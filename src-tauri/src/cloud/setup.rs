//! Automatische Einrichtung eines gemieteten Servers: per SSH anmelden, Server-Datei und
//! Installationsskript übertragen, ausführen, Fortschritt melden, Geräteschlüssel übernehmen.
//! Das Passwort wird nur für diese eine Verbindung benutzt und nirgends gespeichert.

use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;

use russh::client::{self, Handler};
use russh::ChannelMsg;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use super::{http_client, normalize_url, store_connection, Cloud, Connection};

const SCRIPT: &str = include_str!("../../../server/install.sh");

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Progress {
    step: u32,
    total: u32,
    text: String,
}

const TOTAL: u32 = 8;

fn progress(app: &AppHandle, step: u32, text: &str) {
    let _ = app.emit("cloud:setup", Progress { step, total: TOTAL, text: text.to_string() });
}

struct Client;

impl Handler for Client {
    type Error = russh::Error;

    // Ein frisch gemieteter Server ist uns noch unbekannt; wir verbinden uns nur dieses eine Mal.
    async fn check_server_key(&mut self, _key: &russh::keys::PublicKeyOrCertificate) -> Result<bool, Self::Error> {
        Ok(true)
    }
}

/// Für die Shell sicher in einfache Anführungszeichen setzen.
fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', r"'\''"))
}

fn valid_host(host: &str) -> bool {
    !host.is_empty()
        && host.len() <= 253
        && host.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | ':'))
}

/// Führt einen Befehl aus, schickt `input` auf die Standardeingabe und liefert Ausgabe und Exit-Code.
async fn run(
    session: &client::Handle<Client>,
    command: &str,
    input: &[u8],
    mut on_line: impl FnMut(&str),
) -> Result<(String, u32), String> {
    let mut channel = session.channel_open_session().await.map_err(|e| e.to_string())?;
    channel.exec(true, command).await.map_err(|e| e.to_string())?;
    if !input.is_empty() {
        channel.data(input).await.map_err(|e| e.to_string())?;
    }
    channel.eof().await.map_err(|e| e.to_string())?;
    let mut output = String::new();
    let mut pending = String::new();
    let mut code = None;
    while let Some(msg) = channel.wait().await {
        match msg {
            ChannelMsg::Data { data } | ChannelMsg::ExtendedData { data, .. } => {
                let text = String::from_utf8_lossy(&data);
                output.push_str(&text);
                pending.push_str(&text);
                while let Some(end) = pending.find('\n') {
                    let line: String = pending.drain(..=end).collect();
                    on_line(line.trim_end());
                }
            }
            ChannelMsg::ExitStatus { exit_status } => code = Some(exit_status),
            _ => {}
        }
    }
    if !pending.is_empty() {
        on_line(pending.trim_end());
    }
    Ok((output, code.unwrap_or(255)))
}

fn friendly_ssh_error(err: russh::Error) -> String {
    let text = err.to_string();
    if text.contains("timed out") || text.contains("Connection refused") || text.contains("No route") {
        "Der Server ist nicht erreichbar. Stimmt die IP-Adresse, und läuft der Server schon?".into()
    } else {
        format!("Verbindung zum Server fehlgeschlagen: {text}")
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupResult {
    url: String,
}

/// Richtet einen frischen Debian-/Ubuntu-Server als efeu Cloud ein und verbindet dieses Gerät.
/// `domain` ist optional; ohne sie erhält die IP-Adresse ein eigenes HTTPS-Zertifikat.
#[tauri::command]
pub async fn cloud_setup(
    app: AppHandle,
    state: State<'_, Cloud>,
    host: String,
    user: Option<String>,
    password: String,
    domain: Option<String>,
    device_name: String,
) -> Result<SetupResult, String> {
    state.setup_cancel.store(false, Ordering::SeqCst);
    let host = host.trim().to_string();
    if !valid_host(&host) {
        return Err("Bitte die IP-Adresse des Servers eintragen (z. B. 49.12.34.56).".into());
    }
    let domain = domain.map(|d| d.trim().trim_end_matches('.').to_lowercase()).filter(|d| !d.is_empty());
    if let Some(d) = &domain {
        if !valid_host(d) || !d.contains('.') {
            return Err("Die Domain sieht ungültig aus.".into());
        }
    }
    let address = domain.clone().unwrap_or_else(|| host.clone());
    let user = user.map(|u| u.trim().to_string()).filter(|u| !u.is_empty()).unwrap_or_else(|| "root".into());

    let server_file = app
        .path()
        .resolve("efeu-server.mjs", tauri::path::BaseDirectory::Resource)
        .map_err(|e| e.to_string())?;
    let server_bytes = tokio::fs::read(&server_file)
        .await
        .map_err(|_| "Die Server-Datei fehlt in dieser efeu-Version.".to_string())?;
    let web_file = app
        .path()
        .resolve("efeu-web.tar.gz", tauri::path::BaseDirectory::Resource)
        .map_err(|e| e.to_string())?;
    let web_bytes = tokio::fs::read(&web_file)
        .await
        .map_err(|_| "Die Web-Oberfläche fehlt in dieser efeu-Version.".to_string())?;

    progress(&app, 0, "Verbindung zum Server wird aufgebaut");
    let config = Arc::new(client::Config { inactivity_timeout: Some(Duration::from_secs(600)), ..Default::default() });
    let addr = if host.contains(':') { format!("[{host}]:22") } else { format!("{host}:22") };
    let mut session = tokio::time::timeout(Duration::from_secs(20), client::connect(config, addr, Client))
        .await
        .map_err(|_| "Der Server antwortet nicht. Stimmt die IP-Adresse?".to_string())?
        .map_err(friendly_ssh_error)?;
    let auth = session.authenticate_password(&user, &password).await.map_err(friendly_ssh_error)?;
    if !auth.success() {
        return Err("Anmeldung fehlgeschlagen. Stimmt das Passwort?".into());
    }

    // Manche Anbieter verlangen beim ersten Anmelden ein neues Passwort; dann geht nichts automatisch.
    let (probe, _) = run(&session, "echo efeu-ok", &[], |_| {}).await?;
    if !probe.contains("efeu-ok") {
        return Err(
            "Der Server verlangt, dass das Passwort zuerst geändert wird. Bitte einmal beim Anbieter in der Konsole anmelden, ein neues Passwort setzen und es hier eintragen."
                .into(),
        );
    }

    progress(&app, 1, "Server-Datei wird übertragen");
    let (_, code) = run(&session, "umask 077 && cat > /tmp/efeu-server.mjs", &server_bytes, |_| {}).await?;
    if code != 0 {
        return Err("Die Server-Datei ließ sich nicht übertragen.".into());
    }
    let (_, code) = run(&session, "umask 077 && cat > /tmp/efeu-web.tar.gz", &web_bytes, |_| {}).await?;
    if code != 0 {
        return Err("Die Web-Oberfläche ließ sich nicht übertragen.".into());
    }

    // Erst als Datei ablegen: Würde bash das Skript von der Standardeingabe lesen, könnten Befehle
    // darin (apt, curl) den Rest des Skripts verschlucken.
    let (_, code) = run(&session, "umask 077 && cat > /tmp/efeu-install.sh", SCRIPT.as_bytes(), |_| {}).await?;
    if code != 0 {
        return Err("Das Installationsskript ließ sich nicht übertragen.".into());
    }
    let prefix = if user == "root" { String::new() } else { "sudo -n ".to_string() };
    let command = format!(
        "{prefix}bash /tmp/efeu-install.sh {} {} < /dev/null; status=$?; rm -f /tmp/efeu-install.sh; exit $status",
        quote(&address),
        quote(&device_name)
    );
    let mut key_json: Option<String> = None;
    let mut failure: Option<String> = None;
    let app_for_lines = app.clone();
    let (output, code) = run(&session, &command, &[], |line| {
        if let Some(rest) = line.strip_prefix("##SCHRITT ") {
            let (n, text) = rest.split_once(' ').unwrap_or((rest, ""));
            progress(&app_for_lines, n.parse::<u32>().unwrap_or(0) + 1, text);
        } else if let Some(rest) = line.strip_prefix("##SCHLUESSEL ") {
            key_json = Some(rest.to_string());
        } else if let Some(rest) = line.strip_prefix("##FEHLER ") {
            failure = Some(rest.to_string());
        }
    })
    .await?;
    let _ = session.disconnect(russh::Disconnect::ByApplication, "", "de").await;
    if let Some(message) = failure {
        return Err(message);
    }
    if code != 0 || key_json.is_none() {
        let tail: Vec<&str> = output.lines().rev().take(6).collect();
        let tail: Vec<&str> = tail.into_iter().rev().collect();
        return Err(format!("Die Einrichtung ist fehlgeschlagen:\n{}", tail.join("\n")));
    }
    let key: serde_json::Value = serde_json::from_str(key_json.as_deref().unwrap_or("")).map_err(|e| e.to_string())?;
    let token = key["token"].as_str().ok_or("Kein Geräteschlüssel erhalten")?.to_string();
    let device_id = key["id"].as_str().ok_or("Keine Gerätekennung erhalten")?.to_string();

    // Warten, bis HTTPS steht (das Zertifikat kommt meist nach wenigen Sekunden).
    progress(&app, TOTAL - 1, "Warte auf das HTTPS-Zertifikat");
    let url = normalize_url(&address)?;
    let client = http_client(Some(Duration::from_secs(10)))?;
    let mut ready = false;
    for _ in 0..60 {
        if state.setup_cancel.load(Ordering::SeqCst) {
            return Err("Abgebrochen".into());
        }
        if let Ok(r) = client.get(format!("{url}/api/status")).send().await {
            if r.status().is_success() {
                ready = true;
                break;
            }
        }
        tokio::time::sleep(Duration::from_secs(3)).await;
    }
    if !ready {
        return Err(
            "Der Server ist eingerichtet, aber über HTTPS noch nicht erreichbar. Sind die Ports 80 und 443 in der Firewall des Anbieters offen?"
                .into(),
        );
    }
    store_connection(&app, Connection { url: url.clone(), token, device_id }).await?;
    progress(&app, TOTAL, "Fertig");
    Ok(SetupResult { url })
}

#[tauri::command]
pub fn cloud_setup_cancel(state: State<'_, Cloud>) {
    state.setup_cancel.store(true, Ordering::SeqCst);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quotes_for_the_shell() {
        assert_eq!(quote("Erays MacBook"), "'Erays MacBook'");
        assert_eq!(quote("it's"), r"'it'\''s'");
    }

    #[test]
    fn validates_hosts() {
        assert!(valid_host("49.12.34.56"));
        assert!(valid_host("notizen.example.de"));
        assert!(valid_host("2a01:4f8::1"));
        assert!(!valid_host("49.12.34.56; rm -rf /"));
        assert!(!valid_host(""));
    }
}
