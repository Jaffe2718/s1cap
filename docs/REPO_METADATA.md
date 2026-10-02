# Repository Metadata

Canonical public-facing metadata for **s1cap**. Keep every surface (GitHub About, npm, DeepSeek Harness
Plugin Hub, paper artifact listings) in sync with this file.

Paper title: *S1CAP: Context-Aware Planning via System-1 Models for Efficient LLM Agents* (acronym: **S**ystem-**1** **C**ontext-**A**ware **P**lanning)

Canonical expansion — use everywhere the acronym is spelled out: **S1CAP = System-1 Context-Aware
Planning**: cheap decision models decide (1) *which context* an LLM agent sees and (2) *in which order*
its own candidate plans run. Do not expand it as "Selective Context and Adaptive Planning" (retired with
the 2026-09-28 naming erratum).

Authors: **Yuanming Chen** · **LI Changzhe** (citation form: `Chen, Yuanming and LI, Changzhe`)

---

## 1. GitHub About description — primary (257 chars)

The ablation this names is the 2×2 crossing's run set of **three arms** (`C0`, `C1`, `C2`); the character count
below is exact, so the paste text names the set that runs — three arms, not the four-arm crossing — and the arm
count is stated here as well. The count is unchanged at **257**: the phrase that replaced the cross's name has the
same length, so the paste text can be swapped in without re-measuring the field.

```
Research artifact for S1CAP — System-1 decision models governing LLM agent context lifecycle: associative recall, Trace-as-State assembly, probability-ranked plan execution, prompt-cache-aware cost telemetry, three-arm ablation. DSH plugin + portable proxy.
```

Paste path: repo home → **About** (gear icon) → *Description*.

Why this one: leads with the honest framing (*Research artifact*), names the system, states the mechanism
(associative recall · Trace-as-State assembly · plan ranking), and carries the evidence story
(prompt-cache-aware telemetry · the three-cell ablation suite — `C0` baseline, `C1` a second control arm, `C2` the
arm under test, registered as `C0` vs `C2`) plus the deliverable (DSH plugin + portable proxy).

## 2. Alternates

**Full technical (332 chars)** — use when a longer field is available (e.g. paper artifact metadata):

```
System-1 decision models (Jev/Laya/Kev-class) as the governance layer for an LLM agent context lifecycle: growing association graph over session segments, relevance-gated recall with Trace-as-State ordering, and plan pre-ranking — measured in solve rate, cache hit/miss tokens, cost and latency. DSH plugin + harness-agnostic proxy.
```

**Concise (185 chars)** — search-result friendly:

```
System-1-governed context lifecycle for LLM agents: association-graph recall, Trace-as-State assembly, plan pre-ranking — measured in tokens, cost and time. DSH plugin + portable proxy.
```

**One-liner (172 chars)** — slide decks, README badges, chat bios:

```
Cheap System-1 decision models govern an LLM agent context lifecycle: which context to keep, in what order, and which plan to try first — measured in tokens, cost and time.
```

## 3. Topics (GitHub, max 20 — paste as-is)

```
llm-agents context-engineering agent-memory context-window prompt-caching kv-cache system-one decision-models jev laya small-language-models coding-agent deepseek-harness dsh-plugin agent-harness opencode claude-code benchmark ablation-study typescript
```

## 4. Keywords (for paper artifact / dataset listings)

`System-1 models`, `decision models`, `context lifecycle`, `context engineering`, `agent memory`,
`association graph`, `Trace as State`, `plan ranking`, `prompt caching`, `KV cache`, `Jev`, `Laya`,
`DeepSeek Harness`, `ablation study`, `agent harness`.

## 5. Surface checklist

| Surface | Field | Use section |
|---|---|---|
| GitHub repo About | Description | §1 (primary) |
| GitHub repo About | Topics | §3 |
| npm `s1cap` (proxy) | `description` | §1 or §2 concise |
| npm `dsh-s1cap` (DSH plugin) | `description` | §2 concise |
| DSH Plugin Hub / dshmarket listing | summary | §2 concise |
| Paper artifact / OpenReview metadata | abstract keywords | §4 |
