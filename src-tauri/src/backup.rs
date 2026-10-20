use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use tauri::{AppHandle, Manager};

use crate::db::Db;
use crate::paths::{assets_dir, backups_dir, db_path, DB_FILE};

/// Anzahl der aufbewahrten Backups.
const KEEP: usize = 7;

/// Kopiert die Bilder per Hardlink (sie ändern sich nie, Namen sind Inhalts-Hashes), sonst als Kopie.
fn link_or_copy_dir(source: &Path, target: &Path) -> Result<(), String> {
    fs::create_dir_all(target).map_err(|e| e.to_string())?;
    if !source.exists() {
        return Ok(());
    }
    for entry in fs::read_dir(source).map_err(|e| e.to_string())?.filter_map(Result::ok) {
        let path = entry.path();
        if !path.is_file() || entry.file_name().to_string_lossy().starts_with('.') {
            continue;
        }
        let dest = target.join(entry.file_name());
        if fs::hard_link(&path, &dest).is_err() {
            fs::copy(&path, &dest).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// Erstellt ein vollständiges Backup (Datenbank + Bilder) in backups/<name>.
async fn create_backup(app: &AppHandle, name: &str) -> Result<PathBuf, String> {
    if !db_path(app)?.exists() {
        return Err("Noch keine Datenbank vorhanden".into());
    }
    let root = backups_dir(app)?;
    let target = root.join(name);
    let partial = root.join(format!(".{name}.partial"));
    let _ = fs::remove_dir_all(&partial);
    fs::create_dir_all(&partial).map_err(|e| e.to_string())?;

    // VACUUM INTO erzeugt eine konsistente, kompakte Kopie, auch während die App schreibt.
    let db = app.state::<Db>();
    let pool = db.pool(app).await?;
    sqlx::query("VACUUM INTO ?")
        .bind(partial.join(DB_FILE).to_string_lossy().into_owned())
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
    link_or_copy_dir(&assets_dir(app)?, &partial.join("assets"))?;

    let _ = fs::remove_dir_all(&target);
    fs::rename(&partial, &target).map_err(|e| e.to_string())?;
    prune(&root)?;
    Ok(target)
}

/// Behält nur die neuesten Backups (Namen beginnen mit dem Datum, sortieren also chronologisch).
fn prune(root: &Path) -> Result<(), String> {
    let mut names: Vec<String> = fs::read_dir(root)
        .map_err(|e| e.to_string())?
        .filter_map(Result::ok)
        .filter(|e| e.path().is_dir())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| !n.starts_with('.'))
        .collect();
    names.sort();
    let excess = names.len().saturating_sub(KEEP);
    for name in names.into_iter().take(excess) {
        fs::remove_dir_all(root.join(name)).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn today() -> String {
    chrono::Local::now().format("%Y-%m-%d").to_string()
}

/// Tägliches Backup, falls es für heute noch keines gibt.
async fn backup_if_due(app: &AppHandle) -> Result<(), String> {
    let root = backups_dir(app)?;
    let today = today();
    let exists = fs::read_dir(&root)
        .map_err(|e| e.to_string())?
        .filter_map(Result::ok)
        .any(|e| e.file_name().to_string_lossy().starts_with(&today));
    if !exists {
        create_backup(app, &today).await?;
    }
    Ok(())
}

/// Prüft kurz nach dem Start und danach stündlich, ob ein Backup fällig ist.
pub fn schedule(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(10)).await;
        loop {
            if let Err(err) = backup_if_due(&app).await {
                eprintln!("Backup fehlgeschlagen: {err}");
            }
            tokio::time::sleep(Duration::from_secs(60 * 60)).await;
        }
    });
}

/// Sofortiges Backup auf Wunsch. Liefert den Ordner.
#[tauri::command]
pub async fn backup_now(app: AppHandle) -> Result<String, String> {
    let name = chrono::Local::now().format("%Y-%m-%d_%H%M%S").to_string();
    create_backup(&app, &name).await.map(|p| p.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::prune;
    use std::fs;

    #[test]
    fn keeps_newest_seven() {
        let root = std::env::temp_dir().join(format!("efeu-backup-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        for day in 1..=10 {
            fs::create_dir_all(root.join(format!("2026-01-{day:02}"))).unwrap();
        }
        fs::create_dir_all(root.join(".2026-01-11.partial")).unwrap();
        prune(&root).unwrap();
        let mut left: Vec<_> = fs::read_dir(&root)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|n| !n.starts_with('.'))
            .collect();
        left.sort();
        assert_eq!(left.first().unwrap(), "2026-01-04");
        assert_eq!(left.len(), 7);
        fs::remove_dir_all(&root).unwrap();
    }
}
