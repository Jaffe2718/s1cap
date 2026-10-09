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

/**
 * Whether a walk standing on the segment at position `from` may expand into the one at position `to`: only
 * backwards in the session's append order.
 *
 * Both positions are indices into the graph's own `order`, and `undefined` means the graph never placed that id -
 * see `AssociationGraph.recall` for why an unplaced neighbour is not an expansion. The rule is written as one
 * expression on purpose: it is the whole of the traversal direction, and every reader of it must see that
 * "unknown" is *not* older rather than infer it from a comparison against `undefined`.
 */
function isBackwardStep(from: number | undefined, to: number | undefined): boolean {
  return from !== undefined && to !== undefined && to < from;
}

export interface RecallOptions {
  /** relevance threshold τ */
  threshold: number;
  /** bounded BFS depth d */
  depth: number;
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
 * One row the walk needs and cannot answer from what the graph already holds: the segment the walk would expand
 * next, and the predecessors inside `w` it must be scored against.
 *
 * A row is *one segment against its window*, which is the same unit `scoreNew` offers one at a time - so a
 * demanded row is a segment's arrival-order row, asked for because a walk reached the segment rather than because
 * the segment arrived. `candidates` is never empty (a row with no window is settled by `#offer` without being
 * handed out), and `index` is the segment's position in the graph's own append order, which is what makes the
 * demand's maximum cost `min(index, w)`. Already measured pairs are omitted.
 */
export interface DemandRow {
  /** the segment whose row this is: the node the walk stands on and would expand */
  id: string;
  /** its position in the graph's append order */
  index: number;
  /** the depth at which the walk stands on it (0 = a seed, i.e. the step's anchor) */
  depth: number;
  /** the segment itself, as `scoreNew` would have handed it to the scorer */
  current: Segment;
  /** Missing predecessors inside `w`, oldest first; lexical guesses are missing when a backend is available. */
  candidates: Segment[];
}

/** What one level of the walk cost, and what it got. */
export interface DemandLevel {
  depth: number;
  /** rows this level asked for */
  rows: number;
  /** Missing pairs actually offered: the sum of candidate counts, not full window sizes. */
  pairs: number;
  /** of `pairs`, the ones the backend answered */
  judged: number;
  /** rows nobody answered (a refusal, a failure, a throw) - released, so a later walk may ask again */
  missed: number;
  /** the pairs that went with the missed rows */
  missedPairs: number;
  /** rows the walk needed but could not have: another sweep owns them, or they were settled as it asked */
  skipped: number;
}

/**
 * The demand walk's whole result.
 *
 * `hits` is what `recall` would return from the graph as it stood when the walk finished - the two share
 * `#walkLevel`, so this is the walk's own answer and not a second traversal's. `stop` says why the demands
 * ended, and it is the field a round reads to tell "the walk was done" from "the deadline arrived".
 */
export interface DemandResult {
  hits: RecallHit[];
  levels: DemandLevel[];
  /** rows asked for, across every level */
  rows: number;
  /** pairs offered: the sum of missing candidate counts over the asked rows */
  pairs: number;
  /** of `pairs`, the ones a backend answered */
  judged: number;
  /** pairs that were offered and not answered; every one of them is unsettled and will be asked again */
  missedPairs: number;
  /** rows that were offered and not answered */
  missed: number;
  /** rows the walk needed and could not have */
  skipped: number;
  stop: 'complete' | 'budget' | 'depth';
}

/**
 * Score the rows one level of the walk needs, and answer with one weight list per row - aligned by index, and
 * `undefined` for a row nobody answered.
 *
 * The graph calls this **once per level, with the rows that level needs and no others**, so a scorer is free to
 * put several rows into one System-1 request: at `w = 16` a full row is 16 questions against the default
 * `s1.questionsPerCall` of 20, so one row is already one call and batching two of them would exceed the cap
 * rather than halve the calls. What the per-level shape buys is that the walk's round trips are the *levels* of
 * the walk and not its rows. Returning `undefined` for the whole level is read as "no row was answered".
 */
export type DemandScorer = (
  rows: readonly DemandRow[],
  /** Publish a finished row immediately; returning the full array remains supported. */
  onRow?: (index: number, weights: readonly number[] | undefined) => void,
) => Promise<readonly (readonly number[] | undefined)[] | undefined>;

/**
 * `recall`'s options plus the two things only the demand walk needs: `w`, which decides a row's size, and the
 * local scorer used when there is no backend to ask.
 */
export interface RecallDemandOptions extends RecallOptions {
  /** `recall.window`: how many predecessors one row is scored against */
  window: number;
  /** the local scorer for a session with no System-1 lane; defaults to `lexicalScore` */
  score?: (a: Segment, b: Segment) => number;
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
  /** pairs the backend actually answered, where `scoredPairs` counts the ones it was merely offered */
  judgedPairs?: number;
  /**
   * Pairs the run declined to offer because the backend was saturated, and the segments still waiting for a
   * window. Both survive a restart like every other counter here: a session that resumed and forgot what it had
   * postponed would report coverage computed from a denominator that lost the omission.
   */
  deferredPairs?: number;
  deferredSegments?: number;
  /**
   * The on-demand walk's own accounting: pairs it asked for, and pairs it asked for and never got an answer for.
   *
   * Additive to schema 2 rather than a new schema, because a file without them is *readable*: an older build's
   * snapshot has no demand in it (its scoring was eager) and a newer build's has no eager sweep in it, and both
   * describe the same graph - the two counters say how the pairs in `scoredPairs` were bought, and a reader that
   * does not have them reads the older, coarser statement. Bumping the schema would make every existing round
   * unreadable to punish a file for carrying one counter fewer.
   */
  demandPairs?: number;
  demandMissedPairs?: number;
}

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
export const S1_DEFERRED: unique symbol = Symbol.for('s1cap.s1-deferred');

export type S1Deferral = typeof S1_DEFERRED;

export class AssociationGraph {
  #segments = new Map<string, Segment>();
  /** insertion order, for the scoring window */
  #order: string[] = [];
  /** membership test for #order, so `addSegments` is not quadratic in a long session */
  #known = new Set<string>();
  /**
   * id -> its index in `#order`: the segment's **position in the session's append order**.
   *
   * This is the graph's only notion of "older", and it is the quantity `recall` expands towards. It is the same
   * number `unjudgedWithin` reads, kept as a map rather than re-derived with `indexOf` so the walk's direction
   * test is O(1) per neighbour. Written where `#order` is written and nowhere else: `addSegments` (appending) and
   * `fromSnapshot` (rebuilding). First occurrence wins there, which is what `#order.indexOf` has always answered,
   * so a snapshot that names an id twice cannot give the walk one position and `unjudgedWithin` another.
   */
  #at = new Map<string, number>();
  /**
   * How many entries of `#order` have been **settled**: scored, or found to have no window at all.
   *
   * Read as "the length of the settled prefix", and it is what the snapshot carries and what a restart resumes
   * from. It is *not* "the next entry to offer": an entry a sweep is scoring right now is not settled, and an
   * entry settled out of order (see `#settled`) does not move this on its own. Both of those were the same
   * number before the take became exclusive, and the difference is the whole subject of `#claim` below.
   *
   * The direction the restart errs in is deliberate: entries settled out of order are not in the snapshot, so a
   * resumed session offers them again - while an entry that was deferred is never silently skipped. Persisting the
   * highest entry *taken* instead would skip the deferred ones, which is a hole in the graph rather than a re-paid
   * window.
   *
   * **How many entries a restart re-offers is no longer "a handful", and the number is worth stating.** While the
   * cursor is the only producer of out-of-order settlements, they are the entries in flight, one per concurrent
   * sweep. The anchor priority (`scoreNew`'s `anchorId`) is a second producer and it deliberately settles entries
   * far above the cursor - one per step, for as long as the lane is behind - so a session whose cursor stalled at
   * 106 of 228 (round `20261004-1239`) can hold a settled set the size of its whole backlog, and a restart re-offers
   * those rows. That is the same trade this comment already makes, at a larger price: re-paying the anchors of a
   * backlog is a cost, skipping a deferred entry is a hole in the graph.
   */
  #scored = 0;
  /**
   * Entries a sweep has taken and not yet settled. **Never handed to a second sweep.**
   *
   * This set is the fix for the defect that made the lane pay for the same pair up to eight times. `scoreNew`
   * used to read `#scored` once into a local `lastOffered` and then walk forward, writing `#scored = index + 1`
   * as it took each entry. The upkeep queue does not await its async handler, and the observer drains every
   * queued event synchronously at `turn/end` and in the anchor wait, so a burst of N events started N
   * concurrent `scoreNew` calls over one graph; two sweeps whose walks overlapped scored the *same* segment, and
   * either could write the shared cursor backward over segments the other had already finished. Measured on
   * round `20261004-0233` (cell C2, from its own artifacts): `scoredPairs` 10,157 against **2,211 distinct
   * pairs** in `scores` - a complete triangle over the first 67 segments, no holes and nothing outside it - and
   * 9,828 questions sent for those 2,211 pairs. 486 of the 634 calls were re-asks of pairs the graph already
   * held. The multiplicity matched the concurrency (371 calls of exactly 20 questions against 47 windows of at
   * least 20 pairs = 7.9, beside `admissionLimit: 8`; the 47 are the **offered** ones, entries 20…66 of the 67
   * the cursor had settled, not the 165 windows of ≥ 20 pairs the full 185-entry arrival order holds - the other
   * 118 were never offered to anyone, so no call could have been a re-ask of them), which is what a claim set
   * removes: an entry is offered once, by one sweep, however many sweeps are in flight.
   */
  #taken = new Set<number>();
  /**
   * Entries settled **out of order**, above `#scored`, pruned as `#scored` advances over them.
   *
   * Without it the cursor cannot tell "already scored by the sweep that was ahead of me" from "not offered
   * yet", and a sweep that took a lower index would re-offer the higher ones. Two things settle entries here: an
   * entry a concurrent sweep finished ahead of the cursor, and **an entry the caller named as its anchor**
   * (`scoreNew`'s `anchorId`), which is settled here on purpose and is the whole point of the priority - the walk
   * needs the newest segment's row and the cursor is nowhere near it. The set is therefore bounded by the
   * *distance* between the cursor and the anchors the maintenance has been told about, not by the number of sweeps
   * in flight, and it is small only while the two are close; see `#scored` above for what that costs a restart.
   */
  #settled = new Set<number>();
  #rowListeners = new Map<number, Set<() => void>>();

  /** Whether this row is owned by a scoring operation (including another walk). */
  rowPending(id: string): boolean {
    return this.#taken.has(this.#at.get(id) ?? -1);
  }

  /** Wake a waiter when the owner records or releases this row. */
  onRowComplete(id: string, listener: () => void): () => void {
    const index = this.#at.get(id) ?? -1;
    const listeners = this.#rowListeners.get(index) ?? new Set<() => void>();
    listeners.add(listener);
    this.#rowListeners.set(index, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.#rowListeners.delete(index);
    };
  }

  #notifyRow(index: number): void {
    for (const listener of this.#rowListeners.get(index) ?? []) {
      try { listener(); } catch { /* Diagnostics/waiters must not break graph writes. */ }
    }
  }
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
  /**
   * Pairs the **on-demand** walk paid for, and the pairs it asked for and did not get.
   *
   * Separate from `#scoredPairs`/`#judgedPairs` (which they are also added to, because a demanded pair *was*
   * offered and may well have been judged) for one reason: a round has to be able to say how much of the lane
   * the walk spent, and `scoredPairs` alone cannot - under eager scoring it was the whole session's arrival order
   * and under on-demand scoring it is whatever a walk asked for. `demandMissedPairs` is the honest counterpart of
   * `deferredPairs` for this path: pairs that were asked for and not answered, counted once per entry
   * (`#demandMissedAt`) because the entry goes back unsettled and a later walk asks again.
   */
  #demandPairs = 0;
  #demandMissedPairs = 0;
  #demandMissedRows = 0;
  /** entries whose unanswered demand has already been counted; see `#miss` */
  #demandMissedAt = new Set<number>();
  #edges = new Map<string, AssociationEdge>();
  /** every scored pair, above and below the threshold, by `${from}->${to}`; see `ScoredPair` */
  #scores = new Map<string, ScoredPair>();
  /** All measured incoming pairs, including scores below the ingest threshold. */
  #scoreRows = new Map<string, Map<string, ScoredPair>>();
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
        if (!this.#known.has(s.id)) {
          this.#known.add(s.id);
          // Placed and appended in one step, so `#at` and `#order` cannot disagree about a segment the graph has
          // admitted: every id `addSegments` records is in both, and nothing else is in `#order`.
          this.#at.set(s.id, this.#order.length);
          this.#order.push(s.id);
        }
      }
  }

  /**
   * Offer the entry at `index`: the claim, with the window it would be scored against. `undefined` means it could
   * not be offered, and the two kinds of that are not the same fact.
   *
   *  - **Entries this settles**: an entry with no segment, or with an empty window, costs nothing and is settled
   *    on the spot. That is what keeps the scan below from stopping on one forever - an entry that cannot be
   *    offered *and is left unsettled* would be returned to by every call for the rest of the session.
   *  - **Entries that are not this sweep's to take**: below the cursor's prefix, already settled out of order, or
   *    owned by another sweep. These are left alone, and the caller falls through to the scan.
   *
   * The take is synchronous with the test above it, which is the entire exclusivity guarantee (`#taken`).
   */
  #offer(index: number, windowN: number): { index: number; current: Segment; candidates: Segment[] } | undefined {
    if (index < this.#scored || index >= this.#order.length) return undefined;
    if (this.#settled.has(index) || this.#taken.has(index)) return undefined;
    const current = this.#segments.get(this.#order[index] as string);
    if (current === undefined) {
      this.#settle(index);
      return undefined;
    }
    const from = Math.max(0, index - windowN);
    const candidates: Segment[] = [];
    for (let j = from; j < index; j += 1) {
      const other = this.#segments.get(this.#order[j] as string);
      if (other !== undefined) candidates.push(other);
    }
    if (candidates.length === 0) {
      this.#settle(index);
      return undefined;
    }
    this.#taken.add(index);
    return { index, current, candidates };
  }

  /**
   * Take `preferred` - the entry the caller named - or the lowest entry that no sweep owns and no sweep has
   * settled, with the window it would be scored against. `undefined` means there is nothing left to offer.
   *
   * **The scan and the take are one synchronous step, and that is the whole guarantee.** Two sweeps calling
   * `scoreNew` concurrently cannot both be handed the same entry, because the entry is added to `#taken` before
   * either of them reaches an `await`. What each sweep does with its entry afterwards - a batch call, a retry, a
   * refusal - is sequential inside that sweep, so N sweeps in flight are N *different* segments being scored.
   *
   * **`preferred` is the priority, and it is a claim like any other.** It is offered by the same `#offer` the scan
   * uses, so it is exclusive in the same way and before the same first `await`; it is settled into `#settled` when
   * the offer completes, which is what an entry above the cursor is; and it moves `#scored` only through `#settle`,
   * i.e. only once every earlier entry has been settled too. An entry that is already settled, already owned, or
   * below the prefix falls through to the scan, which is the honest answer to "someone else has this row" - the
   * caller is not told a row it cannot have, and no entry is ever handed out twice. `scoreNew` reads it from
   * `anchorId`.
   */
  #claim(windowN: number, preferred?: number): { index: number; current: Segment; candidates: Segment[] } | undefined {
    if (preferred !== undefined) {
      const claim = this.#offer(preferred, windowN);
      if (claim !== undefined) return claim;
    }
    for (;;) {
      let i = this.#scored;
      while (i < this.#order.length && (this.#settled.has(i) || this.#taken.has(i))) i += 1;
      if (i >= this.#order.length) return undefined;
      const claim = this.#offer(i, windowN);
      if (claim !== undefined) return claim;
    }
  }

  /** Settle a taken entry: it is scored (or had no window) and will never be offered again. */
  #settle(index: number): void {
    this.#taken.delete(index);
    this.#notifyRow(index);
    if (index < this.#scored) return;
    this.#settled.add(index);
    // The cursor advances over the settled prefix and forgets what it passes, so `#settled` stays bounded by the
    // entries that finished ahead of an earlier one rather than growing with the session.
    while (this.#settled.delete(this.#scored)) this.#scored += 1;
  }

  /**
   * Give a taken entry back **unsettled**, so a later sweep offers it again - the admission gate's "not now"
   * arriving as `S1_DEFERRED`, and the budget stopping a sweep before it makes the offer.
   *
   * The entry stays out of `#settled`, which is what keeps `deferredPairs` honest: its pairs were offered to
   * nobody, so they are counted as deferred and not in `scoredPairs`.
   */
  #release(index: number): void {
    this.#taken.delete(index);
    this.#notifyRow(index);
  }

  /**
   * Write one claimed row's answer: the graded pair for every candidate, and an edge for each pair that clears
   * the threshold. Returns how many edges it made.
   *
   * One implementation, because `scoreNew` and the on-demand walk must produce **the same graph from the same
   * answer** - that equality is what lets a round compare a lazy build's graph with an eager one's, and two copies
   * of this loop would be the way it stops being true. The two callers differ in where the weights come from (a
   * row of a sweep, or a level of a walk) and in nothing below this line.
   *
   * `'s1-noul'` is the only System-1 question shape the association path asks; `'lexical'` means "calculated here,
   * no backend consulted", which is the distinction an experiment has to be able to read. The probability is
   * recorded **before** the threshold is applied, not after: the number is the measurement and the threshold is a
   * reading of it, and testing first spent the call and kept only the verdict.
   */
  #record(
    current: Segment,
    candidates: readonly Segment[],
    weights: readonly number[],
    byBackend: boolean,
    windowN: number,
    threshold: number,
  ): number {
    let edges = 0;
    for (let i = 0; i < candidates.length; i += 1) {
      const weight = weights[i] as number;
      const other = candidates[i] as Segment;
      const source: EdgeSource = byBackend ? 's1-noul' : 'lexical';
      if (Number.isFinite(weight)) {
        this.#putScore({ from: other.id, to: current.id, w: weight, source, at: current.ts });
      }
      if (!Number.isFinite(weight) || weight < threshold) continue;
      this.upsertEdge({
        from: other.id,
        to: current.id,
        w: weight,
        wTier1: weight,
        source,
        verifiedAt: current.ts,
        provenance: byBackend ? `window:${String(windowN)};s1` : `window:${String(windowN)};fallback`,
      });
      edges += 1;
    }
    return edges;
  }

  /**
   * Score segments that arrived since the last call, each against only the most recent `windowN` segments.
   *
   * This is where `recall.window = w` lives. The cost is one pass of `w` comparisons per new segment - O(w),
   * independent of how long the session has grown - and `scoredPairs` makes that saving measurable instead of
   * rhetorical. Segments outside the window are untouched: they keep every edge they already had and stay
   * reachable by `recall()`, because w only decides *whether a pair is scored*, not what exists in the graph.
   *
   * **One offer per segment, however many sweeps are in flight.** The cost above is O(w) *per new segment*, and
   * that arithmetic only holds if a segment is offered once; a call therefore does not walk a cursor it read at
   * entry, it claims each entry exclusively (`#claim`). Round `20261004-0233` is why: several concurrent sweeps,
   * each walking its own copy of the same cursor, scored the same 2 211 pairs until `scoredPairs` read 10 157 -
   * and the backend was paid for 9 828 questions to get them.
   *
   * **The order is `anchorId`'s subject, and the oldest-first default is the defect it answers.** A step recalls
   * from the *newest* input event and this walk starts at the *oldest* unsettled entry; on a lane that settles
   * pairs slower than the session produces them, the two never meet. Naming an entry puts that one row first and
   * leaves the rest of the walk exactly as it was, which is the whole change.
   *
   * **`anchorId`, the option that names it, and what it is measured against.** Round `20261004-1239` (cell C2),
   * from that round's own artifacts: 228 segments, the cursor at 106 of 228, `scores` a complete triangle over
   * segments 0..105 (5,565 pairs) and nothing above it, and 25,878 pairs offered (`Σ min(i, 1024)`). The lane
   * settles 15.1 pairs/s against a session that generates 70.1/s, so the newest segments - the ones every step
   * assembles from - were never offered **at all**. `recall` from an unscored anchor returns nothing, and
   * `candidates` read 0 on **19 of 26 assemblies**; the fail-open rule in `assemble()` then filled the block with
   * every unjudged pair inside the window (`unknownAdmitted` = `selected` exactly - 40 = 40 … 126 = 126 from
   * assembly #9 on), 21,755 recalled tokens on the last one. The wait for that row (`recall.anchorWaitMs`, 10 s)
   * was already there and gave up at all 18 of those steps: it was waiting for work nothing had asked for.
   *
   * What the option does and does not do, in four sentences. The named entry is claimed before the cursor's by
   * `#claim`, so one sweep offers that row first and then carries on with the oldest-first work - the same
   * throughput spent in a better order, because the lane is still 4.6x too slow and this reorders it rather than
   * enlarging it. It does **not** advance the cursor: the entry is settled into `#settled` like any other
   * out-of-order settlement, and `#scored` moves only when the prefix fills, so the row is never bought twice. It
   * is a *preference* and not a promise: an entry another sweep owns, one already settled, or one below the prefix
   * is not taken from anyone, and a name the graph does not hold (`#at` has no position for it) prioritises
   * nothing at all. And it is the segment's **id**, not its index, on purpose: the caller - the plugin's bounded
   * anchor wait - is handed exactly the id the assembler will walk from (`beforeAssemble`), so the graph is told
   * the caller's own notion of the anchor instead of a second one; an index would be a second notion of
   * *position*, and the two could disagree after a snapshot is restored.
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
    ) => readonly number[] | undefined | S1Deferral | Promise<readonly number[] | undefined | S1Deferral>;
    /**
     * The most pairs one call may offer, across every segment it walks.
     *
     * `scoreNew` scores *every* segment that arrived since the last call, and each of them against its whole
     * window: a tick that folds in a burst of session events therefore offers `segments x w` pairs at once. The
     * `recall.window` bound is a bound on one segment, not on a call, and the difference was measured: round
     * `20261002-2037` walked 860 672 pairs for 4 152 judgements - 0.48 % - across a 2219.7 s run whose backend
     * refused 64.4 % of the 5 992 requests it was sent, because each in-flight tick kept offering its own window
     * regardless of what the last one was told.
     *
     * This is a per-call budget, not a smaller window: a segment whose window was cut short is **deferred**, the
     * cursor does not advance over it, and the next call offers it again - with the same window - against a
     * backend that may by then be answering. Pairs already scored are never re-offered, so the `scored` cursor and
     * `docs/CELLS-RUN.md`'s "no pair is paid for twice" both still hold - and that sentence is now enforced by
     * `#claim`/`#settle` rather than assumed: it was false under concurrent sweeps until they were made
     * exclusive (measured: `scoredPairs` 10 157 against 2 211 distinct pairs in round `20261004-0233`).
     *
     * Undefined means no budget. Callers that score locally (the lexical fallback, `window-curve.mjs`, the tests)
     * want every pair at once and are not charged by it; a batch scorer that can be refused should set it.
     */
    maxPairsPerSweep?: number;
    anchorId?: string;
  }): Promise<{
    scoredPairs: number;
    judgedPairs: number;
    edges: number;
    /** pairs in this call's windows that were left for a later call because the backend could not take them */
    deferredPairs: number;
    /** how many segments were held back; their windows are offered again on the next call */
    deferredSegments: number;
  }> {
    const windowN = Math.max(1, Math.trunc(opts.windowN));
    const maxPairs =
      opts.maxPairsPerSweep === undefined ? Number.POSITIVE_INFINITY : Math.max(1, Math.trunc(opts.maxPairsPerSweep));
    const scorer = opts.score ?? lexicalScore;
    /**
     * The position of the entry the caller named, resolved once against the graph's own index and `undefined` when
     * the graph does not hold that id. `#at` is the only place a segment's position lives (see its own comment),
     * so resolving it here rather than at each claim keeps one answer for the whole call - and a name that matches
     * nothing yields no preference instead of a guessed position, which is what an id the graph never admitted
     * deserves.
     */
    const preferred = opts.anchorId === undefined ? undefined : this.#at.get(opts.anchorId);
    let scoredPairs = 0;
    let judgedPairs = 0;
    let edges = 0;
    let deferredPairs = 0;
    let deferredSegments = 0;
    /**
     * Count one segment's window as deferred, at most once.
     *
     * The entry is not settled, so the next sweep offers it again and would add its window to the total a second
     * time - reporting more deferred pairs than the session has. `deferSegment`'s guard is what makes the counting
     * idempotent across sweeps, and `countDeferredSuffix` relies on that instead of trying to remember what it
     * counted last time.
     */
    const deferSegment = (index: number, pairs: number): void => {
      if (index < this.#deferralCounted) return;
      this.#deferralCounted = index + 1;
      deferredPairs += pairs;
      deferredSegments += 1;
    };
    /**
     * Count the windows of every entry from `index` on that this call did not offer.
     *
     * A walk, not a request: no scorer is called and no cursor moves. Every entry below `#scored` is settled, so
     * "from `index` on" covers everything still waiting, and counting from the front of that set each time is both
     * complete and idempotent. Without that, a backlog of tens of thousands of pairs behind one budget stop would
     * be reported as the size of one window, which is the one direction this accounting must not lean.
     *
     * **What calling it from a low index costs, stated because a round reports this number.** The count is a tail
     * measured from one point, not a rate: whichever call stops first fixes it, and everything above that entry is
     * counted once whether it is offered a second later or never. Measured on round `20261004-0233`'s final
     * snapshot, that is exact: 16 767 deferred pairs = sum(i, i = 23..184) and 162 deferred segments = 185 - 23,
     * i.e. the whole tail from the first refusal - while 44 of those segments (23..66) were scored afterwards and
     * are counted in `scoredPairs` as well. A run that refuses earlier therefore reports a *larger* deferral
     * without having lost a pair, which is why `deferredPairs` is read as "how much of the session's tail had not
     * been offered when this call stopped" and never as the lane's failure rate.
     */
    const countDeferredSuffix = (index: number): void => {
      for (let i = index; i < this.#order.length; i += 1) {
        if (i < this.#deferralCounted) continue;
        // An entry another sweep owns right now was not held back by this call - and the walk **stops** there
        // rather than stepping over it, because the marker below is one index and would otherwise jump past an
        // entry nobody has counted and nobody ever would: a refusal at 1 beside a concurrent sweep holding 2 used
        // to count 1 and 3, and 2's pairs then fell out of both counters for good. The owning sweep counts from
        // its own index when it stops, so stopping here is complete; it is only ever less than the tail.
        if (this.#taken.has(i)) break;
        // Settled entries above the cursor need no counting and cannot be deferred, so the walk passes them.
        if (this.#settled.has(i)) continue;
        const id = this.#order[i] as string;
        if (!this.#segments.has(id)) continue;
        const from = Math.max(0, i - windowN);
        let pairs = 0;
        for (let j = from; j < i; j += 1) if (this.#segments.has(this.#order[j] as string)) pairs += 1;
        if (pairs > 0) deferSegment(i, pairs);
      }
    };
    // One offer at a time, each on an entry no other sweep holds. The loop below never reads `#scored` itself: the
    // only way to learn which entry is next is `#claim`, and the only way to give it back is `#release`, so two
    // sweeps in flight cannot be handed the same segment however the event burst is drained. `preferred` - the
    // caller's anchor - is claimed by that same call and is therefore the *first* entry of this call, which also
    // means the budget below never refuses it: the one entry a call is always allowed to offer is its first, and
    // the entry the step's recall depends on is now that one.
    for (;;) {
      const claimed = this.#claim(windowN, preferred);
      if (claimed === undefined) break;
      const { index, current, candidates } = claimed;
      // The budget is tested *after* the claim and before the offer, so that a sweep which cannot afford this
      // window does not spend it: the entry goes back unoffered and stays counted as deferred. It is still tested
      // only when something has already been offered this call - a budget that refused the *first* entry would
      // stop on it forever, a backlog it could never work through. The pair count of one window is bounded by `w`.
      if (scoredPairs > 0 && scoredPairs + candidates.length > maxPairs) {
        this.#release(index);
        countDeferredSuffix(index);
        break;
      }
      scoredPairs += candidates.length;
      // Everything below runs with the entry held: `settled` says whether the offer completed, and the `finally`
      // is the single place the claim is resolved, so no exit path - an answer, a refusal, a throw from the
      // scorer, a malformed batch - can leave an entry owned by a sweep that has gone away, which would be a
      // segment no later sweep could reach.
      let settled = false;
      try {
        let weights: readonly number[];
        // Which scorer produced the weights, so the edge can say so. `undefined` from the batch scorer means the
        // System-1 backend did not answer this segment and the local fallback produced every weight in it; calling
        // that edge `'s1'` was a provenance lie, not merely an untyped literal.
        let byBackend = false;
        if (opts.scoreBatch !== undefined) {
          const batch = await opts.scoreBatch(current, candidates);
          if (batch === S1_DEFERRED) {
            // Not now. The offer is withdrawn rather than paid for: `scoredPairs` gives the pairs back and the
            // entry is released unsettled, so the window is offered again - whole - on a later call. Counting it
            // as offered-but-unjudged instead would make `judgedPairs / scoredPairs` fall for a reason the reader
            // cannot see, and scoring it lexically would spend the pair for good.
            //
            // The release comes **before** the walk, not only in the `finally`: `countDeferredSuffix` skips the
            // entries other sweeps own, and this entry is still owned at this instant. Releasing after the walk
            // leaves this segment out of its own deferral count (measured: 14 instead of 15 of a six-segment
            // backlog), which is the one direction this accounting must not lean.
            scoredPairs -= candidates.length;
            this.#release(index);
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

        edges += this.#record(current, candidates, weights, byBackend, windowN, opts.threshold);
        settled = true;
      } finally {
        if (settled) this.#settle(index);
        else this.#release(index);
      }
    }
    this.#scoredPairs += scoredPairs;
    this.#judgedPairs += judgedPairs;
    this.#deferredPairs += deferredPairs;
    this.#deferredSegments += deferredSegments;
    return { scoredPairs, judgedPairs, edges, deferredPairs, deferredSegments };
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

  #putScore(score: ScoredPair): void {
    this.#scores.set(`${score.from}->${score.to}`, score);
    let row = this.#scoreRows.get(score.to);
    if (row === undefined) {
      row = new Map();
      this.#scoreRows.set(score.to, row);
    }
    row.set(score.from, score);
  }

  /** A threshold change reuses paid measurements; explicit/manual edges remain traversable. */
  #walkNeighbors(id: string): { other: string; w: number; at: number }[] {
    const out = new Map<string, { other: string; w: number; at: number }>();
    for (const edge of this.neighbors(id)) {
      const other = edge.from === id ? edge.to : edge.from;
      out.set(other, { other, w: edge.w, at: edge.verifiedAt });
    }
    for (const score of this.#scoreRows.get(id)?.values() ?? []) {
      out.set(score.from, { other: score.from, w: score.w, at: score.at });
    }
    return [...out.values()];
  }

  /**
   * Bounded BFS from the seed segments over edges with w_eff > τ,
   * depth ≤ d.
   * Returns hits (seeds excluded), best weight first.
   *
   * **Expansion goes backwards in time, and that is the direction rule rather than a preference.** A pair is
   * scored once, when the newer of its two segments arrives (`scoreNew` writes `${other.id}->${current.id}`), so
   * the *storage* is triangular - one entry per unordered pair, oriented older→newer - while `neighbors()` is
   * symmetric, which is an honest reading of "this pair has a score" and is why the adjacency is left alone. The
   * walk is the other half: expanding a node into `neighbors(id)` whole let an **older segment recall a newer
   * one**, which the user's rule forbids. Measured on round `20261004-0233` (cell C2, from its own `recallTree`
   * records against the RG snapshot's `order`: 185 segments, 22 assemblies with a non-empty tree): 255 of 540
   * recorded tree edges - 47.2 % - were forward, the widest from append position 1 to position 28. Re-run over the
   * same anchors by `packages/core/test/forward-edge-audit.ts`, this file's forward count is 0 and
   * `forward-edge-audit.ts` is where the next round checks that it stayed there.
   *
   * (That sentence gave a second reason until 2026-10-05: *"and because the frontier is k^d the meaningless half
   * was re-multiplied at every depth"*. It is deleted rather than kept because `k` is retired (below), so `k^d` is
   * no longer this walk's frontier and the clause would name a bound that does not hold. The direction rule never
   * rested on it: the defect it fixes is the forward step itself, which is wrong at every branching factor, and
   * the measured 47.2 % is what the fix is aimed at.)
   *
   * "Older" is the segment's position in `#order`, the session's append order - the same quantity
   * `orderedSegments`, `unjudgedWithin` and the scoring window are read on. **A neighbour with no known position
   * is not expanded into**, and that is a decision with three candidates rejected on purpose. Treating it as
   * older is the defect itself, for every segment the order does not cover. Treating it as unreachable-but-quiet
   * is what this does: the rule is a claim that a segment is older, and an id the graph never admitted cannot
   * establish it, so no step is taken through it. Failing loudly was the third candidate and is worse here - a
   * live step's walk is on the model's critical path, the graph already tolerates ids it does not hold (the final
   * filter below has always dropped hits whose segment is gone), and unplaced ids cannot arise from the live path
   * at all: `addSegments` places every id it admits. They can only come from an edge in a hand-written or damaged
   * snapshot, whose endpoints `recall` could never return as hits anyway.
   *
   * **A node expands into every neighbour that clears τ and lies earlier in the order, and there is no per-node
   * cap.** A `fanout` option (`k`, the heaviest-k cut) sat in this signature until 2026-10-05 and is retired: it
   * was never in the originating brief, never in the wiring record and never in the settings panel - see
   * `LEGACY_POLICY_KEYS` (`packages/core/src/config.ts`) for the retirement a profile that still writes it gets,
   * and `AssemblyPolicy.recall` (`packages/core/src/types.ts`) for the measurement that removed it. So the walk's
   * branching is bounded by `threshold` (fewer edges clear τ as it rises), by `depth`, and by the append order
   * itself, which is the bound the direction rule supplies.
   *
   * The hits describe a tree rooted at the seed: `via` is the parent that *discovered* the hit and `depth` its
   * discovery depth, both fixed at discovery, while `w` is the heaviest path's weight. The two are allowed to
   * disagree, because they answer different questions - what to rank by, and what the walk looked like.
   */
  recall(seedIds: readonly string[], opts: RecallOptions): RecallHit[] {
    const state = this.#walkState(seedIds);
    let frontier = state.frontier;
    while (frontier.length > 0) {
      const next = this.#walkLevel(frontier, opts, state);
      if (next.length === 0) break;
      frontier = next;
    }
    return this.#walkHits(state);
  }

  /** The walk's own state: the seeds, the best hit per node, what has been discovered, and the level it is on. */
  #walkState(seedIds: readonly string[]): {
    seeds: Set<string>;
    best: Map<string, RecallHit>;
    visited: Set<string>;
    frontier: { id: string; depth: number }[];
  } {
    return {
      seeds: new Set<string>(seedIds),
      best: new Map<string, RecallHit>(),
      visited: new Set<string>(seedIds),
      frontier: seedIds.map((id) => ({ id, depth: 0 })),
    };
  }

  /**
   * Expand one level of the walk: every node of `frontier` is ranked against the graph's edges as they stand, and
   * the neighbours that clear τ and lie earlier in the append order are discovered. Returns the next frontier.
   *
   * **This is the walk, and there is exactly one of it.** `recall` and `recallDemand` differ in *when* the graph's
   * rows are filled - eagerly, or by the demand walk asking for them level by level - and in nothing else: both
   * expand through this method, so "the lazy walk returns what the eager one returns on a settled graph" is a
   * property of the code rather than a promise about it.
   */
  #walkLevel(
    frontier: readonly { id: string; depth: number }[],
    opts: RecallOptions,
    state: { seeds: Set<string>; best: Map<string, RecallHit>; visited: Set<string> },
  ): { id: string; depth: number }[] {
    {
      const next: { id: string; depth: number }[] = [];
      for (const node of frontier) {
        if (node.depth >= opts.depth) continue;
        // The position this node stands at, which every expansion below has to be earlier than. Unknown for a
        // node outside the order, and then the node does not expand at all (`isBackwardStep`).
        const from = this.#at.get(node.id);
        // Ranked by decayed weight. There is **no per-node cap** any more (`fanout`/`k` is retired - `recall`'s own
        // doc comment carries the reason and the pointer), so this list is every neighbour that clears τ and lies
        // earlier in the append order, and the `sort` is the ranking the caller receives rather than the order a
        // cut is taken in. The direction filter sits in the same pass as the threshold because it is a condition on
        // the candidate, like the threshold beside it, and not a preference between candidates that both qualify:
        // a newer neighbour is not admitted and then dropped, it is never a candidate.
        const ranked = this.#walkNeighbors(node.id)
          .map((e) => {
            const other = e.other;
            const age = opts.now - e.at;
            return { other, w: decayedWeight(e.w, age, opts.lambdaMs) };
          })
          .filter((n) => n.w > opts.threshold && isBackwardStep(from, this.#at.get(n.other)))
          .sort((a, b) => b.w - a.w);

        for (const n of ranked) {
          // Seeds are the query anchors, never recall hits. The pair graph's back-edge is gone with the direction
          // rule - an expansion is strictly older, so one seed can no longer walk back into itself - but this line
          // is still load-bearing for a seed *set*: two seeds sit at two positions, the older of them is an
          // ordinary older neighbour of the newer, and without this it would come back as an "earlier turn" that is
          // in fact the question being asked. `visited` cannot stand in for it: it is seeded with them.
          if (state.seeds.has(n.other)) continue;
          const depth = node.depth + 1;
          const prev = state.best.get(n.other);
          if (prev === undefined) {
            // `via` and `depth` are written once, at discovery, and never rewritten.
            //
            // They used to be overwritten whenever a heavier path to the node turned up later
            // (`if (!prev || n.w > prev.w) best.set(...)`), which made `via` mean "the best predecessor seen so
            // far" rather than "the parent that discovered this node". A tree rebuilt from that is only
            // tree-*shaped*: it can re-parent a node under a node discovered after it, or close a cycle - anchor
            // `x -> a`, `a -> b`, then `b -> a` heavier than `x -> a` gives `best = {a: via b, b: via a}` - and the
            // structure logged for a step would then not be the walk that produced its selection. `recallTree`
            // records that walk, so the parent it records has to be the one the walk actually took. (That fixture
            // is no longer walkable at all now that expansion is strictly backwards, which is the direction rule's
            // own protection against a cycle; the freeze stays because it is what makes the tree the walk.)
            state.best.set(n.other, { id: n.other, w: n.w, via: node.id, depth });
          } else if (n.w > prev.w) {
            // A heavier path still raises the weight - it is what the hit is ranked, thresholded and ordered by -
            // but it does not re-parent the node. Keeping the two decisions apart is what makes a tree possible
            // at all: the strongest path and the discovery edge are no longer required to agree.
            prev.w = n.w;
          }
          if (!state.visited.has(n.other)) {
            state.visited.add(n.other);
            next.push({ id: n.other, depth });
          }
        }
      }
      return next;
    }
  }

  /** The walk's answer: its hits, whose segments the graph still holds, heaviest first. */
  #walkHits(state: { best: Map<string, RecallHit> }): RecallHit[] {
    return [...state.best.values()]
      .filter((h) => this.#segments.has(h.id))
      .sort((a, b) => b.w - a.w);
  }

  /**
   * The **on-demand** walk: the same level-by-level expansion as `recall`, with the rows it needs scored *because
   * it asked for them* rather than because the segments arrived.
   *
   * This is the whole of on-demand scoring, and it is one sentence of policy: a pair is paid for when a walk
   * demands the row that holds it. Before a level is expanded, this method asks for the rows of the nodes that
   * level stands on and cannot answer from what the graph already holds; the answer is written through the same
   * exclusive claim `scoreNew` uses (`#offer` → `#settle`/`#release`), so a walk and a sweep over one graph can
   * never be handed the same entry and no entry is left owned by a walk that has gone away.
   *
   * **Nothing is expanded that the graph does not connect.** A node whose row leaves it with no neighbour above τ
   * produces no children, so no row behind it is ever asked for - the branch is not computed at all. That is the
   * saving, and it is not a heuristic: it is the walk's own rule applied to the scoring.
   *
   * **What it costs, stated where the code is.** The pairs a walk pays for are `sum min(index, w)` over the rows
   * it reached, so unlike eager scoring (`sum_{i=1}^{N-1} min(i, w)`, which contains no `d`) the cost now moves
   * with `recall.depth`: more depth reaches more nodes, more nodes are rows, more rows are paid for. The
   * degenerate case is a session whose steps are as numerous as its segments - the walk then roots at nearly
   * every segment and the union of its demands approaches the eager total, which is the upper bound and not the
   * expectation. See `recall.depth` in `types.ts`, whose "`d` is free under eager scoring" note this method is
   * the arrival of.
   *
   * The demand is issued **newest first**, level by level, because the walk expands backwards: the first row is
   * the seed's own (the step's anchor), then the rows of what the anchor found, and so on. That ordering is worth
   * as much as the volume - eager scoring walks the append order from its oldest unsettled entry, which is the
   * opposite end of the session from where a step's recall starts.
   *
   * @param scorer the backend, handed one level's rows at a time; absent means "score locally", which is the
   *        fallback a session with no System-1 lane has always had and is what keeps such a session's graph
   *        populated at all.
   * @param budget asked before each level whether there is time to buy another one. `false` stops the demands and
   *        the walk finishes on what it holds; the level already claimed is never abandoned.
   */
  async recallDemand(
    seedIds: readonly string[],
    opts: RecallDemandOptions,
    scorer?: DemandScorer,
    budget?: () => boolean,
  ): Promise<DemandResult> {
    const windowN = Math.max(1, Math.trunc(opts.window));
    const state = this.#walkState(seedIds);
    const levels: DemandLevel[] = [];
    let frontier = state.frontier;
    let stop: DemandResult['stop'] = 'complete';
    for (;;) {
      if (frontier.length === 0) break;
      // Every node of this level is at the depth bound, so the level cannot be expanded and nothing behind it can
      // be reached: there is no row here worth buying.
      if (frontier.every((node) => node.depth >= opts.depth)) {
        stop = 'depth';
        break;
      }
      if (budget !== undefined && !budget()) {
        stop = 'budget';
        break;
      }
      const claim = this.#claimNeeded(frontier, windowN, scorer !== undefined);
      if (claim.rows.length > 0) {
        const level = await this.#demandLevel(claim.rows, opts, windowN, scorer);
        level.skipped = claim.skipped;
        levels.push(level);
      }
      else if (claim.skipped > 0) {
        // Rows the walk needed and could not have: another walk owns them, or they were settled between the
        // `#at` read and the claim. Nothing is asked for and nothing is waited on - the walk reads the graph as it
        // stands, which is the same answer it would give if the deadline had arrived.
        levels.push({ depth: frontier[0]?.depth ?? 0, rows: 0, pairs: 0, judged: 0, missed: 0, missedPairs: 0, skipped: claim.skipped });
      }
      const next = this.#walkLevel(frontier, opts, state);
      if (next.length === 0) break;
      frontier = next;
    }
    let rows = 0;
    let pairs = 0;
    let judged = 0;
    let missed = 0;
    let missedPairs = 0;
    let skipped = 0;
    for (const level of levels) {
      rows += level.rows;
      pairs += level.pairs;
      judged += level.judged;
      missed += level.missed;
      missedPairs += level.missedPairs;
      skipped += level.skipped;
    }
    return { hits: this.#walkHits(state), levels, rows, pairs, judged, missed, missedPairs, skipped, stop };
  }

  /**
   * The rows `frontier` needs and nobody else holds: one per node whose window is not yet fully scored.
   *
   * Only missing pairs are offered. When a backend is available, lexical guesses
   * are missing backend judgements too. A widened window or partially restored row
   * can therefore be completed without re-buying its measured pairs. The eager
   * cursor does not suppress this demand, but a row held by another caller does.
   */
  #claimNeeded(
    frontier: readonly { id: string; depth: number }[],
    windowN: number,
    requireBackend: boolean,
  ): { rows: DemandRow[]; skipped: number } {
    const rows: DemandRow[] = [];
    let skipped = 0;
    // **Newest first, inside a level as well as across levels.** The set of rows is the level's and does not
    // depend on this order, but the order is what a scorer that runs out of budget inside a level buys first, and
    // the walk's own need is nearest-the-anchor-first: a row at a higher index is closer to the step's own event
    // (the walk goes backwards), so it is worth more to the answer than one behind it. The frontier itself is
    // *not* reordered - `#walkLevel` discovers in the parent's ranked order, which is what decides `via` and the
    // tree, and this must not touch it.
    const ordered = frontier
      .map((node) => ({ node, index: this.#at.get(node.id) }))
      .filter((entry): entry is { node: { id: string; depth: number }; index: number } => entry.index !== undefined)
      .sort((a, b) => b.index - a.index);
    for (const { node, index } of ordered) {
      // A seed the graph does not hold has no position and therefore no window; a seed at position 0 has nothing
      // in front of it. Neither is a row, and neither is a skip: there is nothing to ask for.
      if (index <= 0) continue;
      const current = this.#segments.get(node.id);
      if (current === undefined) continue;
      const candidates: Segment[] = [];
      for (let j = Math.max(0, index - windowN); j < index; j += 1) {
        const id = this.#order[j] as string;
        const scored = this.#scores.get(`${id}->${node.id}`);
        if (scored !== undefined && (!requireBackend || scored.source === 's1-noul')) continue;
        const segment = this.#segments.get(id);
        if (segment !== undefined) candidates.push(segment);
      }
      if (candidates.length === 0) continue;
      // The settled cursor belongs to eager scoring under its original window. Demand
      // may widen that window, or resume a partially measured row after a restart.
      if (this.#taken.has(index)) {
        skipped += 1;
        continue;
      }
      this.#taken.add(index);
      rows.push({ id: node.id, index, depth: node.depth, current, candidates });
    }
    return { rows, skipped };
  }

  /**
   * Score one level's claimed rows and settle them, releasing any that nobody answered.
   *
   * Finished rows are resolved immediately; `finally` releases any remaining claims after a throw.
   * An answer, refusal or malformed weight list leaves the entry settled or free, never owned by a walk that
   * has gone away. A row that is *not* answered is released **unsettled and unwritten** - no lexical row is
   * written in its place - so a later walk asks again. That is the one deliberate difference from `scoreNew`'s
   * fallback: a sweep that loses its backend still has to fill the session's cursor, while a walk that loses its
   * backend only loses reach for that step, and the fail-open rule in `assemble()` is what covers the step's own
   * anchor. A session with **no** backend at all is the other branch below and does score locally, because there
   * is then no reason to prefer an empty graph.
   */
  async #demandLevel(
    rows: readonly DemandRow[],
    opts: RecallDemandOptions,
    windowN: number,
    scorer?: DemandScorer,
  ): Promise<DemandLevel> {
    const level: DemandLevel = {
      depth: rows[0]?.depth ?? 0,
      rows: rows.length,
      pairs: 0,
      judged: 0,
      missed: 0,
      missedPairs: 0,
      skipped: 0,
    };
    for (const row of rows) level.pairs += row.candidates.length;
    const settledAt = new Set<number>();
    try {
      if (scorer === undefined) {
        const local = opts.score ?? lexicalScore;
        for (const row of rows) {
          const weights = row.candidates.map((other) => local(row.current, other));
          this.#record(row.current, row.candidates, weights, false, windowN, opts.threshold);
          this.#settle(row.index);
          settledAt.add(row.index);
          this.#scoredPairs += row.candidates.length;
          this.#demandPairs += row.candidates.length;
        }
        return level;
      }
      const processed = new Set<number>();
      const accept = (i: number, weights: readonly number[] | undefined): void => {
        const row = rows[i];
        if (row === undefined || processed.has(i)) return;
        processed.add(i);
        // A short or over-long list is a caller bug and is treated exactly like no answer rather than guessed at:
        // `scoreNew` throws here, and a walk cannot afford to - see the note above.
        if (weights === undefined || weights.length !== row.candidates.length ||
            !Array.from(weights).every((w) => Number.isFinite(w) && w >= 0 && w <= 1)) {
          level.missed += 1;
          level.missedPairs += row.candidates.length;
          this.#miss(row.index, row.candidates.length);
          this.#release(row.index);
          settledAt.add(row.index);
          return;
        }
        this.#record(row.current, row.candidates, weights, true, windowN, opts.threshold);
        this.#settle(row.index);
        settledAt.add(row.index);
        this.#scoredPairs += row.candidates.length;
        this.#judgedPairs += row.candidates.length;
        this.#demandPairs += row.candidates.length;
        level.judged += row.candidates.length;
      };
      let answers: readonly (readonly number[] | undefined)[] | undefined;
      try {
        answers = await scorer(rows, accept);
      } catch {
        // Preserve rows already published; release unanswered rows for a later walk.
        answers = undefined;
      }
      for (let i = 0; i < rows.length; i += 1) accept(i, answers?.[i]);
      return level;
    } finally {
      for (const row of rows) if (!settledAt.has(row.index)) this.#release(row.index);
    }
  }

  /**
   * Count a demanded row nobody answered, **once per entry**.
   *
   * The entry is released unsettled, so a later walk asks for it again; without this guard the same pairs would
   * be counted on every attempt and `demandMissedPairs` would rise with the number of steps rather than with the
   * work that was lost. `deferredPairs` is deliberately not used for this: it is the eager path's first-refusal
   * accounting (a suffix of the append order, with a `k` a report solves for), and a demand is not a suffix.
   */
  #miss(index: number, pairs: number): void {
    if (this.#demandMissedAt.has(index)) return;
    this.#demandMissedAt.add(index);
    this.#demandMissedRows += 1;
    this.#demandMissedPairs += pairs;
  }

    stats(): {
      segments: number;
      edges: number;
      scoredPairs: number;
      judgedPairs: number;
      deferredPairs: number;
      /** of `scoredPairs`, the pairs an on-demand walk asked for; see `#demandPairs` */
      demandPairs: number;
      /** pairs a demanded row covered and never got an answer for; asked again by a later walk */
      demandMissedPairs: number;
      /** how many rows those pairs belonged to, counted once per entry */
      demandMissedRows: number;
    } {
      return {
        segments: this.#segments.size,
        edges: this.#edges.size,
        scoredPairs: this.#scoredPairs,
        judgedPairs: this.#judgedPairs,
        deferredPairs: this.#deferredPairs,
        demandPairs: this.#demandPairs,
        demandMissedPairs: this.#demandMissedPairs,
        demandMissedRows: this.#demandMissedRows,
      };
  }

  /**
   * Pairs the run declined to offer because the backend was saturated, cumulative.
   *
   * **A historical fact about the first refusal, never a live coverage term.** A pair counted here is one that was
   * not offered *when the refusal landed*; the counting is idempotent per entry (`countDeferredSuffix`,
   * `#deferralCounted`) and **nothing subtracts a pair that is scored later**, so the counter does not fall when
   * the walk recovers. Read it beside `scoredPairs`, never inside it, never added to it, and never as the window
   * the arrival order offered.
   *
   * Measured twice, and `scoredPairs + deferredPairs` breaks against the offered window in **both** directions:
   *
   * - round `20261004-0233` (cell C2): 10 157 + 16 767 = 26 924 against **17 020** offered (`Σ min(i, w)`,
   *   i = 1…184, **w = 1024 - the default of that round, not of this build** since 2026-10-05; a round's own wiring
   *   record is what says which it ran), cursor 67 of 185 - the tail was largely never recovered, and the overlap (segments
   *   23…66 deferred and scored afterwards) sits in both counters.
   * - round `20261004-1211` (cell C2): 780 + 212 = **992 against 780** offered, cursor **40 of 40** - every
   *   deferred pair was recovered and scored, and all 212 stay counted, so the sum exceeds the whole session.
   *   `scores` holds 780 distinct pairs, a complete triangle; the 212 are `Σ_{i=23}^{30} i` with
   *   `deferredSegments` 8 = 31 − 23, i.e. counted when the order held 31 segments - a suffix of an *earlier,
   *   shorter* order, and no suffix sum of the final 40.
   *
   * The ratio, its offered denominator and the first-refusal index `k` (which exists only while the counted tail
   * is still the session's tail) are `docs/FORMULAS.md` §5.1's - corrected 2026-10-05 - and are not restated here:
   * this class owns the counters, not the reading placed on them.
   */
  get deferredPairs(): number {
    return this.#deferredPairs;
  }

  /** Segments whose window has not been offered yet; their pairs are the `deferredPairs` above. */
  get deferredSegments(): number {
    return this.#deferredSegments;
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
      judgedPairs: this.#judgedPairs,
      deferredPairs: this.#deferredPairs,
      deferredSegments: this.#deferredSegments,
      demandPairs: this.#demandPairs,
      demandMissedPairs: this.#demandMissedPairs,
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
    // The membership set follows the order it was built from, so `addSegments` after a restore cannot append a
    // duplicate of an id the snapshot already carried.
    graph.#known = new Set(graph.#order);
    // And so does the position index. First occurrence wins, which is what `#order.indexOf` answers for a snapshot
    // that names an id twice - the walk and `unjudgedWithin` must not disagree about where a segment sits. A
    // segment the snapshot carries but its `order` does not is deliberately left *unplaced* rather than appended
    // in `seq` order here: the walk then declines to guess its age (see `recall`), which is the honest reading of
    // a file whose own order does not cover it, and no live path can produce one (`addSegments` places every id).
    for (const [index, id] of graph.#order.entries()) if (!graph.#at.has(id)) graph.#at.set(id, index);
    for (const edge of snap.edges ?? []) {
      graph.#edges.set(`${edge.from}->${edge.to}`, edge);
      graph.#link(edge.from, edge.to);
    }
    for (const score of snap.scores ?? []) graph.#putScore(score);
    // Clamped, because a cursor larger than the order array would silently skip scoring forever.
    graph.#scored = Math.max(0, Math.min(graph.#order.length, Math.trunc(snap.scored ?? 0)));
    graph.#scoredPairs = Math.max(0, Math.trunc(snap.scoredPairs ?? 0));
    graph.#judgedPairs = Math.max(0, Math.trunc(snap.judgedPairs ?? 0));
    graph.#deferredPairs = Math.max(0, Math.trunc(snap.deferredPairs ?? 0));
    graph.#deferredSegments = Math.max(0, Math.trunc(snap.deferredSegments ?? 0));
    graph.#demandPairs = Math.max(0, Math.trunc(snap.demandPairs ?? 0));
    graph.#demandMissedPairs = Math.max(0, Math.trunc(snap.demandMissedPairs ?? 0));
    // The deferral cursor is re-derived from what the snapshot says was deferred. It is an *index* into `order`,
    // not a count: `deferSegment` leaves it one past the last entry it counted, and a walk counts a whole suffix,
    // so what it reached is the end of the order the snapshot was written from. Restoring the segment *count*
    // here - which is what this did - put the marker 162 entries into a 185-entry order for round
    // `20261004-0233`'s final snapshot, so a resumed graph would have re-counted the last 23 segments' windows as
    // deferred and reported a deferral total larger than the session has pairs. `0` when nothing was ever
    // deferred, because then no walk has run.
    graph.#deferralCounted = graph.#deferredSegments > 0 ? graph.#order.length : 0;
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
  unjudgedWithin(seedId: string, windowN: number): Segment[] {
    // The same position `recall` expands towards, read from the same index; `-1` is "the graph does not hold it",
    // which is what `#order.indexOf` returned here before.
    const seed = this.#at.get(seedId) ?? -1;
    if (seed < 0) return [];
    const from = Math.max(0, seed - Math.max(0, Math.trunc(windowN)));
    const out: Segment[] = [];
    // Nearest first: when the backend has not answered, recency *inside* the window is the best ordering there is.
    for (let i = seed - 1; i >= from; i -= 1) {
      const id = this.#order[i] as string;
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
export function lexicalScore(a: Segment, b: Segment): number {
  const left = segmentTokens(a);
  const right = segmentTokens(b);
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  return shared / Math.min(left.size, right.size);
}

// Weak keys bound the cache to live segment objects. Check text as callers can replace
// or mutate a segment, and never retain another session's text in a global string map.
const tokenCache = new WeakMap<Segment, { text: string; tokens: Set<string> }>();
function segmentTokens(segment: Segment): Set<string> {
  const cached = tokenCache.get(segment);
  if (cached?.text === segment.text) return cached.tokens;
  const tokens = tokensOf(segment.text);
  tokenCache.set(segment, { text: segment.text, tokens });
  return tokens;
}

function tokensOf(text: string): Set<string> {
  const out = new Set<string>();
  for (const token of text.toLowerCase().split(/[^\p{L}\p{N}_]+/u)) {
    if (token.length > 1) out.add(token);
  }
  return out;
}
