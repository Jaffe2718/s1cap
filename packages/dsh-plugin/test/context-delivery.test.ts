import test from 'node:test';
import assert from 'node:assert/strict';

import { deliverContext } from '../src/context-delivery.ts';
import type { ContextDeliveryInput, DeliverableSegment } from '../src/context-delivery.ts';

/**
 * The fixture is the shape the packaged harness actually produces at `agent/pre-step` (read from
 * `dsh-agent-loop/lib/index.js`): `decision.messages` is the step's increment — the claimed messages plus one
 * projected context message — while the history lives in the session log and never appears here. Two of these
 * fixtures model that precisely, because a test built around "the messages are the history" would have passed
 * against a design that cannot work.
 */
const SYSTEM = { id: 'sys', role: 'system', content: [{ type: 'text', text: 'you are a coding agent' }] };
const ASKED = { id: 'u2', role: 'user', content: [{ type: 'text', text: 'and the script named test?' }] };
const CLAIMED = [ASKED];

function segment(id: string, text: string, kind = 'assistant'): DeliverableSegment {
  return { id, kind, text };
}

const RECALLED: DeliverableSegment[] = [
  segment('h1', 'package.json scripts: build, test, dsh:add'),
  segment('h4', 'the loop driver lives in dsh-agent-loop'),
];

function input(overrides: Partial<ContextDeliveryInput> = {}): ContextDeliveryInput {
  return {
    enabled: true,
    order: ['pinned', 'stateProxy', 'anchor', 'recalled', 'tail'],
    stateProxy: 'TASK: read three files and summarize',
    recalled: RECALLED,
    anchor: segment('u2', 'and the script named test?', 'user'),
    messages: [SYSTEM, ASKED],
    claimed: CLAIMED,
    step: 2,
    ...overrides,
  };
}

test('delivery inserts one message and removes nothing', () => {
  const result = deliverContext(input());

  assert.equal(result.delivered, true, result.reason);
  assert.equal(result.dropped, 0, 'nothing the harness sent is removed: the log keeps the transcript');
  assert.equal(result.kept, 2, 'both harness messages survive, by identity');
  assert.equal(result.inserted, 1);
  const messages = result.messages ?? [];
  assert.equal(messages.length, 3);
  assert.equal(messages[0], SYSTEM, 'the system prefix is untouched, and stays first');
  assert.equal(messages[1], ASKED, 'the claimed message is untouched');
});

test('the block lands after the last claimed message, where the question is already asked', () => {
  const result = deliverContext(input());
  const messages = result.messages ?? [];
  const injected = messages[2] as { id: string; role: string; content: { text: string }[]; source: { kind: string } };

  assert.equal(messages.indexOf(ASKED) + 1, 2, 'insertion index follows the claimed list, not the array end');
  assert.equal(messages.indexOf(ASKED) + 1, messages.indexOf(injected), 'and the block comes right after it');
  assert.equal(injected.role, 'user');
  assert.equal(injected.source.kind, 'system-prompt', 'the injected-context kind the adapter already enumerates');
  assert.equal(injected.id, result.payloadId, 'the id carries the payload digest, so it cannot collide');
  assert.ok(injected.content[0].text.includes('scripts: build, test, dsh:add'), 'the recalled text is in there');
  assert.ok(injected.content[0].text.includes('TASK: read three files'), 'and the state proxy, because C4 builds one');
});

test('the block carries quoted session content and no S1CAP prose of its own', () => {
  const result = deliverContext(input());
  const messages = result.messages ?? [];
  const injected = messages[2] as { content: { text: string }[] };
  const text = injected.content[0].text;

  // The rule: S1CAP manages which of the harness's own context is in the prompt, and contributes no text of its
  // own. An earlier version opened with "the blocks below were selected by relevance to the current task, they
  // supplement the transcript" - S1CAP writing about the context into the conversation. A bare concatenation
  // would fail the other way: an earlier turn re-sent as a fresh user message reads as something the user just
  // said. So: quoted verbatim, one provenance line each, nothing else.
  assert.ok(!/^#/m.test(text.split('## ')[0] ?? ''), `no preamble before the first block: ${text.slice(0, 80)}`);
  assert.ok(!text.includes('selected by relevance'), 'no explanation of why these were chosen');
  assert.ok(!text.includes('supplement'), 'and no instruction about how to read them');
  assert.ok(text.includes('quoted verbatim'), 'each block says where its text came from');
  assert.ok(text.includes('written by S1CAP from this session'), 'the authored state proxy says so, unlike the quotes');
  assert.ok(
    text.includes('scripts: build, test, dsh:add'),
    'the recalled turn is present word for word, not summarized',
  );
  assert.ok(text.includes('TASK: read three files'), 'and the state proxy body, since TAS is part of the method');
});

test('the layout order decides the block order inside the message', () => {
  const xFirst = deliverContext(input({ order: ['pinned', 'stateProxy', 'anchor', 'recalled', 'tail'] }));
  const xLast = deliverContext(input({ order: ['pinned', 'stateProxy', 'recalled', 'tail', 'anchor'] }));
  const textOf = (r: ReturnType<typeof deliverContext>): string => {
    const messages = r.messages ?? [];
    const last = messages[messages.length - 1] as { content: { text: string }[] };
    return last.content[0].text;
  };

  // Both layouts carry the same blocks, so this asserts order inside the block, not a difference in content: the
  // two cells differ in where x sits in the *transcript*, and x never travels inside the injected block.
  assert.deepEqual(xFirst.blocks, ['stateProxy', 'recalled', 'recalled']);
  assert.deepEqual(xLast.blocks, ['stateProxy', 'recalled', 'recalled']);
  assert.ok(
    textOf(xFirst).indexOf('state proxy T') < textOf(xFirst).indexOf('earlier assistant turn'),
    'the state proxy precedes the quoted turns',
  );
});

test('a payload already in the transcript is not delivered twice', () => {
  const once = deliverContext(input());
  const messages = once.messages ?? [];
  const step = 3;

  const twice = deliverContext(input({ messages, step }));

  assert.equal(twice.delivered, false, 'the previous injection came back through the log and is left alone');
  assert.match(twice.reason, /already in the transcript/);
  assert.equal(twice.messages, null, 'so the harness list is returned unchanged');
  assert.deepEqual(twice.blocks, ['stateProxy', 'recalled', 'recalled'], 'and the blocks are still reported');
});

test('a different selection is a different payload, and is delivered', () => {
  const once = deliverContext(input());
  const messages = once.messages ?? [];

  const changed = deliverContext(input({ messages, step: 3, recalled: [segment('h7', 'a newly relevant fact')] }));

  assert.equal(changed.delivered, true, 'a changed selection is a changed payload, not a repeat');
  assert.notEqual(changed.payloadId, deliverContext(input()).payloadId);
});

test('nothing to insert means nothing is inserted, and the reason says which', () => {
  const noRecall = deliverContext(input({ recalled: [], stateProxy: '' }));

  assert.equal(noRecall.delivered, false);
  assert.match(noRecall.reason, /nothing to insert/);
  assert.equal(noRecall.messages, null);
});

test('a cell with delivery off, and a step the harness treats as no step, both pass through', () => {
  const off = deliverContext(input({ enabled: false }));
  assert.equal(off.delivered, false);
  assert.match(off.reason, /policy\.deliver is off/);

  // The harness's own guard, verbatim: `step === 1 && decision.messages.length === 0`.
  const firstStep = deliverContext(input({ step: 1, messages: [] }));
  assert.equal(firstStep.delivered, false);
  assert.match(firstStep.reason, /step 1 with no claimed messages/);

  const empty = deliverContext(input({ messages: [] }));
  assert.equal(empty.delivered, false, 'and a decision with no messages is not a step either');
});

test('a step that claimed nothing still gets its block, at the end', () => {
  // A tool-result step claims one result; a step with no claim at all is unusual but not impossible, and the
  // block has to go somewhere rather than be dropped. End of the list is the honest place: after everything the
  // harness will append for this step.
  const result = deliverContext(input({ claimed: [], messages: [SYSTEM, ASKED] }));
  const messages = result.messages ?? [];

  assert.equal(result.delivered, true, result.reason);
  assert.equal(messages.length, 3);
  assert.equal(messages[0], SYSTEM);
  assert.equal(messages[1], ASKED);
});
