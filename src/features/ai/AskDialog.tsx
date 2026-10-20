import { writeText } from '@tauri-apps/plugin-clipboard-manager';
import { Copy, FilePlus2, Globe, Loader2, Search, Sparkles, Square } from 'lucide-react';
import { useRef, useState, type ReactNode } from 'react';
import { create } from 'zustand';
import { Modal } from '../../components/Modal';
import { cx } from '../../lib/cx';
import { usePages } from '../../store/pages';
import { reportError, toast } from '../../store/toast';
import { useUI } from '../../store/ui';
import { askRequest, gatherContext, researchRequest, saveAnswerAsPage, type ContextPage } from './ask';
import { AiCancelled, askAi, costNote, type AiResult } from './client';
import { cleanAnswer } from './markdown';

type Mode = 'ask' | 'research';

const useAsk = create<{ mode: Mode | null }>(() => ({ mode: null }));

export function openAsk(mode: Mode): void {
  useAsk.setState({ mode });
}

/** [[Titel]] im Antworttext als Link zur Seite */
function RichAnswer({ text }: { text: string }) {
  const pages = usePages((s) => s.pages);
  const parts: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(/\[\[([^[\]]+)\]\]/g)) {
    parts.push(text.slice(last, match.index));
    const title = match[1].trim();
    const page = Object.values(pages).find((p) => p.deletedAt === null && p.title.trim().toLocaleLowerCase('de') === title.toLocaleLowerCase('de'));
    parts.push(
      page ? (
        <button
          key={match.index}
          onClick={() => {
            useAsk.setState({ mode: null });
            useUI.getState().open(page.id);
          }}
          className="text-accent underline decoration-accent/40 underline-offset-2 hover:decoration-accent"
        >
          {title}
        </button>
      ) : (
        <span key={match.index} className="font-medium">
          {title}
        </span>
      ),
    );
    last = (match.index ?? 0) + match[0].length;
  }
  parts.push(text.slice(last));
  return <>{parts}</>;
}

export function AskDialog() {
  const mode = useAsk((s) => s.mode);
  if (!mode) return null;
  return <Dialog key={mode} initialMode={mode} />;
}

function Dialog({ initialMode }: { initialMode: Mode }) {
  const [mode, setMode] = useState<Mode>(initialMode);
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState('');
  const [result, setResult] = useState<AiResult | null>(null);
  const [sources, setSources] = useState<ContextPage[]>([]);
  const [status, setStatus] = useState<'idle' | 'searching' | 'running' | 'done'>('idle');
  const controller = useRef<AbortController | null>(null);

  const close = () => {
    controller.current?.abort();
    useAsk.setState({ mode: null });
  };

  const run = async () => {
    const q = question.trim();
    if (!q) return;
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    setAnswer('');
    setResult(null);
    setSources([]);
    try {
      let request;
      if (mode === 'ask') {
        setStatus('searching');
        const context = await gatherContext(q, useUI.getState().currentId);
        setSources(context);
        request = askRequest(q, context);
      } else request = researchRequest(q);
      const res = await askAi(request, {
        signal: abort.signal,
        onStart: () => setStatus('running'),
        onText: (_d, full) => setAnswer(full),
      });
      if (!res) {
        setStatus('idle');
        return;
      }
      setAnswer(cleanAnswer(res.text));
      setResult(res);
      setStatus('done');
    } catch (err) {
      setStatus('idle');
      if (!(err instanceof AiCancelled)) reportError(mode === 'ask' ? 'Frag efeu' : 'Recherche', err);
    }
  };

  const save = async () => {
    if (!result) return;
    try {
      const id = await saveAnswerAsPage(question.trim(), cleanAnswer(result.text), result.citations);
      useAsk.setState({ mode: null });
      useUI.getState().open(id);
      toast('Als Seite gespeichert');
    } catch (err) {
      reportError('Speichern', err);
    }
  };

  const busy = status === 'searching' || status === 'running';

  return (
    <Modal onClose={close} className="flex max-h-[76vh] w-[640px] flex-col">
      <div className="flex items-center gap-2 border-b border-border px-4 py-3">
        <Sparkles size={16} className="shrink-0 text-accent" />
        <input
          autoFocus
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !busy) {
              e.preventDefault();
              void run();
            }
          }}
          placeholder={mode === 'ask' ? 'Frag etwas über deine Notizen …' : 'Was soll Claude im Web recherchieren?'}
          className="h-8 min-w-0 flex-1 bg-transparent text-[15px] outline-none placeholder:text-faint"
        />
      </div>
      <div className="flex gap-1 border-b border-border px-3 py-2">
        {(
          [
            ['ask', 'Aus meinen Seiten', Search],
            ['research', 'Im Web recherchieren', Globe],
          ] as const
        ).map(([id, label, Icon]) => (
          <button
            key={id}
            onClick={() => setMode(id)}
            disabled={busy}
            className={cx('flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs', mode === id ? 'bg-active font-medium' : 'text-muted hover:bg-hover')}
          >
            <Icon size={13} /> {label}
          </button>
        ))}
        <span className="ml-auto self-center text-xs text-faint">
          {mode === 'ask' ? 'Nur deine passendsten Seiten gehen an Claude' : 'Bis zu 5 Websuchen, je 1 Cent'}
        </span>
      </div>

      <div className="min-h-[120px] flex-1 overflow-y-auto px-5 py-4 text-sm leading-relaxed whitespace-pre-wrap">
        {status === 'idle' && !answer && (
          <p className="text-faint">
            {mode === 'ask'
              ? 'Zum Beispiel: „Was war nochmal die Empfehlung für den Design Brief?“ oder „Welche Aufgaben sind noch offen?“'
              : 'Zum Beispiel: „Aktuelle Studien zu Stress beim Pendeln“. Das Ergebnis kannst du mit Quellen als Seite speichern.'}
          </p>
        )}
        {status === 'searching' && <p className="text-faint">Suche passende Seiten …</p>}
        {status === 'running' && !answer && <p className="text-faint">{mode === 'research' ? 'Claude recherchiert im Web …' : 'Claude liest deine Seiten …'}</p>}
        {answer && <RichAnswer text={answer} />}
        {result && result.citations.length > 0 && (
          <div className="mt-4 border-t border-border pt-3 whitespace-normal">
            <div className="mb-1 text-xs font-medium text-faint">Quellen</div>
            <ul className="space-y-0.5">
              {result.citations.map((c) => (
                <li key={c.url} className="truncate text-xs">
                  <a href={c.url} className="text-accent hover:underline">
                    {c.title || c.url}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      <div className="flex items-center gap-2 border-t border-border px-4 py-2.5">
        <span className="min-w-0 truncate text-xs text-faint">
          {result
            ? `${costNote(result)}${mode === 'ask' && sources.length ? ` · ${sources.length} Seiten gelesen` : ''}${result.usage.webSearches ? ` · ${result.usage.webSearches} Suchen` : ''}`
            : busy
              ? 'läuft …'
              : ''}
        </span>
        <div className="flex-1" />
        {busy && <Loader2 size={14} className="animate-spin text-faint" />}
        {busy ? (
          <button onClick={() => controller.current?.abort()} className="flex h-7 items-center gap-1.5 rounded-md border border-border px-2.5 text-xs hover:bg-hover">
            <Square size={11} /> Stopp
          </button>
        ) : result ? (
          <>
            <button
              onClick={() =>
                void writeText(cleanAnswer(result.text))
                  .then(() => toast('Antwort kopiert'))
                  .catch((err) => reportError('Kopieren', err))
              }
              className="flex h-7 items-center gap-1.5 rounded-md border border-border px-2.5 text-xs hover:bg-hover"
            >
              <Copy size={12} /> Kopieren
            </button>
            <button onClick={() => void save()} className="flex h-7 items-center gap-1.5 rounded-md bg-accent px-2.5 text-xs font-medium text-accent-fg">
              <FilePlus2 size={12} /> Als Seite speichern
            </button>
          </>
        ) : (
          <button
            onClick={() => void run()}
            disabled={!question.trim()}
            className="h-7 rounded-md bg-accent px-3 text-xs font-medium text-accent-fg disabled:opacity-50"
          >
            {mode === 'ask' ? 'Fragen' : 'Recherchieren'}
          </button>
        )}
      </div>
    </Modal>
  );
}
