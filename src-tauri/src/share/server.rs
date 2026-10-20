//! HTTP-Seite der Freigabe: Web-Oberfläche, Anmeldung per Einladungslink, WebSocket und Dateien.

use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;

use axum::body::Bytes;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{DefaultBodyLimit, Path, Query, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::json;
use tauri::Manager;
use tokio::sync::mpsc;

use super::{emit_close, emit_message, emit_open, random_hex, Conn, Hub, Outgoing, QUEUE};
use crate::assets;
use crate::db::Db;
use crate::paths::assets_dir;

const COOKIE: &str = "efeu_session";
/// Cloudflare nimmt im kostenlosen Tarif höchstens 100 MB pro Anfrage an.
const MAX_UPLOAD: usize = 100 * 1024 * 1024;
const MAX_MESSAGE: usize = 16 * 1024 * 1024;

type Shared = State<Arc<Hub>>;

pub(super) fn router(hub: Arc<Hub>) -> Router {
    Router::new()
        .route("/api/ping", get(ping))
        .route("/api/session", post(session))
        .route("/api/ws", get(socket))
        .route("/api/upload", post(upload).layer(DefaultBodyLimit::max(MAX_UPLOAD)))
        .route("/files/{name}", get(file))
        .fallback(get(app_asset))
        .with_state(hub)
}

fn error(status: StatusCode, message: &str) -> Response {
    (status, message.to_string()).into_response()
}

/// Person zur Sitzung im Cookie.
fn member(hub: &Hub, headers: &HeaderMap) -> Option<String> {
    let cookies = headers.get(header::COOKIE)?.to_str().ok()?;
    let id = cookies
        .split(';')
        .filter_map(|c| c.trim().split_once('='))
        .find(|(k, _)| *k == COOKIE)
        .map(|(_, v)| v)?;
    hub.sessions.lock().unwrap().get(id).cloned()
}

/// Host aus Sicht des Browsers (über den Tunnel kommt er unverändert an).
fn host(headers: &HeaderMap) -> Option<&str> {
    headers
        .get("x-forwarded-host")
        .or_else(|| headers.get(header::HOST))
        .and_then(|v| v.to_str().ok())
}

fn is_local(host: &str) -> bool {
    let name = host.rsplit_once(':').map_or(host, |(h, _)| h);
    name == "127.0.0.1" || name == "localhost"
}

/// Schutz vor fremden Seiten, die im Namen eines angemeldeten Gastes eine WebSocket-Verbindung öffnen.
fn same_origin(headers: &HeaderMap) -> bool {
    let (Some(origin), Some(host)) = (headers.get(header::ORIGIN).and_then(|v| v.to_str().ok()), host(headers)) else {
        return false;
    };
    origin.split_once("://").is_some_and(|(_, rest)| rest == host)
}

async fn db_pool(hub: &Hub) -> Result<sqlx::SqlitePool, Response> {
    let db = hub.app.state::<Db>();
    db.pool(&hub.app)
        .await
        .cloned()
        .map_err(|e| error(StatusCode::SERVICE_UNAVAILABLE, &e))
}

/// Erreichbarkeit für die Startseite eigener Geräte (läuft auf einer anderen Adresse, daher CORS).
async fn ping() -> Response {
    let mut response = (StatusCode::OK, "efeu").into_response();
    response.headers_mut().insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, HeaderValue::from_static("*"));
    response.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

#[derive(Deserialize)]
struct SessionRequest {
    token: String,
}

/// Tauscht den geheimen Teil des Einladungslinks gegen ein Sitzungs-Cookie.
async fn session(State(hub): Shared, headers: HeaderMap, Json(request): Json<SessionRequest>) -> Response {
    let token = request.token.trim();
    if token.len() != 64 || !token.chars().all(|c| c.is_ascii_hexdigit()) {
        return error(StatusCode::UNAUTHORIZED, "Ungültiger Einladungslink");
    }
    let pool = match db_pool(&hub).await {
        Ok(pool) => pool,
        Err(response) => return response,
    };
    let found: Option<(String, String, String)> =
        sqlx::query_as("SELECT id, name, color FROM share_members WHERE token = ?")
            .bind(token)
            .fetch_optional(&pool)
            .await
            .unwrap_or(None);
    let Some((id, name, color)) = found else {
        // Gegen Durchprobieren: Fehlversuche bremsen.
        tokio::time::sleep(Duration::from_millis(400)).await;
        return error(StatusCode::UNAUTHORIZED, "Dieser Einladungslink ist nicht (mehr) gültig");
    };
    let session = random_hex();
    hub.sessions.lock().unwrap().insert(session.clone(), id.clone());
    let secure = if host(&headers).is_some_and(is_local) { "" } else { "; Secure" };
    let cookie = format!("{COOKIE}={session}; Path=/; HttpOnly; SameSite=Strict{secure}");
    let mut response = Json(json!({ "memberId": id, "name": name, "color": color })).into_response();
    if let Ok(value) = HeaderValue::from_str(&cookie) {
        response.headers_mut().insert(header::SET_COOKIE, value);
    }
    response
}

async fn member_exists(hub: &Hub, member_id: &str) -> bool {
    let Ok(pool) = db_pool(hub).await else { return false };
    sqlx::query_scalar::<_, i64>("SELECT count(*) FROM share_members WHERE id = ?")
        .bind(member_id)
        .fetch_one(&pool)
        .await
        .is_ok_and(|n| n > 0)
}

async fn socket(State(hub): Shared, headers: HeaderMap, upgrade: WebSocketUpgrade) -> Response {
    let Some(member_id) = member(&hub, &headers) else {
        return error(StatusCode::UNAUTHORIZED, "Nicht angemeldet");
    };
    if !same_origin(&headers) {
        return error(StatusCode::FORBIDDEN, "Fremde Herkunft");
    }
    if !member_exists(&hub, &member_id).await {
        return error(StatusCode::UNAUTHORIZED, "Zugang wurde entfernt");
    }
    upgrade
        .max_message_size(MAX_MESSAGE)
        .on_upgrade(move |socket| connection(hub, socket, member_id))
}

/// Eine Gast-Verbindung: eingehende Nachrichten gehen ans Hauptfenster, ausgehende kommen über die Warteschlange.
async fn connection(hub: Arc<Hub>, socket: WebSocket, member_id: String) {
    let id = hub.next_conn.fetch_add(1, Ordering::SeqCst);
    let (tx, mut rx) = mpsc::channel::<Outgoing>(QUEUE);
    hub.conns.lock().unwrap().insert(id, Conn { member_id: member_id.clone(), tx });
    emit_open(&hub.app, id, &member_id);

    let (mut sink, mut stream) = socket.split();
    let writer = async {
        // Regelmäßige Pings halten die Verbindung durch den Tunnel offen.
        let mut ping = tokio::time::interval(Duration::from_secs(25));
        loop {
            tokio::select! {
                message = rx.recv() => match message {
                    Some(Outgoing::Text(text)) => {
                        if sink.send(Message::Text(text.into())).await.is_err() {
                            break;
                        }
                    }
                    Some(Outgoing::Close) | None => {
                        let _ = sink.send(Message::Close(None)).await;
                        break;
                    }
                },
                _ = ping.tick() => {
                    if sink.send(Message::Ping(Bytes::new())).await.is_err() {
                        break;
                    }
                }
            }
        }
    };
    let reader = async {
        while let Some(Ok(message)) = stream.next().await {
            match message {
                Message::Text(text) => emit_message(&hub.app, id, &member_id, text.as_str()),
                Message::Close(_) => break,
                _ => {}
            }
        }
    };
    tokio::select! {
        _ = writer => {},
        _ = reader => {},
    }
    hub.conns.lock().unwrap().remove(&id);
    emit_close(&hub.app, id, &member_id);
}

#[derive(Deserialize)]
struct UploadQuery {
    kind: String,
    #[serde(default)]
    ext: String,
    #[serde(default)]
    name: String,
}

/// Bilder und Anhänge von Gästen mit Schreibrecht.
async fn upload(State(hub): Shared, headers: HeaderMap, Query(query): Query<UploadQuery>, body: Bytes) -> Response {
    let Some(member_id) = member(&hub, &headers) else {
        return error(StatusCode::UNAUTHORIZED, "Nicht angemeldet");
    };
    let pool = match db_pool(&hub).await {
        Ok(pool) => pool,
        Err(response) => return response,
    };
    // Eigene Geräte dürfen alles, Gäste brauchen irgendwo Schreibrecht.
    let can_edit = sqlx::query_scalar::<_, i64>(
        "SELECT (SELECT count(*) FROM share_members WHERE id = ?1 AND kind = 'device')
              + (SELECT count(*) FROM share_grants WHERE member_id = ?1 AND role = 'edit')",
    )
        .bind(&member_id)
        .fetch_one(&pool)
        .await
        .is_ok_and(|n| n > 0);
    if !can_edit {
        return error(StatusCode::FORBIDDEN, "Nur mit Schreibrecht");
    }
    let app = hub.app.clone();
    let stored = tokio::task::spawn_blocking(move || match query.kind.as_str() {
        "image" => assets::store(&app, &body, &query.ext).map(|name| json!({ "name": name })),
        "file" => assets::store_file(&app, &body, &query.name).map(|f| json!({ "src": f.src, "size": f.size })),
        _ => Err("Unbekannte Art".to_string()),
    })
    .await
    .unwrap_or_else(|e| Err(e.to_string()));
    match stored {
        Ok(value) => Json(value).into_response(),
        Err(message) => error(StatusCode::BAD_REQUEST, &message),
    }
}

/// Gespeicherte Dateien sind inhaltsadressiert: 32 Hex-Zeichen und eine einfache Endung.
fn valid_asset_name(name: &str) -> bool {
    let Some((hash, ext)) = name.split_once('.') else { return false };
    hash.len() == 32
        && hash.chars().all(|c| c.is_ascii_hexdigit())
        && (1..=10).contains(&ext.len())
        && ext.chars().all(|c| c.is_ascii_alphanumeric())
}

fn mime_for(ext: &str) -> &'static str {
    match ext {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "avif" => "image/avif",
        "bmp" => "image/bmp",
        "heic" => "image/heic",
        "mp4" | "m4v" => "video/mp4",
        "mov" => "video/quicktime",
        "webm" => "video/webm",
        "mp3" => "audio/mpeg",
        "m4a" => "audio/mp4",
        "wav" => "audio/wav",
        "ogg" => "audio/ogg",
        "pdf" => "application/pdf",
        _ => "application/octet-stream",
    }
}

async fn file(State(hub): Shared, headers: HeaderMap, Path(name): Path<String>) -> Response {
    if member(&hub, &headers).is_none() {
        return error(StatusCode::UNAUTHORIZED, "Nicht angemeldet");
    }
    if !valid_asset_name(&name) {
        return error(StatusCode::NOT_FOUND, "Nicht gefunden");
    }
    let Ok(dir) = assets_dir(&hub.app) else {
        return error(StatusCode::INTERNAL_SERVER_ERROR, "Kein Datenordner");
    };
    let Ok(bytes) = tokio::fs::read(dir.join(&name)).await else {
        return error(StatusCode::NOT_FOUND, "Nicht gefunden");
    };
    let ext = name.rsplit_once('.').map_or("", |(_, e)| e).to_ascii_lowercase();
    let mime = mime_for(&ext);
    let inline = mime.starts_with("image/") || mime.starts_with("video/") || mime.starts_with("audio/");
    let mut response = (StatusCode::OK, bytes).into_response();
    let h = response.headers_mut();
    h.insert(header::CONTENT_TYPE, HeaderValue::from_static(mime));
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("private, max-age=31536000, immutable"));
    h.insert(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
    // Hochgeladene Dateien (z. B. SVG) dürfen nie als Teil der App Skripte ausführen.
    h.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static("default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox"),
    );
    if !inline {
        h.insert(header::CONTENT_DISPOSITION, HeaderValue::from_static("attachment"));
    }
    response
}

fn guest_csp(host: &str) -> String {
    format!(
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; \
         media-src 'self' blob:; font-src 'self' data:; connect-src 'self' wss://{host} ws://{host}; \
         worker-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'"
    )
}

/// Die eingebettete Oberfläche der App, im Gastmodus. Unbekannte Pfade liefern die Startseite.
async fn app_asset(State(hub): Shared, headers: HeaderMap, uri: Uri) -> Response {
    let path = uri.path().to_string();
    let Some(asset) = hub.app.asset_resolver().get(path.clone()) else {
        return error(StatusCode::NOT_FOUND, "Nicht gefunden");
    };
    let is_html = asset.mime_type.starts_with("text/html");
    let body = if is_html {
        // Markiert die Seite als Gast-Oberfläche (siehe src/lib/mode.ts).
        String::from_utf8_lossy(&asset.bytes)
            .replacen("<head>", "<head><meta name=\"efeu-mode\" content=\"guest\">", 1)
            .into_bytes()
    } else {
        asset.bytes
    };
    let mut response = (StatusCode::OK, body).into_response();
    let h = response.headers_mut();
    if let Ok(mime) = HeaderValue::from_str(&asset.mime_type) {
        h.insert(header::CONTENT_TYPE, mime);
    }
    h.insert(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
    h.insert(header::REFERRER_POLICY, HeaderValue::from_static("no-referrer"));
    let cache = if is_html || !path.starts_with("/assets/") { "no-cache" } else { "public, max-age=31536000, immutable" };
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static(cache));
    if let Ok(csp) = HeaderValue::from_str(&guest_csp(host(&headers).unwrap_or("localhost"))) {
        h.insert(header::CONTENT_SECURITY_POLICY, csp);
    }
    response
}

#[cfg(test)]
mod tests {
    use axum::http::{header, HeaderMap, HeaderValue};

    use super::{same_origin, valid_asset_name};

    #[test]
    fn checks_asset_names() {
        assert!(valid_asset_name("0123456789abcdef0123456789abcdef.png"));
        assert!(!valid_asset_name("../efeu.db"));
        assert!(!valid_asset_name("0123456789abcdef0123456789abcdef.png/../x"));
        assert!(!valid_asset_name("short.png"));
    }

    #[test]
    fn requires_matching_origin() {
        let headers = |origin: &str, host: &str| {
            let mut h = HeaderMap::new();
            h.insert(header::ORIGIN, HeaderValue::from_str(origin).unwrap());
            h.insert(header::HOST, HeaderValue::from_str(host).unwrap());
            h
        };
        assert!(same_origin(&headers("https://a-b.trycloudflare.com", "a-b.trycloudflare.com")));
        assert!(same_origin(&headers("http://127.0.0.1:5123", "127.0.0.1:5123")));
        assert!(!same_origin(&headers("https://evil.example", "a-b.trycloudflare.com")));
    }
}
