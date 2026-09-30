/**
 * Association graph (RG) — nodes are segments, edges are System-1-scored relevance
 * relations with recency decay (docs/FORMULAS.md §2, docs/AGENT_BRIEF.md §5.2).
 *
 * Storage is in-memory for M0/M1; the SQLite-backed store plugs in behind the
 * same surface (segments + edges + provenance).
 */
import type { AssociationEdge, EdgeSource, Segment } from './types.ts';

/** w_eff = w · exp(−Δt/λ) */
export function decayedWeight(w: number, ageMs: number, lambdaMs: number): number {
  if (!(lambdaMs > 0)) return w;
  return w * Math.exp(-Math.max(0, ageMs) / lambdaMs);
}

export interface RecallOptions {
  /** relevance threshold τ */
  relevanceThreshold: number;
  /** bounded BFS depth d */
  depth: number;
  /** per-node expansion fanout k */
  fanout: number;
  /** decay constant λ in ms */
  lambdaMs: number;
  /** current time for decay evaluation */
  now: number;
}

export interface RecallHit {
  id: string;
  /** effective (decayed) weight of the best path into this node */
  w: number;
  /** predecessor segment id on that path */
  via: string;
  depth: number;
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
export interface ScoredPair {
  from: string;
  to: string;
  /** the backend's probability for this pair, kept whether or not it clears the threshold */
  w: number;
  /** who produced it: the System-1 backend or the local lexical fallback */
  source: EdgeSource;
  at: number;
}

export interface RgSnapshot {
  schema: number;
  /**
   * Written by the store, and checked by it on read: a snapshot is only ever valid for the session whose graph
   * it is. Absent in a hand-written or older file, which the store then treats as unreadable rather than shared.
   */
  sessionId?: string;
  /** append order of segment ids - the window's notion of "recent" */
  order: string[];
  segments: Segment[];
  edges: AssociationEdge[];
  /**
   * Every scored pair, including the ones below the threshold. Absent in a schema-1 file, which is still read:
   * the graph it described is intact, only the sub-threshold probabilities are gone for good.
   */
  scores?: ScoredPair[];
  /** how many entries of `order` have already been scored; the reason a restart is not a re-pay */
  scored: number;
  scoredPairs: number;
}

export class AssociationGraph {
  #segments = new Map<string, Segment>();
  /** insertion order, for the scoring window */
  #order: string[] = [];
  /** how many entries of #order have been scored already */
  #scored = 0;
  /** cumulative pair comparisons - the number recall.window is meant to bound */
  #scoredPairs = 0;
  #edges = new Map<string, AssociationEdge>();
  /** every scored pair, above and below the threshold, by `${from}->${to}`; see `ScoredPair` */
  #scores = new Map<string, ScoredPair>();
  #adj = new Map<string, string[]>();

  get segmentCount(): number {
    return this.#segments.size;
  }

  get edgeCount(): number {
    return this.#edges.size;
  }

  /** pairs the backend was asked about, which is not the same number as the edges they produced */
  get scoreCount(): number {
    return this.#scores.size;
  }

  addSegments(segments: Iterable<Segment>): void {
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
  async scoreNew(opts: {
    windowN: number;
    threshold: number;
    score?: (a: Segment, b: Segment) => number;
    /**
     * Score one new segment against the whole window in a single call, returning a weight per candidate in the
     * same order.
     *
     * This exists because the System-1 backend takes many questions in one request. A per-pair `score` would
     * cost one S1 call per pair - w calls for every new segment - which is the opposite of what the window is
     * for. A batch scorer is called once per new segment and must return exactly as many weights as candidates,
     * aligned by index; a short or over-long array is a caller bug and is reported rather than guessed at.
     */
    scoreBatch?: (
      current: Segment,
      candidates: readonly Segment[],
    ) => readonly number[] | undefined | Promise<readonly number[] | undefined>;
  }): {
    scoredPairs: number;
    edges: number;
  } {
    const windowN = Math.max(1, Math.trunc(opts.windowN));
    const scorer = opts.score ?? lexicalScore;
    let scoredPairs = 0;
    let edges = 0;
    while (this.#scored < this.#order.length) {
      const id = this.#order[this.#scored] as string;
      this.#scored += 1;
      const current = this.#segments.get(id);
      if (current === undefined) continue;
      const from = Math.max(0, this.#scored - 1 - windowN);
      // Collect the window first so a batch scorer sees it as a unit. The pairs counted here are the same
      // pairs either way: w decides how much is scored, not who does the scoring.
      const candidates: Segment[] = [];
      for (let i = from; i < this.#scored - 1; i += 1) {
        const other = this.#segments.get(this.#order[i] as string);
        if (other !== undefined) candidates.push(other);
      }
      if (candidates.length === 0) continue;
      scoredPairs += candidates.length;

      let weights: readonly number[];
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
        const weight = weights[i] as number;
        const other = candidates[i] as Segment;
        // `'s1-noul'` is the only System-1 question shape the association path asks; `'lexical'` means
        // "computed here, no backend consulted", which is the distinction an experiment has to be able to read.
        const source: EdgeSource = byBackend ? 's1-noul' : 'lexical';
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
    return { scoredPairs, edges };
  }
  getSegment(id: string): Segment | undefined {
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
  orderedSegments(limit?: number): Segment[] {
    const out: Segment[] = [];
    const from = limit === undefined ? 0 : Math.max(0, this.#order.length - Math.max(0, Math.trunc(limit)));
    for (let i = from; i < this.#order.length; i += 1) {
      const segment = this.#segments.get(this.#order[i] as string);
      if (segment !== undefined) out.push(segment);
    }
    return out;
  }

  /** Insert or replace an edge (key = `${from}->${to}`), indexed in both directions. */
  upsertEdge(edge: AssociationEdge): void {
    const key = `${edge.from}->${edge.to}`;
    this.#edges.set(key, edge);
    this.#link(edge.from, edge.to);
  }

  #link(a: string, b: string): void {
    const list = this.#adj.get(a) ?? [];
    if (!list.includes(b)) list.push(b);
    this.#adj.set(a, list);
    const back = this.#adj.get(b) ?? [];
    if (!back.includes(a)) back.push(a);
    this.#adj.set(b, back);
  }

  neighbors(id: string): AssociationEdge[] {
    const ids = this.#adj.get(id) ?? [];
    const out: AssociationEdge[] = [];
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
  recall(seedIds: readonly string[], opts: RecallOptions): RecallHit[] {
    const seeds = new Set<string>(seedIds);
    const best = new Map<string, RecallHit>();
    const visited = new Set<string>(seedIds);
    let frontier: { id: string; depth: number }[] = seedIds.map((id) => ({ id, depth: 0 }));

    while (frontier.length > 0) {
      const next: { id: string; depth: number }[] = [];
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

    stats(): { segments: number; edges: number; scoredPairs: number } {
      return { segments: this.#segments.size, edges: this.#edges.size, scoredPairs: this.#scoredPairs };
  }

  /**
   * Everything the graph holds, in a form that survives the process.
   *
   * The scoring cursor is part of the snapshot, and it is the reason a snapshot is worth writing at all: without
   * `scored`, a restarted session would re-ask the System-1 backend about pairs it had already paid for. `adj`
   * is derived from `edges` and is therefore rebuilt rather than stored.
   */
  snapshot(): RgSnapshot {
    return {
      schema: RG_SNAPSHOT_SCHEMA,
      order: [...this.#order],
      segments: [...this.#segments.values()],
      edges: [...this.#edges.values()],
      scores: [...this.#scores.values()],
      scored: this.#scored,
      scoredPairs: this.#scoredPairs,
    };
  }

  /**
   * Rebuild a graph from a snapshot.
   *
   * Schema 1 is still read: it held the same segments and the same thresholded edges, and only lacked the
   * sub-threshold probabilities. Refusing it would throw away a whole session's graph to punish a file for
   * being written one version earlier.
   */
  static fromSnapshot(snap: RgSnapshot | undefined): AssociationGraph {
    const graph = new AssociationGraph();
    if (snap === undefined || (snap.schema !== RG_SNAPSHOT_SCHEMA && snap.schema !== 1)) return graph;
    for (const segment of snap.segments ?? []) graph.#segments.set(segment.id, segment);
    graph.#order = (snap.order ?? []).filter((id) => graph.#segments.has(id));
    for (const edge of snap.edges ?? []) {
      graph.#edges.set(`${edge.from}->${edge.to}`, edge);
      graph.#link(edge.from, edge.to);
    }
    for (const score of snap.scores ?? []) graph.#scores.set(`${score.from}->${score.to}`, score);
    // Clamped, because a cursor larger than the order array would silently skip scoring forever.
    graph.#scored = Math.max(0, Math.min(graph.#order.length, Math.trunc(snap.scored ?? 0)));
    graph.#scoredPairs = Math.max(0, Math.trunc(snap.scoredPairs ?? 0));
    return graph;
  }

  /**
   * Every pair the backend was asked about, above and below the threshold, newest first.
   *
   * Read-only and for analysis: this is the graded relevance the graph keeps, and the thing that makes `r` a
   * reading rather than a filter. `edgesAt` is the thresholded view of the same data.
   */
  scores(): ScoredPair[] {
    return [...this.#scores.values()].sort((a, b) => b.at - a.at);
  }

  /** The pairs that would be edges if the threshold were `threshold` - an offline sweep of `recall.threshold`. */
  edgesAt(threshold: number): ScoredPair[] {
    return this.scores().filter((pair) => Number.isFinite(pair.w) && pair.w >= threshold);
  }
}

/**
 * Local lexical fallback scorer (shared tokens over the smaller token count). It stands in for the System-1
 * association backend so the window and its cost are testable offline; the S1 scorer replaces it later without
 * touching the windowing logic.
 */
export function lexicalScore(a: Segment, b: Segment): number {
  const left = tokensOf(a.text);
  const right = tokensOf(b.text);
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  return shared / Math.min(left.size, right.size);
}

function tokensOf(text: string): Set<string> {
  const out = new Set<string>();
  for (const token of text.toLowerCase().split(/[^\\p{L}\\p{N}_]+/u)) {
    if (token.length > 1) out.add(token);
  }
  return out;
}
