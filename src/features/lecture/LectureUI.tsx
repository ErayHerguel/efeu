import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { open } from '@tauri-apps/plugin-dialog';
import { FileText, Loader2, Mic, Pause, Play, Square, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { create } from 'zustand';
import { Modal } from '../../components/Modal';
import { cx } from '../../lib/cx';
import { usePages } from '../../store/pages';
import { reportError } from '../../store/toast';
import { useUI } from '../../store/ui';
import { formatUsd } from '../ai/cost';
import { useAiReady } from '../ai/store';
import { clock } from './notes';
import { downloadModel, liveCostPerHour, modelStatus, pauseLecture, startLecture, stopLecture, useLecture, type Language, type LectureOptions, type Sensitivity } from './lecture';

const useStartDialog = create<{ pageId: string | null }>(() => ({ pageId: null }));

export function openLectureStart(pageId: string): void {
  if (useLecture.getState().status !== 'idle') {
    useUI.getState().open(useLecture.getState().pageId ?? pageId);
    return;
  }
  useStartDialog.setState({ pageId });
}

const PREFS_KEY = 'flou.lecture.prefs';
const HINT_KEY = 'flou.lecture.hintSeen';

function loadPrefs(): Omit<LectureOptions, 'slides'> {
  const fallback: Omit<LectureOptions, 'slides'> = { language: 'de', keepTranscript: true, liveNotes: true, device: null, sensitivity: 'normal' };
  try {
    return { ...fallback, ...JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') };
  } catch {
    return fallback;
  }
}

/** Pegel-Test: Mikrofon live anzeigen, mit Hinweis, wenn es den Raum kaum hört. */
function LevelTest({ device, sensitivity }: { device: string | null; sensitivity: Sensitivity }) {
  const [level, setLevel] = useState(0);
  const [peak, setPeak] = useState(0);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setPeak(0);
    setError(null);
    let off: (() => void) | null = null;
    let alive = true;
    void listen<{ kind: string; level?: number; message?: string }>('lecture', ({ payload }) => {
      if (payload.kind === 'level') {
        const l = payload.level ?? 0;
        setLevel(l);
        setPeak((p) => Math.max(p * 0.995, l));
      } else if (payload.kind === 'error') setError(payload.message ?? 'Mikrofon-Fehler');
    }).then((u) => {
      if (alive) off = u;
      else u();
    });
    invoke('lecture_monitor', { device, on: true }).catch((err) => setError(String(err)));
    return () => {
      alive = false;
      off?.();
      void invoke('lecture_monitor', { device: null, on: false });
    };
  }, [device]);
  const threshold = sensitivity === 'high' ? 0.15 : sensitivity === 'low' ? 0.35 : 0.25;
  const verdict =
    error ??
    (peak < 0.05
      ? 'Sag etwas oder warte, bis jemand spricht …'
      : peak < threshold
        ? 'Eher leise: setz dich näher ran, nimm ein anderes Mikrofon oder stell die Empfindlichkeit auf „Hoch“.'
        : 'Pegel gut.');
  return (
    <div>
      <div className="relative h-2 overflow-hidden rounded-full bg-hover">
        <div className="absolute inset-y-0 left-0 rounded-full bg-accent transition-[width] duration-100" style={{ width: `${Math.round(level * 100)}%` }} />
        <div className="absolute inset-y-0 w-px bg-text/40" style={{ left: `${Math.round(threshold * 100)}%` }} title="Ab hier sicher erkannt" />
      </div>
      <p className={cx('mt-1 text-xs', error ? 'text-danger' : 'text-faint')}>{verdict}</p>
    </div>
  );
}

function Choice<T extends string>({ value, options, onChange }: { value: T; options: { id: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="flex gap-1.5">
      {options.map((o) => (
        <button
          key={o.id}
          onClick={() => onChange(o.id)}
          className={cx('h-8 flex-1 rounded-md border text-sm', value === o.id ? 'border-accent bg-accent-soft' : 'border-border text-muted hover:bg-hover')}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Check({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string }) {
  return (
    <label className="flex cursor-pointer items-start gap-2.5 py-1">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="mt-0.5 accent-[var(--c-accent)]" />
      <span>
        <span className="block text-sm">{label}</span>
        {hint && <span className="block text-xs text-faint">{hint}</span>}
      </span>
    </label>
  );
}

function StartDialog({ pageId }: { pageId: string }) {
  const aiReady = useAiReady();
  const [prefs, setPrefs] = useState(loadPrefs);
  const [slides, setSlides] = useState<LectureOptions['slides']>(null);
  const [model, setModel] = useState<{ ready: boolean; size: number } | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [starting, setStarting] = useState(false);
  const [hintSeen] = useState(() => {
    try {
      return localStorage.getItem(HINT_KEY) === '1';
    } catch {
      return false;
    }
  });
  const close = () => useStartDialog.setState({ pageId: null });

  const [devices, setDevices] = useState<{ name: string; default: boolean }[]>([]);
  useEffect(() => {
    modelStatus()
      .then(setModel)
      .catch((err) => reportError('Spracherkennung', err));
    invoke<{ name: string; default: boolean }[]>('lecture_devices')
      .then(setDevices)
      .catch(() => setDevices([]));
  }, []);
  // Gespeichertes Mikrofon gibt es nicht mehr (z. B. Headset abgesteckt): Systemmikrofon nehmen.
  const device = prefs.device && devices.some((d) => d.name === prefs.device) ? prefs.device : null;

  const update = (patch: Partial<typeof prefs>) => {
    const next = { ...prefs, ...patch };
    setPrefs(next);
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(next));
    } catch {
      // egal
    }
  };

  const download = async () => {
    setProgress(0);
    try {
      await downloadModel((r, t) => setProgress(t ? r / t : 0));
      setModel((m) => (m ? { ...m, ready: true } : m));
    } catch (err) {
      reportError('Download', err);
    } finally {
      setProgress(null);
    }
  };

  const pickSlides = async () => {
    try {
      const path = await open({ multiple: false, filters: [{ name: 'PDF', extensions: ['pdf'] }] });
      if (typeof path !== 'string') return;
      const file = await invoke<{ name: string; data: string }>('ai_read_pdf', { path });
      setSlides({ name: file.name, data: file.data });
    } catch (err) {
      reportError('Folien', err);
    }
  };

  const start = async () => {
    setStarting(true);
    try {
      localStorage.setItem(HINT_KEY, '1');
    } catch {
      // egal
    }
    try {
      await startLecture(pageId, { ...prefs, device, liveNotes: prefs.liveNotes && aiReady, slides });
      close();
    } catch (err) {
      reportError('Mitschrift', err);
    } finally {
      setStarting(false);
    }
  };

  const page = usePages((s) => s.pages[pageId]);
  const mb = model ? Math.round(model.size / 1_000_000) : 0;

  return (
    <Modal onClose={close} position="center" className="w-[460px] p-5">
      <div className="flex items-center gap-2">
        <Mic size={16} className="text-accent" />
        <h2 className="text-base font-semibold">Vorlesung mitschreiben</h2>
      </div>
      <p className="mt-1 text-sm text-muted">
        flou hört über das Mikrofon mit, erkennt die Sprache direkt auf diesem Computer und schreibt Notizen in „{page?.title || 'diese Seite'}“. Der
        Ton wird nicht gespeichert. Du kannst den Computer währenddessen ganz normal weiter benutzen.
      </p>

      {model && !model.ready && (
        <div className="mt-4 rounded-md border border-border p-3 text-sm">
          <p className="font-medium">Einmalig: Spracherkennung laden</p>
          <p className="mt-0.5 text-xs text-muted">Whisper (Open Source), etwa {mb} MB. Danach funktioniert die Erkennung offline.</p>
          {progress === null ? (
            <button onClick={() => void download()} className="mt-2 h-8 rounded-md bg-accent px-3 text-sm font-medium text-accent-fg">
              Jetzt laden
            </button>
          ) : (
            <div className="mt-2">
              <div className="h-1.5 rounded-full bg-hover">
                <div className="h-1.5 rounded-full bg-accent transition-[width]" style={{ width: `${Math.round(progress * 100)}%` }} />
              </div>
              <p className="mt-1 text-xs text-faint tabular-nums">{Math.round(progress * 100)} %</p>
            </div>
          )}
        </div>
      )}

      <div className="mt-4 space-y-3">
        <div>
          <div className="mb-1.5 text-xs font-medium text-faint">Mikrofon</div>
          <select
            value={device ?? ''}
            onChange={(e) => update({ device: e.target.value || null })}
            className="h-8 w-full rounded-md border border-border bg-bg px-2 text-sm outline-none focus:border-border-strong"
          >
            <option value="">Systemmikrofon{devices.find((d) => d.default) ? ` (${devices.find((d) => d.default)!.name})` : ''}</option>
            {devices
              .filter((d) => !d.default)
              .map((d) => (
                <option key={d.name} value={d.name}>
                  {d.name}
                </option>
              ))}
          </select>
          <div className="mt-2">{model?.ready && <LevelTest device={device} sensitivity={prefs.sensitivity} />}</div>
        </div>
        <div>
          <div className="mb-1.5 text-xs font-medium text-faint">Empfindlichkeit</div>
          <Choice<Sensitivity>
            value={prefs.sensitivity}
            onChange={(sensitivity) => update({ sensitivity })}
            options={[
              { id: 'low', label: 'Niedrig' },
              { id: 'normal', label: 'Normal' },
              { id: 'high', label: 'Hoch' },
            ]}
          />
          <p className="mt-1 text-xs text-faint">
            {prefs.sensitivity === 'high'
              ? 'Für leise Sprecher und hintere Reihen: hebt auch sehr leise Sprache an, nimmt etwas mehr Nebengeräusche mit.'
              : prefs.sensitivity === 'low'
                ? 'Für laute Räume: nur deutliche Sprache, Nebengespräche werden eher ignoriert.'
                : 'Leise Passagen werden automatisch angehoben.'}
          </p>
        </div>
        <div>
          <div className="mb-1.5 text-xs font-medium text-faint">Sprache der Vorlesung</div>
          <Choice<Language>
            value={prefs.language}
            onChange={(language) => update({ language })}
            options={[
              { id: 'de', label: 'Deutsch' },
              { id: 'en', label: 'Englisch' },
              { id: 'auto', label: 'Automatisch' },
            ]}
          />
        </div>
        <div>
          <Check
            checked={prefs.liveNotes && aiReady}
            onChange={(liveNotes) => update({ liveNotes })}
            label="Live-Stichpunkte alle paar Minuten"
            hint={aiReady ? `Mit Claude Haiku, etwa ${formatUsd(liveCostPerHour())} pro Stunde. Ohne: die Mitschrift selbst wächst in der Seite.` : 'Braucht die KI (Einstellungen → KI). Ohne erscheint die Mitschrift selbst.'}
          />
          <Check checked={prefs.keepTranscript} onChange={(keepTranscript) => update({ keepTranscript })} label="Mitschrift am Ende einklappbar anhängen" hint="Nur Text, wenige Kilobyte." />
        </div>
        <div className="flex items-center gap-2 text-sm">
          <button onClick={() => void pickSlides()} className="flex h-8 items-center gap-1.5 rounded-md border border-border px-3 hover:bg-hover">
            <FileText size={14} /> Folien anhängen (PDF)
          </button>
          {slides ? (
            <span className="flex min-w-0 items-center gap-1 text-xs text-muted">
              <span className="truncate">{slides.name}.pdf</span>
              <button onClick={() => setSlides(null)} aria-label="Folien entfernen" className="text-faint hover:text-text">
                <X size={12} />
              </button>
            </span>
          ) : (
            <span className="text-xs text-faint">optional, für die Zusammenfassung</span>
          )}
        </div>
      </div>

      {!hintSeen && (
        <p className="mt-4 rounded-md bg-hover px-3 py-2 text-xs text-muted">
          Hinweis: Vorlesungen darf man in Deutschland nicht ohne Weiteres mitschneiden. Frag am besten vorher die Lehrperson. flou speichert
          keinen Ton, nur den erkannten Text.
        </p>
      )}

      <div className="mt-5 flex justify-end gap-2">
        <button onClick={close} className="h-8 rounded-md border border-border px-3 text-sm hover:bg-hover">
          Abbrechen
        </button>
        <button
          onClick={() => void start()}
          disabled={!model?.ready || starting}
          className="flex h-8 items-center gap-1.5 rounded-md bg-accent px-3 text-sm font-medium text-accent-fg disabled:opacity-50"
        >
          {starting ? <Loader2 size={14} className="animate-spin" /> : <Mic size={14} />} Mitschrift starten
        </button>
      </div>
    </Modal>
  );
}

/** Schwebende Anzeige während der Mitschrift, auf jeder Seite sichtbar. */
function Recorder() {
  const s = useLecture();
  const page = usePages((st) => (s.pageId ? st.pages[s.pageId] : undefined));
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  if (s.status === 'idle') return null;
  const paused = s.status === 'paused';
  const finishing = s.status === 'finishing';
  const bars = [0.5, 0.8, 1, 0.7, 0.4];
  return createPortal(
    <div className="fixed bottom-5 left-5 z-30 w-[300px] animate-pop-in rounded-xl bg-surface p-3 shadow-popover">
      <div className="flex items-center gap-2">
        <span className={cx('h-2.5 w-2.5 shrink-0 rounded-full', paused || finishing ? 'bg-faint' : 'animate-pulse bg-danger')} />
        <button onClick={() => s.pageId && useUI.getState().open(s.pageId)} className="min-w-0 flex-1 truncate text-left text-sm font-medium hover:underline">
          {finishing ? 'Wird abgeschlossen …' : paused ? 'Pausiert' : 'Mitschrift läuft'}
          <span className="font-normal text-faint"> · {page?.title || 'Ohne Titel'}</span>
        </button>
        <span className="text-xs text-muted tabular-nums">{clock(now - s.startedAt)}</span>
      </div>
      <div className="mt-2 flex items-center gap-2">
        <div className="flex h-5 items-end gap-0.5" aria-hidden>
          {bars.map((b, i) => (
            <span key={i} className="w-1 rounded-full bg-accent transition-[height] duration-150" style={{ height: `${Math.max(12, (paused ? 0 : s.level) * b * 100)}%` }} />
          ))}
        </div>
        <p className="min-w-0 flex-1 truncate text-xs text-muted">{s.lastText || (s.status === 'starting' ? 'Startet …' : 'Wartet auf Sprache …')}</p>
      </div>
      {s.backlog > 60 && <p className="mt-1.5 text-xs text-faint">Erkennung hinkt {Math.round(s.backlog)} s hinterher, holt aber auf.</p>}
      {s.error && <p className="mt-1.5 text-xs text-danger">{s.error}</p>}
      <div className="mt-2.5 flex items-center gap-1.5">
        <span className="flex-1 text-xs text-faint">
          {s.notesCount ? `${s.notesCount} Abschnitte notiert` : 'Erste Notizen nach ~3 Min.'}
          {s.cost > 0 && ` · ${formatUsd(s.cost)}`}
        </span>
        {!finishing && (
          <>
            <button
              onClick={() => void pauseLecture(!paused).catch((err) => reportError('Pause', err))}
              title={paused ? 'Weiter' : 'Pause'}
              className="flex h-7 w-7 items-center justify-center rounded-md border border-border hover:bg-hover"
            >
              {paused ? <Play size={13} /> : <Pause size={13} />}
            </button>
            <button onClick={() => void stopLecture()} className="flex h-7 items-center gap-1.5 rounded-md bg-accent px-2.5 text-xs font-medium text-accent-fg">
              <Square size={11} /> Beenden
            </button>
          </>
        )}
        {finishing && <Loader2 size={14} className="animate-spin text-faint" />}
      </div>
    </div>,
    document.body,
  );
}

export function LectureUI() {
  const pageId = useStartDialog((s) => s.pageId);
  return (
    <>
      {pageId && <StartDialog pageId={pageId} />}
      <Recorder />
    </>
  );
}
