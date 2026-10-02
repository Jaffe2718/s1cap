# S1CAP Formal Definitions and Formula Handbook

**Version** 0.1 · 2026-09-28 · revised 2026-10-02 (definitions only; parameter values and the report generator's
row list removed to pointers) · Companion to [PROPOSAL.md](./PROPOSAL.md) · [ARCHITECTURE.md](./ARCHITECTURE.md) · [AGENT_BRIEF.md](./AGENT_BRIEF.md) · [technical roadmap](./figures/s1cap-technical-route.html)

This document uses Markdown + LaTeX to fix all mathematical definitions of S1CAP: segmentation and association graph, context assembly, Trace-as-State layout, plan gate, cost and cache break-even model, time model, statistical protocol. **It defines symbols; it does not own parameter values.** Every knob named below takes its default from `defaultPolicy()` and the cell presets (`packages/core/src/types.ts`, `bench/cells/*.json`), and a run's values are its own `kind:"wiring"` record — so where a value is quoted here it is quoted as an *input to a computation*, dated, and never as the place the value is maintained.

---

## 0. Notation

**Symbols and meanings only.** This table used to carry a "Default value" column — $\tau/d/k$, $\lambda$, $K$,
$\rho$, $\mu$, $\mu_{\mathrm{seg}}$, $m/M$, $c_{\min}$ and the state proxy's size bound. That column was a second
copy of code-owned defaults and is removed rather than synchronised: the defaults are `defaultPolicy()`'s and the
presets', each knob keeps its name here so a symbol can be looked up, and a reader who needs a value reads it
there or in the run's wiring record.

| Symbol | Meaning |
|---|---|
| $\mathcal{L} = (e_1,\dots,e_T)$ | Session event log (append-only, human-recorded, never rewritten) |
| $S=\{s_1,\dots,s_n\}$ | Segment set; $s_i=(\mathrm{id},\mathrm{kind},\mathrm{tok}_i,t_i,\mathrm{text}_i)$, $\mathrm{kind}\in\{$user, assistant, trace, toolCall, toolResult$\}$ |
| $x$ | Current user input (condition/instruction) |
| $P$ | Fixed prefix (system prompt + tool schema), never reordered |
| $T_{\mathrm{state}}$ | Task-state proxy (serialized reasoning trace + task brief) (bound: `tas.tMaxChars`) |
| $G_t=(V_t,E_t)$ | Association graph at time $t$ (association graph) |
| $\tau,\ d,\ k$ | Association threshold / BFS depth / per-node expansion limit (`recall.threshold`, `recall.depth`, `recall.fanout`) |
| $\lambda$ | Time decay constant (active session time) |
| $K$ | Number of recent-tail verbatim turns kept (`tail.k`) |
| $B$ | Context token budget (defined in §3.1) |
| $\rho$ | Recall-block share of the budget (`recall.budgetRatio`) |
| $\mu$ | Minimum recall-block fill rate (token share; fallback below this) — `recall.minRecalledShare`, **off by default** ⁽¹⁾ |
| $\mu_{\mathrm{seg}}$ | Minimum recall-block **segment count** (fallback below this) — `recall.minRecalledSegments`, the guard that actually runs |
| $m,\ M$ | Number of candidate plans / attempt limit (§4; `PlanGateOptions`, no policy field) |
| $c_{\min}$ | Plan gate abstention confidence (§4; `PlanGateOptions`, no policy field) |

⁽¹⁾ **The in-force fallback rule is the count floor, not the token share.** This document, `ARCHITECTURE.md:57` and
`AGENT_BRIEF.md` §3.5 all stated $\mu = 0.25$ as the rule that fires the recency fallback; the code's default is
`recall.minRecalledShare: 0` (`packages/core/src/types.ts`, `defaultPolicy()`), i.e. **off**, because at 0.25 it
fired on 9 of 9 steps of a live run and discarded every System-1 selection before delivery could see it
(`packages/core/src/assembler.ts`, beside the guard). What does run is `recall.minRecalledSegments: 1`
(`packages/core/src/config.ts`), a floor of one segment under a recall selection: fewer than one selected segment
is not a selection, so the block falls back to the recency window. Both fields are now recorded on the
`kind:"wiring"` tape record (`governance.recall`) so a run cannot be read through the wrong one. A reader modelling
*when* the fallback fires must use $\mu_{\mathrm{seg}}$, not $\mu$. **The values themselves are `defaultPolicy()`'s
and are not restated here**; what this note owns is the rule — which field is in force, and why the token-share one
is not.

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

**Tier-1 (candidate generation)**: the design has two modes and the implementation has one, so `recall.tier1` is
`s1` or `off` and nothing else (2026-10-02):

$$
\text{embed mode (NOT IMPLEMENTED):}\quad C_1(p) = \operatorname*{top\text{-}k}_{h \in S}\ \cos\big(\phi(p),\phi(h)\big),\quad k=32
$$

$$
\text{S1 mode (the one that runs):}\quad w_1(p,h) = P_{\mathrm{S1}}\big(\mathrm{rel}(p,h)\big),\quad \text{single } \texttt{/v1/systemone} \text{ parallel noul batch}
$$

**The embed mode has no implementation anywhere under `packages/`**: no embedder, no ANN index, `source: 'embed'` is
never assigned to an edge, and `recall.embedModel` has no reader (a non-empty value is reported by
`validatePolicy` as a warning). Every cell that selects at all selects through the `noul` batch: the recorded graph
of round `20261002-2037` holds **`s1-noul` 1 824** and **`lexical` 253 976** edges and **0** embed edges. The
failure this closes is not a naming preference: C2's recipe said `embed` while the only read of the field in the
whole implementation was `policy.recall.tier1 !== 'off'`, so the cell was described by a mechanism it did not use
and the field composed, printed and was never resolved. It says `s1` now, and a literal `embed` is **rejected**
(`packages/core/src/config.ts`, `LEGACY_TIER1`) rather than treated as on. The embedding route stays in the design
as the tier-1 axis that is **not measured**; implementing it is what would measure it.

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

**Per-turn complexity**: tier-2 is one parallel query call (state ingested once, $|C_1|$ questions evaluated in
parallel) — tens of ms locally, about $0.0006/turn$ in the cloud. The tier-1 ANN row $O(\log n)$ belongs to the
embed mode above and is therefore **paid by no turn today**; what runs is the same single batched call.

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

The **token-share** rule, which is off by default ($\mu = 0$, table note 1):

$$
\sum_{h \in R'} \mathrm{tok}(h) < \mu \rho B \implies \text{degrade to recency window (chronological last-}N\text{), log a degradation event}
$$

The **count** rule, which is the one in force ($\mu_{\mathrm{seg}} = 1$):

$$
|R'| < \mu_{\mathrm{seg}} \implies \text{degrade to recency window (chronological last-}N\text{), log a degradation event}
$$

Both are `AssemblyPolicy.recall.minRecalledShare` / `.minRecalledSegments`; both are recorded on the wiring
record; either degradation is written to the assembly record as `fallback` (see §5.1, "what a report has to
carry").

## 4. Plan gate (S1 decision backend + PLAN GATE, factor S1G on)

> **Design, not wiring, as of 2026-10-02.** Every formula in this section is the specification of the gate, and the
> gate is not run by any cell: round `20261002-2037` produced zero `plan_gate` records with C2 carrying the knob
> `on`, because neither of the gate's two triggers (a numbered plan in an assistant message, a `todo/write` session
> event) occurred. The knob has been removed from the policy, the presets, the config schema and the report; the
> mechanism below is kept, implemented and unit-tested, so an arm with a plan source the model actually writes to can
> run it. See `packages/core/src/types.ts`.

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

**The prices are inputs, owned elsewhere.** $p_{\mathrm{hit}}, p_{\mathrm{miss}}, p_{\mathrm{out}}$ and
$p_{\mathrm{s1}}$ are properties of a provider contract, not of this system: the price-anchor row of
[AGENT_BRIEF.md](./AGENT_BRIEF.md) §"Facts the protocol depends on" (its sources table and the fetch date are in
that document's §"Sources") owns the reference table, and a run's own price list belongs in the run's
record. This document owns only the formula above, which applies whatever those prices are. The two tables in §6
below are the one place prices appear here, and they appear as **derived** figures — computed from that row's
anchors on 2026-09-28 and labelled as such — not as a second copy of the list.

### 5.1 What a report has to carry

> **Cell labels in this section.** The measured figures quoted here come from round `20261001-1300`, which ran
> **four** cells under labels that no longer exist: round `C1` (baseline) is today's **`C0`**; round `C2` (read as
> TAS alone then; a second control arm today — §6.1) is today's **`C1`**; round `C3` (recall selection with
> `tas.on: false`) is **dropped, no successor**; round `C4` (the full configuration) is today's **`C2`**. Every
> figure below stays attributed to that round and to the label it ran under, and none is silently re-labelled. The
> table itself, and the per-step reason the fourth arm was dropped, are kept once as frozen history of that round
> in `.s1cap-ablation/round-20261001-1300/ROUND-REPORT.md`, whose cells are named `C1`–`C4`; `docs/CELLS-RUN.md`
> states the reading rule (a figure from that round is never a contrast, and its labels are never re-labelled into
> today's scheme) without reproducing the table.

The primary measurements are the three raw token counts inside $c_{\mathrm{call}}$ — the triple
$(n_{\mathrm{miss}}, n_{\mathrm{hit}}, n_{\mathrm{out}})$: uncached input tokens, cached input tokens, output
tokens — reported **separately and per unit of work**, per turn and per step, because a hit rate is a ratio and a
ratio hides scale. (Which usage field each count is read from is `docs/CELLS-RUN.md`'s table in "The measurement,
and what must be in the round's record".) **No scalar is formed from the three.** $c_{\mathrm{call}}$ above is a price list applied to the
triple, and prices differ per model and per provider: $p_{\mathrm{hit}}, p_{\mathrm{miss}}, p_{\mathrm{out}}$ are
properties of a contract, not of the system under test, so a weighted total would rank cells by the rates assumed
rather than by what ran. A cell that wins on one component and loses on another is a normal outcome, not a tie to be
broken by weights — the table is read component by component. Round `20261001-1300` is the case in point: the arm
with the best hit rate (round `C4`, the full configuration, today's `C2`, 92.6%) carried the **largest** count on
all three components, and the arm slightly *below* the baseline's rate (round `C2`, then read as TAS alone, today's `C1`, 86.2%)
carried the smallest. So a report prints $n_{\mathrm{miss}}, n_{\mathrm{hit}}, n_{\mathrm{out}}$ per cell with
their per-turn and per-step quotients, and treats $h$ as a **mechanism diagnostic** — it answers "did the prefix stay
stable across steps", which is worth knowing and is not a cost — and never reports it instead of the triple. $h$ is
the §6 break-even input below: it is defined once, with the usage fields it is read from, in `docs/CELLS-RUN.md`.

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

> **The lane's two token halves are reported separately (2026-10-02).** $C_{\mathrm{S1}}$ above prices the lane on
> $n_{\mathrm{in}}^{\mathrm{S1}}$ **only** ("Jev output is free"). `scripts/cell-report.mjs` used to print one column,
> $\sum (n_{\mathrm{in}}^{\mathrm{S1}} + n_{\mathrm{out}}^{\mathrm{S1}})$ — a mixture of the quantity this formula
> prices with one it prices at zero. It is now two rows, `System-1 lane input tokens (the priced quantity)` and
> `System-1 lane output tokens (free under the cost model)`, cell-level, per turn and per step. In round
> `20261002-2037` the output half is 0 on every one of the 5 992 records, which is exactly why the mixture was
> invisible; a cost statement uses the input row.

Every System-1 column carries its coverage, $\mathrm{judgedPairs}/\mathrm{scoredPairs}$ from the association graph
(`packages/core/src/assoc-graph.ts`), with the failure split beside it (503 refused / transport timeout / other).
A cell counts as **S1-governed** only at coverage $\ge 0.5$ **over the window the run was offered**:

$$
\mathrm{coverage}^{\mathrm{offered}} \;=\; \frac{\mathrm{judgedPairs}}{\mathrm{scoredPairs} + \mathrm{deferredPairs}} \;\ge\; 0.5
$$

Below that the majority of its graph was scored by the local lexical fallback and the cell is not a measurement of
System-1 however it is labelled. Round `20261001-1300` measured 16.9 / 33.4 / 22.5 / 39.2% (round labels `C1` /
`C2` / `C3` / `C4`) under the ratio this floor used to be stated over — no arm cleared it. Where a cell has no lane,
coverage is **undefined** rather than 0: `judgedPairs` is 0 because the backend was never asked, which is a
different claim from a backend that judged none of what it was shown.

> **Why the floor moved to the second denominator (2026-10-02).** The admission gate defers a window it will not
> send, and `AssociationGraph.scoreNew` gives those pairs back to the cursor
> (`packages/core/src/assoc-graph.ts`): a deferred pair never reaches `scoredPairs`. So
> $\mathrm{judgedPairs}/\mathrm{scoredPairs}$ **rises when the run declines work** — with `admissionLimit: 8` and a
> breaker that can hold for `cooldownMs`, a saturated cell can reach 0.5 by not asking. A validity floor a run can
> satisfy by declining work is not a floor. The floor is therefore stated over the pairs the arrival order offered,
> `scoredPairs + deferredPairs`, and `judgedPairs/scoredPairs` is kept as the secondary reading it always was: the
> share of what the backend was *shown* that it answered. `scripts/cell-report.mjs` prints both ratios, the deferral
> share, and the deferred count beside every coverage figure, in the markdown and in the machine-readable CSV
> (`System-1 coverage (judged/(scored+deferred))`, `deferred share of offered`).

Output length is part of the comparison or it is a confounder. $n_{\mathrm{out}}$ was 55–80% of what a price-weighted
total would have charged in every cell of that round — a statement about the quantities, since output dominates any
weighting — and the full configuration emitted 76 501 output tokens against 19 410 in the arm that round read as
TAS alone (round label `C2`, today's `C1`). A stimulus that does
not constrain how long the answer may be has to report $n_{\mathrm{out}}$ as its own row instead of folding it into
a total that is then compared across cells.

#### The report generator

`scripts/cell-report.mjs` is committed and validates against round `20261001-1300` exactly. It reads a finished
run's own evidence — `evidence/<cell>/control.jsonl`, `home/<cell>/sessions/**/session.v4.jsonl.zstd`, and
`home/<cell>/.s1cap/rg/*.json` — and prints the metrics defined above **per cell, per turn and per step**. Which
rows it prints, how it is invoked and how it reconciles them are the script's own (`METRICS`, its usage block and
its `--self-test`); what this document owns is the definition those rows implement. The row labels a reader of this
section will see in its output: `cached-hit input tokens`, `uncached input tokens`, `output tokens`, and the
System-1 lane's two rows — `System-1 lane input tokens (the priced quantity)` and `System-1 lane output tokens
(free under the cost model)`.

Three reading rules the numbers cannot state for themselves, each of which a round's record keeps so the next
reader does not re-derive it:

- **System-1 calls do not align to steps.** Upkeep ticks off the step clock, so calls are attributed by timestamp
  into a step window and then a turn window, and the remainder is printed as its own rows (between steps, between
  turns, after the last turn). The rows must add up to the cell total: in round `20261001-1300`'s baseline arm only
  **179 of 363** calls fell inside a step window, and a per-step-only table would have dropped the other **184**.
- **System-1 time is concurrent, not additive.** It must never be added to LLM time; lane time can exceed the
  wall-clock width of the turn it sits in.
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

**Derived table — not a price list.** Substituting the `deepseek-flash` **peak** prices of
[AGENT_BRIEF.md](./AGENT_BRIEF.md) §"Facts the protocol depends on" — the price-anchor row, whose sources are in
§"Sources" — ($p_{\mathrm{hit}} = 0.006$, $p_{\mathrm{miss}} = 0.30$ per 1M tokens as
fetched 2026-09-27/28) into the $\rho^{*}$ formula above, computed **2026-09-28**:

| Baseline hit rate $h$ | $\rho^{*}$ (tokens that must be saved per 1 hit token invalidated) |
|---|---|
| 0.50 | 1.92 |
| 0.75 | 3.70 |
| 0.90 | 8.31 |
| 1.00 | 49.0 |

The inputs are that price-anchor row's and the arithmetic is this table's; a price change re-derives it rather than
editing it, and the row worth quoting is whichever $\rho^{*}$ matches the $h$ a run measured.

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
   sent — twice the prompt, twice the all-miss bill at any price list, which is the whole content of the rule
   (the currency figures are the brief's price-anchor row applied to $n_{\mathrm{miss}}$, and are not restated here).

**Positional + amortized test.** Cutting $R$ tokens at a point with $A$ tokens after it, of which a fraction
$h$ were hits, and with $n$ calls left in the task, costs the suffix one re-prefill and saves on every
remaining call:

$$
\text{adopt} \iff n \cdot R \cdot \big(h\,p_{\mathrm{hit}} + (1-h)\,p_{\mathrm{miss}}\big) \;>\; A \cdot h \cdot \big(p_{\mathrm{miss}} - p_{\mathrm{hit}}\big)
\qquad\Longleftrightarrow\qquad
\frac{R}{h\,A} \;>\; \frac{\rho^{*}}{n}
$$

The left-hand ratio counts removed tokens per invalidated **hit** token, i.e. the same unit as $\rho^{*}$
(`packages/core/src/cache-policy.ts`, `decideReselect`). **Derived table:** at $h = 0.75$, whose $\rho^{*} = 3.70$
is the row above, also computed 2026-09-28 from the brief's price-anchor row — the case rows are inputs chosen to
show the test's direction, and the test itself is the inequality, not the table:

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
  the `C0`-vs-`C2` comparison — baseline against the full configuration, the same pair §8's registered test is
  stated over, and the pair round `20261001-1300` recorded under the labels `C1` vs `C4` (per that round's own
  record; the label mapping is the note at the head of §5.1) — is the **design contrast** and isolates selection's
  cache effect, which is H3. It is also the only
  contrast the selection claim has left, now that the recall-only arm is dropped and H1 is folded into H3
  (the success rule and the H1-into-H3 fold are `AGENT_BRIEF.md` §"Metrics, hypotheses, success rule"): the same
  comparison answers both, and the two cannot be separated afterwards.
  **`C1` is not that contrast and cannot be**: since 2026-10-02 it is a second control arm that delivers nothing —
  its `deliver` was `true` and structurally could never fire, because delivery inserts the `recalled` block and
  nothing else while `tier1: 'off'` makes that block empty by construction (the two rounds that measured it, and
  the model-level statement of it, are in `docs/CELLS-RUN.md` "The arms, and what the contrast is") — so its
  model-visible input is the baseline's and a `C1`-vs-`C2`
  difference would not be an arm's effect. And what `C0`-vs-`C2` measures **today** is the recall lane: TAS's
  ordering reaches the model only through the model-view write-back, which does not exist yet
  (`docs/ARCHITECTURE.md`, `packages/proxy`) and is a separate project.

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

The full configuration is now `C2` and the baseline `C0` (round `20261001-1300` called them `C4` and `C1`; the
label mapping is the note at the head of §5.1). The protocol below — the **registered rule** — is stated in today's
names; the test and
the margin are unchanged. It needs no re-registration from the 2026-10-02 relabelling of `C1`: this protocol was
already stated over `C2` vs `C0`, and `C1` — a control arm that delivers nothing — is not part of the test (§6.1
says why it cannot be, and what the `C2`-vs-`C0` pair therefore measures while the ordering stays unrouted).

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

**Success criterion (overall)**: completion rate non-inferior **and** cost or time improved by ≥10% (CI excluding 0).

#### 8.1 The tool, and the three facts of the protocol a reader of §8 needs

`scripts/paired-stats.mjs` is the implementation of the four rules above: dependency-free, frozen before the full
run, and checked against hand-computed cases by its own `--self-test`. **What it does, what its input must look
like, and every status it can refuse are documented in its own header** — the document that moves when the code
moves. Three facts belong to the protocol rather than to the tool:

- **The pairing unit is the task.** Two arms are compared only over the task keys both ran, and a ragged input is
  **refused**, never silently contracted, because a paired statistic over different task sets is not a paired
  statistic. A repeat is a second draw and needs its own key, not an average folded onto the first.
- **$B$, the seed and the family are parameters that appear in every output**, so a rerun reproduces the numbers
  and Holm corrects exactly the family the run names — membership is never inferred from which metrics happen to be
  present. §5.1 forbids collapsing $(n_{\mathrm{miss}}, n_{\mathrm{hit}}, n_{\mathrm{out}})$ into a scalar, so the
  token triple enters as its own continuous metrics; `cost` is only a name for a total a run chooses to form, with
  the price list that formed it recorded beside it.
- **The resolvable difference runs on the discordant pairs, not on the number of tasks.** The sign test sees
  $b+c$ discordant pairs, so the smallest difference it can resolve is
  $(z_{1-\alpha/2}+z_{1-\beta})/\sqrt{b+c}$: a power figure quoted for $n$ tasks alone cannot be checked against
  it, and the `[VERIFY] Power` bullet of `AGENT_BRIEF.md` §"Metrics, hypotheses, success rule" (14–15 pp at
  $n = 100$) sits at $b+c \approx 373$ — more discordant pairs than that
  arm has tasks. The tool prints the discordant count it observed beside the interval so the gap is visible.
  **The registered plan's power note and its per-arm n are not reconciled here**, and that bullet's figure stays
  unresolved until `bench/stats` records the discordance it assumed.

One caveat that is a property of the protocol rather than of the tool: **non-inferiority at a nonzero margin**
$\delta$ is tested by the asymptotic shifted statistic $z = (\hat\Delta + \delta)\sqrt{b+c}$; the *exact* route is
an inversion of the binomial test on $b/(b+c)$, which is not registered here and is therefore not computed, so
`--method exact` with a nonzero margin refuses rather than substituting a different test. The bootstrap's p-value
is the achieved level read off the resample distribution, not a registered statistic — it exists so Holm has a
number to order, and an achieved `0.000000` at $B = 10^4$ means *no resample crossed zero*, a lower bound of
$1/B$ rather than a p-value of zero.

#### 8.2 What a round still has to supply

The tool reads a per-task, per-arm result set (the shape is in its header). `scripts/cell-report.mjs` emits
per-cell, per-turn and per-step *descriptive* rows — it has no per-task identity in its CSV — so a round that
wants this analysis has to record the per-task triple `(solved, cost, time)` per cell as well, keyed by task.
Until it does, §8's criterion is computable from a file a human assembles and not from the round's own
artifacts; that gap is in the run set's court, not this tool's.

## 9. Complexity summary

| Stage | Complexity | Note |
|---|---|---|
| tier-1 candidate generation (`s1`, the implemented mode) | 1 batched `noul` call / window | the mode every selecting cell runs (§2) |
| tier-1 recall (**embed ANN — not implemented**) | $O(\log n)$ / new segment | HNSW-style index; no turn pays this today |
| tier-2 verification | 1 parallel query / turn | state ingested once |
| BFS recall | $O(k^d)$ upper bound | budget truncation |
| Assembly ordering | $O(\|R'\|\log\|R'\|)$ | per turn |
| Telemetry | $O(1)$ / event | JSONL append |

---

*Citations and fact verification in [RELATED_WORK.md](./RELATED_WORK.md); implementation spec in [AGENT_BRIEF.md](./AGENT_BRIEF.md). **This document owns formulas and definitions, not parameter values:** every knob named here takes its default from `defaultPolicy()` and the cell presets (`packages/core/src/types.ts`, `bench/cells/*.json`), and a run's values from its own `kind:"wiring"` record. A value quoted in prose below is an input to a computation, dated and attributed — never a copy to be kept in sync, and never corrected here when the code and the prose disagree: the code wins and the prose is pointed at it.*

## Recall window w (`recall.window`)

A newly arrived session-event segment `s` (a user input `x`, a model output, a tool result) is scored by the
System-1 association backend against only the **most recent w segments** of history, not against all of it. The
graph itself stays unbounded: segments that fall out of the window keep every edge they already have and remain
reachable by the bounded BFS (`recall.depth = d`, `recall.threshold = r`). **w decides whether a pair is scored;
it never decides what exists in the graph.**

Cost per new segment, with `t` segments already in the graph — **the table is the formula, stated as a table**:

| strategy | pairs scored for segment `t+1` | total after `T` segments |
| --- | --- | --- |
| full history | `t` — grows without bound | `T(T-1)/2` = Theta(T^2) |
| windowed (this design) | `min(t, w)` — bounded by `w` | `T*w - w(w-1)/2` = Theta(T*w) |

**Derived figures:** at `T = 4096` and `w = 1024` — the code's own default for `recall.window`
(`defaultPolicy()`), whose lower bound is a `NUMBER_RULES` entry in `packages/core/src/config.ts` — full history
scores **8,386,560** pairs and the window scores **3,670,528** (rows of the table above, 2026-09-28), and — the
part that matters for a long session — the window's *per-segment* cost never exceeds `w` no matter how long the
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

> **Where those three are carried, and how a report reads them (2026-10-02).** `recallTree` is written on every
> assembly record and `fallback` / `unknownAdmitted` when they are defined (`packages/core/src/observer.ts`), and
> until this date `scripts/cell-report.mjs` read none of them, so a run that lowered `w` could not honour this
> requirement from its own report. The mechanism-diagnostics table now carries all three — `recall block source`,
> `unjudged pairs admitted ('unknownAdmitted')`, `recall structure recorded (steps / nodes placed)` — in the
> markdown and in the CSV, and all three are **three-valued**: a cell whose build did not write the field prints
> `— (not recorded by this snapshot)`, a different statement from "the event did not happen".
>
> Why it matters for `w`: the recency fallback **replaces the System-1 selection with the last-N window**, so
> without it in the report `selected` / `candidates` cannot be read as evidence about the *selector* — "recall
> selected nothing" and "recall was overridden" are different facts about the same count. (Row labels and the
> round `20261002-2037` readings: `scripts/cell-report.mjs` and that round's record.)

Measured offline in `packages/core/test/window.test.ts` (`w = 64`, 400 segments): `scoredPairs` stays within
`total * w` and strictly below full pairwise scoring, the first segment still holds its edges after leaving the
window, and **doubling w roughly doubles the cost** — the cost tracks `w`, not the session length.

**Measured in a live round (`20261001-1300`), and the caveat that comes with it: the window did not bind** — the
four arms offered exactly `T(T-1)/2` pairs (6 670 / 4 278 / 3 321 / 22 791 for 116 / 93 / 82 / 214 segments,
labels `C1` / `C2` / `C3` / `C4` — see the label note at the head of §5.1), the *full-history* row of the table
above,
because `w = 1024` was larger than any session that round produced. Two things follow, and they are the reason the
measurement is recorded beside the formula: a repeated pair would show as a difference of exactly one between
`scoredPairs` and the distinct pairs keyed by `from->to`, and the difference was **zero** in all four arms — so
`scoredPairs` counts offers and there is no duplicate work to remove, the lever on this cost is `w` (or the
`s1.questionsPerCall` cap) and never de-duplication; and the call count follows from the pair count
alone (22 791 pairs at a cap of 20 are the 1 155 calls the full-configuration arm made, where `w = 64` would offer
11 616, half of them).
