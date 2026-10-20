/**
 * efeu hieß früher flou: Browser-Speicher (Gast-Zugang, Ansichtseinstellungen, Emoji-Verlauf) von den
 * alten Schlüsseln übernehmen. Wird vor dem ersten Rendern ausgeführt; der alte Eintrag wird gelöscht.
 */
export function migrateLegacyStorage(): void {
  for (const storage of [safe(() => localStorage), safe(() => sessionStorage)]) {
    if (!storage) continue;
    try {
      const keys = Array.from({ length: storage.length }, (_, i) => storage.key(i)).filter((k): k is string => !!k);
      for (const key of keys) {
        const renamed = key.startsWith('flou.') ? `efeu.${key.slice(5)}` : key.startsWith('flou-') ? `efeu-${key.slice(5)}` : null;
        if (!renamed) continue;
        const value = storage.getItem(key);
        if (value !== null && storage.getItem(renamed) === null) storage.setItem(renamed, value);
        storage.removeItem(key);
      }
    } catch {
      // Ohne Speicher (privates Fenster) gibt es nichts zu übernehmen.
    }
  }
}

function safe<T>(get: () => T): T | null {
  try {
    return get();
  } catch {
    return null;
  }
}
