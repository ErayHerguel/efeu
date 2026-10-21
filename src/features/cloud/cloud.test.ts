import { describe, expect, it } from 'vitest';
import { olderVersion } from './cloud';

describe('Versionsvergleich für Server-Updates', () => {
  it('erkennt ältere Versionen', () => {
    expect(olderVersion('2.0.0', '2.1.0')).toBe(true);
    expect(olderVersion('2.1.0', '2.1.0')).toBe(false);
    expect(olderVersion('2.10.0', '2.9.3')).toBe(false);
    expect(olderVersion('2.1', '2.1.1')).toBe(true);
    expect(olderVersion('dev', '2.1.0')).toBe(true);
  });
});
