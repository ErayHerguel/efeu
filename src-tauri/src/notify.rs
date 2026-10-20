//! Mitteilungen des Systems für Erinnerungen. Unter Windows als Toast über das Tauri-Plugin.
//! macOS lässt Mitteilungen nur für Apps mit kostenpflichtiger Apple-Signatur zu; dort erinnert
//! efeu im Fenster und mit einer Zahl am Dock-Symbol (siehe src/features/reminders.ts).

#[tauri::command]
pub fn notify(app: tauri::AppHandle, title: String, body: String) -> Result<(), String> {
    #[cfg(not(target_os = "macos"))]
    {
        use tauri_plugin_notification::NotificationExt;
        app.notification().builder().title(title).body(body).show().map_err(|e| e.to_string())
    }
    #[cfg(target_os = "macos")]
    {
        let _ = (app, title, body);
        Ok(())
    }
}

/// Plugin nur dort, wo es Mitteilungen anzeigen kann.
pub fn plugin<R: tauri::Runtime>() -> Option<tauri::plugin::TauriPlugin<R>> {
    #[cfg(not(target_os = "macos"))]
    return Some(tauri_plugin_notification::init());
    #[cfg(target_os = "macos")]
    None
}
