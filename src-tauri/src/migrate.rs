//! Übernahme der Daten aus flou (so hieß efeu früher).
//!
//! Läuft als erstes Plugin, also bevor Fenster und Oberfläche entstehen und bevor die Datenbank
//! geöffnet wird. Der alte Ordner (`app.flou.desktop` neben dem neuen) wird kopiert, nie verschoben
//! oder verändert; `flou.db*` heißt danach `efeu.db*`. Vorhandenes wird nie überschrieben. Kopiert
//! wird zuerst in einen Zwischenordner, damit bei einem Fehler kein halb befüllter Ordner bleibt.

use std::fs;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};

use tauri::plugin::{Builder, TauriPlugin};
use tauri::{Manager, Runtime, State};

/// Identifier, unter dem flou seine Daten und Schlüssel abgelegt hat.
pub const OLD_IDENTIFIER: &str = "app.flou.desktop";
const OLD_DB: &str = "flou.db";
const NEW_DB: &str = "efeu.db";

/// Ob beim aktuellen Start Daten aus flou übernommen wurden (für einen einmaligen Hinweis).
pub struct Migrated(AtomicBool);

pub fn plugin<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("efeu-migrate")
        .setup(|app, _api| {
            let migrated = match app.path().app_config_dir() {
                Ok(dir) => migrate_data(&dir).unwrap_or_else(|err| {
                    eprintln!("Daten aus flou konnten nicht übernommen werden: {err}");
                    false
                }),
                Err(_) => false,
            };
            app.manage(Migrated(AtomicBool::new(migrated)));
            Ok(())
        })
        .build()
}

/// Liefert einmalig true, wenn bei diesem Start Daten aus flou übernommen wurden.
#[tauri::command]
pub fn migrated_from_flou(state: State<'_, Migrated>) -> bool {
    state.0.swap(false, Ordering::SeqCst)
}

/* ---------- Schlüsselbund ---------- */

/// Übernimmt einen Schlüssel, den flou unter seinem Identifier abgelegt hat: in den neuen Eintrag
/// schreiben, alten löschen. Fehler (macOS fragt bei anderer Signatur eventuell nach) werden still
/// ignoriert; dann trägt man den Schlüssel eben neu ein.
pub fn take_old_secret(account: &str, new_entry: &keyring::Entry) -> Option<String> {
    let old = keyring::Entry::new(OLD_IDENTIFIER, account).ok()?;
    let secret = old.get_password().ok()?;
    if new_entry.set_password(&secret).is_ok() {
        let _ = old.delete_credential();
    }
    Some(secret)
}

/* ---------- macOS: Bundle „flou.app“ nach dem Update in „efeu.app“ umbenennen ---------- */

/// Das automatische Update aus flou heraus ersetzt den Inhalt von `flou.app` am alten Ort. efeu läuft dann
/// aus `…/flou.app/Contents/MacOS/efeu`; dieses Bundle wird beim Beenden in `efeu.app` umbenannt.
#[cfg(target_os = "macos")]
pub fn legacy_bundle() -> Option<std::path::PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let bundle = exe.ancestors().find(|p| p.extension().is_some_and(|e| e == "app"))?;
    (bundle.file_name()? == "flou.app").then(|| bundle.to_path_buf())
}

#[cfg(not(target_os = "macos"))]
pub fn legacy_bundle() -> Option<std::path::PathBuf> {
    None
}

const RENAME_FAILED: &str = ".flou-app-umbenennen-fehlgeschlagen";

/// Beim Beenden: altes Bundle umbenennen. Klappt es nicht (z. B. fehlende Rechte), merkt sich efeu das
/// und zeigt beim nächsten Start einen Hinweis.
pub fn rename_legacy_bundle(data_dir: &Path) {
    let Some(old) = legacy_bundle() else { return };
    let new = old.with_file_name("efeu.app");
    let marker = data_dir.join(RENAME_FAILED);
    if new.exists() || fs::rename(&old, &new).is_err() {
        let _ = fs::write(marker, old.to_string_lossy().as_bytes());
    } else {
        let _ = fs::remove_file(marker);
    }
}

/// Pfad des alten Bundles, wenn das Umbenennen beim letzten Beenden nicht geklappt hat.
#[tauri::command]
pub fn legacy_bundle_hint(app: tauri::AppHandle) -> Option<String> {
    let bundle = legacy_bundle()?;
    let dir = app.path().app_config_dir().ok()?;
    dir.join(RENAME_FAILED).exists().then(|| bundle.to_string_lossy().into_owned())
}

/// Kopiert den flou-Ordner neben `new_dir` nach `new_dir`, falls dort noch keine Datenbank liegt.
pub fn migrate_data(new_dir: &Path) -> Result<bool, String> {
    let parent = new_dir.parent().ok_or("Datenordner ohne übergeordneten Ordner")?;
    let old_dir = parent.join(OLD_IDENTIFIER);
    if new_dir.join(NEW_DB).exists() || !old_dir.join(OLD_DB).is_file() {
        return Ok(false);
    }
    let name = new_dir.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "efeu".into());
    // Reste abgebrochener Versuche (z. B. Absturz während des Kopierens) wegräumen.
    let stale = format!(".{name}.uebernahme-");
    for entry in fs::read_dir(parent).map_err(|e| e.to_string())?.flatten() {
        if entry.file_name().to_string_lossy().starts_with(&stale) {
            let _ = fs::remove_dir_all(entry.path());
        }
    }
    let temp = parent.join(format!("{stale}{}", std::process::id()));
    if let Err(err) = copy_tree(&old_dir, &temp, true) {
        let _ = fs::remove_dir_all(&temp);
        return Err(err);
    }
    if !new_dir.exists() {
        fs::rename(&temp, new_dir).map_err(|e| {
            let _ = fs::remove_dir_all(&temp);
            format!("{}: {e}", new_dir.display())
        })?;
        return Ok(true);
    }
    // Neuer Ordner existiert schon (ohne Datenbank): Datei für Datei ergänzen, was dort fehlt.
    let result = merge(&temp, new_dir);
    let _ = fs::remove_dir_all(&temp);
    result.map(|()| true)
}

/// Verschiebt alles aus `from` nach `to`, was dort noch nicht existiert (Ordner werden zusammengeführt).
fn merge(from: &Path, to: &Path) -> Result<(), String> {
    for entry in fs::read_dir(from).map_err(|e| e.to_string())?.flatten() {
        let target = to.join(entry.file_name());
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        if !target.exists() {
            fs::rename(entry.path(), &target).map_err(|e| format!("{}: {e}", target.display()))?;
        } else if is_dir && target.is_dir() {
            merge(&entry.path(), &target)?;
        }
    }
    Ok(())
}

/// Neuer Name für Dateien direkt im Datenordner (nur die Datenbank wird umbenannt).
fn renamed(name: &str) -> String {
    match name {
        "flou.db" => "efeu.db".into(),
        "flou.db-wal" => "efeu.db-wal".into(),
        "flou.db-shm" => "efeu.db-shm".into(),
        other => other.into(),
    }
}

fn copy_tree(from: &Path, to: &Path, root: bool) -> Result<(), String> {
    fs::create_dir_all(to).map_err(|e| format!("{}: {e}", to.display()))?;
    for entry in fs::read_dir(from).map_err(|e| format!("{}: {e}", from.display()))? {
        let entry = entry.map_err(|e| e.to_string())?;
        let file_name = entry.file_name().to_string_lossy().into_owned();
        // Halbfertige Downloads und Zwischenstände nicht mitnehmen.
        if file_name.ends_with(".part") || file_name.ends_with(".partial") {
            continue;
        }
        let target = to.join(if root { renamed(&file_name) } else { file_name });
        let kind = entry.file_type().map_err(|e| e.to_string())?;
        if kind.is_dir() {
            copy_tree(&entry.path(), &target, false)?;
        } else if kind.is_file() {
            fs::copy(entry.path(), &target).map_err(|e| format!("{}: {e}", target.display()))?;
        }
        // Symbolische Links gibt es im Datenordner nicht; falls doch, werden sie übersprungen.
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn temp_root(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("efeu-migrate-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        root
    }

    fn old_install(root: &Path) -> PathBuf {
        let old = root.join(OLD_IDENTIFIER);
        fs::create_dir_all(old.join("assets")).unwrap();
        fs::create_dir_all(old.join("backups/2026-10-01/assets")).unwrap();
        fs::write(old.join("flou.db"), b"daten").unwrap();
        fs::write(old.join("flou.db-wal"), b"wal").unwrap();
        fs::write(old.join("assets/abc.png"), b"bild").unwrap();
        fs::write(old.join("backups/2026-10-01/flou.db"), b"backup").unwrap();
        old
    }

    #[test]
    fn copies_and_renames_without_touching_the_old_folder() {
        let root = temp_root("copy");
        let old = old_install(&root);
        let new = root.join("app.efeu.desktop");
        assert!(migrate_data(&new).unwrap());
        assert_eq!(fs::read(new.join("efeu.db")).unwrap(), b"daten");
        assert_eq!(fs::read(new.join("efeu.db-wal")).unwrap(), b"wal");
        assert_eq!(fs::read(new.join("assets/abc.png")).unwrap(), b"bild");
        // Backups behalten ihren Inhalt (alte Sicherungen heißen weiter flou.db).
        assert!(new.join("backups/2026-10-01/flou.db").exists());
        assert!(!new.join("flou.db").exists());
        // Alter Ordner unverändert
        assert_eq!(fs::read(old.join("flou.db")).unwrap(), b"daten");
        assert!(old.join("assets/abc.png").exists());
        // Kein Zwischenordner übrig
        assert_eq!(fs::read_dir(&root).unwrap().count(), 2);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn runs_only_once_and_never_overwrites() {
        let root = temp_root("once");
        old_install(&root);
        let new = root.join("app.efeu.desktop");
        assert!(migrate_data(&new).unwrap());
        fs::write(new.join("efeu.db"), b"neuer stand").unwrap();
        assert!(!migrate_data(&new).unwrap());
        assert_eq!(fs::read(new.join("efeu.db")).unwrap(), b"neuer stand");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn fills_an_existing_folder_without_overwriting() {
        let root = temp_root("merge");
        old_install(&root);
        let new = root.join("app.efeu.desktop");
        fs::create_dir_all(new.join("assets")).unwrap();
        fs::write(new.join("assets/eigenes.png"), b"neu").unwrap();
        assert!(migrate_data(&new).unwrap());
        assert_eq!(fs::read(new.join("efeu.db")).unwrap(), b"daten");
        // Vorhandenes bleibt, Fehlendes kommt dazu.
        assert_eq!(fs::read(new.join("assets/eigenes.png")).unwrap(), b"neu");
        assert_eq!(fs::read(new.join("assets/abc.png")).unwrap(), b"bild");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn cleans_up_after_an_aborted_attempt() {
        let root = temp_root("abort");
        old_install(&root);
        let leftover = root.join(".app.efeu.desktop.uebernahme-12345");
        fs::create_dir_all(leftover.join("assets")).unwrap();
        assert!(migrate_data(&root.join("app.efeu.desktop")).unwrap());
        assert!(!leftover.exists());
        assert_eq!(fs::read_dir(&root).unwrap().count(), 2);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn does_nothing_without_flou() {
        let root = temp_root("none");
        assert!(!migrate_data(&root.join("app.efeu.desktop")).unwrap());
        assert!(!root.join("app.efeu.desktop").exists());
        let _ = fs::remove_dir_all(&root);
    }
}
