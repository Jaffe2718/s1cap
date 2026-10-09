import test from 'node:test';
import assert from 'node:assert/strict';
import { adaptMessages, adaptSessionEvent, defaultPolicy, segmentEvent } from '@s1cap/core';
import { contextVisibility, deliverContext } from '../src/context-delivery.ts';
import { createStepObserver } from '../src/step-observer.ts';

const options = { sessionId: 'structured', startSeq: 1, now: 0 };
const call = { type: 'tool-call', id: 'call-1', name: 'read', arguments: '{"path":"point.py"}' };
const assistant = { id: 'assistant-1', role: 'assistant', content: [
  { type: 'reasoning', text: 'Inspect dimensions before changing distance. '.repeat(60) },
  { type: 'text', text: 'Read the implementation.' }, call,
] };
const callEvent = { type: 'tool/call', seq: 2, data: { callId: call.id, name: call.name, arguments: call.arguments } };
const originals = () => [
  ...adaptMessages([assistant], options).events,
  ...adaptSessionEvent(callEvent, options).events,
].flatMap((event) => segmentEvent(event));

test('structured assistant messages and separate tool-call events are already visible', () => {
  const before = JSON.stringify(assistant);
  const visibility = contextVisibility([assistant]);
  for (const segment of originals()) assert.ok(visibility.containsSegment(segment), segment.id);
  const delivery = deliverContext({ enabled: true, trigger: 'every-step', step: 2,
    order: ['recalled', 'anchor'], recalled: originals(), anchor: originals()[0]!,
    messages: [], visibleMessages: [assistant] });
  assert.equal(delivery.delivered, false);
  assert.equal(JSON.stringify(assistant), before, 'the harness message must remain untouched');
});

test('changed arguments and removed reasoning do not prove old content is still visible', () => {
  const changed = { ...assistant, content: [
    { type: 'text', text: 'Read the implementation.' }, { ...call, arguments: '{"path":"other.py"}' },
  ] };
  const visibility = contextVisibility([changed]);
  const originalEvents = [
    ...adaptMessages([assistant], options).events, ...adaptSessionEvent(callEvent, options).events,
  ];
  for (const segment of originalEvents) assert.equal(visibility.containsSegment(segment), false);
  assert.equal(contextVisibility([{ ...assistant, id: 'different' }]).containsSegment(originalEvents[0]!), false);
  assert.equal(contextVisibility([{ ...assistant, role: 'user' }]).containsSegment(originalEvents[1]!), false);
});

test('native mixed-part tool steps receive S1 selection even when fully visible', async () => {
  let calls = 0;
  const policy = defaultPolicy();
  policy.recall.anchorWaitMs = 0;
  policy.recall.depth = 1;
  const observer = createStepObserver({ policy, sessionId: options.sessionId,
    emit: () => {}, now: () => 0, contextWindow: 10000, reserveOutputTokens: 100,
    fixedOverheadTokens: 0, lambdaMs: 0,
    scoreBatch: async (_current, candidates) => { calls++; return candidates.map(() => 0.9); },
  });
  observer.noteSessionEvent({ ...callEvent, sessionId: options.sessionId });
  await observer.observe({ messages: [assistant], step: 2 }, { visibleMessages: [assistant] });
  assert.ok(calls > 0, 'visibility must not disable S1 governance');
  assert.equal(observer.stats().recallVisibleSkips, 0);
  await observer.observe({ messages: [], step: 3 }, { visibleMessages: [] });
  assert.ok(calls > 0, 'lost original content must still activate the recall lane');
});
