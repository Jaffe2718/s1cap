/**
 * ASSEMBLER — budgeted recall + Trace-as-State layout.
 * Layout: [pinned | T | recalled | tail | x]  (x always last; docs/FORMULAS.md §3.4)
 */
import type { AssemblyPolicy, AssemblyResult, Segment } from './types.ts';
import { AssociationGraph } from './assoc-graph.ts';
import { estimateTokens } from './segmenter.ts';

export interface AssembleInput {
  graph: AssociationGraph;
  policy: AssemblyPolicy;
  /** pinned prefix: system prompt + tool schemas (never reordered) */
  pinned: Segment[];
  /** verbatim recent turns, already resolved by the caller */
  tail: Segment[];
  /** current user input x (anchor, always last) */
  current: Segment;
  /** serialized task-state proxy T; required when policy.tas.on */
  stateProxy?: string;
  contextWindow: number;
  reserveOutputTokens: number;
  fixedOverheadTokens: number;
  now: number;
  /** decay constant λ in ms */
  lambdaMs: number;
  /** chronological history, used for the recency-window fallback */
  history?: Segment[];
}

export function totalTokens(segments: readonly Segment[]): number {
  return segments.reduce((sum, s) => sum + s.tokens, 0);
}

/**
 * Assemble one model-view context.
 *
 * Note: with `recall.tier1 === 'off'` (cells C1/C2) the recalled block is empty by
 * design — those cells let the harness manage history natively.
 */
export function assemble(input: AssembleInput): AssemblyResult {
  const { policy, graph, pinned, tail, current, stateProxy } = input;
  const total = Math.max(0, input.contextWindow - input.reserveOutputTokens - input.fixedOverheadTokens);

  const proxy = policy.tas.on ? (stateProxy ?? '') : '';
  // an empty T is 0 tokens, not estimateTokens('') = 1 (found by a real round: blocks.stateProxy was 1)
  const proxyTokens = policy.tas.on && proxy !== '' ? estimateTokens(proxy) : 0;

  const fixed: Segment[] = [current];
  const pinnedTokens = totalTokens(pinned);
  const tailTokens = totalTokens(tail);
  const fixedUsed = pinnedTokens + tailTokens + current.tokens + proxyTokens;

  const remaining = Math.max(0, total - fixedUsed);
  const recalledBudget = Math.min(Math.floor(total * policy.recall.budgetRatio), remaining);

  let excluded = new Set<string>([...pinned, ...tail, current].map((s) => s.id));
  let recalled: Segment[] = [];
  let fallback: 'recency-window' | undefined;
  let candidates = 0;
  let bfsDepth = 0;

  if (policy.recall.tier1 !== 'off' && recalledBudget > 0) {
    const hits = graph.recall([current.id], {
      tau: policy.recall.tau,
      depth: policy.recall.depth,
      fanout: policy.recall.fanout,
      lambdaMs: input.lambdaMs,
      now: input.now,
    });
    candidates = hits.length;
    let used = 0;
    for (const hit of hits) {
      if (excluded.has(hit.id)) continue;
      const seg = graph.getSegment(hit.id);
      if (!seg) continue;
      if (used + seg.tokens > recalledBudget) continue;
      recalled.push(seg);
      excluded.add(seg.id);
      used += seg.tokens;
      bfsDepth = Math.max(bfsDepth, hit.depth);
    }

    if (used < policy.recall.minRecalledShare * recalledBudget) {
      fallback = 'recency-window';
      recalled = [];
      used = 0;
      // The fallback is a fresh recency window: only pinned/tail/anchor stay excluded.
      excluded = new Set<string>([...pinned, ...tail, current].map((s) => s.id));
      const history = [...(input.history ?? [])].sort((a, b) => a.seq - b.seq);
      for (const seg of history) {
        if (excluded.has(seg.id)) continue;
        if (used + seg.tokens > recalledBudget) continue;
        recalled.push(seg);
        excluded.add(seg.id);
        used += seg.tokens;
      }
    }
  }

  // Ordering: TAS on -> strongest relevance first; TAS off -> chronological.
  if (policy.tas.on) {
    recalled = [...recalled]; // already weight-ordered from recall
  } else {
    recalled = [...recalled].sort((a, b) => a.seq - b.seq);
  }

  const recalledTokens = totalTokens(recalled);
  const result: AssemblyResult = {
    layout: {
      pinned: [...pinned],
      ...(policy.tas.on ? { stateProxy: proxy } : {}),
      recalled,
      tail: [...tail],
      anchor: current,
    },
    budget: {
      total,
      used: fixedUsed + recalledTokens,
      byBlock: {
        pinned: pinnedTokens,
        stateProxy: proxyTokens,
        recalled: recalledTokens,
        tail: tailTokens,
        anchor: current.tokens,
      },
    },
    ...(fallback !== undefined ? { fallback } : {}),
    cacheStability: { prefixTokensStable: pinnedTokens },
    recall: { candidates, selected: recalled.length, bfsDepth },
  };
  return result;
}
