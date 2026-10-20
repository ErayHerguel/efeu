import './assetPath';
import '@excalidraw/excalidraw/index.css';
import {
  CaptureUpdateAction,
  convertToExcalidrawElements,
  Excalidraw,
  exportToBlob,
  exportToSvg,
  FONT_FAMILY,
  MainMenu,
  reconcileElements,
  restoreElements,
} from '@excalidraw/excalidraw';
import type { BinaryFiles, Collaborator, ExcalidrawImperativeAPI, ExcalidrawInitialDataState, SocketId } from '@excalidraw/excalidraw/types';
import { StickyNote } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { flush } from '../../db/saveQueue';
import { saveBlob } from '../../lib/download';
import { usePages } from '../../store/pages';
import { reportError, toast } from '../../store/toast';
import type { BoardFile } from '../collab/protocol';
import { useCanEdit, useCollab, type BoardBinding, type BoardElement, type BoardEvents, type BoardSource, type RemotePointer } from '../collab/sources';
import { sanitizeName } from '../transfer/exportPlan';
import { loadFiles, toBlob } from './files';
import { localBoard } from './localBoard';
import { useActiveBoard } from './active';
import { createBridge } from './aiBridge';

/** Farben der Sticky Notes (wie FigJam: kräftig, aber nicht grell). */
const STICKY_COLORS = [
  { name: 'Gelb', color: '#fff3a3' },
  { name: 'Grün', color: '#c8f0c5' },
  { name: 'Blau', color: '#c7e3ff' },
  { name: 'Rosa', color: '#ffd1e0' },
  { name: 'Lila', color: '#e3d4ff' },
];

/** Sauberer Stil statt Handzeichnung: glatte Linien, Nunito, abgerundete Ecken. */
const CLEAN_DEFAULTS = {
  currentItemRoughness: 0,
  currentItemFontFamily: FONT_FAMILY.Nunito,
  currentItemRoundness: 'round' as const,
  currentItemStrokeWidth: 1,
};

/** Änderungen und Mauszeiger werden höchstens so oft weitergegeben. */
const SEND_MS = 40;

const EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/svg+xml': 'svg' };

export default function BoardCanvas({ pageId }: { pageId: string }) {
  const shared = useCollab((s) => s.boards);
  const epoch = useCollab((s) => s.epoch);
  const source = shared ?? localBoard;
  return <Canvas key={`${shared ? 'shared' : 'local'}-${epoch}`} pageId={pageId} source={source} />;
}

function Canvas({ pageId, source }: { pageId: string; source: BoardSource }) {
  const editable = useCanEdit(pageId);
  const [initial, setInitial] = useState<ExcalidrawInitialDataState | null>(null);
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null);
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);
  const binding = useRef<BoardBinding | null>(null);
  /** Zuletzt gesendete oder empfangene Version je Element: verhindert Echos. */
  const known = useRef(new Map<string, number>());
  const fileIds = useRef(new Set<string>());
  const background = useRef('#ffffff');
  const outgoing = useRef(new Map<string, BoardElement>());
  const sendTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pointerTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const collaborators = useRef(new Map<SocketId, Collaborator>());
  /** Ereignisse, die vor dem Start von Excalidraw ankommen */
  const backlog = useRef<((api: ExcalidrawImperativeAPI) => void)[]>([]);

  const withApi = (fn: (api: ExcalidrawImperativeAPI) => void) => {
    if (apiRef.current) fn(apiRef.current);
    else backlog.current.push(fn);
  };

  useEffect(() => {
    let alive = true;
    let bound: BoardBinding | null = null;

    const events: BoardEvents = {
      elements: (elements) =>
        withApi((excalidraw) => {
          const remote = restoreElements(elements as never, null);
          const merged = reconcileElements(excalidraw.getSceneElementsIncludingDeleted(), remote as never, excalidraw.getAppState());
          excalidraw.updateScene({ elements: merged, captureUpdate: CaptureUpdateAction.NEVER });
          const ids = new Set(remote.map((e) => e.id));
          for (const e of excalidraw.getSceneElementsIncludingDeleted()) if (ids.has(e.id)) known.current.set(e.id, e.version);
        }),
      files: (files) => {
        for (const id of Object.keys(files)) fileIds.current.add(id);
        void loadFiles(files).then((loaded) => withApi((excalidraw) => excalidraw.addFiles(loaded)));
      },
      pointer: (p: RemotePointer) =>
        withApi((excalidraw) => {
          collaborators.current.set(p.person as SocketId, {
            username: p.name,
            color: { background: p.color, stroke: p.color },
            pointer: { x: p.x, y: p.y, tool: p.tool },
            button: p.button,
            id: p.person,
          });
          excalidraw.updateScene({ collaborators: new Map(collaborators.current) });
        }),
      leave: (person) =>
        withApi((excalidraw) => {
          if (!collaborators.current.delete(person as SocketId)) return;
          excalidraw.updateScene({ collaborators: new Map(collaborators.current) });
        }),
    };

    source(pageId, events)
      .then(async (b) => {
        if (!alive) return b.release();
        bound = b;
        binding.current = b;
        const { elements, files, background: bg } = b.snapshot;
        for (const e of elements) known.current.set(e.id, e.version);
        for (const id of Object.keys(files)) fileIds.current.add(id);
        background.current = bg;
        const loaded = await loadFiles(files);
        if (!alive) return;
        setInitial({
          elements: elements as never,
          files: Object.fromEntries(loaded.map((f) => [f.id, f])),
          appState: { ...CLEAN_DEFAULTS, viewBackgroundColor: bg },
          scrollToContent: true,
        });
      })
      .catch((err) => reportError('Board konnte nicht geladen werden', err));

    return () => {
      alive = false;
      if (sendTimer.current) clearTimeout(sendTimer.current);
      if (pointerTimer.current) clearTimeout(pointerTimer.current);
      sendOutgoing();
      bound?.release();
      binding.current = null;
      void flush();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- einmal pro Board und Quelle
  }, [pageId, source]);

  useEffect(() => {
    apiRef.current = api;
    if (!api) return;
    for (const fn of backlog.current.splice(0)) fn(api);
  }, [api]);

  // KI-Funktionen erreichen das Board nur, solange es offen und bearbeitbar ist.
  useEffect(() => {
    if (!api || !editable) return;
    const bridge = createBridge(pageId, api);
    useActiveBoard.setState({ bridge });
    return () => {
      if (useActiveBoard.getState().bridge === bridge) useActiveBoard.setState({ bridge: null });
    };
  }, [api, editable, pageId]);

  function sendOutgoing() {
    sendTimer.current = null;
    const b = binding.current;
    if (!b) return;
    const changed = [...outgoing.current.values()];
    outgoing.current.clear();
    b.change(changed, background.current);
  }

  const onChange = (elements: readonly unknown[], appState: { viewBackgroundColor: string }, files: BinaryFiles) => {
    if (!binding.current) return;
    let dirty = appState.viewBackgroundColor !== background.current;
    background.current = appState.viewBackgroundColor;
    for (const element of elements as BoardElement[]) {
      if (known.current.get(element.id) === element.version) continue;
      known.current.set(element.id, element.version);
      outgoing.current.set(element.id, element);
      dirty = true;
    }
    if (dirty && !sendTimer.current) sendTimer.current = setTimeout(sendOutgoing, SEND_MS);
    const added = Object.values(files).filter((f) => !fileIds.current.has(f.id));
    if (added.length) void storeFiles(added);
  };

  async function storeFiles(files: BinaryFiles[string][]) {
    const b = binding.current;
    if (!b) return;
    for (const f of files) fileIds.current.add(f.id);
    try {
      const mapping: Record<string, BoardFile> = {};
      for (const f of files) {
        const asset = await b.storeImage(await toBlob(f.dataURL), `${f.id}.${EXT[f.mimeType] ?? 'png'}`);
        mapping[f.id] = { asset, mimeType: f.mimeType };
      }
      b.addFiles(mapping);
    } catch (err) {
      for (const f of files) fileIds.current.delete(f.id);
      reportError('Bild konnte nicht gespeichert werden', err);
    }
  }

  const onPointerUpdate = ({ pointer, button }: { pointer: { x: number; y: number; tool: 'pointer' | 'laser' }; button: 'up' | 'down' }) => {
    if (pointerTimer.current) return;
    pointerTimer.current = setTimeout(() => {
      pointerTimer.current = null;
    }, SEND_MS);
    binding.current?.pointer(pointer.x, pointer.y, pointer.tool, button);
  };

  const addSticky = (color: string) => {
    if (!api) return;
    const { scrollX, scrollY, zoom, width, height } = api.getAppState();
    const cx = width / 2 / zoom.value - scrollX;
    const cy = height / 2 / zoom.value - scrollY;
    const offset = (api.getSceneElements().length % 6) * 16;
    const [sticky] = convertToExcalidrawElements([
      {
        type: 'rectangle',
        x: cx - 100 + offset,
        y: cy - 100 + offset,
        width: 200,
        height: 200,
        backgroundColor: color,
        fillStyle: 'solid',
        strokeColor: 'transparent',
        strokeWidth: 1,
        roughness: 0,
        roundness: { type: 3 },
      },
    ]);
    api.updateScene({
      elements: [...api.getSceneElementsIncludingDeleted(), sticky],
      appState: { selectedElementIds: { [sticky.id]: true } },
    });
    api.setActiveTool({ type: 'selection' });
    toast('Doppelklick auf die Notiz, um zu schreiben');
  };

  const exportImage = async (format: 'png' | 'svg') => {
    if (!api) return;
    const title = usePages.getState().pages[pageId]?.title || 'Board';
    try {
      const options = {
        elements: api.getSceneElements(),
        appState: { ...api.getAppState(), exportBackground: true, exportWithDarkMode: false },
        files: api.getFiles(),
      };
      const blob =
        format === 'png'
          ? await exportToBlob({ ...options, mimeType: 'image/png', exportPadding: 24 })
          : new Blob([(await exportToSvg({ ...options, exportPadding: 24 })).outerHTML], { type: 'image/svg+xml' });
      const saved = await saveBlob(blob, `${sanitizeName(title)}.${format}`, { name: format.toUpperCase(), extensions: [format] });
      if (saved) toast(`Als ${format.toUpperCase()} exportiert`);
    } catch (err) {
      reportError('Export fehlgeschlagen', err);
    }
  };

  if (!initial) return null;

  return (
    <div className="efeu-board h-full w-full">
      <Excalidraw
        excalidrawAPI={setApi}
        initialData={initial}
        onChange={onChange as never}
        onPointerUpdate={onPointerUpdate}
        viewModeEnabled={!editable}
        // Wie bei FigJam bleibt die Fläche hell, damit Sticky Notes ihre echten Farben zeigen.
        theme="light"
        langCode="de-DE"
        UIOptions={{
          canvasActions: { loadScene: false, saveToActiveFile: false, export: false, saveAsImage: false, toggleTheme: false },
        }}
        renderTopRightUI={() =>
          editable ? (
            <div className="flex items-center gap-1 rounded-lg bg-surface p-1 shadow-popover">
              <StickyNote size={15} className="mx-1 text-muted" aria-hidden />
              {STICKY_COLORS.map((s) => (
                <button
                  key={s.color}
                  title={`Sticky Note (${s.name})`}
                  aria-label={`Sticky Note ${s.name}`}
                  onClick={() => addSticky(s.color)}
                  className="h-6 w-6 rounded-sm border border-black/10 transition-transform hover:scale-110"
                  style={{ background: s.color }}
                />
              ))}
            </div>
          ) : null
        }
      >
        <MainMenu>
          <MainMenu.Item onSelect={() => void exportImage('png')}>Als PNG exportieren …</MainMenu.Item>
          <MainMenu.Item onSelect={() => void exportImage('svg')}>Als SVG exportieren …</MainMenu.Item>
          {editable && (
            <>
              <MainMenu.Separator />
              <MainMenu.DefaultItems.ChangeCanvasBackground />
              <MainMenu.DefaultItems.ClearCanvas />
            </>
          )}
        </MainMenu>
      </Excalidraw>
    </div>
  );
}
