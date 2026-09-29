/**
 * PLAN GATE — candidate plans, scored by one System-1 choice call, in an advisory order.
 *
 * This is the right-hand column of the method figure: `candidate plans` -> `choice scores` -> `advisory order ·
 * never vetoes stop`. The core half (`orderPlans`, `normalizeProbs`, `AttemptController`) has existed since the
 * beginning and was called by nobody, so the figure described a part of the system that was written down and not
 * running. This file is the wiring, and it is deliberately incapable of the one thing that would make it
 * dangerous:
 *
 *   **It never changes what the model sees or whether the turn ends.** The order is computed, recorded in the
 *   control plane, and returned to whoever asks. There is no code path from a gate decision to a prompt or to a
 *   stop. The figure says "never vetoes stop" and that is a property of the absence of a call site, not a check
 *   somebody remembered to write.
 *
 * Where the plans come from: the model's own output. A plan is a candidate only if the model wrote it down as
 * one - a numbered or bulleted step in an assistant message. S1CAP never invents a plan, so the gate can only
 * ever reorder something the model already decided to do, which is what makes an advisory order meaningful
 * rather than a second opinion that quietly replaced the first.
 */
import { choice, normalize } from '@s1cap/s1-client';
import type { ChoiceAnswer } from '@s1cap/s1-client';

import type { PlanCandidate, PlanGateDecision, PlanScore } from '@s1cap/core';
import { TELEMETRY_SCHEMA_VERSION, orderPlans } from '@s1cap/core';

const MAX_SUMMARY_CHARS = 400;
/** m <= 3 by policy; longer lists are truncated here so the cap is enforced in one place. */
const MAX_PLANS = 3;

export interface PlanGateOptions {
  policy: { planGate: { on: boolean; maxPlans: number; attemptCap: number; abstainConfidence: number } };
  emit(event: TelemetryEvent): void;
  onWarn?(message: string): void;
  now?(): number;
}

export interface PlanGate {
  /**
   * Read candidate plans out of one assistant message and, when they are found, score them in a single
   * System-1 call. Returns undefined when there is nothing to gate - no gate enabled, fewer than two plans
   * (an order over one item is not a decision), or no backend.
   */
  consider(text: string, sessionId: string, step: number): Promise<PlanGateDecision | undefined>;
  stats(): PlanGateStats;
}

export interface PlanGateStats {
  /** assistant messages inspected */
  inspected: number;
  /** messages from which at least two plans were read */
  withPlans: number;
  /** System-1 calls spent on choice scoring */
  calls: number;
  /** decisions where the gate kept the model's own order (low confidence) */
  abstained: number;
  /** messages that produced no decision at all */
  skipped: number;
}

/**
 * Read the model's own plan list out of an assistant message.
 *
 * Deliberately strict about the format: a line that is a numbered or bulleted step, with text after it. Prose
 * containing a "-" in the middle of a sentence is not a plan, and a gate that invents plans from prose would be
 * reordering work the model never proposed.
 */
export function extractPlans(text: string, maxPlans = MAX_PLANS): PlanCandidate[] {
  const plans: PlanCandidate[] = [];
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const match = /^\s*(?:\d+[.)]|[-*+])\s+(\S.*)$/.exec(line);
    if (match === null) continue;
    const summary = (match[1] ?? '').trim();
    if (summary === '') continue;
    plans.push({
      id: `p${plans.length + 1}`,
      summary: summary.length > MAX_SUMMARY_CHARS ? `${summary.slice(0, MAX_SUMMARY_CHARS)}...` : summary,
    });
    if (plans.length >= Math.max(1, Math.trunc(maxPlans))) break;
  }
  return plans;
}

export function createPlanGate(
  opts: PlanGateOptions,
  decide?: (state: unknown, questions: Record<string, ReturnType<typeof choice>>) => Promise<{
    answers: Record<string, unknown>;
    usage?: { input_tokens: number; output_tokens: number };
  }>,
): PlanGate {
  const stats: PlanGateStats = { inspected: 0, withPlans: 0, calls: 0, abstained: 0, skipped: 0 };

  const consider = async (text: string, sessionId: string, step: number): Promise<PlanGateDecision | undefined> => {
    if (!opts.policy.planGate.on || decide === undefined) {
      stats.skipped += 1;
      return undefined;
    }
    stats.inspected += 1;
    const plans = extractPlans(text, opts.policy.planGate.maxPlans);
    // One candidate is not an ordering decision; two is the smallest case where the gate can differ from the
    // model's own order at all.
    if (plans.length < 2) {
      stats.skipped += 1;
      return undefined;
    }
    stats.withPlans += 1;

    const question = choice(
      'The task is to carry out these candidate plans. Which plan should be executed first? ' +
        'Judge by which one unblocks the others and by how much it reduces risk if it fails.',
      Object.fromEntries(plans.map((p) => [p.id, p.summary])),
    );

    let scores: PlanScore[];
    try {
      const result = await decide(
        { task: text.slice(0, MAX_SUMMARY_CHARS * 2), plans: plans.map((p) => ({ id: p.id, summary: p.summary })) },
        { first: question },
      );
      stats.calls += 1;
      const answer = result.answers['first'] as ChoiceAnswer | undefined;
      if (answer === undefined || answer.probabilities === undefined) {
        // No readable answer is an abstention, not an ordering: the model's own order stands.
        stats.skipped += 1;
        return undefined;
      }
      // Jev does not guarantee the probabilities sum to one, so they are normalized before use - and the
      // normalization is the same function the graph uses for relevance, so the two agree on what a
      // probability is.
      const probs = normalize(answer.probabilities as Record<string, number>);
      scores = plans.map((p) => ({
        id: p.id,
        prob: probs[p.id] ?? 0,
        confidence: typeof answer.confidence === 'number' ? answer.confidence : 0,
      }));
    } catch (err) {
      opts.onWarn?.(`[s1cap] plan scoring failed (keeping the model's own order): ${String(err)}`);
      stats.skipped += 1;
      return undefined;
    }

    const decision = orderPlans(plans, scores, opts.policy.planGate.abstainConfidence);
    if (decision.abstained) stats.abstained += 1;
    // The record carries the advice, not an action. `executed` is empty and `verified` false in this milestone
    // because nothing here executes: the gate's order is computed, recorded and returned, and the harness runs
    // the model's own plans. Those two fields exist in the frozen schema for when the harness does hand the
    // order over, and leaving them at their empty values is what says "advisory" in the log.
    const ordered = decision.order;
    opts.emit({
      type: 'plan_gate',
      schema: TELEMETRY_SCHEMA_VERSION,
      ts: (opts.now ?? Date.now)(),
      plans: ordered,
      probs: ordered.map((id) => decision.probs[id] ?? 0),
      confidence: ordered.map((id) => scores.find((s) => s.id === id)?.confidence ?? 0),
      order: ordered,
      abstained: decision.abstained,
      executed: [],
      verified: false,
      savedTokensEst: 0,
    });
    return decision;
  };

  return { consider, stats: () => ({ ...stats }) };
}
