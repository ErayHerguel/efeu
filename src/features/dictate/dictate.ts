import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { Editor } from '@tiptap/core';
import { create } from 'zustand';
import { getActiveEditor } from '../../editor/active';
import { reportError, toast } from '../../store/toast';
import { modelStatus } from '../lecture/lecture';

/**
 * Diktat: Taste drücken (oder halten), sprechen, und der Text landet an der Cursorposition.
 * Erkannt wird lokal mit demselben Whisper-Modell wie bei der Vorlesung; der Ton verlässt den Rechner nie.
 */

export type DictateStatus = 'idle' | 'starting' | 'recording' | 'transcribing';

export const useDictate = create<{ status: DictateStatus; level: number; needsModel: boolean }>(() => ({
  status: 'idle',
  level: 0,
  needsModel: false,
}));

export const DICTATE_KEYS = 'Mod+Alt+V';

let target: Editor | null = null;
let offEvents: (() => void) | null = null;

/** Sprache und Mikrofon aus den Einstellungen der Vorlesung (gleiche Wahl, weniger Fragen). */
function prefs(): { language: string; device: string | null } {
  try {
    const saved = JSON.parse(localStorage.getItem('efeu.lecture.prefs') ?? '{}') as { language?: string; device?: string | null };
    return { language: saved.language ?? 'de', device: saved.device ?? null };
  } catch {
    return { language: 'de', device: null };
  }
}

/** Fügt den Text an der Cursorposition ein, mit Leerzeichen zum Text davor. */
export function insertDictation(editor: Editor, text: string): void {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return;
  const { from, empty, $from } = editor.state.selection;
  const before = empty ? $from.parent.textBetween(0, $from.parentOffset, undefined, ' ') : '';
  const space = before && !/\s$/.test(before) ? ' ' : '';
  editor.chain().focus().insertContentAt(empty ? from : { from, to: editor.state.selection.to }, `${space}${clean}`).run();
}

function cleanup() {
  offEvents?.();
  offEvents = null;
}

export async function startDictation(): Promise<void> {
  if (useDictate.getState().status !== 'idle') return;
  const editor = getActiveEditor();
  if (!editor || !editor.isEditable) return toast('Setze den Cursor zuerst in eine Seite.');
  try {
    const status = await modelStatus();
    if (status.recording) return toast('Während einer Vorlesungs-Mitschrift geht kein Diktat.');
    if (!status.ready) {
      useDictate.setState({ needsModel: true });
      return;
    }
    target = editor;
    useDictate.setState({ status: 'starting', level: 0 });
    offEvents = await listen<{ kind: string; level?: number; message?: string }>('lecture', ({ payload }) => {
      if (payload.kind === 'level') useDictate.setState({ level: payload.level ?? 0 });
      else if (payload.kind === 'error') {
        toast(payload.message ?? 'Mikrofon-Fehler', 'error');
        void cancelDictation();
      }
    });
    await invoke('dictate_start', { device: prefs().device });
    if (useDictate.getState().status === 'starting') useDictate.setState({ status: 'recording' });
  } catch (err) {
    cleanup();
    useDictate.setState({ status: 'idle', level: 0 });
    reportError('Diktat starten', err);
  }
}

export async function stopDictation(): Promise<void> {
  if (useDictate.getState().status !== 'recording') return;
  cleanup();
  useDictate.setState({ status: 'transcribing', level: 0 });
  try {
    const text = await invoke<string>('dictate_stop', { language: prefs().language });
    const editor = target && !target.isDestroyed ? target : getActiveEditor();
    if (!text.trim()) toast('Nichts verstanden. Sprich etwas näher am Mikrofon.');
    else if (editor?.isEditable) insertDictation(editor, text);
  } catch (err) {
    reportError('Diktat', err);
  } finally {
    target = null;
    useDictate.setState({ status: 'idle', level: 0 });
  }
}

export async function cancelDictation(): Promise<void> {
  cleanup();
  target = null;
  useDictate.setState({ status: 'idle', level: 0 });
  await invoke('dictate_cancel').catch(() => undefined);
}

export function toggleDictation(): void {
  const { status } = useDictate.getState();
  if (status === 'idle') void startDictation();
  else if (status === 'recording') void stopDictation();
}
