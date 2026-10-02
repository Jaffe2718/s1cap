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
export const RG_SNAPSHOT_SCHEMA = 2;

/**
 * One pair the association backend was actually asked about, with the probability it returned.
 *
 * This exists because the graph kept only the pairs that cleared the threshold: `scoreNew` tested the weight
 * against `recall.threshold` and `continue`d, so a probability of 0.54 was computed, paid for, and discarded.
 * Three things follow from keeping them, and each is a reason the field is here.
 *
 *  - The threshold becomes what the brief says it is - a *traversal* test for the BFS ("关联超过阈值 r 就继续计算")
 *    - instead of an ingest filter that destroys the measurement before anything can read it.
 *  - `r` becomes sweepable offline. It is one of the three ablation knobs, and a run recorded at r = 0.55 could
 *    not previously be re-read at r = 0.3 without asking the backend for every pair a second time.
 *  - The graph stops throwing away its only graded signal. Edges are binary by construction, which is why a
 *    connectivity matrix drawn from them can only ever be a yes/no picture.
 */
                             
               
             
                                                                                             
            
                                                                            
                     
             
 

                             
                 
     
                                                                                                               
                                                                                                                 
     
                     
                                                                      
                  
                      
                           
     
                                                                                                               
                                                                                              
     
                        
                                                                                                   
                 
                      
                                                                                                       
                       
     
                                                                                                            
                                                                                                                
                                                                                        
     
                         
                            
 

/**
 * The batch scorer's answer for "not now" — distinct from `undefined`, which means "no backend".
 *
 * A saturated backend and an absent backend are two different facts and must not share a signal. `undefined`
 * makes the graph score the window with its local lexical fallback and advance its cursor, which is right for a
 * session that has no System-1 lane at all: the graph keeps working and says `lexical` on every edge. It is wrong
 * for a backend that is refusing right now, because the pair would be paid for once as a lexical row and would
 * never be asked about again — the `scored` cursor is one-way — so the very work the backend was too busy to do
 * would be silently downgraded rather than deferred.
 *
 * Returning this sentinel instead says: do not score this window, do not advance the cursor, and count the pairs
 * as deferred. `scoreNew` then hands the segment back on a later tick with the same window.
 *
 * It is an exported constant rather than a class because both sides must agree on one identity: the graph tests
 * `batch === S1_DEFERRED` and the scorer returns the same object, so no field can drift out of sync with a
 * reader.
 */
export const S1_DEFERRED                = Symbol.for('s1cap.s1-deferred');

                                            

export class AssociationGraph {
  #segments = new Map                 ();
  /** insertion order, for the scoring window */
  #order           = [];
  /** membership test for #order, so `addSegments` is not quadratic in a long session */
  #known = new Set        ();
  /** how many entries of #order have been scored already */
  #scored = 0;
  /** cumulative pair comparisons - the number recall.window is meant to bound */
  #scoredPairs = 0;
  /**
   * Pairs the backend actually answered, as opposed to pairs it was offered.
   *
   * `scoredPairs` counts offered pairs and has been read as "pairs that were scored" since it was written, which
   * is how a live session reported 18528 scored pairs while 1796 had been judged and 1863 questions had timed
   * out. Two numbers that can be subtracted are worth more than one that has to be trusted.
   */
  #judgedPairs = 0;
  /**
   * Segments that were *not offered* to the batch scorer because the backend was saturated, and the pairs that
   * went with them.
   *
   * Separated from `scoredPairs` on purpose, and it is the whole reason `judgedPairs / scoredPairs` stays an
   * honest coverage ratio. A deferred segment never reaches the scorer, so counting its window in `scoredPairs`
   * would print "the backend judged 4 152 of 860 672 pairs" for a run that in fact never asked about most of
   * them — a coverage number computed from work that was never offered. Instead the offer is not counted at all
   * and the omission is counted here, beside it. Measured on round `20261002-2037`: `scoredPairs` 860 672,
   * `judgedPairs` 4 152, no deferral accounting of any kind, and 3 859 refused calls between them.
   */
  #deferredPairs = 0;
  #deferredSegments = 0;
  /** how far the deferral count has been taken; see `deferSegment` in `scoreNew` */
  #deferralCounted = 0;
  #edges = new Map                         ();
  /** every scored pair, above and below the threshold, by `${from}->${to}`; see `ScoredPair` */
  #scores = new Map                    ();
  #adj = new Map                  ();

  get segmentCount()         {
    return this.#segments.size;
  }

  get edgeCount()         {
    return this.#edges.size;
  }

  /** pairs the backend was asked about, which is not the same number as the edges they produced */
  get scoreCount()         {
    return this.#scores.size;
  }

  addSegments(segments                   )       {
      for (const s of segments) {
        this.#segments.set(s.id, s);
        if (!this.#known.has(s.id)) {
          this.#known.add(s.id);
          this.#order.push(s.id);
        }
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
    const maxPairs =
      opts.maxPairsPerSweep === undefined ? Number.POSITIVE_INFINITY : Math.max(1, Math.trunc(opts.maxPairsPerSweep));
    const scorer = opts.score ?? lexicalScore;
    let scoredPairs = 0;
    let judgedPairs = 0;
    let edges = 0;
    let deferredPairs = 0;
    let deferredSegments = 0;
    /**
     * The highest segment whose window has been *counted* as deferred, plus one. Monotonic, like `#scored`, and
     * the reason a sweep can count the whole backlog behind a budget stop without inflating the total when it is
     * called again on the next sweep. See `deferSegment` and `countDeferredSuffix` below.
     */
    let lastOffered = this.#scored;
    /**
     * Count one segment's window as deferred, at most once.
     *
     * The cursor does not advance over a deferred segment, so the next sweep walks it again and would add its
     * window to the total a second time - reporting more deferred pairs than the session has. `deferSegment`'s
     * guard is what makes the counting idempotent across sweeps, and `countDeferredSuffix` relies on that instead
     * of trying to remember what it counted last time.
     */
    const deferSegment = (index        , pairs        )       => {
      if (index < this.#deferralCounted) return;
      this.#deferralCounted = index + 1;
      deferredPairs += pairs;
      deferredSegments += 1;
    };
    /**
     * Count the windows of every segment from `index` on that this call did not offer.
     *
     * A walk, not a request: no scorer is called and the cursor does not move. `#scored` is always ≤ `index` here -
     * the cursor never passes a segment that was not offered - so "from `index` on" is exactly the set of segments
     * still waiting, and counting from the front of that set each time is both complete and idempotent. Without
     * that, a backlog of tens of thousands of pairs behind one budget stop would be reported as the size of one
     * window, which is the one direction this accounting must not lean.
     */
    const countDeferredSuffix = (index        )       => {
      for (let i = index; i < this.#order.length; i += 1) {
        if (i < this.#deferralCounted) continue;
        const id = this.#order[i]          ;
        if (!this.#segments.has(id)) continue;
        const from = Math.max(0, i - windowN);
        let pairs = 0;
        for (let j = from; j < i; j += 1) if (this.#segments.has(this.#order[j]          )) pairs += 1;
        if (pairs > 0) deferSegment(i, pairs);
      }
    };
    while (lastOffered < this.#order.length) {
      const id = this.#order[lastOffered]          ;
      const current = this.#segments.get(id);
      if (current === undefined) {
        // Nothing to score for this entry, so the cursor moves over it. Counted with the segments that were
        // offered, because "this entry cost nothing" and "this entry was postponed" are different facts.
        lastOffered += 1;
        this.#scored = lastOffered;
        continue;
      }
      const from = Math.max(0, lastOffered - windowN);
      // Collect the window first so a batch scorer sees it as a unit. The pairs counted here are the same
      // pairs either way: w decides how much is scored, not who does the scoring.
      const candidates            = [];
      for (let i = from; i < lastOffered; i += 1) {
        const other = this.#segments.get(this.#order[i]          );
        if (other !== undefined) candidates.push(other);
      }
      if (candidates.length === 0) {
        lastOffered += 1;
        this.#scored = lastOffered;
        continue;
      }
      // The per-call budget. Tested only when something has already been offered this call: the cursor never
      // passes a segment that was not offered, so a budget that refused the *first* segment would stop on it
      // forever - a backlog it could never work through. The budget therefore bounds a sweep's size, not whether
      // it can make progress, and the pair count of a single window is already bounded by `w`.
      if (scoredPairs > 0 && scoredPairs + candidates.length > maxPairs) {
        countDeferredSuffix(lastOffered);
        break;
      }
      // Offered from here on: `#scored` is where the next call resumes, and it moves only past a segment the
      // scorer has taken (or one that had no window at all).
      const index = lastOffered;
      lastOffered += 1;
      scoredPairs += candidates.length;
      this.#scored = index + 1;

      let weights                   ;
      // Which scorer produced the weights, so the edge can say so. `undefined` from the batch scorer means the
      // System-1 backend did not answer this segment and the local fallback produced every weight in it; calling
      // that edge `'s1'` was a provenance lie, not merely an untyped literal.
      let byBackend = false;
      if (opts.scoreBatch !== undefined) {
        const batch = await opts.scoreBatch(current, candidates);
        if (batch === S1_DEFERRED) {
          // Not now. The offer is withdrawn rather than paid for: `scoredPairs` gives the pair back and the
          // cursor steps back onto this segment, so the window is offered again - whole - on a later call.
          // Counting it as offered-but-unjudged instead would make `judgedPairs / scoredPairs` fall for a reason
          // the reader cannot see, and scoring it lexically would spend the pair for good.
          this.#scored -= 1;
          scoredPairs -= candidates.length;
          countDeferredSuffix(index);
          break;
        }
        // `undefined` is the batch scorer's way of saying "I could not answer this one" - a backend that
        // timed out, or a level the answer did not carry. That degrades to the local lexical scorer for this
        // segment, which is less accurate but never wrong by omission: a system with no System-1 still works.
        byBackend = batch !== undefined;
        // Offered versus judged, counted where the difference is decided: the backend answered this window, or the
        // fallback did. `scoredPairs` cannot tell the two apart, and reading it as "judged" is what made a 9.7%
        // coverage rate look like full coverage.
        if (byBackend) judgedPairs += candidates.length;
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
        const other = candidates[i]           ;
        // `'s1-noul'` is the only System-1 question shape the association path asks; `'lexical'` means
        // "computed here, no backend consulted", which is the distinction an experiment has to be able to read.
        const source             = byBackend ? 's1-noul' : 'lexical';
        // Recorded before the threshold, not after it. The probability is the measurement; the threshold is a
        // reading of it. Testing first - which is what this did - spent the System-1 call and kept only the
        // verdict, leaving a graph that cannot answer "how relevant was it" or "what would r = 0.3 have kept".
        if (Number.isFinite(weight)) {
          this.#scores.set(`${other.id}->${id}`, { from: other.id, to: id, w: weight, source, at: current.ts });
        }
        if (!Number.isFinite(weight) || weight < opts.threshold) continue;
        this.upsertEdge({
          from: other.id,
          to: id,
          w: weight,
          wTier1: weight,
          source,
          verifiedAt: current.ts,
          provenance: byBackend ? `window:${String(windowN)};s1` : `window:${String(windowN)};fallback`,
        });
        edges += 1;
      }
    }
    this.#scoredPairs += scoredPairs;
    this.#judgedPairs += judgedPairs;
    this.#deferredPairs += deferredPairs;
    this.#deferredSegments += deferredSegments;
    return { scoredPairs, judgedPairs, edges, deferredPairs, deferredSegments };
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
   *
   * The hits describe a tree rooted at the seed: `via` is the parent that *discovered* the hit and `depth` its
   * discovery depth, both fixed at discovery, while `w` is the heaviest path's weight. The two are allowed to
   * disagree, because they answer different questions - what to rank by, and what the walk looked like.
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
          .filter((n) => n.w > opts.threshold)
          .sort((a, b) => b.w - a.w)
          .slice(0, Math.max(0, opts.fanout));

        for (const n of ranked) {
          // Seeds are the query anchors, never recall hits (back-edges would re-add them).
          if (seeds.has(n.other)) continue;
          const depth = node.depth + 1;
          const prev = best.get(n.other);
          if (prev === undefined) {
            // `via` and `depth` are written once, at discovery, and never rewritten.
            //
            // They used to be overwritten whenever a heavier path to the node turned up later
            // (`if (!prev || n.w > prev.w) best.set(...)`), which made `via` mean "the best predecessor seen so
            // far" rather than "the parent that discovered this node". A tree rebuilt from that is only
            // tree-*shaped*: it can re-parent a node under a node discovered after it, or close a cycle - anchor
            // `x -> a`, `a -> b`, then `b -> a` heavier than `x -> a` gives `best = {a: via b, b: via a}` - and the
            // structure logged for a step would then not be the walk that produced its selection. `recallTree`
            // records that walk, so the parent it records has to be the one the walk actually took.
            best.set(n.other, { id: n.other, w: n.w, via: node.id, depth });
          } else if (n.w > prev.w) {
            // A heavier path still raises the weight - it is what the hit is ranked, thresholded and ordered by -
            // but it does not re-parent the node. Keeping the two decisions apart is what makes a tree possible
            // at all: the strongest path and the discovery edge are no longer required to agree.
            prev.w = n.w;
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

    stats()   
                       
                    
                          
                          
                            
      {
      return {
        segments: this.#segments.size,
        edges: this.#edges.size,
        scoredPairs: this.#scoredPairs,
        judgedPairs: this.#judgedPairs,
        deferredPairs: this.#deferredPairs,
      };
  }

  /**
   * Pairs the run declined to offer because the backend was saturated, cumulative.
   *
   * Read beside `scoredPairs`, never inside it. A deferred pair was not offered to any scorer, so adding it to
   * the denominator would report coverage over work that never happened; leaving it out and saying nothing would
   * hide the work the run chose not to do. `scoredPairs + deferredPairs` is the window the session's arrival
   * order would have offered, `judgedPairs / scoredPairs` stays the share of what *was* offered that the backend
   * answered, and `deferredPairs` is the size of the omission with its reason already stated by the scorer.
   */
  get deferredPairs()         {
    return this.#deferredPairs;
  }

  /** Segments whose window has not been offered yet; their pairs are the `deferredPairs` above. */
  get deferredSegments()         {
    return this.#deferredSegments;
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
      scores: [...this.#scores.values()],
      scored: this.#scored,
      scoredPairs: this.#scoredPairs,
      judgedPairs: this.#judgedPairs,
      deferredPairs: this.#deferredPairs,
      deferredSegments: this.#deferredSegments,
    };
  }

  /**
   * Rebuild a graph from a snapshot.
   *
   * Schema 1 is still read: it held the same segments and the same thresholded edges, and only lacked the
   * sub-threshold probabilities. Refusing it would throw away a whole session's graph to punish a file for
   * being written one version earlier.
   */
  static fromSnapshot(snap                        )                   {
    const graph = new AssociationGraph();
    if (snap === undefined || (snap.schema !== RG_SNAPSHOT_SCHEMA && snap.schema !== 1)) return graph;
    for (const segment of snap.segments ?? []) graph.#segments.set(segment.id, segment);
    graph.#order = (snap.order ?? []).filter((id) => graph.#segments.has(id));
    // The membership set follows the order it was built from, so `addSegments` after a restore cannot append a
    // duplicate of an id the snapshot already carried.
    graph.#known = new Set(graph.#order);
    for (const edge of snap.edges ?? []) {
      graph.#edges.set(`${edge.from}->${edge.to}`, edge);
      graph.#link(edge.from, edge.to);
    }
    for (const score of snap.scores ?? []) graph.#scores.set(`${score.from}->${score.to}`, score);
    // Clamped, because a cursor larger than the order array would silently skip scoring forever.
    graph.#scored = Math.max(0, Math.min(graph.#order.length, Math.trunc(snap.scored ?? 0)));
    graph.#scoredPairs = Math.max(0, Math.trunc(snap.scoredPairs ?? 0));
    graph.#judgedPairs = Math.max(0, Math.trunc(snap.judgedPairs ?? 0));
    graph.#deferredPairs = Math.max(0, Math.trunc(snap.deferredPairs ?? 0));
    graph.#deferredSegments = Math.max(0, Math.trunc(snap.deferredSegments ?? 0));
    // The deferral cursor is re-derived from what the snapshot says was deferred: deferrals are counted from the
    // front of the order and never uncounted, so the count and the cursor describe the same prefix.
    graph.#deferralCounted = graph.#deferredSegments;
    return graph;
  }

  /**
   * Every pair the backend was asked about, above and below the threshold, newest first.
   *
   * Read-only and for analysis: this is the graded relevance the graph keeps, and the thing that makes `r` a
   * reading rather than a filter. `edgesAt` is the thresholded view of the same data.
   */
  scores()               {
    return [...this.#scores.values()].sort((a, b) => b.at - a.at);
  }

  /** The pairs that would be edges if the threshold were `threshold` - an offline sweep of `recall.threshold`. */
  edgesAt(threshold        )               {
    return this.scores().filter((pair) => Number.isFinite(pair.w) && pair.w >= threshold);
  }

  /**
   * Segments within `windowN` before `seedId` whose pair with it the System-1 backend has never judged, nearest
   * first.
   *
   * This is the fail-open set: a pair inside the window is not "irrelevant", it is "the backend has not answered
   * for it", and the two are different facts that used to look identical. Treating the unknown as irrelevant is
   * what made a live session's BFS anchor return zero candidates and the assembly fall back to the recency window.
   *
   * **Unjudged, not unscored**, and the difference is the whole rule. This used to test `#scores` for an entry,
   * and a failing System-1 call still writes one - computed by the local lexical fallback, with `source:
   * 'lexical'` - so a pair the backend never judged looked exactly like one it had judged and the fail-open rule
   * stayed silent precisely when it was needed. Measured on a round with 281 `s1_call` records of which 191
   * failed (97 `TypeError: fetch failed`, 57 `S1TimeoutError` after 30 s, 37 `503 server busy` from Laya):
   * every pair carried a lexical score, `unknownAdmitted` fired zero times, 11 of 49 assemblies fell back to
   * `recency-window`, and the graph held zero `s1-noul` edges. The owner's rule is "unknown means relevant"; what
   * is unknown is the *backend's judgement*, not the presence of a number. A pair therefore counts as unknown
   * when it has no `#scores` entry at all, or when its entry was not produced by the backend (`source !==
   * 's1-noul'`, which is also what a lexical entry from `scoreNew` carries).
   *
   * Pairs *beyond* the window are deliberately not returned: they were never asked, by design, and admitting them
   * would undo the saving `w` exists for. So the distinction this draws is exactly the one the window draws, plus
   * "and the backend has not answered for it".
   */
  unjudgedWithin(seedId        , windowN        )            {
    const seed = this.#order.indexOf(seedId);
    if (seed < 0) return [];
    const from = Math.max(0, seed - Math.max(0, Math.trunc(windowN)));
    const out            = [];
    // Nearest first: when the backend has not answered, recency *inside* the window is the best ordering there is.
    for (let i = seed - 1; i >= from; i -= 1) {
      const id = this.#order[i]          ;
      const scored = this.#scores.get(`${id}->${seedId}`);
      if (scored !== undefined && scored.source === 's1-noul') continue;
      const segment = this.#segments.get(id);
      if (segment !== undefined) out.push(segment);
    }
    return out;
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
