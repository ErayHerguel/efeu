//! Vorlesungen mitschreiben: Mikrofon → lokale Spracherkennung (Whisper) → Text.
//!
//! Alles läuft in eigenen Threads, unabhängig vom Fenster: Aufnahme und Erkennung gehen weiter,
//! während man andere Programme nutzt oder das efeu-Fenster geschlossen ist. Der Ton wird nur im
//! Arbeitsspeicher gepuffert, abschnittsweise erkannt und sofort verworfen; es entsteht nie eine
//! Audiodatei. Erkannter Text geht als Ereignis `lecture` ans Frontend.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use futures_util::StreamExt;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::AsyncWriteExt;
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

const RATE: usize = 16_000;
/// Länge eines Erkennungsabschnitts; geschnitten wird an der leisesten Stelle davor.
const CHUNK_SECS: usize = 28;
const SEARCH_SECS: usize = 6;
/// Empfindlichkeit: ab welcher Lautstärke ein Abschnitt als Sprache gilt (darunter: Stille, wird übersprungen,
/// verhindert Fantasietexte) und wie stark leise Abschnitte vor der Erkennung höchstens verstärkt werden.
#[derive(Clone, Copy)]
struct Sensitivity {
    silence_rms: f32,
    max_gain: f32,
    no_speech: f32,
}

fn sensitivity(name: &str) -> Sensitivity {
    match name {
        "low" => Sensitivity { silence_rms: 0.006, max_gain: 6.0, no_speech: 0.6 },
        "high" => Sensitivity { silence_rms: 0.0008, max_gain: 40.0, no_speech: 0.75 },
        _ => Sensitivity { silence_rms: 0.002, max_gain: 16.0, no_speech: 0.65 },
    }
}

/// Zielpegel für die Erkennung: Whisper erkennt deutlich besser, wenn leise Sprache angehoben ist.
const TARGET_RMS: f32 = 0.07;

/// Auf Apple Silicon das große, schnelle Modell (läuft über die GPU), sonst das kleinere.
#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
const MODEL: (&str, u64) = ("ggml-large-v3-turbo-q5_0.bin", 500_000_000);
#[cfg(not(all(target_os = "macos", target_arch = "aarch64")))]
const MODEL: (&str, u64) = ("ggml-small-q5_1.bin", 170_000_000);

/// Bekannte Fantasiesätze von Whisper bei Stille oder Musik (vor allem aus deutschen TV-Untertiteln).
const HALLUCINATIONS: &[&str] = &[
    "untertitel im auftrag",
    "untertitel der amara",
    "untertitelung des zdf",
    "untertitel von stephanie",
    "vielen dank fürs zuschauen",
    "vielen dank für's zuschauen",
    "danke fürs zuschauen",
    "copyright wdr",
    "swr 2021",
    "amara.org",
    "thank you for watching",
];

#[derive(Default)]
pub struct Lecture {
    session: Mutex<Option<Session>>,
    /// Laufendes Diktat (kurze Aufnahme, wird am Ende am Stück erkannt)
    dictation: Mutex<Option<Dictation>>,
    /// Geladenes Sprachmodell fürs Diktat und wann es zuletzt gebraucht wurde
    model: Mutex<Option<(Arc<WhisperContext>, Instant)>>,
    /// Pegel-Test im Startfenster (nur Mikrofon, keine Erkennung)
    monitor: Mutex<Option<(Arc<AtomicBool>, JoinHandle<()>)>>,
    downloading: AtomicBool,
}

impl Lecture {
    pub fn new() -> Self {
        Self::default()
    }
}

struct Dictation {
    stop: Arc<AtomicBool>,
    capture: Option<JoinHandle<()>>,
    buffer: Arc<Mutex<Buffer>>,
}

struct Session {
    stop: Arc<AtomicBool>,
    paused: Arc<AtomicBool>,
    capture: Option<JoinHandle<()>>,
    worker: Option<JoinHandle<()>>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
enum LectureEvent {
    /// Erkannter Text mit Zeit seit Beginn (ohne Pausen)
    Segment { text: String, start_ms: u64, end_ms: u64 },
    /// Pegel 0..1, etwa fünfmal pro Sekunde
    Level { level: f32 },
    /// Erkennung hinkt hinterher (Sekunden Ton in der Warteschlange)
    Backlog { seconds: u32 },
    Error { message: String },
    /// Aufnahme beendet, alles erkannt
    Finished,
}

fn emit(app: &AppHandle, event: LectureEvent) {
    let _ = app.emit("lecture", event);
}

fn models_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("models");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn model_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(models_dir(app)?.join(MODEL.0))
}

/// Ein Whisper-Modell beginnt mit der ggml-Kennung.
fn valid_model(path: &PathBuf) -> bool {
    use std::io::Read;
    let Ok(meta) = std::fs::metadata(path) else { return false };
    if meta.len() < MODEL.1 / 2 {
        return false;
    }
    let mut magic = [0u8; 4];
    std::fs::File::open(path).and_then(|mut f| f.read_exact(&mut magic)).is_ok() && &magic == b"lmgg"
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelStatus {
    ready: bool,
    name: String,
    size: u64,
    recording: bool,
}

#[tauri::command]
pub fn lecture_status(app: AppHandle, state: State<'_, Lecture>) -> Result<ModelStatus, String> {
    let path = model_path(&app)?;
    Ok(ModelStatus {
        ready: valid_model(&path),
        name: MODEL.0.to_string(),
        size: MODEL.1,
        recording: state.session.lock().unwrap().is_some(),
    })
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DownloadProgress {
    received: u64,
    total: u64,
}

/// Lädt das Sprachmodell (einmalig) von Hugging Face; Fortschritt als `lecture-download`.
#[tauri::command]
pub async fn lecture_download(app: AppHandle, state: State<'_, Lecture>) -> Result<(), String> {
    if state.downloading.swap(true, Ordering::SeqCst) {
        return Err("Das Modell wird bereits geladen.".into());
    }
    let result = download(&app).await;
    state.downloading.store(false, Ordering::SeqCst);
    result
}

async fn download(app: &AppHandle) -> Result<(), String> {
    let path = model_path(app)?;
    if valid_model(&path) {
        return Ok(());
    }
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
    let url = format!("https://huggingface.co/ggerganov/whisper.cpp/resolve/main/{}", MODEL.0);
    let client = reqwest::Client::builder()
        .user_agent(concat!("efeu/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(Duration::from_secs(20))
        .read_timeout(Duration::from_secs(120))
        .build()
        .map_err(|e| e.to_string())?;
    let response = client
        .get(url)
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .map_err(|e| format!("Download fehlgeschlagen: {e}"))?;
    let total = response.content_length().unwrap_or(MODEL.1);
    let partial = path.with_extension("part");
    let mut file = tokio::fs::File::create(&partial).await.map_err(|e| e.to_string())?;
    let mut received = 0u64;
    let mut last = Instant::now();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("Download abgebrochen: {e}"))?;
        file.write_all(&chunk).await.map_err(|e| e.to_string())?;
        received += chunk.len() as u64;
        if last.elapsed() > Duration::from_millis(250) {
            last = Instant::now();
            let _ = app.emit("lecture-download", DownloadProgress { received, total });
        }
    }
    file.flush().await.map_err(|e| e.to_string())?;
    drop(file);
    tokio::fs::rename(&partial, &path).await.map_err(|e| e.to_string())?;
    if !valid_model(&path) {
        let _ = std::fs::remove_file(&path);
        return Err("Das heruntergeladene Modell ist beschädigt. Bitte noch einmal versuchen.".into());
    }
    let _ = app.emit("lecture-download", DownloadProgress { received: total, total });
    Ok(())
}

/// Puffer zwischen Aufnahme (Audio-Thread) und Erkennung, Mono mit 16 kHz.
struct Buffer {
    samples: Vec<f32>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InputDevice {
    name: String,
    default: bool,
}

/// Verfügbare Mikrofone (das Systemmikrofon zuerst)
#[tauri::command]
pub fn lecture_devices() -> Vec<InputDevice> {
    let host = cpal::default_host();
    let default = host.default_input_device().and_then(|d| d.description().ok()).map(|d| d.name().to_string());
    let mut list: Vec<InputDevice> = host
        .input_devices()
        .map(|devices| {
            devices
                .filter_map(|d| d.description().ok().map(|desc| desc.name().to_string()))
                .map(|name| InputDevice { default: Some(&name) == default.as_ref(), name })
                .collect()
        })
        .unwrap_or_default();
    list.sort_by_key(|d| !d.default);
    list.dedup_by(|a, b| a.name == b.name);
    list
}

fn stop_monitor(state: &Lecture) {
    if let Some((stop, handle)) = state.monitor.lock().unwrap().take() {
        stop.store(true, Ordering::SeqCst);
        let _ = handle.join();
    }
}

/// Pegel-Test: Mikrofon öffnen und nur den Pegel melden (für das Startfenster).
#[tauri::command]
pub fn lecture_monitor(app: AppHandle, state: State<'_, Lecture>, device: Option<String>, on: bool) -> Result<(), String> {
    stop_monitor(&state);
    if !on || state.session.lock().unwrap().is_some() {
        return Ok(());
    }
    let stop = Arc::new(AtomicBool::new(false));
    let paused = Arc::new(AtomicBool::new(false));
    let thread_stop = stop.clone();
    let handle = std::thread::Builder::new()
        .name("efeu-pegel".into())
        .spawn(move || {
            if let Err(message) = capture_loop(&app, device.as_deref(), &thread_stop, &paused, None) {
                emit(&app, LectureEvent::Error { message });
            }
        })
        .map_err(|e| e.to_string())?;
    *state.monitor.lock().unwrap() = Some((stop, handle));
    Ok(())
}

#[tauri::command]
pub fn lecture_start(app: AppHandle, state: State<'_, Lecture>, language: String, device: Option<String>, sensitivity: String, topic: Option<String>) -> Result<(), String> {
    // Thema als Startkontext für Whisper (kurz halten: Whisper nutzt nur ~200 Tokens Vorlauf)
    let topic: String = topic.unwrap_or_default().trim().chars().take(300).collect();
    stop_monitor(&state);
    let sens = self::sensitivity(&sensitivity);
    let mut slot = state.session.lock().unwrap();
    if slot.is_some() {
        return Err("Es läuft bereits eine Mitschrift.".into());
    }
    let path = model_path(&app)?;
    if !valid_model(&path) {
        return Err("Das Sprachmodell fehlt noch.".into());
    }
    let language = match language.as_str() {
        "de" | "en" | "fr" | "es" | "it" | "tr" => Some(language),
        _ => None,
    };
    let stop = Arc::new(AtomicBool::new(false));
    let paused = Arc::new(AtomicBool::new(false));
    let buffer = Arc::new(Mutex::new(Buffer { samples: Vec::with_capacity(RATE * 40) }));

    // Aufnahme: der cpal-Stream gehört diesem Thread (er ist nicht Send).
    let capture = {
        let (app, stop, paused, buffer, device) = (app.clone(), stop.clone(), paused.clone(), buffer.clone(), device.clone());
        std::thread::Builder::new()
            .name("efeu-mikrofon".into())
            .spawn(move || {
                if let Err(message) = capture_loop(&app, device.as_deref(), &stop, &paused, Some(&buffer)) {
                    stop.store(true, Ordering::SeqCst);
                    emit(&app, LectureEvent::Error { message });
                }
            })
            .map_err(|e| e.to_string())?
    };

    // Erkennung: lädt das Modell einmal und arbeitet den Puffer abschnittsweise ab.
    let worker = {
        let (app, stop, buffer, topic) = (app.clone(), stop.clone(), buffer.clone(), topic.clone());
        std::thread::Builder::new()
            .name("efeu-whisper".into())
            .spawn(move || {
                if let Err(message) = worker_loop(&app, &path, language.as_deref(), &topic, sens, &stop, &buffer) {
                    stop.store(true, Ordering::SeqCst);
                    emit(&app, LectureEvent::Error { message });
                }
                emit(&app, LectureEvent::Finished);
            })
            .map_err(|e| e.to_string())?
    };
    *slot = Some(Session { stop, paused, capture: Some(capture), worker: Some(worker) });
    Ok(())
}

#[tauri::command]
pub fn lecture_pause(state: State<'_, Lecture>, paused: bool) {
    if let Some(s) = state.session.lock().unwrap().as_ref() {
        s.paused.store(paused, Ordering::SeqCst);
    }
}

/// Beendet die Aufnahme; der Rest im Puffer wird noch erkannt, danach kommt `Finished`.
#[tauri::command]
pub async fn lecture_stop(app: AppHandle) -> Result<(), String> {
    let session = app.state::<Lecture>().session.lock().unwrap().take();
    let Some(mut session) = session else { return Ok(()) };
    session.stop.store(true, Ordering::SeqCst);
    let capture = session.capture.take();
    let worker = session.worker.take();
    tauri::async_runtime::spawn_blocking(move || {
        if let Some(h) = capture {
            let _ = h.join();
        }
        if let Some(h) = worker {
            let _ = h.join();
        }
    })
    .await
    .map_err(|e| e.to_string())
}

/// Öffnet das gewählte Mikrofon (oder das Systemmikrofon); ohne `buffer` wird nur der Pegel gemeldet.
/// Wie lange das Modell nach einem Diktat im Speicher bleibt (das nächste Diktat startet dann sofort).
const MODEL_IDLE: Duration = Duration::from_secs(10 * 60);

/// Sprachmodell fürs Diktat: einmal laden, eine Weile behalten.
fn cached_context(app: &AppHandle) -> Result<Arc<WhisperContext>, String> {
    let state = app.state::<Lecture>();
    let mut slot = state.model.lock().unwrap();
    if let Some((context, used)) = slot.as_mut() {
        *used = Instant::now();
        return Ok(context.clone());
    }
    let path = model_path(app)?;
    whisper_rs::install_logging_hooks();
    let context = Arc::new(
        WhisperContext::new_with_params(&path, WhisperContextParameters::default()).map_err(|e| format!("Sprachmodell konnte nicht geladen werden: {e}"))?,
    );
    *slot = Some((context.clone(), Instant::now()));
    Ok(context)
}

/// Gibt das Modell frei, wenn es eine Weile nicht gebraucht wurde.
fn release_model_later(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(MODEL_IDLE + Duration::from_secs(1));
        let state = app.state::<Lecture>();
        let mut slot = state.model.lock().unwrap();
        if slot.as_ref().is_some_and(|(_, used)| used.elapsed() >= MODEL_IDLE) {
            *slot = None;
        }
    });
}

/// Diktat starten: Mikrofon an, Ton sammeln; das Modell lädt schon im Hintergrund.
#[tauri::command]
pub fn dictate_start(app: AppHandle, state: State<'_, Lecture>, device: Option<String>) -> Result<(), String> {
    if state.session.lock().unwrap().is_some() {
        return Err("Während einer Mitschrift geht kein Diktat.".into());
    }
    if !valid_model(&model_path(&app)?) {
        return Err("Das Sprachmodell fehlt noch.".into());
    }
    stop_monitor(&state);
    let mut slot = state.dictation.lock().unwrap();
    if slot.is_some() {
        return Ok(());
    }
    let stop = Arc::new(AtomicBool::new(false));
    let paused = Arc::new(AtomicBool::new(false));
    let buffer = Arc::new(Mutex::new(Buffer { samples: Vec::with_capacity(RATE * 30) }));
    let capture = {
        let (app, stop, buffer) = (app.clone(), stop.clone(), buffer.clone());
        std::thread::Builder::new()
            .name("efeu-diktat".into())
            .spawn(move || {
                if let Err(message) = capture_loop(&app, device.as_deref(), &stop, &paused, Some(&buffer)) {
                    stop.store(true, Ordering::SeqCst);
                    emit(&app, LectureEvent::Error { message });
                }
            })
            .map_err(|e| e.to_string())?
    };
    {
        let app = app.clone();
        std::thread::spawn(move || {
            let _ = cached_context(&app);
        });
    }
    *slot = Some(Dictation { stop, capture: Some(capture), buffer });
    Ok(())
}

/// Diktat beenden und den gesprochenen Text liefern (leer bei Stille).
#[tauri::command]
pub async fn dictate_stop(app: AppHandle, language: String) -> Result<String, String> {
    let dictation = app.state::<Lecture>().dictation.lock().unwrap().take();
    let Some(mut dictation) = dictation else { return Ok(String::new()) };
    dictation.stop.store(true, Ordering::SeqCst);
    let capture = dictation.capture.take();
    let buffer = dictation.buffer.clone();
    let app_worker = app.clone();
    let text = tauri::async_runtime::spawn_blocking(move || {
        if let Some(handle) = capture {
            let _ = handle.join();
        }
        let mut samples = std::mem::take(&mut buffer.lock().unwrap().samples);
        transcribe_dictation(&app_worker, &mut samples, &language)
    })
    .await
    .map_err(|e| e.to_string())??;
    release_model_later(&app);
    Ok(text)
}

/// Diktat abbrechen, ohne zu erkennen.
#[tauri::command]
pub fn dictate_cancel(state: State<'_, Lecture>) {
    if let Some(mut dictation) = state.dictation.lock().unwrap().take() {
        dictation.stop.store(true, Ordering::SeqCst);
        if let Some(handle) = dictation.capture.take() {
            let _ = handle.join();
        }
    }
}

fn transcribe_dictation(app: &AppHandle, samples: &mut Vec<f32>, language: &str) -> Result<String, String> {
    let sens = sensitivity("normal");
    if samples.len() < RATE / 3 || rms(samples) < sens.silence_rms {
        return Ok(String::new());
    }
    let context = cached_context(app)?;
    recognize(&context, samples, language)
}

/// Erkennt eine kurze Aufnahme am Stück (Diktat).
fn recognize(context: &WhisperContext, samples: &mut Vec<f32>, language: &str) -> Result<String, String> {
    let sens = sensitivity("normal");
    // Whisper braucht gut eine Sekunde Ton: kurze Aufnahmen mit Stille auffüllen.
    if samples.len() < RATE + RATE / 5 {
        samples.resize(RATE + RATE / 5, 0.0);
    }
    enhance(samples, sens.max_gain);
    let mut state = context.create_state().map_err(|e| e.to_string())?;
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    let strategy = SamplingStrategy::BeamSearch { beam_size: 5, patience: -1.0 };
    #[cfg(not(all(target_os = "macos", target_arch = "aarch64")))]
    let strategy = SamplingStrategy::Greedy { best_of: 1 };
    let mut params = FullParams::new(strategy);
    let language = match language {
        "de" | "en" | "fr" | "es" | "it" | "tr" => Some(language),
        _ => None,
    };
    params.set_language(language);
    // Diktat ist kurz und man wartet darauf: alle Kerne nutzen.
    params.set_n_threads(std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4).clamp(1, 8) as i32);
    params.set_print_progress(false);
    params.set_print_realtime(false);
    params.set_print_special(false);
    params.set_print_timestamps(false);
    params.set_suppress_blank(true);
    params.set_no_speech_thold(sens.no_speech);
    state.full(params, samples).map_err(|e| format!("Spracherkennung: {e}"))?;
    let mut text = String::new();
    for segment in state.as_iter() {
        let part = segment.to_str_lossy().map(|t| t.trim().to_string()).unwrap_or_default();
        if part.is_empty() || is_hallucination(&part) {
            continue;
        }
        if !text.is_empty() {
            text.push(' ');
        }
        text.push_str(&part);
    }
    Ok(text)
}

fn capture_loop(app: &AppHandle, device_name: Option<&str>, stop: &AtomicBool, paused: &Arc<AtomicBool>, buffer: Option<&Arc<Mutex<Buffer>>>) -> Result<(), String> {
    let host = cpal::default_host();
    let chosen = device_name.and_then(|wanted| {
        host.input_devices()
            .ok()?
            .find(|d| d.description().map(|desc| desc.name() == wanted).unwrap_or(false))
    });
    let device = chosen
        .or_else(|| host.default_input_device())
        .ok_or("Kein Mikrofon gefunden. Ist eins angeschlossen und in den Systemeinstellungen erlaubt?")?;
    let supported = device.default_input_config().map_err(|e| mic_error(&e.to_string()))?;
    let channels = supported.channels() as usize;
    let rate = supported.sample_rate() as usize;
    let format = supported.sample_format();
    let config = supported.config();

    let mut resampler = Resampler::new(rate, RATE);
    let mut level_sum = 0f32;
    let mut level_count = 0usize;
    let mut last_level = Instant::now();
    let app_level = app.clone();
    let paused_cb = paused.clone();
    let buffer_cb = buffer.cloned();
    let mut process = move |mono: &mut dyn Iterator<Item = f32>| {
        if paused_cb.load(Ordering::Relaxed) {
            return;
        }
        let mut out = Vec::new();
        for s in mono {
            level_sum += s * s;
            level_count += 1;
            resampler.push(s, &mut out);
        }
        if let Some(buffer) = &buffer_cb {
            buffer.lock().unwrap().samples.extend_from_slice(&out);
        }
        if last_level.elapsed() > Duration::from_millis(200) && level_count > 0 {
            let rms = (level_sum / level_count as f32).sqrt();
            // Wahrnehmungsnah (logarithmisch): leise Sprache soll sichtbar ausschlagen.
            let db = 20.0 * rms.max(1e-6).log10();
            emit(&app_level, LectureEvent::Level { level: ((db + 60.0) / 50.0).clamp(0.0, 1.0) });
            level_sum = 0.0;
            level_count = 0;
            last_level = Instant::now();
        }
    };
    let err_app = app.clone();
    let on_error = move |e: cpal::Error| emit(&err_app, LectureEvent::Error { message: format!("Mikrofon: {e}") });

    let stream = match format {
        cpal::SampleFormat::F32 => device.build_input_stream::<f32, _, _>(
            config,
            move |data: &[f32], _: &_| process(&mut data.chunks(channels).map(|f| f.iter().sum::<f32>() / channels as f32)),
            on_error,
            None,
        ),
        cpal::SampleFormat::I16 => device.build_input_stream::<i16, _, _>(
            config,
            move |data: &[i16], _: &_| {
                process(&mut data.chunks(channels).map(|f| f.iter().map(|&s| s as f32 / 32768.0).sum::<f32>() / channels as f32))
            },
            on_error,
            None,
        ),
        cpal::SampleFormat::I32 => device.build_input_stream::<i32, _, _>(
            config,
            move |data: &[i32], _: &_| {
                process(&mut data.chunks(channels).map(|f| f.iter().map(|&s| s as f32 / 2_147_483_648.0).sum::<f32>() / channels as f32))
            },
            on_error,
            None,
        ),
        cpal::SampleFormat::U16 => device.build_input_stream::<u16, _, _>(
            config,
            move |data: &[u16], _: &_| {
                process(&mut data.chunks(channels).map(|f| f.iter().map(|&s| (s as f32 - 32768.0) / 32768.0).sum::<f32>() / channels as f32))
            },
            on_error,
            None,
        ),
        other => return Err(format!("Mikrofon-Format {other:?} wird nicht unterstützt.")),
    }
    .map_err(|e| mic_error(&e.to_string()))?;
    stream.play().map_err(|e| mic_error(&e.to_string()))?;
    while !stop.load(Ordering::Relaxed) {
        std::thread::sleep(Duration::from_millis(100));
    }
    drop(stream);
    Ok(())
}

fn mic_error(raw: &str) -> String {
    if raw.to_lowercase().contains("permission") {
        "Kein Zugriff aufs Mikrofon. Erlaube es unter Systemeinstellungen → Datenschutz & Sicherheit → Mikrofon → efeu.".into()
    } else {
        format!("Mikrofon: {raw}")
    }
}

/// Einfacher linearer Resampler (für Sprache völlig ausreichend).
struct Resampler {
    step: f64,
    pos: f64,
    prev: f32,
}

impl Resampler {
    fn new(from: usize, to: usize) -> Self {
        Self { step: from as f64 / to as f64, pos: 0.0, prev: 0.0 }
    }

    fn push(&mut self, sample: f32, out: &mut Vec<f32>) {
        // pos läuft über die Eingangssamples; zwischen prev und sample wird interpoliert.
        while self.pos < 1.0 {
            out.push(self.prev + (sample - self.prev) * self.pos as f32);
            self.pos += self.step;
        }
        self.pos -= 1.0;
        self.prev = sample;
    }
}

fn rms(samples: &[f32]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    (samples.iter().map(|s| s * s).sum::<f32>() / samples.len() as f32).sqrt()
}

/// Leiseste Stelle (Fenster von 0,3 s) in den letzten Sekunden: dort schneiden, damit kein Wort zerteilt wird.
fn cut_point(samples: &[f32]) -> usize {
    let window = RATE * 3 / 10;
    let start = samples.len().saturating_sub(RATE * SEARCH_SECS);
    let mut best = samples.len();
    let mut quietest = f32::MAX;
    let mut i = start;
    while i + window <= samples.len() {
        let level = rms(&samples[i..i + window]);
        if level < quietest {
            quietest = level;
            best = i + window / 2;
        }
        i += window / 3;
    }
    best
}

fn is_hallucination(text: &str) -> bool {
    let lower = text.to_lowercase();
    let trimmed = lower.trim_matches(|c: char| !c.is_alphanumeric());
    let bare = lower.trim();
    trimmed.is_empty() || HALLUCINATIONS.iter().any(|h| lower.contains(h)) || (bare.starts_with('[') && bare.ends_with(']')) || (bare.starts_with('(') && bare.ends_with(')'))
}

/// Bereitet einen Abschnitt für die Erkennung auf:
/// 1. Hochpass (~100 Hz) gegen Brummen, Trittschall und Lüftung.
/// 2. Laufende Lautstärkeregelung in 20-ms-Schritten (wie ein Kompressor): leise Sprache wird bis zu
///    `max_gain` angehoben, laute Stellen (Husten, Stühle) nicht; Rauschen in Sprechpausen nur wenig.
/// 3. Weicher Begrenzer gegen Übersteuern.
fn enhance(chunk: &mut [f32], max_gain: f32) {
    if chunk.is_empty() {
        return;
    }
    // 1. Hochpass erster Ordnung
    let alpha = {
        let rc = 1.0 / (2.0 * std::f32::consts::PI * 100.0);
        let dt = 1.0 / RATE as f32;
        rc / (rc + dt)
    };
    let (mut prev_in, mut prev_out) = (chunk[0], 0.0f32);
    for s in chunk.iter_mut() {
        let out = alpha * (prev_out + *s - prev_in);
        prev_in = *s;
        prev_out = out;
        *s = out;
    }
    // 2. Pegel je Fenster, Rauschboden aus den leisesten 15 %
    let frame = RATE / 50;
    let levels: Vec<f32> = chunk.chunks(frame).map(rms).collect();
    let mut sorted = levels.clone();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let noise = sorted[sorted.len() * 15 / 100].max(1e-5);
    let mut gain = 1.0f32;
    for (i, block) in chunk.chunks_mut(frame).enumerate() {
        let level = levels[i].max(1e-6);
        // Nur deutlich über dem Rauschboden voll verstärken, sonst Rauschen höchstens leicht anheben.
        let limit = if level > noise * 2.5 { max_gain } else { max_gain.min(2.0) };
        let wanted = (TARGET_RMS / level).clamp(1.0, limit);
        // schnell leiser (Attack), langsam lauter (Release): kein Pumpen
        gain = if wanted < gain { wanted } else { gain + (wanted - gain) * 0.08 };
        for s in block.iter_mut() {
            *s *= gain;
        }
    }
    // 3. Weicher Begrenzer
    for s in chunk.iter_mut() {
        if s.abs() > 0.7 {
            *s = s.signum() * (0.7 + 0.3 * ((s.abs() - 0.7) / 0.3).tanh());
        }
    }
}

fn worker_loop(app: &AppHandle, model: &PathBuf, language: Option<&str>, topic: &str, sens: Sensitivity, stop: &AtomicBool, buffer: &Arc<Mutex<Buffer>>) -> Result<(), String> {
    whisper_rs::install_logging_hooks();
    let context = WhisperContext::new_with_params(model, WhisperContextParameters::default())
        .map_err(|e| format!("Sprachmodell konnte nicht geladen werden: {e}"))?;
    let mut state = context.create_state().map_err(|e| e.to_string())?;
    // Etwa die Hälfte der Kerne, damit der Rechner nebenbei flüssig bleibt.
    let threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4).div_ceil(2).clamp(1, 4) as i32;
    let mut offset_ms: u64 = 0;
    let mut context_text = String::new();

    loop {
        let stopping = stop.load(Ordering::Relaxed);
        let chunk: Option<Vec<f32>> = {
            let mut buf = buffer.lock().unwrap();
            let len = buf.samples.len();
            if len >= RATE * CHUNK_SECS {
                let cut = cut_point(&buf.samples[..RATE * CHUNK_SECS]);
                Some(buf.samples.drain(..cut).collect())
            } else if stopping && len >= RATE / 2 {
                Some(buf.samples.drain(..).collect())
            } else {
                None
            }
        };
        let Some(mut chunk) = chunk else {
            if stopping {
                return Ok(());
            }
            std::thread::sleep(Duration::from_millis(500));
            continue;
        };
        let duration_ms = (chunk.len() * 1000 / RATE) as u64;
        let backlog = buffer.lock().unwrap().samples.len() / RATE;
        if backlog > CHUNK_SECS * 2 {
            emit(app, LectureEvent::Backlog { seconds: backlog as u32 });
        }
        if rms(&chunk) >= sens.silence_rms {
            enhance(&mut chunk, sens.max_gain);
            // Auf Apple Silicon (GPU) gründlicher suchen, auf der CPU schnell bleiben.
            #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
            let strategy = SamplingStrategy::BeamSearch { beam_size: 5, patience: -1.0 };
            #[cfg(not(all(target_os = "macos", target_arch = "aarch64")))]
            let strategy = SamplingStrategy::Greedy { best_of: 1 };
            let mut params = FullParams::new(strategy);
            params.set_language(language);
            params.set_n_threads(threads);
            params.set_print_progress(false);
            params.set_print_realtime(false);
            params.set_print_special(false);
            params.set_print_timestamps(false);
            params.set_suppress_blank(true);
            params.set_no_speech_thold(sens.no_speech);
            // Thema/Fachbegriffe und die letzten Sätze als Kontext: bessere Rechtschreibung von Fachwörtern und Namen.
            let prompt = format!("{topic} {context_text}");
            if !prompt.trim().is_empty() {
                params.set_initial_prompt(prompt.trim());
            }
            state.full(params, &chunk).map_err(|e| format!("Spracherkennung: {e}"))?;
            for segment in state.as_iter() {
                let text = segment.to_str_lossy().map(|t| t.trim().to_string()).unwrap_or_default();
                if text.is_empty() || is_hallucination(&text) || segment.no_speech_probability() > sens.no_speech + 0.15 {
                    continue;
                }
                let start_ms = offset_ms + (segment.start_timestamp().max(0) as u64) * 10;
                let end_ms = offset_ms + (segment.end_timestamp().max(0) as u64) * 10;
                context_text.push(' ');
                context_text.push_str(&text);
                emit(app, LectureEvent::Segment { text, start_ms, end_ms: end_ms.min(offset_ms + duration_ms) });
            }
            // Kontext kurz halten (Whisper nutzt ohnehin nur die letzten ~200 Tokens).
            if context_text.len() > 400 {
                let cut = context_text.len() - 400;
                let boundary = (cut..context_text.len()).find(|&i| context_text.is_char_boundary(i)).unwrap_or(cut);
                context_text = context_text[boundary..].to_string();
            }
        }
        offset_ms += duration_ms;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resamples_to_16khz() {
        let mut r = Resampler::new(48_000, 16_000);
        let mut out = Vec::new();
        for i in 0..48_000 {
            r.push((i as f32 / 100.0).sin(), &mut out);
        }
        assert!((out.len() as i64 - 16_000).abs() <= 2, "{}", out.len());
    }

    #[test]
    fn cuts_at_the_quietest_moment() {
        let mut samples = vec![0.5f32; RATE * CHUNK_SECS];
        let quiet = RATE * (CHUNK_SECS - 3);
        for s in &mut samples[quiet..quiet + RATE / 2] {
            *s = 0.0;
        }
        let cut = cut_point(&samples);
        assert!(cut >= quiet && cut <= quiet + RATE / 2, "{cut}");
    }

    /// Sprache um 300 Hz, leise, mit Pausen voller Rauschen
    fn quiet_speech() -> Vec<f32> {
        (0..RATE * 4)
            .map(|i| {
                let t = i as f32 / RATE as f32;
                let speaking = (t as usize) % 2 == 0;
                let noise = ((i * 7919) % 101) as f32 / 101.0 - 0.5;
                (if speaking { (t * 300.0 * std::f32::consts::TAU).sin() * 0.006 } else { 0.0 }) + noise * 0.0004
            })
            .collect()
    }

    #[test]
    fn lifts_quiet_speech_but_not_the_noise() {
        let mut audio = quiet_speech();
        enhance(&mut audio, 40.0);
        let speech = rms(&audio[RATE / 4..RATE * 3 / 4]);
        let pause = rms(&audio[RATE + RATE / 4..RATE + RATE * 3 / 4]);
        assert!(speech > 0.04, "Sprache zu leise: {speech}");
        assert!(speech / pause > 20.0, "Rauschen zu stark angehoben: {speech} / {pause}");
    }

    #[test]
    fn never_clips() {
        let mut loud: Vec<f32> = (0..RATE).map(|i| (i as f32 / 20.0).sin() * 1.5).collect();
        enhance(&mut loud, 40.0);
        assert!(loud.iter().all(|s| s.abs() <= 1.0));
    }

    /// Echte Erkennung mit Modell: EFEU_WHISPER_MODEL=<ggml-Datei> EFEU_TEST_WAV=<16 kHz Mono, 16 Bit> cargo test -- --ignored
    #[test]
    #[ignore]
    fn dictation_recognizes_speech() {
        let model = std::env::var("EFEU_WHISPER_MODEL").expect("EFEU_WHISPER_MODEL");
        let wav = std::fs::read(std::env::var("EFEU_TEST_WAV").expect("EFEU_TEST_WAV")).unwrap();
        // Daten-Chunk suchen und 16-Bit-Samples lesen
        let data = wav.windows(4).position(|w| w == b"data").expect("data-Chunk") + 8;
        let mut samples: Vec<f32> = wav[data..].chunks_exact(2).map(|b| i16::from_le_bytes([b[0], b[1]]) as f32 / 32768.0).collect();
        let context = WhisperContext::new_with_params(&model, WhisperContextParameters::default()).unwrap();
        let text = recognize(&context, &mut samples, "de").unwrap();
        println!("Erkannt: {text}");
        let lower = text.to_lowercase();
        assert!(lower.contains("mitochondrien") && lower.contains("kraftwerk"), "{text}");
    }

    #[test]
    fn filters_known_hallucinations() {
        assert!(is_hallucination("Untertitel im Auftrag des ZDF, 2021"));
        assert!(is_hallucination("[Musik]"));
        assert!(is_hallucination(" ... "));
        assert!(!is_hallucination("Heute geht es um Entropie."));
    }
}
