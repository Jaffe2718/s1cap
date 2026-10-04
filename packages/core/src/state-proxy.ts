/**
 * STATE PROXY T — the serialized reasoning trace.
 *
 * The paper: "Trace as State: Reasoning Traces as Conditional States for Long-Context Transformers" (Zou &
 * Tang, arXiv:2609.02702), §3.2 "Reasoning Traces as a Textual State Proxy" and Appendix C "Prompt and State
 * Templates". Three sentences from it are the whole of this file:
 *
 *   - "We view reasoning traces as an **observable textual proxy for task state**."
 *   - "For each task, a serializer π held fixed across the placement conditions constructs the serialized trace
 *      **T = π(r_1,…,r_ntr)**."
 *   - "A fixed serializer preserves the reasoning traces while adding **only necessary delimiters such as
 *     `<trace_start>` and `<trace_end>` and brief introductory text**."
 *
 * **T is the trace, serialized — not a description of it.** This module used to hold the opposite premise (that
 * a long trace is a bad thing to carry verbatim, and that what should go into the prompt is a compact statement
 * of where the task stands, flattened into `task:` / `ran:` / `called:` / `next:` lines). That summariser is gone.
 * It is not a stylistic simplification: the paper's result is a comparison of *placement* — `[T, x, q]` against
 * `[x, T, q]` — and T is held fixed across the arms by construction ("a serializer π held fixed across the
 * placement conditions"). Replacing T with something the port wrote itself changes the artefact under test, so
 * the arm that was supposed to measure placement was measuring this module's line-truncation policy instead.
 *
 * What survives the change, because it is a property of a *serializer* and not of a summary:
 *
 *   - **Fixed frame, fixed everywhere.** `<trace_start>`, `<trace_end>`, one brief introductory line and a
 *     blank line between consecutive runs are the only text added. They are constants, never derived, so π is
 *     the same function in every arm and every turn.
 *   - **Derived, not generated.** Every character of the body is text the model itself produced for this task,
 *     so nothing in T can be a claim the model never made. This is also why it needs no System-1 call: the
 *     expensive model does not participate in building it.
 *   - **Bounded.** `tas.tMaxChars` is a hard ceiling, not a target, because T sits in front of everything that
 *     varies and an unbounded T would drag the whole prompt's prefix with it. Its default is **50 000** because
 *     that is the paper's number: "Some traces are so long that we truncate them to the first 50,000 characters
 *     to keep the second-pass prompt within the model's context capacity." Note the direction — *first* — which
 *     is `updatePolicy: 'perTask'` below.
 *   - **Zero tokens when empty.** An empty T is the empty string, because the assembler accounts an empty T as
 *     0 tokens and a non-empty one as `estimateTokens(...)` ("found by a real round: blocks.stateProxy was 1",
 *     `assembler.ts`); a one-token estimate for "nothing" would quietly inflate every budget number the paper
 *     reports.
 *   - **Deterministic, and it never throws.** Same window, same bytes — which is what lets the caller memoise it
 *     per task — and every degenerate input (no anchor, no trace text, a ceiling below the frame, `NaN`) is a
 *     documented empty result rather than an exception on the step's critical path.
 */
import type { Segment } from './types.ts';

/**
 * The fixed frame of π, and the only text T adds to the model's own.
 *
 * The paper allows "brief introductory text" and names `<trace_start>` / `<trace_end>` as the necessary
 * delimiters; these are that sentence, made concrete. They are constants rather than options precisely because
 * the paper's serializer has to be held fixed across placement conditions — a knob here would be a knob on the
 * variable the experiment is not about.
 */
const INTRO = 'Reasoning trace for this task so far, in the order it was produced:';
const START = '<trace_start>';
const END = '<trace_end>';

/**
 * The cut marker, on its own line, when the trace is longer than the ceiling.
 *
 * The old module appended a bare `…`, which reads like the model's own punctuation. A truncation this module
 * performs is S1CAP's, not the model's, and T is written for a model that will reason over it — so it is
 * labelled.
 */
const CUT = '[trace truncated]';

/**
 * Which segment kinds are the trace.
 *
 * The paper's `r_1,…,r_ntr` are *the model's own outputs for the problem*, and the paper's `x` is everything
 * else — the long context the trace is being placed against. S1CAP's segment log is richer than the paper's
 * `(r_j, a_j)` pairs, so the mapping has to be stated rather than assumed:
 *
 *   - `assistant`, `trace` — **included**. `trace` is an assistant message made of reasoning parts
 *     (`harness-adapter.ts`), i.e. exactly an `r_j`; `assistant` is its visible answer `a_j`, which the paper
 *     also places inside `π`'s input.
 *   - `user` — **excluded**, and the reason is T's own task boundary rather than the anchor. A `user` segment is
 *     the condition `x`, and T is the trace *of the task the current input belongs to*: `buildStateProxy`
 *     serializes what follows its `anchorId` (below), so a `user` segment inside that window is a later turn's
 *     question, not this task's reasoning. **This boundary deliberately did not move with the recall anchor.**
 *     The anchor handed to the assembler is the step's *newest input event* — `user` on a turn-opening step and
 *     `assistant` / `trace` / `toolCall` / `toolResult` after it (`observer.ts`, `isInputEvent`) — so it moves
 *     within a turn, while this set is fixed. Handing that moving anchor to `buildStateProxy` would start T after
 *     the model's own newest message and empty it on every step after the first: the two boundaries are different
 *     on purpose, and the recall anchor is the one that moves.
 *   - `toolCall`, `toolResult` — **excluded**. These are the environment's half of `x`, not the model's
 *     reasoning: a tool result is evidence the model went to fetch, and S1CAP already has a selection channel
 *     for it (`recalled`, `tail`). Putting it in T as well would both widen the state proxy past what the paper
 *     calls a trace and pay for the same text twice per step.
 *   - `systemPinned` — **excluded**. That is the fixed prefix `P`, which precedes T by definition.
 *
 * Widening this set is the one change that would quietly make S1CAP's `T` a different object from the paper's,
 * so it is a constant with a comment rather than a filter that grew a branch.
 */
const TRACE_KINDS: ReadonlySet<string> = new Set(['assistant', 'trace']);

export interface StateProxyInput {
  /** the window in append order, including the anchor */
  segments: readonly Segment[];
  /** id of the current task segment x */
  anchorId: string;
  /**
   * `tas.tMaxChars` — the ceiling on the whole of T, frame included.
   *
   * The paper phrases its 50 000 as a bound on the trace ("we truncate them to the first 50,000 characters to
   * keep the second-pass prompt within the model's context capacity"); it is applied here to the serialized
   * artefact, because that is what this field is named for and what the assembler's budget arithmetic assumes.
   * The difference is the length of the fixed frame and nothing else.
   */
  maxChars: number;
  /**
   * `tas.updatePolicy` — which end of the trace survives the ceiling.
   *
   * The paper's T is a **per-problem static artefact**: π is applied once to the runs collected for the problem
   * and the result is used in exactly one second pass. S1CAP is not that shape — the loop runs many steps per
   * task and the trace grows — so "static" has to be re-expressed as a rule this pure function can obey without
   * hidden state, and the only such rule is *which prefix of the trace the block is a function of*:
   *
   *   - `'perTask'` — **freezes the serialisation**: the block is the *first* `maxChars` characters of the
   *     trace, the same direction the paper truncates in. Appending to the log cannot change it, because it
   *     does not depend on anything appended. That is the paper's static reading, and it is also the
   *     cache-aligned one (`docs/FORMULAS.md` §6: "a state proxy that re-renders per turn invalidates
   *     everything behind it"), which is why it is the default.
   *   - `'perTurn'` — **re-serialises each turn**: the block follows the trace forward and keeps the *newest*
   *     reasoning, dropping the oldest. Never stale, and it re-cuts — and so loses the prefix cache — every
   *     step the loop takes.
   *
   * The ambiguity is real and is not resolved here: under the ceiling the two policies emit **byte-identical**
   * text, because a trace that fits is not cut from either end, so the switch only has an observable effect once
   * a task's trace outgrows `tMaxChars`. The paper has no second policy to be faithful to here — its runs all
   * land in T, which `perTask` as written cannot reproduce for a multi-step loop without a per-task cache the
   * caller owns (`observer.ts` memoises on `anchorId`; that memo, not this argument, is what actually freezes a
   * `perTask` block in a live session). A round that wants the growing reading measures `perTurn`.
   */
  updatePolicy: 'perTask' | 'perTurn';
  /**
   * Carried for call-site compatibility and deliberately not read: a serialisation that is frozen per task
   * cannot depend on a clock, and nothing here needs one.
   */
  now: number;
}

/**
 * Build T — π(r_1,…,r_ntr): the model's own reasoning for this task, in source order, inside a fixed frame.
 *
 * Returns the empty string whenever there is nothing to serialize (no anchor in the window, no trace text after
 * it, a zero ceiling, a ceiling too small for the frame), because an empty T costs zero tokens and the assembler
 * accounts for that specifically.
 */
export function buildStateProxy(input: StateProxyInput): string {
  const ceiling = Number.isFinite(input.maxChars) ? Math.max(0, Math.floor(input.maxChars)) : 0;
  if (ceiling === 0) return '';

  const anchorIndex = input.segments.findIndex((s) => s.id === input.anchorId);
  if (anchorIndex < 0) return '';

  // Everything the model produced *for this task* comes after the anchor in the append-only log, which is the
  // same append-order fact the tail block is built on. Source order is the array's order: the contract for
  // `segments` is append order and re-sorting here would paper over a caller that broke it rather than fail.
  const parts: string[] = [];
  for (const seg of input.segments.slice(anchorIndex + 1)) {
    if (!TRACE_KINDS.has(seg.kind)) continue;
    // Verbatim means verbatim: no trimming, no whitespace flattening, no per-line clipping. An empty segment is
    // the one thing dropped, because it contributes no characters and a blank line is not reasoning text.
    if (seg.text === '') continue;
    parts.push(seg.text);
  }
  const body = parts.join('\n\n');
  if (body === '') return '';

  const head = `${INTRO}\n${START}\n`;
  const foot = `\n${END}`;
  const budget = ceiling - head.length - foot.length;
  if (budget <= 0) return '';

  if (body.length <= budget) return `${head}${body}${foot}`;

  // The cut has to be marked *and* accounted for: the frame survives either way, so a truncated T is still a
  // well-formed `<trace_start>…<trace_end>` block rather than one whose closing delimiter was eaten.
  const marked = 1 + CUT.length;
  const tail = input.updatePolicy === 'perTurn';
  if (budget <= marked) {
    // No room for a marker. The bound still holds, which is the property that matters more than the label.
    const kept = tail ? body.slice(body.length - budget) : body.slice(0, budget);
    return `${head}${kept}${foot}`;
  }
  const room = budget - marked;
  const kept = tail ? `${body.slice(body.length - room)}\n${CUT}` : `${body.slice(0, room)}\n${CUT}`;
  return `${head}${kept}${foot}`;
}