/**
 * The asynchronous upkeep lane and the system-prompt capture it relies on.
 *
 * The point of the queue is that assembly never waits: `agent/pre-step` has a hard deadline, so graph upkeep
 * is bounded per tick, droppable under pressure, and incapable of throwing into the harness.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createUpkeepQueue, extractSystemPrompt } from '../src/index.ts';

test('the queue drains in bounded ticks and keeps arrival order', () => {
  const seen: number[] = [];
  const queue = createUpkeepQueue<number>({ maxPerFlush: 2, onEvent: (n) => seen.push(n) });
  for (const n of [1, 2, 3, 4, 5]) queue.enqueue(n);

  assert.equal(queue.stats().pending, 5);
  assert.equal(queue.flush(), 2, 'one tick absorbs at most maxPerFlush');
  assert.deepEqual(seen, [1, 2]);
  assert.equal(queue.flush(), 2);
  assert.equal(queue.flush(), 1);
  assert.equal(queue.flush(), 0);
  assert.deepEqual(seen, [1, 2, 3, 4, 5]);

  const stats = queue.stats();
  assert.equal(stats.enqueued, 5);
  assert.equal(stats.applied, 5);
  assert.equal(stats.pending, 0);
  assert.equal(stats.dropped, 0);
  assert.equal(stats.errors, 0);
  assert.equal(stats.flushes, 3);
});

test('a full queue drops the oldest events and says so exactly once', () => {
  const warnings: string[] = [];
  const seen: number[] = [];
  const queue = createUpkeepQueue<number>({
    capacity: 3,
    maxPerFlush: 10,
    onEvent: (n) => seen.push(n),
    onWarn: (m) => warnings.push(m),
  });
  for (const n of [1, 2, 3, 4, 5]) queue.enqueue(n);

  assert.equal(queue.stats().pending, 3, 'capacity is respected');
  assert.equal(queue.stats().dropped, 2);
  assert.equal(warnings.length, 1, 'the warning is not repeated per drop');
  queue.drain();
  assert.deepEqual(seen, [3, 4, 5], 'the newest events survive');
});

test('a failing handler is counted and never rethrown', () => {
  const warnings: string[] = [];
  const queue = createUpkeepQueue<number>({
    onEvent: (n) => {
      if (n === 2) throw new Error('scoring blew up');
    },
    onWarn: (m) => warnings.push(m),
  });
  queue.enqueue(1);
  queue.enqueue(2);
  queue.enqueue(3);

  assert.doesNotThrow(() => queue.drain());
  const stats = queue.stats();
  assert.equal(stats.applied, 2);
  assert.equal(stats.errors, 1);
  assert.equal(stats.pending, 0);
  assert.ok(warnings.some((w) => w.includes('scoring blew up')));
});

test('the lag bound is reported, not enforced by blocking', () => {
  const queue = createUpkeepQueue<number>({ maxLagTurns: 2, onEvent: () => undefined });
  queue.enqueue(1);
  queue.enqueue(2);
  assert.equal(queue.stats().overLag, false, 'pending == maxLagTurns is still inside the bound');
  queue.enqueue(3);
  assert.equal(queue.stats().overLag, true);
  assert.equal(queue.clear() ?? queue.stats().pending, 0);
});

test('the system prompt is read from a session event when it is there, and never guessed', () => {
  const asMessage = { role: 'system', content: [{ type: 'text', text: 'You are a coding agent.' }] };
  assert.equal(extractSystemPrompt(asMessage), 'You are a coding agent.');
  assert.equal(extractSystemPrompt({ type: 'step/end', message: asMessage }), 'You are a coding agent.');
  assert.equal(extractSystemPrompt({ type: 'step/end', data: { message: asMessage } }), 'You are a coding agent.');
  assert.equal(
    extractSystemPrompt({ role: 'developer', content: [{ type: 'text', text: 'House rules.' }] }),
    'House rules.',
    'developer instructions pin as well',
  );

  assert.equal(extractSystemPrompt({ type: 'step/end' }), undefined);
  assert.equal(extractSystemPrompt({ role: 'user', content: [{ type: 'text', text: 'hi' }] }), undefined);
  assert.equal(extractSystemPrompt({ role: 'system', content: [] }), undefined);
  assert.equal(extractSystemPrompt(null), undefined);
});
