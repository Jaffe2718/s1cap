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
import type { AssemblyLayout, AssemblyPolicy, Segment } from './types.ts';
import { AssociationGraph } from './assoc-graph.ts';
import { segmentEvent, estimateTokens, isS1capInjected } from './segmenter.ts';
import { assemble, totalTokens } from './assembler.ts';
import { adaptMessages } from './harness-adapter.ts';
import type { AdapterReport } from './harness-adapter.ts';
import { TELEMETRY_SCHEMA_VERSION } from './telemetry.ts';
import { buildStateProxy } from './state-proxy.ts';
import type { AssemblyEvent } from './telemetry.ts';

export interface ObserveStepInput {
  sessionId: string;
  /** harness step number (1-based); recorded for correlation only */
  step: number;
  /** session-log sequence of the first message in `messages` */
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
   * Called when the payload's own anchor position and the graph window's disagree, with both and with the ids
   * they name.
   *
   * The two are positions in different arrays - the payload's segment list and the graph's append order - so a
   * disagreement is expected rather than exceptional, and this is not a warning: it is the evidence that the two
   * spaces are distinct. It exists because the defect it documents was invisible: a live round rooted 273 of 277
   * walks on a turn-1 segment and every counter in the record stayed healthy. Optional, and never awaited or
   * caught: a diagnostic that cannot be recorded must not be able to cost the step.
   */
  onAnchorMismatch?: (detail: { payloadAnchor: number; windowAnchor: number; payloadId: string; windowId: string }) => void;
  /**
   * Default true. Pass false for a step that cannot receive context.
   *
   * The expensive half of a step - the BFS walk in `assemble()`, the anchor wait, T's rebuild and the token
   * accounting - buys nothing on a step whose harness decision carries no messages: there is no request to put a
   * block in, and `context-delivery.ts` refuses to insert into a list that is not there. That refusal is correct
   * and stays. What was wrong was *paying* for it: a measured diagnostic round assembled 1,205,029 recalled
   * tokens across 277 steps and delivered 1,597 of them, because 275 of those decisions carried no messages and
   * the assembly had already run by the time anyone looked.
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
  // nothing for — and an empty `decision.messages` means no request is made at all. Recall and delivery fired on
  // disjoint steps.
  //
  // The graph's ordered segments are the session's own append order, so they include everything the payload
  // carried and everything before it. That is the window a model call needs.
  //
  // The anchor is the newest `user` segment *in that window*, and finding it is where a whole run's recall
  // silently pointed at the wrong turn. The line above computes a position inside the payload's segment list;
  // this one used to apply it to the graph's array (`window[anchor]`). The two index spaces coincide only when
  // the graph's order begins where the payload's does, which is the rare case: the payload holds the current
  // question *after* the payload's own first segment, so a payload whose last user turn sits at index 2 indexed
  // the graph's third-oldest segment. Measured over the same diagnostic round: 273 of 277 invocations rooted the
  // walk on `34b2115f-…-#3`, the tail chunk of turn 1's AGENTS.md block, and the task's own three chunks were
  // re-offered as candidates 190, 189 and 188 times. The tree was a faithful account of a walk from the wrong
  // question, and no counting of its nodes could have shown that.
  //
  // Resolved in the graph, and not by looking the payload's own last user segment up in the graph, because the
  // payload is the lossy list (the comment above): a step whose payload carries only an older message would then
  // anchor on that older message, which is the same defect one turn smaller. The window is append-ordered and
  // holds everything the step carries, so its last `user` segment IS the newest question this step has; every
  // other block is written relative to it (`pool` below excludes it, `unjudgedWithin` looks back from it), and
  // assembling from any other segment would describe a prompt nobody is going to send.
  const window: Segment[] = input.graph.orderedSegments();
  const windowAnchor = lastIndexWhere(window, (s) => s.kind === 'user');
  // The payload's own anchor is still computed, and is now used for one thing only: a diagnostic when the two
  // disagree. Silence there would leave the next reader of this file to rediscover which space each index lives
  // in, which is what this fix cost.
  const anchor = lastIndexWhere(segments, (s) => s.kind === 'user');
  // The payload's own anchor is used for one thing only, now that the walk is rooted in the graph: a diagnostic
  // when the two disagree. Silence there would leave the next reader of this file to rediscover which space each
  // index lives in, which is what this fix cost.
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
  // Everything in the window except the anchor and the pinned prefix, in append order.
  //
  // This used to be "the segments before the anchor", which looked equivalent and was not: the anchor is the
  // last user segment, and the model's output for the current task - its messages, tool calls and tool results -
  // arrives *after* it in the append-only log. Slicing before the anchor therefore discarded exactly the newest
  // turns, and `tail` came out empty in every live record (blocks.tail = 0 across a whole run) while the k most
  // relevant verbatim turns were quietly not in the prompt at all.
  const pool = window.filter((s) => s.id !== current.id && s.kind !== 'systemPinned');
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
  // One-entry memo of the last built T. `perTask` is the default policy precisely so this can be a single slot:
  // within a task T does not change, and when the task changes the anchor id changes with it.
  const proxyCache = input.proxyCache ?? { id: '', text: '' };
  // `perTask` reuses the memo across the steps of one task; `perTurn` rebuilds every step, which is what that
  // policy means and is not free.
  const reuseProxy = input.policy.tas.updatePolicy === 'perTask' && proxyCache.id === current.id;
  const proxyText = reuseProxy
    ? proxyCache.text
    : buildStateProxy({
        segments: window,
        anchorId: current.id,
        maxChars: input.policy.tas.tMaxChars,
        updatePolicy: input.policy.tas.updatePolicy,
        now: input.now,
      });
  // Write the memo back only for `perTask`. A `perTurn` policy would find a matching id and reuse a proxy it was
  // supposed to rebuild, which is the one way a cache this cheap can be wrong rather than merely redundant.
  if (input.proxyCache !== undefined && input.policy.tas.updatePolicy === 'perTask' && !reuseProxy) {
    input.proxyCache.id = current.id;
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
    xFirst: input.policy.xFirst,
    layoutStableTokens: result.cacheStability.layoutStableTokens,
    cutAfterBlock: result.cacheStability.cutAfterBlock,
    tokensAfterCut: result.cacheStability.tokensAfterCut,
    // The structure this step's recall produced, straight from the assembler: the tree the walk actually made,
    // ids only. Unconditional, unlike `fallback` below, because `{}` is a reading - recall found nothing - and
    // not the absence of one.
    recallTree: result.recallTree,
    ...(result.fallback !== undefined ? { fallback: result.fallback } : {}),
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
