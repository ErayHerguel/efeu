import { LoaderCircle } from 'lucide-react';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import logo from '../../../assets/logo.svg';

/**
 * Seiten der eigenen Cloud für Team-Mitglieder im Browser: Einladung annehmen, anmelden, Passwort neu
 * setzen. Danach geht es mit dem persönlichen Zugang (wie bei Gästen /join/…) in den Workspace.
 */
export type TeamRoute = { kind: 'join'; code: string } | { kind: 'login' } | { kind: 'reset'; code: string };

export function teamRoute(): TeamRoute | null {
  const path = location.pathname.replace(/\/+$/, '');
  const join = /^\/team\/([0-9a-f]{32})$/i.exec(path);
  if (join) return { kind: 'join', code: join[1].toLowerCase() };
  const reset = /^\/reset\/([0-9a-f]{32})$/i.exec(path);
  if (reset) return { kind: 'reset', code: reset[1].toLowerCase() };
  if (path === '/login') return { kind: 'login' };
  return null;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(path, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
  const data = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(data.error ?? `Fehler ${response.status}`);
  return data;
}

function Card({ title, text, children }: { title: string; text?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex min-h-full items-center justify-center p-6">
      <div className="w-full max-w-[380px] space-y-5">
        <div className="space-y-2 text-center">
          <img src={logo} alt="" className="mx-auto h-11 w-11 rounded-xl" draggable={false} />
          <h1 className="text-lg font-semibold">{title}</h1>
          {text && <p className="text-sm text-muted">{text}</p>}
        </div>
        {children}
      </div>
    </div>
  );
}

function Field({ label, value, onChange, type = 'text', hint, autoComplete }: { label: string; value: string; onChange: (v: string) => void; type?: string; hint?: string; autoComplete?: string }) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm">{label}</span>
      <input
        type={type}
        value={value}
        autoComplete={autoComplete}
        autoCapitalize="none"
        spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
        className="h-10 w-full rounded-md border border-border bg-bg px-3 text-[15px] outline-none focus:border-accent"
      />
      {hint && <span className="mt-1 block text-xs text-faint">{hint}</span>}
    </label>
  );
}

function Submit({ busy, disabled, children }: { busy: boolean; disabled?: boolean; children: ReactNode }) {
  return (
    <button
      type="submit"
      disabled={busy || disabled}
      className="flex h-10 w-full items-center justify-center gap-2 rounded-md bg-accent text-sm font-medium text-accent-fg disabled:opacity-50"
    >
      {busy && <LoaderCircle size={15} className="animate-spin" />} {children}
    </button>
  );
}

function useSubmit(action: () => Promise<void>) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };
  return { busy, error, onSubmit };
}

const ErrorText = ({ text }: { text: string | null }) => (text ? <p className="rounded-md bg-danger/10 px-3 py-2 text-sm text-danger">{text}</p> : null);

/** Mit dem persönlichen Zugang in den Workspace (dieselbe Adresse merkt sich auch der Home-Bildschirm). */
const enter = (token: string) => location.replace(`/join/${token}`);

function JoinPage({ code }: { code: string }) {
  const [valid, setValid] = useState<boolean | null>(null);
  const [name, setName] = useState('');
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  useEffect(() => {
    fetch(`/api/team/invite/${code}`)
      .then((r) => r.json() as Promise<{ valid: boolean }>)
      .then((r) => setValid(r.valid))
      .catch(() => setValid(false));
  }, [code]);
  const { busy, error, onSubmit } = useSubmit(async () => {
    const { token } = await post<{ token: string }>('/api/team/join', { code, name, login, password });
    enter(token);
  });
  if (valid === null) return <Card title="Einladung wird geprüft …">{null}</Card>;
  if (!valid) {
    return (
      <Card title="Diese Einladung gilt nicht mehr" text="Sie wurde schon benutzt oder ist abgelaufen. Bitte um eine neue.">
        <a href="/login" className="block text-center text-sm text-accent">
          Ich habe schon ein Konto
        </a>
      </Card>
    );
  }
  return (
    <Card title="Willkommen im Team" text="Wähle deinen Namen und ein Passwort. Damit meldest du dich im Browser, auf dem Handy und in der efeu-App an.">
      <form className="space-y-3" onSubmit={(e) => void onSubmit(e)}>
        <Field label="Dein Name" value={name} onChange={setName} autoComplete="name" />
        <Field label="Benutzername" value={login} onChange={setLogin} autoComplete="username" hint="Buchstaben, Ziffern, Punkt oder Strich" />
        <Field label="Passwort" value={password} onChange={setPassword} type="password" autoComplete="new-password" hint="Mindestens 10 Zeichen" />
        <ErrorText text={error} />
        <Submit busy={busy} disabled={!name.trim() || !login.trim() || password.length < 10}>
          Beitreten
        </Submit>
      </form>
    </Card>
  );
}

function LoginPage() {
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const { busy, error, onSubmit } = useSubmit(async () => {
    const { token } = await post<{ token: string }>('/api/team/login', { login, password });
    enter(token);
  });
  return (
    <Card title="Anmelden" text="Mit deinem Team-Konto.">
      <form className="space-y-3" onSubmit={(e) => void onSubmit(e)}>
        <Field label="Benutzername" value={login} onChange={setLogin} autoComplete="username" />
        <Field label="Passwort" value={password} onChange={setPassword} type="password" autoComplete="current-password" />
        <ErrorText text={error} />
        <Submit busy={busy} disabled={!login.trim() || !password}>
          Anmelden
        </Submit>
        <p className="text-center text-xs text-faint">Passwort vergessen? Wer das Team verwaltet, kann dir einen Link zum Zurücksetzen schicken.</p>
      </form>
    </Card>
  );
}

function ResetPage({ code }: { code: string }) {
  const [password, setPassword] = useState('');
  const [done, setDone] = useState(false);
  const { busy, error, onSubmit } = useSubmit(async () => {
    await post('/api/team/reset', { code, password });
    setDone(true);
  });
  if (done) {
    return (
      <Card title="Passwort geändert" text="Du kannst dich jetzt mit dem neuen Passwort anmelden.">
        <a href="/login" className="flex h-10 w-full items-center justify-center rounded-md bg-accent text-sm font-medium text-accent-fg">
          Zur Anmeldung
        </a>
      </Card>
    );
  }
  return (
    <Card title="Neues Passwort">
      <form className="space-y-3" onSubmit={(e) => void onSubmit(e)}>
        <Field label="Neues Passwort" value={password} onChange={setPassword} type="password" autoComplete="new-password" hint="Mindestens 10 Zeichen" />
        <ErrorText text={error} />
        <Submit busy={busy} disabled={password.length < 10}>
          Speichern
        </Submit>
      </form>
    </Card>
  );
}

export function TeamPage({ route }: { route: TeamRoute }) {
  if (route.kind === 'join') return <JoinPage code={route.code} />;
  if (route.kind === 'reset') return <ResetPage code={route.code} />;
  return <LoginPage />;
}
