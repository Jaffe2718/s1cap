#!/usr/bin/env python
"""
Draw one session's association graph.

The graph is small in the only unit that matters here - `recall.window = w` counts **segments**, not tokens, so a
session of a few hundred segments is a few hundred nodes - which means the whole thing can be looked at instead of
inferred from counters. That is the point of this script: the counters said `scoredPairs: 18528` while the block
was being filled from the recency window, and only a picture of which nodes carry edges shows why.

Three facts are drawn together because they are the same fact at different resolutions:

  * which segment kinds exist, and where in the append order they sit (top panel);
  * which edges came from the System-1 backend and which from the lexical fallback (top panel, colour);
  * which segments have no edges at all (bottom panel, and hollow markers above).

Usage:
  python scripts/plot-rg.py <snapshot.json> [out.png]

The snapshot is the file the plugin writes per session under `<DSH_HOME>/.s1cap/rg/`.
"""
import json
import sys
from collections import Counter

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.lines import Line2D

KIND_ORDER = ["systemPinned", "user", "assistant", "trace", "toolCall", "toolResult"]
KIND_COLOUR = {
    "systemPinned": "#7f7f7f",
    "user": "#1f77b4",
    "assistant": "#2ca02c",
    "trace": "#9467bd",
    "toolCall": "#ff7f0e",
    "toolResult": "#8c564b",
}
S1_COLOUR = "#d62728"
LEXICAL_COLOUR = "#bbbbbb"


def load(path):
    with open(path, encoding="utf-8") as handle:
        return json.load(handle)


def main():
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)
    path = sys.argv[1]
    out = sys.argv[2] if len(sys.argv) > 2 else "rg.png"
    snap = load(path)

    order = snap["order"]
    segments = {s["id"]: s for s in snap["segments"]}
    edges = snap.get("edges", [])

    # Position in the append order is the x axis; the kind is the lane. Both are facts about the session, not a
    # layout choice, so nothing is hidden by where a node lands.
    lanes = {kind: i for i, kind in enumerate(KIND_ORDER)}
    pos = {}
    for i, sid in enumerate(order):
        seg = segments.get(sid)
        kind = seg["kind"] if seg else "trace"
        pos[sid] = (i, lanes.get(kind, len(KIND_ORDER)))

    degree = Counter()
    for e in edges:
        degree[e["from"]] += 1
        degree[e["to"]] += 1

    fig, (ax, ax2) = plt.subplots(
        2, 1, figsize=(16, 9), height_ratios=[3, 1], constrained_layout=True
    )

    # --- edges first, so nodes sit on top of them ---
    drawn_s1 = drawn_lex = 0
    for e in edges:
        a, b = pos.get(e["from"]), pos.get(e["to"])
        if a is None or b is None:
            continue
        is_s1 = e.get("source") == "s1-noul"
        ax.plot(
            [a[0], b[0]], [a[1], b[1]],
            color=S1_COLOUR if is_s1 else LEXICAL_COLOUR,
            lw=0.9 if is_s1 else 0.4,
            alpha=0.35 if is_s1 else 0.10,
            zorder=1,
        )
        drawn_s1 += is_s1
        drawn_lex += not is_s1

    # --- nodes ---
    for sid, (x, y) in pos.items():
        seg = segments.get(sid) or {}
        kind = seg.get("kind", "trace")
        colour = KIND_COLOUR.get(kind, "#333333")
        isolated = degree[sid] == 0
        ax.scatter(
            [x], [y],
            s=max(12, min(220, (seg.get("tokens") or 1) * 0.35)),
            facecolors="none" if isolated else colour,
            edgecolors="black" if isolated else colour,
            linewidths=1.1 if isolated else 0.0,
            alpha=0.95,
            zorder=3,
        )

    # --- the BFS anchors: recall starts from the last user segment ---
    users = [sid for sid in order if (segments.get(sid) or {}).get("kind") == "user"]
    for sid in users:
        x, y = pos[sid]
        ax.scatter([x], [y], s=260, facecolors="none", edgecolors="black", linewidths=1.4, zorder=4)
        if degree[sid] == 0:
            ax.scatter([x], [y], s=520, facecolors="none", edgecolors="red", linewidths=1.8, zorder=5)
            ax.annotate(
                f"anchor with 0 edges\n(BFS starts here -> 0 candidates)",
                (x, y), textcoords="offset points", xytext=(0, -34),
                ha="center", fontsize=8, color="red",
            )

    ax.set_yticks(range(len(KIND_ORDER)))
    ax.set_yticklabels(KIND_ORDER)
    ax.set_xlabel("position in the graph's append order  (one point per context segment)")
    ax.set_title(
        f"association graph  -  {len(order)} segments, {len(edges)} edges  "
        f"({drawn_s1} from System-1, {drawn_lex} lexical)   "
        f"scoring cursor at {snap.get('scored')}, scoredPairs {snap.get('scoredPairs')}"
    )
    ax.grid(axis="x", alpha=0.15)
    ax.legend(
        handles=[
            Line2D([], [], color=S1_COLOUR, lw=2, label="edge scored by the System-1 backend (s1-noul)"),
            Line2D([], [], color=LEXICAL_COLOUR, lw=2, label="edge from the lexical fallback"),
            Line2D([], [], marker="o", color="w", markerfacecolor="#1f77b4", markersize=8, label="segment (colour = kind, size = tokens)"),
            Line2D([], [], marker="o", color="w", markerfacecolor="none", markeredgecolor="black", markersize=8, label="segment with no edges"),
            Line2D([], [], marker="o", color="w", markerfacecolor="none", markeredgecolor="red", markersize=11, label="BFS anchor with no edges"),
        ],
        loc="upper left", fontsize=8, framealpha=0.9,
    )

    # --- degree against position: the picture behind "later anchors are isolated" ---
    xs = [pos[sid][0] for sid in order]
    degs = [degree[sid] for sid in order]
    ax2.scatter(xs, degs, s=14, color="#1f77b4", alpha=0.7)
    ax2.axhline(0, color="red", lw=0.8)
    ax2.set_xlabel("position in the append order")
    ax2.set_ylabel("edges at the segment")
    ax2.set_title("how connected each segment is - zero means BFS from it can never return a candidate", fontsize=9)
    ax2.grid(alpha=0.2)

    fig.savefig(out, dpi=140)
    print(f"wrote {out}")

    kinds = Counter((segments.get(sid) or {}).get("kind", "?") for sid in order)
    zero = Counter((segments.get(sid) or {}).get("kind", "?") for sid in order if degree[sid] == 0)
    print("segments by kind    :", dict(kinds))
    print("zero-edge by kind   :", dict(zero))
    print("edges by source     :", dict(Counter(e.get("source") for e in edges)))
    print("BFS anchors (user)  :", [(sid[:8], degree[sid]) for sid in users])


if __name__ == "__main__":
    main()
