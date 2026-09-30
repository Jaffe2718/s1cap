/**
 * S1 RELEVANCE — one System-1 call per new segment, scoring the whole window.
 *
 * This is the figure's "noul relevance" box: for a new segment s_j, decide how much reference value each
 * historical segment h_i carries for it, as a value in [0,1]. The question type is `noul` - a binary
 * "would retrieving this help?" whose P(true) is read straight as the weight - because that is what the
 * route diagram specifies (`relevance scoring (noul)`, `S1 Assoc Backend: noul relevance`). An earlier
 * implementation asked a graded 4-level `score` question and took the top level's probability mass; both
 * give a number in [0,1], but only the noul form is the thing under study, and the paper cannot describe a
 * box whose implementation asks a different question. The direction matters and is not symmetric - the
 * question is about h_i's usefulness *for s_j*, not about how similar the two strings are.
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
import { noul, normalize } from '@s1cap/s1-client';
import type { NoulAnswer } from '@s1cap/s1-client';
import type { Segment } from '@s1cap/core';

const MAX_SEGMENT_CHARS = 1200;

export interface S1RelevanceOptions {
  decide(state: unknown, questions: Record<string, ReturnType<typeof noul>>): Promise<{
    answers: Record<string, { type?: string; noul?: unknown; probabilities?: Record<string, number>; confidence?: number }>;
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

function readWeight(answer: { noul?: unknown; probabilities?: Record<string, number> } | undefined): number | undefined {
  if (answer === undefined) return undefined;
  // The noul answer *is* the weight: P("retrieving this would help") reduced to one number in [0,1]. A backend
  // that answers with a raw distribution over the criteria gets the same treatment - the true-side mass -
  // because the edge weight the graph consumes is a probability either way.
  if (typeof answer.noul === 'number' && Number.isFinite(answer.noul)) {
    return Math.max(0, Math.min(1, answer.noul));
  }
  if (answer.probabilities !== undefined && typeof answer.probabilities === 'object') {
    const normalized = normalize(answer.probabilities);
    for (const key of ['true', 'yes']) {
      const value = normalized[key] as number | undefined;
      if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.min(1, value));
    }
  }
  return undefined;
}

export function createS1Relevance(opts: S1RelevanceOptions): S1Relevance {
  const stats: S1RelevanceStats = { calls: 0, questions: 0, inputTokens: 0, outputTokens: 0, lastMs: 0, failures: 0 };
  const perCall = Math.max(1, Math.trunc(opts.questionsPerCall ?? 16));
  /** one line, not one per segment: "no backend" is a mode, and a mode repeated per segment is noise */
  let reportedNoClient = false;

  const scoreBatch = async (current: Segment, candidates: readonly Segment[]): Promise<readonly number[] | undefined> => {
    if (candidates.length === 0) return [];
    const started = (opts.now ?? Date.now)();
    const out = new Array<number>(candidates.length).fill(0);

    // The window is covered in sequential batches, not truncated at the first one.
    //
    // The previous shape asked about `candidates[0 .. perCall-1]` and stopped, warning that "the rest is
    // unscored". Because the graph builds its candidate list oldest-first, that meant every segment past the
    // first twenty was measured against **the session's opening twenty segments** and never against its recent
    // neighbours: a live session showed 100% of its System-1 edges with an older endpoint in 0..19, exactly
    // twenty distinct older endpoints, and BFS anchors with no edges at all - recall then fell back to the
    // recency window, which reads as "the selector found nothing" and was in fact "the selector was never
    // asked". `w` is supposed to bound the System-1 *cost* of one segment (O(w) questions), not silently
    // redefine the window as twenty; splitting the same questions across several requests changes the number
    // of round trips and not the number of questions.
    let cursor = 0;
    while (cursor < candidates.length) {
      const batch: number[] = [];
      for (let i = cursor; i < candidates.length && batch.length < perCall; i += 1) batch.push(i);

      // Question ids are local to the request (`h0..hN`), because each batch is its own request; the prose keeps
      // the candidate's position in the window, so the model can still tell which part of the history it is
      // being asked about.
      const questions: Record<string, ReturnType<typeof noul>> = {};
      batch.forEach((candidateIndex, slot) => {
        questions[`h${slot}`] = noul(
          `Does retrieving this candidate help answer or continue the current segment?\n\n` +
            `Current segment:\n${render(current)}\n\n` +
            `Candidate h${candidateIndex}:\n${render(candidates[candidateIndex] as Segment)}`,
          {
            true: 'retrieving the candidate would help with the current segment',
            false: 'the candidate is unrelated or a distraction',
          },
        );
      });

      let answers: Awaited<ReturnType<S1RelevanceOptions['decide']>>['answers'];
      try {
        const result = await opts.decide(
          // The state is the current segment: one System-1 call judges how useful the listed candidates are for
          // it, which is the direction the design asks for (h_i's reference value for s_j, not string overlap).
          { kind: current.kind, text: render(current) },
          questions,
        );
        // `undefined` is the caller saying there is no backend to ask - observation mode, or a provider that
        // resolved to `none`. That is a state and not a failure, so it is reported once instead of per segment;
        // and it is handled here rather than by a TypeError on `result.answers`, which is what it used to be.
        if (result === undefined) {
          if (!reportedNoClient) {
            reportedNoClient = true;
            opts.onWarn?.('[s1cap] relevance: no System-1 client is answering; windows are scored lexically');
          }
          return undefined;
        }
        answers = result.answers;
        stats.calls += 1;
        stats.inputTokens += result.usage?.input_tokens ?? 0;
        stats.outputTokens += result.usage?.output_tokens ?? 0;
      } catch (err) {
        stats.failures += 1;
        opts.onWarn?.(
          `[s1cap] relevance call failed at candidate ${cursor}/${candidates.length} (falling back to lexical scoring): ${String(err)}`,
        );
        return undefined;
      }
      stats.questions += batch.length;

      // All or nothing for the segment. A batch that answered while its neighbour timed out would leave some
      // pairs judged by the backend and others by the lexical scorer, and the graph would then hold two kinds of
      // number in one window without a per-pair record saying which - the exact confusion `ScoredPair.source`
      // exists to prevent. A segment whose backend did not answer is scored lexically, in full, and says so.
      for (let slot = 0; slot < batch.length; slot += 1) {
        const weight = readWeight(answers[`h${slot}`] as Partial<NoulAnswer> | undefined);
        if (weight === undefined) {
          stats.failures += 1;
          opts.onWarn?.(`[s1cap] relevance: no usable weight for candidate h${batch[slot]}; the whole batch falls back`);
          return undefined;
        }
        out[batch[slot] as number] = weight;
      }
      cursor += batch.length;
    }

    stats.lastMs = Math.max(0, (opts.now ?? Date.now)() - started);
    // Aligned by candidate index, so a partial batch is impossible to misread as a full one.
    return out;
  };

  const relevance = scoreBatch as S1Relevance;
  (relevance as { stats?: unknown }).stats = () => ({ ...stats });
  return relevance;
}
