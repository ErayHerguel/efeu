import { Extension, type Editor } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { IMAGE_EXTENSIONS, importFileBlob, importImageBlob } from '../lib/assets';
import { reportError } from '../store/toast';

const filesOf = (data: DataTransfer | null): File[] => (data ? [...data.files] : []);
const isImage = (file: File) => IMAGE_EXTENSIONS.includes((file.name.split('.').pop() ?? '').toLowerCase()) || /^image\/(png|jpeg|gif|webp)$/.test(file.type);

/** Bilder werden zu Bildblöcken, alle anderen Dateien zu Anhängen. */
async function insertImages(editor: Editor, files: File[], pos: number) {
  try {
    const nodes = await Promise.all(
      files.map(async (file) => {
        if (isImage(file)) return { type: 'image', attrs: { src: await importImageBlob(file, file.name) } };
        const stored = await importFileBlob(file, file.name);
        return { type: 'file', attrs: { src: stored.src, name: file.name, size: stored.size, preview: /\.pdf$/i.test(file.name) } };
      }),
    );
    if (editor.isDestroyed) return;
    editor.chain().focus().insertContentAt(pos, nodes).run();
  } catch (err) {
    reportError('Datei konnte nicht eingefügt werden', err);
  }
}

/** Bilder und Dateien aus Zwischenablage oder Finder werden in den App-Ordner kopiert und eingefügt. */
export const ImageInput = Extension.create({
  name: 'imageInput',
  addProseMirrorPlugins() {
    const editor = this.editor;
    return [
      new Plugin({
        key: new PluginKey('imageInput'),
        props: {
          handlePaste(view, event) {
            const files = filesOf(event.clipboardData);
            if (files.length === 0) return false;
            event.preventDefault();
            void insertImages(editor, files, view.state.selection.from);
            return true;
          },
          handleDrop(view, event, _slice, moved) {
            if (moved) return false;
            const files = filesOf(event.dataTransfer);
            if (files.length === 0) return false;
            event.preventDefault();
            const pos = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos ?? view.state.selection.from;
            void insertImages(editor, files, pos);
            return true;
          },
        },
      }),
    ];
  },
});
