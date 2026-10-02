/**
 * Telemetry schema v1 (docs/AGENT_BRIEF.md §8).
 * Field names are frozen once the first benchmark run starts: add, never rename.
 */

export const TELEMETRY_SCHEMA_VERSION = 1 as const;

/** USD per 1M tokens. Verified 2026-09-28 (docs/AGENT_BRIEF.md §1.7). */
export interface TokenPrices {
  hit: number;
  miss: number;
  out: number;
}

export const PRICES = {
  'deepseek-flash-peak': { hit: 0.006, miss: 0.3, out: 1.2 },
  'deepseek-flash-offpeak': { hit: 0.003, miss: 0.15, out: 0.6 },
  'deepseek-v4-pro-peak': { hit: 0.044, miss: 1.32, out: 3.96 },
  'glm-5.3': { hit: 0.26, miss: 1.4, out: 4.4 },
  'glm-5.3-flash': { hit: 0.03, miss: 0.15, out: 0.5 },
} as const satisfies Record<string, TokenPrices>;

export type PriceKey = keyof typeof PRICES;

/** Jev: $0.042 per 1M input tokens, output free. */
export const S1_PRICE_PER_M_INPUT = 0.042;

export interface LlmCallEvent {
  type: 'llm_call';
  schema: typeof TELEMETRY_SCHEMA_VERSION;
  ts: number;
  sessionId: string;
  taskId?: string;
  cell: string;
  model: string;
  seq: number;
  promptTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
  outputTokens: number;
  reasoningTokens?: number;
  /** ms from request start to end (raw) */
  wallMs: number;
  /** ms spent waiting on human approval — excluded from netLatencyMs */
  approvalWaitMs: number;
  /** wallMs − approvalWaitMs (network RTT included unless a probe says otherwise) */
  netLatencyMs: number;
  s1Assist: { calls: number; tokens: number; ms: number };
  flags: { tas: boolean; sel: boolean; planGate: boolean; degraded: boolean };
}

export interface S1CallEvent {
  type: 's1_call';
  schema: typeof TELEMETRY_SCHEMA_VERSION;
  ts: number;
  provider: string;
  /** association scoring vs plan ranking — the two backend roles */
  role: 'assoc' | 'decide';
  kind: 'noul' | 'choice' | 'score';
  questions: number;
  inputTokens: number;
  outputTokens: number;
  ms: number;
  /** correlation metadata (ids only, never content) so cost joins to turns */
  turnId?: string;
  /** ids of the segments that were scored, for coverage analysis */
  scoredSegmentIds?: string[];
  /** checkpoint the backend actually routed to (e.g. Laya's `english` / `typed-decisions`) */
  routedModel?: string;
  /**
   * Where the call went. The configured `provider` name is not evidence of who answered: a stub
   * listening on the configured port answers under the name `laya-serve` just the same. Recording
   * the endpoint makes a run reproducible against an address rather than against a label.
   */
  endpoint?: string;
  /**
   * The checkpoint repository the server named in its own `routing` block, e.g.
   * `convaiinnovations/laya`. Reported only by a real Laya deployment, so its presence is what
   * separates "scored by the model we claim to score by" from "scored by something on that port".
   */
  repo?: string;
  /**
   * How many times this call was attempted, and how long it waited between attempts.
   *
   * Present because a judgement that had to be retried is weaker evidence than one that did not, and a record
   * that cannot say which it was turns a degraded backend into an invisible one. `attempts: 1, waitedMs: 0` is
   * the single-attempt case, and is what a record written before this field existed means.
   */
  attempts?: number;
  waitedMs?: number;
  /**
   * False when the call raised, in which case the scoring fell back to the lexical path. Absent on
   * records written before failures were recorded at all, so `ok !== false` keeps a success intact
   * while older logs stay readable.
   */
  ok?: boolean;
  /** Short error text on a failed call; content-free, so it is safe to log. */
  error?: string;
}

export interface ToolCallEvent {
  type: 'tool_call';
  schema: typeof TELEMETRY_SCHEMA_VERSION;
  ts: number;
  tool: string;
  ms: number;
  ok: boolean;
  approvalWaitMs: number;
}

export interface AssemblyEvent {
  type: 'assembly';
  schema: typeof TELEMETRY_SCHEMA_VERSION;
  ts: number;
  /** the harness session this observation belongs to (added 2026-09-28: without it, records from several sessions are indistinguishable) */
  sessionId?: string;
  /** recall.window = w in force for this assembly (the S1 scoring window) */
  windowN?: number;
  /** pair comparisons spent scoring the segments that arrived since the previous step: the S1 cost w bounds */
  scoredPairs?: number;
  /**
   * Of those pairs, the ones the System-1 backend actually answered. The difference is what the window paid for
   * and did not receive - a timed-out batch, a backend that was down, a batch the question cap dropped. Recorded
   * because `scoredPairs` alone was read as coverage and reported 18528 while 1796 pairs had been judged.
   */
  judgedPairs?: number;
  /**
   * Pairs the run declined to offer at all, because the System-1 backend was saturated and the scorer held the
   * window back for a later tick (`S1_DEFERRED`).
   *
   * A third number rather than part of `scoredPairs`, and the distinction is the point: `scoredPairs` is what was
   * put to a scorer, so folding deferred pairs into it would report coverage over work that never happened, while
   * leaving them out entirely would hide work the run chose not to do. `judgedPairs / scoredPairs` stays the
   * share of what *was* offered that the backend answered; this field and `scoredPairs` together are the window
   * the session's arrival order would have offered.
   */
  deferredPairs?: number;
  seq: number;
  candidates: number;
  selected: number;
  bfsDepth: number;
  budgetUsed: number;
  budgetTotal: number;
  blocks: Record<string, number>;
  prefixTokensStable: number;
  /**
   * The block order this assembly was built in, e.g. `['pinned','stateProxy','anchor','recalled','tail']`.
   *
   * Recorded because the layout is an experimental condition: two cells can differ only in where x sits, and a
   * reader of the control plane has to be able to tell which one produced a record without inferring it from
   * configuration that may have changed since.
   */
  layoutOrder?: string[];
  /** `policy.xFirst` as applied to this assembly */
  xFirst?: boolean;
  /** tokens at the front that stay byte-identical across steps of one task under this layout */
  layoutStableTokens?: number;
  /** the first block after the stable head: where a re-selection would cut the prefix */
  cutAfterBlock?: string;
  /** tokens behind that cut, i.e. the cost of one re-prefill */
  tokensAfterCut?: number;
  fallback?: string;
  /**
   * The graph structure this step's recall produced, copied from the assembler's result.
   *
   * A nested tree: the anchor segment id at the root, each hit under the id recall reached it from, leaves `{}`.
   * **Keys are segment ids only** - no weights, kinds, depths or counts - and every hit recall returned is in it,
   * including the ones the budget dropped, because the tree records the walk the selector made rather than what
   * survived it. Written on every assembly record: `{}` is the answer for a walk that produced nothing, and an
   * absent field would read as "this step was not measured" instead.
   *
   * Optional only so that records written before this field existed stay readable; `assemble()` always fills it.
   */
  recallTree?: Record<string, unknown>;
}

export interface PlanGateEvent {
  type: 'plan_gate';
  schema: typeof TELEMETRY_SCHEMA_VERSION;
  ts: number;
  plans: string[];
  probs: number[];
  confidence: number[];
  order: string[];
  abstained: boolean;
  executed: string[];
  verified: boolean;
  savedTokensEst: number;
}

export type TelemetryEvent =
  | LlmCallEvent
  | S1CallEvent
  | ToolCallEvent
  | AssemblyEvent
  | PlanGateEvent
  | ContextDeliveryEvent;

/**
 * What the model was actually shown, per step.
 *
 * This record exists because "assembled" and "delivered" are different states, and every counter in this project
 * used to report the first while the experiment needed the second: a layout that is computed, recorded with its
 * token counts, and never put in front of the model is a claim in a JSONL file. One record per `agent/pre-step`
 * says which of the two happened, and why not when it did not.
 */
export interface ContextDeliveryEvent {
  type: 'context_delivery';
  schema: typeof TELEMETRY_SCHEMA_VERSION;
  ts: number;
  sessionId?: string;
  /** the step this decision was for */
  step?: number;
  /** the cell, because whether delivery was even possible is a property of the cell */
  cell: string;
  /** true only when the returned decision carried a replacement message list */
  delivered: boolean;
  /** why, in words: a skip is a reported state, not a silent one */
  reason: string;
  /** messages the harness offered, and messages actually returned */
  messagesBefore: number;
  messagesAfter: number;
  /** harness messages passed through verbatim (pinned prefix, tail, and the current turn) */
  kept: number;
  /** harness messages the delivered list does not contain */
  dropped: number;
  /** how many messages were added; delivery is an insertion, so this is 0 or 1 */
  inserted: number;
  /** the blocks the injected message carried, in order: what the model was actually given */
  blocks: string[];
  /** digest of the injected payload, so a repeated delivery is recognisable across steps */
  payloadId: string;
  /** the block order the layout used for this step */
  order: string[];
}

/** Cost of one LLM call in USD. */
export function llmCallCost(e: LlmCallEvent, prices: TokenPrices): number {
  return (
    (e.cacheHitTokens * prices.hit + e.cacheMissTokens * prices.miss + e.outputTokens * prices.out) /
    1_000_000
  );
}

/** Cost of one System-1 call in USD (output is free on Jev). */
export function s1CallCost(inputTokens: number, pricePerMInput: number = S1_PRICE_PER_M_INPUT): number {
  return (inputTokens * pricePerMInput) / 1_000_000;
}

export interface TaskCostSummary {
  llmUsd: number;
  s1Usd: number;
  totalUsd: number;
  tokens: { hit: number; miss: number; out: number };
  cacheHitRate: number;
  llmCalls: number;
  s1Calls: number;
  toolMs: number;
  netLlmMs: number;
  s1Ms: number;
}

/** Aggregate every event of one task into the metrics the paper reports. */
export function summarizeTask(events: readonly TelemetryEvent[], prices: TokenPrices): TaskCostSummary {
  let llmUsd = 0;
  let s1Usd = 0;
  let hit = 0;
  let miss = 0;
  let out = 0;
  let llmCalls = 0;
  let s1Calls = 0;
  let toolMs = 0;
  let netLlmMs = 0;
  let s1Ms = 0;

  for (const e of events) {
    switch (e.type) {
      case 'llm_call':
        llmUsd += llmCallCost(e, prices);
        hit += e.cacheHitTokens;
        miss += e.cacheMissTokens;
        out += e.outputTokens;
        netLlmMs += e.netLatencyMs;
        llmCalls += 1;
        break;
      case 's1_call':
        s1Usd += s1CallCost(e.inputTokens);
        s1Ms += e.ms;
        s1Calls += 1;
        break;
      case 'tool_call':
        toolMs += e.ms;
        break;
      case 'assembly':
      case 'plan_gate':
        break;
    }
  }

  const promptTokens = hit + miss;
  return {
    llmUsd,
    s1Usd,
    totalUsd: llmUsd + s1Usd,
    tokens: { hit, miss, out },
    cacheHitRate: promptTokens > 0 ? hit / promptTokens : 0,
    llmCalls,
    s1Calls,
    toolMs,
    netLlmMs,
    s1Ms,
  };
}

/** Append-only JSONL sink; the caller owns the file handle. */
export class JsonlSink {
  #write: (line: string) => void;

  constructor(write: (line: string) => void) {
    this.#write = write;
  }

  emit(event: TelemetryEvent): void {
    this.#write(`${JSON.stringify(event)}\n`);
  }
}
