mod ai;
mod assets;
mod backup;
mod cloud;
mod db;
mod desk;
mod lecture;
mod migrate;
mod notify;
mod paths;
mod share;
mod transfer;
mod unsplash;

use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager, State, WebviewWindow};
use tauri_plugin_sql::{Migration, MigrationKind};

fn migrations() -> Vec<Migration> {
    vec![
        Migration {
            version: 1,
            description: "init",
            sql: include_str!("../migrations/001_init.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 2,
            description: "databases",
            sql: include_str!("../migrations/002_databases.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 3,
            description: "search",
            sql: include_str!("../migrations/003_search.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 4,
            description: "extras",
            sql: include_str!("../migrations/004_extras.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 5,
            description: "boards",
            sql: include_str!("../migrations/005_boards.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 6,
            description: "share",
            sql: include_str!("../migrations/006_share.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 7,
            description: "devices",
            sql: include_str!("../migrations/007_devices.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 8,
            description: "ai usage",
            sql: include_str!("../migrations/008_ai_usage.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 9,
            description: "cover credits",
            sql: include_str!("../migrations/009_cover_credits.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 10,
            description: "cloud sync",
            sql: include_str!("../migrations/010_sync.sql"),
            kind: MigrationKind::Up,
        },
    ]
}

/// Zeitpunkt des Prozessstarts, für die Messung des Kaltstarts.
struct StartTime(Instant);

/// Das Frontend ist geladen und hat zum ersten Mal gerendert: Fenster zeigen, Startzeit protokollieren.
#[tauri::command]
fn app_ready(window: WebviewWindow, start: State<'_, StartTime>) {
    let _ = window.show();
    let _ = window.set_focus();
    println!("efeu bereit nach {} ms", start.0.elapsed().as_millis());
}

/// Öffnet den macOS-Druckdialog für die aktuelle Ansicht (dort auch „Als PDF sichern“).
#[tauri::command]
fn print_page(window: WebviewWindow) -> Result<(), String> {
    window.print().map_err(|e| e.to_string())
}

/// Beendet die App, nachdem das Frontend ausstehende Änderungen gespeichert hat.
#[tauri::command]
fn app_quit(app: AppHandle) {
    app.exit(0);
}

pub fn run() {
    let started = StartTime(Instant::now());
    let mut builder = tauri::Builder::default();
    if let Some(plugin) = notify::plugin() {
        builder = builder.plugin(plugin);
    }
    builder
        // Zuerst: Daten aus flou übernehmen, bevor Fenster und Datenbank geöffnet werden.
        .plugin(migrate::plugin())
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations(paths::DB_URL, migrations())
                .build(),
        )
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(db::Db::new())
        .manage(ai::Ai::new())
        .manage(unsplash::Unsplash::new())
        .manage(lecture::Lecture::new())
        .manage(share::Share::new())
        .manage(cloud::Cloud::new())
        .manage(started)
        .setup(|app| {
            paths::ensure_dirs(app.handle())?;
            desk::setup(app)?;
            backup::schedule(app.handle().clone());
            cloud::dev_autojoin(app.handle());
            // Das Fenster startet unsichtbar und wird vom Frontend nach dem ersten Rendern gezeigt
            // (kein weißes Aufblitzen im Dark Mode). Fallback, falls das Frontend hängt:
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(Duration::from_millis(1500)).await;
                if let Some(window) = handle.get_webview_window("main") {
                    if !window.is_visible().unwrap_or(true) {
                        let _ = window.show();
                    }
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_quit,
            app_ready,
            ai::ai_cancel,
            ai::ai_count,
            ai::ai_key_delete,
            cloud::cloud_status,
            cloud::cloud_request,
            cloud::cloud_assets_local,
            cloud::cloud_asset_upload,
            cloud::cloud_asset_download,
            cloud::cloud_pair,
            cloud::cloud_forget,
            cloud::cloud_events,
            cloud::setup::cloud_setup,
            cloud::setup::cloud_setup_cancel,
            cloud::device_name,
            ai::ai_key_set,
            ai::ai_mock,
            ai::ai_read_pdf,
            ai::ai_stream,
            ai::ai_test,
            notify::notify,
            print_page,
            assets::file_import,
            assets::file_import_bytes,
            assets::open_asset,
            assets::asset_import_bytes,
            assets::asset_import_file,
            assets::open_external,
            backup::backup_now,
            db::db_tx,
            desk::quick_note_open,
            desk::tray_recording,
            lecture::lecture_devices,
            lecture::lecture_download,
            lecture::lecture_monitor,
            lecture::lecture_pause,
            lecture::lecture_start,
            lecture::lecture_status,
            lecture::lecture_stop,
            migrate::legacy_bundle_hint,
            migrate::migrated_from_flou,
            paths::app_paths,
            paths::reveal_dir,
            share::open_shared,
            share::share_announce,
            share::share_close_member,
            share::share_keep_awake,
            share::share_send,
            share::share_start,
            share::share_status,
            share::share_stop,
            transfer::export_write,
            transfer::import_read,
            transfer::reveal_path,
            transfer::save_file,
            unsplash::unsplash_key_delete,
            unsplash::unsplash_key_set,
            unsplash::unsplash_search,
            unsplash::unsplash_use,
        ])
        .build(tauri::generate_context!())
        .expect("Fehler beim Starten von efeu")
        .run(|app, event| match event {
            tauri::RunEvent::Exit => {
                share::shutdown(app);
                if let Ok(dir) = paths::data_dir(app) {
                    migrate::rename_legacy_bundle(&dir);
                }
            }
            // Klick aufs Dock-Symbol, während efeu im Hintergrund läuft: Fenster wieder zeigen.
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Reopen { .. } => desk::show_main(app),
            _ => {}
        });
}
