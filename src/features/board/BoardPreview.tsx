import { useEffect, useState } from 'react';
import { loadBoard } from '../../db/boards';
import { GUEST } from '../../lib/mode';
import { connection } from '../collab/guest/connection';
import type { BoardSnapshot } from '../collab/protocol';
import { loadFiles } from './files';
import { useBoardRevision } from './active';

/** Gespeicherte Szene, als Gast vom Gastgeber. */
async function loadScene(pageId: string): Promise<Pick<BoardSnapshot, 'elements' | 'files'>> {
  if (GUEST) return connection.request<BoardSnapshot>({ op: 'board.open', pageId, subscribe: false });
  const scene = await loadBoard(pageId);
  return { elements: [...scene.elements], files: scene.files };
}

/** Statische SVG-Vorschau eines Boards (für die Einbettung in Seiten). */
export function BoardPreview({ pageId }: { pageId: string }) {
  const [svg, setSvg] = useState<string | null>(null);
  const [empty, setEmpty] = useState(false);
  const revision = useBoardRevision((s) => s[pageId] ?? 0);

  useEffect(() => {
    let alive = true;
    (async () => {
      const scene = await loadScene(pageId);
      const elements = scene.elements.filter((e) => !e.isDeleted);
      if (elements.length === 0) {
        if (alive) setEmpty(true);
        return;
      }
      if (alive) setEmpty(false);
      await import('./assetPath');
      const { exportToSvg } = await import('@excalidraw/excalidraw');
      const files = await loadFiles(scene.files);
      const node = await exportToSvg({
        elements: elements as never,
        appState: { exportBackground: false, viewBackgroundColor: 'transparent', exportWithDarkMode: false },
        files: Object.fromEntries(files.map((f) => [f.id, f])),
        exportPadding: 16,
      });
      if (alive) setSvg(node.outerHTML);
    })().catch(() => alive && setEmpty(true));
    return () => {
      alive = false;
    };
  }, [pageId, revision]);

  if (empty) return <div className="py-8 text-center text-sm text-faint">Leeres Board – zum Bearbeiten öffnen</div>;
  if (!svg) return <div className="h-40" />;
  // Das SVG stammt aus Excalidraws eigenem Export der lokalen Szene.
  return <div className="board-preview" dangerouslySetInnerHTML={{ __html: svg }} />;
}
