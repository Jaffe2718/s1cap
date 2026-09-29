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
  let candidates = 0;
  let bfsDepth = 0;

  if (policy.recall.tier1 !== 'off' && recalledBudget > 0) {
    const hits = graph.recall([current.id], {
      relevanceThreshold: policy.recall.relevanceThreshold,
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

    if (used < policy.recall.minRecalledShare * recalledBudget) {
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
    // `prefixTokensStable` keeps its established meaning - it equals `blocks.pinned`, which is the N1
    // acceptance criterion recorded in STATUS.md - so it is deliberately not reused for the layout question.
    // What the layout changes is how much of the *front* of the prompt survives a step unchanged, and that is
    // reported separately: both orders keep the pinned prefix and T stable, and only xFirst can add x to that
    // head, which it may because the task changes per task (`cache.reselectPolicy: 'perTask'`), not per step.
    cacheStability: {
      prefixTokensStable: pinnedTokens,
      layoutStableTokens: pinnedTokens + proxyTokens + (policy.xFirst ? current.tokens : 0),
    },
    recall: { candidates, selected: recalled.length, bfsDepth, ...(droppedSiblings > 0 ? { droppedSiblings } : {}) },
  };
  return result;
}
