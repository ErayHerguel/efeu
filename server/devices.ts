import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Store } from './store';

export interface Device {
  id: string;
  name: string;
  createdAt: number;
  lastSeen: number | null;
}

const hash = (secret: string) => createHash('sha256').update(secret).digest('hex');

/** Wie lange ein Kopplungscode gilt. */
export const PAIRING_MS = 10 * 60 * 1000;

/**
 * Geräte mit Zugang zur Cloud. Jedes Gerät hat einen eigenen Schlüssel (256 Bit), gespeichert wird
 * nur dessen Hash. Ein entferntes Gerät kommt sofort nicht mehr hinein.
 */
export class Devices {
  constructor(private store: Store) {}

  /** Neues Gerät anlegen; der Schlüssel wird nur dieses eine Mal herausgegeben. */
  add(name: string): { device: Device; token: string } {
    const token = randomBytes(32).toString('hex');
    const device: Device = { id: randomUUID(), name: name.trim().slice(0, 80) || 'Gerät', createdAt: Date.now(), lastSeen: null };
    this.store.raw
      .prepare('INSERT INTO cloud_devices (id, name, token_hash, created_at) VALUES (?, ?, ?, ?)')
      .run(device.id, device.name, hash(token), device.createdAt);
    return { device, token };
  }

  /** Gerät zum Schlüssel, oder null. */
  verify(token: string | null): Device | null {
    if (!token || !/^[0-9a-f]{64}$/.test(token)) return null;
    const row = this.store.raw
      .prepare('SELECT id, name, created_at, last_seen FROM cloud_devices WHERE token_hash = ?')
      .get(hash(token)) as { id: string; name: string; created_at: number; last_seen: number | null } | undefined;
    if (!row) return null;
    const now = Date.now();
    // Zuletzt gesehen höchstens minütlich schreiben.
    if (!row.last_seen || now - Number(row.last_seen) > 60_000) {
      this.store.raw.prepare('UPDATE cloud_devices SET last_seen = ? WHERE id = ?').run(now, row.id);
    }
    return { id: row.id, name: row.name, createdAt: Number(row.created_at), lastSeen: now };
  }

  list(): Device[] {
    const rows = this.store.raw.prepare('SELECT id, name, created_at, last_seen FROM cloud_devices ORDER BY created_at').all() as {
      id: string;
      name: string;
      created_at: number;
      last_seen: number | null;
    }[];
    return rows.map((r) => ({ id: r.id, name: r.name, createdAt: Number(r.created_at), lastSeen: r.last_seen === null ? null : Number(r.last_seen) }));
  }

  remove(id: string): boolean {
    return Number(this.store.raw.prepare('DELETE FROM cloud_devices WHERE id = ?').run(id).changes) > 0;
  }

  rename(id: string, name: string): boolean {
    const clean = name.trim().slice(0, 80);
    if (!clean) return false;
    return Number(this.store.raw.prepare('UPDATE cloud_devices SET name = ? WHERE id = ?').run(clean, id).changes) > 0;
  }

  /** Einmaliger Code, mit dem sich ein weiteres Gerät anmeldet (z. B. per QR-Code). */
  pairingCode(): { code: string; expiresAt: number } {
    const code = randomBytes(16).toString('hex');
    const expiresAt = Date.now() + PAIRING_MS;
    this.store.raw.prepare('DELETE FROM cloud_pairing WHERE expires_at < ?').run(Date.now());
    this.store.raw.prepare('INSERT INTO cloud_pairing (code_hash, expires_at) VALUES (?, ?)').run(hash(code), expiresAt);
    return { code, expiresAt };
  }

  /** Löst einen Kopplungscode ein. Jeder Code gilt genau einmal. */
  redeem(code: string, name: string): { device: Device; token: string } | null {
    if (!/^[0-9a-f]{32}$/.test(code)) return null;
    const result = this.store.raw
      .prepare('DELETE FROM cloud_pairing WHERE code_hash = ? AND expires_at >= ?')
      .run(hash(code), Date.now());
    if (Number(result.changes) !== 1) return null;
    return this.add(name);
  }
}
