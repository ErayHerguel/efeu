import { Download, X } from 'lucide-react';
import { dismissUpdate, installUpdate, useUpdate } from './updater';

/** Hinweis unten rechts, sobald eine neue Version bereitsteht. */
export function UpdateBanner() {
  const { visible, phase, version, progress } = useUpdate();
  if (!visible || phase === 'idle') return null;
  const busy = phase === 'downloading' || phase === 'ready';
  return (
    <div className="animate-pop-in rounded-lg bg-surface p-4 text-sm shadow-popover">
      <div className="flex items-start gap-3">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-accent-soft text-accent">
          <Download size={16} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="font-medium">efeu {version} ist verfügbar</div>
          <div className="text-xs text-muted">
            {phase === 'downloading' ? `Wird geladen … ${progress} %` : phase === 'ready' ? 'Wird neu gestartet …' : 'Deine Daten bleiben erhalten.'}
          </div>
        </div>
        {!busy && (
          <button aria-label="Später" onClick={dismissUpdate} className="text-faint hover:text-text">
            <X size={15} />
          </button>
        )}
      </div>
      {busy ? (
        <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-hover">
          <div className="h-full rounded-full bg-accent transition-[width]" style={{ width: `${progress}%` }} />
        </div>
      ) : (
        <div className="mt-3 flex justify-end gap-2">
          <button onClick={dismissUpdate} className="h-8 rounded-md px-3 text-sm text-muted hover:bg-hover">
            Später
          </button>
          <button onClick={() => void installUpdate()} className="h-8 rounded-md bg-accent px-3 text-sm font-medium text-accent-fg">
            Aktualisieren
          </button>
        </div>
      )}
    </div>
  );
}
