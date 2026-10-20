import type { Driver } from '../db/driver';
import type { Applied, Replica } from './replica';
import type { Change } from './types';

/** Verbindung zur Cloud. In der App läuft sie über Rust (CSP), im Test direkt über fetch. */
export interface Transport {
  push(changes: Change[]): Promise<{ seq: number }>;
  pull(since: number): Promise<{ changes: Change[]; next: number; more: boolean }>;
  listAssets(): Promise<string[]>;
  uploadAsset(name: string): Promise<void>;
  downloadAsset(name: string): Promise<void>;
  /** Namen der lokal vorhandenen Anhänge */
  localAssets(): Promise<string[]>;
}

export type SyncPhase = 'idle' | 'syncing' | 'offline' | 'error';

export interface SyncReport {
  pushed: number;
  pulled: number;
  applied: Applied;
}

const CURSOR = 'cursor';

/**
 * Gleicht eine lokale Kopie mit der Cloud ab: erst eigene Änderungen hochladen, dann Neues abholen,
 * zuletzt fehlende Anhänge in beide Richtungen übertragen. Immer nur ein Durchlauf zur Zeit;
 * Anstöße während eines Durchlaufs führen zu genau einem weiteren.
 */
export class SyncClient {
  private running: Promise<SyncReport> | null = null;
  private again = false;

  constructor(
    private driver: Driver,
    private replica: Replica,
    private transport: Transport,
  ) {}

  async cursor(): Promise<number> {
    const [row] = await this.driver.select<{ value: string }>('SELECT value FROM sync_state WHERE key = ?', [CURSOR]);
    return Number(row?.value ?? 0);
  }

  private setCursor(seq: number) {
    return this.driver.tx([
      { sql: 'INSERT INTO sync_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', params: [CURSOR, String(seq)] },
    ]);
  }

  /** Einen Durchlauf anstoßen (oder an den laufenden anhängen). */
  sync(): Promise<SyncReport> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      const total: SyncReport = { pushed: 0, pulled: 0, applied: { rows: false, docs: new Set(), boards: new Set() } };
      try {
        do {
          this.again = false;
          const report = await this.once();
          total.pushed += report.pushed;
          total.pulled += report.pulled;
          total.applied.rows ||= report.applied.rows;
          for (const p of report.applied.docs) total.applied.docs.add(p);
          for (const p of report.applied.boards) total.applied.boards.add(p);
        } while (this.again);
        return total;
      } finally {
        this.running = null;
      }
    })();
    return this.running;
  }

  private async once(): Promise<SyncReport> {
    const report: SyncReport = { pushed: 0, pulled: 0, applied: { rows: false, docs: new Set(), boards: new Set() } };
    // Anhänge zuerst, damit niemand auf ein Bild verweist, das die Cloud noch nicht hat.
    await this.uploadAssets();
    for (;;) {
      const outbox = await this.replica.collect();
      if (!outbox) break;
      if (outbox.changes.length) await this.transport.push(outbox.changes);
      await this.replica.ack(outbox);
      report.pushed += outbox.changes.length;
    }
    let since = await this.cursor();
    for (;;) {
      const page = await this.transport.pull(since);
      if (page.changes.length) {
        const applied = await this.replica.apply(page.changes);
        report.applied.rows ||= applied.rows;
        for (const p of applied.docs) report.applied.docs.add(p);
        for (const p of applied.boards) report.applied.boards.add(p);
        report.pulled += page.changes.length;
      }
      if (page.next !== since) await this.setCursor(page.next);
      since = page.next;
      if (!page.more) break;
    }
    if (report.pulled) await this.downloadAssets();
    return report;
  }

  private async uploadAssets() {
    const local = await this.transport.localAssets();
    if (!local.length) return;
    const remote = new Set(await this.transport.listAssets());
    for (const name of local) if (!remote.has(name)) await this.transport.uploadAsset(name);
  }

  private async downloadAssets() {
    const local = new Set(await this.transport.localAssets());
    for (const name of await this.transport.listAssets()) if (!local.has(name)) await this.transport.downloadAsset(name);
  }
}
