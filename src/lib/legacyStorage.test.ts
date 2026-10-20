// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { migrateLegacyStorage } from './legacyStorage';

describe('Browser-Speicher aus flou', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  it('übernimmt alte Schlüssel und löscht sie', () => {
    localStorage.setItem('flou-token', 'abc');
    localStorage.setItem('flou.theme', 'dark');
    sessionStorage.setItem('flou-topic', 'kanal');
    localStorage.setItem('anderes', '1');
    migrateLegacyStorage();
    expect(localStorage.getItem('efeu-token')).toBe('abc');
    expect(localStorage.getItem('efeu.theme')).toBe('dark');
    expect(sessionStorage.getItem('efeu-topic')).toBe('kanal');
    expect(localStorage.getItem('flou-token')).toBeNull();
    expect(localStorage.getItem('anderes')).toBe('1');
  });

  it('überschreibt keine neueren Werte', () => {
    localStorage.setItem('flou-token', 'alt');
    localStorage.setItem('efeu-token', 'neu');
    migrateLegacyStorage();
    expect(localStorage.getItem('efeu-token')).toBe('neu');
    expect(localStorage.getItem('flou-token')).toBeNull();
  });
});
