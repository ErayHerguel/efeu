// Packt die gebaute Web-Oberfläche (dist/) als tar.gz für den Cloud-Server (dist-server/efeu-web.tar.gz).
// Eigenes Skript statt `tar`, damit es unter macOS und Windows gleich funktioniert (ohne Mac-Metadaten).
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const root = fileURLToPath(new URL('..', import.meta.url));
const source = join(root, 'dist');
const target = join(root, 'dist-server', 'efeu-web.tar.gz');

function files(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? files(path) : [path];
  });
}

function header(name, size) {
  const block = Buffer.alloc(512);
  if (Buffer.byteLength(name) > 100) throw new Error(`Pfad zu lang für tar: ${name}`);
  block.write(name, 0);
  block.write('0000644\0', 100);
  block.write('0000000\0', 108);
  block.write('0000000\0', 116);
  block.write(`${size.toString(8).padStart(11, '0')}\0`, 124);
  block.write('00000000000\0', 136);
  block.write('        ', 148);
  block.write('0', 156);
  block.write('ustar\0', 257);
  block.write('00', 263);
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
  return block;
}

const parts = [];
for (const path of files(source).sort()) {
  const name = relative(source, path).split('\\').join('/');
  const data = readFileSync(path);
  parts.push(header(name, statSync(path).size), data, Buffer.alloc((512 - (data.length % 512)) % 512));
}
parts.push(Buffer.alloc(1024));
writeFileSync(target, gzipSync(Buffer.concat(parts), { level: 9 }));
console.log(`Web-Oberfläche gepackt: ${relative(root, target)}`);
