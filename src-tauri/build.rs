fn main() {
    link_clang_runtime();
    tauri_build::build()
}

/// whisper.cpp (Metal) prüft mit `@available`, ob neuere macOS-Funktionen da sind, weil efeu bis macOS 13
/// zurück läuft. Dafür braucht es `___isPlatformVersionAtLeast` aus der Compiler-Laufzeit, die rustc
/// nicht von selbst dazulinkt.
fn link_clang_runtime() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("macos") {
        return;
    }
    let Ok(output) = std::process::Command::new("clang").arg("--print-resource-dir").output() else { return };
    let dir = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let lib = std::path::Path::new(&dir).join("lib/darwin/libclang_rt.osx.a");
    if lib.exists() {
        println!("cargo:rustc-link-arg={}", lib.display());
    }
}
