import { create } from 'zustand';
import { db } from '../../db/driver';
import { commit } from '../../db/saveQueue';
import { costOf, type Usage } from './cost';

export type Feature = 'lecture' | 'explain' | 'page' | 'database' | 'rewrite' | 'summarize' | 'tasks' | 'continue' | 'board' | 'cluster' | 'ask' | 'research';

export const FEATURE_LABELS: Record<Feature, string> = {
  lecture: 'Vorlesung',
  explain: 'Erklären',
  page: 'Seite bearbeiten',
  database: 'Datenbank füllen',
  rewrite: 'Text bearbeiten',
  summarize: 'Zusammenfassen',
  tasks: 'Aufgaben herausziehen',
  continue: 'Weiterschreiben',
  board: 'Board erstellen/bearbeiten',
  cluster: 'Post-its clustern',
  ask: 'Frag efeu',
  research: 'Recherche',
};

export type UsageStatus = 'ok' | 'cancelled' | 'error';

export interface UsageRow {
  id: number;
  createdAt: number;
  feature: Feature;
  model: string;
  inputTokens: number;
  outputTokens: number;
  webSearches: number;
  costUsd: number;
  status: UsageStatus;
}

export interface Group {
  key: string;
  cost: number;
  count: number;
}

export interface UsageSummary {
  today: number;
  month: number;
  total: number;
  monthCount: number;
  byFeature: Group[];
  byModel: Group[];
  recent: UsageRow[];
}

/** Ausgaben im laufenden Monat; aktualisiert sich nach jeder Anfrage (für Budget-Hinweise). */
export const useSpend = create<{ month: number; version: number }>(() => ({ month: 0, version: 0 }));

export function startOfDay(now = new Date()): number {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
}

export function startOfMonth(now = new Date()): number {
  return new Date(now.getFullYear(), now.getMonth(), 1).getTime();
}

export async function logUsage(feature: Feature, model: string, usage: Usage, status: UsageStatus): Promise<number> {
  const cost = costOf(model, usage);
  if (usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens === 0) return 0;
  await commit([
    {
      sql: `INSERT INTO ai_usage (created_at, feature, model, input_tokens, output_tokens, cache_read_tokens,
              cache_write_tokens, web_searches, cost_usd, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [
        Date.now(),
        feature,
        model,
        usage.inputTokens,
        usage.outputTokens,
        usage.cacheReadTokens,
        usage.cacheWriteTokens,
        usage.webSearches,
        cost,
        status,
      ],
    },
  ]);
  await refreshSpend();
  return cost;
}

export async function refreshSpend(): Promise<void> {
  const [row] = await db().select<{ cost: number | null }>('SELECT SUM(cost_usd) AS cost FROM ai_usage WHERE created_at >= ?', [
    startOfMonth(),
  ]);
  useSpend.setState((s) => ({ month: row?.cost ?? 0, version: s.version + 1 }));
}

export async function loadSummary(): Promise<UsageSummary> {
  const month = startOfMonth();
  const day = startOfDay();
  const sums = await db().select<{ today: number | null; month: number | null; total: number | null; monthCount: number }>(
    `SELECT SUM(CASE WHEN created_at >= ? THEN cost_usd END) AS today,
            SUM(CASE WHEN created_at >= ? THEN cost_usd END) AS month,
            SUM(cost_usd) AS total,
            COUNT(CASE WHEN created_at >= ? THEN 1 END) AS monthCount
     FROM ai_usage`,
    [day, month, month],
  );
  const group = (column: 'feature' | 'model') =>
    db().select<Group>(
      `SELECT ${column} AS key, SUM(cost_usd) AS cost, COUNT(*) AS count FROM ai_usage
       WHERE created_at >= ? GROUP BY ${column} ORDER BY cost DESC`,
      [month],
    );
  const [byFeature, byModel, recent] = await Promise.all([
    group('feature'),
    group('model'),
    db().select<UsageRow>(
      `SELECT id, created_at AS createdAt, feature, model, input_tokens AS inputTokens, output_tokens AS outputTokens,
              web_searches AS webSearches, cost_usd AS costUsd, status
       FROM ai_usage ORDER BY created_at DESC LIMIT 25`,
    ),
  ]);
  const s = sums[0];
  return {
    today: s?.today ?? 0,
    month: s?.month ?? 0,
    total: s?.total ?? 0,
    monthCount: s?.monthCount ?? 0,
    byFeature,
    byModel,
    recent,
  };
}

export async function clearUsage(): Promise<void> {
  await commit([{ sql: 'DELETE FROM ai_usage' }]);
  await refreshSpend();
}
