//! Zusammenarbeit: efeu wird selbst zum Server für eingeladene Personen.
//!
//! Ein lokaler HTTP-/WebSocket-Server (nur 127.0.0.1) liefert die Web-Oberfläche aus und reicht
//! Nachrichten der Gäste an das Hauptfenster weiter. Dort entscheidet die App anhand der Freigaben,
//! was jemand sehen und ändern darf. Erreichbar wird der Server über einen Cloudflare Quick Tunnel
//! (cloudflared, Apache-2.0, ohne Konto). Die Daten bleiben in der lokalen Datenbank.

mod awake;
mod server;
mod tunnel;

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::process::Child;
use tokio::sync::{mpsc, oneshot};

use crate::db::Db;

/// Ausgehende Nachrichten an eine Gast-Verbindung.
pub(crate) enum Outgoing {
    Text(String),
    Close,
}

pub(crate) struct Conn {
    member_id: String,
    tx: mpsc::Sender<Outgoing>,
}

/// Wie weit eine Verbindung im Rückstand sein darf, bevor sie getrennt wird (der Gast verbindet sich neu).
const QUEUE: usize = 2048;

/// Gemeinsamer Zustand des laufenden Servers.
pub(crate) struct Hub {
    app: AppHandle,
    /// Sitzungs-Cookie → Person
    sessions: Mutex<HashMap<String, String>>,
    conns: Mutex<HashMap<u64, Conn>>,
    next_conn: AtomicU64,
}

impl Hub {
    fn new(app: AppHandle) -> Self {
        Self {
            app,
            sessions: Mutex::new(HashMap::new()),
            conns: Mutex::new(HashMap::new()),
            next_conn: AtomicU64::new(1),
        }
    }

    fn send(&self, conn: u64, message: Outgoing) {
        let mut conns = self.conns.lock().unwrap();
        let full = match conns.get(&conn) {
            Some(c) => c.tx.try_send(message).is_err(),
            None => false,
        };
        // Kommt eine Verbindung nicht hinterher, wird sie getrennt; der Gast lädt beim Neuverbinden neu.
        if full {
            conns.remove(&conn);
        }
    }

    fn close_member(&self, member_id: &str) {
        self.sessions.lock().unwrap().retain(|_, m| m != member_id);
        let mut conns = self.conns.lock().unwrap();
        for conn in conns.values().filter(|c| c.member_id == member_id) {
            let _ = conn.tx.try_send(Outgoing::Close);
        }
        conns.retain(|_, c| c.member_id != member_id);
    }

    fn close_all(&self) {
        self.sessions.lock().unwrap().clear();
        for (_, conn) in self.conns.lock().unwrap().drain() {
            let _ = conn.tx.try_send(Outgoing::Close);
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareStatus {
    /// off | starting | downloading | connecting | online | error
    phase: &'static str,
    /// Öffentliche Adresse (https://….trycloudflare.com)
    url: Option<String>,
    /// Lokale Adresse, nur auf diesem Computer erreichbar
    local_url: Option<String>,
    error: Option<String>,
}

impl ShareStatus {
    const OFF: ShareStatus = ShareStatus { phase: "off", url: None, local_url: None, error: None };
}

struct Running {
    hub: Arc<Hub>,
    generation: u64,
    shutdown: Option<oneshot::Sender<()>>,
    tunnel: Arc<Mutex<Option<Child>>>,
    /// Hält den Computer wach, solange geteilt wird (falls gewünscht); endet beim Verwerfen.
    awake: Option<awake::KeepAwake>,
    /// Kanal für die Adressmeldung an eigene Geräte; kann nachträglich gesetzt werden.
    topic: Arc<Mutex<Option<String>>>,
}

pub struct Share {
    running: Mutex<Option<Running>>,
    status: Mutex<ShareStatus>,
    generation: AtomicU64,
}

impl Share {
    pub fn new() -> Self {
        Self {
            running: Mutex::new(None),
            status: Mutex::new(ShareStatus::OFF),
            generation: AtomicU64::new(0),
        }
    }

    fn hub(&self) -> Option<Arc<Hub>> {
        self.running.lock().unwrap().as_ref().map(|r| r.hub.clone())
    }

    /// Aktuelle öffentliche Adresse (wechselt, wenn der Tunnel neu aufgebaut wird).
    fn current_url(&self) -> Option<String> {
        self.status.lock().unwrap().url.clone()
    }

    fn is_current(&self, generation: u64) -> bool {
        self.running.lock().unwrap().as_ref().is_some_and(|r| r.generation == generation)
    }

    /// Aktualisiert den Status, sofern er noch zu diesem Start gehört.
    fn update(&self, app: &AppHandle, generation: u64, change: impl FnOnce(&mut ShareStatus)) {
        if !self.is_current(generation) {
            return;
        }
        let status = {
            let mut status = self.status.lock().unwrap();
            change(&mut status);
            status.clone()
        };
        let _ = app.emit_to("main", "share:status", status);
    }

    /// Beendet Server, Tunnel und alle Verbindungen. Auch beim Beenden der App.
    pub fn stop(&self, app: &AppHandle) {
        if let Some(mut running) = self.running.lock().unwrap().take() {
            running.hub.close_all();
            if let Some(tx) = running.shutdown.take() {
                let _ = tx.send(());
            }
            if let Some(mut child) = running.tunnel.lock().unwrap().take() {
                let _ = child.start_kill();
            }
        }
        *self.status.lock().unwrap() = ShareStatus::OFF;
        let _ = app.emit_to("main", "share:status", ShareStatus::OFF);
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ConnEvent<'a> {
    conn: u64,
    member_id: &'a str,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct MessageEvent<'a> {
    conn: u64,
    member_id: &'a str,
    data: &'a str,
}

/// Startet den Server und baut den Tunnel auf. Läuft er schon, wird nur der Status geliefert.
///
/// `topic`: geheimer Kanalname bei ntfy.sh, unter dem die aktuelle Adresse für eigene Geräte
/// gemeldet wird (nur die Adresse, nie ein Zugangsschlüssel). `keep_awake`: kein Ruhezustand,
/// solange geteilt wird.
#[tauri::command]
pub async fn share_start(
    app: AppHandle,
    share: State<'_, Share>,
    db: State<'_, Db>,
    topic: Option<String>,
    keep_awake: bool,
) -> Result<ShareStatus, String> {
    if let Some(topic) = &topic {
        if !tunnel::valid_topic(topic) {
            return Err("Ungültiger Kanalname".into());
        }
    }
    if share.running.lock().unwrap().is_some() {
        return Ok(share.status.lock().unwrap().clone());
    }
    db.pool(&app).await?;
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let hub = Arc::new(Hub::new(app.clone()));
    let (shutdown, stopped) = oneshot::channel::<()>();
    let router = server::router(hub.clone());
    tauri::async_runtime::spawn(async move {
        let _ = axum::serve(listener, router)
            .with_graceful_shutdown(async {
                let _ = stopped.await;
            })
            .await;
    });

    let generation = share.generation.fetch_add(1, Ordering::SeqCst) + 1;
    let slot = Arc::new(Mutex::new(None));
    let topic = Arc::new(Mutex::new(topic));
    *share.running.lock().unwrap() = Some(Running {
        hub,
        generation,
        shutdown: Some(shutdown),
        tunnel: slot.clone(),
        awake: keep_awake.then(awake::KeepAwake::start),
        topic: topic.clone(),
    });
    let status = ShareStatus {
        phase: "starting",
        url: None,
        local_url: Some(format!("http://127.0.0.1:{port}")),
        error: None,
    };
    *share.status.lock().unwrap() = status.clone();
    let _ = app.emit_to("main", "share:status", status.clone());

    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        tunnel::run(handle, port, slot, generation, topic).await;
    });
    Ok(status)
}

#[tauri::command]
pub fn share_stop(app: AppHandle, share: State<'_, Share>) {
    share.stop(&app);
}

/// Ruhezustand während der Freigabe verhindern oder wieder zulassen.
#[tauri::command]
pub fn share_keep_awake(share: State<'_, Share>, on: bool) {
    if let Some(running) = share.running.lock().unwrap().as_mut() {
        if on && running.awake.is_none() {
            running.awake = Some(awake::KeepAwake::start());
        } else if !on {
            running.awake = None;
        }
    }
}

/// Adressmeldung für eigene Geräte einschalten (z. B. nach dem Koppeln des ersten Geräts).
#[tauri::command]
pub fn share_announce(app: AppHandle, share: State<'_, Share>, topic: String) -> Result<(), String> {
    if !tunnel::valid_topic(&topic) {
        return Err("Ungültiger Kanalname".into());
    }
    let (generation, slot) = match share.running.lock().unwrap().as_ref() {
        Some(running) => (running.generation, running.topic.clone()),
        None => return Ok(()),
    };
    let previous = slot.lock().unwrap().replace(topic.clone());
    let url = share.status.lock().unwrap().url.clone();
    let online = share.status.lock().unwrap().phase == "online";
    // Ist der Tunnel schon online, sofort melden; sonst übernimmt das der Tunnel beim Verbinden.
    if previous.is_none() && online {
        if let Some(url) = url {
            tunnel::announce(app, generation, topic, url);
        }
    }
    Ok(())
}

#[tauri::command]
pub fn share_status(share: State<'_, Share>) -> ShareStatus {
    share.status.lock().unwrap().clone()
}

/// Nachricht des Hauptfensters an einzelne Gast-Verbindungen.
#[tauri::command]
pub fn share_send(share: State<'_, Share>, targets: Vec<u64>, data: String) {
    let Some(hub) = share.hub() else { return };
    for conn in targets {
        hub.send(conn, Outgoing::Text(data.clone()));
    }
}

/// Trennt alle Verbindungen einer Person (z. B. nachdem ihr Zugang entfernt wurde).
#[tauri::command]
pub fn share_close_member(share: State<'_, Share>, member_id: String) {
    if let Some(hub) = share.hub() {
        hub.close_member(&member_id);
    }
}

/// Öffnet einen geteilten Workspace eines anderen efeu in einem eigenen Fenster.
/// Die Seite läuft dort wie im Browser, ohne Zugriff auf die App-Schnittstellen.
#[tauri::command]
pub fn open_shared(app: AppHandle, url: String) -> Result<(), String> {
    let parsed = tauri::Url::parse(url.trim()).map_err(|_| "Das ist kein gültiger Link".to_string())?;
    if !is_shared_origin(&parsed) {
        return Err("Das ist kein efeu-Einladungslink".into());
    }
    let label = format!("shared-{}", &random_hex()[..12]);
    let opener = parsed.origin();
    let downloads = app.path().download_dir().ok();
    tauri::WebviewWindowBuilder::new(&app, label, tauri::WebviewUrl::External(parsed))
        .title("efeu – geteilter Workspace")
        .inner_size(1200.0, 800.0)
        .min_inner_size(640.0, 480.0)
        // Fremde Links öffnen im Browser, das Fenster bleibt beim geteilten Workspace.
        .on_navigation(move |target| {
            if target.origin() == opener {
                return true;
            }
            if matches!(target.scheme(), "http" | "https" | "mailto") {
                let _ = tauri_plugin_opener::open_url(target.as_str(), None::<&str>);
            }
            false
        })
        // Anhänge landen im Download-Ordner.
        .on_download(move |_, event| {
            if let tauri::webview::DownloadEvent::Requested { destination, .. } = event {
                if let (Some(dir), Some(name)) = (&downloads, destination.file_name().map(|n| n.to_owned())) {
                    *destination = dir.join(name);
                }
            }
            true
        })
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Einladungslinks zeigen auf einen Quick Tunnel; zum Testen auch auf diesen Computer.
fn is_shared_origin(url: &tauri::Url) -> bool {
    match (url.scheme(), url.host_str()) {
        ("https", Some(host)) => host.ends_with(".trycloudflare.com"),
        ("http", Some("127.0.0.1" | "localhost")) => true,
        _ => false,
    }
}

/// Sitzungs-IDs und ähnliche Geheimnisse: 32 zufällige Bytes als Hex.
pub(crate) fn random_hex() -> String {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).expect("Zufallszahlen nicht verfügbar");
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

pub(crate) fn emit_open(app: &AppHandle, conn: u64, member_id: &str) {
    let _ = app.emit_to("main", "share:open", ConnEvent { conn, member_id });
}

pub(crate) fn emit_close(app: &AppHandle, conn: u64, member_id: &str) {
    let _ = app.emit_to("main", "share:close", ConnEvent { conn, member_id });
}

pub(crate) fn emit_message(app: &AppHandle, conn: u64, member_id: &str, data: &str) {
    let _ = app.emit_to("main", "share:message", MessageEvent { conn, member_id, data });
}

/// Beim Beenden der App: Tunnel-Prozess nicht verwaist zurücklassen.
pub fn shutdown(app: &AppHandle) {
    if let Some(share) = app.try_state::<Share>() {
        share.stop(app);
    }
}

#[cfg(test)]
mod tests {
    use super::is_shared_origin;

    #[test]
    fn accepts_only_tunnel_and_local_links() {
        let ok = |u: &str| is_shared_origin(&tauri::Url::parse(u).unwrap());
        assert!(ok("https://quiet-river-lamp-moon.trycloudflare.com/#join=abc"));
        assert!(ok("http://127.0.0.1:5123/#join=abc"));
        assert!(!ok("http://quiet-river.trycloudflare.com/"));
        assert!(!ok("https://trycloudflare.com.evil.example/"));
        assert!(!ok("file:///etc/passwd"));
    }
}
