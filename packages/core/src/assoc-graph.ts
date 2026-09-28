/**
 * Association graph (RG) — nodes are segments, edges are System-1-scored relevance
 * relations with recency decay (docs/FORMULAS.md §2, docs/AGENT_BRIEF.md §5.2).
 *
 * Storage is in-memory for M0/M1; the SQLite-backed store plugs in behind the
 * same surface (segments + edges + provenance).
 */
import type { AssociationEdge, Segment } from './types.ts';

/** w_eff = w · exp(−Δt/λ) */
export function decayedWeight(w: number, ageMs: number, lambdaMs: number): number {
  if (!(lambdaMs > 0)) return w;
  return w * Math.exp(-Math.max(0, ageMs) / lambdaMs);
}

export interface RecallOptions {
  /** relevance threshold τ */
  tau: number;
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

export class AssociationGraph {
  #segments = new Map<string, Segment>();
  #edges = new Map<string, AssociationEdge>();
  #adj = new Map<string, string[]>();

  get segmentCount(): number {
    return this.#segments.size;
  }

  get edgeCount(): number {
    return this.#edges.size;
  }

  addSegments(segments: Iterable<Segment>): void {
    for (const s of segments) this.#segments.set(s.id, s);
  }

  getSegment(id: string): Segment | undefined {
    return this.#segments.get(id);
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
          .filter((n) => n.w > opts.tau)
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

  stats(): { segments: number; edges: number } {
    return { segments: this.#segments.size, edges: this.#edges.size };
  }
}
