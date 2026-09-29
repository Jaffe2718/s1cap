/**
 * S1 RELEVANCE — one System-1 call per new segment, scoring the whole window.
 *
 * This is the "S1 relevance" box of the design: for a new segment s_j, decide how much reference value each
 * historical segment h_i carries for it, as a value in [0,1]. The direction matters and is not symmetric -
 * the question is about h_i's usefulness *for s_j*, not about how similar the two strings are.
 *
 * Why one call and not one per pair: `recall.window = w` exists to bound this cost, and a per-pair scorer would
 * make the cost w calls per new segment instead of 1. The client takes any number of questions in a single
 * request, so the window is asked about in one round trip and the saving is real rather than rhetorical.
 * `scoredPairs` in the control plane still counts pairs - the graph is where that is decided, not here.
 *
 * Failure policy: a System-1 call that times out, errors, or returns an answer we cannot read yields **no
 * weights**, and the graph's caller falls back to its lexical scorer. That is deliberate. A relevance backend
 * that is briefly unavailable must cost accuracy, never the round, and never a stack trace into the harness.
 */
import { normalize, score } from '@s1cap/s1-client';
import type { ScoreAnswer } from '@s1cap/s1-client';
import type { Segment } from '@s1cap/core';

/** The ordered relevance levels asked of the backend; the answer is the probability of the top one. */
const RELEVANCE_LEVELS: readonly string[] = [
  'directly needed to answer or continue this',
  'useful supporting context',
  'tangentially related',
  'unrelated',
];

const MAX_SEGMENT_CHARS = 1200;

export interface S1RelevanceOptions {
  decide(state: unknown, questions: Record<string, ReturnType<typeof score>>): Promise<{
    answers: Record<string, { type?: string; score?: unknown; probabilities?: Record<string, number>; confidence?: number }>;
    usage?: { input_tokens: number; output_tokens: number };
    ms?: number;
  }>;
  /** per-request question cap (policy: s1.questionsPerCall) */
  questionsPerCall?: number;
  onWarn?(message: string): void;
  /** injected for tests */
  now?(): number;
}

export interface S1RelevanceStats {
  calls: number;
  questions: number;
  inputTokens: number;
  outputTokens: number;
  lastMs: number;
  /** calls that produced no usable weight and were reported */
  failures: number;
}

export interface S1Relevance {
  /**
   * Weights for `candidates`, in order. Returns `undefined` when no backend answered, which is the caller's
   * signal to use its fallback rather than to treat every pair as unrelated.
   */
  (current: Segment, candidates: readonly Segment[]): Promise<readonly number[] | undefined>;
  stats(): S1RelevanceStats;
}

/** A segment rendered for the backend: bounded, and labelled so the model can judge the pair it is shown. */
function render(segment: Segment): string {
  const text = segment.text.length > MAX_SEGMENT_CHARS
    ? `${segment.text.slice(0, MAX_SEGMENT_CHARS)}...`
    : segment.text;
  return `[${segment.kind}] ${text}`;
}

function readWeight(answer: { score?: unknown; probabilities?: Record<string, number> } | undefined): number | undefined {
  if (answer === undefined) return undefined;
  // A `score` answer may come back as the level index or as a probability distribution over the levels. Both
  // are reduced to one number in [0,1]: the distribution is normalized (Jev does not guarantee a sum of one)
  // and the top level's mass is the value, because "how much reference value" is a graded question, not a
  // rank.
  if (answer.probabilities !== undefined && typeof answer.probabilities === 'object') {
    const normalized = normalize(answer.probabilities);
    const keys = Object.keys(normalized);
    if (keys.length === 0) return undefined;
    const top = keys.reduce((best, key) => ((normalized[key] as number) > (normalized[best] as number) ? key : best), keys[0] as string);
    const value = normalized[top] as number;
    return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : undefined;
  }
  if (typeof answer.score === 'number' && Number.isFinite(answer.score)) {
    return Math.max(0, Math.min(1, answer.score));
  }
  return undefined;
}

export function createS1Relevance(opts: S1RelevanceOptions): S1Relevance {
  const stats: S1RelevanceStats = { calls: 0, questions: 0, inputTokens: 0, outputTokens: 0, lastMs: 0, failures: 0 };
  const perCall = Math.max(1, Math.trunc(opts.questionsPerCall ?? 16));

  const scoreBatch = async (current: Segment, candidates: readonly Segment[]): Promise<readonly number[] | undefined> => {
    if (candidates.length === 0) return [];
    const started = (opts.now ?? Date.now)();
    const questions: Record<string, ReturnType<typeof score>> = {};
    const index: number[] = [];
    for (let i = 0; i < candidates.length; i += 1) {
      // The window is asked about in batches bounded by the caller's cap. A cap reached is a real limit, not a
      // silent truncation, so it is reported once and the remaining candidates simply get no weight.
      if (i > 0 && i % perCall === 0) {
        opts.onWarn?.(`[s1cap] relevance: window of ${candidates.length} exceeds questionsPerCall=${perCall}; the rest is unscored`);
        break;
      }
      const id = `h${i}`;
      questions[id] = score(
        `Candidate h${i}:\n${render(candidates[i] as Segment)}\n\n` +
        `How much reference value does this candidate have for the current segment?\n` +
        `Current:\n${render(current)}`,
        [...RELEVANCE_LEVELS],
      );
      index.push(i);
    }
    if (index.length === 0) return undefined;

    let answers: Awaited<ReturnType<S1RelevanceOptions['decide']>>['answers'];
    try {
      const result = await opts.decide(
        // The state is the current segment: one System-1 call judges how useful the listed candidates are for
        // it, which is the direction the design asks for (h_i's reference value for s_j, not string overlap).
        { kind: current.kind, text: render(current) },
        questions,
      );
      answers = result.answers;
      stats.calls += 1;
      stats.inputTokens += result.usage?.input_tokens ?? 0;
      stats.outputTokens += result.usage?.output_tokens ?? 0;
    } catch (err) {
      stats.failures += 1;
      opts.onWarn?.(`[s1cap] relevance call failed (falling back to lexical scoring): ${String(err)}`);
      return undefined;
    }
    stats.questions += index.length;
    stats.lastMs = Math.max(0, (opts.now ?? Date.now)() - started);

    const weights: number[] = [];
    for (const i of index) {
      const answer = answers[`h${i}`] as ScoreAnswer | undefined;
      const weight = readWeight(answer);
      if (weight === undefined) {
        stats.failures += 1;
        opts.onWarn?.(`[s1cap] relevance: no usable weight for candidate h${i}; the whole batch falls back`);
        return undefined;
      }
      weights.push(weight);
    }
    // Aligned by candidate index, so a partial batch is impossible to misread as a full one.
    const out = new Array<number>(candidates.length).fill(0);
    index.forEach((candIndex, k) => {
      out[candIndex] = weights[k] as number;
    });
    return out;
  };

  const relevance = scoreBatch as S1Relevance;
  (relevance as { stats?: unknown }).stats = () => ({ ...stats });
  return relevance;
}
