import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { create } from 'zustand';
import { commit, flush, schedule } from '../../../db/saveQueue';
import { setSetting } from '../../../db/settings';
import {
  deleteGrant,
  deleteMember,
  insertMember,
  loadGrants,
  loadMembers,
  MEMBER_COLORS,
  newToken,
  newTopic,
  renameMember,
  setGrant,
  type Member,
  type MemberKind,
} from '../../../db/share';
import { LAUNCHER_URL } from '../../../app.config';
import { newId } from '../../../lib/ids';
import { confirmDialog } from '../../../store/confirm';
import { reportError, toast } from '../../../store/toast';
import { useCloud } from '../../cloud/cloud';
import { usePresence } from '../presence';
import type { Grant, Role } from '../access';
import { startHub, stopHub, syncAccess } from './hub';

export type Phase = 'off' | 'starting' | 'downloading' | 'connecting' | 'online' | 'error';

export interface ShareStatus {
  phase: Phase;
  url: string | null;
  localUrl: string | null;
  error: string | null;
}

const OFF: ShareStatus = { phase: 'off', url: null, localUrl: null, error: null };
export const HOST_COLOR = '#2f6fde';

interface HostingState {
  status: ShareStatus;
  /** Editoren und Boards laufen gemeinsam (Yjs) statt lokal. */
  live: boolean;
  members: Member[];
  grants: Grant[];
  hostName: string;
  /** Beim Start der App automatisch teilen */
  autostart: boolean;
  /** Kein Ruhezustand, solange geteilt wird */
  keepAwake: boolean;
  /** Geheimer Kanal für die Adressmeldung an eigene Geräte (wird beim ersten Gerät angelegt) */
  topic: string | null;
  hydrate(settings: Record<string, string>): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  invite(name: string, kind?: MemberKind): Promise<Member>;
  removeMember(id: string): Promise<void>;
  renameMember(id: string, name: string): void;
  setRole(memberId: string, pageId: string, role: Role | null): Promise<void>;
  setHostName(name: string): void;
  setAutostart(on: boolean): void;
  setKeepAwake(on: boolean): void;
}

/** Einladungslink einer Person; erst verfügbar, wenn der Tunnel steht. */
export function inviteLink(status: ShareStatus, member: Member): string | null {
  return status.url ? `${status.url}/#join=${member.token}` : null;
}

/**
 * Fester Link eines eigenen Geräts: die Startseite auf der efeu-Website fragt die aktuelle Adresse
 * unter dem geheimen Kanal ab und leitet weiter. Kanal und Schlüssel stehen nur im Fragment (#),
 * das nie an einen Server geht.
 */
export function deviceLink(topic: string, member: Member): string {
  return `${LAUNCHER_URL}#d=${topic}.${member.token}`;
}

const persistSetting = (key: string, value: string) => schedule(`setting:${key}`, () => [setSetting(key, value)]);
const hasDevice = () => useHosting.getState().members.some((m) => m.kind === 'device');

export const useHosting = create<HostingState>((set, get) => ({
  status: OFF,
  live: false,
  members: [],
  grants: [],
  hostName: 'Gastgeber',
  autostart: false,
  keepAwake: true,
  topic: null,

  async hydrate(settings) {
    const [members, grants, status] = await Promise.all([loadMembers(), loadGrants(), invoke<ShareStatus>('share_status')]);
    set({
      members,
      grants,
      status,
      hostName: settings['share.name'] || 'Gastgeber',
      autostart: settings['share.autostart'] === 'true',
      keepAwake: settings['share.keepAwake'] !== 'false',
      topic: settings['share.topic'] || null,
    });
    await listen<ShareStatus>('share:status', (event) => set({ status: event.payload }));
    if (get().autostart) void get().start();
  },

  async start() {
    if (get().live) return;
    // Mit eigener Cloud laufen Editor und Boards über den Abgleich; beides gleichzeitig ginge durcheinander.
    if (useCloud.getState().phase !== 'off') {
      toast('Mit eigener Cloud wird über die Cloud geteilt, nicht über diesen Computer.');
      return;
    }
    try {
      await flush();
      await startHub();
      set({ live: true });
      const { topic, keepAwake } = get();
      // Die Adresse wird nur gemeldet, wenn es eigene Geräte gibt.
      set({ status: await invoke<ShareStatus>('share_start', { topic: hasDevice() ? topic : null, keepAwake }) });
    } catch (err) {
      await get().stop();
      reportError('Teilen konnte nicht gestartet werden', err);
    }
  },

  async stop() {
    await invoke('share_stop').catch(() => undefined);
    await stopHub();
    set({ live: false, status: OFF });
  },

  async invite(name, kind = 'person') {
    const { members } = get();
    const member: Member = {
      id: newId(),
      name: name.trim() || (kind === 'device' ? 'iPhone' : 'Gast'),
      token: newToken(),
      color: MEMBER_COLORS[members.length % MEMBER_COLORS.length],
      createdAt: Date.now(),
      kind,
    };
    const statements = [insertMember(member)];
    let { topic } = get();
    if (kind === 'device' && !topic) {
      topic = newTopic();
      statements.push(setSetting('share.topic', topic));
    }
    await commit(statements);
    set({ members: [...members, member], topic });
    if (kind === 'device' && topic && get().live) await invoke('share_announce', { topic }).catch(() => undefined);
    return member;
  },

  async removeMember(id) {
    await commit([deleteMember(id)]);
    set((s) => ({ members: s.members.filter((m) => m.id !== id), grants: s.grants.filter((g) => g.memberId !== id) }));
    await invoke('share_close_member', { memberId: id }).catch(() => undefined);
    syncAccess();
  },

  renameMember(id, name) {
    set((s) => ({ members: s.members.map((m) => (m.id === id ? { ...m, name } : m)) }));
    schedule(`member:${id}`, () => {
      const member = get().members.find((m) => m.id === id);
      return member ? [renameMember(id, member.name.trim() || 'Gast')] : [];
    });
  },

  async setRole(memberId, pageId, role) {
    const others = get().grants.filter((g) => !(g.memberId === memberId && g.pageId === pageId));
    const grants = role ? [...others, { memberId, pageId, role }] : others;
    await commit([role ? setGrant(memberId, pageId, role) : deleteGrant(memberId, pageId)]);
    set({ grants });
    syncAccess();
  },

  setHostName(name) {
    set({ hostName: name });
    schedule('setting:share.name', () => [setSetting('share.name', get().hostName.trim() || 'Gastgeber')]);
  },

  setAutostart(on) {
    set({ autostart: on });
    persistSetting('share.autostart', String(on));
  },

  setKeepAwake(on) {
    set({ keepAwake: on });
    persistSetting('share.keepAwake', String(on));
    if (get().live) void invoke('share_keep_awake', { on }).catch(() => undefined);
  },
}));

export const isLive = () => useHosting.getState().live;

/** Vor dem Schließen: arbeiten gerade andere mit, nachfragen. */
export async function confirmStopSharing(): Promise<boolean> {
  const guests = usePresence.getState().people.filter((p) => p.id !== 'host').length;
  if (!useHosting.getState().live || guests === 0) return true;
  return confirmDialog({
    title: 'Teilen wird beendet',
    message: `${guests === 1 ? 'Eine Person arbeitet' : `${guests} Personen arbeiten`} gerade mit. Wenn efeu schließt, werden sie getrennt; alles Bisherige ist gespeichert.`,
    confirmLabel: 'Trotzdem schließen',
    danger: true,
  });
}
