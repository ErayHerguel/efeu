/**
 * Läuft die Oberfläche als Gast? Der Freigabe-Server markiert seine Startseite mit
 * <meta name="efeu-mode" content="guest">; in der App selbst fehlt die Markierung.
 */
export const GUEST =
  typeof document !== 'undefined' && document.querySelector('meta[name="efeu-mode"]')?.getAttribute('content') === 'guest';
