import type { JSONContent } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { EditorContent, useEditor, type Editor as TiptapEditor } from '@tiptap/react';
import { useEffect, useMemo, useState } from 'react';
import { loadDoc, saveContent } from '../db/content';
import { flush, schedule } from '../db/saveQueue';
import { useCanEdit, useCollab, type DocBinding } from '../features/collab/sources';
import { collectLinkTargets } from '../lib/doc';
import { usePages } from '../store/pages';
import { useUI } from '../store/ui';
import { setActiveEditor } from './active';
import { createExtensions } from './extensions';
import { docText } from './text';
import { CommentBubble, TableMenu, Toolbar } from './Toolbar';

type LoadState = { status: 'loading' } | { status: 'ready'; doc: JSONContent | null } | { status: 'error'; message: string };

const titleOf = (id: string) => usePages.getState().pages[id]?.title ?? '';

/** Plant das Speichern. Das PM-Dokument ist unveränderlich, daher ist die Momentaufnahme gratis. */
function scheduleSave(pageId: string, doc: PMNode) {
  schedule(`content:${pageId}`, () => {
    const json = doc.toJSON() as JSONContent;
    return saveContent(pageId, json, docText(doc, titleOf), collectLinkTargets(json, pageId), Date.now());
  });
}

export function Editor({ pageId }: { pageId: string }) {
  const docs = useCollab((s) => s.docs);
  const epoch = useCollab((s) => s.epoch);
  // Gemeinsames Arbeiten: Inhalt kommt aus dem geteilten Dokument statt aus der Datenbank.
  if (docs) return <SharedEditor key={epoch} pageId={pageId} source={docs} />;
  return <LocalEditor pageId={pageId} />;
}

function LocalEditor({ pageId }: { pageId: string }) {
  const [state, setState] = useState<LoadState>({ status: 'loading' });

  useEffect(() => {
    let alive = true;
    loadDoc(pageId)
      .then((doc) => alive && setState({ status: 'ready', doc }))
      .catch((err) => alive && setState({ status: 'error', message: String(err) }));
    return () => {
      alive = false;
    };
  }, [pageId]);

  if (state.status === 'loading') return null;
  if (state.status === 'error') {
    return (
      <div className="rounded-md border border-danger px-4 py-3 text-sm text-danger">
        Der Inhalt dieser Seite konnte nicht geladen werden. Er wurde nicht verändert. ({state.message})
      </div>
    );
  }
  return <LoadedEditor pageId={pageId} initial={state.doc} />;
}

function LoadedEditor({ pageId, initial }: { pageId: string; initial: JSONContent | null }) {
  const extensions = useMemo(() => createExtensions(pageId), [pageId]);
  const editor = useEditor({
    extensions,
    content: initial,
    immediatelyRender: true,
    shouldRerenderOnTransaction: false,
    editorProps: { attributes: { class: 'efeu-editor', spellcheck: 'true' } },
    onUpdate: ({ editor: e }) => scheduleSave(pageId, e.state.doc),
  });
  return <EditorChrome pageId={pageId} editor={editor} />;
}

function SharedEditor({ pageId, source }: { pageId: string; source: (pageId: string) => Promise<DocBinding> }) {
  const [binding, setBinding] = useState<DocBinding | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    let acquired: DocBinding | null = null;
    source(pageId)
      .then((b) => {
        if (!alive) return b.release();
        acquired = b;
        setBinding(b);
      })
      .catch((err) => alive && setError(err instanceof Error ? err.message : String(err)));
    return () => {
      alive = false;
      acquired?.release();
    };
  }, [pageId, source]);

  if (error) {
    return <div className="rounded-md border border-danger px-4 py-3 text-sm text-danger">Diese Seite konnte nicht geöffnet werden. ({error})</div>;
  }
  if (!binding) return null;
  return <BoundEditor pageId={pageId} binding={binding} />;
}

function BoundEditor({ pageId, binding }: { pageId: string; binding: DocBinding }) {
  const editable = useCanEdit(pageId);
  const extensions = useMemo(() => createExtensions(pageId, binding), [pageId, binding]);
  const editor = useEditor({
    extensions,
    editable,
    immediatelyRender: true,
    shouldRerenderOnTransaction: false,
    editorProps: { attributes: { class: 'efeu-editor', spellcheck: 'true' } },
  });
  useEffect(() => {
    if (editor.isEditable !== editable) editor.setEditable(editable);
  }, [editor, editable]);
  return <EditorChrome pageId={pageId} editor={editor} />;
}

function EditorChrome({ pageId, editor }: { pageId: string; editor: TiptapEditor }) {
  useEffect(() => {
    setActiveEditor(editor);
    return () => {
      setActiveEditor(null);
      void flush();
    };
  }, [editor]);

  const pendingFocus = useUI((s) => s.pendingFocus);
  useEffect(() => {
    if (useUI.getState().consumeFocus(pageId, 'editor')) editor.commands.focus('start');
  }, [pendingFocus, pageId, editor]);

  return (
    <>
      <EditorContent editor={editor} className="relative" />
      <Toolbar editor={editor} />
      <CommentBubble editor={editor} />
      <TableMenu editor={editor} />
    </>
  );
}
