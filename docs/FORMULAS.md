# S1CAP Formal Definitions and Formula Handbook

**Version** 0.1 · 2026-09-28 · Companion to [PROPOSAL.md](./PROPOSAL.md) · [ARCHITECTURE.md](./ARCHITECTURE.md) · [AGENT_BRIEF.md](./AGENT_BRIEF.md) · [technical roadmap](./figures/s1cap-technical-route.html)

This document uses Markdown + LaTeX to fix all mathematical definitions of S1CAP: segmentation and association graph, context assembly, Trace-as-State layout, plan gate, cost and cache break-even model, time model, statistical protocol. Parameter default values agree with [AGENT_BRIEF.md](./AGENT_BRIEF.md) §4-§5.

---

## 0. Notation

| Symbol | Meaning | Default value |
|---|---|---|
| $\mathcal{L} = (e_1,\dots,e_T)$ | Session event log (append-only, human-recorded, never rewritten) | — |
| $S=\{s_1,\dots,s_n\}$ | Segment set; $s_i=(\mathrm{id},\mathrm{kind},\mathrm{tok}_i,t_i,\mathrm{text}_i)$, $\mathrm{kind}\in\{$user, assistant, trace, toolCall, toolResult$\}$ | — |
| $x$ | Current user input (condition/instruction) | — |
| $P$ | Fixed prefix (system prompt + tool schema), never reordered | — |
| $T_{\mathrm{state}}$ | Task-state proxy (serialized reasoning trace + task brief) | $\le 8\mathrm{k}$ chars |
| $G_t=(V_t,E_t)$ | Association graph at time $t$ (association graph) | — |
| $\tau,\ d,\ k$ | Association threshold / BFS depth / per-node expansion limit | $0.55,\ 2,\ 8$ |
| $\lambda$ | Time decay constant (active session time) | 30 min |
| $K$ | Number of recent-tail verbatim turns kept | 3 |
| $B$ | Context token budget | §3.1 |
| $\rho$ | Recall-block share of the budget | 0.35 |
| $\mu$ | Minimum recall-block fill rate (fallback below this) | 0.25 |
| $m,\ M$ | Number of candidate plans / attempt limit | $3,\ 2$ |
| $c_{\min}$ | Plan gate abstention confidence | 0.5 |

## 1. Segmentation (SEGMENTER)

Message-level segmentation, **never split by token**:

$$
s_i =
\begin{cases}
\mathrm{chunk}(e_i,\,512,\,\mathrm{overlap}=64), & \mathrm{tok}(e_i) > 512 \\
e_i, & \text{otherwise}
\end{cases}
$$

The fixed set $P$ (system/tool schema) does not enter $S$. Each new segment $p$ triggers an association graph update (§2).

## 2. Association graph (S1 association compute backend: two-tier recall + lazy verification)

All S1 calls in this section are handled by the **S1 association compute backend**; it and the **S1 decision backend** of §4 are two independent roles (they may point to the same `/v1/systemone` deployment, or be deployed separately / use different models).

**Tier-0 (metadata, free)**: same task label, same tool family, reply chain — fixed weight $w_0 = 0.6$.

**Tier-1 (candidate generation)**: choose one of two (config option `recall.tier1`):

$$
\text{embed mode:}\quad C_1(p) = \operatorname*{top\text{-}k}_{h \in S}\ \cos\big(\phi(p),\phi(h)\big),\quad k=32
$$

$$
\text{S1 mode:}\quad w_1(p,h) = P_{\mathrm{S1}}\big(\mathrm{rel}(p,h)\big),\quad \text{single } \texttt{/v1/systemone} \text{ parallel noul batch}
$$

**Tier-2 (lazy verification, only for edges that may enter assembly)**:

$$
w(p,h) =
\begin{cases}
f_{\mathrm{score}}(p,h) \in [0,1], & \mathrm{conf} \ge c_{\min} \\
0.8\, w_1(p,h), & \text{abstain}
\end{cases}
$$

**Time decay**:

$$
w_{\mathrm{eff}}(p,h) = w(p,h)\cdot \exp\!\big(-\Delta t/\lambda\big), \qquad \Delta t = t_{\mathrm{now}} - t_h
$$

**Per-turn complexity**: tier-1 ANN $O(\log n)$; tier-2 one parallel query call (state ingested once, $|C_1|$ questions evaluated in parallel); in total tens of ms locally, about $0.0006/turn$ in the cloud.

## 3. Context assembly (ASSEMBLER)

### 3.1 Budget

$$
B = C_{\max} - r_{\mathrm{out}} - f_{\mathrm{fixed}}
$$

where $C_{\max}$ is the model context window, $r_{\mathrm{out}}$ the output reserve (8192), $f_{\mathrm{fixed}}$ the fixed overhead (tool schema etc., measured by the token meter).

### 3.2 Bounded BFS recall

$$
R_d(x) = \big\{ h \in S : \exists\, x \to \cdots \to h,\ \text{path length} \le d,\ \text{per edge } w_{\mathrm{eff}} > \tau,\ \text{per node expansion} \le k \big\}
$$

Worst case $O(k^d)$, truncated early by the budget.

### 3.3 Budget knapsack (greedy)

$$
R' = \arg\max_{R \subseteq R_d(x)} \sum_{h \in R} w_{\mathrm{eff}}(x,h)
\quad \text{s.t.} \quad
\sum_{h \in R} \mathrm{tok}(h) \le \rho B
$$

Greedily packed in descending order of $w_{\mathrm{eff}}$; deduplicated by segment id against the recent-tail $K$ verbatim turns.

### 3.4 Trace-as-State layout (factor TAS on)

$$
\mathrm{prompt} = \big[\,P \,\|\, T_{\mathrm{state}} \,\|\, \operatorname{sort}_{w_{\mathrm{eff}} \downarrow}(R') \,\|\, \mathrm{tail}_K \,\|\, x\,\big]
$$

Key points (from [arXiv:2609.02702](https://arxiv.org/abs/2609.02702)):

- **State first**: $T_{\mathrm{state}}$ (the task state distilled from the trace) is placed before the history, so it is available before the context;
- **Question at the tail**: $x$ is always last (measured in paper T: the model's behavior drifts when the question is not at the end);
- **Strongest first**: recall blocks are ordered by descending $w_{\mathrm{eff}}$ plus the recent-tail verbatim turns at the end, forming a U-shaped attention layout (echoing *Lost in the Middle*, [arXiv:2307.03172](https://arxiv.org/abs/2307.03172));
- **Cache-friendly**: $P$ is never reordered; $T_{\mathrm{state}}$ is appended at task boundaries (`updatePolicy: perTask` by default).

**Memory separation theorem of paper T** (conditional state update task, state space $\mathcal{S}$, $b=\log_2|\mathcal{S}|$):

$$
\text{condition-first } [z,C]:\ \lceil b \rceil \text{ bits}
\qquad\text{vs}\qquad
\text{condition-last } [C,z]:\ \lceil b\cdot 2^{b} \rceil \text{ bits (worst case)}
$$

That is, the working memory demand of condition-first versus condition-last shows an **exponential separation** — this is the theoretical basis for the TAS layout.

### 3.5 Fallback

$$
\sum_{h \in R'} \mathrm{tok}(h) < \mu \rho B \implies \text{degrade to recency window (chronological last-}N\text{), log a degradation event}
$$

## 4. Plan gate (S1 decision backend + PLAN GATE, factor S1G on)

After the LLM produces a plan set $\Pi = \{\pi_1,\dots,\pi_m\}$ ($m \le 3$), it **hands the candidate plans directly to the S1 decision backend** for one choice scoring, retrieving probabilities $p_i$ and confidences $\mathrm{conf}_i$; **PLAN GATE consumes the scoring results** and is responsible only for normalization, the abstention decision, the attempt limit, and ordering. **Server-side normalization** (Jev does not guarantee $\sum p_i = 1$):

$$
\hat p_i = \frac{p_i}{\sum_j p_j}
$$

**Execution order**: try in descending order of $\hat p$, the verifier $V(\pi)$ decides success; on success the unexecuted plans are dropped; attempt limit $M=2$:

$$
\text{execute } \pi_{(1)}, \pi_{(2)}, \dots \quad \text{until } V(\pi_{(i)}) = \top \text{ or } i = M
$$

**Abstention**: $\max_i \mathrm{conf}_i < c_{\min} \Rightarrow$ keep the LLM's own order.

**Expected savings** (let $q_{(i)}$ be each plan's independent success probability and $c(\pi_i)$ its cost):

$$
\mathbb{E}[\text{savings}] = \sum_{i=1}^{M} \Big(\prod_{j<i}(1-q_{(j)})\Big)\, q_{(i)} \sum_{j>i} c(\pi_j)
$$

Condition for positive gate benefit: the $\hat p$ ordering moves $q_{(i)}$ earlier (i.e. the S1 ordering is rank-correlated with the true success rate $> 0$).

## 5. Cost model

**Single LLM call**:

$$
c_{\mathrm{call}} = p_{\mathrm{hit}}\, n_{\mathrm{hit}} + p_{\mathrm{miss}}\, n_{\mathrm{miss}} + p_{\mathrm{out}}\, n_{\mathrm{out}}
$$

**Total task cost**:

$$
C_{\mathrm{task}} = \sum_{\text{calls}} c_{\mathrm{call}} + C_{\mathrm{S1}}, \qquad
C_{\mathrm{S1}} = p_{\mathrm{s1}} \sum_{\text{S1 calls}} n_{\mathrm{in}}^{\mathrm{S1}} \quad (\text{Jev output is free})
$$

Reference prices (per 1M tokens, verified 2026-09-28): `deepseek-flash` peak $p_{\mathrm{hit}}=0.006,\ p_{\mathrm{miss}}=0.30,\ p_{\mathrm{out}}=1.20$ (halved off-peak); GLM-5.3 at $0.26/1.40/4.40$; Jev $p_{\mathrm{s1}}=0.042$ (input only).

### 5.1 What a report has to carry

> **Cell labels in this section.** The measured figures quoted here come from round `20261001-1300`, which ran
> **four** cells under labels that no longer exist. The mapping is: round `C1` (baseline) is today's **`C0`**;
> round `C2` (TAS alone) is today's **`C1`**; round `C3` (recall selection with `tas.on: false`) is **dropped, no
> successor**; round `C4` (the full configuration) is today's **`C2`**. Every figure below stays attributed to that
> round and to the label it ran under, and none is silently re-labelled. `docs/CELLS-RUN.md` §"The names changed
> after round `20261001-1300` ran" carries the same table, with the per-step reason the fourth arm was dropped
> (3 625 uncached input tokens per step against the baseline's 2 595, 2 574 output against 1 523, a 79.2% hit rate
> against 86.7%, and 22.5% coverage, below the 0.5 floor).

The primary measurements are the three raw token counts inside $c_{\mathrm{call}}$ — the triple
$(n_{\mathrm{miss}}, n_{\mathrm{hit}}, n_{\mathrm{out}})$: uncached input tokens, cached input tokens, output
tokens — reported **separately and per unit of work**, per turn and per step, because a hit rate is a ratio and a
ratio hides scale. **No scalar is formed from the three.** $c_{\mathrm{call}}$ above is a price list applied to the
triple, and prices differ per model and per provider: $p_{\mathrm{hit}}, p_{\mathrm{miss}}, p_{\mathrm{out}}$ are
properties of a contract, not of the system under test, so a weighted total would rank cells by the rates assumed
rather than by what ran. A cell that wins on one component and loses on another is a normal outcome, not a tie to be
broken by weights — the table is read component by component. Round `20261001-1300` is the case in point: the arm
with the best hit rate (round `C4`, the full configuration, today's `C2`, 92.6%) carried the **largest** count on
all three components, and the arm slightly *below* the baseline's rate (round `C2`, TAS alone, today's `C1`, 86.2%)
carried the smallest. So a report prints $n_{\mathrm{miss}}, n_{\mathrm{hit}}, n_{\mathrm{out}}$ per cell with
their per-turn and per-step quotients, and treats $h$ as a **mechanism diagnostic** — it answers "did the prefix stay
stable across steps", which is worth knowing and is not a cost — and never reports it instead of the triple.

$C_{\mathrm{S1}}$ is a line of its own, with its call count, and it is compared in tokens, never in currency. The
claim that a cheap System-1 saves an expensive LLM has to carry the System-1 lane's own usage: last round the lane
spent 436 406 / 584 331 / 263 808 / 3 722 310 input tokens over 363 / 257 / 241 / 1 155 calls (round labels `C1` /
`C2` / `C3` / `C4`; i.e. today's `C0` / `C1` / dropped / `C2`). In the full configuration (round `C4`, today's `C2`)
that is 3 722 310 input tokens over 1 155 calls (807 of them answered), against the same cell's LLM usage of
$n_{\mathrm{hit}} = 1\,398\,272$, $n_{\mathrm{miss}} = 110\,990$, $n_{\mathrm{out}} = 76\,501$ — 1 585 763 tokens in
all — so the System-1 lane moved about **2.35×** the tokens of the model it is meant to make cheaper. The two lanes
are not interchangeable (one is a local GPU resource, the other a billed API), and the ratio is not a bill: pricing
either lane would put a price list back in the middle of a quantity comparison. An arm with no System-1 lane at all
— the two control arms of the current scheme, which pin `s1.provider: "none"` — has a $C_{\mathrm{S1}}$ of zero
*by construction*, and a report has to say that rather than print a bare 0 beside a refused lane's real spend.

Every System-1 column carries its coverage, $\mathrm{judgedPairs}/\mathrm{scoredPairs}$ from the association graph
(`packages/core/src/assoc-graph.ts`), with the failure split beside it (503 refused / transport timeout / other).
A cell counts as **S1-governed** only at coverage $\ge 0.5$; below that the majority of its graph was scored by the
local lexical fallback and the cell is not a measurement of System-1 however it is labelled. Round
`20261001-1300` measured 16.9 / 33.4 / 22.5 / 39.2% (round labels `C1` / `C2` / `C3` / `C4`) — no arm cleared the
floor. Where a cell has no lane, coverage is **undefined** rather than 0: `judgedPairs` is 0 because the backend was
never asked, which is a different claim from a backend that judged none of what it was shown.

Output length is part of the comparison or it is a confounder. $n_{\mathrm{out}}$ was 55–80% of what a price-weighted
total would have charged in every cell of that round — a statement about the quantities, since output dominates any
weighting — and the full configuration emitted 76 501 output tokens against TAS alone's 19 410. A stimulus that does
not constrain how long the answer may be has to report $n_{\mathrm{out}}$ as its own row instead of folding it into
a total that is then compared across cells.

#### The report generator

`scripts/cell-report.mjs` is committed and validates against round `20261001-1300` exactly. It reads a finished
run's own evidence — `evidence/<cell>/control.jsonl`, `home/<cell>/sessions/**/session.v4.jsonl.zstd`, and
`home/<cell>/.s1cap/rg/*.json` — and prints the metrics above **per cell, per turn and per step**: time (turns,
steps, LLM calls, System-1 calls, other tool calls; LLM time, System-1 time, other tool time, with the step and turn
frames printed beside them so the residual is visible instead of assumed), cost (cached-hit input tokens, uncached
input tokens, output tokens, plus the System-1 lane's own tokens) and completion (benchmark-only — the current
stimulus completes in every cell, and the report prints that as one constant column rather than a per-turn table of
the same value). The cache hit rate appears once, under mechanism diagnostics, never in the cost table:

```
node scripts/cell-report.mjs --run <dir> --cells C0,C1,C2 --out <dir> --format all
```

A run recorded under the old labels is reported with `--cells C1,C2,C4` plus `--label C1=baseline,C2=TAS,C4=full`
for the display labels that round used; the correspondence between those labels and today's cells is the mapping
note at the head of this section, which is exactly why it matters. Three facts the generator had to handle, each of
which belongs in the record so the next reader does not re-derive it:

- **System-1 calls do not align to steps.** Association-graph upkeep ticks off the step clock, so calls are
  attributed by timestamp into a step window, then a turn window, and the remainder is printed as its own rows. In
  the baseline arm of round `20261001-1300` (round `C1`, today's `C0`) only **179 of 363** calls fell inside a step
  window — 48 between steps of a turn, 108 between turns, 28 after the last `turn/end` — so a per-step-only table
  would have dropped the other **184**, just over half of that arm's calls, while its total still read 363.
- **System-1 time is concurrent, not additive.** In the full configuration (round `C4`, today's `C2`) turn 3 sums
  **10 633 810 ms** of lane time inside a turn of **1 306 265 ms**, so it must never be added to LLM time.
- **A lane-absent zero is not a refused zero.** The lane state is read from the plugin's own `kind:"wiring"` record
  on the cell's tape (`<DSH_HOME>/.s1cap/tape.jsonl`), whose `s1` field is literally `"none"` for the Off choice. A
  lane-absent cell prints `0 (no S1 lane)` with coverage *undefined*; a refused lane prints its
  `ok / refused / total` split with a measured coverage.

## 6. Cache break-even analysis (hypothesis H3)

For a given turn: the selection mechanism deletes $\Delta_s$ tokens (a proportion $h$ of which could have hit the cache), and TAS reordering turns $\Delta_i$ tokens from hits into misses. The cost change relative to the baseline is then:

$$
\Delta C = \underbrace{-\Delta_s\big(h\,p_{\mathrm{hit}} + (1-h)\,p_{\mathrm{miss}}\big)}_{\text{selection saving}}
\;+\; \underbrace{\Delta_i\big(p_{\mathrm{miss}} - p_{\mathrm{hit}}\big)}_{\text{reorder penalty}}
$$

**Break-even ratio**:

$$
\frac{\Delta_s}{\Delta_i} > \rho^{*} = \frac{p_{\mathrm{miss}} - p_{\mathrm{hit}}}{h\,p_{\mathrm{hit}} + (1-h)\,p_{\mathrm{miss}}}
$$

Substituting the `deepseek-flash` peak prices:

| Baseline hit rate $h$ | $\rho^{*}$ (tokens that must be saved per 1 hit token invalidated) |
|---|---|
| 0.50 | 1.92 |
| 0.75 | 3.70 |
| 0.90 | 8.31 |
| 1.00 | 49.0 |

**Interpretation**: the higher the hit rate, the steeper the reorder cost (as $h \to 1$, 49 tokens must be saved per 1 invalidated token to break even) — this is exactly why H3 must be measured per call and why `updatePolicy` must be adjustable, and it is also the axis of the paper's conditional conclusion.

### 6.1 Does a selected context still hit the cache?

A selected context is a **subset** of the full history with chronology preserved, so the prompt differs
from the previous one wherever a segment was dropped. Prefix caches match the longest common prefix of the
prompts *we actually send*, so three consequences follow:

1. Everything **after the earliest cut** loses its discount; everything before it still hits. Removing an
   early segment is therefore expensive in a way that removing a late one is not.
2. The hit rate does not depend on "subset or not" but on **selection stability**: if the assembled prefix
   repeats, the cache hits; if recall churns, it does not.
3. A smaller prompt is **miss insurance**: when a miss does happen, the miss bill is proportional to what we
   sent (100k all-miss = \$0.030 vs 40k all-miss = \$0.012 at `deepseek-flash` peak prices).

**Positional + amortized test.** Cutting $R$ tokens at a point with $A$ tokens after it, of which a fraction
$h$ were hits, and with $n$ calls left in the task, costs the suffix one re-prefill and saves on every
remaining call:

$$
\text{adopt} \iff n \cdot R \cdot \big(h\,p_{\mathrm{hit}} + (1-h)\,p_{\mathrm{miss}}\big) \;>\; A \cdot h \cdot \big(p_{\mathrm{miss}} - p_{\mathrm{hit}}\big)
\qquad\Longleftrightarrow\qquad
\frac{R}{h\,A} \;>\; \frac{\rho^{*}}{n}
$$

The left-hand ratio counts removed tokens per invalidated **hit** token, i.e. the same unit as $\rho^{*}$
(`packages/core/src/cache-policy.ts`, `decideReselect`). With $h = 0.75$ ($\rho^{*} = 3.70$):

| cut $R$ | tokens after cut $A$ | calls left $n$ | $R/(hA)$ | required $\rho^{*}/n$ | decision |
|---|---|---|---|---|---|
| 20k | 6k | 1 | 4.44 | 3.70 | re-select |
| 20k | 6k | 10 | 4.44 | 0.37 | re-select |
| 20k | 80k | 1 | 0.33 | 3.70 | keep selection |
| 20k | 80k | 10 | 0.33 | 0.37 | keep selection (marginal) |
| 5k | 30k | 10 | 0.22 | 0.37 | keep selection |

**Design rules derived from the model** (and implemented as `AssemblyPolicy.cache`):

- `reselectPolicy: perTask` — freeze the selection inside a task; only the small verbatim tail and $x$
  change per call, so the prefix keeps hitting. Re-selection then happens where the cache is cold anyway.
- Put the **large stable material first** (pinned prefix, state proxy $T$, selected blocks) and the **small
  volatile material last** (recent tail, $x$): a mid-prompt re-selection then invalidates only a few k tokens
  instead of the whole suffix.
- Keep $T$ byte-stable within a task (`updatePolicy: perTask`): a state proxy that re-renders per turn
  invalidates everything behind it.
- Prune **contiguous runs, latest-first among the candidates**, and `alignToCacheBlocks` the budget
  (DeepSeek 64 tokens, OpenAI 128, Anthropic counts in 1024-token checkpoints) so a changed boundary does not
  cost a partial block.
- Never let per-turn metadata (timestamps, turn ids, cache flags) into the prefix.
- Measure $h$ per call (already in `llm_call` telemetry) and apply the test above with the measured $h$:
  the `C1`-vs-`C2` comparison — TAS alone against the full configuration, which round `20261001-1300` recorded
  under the labels `C2` vs `C4` — isolates selection's cache effect, which is H3. It is also the only contrast the
  selection claim has left, now that the recall-only arm is dropped and H1 is folded into H3 (AGENT_BRIEF §9.3):
  the same comparison answers both, and the two cannot be separated afterwards.

## 7. Time model

$$
t_{\mathrm{net}} = t_{\mathrm{end}} - t_{\mathrm{req}} - t_{\mathrm{backoff}} - t_{\mathrm{approval}}, \qquad
T_{\mathrm{task}} = \sum_{\text{turns}}\big(t_{\mathrm{LLM}}^{\mathrm{net}} + t_{\mathrm{S1}} + t_{\mathrm{tool}}\big)
$$

$t_{\mathrm{approval}}$ = approval wait (the benchmark zeroes it out with an auto-approval sandbox; interactive sessions deduct it from tool_call events). S1 local path $t_{\mathrm{S1}} \approx 15.6\,\mathrm{ms}$ (EdgeJev INT8, 4 vCPU).

**Measured caveat (2026-10-01).** $t_{\mathrm{S1}}$ is serial with the request only where it gates an assembly or a
gate decision; the association-graph lane runs off the critical path and its calls run concurrently with the LLM
request. In round `20261001-1300` the full-configuration arm's turn 3 summed **10 633 810 ms** of System-1 lane time
inside a turn of **1 306 265 ms**, so lane time must never be added to $t_{\mathrm{LLM}}^{\mathrm{net}}$ in a
report; it is printed as its own column (see §5.1).

## 8. Statistical protocol (pre-registered)

The full configuration is now `C2` and the baseline `C0` (see the mapping note in §5.1: round `20261001-1300`
called them `C4` and `C1`). The protocol below is stated in today's names; the test and the margin are unchanged.

**Primary metric (completion rate, non-inferiority)** — paired McNemar exact test, `C2` vs `C0` discordant pairs $(b,c)$:

$$
p = \min\Big(1,\ 2\sum_{i=0}^{\min(b,c)} \binom{b+c}{i} 2^{-(b+c)}\Big) \le \alpha = 0.05
\quad\text{and}\quad
\hat\Delta_{\mathrm{solve}} = \mathrm{solve}_{C2} - \mathrm{solve}_{C0} \ge -\delta,\ \delta = 0.02
$$

**Secondary metrics (cost/time, superiority)** — paired bootstrap ($B=10^4$ task resamples):

$$
\bar\Delta = \overline{\mathrm{cost}}_{C2} - \overline{\mathrm{cost}}_{C0}, \qquad
\mathrm{CI}_{95}\text{ (percentile)},\quad \text{success} \iff \mathrm{CI}_{95}^{\mathrm{upper}} < -0.10\,\overline{\mathrm{cost}}_{C0}
$$

**Multiple-comparison correction** (secondary family $K=2$: cost, time) — Holm step-down:

$$
p_{(i)}^{\mathrm{adj}} = \max_{j \le i}\Big\{\min\big(1,\ (K-j+1)\,p_{(j)}\big)\Big\}
$$

**Success criterion (overall)**: completion rate non-inferior **and** cost or time improved by ≥10% (CI excluding 0). The analysis script is frozen and committed before the full run.

## 9. Complexity summary

| Stage | Complexity | Note |
|---|---|---|
| tier-1 recall (embed ANN) | $O(\log n)$ / new segment | HNSW-style index |
| tier-2 verification | 1 parallel query / turn | state ingested once |
| BFS recall | $O(k^d)$ upper bound | budget truncation |
| Assembly ordering | $O(\|R'\|\log\|R'\|)$ | per turn |
| Telemetry | $O(1)$ / event | JSONL append |

---

*Citations and fact verification in [RELATED_WORK.md](./RELATED_WORK.md); implementation spec in [AGENT_BRIEF.md](./AGENT_BRIEF.md). Changes to parameter default values must be synced with the AGENT_BRIEF §4 configuration table.*

## Recall window w (`recall.window`)

A newly arrived session-event segment `s` (a user input `x`, a model output, a tool result) is scored by the
System-1 association backend against only the **most recent w segments** of history, not against all of it. The
graph itself stays unbounded: segments that fall out of the window keep every edge they already have and remain
reachable by the bounded BFS (`recall.depth = d`, `recall.threshold = r`). **w decides whether a pair is scored;
it never decides what exists in the graph.**

Cost per new segment, with `t` segments already in the graph:

| strategy | pairs scored for segment `t+1` | total after `T` segments |
| --- | --- | --- |
| full history | `t` — grows without bound | `T(T-1)/2` = Theta(T^2) |
| windowed (this design) | `min(t, w)` — bounded by `w` | `T*w - w(w-1)/2` = Theta(T*w) |

At `T = 4096`, `w = 1024`: full history scores **8,386,560** pairs, the window scores **3,670,528**, and — the
part that matters for a long session — the window's *per-segment* cost never exceeds 1024 no matter how long the
conversation runs, while the full-history cost keeps climbing. This is the S1 call saving the window exists for;
it is not a recall parameter.

**What `w` touches, and what it does not.** `w` is the System-1 scoring window only, at `O(w)` per new segment and
`O(turns × w)` per session instead of the quadratic pair count (`packages/core/src/types.ts`: "S1 scoring window w
(`recall.window`)"; `packages/core/src/assoc-graph.ts`: "one pass of `w` comparisons per new segment", "the pair
count `recall.window` is meant to bound"). **Recall is never bounded by `w`.** The BFS is bounded by
`recall.depth = d` and `recall.threshold = r`, and segments outside the window are still traversed and recalled:
they keep every edge they already have (`packages/core/src/observer.ts`: "Segments outside the window keep their
edges and stay reachable"). What a smaller `w` costs is the **density of edges between new and old segments** —
fewer pairs are offered, so the graph the BFS walks becomes sparser and recall may reach fewer relevant segments
*through those edges*. That loss is real and nothing in round `20261001-1300` measured it (`w = 1024` never bound
there), so a run that lowers `w` must carry `fallback`, `unknownAdmitted` and `recallTree` beside it.
`scoredPairs` / `judgedPairs` measure how much was judged, not how much recall then used.

Measured offline in `packages/core/test/window.test.ts` (`w = 64`, 400 segments): `scoredPairs` stays within
`total * w` and strictly below full pairwise scoring, the first segment still holds its edges after leaving the
window, and **doubling w roughly doubles the cost** — the cost tracks `w`, not the session length.

**Measured in a live round (`20261001-1300`), and the caveat that comes with it: the window did not bind.** The
four arms of that round offered 6 670 / 4 278 / 3 321 / 22 791 pairs for 116 / 93 / 82 / 214 segments (their
labels: `C1` / `C2` / `C3` / `C4`, i.e. today's `C0` / `C1` / dropped / `C2` — see the mapping note in §5.1) —
`T(T-1)/2` to the pair, i.e. the *full-history* row of the table above, because `w = 1024` is larger than any
session the round produced. Each persisted graph (`<DSH_HOME>/.s1cap/rg/*.json`) held exactly that many **distinct**
pairs by `from->to`, so no pair was ever scored twice: `scoredPairs` counts offers, `scores` is keyed by pair, and
one repeated pair would show up as a difference of exactly one. The call count then follows from the pair count and
not from any redundancy — 22 791 pairs at `s1.questionsPerCall = 20` are the 1 155 calls the full-configuration arm
(round `C4`, today's `C2`) made. The lever on this cost is `w` (or the cap), never de-duplication: at `w = 64` the
same 214 segments would offer 11 616 pairs, half of them, in 732 full batches where the unbounded window needs
1 243.
