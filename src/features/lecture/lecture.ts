import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { JSONContent } from '@tiptap/core';
import { create } from 'zustand';
import { usePages } from '../../store/pages';
import { reportError, toast } from '../../store/toast';
import { AiCancelled, askAi, overBudget, run } from '../ai/client';
import { estimateCost } from '../ai/cost';
import { cleanAnswer, fromAiMarkdown } from '../ai/markdown';
import { aiUsable } from '../ai/store';
import { dueForNotes, liveNotesRequest, summaryRequest, transcriptToggle, transcriptText, type Segment } from './notes';
import { appendBlocks, replaceMarker } from './pageWriter';

/**
 * Vorlesung mitschreiben: Rust nimmt auf und erkennt Sprache (Whisper, lokal), hier entstehen daraus
 * live Notizen in der Seite und am Ende eine Zusammenfassung. Läuft unabhängig von der geöffneten
 * Seite und auch, wenn das Fenster geschlossen ist.
 */

export type LectureStatus = 'idle' | 'starting' | 'recording' | 'paused' | 'finishing';
export type Language = 'de' | 'en' | 'auto';

export interface LectureOptions {
  language: Language;
  /** Rohe Mitschrift am Ende einklappbar in die Seite */
  keepTranscript: boolean;
  /** Live-Stichpunkte per KI (sonst nur die Mitschrift) */
  liveNotes: boolean;
  /** Folien als PDF für die Zusammenfassung */
  slides: { name: string; data: string } | null;
}

interface LectureState {
  status: LectureStatus;
  pageId: string | null;
  startedAt: number;
  /** Laufzeit ohne Pausen in ms (aus den Zeitmarken der Erkennung) */
  heardMs: number;
  level: number;
  lastText: string;
  segments: Segment[];
  notesCount: number;
  cost: number;
  backlog: number;
  error: string | null;
}

export const useLecture = create<LectureState>(() => ({
  status: 'idle',
  pageId: null,
  startedAt: 0,
  heardMs: 0,
  level: 0,
  lastText: '',
  segments: [],
  notesCount: 0,
  cost: 0,
  backlog: 0,
  error: null,
}));

const MARKER = 'Zusammenfassung folgt nach der Vorlesung.';
/** Live-Notizen mit dem günstigsten Modell: eine ganze Vorlesung kostet so etwa 1 Cent. */
const LIVE_MODEL = 'claude-haiku-5-5' as const;

let options: LectureOptions = { language: 'de', keepTranscript: true, liveNotes: true, slides: null };
let pendingFrom = 0;
let notesText = '';
let writing: Promise<void> = Promise.resolve();
let offEvents: (() => void) | null = null;
let finished: (() => void) | null = null;

/** Seitenschreibvorgänge nacheinander (Reihenfolge der Abschnitte bleibt erhalten). */
function queue(task: () => Promise<void>): Promise<void> {
  writing = writing.then(task).catch((err) => console.error('Mitschrift', err));
  return writing;
}

const p = (text: string, marks?: JSONContent['marks']): JSONContent => ({ type: 'paragraph', content: text ? [{ type: 'text', text, ...(marks ? { marks } : {}) }] : [] });

async function onSegment(segment: Segment) {
  useLecture.setState((s) => ({ segments: [...s.segments, segment], lastText: segment.text, heardMs: segment.endMs, backlog: 0 }));
  maybeWriteNotes(false);
}

let notesBusy = false;

/** Schreibt einen Live-Abschnitt, sobald genug Neues gesagt wurde (oder beim Beenden). */
function maybeWriteNotes(force: boolean): Promise<void> {
  const { segments, pageId } = useLecture.getState();
  const pending = segments.slice(pendingFrom);
  if (!pageId || notesBusy || !dueForNotes(pending, force)) return Promise.resolve();
  notesBusy = true;
  pendingFrom = segments.length;
  return queue(async () => {
    try {
      if (options.liveNotes && aiUsable() && !overBudget(0.002)) {
        const result = await run(liveNotesRequest(pending, notesText), LIVE_MODEL);
        useLecture.setState((s) => ({ cost: s.cost + result.cost }));
        const answer = cleanAnswer(result.text);
        if (answer && answer !== 'LEER') {
          notesText += `\n${answer}`;
          await appendBlocks(pageId, fromAiMarkdown(answer));
          useLecture.setState((s) => ({ notesCount: s.notesCount + 1 }));
        }
      } else if (!options.liveNotes || !aiUsable()) {
        // Ohne KI: die Mitschrift selbst wächst in der Seite mit.
        await appendBlocks(pageId, [p(transcriptText(pending))]);
      }
    } catch (err) {
      if (!(err instanceof AiCancelled)) useLecture.setState({ error: err instanceof Error ? err.message : String(err) });
    } finally {
      notesBusy = false;
    }
  });
}

export async function modelStatus(): Promise<{ ready: boolean; name: string; size: number; recording: boolean }> {
  return invoke('lecture_status');
}

export async function downloadModel(onProgress: (received: number, total: number) => void): Promise<void> {
  const off = await listen<{ received: number; total: number }>('lecture-download', (e) => onProgress(e.payload.received, e.payload.total));
  try {
    await invoke('lecture_download');
  } finally {
    off();
  }
}

export async function startLecture(pageId: string, opts: LectureOptions): Promise<void> {
  if (useLecture.getState().status !== 'idle') throw new Error('Es läuft bereits eine Mitschrift.');
  options = opts;
  pendingFrom = 0;
  notesText = '';
  useLecture.setState({ status: 'starting', pageId, startedAt: Date.now(), heardMs: 0, level: 0, lastText: '', segments: [], notesCount: 0, cost: 0, backlog: 0, error: null });
  const offLecture = await listen<{ kind: string; text?: string; startMs?: number; endMs?: number; level?: number; seconds?: number; message?: string }>(
    'lecture',
    ({ payload }) => {
      if (payload.kind === 'segment') void onSegment({ text: payload.text ?? '', startMs: payload.startMs ?? 0, endMs: payload.endMs ?? 0 });
      else if (payload.kind === 'level') useLecture.setState({ level: payload.level ?? 0 });
      else if (payload.kind === 'backlog') useLecture.setState({ backlog: payload.seconds ?? 0 });
      else if (payload.kind === 'error') {
        useLecture.setState({ error: payload.message ?? 'Fehler' });
        reportError('Mitschrift', payload.message);
      } else if (payload.kind === 'finished') finished?.();
    },
  );
  const offStop = await listen('tray:lecture-stop', () => void stopLecture());
  offEvents = () => {
    offLecture();
    offStop();
  };
  const now = new Date();
  const when = now.toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long' }) + `, ${now.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}`;
  await queue(() =>
    appendBlocks(pageId, [
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: `Vorlesung · ${when}` }] },
      { type: 'callout', attrs: { icon: '⏳' }, content: [p(MARKER)] },
    ]),
  );
  try {
    await invoke('lecture_start', { language: opts.language });
    await invoke('tray_recording', { recording: true }).catch(() => undefined);
    useLecture.setState({ status: 'recording' });
  } catch (err) {
    cleanup();
    await replaceMarker(pageId, MARKER, []).catch(() => undefined);
    throw err;
  }
}

export async function pauseLecture(paused: boolean): Promise<void> {
  await invoke('lecture_pause', { paused });
  useLecture.setState({ status: paused ? 'paused' : 'recording', level: 0 });
}

function cleanup() {
  offEvents?.();
  offEvents = null;
  finished = null;
  void invoke('tray_recording', { recording: false }).catch(() => undefined);
  useLecture.setState({ status: 'idle', pageId: null, level: 0 });
}

/** Beendet die Mitschrift: Rest erkennen, letzten Abschnitt notieren, Zusammenfassung oben einsetzen. */
export async function stopLecture(): Promise<void> {
  const state = useLecture.getState();
  if (state.status !== 'recording' && state.status !== 'paused') return;
  const pageId = state.pageId!;
  useLecture.setState({ status: 'finishing', level: 0 });
  const done = new Promise<void>((resolve) => {
    finished = resolve;
    setTimeout(resolve, 120_000);
  });
  try {
    await invoke('lecture_stop');
    await done;
    await maybeWriteNotes(true);
    await writing;
    const { segments } = useLecture.getState();
    if (!segments.length) {
      await replaceMarker(pageId, MARKER, [p('Es wurde nichts erkannt. War das richtige Mikrofon aktiv?', [{ type: 'italic' }])]);
      return;
    }
    if (options.keepTranscript) await appendBlocks(pageId, [transcriptToggle(segments)]);
    await summarize(pageId, segments);
  } catch (err) {
    reportError('Mitschrift beenden', err);
  } finally {
    cleanup();
  }
}

async function summarize(pageId: string, segments: Segment[]) {
  if (!aiUsable()) {
    await replaceMarker(pageId, MARKER, [p('Für eine automatische Zusammenfassung richte die KI ein (Einstellungen → KI).', [{ type: 'italic' }])]);
    return;
  }
  try {
    const result = await askAi(summaryRequest(notesText, segments, options.slides));
    if (!result) {
      await replaceMarker(pageId, MARKER, [p('Keine Zusammenfassung erstellt.', [{ type: 'italic' }])]);
      return;
    }
    useLecture.setState((s) => ({ cost: s.cost + result.cost }));
    await replaceMarker(pageId, MARKER, fromAiMarkdown(cleanAnswer(result.text)));
    const title = usePages.getState().pages[pageId]?.title || 'Seite';
    toast(`Vorlesung zusammengefasst in „${title}“ · ${(useLecture.getState().cost).toLocaleString('de-DE', { maximumFractionDigits: 3 })} $ insgesamt`);
  } catch (err) {
    if (err instanceof AiCancelled) return;
    await replaceMarker(pageId, MARKER, [p('Die Zusammenfassung ist fehlgeschlagen. Mit ⌘J kannst du sie aus der Mitschrift erstellen lassen.', [{ type: 'italic' }])]);
    reportError('Zusammenfassung', err);
  }
}

/** Geschätzte Kosten pro Stunde für die Live-Notizen (20 Abschnitte à ~1.400 Tokens Eingabe mit Haiku) */
export function liveCostPerHour(): number {
  return estimateCost(LIVE_MODEL, 1_400, [200, 700]).high * 20;
}

export const isRecording = () => {
  const s = useLecture.getState().status;
  return s === 'recording' || s === 'paused' || s === 'starting' || s === 'finishing';
};
