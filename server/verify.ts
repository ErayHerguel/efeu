import { createHash, createPublicKey, verify } from 'node:crypto';

/**
 * Prüft eine Signatur im Format von `tauri signer sign` (Minisign, Base64-verpackt) gegen einen
 * öffentlichen Schlüssel im selben Format. Damit nimmt der Server nur Updates an, die mit dem
 * Schlüssel der efeu-Releases signiert sind.
 */

/** Öffentlicher Schlüssel der efeu-Releases (derselbe wie für die App-Updates, siehe tauri.conf.json). */
export const RELEASE_KEY =
  'dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEM5QUE3REExOEIzMTRCRUIKUldUclN6R0xvWDJxeWRGSWdIdzZQMWY0TUlEeE9lZ0pIbHIxQWUvNnlHamZ5bVVTcDVrK1BmVy8K';

const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

const lines = (b64: string) =>
  Buffer.from(b64.trim(), 'base64')
    .toString('utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

function publicKey(b64: string): { id: Buffer; key: ReturnType<typeof createPublicKey> } {
  const [, keyLine] = lines(b64);
  const raw = Buffer.from(keyLine ?? '', 'base64');
  if (raw.length !== 42 || raw.subarray(0, 2).toString() !== 'Ed') throw new Error('Ungültiger öffentlicher Schlüssel');
  return { id: raw.subarray(2, 10), key: createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw.subarray(10)]), format: 'der', type: 'spki' }) };
}

export function verifySignature(file: Buffer, signatureB64: string, publicKeyB64 = RELEASE_KEY): boolean {
  try {
    const { id, key } = publicKey(publicKeyB64);
    const [, sigLine, trustedLine, globalLine] = lines(signatureB64);
    const sig = Buffer.from(sigLine ?? '', 'base64');
    if (sig.length !== 74) return false;
    const alg = sig.subarray(0, 2).toString();
    if (!sig.subarray(2, 10).equals(id)) return false;
    const signature = sig.subarray(10);
    // 'ED': über den BLAKE2b-512-Hash der Datei signiert (Standard bei Tauri), 'Ed': über die Datei selbst.
    const message = alg === 'ED' ? createHash('blake2b512').update(file).digest() : alg === 'Ed' ? file : null;
    if (!message || !verify(null, message, key, signature)) return false;
    // Der vertrauenswürdige Kommentar ist mit signiert; auch ihn prüfen.
    const comment = trustedLine?.replace(/^trusted comment: /, '');
    if (comment === undefined || !globalLine) return false;
    return verify(null, Buffer.concat([signature, Buffer.from(comment)]), key, Buffer.from(globalLine, 'base64'));
  } catch {
    return false;
  }
}
