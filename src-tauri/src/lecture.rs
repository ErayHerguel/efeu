//! Vorlesungen mitschreiben: Mikrofon → lokale Spracherkennung (Whisper) → Text.
//!
//! Alles läuft in eigenen Threads, unabhängig vom Fenster: Aufnahme und Erkennung gehen weiter,
//! während man andere Programme nutzt oder das flou-Fenster geschlossen ist. Der Ton wird nur im
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
const CHUNK_SECS: usize = 24;
const SEARCH_SECS: usize = 6;
/// Unterhalb dieser Lautstärke gilt ein Abschnitt als Stille (spart Rechenzeit, verhindert Fantasietexte).
const SILENCE_RMS: f32 = 0.004;

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
    downloading: AtomicBool,
}

impl Lecture {
    pub fn new() -> Self {
        Self::default()
    }
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
        .user_agent(concat!("flou/", env!("CARGO_PKG_VERSION")))
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

#[tauri::command]
pub fn lecture_start(app: AppHandle, state: State<'_, Lecture>, language: String) -> Result<(), String> {
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
        let (app, stop, paused, buffer) = (app.clone(), stop.clone(), paused.clone(), buffer.clone());
        std::thread::Builder::new()
            .name("flou-mikrofon".into())
            .spawn(move || {
                if let Err(message) = capture_loop(&app, &stop, &paused, &buffer) {
                    stop.store(true, Ordering::SeqCst);
                    emit(&app, LectureEvent::Error { message });
                }
            })
            .map_err(|e| e.to_string())?
    };

    // Erkennung: lädt das Modell einmal und arbeitet den Puffer abschnittsweise ab.
    let worker = {
        let (app, stop, buffer) = (app.clone(), stop.clone(), buffer.clone());
        std::thread::Builder::new()
            .name("flou-whisper".into())
            .spawn(move || {
                if let Err(message) = worker_loop(&app, &path, language.as_deref(), &stop, &buffer) {
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

fn capture_loop(app: &AppHandle, stop: &AtomicBool, paused: &Arc<AtomicBool>, buffer: &Arc<Mutex<Buffer>>) -> Result<(), String> {
    let host = cpal::default_host();
    let device = host
        .default_input_device()
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
    let buffer_cb = buffer.clone();
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
        buffer_cb.lock().unwrap().samples.extend_from_slice(&out);
        if last_level.elapsed() > Duration::from_millis(200) && level_count > 0 {
            let rms = (level_sum / level_count as f32).sqrt();
            emit(&app_level, LectureEvent::Level { level: (rms * 8.0).min(1.0) });
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
        "Kein Zugriff aufs Mikrofon. Erlaube es unter Systemeinstellungen → Datenschutz & Sicherheit → Mikrofon → flou.".into()
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

fn worker_loop(app: &AppHandle, model: &PathBuf, language: Option<&str>, stop: &AtomicBool, buffer: &Arc<Mutex<Buffer>>) -> Result<(), String> {
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
        let Some(chunk) = chunk else {
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
        if rms(&chunk) >= SILENCE_RMS {
            let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
            params.set_language(language);
            params.set_n_threads(threads);
            params.set_print_progress(false);
            params.set_print_realtime(false);
            params.set_print_special(false);
            params.set_print_timestamps(false);
            params.set_suppress_blank(true);
            params.set_no_speech_thold(0.6);
            // Die letzten Sätze als Kontext: bessere Rechtschreibung von Fachbegriffen und Namen.
            if !context_text.is_empty() {
                params.set_initial_prompt(&context_text);
            }
            state.full(params, &chunk).map_err(|e| format!("Spracherkennung: {e}"))?;
            for segment in state.as_iter() {
                let text = segment.to_str_lossy().map(|t| t.trim().to_string()).unwrap_or_default();
                if text.is_empty() || is_hallucination(&text) || segment.no_speech_probability() > 0.8 {
                    continue;
                }
                let start_ms = offset_ms + (segment.start_timestamp().max(0) as u64) * 10;
                let end_ms = offset_ms + (segment.end_timestamp().max(0) as u64) * 10;
                context_text.push(' ');
                context_text.push_str(&text);
                emit(app, LectureEvent::Segment { text, start_ms, end_ms: end_ms.min(offset_ms + duration_ms) });
            }
            // Kontext kurz halten (Whisper nutzt ohnehin nur die letzten ~200 Tokens).
            if context_text.len() > 600 {
                let cut = context_text.len() - 600;
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

    #[test]
    fn filters_known_hallucinations() {
        assert!(is_hallucination("Untertitel im Auftrag des ZDF, 2021"));
        assert!(is_hallucination("[Musik]"));
        assert!(is_hallucination(" ... "));
        assert!(!is_hallucination("Heute geht es um Entropie."));
    }
}
