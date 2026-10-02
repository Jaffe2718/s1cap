/**
 * S1 BACKPRESSURE — what the upkeep does when the backend says "not now".
 *
 * The defect these pin, in the round's own numbers (cell C2, `evidence/C2/control.jsonl`): 5 992 `s1_call` records
 * over a 2 219.7 s span - 2.70 requests/second - of which 3 859 (64.4 %) came back `503 server busy`, with the
 * refusal rate above a third in every thirty-second bucket, 4 057 of them carrying `attempts: 2` and 4 057 000 ms of
 * `waitedMs` between them, for a yield of `judgedPairs / scoredPairs = 4 152 / 860 672 = 0.48 %`. Retrying was
 * already right and is unchanged; what was missing is anything that stops asking.
 *
 * The property worth testing is not "fewer calls". It is that a window which is *not* sent is **deferred** rather
 * than scored lexically, and that the deferral is counted where the coverage ratio is read - because the easy wrong
 * answer (score it lexically and move on) makes the ratio look better while making the measurement worse.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

import { AssociationGraph, S1_DEFERRED } from '@s1cap/core';
import type { Segment } from '@s1cap/core';

import { createBackpressure } from '../src/s1-backpressure.ts';
import { createS1Relevance } from '../src/s1-relevance.ts';

/**
 * `S1HttpError` from the *same module instance the scorer uses*.
 *
 * `s1-relevance.ts` imports `@s1cap/s1-client`, which resolves to `packages/s1-client/lib/index.js` (the package's
 * `main`), while a relative `../s1-client/src/index.ts` would be a second copy of the class. `instanceof` across two
 * copies is false, so a refusal built from the wrong one is classified as "not retryable" and the scorer degrades
 * to the lexical fallback - which is a wrong answer about the code, produced by the test's own import.
 */
const require = createRequire(new URL('../src/s1-relevance.ts', import.meta.url));
const client = (await import(pathToFileURL(require.resolve('@s1cap/s1-client')).href)) as {
  S1HttpError: new (status: number, message: string, retryAfterMs?: number) => Error;
};
const { S1HttpError } = client;

function segment(id: string, seq: number): Segment {
  return { id, sessionId: 's', seq, kind: 'user', tokens: 1, text: `text ${id}`, ts: seq * 1000 };
}

/** A clock a test can move by hand, so the cooldown is exercised without sleeping. */
function clock(start = 1_000_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => { now += ms; } };
}

test('the gate admits up to its in-flight limit and defers beyond it, counting both reasons apart', () => {
  const bp = createBackpressure({ maxInFlight: 2 });
  assert.deepEqual(bp.tryAcquire(), { ok: true });
  assert.deepEqual(bp.tryAcquire(), { ok: true });
  assert.deepEqual(bp.tryAcquire(), { ok: false, reason: 'in-flight-limit' });
  bp.recordSuccess();
  assert.deepEqual(bp.tryAcquire(), { ok: true }, 'a freed slot is reusable');
  const stats = bp.stats();
  assert.equal(stats.sent, 3);
  assert.equal(stats.deferredByLimit, 1);
  assert.equal(stats.deferredByBreaker, 0, 'the in-flight limit is not the breaker');
  assert.equal(stats.state, 'closed');
});

test('a run of refusals opens the breaker, one probe is admitted after the cooldown, and a good probe closes it', () => {
  const c = clock();
  const bp = createBackpressure({ maxInFlight: 1, openAfterRefusals: 3, cooldownMs: 10_000, now: c.now });

  for (let i = 0; i < 3; i += 1) {
    assert.deepEqual(bp.tryAcquire(), { ok: true }, `request ${i + 1} is admitted`);
    bp.recordRefusal();
  }
  assert.equal(bp.stats().state, 'open', 'three refusals inside the window open the breaker');
  assert.deepEqual(bp.tryAcquire(), { ok: false, reason: 'breaker-open' }, 'and nothing is sent while it is open');
  assert.equal(bp.stats().opened, 1);

  c.advance(9_999);
  assert.deepEqual(bp.tryAcquire(), { ok: false, reason: 'breaker-open' }, 'one millisecond early is still no');
  c.advance(1);
  assert.deepEqual(bp.tryAcquire(), { ok: true }, 'the cooldown admits exactly one probe');
  assert.deepEqual(bp.tryAcquire(), { ok: false, reason: 'breaker-open' }, 'and only one: the probe is in flight');
  bp.recordSuccess();
  assert.equal(bp.stats().state, 'closed', 'an answering backend closes the breaker');
  assert.equal(bp.stats().recovered, 1);
  assert.deepEqual(bp.tryAcquire(), { ok: true }, 'and the cell resumes');
});

test('every state change of the breaker is reported as it happens, with the counters standing at the time', () => {
  // F4. `stats().state` is a gauge: a session that opened the breaker three times and recovered before it ended
  // reads `closed`, exactly like one that never paused - so "the run stopped asking because the backend refused"
  // and "because our own cap was full" are the same zero in the artifacts. The transitions are what the plugin
  // writes onto the tape, and they are the only record that separates the two.
  const c = clock();
  const seen: { state: string; from: string; reason: string; deferredByLimit: number; deferredByBreaker: number }[] = [];
  const bp = createBackpressure({
    maxInFlight: 1,
    openAfterRefusals: 2,
    cooldownMs: 5_000,
    now: c.now,
    onTransition: (t) => seen.push(t),
  });

  bp.tryAcquire();
  bp.recordRefusal();
  assert.equal(seen.length, 0, 'one refusal is not a state change');
  bp.tryAcquire();
  bp.recordRefusal();
  assert.equal(seen.length, 1, 'the second refusal opens the breaker and is reported');
  assert.deepEqual(
    { state: seen[0]?.state, from: seen[0]?.from, reason: seen[0]?.reason },
    { state: 'open', from: 'closed', reason: '2 refusal(s) within 15000ms' },
  );

  // While it is open, windows are deferred by the breaker - and the count is on the transition that follows.
  assert.deepEqual(bp.tryAcquire(), { ok: false, reason: 'breaker-open' });
  c.advance(5_000);
  assert.deepEqual(bp.tryAcquire(), { ok: true }, 'the cooldown admits one probe');
  assert.equal(seen.length, 2, 'and the probe is a state change');
  assert.equal(seen[1]?.state, 'probing');
  assert.equal(seen[1]?.from, 'open');
  assert.equal(seen[1]?.deferredByBreaker, 1, 'carrying how many windows the open breaker held back');

  bp.recordSuccess();
  assert.equal(seen.length, 3, 'the answer closes it');
  assert.equal(seen[2]?.state, 'closed');
  assert.equal(seen[2]?.from, 'probing');
  assert.equal(bp.stats().state, 'closed', 'which is all the gauge would ever have said');
  assert.equal(bp.stats().opened, 1, 'and the count of opens is the summary, not the sequence');
});

test('the gate reports the thresholds it actually resolved, defaults included', () => {
  // The values that govern a run have to be readable from the run. A gate built with no thresholds named still ran
  // with some, and "which knobs governed this" cannot be answered by re-reading this file later.
  assert.deepEqual(createBackpressure().policy(), { maxInFlight: 8, openAfterRefusals: 5, windowMs: 15_000, cooldownMs: 15_000 });
  assert.deepEqual(createBackpressure({ maxInFlight: 3, openAfterRefusals: 2 }).policy(), {
    maxInFlight: 3, openAfterRefusals: 2, windowMs: 15_000, cooldownMs: 15_000,
  });
  assert.equal(createBackpressure().stats().maxInFlight, 8, 'and the stats agree with the policy');
});

test('a refused probe restarts the cooldown in full instead of degrading into a poll', () => {
  const c = clock();
  const bp = createBackpressure({ maxInFlight: 1, openAfterRefusals: 1, cooldownMs: 5_000, now: c.now });
  bp.tryAcquire();
  bp.recordRefusal();
  c.advance(5_000);
  assert.deepEqual(bp.tryAcquire(), { ok: true }, 'the probe is admitted');
  bp.recordRefusal();
  assert.equal(bp.stats().opened, 2, 'a refused probe is a fresh open');
  c.advance(4_999);
  assert.deepEqual(bp.tryAcquire(), { ok: false, reason: 'breaker-open' }, 'and the pause restarts, not the schedule');
});

test('a deferral is counted, not scored: the pair is offered again, and coverage stays the ratio of what was offered', async () => {
  // The core property. A window the scorer refuses to send must not be written into `scores` by the lexical
  // fallback, must not advance the cursor, and must not be counted in `scoredPairs` - otherwise the report's
  // `judgedPairs / scoredPairs` would describe a backend that judged work it was never shown.
  const graph = new AssociationGraph();
  graph.addSegments([segment('s0', 0), segment('s1', 1), segment('s2', 2), segment('s3', 3)]);

  let defer = true;
  const asked: string[] = [];
  const scorer = (current: Segment, candidates: readonly Segment[]): readonly number[] | typeof S1_DEFERRED => {
    if (defer) return S1_DEFERRED;
    for (const candidate of candidates) asked.push(`${candidate.id}->${current.id}`);
    return candidates.map(() => 0.9);
  };

  const first = await graph.scoreNew({ windowN: 8, threshold: 0.55, scoreBatch: scorer });
  assert.equal(first.scoredPairs, 0, 'nothing was offered, so nothing is counted as scored');
  assert.equal(first.deferredPairs, 6, 'the whole backlog is held back, six pairs of four segments');
  assert.equal(first.deferredSegments, 3, 'counted per segment, and only for the segments that had a window');
  assert.equal(graph.stats().judgedPairs, 0);
  assert.equal(graph.deferredPairs, 6, 'and the graph carries the count the record is read from');
  assert.equal(graph.scoreCount, 0, 'no pair was scored, by the backend or by the fallback');
  assert.equal(graph.edgeCount, 0, 'so no edge was invented from a window that was never judged');

  // The backend comes back. The segments the previous call held back are offered again, whole, and no pair is
  // lost: the cursor never advanced over them.
  defer = false;
  const second = await graph.scoreNew({ windowN: 8, threshold: 0.55, scoreBatch: scorer });
  assert.deepEqual(asked, ['s0->s1', 's0->s2', 's1->s2', 's0->s3', 's1->s3', 's2->s3'], 'the deferred windows, in order');
  assert.equal(second.scoredPairs, 6);
  assert.equal(second.deferredPairs, 0, 'nothing new was deferred');
  assert.equal(graph.stats().scoredPairs, 6, 'the deferred pairs were offered once, not twice and not never');
  assert.equal(graph.stats().judgedPairs, 6);
  assert.equal(graph.deferredPairs, 6, 'the deferral counter keeps what happened; it is not a running total of offers');
});

test('the per-sweep budget defers what it cannot offer, so one tick cannot walk a whole backlog', async () => {
  // `recall.window` bounds one segment; nothing bounded one *call*, and the upkeep queue starts several calls per
  // tick without awaiting them. This is the call-level bound, and its failure mode is a deferral - not a smaller
  // window, and not a lexical score.
  const graph = new AssociationGraph();
  graph.addSegments([segment('s0', 0), segment('s1', 1), segment('s2', 2), segment('s3', 3), segment('s4', 4), segment('s5', 5)]);
  const asked: string[] = [];
  const scorer = (current: Segment, candidates: readonly Segment[]): readonly number[] => {
    for (const candidate of candidates) asked.push(`${candidate.id}->${current.id}`);
    return candidates.map(() => 0.9);
  };

  const first = await graph.scoreNew({ windowN: 64, threshold: 0.55, scoreBatch: scorer, maxPairsPerSweep: 4 });
  assert.equal(first.scoredPairs, 3, 'the budget covers the first two segments (1 + 2 pairs)');
  assert.equal(first.deferredPairs, 12, 'and the whole backlog behind it is counted, not just the next window');
  assert.equal(first.deferredSegments, 3, 'three segments held back (pairs 3, 4, 5 of the fourth, fifth and sixth)');
  assert.deepEqual(asked, ['s0->s1', 's0->s2', 's1->s2']);

  const second = await graph.scoreNew({ windowN: 64, threshold: 0.55, scoreBatch: scorer, maxPairsPerSweep: 4 });
  assert.equal(second.scoredPairs, 3, 'the next call starts at the segment the budget stopped on');
  assert.deepEqual(asked.slice(3), ['s0->s3', 's1->s3', 's2->s3'], 'and offers that window whole, in order');
  assert.equal(graph.stats().scoredPairs, 6);
  // Every segment is reached eventually: the budget delays work, it does not drop it.
  let guard = 0;
  for (;;) {
    const next = await graph.scoreNew({ windowN: 64, threshold: 0.55, scoreBatch: scorer, maxPairsPerSweep: 4 });
    if (next.scoredPairs === 0 && next.deferredPairs === 0) break;
    guard += 1;
    assert.ok(guard < 20, 'the sweep terminates');
  }
  assert.equal(graph.stats().scoredPairs, 15, 'T(T-1)/2 = 15 pairs of six segments, each offered exactly once');
  assert.equal(graph.scoreCount, 15);
  assert.equal(graph.deferredPairs, 12, 'and the deferral total counts each held-back pair once, not once per sweep');
});

test('a saturated backend is not a dead one: deferred windows are never scored lexically', async () => {
  // The whole point of `S1_DEFERRED` as a distinct signal. `undefined` means "no backend" and degrades to the local
  // lexical scorer, which is right for a session with no lane; a refusal is "not now", and degrading on it would
  // spend the pair for good while making the coverage ratio look *better*.
  const graph = new AssociationGraph();
  graph.addSegments([segment('s0', 0), segment('s1', 1), segment('s2', 2)]);
  const couldNotAnswer = await graph.scoreNew({ windowN: 8, threshold: 0.55, scoreBatch: () => undefined });
  assert.equal(couldNotAnswer.scoredPairs, 3, 'an absent backend still offers every pair');
  assert.equal(couldNotAnswer.judgedPairs, 0);
  assert.equal(graph.scoreCount, 3, 'and the lexical fallback writes all three, marked as its own');
  assert.ok(graph.scores().every((p) => p.source === 'lexical'), 'so the record says who scored them');

  const graph2 = new AssociationGraph();
  graph2.addSegments([segment('s0', 0), segment('s1', 1), segment('s2', 2)]);
  const deferred = await graph2.scoreNew({ windowN: 8, threshold: 0.55, scoreBatch: () => S1_DEFERRED });
  assert.equal(deferred.scoredPairs, 0, 'a saturated backend offers nothing');
  assert.equal(graph2.scoreCount, 0, 'and writes nothing, lexically or otherwise');
  assert.equal(graph2.deferredPairs, 3, 'the pairs it did not offer are the deferral');
  assert.equal(graph2.deferredSegments, 2, 'counted per segment, and only for the segments that had a window');
});

test('the deferral survives a restart: a resumed graph does not re-ask, and does not forget what it held back', async () => {
  const before = new AssociationGraph();
  before.addSegments([segment('a0', 0), segment('a1', 1), segment('a2', 2)]);
  await before.scoreNew({ windowN: 8, threshold: 0.55, scoreBatch: () => S1_DEFERRED });
  const resumed = AssociationGraph.fromSnapshot(before.snapshot());
  assert.equal(resumed.deferredPairs, 3, 'the omission is part of what the snapshot carries');
  assert.equal(resumed.deferredSegments, 2, 'the cursor had not advanced over the last two segments');
  const asked: string[] = [];
  await resumed.scoreNew({
    windowN: 8,
    threshold: 0.55,
    scoreBatch: (current, candidates) => {
      for (const c of candidates) asked.push(`${c.id}->${current.id}`);
      return candidates.map(() => 0.9);
    },
  });
  assert.deepEqual(asked, ['a0->a1', 'a0->a2', 'a1->a2'], 'and the held-back windows are offered after the restart');
});

test('the relevance scorer hands the window back as DEFERRED when the gate will not admit it, and spends no request', async () => {
  const c = clock();
  const bp = createBackpressure({ maxInFlight: 1, openAfterRefusals: 1, cooldownMs: 60_000, now: c.now });
  let calls = 0;
  const relevance = createS1Relevance({
    decide: async () => {
      calls += 1;
      throw new S1HttpError(503, 'systemone 503: {"detail":"server busy, try again later"}', 1000);
    },
    questionsPerCall: 2,
    backpressure: bp,
    now: c.now,
    sleep: async () => undefined,
  });

  const current = segment('c', 10);
  const candidates = [segment('a', 1), segment('b', 2)];
  // The first attempt is refused, which opens the breaker; the window's own retry is then *not admitted*, so the
  // window comes back as `S1_DEFERRED` rather than as `undefined`. That is the intended ordering and it is the
  // interesting case: a refusal that would have been retried is held for a later tick instead, which keeps the
  // pairs alive. (`undefined` - the lexical fallback - is for a window the backend genuinely could not answer.)
  const first = await relevance(current, candidates);
  assert.equal(first, S1_DEFERRED, 'a window whose retry the gate refused comes back deferred');
  assert.equal(calls, 1, 'the backend was asked exactly once: the retry never left the cell');
  assert.equal(bp.stats().state, 'open', 'and the refusal opened the breaker');

  const sentBefore = bp.stats().sent;
  const second = await relevance(current, candidates);
  assert.equal(second, S1_DEFERRED, 'the next window is deferred too');
  assert.equal(bp.stats().sent, sentBefore, 'and no request was made for it');
  assert.equal(calls, 1, 'the backend was not asked again');
  const stats = relevance.stats();
  assert.equal(stats.blocked, 2, 'the scorer counts what it held back');
  assert.equal(stats.blockedByBreaker, 2);
  assert.equal(stats.blockedByLimit, 0);
  assert.equal(stats.backpressured, true);
  assert.equal(stats.failures, 1, 'the refusal is still counted as the failure it was');
  assert.equal(stats.gaveUpAfterRetries, 0, 'and not as a window that ran out of attempts');
});

test('the retry policy still governs one refusal, and the gate does not replace it', async () => {
  // The rule the cell's own `_meta.retry` states: `retryAttempts` waits the server's `Retry-After`. Nothing here
  // changes it - the gate sits *around* it, and a window whose retry succeeds must still be a judgement.
  const bp = createBackpressure({ maxInFlight: 4, openAfterRefusals: 10 });
  let calls = 0;
  const relevance = createS1Relevance({
    decide: async (_state, questions) => {
      calls += 1;
      if (calls === 1) throw new S1HttpError(503, 'busy', 250);
      // The retry halves the request, so the second attempt asks about candidate h0 only and a third carries h1.
      // The weight is therefore read from the question's own text, not from a fixed key: a stub that answered
      // `h1` to every question would make two different candidates look like the same answer.
      const answers: Record<string, { type: string; noul: number }> = {};
      for (const [key, question] of Object.entries(questions)) {
        answers[key] = { type: 'noul', noul: question.instructions.includes('Candidate h0:') ? 0.7 : 0.2 };
      }
      return { answers, usage: { input_tokens: 10, output_tokens: 0 }, ms: 5 };
    },
    questionsPerCall: 2,
    backpressure: bp,
    sleep: async () => undefined,
  });
  const weights = await relevance(segment('c', 3), [segment('a', 1), segment('b', 2)]);
  assert.deepEqual(weights, [0.7, 0.2], 'the retry answered and the window is judged by the backend');
  assert.equal(calls, 3, 'one refusal, then the halved retry split across two requests - the gate admitted all three');
  assert.equal(bp.stats().state, 'closed', 'and the breaker never opened for a single refusal');
  assert.equal(bp.stats().refused, 1);
  assert.equal(bp.stats().ok, 2);
});

test('a slot is never leaked: the acquire sits inside the block that releases it, and a leak is counted', async () => {
  // F16.3. `tryAcquire()` used to be called *outside* the block that released the slot, so a throw between the two
  // - `render()` throwing on a malformed segment is the one named in the audit - leaked the slot for the life of
  // the process. Nothing counted leaks, and the symptom is the worst kind: over a long run the effective cap walks
  // to zero, every window is deferred, and `deferredPairs` rises with no stated cause. The leak could not be
  // triggered by a real input, which is why what is pinned here is the *structure* - a throw and an un-sent request
  // both leave `inFlight` at zero and are both counted - rather than a specific bad payload.
  const bp = createBackpressure({ maxInFlight: 1 });
  const relevance = createS1Relevance({
    decide: async () => {
      throw new Error('the request should never be composed: rendering throws first');
    },
    questionsPerCall: 2,
    backpressure: bp,
  });

  // A candidate whose text is not a string: `render()` reads `.length` off it and throws before the request is
  // composed, which is exactly the window between the acquire and the old release point.
  const broken = { id: 'x', sessionId: 's', seq: 1, kind: 'user', tokens: 1, text: undefined } as unknown as Segment;
  await assert.rejects(() => relevance(segment('c', 3), [broken]), /length|undefined/i);

  const after = bp.stats();
  assert.equal(after.inFlight, 0, 'the slot came back even though the attempt threw');
  assert.equal(after.slotsLeaked, 1, 'and the leak is counted rather than silent');
  assert.equal(after.ok, 0, 'a slot returned without a send is not an answered request');
  // The gate is usable again: this is the property the leak destroyed.
  assert.deepEqual(bp.tryAcquire(), { ok: true }, 'the cap is not permanently reduced');
  bp.recordSuccess();
});

test('a request that is never sent hands its slot back through recordLeak, not through recordSuccess', async () => {
  // The other half of the same accounting: `decide` answering `undefined` means "there is no backend", which the
  // gate can be told without touching the network. Reporting that as an answered request would overstate `ok` and
  // hide the path; doing nothing would leak. It is the third exit from a slot and it has its own counter.
  const bp = createBackpressure({ maxInFlight: 1 });
  const relevance = createS1Relevance({
    decide: async () => undefined,
    questionsPerCall: 2,
    backpressure: bp,
  });
  const weights = await relevance(segment('c', 3), [segment('a', 1), segment('b', 2)]);
  assert.equal(weights, undefined, 'no backend means the caller scores lexically');
  const stats = bp.stats();
  assert.equal(stats.ok, 0, 'nothing answered');
  assert.equal(stats.refused, 0, 'and nothing refused');
  assert.equal(stats.slotsLeaked, 1, 'the slot came back and said why');
  assert.equal(stats.inFlight, 0, 'so the cap is intact');
  assert.equal(bp.tryAcquire().ok, true, 'and the next window can be admitted');
});
