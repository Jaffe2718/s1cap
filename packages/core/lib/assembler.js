/**
 * ASSEMBLER — budgeted recall + Trace-as-State layout.
 * Two layouts, selected by `policy.xFirst`:
 *   - false: `[pinned | T | recalled | tail | x]` — the task last, the arrangement in docs/FORMULAS.md §3.4.
 *   - true:  `[pinned | T | x | recalled | tail]` — the task first, "state then information" (§2 of the paper).
 * The two differ in more than order: with x last, the stable prefix ends at T and the whole tail of the prompt
 * is history, so a change in x invalidates everything after it; with x first, the prefix still ends at T, and
 * x itself becomes part of the byte-stable head as long as the task has not changed.
 */
                                                                          
import { AssociationGraph } from './assoc-graph.js';
import { estimateTokens } from './segmenter.js';

                                
                          
                         
                                                                      
                    
                                                              
                  
                                                   
                   
                                                                   
                      
                        
                              
                              
              
                               
                   
                                                                    
                      
 

export function totalTokens(segments                    )         {
  return segments.reduce((sum, s) => sum + s.tokens, 0);
}

/**
 * Assemble one model-view context.
 *
 * Note: with `recall.tier1 === 'off'` (cells C1/C2) the recalled block is empty by
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
  const fixedUsed = pinnedTokens + tailTokens + current.tokens + proxyTokens;

  const remaining = Math.max(0, total - fixedUsed);
  const recalledBudget = Math.min(Math.floor(total * policy.recall.budgetRatio), remaining);

  let excluded = new Set        ([...pinned, ...tail, current].map((s) => s.id));
  // A long event is split into overlapping chunks that share a `chunkOf` parent. Recall scores each chunk
  // independently, so two halves of one paragraph can both clear the threshold and both be selected - the model
  // would then pay twice for the same passage, with the overlap repeated verbatim. Tracking the parents keeps
  // the first-selected chunk of a passage and drops its siblings, which is the one place where a duplicate can
  // be removed without losing a distinct fact.
  const selectedParents = new Set        ();
  let droppedSiblings = 0;
  let recalled            = [];
  let fallback                              ;
  /** segments admitted because their pair with the anchor was inside w and unscored; see `AssemblyResult` */
  let unknownAdmitted = 0;
  let candidates = 0;
  let bfsDepth = 0;

  if (policy.recall.tier1 !== 'off' && recalledBudget > 0) {
    const hits = graph.recall([current.id], {
      threshold: policy.recall.threshold,
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
      const parent = seg.chunkOf ?? seg.id;
      if (selectedParents.has(parent)) {
        droppedSiblings += 1;
        continue;
      }
      if (used + seg.tokens > recalledBudget) continue;
      recalled.push(seg);
      excluded.add(seg.id);
      selectedParents.add(parent);
      used += seg.tokens;
      bfsDepth = Math.max(bfsDepth, hit.depth);
    }

    // Two guards, and they are not the same guard. The count floor catches a *broken* selector: nothing
    // selected means a dead backend, a threshold nothing clears, or a scorer throwing on every pair, and
    // delivering a context that holds nothing but the task is worse than delivering recency. The token-share
    // floor catches a *disappointed* one — and that is the method's expected case, not an error: a selector that
    // fills a quarter of the budget has found little, which is the whole claim. It fired on 9 of 9 steps of a
    // live run, discarding every System-1 selection before delivery could see it, which is why it is off by
    // default and has to be asked for.
    // Fail-open, and it is tried *before* recency because it is strictly better information.
    //
    // An empty selection has two causes that used to be indistinguishable: the backend looked and found nothing,
    // or the backend has not answered yet. Inside the window the second is a timing fact, and the safe reading of
    // it is "relevant" - a false positive spends tokens under a budget that already caps this block, while a false
    // negative hands the step to the recency window, which is what a live session did for an entire run. The
    // admitted segments are nearest-first, bounded by the same budget, and counted separately.
    if (candidates === 0 && recalled.length === 0) {
      const unknown = graph.unscoredWithin(current.id, policy.recall.window);
      for (const seg of unknown) {
        if (used + seg.tokens > recalledBudget) break;
        const parent = seg.chunkOf ?? seg.id;
        if (selectedParents.has(parent)) continue;
        recalled.push(seg);
        excluded.add(seg.id);
        selectedParents.add(parent);
        used += seg.tokens;
        unknownAdmitted += 1;
      }
    }

    const tooFew = recalled.length < Math.max(0, policy.recall.minRecalledSegments);
    const underfilled = used < policy.recall.minRecalledShare * recalledBudget;
    if ((tooFew || underfilled) && unknownAdmitted === 0) {
      fallback = 'recency-window';
      recalled = [];
      used = 0;
      // The fallback is a fresh recency window: only pinned/tail/anchor stay excluded.
      excluded = new Set        ([...pinned, ...tail, current].map((s) => s.id));
      const history = [...(input.history ?? [])].sort((a, b) => a.seq - b.seq);
      // The fallback discards the recalled block entirely, so the drops counted against that discarded attempt
      // are not drops in the result. Resetting here keeps the number an account of the layout that was actually
      // emitted, rather than of every layout that was tried and thrown away.
      droppedSiblings = 0;
      selectedParents.clear();
      for (const seg of history) {
        if (excluded.has(seg.id)) continue;
        const parent = seg.chunkOf ?? seg.id;
        if (selectedParents.has(parent)) {
          droppedSiblings += 1;
          continue;
        }
        if (used + seg.tokens > recalledBudget) continue;
        recalled.push(seg);
        excluded.add(seg.id);
        selectedParents.add(parent);
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
  // The block order is a real branch, not a cosmetic one, so it is reported in the result. With TAS off there
  // is no T block and the order has no state slot in it - the figure's T is simply absent, and saying
  // otherwise would make the record disagree with the layout it describes.
  const order = policy.tas.on
    ? policy.xFirst
      ? ['pinned', 'stateProxy', 'anchor', 'recalled', 'tail']
      : ['pinned', 'stateProxy', 'recalled', 'tail', 'anchor']
    : policy.xFirst
      ? ['pinned', 'anchor', 'recalled', 'tail']
      : ['pinned', 'recalled', 'tail', 'anchor'];

  const result                 = {
    layout: {
      pinned: [...pinned],
      ...(policy.tas.on ? { stateProxy: proxy } : {}),
      recalled,
      tail: [...tail],
      anchor: current,
      order,
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
    ...(unknownAdmitted > 0 ? { unknownAdmitted } : {}),
    // `prefixTokensStable` keeps its established meaning - it equals `blocks.pinned`, which is the N1
    // acceptance criterion recorded in STATUS.md - so it is deliberately not reused for the layout question.
    // What the layout changes is how much of the *front* of the prompt survives a step unchanged, and that is
    // reported separately: both orders keep the pinned prefix and T stable, and only xFirst can add x to that
    // head, which it may because the task changes per task (`cache.reselectPolicy: 'perTask'`), not per step.
    cacheStability: {
      prefixTokensStable: pinnedTokens,
      layoutStableTokens: pinnedTokens + proxyTokens + (policy.xFirst ? current.tokens : 0),
      // The cut point is where a re-selection would break the prefix, so it is the first thing after the
      // stable head that can change. With x first that is the recalled block; with x last it is x itself, and
      // the whole history behind it re-prefills. `decideReselect` prices that, and it cannot do so without
      // being told where the cut is - which is the number this field exists to carry.
      cutAfterBlock: policy.xFirst ? 'anchor' : 'stateProxy',
      // Tokens that would re-prefill after a cut at that point. With x first, recalled+tail are the moving
      // part; with x last, everything from the recalled block on is behind the task.
      tokensAfterCut:
        policy.xFirst
          ? recalledTokens + tailTokens
          : recalledTokens + tailTokens + current.tokens,
    },
    recall: { candidates, selected: recalled.length, bfsDepth, ...(droppedSiblings > 0 ? { droppedSiblings } : {}) },
  };
  return result;
}
