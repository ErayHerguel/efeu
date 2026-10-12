import { CoverPicker } from './features/page/CoverPicker';
import { LoaderCircle } from 'lucide-react';
import { useEffect, useState } from 'react';
import logo from './assets/logo.svg';
import { ConfirmDialog } from './components/ConfirmDialog';
import { Toasts } from './components/Toasts';
import { useConnection } from './features/collab/guest/connection';
import { GuestStartError, startGuest, useGuest, type GuestProblem } from './features/collab/guest/session';
import { CommentsDialog } from './features/history/CommentsDialog';
import { CommandPalette } from './features/palette/CommandPalette';
import { PageView } from './features/page/PageView';
import { TopBar } from './features/page/TopBar';
import { ShortcutsDialog } from './features/shortcuts/ShortcutsDialog';
import { useShortcuts } from './features/shortcuts/useShortcuts';
import { Sidebar } from './features/sidebar/Sidebar';
import { useTheme } from './features/useTheme';
import { usePages } from './store/pages';
import { useUI } from './store/ui';

type Boot = { status: 'loading' } | { status: 'ready' } | { status: 'problem'; problem: GuestProblem | 'revoked' };

const MESSAGES: Record<GuestProblem | 'revoked', { title: string; text: string }> = {
  missing: {
    title: 'Einladungslink fehlt',
    text: 'Öffne den vollständigen Link, den du bekommen hast. Er endet mit „#join=…“.',
  },
  invalid: {
    title: 'Dieser Link gilt nicht mehr',
    text: 'Die Person, die geteilt hat, hat den Zugang entfernt oder neu vergeben. Bitte sie um einen neuen Link.',
  },
  revoked: {
    title: 'Zugang beendet',
    text: 'Die Person, die geteilt hat, hat deinen Zugang entfernt.',
  },
  unreachable: {
    title: 'Workspace nicht erreichbar',
    text: 'Vermutlich hat die Person flou geschlossen oder das Teilen beendet. Versuche es später erneut.',
  },
};

/** Oberfläche für eingeladene Personen: dieselben Ansichten wie in flou, Daten vom Gastgeber. */
export function GuestApp() {
  const [boot, setBoot] = useState<Boot>({ status: 'loading' });
  const status = useConnection((s) => s.status);
  const currentId = useUI((s) => s.currentId);
  const overlay = useUI((s) => s.overlay);
  const host = useGuest((s) => s.host);
  const empty = usePages((s) => Object.keys(s.pages).length === 0);
  useTheme();
  useShortcuts();

  useEffect(() => {
    startGuest()
      .then(() => setBoot({ status: 'ready' }))
      .catch((err) => setBoot({ status: 'problem', problem: err instanceof GuestStartError ? err.problem : 'unreachable' }));
  }, []);

  useEffect(() => {
    document.title = host ? `flou – Workspace von ${host.name}` : 'flou';
  }, [host]);

  const problem = boot.status === 'problem' ? boot.problem : status === 'revoked' ? 'revoked' : null;
  if (problem) return <Notice {...MESSAGES[problem]} />;
  if (boot.status === 'loading') {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-sm text-muted">
        <LoaderCircle size={16} className="animate-spin" /> Verbinde mit dem geteilten Workspace …
      </div>
    );
  }

  return (
    <div className="flex h-full print:block print:h-auto">
      <Sidebar />
      <main className="flex min-w-0 flex-1 flex-col bg-bg print:block">
        <TopBar pageId={currentId} />
        <div className="min-h-0 flex-1 print:min-h-fit">
          {currentId ? (
            <PageView key={currentId} id={currentId} />
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-muted">
              {empty ? 'Mit dir wurde noch nichts geteilt.' : 'Wähle links eine Seite.'}
            </div>
          )}
        </div>
      </main>
      {(overlay === 'palette' || overlay === 'search') && <CommandPalette key={overlay} mode={overlay} />}
      {overlay === 'shortcuts' && <ShortcutsDialog />}
      {overlay === 'comments' && <CommentsDialog />}
      <ConfirmDialog />
      <CoverPicker />
      <Toasts />
    </div>
  );
}

function Notice({ title, text }: { title: string; text: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
      <img src={logo} alt="" className="h-10 w-10 rounded-lg" draggable={false} />
      <h1 className="text-lg font-semibold">{title}</h1>
      <p className="max-w-[420px] text-sm text-muted">{text}</p>
    </div>
  );
}
