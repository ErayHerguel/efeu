import { Loader2, Mic } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Modal } from '../../components/Modal';
import { formatCombo, matches } from '../shortcuts/keys';
import { reportError } from '../../store/toast';
import { formatSize } from '../../editor/nodes/file';
import { downloadModel, modelStatus } from '../lecture/lecture';
import { cancelDictation, DICTATE_KEYS, startDictation, stopDictation, toggleDictation, useDictate } from './dictate';

/** Gedrückt halten länger als das: Loslassen beendet das Diktat (Push-to-Talk). */
const HOLD_MS = 600;

/** Tastenkürzel (drücken oder halten), Anzeige während des Diktats und Download des Sprachmodells. */
export function DictateUI() {
  const { status, level, needsModel } = useDictate();

  useEffect(() => {
    let pressedAt = 0;
    const onDown = (e: KeyboardEvent) => {
      const { status } = useDictate.getState();
      if (e.key === 'Escape' && status === 'recording') {
        e.preventDefault();
        e.stopPropagation();
        void cancelDictation();
        return;
      }
      if (!matches(e, DICTATE_KEYS)) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.repeat) return;
      if (status === 'idle') pressedAt = Date.now();
      toggleDictation();
    };
    const onUp = (e: KeyboardEvent) => {
      if (!pressedAt || e.code !== 'KeyV') return;
      const held = Date.now() - pressedAt;
      pressedAt = 0;
      if (held >= HOLD_MS) void stopDictation();
    };
    window.addEventListener('keydown', onDown, true);
    window.addEventListener('keyup', onUp, true);
    return () => {
      window.removeEventListener('keydown', onDown, true);
      window.removeEventListener('keyup', onUp, true);
    };
  }, []);

  return (
    <>
      {status !== 'idle' && (
        <div className="fixed bottom-5 left-1/2 z-50 flex -translate-x-1/2 items-center gap-3 rounded-full bg-surface py-2 pl-3 pr-2 text-sm shadow-popover" role="status">
          {status === 'transcribing' || status === 'starting' ? (
            <>
              <Loader2 size={16} className="animate-spin text-accent" />
              <span className="text-muted">{status === 'starting' ? 'Mikrofon startet …' : 'Erkenne …'}</span>
            </>
          ) : (
            <>
              <span className="relative flex h-6 w-6 items-center justify-center rounded-full bg-danger text-white">
                <Mic size={14} />
                <span className="absolute inset-0 rounded-full bg-danger opacity-40" style={{ transform: `scale(${1 + level * 0.8})` }} />
              </span>
              <span>Sprich jetzt</span>
              <span className="text-xs text-faint">loslassen oder {formatCombo(DICTATE_KEYS)} fügt ein · Esc bricht ab</span>
              <button onClick={() => void stopDictation()} className="h-7 rounded-full bg-accent px-3 text-xs font-medium text-accent-fg">
                Einfügen
              </button>
            </>
          )}
        </div>
      )}
      {needsModel && <ModelDialog onClose={() => useDictate.setState({ needsModel: false })} />}
    </>
  );
}

function ModelDialog({ onClose }: { onClose: () => void }) {
  const [size, setSize] = useState<number | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  useEffect(() => {
    modelStatus()
      .then((s) => setSize(s.size))
      .catch(() => setSize(null));
  }, []);
  const download = async () => {
    setProgress(0);
    try {
      await downloadModel((received, total) => setProgress(total ? received / total : 0));
      onClose();
      void startDictation();
    } catch (err) {
      reportError('Sprachmodell laden', err);
      setProgress(null);
    }
  };
  return (
    <Modal onClose={progress === null ? onClose : () => undefined} className="w-[420px] p-5">
      <h2 className="mb-2 text-base font-semibold">Diktat einrichten</h2>
      <p className="mb-4 text-sm text-muted">
        efeu erkennt Sprache direkt auf deinem Computer, ohne Internet und ohne dass Ton gespeichert wird. Dafür braucht es einmalig das
        Sprachmodell{size ? ` (${formatSize(size)})` : ''}. Es ist dasselbe wie für „Vorlesung mitschreiben“.
      </p>
      {progress !== null ? (
        <div className="h-2 overflow-hidden rounded-full bg-hover">
          <div className="h-full bg-accent transition-[width]" style={{ width: `${Math.round(progress * 100)}%` }} />
        </div>
      ) : (
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="h-8 rounded-md px-3 text-sm text-muted hover:bg-hover">
            Später
          </button>
          <button onClick={() => void download()} className="h-8 rounded-md bg-accent px-3 text-sm font-medium text-accent-fg">
            Modell laden und diktieren
          </button>
        </div>
      )}
    </Modal>
  );
}
