/**
 * S1CAP core types — the contract shared by every package.
 * Mirrors docs/AGENT_BRIEF.md §4.
 *
 * **Field names are contracts with the rounds already recorded, not promises that a name never changes.** That is
 * the rule this tree follows, and it replaced "add fields, never rename" (docs/AGENT_BRIEF.md §0 rule 5) on
 * 2026-10-05, when this session renamed two fields and deleted a third: a rule the code violates is worse than no
 * rule, because the next reader has to work out which of the two the tree means. A field may be **renamed or
 * removed** when all three of these hold:
 *
 *   1. the old spelling is still read, and reported, rather than silently reinterpreted — `LEGACY_LAYOUT_KEYS` in
 *      `config.ts` translates the old key to its successor and refuses, with its own sentence, a value this build
 *      cannot honour (`xFirst: true` is the worked example: the layout it asked for was deleted, so it is an error
 *      and not a dropped key);
 *   2. a recorded round stays interpretable without the field, from the round's own artifacts — every assembly
 *      carries the literal `layoutOrder` and the resolved values it ran with (`AssemblyEvent`, `observer.ts`), so
 *      deleting a policy field never removes the evidence of what a round recorded;
 *   3. the *reason* is written beside the type, not only in the commit that did it, because the reason is what
 *      stops the removed idea coming back under a new name.
 *
 * The counter-rule is unchanged and is what makes point 1 load-bearing: a field may not be dropped *silently*.
 * Deleting a config path that a profile still writes is this project's most-repeated failure (a key that looks
 * configured and resolves to nothing), which is why every removal here leaves a reader behind.
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

/**
 * Which steps run the assembly at all — the type of `AssemblyPolicy.assemblyTrigger`, and the whole argument for
 * both of its values.
 *
 * `'every-step'` is the default since 2026-10-04, on the originating brief's own requirement. Idea 3 says the
 * recall is driven by "the user input *or* the model's own self-directed input", and idea 2 says every new session
 * event segment - "user input x, or LLM output o, tool results, etc." - feeds the association graph. A step that
 * claims no messages is still a step whose input the model chose, so `'claimed-only'` satisfied the first half of
 * that requirement and silently dropped the second: round `20261004-0205` measured C2 at **2 assemblies in 53
 * steps**, i.e. 51 steps of self-directed input with no recall at all. That is a mechanism not running as
 * specified, not a tuning preference, which is why the default moved rather than a round opting in.
 *
 * `'claimed-only'` is retained as a value, and the measurements that argued for it are retained with it.
 * `agent/pre-step` hands over `inbox.claim(target, turn)`, which is one user message on a turn's first step and an
 * empty array on every step after it (`docs/STATUS-ARCHIVE.md`, fault 2: "the step payload carries no history"), so
 * under `'claimed-only'` the walk, the anchor wait and T's rebuild ran on about one step per turn while the model
 * was called on every step. Round `20261003-2104` measures the consequence rather than the claim: **33 model
 * calls, 2 assemblies**, and only one of the two performed a real BFS walk (`bfsDepth 2`, `candidates 17`).
 *
 * `'every-step'` assembles on every step that will issue a request. At the hook the only facts that separate
 * such a step from the two that cannot receive anything are `decision.kind === 'reject'` and
 * `decision.signal.aborted === true`, both of which keep refusing under either value. The packaged loop appends
 * the decision and then builds and streams the request from the session log regardless of what
 * `decision.messages` holds (`dsh-agent-loop` L1061 / L1063 / L1072), and the measured round shows what that
 * means here: 33 steps, 33 `LLM calls`, one per step, turn ended `1:completed` — so an empty decision did not
 * mean "no request" in it. The one step left out is `step === 1` with nothing claimed: the harness's own guard
 * treats that as no step at all, the host's instructions plugin declines there too, and the evidence for
 * `'every-step'` is about the steps after the first.
 *
 * **The counter-argument is retained, and it is now a risk to watch rather than a reason for the default.** The
 * empty decision is also how the loop decides the turn is over (`if (turnEnds && decision.messages.length === 0)
 * break`, L962), and `turnEnds` is a local of the loop that the payload does not carry — so a plugin cannot tell a
 * terminal pre-step from an ordinary one. Returning a message at a terminal step would prevent the turn from
 * ending, and repeated, that is a livelock; `termination: 'model-owned'` says no S1CAP output may prolong or veto
 * the model's exit. `DEFECT-GATE.md` records this as D1's correction: the refusal on an empty decision was a design
 * decision, not a capability limit. Two things bound the exposure and neither removes it. The payload-id guard
 * refuses a step whose delivered text is byte-identical to one already sent, and `tas.updatePolicy: 'perTask'`
 * holds `T` still within a task — so a terminal step with no new selection is refused. A terminal step whose
 * selection *did* move produces a new payload and is delivered. So: **a round running `'every-step'` must read its
 * own turn/end count against its step count**, and a turn that fails to end where it ended under `'claimed-only'`
 * is this risk materialising, not a harness fault. The first such round is `20261004-0205`'s successor.
 *
 * No cell sets it — `cellPolicy()` leaves all three arms on the default on purpose, so that no measurement round
 * is confounded by a preset.
 */
export type AssemblyTrigger = 'claimed-only' | 'every-step';

/**
 * Which of the paper's two second-pass arms the recorded layout is — the type of `AssemblyPolicy.tracePlacement`,
 * and the **only** layout axis.
 *
 * The paper (arXiv:2609.02702 §3.2–4.1) runs three conditions over the same collected reasoning trace `T`, the
 * same long context `x` and the same question `q`, and it holds `q` fixed at the end of every one of them:
 *
 *     baseline:         M([x, q])
 *     Trace as State:   M([T, x, q])   the trace BEFORE the long context — the method
 *     Trace Append:     M([x, T, q])   the same trace AFTER the long context — the control
 *
 * "trace as state and trace append use the same long context x and the same textual task state proxy T, **with
 * order as the only difference**", and "**the question appears at the end of the prompt** … in every input". So the
 * variable is where `T` sits relative to `x`, `q` never moves, and this enum has exactly the paper's two values
 * rather than a description of the mechanism: `'trace-as-state'` *is* `M([T, x, q])` and `'trace-append'` *is*
 * `M([x, T, q])`, and neither name can be read for anything else.
 *
 * **`'trace-as-state'` is the default because it is the method this project is testing**, not because it happened
 * to be what ran before. It is worth recording how it became reachable, because the previous arrangement was
 * self-blocking: this axis used to carry the mechanism-named values `'before-context' | 'after-context'` and to
 * compose with a second axis — a boolean `xFirst`, renamed `questionPlacement: 'first' | 'last'` for a day — that
 * moved `q` in front of the context. Every cell preset set it, so the two combinations that existed on disk were
 * `[T, q, x]` (all three cells) and `[q, x]` (none), and **`M([T, x, q])` was unreachable without a non-default
 * override no cell ever set**: the project's two named arms were `M([T, x, q])` and `M([x, T, q])`, and round after
 * round it ran a third layout that is neither.
 *
 * **The second axis is deleted, not renamed (2026-10-05), and this enum is the only layout axis.** `q` is last by
 * construction — the paper fixes it there in every condition — so no setting can put it anywhere else, and the
 * value that used to ask for `q` first is refused rather than translated, because there is no layout here for it to
 * mean (`LEGACY_LAYOUT_KEYS` in `config.ts`). Renaming that axis to `questionPlacement` kept the wrong idea alive:
 * it left "the question's position is a variable" expressible, and its `'first'` value produced `[T, q, x]`, which
 * is neither of the paper's two arms. A field whose other value produces a layout the paper does not have is not a
 * variable, so it is removed rather than labelled.
 *
 * What the field does **not** do: decide whether `T` exists at all (`tas.on` does; with TAS off there is no `T` to
 * move and the recorded order is the paper's baseline `M([x, q])` under either value, which is the honest reading
 * rather than a silently inert setting).
 */
export type TracePlacement = 'trace-as-state' | 'trace-append';

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
   * Association-graph upkeep is asynchronous: new session events are folded into the graph off the
   * critical path, and the System-1 scoring they need is bought when a step's recall asks for it
   * (`AssemblyPolicy.recall`, "on demand" since 2026-10-05), so the graph may lag the session by up to
   * `maxLagTurns` turns.
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
    /**
     * Max chars of the serialized state proxy T.
     *
     * **The default is the paper's bound, not this project's.** "Trace as State" truncates the serialized trace "to
     * the first 50,000 characters to keep the second-pass prompt within the model's context capacity" (arXiv
     * 2609.02702), and the shipped default is 50 000 to match it. The value this field carried before that
     * decision — 8 000 — was inherited from the retired summariser and had no source behind it, so a cell running
     * the paper's recipe was cutting T at a sixth of its length and calling that the method.
     *
     * It stays configurable, because the bound is a *fidelity* decision as much as a size one: T is text the model
     * reads, and a round that needs less of it tunes this down rather than changing the layout. What it is **not**
     * is a budget decision, and it used to be described as one: T was "charged to the recall budget ahead of the
     * selection (`assembler.ts`: `fixedUsed` includes the proxy)", so a saturated T shrank the recalled block. That
     * cap (`recall.budgetRatio`) is gone, T and the recall no longer compete for tokens, and `budget.byBlock.stateProxy`
     * records what T cost as a measurement rather than as a deduction.
     */
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
       *
       * **Since 2026-10-05 it is the size of a *row*, and a row is what a walk buys.** With scoring on demand
       * (`AssemblyPolicy.recall.depth` below has the mechanism and the measurement), the lane's unit of work is one
       * row - one segment against its `min(index, w)` predecessors - so `w` bounds how large one System-1 request
       * can be rather than how much of the session is swept. At this build's defaults that is `16 <= 20 =
       * s1.questionsPerCall`: **one row is exactly one call**, which is also why the walk's latency is counted in
       * rows. The old reading - "the window bounds the quadrant of the arrival order that gets scored" - described
       * eager scoring, where the whole order was swept and `w` cut each segment's row; that sweep is gone from the
       * wiring (`packages/dsh-plugin/src/step-observer.ts`, whose queue handler no longer scores) and `scoreNew`
       * remains as the eager primitive the replay tools and the tests call.
       *
       * **The window still does nothing until it is smaller than the session's segment count**, and the default is 16
       * since 2026-10-05 for that reason. Round `20261004-1239` measured the lane against the session it had to
       * serve: 369.2 s of wall (6.2 min), 228 segments, and **16.1 questions/s** (5,958 questions in 369.2 s). The
       * lane's work is `sum_{i=1}^{N-1} min(i, w)` pairs, i.e. `w = 1024` offers 25,878 (all of them - the same
       * `N(N-1)/2` as `w = 512` and `w = 256`), 128 offers 20,928 (81 %), 64 offers 12,512 (48 %), 32 offers 6,768
       * (26 %) and **16 offers 3,512 (14 %, 3.6 min)**. The old `w = 1024` therefore bought nothing at this session
       * length and cost 26.7 min of lane against a 6.2 min session: **4.3x over its budget**, which is why the tail
       * of that round had no edges. Per segment the cost is `i` while `i < w` and `w` once `i > w`, so a `w` the
       * session never reaches leaves the cost **quadratic in the session** rather than linear in `w`.
       *
       * **What the default costs, and what `recall.depth` buys back.** A bounded walk reaches at most `w x d`
       * segments back along a chain of edges that clear `tau`, so this pair of values gives **16 x 8 = 128** where
       * the previous defaults gave `1024 x 2 = 2048` (everything, at this session length). That is a **shorter
       * reach, traded for a lane that fits inside the session it serves** - the window is not free, and a round that
       * needs the old reach back raises `recall.depth` rather than restoring a window that cost quadratic pair
       * scoring. BFS recall is still not *bounded* by `w`: the walk is bounded by `d` and `r`, segments outside the
       * window keep every edge they already have, and what a smaller `w` costs is the density of edges between new
       * and old segments - the loss `docs/FORMULAS.md` measures and states rather than hides.
       */
      window: number;
      /**
       * Bounded wait, in milliseconds, for the anchor segment's own row to be *judged by the backend* before
       * assembly.
       *
       * Default 10 000 (10 s), and `0` disables it entirely.
       *
       * Why it exists: scoring runs asynchronously in the upkeep queue, off the step's critical path, and a
       * System-1 relevance call is slow against the local backend - measured on round `20261004-1239`, 351 calls
       * at min 129 / p50 2 256 / p90 3 560 / max 4 015 ms. A step can therefore assemble before the segment it
       * recalls from - the anchor - has any scored edge, and BFS recall then returns nothing at all. The
       * fail-open rule in `assemble()` (`AssociationGraph.unjudgedWithin`, counted as `unknownAdmitted`) is the
       * backstop and stays: this wait makes it rarer, it has never replaced it.
       *
       * **The anchor is the step's newest *input event*, not its newest `user` segment** - one predicate decides
       * it (`isInputEvent`, `observer.ts`) and that segment is what `assemble()` walks from. This paragraph said
       * "the newest `user` segment" until 2026-10-05, which is true only on a turn-opening step: on every step
       * after it the anchor is the model's own message, tool call or tool result, and a reader who took the old
       * wording seriously would have looked for a row nobody was waiting on.
       *
       * **Since 2026-10-05 the wait *is* the scoring.** Scoring is on demand: the step's recall starts a walk
       * (`AssociationGraph.recallDemand`) whose first level is the anchor's own row, and this bound is the deadline
       * those demands are issued under - so the step waits for at most one call (a row is `min(index, w)` pairs, at
       * most `w` = 16 questions against `s1.questionsPerCall` = 20, i.e. exactly one request at this build's
       * defaults), and everything the walk buys after that lands in the background. `0` therefore does not disable
       * the lane, only the waiting: the walk is still started and its row still lands, for the next step that
       * recalls from it. Before that date this waited on a *sweep* somebody else was running, which is why the
       * round above gave up at 18 consecutive steps - see `recall.depth` and `docs/FORMULAS.md` for the mechanism's
       * measurement.
       *
       * "Judged" rather than "scored", because the wait has to outlast a *failed* call rather than a slow one: a
       * lexical row written in a session with no System-1 lane at all is not a row there is nothing left to wait
       * for, and stopping on it is what would let the fail-open rule stay silent through a round of backend
       * failures. A session with no lane scores its demanded rows locally and this wait reports `not-started`,
       * spending no time at all.
       */
      anchorWaitMs: number;
    /**
     * Bounded BFS depth d (`recall.depth`), and since 2026-10-05 it is the knob that carries the walk's reach:
     * **default 16, up from 2**, so the reach a round gets is `w x d` = `16 x 16` = **256** segments rather than the
     * 2,048 the `w = 1024, d = 2` defaults gave at this session length. The value is not a claim that a deeper walk
     * is free: the worst case stays `O(n^d)` over the graph (`docs/FORMULAS.md` §3.2, which states the bound and
     * what actually bounds the walk in practice), and `d` is the parameter the originating brief gives recall
     * alongside `tau`. What it replaced is stated where the value is: `AssemblyPolicy.recall.window` above.
     *
     * **Why 16 and not 8: `d` costs nothing on the scoring axis, and it is the only thing that extends the reach of
     * a sparse graph.** Two measured facts, and the second one is the one a reader must not overread:
     *
     *   1. **`sum_{i=1}^{N-1} min(i, w)` contains no `d`.** At `w = 16` over round `20261004-1239`'s 228 segments the
     *      lane's work is 3,512 pairs (3.6 min at 16.1 questions/s) whatever `d` is, against 25,878 (26.7 min) at
     *      `w = 1024`. Raising `d` from 8 to 16 therefore spends **nothing** on that axis.
     *   2. **Depth saturates on a dense graph.** Simulated read-only on that round's frozen graph, backwards-only
     *      with `tau` applied, averaged over all 228 anchors: mean reach 8.8 at `d = 1`, 20.4 at `d = 2`, 21.7 at
     *      `d = 4`, and **21.8 at `d = 8` and `d = 16` - identical** (max reach 75 / 105 / 105 / 105 / 105, mean
     *      recalled tokens 2,120 / 4,821 / 5,181 / 5,189 / 5,189). **That graph was built at `w = 1024`, where two
     *      hops already saturate it, so the flat tail measures "`d` is free", not "`d` is useless".** A `w = 16`
     *      graph is far sparser - at most 16 neighbours per node - and on it the reach really is `w x d`, so `d` is
     *      the only knob that extends it. Which depth that sparse graph needs is a question for a round at `w = 16`;
     *      until one runs, 16 is the value of a knob that is free here and is the trade's other end.
     *
     * **Scoring is on demand since 2026-10-05, and this is the sentence that said it would be.** `d` is no longer
     * free: a pair is bought when a *walk* demands the row that holds it (`AssociationGraph.recallDemand`, wired at
     * `packages/dsh-plugin/src/step-observer.ts`), and a walk that goes deeper reaches more nodes, which are more
     * rows, which are more pairs. The upper bound is unchanged - a walk cannot demand more rows than the session
     * has - so what `d` moves is where on the curve between "the anchor's own row" and "the whole session" a step
     * lands. Measured read-only on round `20261004-1458`'s frozen graph (170 segments, `w = 16`, `tau = 0.55`, that
     * round's own 19 assemblies), the rows the walks demand at each depth, as `sum min(index, w)` pairs:
     *
     *   | `d` | rows | pairs | against the eager `sum_{i=1}^{169} min(i,16) = 2 584` |
     *   |---|---|---|---|
     *   | 1 | 18 | 263 | 10 % |
     *   | 2 | 100 | 1 480 | 57 % |
     *   | 4 | 155 | 2 360 | 91 % |
     *   | 8 | 164 | 2 504 | 97 % |
     *   | 16 | 164 | 2 504 | 97 % |
     *
     * Two things that table is not. It is **not** a saving: at `tau = 0.55` - which is the median of that round's
     * score distribution, so half of all pairs are edges and the graph is 46 % dense with a mean degree of 14.1 of
     * a possible 16 - the walk spreads to nearly the whole graph and on-demand scoring buys 97 % of what eager
     * scoring bought. The saving is a function of the *threshold*, and it is measured at a stricter one:
     * `tau = 0.60` gives 66 rows / 941 pairs (64 % below eager) and `tau = 0.70` gives 18 rows / 263 pairs (90 %
     * below), both on the same frozen graph. And it is **not** the whole benefit even at `tau = 0.55`: the *order*
     * half is separate and does not depend on the threshold at all - eager scoring walks the append order from its
     * oldest entry, so serving one step's anchor costs it a median **1 784 pairs before that row** on that round,
     * while the walk's first row is the anchor's own (16 pairs, one call). `docs/FORMULAS.md` carries the full
     * table, the arithmetic and the segments-per-step it assumes.
     *
     * **What did not change: the reach, and `w`'s job.** A walk still reaches what `d` and `tau` allow and `w`
     * still decides only whether a *pair* exists - so a smaller `w` costs edge density between new and old
     * segments, exactly as `AssemblyPolicy.recall.window` says, and `d` is still the knob that buys reach back.
     * What moved is the price of that reach: it was free on the scoring axis and is now billed there.
     *
     * **The validator's cap moved with it** (`packages/core/src/config.ts`, `NUMBER_RULES`: `recall.depth` was
     * 1..6 and is 1..16 now). The cap exists so a profile cannot ask for a walk this build was not shaped for, and
     * it was 6 because nothing needed deeper; `w = 16` gives a 16-segment reach at the old defaults, and raising the
     * window instead is what the measurement above rejects, so the cap is what moves.
     */
    depth: number;
    /**
     * **A `fanout` field sat here until 2026-10-05, and its absence is the correction rather than a gap.**
     *
     * It was `k`, the per-node expansion cap, and it fails the same three tests the `budgetRatio` note further
     * down this interface applies to a recall knob: is it in the brief, is it in the record, can a researcher set
     * it. It is not in the originating brief (`prompt.txt`), which bounds
     * recall with exactly two things, `recall.depth` (d) and `recall.threshold` (r), and gives `recall.window`
     * (w) one job stated in the brief's own words: it exists *only* to save System-1 calls and must not affect
     * the walk. It is in no settings panel - the plugin's `Tuning` surface carries `depth`,
     * `relevanceThreshold`, `window`, `anchorWaitMs` and `tracePlacement`, and nothing else - so a researcher
     * could not tune it. And it is in no record: the tape's `kind:"wiring"` record states
     * `recall: {d, r, w, wait, tier1}` and the round `manifest.json` names no such field. The one place it
     * existed was the three cell presets, at `"fanout": 8`, and `C2.json`'s own `provider` note says of that
     * file *"treat that record [`kind:\"wiring\"`], not this file, as the authority"* - so a parameter that
     * decided behaviour lived only where the project says the authority is not.
     *
     * **The argument for keeping it was wrong, and that is measured rather than argued.** It was justified by
     * the claim that without `k` a depth-2 walk reaches essentially the whole graph, which would make `depth`
     * meaningless; the arithmetic behind that claim took the mean edge degree and derived
     * `1 + 37.6 + 37.6^2 = 1450 > 228` (the segment count). That reasoning ignored the "steps go into a segment
     * earlier in the append order" constraint the walk carries, and the simulation on round `20261004-1239`'s
     * frozen graph contradicts it: walking from **every** segment as anchor, backwards-only, at depth 2, the
     * reachable sets under `k = 8` and under an unbounded `k` are **identical for 63.2 % of anchors** - they
     * differ for 84 of 228. An unbounded depth-2 walk that reached the whole graph could not agree with a
     * capped one that often. The simulation, its anchors and its full table are in the 2026-10-05 correction
     * on `R_d(x)` at the foot of `docs/FORMULAS.md`; this field does not restate them.
     *
     * **What it cost, recorded rather than hidden:** for the 36.8 % of anchors where the cap did bite,
     * removing it selects **more** segments - median **+27**, worst **+69** - so the `recalled` block can grow
     * on those steps. That trade is now made by `recall.threshold`, which is the brief's own knob and **is** in
     * the panel; a reader who wants a tighter block lowers `r`.
     *
     * **On the round it was measured against, nothing changes.** In `round-20261004-1239` the walk returned
     * `candidates = 0` from invocation 9 onward - the System-1 lane was 4.6x too slow to score the pairs, so
     * the tail had no edges - and `fanout` therefore had no effect on any recorded number. Removing it changes
     * the design, not that round's data. Rounds recorded with it (`20261004-0233`, `20261004-1211`,
     * `20261004-1239` and earlier) stay readable: the field is gone from the policy, and a profile or preset
     * that still writes it is read and reported rather than dropped in silence (`packages/core/src/config.ts`,
     * `LEGACY_POLICY_KEYS`).
     */
    /**
     * Which tier-1 candidate generator runs. **`'s1'` and `'off'` are the implemented values and they are the only
     * ones** (2026-10-02).
     *
     * The design (`docs/FORMULAS.md` §2) defines tier-1 as a choice between an embedding ANN and one batched
     * `noul` call. Only the second exists. A grep for `embed`/`embedding` across every `src/` tree under
     * `packages/` returns this
     * field, its default, one comment and one `EdgeSource` value nothing assigns - no embedder, no index - and
     * `source: 'embed'` is never written to an edge: the recorded graph of round `20261002-2037` holds `s1-noul`
     * 1 824, `lexical` 253 976 and **0** embed edges. The only read of this field anywhere in the implementation
     * was `policy.recall.tier1 !== 'off'` (`packages/core/src/assembler.ts`), so a cell that declared `'embed'`
     * ran `'s1'` and was described by a mechanism it did not use - the "composes, appears in every dump, is never
     * read" pattern this repository keeps finding. C2's recipe names the tier that runs.
     *
     * A legacy `'embed'` is therefore **rejected**, not treated as "not off": `validatePolicy`
     * (`packages/core/src/config.ts`) gives it its own error naming the missing implementation and keeps the
     * cell's own value. `'off'` keeps its meaning exactly - it disables recall *selection*, while association-graph
     * upkeep is not gated on it and keeps running.
     */
    tier1: 'off' | 's1';
    /**
     * Declared, and read by nothing: it is the embed mode's model name (see `tier1`), and that mode is not
     * implemented. A **non-empty** value is reported by `validatePolicy` as a warning, so a profile cannot set it
     * and believe an embedder is running; the empty string - what `cordis.patch.yml` ships - means "not set" and
     * is silent. Kept rather than deleted because removing a config path is its own decision, and because the
     * warning is what makes the field's status readable from a run instead of from a grep.
     */
    embedModel?: string;
    /*
     * **There is deliberately no token cap in this section, and the absence is a decision rather than a gap.**
     *
     * A `budgetRatio` (ρ) used to sit here: `min(floor(total × ρ), remaining)` tokens for the recalled block,
     * default 0.35, and a candidate that cleared `threshold` and lay inside `depth` was still dropped if it did not
     * fit. **It is not in the originating brief.** The brief (成本, line 18) names tokens only as a *measurement* —
     * cached-input / uncached-input / output — never as a limit, and it declares exactly three tunable recall
     * parameters: `recall.depth` (d), `recall.threshold` (r) and `recall.window` (w), with d and r deciding what is
     * recalled and w existing "only to save System-1 calls" and explicitly not affecting the walk. The cap also
     * coupled two things the brief keeps apart: `fixedUsed` counted the serialized trace T, so a larger T shrank
     * the recall allowance and the two competed for the same tokens.
     *
     * What bounds the block instead is `r` and `d`, plus the correctness filters in `assembler.ts` — the structural
     * exclusions (pinned/tail/anchor), the anchor's sibling chunks, and the passage chunk de-duplication. Those
     * remove content that is false, already in the prompt, or duplicated; none of them drops a candidate for its
     * size, which is the distinction the cap blurred and `assemble()`'s own comment states.
     *
     * Overflow is the harness's job. S1CAP injects through `agent/pre-step`, which commits the block to the session
     * log as an ordinary surface node with its own seq, so `@deepseek-ai/dsh-compaction-basic` and
     * `@deepseek-ai/dsh-compaction-tool-result-pruner` (both wired into every cell profile) see it like any other
     * message and decide when the log is too long. S1CAP adds context and never rewrites or suppresses.
     *
     * **Measured, so the removal is not a leap of faith** (round `20261004-0233`, cell C2): the cap never bound —
     * `budgetTotal` 118 800, `budgetUsed` peaking at 6 399, which is 5.4% of the budget and 9.2% of the 41 580 the
     * ratio allowed. Deleting it changed no recorded step; what it removes is a latent divergence between the
     * brief's selection rule and the code's. Do not reintroduce a ceiling here — not a share, not a "max selected",
     * not a token ceiling — without the owner deciding to: that is a change to the method, not to a field.
     */
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
     * **The share is taken of `remaining`** (the room the window has left for context after the fixed blocks), not
     * of `floor(total × ρ)`: removing the cap removed the allowance this floor used to be a share *of*. At μ = 0 —
     * the default, and every cell — the comparison is `used < 0`, which is false by construction, so the floor is
     * genuinely inert; a profile that opts in gets a floor whose effective threshold is roughly `μ × total`, i.e.
     * higher than the ρ-based one it replaces, and should re-tune it rather than assume the old number.
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
   * Which of the paper's second-pass arms the layout is: `'trace-as-state'` (`M([T, x, q])`, the method, the
   * default) or `'trace-append'` (`M([x, T, q])`, the control). **The only layout axis.** The question is last by
   * construction — see `TracePlacement` for the paper's three literal orders, for what the older mechanism-named
   * field (`stateProxyPosition: 'before-context' | 'after-context'`) was, and for the second axis that used to
   * move `q` and was deleted on 2026-10-05 rather than renamed.
   *
   * No cell preset sets it, for the same reason no cell sets `assemblyTrigger`: a round that wants the control arm
   * flips it in one profile and moves one variable, and a preset carrying it would put a cell on one side of the
   * paper's own control and redefine which arm that cell *is*. All three cells therefore run the default, which is
   * the method under test, and the round that needs the contrast writes `tracePlacement: trace-append` in its own
   * patch.
   */
  tracePlacement: TracePlacement;
  /**
   * Does the assembled view actually reach the model?
   *
   * `false` is the honest default: with it off, `agent/pre-step` returns the harness's own decision untouched and
   * the layout is recorded but not delivered. That was the state of this project until `context-delivery.ts`
   * existed, and it is why the ablation cells had nothing to ablate — every cell produced a layout record and the
   * model saw the full history in all of them.
   *
   * **What it gates changed on 2026-10-04: it gates the whole injected message, and that message carries the
   * state proxy.** `deliverContext` now renders `T` between the paper's `<trace_start>`/`<trace_end>` delimiters
   * and then the quoted recalled turns, in one insertion, with no second switch — `tas.on` implies `T` is
   * delivered, because delivering `T` is the method (`packages/dsh-plugin/src/context-delivery.ts`). What the
   * switch still decides is narrower and is worth stating precisely: **whether the arm owns context management at
   * all.** A cell with it off records a layout and delivers none of it.
   *
   * The consequence is that a delivering cell no longer needs a recall selection. With `tier1: 'off'` the recalled
   * block is empty by construction (the walk, the unjudged fail-open and the recency fallback all sit behind one
   * guard in `assemble()`), but `T` alone is a delivery — which is exactly what re-opened C1 and turned the
   * registered arm structure into the paper's own:
   *
   *   | arm | delivers          | what the C0→X or X→C2 step isolates                    |
   *   | --- | ----------------- | --------------------------------------------------------- |
   *   | C0  | nothing           | baseline; the harness manages history natively               |
   *   | C1  | **`T` only**      | the paper's placement effect, System-1 lane absent           |
   *   | C2  | `T` + recall turns| S1CAP's recall contribution on top of the paper's effect     |
   *
   * `C0 → C1` is the paper's contrast and `C1 → C2` is S1's, and C1 keeps `s1.provider: 'none'` so the TAS claim
   * stays measurable with the System-1 lane *absent* rather than merely unscoped.
   *
   * **Still not reachable from here, and unchanged by any of the above:** the layout axis (`tracePlacement`)
   * does not reach the model. The one insertion channel appends, so what is injected is `T` followed by the
   * recalled turns regardless of the order the assembler recorded; reproducing the paper's literal
   * `[T, x, q]` needs a channel that delivers the whole layout (`docs/ARCHITECTURE.md` marks it 🔜,
   * `packages/proxy` is not written). The recorded `layout.order` remains the evidence of which layout ran; the
   * delivered text is not evidence of it. That distinction is why the arm correction above is a correction to the
   * *record*: the delivered text of C1 and C2 is unchanged by it, and what changed is which order those cells can
   * truthfully claim to have laid out.
   */
  deliver: boolean;
  assemblyTrigger: AssemblyTrigger;
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
   * the role it was supposed to play in C2 was never played by it, and nothing takes over. The honest reading of
   * that round is that the ordering half of "full configuration" reached the model in neither C1 nor C2 - C1
   * delivered nothing at all, and C2's one delivery channel inserts the `recalled` block and never the ordered
   * layout (see `deliver` above) - so any future arm that wants a plan gate, or wants to attribute anything to
   * the ordering, has to feed it a channel the model actually reads.
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
     * lexical fallback. The deadline now lives in the client as `s1TransportGuardMs(questionsPerCall)` - a base
     * plus a per-question cost, not a constant - where the concern actually belongs, a request that never returns,
     * and where nobody can tune it into a quality switch. It stopped being a constant on 2026-10-05 because a
     * `30_000` guard was below the genuine service time of a large batch on a throttled device: the guard is now
     * `10_000 + 1_250 x questions`, so a 64-question call is allowed 90 s while a one-question call still dies in
     * 11.25 s. The `timeoutMs` field stays gone for the reason above.
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
  /**
   * The step's newest input event — the paper's `x`. It is the user's own question at a turn-opening step, and the
   * model's message, tool call or tool result on every step after it (`observer.ts`, `isInputEvent`), so "the
   * current user input" is only one of the things it can be.
   *
   * It is the **last** block of `order`, unconditionally: the paper places the question at the end of every input,
   * `q` is last by construction in this build, and nothing here can put a block behind the anchor. (Until
   * 2026-10-05 a layout override could, which is the arrangement that was deleted rather than renamed.)
   */
  anchor: Segment;
  /**
   * The actual block order this result was built in, so the layout is observable rather than implied by the
   * order of the fields above. `tracePlacement` is the only axis; the question is last by construction:
   *
   * | `tracePlacement`  | `tas.on` | `order`                                      | paper arm                          |
   * | ----------------- | -------- | -------------------------------------------- | ---------------------------------- |
   * | `trace-as-state`  | true     | `pinned, stateProxy, tail, recalled, anchor` | **Trace as State**, `M([T, x, q])` |
   * | `trace-append`    | true     | `pinned, tail, recalled, stateProxy, anchor` | **Trace Append**, `M([x, T, q])`   |
   * | either            | false    | `pinned, tail, recalled, anchor`             | the baseline, `M([x, q])`          |
   *
   * The two TAS-on rows are the paper's two arms and they are what the default configuration lays out: `q` is in
   * the same slot in both, so `tracePlacement` alone selects between Trace as State and Trace Append — the
   * contrast the paper's second pass is built on. With TAS off there is no T to move, so the arm is inert rather
   * than absent and the recorded order is the paper's baseline.
   *
   * **`recalled` is the last block of the long context in every row, and the long context is what `x` names.** The
   * `order` array says which blocks make up the paper's `x`: `pinned` is the system prompt and tool schemas rather
   * than context, `anchor` **is** `q`, and the blocks between them — `tail` and `recalled` — are the long context
   * the trace is placed around (`packages/dsh-plugin/src/context-delivery.ts`: "the long context here is the
   * `recalled` block"). So a change to where `recalled` sits *inside* `x` is not a change to the paper's variable,
   * which is where `T` sits relative to `x`: under `'trace-as-state'` T is still ahead of every block of `x` and
   * under `'trace-append'` still behind all of them. What the internal order of `x` decides is the prompt's cache
   * behaviour, which is why `recalled` — the one block that moves between steps — is placed last within it: a
   * change there breaks the cached prefix only from that point on, so what is behind it is the question and nothing
   * else. `cacheStability` below carries the arithmetic, and `assembler.ts`'s `AssembleInput.recallOrder` carries
   * the ordering rule and its measurement.
   *
   * **This string is the evidence a reader of a round checks, and it is what keeps the pre-2026-10-05 layouts
   * readable.** Rounds on disk recorded `pinned, stateProxy, anchor, recalled, tail` (C1 and C2, both of them
   * question-second) and `pinned, anchor, recalled, tail` (C0, question-first), and **no setting here produces
   * either any more**: both put the question in the middle or at the head of the prompt, which is exactly what the
   * deleted axis allowed and the paper does not have. A third form — `pinned, stateProxy, recalled, tail, anchor`,
   * which is what this build recorded between 2026-10-05's layout correction and the cache-stability change that
   * followed it — is likewise no longer producible: `recalled` is behind `tail` now. The recorded string is
   * self-describing, so no round needs re-reading; what changed is that the layouts those rounds recorded can no
   * longer be produced, which is the correction rather than a loss.
   */
  order: string[];
}

export interface AssemblyResult {
  layout: AssemblyLayout;
  /**
   * The step's token **measurements** — not an allowance the selection was held to.
   *
   * `total` is what the step's window leaves after the output reserve and the fixed overhead; `used` is the size of
   * the view this call assembled, every block included; `byBlock` is the same number split by block. Both are
   * written to the control plane as `budgetTotal`/`budgetUsed` and a round reads them as cost, so their meaning is
   * fixed here rather than left to the reader.
   *
   * **`used` may exceed `total`, and that is not a defect in the arithmetic.** Selection is bounded by `r` and `d`
   * and not by tokens (see `AssemblyPolicy.recall`), so a step that selects a lot assembles a view larger than the
   * window budget leaves room for; what responds to that is the harness's compaction, which sees the injected block
   * as an ordinary surface node. Until 2026-10-05 a `recall.budgetRatio` cap kept `used <= total` by dropping
   * candidates that had already cleared `r` and lay inside `d` — the rule that was removed — so a reader who finds
   * `used > total` in a record is reading a step that spent more than the window budget, not a miscount.
   */
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
     * pinned, `tail` (which sits in front of the block that moves), plus **T only while
     * `tracePlacement: 'trace-as-state'` keeps it in front of the recalled block**. Add-only, because
     * `prefixTokensStable` already means something narrower and redefining it would silently break the recorded
     * acceptance test.
     *
     * The question is behind this head in every layout, and that is now a fact about the build rather than about a
     * setting: `q` is last by construction (the paper places it at the end of every input), so the block that used
     * to be counted here when a profile moved it forward cannot exist. `'trace-append'` is the arm the prefix cache
     * pays for: T is no longer in the head, so the head is the pinned prefix plus the tail, and everything in front
     * of T re-prefills when the selection changes. That cost is a fact about the arm, not a bug in it, which is why
     * it is computed from the layout rather than assumed.
     */
    layoutStableTokens: number;
    /**
     * The first block after the stable head: where a re-selection would cut the prefix.
     *
     * `'recalled'` whenever the block has anything in it, because `recalled` is the block that moves and the head is
     * everything in front of it; `'stateProxy'` when `tracePlacement: 'trace-as-state'` puts a non-empty T in the
     * head and the recalled block is empty; `'pinned'` otherwise.
     */
    cutAfterBlock: string;
    /**
     * Tokens behind that cut, i.e. what one re-prefill costs. The input `decideReselect` prices, and the reason
     * the layout is a cache decision at all: with the question last — the only arrangement this build produces —
     * everything behind the stable head (the pinned prefix, `tail`, and T when the arm keeps T in front) is the
     * moving part, which is the recalled block and then the question.
     */
    tokensAfterCut: number;
  };
  /** recall diagnostics for telemetry */
  recall: {
    candidates: number;
    selected: number;
    bfsDepth: number;
    /**
     * Recall hits whose complete text was already contained in a selected sibling
     * of the same passage. Distinct sibling chunks are retained.
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
   * Every hit `AssociationGraph.recall` returned is in it, including the ones the passage de-duplication then
   * dropped: what the selector found is the thing being recorded. Always present - `{}` states that the walk
   * produced nothing (recall was not run, or it found no hit), which is a different fact from a record without the
   * field.
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
 * is the safe default — and it is a *base* default rather than a C2 claim: `cellPolicy` turns it on for C1 and C2
 * and leaves it off for C0, which is the delivery axis of the ablation (see `AssemblyPolicy.deliver`).
 */
export function defaultPolicy(): AssemblyPolicy {
  return {
    cell: 'C2',
    termination: 'model-owned',
    assemblyDeadlineMs: 250,
    rgMaintenance: { mode: 'async', maxLagTurns: 2 },
    cache: { reselectPolicy: 'perTask', blockTokens: 64 },
    tas: { on: true, tMaxChars: 50_000, updatePolicy: 'perTask' },
    recall: {
      threshold: 0.55,
      // 16, not 1024: the window does nothing until it is below the session's segment count, and on the round the
      // lane was measured against (`20261004-1239`, 228 segments) `1024` offered every pair while costing 26.7 min
      // of lane against a 6.2 min session. `AssemblyPolicy.recall.window` above carries the arithmetic.
      window: 16,
      anchorWaitMs: 10_000,
      // 16, not 2: what a bounded walk reaches is `w x d`, so the window's reduction is paid back here rather than
      // by restoring a window that cost quadratic pair scoring - and `d` costs the lane nothing (the pair count
      // contains no `d`). See `AssemblyPolicy.recall.depth`.
      depth: 16,
      tier1: 's1',
      embedModel: '',
      minRecalledShare: 0,
      minRecalledSegments: 1,
    },
    tail: { k: 3 },
    // **The method under test, and therefore the default — and the only layout axis.** `'trace-as-state'` is
    // `M([T, x, q])` — the trace in front of the long context, which is what "Trace as State" names and what the
    // project exists to measure. `'trace-append'` is the paper's own control (`M([x, T, q])`, the same two elements
    // with order as the only difference). It stays a value and no cell preset sets it for the reason
    // `assemblyTrigger` is left alone: the contrast is measured by *running both arms*, so a preset carrying one
    // side would redefine which arm that cell is - and a round that wants the control writes one key in its own
    // profile patch.
    //
    // The question is not a field here any more, and its absence is the correction: `q` is the last block of
    // `layout.order` unconditionally, because the paper separates the question from the long context and places it
    // "at the end of every input" (arXiv:2609.02702 §4.1) in all three of its conditions. Until 2026-10-05 a second
    // axis - a boolean `xFirst`, renamed `questionPlacement` for a day - could move it, and its default put the
    // question *second* (`[T, q, x]`) in all three cells: a layout the paper does not have, while the two orders
    // the project named its arms after were both unreachable without an override no preset wrote. Deleting the
    // axis, rather than renaming it, is what makes `tracePlacement` the only thing a round can vary about the
    // order.
    tracePlacement: 'trace-as-state',
    deliver: false,
    // The project's own requirement, not a tuning value: the originating brief says recall is driven by "the user
    // input *or* the model's own self-directed input" (idea 3) and that every new session event segment - "user
    // input x, or LLM output o, tool results, etc." - feeds the association graph (idea 2). A step that claims no
    // messages is still a step whose input the model chose, so `'claimed-only'` assembles on the user's turn and
    // then goes quiet for the rest of it: round `20261004-0205` measured that as **2 assemblies in 53 steps** in
    // C2, i.e. 51 steps of self-directed input with no recall at all. `'every-step'` is therefore the default.
    // `'claimed-only'` is kept as a value because the round that measured it is on disk and has to stay readable.
    assemblyTrigger: 'every-step',
    s1: { provider: 'jev', baseUrl: '', model: '', apiKey: '', questionsPerCall: 20, retryAttempts: 1, admissionLimit: 2 },
  };
}

/**
 * Ablation cell presets (docs/AGENT_BRIEF.md §9.1): C0 the baseline, C1 the paper's arm (the trace is delivered,
 * with no recall selection and no System-1 lane), C2 the full configuration.
 *
 * **The registered contrasts are `C0 → C1` and `C1 → C2`**, the paper's own two steps: what the trace's presence
 * buys, and what the recall selection buys on top of it. `C0 → C2` alone conflated them once `T` became
 * deliverable, which is why C1 was re-opened on 2026-10-04 after a day's re-registration as a placebo.
 *
 * `assemblyTrigger` is deliberately absent from every case below: all three arms run the default
 * `'every-step'`, which the brief requires, so that no cell silently runs a half-mechanism
 * and not a cell. `authority.test.ts` fails if a preset ever starts carrying it.
 *
 * **`tracePlacement` is the only layout axis, and `q` is last in every cell by construction.** Neither is set
 * below, so every cell lays out the paper's arrangement: the question last — the last block of `layout.order` is
 * `anchor` whatever the cell is, because the paper separates the question from the long context and places it "at
 * the end of every input" (arXiv:2609.02702 §4.1), with `[T, x, q]` and `[x, T, q]` as its two literal orders — and
 * the trace in front of the long context (`tracePlacement: 'trace-as-state'`, which is `M([T, x, q])`, the method).
 * Before 2026-10-05 each cell set a boolean `xFirst: true` that moved the anchor instead, so all three recorded
 * `[T, q, x]` — a layout the paper does not have, while the two names the project used for its arms
 * (`[T, x, q]` and `[x, T, q]`) were both unreachable without an override no cell ever wrote.
 *
 * The correction **deleted the second axis rather than renaming it**. Renaming it to
 * `questionPlacement: 'first' | 'last'` kept the wrong idea alive: it left "the question's position is a variable"
 * expressible, and `'first'` produced `[T, q, x]`, which is neither paper arm. A field whose only other value lays
 * out a condition the paper does not have is not a variable, so a profile that still spells the old key is read
 * and reported (`LEGACY_LAYOUT_KEYS` in `config.ts`) and the value that asked for `q` first is refused there
 * rather than translated. `authority.test.ts` asserts the arm and the recorded order for all three cells.
 *
 * `tracePlacement` itself stays out of the presets for the reason `assemblyTrigger` does: it is the paper's
 * Trace-as-State vs Trace-Append contrast, and that contrast is only measured by running both arms. A preset
 * carrying a value would put a cell on one side of the paper's own control and quietly redefine which arm that cell
 * *is*; a round that wants the control writes `tracePlacement: trace-append` in one profile.
 */
export function cellPolicy(cell: Cell): AssemblyPolicy {
  const p = defaultPolicy();
  p.cell = cell;
  // **No cell sets a switch here any more (2026-10-05).** What this returns is `defaultPolicy()` with the cell's
  // name on it; the cell's *configuration* is `bench/cells/<cell>.json`, folded in as a layer by `mergeCellPreset`
  // (`packages/core/src/cell-preset.ts`) and resolved by `validatePolicy`. Precedence is
  // `defaultPolicy()` < cell preset < explicit config in the profile patch.
  //
  // Why the six assignments that used to live here are gone - `tas.on` and `recall.tier1` for C0, `recall.tier1`
  // for C1 and C2, and `deliver` for all three (that one moved earlier the same day):
  //
  //   - **A switch a cell *is* belongs in the file a reader compares against the run.** These were code, so a
  //     researcher could not change them - not even through the settings panel, which owns `depth`,
  //     `relevanceThreshold`, `window`, `anchorWaitMs` and `tracePlacement` and nothing else. That is the same
  //     defect `recall.fanout` was deleted for: a parameter that decides behaviour, reachable only by editing source.
  //   - **The record now carries the result and its provenance.** The wiring record's
  //     `cellPreset: {file, fromPreset, overridden}` names which fields the JSON supplied and which the profile patch
  //     then replaced, so "which value ran, and where did it come from" is readable without opening this file. The
  //     protection `check-doc-pointers.mjs`'s `preset-override` rule provided did not disappear; it moved from "a
  //     preset may not carry this" to "a preset may carry this and the tape says so".
  //
  // What still cannot be reached from a preset, and why: `tracePlacement` (below) and `assemblyTrigger` are the
  // paper's arm and the assembly trigger, and a preset carrying either would put one cell on one side of a contrast
  // the paper defines. They stay code-owned, and `CODE_OWNED_SWITCHES` in the checker still refuses the first.
  //
  // The history those six assignments recorded is kept below, because each line is a measurement rather than a
  // preference, and a reader comparing this build with a round recorded before 2026-10-05 needs it:
  //
  //  * **C0 is the baseline**: chronological append, native compaction only, no trace, no selection, and it delivers
  //    nothing at all - so what it measures is the harness doing what it would have done anyway. It lays out
  //    `M([x, q])`, the long context then the question, which is what the defaults produce with TAS off. The
  //    `xFirst = false` that used to sit here was written to make the baseline chronological, and it recorded
  //    `pinned, anchor, recalled, tail`: the question *first*, which is the baseline of no paper arm either. The
  //    paper's baseline ends in `q` like its two other conditions, and this cell now does too - with the second axis
  //    deleted, `layout.order` ends in `anchor` and there is no setting that can say otherwise.
  //  * **C1 is the paper's Trace-as-State arm with the System-1 lane absent** (`s1.provider: 'none'` in its preset),
  //    re-opened 2026-10-04 because every fact that had closed it stopped being true. It was closed while delivery
  //    inserted the `recalled` block and nothing else and `tier1: 'off'` made that block empty by construction, so
  //    every assembly was refused with "nothing to insert" and the arm was a placebo - round `20261002-2037`: 76
  //    assemblies, 0 with a non-empty recalled block; round `20261001-1300`: 13 assemblies, 13 refusals, 0
  //    `delivered: true`. `tas.on` now implies `T` is delivered (`packages/dsh-plugin/src/context-delivery.ts`), so
  //    this arm's channel carries the trace alone and fires: `C0 -> C1` is the trace's contrast with the lane out,
  //    and `C1 -> C2` is the recall selection on top of it. Leaving it closed would conflate those two variables in
  //    every C0-vs-C2 comparison.
  //  * **The honest part that survives for both arms: the layout axis reaches the model in no arm.** The one
  //    insertion channel appends, so the injected message is `T` followed by the recalled turns whatever the recorded
  //    order was; the layout axis is measured in `layout.order`, not in the delivered text. C1 is a control over
  //    recall selection and over the lane, not over the layout.
  //  * **`tier1: 's1'` for C2** states the mechanism the full configuration runs - the one batched `noul` call that
  //    exists. Until 2026-10-02 the preset said `'embed'`, a mode with no implementation anywhere, read by exactly
  //    one test (`!== 'off'`), so a cell declared a mechanism it did not use.
  return p;
}
