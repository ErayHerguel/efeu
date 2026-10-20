import { BoardView } from './BoardView';
import { useHiddenBoard } from './active';

/**
 * Unsichtbare Zeichenfläche: Die KI zeichnet ein Board, während man auf der Seite bleibt.
 * Liegt außerhalb des sichtbaren Bereichs, hat aber eine echte Größe (Excalidraw braucht Layout).
 */
export function HiddenBoard() {
  const pageId = useHiddenBoard((s) => s.pageId);
  if (!pageId) return null;
  return (
    <div aria-hidden className="pointer-events-none fixed top-0 left-[-10000px] h-[700px] w-[1100px] overflow-hidden opacity-0">
      <BoardView pageId={pageId} />
    </div>
  );
}
