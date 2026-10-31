import katex from 'katex';
import { Check, ExternalLink, GraduationCap, Loader2, X } from 'lucide-react';
import { Fragment, useEffect, useMemo, useState } from 'react';
import { create } from 'zustand';
import { IconButton } from '../../components/IconButton';
import { Modal } from '../../components/Modal';
import { cx } from '../../lib/cx';
import { usePages } from '../../store/pages';
import { reportError, toast } from '../../store/toast';
import { useUI } from '../../store/ui';
import { AiCancelled, costNote } from '../ai/client';
import {
  examGrade,
  examHistory,
  generateExam,
  gradeChoice,
  gradeOpen,
  rememberExam,
  saveAsCards,
  type ExamLevel,
  type ExamMix,
  type Graded,
  type Question,
} from './exam';

export const useExam = create<{ rootId: string | null }>(() => ({ rootId: null }));

/** Probeklausur zu einer Seite (samt Unterseiten) öffnen. */
export function startExam(rootId: string): void {
  useExam.setState({ rootId });
  useUI.getState().setOverlay('exam');
}

/** Text mit Formeln ($…$) als KaTeX. */
function MathText({ text }: { text: string }) {
  const parts = useMemo(() => text.split(/(\$[^$\n]+\$)/g), [text]);
  return (
    <>
      {parts.map((part, i) =>
        /^\$[^$\n]+\$$/.test(part) ? (
          <span key={i} dangerouslySetInnerHTML={{ __html: katex.renderToString(part.slice(1, -1), { throwOnError: false, trust: false }) }} />
        ) : (
          <Fragment key={i}>{part}</Fragment>
        ),
      )}
    </>
  );
}

type Phase = 'setup' | 'creating' | 'answering' | 'grading' | 'results';

export function ExamDialog() {
  const rootId = useExam((s) => s.rootId);
  const title = usePages((s) => (rootId ? s.pages[rootId]?.title || 'Ohne Titel' : ''));
  const [phase, setPhase] = useState<Phase>('setup');
  const [count, setCount] = useState(10);
  const [mix, setMix] = useState<ExamMix>('mixed');
  const [level, setLevel] = useState<ExamLevel>('normal');
  const [questions, setQuestions] = useState<Question[]>([]);
  const [index, setIndex] = useState(0);
  const [picked, setPicked] = useState<(number | null)[]>([]);
  const [written, setWritten] = useState<string[]>([]);
  const [graded, setGraded] = useState<Graded[]>([]);
  const [startedAt, setStartedAt] = useState(0);
  const [saved, setSaved] = useState(false);
  const history = useMemo(() => (rootId ? examHistory(rootId) : []), [rootId, phase]);
  const close = () => useUI.getState().setOverlay(null);

  const create = async () => {
    if (!rootId) return;
    setPhase('creating');
    try {
      const made = await generateExam(rootId, count, mix, level);
      if (!made) return setPhase('setup');
      setQuestions(made.questions);
      setPicked(made.questions.map(() => null));
      setWritten(made.questions.map(() => ''));
      setIndex(0);
      setStartedAt(Date.now());
      setPhase('answering');
      toast(`${made.questions.length} Fragen · ${costNote(made.result)}`);
    } catch (err) {
      setPhase('setup');
      if (!(err instanceof AiCancelled)) reportError('Probeklausur erstellen', err);
    }
  };

  const submit = async () => {
    setPhase('grading');
    try {
      const { graded: open, result } = await gradeOpen(questions, written);
      const all = questions.map((q, i) => (q.kind === 'choice' ? gradeChoice(q, picked[i]) : (open.get(i) ?? { points: 0 as const, feedback: 'Nicht bewertet.' })));
      setGraded(all);
      const percent = Math.round((all.reduce((sum, g) => sum + g.points, 0) / (questions.length * 2)) * 100);
      if (rootId) rememberExam(rootId, { at: Date.now(), percent, questions: questions.length });
      setPhase('results');
      if (result) toast(`Bewertet · ${costNote(result)}`);
    } catch (err) {
      setPhase('answering');
      if (!(err instanceof AiCancelled)) reportError('Antworten bewerten', err);
    }
  };

  // Tastatur beim Beantworten: 1–4 wählt, Enter weiter.
  useEffect(() => {
    if (phase !== 'answering') return;
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLTextAreaElement) return;
      const q = questions[index];
      if (q?.kind === 'choice' && /^[1-4]$/.test(e.key) && Number(e.key) <= q.options.length) {
        setPicked((p) => p.map((v, i) => (i === index ? Number(e.key) - 1 : v)));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (index < questions.length - 1) setIndex(index + 1);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [phase, index, questions]);

  if (!rootId) return null;
  const q = questions[index];
  const answered = questions.filter((qq, i) => (qq.kind === 'choice' ? picked[i] !== null : written[i].trim())).length;
  const points = graded.reduce((sum, g) => sum + g.points, 0);
  const percent = questions.length ? Math.round((points / (questions.length * 2)) * 100) : 0;
  const wrong = questions.map((question, i) => ({ question, g: graded[i] })).filter(({ g }) => g && g.points < 2);
  const chip = (on: boolean) => cx('h-8 rounded-md border px-3 text-sm', on ? 'border-accent bg-accent-soft text-accent' : 'border-border text-muted hover:bg-hover');

  return (
    <Modal onClose={phase === 'creating' || phase === 'grading' ? () => undefined : close} className="flex max-h-[86vh] w-[640px] flex-col">
      <div className="flex items-center gap-2 border-b border-border px-5 py-3">
        <GraduationCap size={18} className="text-accent" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold">Probeklausur</div>
          <div className="truncate text-xs text-faint">{title} · samt Unterseiten</div>
        </div>
        {phase === 'answering' && (
          <span className="text-xs text-faint">
            {answered}/{questions.length} beantwortet · {Math.round((Date.now() - startedAt) / 60_000)} min
          </span>
        )}
        <IconButton icon={X} label="Schließen" onClick={close} />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {phase === 'setup' && (
          <div className="flex flex-col gap-4 text-sm">
            <p className="text-muted">
              Claude stellt aus deinen Notizen eine Klausur zusammen, mit Fragen wie vom Prüfer. Danach bewertet es deine Antworten und erklärt, was fehlte.
              Falsche Antworten kannst du als Karteikarten speichern.
            </p>
            <div>
              <div className="mb-1.5 text-xs text-faint">Fragen</div>
              <div className="flex gap-1.5">
                {[5, 10, 15, 20].map((n) => (
                  <button key={n} onClick={() => setCount(n)} className={chip(count === n)}>
                    {n}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <div className="mb-1.5 text-xs text-faint">Art</div>
              <div className="flex gap-1.5">
                {(
                  [
                    ['mixed', 'Gemischt'],
                    ['choice', 'Nur Auswahl'],
                    ['open', 'Nur Freitext'],
                  ] as const
                ).map(([value, label]) => (
                  <button key={value} onClick={() => setMix(value)} className={chip(mix === value)}>
                    {label}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <div className="mb-1.5 text-xs text-faint">Schwierigkeit</div>
              <div className="flex gap-1.5">
                {(
                  [
                    ['normal', 'Wie in der Klausur'],
                    ['hard', 'Schwer (Verständnis, Transfer)'],
                  ] as const
                ).map(([value, label]) => (
                  <button key={value} onClick={() => setLevel(value)} className={chip(level === value)}>
                    {label}
                  </button>
                ))}
              </div>
            </div>
            {history.length > 0 && (
              <div className="text-xs text-faint">
                Bisher:{' '}
                {history
                  .slice(-5)
                  .map((h) => `${h.percent} % (${new Intl.DateTimeFormat('de-DE', { day: 'numeric', month: 'short' }).format(h.at)})`)
                  .join(' · ')}
              </div>
            )}
          </div>
        )}

        {(phase === 'creating' || phase === 'grading') && (
          <div className="flex flex-col items-center gap-3 py-16 text-sm text-muted">
            <Loader2 size={22} className="animate-spin text-accent" />
            {phase === 'creating' ? 'Claude liest deine Notizen und stellt die Fragen …' : 'Claude korrigiert deine Antworten …'}
          </div>
        )}

        {phase === 'answering' && q && (
          <div className="flex flex-col gap-4">
            <div className="flex gap-1">
              {questions.map((qq, i) => (
                <button
                  key={i}
                  title={`Frage ${i + 1}`}
                  onClick={() => setIndex(i)}
                  className={cx(
                    'h-1.5 flex-1 rounded-full',
                    i === index ? 'bg-accent' : (qq.kind === 'choice' ? picked[i] !== null : written[i].trim()) ? 'bg-accent/40' : 'bg-hover',
                  )}
                />
              ))}
            </div>
            <div className="text-xs text-faint">
              Frage {index + 1} von {questions.length} · {q.kind === 'choice' ? 'Auswahl (Tasten 1–4)' : 'Freitext'}
            </div>
            <div className="text-base font-medium leading-relaxed">
              <MathText text={q.question} />
            </div>
            {q.kind === 'choice' ? (
              <div className="flex flex-col gap-2">
                {q.options.map((option, i) => (
                  <button
                    key={i}
                    onClick={() => setPicked((p) => p.map((v, j) => (j === index ? i : v)))}
                    className={cx(
                      'flex items-start gap-3 rounded-lg border px-3 py-2.5 text-left text-sm',
                      picked[index] === i ? 'border-accent bg-accent-soft' : 'border-border hover:bg-hover',
                    )}
                  >
                    <span className="mt-px flex h-5 w-5 shrink-0 items-center justify-center rounded border border-border text-2xs text-faint">{i + 1}</span>
                    <span>
                      <MathText text={option} />
                    </span>
                  </button>
                ))}
              </div>
            ) : (
              <textarea
                autoFocus
                rows={6}
                value={written[index]}
                onChange={(e) => setWritten((w) => w.map((v, j) => (j === index ? e.target.value : v)))}
                placeholder="Deine Antwort …"
                className="resize-none rounded-lg border border-border bg-bg p-3 text-sm outline-none focus:border-border-strong"
              />
            )}
          </div>
        )}

        {phase === 'results' && (
          <div className="flex flex-col gap-4">
            <div className="flex items-center gap-4 rounded-xl bg-hover px-4 py-3">
              <div className="text-3xl font-semibold">{percent} %</div>
              <div className="text-sm">
                <div>
                  Note <strong>{examGrade(percent)}</strong> · {points} von {questions.length * 2} Punkten
                </div>
                <div className="text-xs text-faint">{percent >= 50 ? 'Bestanden.' : 'Noch nicht bestanden, schau dir die Erklärungen an.'}</div>
              </div>
            </div>
            {questions.map((question, i) => {
              const g = graded[i];
              return (
                <div key={i} className="rounded-lg border border-border p-3 text-sm">
                  <div className="mb-1 flex items-start gap-2">
                    <span className={cx('mt-0.5 h-2.5 w-2.5 shrink-0 rounded-full', g.points === 2 ? 'bg-[#30a46c]' : g.points === 1 ? 'bg-[#f76b15]' : 'bg-danger')} />
                    <div className="flex-1 font-medium">
                      <MathText text={question.question} />
                    </div>
                    <button
                      title="Zur Seite"
                      onClick={() => {
                        close();
                        useUI.getState().open(question.pageId);
                      }}
                      className="text-faint hover:text-text"
                    >
                      <ExternalLink size={14} />
                    </button>
                  </div>
                  <div className="ml-[18px] flex flex-col gap-1 text-muted">
                    <div>
                      <span className="text-faint">Deine Antwort: </span>
                      {question.kind === 'choice' ? (picked[i] !== null ? <MathText text={question.options[picked[i]!]} /> : '–') : written[i].trim() || '–'}
                    </div>
                    {g.points < 2 && question.kind === 'open' && <div>{g.feedback}</div>}
                    <div>
                      <span className="text-faint">{question.kind === 'choice' ? 'Richtig: ' : 'Musterlösung: '}</span>
                      {question.kind === 'choice' && <MathText text={`${question.options[question.answer]}. `} />}
                      <MathText text={question.solution} />
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-3">
        {phase === 'setup' && (
          <button onClick={() => void create()} className="h-8 rounded-md bg-accent px-4 text-sm font-medium text-accent-fg">
            Klausur erstellen
          </button>
        )}
        {phase === 'answering' && (
          <>
            <button disabled={index === 0} onClick={() => setIndex(index - 1)} className="h-8 rounded-md px-3 text-sm text-muted hover:bg-hover disabled:opacity-40">
              Zurück
            </button>
            {index < questions.length - 1 ? (
              <button onClick={() => setIndex(index + 1)} className="h-8 rounded-md bg-hover px-4 text-sm hover:bg-active">
                Weiter
              </button>
            ) : null}
            <button onClick={() => void submit()} className="h-8 rounded-md bg-accent px-4 text-sm font-medium text-accent-fg">
              Abgeben{answered < questions.length ? ` (${questions.length - answered} offen)` : ''}
            </button>
          </>
        )}
        {phase === 'results' && (
          <>
            {wrong.length > 0 && (
              <button
                disabled={saved}
                onClick={() =>
                  saveAsCards(wrong.map(({ question }) => ({ question })))
                    .then((n) => {
                      setSaved(true);
                      toast(n ? `${n} Karteikarten angelegt` : 'Die Karten gibt es schon');
                    })
                    .catch((err) => reportError('Karteikarten anlegen', err))
                }
                className="flex h-8 items-center gap-1.5 rounded-md px-3 text-sm text-muted hover:bg-hover disabled:opacity-50"
              >
                {saved && <Check size={14} />} Fehler als Karteikarten ({wrong.length})
              </button>
            )}
            <button
              onClick={() => {
                setSaved(false);
                setPhase('setup');
              }}
              className="h-8 rounded-md bg-accent px-4 text-sm font-medium text-accent-fg"
            >
              Neue Klausur
            </button>
          </>
        )}
      </div>
    </Modal>
  );
}
