import { getVersion } from '@tauri-apps/api/app';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';
import { Copy, Database, Globe, Monitor, Moon, QrCode, RefreshCw, Settings, Smartphone, Sparkles, Sun, Trash2, X, type LucideIcon } from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { renderSVG } from 'uqr';
import { IconButton } from '../../components/IconButton';
import { Modal } from '../../components/Modal';
import { pageTitle } from '../../components/PageIcon';
import type { Member } from '../../db/share';
import { cx } from '../../lib/cx';
import { confirmDialog } from '../../store/confirm';
import { usePages } from '../../store/pages';
import { reportError, toast } from '../../store/toast';
import { useUI, type Theme } from '../../store/ui';
import { actionById } from '../actions';
import { deviceLink, useHosting } from '../collab/host/hosting';
import { StatusCard } from '../collab/host/ShareDialog';
import { usePresence } from '../collab/presence';
import { formatCombo } from '../shortcuts/keys';
import { useUpdate } from '../update/updater';
import { AiSettings } from '../ai/AiSettings';
import { useSettingsSection } from '../ai/client';
import { Button, Heading, Toggle } from './controls';
import { setUnsplashKey, useUnsplash } from '../page/covers';

type Section = 'general' | 'ai' | 'sharing' | 'devices' | 'data' | 'updates';

const SECTIONS: { id: Section; label: string; icon: LucideIcon }[] = [
  { id: 'general', label: 'Allgemein', icon: Settings },
  { id: 'ai', label: 'KI', icon: Sparkles },
  { id: 'sharing', label: 'Teilen', icon: Globe },
  { id: 'devices', label: 'Meine Geräte', icon: Smartphone },
  { id: 'data', label: 'Daten', icon: Database },
  { id: 'updates', label: 'Updates', icon: RefreshCw },
];

const THEMES: { id: Theme; label: string; icon: LucideIcon }[] = [
  { id: 'system', label: 'System', icon: Monitor },
  { id: 'light', label: 'Hell', icon: Sun },
  { id: 'dark', label: 'Dunkel', icon: Moon },
];

function General() {
  const theme = useUI((s) => s.theme);
  const homeId = useUI((s) => s.homeId);
  const home = usePages((s) => (homeId ? s.pages[homeId] : undefined));
  return (
    <div className="space-y-6">
      <section>
        <Heading>Erscheinungsbild</Heading>
        <div className="flex gap-2">
          {THEMES.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => useUI.getState().setTheme(id)}
              className={cx(
                'flex h-9 flex-1 items-center justify-center gap-1.5 rounded-md border text-sm',
                theme === id ? 'border-accent bg-accent-soft text-text' : 'border-border text-muted hover:bg-hover',
              )}
            >
              <Icon size={15} /> {label}
            </button>
          ))}
        </div>
      </section>
      <section>
        <Heading>Startseite</Heading>
        {home && home.deletedAt === null ? (
          <div className="flex items-center gap-2 text-sm">
            <span className="flex-1 truncate">{pageTitle(home)}</span>
            <Button onClick={() => useUI.getState().setHome(null)}>Entfernen</Button>
          </div>
        ) : (
          <p className="text-sm text-faint">Keine. Festlegen über „…“ oben rechts auf einer Seite → „Als Startseite festlegen“.</p>
        )}
      </section>
      <UnsplashSetting />
      <section>
        <Heading>Tastenkürzel</Heading>
        <Button onClick={() => useUI.getState().setOverlay('shortcuts')}>Alle Kürzel anzeigen ({formatCombo('Mod+/')})</Button>
      </section>
    </div>
  );
}

function UnsplashSetting() {
  const keySet = useUnsplash((s) => s.keySet);
  return (
    <section>
      <Heading>Titelbilder von Unsplash</Heading>
      {keySet ? (
        <div className="flex items-center gap-2 text-sm">
          <span className="flex-1">Eingerichtet, der Schlüssel liegt im Schlüsselbund.</span>
          <Button onClick={() => void setUnsplashKey(null).catch((err) => reportError('Unsplash', err))}>Schlüssel entfernen</Button>
        </div>
      ) : (
        <p className="text-sm text-faint">Nicht eingerichtet. Auf einer Seite „Titelbild hinzufügen“ → „Unsplash“ führt dich in zwei Minuten durch.</p>
      )}
    </section>
  );
}

function Sharing() {
  const hostName = useHosting((s) => s.hostName);
  const autostart = useHosting((s) => s.autostart);
  const keepAwake = useHosting((s) => s.keepAwake);
  return (
    <div className="space-y-6">
      <StatusCard />
      <label className="block">
        <span className="text-xs font-medium text-faint">Dein Name für die anderen</span>
        <input
          value={hostName}
          onChange={(e) => useHosting.getState().setHostName(e.target.value)}
          className="mt-1 h-8 w-full rounded-md border border-border bg-bg px-2 text-sm outline-none focus:border-border-strong"
        />
      </label>
      <section className="divide-y divide-border">
        <Toggle
          checked={autostart}
          onChange={(on) => useHosting.getState().setAutostart(on)}
          label="Beim Start von flou automatisch teilen"
          hint="So sind Gäste und deine Geräte verbunden, sobald flou läuft."
        />
        <Toggle
          checked={keepAwake}
          onChange={(on) => useHosting.getState().setKeepAwake(on)}
          label="Computer wach halten, solange geteilt wird"
          hint="Der Bildschirm darf ausgehen. Ein zugeklappter Laptop schläft trotzdem (Systemverhalten)."
        />
      </section>
      <Button onClick={() => useUI.getState().setOverlay('share')}>Personen und Rechte verwalten …</Button>
    </div>
  );
}

/** QR-Code und Anleitung, um ein eigenes Gerät zu verbinden. */
function DeviceQr({ member, onClose }: { member: Member; onClose: () => void }) {
  const topic = useHosting((s) => s.topic);
  const link = topic ? deviceLink(topic, member) : null;
  // Wird lokal aus dem eigenen Link erzeugt (kein fremder Inhalt).
  const svg = useMemo(() => (link ? renderSVG(link, { border: 2, ecc: 'M' }) : null), [link]);
  if (!link || !svg) return null;
  return (
    <div className="rounded-md border border-border p-4">
      <div className="flex items-start gap-4">
        <div className="h-[184px] w-[184px] shrink-0 rounded-md bg-white p-1 [&>svg]:h-full [&>svg]:w-full" dangerouslySetInnerHTML={{ __html: svg }} />
        <ol className="min-w-0 flex-1 list-decimal space-y-2 pl-4 text-sm">
          <li>Auf dem iPhone die Kamera öffnen und den Code scannen.</li>
          <li>
            In Safari unten auf <strong>Teilen</strong> tippen, dann <strong>„Zum Home-Bildschirm“</strong>. flou liegt jetzt als App auf deinem iPhone.
          </li>
          <li className="text-muted">Funktioniert, solange flou auf diesem Computer geöffnet ist und das Teilen läuft.</li>
        </ol>
      </div>
      <div className="mt-3 flex items-center gap-2">
        <Button
          onClick={() =>
            writeText(link)
              .then(() => toast('Link kopiert, z. B. per AirDrop ans iPhone schicken'))
              .catch((err) => reportError('Link konnte nicht kopiert werden', err))
          }
        >
          <Copy size={14} /> Link kopieren
        </Button>
        <div className="flex-1" />
        <Button onClick={onClose}>Fertig</Button>
      </div>
    </div>
  );
}

function Devices() {
  const members = useHosting((s) => s.members);
  const live = useHosting((s) => s.live);
  const people = usePresence((s) => s.people);
  const devices = members.filter((m) => m.kind === 'device');
  const [showing, setShowing] = useState<string | null>(null);

  const connect = async () => {
    try {
      const device = await useHosting.getState().invite(`iPhone${devices.length ? ` ${devices.length + 1}` : ''}`, 'device');
      setShowing(device.id);
      if (!useHosting.getState().live) await useHosting.getState().start();
    } catch (err) {
      reportError('Gerät konnte nicht verbunden werden', err);
    }
  };

  const remove = async (device: Member) => {
    const ok = await confirmDialog({
      title: `${device.name} entfernen?`,
      message: 'Das Gerät verliert sofort den Zugriff. Das App-Symbol auf dem Gerät kannst du danach löschen.',
      confirmLabel: 'Entfernen',
      danger: true,
    });
    if (ok) await useHosting.getState().removeMember(device.id);
  };

  const shown = devices.find((d) => d.id === showing);

  return (
    <div className="space-y-5">
      <p className="text-sm text-muted">
        Dein iPhone (oder ein anderes Gerät) bekommt deinen kompletten Workspace: alle Seiten, Boards und Datenbanken, live abgeglichen
        mit diesem Computer. Das Gerät nutzt flou im Browser; es braucht keine App aus dem App Store.
      </p>
      {shown ? (
        <DeviceQr member={shown} onClose={() => setShowing(null)} />
      ) : (
        <Button primary onClick={() => void connect()}>
          <Smartphone size={15} /> iPhone verbinden
        </Button>
      )}
      {devices.length > 0 && (
        <section>
          <Heading>Verbundene Geräte</Heading>
          <div className="space-y-1">
            {devices.map((device) => {
              const online = people.some((p) => p.memberId === device.id);
              return (
                <div key={device.id} className="flex items-center gap-2">
                  <span className="relative">
                    <Smartphone size={18} className="text-muted" />
                    {online && <span className="absolute -right-0.5 -bottom-0.5 h-2 w-2 rounded-full bg-[#30a46c] ring-2 ring-surface" />}
                  </span>
                  <input
                    defaultValue={device.name}
                    onChange={(e) => useHosting.getState().renameMember(device.id, e.target.value)}
                    aria-label="Gerätename"
                    className="h-8 min-w-0 flex-1 rounded-md bg-transparent px-1 text-sm outline-none focus:bg-bg"
                  />
                  <span className="text-xs text-faint">{online ? 'verbunden' : live ? 'nicht verbunden' : 'Teilen ist aus'}</span>
                  <IconButton icon={QrCode} label="QR-Code zeigen" onClick={() => setShowing(device.id)} />
                  <IconButton icon={Trash2} label={`${device.name} entfernen`} onClick={() => void remove(device)} />
                </div>
              );
            })}
          </div>
        </section>
      )}
      <p className="text-xs text-faint">
        Damit das Symbol auf dem Home-Bildschirm deinen Computer immer findet (die Tunnel-Adresse ändert sich bei jedem Start), meldet flou
        die aktuelle Adresse unter einem geheimen Namen beim kostenlosen Dienst ntfy.sh. Gemeldet wird nur die Adresse, nie dein
        Zugangsschlüssel; ohne ihn kommt niemand an deine Daten.
      </p>
    </div>
  );
}

function Data() {
  const run = (id: string) => () => void actionById(id).run();
  return (
    <div className="space-y-6">
      <section>
        <Heading>Speicherort</Heading>
        <p className="mb-2 text-sm text-muted">Alle Seiten, Bilder und Backups liegen in einem Ordner auf diesem Computer.</p>
        <Button onClick={run('app.dataFolder')}>Datenordner zeigen</Button>
      </section>
      <section>
        <Heading>Backups</Heading>
        <p className="mb-2 text-sm text-muted">Einmal täglich automatisch, die letzten 7 bleiben erhalten.</p>
        <div className="flex gap-2">
          <Button onClick={run('backup.now')}>Backup jetzt erstellen</Button>
          <Button onClick={run('backup.reveal')}>Backups zeigen</Button>
        </div>
      </section>
      <section>
        <Heading>Export und Import (Markdown)</Heading>
        <div className="flex flex-wrap gap-2">
          <Button onClick={run('export.workspace')}>Workspace exportieren …</Button>
          <Button onClick={run('import.files')}>Dateien importieren …</Button>
          <Button onClick={run('import.folder')}>Ordner importieren …</Button>
        </div>
      </section>
      <section>
        <Heading>Umzug aus Notion</Heading>
        <p className="mb-2 text-sm text-muted">
          In Notion: Einstellungen → Workspace exportieren → „Markdown &amp; CSV“. Die ZIP-Datei per Doppelklick entpacken und den Ordner
          hier wählen. Seiten, Unterseiten, Bilder und Datenbanken samt Einträgen kommen mit.
        </p>
        <Button onClick={run('import.notion')}>Aus Notion importieren …</Button>
      </section>
    </div>
  );
}

function Updates() {
  const auto = useUpdate((s) => s.auto);
  const [version, setVersion] = useState('');
  useEffect(() => {
    getVersion()
      .then(setVersion)
      .catch(() => undefined);
  }, []);
  return (
    <div className="space-y-6">
      <section>
        <Heading>Version</Heading>
        <p className="text-sm">flou {version}</p>
      </section>
      <section className="divide-y divide-border">
        <Toggle
          checked={auto}
          onChange={() => void actionById('update.toggleAuto').run()}
          label="Beim Start nach Updates suchen"
          hint="Fragt einmal die neueste Versionsnummer bei GitHub ab, ohne deine Daten."
        />
      </section>
      <Button onClick={() => void actionById('update.check').run()}>Jetzt nach Updates suchen</Button>
    </div>
  );
}

export function SettingsDialog() {
  const [section, setSection] = useState<Section>(() => {
    const wanted = useSettingsSection.getState().section;
    useSettingsSection.setState({ section: null });
    return SECTIONS.some((s) => s.id === wanted) ? (wanted as Section) : 'general';
  });
  const close = () => useUI.getState().setOverlay(null);
  const content: Record<Section, ReactNode> = {
    general: <General />,
    ai: <AiSettings />,
    sharing: <Sharing />,
    devices: <Devices />,
    data: <Data />,
    updates: <Updates />,
  };
  return (
    <Modal onClose={close} position="center" className="flex h-[min(600px,85vh)] w-[760px] max-w-full">
      <nav className="flex w-[190px] shrink-0 flex-col gap-0.5 border-r border-border bg-sidebar p-2">
        <div className="px-2 pt-1 pb-2 text-sm font-semibold">Einstellungen</div>
        {SECTIONS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => setSection(id)}
            className={cx(
              'flex h-8 items-center gap-2 rounded-md px-2 text-sm',
              section === id ? 'bg-active font-medium text-text' : 'text-muted hover:bg-hover',
            )}
          >
            <Icon size={15} /> {label}
          </button>
        ))}
      </nav>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-12 shrink-0 items-center border-b border-border px-5">
          <h2 className="flex-1 text-sm font-semibold">{SECTIONS.find((s) => s.id === section)?.label}</h2>
          <IconButton icon={X} label="Schließen" onClick={close} />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{content[section]}</div>
      </div>
    </Modal>
  );
}
