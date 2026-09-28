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

export type EdgeSource = 'meta' | 'embed' | 's1-noul' | 's1-score';

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
    tau: number;
    /** bounded BFS depth d */
    depth: number;
    /** per-node expansion fanout k */
    fanout: number;
    tier1: 'embed' | 's1' | 'off';
    embedModel?: string;
    /** share of the token budget available to recalled blocks (ρ) */
    budgetRatio: number;
    /** fall back to recency window below this fill rate (μ) */
    minRecalledShare: number;
  };
  tail: { k: number };
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

export interface AssemblyResult {
  layout: {
    pinned: Segment[];
    /** serialized state proxy; undefined when TAS is off */
    stateProxy?: string;
    recalled: Segment[];
    tail: Segment[];
    /** current user input x — always last */
    anchor: Segment;
  };
  budget: {
    total: number;
    used: number;
    byBlock: Record<string, number>;
  };
  fallback?: 'recency-window';
  /** tokens of the cache-stable prefix (pinned block), for H3 accounting */
  cacheStability: { prefixTokensStable: number };
  /** recall diagnostics for telemetry */
  recall: { candidates: number; selected: number; bfsDepth: number };
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
      tau: 0.55,
      depth: 2,
      fanout: 8,
      tier1: 'embed',
      embedModel: '',
      budgetRatio: 0.35,
      minRecalledShare: 0.25,
    },
    tail: { k: 3 },
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
      break;
    case 'C2': // +TAS ordering only
      p.tas.on = true;
      p.recall.tier1 = 'off';
      p.planGate.on = false;
      break;
    case 'C3': // +S1 governance only (selection + plan gate), chronological layout
      p.tas.on = false;
      p.recall.tier1 = 'embed';
      p.planGate.on = true;
      break;
    case 'C4':
      break;
  }
  return p;
}
