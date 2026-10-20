import { ExternalLink, ImageUp, KeyRound, Loader2, Search } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import { Modal } from '../../components/Modal';
import { openExternal, pickImage } from '../../lib/assets';
import { cx } from '../../lib/cx';
import { GUEST } from '../../lib/mode';
import { usePages } from '../../store/pages';
import { reportError } from '../../store/toast';
import { GRADIENTS, gradientAsset, gradientCss, searchUnsplash, setUnsplashKey, useUnsplash, useUnsplashPhoto, type UnsplashPhoto } from './covers';

type Tab = 'unsplash' | 'gradients' | 'upload';

const usePicker = create<{ pageId: string | null }>(() => ({ pageId: null }));

export function openCoverPicker(pageId: string): void {
  usePicker.setState({ pageId });
}

function setCover(pageId: string, asset: string) {
  usePages.getState().update(pageId, { cover: asset });
  usePicker.setState({ pageId: null });
}

/** Einrichtung, wenn noch kein Unsplash-Schlüssel hinterlegt ist */
function UnsplashSetup() {
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      await setUnsplashKey(key);
    } catch (err) {
      reportError('Unsplash', err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mx-auto max-w-[420px] py-6 text-sm">
      <p className="font-medium">Millionen freie Fotos von Unsplash</p>
      <p className="mt-1 text-muted">
        Unsplash braucht dafür einen kostenlosen Zugangsschlüssel. Einmal einrichten, dauert zwei Minuten:
      </p>
      <ol className="mt-3 list-decimal space-y-1 pl-5 text-muted">
        <li>
          Auf{' '}
          <button onClick={() => void openExternal('https://unsplash.com/oauth/applications')} className="text-accent hover:underline">
            unsplash.com/developers
          </button>{' '}
          anmelden und „New Application“ anlegen (Name z. B. „efeu“).
        </li>
        <li>Den „Access Key“ kopieren und hier einfügen.</li>
      </ol>
      <div className="mt-4 flex gap-2">
        <input
          value={key}
          onChange={(e) => setKey(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && key && void save()}
          placeholder="Access Key"
          spellCheck={false}
          autoComplete="off"
          className="h-8 min-w-0 flex-1 rounded-md border border-border bg-bg px-2 font-mono text-sm outline-none focus:border-border-strong"
        />
        <button
          onClick={() => void save()}
          disabled={!key || busy}
          className="flex h-8 items-center gap-1.5 rounded-md bg-accent px-3 text-sm font-medium text-accent-fg disabled:opacity-50"
        >
          {busy ? <Loader2 size={14} className="animate-spin" /> : <KeyRound size={14} />} Speichern
        </button>
      </div>
      <p className="mt-3 text-xs text-faint">Der Schlüssel liegt im Schlüsselbund. Gewählte Fotos speichert efeu lokal, sie erscheinen auch offline.</p>
    </div>
  );
}

function UnsplashTab({ pageId }: { pageId: string }) {
  const [query, setQuery] = useState('');
  const [photos, setPhotos] = useState<UnsplashPhoto[]>([]);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [using, setUsing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);

  const load = async (q: string, p: number) => {
    const id = ++request.current;
    setLoading(true);
    setError(null);
    try {
      const result = await searchUnsplash(q, p);
      if (id !== request.current) return;
      setPhotos((prev) => (p === 1 ? result : [...prev, ...result]));
      setPage(p);
    } catch (err) {
      if (id === request.current) setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (id === request.current) setLoading(false);
    }
  };

  useEffect(() => {
    const t = setTimeout(() => void load(query, 1), query ? 350 : 0);
    return () => clearTimeout(t);
  }, [query]);

  const choose = async (photo: UnsplashPhoto) => {
    setUsing(photo.id);
    try {
      setCover(pageId, await useUnsplashPhoto(photo));
    } catch (err) {
      reportError('Foto', err);
    } finally {
      setUsing(null);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-9 items-center gap-2 rounded-md bg-bg px-2.5">
        <Search size={14} className="text-faint" />
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Fotos suchen, z. B. Berge, Büro, Herbst …"
          className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-faint"
        />
        {loading && <Loader2 size={14} className="animate-spin text-faint" />}
      </div>
      {error && <p className="mt-3 text-sm text-danger">{error}</p>}
      <div
        className="mt-3 grid min-h-0 flex-1 auto-rows-[96px] grid-cols-3 gap-2 overflow-y-auto pr-1"
        onScroll={(e) => {
          const el = e.currentTarget;
          if (!loading && photos.length && el.scrollTop + el.clientHeight > el.scrollHeight - 120) void load(query, page + 1);
        }}
      >
        {photos.map((p) => (
          <div key={p.id} className="group relative overflow-hidden rounded-md" style={{ background: p.color }}>
            <button onClick={() => void choose(p)} disabled={!!using} title={p.description} className="h-full w-full">
              <img src={p.thumb} alt={p.description} loading="lazy" draggable={false} className="h-full w-full object-cover transition-transform group-hover:scale-105" />
            </button>
            {using === p.id && (
              <div className="absolute inset-0 flex items-center justify-center bg-black/40">
                <Loader2 size={18} className="animate-spin text-white" />
              </div>
            )}
            <a
              href={p.authorUrl}
              className="absolute inset-x-0 bottom-0 truncate bg-gradient-to-t from-black/60 to-transparent px-1.5 pt-3 pb-1 text-left text-[10px] text-white opacity-0 transition-opacity group-hover:opacity-100"
            >
              {p.author}
            </a>
          </div>
        ))}
      </div>
      <p className="mt-2 text-xs text-faint">
        Fotos von{' '}
        <a href="https://unsplash.com/?utm_source=efeu&utm_medium=referral" className="hover:underline">
          Unsplash
        </a>
        , frei nutzbar. Der Name des Fotografen erscheint am Titelbild.
      </p>
    </div>
  );
}

function GradientsTab({ pageId }: { pageId: string }) {
  const [busy, setBusy] = useState<string | null>(null);
  return (
    <div className="grid auto-rows-[72px] grid-cols-4 gap-2">
      {GRADIENTS.map((g) => (
        <button
          key={g.name}
          title={g.name}
          disabled={!!busy}
          onClick={async () => {
            setBusy(g.name);
            try {
              setCover(pageId, await gradientAsset(g));
            } catch (err) {
              reportError('Titelbild', err);
            } finally {
              setBusy(null);
            }
          }}
          className="relative rounded-md transition-transform hover:scale-[1.03]"
          style={{ background: gradientCss(g) }}
        >
          {busy === g.name && <Loader2 size={16} className="absolute inset-0 m-auto animate-spin text-white" />}
        </button>
      ))}
    </div>
  );
}

export function CoverPicker() {
  const pageId = usePicker((s) => s.pageId);
  const keySet = useUnsplash((s) => s.keySet);
  const [tab, setTab] = useState<Tab>(GUEST ? 'gradients' : 'unsplash');
  if (!pageId) return null;
  const close = () => usePicker.setState({ pageId: null });
  const tabs: { id: Tab; label: string }[] = [
    ...(GUEST ? [] : [{ id: 'unsplash' as const, label: 'Unsplash' }]),
    { id: 'gradients', label: 'Farbverläufe' },
    { id: 'upload', label: 'Hochladen' },
  ];
  return (
    <Modal onClose={close} className="flex h-[min(560px,80vh)] w-[640px] flex-col p-4">
      <div className="mb-3 flex items-center gap-1">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={cx('h-8 rounded-md px-3 text-sm', tab === t.id ? 'bg-active font-medium' : 'text-muted hover:bg-hover')}
          >
            {t.label}
          </button>
        ))}
        {tab === 'unsplash' && keySet && (
          <button
            onClick={() => void setUnsplashKey(null).catch((err) => reportError('Unsplash', err))}
            className="ml-auto text-xs text-faint hover:text-muted"
          >
            Schlüssel entfernen
          </button>
        )}
      </div>
      {tab === 'unsplash' && (keySet ? <UnsplashTab pageId={pageId} /> : <UnsplashSetup />)}
      {tab === 'gradients' && <GradientsTab pageId={pageId} />}
      {tab === 'upload' && (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 text-sm text-muted">
          <button
            onClick={async () => {
              try {
                const name = await pickImage();
                if (name) setCover(pageId, name);
              } catch (err) {
                reportError('Titelbild', err);
              }
            }}
            className="flex h-9 items-center gap-2 rounded-md bg-accent px-4 font-medium text-accent-fg"
          >
            <ImageUp size={15} /> Bild auswählen …
          </button>
          <span className="text-xs text-faint">Am besten im Querformat, mindestens 1500 Pixel breit.</span>
        </div>
      )}
      {tab === 'unsplash' && !keySet && (
        <button onClick={() => void openExternal('https://unsplash.com/developers')} className="mt-auto flex items-center gap-1 self-start text-xs text-faint hover:text-muted">
          <ExternalLink size={12} /> Was ist die Unsplash API?
        </button>
      )}
    </Modal>
  );
}
