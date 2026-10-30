import { useEffect, useRef, useState } from 'react';
import { Popover } from '../components/Popover';
import { renderMath, useMathEditor } from './nodes/math';

/** Eingabe für eine Formel (LaTeX) mit Vorschau. ↩ oder Klick daneben übernimmt, ⇧↩ neue Zeile. */
export function MathEditor() {
  const { pos, anchor, editor } = useMathEditor();
  const node = pos === null || !editor || editor.isDestroyed ? null : editor.state.doc.nodeAt(pos);
  if (pos === null || !anchor || !editor || !node || !node.type.name.startsWith('math')) return null;
  return <MathInput key={pos} initial={String(node.attrs.latex ?? '')} display={node.type.name === 'mathBlock'} anchor={anchor} />;
}

function MathInput({ initial, display, anchor }: { initial: string; display: boolean; anchor: NonNullable<ReturnType<typeof useMathEditor.getState>['anchor']> }) {
  const [value, setValue] = useState(initial);
  const preview = useRef<HTMLDivElement>(null);
  const done = useRef(false);

  useEffect(() => {
    if (preview.current) renderMath(preview.current, value, display);
  }, [value, display]);

  /** Übernehmen: leere Formel wird entfernt; danach Cursor hinter die Formel. */
  const finish = () => {
    if (done.current) return;
    done.current = true;
    const { editor, pos } = useMathEditor.getState();
    useMathEditor.setState({ pos: null, anchor: null, editor: null });
    if (!editor || pos === null || editor.isDestroyed) return;
    const node = editor.state.doc.nodeAt(pos);
    if (!node) return;
    const latex = value.trim();
    const chain = editor.chain().focus();
    if (!latex) chain.deleteRange({ from: pos, to: pos + node.nodeSize }).run();
    else {
      if (latex !== node.attrs.latex) chain.command(({ tr }) => (tr.setNodeAttribute(pos, 'latex', latex), true));
      chain.setTextSelection(pos + node.nodeSize).run();
    }
  };

  return (
    <Popover anchor={anchor} onClose={() => finish()}>
      <div className="flex w-[360px] flex-col gap-2 p-2">
        <textarea
          autoFocus
          rows={display ? 3 : 1}
          value={value}
          spellCheck={false}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              finish();
            }
          }}
          placeholder={display ? '\\int_0^1 x^2\\,dx = \\frac{1}{3}' : 'a^2 + b^2 = c^2'}
          className="resize-none rounded-md bg-bg p-2 font-mono text-sm outline-none placeholder:text-faint"
        />
        <div ref={preview} className="math-preview min-h-6 overflow-x-auto px-1 text-center" />
        <div className="flex items-center justify-between text-2xs text-faint">
          <span>LaTeX · ↩ übernehmen · ⇧↩ neue Zeile</span>
          <button onClick={() => finish()} className="h-7 rounded-md bg-accent px-2 text-xs font-medium text-accent-fg">
            Fertig
          </button>
        </div>
      </div>
    </Popover>
  );
}
