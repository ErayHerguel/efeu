import { getActiveEditor } from '../../editor/active';
import { Editor } from '../../editor/Editor';
import { BoardView } from '../board/BoardView';
import { BoardHeader } from './PageHeader';
import { DatabaseView } from '../database/DatabaseView';
import { PropertiesPanel } from '../database/PropertiesPanel';
import { cx } from '../../lib/cx';
import { GUEST } from '../../lib/mode';
import { usePages } from '../../store/pages';
import { Backlinks } from './Backlinks';
import { Cover } from './Cover';
import { PageHeader } from './PageHeader';

export function PageView({ id }: { id: string }) {
  const page = usePages((s) => s.pages[id]);
  const parentType = usePages((s) => (page?.parentId ? s.pages[page.parentId]?.type : undefined));
  if (!page || page.deletedAt !== null) return null;
  if (page.type === 'board') {
    return (
      <div className="flex h-full flex-col">
        <BoardHeader page={page} />
        <div className="min-h-0 flex-1 border-t border-border">
          <BoardView key={id} pageId={id} />
        </div>
      </div>
    );
  }
  const isDatabase = page.type === 'database';
  const width = page.fullWidth
    ? 'max-w-none'
    : isDatabase
      ? 'max-w-[calc(var(--container-wide)+7rem)]'
      : 'max-w-[calc(var(--container-content)+7rem)]';

  /** Klick in den leeren Bereich unter dem Text: Cursor ans Ende, bei Bedarf in eine neue leere Zeile (wie bei Notion). */
  const focusEnd = (e: React.MouseEvent) => {
    if (isDatabase || e.target !== e.currentTarget) return;
    const editor = getActiveEditor();
    if (!editor || !editor.isEditable || e.clientY < editor.view.dom.getBoundingClientRect().bottom) return;
    e.preventDefault();
    const last = editor.state.doc.lastChild;
    if (last?.type.name === 'paragraph' && last.content.size === 0) editor.commands.focus('end');
    else editor.chain().insertContentAt(editor.state.doc.content.size, { type: 'paragraph' }).focus('end').run();
  };

  return (
    <div className="h-full overflow-y-auto" data-scroll-container onMouseDown={focusEnd}>
      <Cover page={page} />
      <div className={cx('mx-auto w-full px-5 md:px-14', isDatabase ? 'pb-24' : 'pb-[40vh]', width)} onMouseDown={focusEnd}>
        <PageHeader page={page} />
        {isDatabase ? (
          <DatabaseView databaseId={id} />
        ) : (
          <>
            {parentType === 'database' && page.parentId && <PropertiesPanel databaseId={page.parentId} rowId={id} />}
            <div className="mt-4">
              <Editor key={id} pageId={id} />
            </div>
          </>
        )}
        {!GUEST && <Backlinks pageId={id} />}
      </div>
    </div>
  );
}
