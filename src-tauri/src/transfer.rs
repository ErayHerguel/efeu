use std::fs;
use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::paths::assets_dir;

const MAX_IMPORT_FILES: usize = 10_000;
const MAX_FILE_BYTES: u64 = 20 * 1024 * 1024;

/// Verbindet einen relativen Pfad mit `root` und verhindert das Verlassen des Zielordners.
fn safe_join(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let rel = Path::new(relative);
    if relative.is_empty() || rel.is_absolute() || rel.components().any(|c| !matches!(c, Component::Normal(_))) {
        return Err(format!("Ungültiger Pfad: {relative}"));
    }
    Ok(root.join(rel))
}

#[derive(Deserialize)]
pub struct OutFile {
    path: String,
    content: String,
}

#[derive(Deserialize)]
pub struct OutAsset {
    name: String,
    path: String,
}

/// Schreibt einen Markdown-Export: Dateien und kopierte Bilder unterhalb von `root`.
#[tauri::command]
pub fn export_write(app: AppHandle, root: String, files: Vec<OutFile>, assets: Vec<OutAsset>) -> Result<(), String> {
    write_export(Path::new(&root), files, assets, &assets_dir(&app)?)
}

fn write_export(root: &Path, files: Vec<OutFile>, assets: Vec<OutAsset>, source_dir: &Path) -> Result<(), String> {
    fs::create_dir_all(root).map_err(|e| format!("{}: {e}", root.display()))?;
    // Alle Pfade vorab prüfen: entweder wird alles geschrieben oder nichts.
    for file in &files {
        safe_join(root, &file.path)?;
    }
    for asset in &assets {
        safe_join(root, &asset.path)?;
        if asset.name.contains(['/', '\\']) || asset.name.starts_with('.') {
            return Err(format!("Ungültiger Bildname: {}", asset.name));
        }
    }
    for file in files {
        let target = safe_join(root, &file.path)?;
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        fs::write(&target, file.content).map_err(|e| format!("{}: {e}", target.display()))?;
    }
    for asset in assets {
        let source = source_dir.join(&asset.name);
        if !source.exists() {
            continue;
        }
        let target = safe_join(root, &asset.path)?;
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        fs::copy(&source, &target).map_err(|e| format!("{}: {e}", target.display()))?;
    }
    Ok(())
}

#[derive(Serialize)]
pub struct InFile {
    /// Pfad relativ zum gewählten Ordner (mit "/"), bei Einzeldateien nur der Dateiname
    rel: String,
    abs: String,
    content: String,
}

fn is_markdown(path: &Path) -> bool {
    matches!(
        path.extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase).as_deref(),
        Some("md" | "markdown")
    )
}

/// Markdown-Seiten und CSV-Tabellen (Datenbanken aus dem Notion-Export).
fn is_importable(path: &Path) -> bool {
    is_markdown(path)
        || path
            .extension()
            .and_then(|e| e.to_str())
            .is_some_and(|e| e.eq_ignore_ascii_case("csv"))
}

fn read_file(path: &Path, rel: String, out: &mut Vec<InFile>) -> Result<(), String> {
    if out.len() >= MAX_IMPORT_FILES {
        return Err(format!("Mehr als {MAX_IMPORT_FILES} Dateien"));
    }
    let size = fs::metadata(path).map_err(|e| e.to_string())?.len();
    if size > MAX_FILE_BYTES {
        return Err(format!("{} ist größer als 20 MB", path.display()));
    }
    let bytes = fs::read(path).map_err(|e| format!("{}: {e}", path.display()))?;
    out.push(InFile {
        rel,
        abs: path.to_string_lossy().into_owned(),
        content: String::from_utf8_lossy(&bytes).into_owned(),
    });
    Ok(())
}

fn walk(dir: &Path, base: &Path, out: &mut Vec<InFile>) -> Result<(), String> {
    let mut entries: Vec<_> = fs::read_dir(dir)
        .map_err(|e| format!("{}: {e}", dir.display()))?
        .filter_map(Result::ok)
        .collect();
    entries.sort_by_key(|e| e.file_name());
    for entry in entries {
        let path = entry.path();
        let hidden = entry.file_name().to_string_lossy().starts_with('.');
        let file_type = entry.file_type().map_err(|e| e.to_string())?;
        if hidden || file_type.is_symlink() {
            continue;
        }
        if file_type.is_dir() {
            walk(&path, base, out)?;
        } else if is_importable(&path) {
            let rel = path
                .strip_prefix(base)
                .map_err(|e| e.to_string())?
                .components()
                .map(|c| c.as_os_str().to_string_lossy())
                .collect::<Vec<_>>()
                .join("/");
            read_file(&path, rel, out)?;
        }
    }
    Ok(())
}

/// Liest Markdown-Dateien bzw. ganze Ordner (rekursiv) für den Import.
#[tauri::command]
pub fn import_read(paths: Vec<String>) -> Result<Vec<InFile>, String> {
    let mut out = Vec::new();
    for raw in paths {
        let path = PathBuf::from(&raw);
        if path.is_dir() {
            walk(&path, &path, &mut out)?;
        } else if is_importable(&path) {
            let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            read_file(&path, name, &mut out)?;
        }
    }
    Ok(out)
}

/// Schreibt Bytes (z. B. ein exportiertes Board-Bild) an einen vom Nutzer im Dialog gewählten Pfad.
/// Der Pfad kommt URL-kodiert im Header `x-path`.
#[tauri::command]
pub fn save_file(request: tauri::ipc::Request<'_>) -> Result<(), String> {
    let raw = request.headers().get("x-path").and_then(|v| v.to_str().ok()).ok_or("Header x-path fehlt")?;
    let path = percent_decode(raw);
    match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) => fs::write(&path, bytes).map_err(|e| format!("{path}: {e}")),
        tauri::ipc::InvokeBody::Json(_) => Err("Erwartet Binärdaten".into()),
    }
}

/// Minimale Prozent-Dekodierung für Pfade aus encodeURIComponent.
fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(b) = u8::from_str_radix(&input[i + 1..i + 3], 16) {
                out.push(b);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Zeigt eine vom Nutzer gewählte Export-Datei oder einen Ordner im Finder bzw. Explorer.
#[tauri::command]
pub fn reveal_path(path: String) -> Result<(), String> {
    // Das Frontend setzt Pfade mit "/" zusammen; der Explorer braucht native Trenner.
    #[cfg(windows)]
    let path = path.replace('/', "\\");
    tauri_plugin_opener::reveal_item_in_dir(PathBuf::from(path)).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_paths() {
        assert_eq!(percent_decode("%2FUsers%2Feray%2FBoard%20%C3%BC.png"), "/Users/eray/Board ü.png");
        assert_eq!(percent_decode("ohne"), "ohne");
        assert_eq!(percent_decode("kaputt%2"), "kaputt%2");
    }

    #[test]
    fn rejects_escaping_paths() {
        let root = Path::new("/tmp/export");
        assert!(safe_join(root, "a/b.md").is_ok());
        assert!(safe_join(root, "../x.md").is_err());
        assert!(safe_join(root, "/etc/passwd").is_err());
        assert!(safe_join(root, "a/../../x").is_err());
        assert!(safe_join(root, "").is_err());
    }

    #[test]
    fn writes_export_with_assets() {
        let base = std::env::temp_dir().join(format!("efeu-export-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        let source = base.join("assets-src");
        fs::create_dir_all(&source).unwrap();
        fs::write(source.join("abc.png"), [1u8, 2, 3]).unwrap();
        let root = base.join("ziel");
        let files = vec![
            OutFile { path: "Projekt.md".into(), content: "# Projekt\n".into() },
            OutFile { path: "Projekt/Notiz.md".into(), content: "![](../assets/abc.png)\n".into() },
        ];
        let assets = vec![
            OutAsset { name: "abc.png".into(), path: "assets/abc.png".into() },
            OutAsset { name: "fehlt.png".into(), path: "assets/fehlt.png".into() },
        ];
        write_export(&root, files, assets, &source).unwrap();
        assert_eq!(fs::read_to_string(root.join("Projekt/Notiz.md")).unwrap(), "![](../assets/abc.png)\n");
        assert_eq!(fs::read(root.join("assets/abc.png")).unwrap(), vec![1, 2, 3]);
        assert!(!root.join("assets/fehlt.png").exists());

        let evil = vec![OutFile { path: "../ausbruch.md".into(), content: String::new() }];
        assert!(write_export(&root, evil, vec![], &source).is_err());
        assert!(!base.join("ausbruch.md").exists());
        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn reads_markdown_tree() {
        let dir = std::env::temp_dir().join(format!("efeu-import-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("Projekt")).unwrap();
        fs::write(dir.join("Projekt.md"), "# Projekt").unwrap();
        fs::write(dir.join("Projekt/Notiz.md"), "Text").unwrap();
        fs::write(dir.join("bild.png"), [0u8; 4]).unwrap();
        fs::write(dir.join(".versteckt.md"), "x").unwrap();
        let files = import_read(vec![dir.to_string_lossy().into_owned()]).unwrap();
        let rels: Vec<_> = files.iter().map(|f| f.rel.as_str()).collect();
        assert_eq!(rels, vec!["Projekt/Notiz.md", "Projekt.md"]);
        fs::remove_dir_all(&dir).unwrap();
    }
}
