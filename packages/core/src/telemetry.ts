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

/**
 * One LLM call, priced.
 *
 * THERE IS NO `flags` FIELD HERE, AND THERE IS NO `planGate` ANYWHERE (2026-10-02, revised after the audit).
 *
 * This interface carried `flags: { tas, sel, planGate, degraded }` as a **required** field. Nothing in
 * `packages/*&#47;src` ever assigned it, no round's artifacts carry it, and one of the four names described a
 * component the policy no longer has: a required field that is never populated is a lie in the type, and the
 * build is pure type erasure (`scripts/build-packages.mjs` strips types; `typescript` is not installed), so
 * nothing would ever have reported it. `packages/dsh-plugin/test/observer.test.ts` records the same lesson for a
 * runtime property that did not exist on its declared type.
 *
 * The audit names this field as `S1CallEvent.flags` (`s1cap-audit-lane.md`, F13); it is `LlmCallEvent`'s, and
 * `S1CallEvent` has never had one. The substance is stronger than the finding says: nothing emits an `llm_call`
 * record at all — round `20261002-2037`'s control planes hold only `assembly`, `context_delivery` and `s1_call` —
 * so the bucket had no producer anywhere, and `core.test.ts` now pins its absence because the type checker that
 * would otherwise notice cannot run.
 *
 * The field was described to the reader as "which interventions were active for this call". Two of the three
 * survivors could not answer that either: `tas` is true whenever TAS assembled a layout, whether or not the
 * layout was delivered, and `deliver` is the switch that decides whether the model saw it (see the C1 finding in
 * `s1cap-audit-lane.md`). A flag that is set from the policy rather than from the delivery would repeat exactly
 * the defect it was meant to record.
 *
 * What replaces it, if this type is ever emitted: derive the flags from the *outcome* the lane already records -
 * `assembly.layoutOrder` contains the state proxy, `context_delivery.delivered` says whether it reached the model,
 * and `s1_call.judgedPairs` covers selection - so a reader can check them against a record instead of trusting a
 * policy read. Nothing emits an `llm_call` record today; the cells' own token account is read from
 * `assistant/message.usage` by `scripts/cell-report.mjs`, which is why this removal changes no artifact.
 */
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
  /**
   * Pair comparisons spent scoring the session's segments, **cumulative for the session, as of this assembly** -
   * not a per-step figure, and not to be summed over a run's records.
   *
   * The comment here used to read "spent scoring the segments that arrived since the previous step", which is
   * what a per-call number would be and is not what is written: upkeep scores each new session segment as it
   * arrives, so a per-call figure would report only this step's own segment and hide every pair the window
   * actually cost. The graph is the only place that knows the running total, and `observer.ts` copies it
   * verbatim. Measured on round `20261002-2037`: the last assembly carries `856 576` and the snapshot `860 672`
   * (the difference is scoring after the last step), while the sum over the 277 records is `84 874 308` - a
   * number a reader gets by adding up a cumulative field, which is what the old comment invited.
   */
  scoredPairs?: number;
  /**
   * Of those pairs, the ones the System-1 backend actually answered. **Cumulative for the session, as of this
   * assembly**, like `scoredPairs` above and for the same reason.
   *
   * The difference is what the window paid for and did not receive - a timed-out batch, a backend that was down,
   * a batch the question cap dropped. Recorded because `scoredPairs` alone was read as coverage and reported
   * 18528 while 1796 pairs had been judged.
   */
  judgedPairs?: number;
  /**
   * Pairs the run declined to offer at all, because the System-1 backend was saturated and the scorer held the
   * window back for a later tick (`S1_DEFERRED`). **Cumulative for the session, as of this assembly**, like
   * `scoredPairs` above.
   *
   * A third number rather than part of `scoredPairs`, and the distinction is the point: `scoredPairs` is what was
   * put to a scorer, so folding deferred pairs into it would report coverage over work that never happened, while
   * leaving them out entirely would hide work the run chose not to do. `judgedPairs / scoredPairs` stays the
   * share of what *was* offered that the backend answered; this field and `scoredPairs` together are the window
   * the session's arrival order would have offered.
   */
  deferredPairs?: number;
  /**
   * Session events dropped at ingestion because the upkeep queue was full (`upkeep-queue.ts` `capacity`).
   *
   * **Cumulative for the session, as of this assembly**, like the three pair counters above.
   *
   * A dropped event is content loss and not a backpressure statistic: the segment it carried never enters the
   * graph, so every recall measurement that follows is over a session with a hole in it - and the only record of
   * that was a counter on `/s1` (`upkeep.dropped`), which a round does not persist. The queue's own header
   * promised the drop would be "counted"; counted is not the same as *readable after the round*, and this field
   * is the difference. Written on every assembly (0 included) so "nothing was dropped" is a reading rather than
   * an absent field, and so that a reader comparing two steps can see the moment the hole appeared.
   */
  upkeepDropped?: number;
  seq: number;
  candidates: number;
  selected: number;
  bfsDepth: number;
  /**
   * The size of the view this assembly built, in tokens: every block, the recalled one included. Copied from
   * `AssemblyResult.budget.used` (`packages/core/src/types.ts`, which states the meaning in full).
   *
   * It was, until 2026-10-05, bounded above by `budgetTotal` because a `recall.budgetRatio` cap dropped candidates
   * that did not fit the allowance. That cap is gone — selection is decided by `r` and `d` — so **`budgetUsed` may
   * exceed `budgetTotal`**, and a reader who finds that is reading a step that spent more than the window budget,
   * not a broken record. What responds to it is the harness's compaction, which sees the injected block as an
   * ordinary surface node.
   */
  budgetUsed: number;
  /** what the step's window leaves after the output reserve and the fixed overhead: a measurement, not a ceiling */
  budgetTotal: number;
  blocks: Record<string, number>;
  prefixTokensStable: number;
  /**
   * The block order this assembly was built in, e.g. `['pinned','stateProxy','recalled','tail','anchor']`.
   *
   * Recorded because the layout is an experimental condition: two cells can differ only in where the trace sits
   * relative to the long context, and a reader of the control plane has to be able to tell which one produced a
   * record without inferring it from configuration that may have changed since.
   */
  layoutOrder?: string[];
  /**
   * `policy.tracePlacement` as applied to this assembly: `'trace-as-state'` (`M([T, x, q])`, the paper's method) or
   * `'trace-append'` (`M([x, T, q])`, its control).
   *
   * Optional so that records written before 2026-10-05 stay readable — they carry `layoutOrder`, which says the
   * same thing in the layout's own words.
   */
  tracePlacement?: string;
  /** tokens at the front that stay byte-identical across steps of one task under this layout */
  layoutStableTokens?: number;
  /** the first block after the stable head: where a re-selection would cut the prefix */
  cutAfterBlock?: string;
  /** tokens behind that cut, i.e. the cost of one re-prefill */
  tokensAfterCut?: number;
  /**
   * `'recency-window'` when the count/share floors discarded the walk's own selection and the block was refilled
   * from chronological history.
   *
   * **Absent means "the recency fallback did not fire", and the two are not the same reading.** Presence and
   * absence are the only two states: the field is omitted (`observer.ts`, beside `recallTree`) rather than
   * written as `null`, so a tool that collapses absence into `null` reports "277 of 277 recorded `null`", which
   * is what round `20261002-2037`'s `recall.mjs:56` did (`r.a.fallback ?? null`) and what its report then read as
   * a configured-but-silent knob. The fallback could not fire in that run for a second reason worth recording
   * beside it: `selected` was >= 1 on all 277 steps (`recall-C2.json`: min 1, max 24), so the count floor
   * `minRecalledSegments: 1` was satisfied on every one of them - by a walk that was rooted on the wrong segment
   * 273 times. A floor expressed as "did selection return anything" cannot catch a *mis-rooted* selector.
   */
  fallback?: string;
  /**
   * Segments admitted because their pair with the anchor was inside `w` and the backend had not judged it (the
   * fail-open rule in `assemble()`).
   *
   * Recorded because the docs require a run to carry it (`docs/CELLS-RUN.md`: "a run that lowers `w` must carry
   * `fallback`, `unknownAdmitted` and `recallTree` beside it"; `docs/FORMULAS.md` the same) and because it was
   * *computed and thrown away*: `assemble()` has returned it since the fail-open branch was written, the
   * assembler test asserts it, and of the 277 `assembly` records of round `20261002-2037` **zero** carried the
   * key. Its consequence was invisible exactly where it was load-bearing: assembly #1 of that round has
   * `candidates: 0`, `selected: 1`, no `fallback`, and its one delivered block is 372 tokens - with no candidates
   * and no fallback, the fail-open branch is the only mechanism that can fill `recalled`, so the run's first
   * delivery was unjudged pairs admitted by the fail-open rule and no artifact said so.
   *
   * **Cumulative and per-assembly are different questions here, and this number is per-assembly**: it counts the
   * segments *this* assembly admitted, not a session total (contrast `scoredPairs`/`judgedPairs`/`deferredPairs`
   * above, which are cumulative for the session). Absent means the step admitted none, which is the ordinary
   * case; a present `0` never occurs, and the field is omitted rather than zeroed for the same reason
   * `fallback` is.
   */
  unknownAdmitted?: number;
  /**
   * The graph structure this step's recall produced, copied from the assembler's result.
   *
   * A nested tree: the anchor segment id at the root, each hit under the id recall reached it from, leaves `{}`.
   * **Keys are segment ids only** - no weights, kinds, depths or counts - and every hit recall returned is in it,
   * including the ones the passage de-duplication dropped, because the tree records the walk the selector made
   * rather than what survived it. Written on every assembly record: `{}` is the answer for a walk that produced
   * nothing, and an absent field would read as "this step was not measured" instead.
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
  /**
   * Whether the assembler ran for this step, and whether the step was read into the graph anyway.
   *
   * Both exist because a refusal on its own is ambiguous, and the ambiguity is the one this pair removes:
   * `delivered: false, reason: "the decision carried no messages"` is produced identically by three different
   * states - the step was read and the assembly was deliberately not paid for (`assembled: false,
   * ingested: true`, the documented `ingestOnly` path), the observer was missing or `observe()` threw
   * (`assembled: false, ingested: false`), and the assembly ran and the delivery module declined for a reason of
   * its own (`assembled: true`, with the block list). The counters that separate them (`ingestOnly`, `errors`)
   * live only on the `/s1` route, which a round does not persist - so without these two fields the control plane
   * cannot tell "the lane declined this on purpose" from "the lane was never there", and a defect in the
   * observation path reads exactly like the lane working as designed.
   *
   * They are written on the refusal paths in `index.ts`, on the strength of the observation's own kind rather
   * than of the decision, and they are optional only so records written before them stay readable.
   */
  assembled?: boolean;
  ingested?: boolean;
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
