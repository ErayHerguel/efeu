import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';
import { Check, Cloud, CloudOff, Copy, Laptop, Loader2, RefreshCw, Server, Smartphone, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { renderSVG } from 'uqr';
import { IconButton } from '../../components/IconButton';
import { cx } from '../../lib/cx';
import { confirmDialog } from '../../store/confirm';
import { reportError, toast } from '../../store/toast';
import { useUI } from '../../store/ui';
import { useSettingsSection } from '../ai/client';
import { cloudLink, useHosting } from '../collab/host/hosting';
import { Button, Heading } from '../settings/controls';
import {
  disconnectCloud,
  joinCloud,
  listDevices,
  pairingCode,
  removeDevice,
  renameDevice,
  setupServer,
  syncNow,
  useCloud,
  type CloudDevice,
  type CloudPhase,
} from './cloud';

const GUIDE_URL = 'https://erayherguel.github.io/efeu/cloud.html';

const PHASE_TEXT: Record<CloudPhase, string> = {
  off: 'Nicht verbunden',
  connecting: 'Verbinde …',
  syncing: 'Gleiche ab …',
  synced: 'Alles abgeglichen',
  offline: 'Offline – Änderungen werden später übertragen',
  error: 'Fehler beim Abgleich',
};

function Input({
  label,
  value,
  onChange,
  placeholder,
  type = 'text',
  hint,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
  hint?: ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm">{label}</span>
      <input
        type={type}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        autoComplete="off"
        spellCheck={false}
        className="h-9 w-full rounded-md border border-border bg-bg px-2.5 text-sm outline-none focus:border-accent"
      />
      {hint && <span className="mt-1 block text-xs text-faint">{hint}</span>}
    </label>
  );
}

interface Progress {
  step: number;
  total: number;
  text: string;
}

function SetupWizard({ onCancel }: { onCancel: () => void }) {
  const [host, setHost] = useState('');
  const [password, setPassword] = useState('');
  const [domain, setDomain] = useState('');
  const [advanced, setAdvanced] = useState(false);
  const [running, setRunning] = useState(false);
  const [steps, setSteps] = useState<Progress[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const off = listen<Progress>('cloud:setup', (e) => setSteps((s) => [...s.filter((p) => p.step !== e.payload.step), e.payload]));
    return () => void off.then((f) => f());
  }, []);

  const start = async () => {
    setRunning(true);
    setError(null);
    setSteps([]);
    try {
      await setupServer({ host, password, domain: advanced ? domain : '' });
      toast('Deine Cloud ist eingerichtet.');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  };

  const current = steps.length ? Math.max(...steps.map((s) => s.step)) : -1;

  return (
    <div className="space-y-4 rounded-lg border border-border p-4">
      <div>
        <h4 className="text-sm font-medium">Eigenen Server einrichten</h4>
        <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm text-muted">
          <li>
            Miete einen kleinen Server mit <strong className="font-medium text-text">Ubuntu 24.04</strong>, zum Beispiel bei Hetzner (ca. 4 € im Monat).{' '}
            <button className="text-accent hover:underline" onClick={() => void invoke('open_external', { url: GUIDE_URL })}>
              Anleitung mit Bildern
            </button>
          </li>
          <li>Trag hier die IP-Adresse und das root-Passwort ein, die du vom Anbieter bekommst.</li>
          <li>efeu richtet alles selbst ein. Das dauert etwa 3 Minuten.</li>
        </ol>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Input label="IP-Adresse" value={host} onChange={setHost} placeholder="49.12.34.56" />
        <Input label="Passwort (root)" value={password} onChange={setPassword} type="password" />
      </div>
      {advanced ? (
        <Input
          label="Eigene Domain (optional)"
          value={domain}
          onChange={setDomain}
          placeholder="notizen.meinname.de"
          hint="Die Domain muss schon auf die IP-Adresse des Servers zeigen (A-Eintrag)."
        />
      ) : (
        <button className="text-xs text-faint hover:text-muted" onClick={() => setAdvanced(true)}>
          Erweitert: eigene Domain verwenden
        </button>
      )}
      <p className="text-xs text-faint">
        Das Passwort wird nur für die Einrichtung benutzt und nicht gespeichert. Danach meldet sich dieses Gerät mit einem eigenen Schlüssel an.
      </p>

      {steps.length > 0 && (
        <ul className="space-y-1 text-sm">
          {steps
            .sort((a, b) => a.step - b.step)
            .map((s) => (
              <li key={s.step} className="flex items-center gap-2">
                {s.step < current || s.step === s.total ? (
                  <Check size={14} className="text-[#30a46c]" />
                ) : running ? (
                  <Loader2 size={14} className="animate-spin text-muted" />
                ) : (
                  <span className="h-3.5 w-3.5" />
                )}
                <span className={cx(s.step === current ? 'text-text' : 'text-muted')}>{s.text}</span>
              </li>
            ))}
        </ul>
      )}
      {error && <p className="whitespace-pre-wrap rounded-md bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p>}
      <div className="flex gap-2">
        <Button primary disabled={running || !host.trim() || !password} onClick={() => void start()}>
          {running ? <Loader2 size={15} className="animate-spin" /> : <Server size={15} />} {running ? 'Wird eingerichtet …' : 'Einrichten'}
        </Button>
        <Button
          onClick={() => {
            if (running) void invoke('cloud_setup_cancel');
            onCancel();
          }}
        >
          Abbrechen
        </Button>
      </div>
    </div>
  );
}

function JoinForm({ onCancel }: { onCancel: () => void }) {
  const [url, setUrl] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const join = async () => {
    setBusy(true);
    try {
      await joinCloud(url, code);
      toast('Mit deiner Cloud verbunden.');
    } catch (err) {
      reportError('Verbinden fehlgeschlagen', err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-3 rounded-lg border border-border p-4">
      <h4 className="text-sm font-medium">Mit bestehender Cloud verbinden</h4>
      <p className="text-sm text-muted">
        Auf einem Gerät, das schon verbunden ist: Einstellungen → Eigene Cloud → „Weiteres Gerät verbinden“. Dort stehen Adresse und Code.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Input label="Adresse" value={url} onChange={setUrl} placeholder="49.12.34.56" />
        <Input label="Code" value={code} onChange={setCode} placeholder="32 Zeichen" />
      </div>
      <p className="text-xs text-faint">Was du auf diesem Gerät schon angelegt hast, bleibt erhalten und kommt in die Cloud dazu.</p>
      <div className="flex gap-2">
        <Button primary disabled={busy || !url.trim() || !code.trim()} onClick={() => void join()}>
          {busy ? <Loader2 size={15} className="animate-spin" /> : <Cloud size={15} />} Verbinden
        </Button>
        <Button onClick={onCancel}>Abbrechen</Button>
      </div>
    </div>
  );
}

function PhonePairing({ url }: { url: string }) {
  const [link, setLink] = useState<string | null>(null);
  const svg = useMemo(() => (link ? renderSVG(link, { border: 1, ecc: 'M' }) : ''), [link]);
  useEffect(() => {
    // Ein Handy ist ein eigenes Gerät mit vollem Zugriff, wie beim Teilen über den Mac.
    const count = useHosting.getState().members.filter((m) => m.kind === 'device').length;
    useHosting
      .getState()
      .invite(count ? `Handy ${count + 1}` : 'Handy', 'device')
      .then((member) => setLink(cloudLink(url, member)))
      .catch((err) => reportError('Gerät konnte nicht angelegt werden', err));
  }, [url]);
  if (!link) return <Loader2 size={16} className="animate-spin text-muted" />;
  return (
    <div className="flex gap-4">
      <div className="h-40 w-40 shrink-0 rounded-md bg-white p-1 [&>svg]:h-full [&>svg]:w-full" dangerouslySetInnerHTML={{ __html: svg }} />
      <ol className="min-w-0 flex-1 list-decimal space-y-2 pl-4 text-sm text-muted">
        <li>Mit der Kamera des Handys den Code scannen.</li>
        <li>
          Im Browser auf <strong className="font-medium text-text">Teilen</strong> → <strong className="font-medium text-text">„Zum Home-Bildschirm“</strong> tippen. efeu liegt dann wie eine App auf dem Handy.
        </li>
        <li>Das Handy erscheint unter Einstellungen → Meine Geräte und lässt sich dort wieder entfernen.</li>
      </ol>
    </div>
  );
}

function ComputerPairing({ url }: { url: string }) {
  const [pairing, setPairing] = useState<{ code: string; expiresAt: number } | null>(null);
  useEffect(() => {
    pairingCode()
      .then(setPairing)
      .catch((err) => reportError('Code konnte nicht erstellt werden', err));
  }, []);
  if (!pairing) return <Loader2 size={16} className="animate-spin text-muted" />;
  const copy = (text: string) => void writeText(text).then(() => toast('Kopiert'));
  return (
    <div className="space-y-2 text-sm">
      <p className="text-muted">Auf dem anderen Computer efeu installieren, dann unter Einstellungen → Eigene Cloud → „Mit bestehender Cloud verbinden“ eintragen:</p>
      <div className="flex items-center gap-1">
        <span className="w-16 text-xs text-faint">Adresse</span>
        <code className="truncate rounded bg-code px-1.5 py-0.5 text-xs">{url.replace(/^https:\/\//, '')}</code>
        <IconButton icon={Copy} label="Adresse kopieren" onClick={() => copy(url)} />
      </div>
      <div className="flex items-center gap-1">
        <span className="w-16 text-xs text-faint">Code</span>
        <code className="truncate rounded bg-code px-1.5 py-0.5 text-xs">{pairing.code}</code>
        <IconButton icon={Copy} label="Code kopieren" onClick={() => copy(pairing.code)} />
      </div>
      <p className="text-xs text-faint">Der Code gilt 10 Minuten und nur für ein Gerät.</p>
    </div>
  );
}

function PairingPanel({ url, onClose }: { url: string; onClose: () => void }) {
  const [kind, setKind] = useState<'phone' | 'computer' | null>(null);
  return (
    <div className="space-y-3 rounded-lg border border-border p-4">
      <div className="flex gap-2">
        {(
          [
            ['phone', Smartphone, 'Handy oder Tablet'],
            ['computer', Laptop, 'Anderer Computer'],
          ] as const
        ).map(([id, Icon, label]) => (
          <button
            key={id}
            onClick={() => setKind(id)}
            className={cx(
              'flex h-9 flex-1 items-center justify-center gap-1.5 rounded-md border text-sm',
              kind === id ? 'border-accent bg-accent-soft text-text' : 'border-border text-muted hover:bg-hover',
            )}
          >
            <Icon size={15} /> {label}
          </button>
        ))}
      </div>
      {kind === 'phone' && <PhonePairing url={url} />}
      {kind === 'computer' && <ComputerPairing url={url} />}
      <Button onClick={onClose}>Fertig</Button>
    </div>
  );
}

function Connected() {
  const { phase, url, error, lastSync } = useCloud();
  const [devices, setDevices] = useState<CloudDevice[] | null>(null);
  const [me, setMe] = useState<string | null>(null);
  const [pairing, setPairing] = useState(false);

  const reload = () =>
    listDevices()
      .then((r) => {
        setDevices(r.devices);
        setMe(r.me);
      })
      .catch(() => setDevices(null));
  useEffect(() => {
    void reload();
  }, [pairing]);

  const remove = async (device: CloudDevice) => {
    const ok = await confirmDialog({
      title: `${device.name} entfernen?`,
      message: 'Das Gerät kommt sofort nicht mehr in die Cloud. Was dort schon gespeichert ist, bleibt auf dem Gerät.',
      confirmLabel: 'Entfernen',
      danger: true,
    });
    if (!ok) return;
    try {
      await removeDevice(device.id);
      await reload();
    } catch (err) {
      reportError('Gerät konnte nicht entfernt werden', err);
    }
  };

  const disconnect = async () => {
    const ok = await confirmDialog({
      title: 'Verbindung zur Cloud trennen?',
      message: 'Alle Seiten bleiben auf diesem Computer und in der Cloud. Dieses Gerät gleicht danach nicht mehr ab.',
      confirmLabel: 'Trennen',
      danger: true,
    });
    if (!ok) return;
    try {
      await disconnectCloud();
    } catch (err) {
      reportError('Trennen fehlgeschlagen', err);
    }
  };

  const good = phase === 'synced' || phase === 'syncing' || phase === 'connecting';
  const newPassword = useCloud((s) => s.newPassword);
  return (
    <div className="space-y-6">
      {newPassword && (
        <section className="space-y-2 rounded-lg border border-accent p-4 text-sm">
          <p>
            Dein Anbieter wollte beim ersten Anmelden ein neues Passwort. efeu hat dafür ein sicheres gesetzt. Für efeu brauchst du es nicht
            mehr; heb es trotzdem auf (z. B. im Passwort-Manager), falls du dich selbst einmal am Server anmelden willst.
          </p>
          <div className="flex items-center gap-1">
            <code className="rounded bg-code px-1.5 py-0.5 text-xs">{newPassword}</code>
            <IconButton icon={Copy} label="Passwort kopieren" onClick={() => void writeText(newPassword).then(() => toast('Kopiert'))} />
          </div>
          <Button onClick={() => useCloud.setState({ newPassword: null })}>Habe ich gespeichert</Button>
        </section>
      )}
      <section className="flex items-start gap-3 rounded-lg border border-border p-4">
        {good ? <Cloud size={20} className="mt-0.5 text-accent" /> : <CloudOff size={20} className="mt-0.5 text-muted" />}
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium">{PHASE_TEXT[phase]}</div>
          <div className="truncate text-xs text-faint">{url}</div>
          {lastSync && <div className="text-xs text-faint">Zuletzt abgeglichen: {new Date(lastSync).toLocaleTimeString('de-DE')}</div>}
          {error && phase !== 'synced' && <div className="mt-1 text-xs text-danger">{error}</div>}
        </div>
        <IconButton icon={RefreshCw} label="Jetzt abgleichen" onClick={syncNow} />
      </section>

      <section>
        <Heading>Geräte</Heading>
        <p className="mb-2 text-xs text-faint">Unten stehen die Computer mit efeu. Handys und Tablets findest du unter „Meine Geräte“.</p>
        {pairing && url ? (
          <PairingPanel url={url} onClose={() => setPairing(false)} />
        ) : (
          <Button primary onClick={() => setPairing(true)}>
            <Laptop size={15} /> Weiteres Gerät verbinden
          </Button>
        )}
        {devices && (
          <div className="mt-3 space-y-1">
            {devices.map((d) => (
              <div key={d.id} className="flex items-center gap-2">
                <Laptop size={16} className="text-muted" />
                <input
                  defaultValue={d.name}
                  onBlur={(e) => e.target.value !== d.name && void renameDevice(d.id, e.target.value).catch(() => undefined)}
                  aria-label="Gerätename"
                  className="h-8 min-w-0 flex-1 rounded-md bg-transparent px-1 text-sm outline-none focus:bg-bg"
                />
                <span className="text-xs text-faint">
                  {d.id === me ? 'dieses Gerät' : d.lastSeen ? `zuletzt ${new Date(d.lastSeen).toLocaleDateString('de-DE')}` : 'noch nie'}
                </span>
                {d.id !== me && <IconButton icon={Trash2} label={`${d.name} entfernen`} onClick={() => void remove(d)} />}
              </div>
            ))}
          </div>
        )}
      </section>

      <section>
        <Heading>Sicherheit</Heading>
        <p className="text-sm text-muted">
          Deine Daten liegen nur auf deinem Server und deinen Geräten. Der Server sichert die Datenbank jeden Tag (14 Tage) und installiert
          Sicherheitsupdates selbst.
        </p>
      </section>

      <Button onClick={() => void disconnect()}>Verbindung trennen</Button>
    </div>
  );
}

export function CloudSettings() {
  const phase = useCloud((s) => s.phase);
  const [mode, setMode] = useState<'choose' | 'setup' | 'join'>('choose');
  if (phase !== 'off') return <Connected />;
  return (
    <div className="space-y-5">
      <p className="text-sm text-muted">
        Mit einer eigenen Cloud hast du deine Seiten auf allen Geräten, auch wenn dieser Computer aus ist, und kannst sie mit anderen
        teilen. Sie läuft auf einem Server, den du selbst mietest: Deine Daten liegen bei dir, nicht bei efeu oder anderen. Ganz ohne Cloud
        bleibt efeu wie bisher nur auf diesem Computer.
      </p>
      {mode === 'setup' ? (
        <SetupWizard onCancel={() => setMode('choose')} />
      ) : mode === 'join' ? (
        <JoinForm onCancel={() => setMode('choose')} />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          <button onClick={() => setMode('setup')} className="rounded-lg border border-border p-4 text-left hover:bg-hover">
            <Server size={20} className="mb-2 text-accent" />
            <div className="text-sm font-medium">Eigenen Server einrichten</div>
            <div className="mt-1 text-xs text-muted">Neuen Server mieten, efeu richtet ihn automatisch ein.</div>
          </button>
          <button onClick={() => setMode('join')} className="rounded-lg border border-border p-4 text-left hover:bg-hover">
            <Laptop size={20} className="mb-2 text-accent" />
            <div className="text-sm font-medium">Mit bestehender Cloud verbinden</div>
            <div className="mt-1 text-xs text-muted">Du hast schon eine efeu-Cloud auf einem anderen Gerät eingerichtet.</div>
          </button>
        </div>
      )}
    </div>
  );
}

const INDICATOR: Partial<Record<CloudPhase, { icon: typeof Cloud; text: string; className: string }>> = {
  synced: { icon: Cloud, text: 'In der Cloud abgeglichen', className: 'text-faint' },
  syncing: { icon: RefreshCw, text: 'Gleicht mit der Cloud ab …', className: 'text-faint' },
  connecting: { icon: RefreshCw, text: 'Verbinde mit der Cloud …', className: 'text-faint' },
  offline: { icon: CloudOff, text: 'Cloud nicht erreichbar – Änderungen werden später übertragen', className: 'text-muted' },
  error: { icon: CloudOff, text: 'Fehler beim Abgleich mit der Cloud', className: 'text-danger' },
};

/** Kleines Symbol oben rechts: Stand des Cloud-Abgleichs, Klick öffnet die Einstellungen. */
export function CloudIndicator() {
  const phase = useCloud((s) => s.phase);
  const error = useCloud((s) => s.error);
  const look = INDICATOR[phase];
  if (!look) return null;
  const Icon = look.icon;
  return (
    <button
      title={error && phase !== 'synced' ? `${look.text}: ${error}` : look.text}
      aria-label={look.text}
      onClick={() => {
        useSettingsSection.setState({ section: 'cloud' });
        useUI.getState().setOverlay('settings');
      }}
      className={cx('flex h-7 w-7 items-center justify-center rounded-md hover:bg-hover', look.className)}
    >
      <Icon size={15} className={phase === 'syncing' || phase === 'connecting' ? 'animate-spin [animation-duration:2s]' : ''} />
    </button>
  );
}
