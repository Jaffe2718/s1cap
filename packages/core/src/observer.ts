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
import type { AssemblyPolicy, Segment } from './types.ts';
import { AssociationGraph } from './assoc-graph.ts';
import { segmentEvent, estimateTokens } from './segmenter.ts';
import { assemble, totalTokens } from './assembler.ts';
import { adaptMessages } from './harness-adapter.ts';
import type { AdapterReport } from './harness-adapter.ts';
import { TELEMETRY_SCHEMA_VERSION } from './telemetry.ts';
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
  const segments: Segment[] = events.flatMap((ev) => segmentEvent(ev));
  input.graph.addSegments(segments);
  // recall.window = w: only segments that arrived since the previous step are scored, each against
  // the most recent w segments. Segments outside the window keep their edges and stay reachable. The result is
  // not read here - the graph keeps the running total - but the scoring itself must still happen, or the
  // segments this step added would stay unconnected to the window.
  await input.graph.scoreNew({
    windowN: input.policy.recall.window,
    threshold: input.policy.recall.relevanceThreshold,
    ...(input.scoreBatch !== undefined ? { scoreBatch: input.scoreBatch } : {}),
  });

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
  // Where the model view is taken from. The step payload usually carries nothing (see adaptSessionEvent for the
  // measurement), and the session-event stream that upkeep folds into the graph is what actually holds the
  // conversation. So the window is this payload's segments when it has any, and the graph's own append order
  // otherwise. Both are the same thing in the steady state: the payload's segments are added to this same graph
  // immediately above, so the graph is a superset and using it never loses a segment the payload carried.
  const window: Segment[] = segments.length > 0 ? segments : input.graph.orderedSegments();
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
  const before = (windowAnchor >= 0 ? window.slice(0, windowAnchor) : window.slice(0, -1)).filter(
    (s) => s.kind !== 'systemPinned',
  );
  const tailCount = Math.max(0, Math.min(input.policy.tail.k, before.length));
  const tail = tailCount > 0 ? before.slice(before.length - tailCount) : [];
  const history = before.slice(0, before.length - tailCount);

  const result = assemble({
    graph: input.graph,
    policy: input.policy,
    pinned,
    tail,
    current,
    // The serialized state proxy T is not built yet (M1's remaining sub-step), so the TAS block is
    // accounted as empty. Documented so the budget numbers are read correctly, not over-trusted.
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
    ...(result.fallback !== undefined ? { fallback: result.fallback } : {}),
  };

  return {
    kind: 'assembled',
    event,
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
