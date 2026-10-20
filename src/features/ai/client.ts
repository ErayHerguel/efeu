import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { create } from 'zustand';
import { useUI } from '../../store/ui';
import { costOf, estimateCost, formatUsd, type Estimate, type Usage } from './cost';
import { AiCancelled, AiError } from './errors';
import { mockCount, mockStream } from './mock';
import { MODELS, modelInfo, type ModelId } from './models';
import { addUsage, MessageAccumulator, type Block, type Citation } from './stream';
import { CONFIRM_THRESHOLD, useAi } from './store';
import { FEATURE_LABELS, logUsage, refreshSpend, useSpend, type Feature, type UsageStatus } from './usage';

export type Content = string | Block[];
export interface Message {
  role: 'user' | 'assistant';
  content: Content;
}

export interface AiRequest {
  feature: Feature;
  /** Kurze Beschreibung für den Kostendialog, z. B. „Absatz kürzen“ */
  title: string;
  system: string;
  messages: Message[];
  maxTokens: number;
  effort: 'low' | 'medium' | 'high';
  /** Geschätzte Ausgabe-Tokens inkl. Denken [wenig, viel] für die Kostenschätzung */
  output: [number, number];
  /** JSON-Schema: Antwort kommt als garantiert gültiges JSON */
  schema?: Record<string, unknown>;
  /** Websuche erlauben, höchstens so viele Suchen */
  webSearch?: number;
  /** Zusätzliche Eingabe, die erst während der Antwort entsteht (z. B. Suchergebnisse) [wenig, viel] */
  extraInput?: [number, number];
  /** Antwort des simulierten Claude (nur Entwicklungs-Builds) */
  mock?: () => string;
}

export interface AiResult {
  text: string;
  content: Block[];
  citations: Citation[];
  usage: Usage;
  cost: number;
  model: string;
  stopReason: string | null;
}

export { AiCancelled, AiError } from './errors';

const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

function tools(req: AiRequest, model: ModelId): Block[] | undefined {
  if (!req.webSearch) return undefined;
  // Die Suche mit dynamischer Filterung gibt es nur für Opus und Sonnet.
  const type = model === 'claude-haiku-5-5' ? 'web_search_20250305' : 'web_search_20260209';
  return [{ type, name: 'web_search', max_uses: req.webSearch }];
}

function requestBody(req: AiRequest, model: ModelId, messages: Message[]): { body: Record<string, unknown>; betas: string[] } {
  const body: Record<string, unknown> = {
    model,
    max_tokens: req.maxTokens,
    system: req.system,
    messages,
    output_config: { effort: req.effort, ...(req.schema ? { format: { type: 'json_schema', schema: req.schema } } : {}) },
  };
  const t = tools(req, model);
  if (t) body.tools = t;
  if (!modelInfo(model).fallback) return { body, betas: [] };
  // Lehnt das Modell ab, übernimmt serverseitig das passende Ersatzmodell, statt leer zurückzukommen.
  body.fallbacks = 'default';
  return { body, betas: [FALLBACK_BETA] };
}

/** Zählt die Eingabe-Tokens (kostenlos bei Anthropic). */
async function countInput(req: AiRequest, model: ModelId): Promise<number> {
  if (useAi.getState().mock) return mockCount(req);
  const body: Record<string, unknown> = { model, system: req.system, messages: req.messages };
  const t = tools(req, model);
  if (t) body.tools = t;
  return invoke<number>('ai_count', { body, betas: [] });
}

export interface Prepared {
  inputTokens: number;
  estimates: Estimate[];
}

/** Kostenschätzung für alle Modelle (Eingabe genau gezählt, Ausgabe als Spanne). */
export async function prepare(req: AiRequest): Promise<Prepared> {
  const inputTokens = await countInput(req, useAi.getState().model);
  const searches: [number, number] = req.webSearch ? [Math.min(2, req.webSearch), req.webSearch] : [0, 0];
  const [extraLow, extraHigh] = req.extraInput ?? [0, 0];
  const estimates = MODELS.map((m) => ({
    model: m.id,
    inputTokens,
    low: estimateCost(m.id, inputTokens + extraLow, [req.output[0], req.output[0]], [searches[0], searches[0]]).low,
    high: estimateCost(m.id, inputTokens + extraHigh, [req.output[1], req.output[1]], [searches[1], searches[1]]).high,
  }));
  return { inputTokens, estimates };
}

let counter = 0;

/** Eine gestreamte Anfrage an Claude; setzt nach `pause_turn` (lange Websuche) automatisch fort. */
export async function run(
  req: AiRequest,
  model: ModelId,
  opts: { onText?: (delta: string, full: string) => void; signal?: AbortSignal } = {},
): Promise<AiResult> {
  let messages = [...req.messages];
  let total: Usage | null = null;
  let content: Block[] = [];
  let text = '';
  let served = model as string;
  let status: UsageStatus = 'ok';
  const citations: Citation[] = [];
  let last: MessageAccumulator | null = null;
  try {
    for (let turn = 0; turn < 5; turn++) {
      const prefix = text;
      const acc = new MessageAccumulator(opts.onText ? (delta, full) => opts.onText?.(delta, prefix + full) : undefined);
      last = acc;
      await streamOnce(req, model, messages, acc, opts.signal);
      total = total ? addUsage(total, acc.usage) : acc.usage;
      content = [...content, ...acc.replayContent];
      text += acc.text;
      citations.push(...acc.citations.filter((c) => !citations.some((x) => x.url === c.url)));
      served = acc.model || served;
      if (acc.stopReason === 'refusal') throw new AiError('Claude hat diese Anfrage abgelehnt.');
      if (acc.stopReason !== 'pause_turn') {
        const cost = await logUsage(req.feature, served, total, 'ok').catch(() => costOf(served, total ?? acc.usage));
        return { text, content, citations, usage: total, cost, model: served, stopReason: acc.stopReason };
      }
      // Fortsetzen: bisherige Antwort unverändert anhängen, die API macht dort weiter.
      messages = [...messages, { role: 'assistant', content: acc.replayContent }];
      last = null;
    }
    throw new AiError('Claude hat die Antwort nicht abgeschlossen.');
  } catch (err) {
    status = err instanceof AiCancelled ? 'cancelled' : 'error';
    // Auch abgebrochene Anfragen kosten: bisherigen Verbrauch festhalten (Ausgabe grob aus dem Text geschätzt).
    let usage = total;
    if (last) {
      const partial = { ...last.usage, outputTokens: Math.max(last.usage.outputTokens, Math.ceil(last.text.length / 3.5)) };
      usage = usage ? addUsage(usage, partial) : partial;
    }
    if (usage) await logUsage(req.feature, served, usage, status).catch(() => undefined);
    throw err;
  }
}

async function streamOnce(req: AiRequest, model: ModelId, messages: Message[], acc: MessageAccumulator, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new AiCancelled();
  if (useAi.getState().mock) return mockStream(req, model, acc, signal);
  const id = `ai-${Date.now()}-${++counter}`;
  const { body, betas } = requestBody(req, model, messages);
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let off: (() => void) | null = null;
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      off?.();
      signal?.removeEventListener('abort', onAbort);
      if (err) reject(err);
      else resolve();
    };
    const onAbort = () => {
      void invoke('ai_cancel', { id });
      finish(new AiCancelled());
    };
    signal?.addEventListener('abort', onAbort);
    listen<{ id: string; event?: Record<string, unknown>; error?: string; done: boolean }>('ai-stream', ({ payload }) => {
      if (payload.id !== id || settled) return;
      if (payload.event) acc.handle(payload.event);
      if (payload.done) finish(payload.error ? new AiError(payload.error) : undefined);
    })
      .then((unlisten) => {
        off = unlisten;
        if (settled) return unlisten();
        return invoke('ai_stream', { id, body, betas });
      })
      .catch((err) => finish(new AiError(err instanceof Error ? err.message : String(err))));
  });
}

/* ---------- Kostendialog ---------- */

export interface ConfirmRequest {
  req: AiRequest;
  prepared: Prepared;
  model: ModelId;
  resolve: (model: ModelId | null) => void;
}

export const useAiConfirm = create<{ request: ConfirmRequest | null }>(() => ({ request: null }));

function askConfirm(req: AiRequest, prepared: Prepared, model: ModelId): Promise<ModelId | null> {
  useAiConfirm.getState().request?.resolve(null);
  return new Promise((resolve) => {
    useAiConfirm.setState({
      request: {
        req,
        prepared,
        model,
        resolve: (chosen) => {
          useAiConfirm.setState({ request: null });
          resolve(chosen);
        },
      },
    });
  });
}

/** Würde diese Anfrage das Monatsbudget sprengen? */
export function overBudget(estimateHigh: number): boolean {
  const { budget } = useAi.getState();
  return budget > 0 && useSpend.getState().month + estimateHigh > budget;
}

/**
 * Der normale Weg für alle KI-Funktionen: Schlüssel prüfen, Kosten schätzen, je nach Einstellung
 * (und immer bei drohender Budget-Überschreitung) bestätigen lassen, dann ausführen.
 * Liefert `null`, wenn der Nutzer abbricht.
 */
export async function askAi(
  req: AiRequest,
  opts: { onText?: (delta: string, full: string) => void; signal?: AbortSignal; onStart?: (model: ModelId) => void } = {},
): Promise<AiResult | null> {
  const state = useAi.getState();
  if (!state.available) throw new AiError('KI gibt es nur in der efeu-App.');
  if (!state.keySet && !state.mock) {
    useUI.getState().setOverlay('settings');
    useSettingsSection.setState({ section: 'ai' });
    throw new AiError('Trag zuerst deinen API-Schlüssel ein (Einstellungen → KI).');
  }
  await refreshSpend().catch(() => undefined);
  const prepared = await prepare(req);
  let model = state.model;
  const estimate = prepared.estimates.find((e) => e.model === model);
  const needsConfirm = !estimate || estimate.high >= CONFIRM_THRESHOLD[state.confirm] || overBudget(estimate.high);
  if (needsConfirm) {
    const chosen = await askConfirm(req, prepared, model);
    if (!chosen) return null;
    model = chosen;
  }
  opts.onStart?.(model);
  return run(req, model, opts);
}

/** Welcher Bereich der Einstellungen beim Öffnen gezeigt wird (z. B. „KI“ nach einem Hinweis). */
export const useSettingsSection = create<{ section: string | null }>(() => ({ section: null }));

export const featureLabel = (feature: Feature) => FEATURE_LABELS[feature];

/** Kosten einer fertigen Anfrage, kurz für Hinweise: „Opus · 0,012 $“ */
export function costNote(result: AiResult): string {
  return `${modelInfo(result.model).short} · ${formatUsd(result.cost)}`;
}
