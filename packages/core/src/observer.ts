/**
 * OBSERVER — read-only, per-LLM-call context accounting.
 *
 * M1 runs S1CAP in observation mode: the segmenter, the association graph and the assembler all run for
 * real, and the *result* is recorded in the control plane, but the prompt the model receives is returned
 * untouched. That is what makes the first milestone safe to run against a live session: nothing here can
 * change a single token the model sees, while the numbers we will later optimise are already measurable
 * (candidates, selected blocks, budget, cache-stable prefix, and the token delta against the full history).
 *
 * Everything is a pure function of its inputs — no clock reads, no randomness, no mutation of the caller's
 * messages — so a replay of the same step produces the same observation byte for byte
 * (`packages/core/test/observer.test.ts`).
 */
import type { AssemblyLayout, AssemblyPolicy, Segment, SegmentKind } from './types.ts';
import { AssociationGraph } from './assoc-graph.ts';
import { segmentEvent, estimateTokens, isS1capInjected } from './segmenter.ts';
import { assemble, totalTokens } from './assembler.ts';
import { adaptMessages } from './harness-adapter.ts';
import type { AdapterReport } from './harness-adapter.ts';
import { TELEMETRY_SCHEMA_VERSION } from './telemetry.ts';
import { buildStateProxy } from './state-proxy.ts';
import type { AssemblyEvent } from './telemetry.ts';

/**
 * The rule: which segment kinds are **input events**, i.e. the session events a step's recall may be seeded from.
 *
 * It comes from two sentences of the originating brief, quoted verbatim in `types.ts` §`AssemblyTrigger`. Idea 3
 * drives the recall from "the user input *or* the model's own self-directed input" `x`; idea 2 defines a session
 * event as "user input x, or LLM output o, tool-call results, etc.". Both halves of that disjunction are input
 * events, so every session-event kind is a seed and exactly one kind is not:
 *
 *   kind             seed?   why
 *   --------------   -----   ----------------------------------------------------------------------------------
 *   `user`           yes     idea 2's "user input x" — the first half of idea 3's disjunction
 *   `assistant`      yes     idea 2's "LLM output o" — the second half, "the model's own self-directed input"
 *   `trace`          yes     the same model output under another name: an assistant message that carries reasoning
 *                            parts is labelled `trace` (`harness-adapter.ts`), so excluding it would leave the
 *                            defect unfixed for any model that reasons. Round `20261004-0233` logged 25 `trace`
 *                            segments and **zero** `assistant` ones, and its own frozen root is the proof
 *   `toolCall`       yes     the model's own act under idea 2's "etc." — the invocation is the model's decision,
 *                            and its arguments are the intent a later step can be related to
 *   `toolResult`     yes     named outright by idea 2: "tool-call results"
 *   `systemPinned`   **no**  the one exclusion. It is not a session event at all: the pinned prefix (the rendered
 *                            system prompt, developer instructions, the harness's own notices) precedes
 *                            everything in the request by construction and is placed exactly once, in the head.
 *                            Seeding a walk from it would make the step recall *from its own instructions*, and it
 *                            is the block every other one is positioned relative to
 *
 * A `Record<SegmentKind, boolean>` and not a set or a `kind !== 'systemPinned'` test, because the exhaustiveness
 * is the point: a seventh kind is a type error here and has to be classified deliberately rather than silently
 * joining the seeds. This table is the single place the rule lives.
 */
const INPUT_EVENT: Record<SegmentKind, boolean> = {
  user: true,
  assistant: true,
  trace: true,
  toolCall: true,
  toolResult: true,
  systemPinned: false,
};

/**
 * Is this segment an input event — a session event the step's recall may be seeded from? See `INPUT_EVENT` above,
 * which is the only place the answer is decided.
 *
 * Used twice in `observeStep`, and both call sites have to agree: the anchor the walk is rooted on (`windowAnchor`)
 * and the payload-side anchor the mismatch diagnostic compares it against. Two different predicates there would
 * make the diagnostic fire on every mid-turn step, which is noise rather than a report.
 */
export function isInputEvent(segment: Segment): boolean {
  return INPUT_EVENT[segment.kind];
}

export interface ObserveStepInput {
  sessionId: string;
  /** harness step number (1-based); recorded for correlation only */
  step: number;
  /**
   * The observer's own monotonic counter, advanced by the messages each call carried.
   *
   * It is **not** a session-log sequence: the harness's `agent/pre-step` payload does not expose one, so this
   * number is only meaningful within a run's own records, and tools must not join it against the session store.
   * The field was documented as "session-log sequence of the first message in `messages`", which it has never
   * been - round `20261002-2037`'s own reader prints it under a column headed `step?` with the question mark,
   * which is the honest reading of it.
   */
  seq: number;
  /** harness message list as offered to this LLM call (DSH shape; see harness-adapter.ts) */
  messages: readonly unknown[];
  /**
   * Rendered system prompt, when the caller has one. The `agent/pre-step` payload's `messages` array does
   * not carry it — verified in a real round, where `blocks.pinned` came out 0 — so the harness's own
   * system-prompt surface supplies it; `extractSystemPrompt()` reads it out of a session event.
   */
  systemPrompt?: string;
  policy: AssemblyPolicy;
  now: number;
  /**
   * Optional batch scorer, forwarded to the graph. Supplied when a System-1 backend is live, absent otherwise -
   * the graph falls back to its lexical scorer, which is what keeps observation mode free and offline.
   */
  scoreBatch?: (
    current: Segment,
    candidates: readonly Segment[],
  ) => readonly number[] | Promise<readonly number[]>;
  /**
   * Default true. Pass false on a synchronous path whose system has an asynchronous scoring path: the graph scores
   * each new segment once, from whichever caller reaches `scoreNew` first, so a step that scores lexically does not
   * merely add edges - it takes the scoring away from the System-1 backend. See the note at the call site.
   */
  scoreOnStepPath?: boolean;
  /**
   * Called with the anchor segment's id once the anchor has been chosen and before `assemble()` runs.
   *
   * It exists because the anchor id is computed *here*, inside `observeStep`, while the queue that drains
   * asynchronous System-1 scoring lives in the plugin. The plugin uses this to wait for that one segment's row to
   * finish scoring, which is what stops a step from assembling before the segment it recalls from has any scored
   * edges. A throw is contained and reported like every other optional surface: it costs the wait, never the step.
   */
  beforeAssemble?: (anchorId: string) => void | Promise<void>;
  /**
   * One-entry memo for T, held by the caller so it survives across steps. It is passed in rather than created
   * here because `observeStep` is a pure function of its input: a per-call proxy cache would rebuild T on every
   * step, which is exactly the instability the block is placed to avoid.
   */
  proxyCache?: { id: string; text: string };
  /**
   * The order the recalled block was left in by this session's previous step, held by the caller for the same
   * reason `proxyCache` is and **mutated in place by `assemble()`** (see `AssembleInput.recallOrder`).
   *
   * Like `proxyCache`, it belongs to one session. Forked sessions can share event
   * ids, so an id alone is not a safe cache key across sessions. The plugin holds
   * separate caches for both values alongside its per-session graph map.
   *
   * Its absence is supported and costs one step of ordering stability, never a different selection: without it the
   * block falls back to the deterministic order this build used before the ordering existed.
   */
  recallOrder?: string[];
  contextWindow: number;
  reserveOutputTokens: number;
  fixedOverheadTokens: number;
  lambdaMs: number;
  /**
   * The graph maintained across steps. In observation mode the upkeep is a synchronous stand-in for the
   * asynchronous lane: the graph is updated here, before assembly, so recall has something to recall.
   * The async lane replaces this call site in M1's next sub-step; the assembler never notices.
   */
  graph: AssociationGraph;
  reasoningPartTypes?: readonly string[];
  /**
   * Session events the upkeep queue dropped because it was full, cumulative for the session, as of this call.
   *
   * Passed in rather than read here because the queue belongs to the caller and `observeStep` owns no state; it
   * travels to the record because a dropped event is content loss - the segment never entered the graph - and the
   * only other record of it was `upkeep.dropped` on the live `/s1` route. See `AssemblyEvent.upkeepDropped`.
   */
  upkeepDropped?: number;
  /**
   * Called when the payload's own anchor position and the graph window's disagree, with both and with the ids
   * they name.
   *
   * The two are positions in different arrays - the payload's segment list and the graph's append order - so a
   * disagreement is expected rather than exceptional, and this is not a warning: it is the evidence that the two
   * spaces are distinct. Both are resolved with the same predicate (`isInputEvent`), which is what keeps this a
   * report about the *spaces* instead of a report about the two rules disagreeing. It exists because the defect it
   * documents was invisible: a live round rooted 273 of 277 walks on a turn-1 segment and every counter in the
   * record stayed healthy. Optional, and never awaited or caught: a diagnostic that cannot be recorded must not be
   * able to cost the step.
   */
  onAnchorMismatch?: (detail: { payloadAnchor: number; windowAnchor: number; payloadId: string; windowId: string }) => void;
  /**
   * Default true. Pass false for a step the caller has decided cannot receive context.
   *
   * The expensive half of a step - the BFS walk in `assemble()`, the anchor wait, T's rebuild and the token
   * accounting - buys nothing on such a step, and a measured diagnostic round paid for it 275 times out of 277:
   * 1,205,029 recalled tokens assembled against 1,597 delivered (0.133%), because the decision carried no
   * messages on all but two of those steps and the assembly had already run by the time anyone looked.
   *
   * **The reason the decision is empty is not "there is no request", and this comment used to say it was.** The
   * packaged harness appends `decision.messages` and then builds and streams the request *unconditionally*
   * (`dsh-agent-loop/lib/index.js`: the append at L1061, `buildRequest` at L1063, `stream` at L1072) - the
   * request is built from the session log, not from the decision. Round `20261002-2037` proves it in its own
   * numbers: 277 `step/start` against 277 `assistant/message`, with one `turn/start` and no `turn/end` at all,
   * so all 275 empty-decision steps did call the model. The two places the loop *does* skip on an empty decision
   * are turn-boundary tests (L962 `if (turnEnds && decision.messages.length === 0) break`, and the step-0 case at
   * L963) - i.e. the empty decision is the harness's **turn-termination signal**, which the plugin cannot
   * observe: `turnEnds` is a local of the loop, and the payload carries `{messages, turn, step, signal}`.
   *
   * So the flag is not "this step sends no request". It is "this step's decision is empty, which is also how the
   * harness says the turn is over, and returning a message here would defeat `termination: 'model-owned'`".
   * That is a design decision and not a capability limit, and it is recorded as such rather than asserted as a
   * fact about the harness. What is *not* left to that decision is the accounting: the caller reports
   * `assembled: false, ingested: true` on the step's `context_delivery` record, so a reader can tell an
   * observation that ran and was declined from one that never ran.
   *
   * The flag stops at assembly. The adapter, the segmenter and `graph.addSegments` still run, because a segment
   * exists as soon as the host's stream or this payload carries it and a step is one of the two ways it arrives;
   * a skip that also stopped ingestion would leave a hole in the graph exactly the size of the steps the harness
   * claimed nothing for, which is most of them.
   */
  assemble?: boolean;
}

/** a step that produced an assembly and a control-plane record */
export interface StepObservation {
  kind: 'assembled';
  /** the control-plane record (frozen telemetry schema v1) */
  event: AssemblyEvent;
  /** what the segmenter produced, in order */
  segments: Segment[];
  /** the recalled block actually selected, in order (ids only, for replay comparison) */
  selectedIds: string[];
  /**
   * The blocks themselves, in layout order. Present so a caller can *deliver* the view rather than only report
   * it: until `context-delivery.ts` existed, the layout was reachable only as token counts in the record, and a
   * layout the model never sees is a claim in a log file.
   */
  layout: AssemblyLayout;
  fullTokens: number;
  selectedTokens: number;
  /** tokens the full history would have sent that the selected view does not */
  wouldSaveTokens: number;
  report: AdapterReport;
  /** wall time the observation itself took, filled by the caller (0 when unknown) */
  observeMs: number;
}

/**
 * A step that produced no assembly at all.
 *
 * This is a real shape, not a defensive fiction: a live `agent/pre-step` payload whose messages carry nothing the
 * adapter turns into a segment leaves the segment list empty, and there is then no "current" segment to anchor an
 * assembly on. The earlier code asserted non-null with `segments[segments.length - 1]!` and threw
 * `Cannot read properties of undefined (reading 'tokens')` from the assembler - once per step, swallowed by the
 * observer's own guard. It looked like a working install: the plugin stayed inert, the harness was fine, and the
 * control-plane log kept exactly one record from the primer. Reporting the case is what makes it visible.
 */
/**
 * A step that was ingested and deliberately not assembled ([`ObserveStepInput.assemble`]).
 *
 * It is a third state and not a flavour of the two above, because the difference is the whole point of the flag:
 * `assembled` means the walk ran, `empty` means it could not, and `ingested` means nobody asked for it. Collapsing
 * this into `empty` would report a skip as a failure of the segmenter, which is the opposite of what happened.
 *
 * The counts are here so a caller can prove the step was still *read*: `segments` is what this step contributed to
 * the graph, and `messages` is how many messages the payload carried (0 is the usual number - the harness claims
 * its messages in the decision, not in this payload).
 */
export interface IngestedStepObservation {
  kind: 'ingested';
  /** what the segmenter produced for this step, in order; these are in the graph */
  segments: Segment[];
  /** why nothing was assembled, in words fit for a log line */
  reason: string;
  /** how many messages the payload's own list carried */
  messages: number;
  report: AdapterReport;
}

export interface EmptyStepObservation {
  kind: 'empty';
  /** why there is nothing to assemble, in words fit for a log line */
  reason: string;
  /** the number of messages that produced no segment */
  messages: number;
  /**
   * Still present, and the reason it matters: the report names the roles and part types the adapter could not
   * read. An empty step is usually a *shape* we do not understand yet, so dropping the report would throw away
   * the only clue about which shape it was.
   */
  report: AdapterReport;
}

export async function observeStep(
  input: ObserveStepInput,
): Promise<StepObservation | IngestedStepObservation | EmptyStepObservation> {
  const { events, report } = adaptMessages(input.messages, {
    sessionId: input.sessionId,
    startSeq: input.seq,
    now: input.now,
    ...(input.reasoningPartTypes !== undefined ? { reasoningPartTypes: input.reasoningPartTypes } : {}),
  });

  // segmentEvent applies the I2 gate (provenance.ts): a control-plane record can never become a segment.
  //
  // One more gate here, and it is the important one. A block S1CAP delivered is appended to the session log by
  // the harness, so it comes back through the session-event stream as an ordinary user message. Letting it in
  // would put S1CAP's own output into the graph, and from there into three places at once: the recall
  // candidates (so relevance re-selects a summary of the conversation as the most relevant thing in it), the
  // verbatim tail (so we re-present our own text as if it were a recent turn), and `fullTokens` — which is the
  // denominator of `wouldSaveTokens`. The last is the one that makes the headline number self-referential: the
  // tokens "saved" would be measured against a baseline S1CAP itself inflated. The method is about which of the
  // harness's own context is in the prompt and in what order, so its own text does not belong in that accounting.
  //
  // The host keeps its copy in the log and builds the request from the log, so the model still reads what was
  // delivered; what stops is S1CAP measuring, recalling or re-delivering it.
  const ingestable = events.filter((ev) => !isS1capInjected(ev.id));
  const segments: Segment[] = ingestable.flatMap((ev) => segmentEvent(ev));
  input.graph.addSegments(segments);
  // The pinned prefix, built before the skip below rather than after it.
  //
  // It is two statements and it belongs to neither half: a rendered system prompt is part of what the *session*
  // carries, and the reason it is added to `pinned` rather than to the graph is that it has to stay byte-stable
  // at the front of the prompt and may never be a recall candidate. Keeping it here means a skipped step's
  // segments are exactly `segments` - one list, one meaning - instead of a list that silently grew a pin.
  const pinned = segments.filter((s) => s.kind === 'systemPinned');
  const promptText = input.systemPrompt?.trim() ?? '';
  if (promptText !== '') {
    pinned.unshift({
      id: 'system-prompt',
      sessionId: input.sessionId,
      kind: 'systemPinned',
      seq: input.seq,
      ts: input.now,
      tokens: estimateTokens(promptText),
      text: promptText,
    });
  }
  // The step is read, and nothing about the model view is decided. Everything below this line is assembly work,
  // and assembly work on a step that cannot receive context is what this flag exists to stop paying for (see
  // `ObserveStepInput.assemble`). The graph write above is deliberately *not* skipped: a segment belongs to the
  // session from the moment the harness carries it, and only the view is optional.
  //
  // It sits above the scoring branch as well. That branch exists to keep the System-1 scoring to whichever caller
  // reaches it first, and a skip is not a caller asking for anything: scoring on a step that assembles nothing
  // would take the pairs away from upkeep - the lane that is still scoring for the steps that do assemble - which
  // is the failure `scoreOnStepPath` was added to fix, arrived at from the other side.
  if (input.assemble === false) {
    return {
      kind: 'ingested',
      segments,
      reason:
        'the decision carried no messages, so the step was ingested and not assembled: ' +
        'there is nothing to insert a block into, and the walk would be paid for and thrown away',
      messages: input.messages.length,
      report,
    };
  }
  // recall.window = w: only segments that arrived since the previous step are scored, each against
  // the most recent w segments. Segments outside the window keep their edges and stay reachable.
  //
  // `scoreOnStepPath` exists because there are two callers of this function and they are not the same call. In the
  // plugin, the synchronous pre-step path and the asynchronous upkeep path both add segments to the same graph, and
  // `scoreNew` advances a cursor: whoever gets there first owns the scoring for those segments. Left to itself, the
  // pre-step path won every time and scored every pair with the local lexical scorer, so upkeep later found nothing
  // new to score and the System-1 association backend was asked nothing at all - `upkeepScoredPairs: 0` with a
  // healthy-looking graph, which is what a live session actually measured.
  //
  // Routing the scoring to upkeep is also the only reading consistent with the policy: `rgMaintenance` is declared
  // `async`, and a measured System-1 call costs 400-1500 ms against a 250 ms assembly deadline. A step that waited
  // on scoring would either blow its own budget or answer from a scorer that never ran.
  if (input.scoreOnStepPath !== false) {
    await input.graph.scoreNew({
      windowN: input.policy.recall.window,
      threshold: input.policy.recall.threshold,
      ...(input.scoreBatch !== undefined ? { scoreBatch: input.scoreBatch } : {}),
    });
  }

  // Where the model view is taken from, and which segment is the step's own question.
  //
  // This used to say: the payload's segments when it has any, the graph's append order otherwise, because the
  // graph is a superset and "using it never loses a segment the payload carried". The conclusion was right and
  // the direction was backwards, and the cost has now been measured. The graph IS a superset — which means
  // using the *payload* is the lossy choice, not the graph. At a turn-opening step the payload holds exactly one
  // new user message, so the pool is that message, `history` is empty, and there is nothing for relevance to
  // select: a live C2 run delivered the state proxy on 4 steps, every one of them with `blocks.recalled = 0`,
  // while the five steps that did have history (836 to 5243 tokens of it) were the steps the harness claims
  // nothing for - so recall and delivery fired on disjoint steps.
  //
  // (Those "steps the harness claims nothing for" were previously described here as steps where "no request is
  // made at all". That is false, and the packaged harness says so unconditionally: the request is built from the
  // session log and streamed whatever `decision.messages` holds (`dsh-agent-loop` L1061/L1063/L1072), and the
  // round's own 277 `step/start` against 277 `assistant/message` confirm it. The empty decision is the harness's
  // turn-*termination* signal - L962/L963 - which is why the caller still declines to assemble on it; see
  // `ObserveStepInput.assemble` for the whole rule. What the disjointness above measures is the *claimed list*,
  // not the existence of a request.)
  //
  // The graph's ordered segments are the session's own append order, so they include everything the payload
  // carried and everything before it. That is the window a model call needs.
  //
  // The anchor is the newest *input event* in that window — `isInputEvent` above — and getting that predicate
  // wrong is where a whole run's recall silently pointed at the wrong turn. Two independent defects have been
  // found here.
  //
  // The first was an index space. The line above computes a position inside the payload's segment list; this one
  // used to apply it to the graph's array (`window[anchor]`). The two index spaces coincide only when the graph's
  // order begins where the payload's does, which is the rare case: the payload holds the current question *after*
  // the payload's own first segment, so a payload whose last user turn sits at index 2 indexed the graph's
  // third-oldest segment. Measured over the same diagnostic round: 273 of 277 invocations rooted the walk on
  // `34b2115f-…-#3`, the tail chunk of turn 1's AGENTS.md block, and the task's own three chunks were re-offered as
  // candidates 190, 189 and 188 times. The tree was a faithful account of a walk from the wrong question, and no
  // counting of its nodes could have shown that.
  //
  // The second is the predicate itself, and it survived that fix because the fix kept it: the anchor was "the
  // newest `user` segment". That is a chat-transcript rule. It holds while a session alternates one user turn with
  // one model turn, and it stops advancing the moment the loop takes more than one step per turn — the model's own
  // messages arrive as `assistant` (or `trace`), its tool invocations as `toolCall`, their results as `toolResult`,
  // and none of those is a `user` segment. So from the turn's second step on, the newest `user` segment stays the
  // turn's opening question for the rest of the turn, and every step re-seeds the walk from it.
  //
  // Measured in round `20261004-0233`, cell C2, from that round's own control plane (`evidence/C2/control.jsonl`,
  // 25 assemblies): the `recallTree` root changed once and then stayed `7b0dd492-…-#3` for the last 20 consecutive
  // assemblies while the step counter climbed from 23 to 116. Every one of those walks explored the same frozen
  // neighbourhood — `candidates` plateaued at 26-28, `selected` at 20, `bfsDepth` at 2 — and because the selection
  // never moved, the delivered payload was byte-identical from step to step, so the payload-id guard refused the
  // re-delivery and only 11 of the 25 steps received anything at all.
  //
  // That session's own segment kinds are the proof that no `user`-only condition could have advanced: it logged
  // 15 `user`, 25 `trace`, 42 `toolCall` and 42 `toolResult` segments and **no `assistant` segment at all** (every
  // model message carried reasoning parts, so the adapter labelled it `trace`), and 14 of the 15 `user` segments
  // were S1CAP's own deliveries, which ingestion drops (`isS1capInjected`). The frozen root was the one genuine
  // `user` segment left in the graph. A rule that admitted only `user`, `assistant` and the tool kinds would still
  // freeze there.
  //
  // `isInputEvent` is therefore the brief's own rule, applied: both halves of idea 3 drive the recall. The window
  // is append-ordered and holds everything the step carries, so its newest input event is the step's own `x`;
  // every other block is written relative to it (`pool` below excludes it, `unjudgedWithin` looks back from it),
  // and assembling from any other segment would describe a prompt nobody is going to send.
  const window: Segment[] = input.graph.orderedSegments();
  const windowAnchor = lastIndexWhere(window, isInputEvent);
  // The payload's own anchor is still computed, and is now used for one thing only: a diagnostic when the two
  // disagree — the payload's own segment list and the graph's append order are different arrays, and silence here
  // would leave the next reader of this file to rediscover which space each index lives in, which is what the
  // first fix above cost. It is resolved with the *same* predicate as the window's for that reason: with the
  // payload read as "newest user segment" and the graph as "newest input event", every mid-turn step would report
  // a disagreement that is not one, and the diagnostic would stop being read.
  const anchor = lastIndexWhere(segments, isInputEvent);
  if (anchor >= 0 && windowAnchor >= 0 && windowAnchor !== anchor) {
    const idAt = (list: readonly Segment[], i: number): string => list[i]?.id ?? '';
    try {
      input.onAnchorMismatch?.({
        payloadAnchor: anchor,
        windowAnchor,
        payloadId: idAt(segments, anchor),
        windowId: idAt(window, windowAnchor),
      });
    } catch {
      /* a diagnostic that cannot be recorded costs the diagnostic, never the step */
    }
  }
  const current = windowAnchor >= 0 ? window[windowAnchor] : window[window.length - 1];
  if (current === undefined) {
    // The counts are in the message on purpose. "No segment" alone was not enough to tell which stage dropped
    // the step, and guessing at it cost a whole session.
    return {
      kind: 'empty',
      reason:
        'no segment to assemble ' +
        `(messages=${input.messages.length} events=${events.length} reported=${report.messages} ` +
        `emptyMessages=${report.empty} parts=${report.parts} rawParts=${report.rawParts} ` +
        `graphSegments=${input.graph.stats().segments} ` +
        `unknownRoles=[${report.unknownRoles.join(',')}] unknownParts=[${report.unknownPartTypes.join(',')}])`,
      messages: input.messages.length,
      report,
    };
  }
  // The bounded anchor wait, before anything is assembled from the graph.
  //
  // It sits here, and not earlier, because `current.id` is only known once the anchor has been chosen; and not
  // later, because `assemble()` is the first reader of the anchor's scored edges - a wait after it would be a
  // measurement of nothing. `observeStep` stays a pure function of its input and owns no clock, so the waiting
  // itself is the caller's: this only hands over the id and continues.
  //
  // Contained, and deliberately quiet: this function has no diagnostic sink of its own (it is pure by design, see
  // the header) and the plugin's wait is written never to throw. A throw here is a caller bug, and the same
  // fail-open rule that admits unjudged pairs is what makes swallowing it safe - the step assembles with whatever
  // the graph has, and `unknownAdmitted` reports the difference. It must not cost the step.
  try {
    await input.beforeAssemble?.(current.id);
  } catch {
    /* the wait failed: assemble from the graph as it stands, which is the fail-open path */
  }
  // Everything in the window except the anchor, the anchor's own sibling chunks, and the pinned prefix, in
  // append order.
  //
  // This used to be written "the segments before the anchor", and the two were taken to be equivalent. They were
  // not: the anchor was then the newest `user` segment, and the model's output for the current task - its
  // messages, tool calls and tool results - arrives *after* it in the append-only log. Slicing before the anchor
  // therefore discarded exactly the newest turns, and `tail` came out empty in every live record (blocks.tail = 0
  // across a whole run) while the k most recent verbatim turns were quietly not in the prompt at all. With the
  // anchor now the newest input event, nothing but pinned segments follows it and the two spellings *would*
  // coincide - which is why the filter stays: it is the spelling whose correctness does not depend on where the
  // anchor is, so the next change to `isInputEvent` cannot silently reintroduce the empty tail.
  //
  // The sibling exclusion is the seed rule's other half. The anchor is the *last chunk* of its event, not the
  // event: a long event is split into chunks sharing a `chunkOf` parent (`segmenter.ts`), so the segment the walk
  // starts from sits in the graph as one of several, and - on a turn-opening step - the question the model is
  // answering is one of them. Without this line the rest are ordinary history - in `tail` when they are the last
  // k, in `history` and therefore in the fallback otherwise - and a recall hit on one is delivered as "an earlier
  // turn, quoted verbatim" naming the current event's own id. Measured in round `20261002-2037`: both of the run's
  // deliveries quote the task prompt, and the delivered body is its middle chunk; `recall-C2.txt` shows the
  // prompt's three chunks offered as candidates 190 / 189 / 188 times. Re-quoting the event the walk starts from
  // is both false and redundant, whatever kind it is - the exclusion is on the identity of the parent
  // (`chunkOf ?? id`) rather than on the chunk, which is what makes it follow the anchor to a `toolResult` as well.
  const anchorParent = current.chunkOf ?? current.id;
  const pool = window.filter(
    (s) => s.id !== current.id && (s.chunkOf ?? s.id) !== anchorParent && s.kind !== 'systemPinned',
  );
  // The same exclusion has to reach the assembler, and this is not redundancy: the walk draws its candidates
  // from the *graph*, not from this list, so a sibling chunk is still selectable there even with `pool` clean.
  // `excludeIds` is that half (see `AssembleInput`), and it is also what keeps a sibling out of the recency
  // fallback, whose candidate list is `history` minus `excluded`.
  const siblingIds = window
    .filter((s) => (s.chunkOf ?? s.id) === anchorParent && s.id !== current.id)
    .map((s) => s.id);
  // `tail` is the k most recent turns, verbatim. Which side of x they end up on is the layout's business and not
  // the selector's: with x last they sit immediately before it, with x first immediately after it.
  const tailCount = Math.max(0, Math.min(input.policy.tail.k, pool.length));
  const tail = tailCount > 0 ? pool.slice(pool.length - tailCount) : [];
  const history = pool
    .slice(0, pool.length - tailCount)
    // Our own delivered blocks are excluded from the recall candidates as well. The ingestion gate above is
    // where this normally happens; this line is the second lock on the same door, and it is here because the
    // graph is also filled by replay and by upkeep, neither of which goes through that one statement. A block
    // that summarizes the conversation is among the most relevant things in it, so re-selecting it is not a
    // cosmetic problem. Excluding here covers both the S1 selection and the recency fallback, since the
    // assembler draws candidates from `history` in both cases.
    .filter((s) => !isS1capInjected(s.id));
  // --- T's boundary, which is the task and not the recall anchor ---
  //
  // T = π(r_1,…,r_ntr) is the model's reasoning **for one task** ("an observable textual proxy for task state",
  // `state-proxy.ts`), and `buildStateProxy` serialises the `assistant`/`trace` segments that *follow* the segment
  // it is handed as `anchorId` — its contract for that argument is "id of the current task segment x". It used to
  // be handed the recall anchor, and the two were the same segment by accident of the old rule: the recall anchor
  // was the newest `user` segment, which on a turn-opening step is the question that opened the task. They are not
  // the same segment now — the recall anchor is the newest input event and moves at every step — so handing T that
  // id would slice T's input at the very end of the log: T would come out empty on every step after the first,
  // and the state proxy would vanish from the two cells that exist to deliver it while every counter on the record
  // stayed healthy. The task boundary is unchanged and is still the newest `user` segment, which is what the old
  // expression for the recall anchor always computed: the question the task was opened with.
  //
  // The fallback is the recall anchor, and it only arises in a window with no `user` segment at all — a session
  // whose every event is a model or tool event. T is the empty string there either way, because nothing the model
  // produced for a task can precede the task's own question.
  const taskAnchor = lastIndexWhere(window, (s) => s.kind === 'user');
  const taskSegment = taskAnchor >= 0 ? (window[taskAnchor] ?? current) : current;
  // One-entry memo of the last built T. `perTask` is the default policy precisely so this can be a single slot:
  // within a task T does not change, and when the task changes the task segment's id changes with it. Keyed on
  // `taskSegment` rather than on the recall anchor on purpose — a moving key would rebuild T on every step and
  // quietly turn the default `perTask` policy into a per-step one.
  const proxyCache = input.proxyCache ?? { id: '', text: '' };
  // An opening question has no subsequent trace. Do not freeze that absence:
  // perTask freezes the first nonempty trace once the model has produced it.
  // `perTask` reuses the memo across the steps of one task; `perTurn` rebuilds every step, which is what that
  // policy means and is not free.
  const reuseProxy = input.policy.tas.updatePolicy === 'perTask' && proxyCache.id === taskSegment.id &&
    proxyCache.text !== '';
  const proxyText = reuseProxy
    ? proxyCache.text
    : buildStateProxy({
        segments: window,
        anchorId: taskSegment.id,
        maxChars: input.policy.tas.tMaxChars,
        updatePolicy: input.policy.tas.updatePolicy,
        now: input.now,
      });
  // Write the memo back only for `perTask`. A `perTurn` policy would find a matching id and reuse a proxy it was
  // supposed to rebuild, which is the one way a cache this cheap can be wrong rather than merely redundant.
  if (input.proxyCache !== undefined && input.policy.tas.updatePolicy === 'perTask' && !reuseProxy) {
    input.proxyCache.id = taskSegment.id;
    input.proxyCache.text = proxyText;
  }

  const result = assemble({
    graph: input.graph,
    policy: input.policy,
    pinned,
    tail,
    current,
    // T, the serialized task state, replaces the raw trace in front of the moving blocks. Its stability is what
    // lets it sit in the cache-stable head.
    stateProxy: proxyText,
    contextWindow: input.contextWindow,
    reserveOutputTokens: input.reserveOutputTokens,
    fixedOverheadTokens: input.fixedOverheadTokens,
    now: input.now,
    lambdaMs: input.lambdaMs,
    history,
    // The anchor's sibling chunks, so a *graph* hit on one of them is dropped too: the walk does not read `pool`.
    excludeIds: siblingIds,
    // The block's order from this session's previous step, mutated in place to this step's order. It is the
    // caller's, like the T memo above and for the same reason: `observeStep` is a pure function of its input, so a
    // per-call order map would be an empty one every step — which is exactly the instability the ordering exists to
    // remove, and would look identical on the record.
    ...(input.recallOrder !== undefined ? { recallOrder: input.recallOrder } : {}),
  });

  // Measured against the window the view was actually taken from, not the payload: with an empty payload the
  // payload's tokens are zero, and "what the full history would have cost" would be reported as free.
  const fullTokens = totalTokens(window);
  const selectedTokens = result.budget.used;
  const graphStats = input.graph.stats();
  const event: AssemblyEvent = {
    windowN: input.policy.recall.window,
    // Cumulative, because the pairs are no longer all scored here: upkeep scores each new session segment as
    // it arrives, so a per-call number would report only this step's own segment and hide every pair the
    // window actually cost. The graph is the single place that knows the running total.
    scoredPairs: graphStats.scoredPairs,
    // And of those, the ones the backend actually answered. Read together, `scoredPairs - judgedPairs` is the
    // number of pairs the window paid for and did not get, which is the only way a silent slide into lexical
    // scoring shows up in a record that otherwise looks healthy.
    judgedPairs: graphStats.judgedPairs,
    // And the pairs the window did *not* offer, because the backend was saturated and the scorer held them back
    // (`S1_DEFERRED`). A third number rather than a bigger denominator: `scoredPairs` counts what was put to a
    // scorer, `deferredPairs` counts what was not, and adding the second to the first would report a coverage
    // ratio over work the run declined to do. A record that carries only the first two cannot tell "the backend
    // answered a third of what it was asked" from "the run stopped asking", and round `20261002-2037` is exactly
    // that ambiguity: 4 152 judged of 860 672 offered, with 3 859 refusals in between and nothing on the record
    // saying how much of the remainder was ever attempted.
    deferredPairs: graphStats.deferredPairs,
    type: 'assembly',
    schema: TELEMETRY_SCHEMA_VERSION,
    ts: input.now,
    sessionId: input.sessionId,
    seq: input.seq,
    candidates: result.recall.candidates,
    selected: result.recall.selected,
    bfsDepth: result.recall.bfsDepth,
    budgetUsed: result.budget.used,
    budgetTotal: result.budget.total,
    blocks: result.budget.byBlock,
    prefixTokensStable: result.cacheStability.prefixTokensStable,
    layoutOrder: result.layout.order,
    // The paper's axis, recorded as the arm it selected rather than as a mechanism name: a reader of a round can
    // tell Trace as State from Trace Append without holding the enum in their head, and the two values are the
    // project's names for the paper's two conditions (`packages/core/src/types.ts`).
    //
    // **No `questionPlacement` beside it any more (deleted 2026-10-05).** The question is the last block of
    // `layoutOrder` in every assembly this build produces, so a field that recorded where it sits would record one
    // value forever; and the axis it named could produce `[T, q, x]`, a layout the paper does not have. Rounds
    // recorded before that date still carry it, and the reader of such a round has `layoutOrder` beside it, which
    // says the same thing in the layout's own words.
    tracePlacement: input.policy.tracePlacement,
    layoutStableTokens: result.cacheStability.layoutStableTokens,
    cutAfterBlock: result.cacheStability.cutAfterBlock,
    tokensAfterCut: result.cacheStability.tokensAfterCut,
    // The structure this step's recall produced, straight from the assembler: the tree the walk actually made,
    // ids only. Unconditional, unlike `fallback` below, because `{}` is a reading - recall found nothing - and
    // not the absence of one.
    recallTree: result.recallTree,
    ...(result.fallback !== undefined ? { fallback: result.fallback } : {}),
    // The fail-open admission count, copied verbatim from the assembler and omitted when it is zero for the same
    // reason `fallback` is: no admission is the ordinary case, and `{}` vs absent is the convention this record
    // already uses for `recallTree`. It was computed and dropped on the floor for a whole round - see
    // `AssemblyEvent.unknownAdmitted`, which is where the consequence is written down.
    ...(result.unknownAdmitted !== undefined ? { unknownAdmitted: result.unknownAdmitted } : {}),
    // Unconditional, unlike the two above: a dropped session event is content loss, so "0 dropped" has to be a
    // reading a later round can make rather than an absent field it has to interpret. Undefined means the caller
    // did not supply the counter at all (a local or test caller), which is a third state and stays absent.
    ...(input.upkeepDropped !== undefined ? { upkeepDropped: input.upkeepDropped } : {}),
  };

  return {
    kind: 'assembled',
    event,
    layout: result.layout,
    segments,
    selectedIds: result.layout.recalled.map((s) => s.id),
    fullTokens,
    selectedTokens,
    wouldSaveTokens: Math.max(0, fullTokens - selectedTokens),
    report,
    observeMs: 0,
  };
}

function lastIndexWhere<T>(items: readonly T[], predicate: (item: T) => boolean): number {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i];
    if (item !== undefined && predicate(item)) return i;
  }
  return -1;
}
