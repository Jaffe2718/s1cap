# Related-Work Dossier (verified)

**Verification date:** 2026-09-27/28. Every entry below was verified via the official arXiv API (batched `export.arxiv.org` queries), a fetched repo/site page, or npm registry metadata. Numbers quoted come from fetched abstracts/pages. Unverified items are listed at the end — do not cite them without fetching first.

This dossier serves paper §2 and the novelty audit. Axes: **(a)** association graph over agent-trace segments; **(b)** per-turn selection/assembly of context inside an agent loop; **(c)** pre-ranking of candidate action plans; **(d)** prompt-cache/latency telemetry.

## 1. Agent memory & context management

| name | exact title | first author | year | arXiv | URL | mechanism 1-line |
|---|---|---|---|---|---|---|
| MemGPT | MemGPT: Towards LLMs as Operating Systems | Charles Packer | 2023 | 2310.08560 | https://arxiv.org/abs/2310.08560 | OS-inspired virtual context: the LLM self-manages memory tiers via interrupts |
| Letta | (lab/product, not a paper — MemGPT creators) | — | 2024– | — | https://www.letta.com | Blogs: Sleep-time Compute (2025-04), Context Repositories (2026-02), Context Constitution (2026-04), Memory Models (2026-06) |
| Mem0 | Mem0: Building Production-Ready AI Agents with Scalable Long-Term Memory | Prateek Chhikara | 2025 | 2504.19413 | https://arxiv.org/abs/2504.19413 | Per-turn extraction/consolidation/retrieval of salient facts; 91% lower p95 latency vs full-context on LOCOMO |
| Zep/Graphiti | Zep: A Temporal Knowledge Graph Architecture for Agent Memory | Preston Rasmussen | 2025 | 2501.13956 | https://arxiv.org/abs/2501.13956 | Bi-temporal KG engine; hybrid cosine/BM25/graph search |
| A-Mem | A-MEM: Agentic Memory for LLM Agents | Wujiang Xu | 2025 | 2502.12110 | https://arxiv.org/abs/2502.12110 | Zettelkasten-style notes, dynamic linking, memory evolution (NeurIPS 2025) |
| HippoRAG | HippoRAG: Neurobiologically Inspired Long-Term Memory for LLMs | Bernal Jiménez Gutiérrez | 2024 | 2405.14831 | https://arxiv.org/abs/2405.14831 | Offline OpenIE KG + Personalized PageRank; single-step multi-hop retrieval 10–30× cheaper than IRCoT (NeurIPS 2024) |
| HippoRAG 2 | From RAG to Memory: Non-Parametric Continual Learning for LLMs | Bernal Jiménez Gutiérrez | 2025 | 2502.14802 | https://arxiv.org/abs/2502.14802 | PPR + deeper passage integration + online LLM use for factual/sense-making/associative memory (ICML 2025) |
| MemOS | MemOS: A Memory OS for AI System | Zhiyu Li | 2025 | 2507.03724 | https://arxiv.org/abs/2507.03724 | Memory as schedulable OS resource; MemCube unifies plaintext/activation/parameter memories |
| MESA | (query-adaptive memory-structure selection) | Beidi Zhao | 2026 | 2608.10108 | https://arxiv.org/abs/2608.10108 | Query-adaptive selection/fusion of five memory views via harness optimization (UCB); +8.5% with 41% fewer evidence tokens |
| EMem baseline | (event-centric EDU heterogeneous graph) | Sizhe Zhou | 2025 | 2511.17208 | https://arxiv.org/abs/2511.17208 | Event-centric graph for conversational memory — (a)-lite |
| AgentFold | AgentFold: Long-Horizon Web Agents with Proactive Context Management | Rui Ye | 2025 | 2510.24699 | https://arxiv.org/abs/2510.24699 | Learned per-step folding of live context (granular condensation / deep consolidation); 36.2% BrowseComp with 30B-A3B |
| RAPTOR | RAPTOR: Recursive Abstractive Processing for Tree-Organized Retrieval | Parth Sarthi | 2024 | 2401.18059 | https://arxiv.org/abs/2401.18059 | Recursive cluster+summarize tree; retrieval across abstraction levels |
| Context-eng. survey | A Survey of Context Engineering for Large Language Models | Lingrui Mei | 2025 | 2507.13334 | https://arxiv.org/abs/2507.13334 | Taxonomy over 1400+ papers; "context assembly" is the standard term for our (b) |
| GAAMA | GAAMA: Graph Augmented Associative Memory for Agents | Swarna Kamal Paul | 2026 | 2603.27910 | https://arxiv.org/abs/2603.27910 | Growing 4-node/5-edge association graph scored via kNN + edge-type-aware PPR + GRAFT repair; 79.1% LoCoMo-10 |
| ReContext | ReContext: Recursive Evidence Replay as LLM Harness for Long-Context Reasoning | Yanjun Zhao | 2026 | 2607.02509 | https://arxiv.org/abs/2607.02509 | Training-free harness: query-conditioned evidence pool replayed before generation |

## 2. Order sensitivity & rereading

| name | exact title | first author | year | arXiv | URL | mechanism 1-line |
|---|---|---|---|---|---|---|
| Lost in the Middle | Lost in the Middle: How Language Models Use Long Contexts | Nelson F. Liu | 2023 | 2307.03172 | https://arxiv.org/abs/2307.03172 | U-shaped positional bias (TACL 2023) — grounds our strongest-first recalled ordering |
| Re2 | Re-Reading Improves Reasoning in Large Language Models | Xiaohan Xu | 2023 | 2309.06275 | https://arxiv.org/abs/2309.06275 | Repeat the question for pseudo-bidirectional encoding (EMNLP 2024) |
| Trace as State | Trace as State: Reasoning Traces as Conditional States for Long-Context Transformers | Xu Zou | 2026 | 2609.02702 | https://arxiv.org/abs/2609.02702 | State proxy `T` placed BEFORE the long context on a fresh pass; 26/27 combos beat trace-append |
| Markovian Thinker | The Markovian Thinker: Architecture-Agnostic Linear Scaling of Reasoning | Milad Aghajohari | 2025 | 2510.06557 | https://arxiv.org/abs/2510.06557 | Fixed-size reasoning chunks with textual carryover state; linear compute |
| Ok & Lee | (multi-choice prompt-order gap; cited by 2609.02702) | Ok | 2026 | — | via 2609.02702 refs | Repeating options after the context partially closes the order gap |
| CoRe / Racing Thoughts | (cited by 2609.02702) | — | 2025 | — | via 2609.02702 refs | Order sensitivity and layerwise race conditions in contextualization |

## 3. Prompt compression, caching & routing

| name | exact title | first author | year | arXiv | URL | mechanism 1-line |
|---|---|---|---|---|---|---|
| LLMLingua | LLMLingua: Compressing Prompts for Accelerated Inference of LLMs | Huiqiang Jiang | 2023 | 2310.05736 | https://arxiv.org/abs/2310.05736 | Coarse-to-fine token dropping by small-LM perplexity; up to 20× compression (EMNLP 2023) |
| LLMLingua-2 | LLMLingua-2: Data Distillation for Efficient and Faithful Task-Agnostic Prompt Compression | Zhuoshi Pan | 2024 | 2403.12968 | https://arxiv.org/abs/2403.12968 | Compression as token classification on a bidirectional encoder (ACL 2024 Findings) |
| Prompt Cache | Prompt Cache: Modular Attention Reuse for Low-Latency Inference | In Gim | 2023 | 2311.04934 | https://arxiv.org/abs/2311.04934 | Schema-defined prompt modules with precomputed KV reuse; 8×(GPU)–60×(CPU) TTFT speedup (MLSys 2024) |
| CacheGen | CacheGen: KV Cache Compression and Streaming for Fast LLM Serving | Yuhan Liu | 2023 | 2310.07240 | https://arxiv.org/abs/2310.07240 | KV cache compression + streaming; 3.5–4.3× smaller (SIGCOMM'24) |
| Don't Break the Cache | Don't Break the Cache: An Evaluation of Prompt Caching for Long-Horizon Agentic Tasks | Elias Lumer | 2026 | 2601.06007 | https://arxiv.org/abs/2601.06007 | 500+ multi-turn agent sessions: 41–80% cost / 13–31% TTFT gains; cache-aware assembly (dynamic content last) beats naive caching — our H3 anchor |
| RouteLLM | RouteLLM: Learning to Route LLMs with Preference Data | Isaac Ong | 2024 | 2406.18665 | https://arxiv.org/abs/2406.18665 | Preference-trained routers pick strong vs weak LLM per query; >2× cost cut |
| FrugalGPT | FrugalGPT: How to Use Large Language Models While Reducing Cost and Improving Performance | Lingjiao Chen | 2023 | 2305.05176 | https://arxiv.org/abs/2305.05176 | Weak→strong cascade with early stopping; up to 98% cost reduction |
| Hybrid LLM | Hybrid LLM: Cost-Efficient and Quality-Aware Query Routing | Dujian Ding | 2024 | 2404.14618 | https://arxiv.org/abs/2404.14618 | Difficulty-predicting router; up to 40% fewer large-model calls (ICLR 2024) |
| Git Context Controller | GIT CONTEXT CONTROLLER: MANAGE THE CONTEXT OF LLM-BASED AGENTS LIKE GIT | — | 2025 | 2508.00031 | https://browse-export.arxiv.org/pdf/2508.00031 | Git-like versioned context management for agents |

## 4. Decision models (System One) — the new substrate

| name | what | URL | license / sizes | notes |
|---|---|---|---|---|
| Jev 1.13 | TypeSafe AI's cloud decision model; `POST /v1/systemone`; noul/choice/score; $0.042/M input, output free | https://docs.typesafe.ai/api | proprietary | JevBench #4 (63.3; 86.6% public / 36.7% sealed); documented jaggedness (math/dates/context rot/steerability; probabilities not guaranteed to sum to 1) |
| Laya | Convai Innovations' open decision models; `laya[serve]` speaks `/v1/systemone` | https://github.com/NandhaKishorM/laya | Apache-2.0; 421M / 322M multilingual / 421M typed-decisions | Near-chance zero-shot (0.362); 0.766 after fine-tune; ECE 0.466→0.081 after refit; >20-option choices fail at defaults |
| Kev | jaredpalmer's open Jev-class models (LoRA + pointer head) | https://github.com/jaredpalmer/kev | Apache-2.0; 0.8B/4B/9B/27B | `kev.serve`; 27B 0.848 vs Jev 0.857 (dev) |
| Nimble | Bespoke Labs' open Jev-class (Qwen3.5-9B LoRA) | via https://www.orcarouter.ai/blog/laya-vs-nimble | Apache-2.0; 9B | English-only, 26-option cap, uncalibrated softmax |
| JevBench | Benchmark Heaven's decision-model benchmark (4 axes; 534 public + 308 sealed) | https://www.benchmarkheaven.com/jev-models | MIT harness | Jev-class = ≤2× Jev cost and ≤2× latency |
| EdgeJev | ONNX INT8 local runtime for Laya/Kev serving `/v1/systemone` | https://github.com/yzfly/edgejev | Apache-2.0 | 322M INT8 = 324 MB, 15.6 ms/decision on 4 vCPU |

## 5. Harness-ecosystem prior art (the layer we differ from)

| project | what it does | URL | relation to us |
|---|---|---|---|
| dsh-command-context-trim | Model-free `/trim`: drops oldest least-valuable balanced span, zero LLM calls; auto-trim on `CONTEXT_WINDOW_EXCEEDED` via `prepend` on `agent/request-error` | https://github.com/snailium/dsh-command-context-trim | Our C0 baseline's spirit (heuristic, model-free); it discards, we assemble. Also our template for DSH plugin mechanics |
| pi-system-one | Registers a `system_one` **tool** the pi agent may call (Jev/Reflex/Laya backends) | https://www.npmjs.com/package/pi-system-one | *System One as a tool* (agent-in-the-loop) vs ours *as governance* (infrastructure-in-the-loop, agent-invisible) |
| hermes-jev-skills | Jev-powered routing, memory, compaction, skill selection for Hermes/Claude Code/Codex | https://github.com/kerpopule/hermes-jev-skills | Closest combination-axis prior work: Jev inside harnesses driving memory/compaction — but no association graph (a), no budgeted TAS assembly (b proper), no probability plan pre-ranking (c), no cache/latency telemetry (d); integration repo, no research evaluation |
| dsh-typesafe | Jev decision layer for DSH: typed decisions, confidence-gated routing, cost meter | https://github.com/979569650/dsh-typesafe | (c)/(d)-lite, routing-only |
| laya-jev-GraphRAG | Agentic GraphRAG with swappable System One models, A* traversal over graph DBs | https://github.com/bodepudimuneendra-netizen/laya-jev-GraphRAG | GraphRAG over documents, not agent-trace context management |
| DSH plugin hub / dshmarket | Community marketplaces (10,000+ plugins) | https://dsh-plugin.org · https://www.npmjs.com/package/dshmarket | Distribution channels for `dsh-s1cap` |

## 6. Closest-works ranking (novelty audit, Sept 2026)

1. **hermes-jev-skills** — Jev-class model inside real harnesses (memory, compaction, routing). Missing: (a) proper, (b) proper, (c) proper, (d); no research evaluation. README not fully captured — re-verify via raw.githubusercontent.com before writing the paper's related-work claim about it.
2. **GAAMA** (2603.27910) — strongest (a)+(b) *mechanics*: association graph + graph-walk relevance scoring. But embeddings+PPR scorer (not a decision model), conversational-memory QA target (not per-turn harness assembly), no (c)/(d).
3. **AgentFold** (2510.24699) — tight (b) overlap in a live agent loop, but the (fine-tuned) model itself folds its context; no external decision model, no (a)/(c)/(d).
4. **Don't Break the Cache** (2601.06007) — (d) almost exactly, and it *constrains* our (b): cache-aware assembly (dynamic content at prompt end) beats naive caching. No method, no decision model. Our H3 must cite and engage it.
5. **laya-jev-GraphRAG** — closest tooling overlap (System One models steering graph traversal), but document GraphRAG, not trace-segment context management.

**Novelty read:** no verified work combines a Jev/Laya-class decision model as the pairwise-relevance scorer over an association graph of agent-trace segments (a) + per-turn bounded-BFS/budget assembly inside a harness (b) + the same model pre-ranking candidate plans (c) + full prompt-cache/latency telemetry (d). The defensible differentiators: decision-model-as-scorer, turn-level trace-segment granularity, same-model plan ranking, and the cache-aware (a)+(b)+(c)+(d) integration. **Field velocity warning:** Jev released 2026-09-15, Laya 09-18, pi-system-one 09-22 — this window is weeks old and moving fast; the measured 2×2 + portability + versioned telemetry is the durable contribution.

## 7. UNVERIFIED — fetch before citing

- arXiv 2609.25913 "When Does Execution Provenance Help Agent Memory Retrieval?" (search hit only)
- SWE-Pruner (self-adaptive context pruning for coding agents; no arXiv id captured)
- jev-agent-design-with-topk-logit-choices (github.com/6Mikao9/...) — description mentions "decision-aware hierarchical memory, dependency-aware replanning"; conceptual overlap with (a)/(c) possible
- hermes-jev-skills / dsh-typesafe / laya-jev-GraphRAG README bodies (repo descriptions verified; fetch raw READMEs for implementation-level claims)
- Anthropic 1-hour cache-write exact multiplier ("higher rate" only)
- OpenAI pricing (mirror-sourced; official page 403'd)
- tau2-bench per-domain task counts (~280 total expected, unconfirmed)
- Whether the paper-T model "DeepSeek V4 Pro Preview" equals public `deepseek-v4-pro` (DeepSeek-V4-Pro-0813)
