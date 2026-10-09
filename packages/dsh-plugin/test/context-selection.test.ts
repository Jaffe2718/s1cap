import test from 'node:test';
import assert from 'node:assert/strict';
import { adaptMessages, segmentEvent } from '@s1cap/core';
import type { StepObservation } from '@s1cap/core';
import { selectToolContext } from '../src/context-selection.ts';

function fixture({ padding = 0, lines = 180, budget = 118_800 } = {}) {
  const text = Array.from({ length: lines }, (_, i) => `${i}: evidence ${'x'.repeat(72)}`).join('\n');
  const message = { id: 'old-result', role: 'tool', toolCallId: 'read-1',
    content: [{ type: 'text', text }], isError: false };
  const events = new Map<number, any>([
    [1, { type: 'tool/result', data: { turn: 1, step: 2, message, meta: { path: 'logging.py' } } }],
    [2, { type: 'assistant/message', data: { message: { id: 'history', role: 'assistant',
      content: [{ type: 'reasoning', text: 'h'.repeat(padding) }] } } }],
    ...[3, 4, 5].map(seq => [seq, { type: 'user/message', data: { message: {
      id: `recent-${seq}`, role: 'user', content: [{ type: 'text', text: 'current evidence' }],
    } } }] as const),
  ]);
  const chunks = adaptMessages([message], { sessionId: 'pressure', startSeq: 1, now: 0 })
    .events.flatMap(event => segmentEvent(event));
  assert.ok(chunks.length > 1);
  const writes: { type: string; data: any; intent: any }[] = [];
  const session = {
    surface: { nodes: [1, 2, 3, 4, 5] },
    eventAt: (seq: number) => events.get(seq),
    deriveEventMessage: (event: any) => event.data.message,
    append: (type: string, data: any, intent: any) => writes.push({ type, data, intent }),
  };
  const observation = { event: { sessionId: 'pressure', budgetTotal: budget },
    layout: { tail: [], recalled: [], anchor: { id: 'anchor' } },
    fullTokens: 1_000_000, selectedTokens: 1,
  } as unknown as StepObservation;
  return { payload: { agent: { session } }, observation, chunks, message, events, session, writes };
}

test('short native history preserves original evidence despite explicit S1 rejection', () => {
  const f = fixture({ padding: 30_000 });
  const original = JSON.stringify(f.message);
  const result = selectToolContext(f.payload, f.observation, f.chunks.slice(1), 3);
  assert.match(result.reason, /short context/);
  assert.equal(result.changed, 0);
  assert.equal(f.writes.length, 0);
  assert.equal(JSON.stringify(f.message), original);
  assert.ok(result.contextTokens! < result.contextThresholdTokens!);
});

test('large visible history with a tiny selected view still permits substantial net compression', () => {
  const f = fixture({ padding: 140_000 });
  const result = selectToolContext(f.payload, f.observation, f.chunks.slice(1), 3);
  assert.equal(result.changed, 1);
  assert.ok(result.potentialSavingTokens! >= result.minimumSavingTokens!);
  const replacement = f.writes[0]!;
  assert.deepEqual(replacement.intent, { surfaceOp: { op: 'replace', startSeq: 1, endSeq: 1 }, sourceEventSeqs: [1] });
  assert.equal(replacement.data.message.toolCallId, f.message.toolCallId);
  assert.equal(replacement.data.message.isError, false);
  assert.deepEqual(replacement.data.meta, { path: 'logging.py' });
  assert.ok(replacement.data.message.content[0].text.includes(f.chunks[0]!.text));
});

test('large context does not justify a small deletion', () => {
  const f = fixture({ padding: 140_000, lines: 40 });
  const result = selectToolContext(f.payload, f.observation, f.chunks.slice(1), 3);
  assert.match(result.reason, /insufficient net savings/);
  assert.ok(result.potentialSavingTokens! > 0);
  assert.equal(f.writes.length, 0);
});

test('recalled, unjudged and recent evidence remain protected under context pressure', () => {
  const f = fixture({ padding: 140_000 });
  f.observation.layout.recalled = f.chunks;
  assert.equal(selectToolContext(f.payload, f.observation, f.chunks, 3).changed, 0);
  f.observation.layout.recalled = [];
  assert.equal(selectToolContext(f.payload, f.observation, [], 3).changed, 0);
  f.session.surface.nodes = [2, 3, 4, 5, 1];
  assert.equal(selectToolContext(f.payload, f.observation, f.chunks.slice(1), 3).changed, 0);
  assert.equal(f.writes.length, 0);
});

test('a smaller available context budget moves the pressure threshold without disabling savings checks', () => {
  const f = fixture({ padding: 35_000, budget: 20_000 });
  const result = selectToolContext(f.payload, f.observation, f.chunks.slice(1), 3);
  assert.equal(result.contextThresholdTokens, 10_000);
  assert.equal(result.changed, 1);
});

test('missing budget or unreadable surface preserves evidence', () => {
  const f = fixture({ padding: 140_000, budget: Number.NaN });
  assert.match(selectToolContext(f.payload, f.observation, f.chunks.slice(1), 3).reason, /budget unavailable/);
  f.observation.event.budgetTotal = 118_800;
  f.session.surface.nodes.push(999);
  assert.match(selectToolContext(f.payload, f.observation, f.chunks.slice(1), 3).reason, /event unavailable/);
  assert.equal(f.writes.length, 0);
});
