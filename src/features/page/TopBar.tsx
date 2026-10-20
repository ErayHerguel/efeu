import { ChevronLeft, ChevronRight, Copy, CopyPlus, History, LayoutTemplate, House, MessageSquare, MoreHorizontal, MoveHorizontal, Mic, PanelLeft, Printer, Sparkles, Star, Trash2 } from 'lucide-react';
import { useAiReady } from '../ai/store';
import { openAiBar } from '../ai/edit/session';
import { suggestTitle } from '../ai/title';
import { openLectureStart } from '../lecture/LectureUI';
import { useLecture } from '../lecture/lecture';
import { Fragment, useCallback, useState } from 'react';
import { IconButton } from '../../components/IconButton';
import { MenuList } from '../../components/MenuList';
import { PageIcon, pageTitle } from '../../components/PageIcon';
import { Popover, type Anchor } from '../../components/Popover';
import { useSaveStatus } from '../../db/saveQueue';
import { GUEST } from '../../lib/mode';
import { IS_MAC } from '../../lib/platform';
import { useNarrow } from '../../lib/useNarrow';
import { ConnectionIndicator } from '../collab/guest/GuestIdentity';
import { CloudIndicator } from '../cloud/CloudSettings';
import { PageShareButton } from '../collab/host/PageShare';
import { PagePresence } from '../collab/presence';
import { useCanEdit } from '../collab/sources';
import { ancestorIds } from '../../lib/tree';
import { usePages } from '../../store/pages';
import { useUI } from '../../store/ui';
import { actionById, duplicateAndOpen } from '../actions';
import { saveAsTemplate } from '../templates/templates';
import { formatCombo } from '../shortcuts/keys';

/** Abstand für die Ampel-Knöpfe, wenn die Seitenleiste ausgeblendet ist. */
const TRAFFIC_LIGHT_INSET = 84;

export function TopBar({ pageId }: { pageId: string | null }) {
  const sidebarOpen = useUI((s) => s.sidebarOpen);
  const narrow = useNarrow();
  const canBack = useUI((s) => s.back.length > 0);
  const canForward = useUI((s) => s.forward.length > 0);
  const pages = usePages((s) => s.pages);
  const page = pageId ? pages[pageId] : undefined;
  const path = page ? [...ancestorIds(pages, page.id), page.id] : [];
  // Auf schmalen Bildschirmen nur die aktuelle Seite.
  const crumbs = narrow ? path.slice(-1) : path;
  const [menu, setMenu] = useState<Anchor | null>(null);
  const favorite = useUI((s) => (pageId ? s.favorites.includes(pageId) : false));
  const isHome = useUI((s) => pageId !== null && s.homeId === pageId);
  const closeMenu = useCallback(() => setMenu(null), []);
  const editable = useCanEdit(pageId);
  const aiReady = useAiReady();
  const recording = useLecture((s) => s.status !== 'idle' && s.pageId === pageId);

  return (
    <header
      data-tauri-drag-region
      className="flex h-11 shrink-0 items-center gap-1 pr-3 print:hidden"
      style={{ paddingLeft: sidebarOpen || narrow || !IS_MAC || GUEST ? 12 : TRAFFIC_LIGHT_INSET }}
    >
      {narrow ? (
        <IconButton icon={PanelLeft} label="Menü" onClick={() => useUI.getState().setDrawer(true)} />
      ) : (
        !sidebarOpen && (
          <IconButton
            icon={PanelLeft}
            label={`Seitenleiste einblenden (${formatCombo('Mod+\\')})`}
            onClick={() => useUI.getState().toggleSidebar()}
          />
        )
      )}
      <IconButton icon={ChevronLeft} label={`Zurück (${formatCombo('Mod+[')})`} disabled={!canBack} onClick={() => useUI.getState().goBack()} />
      {!narrow && (
        <IconButton icon={ChevronRight} label={`Vorwärts (${formatCombo('Mod+]')})`} disabled={!canForward} onClick={() => useUI.getState().goForward()} />
      )}

      <nav className="ml-1 flex min-w-0 items-center text-sm" aria-label="Pfad">
        {crumbs.map((id, i) => (
          <Fragment key={id}>
            {i > 0 && <span className="px-0.5 text-faint">/</span>}
            <button
              onClick={() => useUI.getState().open(id)}
              className="flex h-7 min-w-0 max-w-[200px] items-center gap-1.5 rounded-md px-1.5 text-muted hover:bg-hover hover:text-text"
            >
              <PageIcon page={pages[id]} size={14} />
              <span className="truncate">{pageTitle(pages[id])}</span>
            </button>
          </Fragment>
        ))}
      </nav>

      <div data-tauri-drag-region className="h-full flex-1" />
      {GUEST ? <ConnectionIndicator /> : <SaveIndicator />}
      {!GUEST && <CloudIndicator />}
      <PagePresence />
      {page && !GUEST && editable && page.type === 'page' && (
        <IconButton icon={Mic} label={recording ? 'Mitschrift läuft' : 'Vorlesung mitschreiben'} onClick={() => openLectureStart(page.id)} />
      )}
      {page && aiReady && editable && (
        <button
          title={`Mit KI bearbeiten (${formatCombo('Mod+J')})`}
          onClick={() => openAiBar()}
          className="flex h-7 items-center gap-1 rounded-md px-2 text-sm text-accent hover:bg-hover"
        >
          <Sparkles size={15} /> KI
        </button>
      )}
      {page && !GUEST && <PageShareButton pageId={page.id} />}
      {page && (
        <button
          aria-label={favorite ? 'Aus Favoriten entfernen' : 'Zu Favoriten hinzufügen'}
          title={favorite ? 'Aus Favoriten entfernen' : 'Zu Favoriten hinzufügen'}
          onClick={() => useUI.getState().toggleFavorite(page.id)}
          className="flex h-7 w-7 items-center justify-center rounded-md text-muted hover:bg-hover hover:text-text"
        >
          <Star size={16} className={favorite ? 'fill-current text-accent' : ''} />
        </button>
      )}
      {page && (
        <IconButton icon={MoreHorizontal} label="Seitenoptionen" onClick={(e) => setMenu(e.currentTarget.getBoundingClientRect())} />
      )}
      {menu && page && (
        <Popover anchor={menu} onClose={closeMenu} placement="bottom-end">
          <MenuList
            onDone={closeMenu}
            items={[
              ...(editable
                ? [
                    {
                      label: page.fullWidth ? 'Normale Breite' : 'Volle Breite',
                      icon: MoveHorizontal,
                      hint: formatCombo(actionById('page.fullWidth').keys!),
                      onSelect: () => void actionById('page.fullWidth').run(),
                    },
                  ]
                : []),
              { label: 'Drucken / Als PDF sichern …', icon: Printer, hint: formatCombo('Mod+P'), onSelect: () => void actionById('share.print').run() },
              ...(GUEST
                ? []
                : [
                    {
                      label: 'Als Markdown kopieren',
                      icon: Copy,
                      hint: formatCombo('Mod+Shift+C'),
                      onSelect: () => void actionById('share.copyMarkdown').run(),
                    },
                  ]),
              {
                label: isHome ? 'Startseite entfernen' : 'Als Startseite festlegen',
                icon: House,
                onSelect: () => useUI.getState().setHome(isHome ? null : page.id),
              },
              ...(GUEST
                ? []
                : [
                    { label: 'Duplizieren', icon: CopyPlus, onSelect: () => void duplicateAndOpen(page.id) },
                    { label: 'Als Vorlage speichern', icon: LayoutTemplate, onSelect: () => void saveAsTemplate(page.id) },
                  ]),
              ...(aiReady && editable
                ? [{ label: 'KI: Titel und Icon vorschlagen', icon: Sparkles, onSelect: () => void suggestTitle(page.id) }]
                : []),
              ...(page.type === 'page' && !GUEST
                ? [{ label: 'Versionsverlauf …', icon: History, onSelect: () => useUI.getState().setOverlay('versions') }]
                : []),
              ...(page.type === 'page'
                ? [{ label: 'Kommentare', icon: MessageSquare, onSelect: () => useUI.getState().setOverlay('comments') }]
                : []),
              ...(editable
                ? [
                    {
                      label: 'In den Papierkorb',
                      icon: Trash2,
                      danger: true,
                      hint: formatCombo(actionById('page.trash').keys!),
                      onSelect: () => void usePages.getState().trash(page.id),
                    },
                  ]
                : []),
            ]}
          />
        </Popover>
      )}
    </header>
  );
}

function SaveIndicator() {
  const { status, error } = useSaveStatus();
  if (status === 'error') {
    return (
      <span title={error ?? undefined} className="mr-2 text-xs text-danger">
        Nicht gespeichert – neuer Versuch läuft
      </span>
    );
  }
  if (status === 'saving') return <span className="mr-2 text-xs text-faint">Speichert …</span>;
  return null;
}
