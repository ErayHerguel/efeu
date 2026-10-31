import type { PDFDocumentLoadingTask, PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { el } from '../dom';

/**
 * PDFs als Seiten direkt im Editor (pdf.js, Apache-2.0). Die Seiten haben eine feste Breite, damit
 * Zeichnungen darüber (Markieren, Pfeile, Randnotizen) bei jeder Fensterbreite an derselben Stelle liegen.
 * Gerendert wird erst, wenn eine Seite ins Bild kommt.
 */

export const PDF_WIDTH = 700;

type PdfLib = typeof import('pdfjs-dist/legacy/build/pdf.mjs');
let lib: Promise<PdfLib> | null = null;

/** pdf.js erst beim ersten PDF laden (hält den Start der App schlank). Legacy-Build: läuft auch unter macOS 13. */
function pdfjs(): Promise<PdfLib> {
  lib ??= Promise.all([import('pdfjs-dist/legacy/build/pdf.mjs'), import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url')]).then(([m, worker]) => {
    m.GlobalWorkerOptions.workerSrc = worker.default;
    return m;
  });
  return lib;
}

export const isPdf = (name: string) => /\.pdf$/i.test(name);

/** Zeigt alle Seiten der PDF in `container`. Liefert die Aufräumfunktion. */
export function mountPdf(container: HTMLElement, url: string): () => void {
  let destroyed = false;
  let doc: PDFDocumentProxy | null = null;
  let task: PDFDocumentLoadingTask | null = null;
  const rendered = new Set<number>();
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting || !doc) continue;
        const target = entry.target as HTMLElement;
        const number = Number(target.dataset.page);
        if (rendered.has(number)) continue;
        rendered.add(number);
        void doc.getPage(number).then((page) => renderPage(page, target));
      }
    },
    { rootMargin: '600px 0px' },
  );

  const status = el('div', 'pdf-status');
  status.textContent = 'PDF wird geladen …';
  container.append(status);

  (async () => {
    const pdf = await pdfjs();
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.arrayBuffer();
    if (destroyed) return;
    task = pdf.getDocument({ data });
    doc = await task.promise;
    if (destroyed) return void task.destroy();
    status.remove();
    for (let number = 1; number <= doc.numPages; number++) {
      const page = await doc.getPage(number);
      if (destroyed) return;
      const viewport = page.getViewport({ scale: 1 });
      const slot = el('div', 'pdf-page');
      slot.dataset.page = String(number);
      slot.style.aspectRatio = `${viewport.width} / ${viewport.height}`;
      const label = el('span', 'pdf-page-number');
      label.textContent = String(number);
      slot.append(label);
      container.append(slot);
      observer.observe(slot);
    }
  })().catch((err) => {
    if (destroyed) return;
    status.textContent = `PDF konnte nicht angezeigt werden (${err instanceof Error ? err.message : String(err)}).`;
    status.classList.add('is-error');
  });

  return () => {
    destroyed = true;
    observer.disconnect();
    void task?.destroy();
  };
}

async function renderPage(page: PDFPageProxy, slot: HTMLElement) {
  const base = page.getViewport({ scale: 1 });
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  const viewport = page.getViewport({ scale: (PDF_WIDTH / base.width) * ratio });
  const canvas = el('canvas', 'pdf-canvas');
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  const context = canvas.getContext('2d');
  if (!context) return;
  slot.prepend(canvas);
  await page.render({ canvas, canvasContext: context, viewport }).promise;
}
