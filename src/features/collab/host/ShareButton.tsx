import { Users } from 'lucide-react';
import { cx } from '../../../lib/cx';
import { useUI } from '../../../store/ui';
import { usePresence } from '../presence';
import { useHosting } from './hosting';

/** Unten in der Seitenleiste: Teilen öffnen, mit Zustand (aus, startet, online, Fehler). */
export function ShareButton() {
  const live = useHosting((s) => s.live);
  const phase = useHosting((s) => s.status.phase);
  const guests = usePresence((s) => s.people.filter((p) => p.id !== 'host' && p.id !== s.me).length);
  const dot = !live ? null : phase === 'online' ? 'bg-[#30a46c]' : phase === 'error' ? 'bg-danger' : 'bg-[#ffc53d]';
  const label = !live ? 'Teilen' : phase === 'online' ? (guests ? `${guests} online` : 'Online') : phase === 'error' ? 'Fehler' : 'Startet …';
  return (
    <button
      onClick={() => useUI.getState().setOverlay('share')}
      title="Teilen und Zusammenarbeiten"
      className="flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-sm text-muted hover:bg-hover hover:text-text"
    >
      <span className="relative">
        <Users size={15} />
        {dot && <span className={cx('absolute -top-0.5 -right-0.5 h-2 w-2 rounded-full ring-2 ring-sidebar', dot)} />}
      </span>
      {label}
    </button>
  );
}
