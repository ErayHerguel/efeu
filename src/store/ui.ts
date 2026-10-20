import { create } from 'zustand';
import { schedule } from '../db/saveQueue';
import { setSetting } from '../db/settings';
import { GUEST } from '../lib/mode';

export type Theme = 'light' | 'dark' | 'system';
export type FocusTarget = 'title' | 'editor';
export interface FocusRequest {
  pageId: string;
  target: FocusTarget;
}
export type Overlay = 'palette' | 'search' | 'shortcuts' | 'trash' | 'versions' | 'comments' | 'share' | 'join' | 'settings' | 'templates' | null;

const SIDEBAR_MIN = 200;
const SIDEBAR_MAX = 480;

interface UIState {
  currentId: string | null;
  back: string[];
  forward: string[];
  sidebarOpen: boolean;
  /** Seitenleiste als Ausklappmenü auf schmalen Bildschirmen (nicht gespeichert) */
  drawerOpen: boolean;
  sidebarWidth: number;
  theme: Theme;
  overlay: Overlay;
  expanded: Record<string, true>;
  /** Startseite: wird beim Start geöffnet */
  homeId: string | null;
  favorites: string[];
  /** Offener Fokus-Wunsch an die Seitenansicht; wird von der Zielkomponente eingelöst und gelöscht. */
  pendingFocus: FocusRequest | null;
  hydrate(settings: Record<string, string>): void;
  open(id: string | null): void;
  goBack(): void;
  goForward(): void;
  toggleSidebar(): void;
  setDrawer(open: boolean): void;
  setSidebarWidth(width: number): void;
  setTheme(theme: Theme): void;
  setOverlay(overlay: Overlay): void;
  setExpanded(id: string, open: boolean): void;
  requestFocus(target: FocusTarget): void;
  setHome(id: string | null): void;
  toggleFavorite(id: string): void;
  consumeFocus(pageId: string, target: FocusTarget): boolean;
}

/** Als Gast bleiben Ansichtseinstellungen im Browser (localStorage), sonst in der Datenbank. */
const GUEST_PREFIX = 'efeu.';
const persist = (key: string, value: string) => {
  if (!GUEST) {
    schedule(`setting:${key}`, () => [setSetting(key, value)]);
    return;
  }
  try {
    localStorage.setItem(GUEST_PREFIX + key, value);
  } catch {
    // Ohne Speicher (privates Fenster) gelten die Einstellungen nur bis zum Neuladen.
  }
};

/** Gespeicherte Ansichtseinstellungen eines Gastes. */
export function guestSettings(): Record<string, string> {
  const settings: Record<string, string> = {};
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(GUEST_PREFIX)) settings[key.slice(GUEST_PREFIX.length)] = localStorage.getItem(key) ?? '';
    }
  } catch {
    // siehe persist
  }
  return settings;
}

export const useUI = create<UIState>((set, get) => ({
  currentId: null,
  back: [],
  forward: [],
  sidebarOpen: true,
  drawerOpen: false,
  sidebarWidth: 260,
  theme: 'system',
  overlay: null,
  expanded: {},
  homeId: null,
  favorites: [],
  pendingFocus: null,

  hydrate(settings) {
    const width = Number(settings['ui.sidebarWidth']);
    let expanded: Record<string, true> = {};
    try {
      expanded = JSON.parse(settings['ui.expanded'] ?? '{}');
    } catch {
      expanded = {};
    }
    let favorites: string[] = [];
    try {
      favorites = JSON.parse(settings['nav.favorites'] ?? '[]');
    } catch {
      favorites = [];
    }
    const homeId = settings['nav.home'] || null;
    set({
      homeId,
      favorites,
      sidebarOpen: settings['ui.sidebarOpen'] !== 'false',
      sidebarWidth: Number.isFinite(width) && width > 0 ? clampWidth(width) : 260,
      theme: (['light', 'dark', 'system'] as const).find((t) => t === settings['ui.theme']) ?? 'system',
      currentId: homeId ?? (settings['ui.lastPage'] || null),
      expanded,
    });
  },

  open(id) {
    const { currentId, back } = get();
    if (id === currentId) return;
    set({
      currentId: id,
      back: currentId ? [...back.slice(-49), currentId] : back,
      forward: [],
    });
    persist('ui.lastPage', id ?? '');
  },

  goBack() {
    const { back, currentId, forward } = get();
    const target = back[back.length - 1];
    if (!target) return;
    set({
      currentId: target,
      back: back.slice(0, -1),
      forward: currentId ? [currentId, ...forward] : forward,
    });
    persist('ui.lastPage', target);
  },

  goForward() {
    const { back, currentId, forward } = get();
    const [target, ...rest] = forward;
    if (!target) return;
    set({ currentId: target, back: currentId ? [...back, currentId] : back, forward: rest });
    persist('ui.lastPage', target);
  },

  toggleSidebar() {
    const sidebarOpen = !get().sidebarOpen;
    set({ sidebarOpen });
    persist('ui.sidebarOpen', String(sidebarOpen));
  },

  setDrawer(drawerOpen) {
    set({ drawerOpen });
  },

  setSidebarWidth(width) {
    const sidebarWidth = clampWidth(width);
    set({ sidebarWidth });
    persist('ui.sidebarWidth', String(sidebarWidth));
  },

  setTheme(theme) {
    set({ theme });
    persist('ui.theme', theme);
  },

  setOverlay(overlay) {
    set({ overlay });
  },

  setExpanded(id, open) {
    const expanded = { ...get().expanded };
    if (open) expanded[id] = true;
    else delete expanded[id];
    set({ expanded });
    persist('ui.expanded', JSON.stringify(expanded));
  },

  requestFocus(target) {
    const pageId = get().currentId;
    if (pageId) set({ pendingFocus: { pageId, target } });
  },

  setHome(id) {
    set({ homeId: id });
    persist('nav.home', id ?? '');
  },

  toggleFavorite(id) {
    const { favorites } = get();
    const next = favorites.includes(id) ? favorites.filter((f) => f !== id) : [...favorites, id];
    set({ favorites: next });
    persist('nav.favorites', JSON.stringify(next));
  },

  consumeFocus(pageId, target) {
    const request = get().pendingFocus;
    if (!request || request.pageId !== pageId || request.target !== target) return false;
    set({ pendingFocus: null });
    return true;
  },
}));

function clampWidth(width: number) {
  return Math.round(Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, width)));
}

/** Entfernt gelöschte Seiten aus dem Verlauf und wählt notfalls eine andere Seite. */
export function forgetPages(isLive: (id: string) => boolean, fallback: string | null): void {
  const { currentId, back, forward } = useUI.getState();
  const nextBack = back.filter(isLive);
  const nextForward = forward.filter(isLive);
  const current = currentId && isLive(currentId) ? currentId : (nextBack.pop() ?? fallback);
  useUI.setState({ currentId: current, back: nextBack, forward: nextForward });
  if (current !== currentId) persist('ui.lastPage', current ?? '');
}
