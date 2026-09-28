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

export interface StepObservation {
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

export function observeStep(input: ObserveStepInput): StepObservation {
  const { events, report } = adaptMessages(input.messages, {
    sessionId: input.sessionId,
    startSeq: input.seq,
    now: input.now,
    ...(input.reasoningPartTypes !== undefined ? { reasoningPartTypes: input.reasoningPartTypes } : {}),
  });

  // segmentEvent applies the I2 gate (provenance.ts): a control-plane record can never become a segment.
  const segments: Segment[] = events.flatMap((ev) => segmentEvent(ev));
  input.graph.addSegments(segments);

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
  const current = anchor >= 0 ? segments[anchor] : segments[segments.length - 1]!;
  const before = (anchor >= 0 ? segments.slice(0, anchor) : segments.slice(0, -1)).filter(
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

  const fullTokens = totalTokens(segments);
  const selectedTokens = result.budget.used;
  const event: AssemblyEvent = {
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
    ...(result.fallback !== undefined ? { fallback: result.fallback } : {}),
  };

  return {
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
