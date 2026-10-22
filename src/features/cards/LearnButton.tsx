import { Layers } from 'lucide-react';
import { useLearn, startLearning } from './learn';

/** Seitenleiste: „Lernen“ mit der Zahl fälliger Karteikarten (nur, wenn es welche gibt). */
export function LearnButton() {
  const due = useLearn((s) => s.due);
  const any = useLearn((s) => s.any);
  if (!any) return null;
  return (
    <button
      onClick={() => startLearning(null)}
      className="flex h-7 items-center gap-2 rounded-md px-2 text-sm text-muted hover:bg-hover hover:text-text"
    >
      <Layers size={15} className="shrink-0" />
      <span className="flex-1 truncate text-left">Lernen</span>
      {due ? <span className="rounded-full bg-active px-1.5 text-xs font-medium text-text">{due}</span> : null}
    </button>
  );
}
