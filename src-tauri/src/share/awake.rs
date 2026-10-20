//! Kein Ruhezustand, solange geteilt wird. Der Bildschirm darf trotzdem ausgehen;
//! ein zugeklappter Laptop schläft auf macOS weiterhin (Systemverhalten).

#[cfg(target_os = "macos")]
pub(crate) struct KeepAwake {
    child: Option<std::process::Child>,
}

#[cfg(target_os = "macos")]
impl KeepAwake {
    pub(crate) fn start() -> Self {
        use std::process::{Command, Stdio};
        // caffeinate beendet sich mit -w auch dann, wenn efeu abstürzt.
        let child = Command::new("/usr/bin/caffeinate")
            .args(["-i", "-w", &std::process::id().to_string()])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .ok();
        Self { child }
    }
}

#[cfg(target_os = "macos")]
impl Drop for KeepAwake {
    fn drop(&mut self) {
        if let Some(mut child) = self.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

#[cfg(windows)]
pub(crate) struct KeepAwake {
    stop: Option<std::sync::mpsc::Sender<()>>,
}

#[cfg(windows)]
impl KeepAwake {
    pub(crate) fn start() -> Self {
        use windows_sys::Win32::System::Power::{SetThreadExecutionState, ES_CONTINUOUS, ES_SYSTEM_REQUIRED};
        let (stop, stopped) = std::sync::mpsc::channel::<()>();
        // Der Zustand gilt pro Thread: ein eigener Thread hält ihn, bis die Freigabe endet.
        std::thread::spawn(move || {
            unsafe { SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED) };
            let _ = stopped.recv();
            unsafe { SetThreadExecutionState(ES_CONTINUOUS) };
        });
        Self { stop: Some(stop) }
    }
}

#[cfg(windows)]
impl Drop for KeepAwake {
    fn drop(&mut self) {
        self.stop.take();
    }
}

#[cfg(not(any(target_os = "macos", windows)))]
pub(crate) struct KeepAwake;

#[cfg(not(any(target_os = "macos", windows)))]
impl KeepAwake {
    pub(crate) fn start() -> Self {
        Self
    }
}
