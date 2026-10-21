import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { MEMBER_COLORS } from '../src/db/share';
import { transaction, type Store } from './store';

/** Einladungen gelten eine Woche, Links zum Zurücksetzen des Passworts einen Tag. */
const INVITE_MS = 7 * 24 * 60 * 60 * 1000;
const RESET_MS = 24 * 60 * 60 * 1000;

const SCHEMA = `
-- Zugangsdaten der Team-Mitglieder. Das Mitglied selbst steht in share_members (wird abgeglichen),
-- Login und Passwort-Hash bleiben nur auf dem Server.
CREATE TABLE IF NOT EXISTS team_accounts (
  member_id TEXT PRIMARY KEY,
  login TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS team_invites (
  code_hash TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS team_resets (
  code_hash TEXT PRIMARY KEY,
  member_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
`;

const hash = (secret: string) => createHash('sha256').update(secret).digest('hex');

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const derived = scryptSync(password, salt, 32, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return `scrypt$15$8$1$${salt.toString('base64')}$${derived.toString('base64')}`;
}

export function checkPassword(password: string, stored: string): boolean {
  const [scheme, n, r, p, salt, expected] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !expected) return false;
  const want = Buffer.from(expected, 'base64');
  const derived = scryptSync(password, Buffer.from(salt, 'base64'), want.length, {
    N: 1 << Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: 64 * 1024 * 1024,
  });
  return derived.length === want.length && timingSafeEqual(derived, want);
}

export class TeamError extends Error {}

export interface TeamMember {
  id: string;
  name: string;
  login: string;
  color: string;
  createdAt: number;
  lastSeen: number | null;
}

const LOGIN = /^[a-z0-9._-]{2,40}$/i;

function validate(input: { name?: unknown; login?: unknown; password?: unknown }) {
  const name = String(input.name ?? '').trim().slice(0, 80);
  const login = String(input.login ?? '').trim();
  const password = String(input.password ?? '');
  if (!name) throw new TeamError('Bitte einen Namen angeben.');
  if (!LOGIN.test(login)) throw new TeamError('Der Benutzername darf Buchstaben, Ziffern, Punkt, Binde- und Unterstrich enthalten (2–40 Zeichen).');
  if (password.length < 10) throw new TeamError('Das Passwort muss mindestens 10 Zeichen lang sein.');
  return { name, login, password };
}

/**
 * Team der Cloud: Einladungen, Konten mit Passwort, Zurücksetzen. Ein Mitglied ist eine Zeile in
 * share_members mit team_role 'member'; deren Token öffnet wie bei Gästen die Web-Oberfläche.
 */
export class Team {
  constructor(private store: Store) {
    store.raw.exec(SCHEMA);
  }

  createInvite(): { code: string; expiresAt: number } {
    const code = randomBytes(16).toString('hex');
    const now = Date.now();
    this.store.raw.prepare('DELETE FROM team_invites WHERE expires_at < ?').run(now);
    this.store.raw.prepare('INSERT INTO team_invites (code_hash, expires_at, created_at) VALUES (?, ?, ?)').run(hash(code), now + INVITE_MS, now);
    return { code, expiresAt: now + INVITE_MS };
  }

  inviteValid(code: string): boolean {
    if (!/^[0-9a-f]{32}$/.test(code)) return false;
    return Boolean(this.store.raw.prepare('SELECT 1 FROM team_invites WHERE code_hash = ? AND expires_at >= ?').get(hash(code), Date.now()));
  }

  /** Einladung einlösen: legt das Mitglied an und liefert seinen Zugang für die Web-Oberfläche. */
  async join(code: string, input: { name?: unknown; login?: unknown; password?: unknown }): Promise<{ memberId: string; token: string }> {
    const { name, login, password } = validate(input);
    if (!this.inviteValid(code)) throw new TeamError('Diese Einladung ist ungültig oder abgelaufen.');
    if (this.store.raw.prepare('SELECT 1 FROM team_accounts WHERE login = ?').get(login)) throw new TeamError('Dieser Benutzername ist schon vergeben.');
    const passwordHash = hashPassword(password);
    const memberId = randomUUID();
    const token = randomBytes(32).toString('hex');
    const count = (this.store.raw.prepare('SELECT count(*) AS n FROM share_members').get() as { n: number }).n;
    const now = Date.now();
    transaction(this.store.raw, () => {
      const used = this.store.raw.prepare('DELETE FROM team_invites WHERE code_hash = ? AND expires_at >= ?').run(hash(code), now);
      if (Number(used.changes) !== 1) throw new TeamError('Diese Einladung ist ungültig oder abgelaufen.');
      this.store.raw
        .prepare("INSERT INTO share_members (id, name, token, color, created_at, kind, team_role) VALUES (?, ?, ?, ?, ?, 'person', 'member')")
        .run(memberId, name, token, MEMBER_COLORS[Number(count) % MEMBER_COLORS.length], now);
      this.store.raw.prepare('INSERT INTO team_accounts (member_id, login, password_hash, created_at) VALUES (?, ?, ?, ?)').run(memberId, login, passwordHash, now);
    });
    return { memberId, token };
  }

  /** Anmelden mit Benutzername und Passwort. */
  login(login: string, password: string): { memberId: string; token: string } | null {
    const row = this.store.raw
      .prepare(
        "SELECT a.member_id, a.password_hash, m.token FROM team_accounts a JOIN share_members m ON m.id = a.member_id WHERE a.login = ? AND m.team_role = 'member'",
      )
      .get(String(login).trim()) as { member_id: string; password_hash: string; token: string } | undefined;
    if (!row || !checkPassword(String(password), row.password_hash)) return null;
    return { memberId: row.member_id, token: row.token };
  }

  createReset(memberId: string): { code: string; expiresAt: number } {
    if (!this.store.raw.prepare('SELECT 1 FROM team_accounts WHERE member_id = ?').get(memberId)) throw new TeamError('Mitglied nicht gefunden.');
    const code = randomBytes(16).toString('hex');
    const now = Date.now();
    this.store.raw.prepare('DELETE FROM team_resets WHERE expires_at < ? OR member_id = ?').run(now, memberId);
    this.store.raw.prepare('INSERT INTO team_resets (code_hash, member_id, expires_at) VALUES (?, ?, ?)').run(hash(code), memberId, now + RESET_MS);
    return { code, expiresAt: now + RESET_MS };
  }

  resetPassword(code: string, password: string): void {
    if (password.length < 10) throw new TeamError('Das Passwort muss mindestens 10 Zeichen lang sein.');
    const row = /^[0-9a-f]{32}$/.test(code)
      ? (this.store.raw.prepare('SELECT member_id FROM team_resets WHERE code_hash = ? AND expires_at >= ?').get(hash(code), Date.now()) as
          | { member_id: string }
          | undefined)
      : undefined;
    if (!row) throw new TeamError('Dieser Link ist ungültig oder abgelaufen.');
    this.store.raw.prepare('UPDATE team_accounts SET password_hash = ? WHERE member_id = ?').run(hashPassword(password), row.member_id);
    this.store.raw.prepare('DELETE FROM team_resets WHERE member_id = ?').run(row.member_id);
  }

  list(): TeamMember[] {
    const rows = this.store.raw
      .prepare(
        `SELECT m.id, m.name, m.color, m.created_at, a.login,
                (SELECT max(last_seen) FROM cloud_devices d WHERE d.member_id = m.id) AS last_seen
         FROM share_members m JOIN team_accounts a ON a.member_id = m.id
         WHERE m.team_role = 'member' ORDER BY m.created_at`,
      )
      .all() as { id: string; name: string; color: string; created_at: number; login: string; last_seen: number | null }[];
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      login: r.login,
      color: r.color,
      createdAt: Number(r.created_at),
      lastSeen: r.last_seen === null ? null : Number(r.last_seen),
    }));
  }

  /** Mitglied entfernen: Zugang, Geräte und Sitzungen sind sofort weg. */
  remove(memberId: string): boolean {
    let removed = false;
    transaction(this.store.raw, () => {
      removed = Number(this.store.raw.prepare("DELETE FROM share_members WHERE id = ? AND team_role = 'member'").run(memberId).changes) > 0;
      this.cleanup();
    });
    return removed;
  }

  /** Konten und Geräte von Mitgliedern löschen, die es nicht mehr gibt (z. B. in der App entfernt). */
  cleanup(): void {
    this.store.raw.exec(`
      DELETE FROM team_accounts WHERE member_id NOT IN (SELECT id FROM share_members WHERE team_role = 'member');
      DELETE FROM team_resets WHERE member_id NOT IN (SELECT member_id FROM team_accounts);
      DELETE FROM cloud_devices WHERE member_id IS NOT NULL AND member_id NOT IN (SELECT member_id FROM team_accounts);
    `);
  }
}
