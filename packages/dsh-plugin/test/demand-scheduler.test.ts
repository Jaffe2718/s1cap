import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreDemandRows } from '../src/demand-scheduler.ts';
import type { DemandRow } from '@s1cap/core';

const rows: DemandRow[] = Array.from({ length: 6 }, (_, i) => ({
  id: `s${i}`, index: i + 1, depth: 1,
  current: { id: `s${i}`, seq: i, sessionId: 's', kind: 'user', text: `row ${i}`, tokens: 2, ts: 0 },
  candidates: [{ id: 'a', seq: 0, sessionId: 's', kind: 'user', text: 'a', tokens: 1, ts: 0 }],
}));

test('workers overlap at the admission limit and preserve row order', async () => {
  let inFlight = 0;
  let peak = 0;
  const result = await scoreDemandRows(rows, async (current) => {
    peak = Math.max(peak, ++inFlight);
    await new Promise((resolve) => setTimeout(resolve, current.seq % 2 ? 1 : 5));
    inFlight--;
    return [current.seq / 10];
  }, { concurrency: 2, canStart: () => true });
  assert.equal(peak, 2);
  assert.deepEqual(result, rows.map((r) => [r.current.seq / 10]));
});

test('expiry inside a level starts no further rows; unstarted rows are retryable', async () => {
  let open = true;
  const asked: string[] = [];
  const result = await scoreDemandRows(rows, async (current) => {
    asked.push(current.id);
    await Promise.resolve();
    open = false;
    return [0.8];
  }, { concurrency: 2, canStart: () => open });
  assert.deepEqual(asked, ['s0', 's1']);
  assert.deepEqual(result, [[0.8], [0.8], undefined, undefined, undefined, undefined]);
});

test('a failed row does not shift or strand subsequent answers', async () => {
  const errors: string[] = [];
  const result = await scoreDemandRows(rows, async (current) => {
    if (current.id === 's1') throw new Error('offline');
    return [0.7];
  }, { concurrency: 2, canStart: () => true, onError: (row) => { errors.push(row.id); } });
  assert.deepEqual(errors, ['s1']);
  assert.deepEqual(result, [[0.7], undefined, [0.7], [0.7], [0.7], [0.7]]);
});
