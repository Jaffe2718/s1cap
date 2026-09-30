#!/usr/bin/env python
"""
Draw one session's association graph as a connectivity matrix.

The graph is small in the unit that matters - `recall.window = w` counts **segments**, not tokens, so a session
is a few hundred nodes - which means the whole thing can be looked at instead of inferred from counters. The
matrix is the right shape for the question that matters: *which segment is connected to which*, and in
particular whether the connections have structure or are a constant pointing at one part of the session.

Both axes are the graph's append order, so an edge between segment i and segment j is a dot at (i, j) and
(i, j) mirrored. Because a segment can only be scored against segments that came before it, every edge lies in
the upper triangle: a band that runs parallel to the diagonal means local, recent connection, and a band that
runs straight up from one early position means every later segment was measured against that same early part
of the session no matter what it said. Those two patterns look nothing alike here, which is why this is drawn
as a matrix and not as a graph layout.

Colour is who produced the edge: the System-1 backend or the lexical fallback. The kind of each segment is
shown as a strip along both axes, and the BFS anchors - the last user segment of each turn, which is where
recall starts - are drawn as red lines when they have no edges at all, because a BFS from an isolated node can
never return a candidate.

Usage:
  python scripts/plot-rg.py <snapshot.json> [out.png] [threshold]

The snapshot is the file the plugin writes per session under `<DSH_HOME>/.s1cap/rg/`.

The left panel is the graded picture: every pair the backend was asked about, coloured by the probability it
returned. The right panel is what the threshold kept. Before `scores` was stored the two were the same thing -
the graph kept only the pairs that cleared r, so a matrix drawn from it could only ever be a yes/no picture, and
the sub-threshold probabilities were gone even though they had been paid for. A schema-1 snapshot has no
`scores` and the left panel says so rather than drawing an empty grid that reads as "nothing was relevant".
"""
import json
import sys
from collections import Counter

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
from matplotlib.colors import Normalize
from matplotlib.lines import Line2D
from matplotlib.patches import Patch

KIND_ORDER = ["systemPinned", "user", "assistant", "trace", "toolCall", "toolResult"]
KIND_COLOUR = {
    "systemPinned": "#7f7f7f",
    "user": "#1f77b4",
    "assistant": "#2ca02c",
    "trace": "#9467bd",
    "toolCall": "#ff7f0e",
    "toolResult": "#8c564b",
}
S1_RGB = np.array([0.84, 0.15, 0.16])      # red: scored by the System-1 backend
LEX_RGB = np.array([0.55, 0.55, 0.55])     # grey: the lexical fallback
GRADED_CMAP = plt.get_cmap("viridis")


def hex_to_rgb(value):
    value = value.lstrip("#")
    return np.array([int(value[i:i + 2], 16) / 255 for i in (0, 2, 4)])


def main():
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)
    path = sys.argv[1]
    out = sys.argv[2] if len(sys.argv) > 2 else "rg-matrix.png"
    with open(path, encoding="utf-8") as handle:
        snap = json.load(handle)

    order = snap["order"]
    segments = {s["id"]: s for s in snap["segments"]}
    edges = snap.get("edges", [])
    n = len(order)
    position = {sid: i for i, sid in enumerate(order)}
    kind_of = [(segments.get(sid) or {}).get("kind", "trace") for sid in order]

    # Two passes so the System-1 edges win where a pair carries both: the lexical pass is drawn first and is
    # almost always the one that would otherwise hide the measurement.
    canvas = np.ones((n, n, 3))
    for e in edges:
        if e.get("source") == "s1-noul":
            continue
        i, j = position.get(e["from"]), position.get(e["to"])
        if i is None or j is None:
            continue
        w = float(e.get("w") or 0.0)
        shade = LEX_RGB * (1.0 - 0.45 * max(0.0, min(1.0, w)))
        canvas[i, j] = shade
        canvas[j, i] = shade
    for e in edges:
        if e.get("source") != "s1-noul":
            continue
        i, j = position.get(e["from"]), position.get(e["to"])
        if i is None or j is None:
            continue
        w = float(e.get("w") or 0.0)
        canvas[i, j] = S1_RGB * (1.0 - 0.35 * max(0.0, min(1.0, w)))
        canvas[j, i] = canvas[i, j]

    # The graded picture: one cell per pair the backend was asked about, coloured by the probability it gave.
    # NaN is "never scored", which is a different fact from "scored 0" and is drawn as blank.
    scores = snap.get("scores") or []
    graded = np.full((n, n), np.nan)
    for pair in scores:
        i, j = position.get(pair["from"]), position.get(pair["to"])
        if i is None or j is None:
            continue
        graded[i, j] = pair["w"]
        graded[j, i] = pair["w"]

    degree = Counter()
    for e in edges:
        degree[e["from"]] += 1
        degree[e["to"]] += 1
    users = [i for i, k in enumerate(kind_of) if k == "user"]
    dead_anchors = [i for i in users if degree[order[i]] == 0]

    fig = plt.figure(figsize=(17, 10))
    # Two matrices, because "what was measured" and "what was kept" stopped being the same thing the moment the
    # probabilities were stored. The strip owns each title: putting it on a matrix put the first line underneath
    # the strip, which is how a picture whose whole point is three numbers ends up showing none of them.
    ax_g = fig.add_axes([0.06, 0.10, 0.34, 0.58])
    ax_e = fig.add_axes([0.52, 0.10, 0.34, 0.58])
    ax_gt = fig.add_axes([0.06, 0.69, 0.34, 0.012])
    ax_et = fig.add_axes([0.52, 0.69, 0.34, 0.012])
    ax_gl = fig.add_axes([0.04, 0.10, 0.012, 0.58])

    extent = (-0.5, n - 0.5, n - 0.5, -0.5)
    graded_img = np.ones((n, n, 3))
    if scores:
        mask = ~np.isnan(graded)
        graded_img[mask] = GRADED_CMAP(np.nan_to_num(graded, nan=0.0))[mask][:, :3]
    ax_g.imshow(graded_img, interpolation="nearest", origin="upper", extent=extent)
    ax_e.imshow(canvas, interpolation="nearest", origin="upper", extent=extent)

    for axis in (ax_g, ax_e):
        axis.set_xlabel("segment index in the append order  (newer ->)")
        axis.set_ylabel("segment index in the append order  (newer ->)")
        # Every twentieth index: that is the request size, so it is the grid the batches move along.
        for tick in range(0, n, 20):
            axis.axhline(tick, color="black", lw=0.3, alpha=0.25)
            axis.axvline(tick, color="black", lw=0.3, alpha=0.25)
        for i in dead_anchors:
            axis.axhline(i, color="red", lw=1.1, alpha=0.9)
            axis.axvline(i, color="red", lw=1.1, alpha=0.9)

    for i in dead_anchors:
        ax_e.annotate(
            f"  anchor {i}: 0 edges",
            (n - 0.5, i), xytext=(-4, 4), textcoords="offset points",
            ha="right", va="bottom", fontsize=8, color="red",
        )

    strip = np.array([hex_to_rgb(KIND_COLOUR.get(k, "#333333")) for k in kind_of]).reshape(1, n, 3)
    for strip_axis in (ax_gt, ax_et):
        strip_axis.imshow(strip, aspect="auto", interpolation="nearest", extent=(-0.5, n - 0.5, 0, 1))
        strip_axis.set_axis_off()
    ax_gl.imshow(strip.reshape(n, 1, 3), aspect="auto", interpolation="nearest", extent=(0, 1, n - 0.5, -0.5))
    ax_gl.set_axis_off()

    s1_edges = sum(1 for e in edges if e.get("source") == "s1-noul")
    if scores:
        s1_scores = sum(1 for p in scores if p.get("source") == "s1-noul")
        ax_g.set_title(
            f"what the backend was asked, and what it answered  -  {len(scores)} scored pairs "
            f"({s1_scores} System-1)\n"
            f"colour is the probability itself; blank means the pair was never scored",
            fontsize=9, pad=8,
        )
        sm = plt.cm.ScalarMappable(norm=Normalize(0, 1), cmap=GRADED_CMAP)
        fig.colorbar(sm, ax=ax_g, fraction=0.046, pad=0.02, label="P(retrieving the candidate helps)")
    else:
        ax_g.set_title(
            "no `scores` in this snapshot: it is schema 1, written before the probabilities were kept,\n"
            "so this panel cannot be drawn - the pairs below the threshold are gone",
            fontsize=9, pad=8, color="#b00",
        )

    ax_et.set_title(
        f"what the threshold kept  -  {n} segments, {len(edges)} edges ({s1_edges} System-1, "
        f"{len(edges) - s1_edges} lexical)  -  cursor {snap.get('scored')}, scoredPairs {snap.get('scoredPairs')}\n"
        f"both axes are the append order, and every edge sits above the diagonal because a segment is scored "
        f"only against earlier ones",
        fontsize=9, pad=8,
    )

    legend = [
        Line2D([], [], color=S1_RGB, lw=4, label="edge scored by the System-1 backend (s1-noul)"),
        Line2D([], [], color=LEX_RGB, lw=4, label="edge from the lexical fallback"),
        Line2D([], [], color="red", lw=1.4, label=f"BFS anchor with no edges ({len(dead_anchors)} of {len(users)} user segments)"),
    ] + [
        Patch(facecolor=KIND_COLOUR[k], label=k) for k in KIND_ORDER if k in set(kind_of)
    ]
    ax_e.legend(handles=legend, loc="upper left", bbox_to_anchor=(1.03, 1.0), fontsize=8, framealpha=0.95)

    fig.savefig(out, dpi=150)
    print(f"wrote {out}")

    # The numbers behind the picture, including the one the picture is for: how far back the System-1 edges
    # reach. A median in the hundreds while the recent end is covered only by lexical edges is the signature of
    # a batch that covers the wrong end of the window.
    s1_dist = sorted(
        abs(position[e["from"]] - position[e["to"]]) for e in edges if e.get("source") == "s1-noul"
    )
    lex_dist = sorted(
        abs(position[e["from"]] - position[e["to"]]) for e in edges if e.get("source") != "s1-noul"
    )
    print("segments by kind  :", dict(Counter(kind_of)))
    print("zero-edge by kind :", dict(Counter(k for k, sid in zip(kind_of, order) if degree[sid] == 0)))
    print("edges by source   :", dict(Counter(e.get("source") for e in edges)))
    print("user anchors      :", [(i, degree[order[i]]) for i in users])
    for name, dist in (("s1-noul", s1_dist), ("lexical", lex_dist)):
        if dist:
            print(
                f"{name:>8} distance back: min={dist[0]} median={dist[len(dist) // 2]} max={dist[-1]} "
                f"<=20: {sum(1 for d in dist if d <= 20)}  >100: {sum(1 for d in dist if d > 100)}"
            )
    print("fill ratio        :", f"{len(edges) / (n * (n - 1) / 2):.4f} of the upper triangle")


if __name__ == "__main__":
    main()
