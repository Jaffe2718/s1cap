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
  const queue = createUpkeepQueue<number>({ maxPerFlush: 2, onEvent: (n) => { seen.push(n); } });
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
    onEvent: (n) => { seen.push(n); },
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

/**
 * F11: three claims the header made and the code did not keep.
 *
 *   - "the promise is awaited before the next event starts, so ... a burst cannot interleave two scorers over one
 *     window" - false, and it was the D3 failure mode: several `scoreNew` loops in flight over one backend is what
 *     round `20261002-2037` measured (5 992 requests at 2.70/s, 64.4 % refused).
 *   - "`flush()` is bounded: at most `maxPerFlush` per tick" - true of `flush()`, false of `drain()`, which is on
 *     the live path (the anchor wait's loop and every `turn/end`).
 *   - "`overLag`: true while the queue holds more than the allowed lag", with `maxLagTurns` documented "in turns" -
 *     the comparison is *pending events* against a number in turns, so it is true whenever anything is pending.
 *
 * The three are asserted here because each one was a comment that made a wrong reading look confirmed, which is
 * the shape of defect this pass exists to remove: a documented guarantee that the code contradicts is worse than no
 * documentation, because it is what a reader checks *instead of* the code.
 */
test('the handler is not awaited between events: the queue bounds a tick, not concurrency', () => {
  const started: number[] = [];
  const settled: number[] = [];
  const queue = createUpkeepQueue<number>({
    maxPerFlush: 10,
    onEvent: async (n) => {
      started.push(n);
      // A stand-in for one System-1 scoring call: it resolves later, and the queue must not be waiting on it.
      await new Promise((resolve) => setImmediate(resolve));
      settled.push(n);
    },
  });
  for (const n of [1, 2, 3]) queue.enqueue(n);

  assert.equal(queue.flush(), 3, 'all three handlers were entered in one tick');
  assert.deepEqual(started, [1, 2, 3], 'in arrival order');
  assert.deepEqual(
    settled,
    [],
    'and none of them had returned when the tick did: N handlers are in flight at once, which is the property ' +
      'that made several scoring loops hammer one backend. The bound for that is `s1.admissionLimit`, not this queue',
  );
  // And the count says "folded", not "finished" - which is why it cannot be read as a concurrency gauge.
  assert.equal(queue.stats().applied, 3, '`applied` counts entry, not completion');
});

test('drain() is not bounded by maxPerFlush, and that is what makes it usable at a turn boundary', () => {
  const seen: number[] = [];
  const queue = createUpkeepQueue<number>({ maxPerFlush: 2, onEvent: (n) => { seen.push(n); } });
  for (const n of [1, 2, 3, 4, 5]) queue.enqueue(n);

  assert.equal(queue.drain(), 5, 'the live caller drains everything it has, in one call');
  assert.deepEqual(seen, [1, 2, 3, 4, 5]);
  assert.equal(queue.stats().pending, 0);
  // The bounded tick is still bounded, which is the property that has to survive: `flush()` is the timer's call.
  for (const n of [6, 7, 8]) queue.enqueue(n);
  assert.equal(queue.flush(), 2, 'a tick absorbs at most `maxPerFlush`');
  assert.equal(queue.stats().pending, 1);
});

test('overLag compares pending events against a bound named in turns, and nothing acts on it', () => {
  // The unit mismatch is the finding, so it is asserted rather than described: one step of a session emits several
  // events, so `maxLagTurns: 2` is exceeded by two pending *events* - one step's worth - and the flag is true
  // whenever anything at all is waiting. It is reported on `/s1` and read by no branch anywhere.
  const queue = createUpkeepQueue<number>({ maxLagTurns: 2, onEvent: () => undefined });
  queue.enqueue(1);
  queue.enqueue(2);
  queue.enqueue(3);
  const stats = queue.stats();
  assert.equal(stats.overLag, true, 'three pending events, a bound of two turns: the units do not match');
  assert.equal(stats.maxLagTurns, 2, 'and the bound is carried verbatim, so the mismatch is visible in the record');
  assert.equal(stats.pending, 3, 'beside the count it is actually compared against');
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
