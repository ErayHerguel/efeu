import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RELEASE_KEY, verifySignature } from './verify';

const fixture = (name: string) => readFileSync(join(__dirname, 'fixtures', name));

describe('Signaturprüfung für Server-Updates', () => {
  const file = fixture('datei.txt');
  const sig = fixture('datei.txt.sig').toString();
  const key = fixture('test.key.pub').toString();

  it('nimmt korrekt signierte Dateien an', () => {
    expect(verifySignature(file, sig, key)).toBe(true);
  });

  it('weist veränderte Dateien, fremde Schlüssel und Unsinn zurück', () => {
    expect(verifySignature(Buffer.concat([file, Buffer.from('!')]), sig, key)).toBe(false);
    expect(verifySignature(file, sig, RELEASE_KEY)).toBe(false);
    expect(verifySignature(file, '', key)).toBe(false);
    expect(verifySignature(file, 'kein base64 ###', key)).toBe(false);
  });
});
