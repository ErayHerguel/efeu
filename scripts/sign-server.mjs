// Signiert Server-Datei und Web-Oberfläche mit dem Release-Schlüssel (nur im Release-Build, wenn
// TAURI_SIGNING_PRIVATE_KEY gesetzt ist). Ohne Schlüssel entstehen leere Signaturen: Solche Builds
// können eine eingerichtete Cloud nicht aktualisieren, das ist gewollt.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = fileURLToPath(new URL('../dist-server/', import.meta.url));
for (const name of ['efeu-server.mjs', 'efeu-web.tar.gz']) {
  const file = join(dir, name);
  if (process.env.TAURI_SIGNING_PRIVATE_KEY) {
    execFileSync('npx', ['tauri', 'signer', 'sign', file], { stdio: 'inherit', shell: process.platform === 'win32' });
  } else {
    writeFileSync(`${file}.sig`, '');
  }
}
console.log(process.env.TAURI_SIGNING_PRIVATE_KEY ? 'Server-Dateien signiert' : 'Server-Dateien ohne Signatur (kein Release-Schlüssel)');
