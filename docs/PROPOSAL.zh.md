# s1-governor 项目提案（人读版）

**版本** 0.1 · 2026-09-28 · 面向 Supervisor / Cooperator
**配套文档:** [AGENT_BRIEF.md](./AGENT_BRIEF.md)（投喂给编码 Agent 的完整实施规格，英文）· [RELATED_WORK.md](./RELATED_WORK.md)（全部经 URL 核验的相关工作档案）

---

## 0. 一页摘要

**一句话**：用一个比 LLM 便宜约 50–100 倍的 System-1 决策模型（decision model，Jev/Laya/Kev 类，走 `/v1/systemone` 协议）充当 LLM agent harness 的**上下文生命周期治理层**——维护会话分片的关联图（association graph）、按 Trace-as-State 顺序组装每轮上下文、在执行前给候选方案预排序——在不损失任务完成率的前提下，降低 token 成本与时延，并以完整的缓存命中/未中遥测数据说话。

**为什么是现在**：三个要素在 2026 年 9 月刚刚齐备——
1. **Trace as State**（arXiv:2609.02702，Z.ai & 清华，2026-09-02）：证明"把推理轨迹作为状态代理放在长上下文**之前**"（`[T, x, q]`）在 26/27 个组合上优于放在之后，**且无需训练**——纯推理期手段，harness 插件即可移植；
2. **决策模型品类诞生**：TypeSafe AI 的 Jev（2026-09-15，$0.042/M 输入、输出免费、问询并行评估）与开源 Laya（2026-09-18，Apache-2.0，322M/421M，本地 15.6ms/决策）——"System-1 调用"的成本从"一次 LLM 调用"降为"噪声级"；
3. **缓存经济学成为硬约束**：DeepSeek `deepseek-flash` 缓存命中价 $0.006/M vs 未中 $0.30/M（**50 倍**）——上下文怎么组装、什么能重排、什么不能，直接决定成本。

**核心假设**：H1 关联图召回能用更少的上下文 token 保持完成率；H2 方案预排序能省掉浪费的执行尝试；H3（双向风险）Trace-as-State 重排会改变缓存命中率，净效应必须被测量而不是被假设；H4 收益可跨 harness 迁移。

**成功判据（已修正，见 §5.3）**：完成率**非劣**于基线（配对 McNemar，单侧 α=0.05，容差 −2pp）**且**成本或时间改善 ≥10%（配对 bootstrap 95% CI 不含 0）。不再采用"三者占其一即成功"。

**结论预览**：评审判定 **Accept with Revisions**（值得做，待验证实验；修订点已全部吸收进本提案与 AGENT_BRIEF）。

---

## 1. 研究问题

- **RQ1**：System-1 决策模型能否在 agent 循环内以可忽略的成本完成上下文分片相关性判定与方案预排序？
- **RQ2**：Trace-as-State 的"状态前置"原则从单文档长上下文问答移植到 agent harness 后，是否仍带来质量/成本/时间收益（含缓存惩罚的净额）？
- **RQ3**：收益是否跨 harness（DSH / opencode / Claude Code / pi）与跨模型（DeepSeek / GLM）成立？

## 2. 术语规范对照表（原 prompt 用词 → 规范用词）

| 原 prompt 用词 | 规范用词 | 说明 |
|---|---|---|
| 论文T | Trace as State（arXiv:2609.02702） | 全称引用；机制是"状态代理 T 前置于长上下文"，**问题 q 始终在最后** |
| x倒置 | TAS ordering（Trace-as-State 布局） | 注意：论文 T 并非"把 x 放最前"，而是把**从轨迹提炼的状态 T 放在历史之前**、当前指令放最后；本项目采用 `[pinned \| T \| 召回块 \| 近尾原文 \| x]` |
| laya / **Jav** | **Laya** / **Jev** | Jev（TypeSafe AI）；Laya（Convai Innovations，开源）。"Jav"为笔误 |
| System 1模型 | decision model（System One） | TypeSafe 官方称 System One models；社区（Maggie Appleton）建议 decision models——论文用 "decision models (System One)" 双名 |
| Relevant Graph (RG) | association graph（关联图） | 与 GAAMA/HippoRAG 文献术语对齐 |
| Relevant Context (RC) | assembled context / context assembly | 对齐 context engineering survey（arXiv:2507.13334）标准术语 |
| bsf算法 | **BFS**（breadth-first search） | |
| 语段/分片 | segment（消息级分片） | 粒度=消息/工具调用/推理块，**永远不是 token 级** |
| deepseek-v41-flash | **`deepseek-flash`** | API 实际 model id；版本名 DeepSeek-V4.1-Flash；无 "deepseek-v4.1-flash" 这个 id |
| 做选择题 | choice question（noul/score/choice） | Jev 三种问询类型的术语 |
| 缓存命中/未中 | prompt cache hit / miss | DeepSeek 字段：`prompt_cache_hit_tokens` / `prompt_cache_miss_tokens` |
| 越权操作 | permission-gated tool calls（权限审批） | 其等待时长从时延统计中扣除 |
| 题库 | benchmark suite / task set | |
| 任务完成度 | solve rate | |

## 3. 方法论（优化后）

### 3.1 总体架构：System-1 控制平面 / System-2 计算平面

廉价决策模型作为**治理层**（governor）运行在 harness 与 LLM 之间，LLM 本体不做任何修改。组件：SEGMENTER（分片）→ RECALL（两级召回）→ RG STORE（SQLite 关联图）→ ASSEMBLER（预算内 BFS 选择 + TAS 布局）→ PLAN GATE（choice 预排序 + 尝试控制）→ TELEMETRY（版本化 JSONL 遥测）。适配层：DSH 一等插件（`dsh-s1-governor`）+ OpenAI-compatible 代理（可移植到 opencode / Claude Code / pi）。

### 3.2 相对初版设计的四个关键修正

1. **两级召回替代"Laya 直接两两打分"**。核实结论：Laya 基座**零样本接近随机**（0.362 vs 随机 0.318；微调后 0.766），且 >20 选项会失败。因此：tier-0 元数据边（免费）→ tier-1 候选生成（本地嵌入 ANN，或 S1 noul 批量问询）→ tier-2 惰性验证（仅对可能进入组装的边做 score 精排）。默认云端 Jev 时 S1 成本为噪声级（每会话约 $0.04）；本地路径用 EdgeJev（322M INT8，324MB，4 核 vCPU 15.6ms/决策）或 M3 微调后的 laya-typed-decisions。
2. **"x倒置"更正为忠实的 TAS 移植**。论文 T 的可迁移原则是"晚发现的状态信息应在下一轮 pass 中先于上下文可用，**问题永远在最后**"。组装布局：`[pinned（system+工具schema，缓存稳定前缀）| T（状态代理：序列化推理轨迹+任务简报，≤8k 字符，append-only，按任务更新）| 召回块（按 w_eff 降序，最强者在前——Lost in the Middle 的 U 型）| 近尾 K 轮原文 | x+当前状态快照]`。
3. **缓存经济学作为一等公民**。命中价是未中的 1/50（DeepSeek 峰时），因此：(a) pinned 前缀永不被重排；(b) T 按任务边界更新（`perTask` 默认，`perTurn` 可选）；(c) **H3 假设显式化**——TAS 重排对命中率的净影响必须逐调用测量（引用 arXiv:2601.06007 的结论：缓存感知组装优于朴素缓存）。
4. **方案闸门加安全栏**。Jev 的概率**不保证归一**（文档示例 P+¬P=1.19）→ 服务端归一；决策模型可被对抗内容牵引 → 传入 S1 的 state 做预过滤（剥离超长代码块/URL）；尝试上限 m=2；置信度 <0.5 时弃权、回退 LLM 自身顺序。

### 3.3 DSH 原生红利（核实自本机安装与社区插件）

DSH 的会话模型是**持久化 append-only 事件日志（人类记录，永不改写）与 surface（模型视图）分离**，`surfaceOp {op:'replace'}` 允许只改模型看到的上下文——**原生满足"呈现给用户严格按时序、内部重组给模型"**。拦截点：`agent/pre-step`（LLM 调用前组装）、`agent/request-error`（waterfall + prepend）、`ctx.tokenMeter`（shadow-price 计费）、`@deepseek-ai/dsh-compaction`（工具配对完整性）。现有插件 `dsh-command-context-trim`（model-free 最旧裁剪）恰是 C1 基线的精神原型，也是插件机制的工程模板。

## 4. 实验设计

### 4.1 2×2 析因（within-task 配对）

| Cell | A：TAS ordering | B：S1 governance（召回选择+方案闸门） |
|---|---|---|
| C1 基线 | off（时序追加） | off（仅 harness 原生 compaction） |
| C2 | **on** | off |
| C3 | off | **on** |
| C4 完整 | **on** | **on** |

同任务、同模型（`deepseek-flash`，temperature=0）、同 harness 版本、同工具白名单、随机化顺序。

### 4.2 基准套件（全部自动评分，无 GUI，无 LLM 评审）

| 基准 | 规模/cell | 角色 | 状态 |
|---|---|---|---|
| SWE-bench Verified | 100（分层抽样） | issue→patch 的经典编码信号 | MIT，已核验 |
| Terminal-Bench 4.0 | 全部 66 | 长时程终端任务——DSH 主场 | Apache-2.0，Harbor 框架 |
| τ²-bench（tau2） | base 全量（约 280，M0 核实） | 多轮工具+用户交互轴 | MIT，纯 Python |

**先跑 10 任务 TB pilot 校准成本**（TB 是成本主驱动与最大不确定项：lean 假设 5M in/任务 vs 前沿规模 20–65M/任务）。排除：GAIA（浏览+多模态噪声）、TheAgentCompany（30GB+ 基建 + LLM 评审混淆）、OSWorld/WebArena（GUI）。

### 4.3 统计规程与成功判据

- 主指标 solve rate：配对 **McNemar**，非劣效（单侧 α=0.05，容差 −2pp 绝对值）；
- 次级指标 $/task、tokens/task（hit/miss/out 拆分）、wall-clock/task（净 LLM + S1 + 工具，**扣除权限审批等待**）：配对 **bootstrap**（10k 重采样）95% CI，Holm 校正；
- 成功 = 非劣 **且**（成本或时间 ≥10% 改善且 CI 不含 0）。赢成本但掉完成率 >2pp 不算赢；
- 报告全部 cell + 质量-成本 **Pareto 图** + 缓存命中率瀑布图（H3）；
- 分析脚本在首轮全量运行**之前冻结入库**（预注册式）；10% 子样本 3 seeds 估方差。

### 4.4 遥测（版本化 JSONL，字段见 AGENT_BRIEF §8）

每 LLM 调用记录 prompt/cacheHit/cacheMiss/output tokens、净时延、S1 辅助统计；每 S1 调用记录类型/成本/时延；每次组装记录候选数、选中数、BFS 深度、预算占用、布局块、缓存稳定前缀长度；方案闸门记录每个方案的概率/置信度/执行/验证/节省 token 估计。

### 4.5 泛化（消除"针对 DSH 做结果工程"的质疑）

- **跨 harness**：C1 vs C4 通过 proxy 在 opencode 上复测同基准 10% 子样本（Claude Code/pi 为 stretch）；同一 core 包、同一遥测 schema，仅适配层不同；
- **跨模型**：10% 子样本换 GLM-5.3 复测；
- 所有模型版本与调用日期入库；SWE-bench Verified 的污染风险在论文中声明，并以 SWE-bench-Live 20 任务做抽查对照。

### 4.6 预算（`deepseek-flash`，峰时价）

全网格 ≈ **$480（峰时）/ $240（谷时）**；谷时=UTC 工作日 01:00–04:00 与 06:00–10:00 之外全部五折——按此排程。构成：SWE-V ≈ $21 + τ² ≈ $22 + TB ≈ $440（lean 假设，**pilot 后修正**）。可选：SWE-V 上 `deepseek-v4-pro` 对照臂 +$76；GLM 换模检查 +$40。S1（Jev 云端）每会话约 $0.04，忽略不计。

## 5. 里程碑（10 周）与分工建议

| 周 | 里程碑 | 验收 |
|---|---|---|
| 1 | M0：关闭全部 `[VERIFY]` 项；monorepo 脚手架；s1-client 连通真 Jev/laya-serve；遥测 v1；DSH 插件骨架 | `dsh --dump-config` 可见 bundle；冒烟会话中硬编码组装改写 surface |
| 2–3 | M1：SEGMENTER+RG+ASSEMBLER；proxy MVP；回放一致性测试 | 核心覆盖率 ≥90%；回放不变式通过 |
| 3–4 | M2：方案闸门；降级路径；设置 UI；**TB 10 任务 pilot** | pilot 报告定成本模型；10 任务 C1/C4 冒烟 |
| 5–6 | M3：SWE-V + τ² 全量 2×2；（可选）Laya 微调+校准 | 冻结的统计模块出报告 |
| 7–8 | M4：TB cells；opencode 迁移检查；GLM 换模检查 | H4 有结论 |
| 9–10 | M5：论文图表（Pareto、缓存瀑布、`/s1 why` 案例）+ LaTeX 初稿 | 全文初稿 |

分工建议：一人主攻 core+DSH 插件，一人主攻 bench runners+stats；论文两人共写，投稿前过 pre-submission-reviewer。

## 6. 风险与缓解

| 风险 | 等级 | 缓解 |
|---|---|---|
| 领域窗口移动极快（Jev 09-15、Laya 09-18、pi-system-one 09-22、hermes-jev-skills 已存在） | 高 | 快速发 preprint；贡献点锚定"可复现的 2×2 测量 + 版本化遥测 + 跨 harness 迁移"——集成仓库没有这些 |
| Laya 零样本弱（本地路径质量风险） | 中 | 默认 Jev 云端；本地路径绑定 M3 微调里程碑；两级召回降低对 S1 精度依赖 |
| H3 反噬：TAS 重排降低命中率，净成本变差 | 中 | 这是**可发表的负结果轴**；`updatePolicy` 两档对比给出条件性结论；引用 2601.06007 设计缓存感知布局 |
| TB 成本失控 | 中 | 10 任务 pilot 先行；Artificial Analysis 每 TB 4.0 模型成本页校准；TB 可降级为 33 任务子集 |
| Jev jaggedness（数学/日期/对抗内容） | 中 | 算术与日期永远留在代码里；state 预过滤；概率服务端归一 |
| DSH 版本快速迭代（0.1.2→0.1.7-rc） | 低 | peerDeps 固定 + compatibility 矩阵声明；surfaceOp 形状探测（context-trim 的做法） |

## 7. 评审结论（idea-evaluator，附录）

- **类型**：Technique paper（Novel Method）——把 Trace-as-State 原则与决策模型移植进 agent harness 基础设施，并给出测量。
- **致命缺陷审计**：无 CRITICAL。F1 新颖性已落地核查（三个并行验证 pass + 仓库级检索）：**无人组合 (a)关联图 +(b)预算内逐轮组装 +(c)同模型方案预排序 +(d)缓存/时延遥测**；最近邻 hermes-jev-skills（集成无评估）、GAAMA（图但嵌入+PPR、对话记忆）、AgentFold（模型自折叠、无外部决策模型）、Don't Break the Cache（测量无方法）。风险为 MAJOR（窗口移动）而非致命。
- **五维评分**（5 为默认，机制论证可上调，全部标注 "mechanism-based, not yet confirmed by data"，验证实验=C4 vs C1 配对网格）：Higher **6**（论文 T 26/27 胜率提示排序收益可迁移，但 agent 任务形态不同，主张非劣）；Faster **8**（S1 毫秒级 vs LLM 秒级；并行 noul 批量 12.2× 便宜；方案闸门省浪费尝试）；Stronger **6**（降级路径+跨 harness 检查，但主网格单 provider）；Cheaper **8**（命中率 50× 价差是最大杠杆；TB 成本主导，pilot 定标）；Broader **7**（一个 proxy 覆盖四 harness；协议标准 `/v1/systemone`；决策模型可换）。
- **范式探针**：First principles ✓（挑战"上下文必须时序追加"，论文 T 有理论+实证）；Elephant in the room ✓（agent 成本与 context rot 人人抱怨）；技术周期 ✓（决策模型品类 2026-09 才诞生，使 S1 治理突然变得近乎免费）；Hamming ✓（若成立，agent 经济学改变）。4/4。
- **可行性**：算力低（API+CPU）；数据低（全开源基准）；工程中（插件+代理+runner，均有模板）；时间中（10 周紧凑但分阶段，TB pilot 前置控风险）。
- **判定**：**Accept with Revisions**（worth pursuing, pending the validation experiment）。修订项已吸收：①成功判据改非劣+优越；②两级召回替代朴素 Laya 打分；③H3 缓存惩罚显式化；④术语更正（§2）；⑤2×2 因子形式化。
- **三个首要行动**：① M0 按 AGENT_BRIEF 执行（脚手架+s1-client+遥测+插件骨架）；② TB 10 任务 pilot 钉死成本模型；③ 全量运行前冻结统计脚本与遥测 schema。

## 8. 命名与发布

- **论文标题（已锁定，2026-09-28）**：*S1CAP: Selective Context and Adaptive Planning via System-1 Models for Efficient LLM Agents*（中文对照：S1CAP：基于 System-1 模型的选择性上下文与自适应规划，面向高效 LLM Agent）。查重：AI/agent 领域无 "S1CAP" 冲突（检索命中均为医学文献 "severe CAP" 假阳性）。已知遗留并接受：与 EMNLP 2023 [Selective Context](https://github.com/liyucheng09/Selective_Context)（token 级压缩）同名——论文 §2 必须引用并显式区分（token 剪枝 vs 分片级关联图召回）。
- **仓库**：推荐 `s1cap`（与论文系统名对齐；npm `s1cap` 与 `dsh-s1cap` 均未注册，2026-09-28 核实 404），备选 `s1-governor`（npm `s1-governor` / `dsh-s1-governor` 同样可用）。命名空间说明：`system-one`/`s1` 裸前缀在决策模型生态已拥挤（s1-rs、pi-system-one、system-one-core），带 CAP 后缀即独占；首次公开发布前定案，保持论文/repo/插件三点一线。
- **Description**：*A System-1 decision model (Jev/Laya/Kev-class) governs the context lifecycle of LLM agent harnesses: an association graph over session segments, relevance-gated context assembly with Trace-as-State ordering, and pre-execution plan ranking — with full cache-hit/miss, cost, and latency telemetry. DSH plugin + harness-agnostic proxy.*
- **Topics**：`llm-agents` `context-engineering` `agent-memory` `context-window` `prompt-caching` `kv-cache` `system-one` `decision-models` `jev` `laya` `small-language-models` `coding-agent` `deepseek-harness` `dsh-plugin` `agent-harness` `opencode` `claude-code` `benchmark` `ablation-study`
- **发布渠道**：dshmarket / DSH Plugin Hub / GitHub topic `dsh-plugin`；论文 target venue 待定（Open Questions #4）。

## 9. 开放问题（需 Supervisor 拍板）

1. 主模型：`deepseek-flash`（建议：便宜、1M ctx、有 vision）vs GLM-5.3；
2. 论文主打的 S1 后端：云端 Jev（质量、集成简单）vs 本地微调 Laya/EdgeJev（离线叙事、工作量在 M3）；
3. 全网格预算上限（建议 ≥$500）；
4. 目标 venue 与截稿（决定 M5 范围）；
5. 是否发布 Laya 微调权重（Apache-2.0 基座允许）。

## 10. 参考（全部经 URL 核验，完整档案见 RELATED_WORK.md）

Trace as State: arXiv:2609.02702 · Jev: docs.typesafe.ai · Laya: github.com/NandhaKishorM/laya · EdgeJev: github.com/yzfly/edgejev · Kev: github.com/jaredpalmer/kev · JevBench: benchmarkheaven.com/jev-models · DeepSeek 定价: api-docs.deepseek.com/quick_start/pricing · GLM 定价: docs.z.ai/guides/overview/pricing · Don't Break the Cache: arXiv:2601.06007 · GAAMA: arXiv:2603.27910 · AgentFold: arXiv:2510.24699 · Lost in the Middle: arXiv:2307.03172 · Context Engineering Survey: arXiv:2507.13334 · dsh-command-context-trim: github.com/snailium/dsh-command-context-trim · pi-system-one: npmjs.com/package/pi-system-one · SWE-bench Verified: swebench.com/verified.html · Terminal-Bench: tbench.ai · τ²-bench: github.com/sierra-research/tau2-bench
