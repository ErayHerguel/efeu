import type { AiRequest } from './client';
import { AiCancelled } from './errors';
import type { ModelId } from './models';
import type { MessageAccumulator } from './stream';

/**
 * Simulierter Claude für Entwicklungs-Builds (EFEU_AI_MOCK=1): erzeugt dieselben Stream-Ereignisse
 * wie die API, mit plausiblen Token-Zahlen, aber ohne Netzwerk, Schlüssel und Kosten.
 */

const charsPerToken = 3.5;

/** Grobe Token-Zählung; PDFs zählen pauschal pro Dokument. */
export function mockCount(req: Pick<AiRequest, 'system' | 'messages'>): number {
  let chars = req.system.length;
  let documents = 0;
  for (const m of req.messages) {
    if (typeof m.content === 'string') {
      chars += m.content.length;
      continue;
    }
    for (const block of m.content) {
      if (block.type === 'document') documents++;
      else chars += JSON.stringify(block).length;
    }
  }
  return Math.ceil(chars / charsPerToken) + documents * 18_000;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new DOMException('abgebrochen', 'AbortError'));
    });
  });

export async function mockStream(req: AiRequest, model: ModelId, acc: MessageAccumulator, signal?: AbortSignal): Promise<void> {
  const text = req.mock?.() ?? `Simulierte Antwort für „${req.title}“.`;
  const input = mockCount(req);
  try {
    acc.handle({ type: 'message_start', message: { model, usage: { input_tokens: input, output_tokens: 1 } } });
    acc.handle({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    await sleep(400, signal);
    for (let i = 0; i < text.length; i += 24) {
      acc.handle({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: text.slice(i, i + 24) } });
      await sleep(20, signal);
    }
    acc.handle({ type: 'content_block_stop', index: 0 });
    const thinking = req.effort === 'low' ? 150 : req.effort === 'medium' ? 600 : 1500;
    acc.handle({
      type: 'message_delta',
      delta: { stop_reason: 'end_turn' },
      usage: {
        output_tokens: Math.ceil(text.length / charsPerToken) + thinking,
        server_tool_use: { web_search_requests: req.webSearch ? Math.min(3, req.webSearch) : 0 },
      },
    });
  } catch {
    throw new AiCancelled();
  }
}
