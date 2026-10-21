import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { extname, join, normalize } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { registerVirtualMember, type HubTransport } from '../src/features/collab/host/hub';
import { HOST_COLOR } from '../src/features/collab/host/hosting';
import type { Devices } from './devices';
import { assetPath, assetStream, fileExt, imageExt, MIME, storeBytes } from './assets';
import type { Store } from './store';

const COOKIE = 'efeu_session';
const MAX_UPLOAD = 100 * 1024 * 1024;
const MAX_MESSAGE = 16 * 1024 * 1024;

const STATIC_MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.webmanifest': 'application/manifest+json',
  '.wasm': 'application/wasm',
};

const hostOf = (req: IncomingMessage) => String(req.headers['x-forwarded-host'] ?? req.headers.host ?? '');
const isLocal = (host: string) => /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host);

function guestCsp(host: string): string {
  return (
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; " +
    `media-src 'self' blob:; font-src 'self' data:; connect-src 'self' wss://${host} ws://${host}; ` +
    "worker-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'"
  );
}

function reply(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('Zu groß'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * Teilen über die Cloud: dieselbe Web-Oberfläche und dasselbe Protokoll wie beim Teilen über den Mac
 * (src-tauri/src/share/server.rs), nur dass hier der Server Gastgeber ist und immer erreichbar bleibt.
 * Anmeldung mit dem geheimen Teil des Einladungslinks, danach Sitzungs-Cookie.
 */
export class Sharing {
  private sessions = new Map<string, string>();
  private sockets = new Map<number, { memberId: string; ws: WebSocket }>();
  private nextConn = 1;
  private wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE });
  private handlers: Parameters<HubTransport['listen']>[0] | null = null;
  private index: string | null = null;

  constructor(
    private store: Store,
    private webDir: string | null,
    private devices?: Devices,
  ) {
    const indexPath = webDir && join(webDir, 'index.html');
    if (indexPath && existsSync(indexPath)) {
      // Markiert die Seite als Gast-Oberfläche (siehe src/lib/mode.ts).
      this.index = readFileSync(indexPath, 'utf8').replace('<head>', '<head><meta name="efeu-mode" content="guest">');
    }
  }

  get hasWebApp(): boolean {
    return this.index !== null;
  }

  transport(): Omit<HubTransport, 'loadDoc'> {
    return {
      host: false,
      send: (targets, data) => {
        for (const conn of targets) {
          const socket = this.sockets.get(conn);
          if (socket && socket.ws.readyState === socket.ws.OPEN) socket.ws.send(data);
        }
      },
      listen: async (handlers) => {
        this.handlers = handlers;
        return () => {
          this.handlers = null;
        };
      },
    };
  }

  private member(id: string): { id: string; kind: string } | undefined {
    return this.store.raw.prepare('SELECT id, kind FROM share_members WHERE id = ?').get(id) as { id: string; kind: string } | undefined;
  }

  private sessionMember(req: IncomingMessage): string | null {
    const cookies = String(req.headers.cookie ?? '');
    for (const part of cookies.split(';')) {
      const [key, value] = part.trim().split('=');
      if (key === COOKIE && value) return this.sessions.get(value) ?? null;
    }
    return null;
  }

  /** Verbindungen von Personen schließen, deren Zugang entfernt wurde. */
  dropRemoved() {
    for (const socket of this.sockets.values()) {
      if (!socket.memberId.startsWith('owner-') && !this.member(socket.memberId)) socket.ws.close();
    }
    for (const [session, memberId] of this.sessions) if (!this.member(memberId)) this.sessions.delete(session);
  }

  /** Bearbeitet die Anfragen der Gast-Oberfläche; liefert false, wenn die Anfrage nicht dazugehört. */
  async handle(req: IncomingMessage, res: ServerResponse, path: string, method: string): Promise<boolean> {
    if (path === '/api/ping') {
      res.writeHead(200, { 'access-control-allow-origin': '*', 'cache-control': 'no-store' });
      res.end('efeu');
      return true;
    }
    if (path === '/api/session' && method === 'POST') {
      const body = JSON.parse((await readBody(req, 4096)).toString('utf8') || '{}') as { token?: unknown };
      const token = String(body.token ?? '').trim();
      const row = /^[0-9a-f]{64}$/.test(token)
        ? (this.store.raw.prepare('SELECT id, name, color FROM share_members WHERE token = ?').get(token) as
            | { id: string; name: string; color: string }
            | undefined)
        : undefined;
      if (!row) {
        // Gegen Durchprobieren: Fehlversuche bremsen.
        await new Promise((r) => setTimeout(r, 400));
        res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Dieser Einladungslink ist nicht (mehr) gültig');
        return true;
      }
      const session = randomBytes(32).toString('hex');
      this.sessions.set(session, row.id);
      const secure = isLocal(hostOf(req)) ? '' : '; Secure';
      reply(res, 200, { memberId: row.id, name: row.name, color: row.color }, { 'set-cookie': `${COOKIE}=${session}; Path=/; HttpOnly; SameSite=Strict${secure}` });
      return true;
    }
    if (path === '/api/upload' && method === 'POST') {
      const memberId = this.sessionMember(req);
      if (!memberId) {
        reply(res, 401, 'Nicht angemeldet');
        return true;
      }
      // Eigene Geräte dürfen alles, Gäste brauchen irgendwo Schreibrecht.
      const { n } = this.store.raw
        .prepare(
          "SELECT (SELECT count(*) FROM share_members WHERE id = ?1 AND kind = 'device') + (SELECT count(*) FROM share_grants WHERE member_id = ?1 AND role = 'edit') AS n",
        )
        .get(memberId) as { n: number };
      if (!Number(n)) {
        reply(res, 403, 'Nur mit Schreibrecht');
        return true;
      }
      const url = new URL(req.url ?? '/', 'http://localhost');
      const bytes = await readBody(req, MAX_UPLOAD);
      try {
        if (url.searchParams.get('kind') === 'image') {
          const ext = imageExt(url.searchParams.get('ext') ?? '');
          if (!ext) throw new Error('Dateityp wird nicht unterstützt');
          reply(res, 200, { name: storeBytes(this.store.assets, bytes, ext) });
        } else if (url.searchParams.get('kind') === 'file') {
          const name = storeBytes(this.store.assets, bytes, fileExt(url.searchParams.get('name') ?? ''));
          reply(res, 200, { src: name, size: bytes.length });
        } else throw new Error('Unbekannte Art');
      } catch (err) {
        res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(err instanceof Error ? err.message : 'Fehler');
      }
      return true;
    }
    const file = /^\/files\/([^/]+)$/.exec(path);
    if (file && method === 'GET') {
      if (!this.sessionMember(req)) {
        reply(res, 401, 'Nicht angemeldet');
        return true;
      }
      const name = decodeURIComponent(file[1]);
      const found = assetPath(this.store.assets, name);
      if (!found) {
        reply(res, 404, 'Nicht gefunden');
        return true;
      }
      const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
      const mime = MIME[ext] ?? 'application/octet-stream';
      const inline = /^(image|video|audio)\//.test(mime);
      const { size, stream } = assetStream(found);
      res.writeHead(200, {
        'content-type': mime,
        'content-length': size,
        'cache-control': 'private, max-age=31536000, immutable',
        'x-content-type-options': 'nosniff',
        // Hochgeladene Dateien (z. B. SVG) dürfen nie als Teil der App Skripte ausführen.
        'content-security-policy': "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox",
        ...(inline ? {} : { 'content-disposition': 'attachment' }),
      });
      stream.pipe(res);
      return true;
    }
    if (method === 'GET' && this.index && !path.startsWith('/api/')) {
      this.serveStatic(req, res, path);
      return true;
    }
    return false;
  }

  /** Die Web-Oberfläche; unbekannte Pfade liefern die Startseite. */
  private serveStatic(req: IncomingMessage, res: ServerResponse, path: string) {
    const headers: Record<string, string> = {
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'content-security-policy': guestCsp(hostOf(req) || 'localhost'),
    };
    const relative = normalize(decodeURIComponent(path)).replace(/^([/\\])+/, '');
    const target = this.webDir && relative && !relative.startsWith('..') ? join(this.webDir, relative) : null;
    if (target && relative !== 'index.html' && existsSync(target) && statSync(target).isFile()) {
      res.writeHead(200, {
        ...headers,
        'content-type': STATIC_MIME[extname(target)] ?? 'application/octet-stream',
        'cache-control': relative.startsWith('assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
      });
      res.end(readFileSync(target));
      return;
    }
    res.writeHead(200, { ...headers, 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
    res.end(this.index);
  }

  /** WebSocket der Gast-Oberfläche. */
  upgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
    const deny = (status: string) => {
      socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
      socket.destroy();
    };
    // Schutz vor fremden Seiten, die im Namen eines angemeldeten Gastes eine Verbindung öffnen.
    const origin = String(req.headers.origin ?? '');
    if (origin.replace(/^https?:\/\//, '') !== hostOf(req)) return deny('403 Forbidden');
    let memberId = this.sessionMember(req);
    // Die efeu-App meldet sich mit ihrem Geräteschlüssel an: als Team-Mitglied oder als Inhaber.
    const bearer = String(req.headers.authorization ?? '');
    if (!memberId && bearer.startsWith('Bearer ') && this.devices) {
      const device = this.devices.verify(bearer.slice(7).trim());
      if (device?.memberId) memberId = device.memberId;
      else if (device) {
        const name = new URL(req.url ?? '/', 'http://localhost').searchParams.get('name')?.trim().slice(0, 80) || device.name;
        memberId = `owner-${device.id}`;
        registerVirtualMember({ id: memberId, name, token: '', color: HOST_COLOR, createdAt: device.createdAt, kind: 'device', teamRole: null });
      }
    }
    if (!memberId) return deny('401 Unauthorized');
    if (!memberId.startsWith('owner-') && !this.member(memberId)) return deny('401 Unauthorized');
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      const conn = this.nextConn++;
      this.sockets.set(conn, { memberId, ws });
      this.handlers?.open(conn, memberId);
      const ping = setInterval(() => ws.readyState === ws.OPEN && ws.ping(), 25_000);
      ws.on('message', (data, binary) => {
        if (!binary) this.handlers?.message(conn, memberId, data.toString());
      });
      ws.on('close', () => {
        clearInterval(ping);
        this.sockets.delete(conn);
        this.handlers?.close(conn);
      });
      ws.on('error', () => ws.close());
    });
  }
}
