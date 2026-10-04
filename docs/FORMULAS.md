# S1CAP Formal Definitions and Formula Handbook

**Version** 0.1 · 2026-09-28 · revised 2026-10-02 (definitions only; parameter values and the report generator's
row list removed to pointers) · Companion to [PROPOSAL.md](./PROPOSAL.md) · [ARCHITECTURE.md](./ARCHITECTURE.md) · [AGENT_BRIEF.md](./AGENT_BRIEF.md) · [technical roadmap](./figures/s1cap-technical-route.html)

This document uses Markdown + LaTeX to fix all mathematical definitions of S1CAP: segmentation and association graph, context assembly, Trace-as-State layout, plan gate, cost and cache break-even model, time model, statistical protocol. **It defines symbols; it does not own parameter values.** Every knob named below takes its default from `defaultPolicy()` and the cell presets (`packages/core/src/types.ts`, `bench/cells/*.json`), and a run's values are its own `kind:"wiring"` record — so where a value is quoted here it is quoted as an *input to a computation*, dated, and never as the place the value is maintained.

---

## 0. Notation

**Symbols and meanings only.** This table used to carry a "Default value" column — $\tau/d/k$, $\lambda$, $K$,
$\rho$ (since retired, see the 2026-10-05 correction at the end), $\mu$, $\mu_{\mathrm{seg}}$, $m/M$, $c_{\min}$ and
the state proxy's size bound. That column was a second
copy of code-owned defaults and is removed rather than synchronised: the defaults are `defaultPolicy()`'s and the
presets', each knob keeps its name here so a symbol can be looked up, and a reader who needs a value reads it
there or in the run's wiring record.

| Symbol | Meaning |
|---|---|
| $\mathcal{L} = (e_1,\dots,e_T)$ | Session event log (append-only, human-recorded, never rewritten) |
| $S=\{s_1,\dots,s_n\}$ | Segment set; $s_i=(\mathrm{id},\mathrm{kind},\mathrm{tok}_i,t_i,\mathrm{text}_i)$, $\mathrm{kind}\in\{$user, assistant, trace, toolCall, toolResult$\}$ |
| $x$ | The step's newest **input event** — the recall anchor, and the last block in the default layout; the user's own input on a turn-opening step (`packages/core/src/observer.ts`, `isInputEvent`) |
| $P$ | Fixed prefix (system prompt + tool schema), never reordered |
| $T_{\mathrm{state}}$ | Task-state proxy (serialized reasoning trace + task brief) (bound: `tas.tMaxChars`) |
| $G_t=(V_t,E_t)$ | Association graph at time $t$ (association graph) |
| $\tau,\ d$ | Association threshold / BFS depth (`recall.threshold`, `recall.depth`) — the brief's two recall parameters. A per-node expansion cap $k$ (spelled in a profile as recall.fanout, unbackticked here because the path is gone; `scripts/check-doc-pointers.mjs` reads a backticked one as a live field) sat in this row until 2026-10-05; it is retired, see the correction on $R_d(x)$ at the end of this document |
| $\lambda$ | Time decay constant (active session time) |
| $K$ | Number of recent-tail verbatim turns kept (`tail.k`) |
| $B$ | Context token budget (defined in §3.1) |
| ~~$\rho$~~ | *Retired 2026-10-05:* the recall-block share of the budget. There is no token cap on the selection any more — see the correction at the end of this document |
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
*when* the fallback fires must use $\mu_{\mathrm{seg}}$, not $\mu$. **The token-share rule's denominator was rebased
when the recall token cap was retired**: it is the room the window has left after the fixed blocks,
$\mathrm{remaining} = B - f_{\mathrm{fixed}}$, and no longer a share-of-budget allowance — see §3.5 and the second
2026-10-05 correction at the end. **The values themselves are `defaultPolicy()`'s
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

$B$ is an **accounting budget, not a limit on the recall selection**: nothing is dropped for exceeding a share of it (that share, $\rho$, is retired — see the 2026-10-05 correction at the end). What it is still used for is the room the window has left after the fixed blocks, $\mathrm{remaining} = B - f_{\mathrm{fixed}}$, which is the quantity the token-share fallback of §3.5 takes its share *of*, and `budget.total` on the assembly record.

### 3.2 Bounded BFS recall

$$
R_d(x) = \big\{ h \in S : \exists\, x \to \cdots \to h,\ \text{path length} \le d,\ \text{each step into a segment earlier in append order},\ \text{per edge } w_{\mathrm{eff}} > \tau,\ \text{no per-node expansion cap} \big\}
$$

Worst case $O(n^d)$ over $n = |S|$ — see the bound note below.

**Every step goes into a segment earlier in the session's append order** — the walk expands backwards only, from a segment to one that arrived before it, and a neighbour the append order does not place is not expanded into at all. The direction is not a knob: `recall(seeds, {threshold, depth})` is the signature it has now, and `neighbors()` is still the symmetric "does this pair have a score" reading that `upsertEdge`'s indexing in both directions supports — the stored relation is undirected, the *walk* is not. **A per-node expansion cap $k$ used to sit in this formula as a fifth clause** ("per node expansion ≤ k", the field recall.fanout — left unbackticked throughout this document because the path is gone and a backticked one reads as a live field), and the clause is removed rather than kept: the field is retired, so a reader who takes the formula as the current rule would be reading a bound the walk does not have. What the clause meant, why the argument for it was wrong, and what the removal costs are the 2026-10-05 correction at the end of this document.

**The bound, stated correctly now that $k$ is gone.** With no per-node cap, a node expands into **every** neighbour that clears $\tau$ and lies earlier in the append order, and the size of that set for node $v$ is its **backward degree** $\deg^-(v)$ — the number of $v$'s edges whose other endpoint is older. So the worst case is $O(n^d)$: at most every segment expands into every other segment at each of at most $d$ levels, and the walk places at most $n$ nodes because `visited` admits each once. That bound is loose and the honest reading of what bounds the walk in practice is three things, in this order: **$\tau$** (each expansion is an edge with $w_{\mathrm{eff}} > \tau$, so a higher threshold offers fewer candidates), **the append order** (an expansion set is a subset of the older neighbours, never the whole neighbourhood), and **$d$** (the number of levels, which on a session that grows monotonically also shrinks the older side as the walk descends). The earlier statement of this bound was *"worst case $O(k^d)$"*, which is what a per-node cap makes the frontier — with the cap retired that expression names a bound the code no longer has, so it is replaced rather than left standing. What the replacement does **not** claim is that the walk is as cheap as it was: see the measured cost in the correction at the end.

The seed $x$ — **the recall anchor** — is the step's newest **input event**: a `user`, `assistant`, `trace`, `toolCall` or `toolResult` segment, with `systemPinned` the one kind excluded (`packages/core/src/observer.ts`, `isInputEvent`). It is **not** the newest `user` segment: the two coincide on a turn-opening step, and on every later step of an agent loop the anchor is the model's own newest event. **`T`'s boundary is a different segment on purpose**: `buildStateProxy` serializes what follows the newest `user` segment — the question the task was opened with — because a boundary that moved with the anchor would come out empty on every step after the first. Which segment each rule reads, and why they differ, is the 2026-10-05 correction at the end of this document.

### 3.3 Selection (greedy, and no token cap)

$$
R' = \operatorname{dedup}\Big( \operatorname{sort}_{w_{\mathrm{eff}} \downarrow}\big( R_d(x) \setminus \{\,P,\ \mathrm{tail}_K,\ x,\ \mathrm{siblings}(x)\,\} \big) \Big)
$$

Greedily ordered by descending $w_{\mathrm{eff}}$, and **no candidate is dropped for its size**: $\tau$ and $d$ decide what is recalled. Everything the selector does drop is a *correctness filter* rather than a budget — the structural exclusions ($P$, $\mathrm{tail}_K$, $x$: content the model already has, or not history at all), the recall anchor's sibling chunks (the step's own newest input event quoted back as an earlier turn) and the passage chunk de-duplication (two halves of one passage, the same text paid for twice). Those change *what* the model reads and never *how much*; a token ceiling is the other kind of rule, because it drops a candidate that cleared $\tau$ and lay inside $d$ for its size. The behaviour is `packages/core/src/assembler.ts`; the decision and its measurement are in `AssemblyPolicy.recall` (`packages/core/src/types.ts`).

### 3.4 Trace-as-State layout (factor TAS on)

$$
\mathrm{prompt} = \big[\,P \,\|\, T_{\mathrm{state}} \,\|\, \mathrm{tail}_K \,\|\, \operatorname{sort}_{w_{\mathrm{eff}} \downarrow}(R') \,\|\, x\,\big]
$$

Key points (from [arXiv:2609.02702](https://arxiv.org/abs/2609.02702)):

- **State first**: $T_{\mathrm{state}}$ (the task state distilled from the trace) is placed before the history, so it is available before the context;
- **Question at the tail**: $x$ is always last (measured in paper T: the model's behavior drifts when the question is not at the end);
- **Strongest first**: recall blocks are ordered by descending $w_{\mathrm{eff}}$ within themselves. The recent-tail
  verbatim turns used to sit at the end of the remembered material — the *Lost in the Middle*-style U-shaped reading
  this bullet carried ([arXiv:2307.03172](https://arxiv.org/abs/2307.03172)) — and since 2026-10-05 they sit **in front
  of** the recalled block: where the block a re-selection moves sits is a cache decision, and the correction at the foot
  of this document carries the reason and the measurement;
- **Cache-friendly**: $P$ is never reordered; $T_{\mathrm{state}}$ is appended at task boundaries (`updatePolicy: perTask` by default).

**Memory separation theorem of paper T** (conditional state update task, state space $\mathcal{S}$, $b=\log_2|\mathcal{S}|$):

$$
\text{condition-first } [z,C]:\ \lceil b \rceil \text{ bits}
\qquad\text{vs}\qquad
\text{condition-last } [C,z]:\ \lceil b\cdot 2^{b} \rceil \text{ bits (worst case)}
$$

That is, the working memory demand of condition-first versus condition-last shows an **exponential separation** — this is the theoretical basis for the TAS layout.

### 3.5 Fallback

The **token-share** rule, which is off by default ($\mu = 0$, table note 1). **Its denominator was rebased by the token cap's retirement:** the share used to be taken of an allowance, `floor(total × ρ)`, and it is taken of the room the window has left after the fixed blocks, $\mathrm{remaining} = B - f_{\mathrm{fixed}}$. That is a forced semantic change to a mechanism that was otherwise left alone — at $\mu = 0$, the default and every cell, the comparison is `used < 0` and decides nothing, but a profile that opts in is now measuring against `remaining`:

$$
\sum_{h \in R'} \mathrm{tok}(h) < \mu \cdot \mathrm{remaining} \implies \text{degrade to recency window (chronological last-}N\text{), log a degradation event}
$$

The **count** rule, which is the one in force ($\mu_{\mathrm{seg}} = 1$):

$$
|R'| < \mu_{\mathrm{seg}} \implies \text{degrade to recency window (chronological last-}N\text{), log a degradation event}
$$

Both are `AssemblyPolicy.recall.minRecalledShare` / `.minRecalledSegments`; both are recorded on the wiring
record; either degradation is written to the assembly record as `fallback` (see §5.1, "what a report has to
carry").

**What bounds a fallback step: the candidate list, and no token ceiling.** The fallback discards the walk's
selection and re-fills from `history` — the caller's own candidate list, the graph window minus the verbatim tail,
minus the structural exclusions and the recall anchor's sibling chunks. So a fallback step injects *that whole list*
rather than at most a share of the budget, and **this is the one place where retiring the cap changes what a step
delivers**: its `budgetUsed` is larger than it would have been, and `fallback: 'recency-window'` on the assembly
record is what says why. Overflow is the harness's job — `@deepseek-ai/dsh-compaction-basic` and
`@deepseek-ai/dsh-compaction-tool-result-pruner` decide when the log is too long — and the shape is
`packages/core/src/assembler.ts`'s; the 2026-10-05 correction at the end of this document states it in full.

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

Every System-1 column carries its coverage — the floor below, and $\mathrm{judgedPairs}/\mathrm{scoredPairs}$ from
the association graph (`packages/core/src/assoc-graph.ts`) as the secondary reading — with the failure split beside
it (503 refused / transport timeout / other). A cell counts as **S1-governed** only at coverage $\ge 0.5$ **over the
pairs the arrival order offered**:

$$
\text{coverage over offered} \;=\; \frac{\bigl|\{\text{distinct pairs in the graph's \texttt{scores} map}\}\bigr|}{\sum_{i=1}^{N-1} \min(i, w)}
$$

$N$ is the session's segment count (the graph's own `order`) and $w$ is the scoring window `recall.window` the run
used. **"Settled" is the numerator's one word, and it means exactly this: the graph holds a score for the pair** —
one entry in the `scores` map, keyed by the pair with the older segment first, so the storage is triangular and the
map holds **one entry per unordered pair**. The denominator is a *pair count of the offered window*: the pairs the
session's own arrival order would have scored, $\min(i, w)$ for the $i$-th arriving segment (the table under
"Recall window w" below is that row's own statement). It is **not** `scoredPairs`, which counts offers and so counts
a pair again every time the cursor hands it back, and it is **not** `scoredPairs + deferredPairs` — no sum of those
two counters is a pair count of anything, and the two rounds that measure it are the 2026-10-05 correction at the
end of this document. Which counters the report prints, how it combines them and what it labels the result are
`scripts/cell-report.mjs`; what this section owns is the ratio they implement.

**A settled pair is not always a pair System-1 judged.** The map records the scorer on every entry (`source`):
`s1-noul` for a window the backend answered, `lexical` for one the local fallback produced when it did not. The
floor is a coverage of the offered *window by the graph*, so it is read beside both qualifications a report has to
print with it: the secondary ratio, which is the share of what the backend was *shown* that it answered, and the
settled pairs' own split by scorer. **$w$ is not in the rg snapshot**, so a report reads it from the run's own
wiring record (`docs/DOC-CONTRACT.md` §3) or from the `window:` provenance the graph writes on its edges; where
neither carries one, the offered window is not derivable and the floor says so rather than printing a number over a
guessed denominator. Where a cell has **no lane**, coverage is **undefined** rather than 0 or 1: `judgedPairs` is 0
because the backend was never asked, and the local fallback settles pairs in a cell the lane never touched — a floor
over settled pairs would read 1.00 for a control arm, which is why it is not applied to one.

Below the floor the majority of the cell's graph was scored by the local lexical fallback and the cell is not a
measurement of System-1 however it is labelled. Round `20261001-1300` measured 16.9 / 33.4 / 22.5 / 39.2% (round
labels `C1` / `C2` / `C3` / `C4`) under the ratio this floor used to be stated over — no arm cleared it.

> **Why the floor moved off $\mathrm{judgedPairs}/\mathrm{scoredPairs}$ (2026-10-02).** The admission gate defers a
> window it will not send, and `AssociationGraph.scoreNew` gives those pairs back to the cursor
> (`packages/core/src/assoc-graph.ts`): a deferred pair never reaches `scoredPairs`. So
> $\mathrm{judgedPairs}/\mathrm{scoredPairs}$ **rises when the run declines work** — with `admissionLimit: 8` and a
> breaker that can hold for `cooldownMs`, a saturated cell can reach 0.5 by not asking. A validity floor a run can
> satisfy by declining work is not a floor. The floor is therefore stated over the pairs the arrival order offered —
> the denominator above, $\sum_{i=1}^{N-1}\min(i,w)$, **not a sum of the two counters; that reading is superseded,
> corrected in place 2026-10-05, and its wording is quoted verbatim in the correction at the end of this
> document** — and $\mathrm{judgedPairs}/\mathrm{scoredPairs}$ is kept as the secondary reading it always was: the
> share of what the backend was *shown* that it answered. `scripts/cell-report.mjs` prints both ratios, the deferral
> count and its share, and the first-refusal index `k` beside every coverage figure, in the markdown and in the
> machine-readable CSV.

**The first-refusal index `k` exists only while the deferral is terminal.** `k` is the index the equation
$\sum_{i=k}^{N-1}\min(i,w) = \mathrm{deferredPairs}$ names — the entry the first refusal stopped on — and that
equation has a solution **only when the tail the counter measured is still the session's tail**. A round whose
cursor has reached $N$ has none: every deferred pair was recovered and scored, so the counter is a historical suffix
of an earlier, shorter order and names no index of this one. `scripts/cell-report.mjs` prints the index or the
reason there is none, and never a number the snapshot cannot support; the two rounds that measure this are the
2026-10-05 correction at the end of this document.

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
  instead of the whole suffix. *(The two groups are the layout's, and the layout changed on 2026-10-05: the recalled
  block now sits behind the recent tail and immediately in front of $x$, so a re-selection invalidates the question and
  nothing else — this bullet's own aim, reached one block earlier. The block order is the assembler header table's and
  is not copied here; the correction at the foot of this document carries the move and its measurement.)*
- Keep $T$ byte-stable within a task (`updatePolicy: perTask`): a state proxy that re-renders per turn
  invalidates everything behind it.
- Prune **contiguous runs, latest-first among the candidates**, and `alignToCacheBlocks` the budget
  (DeepSeek 64 tokens, OpenAI 128, Anthropic counts in 1024-token checkpoints) so a changed boundary does not
  cost a partial block.
- Never let per-turn metadata (timestamps, turn ids, cache flags) into the prefix.
- Measure $h$ per call (already in `llm_call` telemetry) and apply the test above with the measured $h$:
  the `C0`-vs-`C2` comparison — baseline against the full configuration, the same pair §8's registered test is
  stated over, and the pair round `20261001-1300` recorded under the labels `C1` vs `C4` (per that round's own
  record; the label mapping is the note at the head of §5.1) — is the **endpoint** contrast and bounds selection's
  cache effect, which is H3. **Since 2026-10-04 it is the endpoint rather than the whole registration** (the
  supersession is recorded in the dated note at the end of this file): the registered contrasts are now the paper's
  two steps, `C0 → C1` and `C1 → C2`, so a cache figure read off the endpoint alone still cannot say which half
  produced it. The endpoint test in §8 did not change; only the decomposition did.
  What the two steps measure **today** is the trace's *presence*, not its *position*: delivery appends and renders
  the trace before the recalled block by construction, so `policy.tracePlacement` reaches the recorded
  `layout.order` and not the delivered text (`docs/ARCHITECTURE.md`, `packages/proxy`). The arms are
  `docs/CELLS-RUN.md`'s, and the statement of record is the comment above `cellPolicy()` in
  `packages/core/src/types.ts`.

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
| BFS recall | $O(n^d)$ upper bound | bounded in practice by $\tau$, by the append-order direction and by $d$; no per-node cap, and nothing truncates it on tokens. `d` costs the *scoring* axis nothing while scoring is eager — the pair count $\sum \min(i,w)$ contains no `d` — and stops being free under on-demand scoring, which is not built (2026-10-05 correction at the end of this document) |
| Assembly ordering | $O(\|R'\|\log\|R'\|)$ | per turn |
| Telemetry | $O(1)$ / event | JSONL append |

---

*Citations and fact verification in [RELATED_WORK.md](./RELATED_WORK.md); implementation spec in [AGENT_BRIEF.md](./AGENT_BRIEF.md). **This document owns formulas and definitions, not parameter values:** every knob named here takes its default from `defaultPolicy()` and the cell presets (`packages/core/src/types.ts`, `bench/cells/*.json`), and a run's values from its own `kind:"wiring"` record. A value quoted in prose below is an input to a computation, dated and attributed — never a copy to be kept in sync, and never corrected here when the code and the prose disagree: the code wins and the prose is pointed at it.*

## Recall window w (`recall.window`)

A newly arrived session-event segment `s` (a user input `x`, a model output, a tool result) is scored by the
System-1 association backend against only the **most recent w segments** of history, not against all of it. The
graph itself stays unbounded: segments that fall out of the window keep every edge they already have and remain
reachable by the bounded BFS (`recall.depth = d`, `recall.threshold = r`). **"Reachable" is a claim about the edge,
not about a direction:** a step expands only into a segment earlier in the session's append order (§3.2), so such a
pair is reached from its *newer* endpoint — the older segment keeps the edge and is still recalled by the segment
that arrived after it. **w decides whether a pair is scored; it never decides what exists in the graph.**

Cost per new segment, with `t` segments already in the graph — **the table is the formula, stated as a table**:

| strategy | pairs scored for segment `t+1` | total after `T` segments |
| --- | --- | --- |
| full history | `t` — grows without bound | `T(T-1)/2` = Theta(T^2) |
| windowed (this design) | `min(t, w)` — bounded by `w` | `T*w - w(w+1)/2` = Theta(T*w) |

**A window that never binds is not a window, and calling it one was the error this section corrects (2026-10-05).**
`min(t, w) = t` for every `t < w`, so while the session is shorter than `w` the per-segment row is the *full-history*
row, the total is the full quadratic triangle, and the saving the window exists for is **zero**. `w = 1024` was the
code's own default until this date, against sessions of 116–228 segments in every round that has run: the brief read
"1024 basically covers the whole session" as the window doing its job, and it is the opposite reading — covering the
whole session means it removes nothing. Only `w` **below** the session's segment count makes the per-segment cost the
constant `w`, which is what the `O(turns × w)` statement below describes.

| `w` (N = 228) | pairs `sum_{i=1}^{227} min(i, w)` | share of full history | lane at 16.1 q/s | does `w` bind? |
| --- | --- | --- | --- | --- |
| 1024 | 25,878 | 100 % | 26.7 min | **no** |
| 512 | 25,878 | 100 % | 26.7 min | **no** |
| 256 | 25,878 | 100 % | 26.7 min | **no** |
| 128 | 20,928 | 81 % | 21.6 min | yes |
| 64 | 12,512 | 48 % | 12.9 min | yes |
| 32 | 6,768 | 26 % | 7.0 min | yes |
| **16** | **3,512** | **14 %** | **3.6 min** | **yes** |

The row is the measurement, and it is what set the two defaults: round `20261004-1239` had **N = 228 segments** and
**369.2 s** of session wall (6.2 min) against a System-1 lane measured at **16.1 questions/s** (5,958 questions in
369.2 s). The `w = 1024` it ran needed **26.7 min of lane to serve a 6.2 min session — 4.3× its budget** — which is
why the walk returned `candidates = 0` from invocation 9 onward: the tail had no edges because the lane was still
scoring the head. `recall.window` is **16** and `recall.depth` is **16** since 2026-10-05; both values live in
`defaultPolicy()` and the bounds in `NUMBER_RULES` (`packages/core/src/types.ts`, `packages/core/src/config.ts`).
Rounds recorded at `w = 1024, d = 2` (`20261004-0233`, `1211`, `1239` and earlier) stay readable and unedited — a
round's own `kind:"wiring"` record is what says what it ran.

**What raising `d` costs, and what it does not (2026-10-05).** `sum_{i=1}^{N-1} min(i, w)` **contains no `d`**: at
`w = 16` the lane's 3,512 pairs are the same for every depth, so `d` is **free under eager scoring** — today's design,
where every pair inside `w` is offered as the segment arrives. Simulated read-only on that round's frozen graph,
backwards-only with `tau` applied and averaged over all 228 anchors:

| `d` | mean reach | max reach | mean recalled tokens |
| --- | --- | --- | --- |
| 1 | 8.8 | 75 | 2,120 |
| 2 | 20.4 | 105 | 4,821 |
| 4 | 21.7 | 105 | 5,181 |
| 8 | 21.8 | 105 | 5,189 |
| 16 | 21.8 | 105 | 5,189 |

**Read that table as "`d` is free", not as "`d` is useless".** `d = 8` and `d = 16` are identical *there* because
that graph was built at `w = 1024`, where two hops already saturate it. A `w = 16` graph is far sparser (at most 16
neighbours per node) and on it the reach really is `w × d`, so `d` is the only knob that extends it — the values were
chosen for that graph, and which depth it needs is a question only a round at `w = 16` can answer. **And `d` stopped
being free the same day, because scoring stopped being eager: on-demand scoring is built** — a row is bought when a
walk asks for it (`AssociationGraph.recallDemand`, wired at `packages/dsh-plugin/src/step-observer.ts`) — so more
nodes reached means more rows scored, and `d` moved from the free axis to the billed one. The rows-and-pairs-per-depth
table, the threshold dependence and the order half of the saving are in the correction at the foot of this document
(§"Correction 2026-10-05 (seventh)") and in `AssemblyPolicy.recall.depth` (`packages/core/src/types.ts`).

**Derived figures:** at `T = 4096` and `w = 1024` — a value quoted as an input, not as the default it was until
2026-10-05 (`defaultPolicy()`; the lower bound is a `NUMBER_RULES` entry, `packages/core/src/config.ts`) — full history
scores **8,386,560** pairs and the window scores **3,669,504** (rows of the table above, 2026-09-28; the windowed
figure corrected 2026-10-05, see the correction at the end of this document), and — the
part that matters for a long session — the window's *per-segment* cost never exceeds `w` no matter how long the
conversation runs, while the full-history cost keeps climbing. This is the S1 call saving the window exists for;
it is not a recall parameter.

**What `w` touches, and what it does not.** `w` is the System-1 scoring window only, at `O(w)` per new segment and
`O(turns × w)` per session instead of the quadratic pair count — **and that `O(turns × w)` claim holds only once
`i > w` for the segments being scored**, i.e. only for a window below the session's segment count. While `i < w` the
per-segment cost is `i`, not `w`, and the session total is the full `Theta(T²)` triangle: the linear form is a
statement about a window that binds, and this section's table is where it stops binding. That reading is not
paraphrase — the count is `min(i, w)` in the code and in the graph cost note the row cites (`packages/core/src/types.ts`:
"S1 scoring window w (`recall.window`)"; `packages/core/src/assoc-graph.ts`: "one pass of `w` comparisons per new
segment", "the pair count `recall.window` is meant to bound"). **Recall is never bounded by `w`.** The BFS is bounded by
`recall.depth = d` and `recall.threshold = r`, and segments outside the window are still traversed and recalled
(traversed, as §3.2 states, only from the newer endpoint of a pair into the older one — the direction is the walk's
and not `w`'s): they keep every edge they already have (`packages/core/src/observer.ts`: "Segments outside the window keep their
edges and stay reachable"). What a smaller `w` costs is the **density of edges between new and old segments** —
fewer pairs are offered, so the graph the BFS walks becomes sparser and recall may reach fewer relevant segments
*through those edges*. That loss is real, and it is **larger at `w = 16` than at any value this project has run**:
rounds `20261001-1300` and `20261004-0233` were both recorded with a window that never bound (`w = 1024` against 214
and 185 segments), so **no recorded round measures the sparse-graph loss at all**, and a run at `w = 16` must carry
`fallback`, `unknownAdmitted` and `recallTree` beside it. What pays for it is `d`: the reach `w × d` is **256** at the
defaults, against the 2,048 the previous `w = 1024, d = 2` pair gave — a deliberate trade of reach for a lane that
fits inside its session.
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

**How much `w` would have to move to matter, measured at a recorded round's own session length (2026-10-05, and the
answer is the default).** At round `20261004-0233`'s N = 185 segments the offered window is
`sum_{i=1}^{N-1} min(i, w)` = **17 020** pairs — that is its `N(N-1)/2`, the full-history row, **92.0 pairs per new
segment** — and at that length **`w = 1024` is already unbounded**: `w = 256` offers the same 17 020 (0.0 %). A `w`
of 128 is worth **15 424 (−9.4 %)**, 64 is **9 760 (−42.7 %)** and 54 is **8 505 (−50.0 %)**; at the **16** this
document's table above sets as the default the same session offers **2 824** pairs, **−83.4 %**. So the saving is a
function of the session length before it is a function of `w`, and the curve is only flat at the *top*: a `w` of 128
reaches roughly the 36 % it was once expected to save here only at N ≈ 320 (−35.9 % there), while a round shorter
than that cannot show it. **`w` is not the binding constraint on this cost at the lengths measured so far** — which
is the per-segment row of the table above read at a length rather than at the limit, and it is exactly the sentence
that kept `w = 1024`: read one row further and it says the default bounded *nothing* at every length on record. That
is the correction the 2026-10-05 table made, and the 4.3× overspend on round `20261004-1239` is what it cost.

Measured offline in `packages/core/test/window.test.ts` (`w = 64`, 400 segments): `scoredPairs` stays within
`total * w` and strictly below full pairwise scoring, the first segment still holds its edges after leaving the
window, and **doubling w roughly doubles the cost** — the cost tracks `w`, not the session length.

**Measured in a live round (`20261001-1300`), and the caveat that comes with it: the window did not bind** — the
four arms offered exactly `T(T-1)/2` pairs (6 670 / 4 278 / 3 321 / 22 791 for 116 / 93 / 82 / 214 segments,
labels `C1` / `C2` / `C3` / `C4` — see the label note at the head of §5.1), the *full-history* row of the table
above,
because `w = 1024` was larger than any session that round produced. The call count, too, follows from the pair count
alone *in a run that offers each pair once* (22 791 pairs at a cap of 20 are the 1 155 calls the full-configuration
arm made, where `w = 64` would offer 11 616, half of them) — but **whether a run does offer each pair once is a
property of the graph, not of the pair count**, and a later round did not. Round `20261004-0233` scored the same
2 211 pairs 4.59 times over, and nothing in the pair count could have shown it: the difference between `scoredPairs`
and the distinct pairs keyed by `from->to` is a **duplicate-work measurement**, not a check that has to come out
zero, and when it is not zero the lever is the graph's own take — see the 2026-10-05 correction at the end of this
document, which states what was measured and what the two counters mean.

---

## Correction 2026-10-04 — the symbol table's `T`, §3.4's two key points, and one strengthened rule

Appended under `docs/DOC-CONTRACT.md` §4. **Nothing above this line is edited.** `FORMULAS.md` is a class-(b)
source of truth (metrics and definitions), so each correction below points at the code that owns the value rather
than restating it. The decision these follow is `STATUS.md` §10.

### 1. The notation table's `$T_{\mathrm{state}}$` (line 24) is wrong about the content

It reads "Task-state proxy (serialized reasoning trace **+ task brief**) (bound: `tas.tMaxChars`)". **There is no
task brief.** The user's own text is S1CAP's $x$ — the anchor, already in the prompt by construction — and the
paper's state proxy is the serialized reasoning traces alone, `T = π(r_1,…,r_ntr)` (arXiv:2609.02702 §3.2). A task
brief inside $T$ would both widen it past the paper's object and charge the same tokens twice per step.

**The bound, read the right way round.** `tas.tMaxChars` is the owner, and the project's effective value is read
from `AssemblyPolicy` in `packages/core/src/types.ts` resolved per cell through `bench/cells/*.json` — **never from
this table and never from a document**. For what it bounds: the paper's own figure is the **first 50,000
characters** of the serialized trace (the paper's *Setup*), and the direction is the part that carries meaning, because it is what
`tas.updatePolicy` selects between (§6 below). The serializer is `packages/core/src/state-proxy.ts`.

### 2. §3.4's first key point says "distilled"; the paper distills nothing

Line 145 reads "**State first**: $T_{\mathrm{state}}$ (the task state **distilled from** the trace) is placed before
the history". The word is the error. The paper's premise is that the trace **is** the textual proxy — "we view
reasoning traces as an observable textual proxy for task state" — and the state-first rule follows from placing
that text before the history. Distilling it first would replace the artefact whose placement is under test with a
different artefact, which is exactly the substitution §3.4's own citation is being used to justify. The rule
itself is unchanged; the description of what is being placed is corrected.

### 3. §3.4's second key point borrows the paper's notation, and the layout in that section is not the paper's

Line 146 reads "**Question at the tail**: $x$ is always last (measured in paper T: the model's behavior drifts when
the question is not at the end)". The **conclusion** is right and S1CAP follows it. The **symbols** are not: in
arXiv:2609.02702, $x$ is the **long context** and $q$ is the **question**. In this document, and in the whole
project, $x$ is the user's latest input and the recalled history is $R'$. The paper's two conditions are therefore
`[T, x, q]` and its matched control `[x, T, q]`; the expression in §3.4 is S1CAP's own layout,
`[P | T | sort(R') | tail_K | x]`, which is not either of them and is not claimed to be.

**The load-bearing consequence, and it is a measurement fact rather than a notation one.** The paper's only
independent variable is **where $T$ sits**, and in the layout above the `stateProxy` block is at a fixed position
in every branch — the anchor is last in every layout by construction and the only field that moves anything is
`tracePlacement`, which moves $T$ (`packages/core/src/assembler.ts`). So **the paper's
matched control is not expressible in this layout**: no configuration places $T$ after the history. §3.4's title
says "(factor TAS on)", and the factor that the paper varies is therefore not yet a factor here. `STATUS.md` §10
records the decision to make $T$'s position an independent variable; the name, type and default of that variable
are owned by `AssemblyPolicy` and are not written in this document. *(Superseded by the corrections below, and
corrected in place where the correction could point at a live rule: the control **is** expressible
(`tracePlacement: 'trace-append'`), so the two sentences that say it is not are named and quoted as superseded in the
2026-10-05 correction below. The field the paragraph used to name for the anchor is retired; `tracePlacement` moves
$T$, and the anchor is last in every layout by construction.)*

### 4. §6's "Keep $T$ byte-stable within a task" — not falsified, strengthened

Line 413's rule is correct as written: a state proxy that re-renders per turn invalidates everything behind it.
**It is now true by construction rather than by convention**, and the strengthened form is what a reader should
rely on. Under the current serializer, `updatePolicy: 'perTask'` is a statement about *which prefix of the trace*
the block is a function of — the first `tMaxChars` characters — so appending to the log cannot change it, because
it does not depend on anything appended. The weaker form of the same claim (that a caller-side memo is what holds
it steady in a live session) is no longer the load-bearing one.

Two limits a formula must state rather than smooth over, both of which belong to the owning code and are recorded
in `packages/core/src/state-proxy.ts`: below the ceiling the two policies emit **byte-identical** text, so the
switch has no observable effect until a task's trace outgrows the ceiling; and `'perTurn'` follows the trace
forward, which re-cuts the block and so loses the prefix cache on every step the loop takes.

### 5. §6's contrast paragraph is superseded on the registration, edited in place

§6 is a live design-rules section rather than a dated record, so its registration sentences were corrected rather
than left standing — a rules section that names the wrong pair sends the next reader to the wrong comparison. The
superseded text, for the record:

> the `C0`-vs-`C2` comparison … is the **design contrast** and isolates selection's cache effect … **It is also the
> only contrast the selection claim has left**, now that the recall-only arm is dropped … **`C1` is not that contrast
> and cannot be**: since 2026-10-02 it is a second control arm that delivers nothing … what `C0`-vs-`C2` measures
> **today** is the recall lane: TAS's ordering reaches the model only through the model-view write-back, which does
> not exist yet.

Three claims moved. **The endpoint did not**: §8's pre-registered statistic is still `C2` vs `C0` and was not
touched — a pre-registration is not a document that gets corrected into agreement with a later design change. **The
decomposition did**: `C0 → C1` and `C1 → C2` are the registered contrasts since 2026-10-04, so the endpoint alone no
longer isolates one mechanism. **The subject did**: `T` is delivered, so the sentence about the trace never reaching
the model is false; what survives is its narrower form, that the trace's *position* does not reach the model in any
arm, because the delivery channel appends.

The round-1300 figures the paragraph quotes (`C1` vs `C4` labels, the ~0.69× per step) are that round's record and
are untouched.

## Correction 2026-10-05 — one layout field was renamed and the second was **deleted**; §3.4's layout is the paper's Trace-as-State order

Appended beside the 2026-10-04 correction under `docs/DOC-CONTRACT.md` §4. **Nothing in that correction is rewritten**;
the sentences of it that this note supersedes are named and quoted below. §6 is a live design-rules section, so its
one stale field name was corrected in place rather than left standing, for the reason its own item 5 gives. **The
second axis named in this note's "What moved" was deleted later the same day**; the note at the foot of this
correction records that and quotes the mapping as superseded.

### What moved

`AssemblyPolicy.xFirst: boolean` is gone from the tree: it was renamed to `questionPlacement: 'first' | 'last'` and
then **deleted** the same day (the field mapping this note used to carry is quoted as superseded at the foot of this
correction). `AssemblyPolicy.stateProxyPosition: 'before-context' | 'after-context'` is now
`tracePlacement: 'trace-as-state' | 'trace-append'` (default `'trace-as-state'`), the **only** layout axis: the
question is last in every layout by construction. A profile that still spells an old key is read and reported
(`LEGACY_LAYOUT_KEYS`, `packages/core/src/config.ts`); which spellings are warned about and which are refused is the
code's and is not restated here. Names, values and
defaults are owned by `packages/core/src/types.ts` and `packages/core/src/config.ts`; this document keeps its rule of
not restating them, and §3.4's formula is unchanged — what changed is that the second axis that used to move the
question is gone, so the formula's `x` is last by construction rather than by default.

### Why

The paper (arXiv:2609.02702, section 4.1) places the question **last in every condition** — "the question appears at the end
of the prompt … place it at the end of every input" — and its two arms are `[T, x, q]` (**TAS**, Trace as State) and
`[x, T, q]` (Trace Append), **order the only difference**. `xFirst` moved the *question*, the one element the paper
fixes, and its name presented that as the paper's variable; `stateProxyPosition` was already the paper's axis, so it
took the paper's name. **The question's own axis was then deleted rather than renamed** — see the note at the foot of
this correction: `questionPlacement` left "the question's position is a variable" expressible and its `'first'` value
produced `[T, q, x]`, which is neither paper arm, so `tracePlacement` alone is the axis.

### The evidence, from round `20261004-0233`'s own `layoutOrder` records

`C1` and `C2` recorded `pinned, stateProxy, anchor, recalled, tail` — the question second, a layout that is neither
paper arm — because both set `xFirst: true`; `C0` (`xFirst: false`, TAS off) recorded `pinned, recalled, tail, anchor`,
the paper's baseline `M([x, q])`. So no cell reproduced either paper arm. The table of orders each `tracePlacement`
value produces is in the header of `packages/core/src/assembler.ts`.

### §6's live sentence, edited in place

It read *"… so `policy.stateProxyPosition` reaches the recorded `layout.order` and not the delivered text"*; the field
is now `policy.tracePlacement`. The claim itself is unchanged and still true: the delivered text appends `T` ahead of
the recalled turns whatever the recorded order says (`packages/dsh-plugin/src/context-delivery.ts`).

### Two sentences of the 2026-10-04 correction above are superseded

Both are in its item 3 ("§3.4's second key point borrows the paper's notation, and the layout in that section is not
the paper's"), and both are superseded by the rename rather than withdrawn:

1. *"… the expression in §3.4 is S1CAP's own layout, `[P | T | sort(R') | tail_K | x]`, which is not either of them
   and is not claimed to be."* Under what the layout field now carries — the question last, the trace in
   front of the long context — §3.4's layout **is** TAS: `P` is the pinned prefix, `T` is
   the trace, `sort(R')` is the paper's long context `x`, and this document's `x` is the paper's `q`. The formula
   section needed no edit for that; the field that made the difference reachable is the correction.
2. *"… **the paper's matched control is not expressible in this layout**: no configuration places `T` after the
   history. §3.4's title says '(factor TAS on)', and the factor that the paper varies is therefore not yet a factor
   here."* `tracePlacement: 'trace-append'` **is** the paper's control, it is enforced by `assemble()` and recorded on
   every assembly, and a profile can set it. What stays true, and is the operator's reading rule rather than a
   limitation of the policy: **no preset carries it**, so no arm has presented the control yet.

§3.4's own *"Question at the tail: $x$ is always last"* line is the conclusion its item 3 already called right, and it
is now true of every layout rather than one branch of a boolean: the last block of every recorded order is `anchor`,
and no field can place it anywhere else (the field that once could — the boolean `xFirst`, and the
`questionPlacement` it was renamed to for a day — is deleted; see the note below).

**Deletion, later the same day — the question axis is gone, and the mapping above is superseded.** Recorded under
`docs/DOC-CONTRACT.md` §4, inside this correction rather than in place of it, because the sentences it supersedes are
this note's own.

- **What moved.** `AssemblyPolicy.questionPlacement: 'first' | 'last'` is **gone from the tree** — deleted, not
  renamed. **`AssemblyPolicy.tracePlacement: 'trace-as-state' | 'trace-append'` is the only layout axis**, and `q` is
  last by construction: the paper's section 4.1 (arXiv:2609.02702) separates the question from the long context and places it
  "at the end of every input" in every condition, its two arms are `[T, x, q]` and `[x, T, q]` with order the only
  difference, and `'first'` produced `[T, q, x]`, which is neither. `LEGACY_LAYOUT_KEYS`
  (`packages/core/src/config.ts`) reads both retired spellings and reports them — the question-last ones as a warning,
  the question-first ones as an error that quotes the sentence that retired the layout — so the mapping in **What
  moved** above is superseded: there is no surviving `questionPlacement` to translate `true`/`'first'` into.
- **Where this leaves the two paragraphs above.** Item 1's reading is unchanged and stronger: §3.4's layout is TAS
  under what the one layout field carries, and the question's position is no longer a field at all. Item 2 stands as
  written: `tracePlacement: 'trace-append'` is the paper's control and no preset carries it.
- **The evidence, from round `20261004-0233`'s own `layoutOrder` records**, `C0`
  `["pinned","recalled","tail","anchor"]` and `C1`/`C2` `["pinned","stateProxy","anchor","recalled","tail"]`, is data:
  the first string is the order `C0` produced with TAS off, and the second is the order the TAS cells produced when
  the anchor axis put the question second.

## Correction 2026-10-05 (second of the day) — the recall token cap was retired: §3.1, §3.3 and §3.5 carry no ρ

Appended under `docs/DOC-CONTRACT.md` §4. The live formula sections of this document — *Budget*, *Bounded BFS
recall*, *Selection* and *Fallback* — were corrected in place and the superseded wording is carried here verbatim: a
rule sheet that still
bounds the selection by a knob the build no longer has sends the next reader to the wrong rule, which is the same
reason the first correction of today gives.

### What moved

The `recall` block's `budgetRatio` (ρ, default 0.35) is **gone from the policy**. `recall.depth` (d),
`recall.threshold` (r) and `recall.window` (w) are the only tunable recall parameters, and **no token ceiling bounds
the recalled block**: the selector is bounded by r, d and the correctness filters named in §3.3. `validatePolicy`
reports unknown keys only at the **top level**, so a stale profile that still writes `budgetRatio` inside `recall` is
accepted and silently ignored — which is why the presets were swept in the same change, and why a file still carrying
it is a finding rather than a harmless no-op.

### Why

The originating brief declares exactly three tunable recall parameters — `recall.depth` (d), `recall.threshold` (r)
and `recall.window` (w) — and mentions tokens **only as a measurement** (成本, line 18: cached input / uncached input /
output), never as a limit. `budgetRatio` was an added mechanism: a candidate that cleared r and lay inside d could
still be dropped because the block was full, so the recorded selection was a different rule from the brief's. It also
coupled two things the brief keeps apart — the allowance was `min(total × ρ, remaining)`, and the fixed side counted
the serialized trace T, so a larger T shrank the recall allowance and T competed with the recall for the same tokens.

**What bounds the block instead: r, d, and the correctness filters — and those are not a budget.** The structural
exclusions (pinned / tail / anchor: content the model already has in the prompt, or not history at all), the anchor's
sibling chunks (the current event quoted back as "an earlier turn") and the passage chunk de-duplication (two halves
of one passage) each remove content that is false, already present or duplicated. They change *what* the model reads
and never *how much*; a token ceiling is the other kind of rule, and that distinction is what the removal was about.
The code that owns all of it is `packages/core/src/assembler.ts` (the note above `assemble`), and the decision and its
measurement are in `AssemblyPolicy.recall` (`packages/core/src/types.ts`); neither is restated here beyond what the
formulas need.

**Overflow is the harness's job, not S1CAP's.** DSH ships two native mechanisms, both wired into every cell profile
under the `compaction` group: `@deepseek-ai/dsh-compaction-basic` (context compaction —
`thresholdTokens = floor(min(contextWindow × thresholdRatio, pressureBudgetTokens))`,
`retainTokens = floor(messageBudgetTokens × retainRatio)`, defaults 0.8 / 0.16) and
`@deepseek-ai/dsh-compaction-tool-result-pruner` (`thresholdChars 8192`, `headChars 4096`, `tailChars 1024`). S1CAP's
injection goes through `agent/pre-step`, which appends the block to the session log as a real surface node with its
own seq, and compaction operates on "the surface-node seqs, in order, being compacted" (`buildSummarizationInput`,
`compactRegion`) — **so injected recall is inside what compaction covers.** S1CAP inserts context and never rewrites
or suppresses it: the harness decides when the log is too long, which is the additive property the design asks for.

**What a compaction costs, which none of that accounting carries.** Prompt caching is *prefix* caching: a hit
reaches only as far as the prompt stays byte-identical from the front, and a compaction replaces content at the
front with a summary. The step it lands on therefore re-reads the rest of the prompt uncached, so the price of one
summary is one prompt. Round `20261004-1458` measured it: two prompt rewrites carried 113,735 uncached tokens above
the cell's median step, 33.6 % of that cell's entire uncached input, against a 131,072-token trigger that every
cell of the round crossed (C2 peaked at 145,266 there and 155,454 in `20261004-1239`). Two consequences are in the
tree: the profiles' trigger is now 393,216 (`setup.mjs`'s `contextWindowRows()`, which also states the trade), and
the per-step reading is drawn rather than left to be computed — `scripts/cell-report.mjs` writes `cache-steps.svg`
with every compaction and prune record marked and the step it is charged to labelled.

### Measured, so the removal is not a leap of faith

Round `20261004-0233`, cell C2: **the cap never bound.** `budgetUsed` peaked at 6 399 against a `budgetTotal` of
118 800 — 5.4 % of the budget, and 9.2 % of the 41 580 the ratio allowed. Deleting it changed no recorded step; what
it removes is a latent divergence between the brief's selection rule and the code's.

### What the removal did not leave alone: μ's denominator, and the fallback's size

Two consequences are changes rather than deletions, and both are stated here because a reader must not have to
discover them:

1. **μ's denominator was rebased.** The token-share floor (`recall.minRecalledShare`, off at 0 in every cell) used to
   compare the recalled mass against a share *of the allowance* — `μ · floor(total × ρ)`. With the allowance gone the
   comparison is `used < μ · remaining`, where `remaining = B − f_fixed` is the room the window has left after the
   fixed blocks (`packages/core/src/assembler.ts`). The mechanism was left alone; its denominator was not, so **no
   value of μ means the same thing as it did before**.
2. **The recency fallback is no longer bounded by tokens.** A fallback step discards the selection and re-fills from
   the caller's candidate list, so it injects that whole list where the ρ-bounded version injected at most the
   allowance. What bounds it now is the list itself plus the correctness filters — no ceiling. The fallback fired on
   some assemblies of round `20261004-0233`, so this is not a corner case: a fallback step's `budgetUsed` is larger
   than it used to be, and `fallback: 'recency-window'` on the record is what says why. Overflow is
   `@deepseek-ai/dsh-compaction-basic`'s to own (with the tool-result pruner), which is the architecture's answer and
   is stated in §3.5 above.

### The superseded wording, verbatim

1. Notation table — the row *"| $\rho$ | Recall-block share of the budget |"*, whose code span named the field by its
   full path (the `recall` block's `budgetRatio`) → a struck-through retired-symbol row, because old rounds' records
   and reports print ρ.
2. §3.2 — *"Worst case $O(k^d)$, truncated early by the budget."* → the walk is bounded by d and k; nothing truncates
   it on tokens. **The $k$ in that rewrite was itself superseded later the same day** (2026-10-05): the per-node
   cap is retired, the clause is out of the formula, and the bound is now $O(n^d)$ over $n = |S|$ — see the
   correction on $R_d(x)$ at the end of this document, which replaces this cell's wording rather than this cell.
3. §3.3 — *"Budget knapsack (greedy)"* with the constraint
   *"$\sum_{h \in R} \mathrm{tok}(h) \le \rho B$"*, closed by *"Greedily packed in descending order of
   $w_{\mathrm{eff}}$; deduplicated by segment id against the recent-tail $K$ verbatim turns."* → the section is
   *Selection (greedy, and no token cap)*, the constraint is gone, and the de-duplication it named in passing is
   stated as the correctness filter it is.
4. §3.5 — *"$\sum_{h \in R'} \mathrm{tok}(h) < \mu \rho B$"* → the share is taken of
   $\mathrm{remaining} = B - f_{\mathrm{fixed}}$, which is what the code compares
   (`used < policy.recall.minRecalledShare * remaining`), because the allowance it used to be a share *of* went with
   the cap.

### Pointers

The selection and the fallback: `packages/core/src/assembler.ts`. The policy field and its history:
`AssemblyPolicy.recall` in `packages/core/src/types.ts`. The retirement note where the field used to sit:
`packages/core/src/config.ts`. What a round records: `budgetUsed` / `budgetTotal` on the assembly record, and §5.1 of
this document for the metric specification.

## Correction 2026-10-05 (third) — the recall anchor is the step's newest input event, not the newest `user` segment

Appended under `docs/DOC-CONTRACT.md` §4. This one corrects a *dated* sentence rather than a live one, so nothing
above is edited: item 1 of this document's 2026-10-04 correction carries a reading that is now wrong only in part, and
this note is where the record is superseded.

### What moved

The seed of the BFS recall walk — the recall anchor, §3.2 above — is the step's **newest input event**: a `user`,
`assistant`, `trace`, `toolCall` or `toolResult` segment, with `systemPinned` the one kind excluded
(`packages/core/src/observer.ts`, `isInputEvent`). It used to be the newest `user` segment. The reason is the
originating brief's own: idea 3 drives recall from "the user input *or* the model's own self-directed input", and idea
2 defines a session event as "user input x, or LLM output o, tool call results, etc.".

**`T`'s boundary deliberately did not move.** `buildStateProxy` serializes the `assistant`/`trace` segments that
*follow* the segment it is handed, and it is still handed the newest `user` segment — the question the task was opened
with (`packages/core/src/observer.ts`, the note "T's boundary, which is the task and not the recall anchor"). Handing
it the moving anchor would slice T's input at the very end of the log, so `T` would come out empty on every step after
the first: the state proxy would vanish from the two cells that exist to deliver it while every counter on the record
stayed healthy. So **the recall anchor moves every step and T's task boundary does not**, and a sentence that says
"the anchor" has to say which one it means.

### The sentences this supersedes, verbatim

1. Item 1 of the 2026-10-04 correction (line 610 as it then stood) reads: *"The user's own text is S1CAP's $x$ — the
   anchor, already in the prompt by construction"*. That is true **only at a turn-opening step**, where the newest
   `user` segment and the newest input event are the same segment; on every later step of an agent loop the user's
   text is not the anchor — the model's own newest message, tool call or tool result is — while it remains the boundary
   of `T`. What the sentence was written to establish is unaffected: there is still no task brief inside `T`, and the
   user's text is still not part of it (`packages/core/src/state-proxy.ts`, `TRACE_KINDS`).
2. The **notation table's `$x$` row** read *"Current user input (condition/instruction)"*; it now names the step's
   newest input event, because that is the segment the code calls `current` and seeds the walk with. The same
   imprecision sits in item 3 of the 2026-10-04 correction — *"In this document, and in the whole project, $x$ is the
   user's latest input and the recalled history is $R'$"* — and everything else that item says about the paper's own
   notation ($x$ is the paper's long context, $q$ its question) still stands.

### Measured, which is why the change was made

Round `20261004-0233`, cell C2: the walk root stayed on one segment for the last **20 of 25** assemblies while the
step sequence climbed 23 → 116, because the only `user` segments in an agent loop are at turn openers. `candidates`
plateaued at 26–28 and `selected` at 20, the assembled payload never changed, and only **11 of 25** steps received
anything at all. With the seed on the step's newest input event the walk re-roots every step, and `newestUser` is
carried beside `anchor` on every assembly row so the two rules can be read against each other in a round's own
artifacts.

### Pointers

The rule and the two boundaries: `packages/core/src/observer.ts` (`isInputEvent`, and the "T's boundary" note). The
definitions of §3.2 and §3.3 above. The measured round: its own directory's `control.jsonl`, on the `candidates`,
`selected`, `anchor` and `newestUser` fields.

## Correction 2026-10-05 (fourth) — the System-1 lane was not slow, it was **paid for the same work 4.45 times**; five sentences of §5.1 and the "Recall window w" section are falsified, and one sibling document restated two of them

Appended under `docs/DOC-CONTRACT.md` §4, at the foot of the three corrections above and in place of none of them.
The live formula sections — §5.1's coverage definition, the *Recall window w* table and the one live paragraph that
read a zero duplicate-work difference as a property of the code — were corrected in place, and the wording they
carried is quoted verbatim below. `docs/LAYA_RUNTIME.md`'s restatement of the same floor was corrected in place
too, and its superseded sentence is quoted in item 6. The reason is the one the other two 2026-10-05 corrections
give: a rule sheet that still tells the next reader there is no duplicate work to look for sends them away from the
defect. **Items 2 and 3 below are the important ones, and the reason is not that they were wrong: it is that they
were the sentences that closed the question.** A reader who trusted them would not have looked, which is exactly
how this survived.

### 1. The windowed closed form was wrong by `w`, and so was the figure derived from it

The *Recall window w* table (§5.1, the row `windowed (this design)`) carried `T*w - w(w-1)/2` and the derived
paragraph carried **3,670,528**. Both were `w` (= 1,024) too high, and the paragraph is where the error was
visible: the same paragraph printed **8,386,560** for the full-history row, which is right.

**Checked against the table's own row definition, by direct enumeration.** The row is `min(t, w)` for segment `t+1`,
so with segments numbered from 1 a segment scores against `min(s-1, w)` earlier ones — the first segment scores
nothing, the last of `T` scores `min(T-1, w)` — and the total is `sum_{i=0}^{T-1} min(i, w)`:

- `sum_{i=0}^{4095} min(i, 1024)` = `0 + 1 + … + 1023 + 3072 × 1024` = `523,776 + 3,145,728` = **3,669,504**;
- `T*w - w(w+1)/2` = `4096 × 1024 − 1024 × 1025 / 2` = `4,194,304 − 524,800` = **3,669,504**;
- the form that was printed, `T*w - w(w-1)/2` = `4,194,304 − 523,776` = **3,670,528** — the printed figure, and
  exactly `w` high. Its error is a single bounded segment too many: it is `(T+1)*w - w(w+1)/2`, the total for a
  session one segment longer.

The full-history row needs no change: `T(T-1)/2` = `4096 × 4095 / 2` = **8,386,560**, and the row agrees with the
same enumeration.

### 2. "the difference was zero in all four arms" — it is **7,946** in round `20261004-0233`, and the lever **was** de-duplication

The paragraph below the table read the zero difference between `scoredPairs` and the distinct pairs keyed by
`from->to` as a *property of the code*, and closed the subject. It is a **measurement** — the one measurement that
would have found this — and in the next long round it did not come out zero. Both sentences, verbatim:

> … a repeated pair would show as a difference of exactly one between `scoredPairs` and the distinct pairs keyed by
> `from->to`, and the difference was **zero** in all four arms — so `scoredPairs` counts offers and there is no
> duplicate work to remove, the lever on this cost is `w` (or the `s1.questionsPerCall` cap) and never
> de-duplication; and the call count follows from the pair count alone (22 791 pairs at a cap of 20 are the 1 155
> calls the full-configuration arm made, where `w = 64` would offer 11 616, half of them).

**Measured in round `20261004-0233` (cell `C2`), from that round's own snapshot and control plane:**

- The association graph's `scores` map holds **2,211** rows and the same number of distinct keys — exactly
  `67 × 66 / 2`, a **complete triangle over segments 0–66, no holes and nothing outside it** — so the graph holds
  2,211 distinct pairs, and the difference the sentence expected is `10,157 − 2,211` = **7,946**: not zero and not
  one, and `10,157 / 2,211` = **4.59×**, which is `scoredPairs / distinct pairs` and is exactly the duplicate-work
  ratio stated in the section above.
- The lane was charged **9,828 questions** for those 2,211 pairs (`9,828 / 2,211` = **4.445×**), across **634**
  `noul` calls. A clean non-overlapping pass needs `ceil(2,211 / 20)` = **144 calls / 2,211 questions**, so
  **486 of the 634 calls (77.5 %) were re-asks** of pairs the graph already held.
- The multiplicity is visible in the call sequence without any counter: the per-call window sizes are
  `1,2,3,4,`**`2,3,4,3,4,4,`**`5,6,6,7,8,8,…` — window sizes that repeat **downward**, where one sweep's windows can
  only ascend, because the window a segment gets is the number of segments already before it.

**Mechanism, and the fix that answers it.** The upkeep queue does not await its handler
(`packages/core/src/upkeep-queue.ts`, `runOne`) and the observer drains every queued event synchronously
(`packages/dsh-plugin/src/step-observer.ts`), so a burst starts N concurrent sweeps over one graph. Each sweep used
to copy the shared cursor once at entry (`let lastOffered = this.#scored`), walk forward writing `this.#scored =
index + 1` per take and `-= 1` on a deferral — so two overlapping walks scored the same segment, and either could
move the cursor **backward** over what the other had finished. Work is now obtained only through `#claim`, which
marks an entry owned **before any `await`**, so L sweeps in flight are L *distinct* segments; the cursor advances
only in `#settle()`, over contiguous settled entries; and a `try/finally` resolves the claim on every exit path.
The code that owns all of this, with the same measurement, is `packages/core/src/assoc-graph.ts` (`#claim`,
`#taken`, `#settle`). A scale test at the round's exact shape now measures **17,020 questions for 17,020 pairs —
1.00×**, against this round's 4.45×.

**So `scoredPairs / distinct pairs` is the duplicate-work ratio, and 1.00 is the healthy reading of it.** Read the
other way round it is a yield: `distinct / scoredPairs` was **21.8 %** here, and the 7,946 difference is 7,946
re-scored offers. The superseded sentence's *conclusion* about `w` survives in a much narrower form and is stated
in the section above: at the lengths measured so far `w` is not the binding constraint, and it was never the
duplicate-work lever.

### 3. "the call count follows from the pair count alone" — it does not, and the round's own numbers say so

The same paragraph's second clause is falsified by the same round. **634 calls were made for 2,211 distinct
pairs whose clean cost is 144.** The `20261001-1300` figures it quotes are that round's record and are untouched;
what is corrected is the general claim drawn from them, which the *Recall window w* section above now states with
its condition attached: the call count follows from the pair count alone **in a run that offers each pair once**,
and whether a run does that is a property of the graph's take, not of the pair count.

### 4. "The floor is therefore stated over the pairs the arrival order offered, `scoredPairs + deferredPairs`" — the two are not additive

§5.1's coverage rule was stated over `scoredPairs + deferredPairs`, printed as a single formula with a `≥ 0.5`
floor. **Neither counter is the pair count that denominator needs, and their sum is not one either.** Measured in
round `20261004-0233`:

- the offered window at that round's `N = 185` segments is `sum_{i=1}^{N-1} min(i, w)` = `184 × 185 / 2` =
  **17,020** pairs (`w = 1024` did not bind);
- `scoredPairs + deferredPairs` = `10,157 + 16,767` = **26,924** — **9,904 more than the session contains**;
- the excess is the pairs counted in both counters: the deferred total is the whole tail from the first refusal,
  `sum(i, i = 23..184)` = **16,767** (matching `deferredSegments` = 162 = 185 − 23), and **44 of those segments
  (23–66) were scored afterwards**, so their pairs are in `scoredPairs` as well. `sum(i, i = 23..66)` = **1,958**
  is the overlap: those 1,958 pairs are paid for in the round *and* held in the omission count. The other
  comparison, stated because it is the one a reader will reach for next: the deferred counter counts **14,809**
  pairs that were never scored, `7,946` re-offers lie inside `scoredPairs` and `1,958` of them are the overlap
  above — so the two counters count the same pair twice for 1,958 pairs, and 5,988 of the re-offers are re-offers
  the deferral count never saw;
- `scoredPairs` additionally counts every re-offer, so it is a **work** counter and not a pair count at any point,
  not merely at the end.

So the printed `33.6 %` floor was the ratio of a judged-pair count to a denominator that measures work done plus
work declined, over a set that double-counts part of both — neither a rate nor a coverage over the offered window.
**What a coverage figure has to be built from: the distinct pairs the lane settled, over the pairs the session's
arrival order offered, `sum_{i=1}^{N-1} min(i, w)` where N is the session's segment count**. The live §5.1
paragraphs above now state it that way and point at
`scripts/cell-report.mjs` for the rows and the arithmetic; the counters themselves, and why each cannot be the
denominator, are documented in `packages/core/src/assoc-graph.ts` (`#scoredPairs`, `#deferredPairs`,
`countDeferredSuffix`).

**A source sentence this correction reports rather than fixes.** The doc comment on `AssociationGraph.deferredPairs`
(`packages/core/src/assoc-graph.ts`) still says *"`scoredPairs + deferredPairs` is the window the session's arrival
order would have offered"* — which is the §5.1 claim this item falsifies, in the code that owns the counter. It is
quoted here so the next lane finds it; **nothing under `packages/**` is edited by this correction.**

### 5. The live sentence that read a zero duplicate-work difference as a property of the code

One sentence of the **Recall window w** section was *not* falsified by the round and was still wrong in the same
way — it is corrected in place here for the reason the others are. It reads *"Two things follow, and they are the
reason the measurement is recorded beside the formula"*, and "two things" were a property of the code and a
property of the pair count that the round has since shown to be properties of the *run*. It now states what a
nonzero difference means and points at this correction.

### 6. The same ratio restated in a sibling document, and where its superseded wording is kept

A second live document printed the same floor formula and pointed at §5.1 for it, so the correction above is not
confined to this file. `docs/LAYA_RUNTIME.md` §6 read, verbatim:

> None of that substitutes for reporting coverage: a cell whose calls are mostly refused is not a cell that received
> its configured System-1 governance, and the number that says so is **`judgedPairs / (scoredPairs +
> deferredPairs)`** — the floor row, with `judgedPairs / scoredPairs` the secondary reading; `docs/FORMULAS.md` §5.1
> owns both.

It now states the floor without the ratio and points at §5.1 and at `scripts/cell-report.mjs`; the sentence is
**edited in place** rather than appended to, because it is a live statement of a current fact whose own source of
truth is this section — and the superseded wording is the quotation above, kept here rather than in that document,
which has no dated section of its own. `docs/CONTROL_PLANE_LOGGING.md`'s neighbouring sentence (*"`scoredPairs`,
`judgedPairs` and `deferredPairs` are three numbers rather than one ratio"*) is **not** affected and is left as
written: it states that the three exist separately, which is true, and it points here for their definitions.

### 7. Two supporting counts this correction does **not** restate, and why

Every headline figure above was recomputed from the round's own artifacts and reproduces exactly (2,211 pairs as a
complete triangle; `scoredPairs` 10,157; `judgedPairs` 9,038; `deferredPairs` 16,767; `deferredSegments` 162; 634
`noul` calls; 9,828 questions; 371 calls of exactly 20 questions; the `1,2,3,4,2,3,4,3,4,4,5,6,6,…` sequence). Two
*further* counts that circulate beside them do not, and neither is stated as fact here:

1. **"47 windows of ≥ 20 pairs"**, used to make the multiplicity (`371 / 47` = 7.9) look like the admission cap.
   Counted by the table above, the windows of ≥ 20 pairs over the round's arrivals number **165** (`i = 20..184`),
   and **47** is what that count is over the *settled prefix* (`i = 20..66`). The two ranges give 2.2 and 7.9; the
   count that the per-call distribution itself supports needs no range chosen for it, since 371 of 634 calls ran at
   the cap and 486 calls were re-asks. The occurrences of `47` and of the 7.9 beside it are in
   `packages/core/src/assoc-graph.ts`'s comment on `#taken`, which is the owner's to settle and is not edited here.
2. **"44 of those segments (23..66)"** — a source comment's own summary of the deferred tail. The range it names,
   `23..66`, contains **44** segments and its windows hold `sum(i, i = 23..66)` = **1,958** pairs, the overlap this
   correction relies on; that arithmetic is what is stated above, and the count of *segments* is the one number here
   that this snapshot's `scores` map cannot settle on its own, since it records pairs and not the order in which they
   were settled. Nothing above depends on it.

Both are reported rather than adopted: a correction that copied an unreproduced count into this document would be
the same class of defect it exists to repair, and the load-bearing claims here do not depend on either.

### Pointers

- The fix and the counters: `packages/core/src/assoc-graph.ts` — `#claim` (exclusive take, before any `await`),
  `#settle` (forward-only cursor over the settled prefix), `#release`, `countDeferredSuffix`, and the measured
  history on `#taken`.
- What the backend sends per call: the S1 client's transport guard is sized from the question count
  (`packages/s1-client/src/index.ts`), and the per-call ceiling is the policy field named in the table above.
- The round: `.s1cap-ablation/round-20261004-0233/` — `home/C2/.s1cap/rg/*.json` for the `scores` map and the four
  counters, `evidence/C2/control.jsonl` for the 634 calls, their per-call question counts and their timestamps.
- What the report prints and how a coverage row is assembled: `scripts/cell-report.mjs`.

## Correction 2026-10-05 (fifth) — the recall walk expands **only backwards in the append order**, and §3.2 never said so

Appended under `docs/DOC-CONTRACT.md` §4, at the foot of the four corrections above and in place of none of them.
§3.2's formula is a live statement of the current rule, so the missing clause was **added in place**; §9's row was
checked in the same pass and one of its cells carried the retired ρ claim, so that cell was corrected in place too;
§"Recall window w" had a direction clause added rather than a claim replaced. The wording as it stood is quoted
verbatim below. The same clause was added to the matching sentence in `docs/ARCHITECTURE.md`'s
"Parameter: `recall.window` = w" section and in `docs/AGENT_BRIEF.md` §3.2, each quoted in that document's own dated
update. **Two passages of this correction were overtaken later the same day** by the retirement of the per-node
expansion cap: "the filter sits before the slice" (there is no slice) and "§9's row" (there is no $k$ in it). Both
are corrected in place below with their wording quoted, and the correction on $R_d(x)$ at the foot of this document
is what supersedes them.

### What moved

`AssociationGraph.recall()` expands only into segments **earlier in the session's append order**
(`packages/core/src/assoc-graph.ts`): one filter, `isBackwardStep(from, to) => to < from`, applied to every
neighbour, over positions read from `#at` — `id -> its index in #order`, the same index `unjudgedWithin` reads, so
"older" has one meaning in the graph. A neighbour the order does not place is **excluded**: unplaceable is not
"older", and such a node is no bridge either.

**This paragraph read — until 2026-10-05 — *"The filter sits before the slice on purpose, and that is §3.2's own $k$ talking."* §3.2 defines the bound as *per node expansion ≤ k*, so the set that is cut to $k$ has to be the set of legal expansions. Slicing first would spend a node's fanout on newer neighbours and then drop them, taking its branching below $k$ for a reason that has nothing to do with the edge weights $k$ is defined over.** It is superseded rather than wrong: it was a correct account of the build between this correction and the retirement of `k` later the same day. There is no slice any more — `recall` expands into every neighbour over $\tau$ that lies earlier in the order — so the ordering question the paragraph answered no longer arises, and the direction filter's placement is now simply "it is a condition on the candidate, like the threshold beside it" (`packages/core/src/assoc-graph.ts` states it there).

**What did not move, and must not be "corrected" with it.** `neighbors()` is still symmetric and `upsertEdge` still
indexes an edge in both directions: a stored pair is **one score for an undirected relation**, which is an honest
reading of "this pair has a score" and is why the adjacency was left alone. The direction lives in the *walk*. The
recall signature is unchanged by the direction rule — it takes `threshold`, `depth`, `lambdaMs` and `now`, and the
cap that used to be a fifth option is retired — so the direction is not a new option, field or knob.

### Why §3.2 had to change

As written the formula quantified over `∃ x → ⋯ → h` with no constraint on the step, so it denoted the *forward*
paths the measurement below counts. The rule is the user's — a segment recalls earlier segments, never later ones —
so the missing clause is what makes the other three clauses of §3.2 mean what the section says they mean, rather
than being true only where the walk happened to go backwards.

### Measured, from round `20261004-0233`'s own record (cell C2, unedited)

Reproducible read-only with `cd s1cap && node --experimental-strip-types packages/core/test/forward-edge-audit.ts`
(the round's `recallTree` records against its RG snapshot's `order`; 185 segments, 22 walks with a non-empty tree):

| | tree edges | FORWARD (child newer than parent) | largest jump |
| --- | --- | --- | --- |
| recorded, unedited | 540 | **255 (47.2 %)** | idx 1 → 28 |
| re-run on the fixed build | 360 | **0 (0.0 %)** | none |

Of the recorded 255, **123 pointed at a child after the anchor** — segments that did not exist when that walk ran,
reachable only by a forward step (135 edges went into a child after the anchor in all). The change is **not a pure
prune**: the re-run of that day reached **20 hits the record never reached** — older nodes the per-node cap had
crowded out — while **200 recorded nodes were no longer reached**, and `candidates` read 540 against 360.

**Those two re-run numbers moved when the cap was retired later the same day, and the movement is the cost table's
own prediction arriving on a recorded round.** With no cap the same audit reads **400** tree nodes and edges,
**180** recorded nodes no longer reached, and `candidates` 540 against **400** — the walk places **40 more** nodes
than the capped re-run did, which is the "+27 median / +69 worst" growth measured on `20261004-1239` showing up as
**+40 on this round's 22 walks**. The forward count is unchanged at **0 (0.0 %)**: uncapping widened the walk, it did
not reintroduce a forward step. The recorded column (540 edges, 255 forward, 47.2 %) is untouched — the round is on
disk unedited. Reproduce both readings by running the audit against a build with and without the cap; the current
output is the uncapped one.

### §9's row, checked rather than assumed

$O(k^d)$ **was** an upper bound when this was written — at most $k$ expansions per node over at most $d$ levels — so
the value needed no change that day and was left exactly as written. The row's *note* cell did need one: it read
*"budget truncation"*, which restated the retired ρ claim corrected earlier today (§3.2's old *"truncated early by
the budget"*), not a property of $d$ and $k$. It then said the walk is bounded by $d$ and $k$, with nothing
truncating it on tokens.

**That row has since been rewritten again, and the reason is this document's own later correction:** `k` was
retired hours after this paragraph was written, so the cell this paragraph describes no longer exists. §9's BFS-recall
row now reads $O(n^d)$ over $n = |S|$ with its note naming $\tau$, the append-order direction and $d$ — see the
correction on $R_d(x)$ at the foot of this document. The wording above is kept because it is what this correction
decided at the time; the cell it decided about has been superseded, not this reasoning.

### The superseded wording, verbatim

1. §3.2's formula, with no direction constraint — *"$R_d(x) = \big\{ h \in S : \exists\, x \to \cdots \to h,\ \text{path length} \le d,\ \text{per edge } w_{\mathrm{eff}} > \tau,\ \text{per node expansion} \le k \big\}$"*.
2. §9's note cell — *"budget truncation"*.

**The two sentences of §"Recall window w" that the clause was added to.** Neither claim was replaced — *reachable by
the bounded BFS* and *still traversed and recalled* are both true of every pair `w` leaves in place — but each could
be read as symmetric reachability, which is the half the walk does not have:

> … segments that fall out of the window keep every edge they already have and remain reachable by the bounded BFS
> (`recall.depth = d`, `recall.threshold = r`). **w decides whether a pair is scored; it never decides what exists
> in the graph.**

> … and segments outside the window are still traversed and recalled: they keep every edge they already have
> (`packages/core/src/observer.ts`: "Segments outside the window keep their edges and stay reachable").

### Pointers

- The direction rule and the walk: `packages/core/src/assoc-graph.ts` — `isBackwardStep`, `#at` (the position index,
  written where `#order` is written), `recall` (the expansion, and its `via`/`depth` note), `unjudgedWithin` (the same
  position index).
- The audit and the fixtures: `packages/core/test/forward-edge-audit.ts` (reads a round, writes nothing) and
  `packages/core/test/recall-direction.test.ts`.
- The round: `.s1cap-ablation/round-20261004-0233/` — `evidence/C2/control.jsonl` for the `recallTree` records,
  `home/C2/.s1cap/rg/*.json` for `order`, the edges and the scores behind them.

## Correction 2026-10-05 (sixth) — a sum of two counters is not the offered window: §5.1's floor is the **distinct pairs settled over `Σ min(i,w)`**, and the first-refusal index `k` has no solution once the deferral recovers

Appended under `docs/DOC-CONTRACT.md` §4, at the foot of the five corrections above and in place of none of them.
§5.1 is a live rules section, so its coverage definition was made precise and the one dated note inside it that
still named a sum of counters was corrected in place; the wording both carried is quoted verbatim below. **The sum
is falsified in both directions — by a run whose walk recovered and by a run whose walk stopped — which is what makes
the counter's own meaning the finding rather than either round.**

### The measurement that falsifies it

Round `20261004-1211`, cell C2 (the only cell with a System-1 lane), read from its own
`home/C2/.s1cap/rg/*.json` and `evidence/C2/control.jsonl`:

| quantity | value |
| --- | --- |
| segments in the arrival order (`order`) | 40 |
| cursor (`scored`) | **40 of 40** — the walk caught up completely |
| `scoredPairs` | 780 = 40 × 39 / 2 |
| distinct pairs in the `scores` map | **780** — a complete triangle, every pair once, no holes |
| `judgedPairs` | 780 |
| `deferredPairs` | 212 |
| `deferredSegments` | 8 |
| offered window, $\sum_{i=1}^{39}\min(i, 1024)$ | **780** (`w = 1024` never bound) |
| `s1_call` records | 58, all `ok`, 0 refused, 0 timeouts, 780 questions |

The report of that round printed the floor as **78.6 %**. The honest ratio is **100 %** — 780 distinct pairs settled
against 780 offered. The two counters are **not additive, and on this round their sum exceeds what the session ever
contained**:

```
scoredPairs + deferredPairs = 780 + 212 = 992   >   780 offered
```

### Why — the mechanism, which is the part to carry forward

`deferredPairs` is written by `countDeferredSuffix` + `#deferralCounted` (`packages/core/src/assoc-graph.ts`): it
counts **the entire tail from the first refusal, once**, and is idempotent from then on. **It does not decrease when
the deferred pairs are later scored.** On this round the cursor reached **40 of 40** — every deferred pair was
recovered and scored, and `scores` holds all 780 of them — while `deferredPairs` still counts all 212. So the two
counters **double-count exactly the recovered deferrals**, and their sum **cannot** be bounded by the offered count
whenever a deferral recovers. The counter was designed to answer *"how much of the session had not been offered when
the first refusal landed"* — a historical fact — and it is being read as a live coverage term, which it is not.

**And the 212 are a suffix of an earlier, shorter order, not of this one.** The two counters are jointly consistent
with exactly one reading. A contiguous tail of 8 segments (that is `deferredSegments`) whose windows hold 212 pairs
has the single solution $k = 23$ over an order of $m = 31$ — $\sum_{i=23}^{30} i = 212$, and $31 - 23 = 8$ — so the
count was taken when the order held **31** segments, with the first refusal landing at index 23. The final order
holds 40: its 8-segment suffix ($k = 32$) is 284, and **no** $k$ of the final 40 gives 212 at all.

### The same formula breaks the other way in the round before it

Round `20261004-0233`, cell C2: `scoredPairs` 10 157, `deferredPairs` 16 767, offered 17 020, cursor **67 of 185**.
There the tail was largely *never* recovered, so the sum (26 924) overshoots for the opposite reason: the cursor
stopped, 1 958 pairs are counted in **both** counters (segments 23…66, deferred by the first refusal and scored
afterwards), and `scoredPairs` counts every re-offer besides. **Both rounds break the same formula, and neither
break is a defect in the graph.** A run that recovers and a run that stops are both normal; what is not is reading
the counter as coverage.

### What the floor is now, and what "settled" means

§5.1 above states it live; the two points this correction adds to its wording are the definition of the numerator
and the provenance of the denominator:

1. **Settled = the graph holds a score for the pair.** The numerator is the number of distinct entries in the
   graph's `scores` map — one entry per **unordered** pair, because the pair is stored once with the older segment
   first, so the storage is triangular and the map cannot hold a pair twice. It is not `judgedPairs` (which counts
   what the backend answered out of what it was *shown*) and it is not `scoredPairs` (which counts offers, and
   counts a re-offer again).
2. **The denominator is the offered window, $\sum_{i=1}^{N-1}\min(i,w)$, and `w` is not in the snapshot.** A report
   reads `w` from the run's own `kind:"wiring"` record — the field `recall.window`, which is what `scoreNew` is
   actually called with (`packages/dsh-plugin/src/step-observer.ts`) — and falls back to the `window:<w>;<scorer>`
   provenance the graph writes on its edges. Where neither carries a single value the offered window **is not
   derivable**, and the report says so: an absent number is the correct output there, because the only other option
   is a number over a denominator nobody recorded.

A settled pair is not always a pair System-1 judged: the same entry's `source` says `s1-noul` or `lexical`, so the
floor is printed with the secondary ratio and with the settled pairs' split by scorer rather than instead of them.
**A cell with no lane stays undefined** — its local fallback settles pairs the lane never saw, so a floor over
settled pairs would read 1.00 for a control arm, which is the failure mode the undefined reading exists to prevent.

### The first-refusal index `k` is derivable only while the deferral is terminal

Round `20261004-1153`'s own `DEFECT-GATE.md` (frozen) pre-registered, of `deferredPairs`: *"This round will report
it beside the first-refusal index `k`"* — solve $\sum_{i=k}^{N-1}\min(i,w) = \mathrm{deferredPairs}$ for `k`. **On
round `20261004-1211` that equation has no solution.** With $N = 40$ and $w = 1024$,
$\sum_{i=k}^{39} i = 780 - k(k-1)/2$; setting it to 212 gives $k(k-1) = 1136$, which is not a product of consecutive
integers (33 × 34 = 1122, 34 × 35 = 1190). The cause is the mechanism above: the tail was recovered, so
`deferredPairs` is no longer any suffix sum of the final $N$. The rule §5.1 now states, and
`scripts/cell-report.mjs` implements: **`k` is derivable only while the deferral is terminal** — the counted tail is
still the session's tail — and **a round whose cursor reaches $N$ has no `k`**, because every pair it counts has
since been settled. A pre-registered check that silently cannot be computed is worse than one that reports its own
precondition, so the report prints the index when the equation solves it on a deferral that is still terminal, and
otherwise the reason it does not.

### The superseded wording, verbatim

1. The blockquote *"Why the floor moved to the second denominator (2026-10-02)"* of §5.1 (its line 320 as it then
   stood) ends: *"The floor is therefore stated over the pairs the arrival order offered, `scoredPairs +
   deferredPairs`, and `judgedPairs/scoredPairs` is kept as the secondary reading it always was: the share of what
   the backend was *shown* that it answered."* — the move off `judgedPairs/scoredPairs` was right and is kept; the
   denominator it named is not a pair count of the offered window, and the note now points at the formula above.
2. The same blockquote's closing sentence named the report's rows (its line 323 as it then stood): *"`scripts/cell-report.mjs`
   prints both ratios, the deferral share, and the deferred count beside every coverage figure, in the markdown and
   in the machine-readable CSV (`System-1 coverage (judged/(scored+deferred))`, `deferred share of offered`)."* —
   the CSV row label it quotes is gone from the script, which now carries the floor ratio, the offered window, the
   distinct settled count with its scorer split, and the first-refusal index `k`.
3. The sentence §5.1 carried two paragraphs above it — *"Where a cell has no lane, coverage is **undefined** rather
   than 0: `judgedPairs` is 0 because the backend was never asked, which is a different claim from a backend that
   judged none of what it was shown."* — is **not** superseded (the reading is unchanged) and was extended in place:
   a lane-absent cell's fallback settles pairs, so the floor must not be applied to it for a reason of its own.
4. The doc comment on `AssociationGraph.deferredPairs` (`packages/core/src/assoc-graph.ts`) was named by the fourth
   correction of today as a source sentence that still asserted the sum; that sentence had already been replaced,
   and the comment now carries this round's recovery case beside the earlier round's stopped one.

### Pointers

- The counters and the counting: `packages/core/src/assoc-graph.ts` — `countDeferredSuffix`, `deferSegment`,
  `#deferralCounted`, `#claim` / `#settle` / `#release`, `snapshot()`, and the measured history on `deferredPairs`.
- The floor, its rows, its not-derivable cases and the `k` row: `scripts/cell-report.mjs` (`coverageFor`,
  `findWindowEvidence`, `offeredWindowPairs`, `settledPairStats`, `firstRefusalIndex`), pinned by its `--self-test`
  — including a fixture whose cursor reaches `N` over a complete triangle, which is this round's shape in miniature.
- The rounds: `.s1cap-ablation/round-20261004-1211/` — `home/C2/.s1cap/rg/*.json` for `order`, `scored`, the four
  counters and the 780-entry `scores` map; `evidence/C2/control.jsonl` for the 58 calls. And
  `.s1cap-ablation/round-20261004-0233/` for the stopped-walk reading of the same counters.
- What a run was configured as, which is where `w` comes from: that round's own `home/C2/.s1cap/tape.jsonl`
  `kind:"wiring"` record (`docs/DOC-CONTRACT.md` §3).

## Correction 2026-10-05 (seventh) — the per-node expansion cap `k` is **retired**, so §3.2's fifth clause and its $O(k^d)$ bound are gone and the formula is bounded by $d$, $\tau$ and the append order

Appended under `docs/DOC-CONTRACT.md` §4, at the foot of the six corrections above and in place of none of them.
§3.2 is a live statement of the current rule, so its formula was **changed in place** — the clause removed and the
bound replaced — and the wording as it stood is quoted verbatim below. §9's BFS-recall row and the two superseded
sentences of the fifth correction were corrected in place in the same pass, each with its old wording quoted beside
it. The field itself is deleted from `AssemblyPolicy.recall` (`packages/core/src/types.ts`, which carries the
decision and the cost) and a profile or preset that still writes it is **read and reported** rather than dropped in
silence (`packages/core/src/config.ts`, `LEGACY_POLICY_KEYS`).

### What `k` was

(the key is recall.fanout in a profile — written unbackticked from here on, because `scripts/check-doc-pointers.mjs` reads a backticked path as a claim about a live field and the path is gone), an integer 1..64, default 8, carried as `"fanout": 8` by all three cell presets) was the
**per-node expansion fanout of the recall walk**: at each BFS node the walk ranked its neighbours by decayed weight
and expanded into at most the heaviest $k$ of them. It was a fifth clause of §3.2's $R_d(x)$ — *"per node expansion
≤ k"* — and the term $k$ in the worst-case bound $O(k^d)$.

### It was never in the brief

The originating brief (`prompt.txt`) mentions the per-node expansion cap **zero times**, and that is a count rather
than an impression. The brief bounds recall with exactly two things: `recall.depth` ($d$) and `recall.threshold`
($r$). It names a third recall parameter, `recall.window` ($w$), and gives it one job in its own words — it exists
**only to save System-1 calls** and **must not affect recall**, with segments outside the window staying in the graph
and remaining reachable. A per-node cap on the walk is therefore not a parameter the brief leaves to the
implementation: it is a rule about *what the walk reaches*, which is the category $d$ and $r$ own.

### It was in no record and no panel

Three places could have carried it, and none did:

- **The record.** The tape's `kind:"wiring"` record — the authority a run is read through
  (`docs/DOC-CONTRACT.md` §3) — carries `recall: {d, r, w, wait, tier1}`. There is no `k` in it, and the round
  `manifest.json` does not mention the field either. The `governance.recall` block beside it carries `d`, `r`, `w`,
  `wait`, `minRecalledShare` and `minRecalledSegments`, and no `k`.
- **The panel.** The plugin's `Tuning` surface (`packages/dsh-plugin/src/credentials.ts`) carries `depth`,
  `relevanceThreshold`, `window`, `anchorWaitMs` and `tracePlacement`. A researcher could not tune `k` from the
  settings panel, and no command-line spelling of it exists.
- **The one place it did live was the presets** — `bench/cells/C0.json`, `C1.json` and `C2.json`. And `C2.json`'s own
  `provider` note says of that file: *"treat that record [`kind:\"wiring\"`], not this file, as the authority."* So
  the parameter that decided behaviour lived only where the project says the authority is not: a value composing,
  appearing in every dump, and absent from the two surfaces that would have made it a setting.

### The measurement that falsified the argument for keeping it

The field was justified by a deduction: without $k$ a depth-2 walk reaches essentially the whole graph, which would
make `depth` meaningless. The arithmetic took the graph's mean edge degree — 37.6 — and derived
$1 + 37.6 + 37.6^2 \approx 1450 > 228$ segments. **That reasoning ignored the constraint the walk actually carries**:
every step goes into a segment *earlier in the append order* (§3.2's own clause, added earlier the same day), so a
node's forward neighbours — which are most of its neighbours, and the heaviest ones — are not candidates at all.

The simulation, run read-only on round `20261004-1239`'s **frozen** graph (`home/C2/.s1cap/rg/*.json`), walking from
**every** segment as anchor, backwards-only, at depth $d = 2$:

| | anchors | share |
| --- | --- | --- |
| reachable sets **identical** under $k = 8$ and under an unbounded $k$ | **144 of 228** | **63.2 %** |
| reachable sets **differ** | **84 of 228** | 36.8 % |

**That is what falsifies the deduction.** An unbounded depth-2 walk that reached essentially the whole graph could
not agree with a capped one on 63.2 % of anchors — if $k$ were doing the work the argument credited it with, the two
sets would differ almost everywhere. What bounds the walk is the direction rule and $\tau$; $k$ only ever bit on the
third of anchors where a node had more than eight older neighbours over $\tau$.

### The cost of removing it, recorded rather than hidden

For the **36.8 %** of anchors where the cap did bite, removing it selects **more** segments: median **+27**, worst
**+69**. The `recalled` block can therefore grow on those steps — this is a change to what the model reads, not a
no-op, and it is the reason the removal is a decision rather than a cleanup.

**And it is visible on a recorded round, which is a stronger reading than the simulation alone.** Re-running
`packages/core/test/forward-edge-audit.ts` against round `20261004-0233` — read-only, the round unedited — the
uncapped walk places **400** tree nodes where the capped one placed **360**, leaves **180** recorded nodes
unreached instead of 200, and reads `candidates` 540 against **400** instead of 360: **+40 nodes over that round's
22 walks**, the same direction and the same order of magnitude as the +27 median. **The forward count stays 0
(0.0 %)**, so uncapping widened the walk without reintroducing the defect the direction rule fixed. Both readings
are reproducible by running the audit on a build with and without the cap.

**That trade is `recall.threshold`'s now.** $r$ is the brief's own knob and it **is** in the settings panel, so
lowering $r$ is how a round asks for a smaller block. The two are not interconvertible and this is the one thing a
reader must not get wrong: $k$ capped *neighbours expanded per node*, while $r$ drops *candidate edges by
relevance*. There is no formula that turns an old $k$ into an $r$; a round re-tunes the block size it wants.

### For the round it was measured in, nothing changes

In `round-20261004-1239` the walk returned `candidates = 0` from invocation 9 onward: the System-1 lane was **4.6×**
too slow to score the pairs, so the tail had no edges. `fanout` therefore had **no effect on any number that round
recorded**. Removing it changes the design, not that round's data. The rounds that ran with it
(`20261004-0233`, `20261004-1211`, `20261004-1239` and earlier) stay readable and unedited: the field is gone from
the policy, the presets' `_meta` notes record the removal beside what the round wrote, and nothing in this change
rewrites a round directory.

### The superseded wording, verbatim

1. §3.2's formula — *"$R_d(x) = \big\{ h \in S : \exists\, x \to \cdots \to h,\ \text{path length} \le d,\ \text{each step into a segment earlier in append order},\ \text{per edge } w_{\mathrm{eff}} > \tau,\ \text{per node expansion} \le k \big\}$"* → the clause is removed and the formula now ends *"no per-node expansion cap"*.
2. §3.2's bound — *"Worst case $O(k^d)$."* → replaced by $O(n^d)$ over $n = |S|$, with the practical bound stated as $\tau$, the append-order direction and $d$.
3. §3.2's signature sentence — *"The direction is not a knob: `recall(seeds, {threshold, depth, fanout})` is the signature it has always been"* → the signature is `recall(seeds, {threshold, depth})`; the direction is still not a knob, and the cap it named is retired.
4. §3.2's slice sentence — *"The filter is applied before the fanout cut, so the $k$ above counts expansions into earlier segments: slicing first would spend a node's fanout on newer neighbours and quietly take its branching below $k$."* → there is no cut and no slice: `recall` expands into every neighbour over $\tau$ that lies earlier in the order (`packages/core/src/assoc-graph.ts`).
5. The notation table's row — *"| $\tau,\ d,\ k$ | Association threshold / BFS depth / per-node expansion limit (`recall.threshold`, `recall.depth`, recall.fanout) |"* → $k$ is out of the row, and the symbol table's opening line no longer lists it among the defaults column's history.
6. §9's BFS-recall row — *"| BFS recall | $O(k^d)$ upper bound | bounded by $d$ and $k$; nothing truncates it on tokens |"* → $O(n^d)$, with the note naming $\tau$, the direction rule and $d$.
7. The fifth correction's §9 paragraph — *"$O(k^d)$ is still an **upper** bound — at most $k$ expansions per node over at most $d$ levels — so the value needs no change and was left exactly as written."* → true of the build that day and superseded hours later; the paragraph now says so and points here.
8. The fifth correction's filter paragraph — *"The filter sits before the slice on purpose, and that is §3.2's own $k$ talking."* → superseded by the same retirement, with the paragraph's own text quoted in place.
9. `docs/ARCHITECTURE.md` §2's `e3` row — *"`recall(seeds, {threshold, depth, fanout})`, then the greedy selection with its correctness filters — no token cap"* → the signature without the cap; and §3's **Association graph (RG)** row dropped `fanout=8` from its key-parameter cell.
10. `docs/STATUS-ARCHIVE.md`'s captured config dump and module table still name the field (`threshold(window|depth|fanout)(number)` and `` `tau/depth/fanout` ``). **They are left alone on purpose**: that file is a record, `docs/DOC-CONTRACT.md` §4 forbids rewriting it, and the field was in the dump it captured — the archive is what the schema looked like then, not a claim about now.

### Pointers

- The retirement and the sentence a profile gets: `packages/core/src/config.ts` — `LEGACY_POLICY_KEYS` and
  `fanoutRetirement` (the retired path recall.fanout is the one entry with a dotted key; it is warned about, never
  rejected).
- The decision, the measurement and the cost: `packages/core/src/types.ts`, `AssemblyPolicy.recall` (where the field
  sat) and `packages/core/src/assoc-graph.ts`, `RecallOptions` / `recall` (the walk that no longer cuts).
- The presets and their dated notes: `bench/cells/C0.json`, `C1.json`, `C2.json` — each `_meta` carries a
  `recallFanoutRemoved` line recording the removal and what the round it ran in wrote.
- The walk's own tests: `packages/core/test/core.test.ts` (the case that pinned the strongest-k cut was **wrong, not
  stale**, and is replaced by one that pins "no cap"), `packages/core/test/recall-direction.test.ts` (the count that
  moved), `packages/core/test/forward-edge-audit.ts` (the read-only audit whose header no longer prints a `k`).
- The round the measurement was taken on: `.s1cap-ablation/round-20261004-1239/` — `home/C2/.s1cap/rg/*.json` for
  the frozen graph. Read-only; nothing in this change writes to a round.

## Correction 2026-10-05 (eighth) — `recall.window` is **16**, not 1024, and `recall.depth` is **16**, not 2: a window the session never reaches is not a window, and the `O(turns × w)` claim holds only once `i > w`

Appended under `docs/DOC-CONTRACT.md` §4, at the foot of the seven corrections above and in place of none of them.
The *Recall window w* section is a live statement of the current rule, so its cost paragraph was **changed in place**
— the framing, the table and the `O()` claim — and the wording as it stood is quoted verbatim below. The defaults and
both validator bounds are `defaultPolicy()` and `NUMBER_RULES` (`packages/core/src/types.ts`,
`packages/core/src/config.ts`); the cells that inherit them and the panel whose floor moved with them are pointed at
at the end. Date of the decision and of every measurement below: **2026-10-05**.

### What moved

| | was | is |
| --- | --- | --- |
| `defaultPolicy().recall.window` (`recall.window`, w) | 1024 | **16** |
| `defaultPolicy().recall.depth` (`recall.depth`, d) | 2 | **16** |
| `NUMBER_RULES` for `recall.window` | `min 64`, max 1048576 | **`min 4`**, max 1048576 |
| `NUMBER_RULES` for `recall.depth` | 1..6 | 1..**16** |

Nothing else about the recall block moved: `recall.threshold` stays 0.55, `recall.anchorWaitMs` is untouched, no
field is added, renamed or removed, and the walk's own rule (§3.2) is unchanged. The three cell presets carry
`"depth": 16` explicitly because they carried `"depth": 2` explicitly, and **none of them carries `window`** — the
default reaches all three, and `cellPolicy()` (`packages/core/src/types.ts`) moves neither field.

### Why: `w = 1024` against a 228-segment session is brute force, not a window

The window's whole job is the `min(i, w)` in the cost table above, and **`min(i, w) = i` for every `i < w`**. While
the session is shorter than the window, the per-segment cost is the *full-history* row: it grows with the session,
the total is the whole quadratic triangle `T(T-1)/2`, and the saving the window exists for is exactly zero. A window
that never binds **saves nothing**, which is the opposite of the reading that kept it — the brief assumed
`w = 1024` "basically covers the whole session" and treated that as the feature. Covering the whole session *is* the
defect. `w = 16` binds from segment 17 onward and makes the per-segment cost the constant 16, so the brief's own
`O(turns × w)` claim is true of it and was false of 1024.

### The measurement

Round `20261004-1239` (benchmark task, cell C2): **369.2 s of session wall (6.2 min)**, **228 segments**, and the
System-1 lane measured at **16.1 questions/s** — 5,958 questions in 369.2 s. The lane's work is
`sum_{i=1}^{N-1} min(i, w)` pairs:

| `w` | pairs (N = 228) | vs `w = 1024` | lane needs | does `w` bind? |
| --- | --- | --- | --- | --- |
| 1024 | 25,878 | 100 % | 26.7 min | **no** |
| 512 | 25,878 | 100 % | 26.7 min | **no** |
| 256 | 25,878 | 100 % | 26.7 min | **no** |
| 128 | 20,928 | 81 % | 21.6 min | yes |
| 64 | 12,512 | 48 % | 12.9 min | yes |
| 32 | 6,768 | 26 % | 7.0 min | yes |
| **16** | **3,512** | **14 %** | **3.6 min** | **yes** |

**The default it ran needed 26.7 min of lane to serve a 6.2 min session — 4.3× its budget.** That is what the round
recorded as `candidates = 0` from invocation 9 onward: the tail had no edges because the lane was still scoring the
head, so the walk found nothing to walk. At `w = 16` the same session's lane work fits in **3.6 min**, inside the
session it serves. The saving is a function of the session length before it is a function of `w` (§"How much `w`
would have to move to matter" above carries the same arithmetic at N = 185), and the earlier reading of that fact —
"`w` is not the binding constraint" — is what kept a value that bound nowhere.

### Why `d` is 16, and what the depth table does and does not say

A bounded walk reaches at most `w × d` segments back along a chain of edges that clear `tau`, so the default pair
gives **16 × 16 = 256** where the previous `w = 1024, d = 2` gave **2,048** — which, at 228 segments, was everything.
**State the trade rather than hiding it: this buys affordability at the cost of reach, and `d` is what buys the reach
back.**

**1. Scoring cost does not depend on `d` at all.** `sum_{i=1}^{N-1} min(i, w)` contains no `d`. On this round's 228
segments at `w = 16` that is **3,512 pairs = 3.6 min of lane**, against `w = 1024`'s **25,878 pairs = 26.7 min**,
whatever `d` is. Raising `d` from 8 to 16 spends **nothing** on that axis.

**2. Depth saturates on a dense graph and only matters on a sparse one.** Measured read-only on round
`20261004-1239`'s frozen graph, backwards-only, thresholds applied, averaged over all 228 anchors:

| `d` | mean reach | max reach | mean recalled tokens |
| --- | --- | --- | --- |
| 1 | 8.8 | 75 | 2,120 |
| 2 | 20.4 | 105 | 4,821 |
| 4 | 21.7 | 105 | 5,181 |
| 8 | 21.8 | 105 | 5,189 |
| 16 | 21.8 | 105 | 5,189 |

**That table shows `d` is free; it does not show `d` is useless, and it must not be quoted as if it settled the
question.** `d = 8` and `d = 16` are identical *there* because that graph was built at `w = 1024`, where two hops
already saturate it. **A `w = 16` graph is far sparser** — at most 16 neighbours per node — and on it the reach really
is `w × d`, so `d` is the only thing that extends it. Which depth that graph needs **can only be confirmed on a
`w = 16` graph, and that needs a round**; until one runs, 16 is the value of a knob that is free on the graph we have.

**3. The honest cost of 16, to be re-read when the design changes: `d` is free under eager scoring and billed under
on-demand scoring.** Today every pair inside `w` is offered to the lane as the segment arrives, so `d` changes what
recall *reaches* and not what is *scored*. Under **on-demand scoring** — score a row when a walk asks for it, a design
under discussion and **not built** — more nodes reached means more rows scored, and `d` moves from the free axis to
the billed one. The sentence exists so that when that design lands, nobody assumes `d` is still free.

### The bounds, and why they moved with the values

- **`recall.window`: `min 64` → `min 4`.** A floor is the smallest value the surface will honour, and 64 was a number
  with no source: it is not a measurement, not the panel's floor at the time (that one was copied from it) and not
  something the cost table distinguishes — `w = 64` is simply one point on the curve above, worth 48 % of the full
  triangle. It also sat below the *old default* by a factor of 16 while the interesting range turned out to be below
  it. **4 is the panel's floor** (`packages/dsh-plugin/src/credentials.ts`, which accepts `w` from the settings panel
  and `/s1-tune` at `>= 4`), so the validator and the panel now admit the same set — a profile cannot write a window
  the panel would refuse, or the reverse. The ceiling is untouched.
- **`recall.depth`: 1..6 → 1..16.** The cap exists so a profile cannot ask for a walk this build was not shaped for,
  and it was 6 because nothing needed deeper. `w = 16` gives a 16-segment reach at the old defaults; recovering reach
  by raising the window is what the measurement rejects (it is the quadratic term), so the cap moved to admit the
  value the default carries. It stays a cap: a deeper walk is still the `O(n^d)` of §9.

### What the change is not

- **Not a claim that the sparse graph is harmless.** The paragraph above beginning *"What `w` touches, and what it
  does not"* now says the
  density loss at `w = 16` is larger than at any value this project has run, and that **no recorded round measures
  it** — the two rounds examined (`20261001-1300`, `20261004-0233`) both ran a window that never bound.
- **Not a claim about the round the numbers came from.** `round-20261004-1239` recorded `w = 1024, d = 2` and its
  artifacts are unchanged: what moved is the default for the *next* round, and a round's own `kind:"wiring"` record
  remains the authority on what it ran (`docs/DOC-CONTRACT.md` §3). Rounds `20261004-0233`, `20261004-1211`,
  `20261004-1239` and earlier stay readable, and no round directory is written by this change.
- **Not a new knob, and not a second source of truth.** Two existing fields, two existing validator rules and one
  existing panel bound; the values are owned by `defaultPolicy()` and `NUMBER_RULES` and are pointed at rather than
  restated wherever a document needs them.

### The superseded wording, verbatim

1. §"Recall window w"'s derived-figures paragraph opened — *"**Derived figures:** at `T = 4096` and `w = 1024` — the code's own default for `recall.window` (`defaultPolicy()`), whose lower bound is a `NUMBER_RULES` entry in `packages/core/src/config.ts` — full history scores **8,386,560** pairs and the window scores **3,669,504**"* → `w = 1024` is now an input quoted with its arithmetic rather than the default, and the paragraph says which it is. The two figures are unchanged.
2. §"Recall window w"'s `O()` sentence — *"`w` is the System-1 scoring window only, at `O(w)` per new segment and `O(turns × w)` per session instead of the quadratic pair count"* → the same sentence now carries the condition: **it holds only once `i > w`**, i.e. only for a window below the session's segment count, and while `i < w` the session total is the full `Theta(T²)` triangle.
3. §"Recall window w"'s density paragraph — *"That loss is real and nothing in round `20261001-1300` measured it (`w = 1024` never bound there), so a run that lowers `w` must carry `fallback`, `unknownAdmitted` and `recallTree` beside it."* → the loss is now stated as larger than at any value run so far, with both rounds that ran an unbinding window named, and the requirement to carry the three fields kept.
4. The paragraph above beginning *"How much `w` would have to move to matter"* — *"read at a length rather than at the limit."* (closing the sentence *"`w` is not the binding constraint on this cost at the lengths measured so far"*) → the sentence is kept and extended: read one row further it says the old default bounded **nothing** at every length on record, at N = 185 a `w` of **16** is **−83.4 %** (2 824 pairs of 17 020), and round `20261004-1239` is what the missing row cost (4.3× the session).
5. §9's BFS-recall note — *"bounded in practice by $\tau$, by the append-order direction and by $d$; no per-node cap, and nothing truncates it on tokens"* → kept, with the depth's cost stated: free on the scoring axis while scoring is eager, billed under on-demand scoring (not built).
6. `docs/ARCHITECTURE.md`'s *"Parameter: `recall.window` = w"* row — *"| `recall.window` | w | 1024 | integer >= 1 | how many of the most recent segments a newly arrived segment is scored against |"* → the default, the rule and the "what it does" cell were corrected in place (the default is now a pointer at `defaultPolicy()`, the rule is 4..1048576, and the cell says the window binds only below the session's segment count); a dated update at the foot of that document carries the old line and the reason.
7. `docs/CELLS-RUN.md`'s head-of-document pointer paragraph (the one beginning *"Where material that used to sit in this document now lives"*, whose reference to the *stimulus-setting levers* is the passage in question) — its two bullets on `recall.window` now point at this correction for the value and the reason, and the cell table records `depth` explicitly where it was `2`.

### Pointers

- The defaults and the reasoning beside them: `packages/core/src/types.ts` — `defaultPolicy().recall` and the two
  field notes on `AssemblyPolicy.recall` (`window`, `depth`), which carry the cost table, the saturation table, the
  `w × d` reach and the eager/on-demand sentence.
- The bounds: `packages/core/src/config.ts` — `NUMBER_RULES`, `recall.window` (`min 4`) and `recall.depth`
  (`max 16`), each with the comment that says why it moved.
- The cells: `bench/cells/C0.json`, `C1.json`, `C2.json` — `"depth": 16` carried explicitly in all three; `window`
  carried by none, each with a dated `_meta.recallWindowInherited` line saying so (in `_meta` rather than at the top
  level: `scripts/check-doc-pointers.mjs` reads an unrecognised top-level preset key as a policy field the preset is
  overriding, and `_meta` is where the presets have always kept prose).
- The profile: `packages/dsh-plugin/cordis.patch.yml` — `depth: 16`, and no `window` line (it inherits, as before).
- The panel, and the floor that moved with the validator: `packages/dsh-plugin/src/credentials.ts` (`Tuning`,
  `parseTuning`, `parseTuningArgs`), `packages/dsh-plugin/src/index.ts` (`readTuningFile`, the two help strings) and
  `packages/dsh-plugin/src/client.js` (the panel's own bounds and defaults).
- The tests that pin all four facts: `packages/core/test/config.test.ts` (defaults and both bounds, in core) and
  `packages/dsh-plugin/test/credentials.test.ts` (the same four through the panel's parser).
- The round the measurement was taken on: `.s1cap-ablation/round-20261004-1239/` — its `kind:"wiring"` record and
  `home/C2/.s1cap/rg/*.json`. Read-only.


## Correction 2026-10-05 (ninth) — scoring is **on demand**: a pair is bought when a walk asks for the row that holds it, "`d` is free" is over, and §5.1's floor falls **by construction**

**The change, in one paragraph.** Scoring used to be *eager*: the upkeep queue called `scoreNew` for every session
event it folded in, so every segment was scored against its `w` predecessors as it arrived, oldest first, whatever any
walk would later need. It is now *on demand*: `AssociationGraph.recallDemand` is the same walk `recall` runs —
one implementation, `#walkLevel`, shared by both — with one thing added per level. Before a level is expanded, the
walk asks for the rows of the nodes it stands on and cannot answer from what the graph already holds; the answer is
written through the same exclusive claim `scoreNew` uses (`#offer` → `#settle`/`#release`), so a walk and a sweep over
one graph can never be handed the same entry. A node whose row leaves it with no neighbour above `$\tau$` produces no
children, so no row behind it is ever asked for — **the branch is not computed**, which is the user's rule stated as
code. The wiring is at `packages/dsh-plugin/src/step-observer.ts`: the queue handler no longer scores at all (it
ingests), the step's `beforeAssemble` starts the walk and watches its first level, and `recall.anchorWaitMs` is the
deadline the demands are issued under. `0` disables the *waiting*, not the recall; a cell with `recall.tier1: 'off'`
demands nothing, because it has no recall to serve.

**What the saving is, measured rather than argued.** Read-only, on round `20261004-1458`'s frozen graph (170 segments,
`w = 16` — inferred exactly, because that snapshot's `scoredPairs` is `$\sum_{i=1}^{169}\min(i,16) = 2\,584$` —
`$\tau = 0.55$`, `d = 16`, and the round's own 19 assemblies / 18 distinct `recallTree` roots, i.e. **8.9
segments per step**). `packages/core/test/on-demand-saving.ts` reproduces every number below:

| | rows | pairs | against eager |
|---|---|---|---|
| EAGER (`$\sum_{i=1}^{N-1}\min(i,w)$`, arithmetic from N and w) | 169 | 2,584 | — |
| LAZY, **upper bound** (the union over *every* segment as an anchor) | 169 | 2,584 | **0 %** |
| LAZY, the round's own 18 anchors, `$\tau = 0.55$` | 164 | 2,504 | −3.1 % |
| LAZY, same anchors, `$\tau = 0.60$` | 66 | 941 | −63.6 % |
| LAZY, same anchors, `$\tau = 0.70$` | 18 | 263 | −89.8 % |

**The upper bound is the degenerate case and it is not unlikely.** When recalls are as numerous as segments the walk
roots at nearly every segment and the union of its demands *is* the arrival order: 0 % saved. At this round's 8.9
segments per step the volume saving at today's `$\tau$` is 3.1 %, because `$\tau = 0.55$` is the median of that round's
score distribution, half of all pairs are edges, the graph is 46 % dense and the walk spreads to nearly all of it
(mean reach 85.5 of 169). **The saving is a function of the threshold, and it is reported at a stricter one because
that is where the user is going: −63.6 % at 0.60, −89.8 % at 0.70.** A saving quoted only at 0.55 would be the
pessimistic end of a parameter that is about to move.

**The order half is separate, and it does not shrink with the volume half.** Eager scoring walks the append order from
its oldest unsettled entry; a step's walk is rooted on the newest input event and expands backwards. On the same
round, the pairs an eager pass must buy **before it reaches one step's anchor** are p50 **1,784**, p90 2,408, max
2,536 (23,487 across the 19 steps), while the walk's first row is the anchor's own — 16 pairs, one call, at every
step. Measured on round `20261004-1239` the same asymmetry is what emptied the recall block: the lane was 4.6x too
slow, it spent its time on the oldest rows, and 19 of 26 assemblies found `candidates = 0`. A session with low
segments-per-step therefore keeps the order half even where the volume half is small.

**`d` is no longer free, and this is the sentence the previous correction left open.** Under eager scoring the pair
count `$\sum \min(i,w)$` contained no `d`; under on-demand scoring a deeper walk reaches more nodes, each reached node
is a row, and each row is `$\min(\text{index}, w)$` pairs. On the same frozen graph, the rows/pairs the walks demand
at each depth: `d = 1` → 18 rows / 263 pairs, `d = 2` → 100 / 1,480, `d = 4` → 155 / 2,360, `d = 8` and `d = 16` →
164 / 2,504 (at `$\tau = 0.55$`); at `$\tau = 0.60$` → 18 / 263, 49 / 669, 66 / 941, 66 / 941, 66 / 941. Depth
saturates once the walk has reached the whole graph; how fast it saturates is the threshold's business. **What did not
move is the reach:** `w` still decides only whether a pair exists and `d` still bounds how far a chain of edges above
`$\tau$` is followed.

**What the change does to §5.1's floor, which is the number a round reads first.** The floor is
`distinct pairs settled / $\sum_{i=1}^{N-1}\min(i,w)$`. Under on-demand scoring a pair nobody demanded is never
settled, so **the floor falls by construction** — on round `20261004-1458` it would read 2,504/2,584 = 96.9 % at
`$\tau = 0.55$` and 941/2,584 = 36.4 % at `$\tau = 0.60$`, against the 100 % eager scoring produced. That is not a
regression and must not be read as one: the denominator is the *arrival order's* offer, and the numerator is now the
set the walks asked for. **The honest reading of the floor under this design is "the share of the arrival order that
the recalls actually demanded"**, and the lane's health is read beside it from two numbers that did not exist before:
`demandMissedPairs` (pairs a walk asked for and no backend answered — the reach a failing backend cost the step, per
entry, carried in the snapshot as `demandMissedPairs`) and the ratio `judgedPairs / demandPairs`. A round that wants
"was any pair paid for and lost" reads those two; a round that reads the floor alone would see a *lower* number for a
*better* run, which is exactly the misreading this paragraph exists to prevent.

**Latency, as a distribution rather than a mean.** A step waits for **one call** — its anchor's row is the walk's
first level, and a row at `w = 16` is at most 16 questions against `s1.questionsPerCall = 20`, i.e. exactly one
request — so the step's own wait is that call plus the 50 ms poll granularity, bounded by `recall.anchorWaitMs`.
On round `20261004-1458`'s own 169 answered calls that is p50 **753 ms**, p90 **1,093 ms**, max 1,482 ms. Everything
the walk buys after the first level lands in the background, and **a row is bought once**: a row an earlier step's
walk already scored is not re-asked, so the lane's cost across a session is the *union* of the walks' rows, not their
sum. On that round the union is 164 calls (≈ p50 118.7 s / p90 123.7 s of lane at the round's own latency
distribution) against the 169 calls / 122.4 s the eager pass actually spent — the same total, spent in a different
order. Per step, the rows a walk demands are p50 6 / p90 16 / max 54 *newly bought*; the rest of what it reaches is a
local check against `scores` and costs no call at all.

**One falsified label, recorded because it was quoted.** The simulation table this change was commissioned from
labelled "round `20261004-1458`'s frozen graph: EAGER 228 rows, 25,878 pairs" — those are round **`20261004-1239`**'s
numbers (228 segments at `w = 1024`, `$\sum_{i=1}^{227}\min(i,1024) = 25{,}878$`). Round `1458` is 170 segments at
`w = 16` and 2,584 pairs, as the table above measures. The qualitative finding — the union over every anchor is the
eager cost — survives and is now measured on both graphs. **A lazy figure cannot be recovered from round `1239`'s
artifacts at all**: its graph holds 5,565 graded pairs, a complete triangle over segments 0..105, so a walk from any
anchor above index 106 has no edges to expand and a walk below it is measured on a graph that round never finished.
What is exact there is the eager cost and the upper bound, both arithmetic.

### Pointers

- The mechanism: `packages/core/src/assoc-graph.ts` — `recallDemand`, `#claimNeeded`, `#demandLevel`, `#walkLevel`,
  `#record`; `packages/dsh-plugin/src/step-observer.ts` — the queue handler, `demandWalk`, `scoreDemandedRows`,
  `waitForAnchorRow`, and the `recall-demand` tape line a round reads the rows/pairs/judged/missed from.
- The measurement: `packages/core/test/on-demand-saving.ts` (read-only; usage in its header) and the equality,
  order, dead-end, `d`-billing, threshold, stranding and budget tests in `packages/core/test/on-demand-recall.test.ts`.
- The values: `packages/core/src/types.ts` — `AssemblyPolicy.recall` (`window`, `anchorWaitMs`, `depth`), which carry
  the tables this correction summarizes.
- A round's own authority: `.s1cap-ablation/round-20261004-1458/` (`home/C2/.s1cap/rg/*.json`,
  `evidence/C2/control.jsonl`) and `.s1cap-ablation/round-20261004-1239/`. Both read-only; neither was edited.

---

## Correction 2026-10-05 (tenth) — the recalled block moved behind the tail: a cache fix **inside $x$**, and the paper's arm is unchanged

Appended under `docs/DOC-CONTRACT.md` §4, at the foot of the nine corrections above and in place of none of them.
§3.4 is a live formula section and §6's cache rules are live design prose, so §3.4's formula, its "Strongest first"
bullet and §6's block-grouping rule were **corrected in place**, and the wording as it stood is carried here verbatim —
the same reason the first correction of today gives: a rule sheet that prints an order the build no longer produces
sends the next reader to the wrong layout. What a round recorded is that round's record and is left as written.

### What moved

The recalled block now sits **immediately before the anchor**, behind the tail. It used to be third of five, with
`tail` and `anchor` behind it, which is what §3.4's formula said and what every cell recorded until today. The block
order each `tracePlacement` value produces is the table in `packages/core/src/assembler.ts`'s header, and
`AssemblyLayout.order` (`packages/core/src/types.ts`) is the statement of record; neither is restated as a rule here.

### Why this is not a move of the paper's variable

The variable is where the trace $T$ sits relative to the long context $x$ — the paper's two arms are $[T, x, q]$ (Trace
as State) and $[x, T, q]$ (Trace Append), order the only difference — and the recalled block **is part of that long
context**, which is how `AssemblyLayout.order` reads the layout: `anchor` is $q$, the pinned prefix is not context, and
the blocks between them are the long context the trace is placed around
(`packages/dsh-plugin/src/context-delivery.ts`: "the long context here is the `recalled` block"). So a block that moves
*inside* $x$ leaves $T$'s side of it untouched: $T$ is still ahead of every block of $x$ under `'trace-as-state'` and
behind all of them under `'trace-append'`. **No arm moved, and §3.4's `[T, x, q]` reading of the formula is unchanged**
— what changed inside it is the order of the two blocks that make up $x$.

### Why the block moved — the arithmetic is the cache's

A prompt cache is a prefix cache: a change at any token breaks the match from that token to the end of the prompt, so
anything placed behind a block that changes every step is invalidated with it. The recalled block is the block a
re-selection moves (§6's `reselectPolicy` rule freezes it per task, and it still changes when the task's selection
does); ending $x$ with it means a re-selection costs the question and nothing else. **Measured on round
`20261004-1458` C2**: the whole-prompt invalidation span per delivered pair fell from **2,539 to 2,111 tokens** with
this move, on top of the ordering change that had already cut it from **6,179 to 2,539**. `AssemblyResult.cacheStability`
computes the stable head from the laid-out order rather than assuming it, so it reads the new order without a change of
its own.

### The superseded wording, verbatim

1. §3.4's formula, which read:

   $$
   \mathrm{prompt} = \big[\,P \,\|\, T_{\mathrm{state}} \,\|\, \operatorname{sort}_{w_{\mathrm{eff}} \downarrow}(R') \,\|\, \mathrm{tail}_K \,\|\, x\,\big]
   $$

   The two middle terms are swapped: $\mathrm{tail}_K$ now precedes the recalled block, which is the last block
   before $x$.
2. §3.4's **Strongest first** bullet — *"recall blocks are ordered by descending $w_{\mathrm{eff}}$ plus the
   recent-tail verbatim turns at the end, forming a U-shaped attention layout (echoing *Lost in the Middle*)"*. The
   within-block order is unchanged; the recent-tail turns no longer sit at the end of the remembered material.
3. §6's cache rule — *"Put the **large stable material first** (pinned prefix, state proxy $T$, selected blocks) and
   the **small volatile material last** (recent tail, $x$): a mid-prompt re-selection then invalidates only a few k
   tokens instead of the whole suffix."* The rule stands as written and the parenthetical added beside it names what
   the layout now does: the recalled block sits second-to-last, in front of $x$ only, so a re-selection invalidates
   the question and nothing else — the arrangement the rule is reaching for.

### What this correction does not touch

The **round records** this document quotes — round `20261004-0233`'s own `layoutOrder` records, and every figure read
off a round's own artifacts — are data from those rounds and keep their wording. In particular the correction above
("one layout field was renamed and the second was **deleted**") also records the orders those rounds produced, and its
`C1`/`C2` string stays as that round's evidence: the old order it names is no longer producible, which is the same
statement the code's `AssemblyLayout.order` makes.



