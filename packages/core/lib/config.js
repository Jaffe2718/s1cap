/**
 * Policy validation and normalisation (docs/AGENT_BRIEF.md §4).
 *
 * Zero-dependency so `node --test` runs it without an install step; the DSH production path
 * mirrors exactly these rules in a schemastery schema (M1).
 *
 * Fail-safe by design: an invalid value is reported and the default is kept, because a live
 * harness must never break a session over a typo in config.
 */
                                                       
import { cellPolicy, defaultPolicy } from './types.js';

                                           

                        
               
                  
                     
 

                                   
              
                  
                  
                    
                                                   
                         
 

const CELLS                  = ['C0', 'C1', 'C2'];

                      
               
              
              
                    
 

/** Numeric bounds: thresholds, budgets, caps and timings. */
export const NUMBER_RULES                        = [
  // NOT ENFORCED. The type calls this "hard deadline for the synchronous per-call assembly hook; on expiry the
  // call passes through unmodified", and nothing enforces a deadline: the value is read once, to print on `/s1`
  // and in the status route's `effective` block. The documented entry comment beside it says 250 ms, and the
  // bounded wait that actually runs is `recall.anchorWaitMs` - 10 000 ms by default, forty times larger - so the
  // two numbers in one policy object contradict each other. See `UNENFORCED_KNOBS` below, which is the one place
  // this is stated in a form a test can check.
  { path: 'assemblyDeadlineMs', min: 1, max: 10_000, integer: true },
  // NOT ENFORCED as a lag in turns. Read as "how far the graph may lag the session, in turns", and the queue
  // compares it against a count of *pending events*, which nothing acts on. See `UNENFORCED_KNOBS`.
  { path: 'rgMaintenance.maxLagTurns', min: 0, max: 100, integer: true },
  // NOT ENFORCED. `alignToCacheBlocks(tokens, blockTokens)` exists and is called by nothing; the assembler
  // records cache-stability numbers and never aligns to a block boundary. See `UNENFORCED_KNOBS`.
  { path: 'cache.blockTokens', min: 1, max: 4096, integer: true },
  { path: 'tas.tMaxChars', min: 0, max: 200_000, integer: true },
  { path: 'recall.threshold', min: 0, max: 1 },
  // **The floor moved 64 -> 4 on 2026-10-05, because a window at or above the session's segment count does nothing
  // and the old floor was justified as if it throttled something.** Those pair counts are the *eager* arrival
  // order's (`sum_{i=1}^{N-1} min(i, w)`), and since scoring became on demand they are the wrong denominator for a
  // live run: a row is bought when a walk demands it, so the lane's work is the rows the walks reached
  // (`AssemblyPolicy.recall.depth` has the measurement). What survives from this argument is the *shape*: `w` is
  // what makes a row `min(index, w)` pairs, and a `w` above every session makes every row a whole history - the
  // quadratic term under another name. The floor is unchanged and still the panel's own.
  //
  // On round `20261004-1239` (228 segments, 16.1 questions/s measured) `w = 64` offered 12,512 pairs (48 % of the
  // full-history 25,878), `w = 32` offered 6,768 (26 %) and `w = 16` offered 3,512 (14 %), while the default this
  // floor used to guard - `w = 1024` - offered all 25,878 and cost 26.7 min of lane against a 6.2 min session, 4.3x
  // over budget. `AssemblyPolicy.recall.window` (`packages/core/src/types.ts`) carries the table and the decision.
  //
  // 4 is the panel's own floor rather than a second number invented here: `packages/dsh-plugin/src/credentials.ts`
  // accepts `w` from the settings panel and from `/s1-tune` at `>= 4`, with the same value for the same reason, and
  // those two surfaces have to agree on what a researcher may select. The value itself is not a claim that 4 is a
  // good window for a 228-segment session - it is the smallest window either surface will honour, which is what a
  // floor is. The ceiling is untouched: a `w` far above any session remains legal noise for the reason the rule had
  // it, and it is now only what a round that means "unbounded" writes down.
  { path: 'recall.window', min: 4, max: 1048576, integer: true },
  // the bounded wait for the anchor's own row before assembly; 0 disables it. Since scoring became on demand this
  // is the deadline the walk's demands are issued under rather than a wait on somebody else's sweep, and 0 disables
  // the *waiting* and not the recall: the walk is still started. `AssemblyPolicy.recall.anchorWaitMs` says so.
  { path: 'recall.anchorWaitMs', min: 0, max: 60_000, integer: true },
  // **The cap moved 6 -> 16 on 2026-10-05, and it moved rather than the window.** What a bounded read reaches is
  // `w x d` (a chain of edges that clear `tau`, at most `d` levels deep), so the default pair `w = 16, d = 16`
  // reaches **256** segments where the previous defaults `w = 1024, d = 2` reached 2,048. Recovering that reach by
  // raising the window is what the measurement above rejects - it is the quadratic term - while raising `d` cost the
  // scoring axis **nothing** while scoring was eager: `sum_{i=1}^{N-1} min(i, w)` contains no `d`. That is no
  // longer the whole story. **Scoring is on demand since 2026-10-05** (`packages/core/src/assoc-graph.ts`,
  // `recallDemand`; wired at `packages/dsh-plugin/src/step-observer.ts`), so the pairs a step pays for are the rows
  // its walk reached and `d` is billed on that axis like every other reach parameter - measured on round
  // `20261004-1458`'s frozen graph at `tau = 0.55`, where `d = 1` costs 263 pairs, `d = 2` costs 1,480 and `d = 16`
  // costs 2,504 of the eager 2,584; at `tau = 0.60` the same sweep is 263 / 669 / 941. The cap is unchanged, and
  // `AssemblyPolicy.recall.depth` (`packages/core/src/types.ts`) carries the table, the threshold dependence and
  // the order half of the saving - which does not depend on `d` at all.
  { path: 'recall.depth', min: 1, max: 16, integer: true },
  // `recall.fanout` (k, 1..64) used to sit here. It is retired (2026-10-05) with the per-node cap it configured:
  // recall selection is bounded by `recall.threshold` (r) and `recall.depth` (d), and by the walk's own direction
  // rule. It is read and reported rather than dropped - see `LEGACY_POLICY_KEYS` below, which is where a profile
  // that still writes it gets its sentence, and `AssemblyPolicy.recall` (`packages/core/src/types.ts`) for the
  // measurement that retired it.
  // `recall.budgetRatio` (ρ, 0.05..0.95) used to sit here. It is retired with the cap it configured - recall
  // selection is decided by `recall.threshold` (r) and `recall.depth` (d), and overflow belongs to the harness's
  // compaction (`packages/core/src/types.ts`, `AssemblyPolicy.recall`, carries the measurement and the reason).
  //
  // A key that is deleted rather than translated is a key a stale profile still writes, and the failure mode is
  // worth naming here rather than leaving to be rediscovered: `validatePolicy` reports unknown keys only at the
  // **top level** (`KNOWN_TOP_LEVEL`), so a nested key no table names - `recall: { budgetRatio: 0.35 }` is the
  // worked example - is accepted and silently ignored, with no warning on `/s1` and nothing on the assembly record
  // saying the field is gone. That is the "composes, appears in every dump, is never read" pattern this repository
  // keeps finding, and it is why `recall.fanout` was put in `LEGACY_POLICY_KEYS` rather than merely deleted.
  //
  // `packages/dsh-plugin/cordis.patch.yml` still carried the `recall.budgetRatio` line this comment used to point
  // at (line 62) and, until 2026-10-05, a `fanout: 8` line beside it; both are deleted from that file now, so this
  // example is historical rather than live.
  { path: 'recall.minRecalledShare', min: 0, max: 1 },
  // the count floor under a recall selection (assembler.ts): fewer segments than this and the block falls back to
  // the recency window. 1 is the least that is still a selection, and it is the floor rather than 0 because the
  // type documents this rule as the guard against a *broken* selector - a value that switches the guard off is not
  // a setting this harness supports. 8 is the ceiling for the reason the plan-gate caps stop there too: the guard
  // exists to catch a selector that returned nothing, so a bound large enough to act as a selection quota would
  // make the fallback the normal path and discard confident selections, which is what `minRecalledShare` did at
  // 0.25 - it fired on 9 of 9 steps of a live run. Eight segments is already far past "nothing was selected".
  { path: 'recall.minRecalledSegments', min: 1, max: 8, integer: true },
  { path: 'tail.k', min: 0, max: 20, integer: true },
  // Ceiling is the server's own `MAX_QUESTIONS = 64` (serve.py), measured to agree exactly: 64 answers, 65 returns
  // `413 {"detail": "too many questions (65 > 64)"}` in ~20 ms with no inference.
  //
  // **There is a 5-6x latency cliff at 41, measured 2026-10-05, and it is why raising this value is a trap rather
  // than a lever.** At a fixed 900 MHz SM clock with ~512-token rows, three interleaved repeats read 3,635 / 3,223 /
  // 3,382 ms at 40 questions and 19,321 / 18,682 / 18,683 ms at 41 - six of six, a sharp boundary, not a slope. It
  // needs **both** ~40+ rows **and** long rows: with 293-token rows there is no cliff through n=60 (n=41 -> 2,042 ms,
  // normal), and row count x row length does not predict it ((40,512) = 20,480 tokens is fast, (41,512) = 20,992 is
  // 6x slower). In throughput that is **2.69 questions/s at 64 against 20.75 at 20** - so `20 -> 64` costs 87 %,
  // while `20 -> 40` is a real but small +4 % (20.75 -> 21.60) worth having only for halving the request count.
  //
  // The bound is left at 64 because the cliff's trigger is the *row length*, which a static validator cannot see:
  // 64 stays legitimate for short rows and capping here would silently remove a configuration that is genuinely
  // fast. The default (20) and the cells are on the safe side of the boundary. Treat this comment as the reason not
  // to move it, and re-measure before anyone does - the earlier "raise it to 64 for a 2.3x gain" reading came from a
  // regression fitted to a thermally throttled subsample and is retracted.
  { path: 's1.questionsPerCall', min: 1, max: 64, integer: true },
  // attempts for one refused System-1 call; 1 is the single attempt this used to be, 5 is the ceiling because a
  // refusal costs a wait each time and the harness has to stay responsive
  { path: 's1.retryAttempts', min: 1, max: 5, integer: true },
  // Requests this cell may have in flight at once. 64 is a ceiling rather than a recommendation - the local Laya
  // admits 16 and refuses the rest - and it is here so that a mis-set value is an error rather than a cell that
  // quietly recreates the 64.4%-refused run this field exists to prevent. See `AssemblyPolicy.s1.admissionLimit`.
  { path: 's1.admissionLimit', min: 1, max: 64, integer: true },
];

export const ENUM_RULES                                                         = [
  { path: 'cell', values: CELLS },
  { path: 'tas.updatePolicy', values: ['perTask', 'perTurn'] },
  // The implemented tier-1 values, and only those. `embed` is the designed third mode and this build does not have
  // it: no embedder exists, `source: 'embed'` is never assigned to an edge, `recall.embedModel` is read by nothing,
  // and the only behavioural read of the field anywhere is `assembler.ts`'s `!== 'off'` - so a cell that declared
  // `embed` ran the `noul` batch and was described by a mechanism it did not use. The failure mode closed here is
  // not "unknown string" but **silently treated as on**, so `embed` is rejected with its own message
  // (`LEGACY_TIER1`, applied in the enum loop below) rather than accepted as an alias for `s1`: an alias is still
  // a recipe naming something the build lacks. As of 2026-10-02 the policy default, the type union and C2's preset
  // all say `s1` - the mode that runs - and `'off'` keeps its meaning (no recall *selection*; association-graph
  // upkeep is not gated on it).
  { path: 'recall.tier1', values: ['s1', 'off'] },
  // NOT ENFORCED. `decideReselect()` exists for this value and is called by nothing in `packages/*/src` or
  // `scripts/`; the assembler records `cacheStability` numbers and never re-selects on a policy. See
  // `UNENFORCED_KNOBS`.
  { path: 'cache.reselectPolicy', values: ['perTask', 'perTurn', 'threshold'] },
  { path: 's1.provider', values: ['jev', 'laya-serve', 'edgejev', 'kev', 'none'] },
  /**
   * Which steps run the assembly. **Not in `UNENFORCED_KNOBS`, because both values have a live reader**:
   * `packages/dsh-plugin/src/index.ts` computes the observer's `assemble` flag from it (and passes it on), and
   * `context-delivery.ts` relaxes the empty-decision refusal for `'every-step'` alone. That is the test the
   * registry exists to make mechanical - a knob added here without a reader would have to be registered there
   * instead, and `core/test/config.test.ts` checks the two sets against each other.
   *
   * `'every-step'` is the default since 2026-10-04, because the originating brief requires recall on the model's
   * own self-directed input as well as on the user's (`packages/core/src/types.ts` carries the measurement that
   * showed `'claimed-only'` dropping half of that, and the retained counter-argument). `'claimed-only'` is still
   * the value a single round may flip back to, in one profile patch, without any preset carrying it. It is a
   * declared path on purpose: a profile has to be able to set it,
   * and an undeclared knob is reported as an unknown key and ignored - the measured way a switch that looks
   * configured ends up doing nothing (`deliver`'s own history, `BOOLEAN_PATHS` below).
   */
  { path: 'assemblyTrigger', values: ['claimed-only', 'every-step'] },
  /**
   * Which of the paper's second-pass arms the layout is — **the axis the project's two named arms are made of**.
   *
   * The two values are the paper's own conditions, not a description of a mechanism: `'trace-as-state'` is
   * `M([T, x, q])` (the trace before the long context — the method, and the default) and `'trace-append'` is
   * `M([x, T, q])` (the same trace after it — the control). See `packages/core/src/types.ts` (`TracePlacement`)
   * for the paper's three literal orders and for what the previous, mechanism-named values
   * (`'before-context' | 'after-context'`) cost.
   *
   * **Not in `UNENFORCED_KNOBS`, because both values have a live reader**: `assemble()` branches on
   * `policy.tracePlacement` when it builds `layout.order`, and the recorded string is the evidence a reader of a
   * round checks — set the value and the order changes (`packages/core/src/assembler.ts`). It is the same test
   * the registry exists to make mechanical, and `core/test/config.test.ts` checks the two sets against each other
   * and pins this path as absent from the registry.
   *
   * It is top-level rather than nested under `tas` because it is a *layout* axis: `tas` owns whether T exists, how
   * long it may be and when it is rebuilt, and `tas.on: false` leaves this field with nothing to move. A reader who
   * has to know that `tas` also owns the order has three `tas` fields to read past before reaching it.
   */
  { path: 'tracePlacement', values: ['trace-as-state', 'trace-append'] },
];

/**
 * Values a config may still carry that named something this build does not have (2026-10-02).
 *
 * The case this table exists for is `recall.tier1: 'embed'`. It was an accepted value and C2's own preset carried
 * it, and the only behavioural read of the field in the whole implementation was
 * `policy.recall.tier1 !== 'off'` (`packages/core/src/assembler.ts`) - so the cell ran the `noul` batch and was
 * described by a mode nothing implements. It is an **error** now, with its own sentence rather than the generic
 * enum message: the defect was never "unknown string", it was being treated as on, and an explicit retirement
 * survives someone adding `embed` back to `ENUM_RULES` by reflex.
 */
export const LEGACY_TIER1                                                              = [
  {
    path: 'recall.tier1',
    value: 'embed',
    message:
      'tier-1 "embed" is not implemented: no embedder or ANN index exists, `source: "embed"` is never written to ' +
      'an edge, and this field was read only as `!== "off"`. The implemented values are "s1" (one batched `noul` ' +
      'call - what every selecting cell has run) and "off" (no recall selection at all). The cell\'s own value is ' +
      'kept; see packages/core/src/types.ts (`recall.tier1`) for the measurement',
  },
];

/**
 * The policy keys this build no longer has, and what each old spelling means now.
 *
 * **Three renames, then two deletions, and the difference matters.** On 2026-10-05 the layout surface was
 * `xFirst: boolean` (where the anchor went) and `stateProxyPosition: 'before-context' | 'after-context'` (where T
 * went); both were renamed onto fields that named the paper's own objects — `xFirst` to
 * `questionPlacement: 'first' | 'last'`, `stateProxyPosition` to `tracePlacement: 'trace-as-state' |
 * 'trace-append'`. Later the same day `questionPlacement` was **deleted**: the paper (arXiv:2609.02702 §4.1) fixes
 * the question last in every condition — "We therefore separate the question from the long context and place it at
 * the end of every input" — and its two arms are `[T, x, q]` (Trace as State) and `[x, T, q]` (Trace Append), with
 * "order as the only difference". The question's position is therefore not a variable, and `'first'` produced
 * `[T, q, x]`, which is **neither** of the paper's arms. Renaming the boolean had left that wrong idea expressible
 * under a better name; deleting the field is the correction, and `tracePlacement` is now the only layout axis.
 * `recall.fanout` (k, the per-node expansion cap) is the second deletion and the reason this table is no longer
 * named for the layout alone: it was **not** a layout key, it is a retired scalar, and the table's job — read the
 * old spelling, name it, say what replaced it — is the same job. The list keeps the name `LEGACY_LAYOUT_KEYS` for
 * the three layout entries alone (`LEGACY_LAYOUT_KEYS` below, the projection the layout documents point at), and
 * `LEGACY_POLICY_KEYS` is the table the validator actually reads.
 *
 * **Why a translation rather than a rejection, wherever a translation exists.** `stateProxyPosition` and
 * `xFirst: false` named a real setting with one unambiguous successor, so an error would refuse a profile that is
 * merely out of date, while *dropping* them — which is what an undeclared key does here — would silently run the
 * default. That second failure is the one this project keeps measuring: a key that looks configured and resolves to
 * nothing. So an old key is read, the reading is reported as a warning with both spellings, and the layout the
 * profile asked for is the layout that runs. `recall.fanout` is the same failure one field over and gets the same
 * treatment: a profile or a stored cell preset carrying it is *told* it is retired and what replaced it, because a
 * value dropped in silence is how a saved line turns into different behaviour without a word.
 *
 * **`xFirst: true` (and its `on`/`1`/`yes` spellings) is refused, and that is a decision rather than an
 * oversight.** It asked for the question *first* — `[T, q, x]` — and this build has no layout that puts `q`
 * anywhere but last, so there is nothing to translate it *into*: applying the rest of the profile while saying
 * nothing would leave a file that asks for a deleted layout beside a session that quietly ran another one. It is an
 * **error**, not a warning, because `validatePolicy`'s warnings are advice about a value that was kept
 * (`recall.embedModel`, the `tas.on`/recall pairing) while this key is a request for a condition the project cannot
 * produce; `ok: false` is the loudest thing this validator has, it is already how `recall.tier1: 'embed'` is
 * treated, and an error here is still fail-safe — a session never fails over config, the resolved policy keeps its
 * defaults, and the sentence is printed under `configIssues.errors` on `/s1`. `xFirst: false` and
 * `questionPlacement: 'last'` ask for exactly what every layout does now, so they are read, reported and otherwise
 * ignored: translatable and harmless, and still warned about so a stored file is never silently reinterpreted.
 * Both spellings of the deleted axis are in this table for that reason — a key removed in a rename is still a key a
 * profile can carry, and the rule this file follows is that the old spelling is always read and reported.
 * `recall.fanout` is a retirement rather than a refusal for the same reason: the request it carried is not one this
 * build *cannot* answer, it is one the brief never asked for and `recall.threshold` now answers.
 *
 * What a translated value is **not** is a claim that the old layout can still be produced.
 * `stateProxyPosition: 'after-context'` and `tracePlacement: 'trace-append'` are the same setting and now produce
 * the same order (`pinned, tail, recalled, stateProxy, anchor`) — but that is because the question is last in both,
 * not because the old axis survives: under the old surface T was pinned in front of the context and
 * `xFirst: true` recorded `pinned, stateProxy, anchor, recalled, tail`. A round that wants that exact order has no
 * setting that produces it any more, which is the correction rather than a gap: that order put the question second,
 * and the paper puts it last in every condition (`AssemblyLayout.order` in `types.ts` carries the same note).
 * `recalled`'s own place inside the long context moved on the same day and for a different reason — a cache one, not
 * a paper one — so a round older than that reads `recalled, tail` where this build writes `tail, recalled`; the
 * recorded string says which, and `AssembleInput.recallOrder` in `assembler.ts` says why.
 */
                                  
                                                              
              
     
                                                                                                                
                                                                                                      
     
                    
     
                                                                                                                  
                                                                                                                  
                                                                                                            
                          
     
                                           
     
                                                                                                                 
                                                                                                                  
                                                                                                                  
                                                                         
     
                              
     
                                                                                                                
                                                                                                             
                                                                                                             
                                                     
    
                                                                                                            
                                                                                                                   
                                                                                                                 
                                                                                                            
                                                                                                               
     
                                                     
 

/**
 * The sentence a profile gets when it asks for the question in front of the long context — the one layout this
 * build deleted the ability to produce.
 *
 * It names the key, the value that was written, the layout that value asked for, the paper sentence that retired
 * it, and the setting that exists instead: the five things a reader needs in order to fix the file rather than
 * guess at it. Written once because it is one deleted layout under two spellings (`xFirst` and the
 * `questionPlacement` it was renamed to), and two copies of a sentence like this drift.
 */
function questionFirstRefusal(key        , raw         )         {
  return (
    `${key}: ${JSON.stringify(raw)} asks for a layout this build cannot produce, so it is refused rather than ` +
    `translated. It put the question \`q\` in front of the long context — \`[T, q, x]\` — and the paper fixes \`q\` ` +
    `last in every condition: "We therefore separate the question from the long context and place it at the end of ` +
    `every input" (arXiv:2609.02702 §4.1), its two arms being \`[T, x, q]\` (trace-as-state) and \`[x, T, q]\` ` +
    `(trace-append), "order as the only difference". The field this key named is deleted, so no value is ` +
    `substituted for it: the question is last by construction and the only layout axis is \`tracePlacement\` ` +
    `(\`trace-as-state\` | \`trace-append\`). Delete \`${key}\` from the profile.`
  );
}

/**
 * The sentence a profile gets when it carries the retired per-node expansion cap, `recall.fanout` (k).
 *
 * It answers, in the order a reader repairing the file needs them: **what the key was**, **that it was never in
 * the brief**, **that it was in no record and no panel**, **the measurement that showed the argument for keeping
 * it was wrong**, **what removing it costs**, and **which knob does its job now**. Those six are not decoration —
 * the field sat in all three cell presets for a day and the only honest way to retire it is to say why it should
 * never have been there and what a researcher loses by its absence, rather than "unknown key".
 *
 * The measurement is a simulation on round `20261004-1239`'s frozen graph, read-only: every segment as anchor,
 * backwards-only, depth 2, `k = 8` against an unbounded `k`. The sets agree for 63.2 % of anchors (84 of 228
 * differ), which is what falsifies the deduction that an uncapped depth-2 walk reaches essentially the whole
 * graph. The cost column is the other half: where the cap did bite, the uncapped walk selects more - median +27
 * segments, worst +69 - and that growth is now `recall.threshold`'s to hold.
 *
 * `recall.threshold` is named as the replacement rather than described as one, because the two bound the
 * selection by different quantities: `k` capped *neighbours expanded per node*, `r` drops *candidate edges by
 * relevance*. A profile cannot translate its old `k` into an `r`; it has to choose the block size it wants and
 * lower `r` until the block is that size. Saying "replace it with r" without that clause would be the same
 * silent-substitution failure the table above exists to prevent.
 */
function fanoutRetirement(key        , raw         )         {
  return (
    `${key}: ${JSON.stringify(raw)} is retired, and nothing was substituted for it. The key was \`k\`, the per-node \
expansion fanout of the recall walk: each node of the BFS expanded at most its \`k\` heaviest neighbours. **It was \
never in the originating brief** (the prompt that defines this project mentions it zero times): the brief bounds \
recall with two things only, \`recall.depth\` (d) and \`recall.threshold\` (r), plus \`recall.window\` (w), which it \
says exists *only* to save System-1 calls and must not affect recall. **It was in no record and no panel.** The \
tape's \`kind:"wiring"\` record carries \`recall: {d, r, w, wait, tier1}\` and no \`k\`, the round \`manifest.json\` does \
not name it, and the settings panel's \`Tuning\` fields are \`depth\`, \`relevanceThreshold\`, \`window\`, \
\`anchorWaitMs\` and \`tracePlacement\` — so a researcher could never tune it. Its only home was the three cell \
presets, and \`C2.json\`'s own \`provider\` note says of that file "treat that record [\`kind:"wiring"\`], not this \
file, as the authority" — a parameter that decided behaviour, living only where the project says the authority is \
not. **And on the round it was measured in, nothing changes.** In \`round-20261004-1239\` the walk returned \
\`candidates = 0\` from invocation 9 onward (the System-1 lane was 4.6x too slow to score the pairs, so the tail had \
no edges), so the cap had no effect on any number that round recorded: removing it changes the design, not that \
round's data, and the rounds that ran with it stay readable and unedited. **The argument for keeping it was wrong, and it is measured rather than argued.** It was justified by the \
claim that without \`k\` a depth-2 walk reaches essentially the whole graph and makes \`depth\` meaningless; that \
arithmetic used the mean edge degree to get \`1 + 37.6 + 37.6^2 = 1450 > 228\` segments. It ignored the rule that \
every step must go into a segment earlier in the append order. Walking from **every** segment as anchor on round \
\`20261004-1239\`'s frozen graph, backwards-only, at depth 2, the reachable sets under \`k = 8\` and under an \
unbounded \`k\` are **identical for 63.2 % of anchors** (they differ for 84 of 228) — an exploding walk could not \
agree with a capped one that often. **What removal costs, recorded rather than hidden:** on the 36.8 % of anchors \
where the cap did bite, the walk now selects **more** segments — median **+27**, worst **+69** — so the \`recalled\` \
block can grow on those steps. **That trade is \`recall.threshold\`'s now**: it is the brief's own knob and it *is* \
in the settings panel, so lowering \`r\` is how a profile asks for a smaller block. Note that \`r\` cannot be \
computed from the old \`k\` — \`k\` counted neighbours expanded per node and \`r\` filters candidate edges by relevance \
— so re-tune the block size rather than translating the number. For the round this was measured against, nothing \
changed either way: in \`round-20261004-1239\` the walk returned \`candidates = 0\` from invocation 9 onward (the \
System-1 lane was 4.6x too slow to score the pairs, so the tail had no edges), so \`k\` had no effect on any \
recorded number. Delete \`${key}\` from the profile.`
  );
}

/**
 * Every retired key: the layout surface, then the retired per-node expansion cap.
 *
 * The retired *scalar* supplies its whole sentence through `retirement` instead of letting the loop assemble one
 * from `translated`, and that is the shape of the case rather than a shortcut. The two branches the loop already
 * handles both have a successor *value* to talk about — a mapping, or "what every layout does now" — while a
 * retired scalar has no successor value at all: `k` counted neighbours expanded per node and its replacement
 * bounds the selection by relevance, so the reader needs the measurement and the trade, not a mapping.
 *
 * Kept in two groups because the layout half is what the layout documents mean by `LEGACY_LAYOUT_KEYS`, and the
 * split is by *subject* rather than by key spelling, so adding a retired layout key later cannot silently change
 * which keys that name covers.
 */
const LAYOUT_KEYS                             = [
  {
    key: 'xFirst',
    to: null,
    // `xFirst: false` meant "the question last", which is now the only order this build lays out: the value is read
    // and reported, and nothing is written because there is no field left to write it to.
    values: { false: 'last' },
    // `true` is the retired value itself; `on`/`1`/`yes` are the spellings the panel's command line accepted for
    // the same setting, and a hand-written patch is likely to carry one of them (the reason the previous version of
    // this table only *warned* about them — which let a file ask for the deleted layout and keep running).
    refused: ['true', 'on', '1', 'yes'],
  },
  {
    key: 'questionPlacement',
    to: null,
    // The spelling the rename itself introduced, and it lived for one day. Same rule: what every layout now does is
    // reported as retired, and the deleted layout is refused.
    values: { last: 'last' },
    refused: ['first'],
  },
  {
    key: 'stateProxyPosition',
    to: 'tracePlacement',
    values: { 'before-context': 'trace-as-state', 'after-context': 'trace-append' },
  },
];

/** The retired per-node expansion cap, on its own because it is a policy field rather than a layout axis. */
const RETIRED_POLICY_FIELDS                             = [
  {
    // The key a profile writes is `recall.fanout`, nested under the `recall` block, and the **dotted** spelling is
    // what `getPath`/`present` resolve from the config root — the same way they resolve `recall.tier1`. A retired
    // *nested* key is not a top-level key, so it is deliberately absent from `KNOWN_TOP_LEVEL`; `recall` itself is
    // what the unknown-key loop sees, and this table is what turns `recall.fanout` from a silence into a sentence.
    key: 'recall.fanout',
    to: null,
    // No value the key could take means anything now, so there is nothing to translate and nothing to refuse
    // separately: every value gets the retirement sentence below.
    values: {},
    retirement: fanoutRetirement,
  },
];

export const LEGACY_POLICY_KEYS                             = [...LAYOUT_KEYS, ...RETIRED_POLICY_FIELDS];

/**
 * The layout entries of `LEGACY_POLICY_KEYS`, under the name the layout documents already point at.
 *
 * A projection rather than a second table, and the layout half is a separate const above rather than a filter on
 * the key spelling so that the two cannot drift: the entries are literally the same objects, and adding a retired
 * layout key to `LAYOUT_KEYS` updates both names at once.
 *
 * The name is kept because it is cited for the *layout* question by `docs/ARCHITECTURE.md`,
 * `docs/AGENT_BRIEF.md`, `docs/CELLS-RUN.md`, `docs/FORMULAS.md`, `docs/STATUS.md`, `docs/PROPOSAL.md`,
 * `bench/README.md`, `README.md` and `packages/dsh-plugin/src/credentials.ts`, and every one of those sentences is
 * about `xFirst`, `questionPlacement` or `stateProxyPosition` — none of which changed shape when a retired scalar
 * joined the table. A reader who wants "what happens to an old profile's layout key" gets exactly those three; a
 * reader who wants every retired key reads `LEGACY_POLICY_KEYS`.
 */
export const LEGACY_LAYOUT_KEYS                             = LAYOUT_KEYS;

/**
 * The knobs this build **accepts, composes, records and does not enforce** - as a registry, because a comment is
 * not a thing a test can check and a knob that composes and does nothing is the defect this exists to remove.
 *
 * The list is closed on purpose. Every entry says what it would take to enforce the knob; anything not in the
 * list is a knob with a live reader, and `core/test/config.test.ts` fails if the two sets drift apart (the test
 * reads the declarations and asserts the registry matches exactly). `cache.reselectPolicy` and
 * `cache.blockTokens` share one entry because they are one mechanism - the assembler prices a re-selection with
 * `cache-policy.ts` and never makes one, so the policy that would decide it and the block size it would align to
 * are unenforced together.
 *
 * Precedent, and why this is a registry rather than five more comments: the plan gate was removed for exactly
 * this shape - a field the full-configuration cell carried and no code read - and its removal was swept for in
 * the presets, the schema and the report. Nothing swept for the rest, so three of these survived the pass that
 * deleted the gate, and the fourth, `recall.tier1: 'embed'`, sat in the cell whose whole purpose is to be the full
 * configuration until 2026-10-02, when it was answered by naming what runs instead: the value is rejected, and the
 * mode's one remaining trace in the policy - `recall.embedModel`, which nothing loads a model for - is the entry
 * below. The registry is what makes the sweep mechanical rather than another reading.
 */
                                 
                                                                                               
                  
                                                          
                 
                                                           
                    
 

export const UNENFORCED_KNOBS                                           = {
  assemblyDeadlineMs: {
    enforced: false,
    claims: 'a hard deadline for the synchronous per-call assembly hook, on expiry of which the call passes through unmodified',
    wouldNeed:
      'the hook to race the assembly against a timer and return the untouched decision on expiry; read today only to be ' +
      'printed on `/s1`. The bound that actually runs is `recall.anchorWaitMs`, which is 10 000 ms by default - forty ' +
      'times this number, in the same policy object',
  },
  'cache.reselectPolicy': {
    enforced: false,
    claims: 'whether a selected context is re-selected per task, per turn, or when the break-even test says it pays',
    wouldNeed:
      'a caller for `cache-policy.ts#decideReselect`, which nothing in `packages/*/src` or `scripts/` calls; the assembler ' +
      'records `cacheStability` and never re-selects on a policy',
  },
  'cache.blockTokens': {
    enforced: false,
    claims: 'the prefix-cache block size a selection is aligned to',
    wouldNeed:
      'a caller for `cache-policy.ts#alignToCacheBlocks`; the same missing mechanism as `cache.reselectPolicy` above',
  },
  'rgMaintenance.maxLagTurns': {
    enforced: false,
    claims: 'how far the association graph may lag the session, in turns',
    wouldNeed:
      'a lag measured in turns. `upkeep-queue.ts` compares it against a count of *pending session events* and nothing acts ' +
      'on the comparison. The bound that does bound scoring concurrency is `s1.admissionLimit`',
  },
  'recall.embedModel': {
    enforced: false,
    claims: "the tier-1 embedding model's own default, used by the `embed` mode",
    wouldNeed:
      'an embedder. Tier-1 `embed` is not implemented and is not an accepted value (`LEGACY_TIER1` above rejects ' +
      'it), so nothing loads a model here; a non-empty value is warned about at the end of `validatePolicy`, and a ' +
      'profile that sets one is naming a mechanism this build does not have',
  },
};

/**
 * Boolean policy paths a profile patch may set.
 *
 * `deliver` is here for a measured reason. It was added to the policy in the N6 commit and *not* here, and a
 * live run then reported `policy.deliver is off` on all twelve steps of a session whose cell was C2 — with 8 of
 * 12 assemblies carrying a non-empty recalled block and 12 of 12 carrying a state proxy. The content was there and
 * the switch was off, because a knob missing from this list is not read from the cell preset, cannot be set
 * from a profile, and is reported as an unknown path. A flag that exists in the type and in the cell, and in
 * neither of the two places that decide it, is worse than a flag that does not exist: it looks configured.
 */
export const BOOLEAN_PATHS                    = ['tas.on', 'deliver'];

/**
 * Fixed by design, not configuration: the harness owns termination, and association-graph
 * upkeep is asynchronous (docs/ARCHITECTURE.md §6). A different value is an error, not a toggle.
 */
export const LITERAL_RULES                                             = [
  { path: 'termination', value: 'model-owned' },
  { path: 'rgMaintenance.mode', value: 'async' },
];

/** Optional string fields on the policy (empty string means "not set"). */
export const STRING_PATHS                    = [
  's1.baseUrl',
  's1.model',
  's1.apiKey',
  'recall.embedModel',
];

/** Everything a profile patch may set (used to warn about typos). */
export const KNOWN_PATHS                    = [
  ...NUMBER_RULES.map((r) => r.path),
  ...ENUM_RULES.map((r) => r.path),
  ...BOOLEAN_PATHS,
  ...LITERAL_RULES.map((r) => r.path),
  ...STRING_PATHS,
];

const KNOWN_TOP_LEVEL                    = [
  'cell',
  'termination',
  'assemblyDeadlineMs',
  // The other assembly switch, and a top-level one for the same reason: it decides which steps are assembled at
  // all, before any of the sections below are consulted. A key missing from this list is a warning and is
  // dropped, which is exactly how a profile could set `assemblyTrigger` and run the default anyway.
  'assemblyTrigger',
  // The arm, and top-level because it is a layout axis: it decides the order of the whole assembled view, before
  // any of the sections below are consulted. A key missing from this list is a warning and is dropped, which is
  // precisely how a profile could set the arm and run the default one instead. It is the **only** layout axis since
  // 2026-10-05: the key that used to sit beside it (`questionPlacement`, and `xFirst` before that) is deleted, and
  // both of its old spellings are read and reported through `LEGACY_LAYOUT_KEYS` below rather than declared here.
  'tracePlacement',
  'rgMaintenance',
  'cache',
  'tas',
  'recall',
  'tail',
  's1',
  'telemetry',
  // **`deliver` was missing from this list until 2026-10-05, and the absence was a false sentence rather than a
  // gap.** The path IS in `BOOLEAN_PATHS`, so the boolean loop applied it; this list is what the unknown-key loop
  // walks, and it did not carry the name. So a profile — or, after `deliver` moved into the cell presets, every one
  // of the three presets — was told `unknown config key (ignored)` about a value that **was** applied. That is the
  // shape this project keeps hunting: a record saying something untrue about what ran. It surfaced only because the
  // move put the key in a file whose warnings a test reads; `checkPresetOverrides` passes either way, since it looks
  // for a different finding. Added here rather than worked around at the caller.
  'deliver',
];

function getPath(root         , path        )          {
  let cursor          = root;
  for (const part of path.split('.')) {
    if (typeof cursor !== 'object' || cursor === null) return undefined;
    cursor = (cursor                           )[part];
  }
  return cursor;
}

function setPath(target                         , path        , value         )       {
  const parts = path.split('.');
  let cursor                          = target;
  for (const part of parts.slice(0, -1)) {
    const next = cursor[part];
    if (typeof next !== 'object' || next === null) {
      cursor[part] = {};
    }
    cursor = cursor[part]                           ;
  }
  cursor[parts[parts.length - 1]          ] = value;
}

function present(root         , path        )          {
  return getPath(root, path) !== undefined;
}

function looksLikeUrl(value        )          {
  return /^https?:\/\/[^\s]+$/i.test(value);
}

/**
 * Validate a raw config object (typically the `config:` block of the plugin's profile patch)
 * and return defaults plus every accepted override.
 *
 * @param extraAllowedKeys plugin-level keys that are not policy fields (e.g. `laya`)
 */
/**
 * The starting policy for a raw config: the cell preset when the config names a real cell, else C2.
 *
 * This was `defaultPolicy()` unconditionally, and that is a measurement bug, not a style choice. `defaultPolicy`
 * *is* C2, and `cellPolicy()` was called from tests only — so a profile patched to `cell: C0` ran C2's TAS,
 * tier1, plan gate and x-first layout while `/s1` reported the cell as C0. Nothing in the log said so, because
 * the record carries the cell name, not the policy that ran. A live run of this exact mistake is in N6: twelve
 * steps of a C2 session all reported `policy.deliver is off` because `deliver` had been added to the policy and
 * to `cellPolicy`, but the runtime never consulted the cell.
 *
 * Precedence, unchanged and already the documented rule: cell preset < explicit config in the profile patch.
 * A knob set in the patch still wins, so an experiment can deviate from its cell on purpose and say so in the
 * patch rather than in a second place.
 */
function basePolicyFor(raw         )                 {
  if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
    const cell = (raw                           )['cell'];
    if (typeof cell === 'string' && (CELLS                     ).includes(cell)) {
      return cellPolicy(cell        );
    }
  }
  return defaultPolicy();
}

export function validatePolicy(raw         , extraAllowedKeys                    = [])                   {
  const policy = basePolicyFor(raw);
  const issues          = [];
  const target = policy                                      ;

  const finish = ()                   => {
    const errors = issues.filter((i) => i.severity === 'error');
    const warnings = issues.filter((i) => i.severity === 'warning');
    return { ok: errors.length === 0, issues, errors, warnings, policy };
  };

  if (raw === undefined || raw === null) return finish();
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    issues.push({ path: '', message: 'config must be an object', severity: 'error' });
    return finish();
  }

  const source = raw                           ;
  // The retired **top-level** keys are *recognized*, so they are not reported as unknown keys on top of the note
  // the loop below writes: two sentences for one key would say "ignored" and "translated" about the same value at
  // the same time, and the reader would have to guess which one happened. They are read below, and that is the only
  // thing said. `questionPlacement` is in this list even though it is not a policy path any more, which is what
  // keeps a profile written between the rename and the deletion from being told it is a typo.
  //
  // A retired key spelled with a dot (`recall.fanout`) is deliberately **not** added here, and it must not be: this
  // loop walks the *top level* of the config object, so the key it sees is `recall`, which `KNOWN_TOP_LEVEL`
  // already declares. Adding the dotted path would put a string in this list that no top-level key can ever equal,
  // which reads as protection while providing none. What keeps `recall.fanout` out of the silent-drop class is the
  // table loop below, which resolves the dotted path with `present`/`getPath` and writes the retirement sentence.
  const renamedKeys = LEGACY_POLICY_KEYS.filter((r) => !r.key.includes('.')).map((r) => r.key);
  const allowedTop = [...KNOWN_TOP_LEVEL, ...renamedKeys, ...extraAllowedKeys];
  for (const key of Object.keys(source)) {
    if (!allowedTop.includes(key)) {
      issues.push({ path: key, message: `unknown config key (ignored)`, severity: 'warning' });
    }
  }

  for (const rule of LITERAL_RULES) {
    if (!present(source, rule.path)) continue;
    const value = getPath(source, rule.path);
    if (value !== rule.value) {
      issues.push({
        path: rule.path,
        message: `must be "${rule.value}" — this is fixed by design, not configurable (got ${JSON.stringify(value)})`,
        severity: 'error',
      });
      continue;
    }
    setPath(target, rule.path, value);
  }

  for (const rule of ENUM_RULES) {
    if (!present(source, rule.path)) continue;
    const value = getPath(source, rule.path);
    // The value must be a real cell; the preset itself was already applied by basePolicyFor() before this
    // function looked at any override, so a bad value costs an error and falls back to C2 rather than a
    // half-applied cell.
    if (typeof value !== 'string' || !rule.values.includes(value)) {
      // A value this build used to advertise and never implemented gets its own sentence instead of the generic
      // list: the reader needs to know the *mode* is missing, not that a string is not in an array.
      const legacy = LEGACY_TIER1.find((r) => r.path === rule.path && r.value === value);
      issues.push({
        path: rule.path,
        message: legacy ? legacy.message : `must be one of ${rule.values.join(' | ')} (got ${JSON.stringify(value)})`,
        severity: 'error',
      });
      continue;
    }
    setPath(target, rule.path, value);
  }

  // The layout keys this build no longer has: translated where the old value still means something, refused where it
  // named a layout the build cannot produce (2026-10-05). Placed after the enum loop and before the scalar loops so
  // that a legacy key's *new* name is written last and therefore wins: a profile that somehow carries both spellings
  // runs the value it stated most explicitly, and the warning names both keys so the duplication is visible instead
  // of silent.
  //
  // Three outcomes, and the difference between them is the point of the table rather than a detail of the loop:
  // a value with a successor is applied; a value whose meaning is now simply the behaviour is reported as retired
  // and applied nowhere (there is nothing to apply); and a value that asked for a deleted layout is an **error**
  // carrying the sentence that retired it. An unusable value on a key that still exists is refused on its own terms
  // — the new key keeps the default — but the key is still reported as renamed, because a profile that wrote it now
  // has a sentence telling it which spelling this build reads. A bare "unknown key" would leave the reader to guess
  // whether the setting moved or disappeared, which is the failure this whole table exists to prevent.
  //
  // A fourth outcome sits at the top of the loop: a **retired scalar** — a key the build deleted outright, with no
  // successor *value* (`recall.fanout`). It is checked first because every branch below would report it falsely.
  // `values` is empty for such a key, so it would fall into the "unusable" branch and be told its value was not one
  // of the old values that still mean something — when in fact the value was read and understood and the *key* is
  // what is gone. The one behavioural difference that matters: a retirement is a **warning**, like the renames,
  // because the request it carried is answerable by another knob (`recall.threshold`); nothing in it asks for a
  // condition this build cannot produce, which is what `xFirst: true` does and why that one is an error.
  for (const legacy of LEGACY_POLICY_KEYS) {
    if (!present(source, legacy.key)) continue;
    const raw = getPath(source, legacy.key);
    const spelling = String(raw);
    if (legacy.retirement !== undefined) {
      issues.push({ path: legacy.key, message: legacy.retirement(legacy.key, raw), severity: 'warning' });
      continue;
    }
    if (legacy.refused?.includes(spelling) === true) {
      issues.push({ path: legacy.key, message: questionFirstRefusal(legacy.key, raw), severity: 'error' });
      continue;
    }
    const translated = legacy.values[spelling];
    if (translated === undefined) {
      // A value nobody can read on a key that is *gone* is an error too, and for the same reason the refusal is:
      // the key itself is not a setting any more, so there is no successor to fall back to and a warning would let
      // the file keep asking for something this build cannot answer.
      issues.push({
        path: legacy.key,
        message:
          legacy.to === null
            ? `retired, and unusable: this key is not a setting any more, so nothing was applied. ` +
              `${JSON.stringify(raw)} is not one of the old values that still mean something here (` +
              `${Object.keys(legacy.values).map((v) => JSON.stringify(v)).join(' | ')}); the question is last in ` +
              `every layout by construction and the only layout axis is "tracePlacement" ` +
              `("trace-as-state" | "trace-append"). See packages/core/src/types.ts.`
            : `renamed, and unusable: this key is now "${legacy.to}", whose accepted values are ` +
              `${Object.values(legacy.values).map((v) => JSON.stringify(v)).join(' | ')} — so ` +
              `${JSON.stringify(raw)} was dropped and the default stands. See packages/core/src/types.ts.`,
        severity: legacy.to === null ? 'error' : 'warning',
      });
      continue;
    }
    if (legacy.to === null) {
      // Translatable and harmless: the value asked for what every layout now does, so it is named as retired and
      // nothing is written. A warning rather than silence, because a stored file that still carries the key must not
      // be reinterpreted without its reader being told.
      issues.push({
        path: legacy.key,
        message:
          `retired: this key is not a setting any more, and nothing was applied because nothing needed to be. ` +
          `${legacy.key} ${JSON.stringify(raw)} meant "the question ${translated}", which is where the ` +
          `question now sits in every layout — the paper separates it from the long context and places it "at the ` +
          `end of every input" (arXiv:2609.02702 §4.1), and \`tracePlacement\` (\`trace-as-state\` | ` +
          `\`trace-append\`) is the only layout axis. Update the profile: delete the key.`,
        severity: 'warning',
      });
      continue;
    }
    setPath(target, legacy.to, translated);
    issues.push({
      path: legacy.key,
      message:
        `renamed: this key is now "${legacy.to}". ${legacy.key} ${JSON.stringify(raw)} means ` +
        `"${legacy.to}: ${JSON.stringify(translated)}", which is what was applied — update the profile. ` +
        `(The old layout itself is no longer producible: it put the question in the middle of the prompt, and the ` +
        `paper places it last in every condition. See packages/core/src/types.ts.)`,
      severity: 'warning',
    });
  }

  for (const path of BOOLEAN_PATHS) {
    if (!present(source, path)) continue;
    const value = getPath(source, path);
    if (typeof value !== 'boolean') {
      issues.push({ path, message: `must be a boolean (got ${JSON.stringify(value)})`, severity: 'error' });
      continue;
    }
    setPath(target, path, value);
  }

  for (const rule of NUMBER_RULES) {
    if (!present(source, rule.path)) continue;
    const value = getPath(source, rule.path);
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      issues.push({ path: rule.path, message: `must be a number (got ${JSON.stringify(value)})`, severity: 'error' });
      continue;
    }
    if (rule.integer && !Number.isInteger(value)) {
      issues.push({ path: rule.path, message: `must be an integer (got ${value})`, severity: 'error' });
      continue;
    }
    if (value < rule.min || value > rule.max) {
      issues.push({
        path: rule.path,
        message: `must be within ${rule.min}..${rule.max} (got ${value})`,
        severity: 'error',
      });
      continue;
    }
    setPath(target, rule.path, value);
  }

  for (const path of STRING_PATHS) {
    if (!present(source, path)) continue;
    const value = getPath(source, path);
    if (typeof value !== 'string') {
      issues.push({ path, message: `must be a string (got ${JSON.stringify(value)})`, severity: 'error' });
      continue;
    }
    if (path === 's1.baseUrl' && value !== '' && !looksLikeUrl(value)) {
      issues.push({ path, message: `must be an http(s) URL or "" (got ${JSON.stringify(value)})`, severity: 'error' });
      continue;
    }
    setPath(target, path, value);
  }

  // The pairing a measured round found to be the worst of the four arms it ran, warned about and never rejected.
  //
  // The pairing is `tas.on: false` with recall selection on (`recall.tier1: 's1'`, the only selecting value): recall
  // selection running without the state proxy that keeps the head of the prompt byte-stable. Round `20261001-1300`
  // measured that combination per step at
  // 3 625 uncached input tokens against the baseline's 2 595, 2 574 output tokens against 1 523 and a 79.2% cache
  // hit rate against 86.7%; its counterpart - the stabiliser on with recall off (cell C1) - measured 1 783 uncached
  // input tokens per step, the fewest in the table, and 1 493 output tokens against the baseline's 1 523. No cell
  // names this pairing any more - it was the fourth arm, dropped - so it is reachable only by setting the two knobs
  // in a profile, which is where a warning earns its place: a combination no cell selects on purpose must not be
  // selected by accident. It stays a warning rather than an error: `ok` stays true, no value is changed, and a
  // session never fails over a combination of two legal settings.
  //
  // Stated as token counts per step, never as a share of a priced total: the three token types carry three prices
  // and the prices differ per model and per provider, so a weighted share of a bill describes a price list rather
  // than the system. The pairs are also per step on purpose - the cells ran different numbers of steps, so their
  // absolute totals rank differently and are not comparable.
  if (policy.tas.on === false && policy.recall.tier1 !== 'off') {
    issues.push({
      path: 'recall.tier1',
      message:
        `recall selection is on ("${policy.recall.tier1}") while tas.on is off, and that pairing measured worse ` +
        `than the baseline in round 20261001-1300, per step: 79.2% cache hit against 86.7%, 3 625 uncached input ` +
        `tokens against 2 595 and 2 574 output tokens against 1 523. With the stabiliser on and recall off the ` +
        `same run measured 1 783 uncached input tokens per step against the baseline's 2 595 and 1 493 output ` +
        `tokens against 1 523. Set tas.on true, or recall.tier1 "off", unless the pairing is what is under test`,
      severity: 'warning',
    });
  }

  // `recall.tier1: 'embed'` used to be accepted here and resolved as an alias for the System-1 tier. It is an
  // error now (`LEGACY_TIER1`, applied in the enum loop above), because the defect was not the missing mechanism
  // on its own - it was that a cell could *declare* the embed mode and be read as "not off". The value that runs
  // is the one the recipe states: `s1` or `off`.

  // What is left of that mode in the policy is its model name, and nothing reads it (`UNENFORCED_KNOBS`). A
  // non-empty value is reported - the "composes, appears in every dump, never read" pattern this repository keeps
  // finding - while the empty string, which `cordis.patch.yml` ships and every `STRING_PATHS` entry treats as
  // "not set", stays silent. A warning rather than an error for the same reason `planGate`'s leftover key is one:
  // a key with no reader costs a session nothing, and the session must not fail over a config it ignores.
  const embedModel = getPath(source, 'recall.embedModel');
  if (typeof embedModel === 'string' && embedModel !== '') {
    issues.push({
      path: 'recall.embedModel',
      message:
        `no reader: tier-1 "embed" is not implemented (see recall.tier1), so nothing loads this model ` +
        `(${JSON.stringify(embedModel)}). The key is accepted and ignored; remove it from the profile`,
      severity: 'warning',
    });
  }

  return finish();
}
