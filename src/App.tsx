import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Plus } from 'lucide-react';
import { useEffect, useState } from 'react';
import { ConfirmDialog } from './components/ConfirmDialog';
import { Toasts } from './components/Toasts';
import { setDriver } from './db/driver';
import { loadSettings } from './db/settings';
import { createTauriDriver } from './db/tauriDriver';
import { createPageAndOpen } from './features/actions';
import { ensureSaved, quitApp } from './features/lifecycle';
import { hydrateSpecial } from './features/templates/special';
import { startReminders } from './features/reminders';
import { ReminderBanner } from './features/ReminderBanner';
import { TemplatePicker } from './features/templates/TemplatePicker';
import { addToInbox } from './features/templates/templates';
import { installMenu } from './features/menu';
import { initPaths, openExternal } from './lib/assets';
import { IS_MAC } from './lib/platform';
import { indexDatabaseValues } from './features/database/searchIndex';
import { CommentsDialog } from './features/history/CommentsDialog';
import { useHosting } from './features/collab/host/hosting';
import { ShareDialog } from './features/collab/host/ShareDialog';
import { JoinDialog } from './features/collab/JoinDialog';
import { SettingsDialog } from './features/settings/SettingsDialog';
import { AiConfirm } from './features/ai/AiConfirm';
import { WritePanel } from './features/ai/WritePanel';
import { AiBar } from './features/ai/edit/AiBar';
import { CoverPicker } from './features/page/CoverPicker';
import { hydrateUnsplash } from './features/page/covers';
import { AskDialog } from './features/ai/AskDialog';
import { useAi } from './features/ai/store';
import { refreshSpend } from './features/ai/usage';
import { VersionsDialog } from './features/history/VersionsDialog';
import { runFirstStart } from './features/onboarding/firstRun';
import { CommandPalette } from './features/palette/CommandPalette';
import { PageView } from './features/page/PageView';
import { TopBar } from './features/page/TopBar';
import { ShortcutsDialog } from './features/shortcuts/ShortcutsDialog';
import { useShortcuts } from './features/shortcuts/useShortcuts';
import { Sidebar } from './features/sidebar/Sidebar';
import { TrashDialog } from './features/trash/TrashDialog';
import { useTheme } from './features/useTheme';
import { UpdateBanner } from './features/update/UpdateBanner';
import { hydrateUpdates, scheduleStartupCheck } from './features/update/updater';
import { usePages } from './store/pages';
import { forgetPages, useUI } from './store/ui';

type Boot = { status: 'loading' } | { status: 'ready' } | { status: 'error'; message: string };

const isLive = (id: string) => {
  const page = usePages.getState().pages[id];
  return Boolean(page && page.deletedAt === null);
};
const firstRoot = () => usePages.getState().children.get(null)?.[0] ?? null;

let booting: Promise<void> | null = null;

/** Einmaliger Start: Datenbank öffnen (inkl. Migrationen), Einstellungen und Seiten laden. */
function bootstrap(): Promise<void> {
  booting ??= (async () => {
    const [driver] = await Promise.all([createTauriDriver(), initPaths()]);
    setDriver(driver);
    const settings = await loadSettings();
    useUI.getState().hydrate(settings);
    hydrateUpdates(settings);
    hydrateUnsplash(settings);
    await useAi.getState().hydrate(settings);
    refreshSpend().catch((err) => console.error('KI-Kosten', err));
    await usePages.getState().load();
    hydrateSpecial(settings);
    await useHosting.getState().hydrate(settings);
    const welcomeId = await runFirstStart(settings);
    if (welcomeId) useUI.getState().open(welcomeId);
    forgetPages(isLive, firstRoot());
    indexDatabaseValues(settings).catch((err) => console.error('Suchindex für Datenbank-Werte', err));
    // Wird die geöffnete Seite gelöscht, springt die Ansicht zum Elternteil oder zur ersten Seite.
    usePages.subscribe((state, prev) => {
      if (state.pages === prev.pages) return;
      const current = useUI.getState().currentId;
      if (!current || isLive(current)) return;
      const parentId = prev.pages[current]?.parentId;
      forgetPages(isLive, parentId && isLive(parentId) ? parentId : firstRoot());
    });
    scheduleStartupCheck();
    startReminders(settings);
    if (IS_MAC) installMenu().catch((err) => console.error('Menü konnte nicht erstellt werden', err));
  })();
  return booting;
}

export function App() {
  const [boot, setBoot] = useState<Boot>({ status: 'loading' });
  const currentId = useUI((s) => s.currentId);
  const overlay = useUI((s) => s.overlay);
  useTheme();
  useShortcuts();

  useEffect(() => {
    bootstrap()
      .then(() => setBoot({ status: 'ready' }))
      .catch((err) => setBoot({ status: 'error', message: err instanceof Error ? err.message : String(err) }));
  }, []);

  useEffect(() => {
    if (boot.status !== 'loading') void invoke('app_ready');
  }, [boot.status]);

  // Links (z. B. in Excalidraw-Dialogen) öffnen im Browser statt die App-Ansicht zu verlassen.
  // Im Editor gilt weiter: ⌘-Klick öffnet, einfacher Klick setzt den Cursor.
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const anchor = (e.target as HTMLElement).closest?.('a[href]');
      if (!anchor || anchor.closest('.ProseMirror')) return;
      const href = anchor.getAttribute('href') ?? '';
      if (!/^(https?:|mailto:)/i.test(href)) return;
      e.preventDefault();
      openExternal(href).catch(() => undefined);
    };
    document.addEventListener('click', onClick, true);
    return () => document.removeEventListener('click', onClick, true);
  }, []);

  useEffect(() => {
    const appWindow = getCurrentWindow();
    const unlisten = appWindow.onCloseRequested(async (event) => {
      // Solange geteilt wird, läuft flou in der Menüleiste weiter (Gäste und eigene Geräte bleiben verbunden).
      if (useHosting.getState().live) {
        event.preventDefault();
        await ensureSaved();
        await appWindow.hide();
        return;
      }
      if (!(await ensureSaved())) event.preventDefault();
    });
    const offQuick = listen<string>('quick-note', (event) => void addToInbox(event.payload));
    const offQuit = listen('tray:quit', () => void quitApp());
    return () => {
      for (const off of [unlisten, offQuick, offQuit]) void off.then((stop) => stop());
    };
  }, []);

  if (boot.status === 'loading') return <div data-tauri-drag-region className="h-full" />;
  if (boot.status === 'error') {
    return (
      <div data-tauri-drag-region className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
        <h1 className="text-lg font-semibold">Die Datenbank konnte nicht geöffnet werden</h1>
        <p className="max-w-[480px] text-sm text-muted">{boot.message}</p>
        <p className="max-w-[480px] text-xs text-faint">Es wurden keine Daten verändert. Backups liegen im Datenordner unter „backups“.</p>
        <ConfirmDialog />
      </div>
    );
  }

  return (
    <div className="flex h-full print:block print:h-auto">
      <Sidebar />
      <main className="flex min-w-0 flex-1 flex-col bg-bg print:block">
        <TopBar pageId={currentId} />
        <div className="min-h-0 flex-1 print:min-h-fit">{currentId ? <PageView key={currentId} id={currentId} /> : <EmptyState />}</div>
      </main>
      {overlay === 'trash' && <TrashDialog />}
      {(overlay === 'palette' || overlay === 'search') && <CommandPalette key={overlay} mode={overlay} />}
      {overlay === 'shortcuts' && <ShortcutsDialog />}
      {overlay === 'versions' && <VersionsDialog />}
      {overlay === 'comments' && <CommentsDialog />}
      {overlay === 'share' && <ShareDialog />}
      {overlay === 'join' && <JoinDialog />}
      {overlay === 'settings' && <SettingsDialog />}
      {overlay === 'templates' && <TemplatePicker />}
      <ConfirmDialog />
      <AiConfirm />
      <WritePanel />
      <AiBar />
      <CoverPicker />
      <AskDialog />
      <Toasts />
      {/* Hinweise unten rechts, übereinander */}
      <div className="fixed right-4 bottom-4 z-50 flex w-[320px] flex-col gap-2 print:hidden">
        <ReminderBanner />
        <UpdateBanner />
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 pb-20 text-center">
      <p className="text-sm text-muted">Keine Seite geöffnet</p>
      <button
        onClick={() => void createPageAndOpen(null)}
        className="flex h-8 items-center gap-1.5 rounded-md bg-accent px-3 text-sm font-medium text-accent-fg"
      >
        <Plus size={15} /> Neue Seite
      </button>
    </div>
  );
}
