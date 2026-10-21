//! Eigene Cloud: Verbindung zum selbst gehosteten efeu-Server.
//!
//! Adresse und Geräteschlüssel liegen zusammen im Schlüsselbund. Alle Anfragen an den Server laufen
//! hier in Rust (die Oberfläche darf wegen der CSP keine fremden Adressen ansprechen). Neue Änderungen
//! meldet der Server über Server-Sent Events, die als Ereignis `cloud:changed` weitergereicht werden;
//! abholen und anwenden macht die Oberfläche (src/sync).

pub mod setup;

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::paths::assets_dir;

const KEY_ACCOUNT: &str = "cloud";

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Connection {
    pub url: String,
    pub token: String,
    pub device_id: String,
    /// Team-Mitglied, als das dieses Gerät verbunden ist; None = eigene Cloud (Inhaber)
    #[serde(default)]
    pub member_id: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    url: String,
    device_id: String,
    member_id: Option<String>,
}

pub struct Cloud {
    connection: Mutex<Option<Option<Connection>>>,
    /// Erhöht sich bei jedem Trennen/Verbinden; alte Ereignis-Schleifen beenden sich dann.
    generation: AtomicU64,
    events_running: AtomicBool,
    pub(crate) setup_cancel: AtomicBool,
}

impl Cloud {
    pub fn new() -> Self {
        Self {
            connection: Mutex::new(None),
            generation: AtomicU64::new(0),
            events_running: AtomicBool::new(false),
            setup_cancel: AtomicBool::new(false),
        }
    }
}

fn entry(app: &AppHandle) -> Result<keyring::Entry, String> {
    keyring::Entry::new(&app.config().identifier, KEY_ACCOUNT).map_err(|e| format!("Schlüsselbund: {e}"))
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

/// Gespeicherte Verbindung (einmal pro Sitzung aus dem Schlüsselbund gelesen).
async fn connection(app: &AppHandle) -> Result<Option<Connection>, String> {
    let cloud = app.state::<Cloud>();
    if let Some(cached) = cloud.connection.lock().unwrap().clone() {
        return Ok(cached);
    }
    let entry = entry(app)?;
    let stored = blocking(move || match entry.get_password() {
        Ok(json) => Ok(serde_json::from_str::<Connection>(&json).ok()),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("Schlüsselbund: {e}")),
    })
    .await?;
    *cloud.connection.lock().unwrap() = Some(stored.clone());
    Ok(stored)
}

async fn require(app: &AppHandle) -> Result<Connection, String> {
    connection(app).await?.ok_or_else(|| "Keine Cloud verbunden".to_string())
}

pub(crate) async fn store_connection(app: &AppHandle, conn: Connection) -> Result<(), String> {
    let entry = entry(app)?;
    let json = serde_json::to_string(&conn).map_err(|e| e.to_string())?;
    blocking(move || entry.set_password(&json).map_err(|e| format!("Schlüsselbund: {e}"))).await?;
    let cloud = app.state::<Cloud>();
    *cloud.connection.lock().unwrap() = Some(Some(conn));
    cloud.generation.fetch_add(1, Ordering::SeqCst);
    Ok(())
}

pub(crate) fn http_client(timeout: Option<Duration>) -> Result<reqwest::Client, String> {
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
    let builder = reqwest::Client::builder()
        .user_agent(concat!("efeu/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(Duration::from_secs(15));
    let builder = match timeout {
        Some(t) => builder.timeout(t),
        None => builder.read_timeout(Duration::from_secs(70)),
    };
    builder.build().map_err(|e| e.to_string())
}

/// Adresse vereinheitlichen: https:// ergänzen, Schrägstrich am Ende entfernen.
pub(crate) fn normalize_url(input: &str) -> Result<String, String> {
    let trimmed = input.trim().trim_end_matches('/');
    let url = if trimmed.contains("://") { trimmed.to_string() } else { format!("https://{trimmed}") };
    let parsed = reqwest::Url::parse(&url).map_err(|_| "Ungültige Adresse".to_string())?;
    if !matches!(parsed.scheme(), "https" | "http") || parsed.host_str().is_none() {
        return Err("Ungültige Adresse".into());
    }
    Ok(url)
}

fn error_text(status: reqwest::StatusCode, body: &str) -> String {
    let message = serde_json::from_str::<Value>(body).ok().and_then(|v| v["error"].as_str().map(str::to_string));
    match (status.as_u16(), message) {
        (401, _) => "Dieses Gerät hat keinen Zugang mehr zur Cloud.".into(),
        (_, Some(m)) => m,
        (code, None) => format!("Die Cloud antwortet mit Fehler {code}"),
    }
}

fn valid_path(path: &str) -> bool {
    path.starts_with("/api/") && !path.contains("..") && path.chars().all(|c| c.is_ascii_graphic())
}

#[tauri::command]
pub async fn cloud_status(app: AppHandle) -> Result<Option<Status>, String> {
    Ok(connection(&app).await?.map(|c| Status { url: c.url, device_id: c.device_id, member_id: c.member_id }))
}

/// JSON-Anfrage an die verbundene Cloud.
#[tauri::command]
pub async fn cloud_request(app: AppHandle, method: String, path: String, body: Option<Value>) -> Result<Value, String> {
    if !valid_path(&path) {
        return Err("Ungültiger Pfad".into());
    }
    let conn = require(&app).await?;
    let method = reqwest::Method::from_bytes(method.as_bytes()).map_err(|_| "Ungültige Methode".to_string())?;
    let mut request = http_client(Some(Duration::from_secs(120)))?
        .request(method, format!("{}{path}", conn.url))
        .bearer_auth(&conn.token);
    if let Some(body) = body {
        request = request.json(&body);
    }
    let response = request.send().await.map_err(|e| format!("Cloud nicht erreichbar: {e}"))?;
    let status = response.status();
    let text = response.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(error_text(status, &text));
    }
    serde_json::from_str(&text).map_err(|e| e.to_string())
}

fn valid_asset(name: &str) -> bool {
    let Some((hash, ext)) = name.split_once('.') else { return false };
    hash.len() == 32
        && hash.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
        && !ext.is_empty()
        && ext.len() <= 10
        && ext.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
}

#[tauri::command]
pub fn cloud_assets_local(app: AppHandle) -> Result<Vec<String>, String> {
    let dir = assets_dir(&app)?;
    let mut names: Vec<String> = std::fs::read_dir(&dir)
        .map_err(|e| e.to_string())?
        .filter_map(|e| e.ok()?.file_name().into_string().ok())
        .filter(|n| valid_asset(n))
        .collect();
    names.sort();
    Ok(names)
}

#[tauri::command]
pub async fn cloud_asset_upload(app: AppHandle, name: String) -> Result<(), String> {
    if !valid_asset(&name) {
        return Err("Ungültiger Dateiname".into());
    }
    let conn = require(&app).await?;
    let bytes = tokio::fs::read(assets_dir(&app)?.join(&name)).await.map_err(|e| e.to_string())?;
    let response = http_client(Some(Duration::from_secs(600)))?
        .put(format!("{}/api/assets/{name}", conn.url))
        .bearer_auth(&conn.token)
        .body(bytes)
        .send()
        .await
        .map_err(|e| format!("Cloud nicht erreichbar: {e}"))?;
    let status = response.status();
    if !status.is_success() {
        return Err(error_text(status, &response.text().await.unwrap_or_default()));
    }
    Ok(())
}

#[tauri::command]
pub async fn cloud_asset_download(app: AppHandle, name: String) -> Result<(), String> {
    if !valid_asset(&name) {
        return Err("Ungültiger Dateiname".into());
    }
    let conn = require(&app).await?;
    let response = http_client(Some(Duration::from_secs(600)))?
        .get(format!("{}/api/assets/{name}", conn.url))
        .bearer_auth(&conn.token)
        .send()
        .await
        .map_err(|e| format!("Cloud nicht erreichbar: {e}"))?;
    let status = response.status();
    if !status.is_success() {
        return Err(error_text(status, &response.text().await.unwrap_or_default()));
    }
    let bytes = response.bytes().await.map_err(|e| e.to_string())?;
    // Nur speichern, was zum Namen passt (der Name ist der Hash des Inhalts).
    use sha2::{Digest, Sha256};
    let hash = format!("{:x}", Sha256::digest(&bytes));
    if hash[..32] != name[..32] {
        return Err("Anhang aus der Cloud ist beschädigt".into());
    }
    let dir = assets_dir(&app)?;
    let tmp = dir.join(format!(".{name}.cloud"));
    tokio::fs::write(&tmp, &bytes).await.map_err(|e| e.to_string())?;
    tokio::fs::rename(&tmp, dir.join(&name)).await.map_err(|e| e.to_string())
}

/// Mit einem Kopplungscode einer bestehenden Cloud beitreten (zweites Gerät).
#[tauri::command]
pub async fn cloud_pair(app: AppHandle, url: String, code: String, name: String) -> Result<(), String> {
    let url = normalize_url(&url)?;
    let response = http_client(Some(Duration::from_secs(30)))?
        .post(format!("{url}/api/pair"))
        .json(&serde_json::json!({ "code": code.trim(), "name": name }))
        .send()
        .await
        .map_err(|e| format!("Cloud nicht erreichbar: {e}"))?;
    let status = response.status();
    let text = response.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(error_text(status, &text));
    }
    let value: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    let token = value["token"].as_str().ok_or("Antwort ohne Schlüssel")?.to_string();
    let device_id = value["device"]["id"].as_str().ok_or("Antwort ohne Gerät")?.to_string();
    store_connection(&app, Connection { url, token, device_id, member_id: None }).await
}

/// Einem Team beitreten (Einladungslink) oder sich mit einem Team-Konto anmelden.
async fn team_access(app: &AppHandle, url: &str, path: &str, body: Value) -> Result<(), String> {
    let url = normalize_url(url)?;
    let response = http_client(Some(Duration::from_secs(30)))?
        .post(format!("{url}{path}"))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Cloud nicht erreichbar: {e}"))?;
    let status = response.status();
    let text = response.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        let message = serde_json::from_str::<Value>(&text).ok().and_then(|v| v["error"].as_str().map(str::to_string));
        return Err(message.unwrap_or_else(|| format!("Die Cloud antwortet mit Fehler {}", status.as_u16())));
    }
    let value: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    let token = value["deviceToken"].as_str().ok_or("Antwort ohne Geräteschlüssel")?.to_string();
    let device_id = value["deviceId"].as_str().ok_or("Antwort ohne Gerät")?.to_string();
    let member_id = value["memberId"].as_str().map(str::to_string);
    store_connection(app, Connection { url, token, device_id, member_id }).await
}

#[tauri::command]
pub async fn cloud_team_join(app: AppHandle, url: String, code: String, name: String, login: String, password: String, device: String) -> Result<(), String> {
    let body = serde_json::json!({ "code": code.trim(), "name": name, "login": login, "password": password, "device": device });
    team_access(&app, &url, "/api/team/join", body).await
}

#[tauri::command]
pub async fn cloud_team_login(app: AppHandle, url: String, login: String, password: String, device: String) -> Result<(), String> {
    let body = serde_json::json!({ "login": login, "password": password, "device": device });
    team_access(&app, &url, "/api/team/login", body).await
}

/// Spielt die Server-Version ein, die diese App mitbringt (Server-Datei und Web-Oberfläche, signiert).
/// Der Server prüft die Signaturen selbst und startet danach neu.
#[tauri::command]
pub async fn cloud_update_server(app: AppHandle) -> Result<(), String> {
    use base64::Engine;
    let conn = require(&app).await?;
    let read = |name: &str| -> Result<Vec<u8>, String> {
        let path = app
            .path()
            .resolve(name, tauri::path::BaseDirectory::Resource)
            .map_err(|e| e.to_string())?;
        std::fs::read(path).map_err(|_| format!("{name} fehlt in dieser efeu-Version"))
    };
    let (server, server_sig, web, web_sig) =
        (read("efeu-server.mjs")?, read("efeu-server.mjs.sig")?, read("efeu-web.tar.gz")?, read("efeu-web.tar.gz.sig")?);
    if server_sig.is_empty() || web_sig.is_empty() {
        return Err("Diese efeu-Version ist nicht signiert und kann den Server nicht aktualisieren.".into());
    }
    let b64 = base64::engine::general_purpose::STANDARD;
    let body = serde_json::json!({
        "server": b64.encode(server),
        "serverSig": String::from_utf8_lossy(&server_sig),
        "web": b64.encode(web),
        "webSig": String::from_utf8_lossy(&web_sig),
    });
    let response = http_client(Some(Duration::from_secs(300)))?
        .post(format!("{}/api/admin/update", conn.url))
        .bearer_auth(&conn.token)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Cloud nicht erreichbar: {e}"))?;
    let status = response.status();
    if !status.is_success() {
        return Err(error_text(status, &response.text().await.unwrap_or_default()));
    }
    Ok(())
}

/// Verbindung vergessen. Die Daten auf diesem Gerät und in der Cloud bleiben erhalten.
#[tauri::command]
pub async fn cloud_forget(app: AppHandle, state: State<'_, Cloud>) -> Result<(), String> {
    *state.connection.lock().unwrap() = Some(None);
    state.generation.fetch_add(1, Ordering::SeqCst);
    let entry = entry(&app)?;
    blocking(move || match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("Schlüsselbund: {e}")),
    })
    .await
}

#[derive(Clone, Serialize)]
struct Online {
    online: bool,
    error: Option<String>,
}

/// Hält eine Ereignis-Verbindung zur Cloud offen (verbindet sich bei Abbruch neu).
#[tauri::command]
pub fn cloud_events(app: AppHandle, state: State<'_, Cloud>) {
    if state.events_running.swap(true, Ordering::SeqCst) {
        return;
    }
    tauri::async_runtime::spawn(async move {
        let mut backoff = 1u64;
        loop {
            let generation = app.state::<Cloud>().generation.load(Ordering::SeqCst);
            let conn = match connection(&app).await {
                Ok(Some(c)) => c,
                _ => break,
            };
            match listen(&app, &conn, generation).await {
                Ok(()) => backoff = 1,
                Err(e) => {
                    let _ = app.emit("cloud:online", Online { online: false, error: Some(e) });
                    tokio::time::sleep(Duration::from_secs(backoff)).await;
                    backoff = (backoff * 2).min(60);
                }
            }
            if app.state::<Cloud>().generation.load(Ordering::SeqCst) != generation {
                backoff = 1;
            }
        }
        app.state::<Cloud>().events_running.store(false, Ordering::SeqCst);
    });
}

async fn listen(app: &AppHandle, conn: &Connection, generation: u64) -> Result<(), String> {
    let response = http_client(None)?
        .get(format!("{}/api/sync/events", conn.url))
        .bearer_auth(&conn.token)
        .send()
        .await
        .map_err(|e| format!("Cloud nicht erreichbar: {e}"))?;
    if !response.status().is_success() {
        let status = response.status();
        return Err(error_text(status, &response.text().await.unwrap_or_default()));
    }
    let _ = app.emit("cloud:online", Online { online: true, error: None });
    let mut stream = response.bytes_stream();
    let mut buffer = String::new();
    while let Some(chunk) = stream.next().await {
        if app.state::<Cloud>().generation.load(Ordering::SeqCst) != generation {
            return Ok(());
        }
        buffer.push_str(&String::from_utf8_lossy(&chunk.map_err(|e| e.to_string())?));
        while let Some(end) = buffer.find("\n\n") {
            let event: String = buffer.drain(..end + 2).collect();
            if let Some(seq) = parse_changed(&event) {
                let _ = app.emit("cloud:changed", seq);
            }
        }
    }
    Err("Verbindung zur Cloud unterbrochen".into())
}

fn parse_changed(event: &str) -> Option<u64> {
    let mut name = "";
    let mut data = "";
    for line in event.lines() {
        if let Some(v) = line.strip_prefix("event: ") {
            name = v;
        } else if let Some(v) = line.strip_prefix("data: ") {
            data = v;
        }
    }
    (name == "changed").then(|| data.trim().parse().ok()).flatten()
}

/// Nur für Testversionen (eigene Kennung): mit `EFEU_DEV_CLOUD=adresse|code` beim Start koppeln,
/// damit sich der Abgleich ohne Klicken prüfen lässt. Die echte App ignoriert die Variable.
pub fn dev_autojoin(app: &AppHandle) {
    if app.config().identifier == "app.efeu.desktop" {
        return;
    }
    let Ok(value) = std::env::var("EFEU_DEV_CLOUD") else { return };
    let Some((url, code)) = value.split_once('|') else { return };
    let (app, url, code) = (app.clone(), url.to_string(), code.to_string());
    tauri::async_runtime::block_on(async move {
        if matches!(connection(&app).await, Ok(Some(_))) {
            return;
        }
        if let Err(e) = cloud_pair(app.clone(), url, code, "Testgerät".into()).await {
            eprintln!("Test-Kopplung fehlgeschlagen: {e}");
        }
    });
}

/// Name dieses Computers (für die Geräteliste in der Cloud).
#[tauri::command]
pub fn device_name() -> String {
    #[cfg(target_os = "macos")]
    if let Ok(out) = std::process::Command::new("scutil").args(["--get", "ComputerName"]).output() {
        let name = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if !name.is_empty() {
            return name;
        }
    }
    std::env::var("COMPUTERNAME").or_else(|_| std::env::var("HOSTNAME")).unwrap_or_else(|_| "Computer".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_addresses() {
        assert_eq!(normalize_url("49.12.1.2").unwrap(), "https://49.12.1.2");
        assert_eq!(normalize_url(" https://notizen.example.de/ ").unwrap(), "https://notizen.example.de");
        assert_eq!(normalize_url("http://192.168.1.5:8080").unwrap(), "http://192.168.1.5:8080");
        assert!(normalize_url("ftp://x").is_err());
        assert!(normalize_url("").is_err());
    }

    #[test]
    fn checks_paths_and_asset_names() {
        assert!(valid_path("/api/sync/pull?since=3"));
        assert!(!valid_path("/api/../etc"));
        assert!(!valid_path("https://evil/api/x"));
        assert!(valid_asset("0123456789abcdef0123456789abcdef.png"));
        assert!(!valid_asset("../0123456789abcdef0123456789abcdef.png"));
        assert!(!valid_asset("0123456789ABCDEF0123456789abcdef.png"));
    }

    #[test]
    fn parses_events() {
        assert_eq!(parse_changed("event: changed\ndata: 42\n\n"), Some(42));
        assert_eq!(parse_changed(": ping\n\n"), None);
    }
}
