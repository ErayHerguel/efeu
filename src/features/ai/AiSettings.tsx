import { invoke } from '@tauri-apps/api/core';
import { Check, KeyRound } from 'lucide-react';
import { useEffect, useState } from 'react';
import { openExternal } from '../../lib/assets';
import { cx } from '../../lib/cx';
import { confirmDialog } from '../../store/confirm';
import { reportError, toast } from '../../store/toast';
import { Button, Heading } from '../settings/controls';
import { estimateCost, formatRange, formatTokens, formatUsd } from './cost';
import { MODELS, modelInfo } from './models';
import { useAi, type ConfirmMode } from './store';
import { clearUsage, FEATURE_LABELS, loadSummary, useSpend, type Feature, type UsageSummary } from './usage';

/** Typische Aktionen mit ungefährer Eingabe/Ausgabe (inkl. Denken), damit man Preise einordnen kann. */
const EXAMPLES: { label: string; input: number; output: [number, number]; searches?: [number, number] }[] = [
  { label: 'Absatz umschreiben', input: 700, output: [300, 900] },
  { label: 'Seite zusammenfassen (ca. 2000 Wörter)', input: 3_500, output: [600, 2_000] },
  { label: 'PDF mit 15 Seiten → Board', input: 25_000, output: [4_000, 10_000] },
  { label: 'Frag efeu (Antwort aus deinen Seiten)', input: 8_000, output: [800, 2_500] },
  { label: 'Recherche mit Websuche', input: 30_000, output: [3_000, 8_000], searches: [3, 5] },
];

const CONFIRM_OPTIONS: { id: ConfirmMode; label: string }[] = [
  { id: 'always', label: 'Immer' },
  { id: 'cent', label: 'Ab 1 Cent' },
  { id: 'fivecent', label: 'Ab 5 Cent' },
  { id: 'never', label: 'Nie' },
];

function KeySection() {
  const keySet = useAi((s) => s.keySet);
  const model = useAi((s) => s.model);
  const mock = useAi((s) => s.mock);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    try {
      await invoke('ai_key_set', { key: draft });
      setDraft('');
      useAi.getState().setKeySet(true);
      await invoke('ai_test', { model });
      toast('Schlüssel gespeichert, Verbindung klappt');
    } catch (err) {
      reportError('Schlüssel', err);
    } finally {
      setBusy(false);
    }
  };

  const test = async () => {
    setBusy(true);
    try {
      await invoke('ai_test', { model });
      toast('Verbindung klappt (der Test kostet nichts)');
    } catch (err) {
      reportError('Verbindungstest', err);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    const ok = await confirmDialog({
      title: 'API-Schlüssel entfernen?',
      message: 'efeu löscht den Schlüssel aus dem Schlüsselbund. Die KI-Funktionen sind danach aus, bis du wieder einen einträgst.',
      confirmLabel: 'Entfernen',
      danger: true,
    });
    if (!ok) return;
    try {
      await invoke('ai_key_delete');
      useAi.getState().setKeySet(false);
    } catch (err) {
      reportError('Schlüssel entfernen', err);
    }
  };

  return (
    <section>
      <Heading>API-Schlüssel</Heading>
      {mock && <p className="mb-2 rounded-md bg-hover px-3 py-2 text-xs text-muted">Testmodus: Claude wird simuliert, es entstehen keine Kosten.</p>}
      {keySet ? (
        <div className="flex items-center gap-2">
          <span className="flex flex-1 items-center gap-1.5 text-sm">
            <Check size={15} className="text-[var(--c-tag-green-fg)]" /> Schlüssel liegt im Schlüsselbund
          </span>
          <Button onClick={() => void test()} disabled={busy}>
            Verbindung testen
          </Button>
          <Button onClick={() => void remove()}>Entfernen</Button>
        </div>
      ) : (
        <>
          <p className="mb-2 text-sm text-muted">
            efeu nutzt Claude von Anthropic mit deinem eigenen Schlüssel. Du zahlst nur, was du verbrauchst, direkt bei Anthropic. Ohne
            Schlüssel bleibt efeu komplett offline.
          </p>
          <div className="flex gap-2">
            <input
              type="password"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && draft && void save()}
              placeholder="sk-ant-…"
              aria-label="API-Schlüssel"
              autoComplete="off"
              spellCheck={false}
              className="h-8 min-w-0 flex-1 rounded-md border border-border bg-bg px-2 font-mono text-sm outline-none focus:border-border-strong"
            />
            <Button primary onClick={() => void save()} disabled={!draft || busy}>
              <KeyRound size={14} /> Speichern
            </Button>
          </div>
          <button
            onClick={() => void openExternal('https://console.anthropic.com/settings/keys')}
            className="mt-2 text-xs text-accent hover:underline"
          >
            Schlüssel erstellen auf console.anthropic.com
          </button>
        </>
      )}
      <p className="mt-2 text-xs text-faint">
        Der Schlüssel liegt im Schlüsselbund deines Systems, nie in der efeu-Datenbank. Anfragen gehen nur an api.anthropic.com und nur,
        wenn du eine KI-Aktion startest. Gäste und verbundene Geräte können die KI nicht nutzen.
      </p>
    </section>
  );
}

function ModelSection() {
  const model = useAi((s) => s.model);
  return (
    <section>
      <Heading>Standardmodell</Heading>
      <div className="space-y-1.5">
        {MODELS.map((m) => (
          <button
            key={m.id}
            onClick={() => useAi.getState().setModel(m.id)}
            className={cx(
              'flex w-full items-center gap-3 rounded-md border px-3 py-2 text-left',
              m.id === model ? 'border-accent bg-accent-soft' : 'border-border hover:bg-hover',
            )}
          >
            <span className={cx('h-3.5 w-3.5 shrink-0 rounded-full border-2', m.id === model ? 'border-accent bg-accent' : 'border-border-strong')} />
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium">{m.name}</span>
              <span className="block text-xs text-faint">{m.hint}</span>
            </span>
            <span className="shrink-0 text-right text-xs text-muted tabular-nums">
              {m.input.toLocaleString('de-DE')} $ / {m.output.toLocaleString('de-DE')} $
              <span className="block text-faint">pro 1 Mio. Tokens ein/aus</span>
            </span>
          </button>
        ))}
      </div>
      <p className="mt-2 text-xs text-faint">Im Kostendialog kannst du für jede einzelne Aktion ein anderes Modell wählen.</p>
    </section>
  );
}

/** Was typische Aktionen ungefähr kosten, für alle Modelle nebeneinander. */
function PriceExamples() {
  return (
    <section>
      <Heading>Was kostet was? (ungefähr)</Heading>
      <div className="overflow-hidden rounded-md border border-border">
        <table className="w-full text-xs">
          <thead className="bg-hover text-faint">
            <tr>
              <th className="px-2 py-1.5 text-left font-medium">Aktion</th>
              {MODELS.map((m) => (
                <th key={m.id} className="px-2 py-1.5 text-right font-medium">
                  {m.short}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {EXAMPLES.map((ex) => (
              <tr key={ex.label} className="border-t border-border">
                <td className="px-2 py-1.5">{ex.label}</td>
                {MODELS.map((m) => {
                  const e = estimateCost(m.id, ex.input, ex.output, ex.searches);
                  return (
                    <td key={m.id} className="px-2 py-1.5 text-right whitespace-nowrap tabular-nums">
                      {formatRange(e.low, e.high)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-xs text-faint">
        Beispiel: Mit 5 $ Guthaben kannst du mit Haiku tausende Absätze umschreiben, mit Opus etwa 15–25 Boards aus PDFs erstellen.
        Websuche kostet zusätzlich 1 Cent pro Suche.
      </p>
    </section>
  );
}

function SpendingSection() {
  const confirm = useAi((s) => s.confirm);
  const budget = useAi((s) => s.budget);
  const [budgetDraft, setBudgetDraft] = useState(budget ? String(budget).replace('.', ',') : '');
  return (
    <section className="space-y-4">
      <div>
        <Heading>Kosten vorher bestätigen</Heading>
        <div className="flex gap-1.5">
          {CONFIRM_OPTIONS.map((o) => (
            <button
              key={o.id}
              onClick={() => useAi.getState().setConfirm(o.id)}
              className={cx(
                'h-8 flex-1 rounded-md border text-sm',
                confirm === o.id ? 'border-accent bg-accent-soft' : 'border-border text-muted hover:bg-hover',
              )}
            >
              {o.label}
            </button>
          ))}
        </div>
        <p className="mt-1.5 text-xs text-faint">
          Vor teureren Aktionen zeigt efeu die geschätzten Kosten für jedes Modell und fragt nach. Droht das Monatsbudget überschritten
          zu werden, fragt efeu immer.
        </p>
      </div>
      <div>
        <Heading>Monatsbudget</Heading>
        <div className="flex items-center gap-2">
          <input
            value={budgetDraft}
            inputMode="decimal"
            onChange={(e) => setBudgetDraft(e.target.value)}
            onBlur={() => {
              const value = Number(budgetDraft.replace(',', '.'));
              useAi.getState().setBudget(Number.isFinite(value) ? value : 0);
            }}
            placeholder="kein Limit"
            aria-label="Monatsbudget in US-Dollar"
            className="h-8 w-28 rounded-md border border-border bg-bg px-2 text-sm tabular-nums outline-none focus:border-border-strong"
          />
          <span className="text-sm text-muted">$ pro Monat</span>
        </div>
      </div>
    </section>
  );
}

function Bars({ rows, label }: { rows: { key: string; cost: number; count: number }[]; label: (key: string) => string }) {
  const max = Math.max(...rows.map((r) => r.cost), 0.000001);
  return (
    <div className="space-y-1.5">
      {rows.map((r) => (
        <div key={r.key} className="text-xs">
          <div className="flex justify-between gap-2">
            <span className="truncate">
              {label(r.key)} <span className="text-faint">· {r.count}×</span>
            </span>
            <span className="tabular-nums">{formatUsd(r.cost)}</span>
          </div>
          <div className="mt-0.5 h-1.5 rounded-full bg-hover">
            <div className="h-1.5 rounded-full bg-accent" style={{ width: `${Math.max(2, (r.cost / max) * 100)}%` }} />
          </div>
        </div>
      ))}
    </div>
  );
}

const time = new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

function Overview() {
  const version = useSpend((s) => s.version);
  const budget = useAi((s) => s.budget);
  const [summary, setSummary] = useState<UsageSummary | null>(null);

  useEffect(() => {
    loadSummary()
      .then(setSummary)
      .catch((err) => reportError('Kostenübersicht', err));
  }, [version]);

  if (!summary) return null;
  const reset = async () => {
    const ok = await confirmDialog({
      title: 'Kostenverlauf zurücksetzen?',
      message: 'Die Übersicht in efeu beginnt wieder bei null. Deine Abrechnung bei Anthropic ändert sich dadurch nicht.',
      confirmLabel: 'Zurücksetzen',
      danger: true,
    });
    if (ok) await clearUsage().catch((err) => reportError('Zurücksetzen', err));
  };

  const share = budget > 0 ? Math.min(1, summary.month / budget) : 0;
  return (
    <section className="space-y-4">
      <Heading>Kostenübersicht</Heading>
      <div className="grid grid-cols-3 gap-2">
        {[
          ['Heute', summary.today],
          ['Dieser Monat', summary.month],
          ['Insgesamt', summary.total],
        ].map(([label, value]) => (
          <div key={label as string} className="rounded-md border border-border px-3 py-2">
            <div className="text-xs text-faint">{label}</div>
            <div className="text-lg font-semibold tabular-nums">{formatUsd(value as number)}</div>
          </div>
        ))}
      </div>
      {budget > 0 && (
        <div>
          <div className="flex justify-between text-xs text-muted">
            <span>Monatsbudget</span>
            <span className="tabular-nums">
              {formatUsd(summary.month)} von {formatUsd(budget)}
            </span>
          </div>
          <div className="mt-1 h-2 rounded-full bg-hover">
            <div className={cx('h-2 rounded-full', share >= 0.9 ? 'bg-danger' : 'bg-accent')} style={{ width: `${share * 100}%` }} />
          </div>
        </div>
      )}
      {summary.monthCount > 0 ? (
        <div className="grid grid-cols-2 gap-5">
          <div>
            <div className="mb-1.5 text-xs font-medium text-faint">Nach Funktion (Monat)</div>
            <Bars rows={summary.byFeature} label={(k) => FEATURE_LABELS[k as Feature] ?? k} />
          </div>
          <div>
            <div className="mb-1.5 text-xs font-medium text-faint">Nach Modell (Monat)</div>
            <Bars rows={summary.byModel} label={(k) => modelInfo(k).name} />
          </div>
        </div>
      ) : (
        <p className="text-sm text-faint">Diesen Monat noch keine KI-Anfragen.</p>
      )}
      {summary.recent.length > 0 && (
        <div>
          <div className="mb-1.5 text-xs font-medium text-faint">Letzte Anfragen</div>
          <div className="max-h-56 overflow-y-auto rounded-md border border-border">
            <table className="w-full text-xs">
              <tbody>
                {summary.recent.map((r) => (
                  <tr key={r.id} className="border-b border-border last:border-0">
                    <td className="px-2 py-1.5 whitespace-nowrap text-faint tabular-nums">{time.format(r.createdAt)}</td>
                    <td className="px-2 py-1.5">
                      {FEATURE_LABELS[r.feature] ?? r.feature}
                      {r.status === 'cancelled' && <span className="text-faint"> (abgebrochen)</span>}
                      {r.status === 'error' && <span className="text-faint"> (Fehler)</span>}
                    </td>
                    <td className="px-2 py-1.5 text-muted">{modelInfo(r.model).short}</td>
                    <td className="px-2 py-1.5 text-right whitespace-nowrap text-faint tabular-nums">
                      {formatTokens(r.inputTokens)} → {formatTokens(r.outputTokens)}
                      {r.webSearches > 0 && ` · ${r.webSearches} Suchen`}
                    </td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{formatUsd(r.costUsd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      <div className="flex items-center gap-2">
        <Button onClick={() => void openExternal('https://console.anthropic.com/settings/billing')}>Guthaben bei Anthropic ansehen</Button>
        {summary.total > 0 && <Button onClick={() => void reset()}>Verlauf zurücksetzen</Button>}
      </div>
      <p className="text-xs text-faint">
        Berechnet aus den Token-Angaben jeder Antwort zu Listenpreisen. Maßgeblich ist die Abrechnung bei Anthropic. Gespeichert werden
        nur Zahlen, keine Inhalte.
      </p>
    </section>
  );
}

export function AiSettings() {
  return (
    <div className="space-y-7">
      <KeySection />
      <Overview />
      <SpendingSection />
      <ModelSection />
      <PriceExamples />
    </div>
  );
}
