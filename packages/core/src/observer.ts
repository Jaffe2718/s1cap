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
): Promise<StepObservation | EmptyStepObservation> {
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

  const pinned = segments.filter((s) => s.kind === 'systemPinned');
  // The rendered system prompt is pinned, never a recall candidate: it has to stay byte-stable at the front
  // of the prompt (that is what the prefix cache hits on) and relevance may not drop it.
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
  const anchor = lastIndexWhere(segments, (s) => s.kind === 'user');
  // Where the model view is taken from.
  //
  // This used to say: the payload's segments when it has any, the graph's append order otherwise, because the
  // graph is a superset and "using it never loses a segment the payload carried". The conclusion was right and
  // the direction was backwards, and the cost has now been measured. The graph IS a superset — which means
  // using the *payload* is the lossy choice, not the graph. At a turn-opening step the payload holds exactly one
  // new user message, so the pool is that message, `history` is empty, and there is nothing for relevance to
  // select: a live C4 run delivered the state proxy on 4 steps, every one of them with `blocks.recalled = 0`,
  // while the five steps that did have history (836 to 5243 tokens of it) were the steps the harness claims
  // nothing for — and an empty `decision.messages` means no request is made at all. Recall and delivery fired on
  // disjoint steps.
  //
  // The graph's ordered segments are the session's own append order, so they include everything the payload
  // carried and everything before it. That is the window a model call needs.
  const window: Segment[] = input.graph.orderedSegments();
  const windowAnchor = anchor >= 0 ? anchor : lastIndexWhere(window, (s) => s.kind === 'user');
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
