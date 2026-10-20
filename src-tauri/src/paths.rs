use std::path::PathBuf;

use serde::Serialize;
use tauri::{AppHandle, Manager};

pub const DB_FILE: &str = "efeu.db";
pub const DB_URL: &str = "sqlite:efeu.db";

/// Basisordner aller Daten: ~/Library/Application Support/<identifier>/
/// tauri-plugin-sql legt die Datenbank in app_config_dir an; auf macOS ist das derselbe Ordner wie app_data_dir.
pub fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_config_dir().map_err(|e| e.to_string())
}

pub fn db_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(data_dir(app)?.join(DB_FILE))
}

pub fn assets_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(data_dir(app)?.join("assets"))
}

pub fn backups_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(data_dir(app)?.join("backups"))
}

pub fn ensure_dirs(app: &AppHandle) -> Result<(), String> {
    for dir in [data_dir(app)?, assets_dir(app)?, backups_dir(app)?] {
        std::fs::create_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    }
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppPaths {
    data_dir: String,
    assets_dir: String,
    backups_dir: String,
}

#[tauri::command]
pub fn app_paths(app: AppHandle) -> Result<AppPaths, String> {
    Ok(AppPaths {
        data_dir: data_dir(&app)?.to_string_lossy().into_owned(),
        assets_dir: assets_dir(&app)?.to_string_lossy().into_owned(),
        backups_dir: backups_dir(&app)?.to_string_lossy().into_owned(),
    })
}

/// Öffnet einen Ordner der App im Finder bzw. Explorer.
#[tauri::command]
pub fn reveal_dir(app: AppHandle, which: String) -> Result<(), String> {
    let dir = match which.as_str() {
        "data" => data_dir(&app)?,
        "backups" => backups_dir(&app)?,
        _ => return Err(format!("Unbekannter Ordner: {which}")),
    };
    tauri_plugin_opener::open_path(&dir, None::<&str>).map_err(|e| e.to_string())
}
