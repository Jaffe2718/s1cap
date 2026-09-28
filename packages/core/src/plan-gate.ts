/**
 * PLAN GATE — probability-ordered plan execution (docs/FORMULAS.zh.md §4).
 * m = candidate plans (<= 3), M = attempt cap (default 2).
 */
import type { PlanCandidate, PlanGateDecision, PlanScore } from './types.ts';

/**
 * Renormalize raw decision-model output so probabilities sum to 1.
 * Required because Jev does not guarantee structural invariants
 * (documented example: P(refund) + P(not refund) = 1.19).
 */
export function normalizeProbs(raw: Record<string, number>): Record<string, number> {
  const ids = Object.keys(raw);
  const positive = ids.filter((id) => {
    const v = raw[id];
    return typeof v === 'number' && Number.isFinite(v) && v > 0;
  });
  const sum = positive.reduce((acc, id) => acc + (raw[id] ?? 0), 0);
  if (positive.length === 0 || sum <= 0) {
    const uniform = ids.length > 0 ? 1 / ids.length : 0;
    return Object.fromEntries(ids.map((id) => [id, uniform]));
  }
  return Object.fromEntries(positive.map((id) => [id, (raw[id] ?? 0) / sum]));
}

/**
 * Order candidate plans by (normalized) probability.
 * Abstains — keeping the LLM's own order — when the best confidence is below
 * `abstainConfidence`, or when scores are missing.
 */
export function orderPlans(
  plans: readonly PlanCandidate[],
  scores: readonly PlanScore[],
  abstainConfidence: number,
): PlanGateDecision {
  const byId = new Map(scores.map((s) => [s.id, s]));
  const raw: Record<string, number> = {};
  for (const p of plans) raw[p.id] = byId.get(p.id)?.prob ?? 0;
  const probs = normalizeProbs(raw);

  const best = plans.reduce<number>((acc, p) => Math.max(acc, byId.get(p.id)?.confidence ?? 0), 0);
  const ordered = [...plans].sort((a, b) => {
    const pa = probs[a.id] ?? 0;
    const pb = probs[b.id] ?? 0;
    if (pb !== pa) return pb - pa;
    return a.id.localeCompare(b.id);
  });

  const abstained = scores.length === 0 || best < abstainConfidence;
  return {
    order: abstained ? plans.map((p) => p.id) : ordered.map((p) => p.id),
    probs,
    abstained,
  };
}

/**
 * Attempt controller: execute plans in order, verify each, stop on first success
 * or when the attempt cap M is reached.
 */
export class AttemptController {
  #order: string[];
  #cap: number;
  #index = 0;
  #attempts = 0;
  #succeeded: string | undefined;
  #stopped = false;

  constructor(order: readonly string[], attemptCap: number) {
    this.#order = [...order];
    this.#cap = Math.max(0, Math.floor(attemptCap));
  }

  /** Next plan to execute, or undefined when the cap is reached / already succeeded. */
  next(): string | undefined {
    if (this.#stopped || this.#succeeded !== undefined) return undefined;
    if (this.#attempts >= this.#cap) return undefined;
    return this.#order[this.#index];
  }

  /** Record the verification outcome of the plan returned by `next()`. */
  record(id: string, ok: boolean): void {
    if (id !== this.#order[this.#index]) {
      throw new Error(`out-of-order attempt: expected ${String(this.#order[this.#index])}, got ${id}`);
    }
    this.#attempts += 1;
    this.#index += 1;
    if (ok) {
      this.#succeeded = id;
      this.#stopped = true;
    }
  }

  get attempts(): number {
    return this.#attempts;
  }

  get succeeded(): string | undefined {
    return this.#succeeded;
  }

  /** Plans never executed (their cost is the gate's saving when we succeed early). */
  unexecuted(): string[] {
    return this.#order.slice(this.#index);
  }
}
