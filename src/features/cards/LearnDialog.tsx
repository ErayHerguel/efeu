import { Layers, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { IconButton } from '../../components/IconButton';
import { Modal } from '../../components/Modal';
import { commit } from '../../db/saveQueue';
import { usePages } from '../../store/pages';
import { reportError } from '../../store/toast';
import { useUI } from '../../store/ui';
import { dueQueue, loadCards, saveReview, type StudyCard } from './cards';
import { countDue, useLearn } from './learn';
import { nextLabel, schedule, type Grade } from './schedule';

const GRADES: { grade: Grade; label: string; className: string }[] = [
  { grade: 1, label: 'Nochmal', className: 'text-danger' },
  { grade: 2, label: 'Schwer', className: 'text-[#f76b15]' },
  { grade: 3, label: 'Gut', className: 'text-[#30a46c]' },
  { grade: 4, label: 'Einfach', className: 'text-accent' },
];

/** Karteikarten lernen: Frage, Antwort zeigen (Leertaste), bewerten (1–4). */
export function LearnDialog() {
  const rootId = useLearn((s) => s.rootId);
  const deckTitle = usePages((s) => (rootId ? s.pages[rootId]?.title || 'Ohne Titel' : null));
  const [queue, setQueue] = useState<StudyCard[] | null>(null);
  const [total, setTotal] = useState(0);
  const [nextDue, setNextDue] = useState<number | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [done, setDone] = useState(0);
  const close = () => {
    useUI.getState().setOverlay(null);
    void countDue();
  };

  useEffect(() => {
    loadCards(rootId)
      .then((cards) => {
        const q = dueQueue(cards);
        setQueue(q);
        setTotal(cards.length);
        const later = cards.filter((c) => !c.isNew && c.review.due > Date.now()).map((c) => c.review.due);
        setNextDue(later.length ? Math.min(...later) : null);
      })
      .catch((err) => reportError('Karten konnten nicht geladen werden', err));
  }, [rootId]);

  const card = queue?.[0];

  const rate = (grade: Grade) => {
    if (!card || !queue) return;
    const now = Date.now();
    const review = schedule(card.review, grade, now);
    commit([saveReview(card, review)]).catch((err) => reportError('Lernstand nicht gespeichert', err));
    // „Nochmal“: in dieser Runde später noch einmal
    const rest = queue.slice(1);
    setQueue(grade === 1 ? [...rest, { ...card, review, isNew: false }] : rest);
    if (grade !== 1) setDone((n) => n + 1);
    setRevealed(false);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!card || e.metaKey || e.ctrlKey || e.altKey) return;
      if (!revealed && (e.key === ' ' || e.key === 'Enter')) {
        e.preventDefault();
        setRevealed(true);
      } else if (revealed && ['1', '2', '3', '4'].includes(e.key)) {
        e.preventDefault();
        rate(Number(e.key) as Grade);
      } else if (revealed && (e.key === ' ' || e.key === 'Enter')) {
        e.preventDefault();
        rate(3);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const open = () => {
    if (!card) return;
    close();
    useUI.getState().open(card.pageId);
  };

  return (
    <Modal onClose={close} position="center" className="flex h-[min(560px,85vh)] w-[640px] max-w-full flex-col">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-4">
        <Layers size={16} className="text-muted" />
        <h2 className="flex-1 truncate text-sm font-semibold">{deckTitle ? `Lernen: ${deckTitle}` : 'Lernen'}</h2>
        {queue && queue.length > 0 && <span className="text-xs text-faint">{queue.length} übrig</span>}
        <IconButton icon={X} label="Schließen" onClick={close} />
      </div>
      {!queue ? (
        <div className="flex flex-1 items-center justify-center text-sm text-muted">Lade Karten …</div>
      ) : !card ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center">
          {total === 0 ? (
            <>
              <h3 className="text-lg font-semibold">Noch keine Karteikarten</h3>
              <p className="max-w-[420px] text-sm text-muted">
                Schreib in eine Seite eine Zeile wie <code className="rounded bg-code px-1">Hauptstadt von Frankreich :: Paris</code> oder einen
                Toggle-Block, dessen Überschrift eine Frage ist (mit „?“ am Ende); der Inhalt ist die Antwort.
              </p>
            </>
          ) : (
            <>
              <h3 className="text-lg font-semibold">{done ? 'Geschafft!' : 'Alles gelernt'}</h3>
              <p className="text-sm text-muted">
                {done ? `${done} Karten wiederholt. ` : ''}
                {nextDue ? `Die nächste Karte ist ${new Date(nextDue).toLocaleString('de-DE', { weekday: 'long', hour: '2-digit', minute: '2-digit' })} fällig.` : ''}
              </p>
            </>
          )}
        </div>
      ) : (
        <>
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-6 overflow-y-auto p-8 text-center">
            <div className="text-xl font-medium whitespace-pre-wrap">{card.front}</div>
            {revealed && (
              <>
                <div className="h-px w-24 bg-border" />
                <div className="text-lg whitespace-pre-wrap text-muted">{card.back}</div>
              </>
            )}
          </div>
          <div className="shrink-0 border-t border-border p-4">
            {revealed ? (
              <div className="grid grid-cols-4 gap-2">
                {GRADES.map(({ grade, label, className }) => (
                  <button key={grade} onClick={() => rate(grade)} className="flex h-14 flex-col items-center justify-center rounded-md border border-border hover:bg-hover">
                    <span className={`text-sm font-medium ${className}`}>{label}</span>
                    <span className="text-xs text-faint">
                      {nextLabel(card.review, grade, Date.now())} · {grade}
                    </span>
                  </button>
                ))}
              </div>
            ) : (
              <button onClick={() => setRevealed(true)} className="flex h-14 w-full items-center justify-center rounded-md bg-accent text-sm font-medium text-accent-fg">
                Antwort zeigen (Leertaste)
              </button>
            )}
            <button onClick={open} className="mt-2 w-full text-center text-xs text-faint hover:text-muted">
              Aus „{usePages.getState().pages[card.pageId]?.title || 'Ohne Titel'}“ · Seite öffnen
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}
