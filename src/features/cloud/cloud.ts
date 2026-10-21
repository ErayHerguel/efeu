import { getVersion } from '@tauri-apps/api/app';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { create } from 'zustand';
import { db } from '../../db/driver';
import { flush, onWrite } from '../../db/saveQueue';
import { importImageBlob } from '../../lib/assets';
import { toast } from '../../store/toast';
import { useDatabases } from '../../store/databases';
import { usePages } from '../../store/pages';
import { SyncClient, type Transport } from '../../sync/client';
import { Replica } from '../../sync/replica';
import type { Change } from '../../sync/types';
import { BoardHub } from '../collab/host/boards';
import { DocHub } from '../collab/host/docs';
import { HOST_COLOR, useHosting } from '../collab/host/hosting';
import { live } from './live';
import { useCollab } from '../collab/sources';

export type CloudPhase = 'off' | 'connecting' | 'synced' | 'syncing' | 'offline' | 'error';

interface CloudState {
  phase: CloudPhase;
  url: string | null;
  deviceId: string | null;
  error: string | null;
  lastSync: number | null;
  /** Neues root-Passwort, das efeu bei der Einrichtung gesetzt hat (nur bis zum Schließen des Hinweises) */
  newPassword: string | null;
  /** Eigene Cloud (Inhaber) oder als Mitglied im Team eines anderen */
  role: 'owner' | 'member' | null;
  /** Name, unter dem andere einen sehen (aus der Live-Verbindung) */
  displayName: string | null;
}

export const useCloud = create<CloudState>(() => ({
  phase: 'off',
  url: null,
  deviceId: null,
  error: null,
  lastSync: null,
  newPassword: null,
  role: null,
  displayName: null,
}));

interface Status {
  url: string;
  deviceId: string;
  memberId: string | null;
}

export interface CloudDevice {
  id: string;
  name: string;
  createdAt: number;
  lastSeen: number | null;
}

/** Anfrage an die verbundene Cloud (läuft über Rust). */
export const cloudRequest = <T>(method: string, path: string, body?: unknown) =>
  invoke<T>('cloud_request', { method, path, body: body ?? null });

const transport: Transport = {
  push: (changes: Change[]) => cloudRequest('POST', '/api/sync/push', { changes }),
  pull: (since) => cloudRequest('GET', `/api/sync/pull?since=${since}`),
  listAssets: async () => (await cloudRequest<{ names: string[] }>('GET', '/api/assets')).names,
  uploadAsset: (name) => invoke('cloud_asset_upload', { name }),
  downloadAsset: (name) => invoke('cloud_asset_download', { name }),
  localAssets: () => invoke<string[]>('cloud_assets_local'),
};

/** Kurz warten, damit schnelles Tippen nicht jede Sekunde einen Abgleich auslöst. */
const DEBOUNCE_MS = 1500;
/** Auffangnetz, falls eine Änderung an der Schreib-Warteschlange vorbei geschrieben wurde. */
const PERIODIC_MS = 30_000;

let session: {
  client: SyncClient;
  docs: DocHub;
  boards: BoardHub;
  cleanup: (() => void)[];
} | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;

function scheduleSync(delay = DEBOUNCE_MS) {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void runSync();
  }, delay);
}

async function runSync() {
  const s = session;
  if (!s) return;
  const { phase } = useCloud.getState();
  if (phase !== 'offline') useCloud.setState({ phase: 'syncing' });
  try {
    // Erst alles Ausstehende schreiben: der Abgleich liest den gespeicherten Stand.
    await flush();
    const report = await s.client.sync();
    if (session !== s) return;
    if (report.applied.rows || report.applied.docs.size || report.applied.boards.size) await refresh(report.applied.rows);
    useCloud.setState({ phase: 'synced', error: null, lastSync: Date.now() });
    live.retry();
  } catch (err) {
    if (session !== s) return;
    const message = err instanceof Error ? err.message : String(err);
    const offline = /nicht erreichbar|unterbrochen/i.test(message);
    useCloud.setState({ phase: offline ? 'offline' : 'error', error: message });
  }
}

/** Ansicht nach übernommenen Änderungen neu laden (offene Seiten und Boards laufen live mit). */
async function refresh(rows: boolean) {
  if (!rows) return;
  // Erst Ausstehendes schreiben, sonst überschriebe der neu geladene Stand eine laufende Änderung.
  await flush();
  await usePages.getState().load();
  const loaded = Object.keys(useDatabases.getState().data);
  await Promise.all(loaded.map((id) => useDatabases.getState().load(id).catch(() => undefined)));
}

const liveRefs = new Map<string, number>();

function installSources(docs: DocHub, boards: BoardHub) {
  useCollab.setState((s) => ({
    epoch: s.epoch + 1,
    docs: async (pageId) => {
      const binding = await docs.acquire(pageId);
      // Live mit den anderen: Tippen und Cursor sofort, nicht erst beim nächsten Abgleich.
      liveRefs.set(pageId, (liveRefs.get(pageId) ?? 0) + 1);
      live.attach(pageId, binding.doc, binding.awareness);
      const me = live.me;
      const user = { name: me?.name ?? (useHosting.getState().hostName || 'Ich'), color: me?.color ?? HOST_COLOR };
      return {
        ...binding,
        user,
        release: () => {
          const left = (liveRefs.get(pageId) ?? 1) - 1;
          if (left <= 0) {
            liveRefs.delete(pageId);
            live.detach(pageId);
          } else liveRefs.set(pageId, left);
          binding.release();
        },
      };
    },
    boards: async (pageId, events) => {
      const attached = await boards.attach(pageId, events);
      return {
        snapshot: attached.snapshot,
        change: attached.change,
        storeImage: (blob, name) => importImageBlob(blob, name),
        addFiles: (files) => void boards.addFiles(pageId, 'host', files),
        pointer: () => undefined,
        release: attached.detach,
      };
    },
  }));
}

/** Beim Start: ist eine Cloud verbunden, den Abgleich aufnehmen. */
export async function startCloud(): Promise<void> {
  if (session) return;
  const status = await invoke<Status | null>('cloud_status').catch(() => null);
  if (!status) return;
  const member = Boolean(status.memberId);
  useCloud.setState({ phase: 'connecting', url: status.url, deviceId: status.deviceId, error: null, role: member ? 'member' : 'owner' });
  // Mitglieder legen neue Seiten im Team an, der Inhaber privat.
  usePages.setState({ defaultSpace: member ? 'team' : 'private' });

  let docs: DocHub | null = null;
  let boards: BoardHub | null = null;
  const replica = new Replica(db(), {
    openDoc: (page) => docs?.peek(page),
    boardMerged: (page, elements, files) => boards?.external(page, elements, files),
  });
  if (member && !(await replica.device())) {
    // Erstes Verbinden mit einem fremden Team: Was schon auf diesem Computer liegt, bleibt hier und geht
    // nicht auf den Server des anderen. Wer etwas teilen will, zieht es selbst in den Team-Bereich.
    await db().tx([
      { sql: "UPDATE pages SET space = 'local' WHERE parent_id IS NULL" },
      { sql: "UPDATE categories SET space = 'local'" },
    ]);
    await usePages.getState().load();
  }
  await replica.enable(status.deviceId);
  docs = new DocHub(() => undefined, (page) => replica.loadDoc(page));
  boards = new BoardHub(() => undefined);
  const client = new SyncClient(db(), replica, transport);

  const unlisten: UnlistenFn[] = await Promise.all([
    listen<number>('cloud:changed', () => scheduleSync(100)),
    listen<{ online: boolean; error: string | null }>('cloud:online', (e) => {
      if (e.payload.online) scheduleSync(0);
      else useCloud.setState({ phase: 'offline', error: e.payload.error });
    }),
  ]);
  const periodic = setInterval(() => scheduleSync(0), PERIODIC_MS);
  session = {
    client,
    docs,
    boards,
    cleanup: [...unlisten, onWrite(() => scheduleSync()), () => clearInterval(periodic)],
  };
  installSources(docs, boards);
  // Teilen läuft jetzt über den Server: Einladungslinks zeigen auf ihn, und er ist immer erreichbar.
  if (!member) useHosting.setState({ live: true, status: { phase: 'online', url: status.url, localUrl: null, error: null } });
  await invoke('cloud_events');
  const name = useHosting.getState().hostName !== 'Gastgeber' ? useHosting.getState().hostName : await invoke<string>('device_name');
  await live.start(name).catch((err) => console.warn('Live-Verbindung', err));
  await runSync();
  if (!member) void updateServerIfOlder();
}

/** Vergleicht Versionsnummern wie 2.1.0 (Teile als Zahlen). */
export function olderVersion(a: string, b: string): boolean {
  const pa = a.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x < y;
  }
  return false;
}

/**
 * Läuft auf dem Server eine ältere Version als diese App, bringt die App ihn auf ihren Stand.
 * So bleiben App und Server zusammen, ohne dass jemand etwas auf dem Server tun muss.
 */
async function updateServerIfOlder() {
  try {
    const [{ version: server }, app] = await Promise.all([cloudRequest<{ version: string }>('GET', '/api/me'), getVersion()]);
    if (!olderVersion(server, app)) return;
    await invoke('cloud_update_server');
    toast(`Deine Cloud wird auf efeu ${app} aktualisiert …`);
    // Der Server startet neu; danach wieder abgleichen.
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      const me = await cloudRequest<{ version: string }>('GET', '/api/me').catch(() => null);
      if (me && !olderVersion(me.version, app)) {
        toast(`Deine Cloud läuft jetzt mit efeu ${app}.`);
        scheduleSync(0);
        return;
      }
    }
  } catch (err) {
    console.warn('Cloud konnte nicht aktualisiert werden', err);
  }
}

async function stopSession() {
  const s = session;
  if (!s) return;
  session = null;
  if (timer) clearTimeout(timer);
  for (const off of s.cleanup) off();
  await live.stop();
  await flush();
  useCollab.setState((st) => ({ docs: null, boards: null, epoch: st.epoch + 1 }));
  await new Promise((resolve) => setTimeout(resolve, 50));
  await s.docs.destroy();
  s.boards.destroy();
}

/** Server neu einrichten (per SSH) und dieses Gerät verbinden. */
export async function setupServer(options: { host: string; password: string; domain: string }): Promise<void> {
  const deviceName = await invoke<string>('device_name');
  const result = await invoke<{ url: string; newPassword: string | null }>('cloud_setup', {
    host: options.host,
    user: null,
    password: options.password,
    domain: options.domain || null,
    deviceName,
  });
  useCloud.setState({ newPassword: result.newPassword });
  await startCloud();
}

/** Einer bestehenden Cloud mit Adresse und Kopplungscode beitreten. */
export async function joinCloud(url: string, code: string): Promise<void> {
  const name = await invoke<string>('device_name');
  await invoke('cloud_pair', { url, code, name });
  await startCloud();
}

/** Verbindung trennen. Die Daten bleiben auf diesem Gerät und in der Cloud. */
/** Einladungslink zerlegen: https://server/team/<code> */
export function parseInvite(link: string): { url: string; code: string } | null {
  const m = /^(https?:\/\/[^/\s]+)\/team\/([0-9a-f]{32})\/?$/i.exec(link.trim());
  return m ? { url: m[1], code: m[2].toLowerCase() } : null;
}

/** Einem Team beitreten (Einladungslink) und dieses Gerät verbinden. */
export async function joinTeam(link: string, input: { name: string; login: string; password: string }): Promise<void> {
  const invite = parseInvite(link);
  if (!invite) throw new Error('Das sieht nicht nach einem Einladungslink aus (…/team/…).');
  const device = await invoke<string>('device_name');
  await invoke('cloud_team_join', { url: invite.url, code: invite.code, ...input, device });
  await startCloud();
}

/** Mit einem bestehenden Team-Konto anmelden (weiteres Gerät). */
export async function loginTeam(url: string, login: string, password: string): Promise<void> {
  const device = await invoke<string>('device_name');
  await invoke('cloud_team_login', { url, login, password, device });
  await startCloud();
}

export interface TeamMember {
  id: string;
  name: string;
  login: string;
  color: string;
  createdAt: number;
  lastSeen: number | null;
}

export const listTeam = async () => (await cloudRequest<{ members: TeamMember[] }>('GET', '/api/team/members')).members;
export const inviteToTeam = () => cloudRequest<{ code: string; expiresAt: number }>('POST', '/api/team/invites');
export const removeFromTeam = (id: string) => cloudRequest('DELETE', `/api/team/members/${id}`);
export const resetTeamPassword = (id: string) => cloudRequest<{ code: string; expiresAt: number }>('POST', `/api/team/members/${id}/reset`);

export async function disconnectCloud(): Promise<void> {
  const wasMember = useCloud.getState().role === 'member';
  await stopSession();
  await invoke('cloud_forget');
  // Ohne Cloud nichts mehr erfassen; beim nächsten Verbinden wird alles neu abgeglichen.
  const { removeCapture } = await import('../../sync/tables');
  await removeCapture(db());
  await db().tx([
    { sql: 'DELETE FROM sync_log' },
    { sql: 'DELETE FROM sync_meta' },
    { sql: 'DELETE FROM sync_docs' },
    { sql: 'DELETE FROM sync_boards' },
    { sql: 'DELETE FROM sync_state' },
    { sql: 'DELETE FROM sync_clock' },
    // Wer ein fremdes Team verlässt, behält dessen Seiten nicht; die eigenen werden wieder normal.
    ...(wasMember
      ? [
          { sql: "DELETE FROM pages WHERE parent_id IS NULL AND space = 'team'" },
          { sql: "DELETE FROM categories WHERE space = 'team'" },
          { sql: "UPDATE pages SET space = 'private' WHERE parent_id IS NULL AND space = 'local'" },
          { sql: "UPDATE categories SET space = 'private' WHERE space = 'local'" },
        ]
      : []),
  ]);
  usePages.setState({ defaultSpace: 'private' });
  await usePages.getState().load();
  useCloud.setState({ phase: 'off', url: null, deviceId: null, error: null, lastSync: null, role: null });
  useHosting.setState({ live: false, status: { phase: 'off', url: null, localUrl: null, error: null } });
}

export const syncNow = () => scheduleSync(0);

/** Name, unter dem andere einen sehen (Cursor, Präsenz, „Bearbeitet von …“). */
export async function setDisplayName(name: string): Promise<void> {
  const clean = name.trim().slice(0, 80);
  if (!clean) return;
  useHosting.getState().setHostName(clean);
  if (!session) return;
  // Neu verbinden, damit die anderen den neuen Namen sehen.
  await live.stop();
  await live.start(clean);
}

export const listDevices = () => cloudRequest<{ devices: CloudDevice[]; me: string }>('GET', '/api/devices');
export const removeDevice = (id: string) => cloudRequest('DELETE', `/api/devices/${id}`);
export const renameDevice = (id: string, name: string) => cloudRequest('PATCH', `/api/devices/${id}`, { name });
export const pairingCode = () => cloudRequest<{ code: string; expiresAt: number }>('POST', '/api/pairing');
