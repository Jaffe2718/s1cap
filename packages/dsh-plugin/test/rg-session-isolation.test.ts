/**
 * Per-session isolation and persistence of the association graph.
 *
 * Two properties, both of which this codebase violated until recently and neither of which any other test here
 * covered: a session's graph must not contain another session's conversation, and a graph must survive the process
 * that built it. The first failure was observed live - a "new chat" inherited 269 segments from unrelated earlier
 * conversations, so every recall count in that window measured contamination. The second is a cost: a restart
 * discarded the scoring cursor, and re-scoring a history means paying the System-1 backend again for pairs it had
 * already been paid for.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { AssociationGraph, createRgFileStore, defaultPolicy } from '@s1cap/core';
import type { RgSnapshot } from '@s1cap/core';

import { createStepObserver } from '../src/step-observer.ts';
import type { StepObserver } from '../src/step-observer.ts';

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

interface Harness {
  observer: StepObserver;
  ticks: (() => void)[];
  /** every pair the batch scorer was asked about, so a re-score shows up as a repeated `current` id */
  scoredCurrents: string[];
}

function harness(rgStore?: ReturnType<typeof createRgFileStore>): Harness {
  const ticks: (() => void)[] = [];
  const scoredCurrents: string[] = [];
  const observer = createStepObserver({
    policy: defaultPolicy(),
    emit: () => {},
    now: () => 1_790_000_000_000,
    contextWindow: 128_000,
    reserveOutputTokens: 8_000,
    fixedOverheadTokens: 1_200,
    lambdaMs: 36 * 60 * 60 * 1000,
    maxLagTurns: 2,
    schedule: (tick) => ticks.push(tick),
    ...(rgStore !== undefined ? { rgStore } : {}),
    scoreBatch: async (current: unknown, candidates: readonly unknown[]) => {
      const id = (current as { id: string }).id;
      scoredCurrents.push(id);
      return candidates.map(() => 0.99);
    },
  });
  return { observer, ticks, scoredCurrents };
}

/** A pre-step payload: the only place a session id is actually readable from. */
function stepPayload(sessionId: string, text: string) {
  return {
    agent: { session: { id: sessionId } },
    step: 1,
    messages: [{ role: 'user', content: [{ type: 'text', text }] }],
  };
}

function userEvent(seq: number, text: string, prefix: string) {
  return {
    type: 'user/message',
    seq,
    time: 1_790_000_000_000 + seq,
    // Ids come from the event, so a fixture that reuses a seq across two runs would overwrite its own segments
    // by id and make "the graph grew" untestable. The prefix is the same thing a real host provides for free.
    data: { id: `${prefix}-${String(seq)}`, role: 'user', content: [{ type: 'text', text }] },
  };
}

async function runSession(
  h: Harness,
  sessionId: string,
  texts: readonly string[],
  prefix: string,
): Promise<void> {
  await h.observer.observe(stepPayload(sessionId, texts[0] ?? 'start'));
  let seq = 10;
  for (const text of texts) {
    h.observer.noteSessionEvent(userEvent(seq, text, prefix));
    seq += 1;
  }
  h.observer.noteSessionEvent({ type: 'turn/end', seq, time: 1_790_000_000_000 + seq, data: { turn: 1 } });
  for (let round = 0; round < 6; round += 1) {
    h.ticks.forEach((tick) => tick());
    h.ticks.length = 0;
    await settle();
  }
}

test('two sessions in one process get two graphs, and neither sees the other', async () => {
  const dir = mkdtempSync(join(tmpdir(), 's1cap-rg-'));
  const store = createRgFileStore({ dir });
  const h = harness(store);

  await runSession(h, 'sess-A', ['pelican riding a bicycle on the promenade'], 'r1a');
  await runSession(h, 'sess-B', ['migrate the payments service to postgres'], 'r1b');

  const byId = new Map(h.observer.stats().sessions.map((s) => [s.sessionId, s]));
  assert.ok(byId.has('sess-A') && byId.has('sess-B'), 'both sessions should hold a graph');

  // The decisive assertion, read from the store rather than from a counter: each session's snapshot contains only
  // segments stamped with that session's id. A shared graph, or a queue that attributed events to whichever
  // session happened to be current at drain time, fails here.
  for (const id of ['sess-A', 'sess-B']) {
    const snap = store.load(id);
    assert.ok(snap !== undefined, `${id} should have been persisted`);
    assert.ok((snap as RgSnapshot).segments.length > 0, `${id} should have segments`);
    for (const segment of (snap as RgSnapshot).segments) {
      assert.equal(segment.sessionId, id, `a ${id} snapshot carried a segment from ${segment.sessionId}`);
    }
  }
});

test('a restarted process resumes a session graph and does not re-score pairs it already paid for', async () => {
  const dir = mkdtempSync(join(tmpdir(), 's1cap-rg-'));
  const store = createRgFileStore({ dir });

  const first = harness(store);
  await runSession(first, 'sess-A', [
    'the old bicycle shop',
    'a pelican learned to ride',
    'the crocodile took over the frame',
  ], 'r2a');
  const before = store.load('sess-A');
  assert.ok(before !== undefined);
  assert.ok((before as RgSnapshot).scored > 0, 'the scoring cursor should have advanced');
  const alreadyScored = new Set(first.scoredCurrents);
  assert.ok(alreadyScored.size > 0, 'the first process should have scored something');

  // A new process: no in-memory graphs, only the file the previous one left behind.
  const second = harness(createRgFileStore({ dir }));
  await runSession(second, 'sess-A', ['and then it drove a sports car'], 'r2b');

  const resumed = store.load('sess-A');
  assert.ok(resumed !== undefined);
  assert.ok(
    (resumed as RgSnapshot).segments.length > (before as RgSnapshot).segments.length,
    'the resumed graph should have grown from the persisted one, not been rebuilt from nothing',
  );
  for (const id of second.scoredCurrents) {
    assert.ok(!alreadyScored.has(id), `segment ${id} was scored twice across a restart - the cursor was not restored`);
  }
});

test('a snapshot written for one session is never loaded into another', () => {
  const dir = mkdtempSync(join(tmpdir(), 's1cap-rg-'));
  const store = createRgFileStore({ dir });
  const snap: RgSnapshot = {
    schema: 1,
    sessionId: 'sess-A',
    order: ['a1'],
    segments: [
      {
        id: 'a1',
        sessionId: 'sess-A',
        kind: 'user',
        seq: 1,
        ts: 1,
        tokens: 2,
        text: 'only ever said in A',
      },
    ],
    edges: [],
    scored: 1,
    scoredPairs: 0,
  };
  assert.equal(store.persist('sess-A', snap), true);
  assert.equal(store.load('sess-B'), undefined, 'a different session must not read A file');

  const restored = AssociationGraph.fromSnapshot(store.load('sess-A'));
  assert.equal(restored.segmentCount, 1);
  assert.equal(restored.edgeCount, 0);

  // An unknown schema is treated as absent rather than half-parsed: the worst case becomes re-scoring, never a
  // graph whose shape the current code cannot interpret.
  assert.equal(AssociationGraph.fromSnapshot({ ...snap, schema: 999 }).segmentCount, 0);
});
