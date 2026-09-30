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

export type Cell = 'C1' | 'C2' | 'C3' | 'C4';

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
      /** relevance threshold (recall.relevanceThreshold, 0..1) */
      relevanceThreshold: number;
      /**
       * S1 scoring window w (recall.window): a new segment is scored only against the most recent w
       * segments. It exists purely to save System-1 calls - BFS recall (depth d, threshold r) is
       * unaffected, and segments outside the window stay in the graph as nodes and remain reachable.
       */
      window: number;
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
     * μ = 0.25 the floor fired on **9 of 9** steps of a live C4 session, so every System-1 selection was replaced
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
   * The baseline cell C1 keeps this off, which is what makes it a baseline: it is the only cell that lets the
   * harness manage history natively. C2/C3/C4 turn it on, because "ordering only" and "S1 governance only" are
   * claims about what the model is shown, and a delivered-nothing cell cannot support them.
   */
  deliver: boolean;
  planGate: {
    on: boolean;
    /** candidate plans m (<= 3) */
    maxPlans: number;
    /** attempt cap M (>= 1) */
    attemptCap: number;
    abstainConfidence: number;
  };
  s1: {
    provider: S1ProviderName;
    /** "" = use the provider default (or the Laya runtime's host/port) */
    baseUrl?: string;
    /** "" = use the provider default (or the Laya checkpoint name) */
    model?: string;
    /** "" = read the provider's environment variable (TYPESAFE_API_KEY / S1CAP_API_KEY); never logged */
    apiKey?: string;
    timeoutMs: number;
    /** questions per /v1/systemone call (context-rot guard) */
    questionsPerCall: number;
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

/** Default policy = cell C4 (full system). Cells C1–C3 are derived by toggles. */
export function defaultPolicy(): AssemblyPolicy {
  return {
    cell: 'C4',
    termination: 'model-owned',
    assemblyDeadlineMs: 250,
    rgMaintenance: { mode: 'async', maxLagTurns: 2 },
    cache: { reselectPolicy: 'perTask', blockTokens: 64 },
    tas: { on: true, tMaxChars: 8000, updatePolicy: 'perTask' },
    recall: {
      relevanceThreshold: 0.55,
    window: 1024,
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
    planGate: { on: true, maxPlans: 3, attemptCap: 2, abstainConfidence: 0.5 },
    s1: { provider: 'jev', baseUrl: '', model: '', apiKey: '', timeoutMs: 2500, questionsPerCall: 20 },
  };
}

/** 2×2 ablation cell presets (docs/AGENT_BRIEF.md §9.1). */
export function cellPolicy(cell: Cell): AssemblyPolicy {
  const p = defaultPolicy();
  p.cell = cell;
  switch (cell) {
    case 'C1': // baseline: chronological append, native compaction only
      p.tas.on = false;
      p.recall.tier1 = 'off';
      p.planGate.on = false;
      // The baseline is the one cell that does not take history management away from the harness: it delivers
      // nothing, so what it measures is the harness doing what it would have done anyway. Every other cell
      // delivers its assembled view, because "ordering only" and "S1 governance only" are statements about what
      // the model is shown - a cell that assembles a layout nobody receives is not an ablation arm.
      p.deliver = false;
      // The baseline is chronological, so x goes last. Leaving this at the default made C1 and C3 carry the
      // position intervention the ablation is meant to isolate, so the one knob that distinguishes them from
      // C2 and C4 was pinned to the same value in all four cells and the layout axis could not be read at all.
      p.xFirst = false;
      break;
    case 'C2': // +TAS ordering only
      p.tas.on = true;
      p.recall.tier1 = 'off';
      p.planGate.on = false;
      p.deliver = true;
      p.xFirst = true;
      break;
    case 'C3': // +S1 governance only (selection + plan gate), chronological layout
      p.tas.on = false;
      p.recall.tier1 = 'embed';
      p.planGate.on = true;
      p.deliver = true;
      p.xFirst = false;
      break;
    case 'C4':
      // full method: TAS ordering, S1 governance, x-first layout
      p.deliver = true;
      p.xFirst = true;
      break;
  }
  return p;
}