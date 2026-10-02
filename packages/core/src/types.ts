/**
 * S1CAP core types — the contract shared by every package.
 * Mirrors docs/AGENT_BRIEF.md §4. Field names are versioned contracts:
 * add fields, never rename (see docs/AGENT_BRIEF.md §0 rule 5).
 */

export const CORE_SCHEMA_VERSION = 1 as const;

export type SegmentKind =
  | 'user'
  | 'assistant'
  | 'trace'
  | 'toolCall'
  | 'toolResult'
  | 'systemPinned';

export interface Segment {
  id: string;
  sessionId: string;
  /** position in the append-only session log */
  seq: number;
  kind: SegmentKind;
  role?: string;
  /** token estimate (harness tokenMeter value in production, heuristic otherwise) */
  tokens: number;
  text: string;
  ts: number;
  taskTag?: string;
  /** set when this segment is a chunk of a larger original segment */
  chunkOf?: string;
}

/**
 * Where an edge's weight came from. `lexical` is a first-class value, not an absence: the
 * association graph keeps working when no System-1 backend answers, and an edge it produced by
 * itself must never be indistinguishable from one a model scored. Before this distinction existed
 * the window scorer wrote the literal `'s1'` for every edge it made, including the ones produced
 * by the lexical fallback - which made `/s1 why` claim System-1 provenance for scores no System-1
 * had ever seen, and made the paper's central comparison unmeasurable.
 */
export type EdgeSource = 'meta' | 'embed' | 's1-noul' | 's1-score' | 'lexical';

export interface AssociationEdge {
  from: string;
  to: string;
  /** tier-2 verified weight in [0,1] */
  w: number;
  /** pre-verification candidate weight */
  wTier1: number;
  source: EdgeSource;
  verifiedAt: number;
  /** question id + answer, for `/s1 why <seq>` provenance */
  provenance: string;
}

export type Cell = 'C0' | 'C1' | 'C2';

export type S1ProviderName = 'jev' | 'laya-serve' | 'edgejev' | 'kev' | 'none';

export interface AssemblyPolicy {
  cell: Cell;
  /**
   * Who owns the agent loop. Deliberately a literal type, not a boolean: the harness
   * stops when the model stops, and no S1CAP output may prolong or veto that exit
   * (docs/ARCHITECTURE.md §4). One user turn is many LLM steps; S1CAP only assembles
   * the context before each call and orders the plans the model already offered.
   */
  termination: 'model-owned';
  /** hard deadline for the synchronous per-call assembly hook; on expiry the call passes through unmodified */
  assemblyDeadlineMs: number;
  /**
   * Association-graph upkeep is asynchronous: new session events are scored off the
   * critical path by the S1 association backend and merged into the graph afterwards,
   * so the graph may lag the session by up to `maxLagTurns` turns.
   */
  rgMaintenance: { mode: 'async'; maxLagTurns: number };
  /**
   * A selected context keeps hitting the prefix cache only while the *selection* is stable:
   * a prompt that changes in the middle loses the discount on everything after the change.
   * Docs: docs/FORMULAS.md §6, `packages/core/src/cache-policy.ts`.
   */
  cache: {
    /** perTask freezes the selection inside a task (cache-aligned, default); threshold gates re-selection on the break-even test */
    reselectPolicy: 'perTask' | 'perTurn' | 'threshold';
    /** prefix-cache block size in tokens: DeepSeek 64, OpenAI 128, Anthropic counts in 1024-token checkpoints */
    blockTokens: number;
  };
  tas: {
    on: boolean;
    /** max chars of the serialized state proxy T */
    tMaxChars: number;
    /** perTask keeps T byte-stable within a task (cache-friendly) */
    updatePolicy: 'perTask' | 'perTurn';
  };
  recall: {
    /** relevance threshold τ */
      /** relevance threshold (recall.threshold, 0..1) */
      threshold: number;
      /**
       * S1 scoring window w (recall.window): a new segment is scored only against the most recent w
       * segments. It exists purely to save System-1 calls - BFS recall (depth d, threshold r) is
       * unaffected, and segments outside the window stay in the graph as nodes and remain reachable.
       */
      window: number;
      /**
       * Bounded wait, in milliseconds, for the anchor segment's own row to be *judged by the backend* before
       * assembly.
       *
       * Default 10 000 (10 s), and `0` disables it entirely.
       *
       * Why it exists: scoring runs asynchronously in the upkeep queue, off the step's critical path, and a
       * measured System-1 relevance call now takes a median of 15.3 s (mean 14.0, p90 25.0, max 29.0) against the
       * local backend. A step can therefore assemble before the segment it recalls from — the anchor, the newest
       * `user` segment — has any scored edges, and BFS recall then returns nothing at all. This is the cheaper
       * first remedy: it waits only for the anchor's row, only until the deadline, and never throws. The fail-open
       * rule in `assemble()` (`AssociationGraph.unjudgedWithin`, counted as `unknownAdmitted`) is the backstop and
       * stays: this wait makes it rarer, it does not replace it.
       *
       * "Judged" rather than "scored", because the wait has to outlast a *failed* call rather than a slow one: a
       * lexical row written after a backend error is not a row there is nothing left to wait for, and stopping on
       * it is what would let the fail-open rule stay silent through a round of backend failures.
       */
      anchorWaitMs: number;
    /** bounded BFS depth d */
    depth: number;
    /** per-node expansion fanout k */
    fanout: number;
    tier1: 'embed' | 's1' | 'off';
    embedModel?: string;
    /** share of the token budget available to recalled blocks (ρ) */
    budgetRatio: number;
    /**
     * Fall back to a recency window when relevance fills less than this share of the budget (μ). **Off (0) by
     * default, and that is a correction rather than a preference.**
     *
     * The method's claim is that a small number of relevant turns beats a full recency window — that is, a good
     * selector uses *less* of the budget, not more. A floor at a quarter of the budget therefore rejects exactly
     * the behaviour that justifies the method, silently, before delivery ever sees the selection. Measured: with
     * μ = 0.25 the floor fired on **9 of 9** steps of a live C2 session, so every System-1 selection was replaced
     * by recency and `scoredPairs` described a ranking nothing downstream consumed.
     *
     * Kept, because an experiment may want it and because deleting a knob that was measured is how the
     * measurement gets lost. Setting it is opting back in to a heuristic that will discard confident selections.
     */
    minRecalledShare: number;
    /**
     * Fall back to a recency window when relevance selected fewer than this many segments.
     *
     * This is the guard that actually protects the model: a selector that returned nothing — a dead backend, a
     * threshold nothing clears, a scorer that throws on every pair — would otherwise deliver a context holding
     * nothing but the task, while the record said a block had been assembled. One segment is the minimum that is
     * still a selection; the token-share floor is not, because thin and confident is the expected case.
     */
    minRecalledSegments: number;
  };
  tail: { k: number };
  /**
   * Where the current task x sits relative to recalled history.
   *
   * `false` is the layout in docs/FORMULAS.md §3.4: `[P | T | recalled | tail | x]`, the task last and history
   * immediately before it. `true` puts the task first, `[P | T | x | recalled | tail]`, which is the
   * "trace as state" arrangement - give the model the state it is reasoning over, then the evidence for it.
   * The distinction is the whole of §2 in the paper: state-then-information, not information-then-state.
   *
   * The cost is cache. With x last, everything above it is history and only changes when the history does; with
   * x first, the prefix up to x stays stable and everything after it is the part that moves, so the saving is
   * smaller but the model's first read is the task rather than whatever was said last.
   */
  xFirst: boolean;
  /**
   * Does the assembled view actually reach the model?
   *
   * `false` is the honest default and the only safe one: with it off, `agent/pre-step` returns the harness's own
   * decision untouched and the layout is recorded but not delivered. That was the state of this project until
   * `context-delivery.ts` existed, and it is why the ablation cells had nothing to ablate — every cell produced a
   * layout record and the model saw the full history in all of them.
   *
   * The baseline cell C0 keeps this off, which is what makes it a baseline: it is the only cell that lets the
   * harness manage history natively. C1 and C2 turn it on, because "TAS alone" and the full configuration are
   * claims about what the model is shown, and a delivered-nothing cell cannot support them.
   */
  deliver: boolean;
  /*
   * THERE IS NO `planGate` FIELD HERE, AND THAT IS A MEASURED DECISION (2026-10-02).
   *
   * The full-configuration cell carried `planGate: { on: true, ... }` and the wiring record stated
   * `planGate: true`, so the arm looked like it ran a plan-ordering step. It never did. Round `20261002-2037`
   * contains **zero** `plan_gate` records in any artifact of the round - not the cell's control plane, not its
   * tape, not the session stream - across 277 steps and 289 tool calls, because the gate's only two inputs are
   * things the model never produced: a numbered or bulleted plan in an assistant message, and a `todo/write`
   * session event. That round emitted neither (`extractPlans` reads nothing from the model's prose; the session
   * event stream carries no `todo/write` at all), so `plan-gate-runtime.ts` never reached the branch that emits
   * its record. A knob that is on in the wiring and structurally inert is worse than no knob: it makes the full
   * configuration look like it does something it does not, in the one cell whose whole purpose is to be the
   * full configuration.
   *
   * So the *policy field* is gone: the cell presets, the config schema, the status route and the report no
   * longer offer or describe a plan gate. What stays is the mechanism itself - `packages/core/src/plan-gate.ts`
   * (`orderPlans`, `normalizeProbs`, `AttemptController`), `packages/dsh-plugin/src/plan-gate-runtime.ts` and
   * the `plan_gate` telemetry record - because it is a documented part of the design with its own tests, and
   * because deleting it would delete the measurement of what the gate does when it is fed. Nothing calls it:
   * the role it was supposed to play in C2 was never played by it, and nothing takes over - the honest reading
   * of the run is that the ordering half of "full configuration" was TAS alone, exactly as in C1, and any future
   * arm that wants a plan gate has to feed it a plan source the model actually writes to.
   */
  s1: {
    provider: S1ProviderName;
    /** "" = use the provider default (or the Laya runtime's host/port) */
    baseUrl?: string;
    /** "" = use the provider default (or the Laya checkpoint name) */
    model?: string;
    /** "" = read the provider's environment variable (TYPESAFE_API_KEY / S1CAP_API_KEY); never logged */
    apiKey?: string;
    /**
     * There is deliberately no request deadline here. It was `timeoutMs`, and as a policy field it silently
     * decided which scorer judged a pair: a timeout costs the batch its System-1 answer and hands it to the
     * lexical fallback. The deadline now lives in the client as `S1_TRANSPORT_TIMEOUT_MS`, where the concern
     * actually belongs - a request that never returns - and where nobody can tune it into a quality switch.
     */
    /** questions per /v1/systemone call (context-rot guard) */
    questionsPerCall: number;
    /**
     * How many times one System-1 call may be *attempted* when the backend refuses it. 1 is a single attempt,
     * which is what this was before the option existed: a retry is a deliberate, recorded choice, not a default.
     *
     * The refusal this exists for is Laya's admission control, which answers `503 server busy` with
     * `Retry-After: 1` the moment its semaphore is full and never queues (docs/LAYA_RUNTIME.md §6b). Measured
     * 2026-10-01: four concurrent cells lost 39% of 1880 calls to it while their *average* load was about a third
     * of what the server sustains, so the losses were a burst artifact, not a capacity shortage — and a
     * one-second retry is what turns them back into judgements. Only a refusal is retried, never a timeout:
     * a refusal costs nothing to repeat, a 30 s timeout costs 30 s.
     *
     * Every attempt is recorded (`attempts`, `waitedMs` on the `s1_call` record), because a judgement that had to
     * be retried is not the same evidence as one that did not.
     */
    retryAttempts: number;
    /**
     * How many System-1 requests this cell may have **in flight at once** — the backend's own admission limit.
     *
     * A property of the backend, not a tuning preference, which is why it is a policy field: the local
     * `laya-serve` this project runs admits 16 concurrent requests and answers `503 server busy` with
     * `Retry-After: 1` to everything beyond that, rather than queueing (docs/LAYA_RUNTIME.md §6b). A cell that is
     * *at* the limit is a cell whose next request is the one that gets refused, so the default sits below it.
     *
     * It exists because the upkeep queue drains up to `maxPerFlush` events per tick **without awaiting the async
     * handler between them** (`packages/core/src/upkeep-queue.ts`), so N queued segments mean N scoring loops in
     * flight, each issuing its own batches. Serialising inside one segment bounds nothing across segments, and
     * round `20261002-2037` is what that costs: 5 992 requests at 2.70 requests/s over 2 219.7 s, of which
     * 3 859 (64.4 %) were refused, with the refusal rate above a third in every thirty-second bucket of the run
     * and no sign of recovery. One cell saturated the backend by itself and kept asking for 37 minutes.
     *
     * A request that cannot be admitted is not retried, not queued and **not scored lexically**: the window is
     * deferred to a later tick (`S1_DEFERRED` in `packages/core/src/assoc-graph.ts`) and the pairs are counted in
     * the graph's `deferredPairs`, which the assembly record prints beside `judgedPairs / scoredPairs`. Coverage
     * therefore stays the honest ratio of what was offered, and what was skipped is a number with a reason.
     */
    admissionLimit: number;
  };
}

/** The blocks of one model-view context, in the order they were laid out. */
export interface AssemblyLayout {
  pinned: Segment[];
  /** serialized state proxy; undefined when TAS is off */
  stateProxy?: string;
  recalled: Segment[];
  tail: Segment[];
  /** current user input x — placed by `xFirst`, not always last */
  anchor: Segment;
  /**
   * The actual block order this result was built in, so the layout is observable rather than implied by the
   * order of the fields above. `['pinned', 'stateProxy', 'anchor', 'recalled', 'tail']` with xFirst, and
   * `['pinned', 'stateProxy', 'recalled', 'tail', 'anchor']` without it.
   */
  order: string[];
}

export interface AssemblyResult {
  layout: AssemblyLayout;
  budget: {
    total: number;
    used: number;
    byBlock: Record<string, number>;
  };
  fallback?: 'recency-window';
  /**
   * How many segments were recalled because their pair with the anchor was inside `w` and the System-1 backend
   * had not judged it, rather than because the backend judged them relevant.
   *
   * "Not judged" is the rule (`AssociationGraph.unjudgedWithin`), and it is deliberately not "has no score": a
   * failed System-1 call still leaves a lexical score behind, so a rule that asked only for an entry stayed silent
   * through a round in which 191 of 281 `s1_call` records failed and 11 of 49 assemblies fell back to recency.
   *
   * Counted separately on purpose: fail-open is a measurement decision as much as a safety one, and a run that
   * added these to the System-1 selection would report an intervention rate inflated by exactly the amount it
   * did not know. Same discipline as `judgedPairs` against `scoredPairs`.
   */
  unknownAdmitted?: number;
  /** tokens of the cache-stable prefix (pinned block), for H3 accounting */
  cacheStability: {
    /** equals `blocks.pinned`; the N1 acceptance criterion, so its meaning is fixed */
    prefixTokensStable: number;
    /**
     * Tokens at the front of the prompt that stay byte-identical across steps of one task, given the layout:
     * pinned + T, plus x when `xFirst` is on. Add-only, because `prefixTokensStable` already means something
     * narrower and redefining it would silently break the recorded acceptance test.
     */
    layoutStableTokens: number;
    /** the first block after the stable head: where a re-selection would cut the prefix */
    cutAfterBlock: string;
    /**
     * Tokens behind that cut, i.e. what one re-prefill costs. The input `decideReselect` prices, and the reason
     * the layout is a cache decision at all: with x first the tail is only the moving part, with x last it is
     * everything behind the task.
     */
    tokensAfterCut: number;
  };
  /** recall diagnostics for telemetry */
  recall: {
    candidates: number;
    selected: number;
    bfsDepth: number;
    /**
     * Recall hits dropped because another chunk of the same passage (`chunkOf` parent) was already selected.
     * Non-zero means the segment pool holds overlapping chunks of long events, which is normal, and the budget
     * was spent on distinct passages instead of on the overlap between two halves of one.
     */
    droppedSiblings?: number;
  };
  /**
   * The graph structure this step's recall produced.
   *
   * A nested tree: the anchor segment id at the root, each hit under the id recall reached it from, leaves `{}`.
   * **Keys are segment ids only** - no weights, kinds, depths or counts - because the tree records the *shape* of
   * the walk, not a ranking of it; the ranking is `layout.recalled`, and the counts are `recall`.
   *
   * Every hit `AssociationGraph.recall` returned is in it, including the ones the budget then dropped: what the
   * selector found is the thing being recorded. Always present - `{}` states that the walk produced nothing
   * (recall was not run, or it found no hit), which is a different fact from a record without the field.
   */
  recallTree: Record<string, unknown>;
}

export interface PlanCandidate {
  id: string;
  summary: string;
}

export interface PlanScore {
  id: string;
  /** raw probability from the decision model */
  prob: number;
  confidence: number;
}

export interface PlanGateDecision {
  /** plan ids in execution order */
  order: string[];
  /** renormalized probabilities (sum to 1 over candidates) */
  probs: Record<string, number>;
  /** true when the gate abstained and kept the LLM's own order */
  abstained: boolean;
}

/**
 * Default policy = the full configuration (cell C2), which is also the base the other two cells are derived from
 * by toggles. `deliver` is the one switch the base leaves off — a policy that assembles a layout nobody receives
 * is the safe default — and each cell turns delivery on for itself.
 */
export function defaultPolicy(): AssemblyPolicy {
  return {
    cell: 'C2',
    termination: 'model-owned',
    assemblyDeadlineMs: 250,
    rgMaintenance: { mode: 'async', maxLagTurns: 2 },
    cache: { reselectPolicy: 'perTask', blockTokens: 64 },
    tas: { on: true, tMaxChars: 8000, updatePolicy: 'perTask' },
    recall: {
      threshold: 0.55,
    window: 1024,
      anchorWaitMs: 10_000,
      depth: 2,
      fanout: 8,
      tier1: 'embed',
      embedModel: '',
      budgetRatio: 0.35,
      minRecalledShare: 0,
      minRecalledSegments: 1,
    },
    tail: { k: 3 },
    xFirst: true,
    deliver: false,
    s1: { provider: 'jev', baseUrl: '', model: '', apiKey: '', questionsPerCall: 20, retryAttempts: 1, admissionLimit: 8 },
  };
}

/** Ablation cell presets (docs/AGENT_BRIEF.md §9.1): C0 baseline, C1 TAS alone, C2 the full configuration. */
export function cellPolicy(cell: Cell): AssemblyPolicy {
  const p = defaultPolicy();
  p.cell = cell;
  switch (cell) {
    case 'C0': // baseline: chronological append, native compaction only
      p.tas.on = false;
      p.recall.tier1 = 'off';
      // The baseline is the one cell that does not take history management away from the harness: it delivers
      // nothing, so what it measures is the harness doing what it would have done anyway. The other two cells
      // deliver their assembled view, because "TAS alone" and the full configuration are statements about what
      // the model is shown - a cell that assembles a layout nobody receives is not an ablation arm.
      p.deliver = false;
      // The baseline is chronological, so x goes last. Leaving this at the default made the baseline carry the
      // position intervention the ablation is meant to isolate: the one knob that distinguishes it from the two
      // ordering cells was pinned to the same value in every cell and the layout axis could not be read at all.
      p.xFirst = false;
      break;
    case 'C1': // TAS alone: the state proxy exists and x sits before recalled history, no System-1 selection
      p.tas.on = true;
      p.recall.tier1 = 'off';
      p.deliver = true;
      p.xFirst = true;
      break;
    case 'C2':
      // the full configuration: TAS ordering plus S1 governance (recall selection), x-first layout. The second
      // half of that governance used to be a plan gate; it is gone, and the comment above `s1` says why.
      p.deliver = true;
      p.xFirst = true;
      break;
  }
  return p;
}