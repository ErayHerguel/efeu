import { Node } from '@tiptap/core';
import { assetUrl, openAsset } from '../../lib/assets';
import { reportError } from '../../store/toast';
import { el } from '../dom';
import { isPdf, mountPdf, PDF_WIDTH } from './pdf';

const VIDEO = /\.(mp4|mov|m4v|webm)$/i;
const AUDIO = /\.(mp3|m4a|wav|aac|ogg|flac)$/i;

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1).replace('.', ',')} MB`;
}

/** Dateianhang im App-Ordner; Audio und Video werden direkt abgespielt, PDFs auf Wunsch als Seiten gezeigt, alles andere öffnet macOS. */
export const FileBlock = Node.create({
  name: 'file',
  group: 'block',
  atom: true,
  draggable: true,
  selectable: true,

  addAttributes() {
    return {
      src: { default: null },
      name: { default: 'Datei' },
      size: { default: 0 },
      /** PDF: Seiten direkt in der Seite zeigen (zum Lesen und Reinzeichnen) statt nur als Anhang */
      preview: { default: false },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'div[data-file]',
        getAttrs: (element) => ({
          src: element.getAttribute('data-file'),
          name: element.getAttribute('data-name') ?? 'Datei',
          size: Number(element.getAttribute('data-size')) || 0,
        }),
      },
    ];
  },

  renderHTML({ node }) {
    return ['div', { 'data-file': node.attrs.src, 'data-name': node.attrs.name, 'data-size': node.attrs.size }];
  },

  addNodeView() {
    return ({ node, getPos, editor }) => {
      const { src, name, size, preview } = node.attrs as { src: string; name: string; size: number; preview: boolean };
      const dom = el('div', 'file-block');
      dom.contentEditable = 'false';
      if (VIDEO.test(src) || AUDIO.test(src)) {
        const media = el(VIDEO.test(src) ? 'video' : 'audio');
        media.controls = true;
        media.preload = 'metadata';
        media.src = assetUrl(src);
        dom.append(media);
      }
      const chip = el('button', 'file-chip');
      chip.type = 'button';
      chip.title = 'Mit Standardprogramm öffnen';
      chip.innerHTML =
        '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="m16 6-8.414 8.586a2 2 0 0 0 2.829 2.829l8.414-8.586a4 4 0 1 0-5.657-5.657l-8.379 8.551a6 6 0 1 0 8.485 8.485l8.379-8.551"/></svg>';
      const label = el('span', 'file-name');
      label.textContent = name;
      const meta = el('span', 'file-size');
      meta.textContent = formatSize(size);
      chip.append(label, meta);
      chip.addEventListener('click', () => openAsset(src, name).catch((err) => reportError('Datei konnte nicht geöffnet werden', err)));
      dom.append(chip);
      let unmount: (() => void) | null = null;
      if (isPdf(name) || isPdf(src)) {
        const toggle = el('button', 'file-toggle');
        toggle.type = 'button';
        toggle.textContent = preview ? 'Seiten ausblenden' : 'Seiten zeigen';
        toggle.title = preview ? 'Nur als Anhang zeigen' : 'PDF-Seiten hier anzeigen, zum Lesen und Reinzeichnen';
        toggle.addEventListener('mousedown', (e) => e.preventDefault());
        toggle.addEventListener('click', () => {
          const pos = getPos();
          if (typeof pos !== 'number' || !editor.isEditable) return;
          editor.view.dispatch(editor.state.tr.setNodeAttribute(pos, 'preview', !preview));
        });
        const head = el('div', 'file-head');
        head.append(chip, toggle);
        dom.append(head);
        if (preview) {
          dom.classList.add('is-pdf');
          const pages = el('div', 'pdf-pages');
          pages.style.width = `${PDF_WIDTH}px`;
          dom.append(pages);
          unmount = mountPdf(pages, assetUrl(src));
        }
      }
      return {
        dom,
        update: (updated) =>
          updated.type.name === 'file' &&
          updated.attrs.src === src &&
          updated.attrs.preview === preview &&
          updated.attrs.name === name,
        destroy: () => unmount?.(),
        selectNode: () => dom.classList.add('is-selected'),
        deselectNode: () => dom.classList.remove('is-selected'),
        stopEvent: (event) => dom.querySelector('video, audio')?.contains(event.target as globalThis.Node) ?? false,
        ignoreMutation: () => true,
      };
    };
  },
});
