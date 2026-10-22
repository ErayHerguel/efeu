import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { assetPath, assetStream, listAssets, MIME, storeAsset } from './assets';
import type { Cloud } from './cloud';
import type { Device, Devices } from './devices';
import type { Sharing } from './share';
import { applyUpdate } from './update';
import { TeamError, type Team } from './team';
import type { Mentions } from './mentions';
import { HOST_COLOR } from '../src/features/collab/host/hosting';
import { teamVisible, visibleAssets } from './scope';
import type { Store } from './store';

declare const __EFEU_VERSION__: string;
export const VERSION = typeof __EFEU_VERSION__ === 'string' ? __EFEU_VERSION__ : 'dev';

const JSON_LIMIT = 32 * 1024 * 1024;
const ASSET_LIMIT = 200 * 1024 * 1024;
const UPDATE_LIMIT = 64 * 1024 * 1024;

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new HttpError(413, 'Zu groß'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson<T>(req: IncomingMessage): Promise<T> {
  try {
    return JSON.parse((await readBody(req, JSON_LIMIT)).toString('utf8')) as T;
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(400, 'Ungültige Anfrage');
  }
}

function send(res: ServerResponse, status: number, body: unknown) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(text);
}

const bearer = (req: IncomingMessage): string | null => {
  const header = req.headers.authorization ?? '';
  return header.startsWith('Bearer ') ? header.slice(7).trim() : null;
};

/** Einfache Bremse gegen das Durchprobieren von Kopplungscodes (je Adresse). */
class Limiter {
  private hits = new Map<string, number[]>();
  constructor(private max: number, private windowMs: number) {}
  allow(key: string): boolean {
    const now = Date.now();
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    recent.push(now);
    this.hits.set(key, recent);
    if (this.hits.size > 10_000) this.hits.clear();
    return recent.length <= this.max;
  }
}

const STATUS_PAGE = `<!doctype html><html lang="de"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>efeu Cloud</title><style>body{font:16px/1.6 -apple-system,system-ui,sans-serif;max-width:520px;margin:15vh auto;padding:0 20px;color:#23231f}
@media(prefers-color-scheme:dark){body{background:#191919;color:#e8e7e3}}</style>
<h1>efeu Cloud läuft</h1><p>Dieser Server gehört zu einer efeu-App. Verbinden lässt er sich in efeu unter Einstellungen → Eigene Cloud.</p></html>`;

export interface Context {
  store: Store;
  cloud: Cloud;
  devices: Devices;
  sharing?: Sharing;
  team?: Team;
  /** Nach Änderungen am Team (Beitritt, Entfernen): Ansichten und Protokoll nachführen */
  teamChanged?: () => void;
  mentions?: Mentions;
}

/** HTTP-Schnittstelle der Cloud. Läuft hinter einem HTTPS-Proxy (Caddy) oder im Heimnetz. */
export function createApp({ store, cloud, devices, sharing, team, teamChanged = () => undefined, mentions }: Context): Server {
  const pairLimiter = new Limiter(10, 60_000);
  const loginLimiter = new Limiter(10, 5 * 60_000);
  const limit = (req: IncomingMessage, limiter: Limiter) => {
    if (!limiter.allow(req.socket.remoteAddress ?? '')) throw new HttpError(429, 'Zu viele Versuche, bitte kurz warten');
  };
  /** Zugang für das Team: Web-Token und, für efeu auf einem Computer, ein eigener Geräteschlüssel */
  const teamAccess = (memberId: string, token: string, deviceName: unknown) => {
    const device = typeof deviceName === 'string' && deviceName.trim() ? devices.add(deviceName, memberId) : null;
    return { memberId, token, deviceToken: device?.token ?? null, deviceId: device?.device.id ?? null };
  };

  const auth = (req: IncomingMessage): Device => {
    const device = devices.verify(bearer(req));
    if (!device) throw new HttpError(401, 'Kein Zugang');
    return device;
  };

  async function route(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    const method = req.method ?? 'GET';

    // Gäste und eigene Geräte im Browser (Einladungslinks).
    if (sharing && (await sharing.handle(req, res, path, method))) return;
    if (method === 'GET' && path === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(STATUS_PAGE);
      return;
    }
    if (method === 'GET' && path === '/api/status') {
      return send(res, 200, { app: 'efeu', version: VERSION, devices: devices.list().length });
    }

    if (method === 'POST' && path === '/api/pair') {
      const ip = req.socket.remoteAddress ?? '';
      if (!pairLimiter.allow(ip)) throw new HttpError(429, 'Zu viele Versuche, bitte kurz warten');
      const body = await readJson<{ code?: unknown; name?: unknown }>(req);
      const result = devices.redeem(String(body.code ?? ''), String(body.name ?? 'Gerät'));
      if (!result) throw new HttpError(403, 'Der Code ist ungültig oder abgelaufen');
      return send(res, 200, { token: result.token, device: result.device });
    }

    if (team && method === 'POST' && path === '/api/team/join') {
      limit(req, loginLimiter);
      const body = await readJson<Record<string, unknown>>(req);
      try {
        const { memberId, token } = await team.join(String(body.code ?? ''), body);
        teamChanged();
        return send(res, 200, teamAccess(memberId, token, body.device));
      } catch (err) {
        if (err instanceof TeamError) throw new HttpError(400, err.message);
        throw err;
      }
    }
    if (team && method === 'POST' && path === '/api/team/login') {
      limit(req, loginLimiter);
      const body = await readJson<Record<string, unknown>>(req);
      const found = team.login(String(body.login ?? ''), String(body.password ?? ''));
      if (!found) {
        await new Promise((r) => setTimeout(r, 400));
        throw new HttpError(401, 'Benutzername oder Passwort stimmt nicht.');
      }
      return send(res, 200, teamAccess(found.memberId, found.token, body.device));
    }
    if (team && method === 'POST' && path === '/api/team/reset') {
      limit(req, loginLimiter);
      const body = await readJson<Record<string, unknown>>(req);
      try {
        team.resetPassword(String(body.code ?? ''), String(body.password ?? ''));
      } catch (err) {
        if (err instanceof TeamError) throw new HttpError(400, err.message);
        throw err;
      }
      return send(res, 200, { ok: true });
    }
    const invite = /^\/api\/team\/invite\/([0-9a-f]{32})$/.exec(path);
    if (team && invite && method === 'GET') return send(res, 200, { valid: team.inviteValid(invite[1]) });

    const device = auth(req);
    /** Nur Geräte des Inhabers (nicht die von Team-Mitgliedern) */
    const owner = () => {
      if (device.memberId) throw new HttpError(403, 'Nur für den Inhaber der Cloud');
    };

    if (method === 'GET' && path === '/api/me') return send(res, 200, { device, version: VERSION });

    if (method === 'POST' && path === '/api/sync/push') {
      const body = await readJson<{ changes?: unknown }>(req);
      if (!Array.isArray(body.changes)) throw new HttpError(400, 'changes fehlt');
      const seq = await cloud.push(device.id, body.changes, device.memberId);
      return send(res, 200, { seq });
    }
    if (method === 'GET' && path === '/api/sync/pull') {
      const since = Number(url.searchParams.get('since') ?? 0);
      if (!Number.isSafeInteger(since) || since < 0) throw new HttpError(400, 'since ungültig');
      return send(res, 200, await cloud.pullFor(device, since));
    }
    if (method === 'GET' && path === '/api/sync/events') {
      // Server-Sent Events: meldet neue Änderungen, das Gerät holt sie dann per pull ab.
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', 'x-accel-buffering': 'no' });
      res.write(`event: changed\ndata: ${cloud.latest()}\n\n`);
      const off = cloud.onChange((seq) => res.write(`event: changed\ndata: ${seq}\n\n`));
      // Neue Erwähnung für die Person dieses Geräts
      const offNotify = mentions?.onNotify((memberId) => {
        if (memberId === (device.memberId ?? 'owner')) res.write('event: notify\ndata: 1\n\n');
      });
      const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
      req.on('close', () => {
        off();
        offNotify?.();
        clearInterval(ping);
      });
      return;
    }

    // Team-Geräte bekommen nur Dateien, auf die Seiten im Team-Bereich verweisen.
    const allowedAssets = () => (device.memberId ? visibleAssets(store, teamVisible(store)) : null);
    if (method === 'GET' && path === '/api/assets') {
      const allowed = allowedAssets();
      return send(res, 200, { names: listAssets(store.assets).filter((n) => !allowed || allowed.has(n)) });
    }
    const asset = /^\/api\/assets\/([^/]+)$/.exec(path);
    if (asset) {
      const name = decodeURIComponent(asset[1]);
      if (method === 'PUT') {
        const bytes = await readBody(req, ASSET_LIMIT);
        if (!storeAsset(store.assets, name, bytes)) throw new HttpError(400, 'Datei passt nicht zum Namen');
        return send(res, 200, { ok: true });
      }
      if (method === 'GET') {
        const allowed = allowedAssets();
        if (allowed && !allowed.has(name)) throw new HttpError(404, 'Nicht gefunden');
        const file = assetPath(store.assets, name);
        if (!file) throw new HttpError(404, 'Nicht gefunden');
        const { size, stream } = assetStream(file);
        const ext = name.slice(name.lastIndexOf('.') + 1);
        res.writeHead(200, {
          'content-type': MIME[ext] ?? 'application/octet-stream',
          'content-length': size,
          'cache-control': 'private, max-age=31536000, immutable',
          'x-content-type-options': 'nosniff',
          'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
        });
        stream.pipe(res);
        return;
      }
    }

    if (method === 'GET' && path === '/api/team/people') {
      // Für @-Erwähnungen: der Inhaber und die Team-Mitglieder (ohne Zugangsdaten)
      const members = store.raw.prepare("SELECT id, name, color FROM share_members WHERE team_role = 'member' ORDER BY created_at").all() as {
        id: string;
        name: string;
        color: string;
      }[];
      return send(res, 200, { people: [{ id: 'owner', name: cloud.editorName(null), color: HOST_COLOR }, ...members], me: device.memberId ?? 'owner' });
    }
    if (mentions && method === 'GET' && path === '/api/notifications') {
      return send(res, 200, { notifications: mentions.list(device.memberId ?? 'owner') });
    }
    if (mentions && method === 'POST' && path === '/api/notifications/read') {
      const body = await readJson<{ ids?: unknown }>(req);
      const ids = Array.isArray(body.ids) ? body.ids.filter((n): n is number => Number.isInteger(n)) : 'all';
      mentions.markRead(device.memberId ?? 'owner', ids);
      return send(res, 200, { ok: true });
    }
    if (team && path === '/api/team/members' && method === 'GET') {
      owner();
      return send(res, 200, { members: team.list() });
    }
    if (team && path === '/api/team/invites' && method === 'POST') {
      owner();
      return send(res, 200, team.createInvite());
    }
    const member = /^\/api\/team\/members\/([0-9a-f-]{36})(\/reset)?$/.exec(path);
    if (team && member) {
      owner();
      if (method === 'DELETE' && !member[2]) {
        if (!team.remove(member[1])) throw new HttpError(404, 'Mitglied nicht gefunden');
        teamChanged();
        return send(res, 200, { ok: true });
      }
      if (method === 'POST' && member[2]) {
        try {
          return send(res, 200, team.createReset(member[1]));
        } catch (err) {
          if (err instanceof TeamError) throw new HttpError(404, err.message);
          throw err;
        }
      }
    }

    if (method === 'POST' && path === '/api/admin/update') {
      owner();
      // Neue Server-Version aus der App (signiert); danach Neustart durch systemd.
      const body = JSON.parse((await readBody(req, UPDATE_LIMIT)).toString('utf8')) as Record<string, unknown>;
      const text = (key: string) => (typeof body[key] === 'string' ? (body[key] as string) : '');
      try {
        applyUpdate({
          server: Buffer.from(text('server'), 'base64'),
          serverSig: text('serverSig'),
          web: Buffer.from(text('web'), 'base64'),
          webSig: text('webSig'),
        });
      } catch (err) {
        throw new HttpError(400, err instanceof Error ? err.message : 'Update fehlgeschlagen');
      }
      send(res, 200, { ok: true });
      console.log('Update eingespielt, Neustart');
      setTimeout(() => process.exit(0), 300);
      return;
    }

    if (method === 'GET' && path === '/api/devices') {
      owner();
      return send(res, 200, { devices: devices.list(), me: device.id });
    }
    if (method === 'POST' && path === '/api/pairing') {
      owner();
      return send(res, 200, devices.pairingCode());
    }
    const one = /^\/api\/devices\/([0-9a-f-]{36})$/.exec(path);
    if (one) owner();
    if (one && method === 'DELETE') {
      if (!devices.remove(one[1])) throw new HttpError(404, 'Gerät nicht gefunden');
      return send(res, 200, { ok: true });
    }
    if (one && method === 'PATCH') {
      const body = await readJson<{ name?: unknown }>(req);
      if (!devices.rename(one[1], String(body.name ?? ''))) throw new HttpError(400, 'Name fehlt');
      return send(res, 200, { ok: true });
    }

    throw new HttpError(404, 'Nicht gefunden');
  }

  const server = createServer((req, res) => {
    route(req, res).catch((err: unknown) => {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) console.error(err);
      if (!res.headersSent) send(res, status, { error: err instanceof HttpError ? err.message : 'Interner Fehler' });
      else res.end();
    });
  });
  server.on('upgrade', (req, socket, head) => {
    if (sharing && new URL(req.url ?? '/', 'http://localhost').pathname === '/api/ws') sharing.upgrade(req, socket, head);
    else socket.destroy();
  });
  return server;
}
