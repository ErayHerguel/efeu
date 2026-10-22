import { AtSign } from 'lucide-react';
import { useState } from 'react';
import { Popover, type Anchor } from '../../components/Popover';
import { cx } from '../../lib/cx';
import { useUI } from '../../store/ui';
import { markNoticesRead, unreadCount, useNotices, type MentionNotice } from './notifications';
import { usePeople } from './people';

function when(ms: number): string {
  const minutes = Math.round((Date.now() - ms) / 60_000);
  if (minutes < 1) return 'gerade eben';
  if (minutes < 60) return `vor ${minutes} Min.`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `vor ${hours} Std.`;
  return new Date(ms).toLocaleDateString('de-DE');
}

/** Seitenleiste: Erwähnungen mit Zähler; die Liste führt direkt zur Seite. Nur, wenn es ein Team gibt. */
export function MentionsButton() {
  const items = useNotices((s) => s.items);
  const team = usePeople((s) => s.people.length > 1);
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  if (!team) return null;
  const unread = unreadCount(items);
  const open = (n: MentionNotice) => {
    setAnchor(null);
    useUI.getState().open(n.pageId);
    if (!n.read) void markNoticesRead([n.id]);
  };
  return (
    <>
      <button
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setAnchor({ left: r.left, top: r.top, right: r.right, bottom: r.bottom });
        }}
        className="flex h-7 items-center gap-2 rounded-md px-2 text-sm text-muted hover:bg-hover hover:text-text"
      >
        <AtSign size={15} className="shrink-0" />
        <span className="flex-1 truncate text-left">Erwähnungen</span>
        {unread > 0 && <span className="rounded-full bg-accent px-1.5 text-xs font-medium text-accent-fg">{unread}</span>}
      </button>
      {anchor && (
        <Popover anchor={anchor} onClose={() => setAnchor(null)} className="w-[320px]">
          <div className="flex items-center justify-between px-3 pt-2 pb-1">
            <span className="text-xs font-medium text-faint">Erwähnungen</span>
            {unread > 0 && (
              <button className="text-xs text-accent hover:underline" onClick={() => void markNoticesRead('all')}>
                Alle gelesen
              </button>
            )}
          </div>
          {items.length === 0 ? (
            <p className="px-3 pb-3 text-sm text-faint">Noch niemand hat dich erwähnt. Tippe in einer Seite „@“, um jemanden zu erwähnen.</p>
          ) : (
            <div className="max-h-[360px] overflow-y-auto pb-1">
              {items.map((n) => (
                <button key={n.id} onClick={() => open(n)} className="flex w-full items-start gap-2 px-3 py-2 text-left hover:bg-hover">
                  <span className={cx('mt-1.5 h-2 w-2 shrink-0 rounded-full', n.read ? 'bg-transparent' : 'bg-accent')} />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm">
                      <strong className="font-medium">{n.byName}</strong> hat dich in „{n.title || 'Ohne Titel'}“ erwähnt
                    </span>
                    <span className="block text-xs text-faint">{when(n.createdAt)}</span>
                  </span>
                </button>
              ))}
            </div>
          )}
        </Popover>
      )}
    </>
  );
}
