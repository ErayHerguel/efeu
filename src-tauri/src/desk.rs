//! Arbeiten außerhalb des Hauptfensters: Schnellnotiz per globalem Tastenkürzel und Symbol in der
//! Menüleiste (macOS) bzw. im Infobereich (Windows). Damit kann efeu auch ohne offenes Fenster
//! weiterlaufen, etwa solange geteilt wird.

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{App, AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

const QUICK: &str = "quick";

/// ⌃⌥N (Windows: Strg+Alt+N) öffnet die Schnellnotiz, egal welches Programm vorne ist.
fn quick_shortcut() -> Shortcut {
    Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::KeyN)
}

/// Zeigt das Hauptfenster (z. B. nach dem Schließen, während efeu im Hintergrund weiterläuft).
pub fn show_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// Kleines Fenster für eine schnelle Notiz. Die Notiz selbst legt das Hauptfenster an.
pub fn open_quick(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(QUICK) {
        let _ = window.show();
        let _ = window.set_focus();
        return;
    }
    let builder = WebviewWindowBuilder::new(app, QUICK, WebviewUrl::App("index.html#quick".into()))
        .title("Schnellnotiz")
        .inner_size(560.0, 250.0)
        .resizable(false)
        .always_on_top(true)
        .center()
        .focused(true);
    #[cfg(target_os = "macos")]
    let builder = builder.title_bar_style(tauri::TitleBarStyle::Overlay).hidden_title(true);
    if let Err(err) = builder.build() {
        eprintln!("Schnellnotiz konnte nicht geöffnet werden: {err}");
    }
}

fn tray_menu(app: &AppHandle, recording: bool) -> tauri::Result<Menu<tauri::Wry>> {
    let quick = MenuItem::with_id(app, "quick", "Schnellnotiz", true, Some("Ctrl+Alt+N"))?;
    let open = MenuItem::with_id(app, "open", "efeu öffnen", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "efeu beenden", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    if recording {
        let stop = MenuItem::with_id(app, "lecture-stop", "Mitschrift beenden", true, None::<&str>)?;
        let separator2 = PredefinedMenuItem::separator(app)?;
        return Menu::with_items(app, &[&stop, &separator2, &quick, &open, &separator, &quit]);
    }
    Menu::with_items(app, &[&quick, &open, &separator, &quit])
}

/// Mitschrift läuft: Hinweis in der Menüleiste (macOS: „● Mitschrift“ neben dem Symbol) und Eintrag zum Beenden.
#[tauri::command]
pub fn tray_recording(app: AppHandle, recording: bool) -> Result<(), String> {
    let Some(tray) = app.tray_by_id("efeu") else { return Ok(()) };
    tray.set_menu(Some(tray_menu(&app, recording).map_err(|e| e.to_string())?)).map_err(|e| e.to_string())?;
    let _ = tray.set_tooltip(Some(if recording { "efeu – Mitschrift läuft" } else { "efeu" }));
    #[cfg(target_os = "macos")]
    let _ = tray.set_title(if recording { Some("● Mitschrift") } else { None });
    Ok(())
}

/// Öffnet die Schnellnotiz aus dem Hauptfenster heraus (Befehlspalette).
#[tauri::command]
pub fn quick_note_open(app: AppHandle) {
    open_quick(&app);
}

pub fn setup(app: &mut App) -> tauri::Result<()> {
    let shortcut = quick_shortcut();
    app.handle().plugin(
        tauri_plugin_global_shortcut::Builder::new()
            .with_handler(move |app, pressed, event| {
                if pressed == &shortcut && event.state() == ShortcutState::Pressed {
                    open_quick(app);
                }
            })
            .build(),
    )?;
    // Ist das Kürzel schon von einem anderen Programm belegt, bleibt die Schnellnotiz über Menü und Palette erreichbar.
    if let Err(err) = app.global_shortcut().register(quick_shortcut()) {
        eprintln!("Kürzel für die Schnellnotiz nicht verfügbar: {err}");
    }

    let menu = tray_menu(app.handle(), false)?;
    // macOS: einfarbige Vorlage, die sich der Menüleiste anpasst; Windows: farbiges App-Symbol.
    #[cfg(target_os = "macos")]
    let icon = tauri::include_image!("icons/tray.png");
    #[cfg(not(target_os = "macos"))]
    let icon = app.default_window_icon().cloned().unwrap_or_else(|| tauri::include_image!("icons/tray.png"));
    TrayIconBuilder::with_id("efeu")
        .icon(icon)
        .icon_as_template(cfg!(target_os = "macos"))
        .tooltip("efeu")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "quick" => open_quick(app),
            "open" => show_main(app),
            "lecture-stop" => {
                let _ = app.emit_to("main", "tray:lecture-stop", ());
            }
            // Beenden über das Hauptfenster, damit vorher alles gespeichert wird.
            "quit" => {
                show_main(app);
                let _ = app.emit_to("main", "tray:quit", ());
            }
            _ => {}
        })
        .build(app)?;
    Ok(())
}
