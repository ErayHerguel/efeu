import { writeText } from '@tauri-apps/plugin-clipboard-manager';
import { Copy, Globe, Link2, LoaderCircle, Trash2, UserPlus, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { IconButton } from '../../../components/IconButton';
import { Modal } from '../../../components/Modal';
import { PageIcon, pageTitle } from '../../../components/PageIcon';
import type { Member } from '../../../db/share';
import { cx } from '../../../lib/cx';
import { confirmDialog } from '../../../store/confirm';
import { usePages } from '../../../store/pages';
import { reportError, toast } from '../../../store/toast';
import { useUI } from '../../../store/ui';
import { Avatar, usePresence } from '../presence';
import { inviteLink, useHosting, type ShareStatus } from './hosting';

const ROLE_LABEL = { none: 'Kein Zugriff', read: 'Lesen', edit: 'Bearbeiten' } as const;

export async function copyInvite(status: ShareStatus, member: Member): Promise<void> {
  const link = inviteLink(status, member);
  if (!link) {
    toast('Der Link ist verfügbar, sobald das Teilen online ist');
    return;
  }
  try {
    await writeText(link);
    toast(`Einladungslink für ${member.name} kopiert`);
  } catch (err) {
    reportError('Link konnte nicht kopiert werden', err);
  }
}

export function StatusCard() {
  const status = useHosting((s) => s.status);
  const live = useHosting((s) => s.live);
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  };
  const { start, stop } = useHosting.getState();

  if (!live) {
    return (
      <div className="rounded-md border border-border p-4">
        <p className="text-sm text-muted">
          Lade Personen zu einzelnen Seiten, Boards oder Datenbanken ein. Sie arbeiten live mit, im Browser oder in ihrer eigenen
          efeu-App. Deine Daten bleiben auf diesem Computer: efeu ist der Server.
        </p>
        <p className="mt-2 text-xs text-faint">
          Erreichbar über das Internet per kostenlosem Cloudflare-Tunnel, ohne Konto. Beim ersten Start lädt efeu dafür einmalig das
          Programm cloudflared (Apache-2.0, ca. 20 MB) von GitHub.
        </p>
        <button
          disabled={busy}
          onClick={() => void run(start)}
          className="mt-3 flex h-8 items-center gap-1.5 rounded-md bg-accent px-3 text-sm font-medium text-accent-fg disabled:opacity-60"
        >
          <Globe size={15} /> Teilen starten
        </button>
      </div>
    );
  }

  const progress: Partial<Record<ShareStatus['phase'], string>> = {
    starting: 'Startet …',
    downloading: 'Lade cloudflared (einmalig) …',
    connecting: 'Verbinde mit dem Internet …',
  };
  return (
    <div className="rounded-md border border-border p-4">
      <div className="flex items-center gap-2 text-sm">
        {status.phase === 'online' && <span className="h-2 w-2 rounded-full bg-[#30a46c]" />}
        {status.phase === 'error' && <span className="h-2 w-2 rounded-full bg-danger" />}
        {progress[status.phase] && <LoaderCircle size={14} className="animate-spin text-muted" />}
        <span className="font-medium">
          {status.phase === 'online' ? 'Online' : status.phase === 'error' ? 'Nicht erreichbar' : progress[status.phase]}
        </span>
        <div className="flex-1" />
        <button
          disabled={busy}
          onClick={() => void run(stop)}
          className="h-7 rounded-md px-2 text-sm text-muted hover:bg-hover hover:text-text disabled:opacity-60"
        >
          Teilen beenden
        </button>
      </div>
      {status.url && (
        <div className="mt-2 truncate font-mono text-xs text-faint" title={status.url}>
          {status.url}
        </div>
      )}
      {status.phase === 'error' && (
        <div className="mt-2 flex items-start gap-2">
          <p className="flex-1 text-xs text-danger">{status.error}</p>
          <button
            disabled={busy}
            onClick={() => void run(async () => (await stop(), await start()))}
            className="h-7 shrink-0 rounded-md border border-border px-2 text-xs hover:bg-hover"
          >
            Erneut versuchen
          </button>
        </div>
      )}
      <p className="mt-2 text-xs text-faint">
        Die Adresse ändert sich bei jedem Start. Solange efeu geöffnet ist und das Teilen läuft, können Eingeladene mitarbeiten.
      </p>
    </div>
  );
}

function MemberRow({ member }: { member: Member }) {
  const status = useHosting((s) => s.status);
  const allGrants = useHosting((s) => s.grants);
  const grants = useMemo(() => allGrants.filter((g) => g.memberId === member.id && g.role !== 'none'), [allGrants, member.id]);
  const pages = usePages((s) => s.pages);
  const online = usePresence((s) => s.people.some((p) => p.memberId === member.id));
  const [name, setName] = useState(member.name);

  const remove = async () => {
    const ok = await confirmDialog({
      title: `${member.name} entfernen?`,
      message: 'Der Einladungslink wird ungültig, offene Verbindungen werden sofort getrennt.',
      confirmLabel: 'Entfernen',
      danger: true,
    });
    if (ok) await useHosting.getState().removeMember(member.id);
  };

  return (
    <div className="rounded-md px-2 py-2 hover:bg-hover/50">
      <div className="flex items-center gap-2">
        <span className="relative">
          <Avatar person={member} size={26} />
          {online && <span className="absolute -right-0.5 -bottom-0.5 h-2.5 w-2.5 rounded-full bg-[#30a46c] ring-2 ring-surface" />}
        </span>
        <input
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            useHosting.getState().renameMember(member.id, e.target.value);
          }}
          aria-label="Name"
          className="h-7 min-w-0 flex-1 rounded-md bg-transparent px-1 text-sm outline-none focus:bg-bg"
        />
        <button
          onClick={() => void copyInvite(status, member)}
          disabled={!status.url}
          title={status.url ? 'Einladungslink kopieren' : 'Erst verfügbar, wenn das Teilen online ist'}
          className="flex h-7 items-center gap-1 rounded-md px-2 text-xs text-muted hover:bg-hover hover:text-text disabled:opacity-40"
        >
          <Copy size={13} /> Link
        </button>
        <IconButton icon={Trash2} label={`${member.name} entfernen`} onClick={() => void remove()} />
      </div>
      <div className="mt-1 flex flex-wrap gap-1 pl-9">
        {grants.length === 0 && <span className="text-xs text-faint">Noch keine Seite freigegeben</span>}
        {grants.map((g) =>
          pages[g.pageId] ? (
            <button
              key={g.pageId}
              onClick={() => {
                useUI.getState().open(g.pageId);
                useUI.getState().setOverlay(null);
              }}
              className="flex h-6 max-w-[220px] items-center gap-1 rounded-sm bg-hover px-1.5 text-xs text-muted hover:text-text"
            >
              <PageIcon page={pages[g.pageId]} size={12} />
              <span className="truncate">{pageTitle(pages[g.pageId])}</span>
              <span className="text-faint">· {ROLE_LABEL[g.role]}</span>
            </button>
          ) : null,
        )}
      </div>
    </div>
  );
}

export function ShareDialog() {
  const allMembers = useHosting((s) => s.members);
  const members = useMemo(() => allMembers.filter((m) => m.kind === 'person'), [allMembers]);
  const hostName = useHosting((s) => s.hostName);
  const status = useHosting((s) => s.status);
  const [invitee, setInvitee] = useState('');
  const close = () => useUI.getState().setOverlay(null);

  const invite = async () => {
    const name = invitee.trim();
    if (!name) return;
    try {
      const member = await useHosting.getState().invite(name);
      setInvitee('');
      if (status.url) await copyInvite(status, member);
      else toast(`${member.name} eingeladen. Den Link kopierst du, sobald das Teilen online ist.`);
    } catch (err) {
      reportError('Einladen fehlgeschlagen', err);
    }
  };

  return (
    <Modal onClose={close} position="center" className="flex max-h-[85vh] w-[560px] flex-col">
      <div className="flex items-center gap-2 border-b border-border px-5 py-3">
        <Link2 size={16} className="text-muted" />
        <h2 className="flex-1 text-sm font-semibold">Teilen und Zusammenarbeiten</h2>
        <IconButton icon={X} label="Schließen" onClick={close} />
      </div>
      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-4">
        <StatusCard />

        <label className="block">
          <span className="text-xs font-medium text-faint">Dein Name für die anderen</span>
          <input
            value={hostName}
            onChange={(e) => useHosting.getState().setHostName(e.target.value)}
            className="mt-1 h-8 w-full rounded-md border border-border bg-bg px-2 text-sm outline-none focus:border-border-strong"
          />
        </label>

        <div>
          <div className="mb-1 text-xs font-medium text-faint">Personen</div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void invite();
            }}
            className="mb-2 flex gap-2"
          >
            <input
              value={invitee}
              onChange={(e) => setInvitee(e.target.value)}
              placeholder="Name der Person"
              className="h-8 min-w-0 flex-1 rounded-md border border-border bg-bg px-2 text-sm outline-none focus:border-border-strong"
            />
            <button
              type="submit"
              disabled={!invitee.trim()}
              className="flex h-8 items-center gap-1.5 rounded-md bg-accent px-3 text-sm font-medium text-accent-fg disabled:opacity-50"
            >
              <UserPlus size={15} /> Einladen
            </button>
          </form>
          {members.length === 0 ? (
            <p className="px-2 py-3 text-sm text-faint">Noch niemand eingeladen.</p>
          ) : (
            <div className={cx('-mx-2 space-y-0.5')}>
              {members.map((m) => (
                <MemberRow key={m.id} member={m} />
              ))}
            </div>
          )}
        </div>

        <p className="text-xs text-faint">
          Rechte vergibst du pro Seite über „Teilen“ oben rechts. Unterseiten und Datenbank-Einträge erben die Rechte; jede Person sieht
          nur, was du ihr freigibst.
        </p>
      </div>
    </Modal>
  );
}
