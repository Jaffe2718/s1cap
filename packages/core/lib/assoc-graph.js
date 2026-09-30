/**
 * Association graph (RG) — nodes are segments, edges are System-1-scored relevance
 * relations with recency decay (docs/FORMULAS.md §2, docs/AGENT_BRIEF.md §5.2).
 *
 * Storage is in-memory for M0/M1; the SQLite-backed store plugs in behind the
 * same surface (segments + edges + provenance).
 */
                                                           

/** w_eff = w · exp(−Δt/λ) */
export function decayedWeight(w        , ageMs        , lambdaMs        )         {
  if (!(lambdaMs > 0)) return w;
  return w * Math.exp(-Math.max(0, ageMs) / lambdaMs);
}

                                
                              
                             
                            
                
                                    
                 
                               
                   
                                          
              
 

                            
             
                                                                   
            
                                            
              
                
 

/**
 * The serialised form of one session's graph. Versioned, because a graph written by an older build
 * is not a graph a newer build may half-read: an unrecognised version is treated as absent, so the
 * worst a stale file can cost is the scoring it did not carry over.
 */
export const RG_SNAPSHOT_SCHEMA = 1;

                             
                 
     
                                                                                                               
                                                                                                                 
     
                     
                                                                      
                  
                      
                           
                                                                                                   
                 
                      
 

export class AssociationGraph {
  #segments = new Map                 ();
  /** insertion order, for the scoring window */
  #order           = [];
  /** how many entries of #order have been scored already */
  #scored = 0;
  /** cumulative pair comparisons - the number recall.window is meant to bound */
  #scoredPairs = 0;
  #edges = new Map                         ();
  #adj = new Map                  ();

  get segmentCount()         {
    return this.#segments.size;
  }

  get edgeCount()         {
    return this.#edges.size;
  }

  addSegments(segments                   )       {
      for (const s of segments) {
        this.#segments.set(s.id, s);
        if (!this.#order.includes(s.id)) this.#order.push(s.id);
      }
  }

  /**
   * Score segments that arrived since the last call, each against only the most recent `windowN` segments.
   *
   * This is where `recall.window = w` lives. The cost is one pass of `w` comparisons per new segment - O(w),
   * independent of how long the session has grown - and `scoredPairs` makes that saving measurable instead of
   * rhetorical. Segments outside the window are untouched: they keep every edge they already had and stay
   * reachable by `recall()`, because w only decides *whether a pair is scored*, not what exists in the graph.
   */
  async scoreNew(opts   
                    
                      
                                               
       
                                                                                                               
                  
      
                                                                                                             
                                                                                                              
                                                                                                                
                                                                                                           
       
                  
                       
                                     
                                                                                
   )   
                        
                  
    {
    const windowN = Math.max(1, Math.trunc(opts.windowN));
    const scorer = opts.score ?? lexicalScore;
    let scoredPairs = 0;
    let edges = 0;
    while (this.#scored < this.#order.length) {
      const id = this.#order[this.#scored]          ;
      this.#scored += 1;
      const current = this.#segments.get(id);
      if (current === undefined) continue;
      const from = Math.max(0, this.#scored - 1 - windowN);
      // Collect the window first so a batch scorer sees it as a unit. The pairs counted here are the same
      // pairs either way: w decides how much is scored, not who does the scoring.
      const candidates            = [];
      for (let i = from; i < this.#scored - 1; i += 1) {
        const other = this.#segments.get(this.#order[i]          );
        if (other !== undefined) candidates.push(other);
      }
      if (candidates.length === 0) continue;
      scoredPairs += candidates.length;

      let weights                   ;
      // Which scorer produced the weights, so the edge can say so. `undefined` from the batch scorer means the
      // System-1 backend did not answer this segment and the local fallback produced every weight in it; calling
      // that edge `'s1'` was a provenance lie, not merely an untyped literal.
      let byBackend = false;
      if (opts.scoreBatch !== undefined) {
        // `undefined` is the batch scorer's way of saying "I could not answer this one" - a backend that
        // timed out, or a level the answer did not carry. That degrades to the local lexical scorer for this
        // segment, which is less accurate but never wrong by omission: a system with no System-1 still works.
        const batch = await opts.scoreBatch(current, candidates);
        byBackend = batch !== undefined;
        weights = batch === undefined ? candidates.map((other) => scorer(current, other)) : batch;
        if (weights.length !== candidates.length) {
          throw new Error(
            `batch scorer returned ${weights.length} weights for ${candidates.length} candidates`,
          );
        }
      } else {
        weights = candidates.map((other) => scorer(current, other));
      }

      for (let i = 0; i < candidates.length; i += 1) {
        const weight = weights[i]          ;
        if (!Number.isFinite(weight) || weight < opts.threshold) continue;
        this.upsertEdge({
          from: (candidates[i]           ).id,
          to: id,
          w: weight,
          wTier1: weight,
          // `'s1-noul'` is the only System-1 question shape the association path asks; `'lexical'` means
          // "computed here, no backend consulted", which is the distinction an experiment has to be able to read.
          source: byBackend ? 's1-noul' : 'lexical',
          verifiedAt: current.ts,
          provenance: byBackend ? `window:${String(windowN)};s1` : `window:${String(windowN)};fallback`,
        });
        edges += 1;
      }
    }
    this.#scoredPairs += scoredPairs;
    return { scoredPairs, edges };
  }
  getSegment(id        )                      {
    return this.#segments.get(id);
  }

  /**
   * Every segment in append order, optionally only the most recent `limit` of them.
   *
   * Read-only and additive, because the model view is now assembled from the graph: the harness's step payload
   * carries only the messages claimed for that step (measured: one user message on the first step, an empty
   * array on every step after), while the session-event stream this graph is fed from holds the whole
   * conversation. The observer needs the ordered tail to place x and the history that recall did not keep, and
   * that ordering is the graph's own - the append order of the session log.
   */
  orderedSegments(limit         )            {
    const out            = [];
    const from = limit === undefined ? 0 : Math.max(0, this.#order.length - Math.max(0, Math.trunc(limit)));
    for (let i = from; i < this.#order.length; i += 1) {
      const segment = this.#segments.get(this.#order[i]          );
      if (segment !== undefined) out.push(segment);
    }
    return out;
  }

  /** Insert or replace an edge (key = `${from}->${to}`), indexed in both directions. */
  upsertEdge(edge                 )       {
    const key = `${edge.from}->${edge.to}`;
    this.#edges.set(key, edge);
    this.#link(edge.from, edge.to);
  }

  #link(a        , b        )       {
    const list = this.#adj.get(a) ?? [];
    if (!list.includes(b)) list.push(b);
    this.#adj.set(a, list);
    const back = this.#adj.get(b) ?? [];
    if (!back.includes(a)) back.push(a);
    this.#adj.set(b, back);
  }

  neighbors(id        )                    {
    const ids = this.#adj.get(id) ?? [];
    const out                    = [];
    for (const other of ids) {
      const e = this.#edges.get(`${id}->${other}`) ?? this.#edges.get(`${other}->${id}`);
      if (e) out.push(e);
    }
    return out;
  }

  /**
   * Bounded BFS from the seed segments over edges with w_eff > τ,
   * depth ≤ d, expanding at most k neighbours per node.
   * Returns hits (seeds excluded), best weight first.
   */
  recall(seedIds                   , opts               )              {
    const seeds = new Set        (seedIds);
    const best = new Map                   ();
    const visited = new Set        (seedIds);
    let frontier                                  = seedIds.map((id) => ({ id, depth: 0 }));

    while (frontier.length > 0) {
      const next                                  = [];
      for (const node of frontier) {
        if (node.depth >= opts.depth) continue;
        const ranked = this.neighbors(node.id)
          .map((e) => {
            const other = e.from === node.id ? e.to : e.from;
            const age = opts.now - e.verifiedAt;
            return { other, w: decayedWeight(e.w, age, opts.lambdaMs) };
          })
          .filter((n) => n.w > opts.relevanceThreshold)
          .sort((a, b) => b.w - a.w)
          .slice(0, Math.max(0, opts.fanout));

        for (const n of ranked) {
          // Seeds are the query anchors, never recall hits (back-edges would re-add them).
          if (seeds.has(n.other)) continue;
          const depth = node.depth + 1;
          const prev = best.get(n.other);
          if (!prev || n.w > prev.w) {
            best.set(n.other, { id: n.other, w: n.w, via: node.id, depth });
          }
          if (!visited.has(n.other)) {
            visited.add(n.other);
            next.push({ id: n.other, depth });
          }
        }
      }
      frontier = next;
    }

    return [...best.values()]
      .filter((h) => this.#segments.has(h.id))
      .sort((a, b) => b.w - a.w);
  }

    stats()                                                           {
      return { segments: this.#segments.size, edges: this.#edges.size, scoredPairs: this.#scoredPairs };
  }

  /**
   * Everything the graph holds, in a form that survives the process.
   *
   * The scoring cursor is part of the snapshot, and it is the reason a snapshot is worth writing at all: without
   * `scored`, a restarted session would re-ask the System-1 backend about pairs it had already paid for. `adj`
   * is derived from `edges` and is therefore rebuilt rather than stored.
   */
  snapshot()             {
    return {
      schema: RG_SNAPSHOT_SCHEMA,
      order: [...this.#order],
      segments: [...this.#segments.values()],
      edges: [...this.#edges.values()],
      scored: this.#scored,
      scoredPairs: this.#scoredPairs,
    };
  }

  /** Rebuild a graph from a snapshot. An unrecognised schema version yields an empty graph, not a partial one. */
  static fromSnapshot(snap                        )                   {
    const graph = new AssociationGraph();
    if (snap === undefined || snap.schema !== RG_SNAPSHOT_SCHEMA) return graph;
    for (const segment of snap.segments ?? []) graph.#segments.set(segment.id, segment);
    graph.#order = (snap.order ?? []).filter((id) => graph.#segments.has(id));
    for (const edge of snap.edges ?? []) {
      graph.#edges.set(`${edge.from}->${edge.to}`, edge);
      graph.#link(edge.from, edge.to);
    }
    // Clamped, because a cursor larger than the order array would silently skip scoring forever.
    graph.#scored = Math.max(0, Math.min(graph.#order.length, Math.trunc(snap.scored ?? 0)));
    graph.#scoredPairs = Math.max(0, Math.trunc(snap.scoredPairs ?? 0));
    return graph;
  }
}

/**
 * Local lexical fallback scorer (shared tokens over the smaller token count). It stands in for the System-1
 * association backend so the window and its cost are testable offline; the S1 scorer replaces it later without
 * touching the windowing logic.
 */
export function lexicalScore(a         , b         )         {
  const left = tokensOf(a.text);
  const right = tokensOf(b.text);
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  return shared / Math.min(left.size, right.size);
}

function tokensOf(text        )              {
  const out = new Set        ();
  for (const token of text.toLowerCase().split(/[^\\p{L}\\p{N}_]+/u)) {
    if (token.length > 1) out.add(token);
  }
  return out;
}
