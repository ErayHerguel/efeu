import { describe, expect, it } from 'vitest';
import { MessageAccumulator } from './stream';

const events = [
  { type: 'message_start', message: { model: 'claude-opus-5-5', usage: { input_tokens: 120, output_tokens: 1, cache_read_input_tokens: 0 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'content_block_start', index: 1, content_block: { type: 'server_tool_use', id: 'srv_1', name: 'web_search', input: {} } },
  { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"query":' } },
  { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"efeu"}' } },
  { type: 'content_block_stop', index: 1 },
  { type: 'content_block_start', index: 2, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: 'Hallo ' } },
  { type: 'content_block_delta', index: 2, delta: { type: 'citations_delta', citation: { url: 'https://a.de', title: 'A' } } },
  { type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: 'Welt' } },
  { type: 'content_block_stop', index: 2 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 42, server_tool_use: { web_search_requests: 1 } } },
  { type: 'message_stop' },
];

describe('MessageAccumulator', () => {
  it('setzt Text, Werkzeuge, Quellen und Verbrauch zusammen', () => {
    const deltas: string[] = [];
    const acc = new MessageAccumulator((d) => deltas.push(d));
    for (const e of events) acc.handle(e);
    expect(acc.text).toBe('Hallo Welt');
    expect(deltas).toEqual(['Hallo ', 'Welt']);
    expect(acc.content[0]).toMatchObject({ type: 'thinking', signature: 'sig' });
    expect(acc.content[1].input).toEqual({ query: 'efeu' });
    expect(acc.citations).toEqual([{ url: 'https://a.de', title: 'A' }]);
    expect(acc.stopReason).toBe('end_turn');
    expect(acc.model).toBe('claude-opus-5-5');
    expect(acc.usage).toEqual({ inputTokens: 120, outputTokens: 42, cacheReadTokens: 0, cacheWriteTokens: 0, webSearches: 1 });
  });
});
