import type { Grant, Role } from '../features/collab/access';
import { db, type Statement } from './driver';

/** person: Gast mit Rechten pro Seite · device: eigenes Gerät (z. B. iPhone) mit vollem Zugriff */
export type MemberKind = 'person' | 'device';

/** Eingeladene Person oder eigenes Gerät. Der Token ist der geheime Teil des Links. */
export interface Member {
  id: string;
  name: string;
  token: string;
  color: string;
  createdAt: number;
  kind: MemberKind;
  /** Mitglied des Teams (sieht den ganzen Team-Bereich); sonst Gast bzw. eigenes Gerät */
  teamRole: 'member' | null;
}

/** Gut unterscheidbare Farben für Cursor und Avatare. */
export const MEMBER_COLORS = ['#e5484d', '#f76b15', '#ffc53d', '#30a46c', '#12a594', '#0090ff', '#6e56cf', '#d6409f'];

export async function loadMembers(): Promise<Member[]> {
  const rows = await db().select<{ id: string; name: string; token: string; color: string; created_at: number; kind: MemberKind; team_role: 'member' | null }>(
    'SELECT id, name, token, color, created_at, kind, team_role FROM share_members ORDER BY created_at',
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    token: r.token,
    color: r.color,
    createdAt: Number(r.created_at),
    kind: r.kind,
    teamRole: r.team_role ?? null,
  }));
}

export async function loadGrants(): Promise<Grant[]> {
  const rows = await db().select<{ member_id: string; page_id: string; role: Role }>('SELECT member_id, page_id, role FROM share_grants');
  return rows.map((r) => ({ memberId: r.member_id, pageId: r.page_id, role: r.role }));
}

/** 256 Bit Zufall als Hex: nicht zu erraten. */
export function newToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Geheimer Kanalname, unter dem efeu eigenen Geräten seine aktuelle Adresse meldet. */
export function newTopic(): string {
  return `efeu-${newToken().slice(0, 40)}`;
}

export function insertMember(m: Member): Statement {
  return {
    sql: 'INSERT INTO share_members (id, name, token, color, created_at, kind, team_role) VALUES (?, ?, ?, ?, ?, ?, ?)',
    params: [m.id, m.name, m.token, m.color, m.createdAt, m.kind, m.teamRole],
  };
}

export function renameMember(id: string, name: string): Statement {
  return { sql: 'UPDATE share_members SET name = ? WHERE id = ?', params: [name, id] };
}

/** Freigaben folgen per ON DELETE CASCADE. */
export function deleteMember(id: string): Statement {
  return { sql: 'DELETE FROM share_members WHERE id = ?', params: [id] };
}

export function setGrant(memberId: string, pageId: string, role: Role): Statement {
  return {
    sql: `INSERT INTO share_grants (member_id, page_id, role) VALUES (?, ?, ?)
          ON CONFLICT(member_id, page_id) DO UPDATE SET role = excluded.role`,
    params: [memberId, pageId, role],
  };
}

export function deleteGrant(memberId: string, pageId: string): Statement {
  return { sql: 'DELETE FROM share_grants WHERE member_id = ? AND page_id = ?', params: [memberId, pageId] };
}
