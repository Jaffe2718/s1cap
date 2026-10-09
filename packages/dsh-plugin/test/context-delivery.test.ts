import test from 'node:test';
import assert from 'node:assert/strict';

import { deliverContext, TRACE_END, TRACE_START } from '../src/context-delivery.ts';
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

/**
 * T, the cell's state proxy, exactly as `buildStateProxy` hands it over.
 *
 * The frame is part of what the serializer produces, not something delivery adds: the paper's π is "the serializer
 * that ... adds fixed labels and delimiters", and π is `packages/core/src/state-proxy.ts`. So the fixture carries
 * the delimiters, because that is the shape this module is actually given. It used to be a bare string with a
 * comment claiming delivery owned the wire format, and the two readings of that one sentence met in round
 * `20261004-0205` as a doubled pair in the model's context. `TAS_TRACE_BODY` is the inner text, so a test can
 * still assert the body arrives unedited.
 */
const TAS_TRACE_BODY = 'TASK: read three files and summarize';
const TAS_TRACE_TEXT = `${TRACE_START}\n${TAS_TRACE_BODY}\n${TRACE_END}`;

const RECALLED: DeliverableSegment[] = [
  segment('h1', 'package.json scripts: build, test, dsh:add'),
  segment('h4', 'the loop driver lives in dsh-agent-loop'),
];

function input(overrides: Partial<ContextDeliveryInput> = {}): ContextDeliveryInput {
  return {
    enabled: true,
    // The order `assemble()` records for the default cell, which is the order the delivered text has to be read
    // against: this module walks `order` for the `recalled` slot and emits the recalled turns there, so a layout
    // change that moves the slot changes where in the injected message they land.
    order: ['pinned', 'stateProxy', 'tail', 'recalled', 'anchor'],
    // `policy.tas.on` reaches this module as the *presence* of `stateProxy`: `assemble()` puts it on the layout
    // only when TAS is on and `index.ts` forwards it only when it is there. This fixture is therefore "C2".
    stateProxy: TAS_TRACE_TEXT,
    recalled: RECALLED,
    anchor: segment('u2', 'and the script named test?', 'user'),
    messages: [SYSTEM, ASKED],
    claimed: CLAIMED,
    step: 2,
    // The measured behaviour, and the default of `policy.assemblyTrigger`. A test that wants the permissive value
    // says so by name, so nothing here can drift into `every-step` by inheriting it.
    trigger: 'claimed-only',
    ...overrides,
  };
}

/** The text of the single injected message, or `''` when the step was left alone. */
function injectedText(result: ReturnType<typeof deliverContext>, at = 2): string {
  const messages = result.messages ?? [];
  const injected = messages[at] as { content?: { text: string }[] } | undefined;
  return injected?.content?.[0]?.text ?? '';
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
  assert.ok(injected.content[0]!.text.includes('scripts: build, test, dsh:add'), 'the recalled text is in there');
  assert.ok(
    injected.content[0]!.text.includes(TAS_TRACE_TEXT),
    'and so is the state proxy: `tas.on` implies T is delivered, which is the whole of the method',
  );
});

/**
 * THE PARADIGM CORRECTION, as a test (2026-10-04).
 *
 * "Trace as State" (arXiv 2609.02702) is a placement contrast on one variable, `T`:
 *
 *     Trace as State:   M([T, x, q])     trace BEFORE the long context
 *     Trace Append:     M([x, T, q])     the same trace, AFTER the long context (the control)
 *
 * It does nothing without `T` in the request. S1CAP computed `T`, recorded it on every assembly, budgeted for it,
 * and never sent it, so all three ablation cells presented the *same* value of the variable the headline result is
 * about. `docs/STATUS.md` §N6 carried "may an authored state proxy `T` be delivered at all" as an open question; the
 * paper settles it. So this is delivery, not an option, and there is deliberately no switch to turn it off — the
 * only gate is whether the cell built a `T` at all.
 */
test('the state proxy reaches the model when TAS is on, and it comes before the long context', () => {
  const result = deliverContext(input());
  const text = injectedText(result);

  assert.equal(result.delivered, true, result.reason);
  assert.deepEqual(
    result.blocks,
    ['stateProxy', 'recalled', 'recalled'],
    `the telemetry names what the model was given: ${JSON.stringify(result.blocks)}`,
  );
  assert.ok(text.includes(TRACE_START), 'the trace is delimited, so it reads as a trace block and not as a user turn');
  assert.ok(text.includes(TRACE_END));
  assert.ok(text.includes(TAS_TRACE_TEXT), 'and the text inside is the cell\'s own trace');
  assert.ok(
    text.indexOf(TAS_TRACE_TEXT) < text.indexOf('quoted verbatim'),
    'T precedes the recalled block: that is the half of the paper\'s contrast this channel controls',
  );
});

test('the trace is delivered verbatim, between the paper\'s delimiters and nothing else', () => {
  // "The serializer preserves the included reasoning text in source order and adds fixed labels and delimiters"
  // (§3.2). "Preserves" is load-bearing: every line of `T` is a rendering of something the model said or a tool
  // returned, and rewriting it here would put S1CAP's words where the method requires the model's own.
  const text = injectedText(deliverContext(input({ recalled: [] })));
  const open = text.indexOf(TRACE_START);
  const close = text.indexOf(TRACE_END);

  assert.ok(open === 0, 'the delivered message opens with the trace: nothing precedes it');
  assert.ok(close > open, 'and closes it');
  assert.equal(text.slice(open + TRACE_START.length, close), `\n${TAS_TRACE_BODY}\n`, 'the body is T, unedited');
  assert.equal(text.slice(close + TRACE_END.length), '', 'and nothing follows the closing delimiter');
  // The frame appears exactly once, and this is the assertion the round `20261004-0205` defect needed: delivery used
  // to wrap `T` itself, so once the serializer also emitted the frame the model was given two pairs - an opening
  // delimiter, the intro, a second opening delimiter, the trace, and two closers. Counting is the whole check: a
  // body that merely *contains* a delimiter is fine, a body framed twice is not.
  assert.equal(text.split(TRACE_START).length - 1, 1, `exactly one opening delimiter, got: ${text.slice(0, 160)}`);
  assert.equal(text.split(TRACE_END).length - 1, 1, 'and exactly one closing delimiter');
});

test('a cell that builds no state proxy sends none: the payload is the quoted turns alone', () => {
  // TAS off (`assemble()` leaves `layout.stateProxy` undefined) and `tas.on` with an empty `T` both arrive here as
  // no trace text, and both mean the same thing to this module: there is nothing to send. This test passes against
  // the pre-2026-10-04 code for the wrong reason — nothing was sent then either — and it is here so that the
  // delivery above cannot later be made unconditional.
  for (const stateProxy of [undefined, '']) {
    const off = deliverContext(input({ stateProxy }));
    const text = injectedText(off);

    assert.equal(off.delivered, true, off.reason);
    assert.deepEqual(off.blocks, ['recalled', 'recalled'], `no stateProxy block for ${JSON.stringify(stateProxy)}`);
    assert.ok(!text.includes(TRACE_START), `no trace delimiters for ${JSON.stringify(stateProxy)}`);
    assert.ok(!text.includes(TAS_TRACE_TEXT), 'and no trace text');
    assert.ok(text.includes('quoted verbatim'), 'the quoted turns are delivered exactly as before');
  }
});

test('the trace is delivered on the value, not on a slot name this module does not own', () => {
  // `order` is the assembler's vocabulary. Depending on its exact `stateProxy` token to decide whether to send T
  // would fail *silently* the day that token is renamed — an empty delivered list is a valid answer here — so the
  // gate is the trace text itself and the order array is walked for `recalled` only.
  const withoutSlot = deliverContext(input({ order: ['pinned', 'anchor', 'recalled', 'tail'] }));
  const reordered = deliverContext(input({ order: ['pinned', 'recalled', 'stateProxy', 'tail', 'anchor'] }));

  assert.equal(withoutSlot.delivered, true, withoutSlot.reason);
  assert.ok(injectedText(withoutSlot).includes(TRACE_START), 'no `stateProxy` slot in `order` does not suppress T');
  assert.ok(
    reordered.delivered && injectedText(reordered).includes(TRACE_START),
    'T is still delivered when its layout slot moves',
  );
  assert.ok(
    injectedText(reordered).indexOf(TRACE_START) > injectedText(reordered).indexOf('quoted verbatim'),
    'Trace Append places T after the recalled block',
  );
});

test('the block carries quoted session content and no S1CAP prose of its own', () => {
  const result = deliverContext(input());
  const messages = result.messages ?? [];
  const injected = messages[2] as { content: { text: string }[] };
  const text = injected.content[0]!.text;

  // The rule: S1CAP manages which of the harness's own context is in the prompt, and introduces nothing of its own.
  // An earlier version opened with "the blocks below were selected by relevance to the current task, they
  // supplement the transcript" - S1CAP writing about the context into the conversation. A bare concatenation
  // would fail the other way: an earlier turn re-sent as a fresh user message reads as something the user just
  // said. So: quoted verbatim, one provenance line each, the trace inside the paper's delimiters, nothing else.
  assert.ok(!/^#/m.test(text.split('## ')[0] ?? ''), `no preamble before the first block: ${text.slice(0, 80)}`);
  assert.ok(!text.includes('selected by relevance'), 'no explanation of why these were chosen');
  assert.ok(!text.includes('supplement'), 'and no instruction about how to read them');
  assert.ok(text.includes('quoted verbatim'), 'each quoted block says where its text came from');
  assert.ok(
    !text.includes('written by S1CAP from this session'),
    'and the trace carries no provenance line: T is the model\'s own text, introduced by the paper\'s delimiters',
  );
  assert.ok(text.includes(TAS_TRACE_TEXT), 'the state proxy is delivered, because that is the method');
  assert.ok(
    text.includes('scripts: build, test, dsh:add'),
    'the recalled turn is present word for word, not summarized',
  );
});

test('the delivered block respects trace placement within the injection', () => {
  // The two orders are the two layouts a round can actually record — the paper's two arms, Trace as State with `T`
  // in front of the long context and Trace Append with `T` behind it. **The pair used to be {question first,
  // question last}**, which the deleted axis produced; the question is the last block of every layout now, so the
  // question is in the same place in both and the property under test is unchanged: it is about `order`, not about
  // which knob wrote it.
  const traceBefore = deliverContext(input({ order: ['pinned', 'stateProxy', 'recalled', 'tail', 'anchor'] }));
  const traceAfter = deliverContext(input({ order: ['pinned', 'recalled', 'tail', 'stateProxy', 'anchor'] }));
  const textOf = (r: ReturnType<typeof deliverContext>): string => {
    const messages = r.messages ?? [];
    const last = messages[messages.length - 1] as { content: { text: string }[] };
    return last.content[0]!.text;
  };

  // Insertion cannot reorder the harness history, but the blocks it does send
  // must follow their recorded order rather than silently collapsing the arms.
  assert.deepEqual(traceBefore.blocks, ['stateProxy', 'recalled', 'recalled']);
  assert.deepEqual(
    traceAfter.blocks,
    ['recalled', 'recalled', 'stateProxy'],
    'Trace Append must remain distinguishable from Trace as State on the wire',
  );
  assert.notEqual(textOf(traceBefore), textOf(traceAfter), 'the delivered order changes with the layout axis');
  assert.ok(textOf(traceBefore).startsWith(TRACE_START), 'the delivered block opens with the trace');
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

test('a changed trace is a different payload too: the duplicate guard is content-based, not weakened', () => {
  // One rule covers both kinds of change, and adding `T` did not carve an exception out of it. The digest is
  // computed over the whole delivered text, so a new task's trace is a new payload and is delivered once; and
  // because `index.ts`'s per-session set keys on that same digest, the two guards agree about what "new" means.
  // The reason it is worth stating: `updatePolicy: 'perTask'` is what keeps this quiet. Under `'perTurn'` the trace
  // would change every step and every step would be a new payload, which is correct but not free.
  const base = deliverContext(input());

  const next = deliverContext(input({ step: 3, stateProxy: 'TASK: fix the failing test' }));

  assert.equal(next.delivered, true, next.reason);
  assert.notEqual(next.payloadId, base.payloadId, 'a new trace is a new payload, so it is sent rather than suppressed');
  assert.ok(injectedText(next).includes('TASK: fix the failing test'), 'and the model reads the new trace');
  assert.notEqual(
    next.payloadId,
    deliverContext(input()).payloadId,
    'while an unchanged trace beside an unchanged selection is the same payload, and is refused',
  );
});

test('a trace with no selection beside it is still a delivery', () => {
  // `recall.tier1: 'off'` makes the recalled block empty by construction, which used to mean "nothing to insert"
  // and therefore nothing to send. With TAS on there is a trace to send, and the trace is the variable the method
  // is about — so this is a delivery, and the block list says it is a delivery of exactly one thing.
  const traceOnly = deliverContext(input({ recalled: [] }));

  assert.equal(traceOnly.delivered, true, traceOnly.reason);
  assert.deepEqual(traceOnly.blocks, ['stateProxy']);
  assert.equal(injectedText(traceOnly), TAS_TRACE_TEXT, 'the message is the trace, framed once by the serializer');
  assert.equal(traceOnly.inserted, 1);
  assert.equal(traceOnly.kept, 2);
  assert.equal(traceOnly.dropped, 0);
});

test('nothing to insert means nothing is inserted, and the reason says which', () => {
  // Reachable only when the cell has neither a trace nor a selection. Before 2026-10-04 an empty selection was
  // this same answer, because there was never a second thing to insert; now it needs `tas.on` *and* an empty `T`.
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

/**
 * The switch, from the delivery module's side: `claimed-only` is what shipped, and `every-step` is the value that
 * makes the end-insertion branch reachable for an *empty* decision.
 *
 * The module's own comment records what this pair is about: the insertion point (`at < 0 -> messages.length`) has
 * always implemented "a step that claimed nothing gets its block at the end", and the refusal on the next line
 * returned before it - so the branch was reachable only for a decision that was non-empty *and* claimed nothing.
 * The doc and the guard contradicted each other and were left that way because the refusal's *reason* is the open
 * question (the empty decision is also the harness's turn-termination signal, which a plugin cannot observe).
 * These tests do not answer that question; they make it a per-step decision the caller states, and they pin both
 * answers. The round behind the switch: `20261003-2104`, 33 steps, 33 `LLM calls`, one per step, 2 assemblies.
 */
test('the default trigger refuses an empty decision with the reason the report scripts count', () => {
  // Named explicitly rather than left out, because this is the value a round that does not flip the switch runs:
  // the reason string is what `cell-report.mjs` and the refusal counts are read through, so it may not drift.
  //
  // A trace in hand does not lift the guard. This is the step the method cares about most — an empty decision is a
  // step that still streams a request from the log — and it stays refused under the default, because lifting it is
  // `assemblyTrigger`'s decision and not this module's. What the trace changes is what happens on the steps that
  // already delivered.
  const empty = deliverContext(input({ messages: [], claimed: [], step: 3, trigger: 'claimed-only' }));
  assert.equal(empty.delivered, false, 'T is available and the step is still refused: the switch was not flipped');
  assert.equal(empty.messages, null, 'the harness list is returned unchanged');
  assert.equal(empty.reason, 'the decision carried no messages');

  // And the harness's own first-step guard keeps its sharper sentence, ahead of the general one.
  const first = deliverContext(input({ messages: [], claimed: [], step: 1, trigger: 'claimed-only' }));
  assert.equal(first.delivered, false);
  assert.equal(first.reason, 'step 1 with no claimed messages: the harness treats this as no step at all');

  // The step that *does* deliver under the default is unchanged in shape and different in content: same insertion
  // point, same message count, one more block inside the message it already sent.
  const claimed = deliverContext(input());
  assert.equal(claimed.delivered, true, claimed.reason);
  assert.match(claimed.reason, /after the last claimed message \(index 2 of 2\)/, 'the default path is where it was');
  assert.deepEqual(claimed.blocks, ['stateProxy', 'recalled', 'recalled']);
  assert.ok(injectedText(claimed).startsWith(TRACE_START), 'and it now carries the trace');
});

test('under every-step an empty decision is delivered at the end, which the default could not do', () => {
  const result = deliverContext(input({ messages: [], claimed: [], step: 3, trigger: 'every-step' }));
  const messages = result.messages ?? [];

  assert.equal(result.delivered, true, result.reason);
  assert.equal(result.kept, 0, 'nothing was removed: the decision carried nothing to remove');
  assert.equal(result.dropped, 0);
  assert.equal(result.inserted, 1);
  assert.deepEqual(
    result.blocks,
    ['stateProxy', 'recalled', 'recalled'],
    'the same trace and the same selection the non-empty path carries',
  );
  assert.equal(messages.length, 1, 'the step increment becomes the injected message alone');
  const injected = messages[0] as { id: string; role: string; content: { text: string }[]; source: { kind: string } };
  assert.equal(injected.id, result.payloadId, 'the id still carries the payload digest');
  assert.equal(injected.role, 'user');
  assert.equal(injected.source.kind, 'system-prompt');
  assert.ok(injected.content[0]!.text.includes('scripts: build, test, dsh:add'), 'and the recalled text is in it');
  assert.ok(
    injected.content[0]!.text.includes(TAS_TRACE_TEXT),
    'and so is the trace: the permissive trigger decides *where* the block goes, not *what* it carries',
  );
  assert.ok(injected.content[0]!.text.startsWith(TRACE_START), 'the trace still opens the message on this path');
  // The end of an empty increment is index 0, and the record says which of the two insertions this was: a round
  // that flips the switch reads deliveries by reason, and "after the last claimed message" would be a false
  // description of a step that claimed nothing.
  assert.match(result.reason, /at the end of the step's increment \(index 0 of 0; nothing in the decision was claimed\)/);
});

test('every-step does not lift the first-step guard, and does not insert into an unknown shape', () => {
  // Two refusals deliberate enough to state as their own test. The first is the harness's own turn-boundary
  // guard, which the switch leaves alone: the evidence for `every-step` (33 steps, 33 calls) is about the steps
  // after the first. The second is the shape rule: this module inserts into a list, and a decision whose
  // `messages` is something else is a shape it does not understand - replacing it with a list would be the
  // rewrite the header forbids, not the insertion it promises.
  const first = deliverContext(input({ step: 1, messages: [], claimed: [], trigger: 'every-step' }));
  assert.equal(first.delivered, false);
  assert.equal(first.reason, 'step 1 with no claimed messages: the harness treats this as no step at all');

  const unknown = deliverContext(
    input({ messages: 'not a list' as unknown as unknown[], claimed: [], step: 4, trigger: 'every-step' }),
  );
  assert.equal(unknown.delivered, false);
  assert.equal(unknown.reason, 'the decision carried no messages');
  assert.equal(unknown.messages, null);
});

test('every-step changes nothing on a step that already claimed messages', () => {
  // The switch may only widen where the assembly happens; it may not change what a step that already worked
  // receives. Same list, same payload digest, same insertion point.
  const before = deliverContext(input());
  const after = deliverContext(input({ trigger: 'every-step' }));

  assert.equal(after.delivered, true, after.reason);
  assert.deepEqual(after.messages, before.messages);
  assert.equal(after.payloadId, before.payloadId);
  assert.equal(after.reason, before.reason, 'and the reason stays the claimed-message sentence, not the end one');
  assert.match(after.reason, /after the last claimed message \(index 2 of 2\)/);
});

test('with the permissive trigger the content check still fires when the block does come back', () => {
  // The cheap first test, under the value that makes the module's other guard (the per-session payload set in
  // `index.ts`) the load-bearing one: if some middleware does hand the previous injection back inside the
  // decision, this refusal is what stops a second copy - and it must not have been loosened by the switch.
  const once = deliverContext(input({ trigger: 'every-step' }));
  const twice = deliverContext(input({ messages: once.messages ?? [], step: 3, trigger: 'every-step' }));

  assert.equal(twice.delivered, false);
  assert.match(twice.reason, /already in the transcript/);
  assert.deepEqual(
    twice.blocks,
    ['stateProxy', 'recalled', 'recalled'],
    'the blocks are still reported on the refusal',
  );
});

/**
 * The three rules the module header states, re-pinned *with the trace in the payload*.
 *
 * The trace is the one block that is S1CAP-authored, so it is the one that could plausibly have tempted a rewrite:
 * a layout that wanted `T` at the front could have been implemented by rebuilding the list. These three say it was
 * not — the trace rides the same single insertion, into the same place, with the same duplicate guard — and each
 * asserts the trace's presence first, so none of them can pass against code that never sent `T`.
 */
test('rule: nothing this module did not add is removed, with the trace in the message', () => {
  const result = deliverContext(input());
  const messages = result.messages ?? [];
  const injected = messages[2];

  assert.equal(result.delivered, true, result.reason);
  assert.ok(
    injectedText(result).includes(TAS_TRACE_TEXT),
    'the trace is in there, to be protected along with the rest',
  );
  assert.equal(result.dropped, 0, 'nothing the harness sent is removed: the log keeps the transcript');
  assert.equal(result.kept, 2);
  assert.equal(messages.length, 3, 'exactly one message added, whatever it carries');
  // Identity, not equality: the harness's own objects come back untouched, in their own order.
  assert.deepEqual(messages.filter((m) => m !== injected), [SYSTEM, ASKED]);
  assert.equal(messages[0], SYSTEM, 'the system prefix is still first: the trace did not jump the cache-stable head');
  assert.equal(messages[1], ASKED);
});

test('rule: an equal payload is still refused, and the trace is part of what makes it equal', () => {
  const once = deliverContext(input());
  const messages = once.messages ?? [];

  const twice = deliverContext(input({ messages, step: 3 }));

  assert.ok(injectedText(once).includes(TAS_TRACE_TEXT), 'the payload being re-fed does contain the trace');
  assert.equal(twice.delivered, false, 'and it is still refused rather than re-appended');
  assert.match(twice.reason, /already in the transcript/);
  assert.equal(twice.messages, null, 'so the harness list is returned unchanged');
  assert.deepEqual(twice.blocks, ['stateProxy', 'recalled', 'recalled'], 'the blocks are still reported');

  // The other direction, which is the one the trace makes newly interesting: change one character of T and the
  // guard must *not* fire. A dedup that ignored the trace would silently swallow every new task's trace.
  const changed = deliverContext(input({ messages, step: 3, stateProxy: `${TAS_TRACE_TEXT}.` }));
  assert.equal(changed.delivered, true, 'a different trace is not the same payload');
  assert.notEqual(changed.payloadId, once.payloadId);
});

test('rule: a step that already claimed messages still inserts in the same place, trace or no trace', () => {
  const withTrace = deliverContext(input());
  const withoutTrace = deliverContext(input({ stateProxy: undefined }));

  assert.equal(withTrace.delivered, true, withTrace.reason);
  assert.equal(withoutTrace.delivered, true, withoutTrace.reason);
  assert.match(withTrace.reason, /after the last claimed message \(index 2 of 2\)/);
  assert.match(
    withoutTrace.reason,
    /after the last claimed message \(index 2 of 2\)/,
    'the same sentence, the same index',
  );
  assert.deepEqual(
    withTrace.messages?.slice(0, 2),
    withoutTrace.messages?.slice(0, 2),
    'the trace does not move the anchor: the harness messages before the insertion are the same two',
  );
  assert.equal(withTrace.messages?.length, 3);
  assert.notEqual(withTrace.payloadId, withoutTrace.payloadId, 'only the content of the inserted message differs');
});

test('the trace is delivered once per task, not once per step: the rules above, over several steps', () => {
  // What a long turn actually does. `updatePolicy: 'perTask'` makes T byte-stable within a task, so steps 3..5 of
  // one task all offer the same payload; the harness hands back the previous injection on the steps where it can
  // see it, and the per-session payload-id set in `index.ts` covers the steps where it cannot (it keys on this same
  // digest). Nothing about the trace changed either half of that — and this is the case that would blow up first if
  // the trace had been added *outside* the digest.
  const once = deliverContext(input({ step: 2 }));
  const messages = once.messages ?? [];
  const delivered: number[] = [];

  for (const step of [3, 4, 5]) {
    const again = deliverContext(input({ step, messages }));
    if (again.delivered) delivered.push(step);
  }

  assert.deepEqual(delivered, [], 'the same trace and the same selection never enter the log twice');
  assert.ok(once.payloadId.startsWith('s1cap-'), 'the payload id still carries the core marker, T or no T');
});
