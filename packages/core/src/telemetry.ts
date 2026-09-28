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
  seq: number;
  candidates: number;
  selected: number;
  bfsDepth: number;
  budgetUsed: number;
  budgetTotal: number;
  blocks: Record<string, number>;
  prefixTokensStable: number;
  fallback?: string;
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
  | PlanGateEvent;

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
