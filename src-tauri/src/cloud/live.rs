//! Live-Verbindung zur eigenen Cloud (WebSocket): dieselben Nachrichten wie die Web-Oberfläche, damit
//! Cursor, Präsenz und Tippen der anderen sofort erscheinen. Der Abgleich der Daten läuft unabhängig
//! davon weiter; fällt die Verbindung aus, verbindet sie sich neu.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::Message;

use super::connection;

pub struct Live {
    tx: Mutex<Option<mpsc::UnboundedSender<String>>>,
    /// Erhöht sich beim Schließen; laufende Verbindungen beenden sich dann.
    generation: AtomicU64,
}

impl Live {
    pub fn new() -> Self {
        Self { tx: Mutex::new(None), generation: AtomicU64::new(0) }
    }
}

fn ws_url(url: &str, name: &str) -> String {
    let base = url.replacen("https://", "wss://", 1).replacen("http://", "ws://", 1);
    let name: String = name.chars().filter(|c| !c.is_control()).take(80).collect();
    let encoded: String = name
        .bytes()
        .map(|b| if b.is_ascii_alphanumeric() { (b as char).to_string() } else { format!("%{b:02X}") })
        .collect();
    format!("{base}/api/ws?name={encoded}")
}

/// Live-Verbindung öffnen (oder die laufende weiterverwenden). `name` erscheint bei den anderen.
#[tauri::command]
pub fn cloud_live_open(app: AppHandle, state: State<'_, Live>, name: String) {
    if state.tx.lock().unwrap().is_some() {
        return;
    }
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    *state.tx.lock().unwrap() = Some(tx);
    let generation = state.generation.load(Ordering::SeqCst);
    tauri::async_runtime::spawn(async move {
        let mut backoff = 1u64;
        loop {
            if app.state::<Live>().generation.load(Ordering::SeqCst) != generation {
                break;
            }
            let Ok(Some(conn)) = connection(&app).await else { break };
            match run(&app, &conn.url, &conn.token, &name, &mut rx, generation).await {
                Ok(()) => break,
                Err(_) => {
                    let _ = app.emit("cloud:live-closed", ());
                    tokio::time::sleep(Duration::from_secs(backoff)).await;
                    backoff = (backoff * 2).min(30);
                }
            }
        }
        let live = app.state::<Live>();
        if live.generation.load(Ordering::SeqCst) == generation {
            *live.tx.lock().unwrap() = None;
        }
    });
}

async fn run(
    app: &AppHandle,
    url: &str,
    token: &str,
    name: &str,
    rx: &mut mpsc::UnboundedReceiver<String>,
    generation: u64,
) -> Result<(), String> {
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
    let mut request = ws_url(url, name).into_client_request().map_err(|e| e.to_string())?;
    let headers = request.headers_mut();
    headers.insert("authorization", HeaderValue::from_str(&format!("Bearer {token}")).map_err(|e| e.to_string())?);
    // Der Server prüft die Herkunft wie beim Browser.
    headers.insert("origin", HeaderValue::from_str(url).map_err(|e| e.to_string())?);
    let (socket, _) = tokio_tungstenite::connect_async(request).await.map_err(|e| e.to_string())?;
    let (mut sink, mut stream) = socket.split();
    let _ = app.emit("cloud:live-open", ());
    let mut ping = tokio::time::interval(Duration::from_secs(25));
    loop {
        tokio::select! {
            outgoing = rx.recv() => match outgoing {
                Some(text) => sink.send(Message::Text(text.into())).await.map_err(|e| e.to_string())?,
                None => return Ok(()),
            },
            incoming = stream.next() => match incoming {
                Some(Ok(Message::Text(text))) => {
                    let _ = app.emit("cloud:live", text.as_str());
                }
                Some(Ok(Message::Close(_))) | None => return Err("geschlossen".into()),
                Some(Err(e)) => return Err(e.to_string()),
                _ => {}
            },
            _ = ping.tick() => {
                if app.state::<Live>().generation.load(Ordering::SeqCst) != generation {
                    let _ = sink.send(Message::Close(None)).await;
                    return Ok(());
                }
                sink.send(Message::Ping(Vec::new().into())).await.map_err(|e| e.to_string())?;
            }
        }
    }
}

#[tauri::command]
pub fn cloud_live_send(state: State<'_, Live>, text: String) -> Result<(), String> {
    match state.tx.lock().unwrap().as_ref() {
        Some(tx) => tx.send(text).map_err(|_| "Live-Verbindung geschlossen".to_string()),
        None => Err("Keine Live-Verbindung".into()),
    }
}

#[tauri::command]
pub fn cloud_live_close(state: State<'_, Live>) {
    state.generation.fetch_add(1, Ordering::SeqCst);
    *state.tx.lock().unwrap() = None;
}

#[cfg(test)]
mod tests {
    use super::ws_url;

    #[test]
    fn builds_socket_addresses() {
        assert_eq!(ws_url("https://2.28.102.19", "Erays Mac"), "wss://2.28.102.19/api/ws?name=Erays%20Mac");
        assert_eq!(ws_url("http://127.0.0.1:8080", "Ä"), "ws://127.0.0.1:8080/api/ws?name=%C3%84");
    }
}
