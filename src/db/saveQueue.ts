import { create } from 'zustand';
import { db, type Statement } from './driver';

/**
 * Zentrale Schreib-Warteschlange.
 *
 * - `schedule` sammelt Änderungen pro Schlüssel (z. B. "content:<id>") und schreibt sie gebündelt
 *   nach 300 ms Ruhe, spätestens nach 2 s Dauertippen.
 * - `commit` schreibt strukturelle Änderungen sofort, aber in derselben Reihenfolge wie alles andere.
 * - Schlägt eine Transaktion fehl, bleiben die Änderungen in der Warteschlange und werden erneut versucht.
 *   Es geht also nichts verloren, solange die App läuft.
 */

type Build = () => Statement[];
export type SaveStatus = 'idle' | 'pending' | 'saving' | 'error';

export const useSaveStatus = create<{ status: SaveStatus; error: string | null }>(() => ({
  status: 'idle',
  error: null,
}));

const DEBOUNCE_MS = 300;
const MAX_WAIT_MS = 2000;
const RETRY_MS = 2000;

const pending = new Map<string, Build>();
const writeListeners = new Set<() => void>();

/** Wird nach jedem erfolgreichen Schreibvorgang aufgerufen (z. B. für den Cloud-Abgleich). */
export function onWrite(listener: () => void): () => void {
  writeListeners.add(listener);
  return () => writeListeners.delete(listener);
}

const notifyWrite = () => {
  for (const l of writeListeners) l();
};
let timer: ReturnType<typeof setTimeout> | null = null;
let firstPendingAt = 0;
let chain: Promise<void> = Promise.resolve();

function arm(delay: number) {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void flush();
  }, delay);
}

export function schedule(key: string, build: Build, delay = DEBOUNCE_MS): void {
  pending.set(key, build);
  if (!firstPendingAt) firstPendingAt = Date.now();
  arm(Math.min(delay, Math.max(0, firstPendingAt + MAX_WAIT_MS - Date.now())));
  if (useSaveStatus.getState().status !== 'error') useSaveStatus.setState({ status: 'pending' });
}

/** Verwirft ausstehende Änderungen, deren Schlüssel `match` erfüllt (z. B. vor endgültigem Löschen). */
export function discard(match: (key: string) => boolean): void {
  for (const key of [...pending.keys()]) if (match(key)) pending.delete(key);
}

/** Schreibt alle ausstehenden Änderungen in einer Transaktion und wartet darauf. */
export function flush(): Promise<void> {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  firstPendingAt = 0;
  if (pending.size === 0) return chain;

  const batch = new Map(pending);
  pending.clear();
  const statements = [...batch.values()].flatMap((build) => build());

  chain = chain.then(async () => {
    useSaveStatus.setState({ status: 'saving' });
    try {
      await db().tx(statements);
      useSaveStatus.setState({ status: pending.size ? 'pending' : 'idle', error: null });
      notifyWrite();
    } catch (err) {
      for (const [key, build] of batch) if (!pending.has(key)) pending.set(key, build);
      useSaveStatus.setState({ status: 'error', error: String(err) });
      console.error('Speichern fehlgeschlagen', err);
      arm(RETRY_MS);
    }
  });
  return chain;
}

/** Sofortiger, geordneter Schreibvorgang. Lehnt ab, wenn die Transaktion fehlschlägt. */
export function commit(statements: Statement[]): Promise<void> {
  void flush();
  const result = chain.then(() => db().tx(statements)).then(notifyWrite);
  chain = result.catch(() => undefined);
  return result;
}
