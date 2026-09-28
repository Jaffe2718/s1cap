# S1CAP（中文说明）

**S**ystem-1 **S**elective **C**ontext and **A**daptive **P**lanning · [English](./README.md)

> 论文标题（已锁定）：*S1CAP: Selective Context and Adaptive Planning via System-1 Models for Efficient LLM Agents*
>
> **作者：** Yuanming Chen · LI Changzhe

## 这是什么

用一个便宜的 **System-1 决策模型**（Jev / Laya / Kev 类，走 [`/v1/systemone`](https://docs.typesafe.ai/api) 协议）接管 LLM agent harness 的**上下文生命周期管理**——而不是让昂贵的 System-2 LLM 自己处理。治理层只在**两个点**介入：

1. **Selective Context（上下文生命周期）**：会话的每个分片（用户输入、模型输出、推理轨迹、工具调用与结果）都是不断增长的**关联图**上的节点，由 System-1 模型打分；每轮用"受限 BFS + 关联阈值 + token 预算"决定**模型看到什么**，并按 Trace-as-State 顺序组装：`[固定前缀 | 状态代理 T | 召回块 | 近尾原文 | 当前输入]`。
2. **Adaptive Planning（决策优先级）**：LLM 给出候选方案后，同一个 System-1 模型用**选择题**给各方案概率；按概率从大到小执行，每个方案完成后用验证器检查，成功即丢弃未执行的备选。

**一切以测量说话**：任务完成率、按 prompt cache 命中/未中拆分的 token 成本（DeepSeek 命中价约为未中的 1/50，是最大的成本杠杆）、以及扣除审批等待的净耗时。

## 为什么是现在（2026 年 9 月）

- **Trace as State**（[arXiv:2609.02702](https://arxiv.org/abs/2609.02702)）：把推理轨迹状态代理放在长上下文**之前**，26/27 个组合优于放在之后——免训练、纯推理期，harness 插件即可移植；
- **决策模型品类诞生**：[Jev](https://docs.typesafe.ai/api)（$0.042/M 输入、输出免费、并行问询便宜 12 倍）、开源 [Laya](https://github.com/NandhaKishorM/laya)（Apache-2.0）、本地运行时 [EdgeJev](https://github.com/yzfly/edgejev)（322M INT8，324MB，4 核 vCPU 15.6ms/决策）；
- **缓存经济学**：DeepSeek `deepseek-flash` 命中 $0.006/M vs 未中 $0.30/M——上下文怎么组装是成本决策。

## 实验设计（预注册）

2×2 同任务配对析因（因子 A：TAS 排序；因子 B：S1 治理 = 召回选择 + 方案闸门）：

| Cell | A | B |
|---|---|---|
| C1 基线 | 关 | 关（仅 harness 原生压缩） |
| C2 | **开** | 关 |
| C3 | 关 | **开** |
| C4 完整 | **开** | **开** |

基准（全部自动评分）：SWE-bench Verified（100/cell）· Terminal-Bench 4.0（66/cell）· τ²-bench（base 全量）。模型：`deepseek-flash`，temperature 0。

**成功判据**：完成率对 C1 **非劣**（配对 McNemar，单侧 α=0.05，容差 −2pp）**且** 成本或时间改善 ≥10%（配对 bootstrap 95% CI 不含 0）。赢成本但掉完成率 >2pp 不算赢。

## 状态与路线图

Pre-alpha，M0 进行中。完整规格见 [docs/AGENT_BRIEF.md](docs/AGENT_BRIEF.md) §10（M0 环境核实 → 脚手架 → s1-client 连通真实后端 → 遥测 v1 → DSH 插件骨架；M1–M5 见文档）。

## 文档

| 文档 | 读者 |
|---|---|
| [docs/PROPOSAL.zh.md](docs/PROPOSAL.zh.md) | 研究提案——Supervisor / Cooperator（中文） |
| [docs/AGENT_BRIEF.md](docs/AGENT_BRIEF.md) | 实施 brief——投喂给编码 Agent（已核验事实库、接口、算法、里程碑） |
| [docs/RELATED_WORK.md](docs/RELATED_WORK.md) | 相关工作档案 + 新颖性审计（全部经 URL 核验） |

## 环境要求

本机已核验（2026-09-28）：Node v22.23.1 · npm 12.0.2 · git 2.45.2 · Python 3.13.13（miniforge）· i7-12700H（支持 AVX2，可跑 EdgeJev 本地运行时）· DSH 内置 Node 24.18.1。

依赖：Node ≥ 22.19 · pnpm（Windows PowerShell 下请调用 `pnpm.cmd` 或调整执行策略）· Python ≥ 3.10（本地 S1 运行时）· 一个 System-1 后端（云端 Jev key，或弱 CPU 设备用本地 EdgeJev/Laya，324MB、离线）。

## 命名说明

**S1CAP = System-1 Selective Context and Adaptive Planning。** 注意："Selective Context" 与 EMNLP 2023 的一篇 token 级压缩工作（[Xiao et al.](https://github.com/liyucheng09/Selective_Context)）同名但机制不同（我们是分片级关联图召回，服务 agent 上下文生命周期）——论文中将引用并显式区分。

## 许可证

待定（建议 MIT）。
