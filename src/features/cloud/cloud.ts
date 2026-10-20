import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { create } from 'zustand';
import { db } from '../../db/driver';
import { flush, onWrite } from '../../db/saveQueue';
import { importImageBlob } from '../../lib/assets';
import { useDatabases } from '../../store/databases';
import { usePages } from '../../store/pages';
import { SyncClient, type Transport } from '../../sync/client';
import { Replica } from '../../sync/replica';
import type { Change } from '../../sync/types';
import { BoardHub } from '../collab/host/boards';
import { DocHub } from '../collab/host/docs';
import { useCollab } from '../collab/sources';

export type CloudPhase = 'off' | 'connecting' | 'synced' | 'syncing' | 'offline' | 'error';

interface CloudState {
  phase: CloudPhase;
  url: string | null;
  deviceId: string | null;
  error: string | null;
  lastSync: number | null;
}

export const useCloud = create<CloudState>(() => ({ phase: 'off', url: null, deviceId: null, error: null, lastSync: null }));

interface Status {
  url: string;
  deviceId: string;
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
  await usePages.getState().load();
  const loaded = Object.keys(useDatabases.getState().data);
  await Promise.all(loaded.map((id) => useDatabases.getState().load(id).catch(() => undefined)));
}

function installSources(docs: DocHub, boards: BoardHub) {
  const user = { name: 'Ich', color: '#2f6fde' };
  useCollab.setState((s) => ({
    epoch: s.epoch + 1,
    docs: async (pageId) => ({ ...(await docs.acquire(pageId)), user }),
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
  useCloud.setState({ phase: 'connecting', url: status.url, deviceId: status.deviceId, error: null });

  let docs: DocHub | null = null;
  let boards: BoardHub | null = null;
  const replica = new Replica(db(), {
    openDoc: (page) => docs?.peek(page),
    boardMerged: (page, elements, files) => boards?.external(page, elements, files),
  });
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
  await invoke('cloud_events');
  await runSync();
}

async function stopSession() {
  const s = session;
  if (!s) return;
  session = null;
  if (timer) clearTimeout(timer);
  for (const off of s.cleanup) off();
  await flush();
  useCollab.setState((st) => ({ docs: null, boards: null, epoch: st.epoch + 1 }));
  await new Promise((resolve) => setTimeout(resolve, 50));
  await s.docs.destroy();
  s.boards.destroy();
}

/** Server neu einrichten (per SSH) und dieses Gerät verbinden. */
export async function setupServer(options: { host: string; password: string; domain: string }): Promise<void> {
  const deviceName = await invoke<string>('device_name');
  await invoke('cloud_setup', {
    host: options.host,
    user: null,
    password: options.password,
    domain: options.domain || null,
    deviceName,
  });
  await startCloud();
}

/** Einer bestehenden Cloud mit Adresse und Kopplungscode beitreten. */
export async function joinCloud(url: string, code: string): Promise<void> {
  const name = await invoke<string>('device_name');
  await invoke('cloud_pair', { url, code, name });
  await startCloud();
}

/** Verbindung trennen. Die Daten bleiben auf diesem Gerät und in der Cloud. */
export async function disconnectCloud(): Promise<void> {
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
  ]);
  useCloud.setState({ phase: 'off', url: null, deviceId: null, error: null, lastSync: null });
}

export const syncNow = () => scheduleSync(0);

export const listDevices = () => cloudRequest<{ devices: CloudDevice[]; me: string }>('GET', '/api/devices');
export const removeDevice = (id: string) => cloudRequest('DELETE', `/api/devices/${id}`);
export const renameDevice = (id: string, name: string) => cloudRequest('PATCH', `/api/devices/${id}`, { name });
export const pairingCode = () => cloudRequest<{ code: string; expiresAt: number }>('POST', '/api/pairing');
