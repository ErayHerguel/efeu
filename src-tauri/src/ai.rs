//! KI mit eigenem Schlüssel (Claude-API von Anthropic).
//!
//! Der API-Schlüssel liegt ausschließlich im Schlüsselbund des Betriebssystems und verlässt diesen
//! Prozess nur im Header der Anfrage an api.anthropic.com. Das Frontend baut die Anfrage, bekommt
//! aber nie den Schlüssel zu sehen. Antworten werden als Server-Sent Events gestreamt und Ereignis
//! für Ereignis ans Frontend weitergereicht; jede laufende Anfrage lässt sich abbrechen.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

use base64::Engine;
use futures_util::StreamExt;
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, State};

const API: &str = "https://api.anthropic.com/v1";
const API_VERSION: &str = "2023-06-01";
const KEY_ACCOUNT: &str = "anthropic-api-key";
/// Grenze der API für eine Anfrage; PDFs darüber lehnt Anthropic ohnehin ab.
const MAX_PDF_BYTES: u64 = 32 * 1024 * 1024;

pub struct Ai {
    /// Schlüssel nach dem ersten Lesen im Speicher, damit macOS nicht bei jeder Anfrage nachfragt.
    key: Mutex<Option<String>>,
    running: Mutex<HashMap<String, tauri::async_runtime::JoinHandle<()>>>,
}

impl Ai {
    pub fn new() -> Self {
        Self { key: Mutex::new(None), running: Mutex::new(HashMap::new()) }
    }
}

fn entry(app: &AppHandle) -> Result<keyring::Entry, String> {
    keyring::Entry::new(&app.config().identifier, KEY_ACCOUNT).map_err(|e| format!("Schlüsselbund: {e}"))
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

/// Liest den Schlüssel (einmal pro Sitzung aus dem Schlüsselbund).
async fn api_key(app: &AppHandle) -> Result<String, String> {
    let ai = app.state::<Ai>();
    if let Some(key) = ai.key.lock().unwrap().clone() {
        return Ok(key);
    }
    let entry = entry(app)?;
    let key = blocking(move || match entry.get_password() {
        Ok(key) => Ok(key),
        // efeu hieß früher flou: Schlüssel von dort übernehmen.
        Err(keyring::Error::NoEntry) => crate::migrate::take_old_secret(KEY_ACCOUNT, &entry)
            .ok_or_else(|| "Kein API-Schlüssel hinterlegt. Trag ihn in den Einstellungen unter „KI“ ein.".to_string()),
        Err(e) => Err(format!("Schlüsselbund: {e}")),
    })
    .await?;
    *ai.key.lock().unwrap() = Some(key.clone());
    Ok(key)
}

#[tauri::command]
pub async fn ai_key_set(app: AppHandle, state: State<'_, Ai>, key: String) -> Result<(), String> {
    let key = key.trim().to_string();
    if !key.starts_with("sk-ant-") || key.len() < 20 || key.chars().any(char::is_whitespace) {
        return Err("Das sieht nicht nach einem Anthropic-API-Schlüssel aus (beginnt mit „sk-ant-“).".into());
    }
    let entry = entry(&app)?;
    let stored = key.clone();
    blocking(move || entry.set_password(&stored).map_err(|e| format!("Schlüsselbund: {e}"))).await?;
    *state.key.lock().unwrap() = Some(key);
    Ok(())
}

#[tauri::command]
pub async fn ai_key_delete(app: AppHandle, state: State<'_, Ai>) -> Result<(), String> {
    *state.key.lock().unwrap() = None;
    let entry = entry(&app)?;
    blocking(move || match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("Schlüsselbund: {e}")),
    })
    .await
}

fn http_client(streaming: bool) -> Result<reqwest::Client, String> {
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
    let builder = reqwest::Client::builder()
        .user_agent(concat!("efeu/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(Duration::from_secs(20));
    // Beim Streamen schickt die API regelmäßig Pings; Stille über Minuten heißt: Verbindung tot.
    let builder = if streaming { builder.read_timeout(Duration::from_secs(180)) } else { builder.timeout(Duration::from_secs(60)) };
    builder.build().map_err(|e| e.to_string())
}

fn valid_beta(beta: &str) -> bool {
    !beta.is_empty() && beta.len() < 64 && beta.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

async fn post(app: &AppHandle, path: &str, body: &Value, betas: &[String], streaming: bool) -> Result<reqwest::Response, String> {
    let key = api_key(app).await?;
    let mut request = http_client(streaming)?
        .post(format!("{API}{path}"))
        .header("x-api-key", key)
        .header("anthropic-version", API_VERSION)
        .header("content-type", "application/json");
    let betas: Vec<&str> = betas.iter().map(String::as_str).filter(|b| valid_beta(b)).collect();
    if !betas.is_empty() {
        request = request.header("anthropic-beta", betas.join(","));
    }
    let body = serde_json::to_vec(body).map_err(|e| e.to_string())?;
    let response = request.body(body).send().await.map_err(network_error)?;
    if response.status().is_success() {
        return Ok(response);
    }
    let status = response.status().as_u16();
    let text = response.text().await.unwrap_or_default();
    let (kind, message) = serde_json::from_str::<Value>(&text)
        .ok()
        .map(|v| {
            (
                v["error"]["type"].as_str().unwrap_or_default().to_string(),
                v["error"]["message"].as_str().unwrap_or_default().to_string(),
            )
        })
        .unwrap_or_default();
    if status == 401 {
        // Falscher oder gelöschter Schlüssel: beim nächsten Mal neu aus dem Schlüsselbund lesen.
        *app.state::<Ai>().key.lock().unwrap() = None;
    }
    Err(api_error(status, &kind, &message))
}

fn network_error(err: reqwest::Error) -> String {
    if err.is_timeout() {
        "Anthropic antwortet nicht (Zeitüberschreitung). Versuch es gleich noch einmal.".into()
    } else if err.is_connect() {
        "Keine Verbindung zu Anthropic. Bist du online?".into()
    } else {
        format!("Verbindung zu Anthropic fehlgeschlagen: {err}")
    }
}

/// Verständliche Meldungen für die häufigen Fehler; sonst die Meldung der API.
fn api_error(status: u16, kind: &str, message: &str) -> String {
    let lower = message.to_lowercase();
    if lower.contains("credit balance") {
        return "Dein Guthaben bei Anthropic ist aufgebraucht. Aufladen unter console.anthropic.com → Billing.".into();
    }
    match (status, kind) {
        (401, _) | (_, "authentication_error") => "Der API-Schlüssel ist ungültig oder wurde gelöscht.".into(),
        (403, _) | (_, "permission_error") => "Dieser API-Schlüssel darf das nicht (fehlende Berechtigung).".into(),
        (429, _) | (_, "rate_limit_error") => "Zu viele Anfragen kurz hintereinander. Warte einen Moment.".into(),
        (529, _) | (_, "overloaded_error") => "Claude ist gerade überlastet. Versuch es in ein paar Minuten noch einmal.".into(),
        (413, _) | (_, "request_too_large") => "Die Anfrage ist zu groß (z. B. eine sehr große PDF).".into(),
        (500..=599, _) | (_, "api_error") => "Bei Anthropic ist ein Fehler aufgetreten. Versuch es gleich noch einmal.".into(),
        _ if !message.is_empty() => format!("Anthropic: {message}"),
        _ => format!("Anthropic antwortet mit Fehler {status}"),
    }
}

/// Testet den Schlüssel mit einer kostenlosen Token-Zählung.
#[tauri::command]
pub async fn ai_test(app: AppHandle, model: String) -> Result<(), String> {
    let body = serde_json::json!({ "model": model, "messages": [{ "role": "user", "content": "Hallo" }] });
    post(&app, "/messages/count_tokens", &body, &[], false).await.map(|_| ())
}

/// Zählt die Eingabe-Tokens einer Anfrage (kostenlos), Grundlage der Kostenschätzung.
#[tauri::command]
pub async fn ai_count(app: AppHandle, body: Value, betas: Vec<String>) -> Result<u64, String> {
    let response = post(&app, "/messages/count_tokens", &body, &betas, false).await?;
    let bytes = response.bytes().await.map_err(network_error)?;
    let value: Value = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    value["input_tokens"].as_u64().ok_or_else(|| "Unerwartete Antwort der Token-Zählung".into())
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct StreamEvent {
    id: String,
    /// Ein Ereignis der API (message_start, content_block_delta, …)
    #[serde(skip_serializing_if = "Option::is_none")]
    event: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    done: bool,
}

fn emit(app: &AppHandle, id: &str, event: Option<Value>, error: Option<String>, done: bool) {
    let _ = app.emit("ai-stream", StreamEvent { id: id.to_string(), event, error, done });
}

/// Startet eine gestreamte Anfrage. Ereignisse kommen als `ai-stream` mit dieser `id`;
/// das letzte trägt `done: true` (mit `error`, falls etwas schiefging).
#[tauri::command]
pub async fn ai_stream(app: AppHandle, state: State<'_, Ai>, id: String, body: Value, betas: Vec<String>) -> Result<(), String> {
    let mut body = body;
    body["stream"] = Value::Bool(true);
    let task_app = app.clone();
    let task_id = id.clone();
    let handle = tauri::async_runtime::spawn(async move {
        let result = stream(&task_app, &task_id, &body, &betas).await;
        task_app.state::<Ai>().running.lock().unwrap().remove(&task_id);
        match result {
            Ok(()) => emit(&task_app, &task_id, None, None, true),
            Err(err) => emit(&task_app, &task_id, None, Some(err), true),
        }
    });
    state.running.lock().unwrap().insert(id, handle);
    Ok(())
}

async fn stream(app: &AppHandle, id: &str, body: &Value, betas: &[String]) -> Result<(), String> {
    let response = post(app, "/messages", body, betas, true).await?;
    let mut bytes = response.bytes_stream();
    let mut buffer: Vec<u8> = Vec::new();
    while let Some(chunk) = bytes.next().await {
        buffer.extend_from_slice(&chunk.map_err(network_error)?);
        while let Some((end, skip)) = event_end(&buffer) {
            let raw: Vec<u8> = buffer.drain(..end + skip).take(end).collect();
            let Some(data) = event_data(&raw) else { continue };
            let Ok(value) = serde_json::from_str::<Value>(&data) else { continue };
            match value["type"].as_str() {
                Some("ping") => {}
                Some("error") => {
                    let kind = value["error"]["type"].as_str().unwrap_or_default();
                    let message = value["error"]["message"].as_str().unwrap_or_default();
                    return Err(api_error(0, kind, message));
                }
                _ => emit(app, id, Some(value), None, false),
            }
        }
    }
    Ok(())
}

/// Ende des ersten vollständigen SSE-Ereignisses (Leerzeile) und Länge des Trenners.
fn event_end(buffer: &[u8]) -> Option<(usize, usize)> {
    let lf = buffer.windows(2).position(|w| w == b"\n\n").map(|i| (i, 2));
    let crlf = buffer.windows(4).position(|w| w == b"\r\n\r\n").map(|i| (i, 4));
    match (lf, crlf) {
        (Some(a), Some(b)) => Some(if a.0 <= b.0 { a } else { b }),
        (a, b) => a.or(b),
    }
}

/// Fügt die `data:`-Zeilen eines Ereignisses zusammen.
fn event_data(raw: &[u8]) -> Option<String> {
    let text = String::from_utf8_lossy(raw);
    let lines: Vec<&str> = text
        .lines()
        .filter_map(|line| line.strip_prefix("data:"))
        .map(|line| line.strip_prefix(' ').unwrap_or(line))
        .collect();
    (!lines.is_empty()).then(|| lines.join("\n"))
}

/// Simulierter Claude für Tests ohne Schlüssel und ohne Kosten: nur in Entwicklungs-Builds
/// (eigene Bundle-ID) und nur mit EFEU_AI_MOCK=1 beim Start.
#[tauri::command]
pub fn ai_mock(app: AppHandle) -> bool {
    app.config().identifier != "app.efeu.desktop" && std::env::var("EFEU_AI_MOCK").is_ok_and(|v| v == "1")
}

#[tauri::command]
pub fn ai_cancel(state: State<'_, Ai>, id: String) {
    if let Some(handle) = state.running.lock().unwrap().remove(&id) {
        handle.abort();
    }
}

#[derive(Serialize)]
pub struct PdfFile {
    name: String,
    data: String,
    size: u64,
}

/// Liest eine im Dialog gewählte PDF als Base64 (für einen Dokument-Block der Anfrage).
#[tauri::command]
pub fn ai_read_pdf(path: String) -> Result<PdfFile, String> {
    let path = PathBuf::from(path);
    let is_pdf = path.extension().and_then(|e| e.to_str()).is_some_and(|e| e.eq_ignore_ascii_case("pdf"));
    if !is_pdf {
        return Err("Bitte eine PDF-Datei wählen.".into());
    }
    let size = std::fs::metadata(&path).map_err(|e| e.to_string())?.len();
    if size > MAX_PDF_BYTES {
        return Err("Die PDF ist größer als 32 MB, so große Dateien nimmt Claude nicht an.".into());
    }
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    if !bytes.starts_with(b"%PDF") {
        return Err("Die Datei ist keine gültige PDF.".into());
    }
    let name = path.file_stem().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    Ok(PdfFile { name, data: base64::engine::general_purpose::STANDARD.encode(bytes), size })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_sse_events() {
        let buffer = b"event: ping\ndata: {\"type\":\"ping\"}\n\nevent: x\r\ndata: {\"a\":1}\r\n\r\nrest";
        let (end, skip) = event_end(buffer).unwrap();
        assert_eq!(event_data(&buffer[..end]).unwrap(), "{\"type\":\"ping\"}");
        let rest = &buffer[end + skip..];
        let (end, _) = event_end(rest).unwrap();
        assert_eq!(event_data(&rest[..end]).unwrap(), "{\"a\":1}");
    }

    #[test]
    fn readable_errors() {
        assert!(api_error(401, "", "").contains("ungültig"));
        assert!(api_error(400, "invalid_request_error", "Your credit balance is too low").contains("Guthaben"));
        assert!(api_error(0, "overloaded_error", "").contains("überlastet"));
        assert_eq!(api_error(400, "invalid_request_error", "bad"), "Anthropic: bad");
    }

    #[test]
    fn beta_names_are_checked() {
        assert!(valid_beta("server-side-fallback-2026-07-01"));
        assert!(!valid_beta("x\r\ninjected: 1"));
    }
}
