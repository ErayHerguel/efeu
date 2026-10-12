import { describe, expect, it } from 'vitest';
import { loadEmojis, searchEmojis, withSkin } from './emojiData';

describe('Emojis', () => {
  it('lädt alle Gruppen ohne Komponenten, mit deutschen Namen', async () => {
    const groups = await loadEmojis();
    const all = groups.flatMap((g) => g.emojis);
    expect(all.length).toBeGreaterThan(1800);
    expect(groups.map((g) => g.name)).toContain('Tiere & Natur');
    expect(groups.some((g) => g.name === 'Komponenten')).toBe(false);
  });

  it('findet Emojis über deutsche Begriffe', async () => {
    const groups = await loadEmojis();
    expect(searchEmojis(groups, 'rakete')[0].unicode).toBe('🚀');
    expect(searchEmojis(groups, 'herz').length).toBeGreaterThan(10);
  });

  it('wählt die Hautfarbe, wo es sie gibt', async () => {
    const groups = await loadEmojis();
    const wave = groups.flatMap((g) => g.emojis).find((e) => e.unicode === '👋')!;
    expect(withSkin(wave, 3)).toBe('👋🏽');
    const rocket = groups.flatMap((g) => g.emojis).find((e) => e.unicode === '🚀')!;
    expect(withSkin(rocket, 3)).toBe('🚀');
  });
});
