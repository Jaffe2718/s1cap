import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultPolicy } from '@s1cap/core';
import { createStepObserver } from '../src/step-observer.ts';

function fixture() {
  const policy = defaultPolicy();
  policy.recall.anchorWaitMs = 0;
  policy.recall.depth = 1;
  let calls = 0;
  const observer = createStepObserver({ policy, sessionId: 's', emit: () => {}, now: () => 0,
    contextWindow: 10000, reserveOutputTokens: 100, fixedOverheadTokens: 0, lambdaMs: 0,
    scoreBatch: async (_current, candidates) => { calls++; return candidates.map(() => 0.9); },
  });
  return { observer, calls: () => calls };
}
const messages = [
  { id: 'q', role: 'user', content: [{ type: 'text', text: 'Fix timeout handling.' }] },
  { id: 'a', role: 'assistant', content: [{ type: 'text', text: 'Inspect the connection pool.' }] },
  { id: 'b', role: 'user', content: [{ type: 'text', text: 'Preserve rollback semantics.' }] },
];

test('fully visible history still receives S1 selection; scored pairs are reused after compaction', async () => {
  const { observer, calls } = fixture();
  await observer.observe({ messages, step: 2 }, { visibleMessages: messages });
  assert.equal(calls(), 1);
  assert.equal(observer.stats().recallVisibleSkips, 0);
  await observer.observe({ messages: [], step: 3 }, { visibleMessages: messages.slice(-1) });
  assert.equal(calls(), 1, 'the same anchor reuses its already scored row');
});

test('missing or incomplete visibility never suppresses scoring', async () => {
  for (const visibleMessages of [undefined, [{ id: 'a', content: 'Inspect' }]]) {
    const { observer, calls } = fixture();
    await observer.observe({ messages, step: 2 }, { visibleMessages });
    assert.equal(calls(), 1);
    assert.equal(observer.stats().recallVisibleSkips, 0);
  }
});

test('forked sessions with identical event ids keep their own first trace', async () => {
  const { observer } = fixture();
  const observe = async (sessionId: string, trace: string) => observer.observe({
    agent: { session: { id: sessionId } }, step: 2,
    messages: [messages[0], { id: 'trace', role: 'assistant', content: [{ type: 'reasoning', text: trace }] }],
  });
  const left = await observe('left', 'Check alpha migration.');
  const right = await observe('right', 'Check beta rollback.');
  const leftAgain = await observer.observe({ agent: { session: { id: 'left' } }, messages: [], step: 3 });
  assert.ok(left?.layout.stateProxy?.includes('alpha migration'));
  assert.ok(right?.layout.stateProxy?.includes('beta rollback'));
  assert.equal(leftAgain?.layout.stateProxy, left?.layout.stateProxy);
});
