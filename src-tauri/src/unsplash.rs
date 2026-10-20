//! Titelbilder von Unsplash mit eigenem (kostenlosem) Zugangsschlüssel.
//!
//! Der Schlüssel liegt im Schlüsselbund. Suchen und Herunterladen laufen hier in Rust; das gewählte
//! Foto wird lokal als Asset gespeichert, damit Titelbilder auch offline erscheinen. Wie von Unsplash
//! verlangt, wird beim Verwenden eines Fotos dessen Download-Endpunkt aufgerufen.

use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Manager, State};

const API: &str = "https://api.unsplash.com";
const KEY_ACCOUNT: &str = "unsplash-access-key";
/// Für Links zu Fotografen und Fotos verlangt Unsplash diese Kennzeichnung.
const UTM: &str = "utm_source=efeu&utm_medium=referral";

pub struct Unsplash {
    key: Mutex<Option<String>>,
}

impl Unsplash {
    pub fn new() -> Self {
        Self { key: Mutex::new(None) }
    }
}

fn entry(app: &AppHandle) -> Result<keyring::Entry, String> {
    keyring::Entry::new(&app.config().identifier, KEY_ACCOUNT).map_err(|e| format!("Schlüsselbund: {e}"))
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

async fn access_key(app: &AppHandle) -> Result<String, String> {
    let state = app.state::<Unsplash>();
    if let Some(key) = state.key.lock().unwrap().clone() {
        return Ok(key);
    }
    let entry = entry(app)?;
    let key = blocking(move || match entry.get_password() {
        Ok(key) => Ok(key),
        Err(keyring::Error::NoEntry) => crate::migrate::take_old_secret(KEY_ACCOUNT, &entry).ok_or_else(|| "Kein Unsplash-Schlüssel hinterlegt.".to_string()),
        Err(e) => Err(format!("Schlüsselbund: {e}")),
    })
    .await?;
    *state.key.lock().unwrap() = Some(key.clone());
    Ok(key)
}

#[tauri::command]
pub async fn unsplash_key_set(app: AppHandle, state: State<'_, Unsplash>, key: String) -> Result<(), String> {
    let key = key.trim().to_string();
    if key.len() < 20 || key.len() > 100 || !key.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err("Das sieht nicht nach einem Unsplash-Zugangsschlüssel („Access Key“) aus.".into());
    }
    // Erst prüfen, dann speichern: ein falscher Schlüssel soll nicht im Schlüsselbund landen.
    get(&key, &format!("{API}/photos?per_page=1")).await?;
    let entry = entry(&app)?;
    let stored = key.clone();
    blocking(move || entry.set_password(&stored).map_err(|e| format!("Schlüsselbund: {e}"))).await?;
    *state.key.lock().unwrap() = Some(key);
    Ok(())
}

#[tauri::command]
pub async fn unsplash_key_delete(app: AppHandle, state: State<'_, Unsplash>) -> Result<(), String> {
    *state.key.lock().unwrap() = None;
    let entry = entry(&app)?;
    blocking(move || match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("Schlüsselbund: {e}")),
    })
    .await
}

fn client() -> Result<reqwest::Client, String> {
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
    reqwest::Client::builder()
        .user_agent(concat!("efeu/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(|e| e.to_string())
}

async fn get(key: &str, url: &str) -> Result<reqwest::Response, String> {
    let response = client()?
        .get(url)
        .header("Authorization", format!("Client-ID {key}"))
        .header("Accept-Version", "v1")
        .send()
        .await
        .map_err(|e| if e.is_connect() { "Keine Verbindung zu Unsplash. Bist du online?".to_string() } else { format!("Unsplash: {e}") })?;
    match response.status().as_u16() {
        200..=299 => Ok(response),
        401 => Err("Der Unsplash-Schlüssel ist ungültig.".into()),
        403 => Err("Unsplash-Limit erreicht (50 Anfragen pro Stunde im Demo-Modus). Versuch es später noch einmal.".into()),
        status => Err(format!("Unsplash antwortet mit Fehler {status}")),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Photo {
    id: String,
    thumb: String,
    raw: String,
    color: String,
    description: String,
    author: String,
    author_url: String,
    photo_url: String,
    download: String,
}

fn with_utm(url: &str) -> String {
    format!("{url}{}{UTM}", if url.contains('?') { "&" } else { "?" })
}

fn photo(v: &Value) -> Option<Photo> {
    let s = |p: &str| v.pointer(p).and_then(Value::as_str).unwrap_or_default().to_string();
    let raw = s("/urls/raw");
    let download = s("/links/download_location");
    if raw.is_empty() || download.is_empty() {
        return None;
    }
    let description = if s("/alt_description").is_empty() { s("/description") } else { s("/alt_description") };
    Some(Photo {
        id: s("/id"),
        thumb: s("/urls/small"),
        raw,
        color: s("/color"),
        description,
        author: s("/user/name"),
        author_url: with_utm(&s("/user/links/html")),
        photo_url: with_utm(&s("/links/html")),
        download,
    })
}

fn encode(query: &str) -> String {
    query
        .bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

/// Suche (quer) oder, ohne Suchbegriff, beliebte Fotos.
#[tauri::command]
pub async fn unsplash_search(app: AppHandle, query: String, page: u32) -> Result<Vec<Photo>, String> {
    let key = access_key(&app).await?;
    let page = page.clamp(1, 50);
    let query = query.trim();
    let url = if query.is_empty() {
        format!("{API}/photos?per_page=24&order_by=popular&page={page}")
    } else {
        format!("{API}/search/photos?per_page=24&orientation=landscape&page={page}&query={}", encode(query))
    };
    let value: Value = serde_json::from_slice(&get(&key, &url).await?.bytes().await.map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    let list = value.get("results").unwrap_or(&value);
    Ok(list.as_array().map(|a| a.iter().filter_map(photo).collect()).unwrap_or_default())
}

#[derive(Deserialize)]
pub struct UsePhoto {
    raw: String,
    download: String,
}

/// Lädt das Foto in Titelbild-Größe herunter, speichert es als Asset und meldet die Verwendung an Unsplash.
#[tauri::command]
pub async fn unsplash_use(app: AppHandle, photo: UsePhoto) -> Result<String, String> {
    if !photo.raw.starts_with("https://images.unsplash.com/") || !photo.download.starts_with("https://api.unsplash.com/") {
        return Err("Unerwartete Adresse".into());
    }
    let key = access_key(&app).await?;
    // Pflicht laut Unsplash-Richtlinien: Verwendung melden (zählt als Download für den Fotografen).
    get(&key, &photo.download).await?;
    let url = format!("{}{}w=2400&q=80&fm=jpg&fit=max", photo.raw, if photo.raw.contains('?') { "&" } else { "?" });
    let bytes = client()?
        .get(url)
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .map_err(|e| format!("Foto konnte nicht geladen werden: {e}"))?
        .bytes()
        .await
        .map_err(|e| e.to_string())?;
    crate::assets::store(&app, &bytes, "jpg")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_queries() {
        assert_eq!(encode("Berge im Nebel"), "Berge%20im%20Nebel");
        assert_eq!(encode("Café&x=1"), "Caf%C3%A9%26x%3D1");
    }

    #[test]
    fn reads_photos_with_attribution() {
        let v: Value = serde_json::json!({
            "id": "abc", "color": "#336699", "alt_description": "Berge",
            "urls": { "raw": "https://images.unsplash.com/photo-1?ixid=1", "small": "https://images.unsplash.com/photo-1?w=400" },
            "links": { "html": "https://unsplash.com/photos/abc", "download_location": "https://api.unsplash.com/photos/abc/download?ixid=1" },
            "user": { "name": "Ana", "links": { "html": "https://unsplash.com/@ana" } }
        });
        let p = photo(&v).unwrap();
        assert_eq!(p.author_url, "https://unsplash.com/@ana?utm_source=efeu&utm_medium=referral");
        assert_eq!(p.description, "Berge");
        assert!(photo(&serde_json::json!({ "id": "x" })).is_none());
    }
}
