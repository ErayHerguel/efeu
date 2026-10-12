import { Clock, Coffee, Flag, Heart, Lightbulb, PawPrint, Plane, Search, Shuffle, Smile, Trash2, Trophy, Users, type LucideIcon } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { cx } from '../../lib/cx';
import { loadEmojis, recentEmojis, rememberEmoji, searchEmojis, setSkinTone, skinTone, withSkin, type Emoji, type EmojiGroup } from './emojiData';

const GROUP_ICONS: Record<number, LucideIcon> = {
  0: Smile,
  1: Users,
  3: PawPrint,
  4: Coffee,
  5: Plane,
  6: Trophy,
  7: Lightbulb,
  8: Heart,
  9: Flag,
};

const TONES = ['✋', '✋🏻', '✋🏼', '✋🏽', '✋🏾', '✋🏿'];

/** Alle Emojis: Suche (deutsch), Kategorien, zuletzt benutzt, Hautfarbe. */
export function EmojiPicker({ onPick, onRemove }: { onPick: (emoji: string) => void; onRemove?: () => void }) {
  const [groups, setGroups] = useState<EmojiGroup[] | null>(null);
  const [query, setQuery] = useState('');
  const [tone, setTone] = useState(skinTone);
  const [toneOpen, setToneOpen] = useState(false);
  const [hover, setHover] = useState<Emoji | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const recent = useMemo(recentEmojis, []);

  useEffect(() => {
    loadEmojis()
      .then(setGroups)
      .catch(() => setGroups([]));
  }, []);

  const pick = (emoji: string) => {
    rememberEmoji(emoji);
    onPick(emoji);
  };

  const results = useMemo(() => (groups && query.trim() ? searchEmojis(groups, query) : null), [groups, query]);

  const random = () => {
    const all = groups?.flatMap((g) => g.emojis) ?? [];
    if (all.length) pick(withSkin(all[Math.floor(Math.random() * all.length)], tone));
  };

  const cell = (e: Emoji, key: string) => (
    <button
      key={key}
      title={e.label}
      onClick={() => pick(withSkin(e, tone))}
      onMouseEnter={() => setHover(e)}
      className="flex h-9 w-9 items-center justify-center rounded-md text-[22px] leading-none hover:bg-hover"
    >
      {withSkin(e, tone)}
    </button>
  );

  return (
    <div className="flex w-[360px] flex-col" onMouseLeave={() => setHover(null)}>
      <div className="flex items-center gap-1.5 border-b border-border px-2 py-2">
        <div className="flex h-8 min-w-0 flex-1 items-center gap-1.5 rounded-md bg-bg px-2">
          <Search size={14} className="shrink-0 text-faint" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && results?.[0]) pick(withSkin(results[0], tone));
            }}
            placeholder="Emoji suchen … (z. B. Rakete, Herz)"
            className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-faint"
          />
        </div>
        <div className="relative">
          <button
            title="Hautfarbe"
            onClick={() => setToneOpen((v) => !v)}
            className="flex h-8 w-8 items-center justify-center rounded-md text-lg hover:bg-hover"
          >
            {TONES[tone]}
          </button>
          {toneOpen && (
            <div className="absolute top-9 right-0 z-10 flex gap-0.5 rounded-md bg-surface p-1 shadow-popover">
              {TONES.map((t, i) => (
                <button
                  key={t}
                  onClick={() => {
                    setTone(i);
                    setSkinTone(i);
                    setToneOpen(false);
                  }}
                  className={cx('flex h-8 w-8 items-center justify-center rounded-md text-lg hover:bg-hover', i === tone && 'bg-active')}
                >
                  {t}
                </button>
              ))}
            </div>
          )}
        </div>
        <button title="Zufällig" aria-label="Zufälliges Emoji" onClick={random} className="flex h-8 w-8 items-center justify-center rounded-md text-muted hover:bg-hover">
          <Shuffle size={15} />
        </button>
        {onRemove && (
          <button title="Icon entfernen" aria-label="Icon entfernen" onClick={onRemove} className="flex h-8 w-8 items-center justify-center rounded-md text-muted hover:bg-hover">
            <Trash2 size={15} />
          </button>
        )}
      </div>

      {!results && groups && groups.length > 0 && (
        <div className="flex justify-between border-b border-border px-2 py-1">
          {recent.length > 0 && (
            <button
              title="Zuletzt benutzt"
              onClick={() => scroller.current?.querySelector('[data-group="recent"]')?.scrollIntoView({ block: 'start' })}
              className="flex h-7 w-7 items-center justify-center rounded-md text-muted hover:bg-hover hover:text-text"
            >
              <Clock size={15} />
            </button>
          )}
          {groups.map((g) => {
            const Icon = GROUP_ICONS[g.id] ?? Smile;
            return (
              <button
                key={g.id}
                title={g.name}
                onClick={() => scroller.current?.querySelector(`[data-group="${g.id}"]`)?.scrollIntoView({ block: 'start' })}
                className="flex h-7 w-7 items-center justify-center rounded-md text-muted hover:bg-hover hover:text-text"
              >
                <Icon size={15} />
              </button>
            );
          })}
        </div>
      )}

      <div ref={scroller} className="h-[300px] overflow-y-auto p-2">
        {!groups ? (
          <p className="p-2 text-sm text-faint">Lade Emojis …</p>
        ) : results ? (
          results.length ? (
            <div className="grid grid-cols-9">{results.map((e) => cell(e, e.unicode))}</div>
          ) : (
            <p className="p-2 text-sm text-faint">Kein Emoji gefunden.</p>
          )
        ) : (
          <>
            {recent.length > 0 && (
              <div data-group="recent" className="mb-2">
                <div className="px-1 pb-1 text-2xs font-medium text-faint">Zuletzt benutzt</div>
                <div className="grid grid-cols-9">
                  {recent.map((emoji) => (
                    <button
                      key={`r${emoji}`}
                      onClick={() => pick(emoji)}
                      className="flex h-9 w-9 items-center justify-center rounded-md text-[22px] leading-none hover:bg-hover"
                    >
                      {emoji}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {groups.map((g) => (
              <div key={g.id} data-group={g.id} className="mb-2">
                <div className="sticky -top-2 bg-surface px-1 py-1 text-2xs font-medium text-faint">{g.name}</div>
                <div className="grid grid-cols-9">{g.emojis.map((e) => cell(e, e.unicode))}</div>
              </div>
            ))}
          </>
        )}
      </div>
      <div className="flex h-9 items-center gap-2 border-t border-border px-3 text-xs text-muted">
        {hover ? (
          <>
            <span className="text-lg leading-none">{withSkin(hover, tone)}</span>
            <span className="truncate">{hover.label}</span>
          </>
        ) : (
          <span className="text-faint">{groups ? `${groups.reduce((n, g) => n + g.emojis.length, 0).toLocaleString('de-DE')} Emojis` : ''}</span>
        )}
      </div>
    </div>
  );
}
