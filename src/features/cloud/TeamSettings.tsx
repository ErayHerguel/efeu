import { writeText } from '@tauri-apps/plugin-clipboard-manager';
import { Copy, KeyRound, Loader2, Trash2, UserPlus } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { renderSVG } from 'uqr';
import { IconButton } from '../../components/IconButton';
import { confirmDialog } from '../../store/confirm';
import { reportError, toast } from '../../store/toast';
import { Button, Heading } from '../settings/controls';
import { inviteToTeam, listTeam, removeFromTeam, resetTeamPassword, useCloud, type TeamMember } from './cloud';

const copy = (text: string) => void writeText(text).then(() => toast('Link kopiert'));

function LinkBox({ link, hint, qr }: { link: string; hint: string; qr?: boolean }) {
  const svg = useMemo(() => (qr ? renderSVG(link, { border: 1, ecc: 'M' }) : ''), [link, qr]);
  return (
    <div className="flex gap-4 rounded-lg border border-border p-4">
      {qr && <div className="h-32 w-32 shrink-0 rounded-md bg-white p-1 [&>svg]:h-full [&>svg]:w-full" dangerouslySetInnerHTML={{ __html: svg }} />}
      <div className="min-w-0 flex-1 space-y-2 text-sm">
        <div className="flex items-center gap-1">
          <code className="min-w-0 truncate rounded bg-code px-1.5 py-0.5 text-xs">{link}</code>
          <IconButton icon={Copy} label="Link kopieren" onClick={() => copy(link)} />
        </div>
        <p className="text-xs text-faint">{hint}</p>
      </div>
    </div>
  );
}

function lastSeen(m: TeamMember): string {
  if (!m.lastSeen) return 'noch nicht in der App';
  const minutes = Math.round((Date.now() - m.lastSeen) / 60_000);
  if (minutes < 2) return 'gerade aktiv';
  if (minutes < 60) return `vor ${minutes} Min.`;
  return `zuletzt ${new Date(m.lastSeen).toLocaleDateString('de-DE')}`;
}

/** Einstellungen → Team (nur für den Inhaber der Cloud). */
export function TeamSettings() {
  const url = useCloud((s) => s.url);
  const role = useCloud((s) => s.role);
  const [members, setMembers] = useState<TeamMember[] | null>(null);
  const [invite, setInvite] = useState<string | null>(null);
  const [reset, setReset] = useState<{ name: string; link: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = () =>
    listTeam()
      .then(setMembers)
      .catch((err) => reportError('Team konnte nicht geladen werden', err));
  useEffect(() => {
    if (role === 'owner') void reload();
  }, [role]);

  if (role !== 'owner' || !url) {
    return (
      <p className="text-sm text-muted">
        Für ein Team brauchst du deine eigene Cloud: Einstellungen → Eigene Cloud → „Eigenen Server einrichten“.
      </p>
    );
  }

  const createInvite = async () => {
    setBusy(true);
    try {
      const { code } = await inviteToTeam();
      setInvite(`${url}/team/${code}`);
    } catch (err) {
      reportError('Einladung konnte nicht erstellt werden', err);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (m: TeamMember) => {
    const ok = await confirmDialog({
      title: `${m.name} aus dem Team entfernen?`,
      message: 'Der Zugang endet sofort, auf allen Geräten und im Browser. Was im Team-Bereich liegt, bleibt erhalten.',
      confirmLabel: 'Entfernen',
      danger: true,
    });
    if (!ok) return;
    try {
      await removeFromTeam(m.id);
      await reload();
    } catch (err) {
      reportError('Entfernen fehlgeschlagen', err);
    }
  };

  const createReset = async (m: TeamMember) => {
    try {
      const { code } = await resetTeamPassword(m.id);
      setReset({ name: m.name, link: `${url}/reset/${code}` });
    } catch (err) {
      reportError('Link konnte nicht erstellt werden', err);
    }
  };

  return (
    <div className="space-y-6">
      <p className="text-sm text-muted">
        Mitglieder sehen und bearbeiten alles im Bereich <strong className="font-medium text-text">Team</strong>, im Browser, auf dem Handy oder
        in ihrer eigenen efeu-App. Deine privaten Seiten sehen sie nie. Einzelne Seiten für Gäste gibst du weiter wie bisher über „Teilen“.
      </p>

      <section className="space-y-3">
        <Heading>Einladen</Heading>
        {invite ? (
          <>
            <LinkBox
              link={invite}
              qr
              hint="Schick den Link der Person. Sie wählt beim Öffnen Name, Benutzername und Passwort. Er gilt 7 Tage und für eine Person."
            />
            <Button onClick={() => void createInvite()}>Weitere Einladung</Button>
          </>
        ) : (
          <Button primary disabled={busy} onClick={() => void createInvite()}>
            {busy ? <Loader2 size={15} className="animate-spin" /> : <UserPlus size={15} />} Person ins Team einladen
          </Button>
        )}
      </section>

      {reset && (
        <section className="space-y-2">
          <Heading>Passwort zurücksetzen für {reset.name}</Heading>
          <LinkBox link={reset.link} hint="Über diesen Link setzt die Person ein neues Passwort. Er gilt 24 Stunden." />
        </section>
      )}

      <section>
        <Heading>Mitglieder</Heading>
        {!members ? (
          <Loader2 size={16} className="animate-spin text-muted" />
        ) : members.length === 0 ? (
          <p className="text-sm text-faint">Noch niemand im Team.</p>
        ) : (
          <div className="space-y-1">
            {members.map((m) => (
              <div key={m.id} className="flex items-center gap-2">
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-medium text-white" style={{ background: m.color }}>
                  {m.name.slice(0, 1).toUpperCase()}
                </span>
                <span className="min-w-0 flex-1 truncate text-sm">
                  {m.name} <span className="text-faint">@{m.login}</span>
                </span>
                <span className="text-xs text-faint">{lastSeen(m)}</span>
                <IconButton icon={KeyRound} label={`Passwort von ${m.name} zurücksetzen`} onClick={() => void createReset(m)} />
                <IconButton icon={Trash2} label={`${m.name} entfernen`} onClick={() => void remove(m)} />
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
