/**
 * ASSEMBLER — recall bounded by r and d + Trace-as-State layout.
 *
 * The layout is **the paper's second pass, and `tracePlacement` is the only axis that moves**: the same long
 * context `x`, the same textual task state proxy `T`, the question `q` last in every condition, and the arm decided
 * by where `T` sits.
 *
 *   tracePlacement     order                                          the paper's arm
 *   ----------------   --------------------------------------------   -----------------------------
 *   'trace-as-state'   pinned | stateProxy | tail | recalled | anchor  Trace as State, M([T, x, q]) — default
 *   'trace-append'     pinned | tail | recalled | stateProxy | anchor  Trace Append,  M([x, T, q])
 *
 * **`recalled` is the last block before the question in both arms (2026-10-05), and that is a cache decision whose
 * arithmetic is in `cacheStability` below.** A change inside the recalled block breaks the prefix cache from the
 * point of the change onward, so every block placed *behind* it is re-prefilled whenever the selection moves. The
 * block used to be third of five, with `tail` and `anchor` behind it; it is now second-to-last, so a selection
 * change costs the question and nothing else. What this is **not** is a move of the paper's variable: the paper's
 * variable is where `T` sits relative to the long context, and the recalled block *is* that long context — "the
 * blocks other than `anchor` ... the long context `x`" (`AssemblyLayout.order` in `types.ts`) — so a block that
 * changes position inside `x` leaves the arm the project is testing exactly where it was. `T` is still ahead of
 * every block of `x` under `'trace-as-state'` and behind all of them under `'trace-append'`.
 *
 * The two are the contrast the paper's second pass is built on: "trace as state and trace append use the same long
 * context x and the same textual task state proxy T, **with order as the only difference**". Both are reachable and
 * the first is the default, so the project lays out the method it is testing without a profile having to ask.
 *
 * **What this replaced, and why the replacement is the fix rather than a rename.** The two arms used to be reachable
 * only as a *composition*: `stateProxyPosition` (`'before-context'`/`'after-context'`) placed `T`, and a second axis
 * placed the anchor — a boolean `xFirst`, later renamed `questionPlacement: 'first' | 'last'`. Every cell preset set
 * the anchor axis, so the two arms needed a non-default override nobody wrote, and the layout that all three cells
 * recorded — `pinned | stateProxy | anchor | recalled | tail` — is neither of the paper's: `q` is second, and the
 * paper's whole reason for separating the question from the long context is that "Models may not behave as intended
 * unless the question appears at the end of the prompt". **That second axis is deleted, not renamed (2026-10-05):
 * `q` is last by construction, so `[T, q, x]` and `[q, x]` are no longer producible and the two rows above are the
 * only orders a TAS-on layout can take.** Renaming it would have kept "the question's position is a variable"
 * expressible, and the value that asked for `q` first is refused with the sentence that retired it
 * (`LEGACY_LAYOUT_KEYS` in `config.ts`).
 *
 * With TAS off there is no T to move, so the order is the paper's baseline `M([x, q])` under either arm value; the
 * figure's T is simply absent, and saying otherwise would make the record disagree with the layout it describes.
 *
 * The two layouts differ in more than order, and the cache is where it shows. With the trace in front, the stable
 * head is the pinned prefix plus T and a change in the selection invalidates everything behind it; with the trace
 * appended, T leaves the head entirely and the head is the pinned prefix plus the tail — which is why
 * `cacheStability`
 * below is computed from the laid-out order rather than assumed. Both arms' heads now also carry `tail`, for the
 * reason the layout table above gives: `tail` is in front of the block that moves.
 */
                                                                          
import { AssociationGraph } from './assoc-graph.js';
                                                  
import { estimateTokens } from './segmenter.js';

                                
                          
                         
                                                                      
                    
                                                              
                  
                                                                                               
                   
                                                                   
                      
                        
                              
                              
              
                               
                   
                                                                    
                      
     
                                                                         
    
                                                                                                                   
                                                                                                                  
                                                                                                                   
                                                                                                            
                                                                                                                   
                                                                                                                   
                                                                                                                  
                                                                                                                 
                                                
     
                                 
     
                                                                                                                 
                                                                                                
    
                                                                                                                     
                                                                                                                     
                                                                                                                   
                                                                   
    
                                                                                                             
                                                                                                            
                                                                                                           
                                                                                                           
                                                                                                           
                                                                                                           
    
                                                                                                                  
                                                                                                                     
                                                                                                                     
                                                                             
    
                                                                                                                 
                                                                                                                  
                                                                                                        
                                                                                                                    
                                                                                                                   
                                                                                                                   
                                                                                                                    
                                                                                            
    
                                                                                                                    
                                                                                                                 
                                                                                                                    
                                                                                                                 
                                                                                                                   
                                                                                                                  
                                                                                                  
     
                         
 

export function totalTokens(segments                    )         {
  return segments.reduce((sum, s) => sum + s.tokens, 0);
}

/**
 * The tree one recall walk produced, as a nested object keyed by segment id: the anchor at the root, every hit
 * under the node `via` says it was reached from, leaves `{}`.
 *
 * Keys are ids and nothing else - no weight, no kind, no depth, no count. This is the *shape* of the walk that
 * produced the step's recall, not a ranking of it; the ranking is `layout.recalled` and `recall.selected`.
 *
 * Every hit `recall` returned is placed, including the ones the chunk de-duplication dropped afterwards: the tree
 * documents what the selector found. `hits` is the array `assemble` already has, so this reads the walk that
 * happened rather than paying for a second one.
 */
function recallTreeOf(anchorId        , hits                      )                          {
  const tree                          = {};
  // An empty object is the answer for a walk that found nothing (or was not run at all): the field is written
  // either way, because "recall produced nothing" and "nobody looked" must not both read as an absent field.
  if (hits.length === 0) return tree;
  const root                          = {};
  tree[anchorId] = root;
  const placed = new Map                                 ([[anchorId, root]]);
  // Ascending discovery depth, because `via` is frozen at discovery (`AssociationGraph.recall`): a hit's parent is
  // the anchor or a hit exactly one depth above it, so one pass places every node after its parent. Recall
  // returns its hits weight-first, which says nothing about that order.
  for (const hit of [...hits].sort((a, b) => a.depth - b.depth)) {
    // One appearance per id, under the parent that reached it first. `recall` keeps a single `best` entry per
    // node and no longer re-parents it after discovery, so a node reachable by two paths arrives here once and
    // lands under the parent that discovered it. Since 2026-10-05 the live form of that is a **branch** - a
    // diamond, two hits sharing a parent one depth up - because every step of the walk now goes strictly earlier
    // in the session's append order, so the `b -> a` back-edge of a cycle can no longer be walked at all. This
    // comment named that cycle as a co-equal reason until then; it is kept here only as the record of why the
    // cycle form is no longer reachable (`AssociationGraph.recall`, `isBackwardStep`).
    if (placed.has(hit.id)) continue;
    // A parent that is not in the tree attaches at the root instead of being dropped. Reachable only if recall
    // filtered a hit out because its segment is no longer in the graph, which is why it is a fallback and not a
    // rule: the walk did reach this id, and losing it would under-report the walk.
    const parent = placed.get(hit.via) ?? root;
    const node                          = {};
    parent[hit.id] = node;
    placed.set(hit.id, node);
  }
  return tree;
}

/**
 * Put the recalled block in a **cache-stable** order: the order its segments were first selected in.
 *
 * The input array is the caller's live order map, and the function **mutates it in place** — that mutation is the
 * whole mechanism, so it is stated here rather than left to the call site. It carries out three steps in one pass:
 *
 *   1. every id the previous block carried that is still selected keeps its position, in the order it already had;
 *   2. every id that is **new to the block** is appended, in the order `recallOrder` arrived in (the caller's own
 *      ranking: weight-descending under `tas.on`, chronological under TAS off — see the call site);
 *   3. every id that is no longer selected is dropped, so the map is a permutation of the current block and cannot
 *      grow with the session.
 *
 * **Why the block's order is a cache property and not a presentation one.** A prefix cache matches the longest
 * byte-identical prefix of two prompts, so re-ordering the block breaks the match at the first segment that moved:
 * everything from there to the end of the prompt is re-prefilled, and the block sits second-to-last in both arms
 * (the header's table), so "everything from there" is the rest of the block plus the question. Appending is
 * therefore the only change that is cheap, and this is the ordering under which a step's change is an append
 * whenever the segment was in the previous block — a segment's first-selection time is fixed, so a surviving
 * segment never moves. A *drop* is a genuine gap that no ordering can paper over: the segments behind it have to
 * close it. Measured on round `20261004-1458` C2's 18 consecutive assemblies: this order changes 2 560 tokens per
 * 10 000 of block against the recorded weight order's 7 416 (`AssembleInput.recallOrder` carries the table).
 *
 * **`tas.on === false` was ordered chronologically until 2026-10-05, and this replaces that rule rather than
 * composing with it.** The two agree on a first step (an empty map falls back to the appended order, which is
 * `recallOrder`: `seq` ascending under TAS off) and they can differ only from the second step onward, where the
 * chronological rule would re-sort the whole block by `seq` and throw away the stability the ordering exists for —
 * an old segment re-selected after a gap would move to the front and invalidate everything behind it. So the
 * recorded order under TAS off is "first-selected, ties by `seq`", not "`seq`": the baseline's *selection* is
 * unchanged (C0 selects nothing; a TAS-off profile running `tier1: 's1'` selects exactly what it selected before),
 * and a round comparing the two orders is comparing the layout, which is what `layout.order` is evidence of.
 */
function firstSelectedOrder(
  prior          ,
  recalled                    ,
  rank                          ,
)           {
  const selected = new Set(recalled.map((s) => s.id));
  const kept           = [];
  for (const id of prior) if (selected.has(id)) kept.push(id);
  const known = new Set(kept);
  // Appended in the caller's own ranking. The rank of a segment is fixed for the whole call - it is the segment's
  // position in the list recall produced, or its `seq` under TAS off - so a tie is impossible and the comparator
  // needs no second key to stay deterministic.
  const arrivals = recalled
    .filter((seg) => !known.has(seg.id))
    .sort((a, b) => rank(a) - rank(b))
    .map((seg) => seg.id);
  const next = [...kept, ...arrivals];
  // In place: the caller's array *is* the map. `length = 0` first so the assignment below replaces the contents
  // rather than overlaying them.
  prior.length = 0;
  prior.push(...next);
  return prior;
}

/**
 * Assemble one model-view context.
 *
 * **What bounds the recalled block: `r` and `d`, and nothing else.** The originating brief declares exactly three
 * tunable recall parameters — `recall.depth` (d), `recall.threshold` (r) and `recall.window` (w) — and says d and r
 * decide what is recalled, with w existing "only to save System-1 calls" and not affecting the walk at all. It
 * mentions tokens as a *cost measurement* (成本: cached input / uncached input / output), never as a limit.
 *
 * There is therefore no token cap in this function, and the absence is a decision. A share-of-budget allowance
 * (`recall.budgetRatio`, ρ, `min(floor(total × ρ), remaining)`) used to drop candidates *after* they had cleared r
 * and *inside* d, which made the recorded selection a different rule from the brief's one; and because the fixed
 * side of that subtraction counted T, a larger T shrank the recall allowance — T and the recall competing for the
 * same tokens, which the brief does not declare either. Measured before removal (round `20261004-0233`, cell C2):
 * the cap never bound — `budgetTotal` 118 800, `budgetUsed` peaking at 6 399, 9.2% of the 41 580 the ratio allowed
 * — so deleting it changed no recorded step and removed a latent divergence.
 *
 * **Overflow is the harness's job, not this file's.** S1CAP injects through `agent/pre-step`, which appends and
 * commits the block to the session log as a real surface node with its own seq, so DSH's own compaction
 * (`@deepseek-ai/dsh-compaction-basic`, `@deepseek-ai/dsh-compaction-tool-result-pruner`, both wired into every
 * cell profile) sees an injected block exactly as it sees any other message and decides when the log is too long.
 * The architecture is additive: this file adds context and never rewrites or suppresses anything. A ceiling here
 * would be a second, competing answer to a question the harness already owns — do not reintroduce one (no share, no
 * "max selected", no token ceiling) without the owner deciding to, because that is a change to the method.
 *
 * Note: with `recall.tier1 === 'off'` (cells C0/C1) the recalled block is empty by
 * design — those cells let the harness manage history natively.
 */
export function assemble(input               )                 {
  const { policy, graph, pinned, tail, current, stateProxy } = input;
  const total = Math.max(0, input.contextWindow - input.reserveOutputTokens - input.fixedOverheadTokens);

  const proxy = policy.tas.on ? (stateProxy ?? '') : '';
  // an empty T is 0 tokens, not estimateTokens('') = 1 (found by a real round: blocks.stateProxy was 1)
  const proxyTokens = policy.tas.on && proxy !== '' ? estimateTokens(proxy) : 0;

  const fixed            = [current];
  const pinnedTokens = totalTokens(pinned);
  const tailTokens = totalTokens(tail);
  // What the blocks that are *not* the recall selection cost, T included. This is an accounting figure — it is what
  // `budget.used` adds the recalled tokens to — and not an allowance: nothing below is dropped for making it large.
  // It used to be subtracted from a recall allowance, which is how T came to compete with the recall for tokens; it
  // no longer does, because there is no allowance (see the note above `assemble`).
  const fixedUsed = pinnedTokens + tailTokens + current.tokens + proxyTokens;

  // The room the step's budget has left after those fixed blocks. **Read by the μ floor below and by nothing else,
  // as the quantity a share is taken of.** It is not a ceiling on anything: no segment is dropped for exceeding it,
  // and it never decides whether the walk runs. At the default `minRecalledShare: 0` it does not affect a decision
  // at all.
  const remaining = Math.max(0, total - fixedUsed);

  // `excludeIds` is unioned in at both build sites of this set - the initial one and the fallback's reset - so
  // the exclusion survives a fallback. Pinned, tail and the anchor are structural exclusions (the model already
  // has them, or they are not history); `excludeIds` is a caller-supplied one (the anchor's sibling chunks).
  //
  // **Everything below that drops a candidate is a correctness filter, and not one of them is a budget.** The
  // distinction is what this file used to blur: a correctness filter removes content that is false, that the model
  // already has, or that duplicates something already selected, so dropping it changes *what* the model reads and
  // never *how much* it reads. A token ceiling is the other kind of rule — it drops a candidate that cleared r and
  // lay inside d because of its size, so the recorded selection stops being the one the brief's rule produces. That
  // is why the cap is gone and these stay: pinned/tail/anchor are not history at all (the model already has them in
  // the prompt), the sibling chunks below are the current event quoted back as "an earlier turn" (false and
  // redundant), and passage de-duplication removes only text fully contained in an already selected chunk.
  // A common parent alone cannot prove redundancy: its chunks may carry different facts.
  const structural = [...pinned, ...tail, current].map((s) => s.id);
  let excluded = new Set        ([...structural, ...(input.excludeIds ?? [])]);
  // Keep distinct chunks of one passage. Drop a sibling only when its complete
  // text already occurs inside a selected sibling, not merely because ids share a parent.
  const selectedParents = new Map                  ();
  const redundant = (seg         )          =>
    selectedParents.get(seg.chunkOf ?? seg.id)?.some((text) => text.includes(seg.text)) ?? false;
  const remember = (seg         )       => {
    const parent = seg.chunkOf ?? seg.id;
    const texts = selectedParents.get(parent) ?? [];
    texts.push(seg.text);
    selectedParents.set(parent, texts);
  };
  let droppedSiblings = 0;
  let recalled            = [];
  let fallback                              ;
  /** segments admitted because their pair with the anchor was inside w and unjudged; see `AssemblyResult` */
  let unknownAdmitted = 0;
  let candidates = 0;
  let bfsDepth = 0;
  /** the structure the walk below produced; `{}` when it was not run or found nothing (see `AssemblyResult`) */
  let recallTree                          = {};

  if (policy.recall.tier1 !== 'off') {
    const hits = graph.recall([current.id], {
      threshold: policy.recall.threshold,
      depth: policy.recall.depth,
      lambdaMs: input.lambdaMs,
      now: input.now,
    });
    candidates = hits.length;
    recallTree = recallTreeOf(current.id, hits);
    // The selected tokens, accumulated as the block is built. Read by the μ floor below and by nothing else; it
    // decides nothing on its own (there is no allowance to compare it against any more).
    let used = 0;
    for (const hit of hits) {
      if (excluded.has(hit.id)) continue;
      const seg = graph.getSegment(hit.id);
      if (!seg) continue;
      if (redundant(seg)) {
        droppedSiblings += 1;
        continue;
      }
      recalled.push(seg);
      excluded.add(seg.id);
      remember(seg);
      used += seg.tokens;
      bfsDepth = Math.max(bfsDepth, hit.depth);
    }

    // Two guards, and they are not the same guard. The count floor catches a *broken* selector: nothing
    // selected means a dead backend, a threshold nothing clears, or a scorer throwing on every pair, and
    // delivering a context that holds nothing but the task is worse than delivering recency. The token-share
    // floor catches a *disappointed* one — and that is the method's expected case, not an error: a selector that
    // fills a quarter of the room it had has found little, which is the whole claim. It fired on 9 of 9 steps of a
    // live run, discarding every System-1 selection before delivery could see it, which is why it is off by
    // default and has to be asked for. The share is taken of `remaining` — the room the window has left for
    // context — because the allowance it used to be a share *of* (`floor(total × ρ)`) went with the cap; μ is 0 in
    // `defaultPolicy()` and in every cell, so this is a note for an experiment that opts in, not a change to any
    // recorded round.
    // Fail-open, and it is tried *before* recency because it is strictly better information.
    //
    // An empty selection has two causes that used to be indistinguishable: the backend looked and found nothing,
    // or the backend has not answered yet. Inside the window the second is a timing fact, and the safe reading of
    // it is "relevant" - a false positive costs tokens the harness compacts for when the log grows too long, while
    // a false negative hands the step to the recency window, which is what a live session did for an entire run.
    // The admitted segments are nearest-first and bounded by `w` — `unjudgedWithin` returns the unjudged pairs
    // *inside the scoring window* and deliberately nothing outside it — and they are counted separately.
    //
    // "Has not answered" is what `unjudgedWithin` tests, and it has to be the backend's judgement rather than the
    // presence of a number: a failed System-1 call still leaves a lexical score in the graph, so a rule that asked
    // only for a score entry stayed silent through a round in which 191 of 281 `s1_call` records failed.
    if (candidates === 0 && recalled.length === 0) {
      const unknown = graph.unjudgedWithin(current.id, policy.recall.window);
      for (const seg of unknown) {
        if (excluded.has(seg.id)) continue;
        if (redundant(seg)) continue;
        recalled.push(seg);
        excluded.add(seg.id);
        remember(seg);
        used += seg.tokens;
        unknownAdmitted += 1;
      }
    }

    const tooFew = recalled.length < Math.max(0, policy.recall.minRecalledSegments);
    const underfilled = used < policy.recall.minRecalledShare * remaining;
    if ((tooFew || underfilled) && unknownAdmitted === 0) {
      fallback = 'recency-window';
      recalled = [];
      used = 0;
      // The fallback is a fresh recency window: only pinned/tail/anchor and the caller's exclusions stay excluded.
      // **What bounds it is `history` itself — the caller's candidate list, which the observer builds as the graph
      // window minus the verbatim tail — and not a token ceiling.** This is the one place where deleting the cap
      // changes what a step delivers: the ρ-bounded fallback injected at most a share of the budget, and this one
      // injects the whole candidate list. That is the intended shape of "degrade to recency" once overflow belongs
      // to the harness (see the note above `assemble`); a round that measures it will see bigger `budgetUsed` on
      // fallback steps, and `fallback: 'recency-window'` is what says why.
      excluded = new Set        ([...structural, ...(input.excludeIds ?? [])]);
      const history = [...(input.history ?? [])].sort((a, b) => a.seq - b.seq);
      // The fallback discards the recalled block entirely, so the drops counted against that discarded attempt
      // are not drops in the result. Resetting here keeps the number an account of the layout that was actually
      // emitted, rather than of every layout that was tried and thrown away.
      droppedSiblings = 0;
      selectedParents.clear();
      // `recallTree` is deliberately not reset with the block. The fallback is a judgement about what the walk
      // found - too thin to deliver - and the walk itself still happened; clearing the tree here would report the
      // recency window as if no recall had been attempted, which is the one thing this run is a measurement of.
      for (const seg of history) {
        if (excluded.has(seg.id)) continue;
        if (redundant(seg)) {
          droppedSiblings += 1;
          continue;
        }
        recalled.push(seg);
        excluded.add(seg.id);
        remember(seg);
        used += seg.tokens;
      }
    }
  }

  // Ordering: **first-selected first, and the caller's own ranking inside one step's arrivals.** The block's order
  // is what the prefix cache keeps, so the rule is the one that appends rather than the one that sorts: a segment
  // the previous step already carried keeps its offset, and only a segment new to the block can move anything - to
  // the end, where nothing is behind it but the question. `firstSelectedOrder` carries the property and the
  // measurement; what the second argument states is that the ranking *within* a step is still the selector's.
  //
  // The rank function is the rule this file used to apply to the whole block, and it is worth saying what changed,
  // because the deletion is deliberate: `tas.on` chose between "weight first" and "chronological" for the **entire**
  // block, and either way a segment already in the block could be moved by a later step's arrival. Weight order (the
  // `tas.on` branch, which no longer copies the array - it is already in that order) re-sorts the block by a number
  // that changes every step; `seq` order (the TAS-off branch) is stable for a segment but inserts an older arrival
  // at the **head** of the block, which invalidates everything behind it. Both are retained here as *tie-breakers
  // for one step's arrivals*, where they cannot disturb a segment that was already selected, and neither decides a
  // position for a segment the previous block carried. Nothing about which segments are selected changes.
  const recalledOrder = input.recallOrder;
  if (recalledOrder !== undefined) {
    // The rank of one step's arrivals, taken before the block is re-ordered: the position in the list recall
    // produced, which is `#walkHits`' weight-descending sort under TAS on. Under TAS off the rule this file used to
    // apply to the whole block is the ranking of the arrivals instead, so an unranked-by-relevance step still reads
    // chronologically.
    const at = new Map(recalled.map((seg, index) => [seg.id, index]));
    const ordered = firstSelectedOrder(recalledOrder, recalled, policy.tas.on ? (seg) => at.get(seg.id) ?? 0 : (seg) => seg.seq);
    // Back through the id map so the block is the segment objects of the order the map holds, and not of the order
    // the walk produced. The map was handed exactly this selection, so the two are the same set by construction and
    // this step cannot add or drop a segment - which is the property `recall.selected` and the equality check on
    // `layout.recalled` both rest on.
    const byId = new Map(recalled.map((seg) => [seg.id, seg]));
    recalled = ordered.flatMap((id) => {
      const seg = byId.get(id);
      return seg === undefined ? [] : [seg];
    });
  } else if (!policy.tas.on) {
    // No map: the caller did not keep one (a replay, a test, a first step). Deterministic in the selection, so the
    // same inputs still produce the same layout - which is the property `replay.ts` and `observer.test.ts` rely on.
    recalled = [...recalled].sort((a, b) => a.seq - b.seq);
  } else {
    recalled = [...recalled]; // already weight-ordered from recall
  }

  const recalledTokens = totalTokens(recalled);
  const usedTokens = fixedUsed + recalledTokens;

  // The block order, built rather than selected from a table of literals, because it is composed from the arm's
  // placement of T and the question's own fixed position - and a table would have to enumerate combinations to be
  // honest. The blocks are appended in the order the layout dictates:
  //
  //   1. `pinned` is first in every layout, always.
  //   2. T, if the arm is Trace as State (`tracePlacement: 'trace-as-state'`), goes directly behind it.
  //   3. the long context `x` behind it: `tail` then `recalled`. **`recalled` is the last block of `x`**, so a change
  //      in the selection is the cheapest place in the prompt to make one; `tail` is in front of it and therefore
  //      part of the byte-stable head.
  //   4. T, if the arm is Trace Append (`tracePlacement: 'trace-append'`), which is after all of `x`.
  //   5. the question, unconditionally: `q` is the last block of every layout this build produces, because the
  //      paper separates the question from the long context and places it "at the end of every input"
  //      (arXiv:2609.02702 §4.1) in all three of its conditions. There is no second axis to move it - the field that
  //      could (`questionPlacement`, and the boolean `xFirst` before it) was deleted on 2026-10-05, because its
  //      'first' value produced `[T, q, x]`, which is neither of the paper's two arms.
  //
  // Steps 2/4 are exclusive per setting, so exactly one order exists per `tracePlacement` value: with TAS on the
  // two orders are the paper's `[T, x, q]` and `[x, T, q]`. With TAS off there is no T block and the order has no
  // state slot in it under either value - the figure's T is simply absent, and saying otherwise would make the
  // record disagree with the layout it describes.
  const proxyInHead = policy.tas.on && policy.tracePlacement === 'trace-as-state';
  const order           = ['pinned'];
  if (proxyInHead) order.push('stateProxy');
  order.push('tail', 'recalled');
  if (policy.tas.on && !proxyInHead) order.push('stateProxy');
  order.push('anchor');

  // The byte-stable head, computed once because `tokensAfterCut` below is this same total minus itself: stating it
  // twice would let the two drift, and the failure mode is a record whose two cache numbers cannot both be true.
  // **`tail` is in the head now, and that is the second half of the same cache decision** (`recalled` is behind it):
  // the head is everything in front of `recalled` — the pinned prefix, T when the arm keeps T there, and the k most
  // recent turns. The question is not in it: `q` is last in every layout, so it is always behind whatever cut a
  // re-selection makes (it used to be added here when a profile moved it to the front, which no profile can do any
  // more).
  const layoutStableTokens = pinnedTokens + (proxyInHead ? proxyTokens : 0) + tailTokens;

  const result                 = {
    layout: {
      pinned: [...pinned],
      ...(policy.tas.on ? { stateProxy: proxy } : {}),
      recalled,
      tail: [...tail],
      anchor: current,
      order,
    },
    // Measurements, not an allowance the selection was held to. `total` is what the step's window leaves after the
    // output reserve and the fixed overhead; `used` is the size of the view this call assembled, the recalled block
    // included. Nothing caps the selection to `total` (the `recall.budgetRatio` cap did, and is gone), so `used` may
    // exceed it - and then what responds is the harness's compaction, not this file. Recorded on every assembly as
    // `budgetUsed`/`budgetTotal`, which a round reads as cost.
    budget: {
      total,
      used: usedTokens,
      byBlock: {
        pinned: pinnedTokens,
        stateProxy: proxyTokens,
        recalled: recalledTokens,
        tail: tailTokens,
        anchor: current.tokens,
      },
    },
    ...(fallback !== undefined ? { fallback } : {}),
    ...(unknownAdmitted > 0 ? { unknownAdmitted } : {}),
    // `prefixTokensStable` keeps its established meaning - it equals `blocks.pinned`, which is the N1
    // acceptance criterion recorded in STATUS.md - so it is deliberately not reused for the layout question.
    // What the layout changes is how much of the *front* of the prompt survives a step unchanged, and that is
    // reported separately: the pinned prefix is stable in every layout, `tail` is stable in every layout because it
    // is in front of the block that moves, and T is stable **only while it is in the head**
    // (`tracePlacement: 'trace-as-state'`). The question is never part of it: `q` is last in every layout now, so it
    // sits behind whatever cut a re-selection makes.
    cacheStability: {
      prefixTokensStable: pinnedTokens,
      // `proxyInHead` is the same condition the layout used to place T, so this number cannot claim T is cached
      // in a prefix the order just put it behind: under `'trace-append'` the head is the pinned prefix plus the tail,
      // and everything in front of T re-prefills when the selection changes.
      layoutStableTokens,
      // The cut point is where a re-selection would break the prefix, so it is the last block of the stable head.
      // **It is `'recalled'` once the block has anything in it**, because `recalled` is the block that moves and the
      // head is everything in front of it, in both arms; an empty block is the case that needs the branch below,
      // since there is then no re-selection that can break anything and the honest answer is the last block that was
      // really laid out in front of it - `'stateProxy'` when the arm keeps T there and T is not empty, and `'pinned'`
      // otherwise (`tail` is empty in that case too, because `tail` is in front of an empty `recalled`).
      //
      // `decideReselect` prices that, and it cannot do so without being told where the cut is - which is the number
      // this field exists to carry. (Nothing in `packages/*/src` calls `decideReselect`; the field is a record.)
      //
      // This used to be keyed on `tracePlacement` alone and to name `'stateProxy'` for every TAS-on layout, including
      // the TAS-off cells, which have no such block. That was reported rather than corrected while the question was
      // whether a TAS-off cell's record should change; the answer the second half of this change gives is that the
      // field now tracks the layout it describes, empty block included.
      cutAfterBlock:
        recalled.length > 0
          ? 'recalled'
          : proxyInHead && proxyTokens > 0
            ? 'stateProxy'
            : 'pinned',
      // Tokens that would re-prefill after a cut at that point: everything in the assembled view that is not in the
      // head. Written as the difference rather than as a branch, so it follows the layout by construction instead
      // of needing a further case each time a placement is added.
      tokensAfterCut: usedTokens - layoutStableTokens,
    },
    recall: { candidates, selected: recalled.length, bfsDepth, ...(droppedSiblings > 0 ? { droppedSiblings } : {}) },
    recallTree,
  };
  return result;
}
