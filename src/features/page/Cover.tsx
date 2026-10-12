import { ImageIcon, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { PageMeta } from '../../db/pages';
import { assetUrl } from '../../lib/assets';
import { cx } from '../../lib/cx';
import { usePages } from '../../store/pages';
import { useCanEdit } from '../collab/sources';
import { openCoverPicker } from './CoverPicker';
import { coverCredit, type CoverCredit } from './covers';

/** Öffnet die Auswahl für das Titelbild (Unsplash, Farbverläufe, eigenes Bild). */
export function chooseCover(pageId: string): void {
  openCoverPicker(pageId);
}

export function Cover({ page }: { page: PageMeta }) {
  const editable = useCanEdit(page.id);
  const [credit, setCredit] = useState<CoverCredit | null>(null);

  useEffect(() => {
    let alive = true;
    setCredit(null);
    if (page.cover) void coverCredit(page.cover).then((c) => alive && setCredit(c));
    return () => {
      alive = false;
    };
  }, [page.cover]);

  if (!page.cover) return null;
  return (
    <div className="group relative h-[30vh] max-h-[280px] min-h-[160px] w-full overflow-hidden bg-hover">
      <img src={assetUrl(page.cover)} alt="" draggable={false} className="h-full w-full object-cover" />
      {credit && (
        <div className="absolute bottom-3 left-4 rounded-md bg-black/35 px-2 py-0.5 text-[11px] text-white/90 opacity-0 backdrop-blur-sm transition-opacity group-hover:opacity-100">
          Foto von{' '}
          <a href={credit.authorUrl} className="underline decoration-white/40 underline-offset-2 hover:decoration-white">
            {credit.author}
          </a>{' '}
          auf{' '}
          <a href={credit.sourceUrl} className="underline decoration-white/40 underline-offset-2 hover:decoration-white">
            {credit.source}
          </a>
        </div>
      )}
      <div className={cx('absolute right-4 bottom-3 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100', !editable && 'hidden')}>
        <button
          onClick={() => chooseCover(page.id)}
          className="flex h-7 items-center gap-1.5 rounded-md bg-surface/90 px-2 text-xs text-muted shadow-popover hover:text-text"
        >
          <ImageIcon size={13} /> Ändern
        </button>
        <button
          onClick={() => usePages.getState().update(page.id, { cover: null })}
          className="flex h-7 items-center gap-1.5 rounded-md bg-surface/90 px-2 text-xs text-muted shadow-popover hover:text-text"
        >
          <Trash2 size={13} /> Entfernen
        </button>
      </div>
    </div>
  );
}
