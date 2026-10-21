import { CalendarDays, ChevronsLeft, House, Monitor, Moon, Plus, Search, Settings, Sun, Trash2, type LucideIcon } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { APP_NAME } from '../../app.config';
import logo from '../../assets/logo.svg';
import { IconButton } from '../../components/IconButton';
import { PageIcon, pageTitle } from '../../components/PageIcon';
import { usePages } from '../../store/pages';
import { cx } from '../../lib/cx';
import { GUEST } from '../../lib/mode';
import { IS_MAC } from '../../lib/platform';
import { useNarrow } from '../../lib/useNarrow';
import { GuestIdentity } from '../collab/guest/GuestIdentity';
import { useAccess } from '../collab/sources';
import { ShareButton } from '../collab/host/ShareButton';
import { useUI, type Theme } from '../../store/ui';
import { actionById } from '../actions';
import { formatCombo } from '../shortcuts/keys';
import type { Space } from '../../db/pages';
import { useCloud } from '../cloud/cloud';
import { PageTree } from './PageTree';
import { Resizer } from './Resizer';

const THEME_ORDER: Theme[] = ['system', 'light', 'dark'];
const THEME_ICON: Record<Theme, LucideIcon> = {
  system: Monitor,
  light: Sun,
  dark: Moon,
};
const THEME_LABEL: Record<Theme, string> = {
  system: 'System',
  light: 'Hell',
  dark: 'Dunkel',
};

export function Sidebar() {
  const narrow = useNarrow();
  const open = useUI((s) => s.sidebarOpen);
  const drawerOpen = useUI((s) => s.drawerOpen);
  const width = useUI((s) => s.sidebarWidth);
  const currentId = useUI((s) => s.currentId);
  const [resizing, setResizing] = useState(false);

  // Auf schmalen Bildschirmen schließt das Menü, sobald eine Seite geöffnet wird.
  useEffect(() => {
    useUI.getState().setDrawer(false);
  }, [currentId]);

  if (narrow) {
    return (
      <>
        {drawerOpen && (
          <div className="fixed inset-0 z-30 animate-fade-in bg-overlay print:hidden" onClick={() => useUI.getState().setDrawer(false)} />
        )}
        <aside
          aria-hidden={!drawerOpen}
          className={cx(
            'safe-area-y fixed inset-y-0 left-0 z-40 w-[min(300px,85vw)] bg-sidebar shadow-popover transition-transform duration-200 print:hidden',
            drawerOpen ? 'translate-x-0' : '-translate-x-full',
          )}
        >
          <SidebarContent narrow />
        </aside>
      </>
    );
  }

  return (
    <aside
      aria-hidden={!open}
      className={cx(
        'relative h-full shrink-0 bg-sidebar print:hidden',
        !resizing && 'transition-[width] duration-150',
        open && 'border-r border-border',
      )}
      style={{ width: open ? width : 0 }}
    >
      <div className={cx('h-full', !open && 'invisible')} style={{ width }}>
        <SidebarContent narrow={false} />
      </div>
      {open && <Resizer onResizing={setResizing} />}
    </aside>
  );
}

function SidebarContent({ narrow }: { narrow: boolean }) {
  const theme = useUI((s) => s.theme);
  const ThemeIcon = THEME_ICON[theme];
  const newPage = actionById('page.new');
  // Eigener Workspace oder eigenes Gerät: alles erlaubt; Gäste nur innerhalb ihrer Freigaben.
  const fullAccess = useAccess((s) => s.access === null);
  const sections = useSections();
  const member = useCloud((s) => s.role === 'member');
  const palette = actionById('palette.open');
  const homeId = useUI((s) => s.homeId);
  const favorites = useUI((s) => s.favorites);
  const currentId = useUI((s) => s.currentId);
  const pages = usePages((s) => s.pages);
  const liveFavorites = favorites.filter((id) => pages[id] && pages[id].deletedAt === null);
  const hasHome = Boolean(homeId && pages[homeId] && pages[homeId].deletedAt === null);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div data-tauri-drag-region className={IS_MAC && !GUEST && !narrow ? 'h-11 shrink-0' : 'h-2 shrink-0'} />
      <div className="group flex h-9 shrink-0 items-center gap-2 px-3">
        <img src={logo} alt="" className="h-5 w-5 rounded-[5px]" draggable={false} />
        <span className="flex-1 truncate text-sm font-semibold text-text">{APP_NAME}</span>
        <IconButton
          icon={ChevronsLeft}
          label={narrow ? 'Menü schließen' : `Seitenleiste ausblenden (${formatCombo('Mod+\\')})`}
          onClick={() => (narrow ? useUI.getState().setDrawer(false) : useUI.getState().toggleSidebar())}
          className={narrow ? undefined : 'opacity-0 group-hover:opacity-100'}
        />
      </div>

      <div className="mt-1 flex flex-col px-2">
        <SidebarButton icon={Search} onClick={() => void palette.run()} hint={palette.keys && formatCombo(palette.keys)}>
          Suchen
        </SidebarButton>
        {fullAccess && (
          <SidebarButton icon={Plus} onClick={() => void newPage.run()} hint={newPage.keys && formatCombo(newPage.keys)}>
            Neue Seite
          </SidebarButton>
        )}
        {!GUEST && (
          <SidebarButton icon={CalendarDays} onClick={() => void actionById('daily.today').run()} hint={formatCombo('Mod+Shift+D')}>
            Heute
          </SidebarButton>
        )}
        {hasHome && (
          <SidebarButton icon={House} onClick={() => useUI.getState().open(homeId!)} hint={formatCombo('Mod+Shift+O')}>
            Startseite
          </SidebarButton>
        )}
      </div>

      {liveFavorites.length > 0 && (
        <>
          <div className="mt-4 mb-1 px-4 text-2xs font-medium tracking-wide text-faint uppercase">Favoriten</div>
          <div className="flex flex-col px-2">
            {liveFavorites.map((id) => (
              <button
                key={id}
                onClick={() => useUI.getState().open(id)}
                className={cx(
                  'flex h-7 items-center gap-2 rounded-md px-2 text-sm',
                  currentId === id ? 'bg-active font-medium text-text' : 'text-muted hover:bg-hover',
                )}
              >
                <PageIcon page={pages[id]} />
                <span className="truncate">{pageTitle(pages[id])}</span>
              </button>
            ))}
          </div>
        </>
      )}

      {!sections.headers && (
        <div className="mt-4 mb-1 px-4 text-2xs font-medium tracking-wide text-faint uppercase">
          {fullAccess ? 'Seiten' : 'Mit dir geteilt'}
        </div>
      )}
      <div className={cx('min-h-0 flex-1 overflow-y-auto px-2', sections.headers && 'mt-4')}>
        <PageTree spaces={sections.spaces} headers={sections.headers} />
      </div>

      <div className="flex shrink-0 items-center gap-1 border-t border-border px-2 py-2">
        {GUEST ? (
          <GuestIdentity />
        ) : (
          <>
            <SidebarButton icon={Trash2} onClick={() => useUI.getState().setOverlay('trash')} className="flex-1">
              Papierkorb
            </SidebarButton>
            {!member && <ShareButton />}
          </>
        )}
        {GUEST ? (
          <IconButton
            icon={ThemeIcon}
            label={`Erscheinungsbild: ${THEME_LABEL[theme]}`}
            onClick={() => {
              const next = THEME_ORDER[(THEME_ORDER.indexOf(theme) + 1) % THEME_ORDER.length];
              useUI.getState().setTheme(next);
            }}
          />
        ) : (
          <IconButton
            icon={Settings}
            label={`Einstellungen (${formatCombo('Mod+,')})`}
            onClick={() => useUI.getState().setOverlay('settings')}
          />
        )}
      </div>
    </div>
  );
}

const ALL_SPACES: Space[] = ['team', 'private', 'local'];
const MEMBER_SPACES: Space[] = ['team', 'local'];

/**
 * Welche Bereiche die Seitenleiste zeigt. Mit eigener Cloud: Team, Privat und „Nur auf diesem Computer“.
 * Ohne Cloud eine einfache Liste, es sei denn, es liegen schon Seiten in anderen Bereichen.
 */
function useSections(): { spaces: Space[]; headers: boolean } {
  const cloud = useCloud((s) => s.phase !== 'off');
  const member = useCloud((s) => s.role === 'member');
  const mixed = usePages((s) => Object.values(s.pages).some((p) => p.parentId === null && p.deletedAt === null && p.space !== 'private'));
  if (GUEST) return { spaces: ALL_SPACES, headers: false };
  // Im Team eines anderen gibt es keinen privaten Bereich auf dessen Server.
  if (member) return { spaces: MEMBER_SPACES, headers: true };
  return { spaces: ALL_SPACES, headers: cloud || mixed };
}

interface SidebarButtonProps {
  icon: LucideIcon;
  onClick: () => void;
  hint?: string;
  className?: string;
  children: ReactNode;
}

function SidebarButton({ icon: Icon, onClick, hint, className, children }: SidebarButtonProps) {
  return (
    <button
      onClick={onClick}
      className={cx('flex h-7 items-center gap-2 rounded-md px-2 text-sm text-muted hover:bg-hover hover:text-text', className)}
    >
      <Icon size={15} className="shrink-0" />
      <span className="flex-1 truncate text-left">{children}</span>
      {hint && <span className="text-xs text-faint">{hint}</span>}
    </button>
  );
}
