import { relaunch } from '@tauri-apps/plugin-process';
import { check, type Update } from '@tauri-apps/plugin-updater';
import { create } from 'zustand';
import { schedule } from '../../db/saveQueue';
import { setSetting } from '../../db/settings';
import { reportError, toast } from '../../store/toast';
import { ensureSaved } from '../lifecycle';

/**
 * Updates wie bei Discord: beim Start einmal im Hintergrund prüfen, pro neuer Version genau einmal
 * erinnern, dann mit einem Klick laden, installieren und neu starten.
 * Die einzige Netzwerkverbindung der App: Abfrage von latest.json bei GitHub (abschaltbar).
 */

type Phase = 'idle' | 'available' | 'downloading' | 'ready';

interface UpdateState {
  phase: Phase;
  version: string | null;
  progress: number;
  /** Banner sichtbar */
  visible: boolean;
  auto: boolean;
  dismissedVersion: string | null;
}

export const useUpdate = create<UpdateState>(() => ({
  phase: 'idle',
  version: null,
  progress: 0,
  visible: false,
  auto: true,
  dismissedVersion: null,
}));

let pending: Update | null = null;

const persist = (key: string, value: string) => schedule(`setting:${key}`, () => [setSetting(key, value)]);

export function hydrateUpdates(settings: Record<string, string>): void {
  useUpdate.setState({ auto: settings['update.auto'] !== 'false', dismissedVersion: settings['update.dismissed'] || null });
}

/** Prüft auf ein Update. `manual` zeigt auch „aktuell“ an und ignoriert „Später“. */
export async function checkForUpdate(manual = false): Promise<void> {
  try {
    const update = await check();
    if (!update) {
      if (manual) toast('efeu ist auf dem neuesten Stand');
      return;
    }
    pending = update;
    const { dismissedVersion } = useUpdate.getState();
    useUpdate.setState({ phase: 'available', version: update.version, visible: manual || dismissedVersion !== update.version });
  } catch (err) {
    if (manual) toast(describeCheckError(err));
    else console.warn('Update-Prüfung fehlgeschlagen', err);
  }
}

/** Verständliche Meldung statt technischer Fehler: Fehlende Update-Infos heißen „aktuell“. */
export function describeCheckError(err: unknown): string {
  const message = String(err instanceof Error ? err.message : err).toLowerCase();
  if (message.includes('release json') || message.includes('404') || message.includes('not found')) {
    return 'efeu ist auf dem neuesten Stand';
  }
  if (/(network|connect|dns|timed? ?out|offline|resolve|internet)/.test(message)) {
    return 'Keine Verbindung zu GitHub. Bitte später erneut versuchen.';
  }
  return 'Update-Prüfung gerade nicht möglich. Bitte später erneut versuchen.';
}

/** Beim Start: kurz warten, damit die App zuerst flüssig lädt. */
export function scheduleStartupCheck(): void {
  if (!useUpdate.getState().auto) return;
  setTimeout(() => void checkForUpdate(false), 4000);
}

export function dismissUpdate(): void {
  const { version } = useUpdate.getState();
  useUpdate.setState({ visible: false, dismissedVersion: version });
  if (version) persist('update.dismissed', version);
}

export function toggleAutoUpdate(): void {
  const auto = !useUpdate.getState().auto;
  useUpdate.setState({ auto });
  persist('update.auto', String(auto));
  toast(auto ? 'Automatische Update-Suche ist an' : 'Automatische Update-Suche ist aus');
}

export async function installUpdate(): Promise<void> {
  if (!pending) return;
  try {
    let total = 0;
    let done = 0;
    useUpdate.setState({ phase: 'downloading', progress: 0 });
    await pending.downloadAndInstall((event) => {
      if (event.event === 'Started') total = event.data.contentLength ?? 0;
      if (event.event === 'Progress') {
        done += event.data.chunkLength;
        useUpdate.setState({ progress: total ? Math.min(99, Math.round((done / total) * 100)) : 0 });
      }
      if (event.event === 'Finished') useUpdate.setState({ progress: 100 });
    });
    useUpdate.setState({ phase: 'ready' });
    if (await ensureSaved()) await relaunch();
  } catch (err) {
    useUpdate.setState({ phase: 'available' });
    reportError('Update fehlgeschlagen', err);
  }
}
