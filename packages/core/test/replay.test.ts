/**
 * Replay parity: one tape, replayed as many times as you like, must produce the same records.
 *
 * This is the gate in front of every later milestone that touches the prompt. It uses the committed
 * synthetic fixture (`test/fixtures/tape.synthetic.jsonl`) — no real session content belongs in the repo.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { cellPolicy, defaultPolicy, digestRecords, parseTape, replayTape, stableStringify } from '../src/index.ts';

const here = dirname(fileURLToPath(import.meta.url));
const tapeText = readFileSync(join(here, 'fixtures', 'tape.synthetic.jsonl'), 'utf8');

const OPTIONS = {
  now: 1_790_000_000_000,
  contextWindow: 128_000,
  reserveOutputTokens: 8_000,
  fixedOverheadTokens: 1_200,
  lambdaMs: 36 * 60 * 60 * 1000,
};

test('a tape round-trips through parse and replays identically every time', async () => {
  const tape = parseTape(tapeText);
  assert.equal(tape.steps.length, 3);
  assert.equal(tape.sessionId, 'fixture-synthetic');
  assert.deepEqual(
    tape.steps.map((s) => s.step),
    [1, 2, 3],
  );

  const first = await replayTape(tape, { ...OPTIONS, policy: cellPolicy('C2') });
  const again = await replayTape(parseTape(tapeText), { ...OPTIONS, policy: cellPolicy('C2') });

  assert.equal(first.records.length, 3);
  assert.deepEqual(again.records, first.records, 'records must be identical field for field');
  assert.deepEqual(again.selectedIds, first.selectedIds);
  assert.equal(again.digest, first.digest);
});

test('the digest is key-order independent but value sensitive', async () => {
  const a = { type: 'assembly', seq: 0, blocks: { pinned: 3, tail: 1 } };
  const b = { blocks: { tail: 1, pinned: 3 }, seq: 0, type: 'assembly' };
  assert.equal(stableStringify(a), stableStringify(b), 'key order must not matter');
  assert.equal(digestRecords([a as never]), digestRecords([b as never]));
  assert.notEqual(digestRecords([a as never]), digestRecords([{ ...a, seq: 1 } as never]));
});

test('a malformed tape fails at the offending line instead of producing a partial replay', async () => {
  const first = JSON.stringify({ schema: 1, sessionId: 'S', step: 1, messages: [] });
  const cases = [
    ['{bad json', /line 2: invalid JSON/],
    ['null', /line 2: expected a step object/],
    [JSON.stringify({ schema: 2, sessionId: 'S', step: 2, messages: [] }), /line 2: unsupported schema 2/],
    [JSON.stringify({ schema: 1, sessionId: 'S', step: 2 }), /line 2: messages must be an array/],
    [JSON.stringify({ schema: 1, sessionId: 'other', step: 2, messages: [] }), /line 2: sessionId changed/],
    [JSON.stringify({ schema: 1, sessionId: 'S', step: 1.5, messages: [] }), /line 2: step must be a non-negative integer/],
  ] as const;
  for (const [badLine, reason] of cases) {
    assert.throws(() => parseTape(`${first}\n${badLine}`), reason);
  }
});

test('the cells behave as the ablation claims: C0 selects nothing, C2 accounts a real budget', async () => {
  const tape = parseTape(tapeText);
  const c0 = await replayTape(tape, { ...OPTIONS, policy: cellPolicy('C0') });
  const c2 = await replayTape(tape, { ...OPTIONS, policy: cellPolicy('C2') });

  for (const record of c0.records) {
    assert.equal(record.selected, 0, 'the baseline cell never recalls anything by design');
    assert.equal(record.candidates, 0);
    assert.equal(record.blocks['recalled'] ?? 0, 0);
  }
  assert.deepEqual(
    c0.selectedIds.map((ids) => ids.length),
    [0, 0, 0],
  );
  assert.notEqual(c0.digest, c2.digest, 'the cells are distinguishable in the record stream');
  for (const record of c2.records) {
    assert.ok(record.budgetUsed <= record.budgetTotal);
    assert.ok(record.prefixTokensStable <= record.budgetTotal);
  }
});

test('a taped system prompt becomes the pinned block and never moves between steps', async () => {
  const tape = parseTape(tapeText);
  const result = await replayTape(tape, { ...OPTIONS, policy: cellPolicy('C2') });

  const pinned = result.records.map((r) => r.blocks['pinned'] ?? 0);
  assert.ok(
    pinned.every((tokens) => tokens > 0),
    'the pinned block is no longer empty when the prompt is known',
  );
  assert.equal(new Set(pinned).size, 1, 'the cache-stable prefix is byte-stable across steps');
  assert.ok(result.records.every((r) => r.prefixTokensStable === r.blocks['pinned']));
});

test('replays are independent of the graph a previous replay built', async () => {
  const tape = parseTape(tapeText);
  const once = await replayTape(tape, { ...OPTIONS, policy: defaultPolicy() });
  const twiceInOneProcess = await replayTape(tape, { ...OPTIONS, policy: defaultPolicy() });
  assert.deepEqual(twiceInOneProcess.records, once.records);
  assert.equal(twiceInOneProcess.digest, once.digest);
});
