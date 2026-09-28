# S1CAP 模块作用详解

**版本** 0.1 · 2026-09-28 · 配套 [技术路线图](./figures/s1cap-technical-route.html) · [AGENT_BRIEF.md](./AGENT_BRIEF.md) · [FORMULAS.zh.md](./FORMULAS.zh.md)

技术路线图上的每个方块对应这里的一节。**状态**列：✅ 已实现（M0）· 🔜 计划（M1/M2）· ⬜ 外部依赖。

## 0. 数据流一句话

```
会话事件 → 分片 → S1 关联计算 → 扩充 RG → BFS 召回 + TAS 组装 → System-2 LLM
                                                                      ↓ 候选方案
              执行 + 验证 ← 概率降序 ← PLAN GATE ← choice 打分 ← S1 决策后端
```

## 1. 会话事件层（Harness Adapter）

| 项 | 内容 |
|---|---|
| 位置 | `packages/dsh-plugin`（DSH 一等插件）· `packages/proxy`（OpenAI-compatible 代理，M1） |
| 职责 | 把 harness 的会话事件（用户消息、助手消息、推理轨迹、工具调用与结果）转成统一 `RawEvent`；把组装结果写回**模型视图**（DSH 走 `surfaceOp: replace`，代理走 messages 重写） |
| 输入 | harness 事件流（append-only 会话日志） |
| 输出 | `Segment[]` 交给 SEGMENTER；surface 重写指令交给 harness |
| 关键约束 | **用户可见的 transcript 永远按时序、永不改写**；只改模型视图 |
| 失败与降级 | 插件加载失败 → 退化为原生 harness 行为（不影响会话可用性） |
| 状态 | 🔜 M1 |

## 2. SEGMENTER（分片器）

| 项 | 内容 |
|---|---|
| 位置 | [`packages/core/src/segmenter.ts`](../packages/core/src/segmenter.ts) |
| 职责 | 把一条会话事件切成**消息级**分片（一段话 / 一次工具结果 / 一段推理轨迹），超过预算才切块 |
| 粒度原则 | **永不按 token 切**——一个语段就是一个语义单元（用户原设计约束） |
| 输入 → 输出 | `RawEvent` → `Segment[]`（`id / kind / tokens / text / ts / taskTag`） |
| 关键参数 | `chunkTokens = 512`、`overlapTokens = 64`（超长块带重叠切分，保留上下文接续） |
| Token 估算 | CJK ≈ 1 token/字，其余 ≈ 4 字符/token（启发式；生产中由 harness `tokenMeter` 提供真实值） |
| 测试 | `estimateTokens`、单段不分片、300 行工具结果分片且尾块含末行 |
| 状态 | ✅ M0 |

## 3. 两级召回（RECALL）

| 项 | 内容 |
|---|---|
| 位置 | [`packages/core/src/assoc-graph.ts`](../packages/core/src/assoc-graph.ts)（tier-0 / tier-2 能力已实现）· tier-1 嵌入与 S1 编排 🔜 M1 |
| 职责 | 为每个新分片生成"与哪些历史分片相关"的候选，供关联图落边 |
| Tier-0（免费） | 元数据边：同任务标签 / 同工具族 / 回复链，固定权重 0.6 |
| Tier-1（候选） | `embed` 模式：本地嵌入 ANN top-k=32；`s1` 模式：一次 `/v1/systemone` 批量 noul（每批 ≤20 问，防 context rot） |
| Tier-2（验证） | 只对**可能进入组装**的边做 `score` 精排；置信度低于阈值则弃权，取 `0.8 × tier-1 权重` |
| 状态 | 部分 ✅（图与查询）/ 🔜（嵌入与 S1 编排，M1） |

## 4. S1 关联计算后端

| 项 | 内容 |
|---|---|
| 位置 | [`packages/s1-client`](../packages/s1-client/src/index.ts)（协议客户端 ✅）· 调用编排 🔜 M1 |
| 职责 | 承担**全部关联性判定**：新片段 × 历史片段 → 关联概率；输出用于扩展 RG 的边权重 |
| 协议 | `POST {baseUrl}/v1/systemone`，`noul` 问询（P(true)），状态只摄入一次、多问并行评估 |
| 后端 | Jev 云端（`api.typesafe.ai`，$0.042/M 输入、输出免费）· 本地 `laya-serve` / EdgeJev / Kev |
| 成本量级 | 每会话约 $0.04（云端）；本地 INT8 约 15.6 ms/决策 |
| 失败与降级 | 超时（默认 2500 ms）→ 该轮跳过 tier-2；连续不可用 → 只保留 tier-0 + 近因窗口 |
| 安全 | 传入的 `state` 先做**预过滤**（剥离超长代码块/URL）——决策模型可被对抗内容牵引 |
| 状态 | ✅ 客户端 / 🔜 编排 |

## 5. 关联图 RG（RG STORE）

| 项 | 内容 |
|---|---|
| 位置 | [`packages/core/src/assoc-graph.ts`](../packages/core/src/assoc-graph.ts) |
| 职责 | 存片段节点与加权边；提供受限 BFS 召回与统计 |
| 边权重 | `w`（tier-2 精排）+ `wTier1`（候选）+ `source` + `verifiedAt` + `provenance`（供 `/s1 why <seq>` 溯源） |
| 时间衰减 | `w_eff = w · exp(−Δt/λ)`，λ 默认 30 分钟活跃会话时间 |
| 召回 | `recall(seeds, {tau, depth, fanout})`：BFS 深度 ≤ d、每节点展开 ≤ k、沿 `w_eff > τ` 扩展；返回按权重降序、含 `via`/`depth` |
| 已知缺陷修复 | 种子节点不再因回边被计入召回结果（M0 测试抓出并修复） |
| 持久化 | 内存（M0）→ SQLite（🔜 M1，接口不变） |
| 状态 | ✅ M0 |

## 6. ASSEMBLER（组装器）

| 项 | 内容 |
|---|---|
| 位置 | [`packages/core/src/assembler.ts`](../packages/core/src/assembler.ts) |
| 职责 | 在 token 预算内决定**模型这一轮看到什么、什么顺序** |
| 预算 | `B = contextWindow − reserveOutput − fixedOverhead`；召回块上限 `min(⌊B·ρ⌋, 剩余)`，ρ = 0.35 |
| 选择 | 贪心背包：按 `w_eff` 降序装入，跳过 pinned / 近尾 / 当前输入 |
| 布局（TAS 开） | `[pinned │ T 状态代理 │ 召回块（权重降序）│ 近尾 K 轮原文 │ x]`——**x 永远最后** |
| 布局（TAS 关） | 召回块改按时序排列（对应 C3 cell） |
| 回退 | 召回质量 < `μ·预算`（μ=0.25）→ 退化为近因窗口并记 `fallback: 'recency-window'` |
| 缓存感知 | `cacheStability.prefixTokensStable` 输出固定前缀 token 数，供 H3 缓存盈亏核算 |
| 状态 | ✅ M0（回放一致性测试 🔜 M1） |

## 7. System-2 LLM（宿主模型）

| 项 | 内容 |
|---|---|
| 位置 | harness 的 provider 配置（本项目**不修改**模型与 harness 本体） |
| 职责 | 消费组装后的上下文，产出推理与**候选方案**；执行阶段产生工具调用 |
| 主模型 | `deepseek-flash`（DeepSeek-V4.1-Flash，1M ctx，temperature 0） |
| 换模检查 | GLM-5.3（10% 子样本，验证 provider 无关性） |
| 状态 | ⬜ 外部 |

## 8. S1 决策后端

| 项 | 内容 |
|---|---|
| 位置 | [`packages/s1-client`](../packages/s1-client/src/index.ts) + [`packages/core/src/plan-gate.ts`](../packages/core/src/plan-gate.ts) |
| 职责 | 对 LLM 给出的候选方案做**一次 choice 打分**，输出每个方案的概率与置信度 |
| 问询形态 | `state = {任务简报, x, T}`；`criteria` = 各方案摘要（≤8 项，保护本地 Laya 的 20 选项上限） |
| 拓扑 | 方案由 **LLM 直接交给本后端**；打分结果交给 PLAN GATE（闸门不自己发起 S1 调用） |
| 已知弱点应对 | Jev 概率不保证归一 → 由闸门统一归一；弃权阈值 0.5 |
| 状态 | ✅ 打分与归一（客户端 + `normalizeProbs`）· 🔜 端到端接线（M2） |

## 9. PLAN GATE（方案闸门）

| 项 | 内容 |
|---|---|
| 位置 | [`packages/core/src/plan-gate.ts`](../packages/core/src/plan-gate.ts) |
| 职责 | 消费 S1 打分，产出**执行顺序**与尝试预算；不做模型调用 |
| 归一化 | `p̂_i = p_i / Σp_j`（修 Jev 的 Σp≠1，文档实例 1.19） |
| 排序 | 按 `p̂` 降序；**弃权**（最高置信度 < 0.5 或无打分）→ 保持 LLM 自身顺序 |
| 尝试控制 | `AttemptController`：上限 **M = 2**（候选方案 m ≤ 3）；任一方案通过验证即停并丢弃其余 |
| 输出 | `{ order, probs, abstained }` + 每方案 `{prob, confidence, executed, verified, savedTokensEst}` 遥测 |
| 状态 | ✅ M0（含测试：归一、弃权保序、M=2 提前成功/封顶） |

## 10. 执行 + 验证

| 项 | 内容 |
|---|---|
| 位置 | harness 工具执行层 + `bench/runners`（M2） |
| 职责 | 按闸门给出的顺序尝试方案；每个方案完成后用**验证器**判定是否完成 |
| 验证器 | benchmark 原生（SWE-bench 测试 / Terminal-Bench 测试套件 / τ² 环境状态） |
| 成功后 | 丢弃未执行方案，记录节省估计；失败且未达上限 → 尝试次选方案 |
| 时间统计 | 扣除**权限审批等待**（自动批准沙箱下为 0） |
| 状态 | 🔜 M2 |

## 11. TELEMETRY（遥测）

| 项 | 内容 |
|---|---|
| 位置 | [`packages/core/src/telemetry.ts`](../packages/core/src/telemetry.ts) |
| 职责 | 版本化 JSONL 记录全链路，支撑论文的成本/时延/质量三类指标 |
| 事件类型 | `llm_call`（含 cache hit/miss 拆分、净时延、审批等待）· `s1_call`（角色 assoc/decide、问题数）· `tool_call` · `assembly` · `plan_gate` |
| 成本模型 | `c = p_hit·hit + p_miss·miss + p_out·out`；`summarizeTask()` 汇总 $/任务、命中率、调用次数与时延 |
| 价格表 | `deepseek-flash` 峰/谷 · `deepseek-v4-pro` · `glm-5.3(-flash)` · Jev 输入价 0.042/M |
| 契约 | schema v1：字段**只增不改名**（跑完第一轮基准后改字段名会让数据不可比） |
| 状态 | ✅ M0 |

---

## 附：模块 → 消融因子映射

| 模块 | C1 基线 | C2 +TAS | C3 +S1 | C4 完整 |
|---|---|---|---|---|
| SEGMENTER / 事件层 | 原生 | 原生 | 原生 | 原生 |
| S1 关联计算 + RG + 召回 | 关 | 关 | **开** | **开** |
| ASSEMBLER（TAS 布局） | 关（时序追加） | **开** | 关（时序） | **开** |
| S1 决策后端 + PLAN GATE | 关 | 关 | **开** | **开** |
| TELEMETRY | 开 | 开 | 开 | 开 |

对应 `bench/cells/C{1..4}.json`。
