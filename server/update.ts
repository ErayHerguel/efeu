import { execFileSync } from 'node:child_process';
import { accessSync, constants, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifySignature } from './verify';

export interface UpdatePackage {
  server: Buffer;
  serverSig: string;
  web: Buffer;
  webSig: string;
}

/** Ordner, in dem die laufende Server-Datei liegt (bei der Einrichtung /opt/efeu). */
const installDir = () => dirname(fileURLToPath(import.meta.url));

/**
 * Spielt eine neue Server-Version ein, die die App mitbringt. Beide Dateien müssen mit dem Schlüssel
 * der efeu-Releases signiert sein. Danach beendet sich der Server; systemd startet ihn neu.
 */
export function applyUpdate(pkg: UpdatePackage, publicKey?: string): void {
  if (!verifySignature(pkg.server, pkg.serverSig, publicKey) || !verifySignature(pkg.web, pkg.webSig, publicKey)) {
    throw new Error('Die Signatur des Updates stimmt nicht');
  }
  const dir = installDir();
  try {
    accessSync(dir, constants.W_OK);
  } catch {
    throw new Error('Dieser Server aktualisiert sich nicht selbst (z. B. im Container). Bitte das Image aktualisieren.');
  }
  const archive = join(dir, '.efeu-web.tar.gz');
  const fresh = join(dir, 'web.neu');
  writeFileSync(archive, pkg.web);
  rmSync(fresh, { recursive: true, force: true });
  mkdirSync(fresh);
  try {
    execFileSync('tar', ['-xzf', archive, '-C', fresh]);
  } finally {
    rmSync(archive, { force: true });
  }
  const serverTmp = join(dir, '.efeu-server.mjs.neu');
  writeFileSync(serverTmp, pkg.server);
  rmSync(join(dir, 'web.alt'), { recursive: true, force: true });
  try {
    renameSync(join(dir, 'web'), join(dir, 'web.alt'));
  } catch {
    // Noch keine Web-Oberfläche vorhanden
  }
  renameSync(fresh, join(dir, 'web'));
  renameSync(serverTmp, join(dir, 'efeu-server.mjs'));
  rmSync(join(dir, 'web.alt'), { recursive: true, force: true });
}
