import { invoke } from '@tauri-apps/api/core';
import { flush, useSaveStatus } from '../db/saveQueue';
import { confirmDialog } from '../store/confirm';
import { confirmStopSharing } from './collab/host/hosting';
import { isRecording, stopLecture } from './lecture/lecture';

/** Schreibt alles Ausstehende. Liefert false, wenn der Nutzer bei Speicherfehlern abbricht. */
export async function ensureSaved(): Promise<boolean> {
  await flush();
  if (useSaveStatus.getState().status !== 'error') return true;
  return confirmDialog({
    title: 'Nicht gespeicherte Änderungen',
    message:
      'Einige Änderungen konnten nicht gespeichert werden und gehen beim Beenden verloren. Die App versucht es weiter, solange sie geöffnet bleibt.',
    confirmLabel: 'Trotzdem beenden',
    danger: true,
  });
}

/** Läuft eine Mitschrift: nachfragen und sie sauber beenden (letzte Notizen, Zusammenfassung). */
async function confirmStopLecture(): Promise<boolean> {
  if (!isRecording()) return true;
  const ok = await confirmDialog({
    title: 'Mitschrift läuft noch',
    message: 'flou beendet die Mitschrift, schreibt die letzten Notizen und die Zusammenfassung und schließt dann.',
    confirmLabel: 'Beenden und schließen',
  });
  if (ok) await stopLecture();
  return ok;
}

export async function quitApp(): Promise<void> {
  if ((await confirmStopLecture()) && (await confirmStopSharing()) && (await ensureSaved())) await invoke('app_quit');
}
