# S1CAP 形式化定义与公式手册

**版本** 0.1 · 2026-09-28 · 配套 [PROPOSAL.zh.md](./PROPOSAL.zh.md) · [AGENT_BRIEF.md](./AGENT_BRIEF.md) · [技术路线图](./figures/s1cap-technical-route.html)

本文用 Markdown + LaTeX 固化 S1CAP 的全部数学定义：分片与关联图、上下文组装、Trace-as-State 布局、方案闸门、成本与缓存盈亏模型、时间模型、统计规程。参数默认值与 [AGENT_BRIEF.md](./AGENT_BRIEF.md) §4-§5 一致。

---

## 0. 符号表

| 符号 | 含义 | 默认值 |
|---|---|---|
| $\mathcal{L} = (e_1,\dots,e_T)$ | 会话事件日志（append-only，人类记录，永不改写） | — |
| $S=\{s_1,\dots,s_n\}$ | 分片集合；$s_i=(\mathrm{id},\mathrm{kind},\mathrm{tok}_i,t_i,\mathrm{text}_i)$，$\mathrm{kind}\in\{$user, assistant, trace, toolCall, toolResult$\}$ | — |
| $x$ | 当前用户输入（条件/指令） | — |
| $P$ | 固定前缀（system prompt + 工具 schema），永不被重排 | — |
| $T_{\mathrm{state}}$ | 任务状态代理（序列化推理轨迹 + 任务简报） | $\le 8\mathrm{k}$ chars |
| $G_t=(V_t,E_t)$ | $t$ 时刻的关联图（association graph） | — |
| $\tau,\ d,\ k$ | 关联阈值 / BFS 深度 / 每节点展开上限 | $0.55,\ 2,\ 8$ |
| $\lambda$ | 时间衰减常数（活跃会话时间） | 30 min |
| $K$ | 近尾原文保留轮数 | 3 |
| $B$ | 上下文 token 预算 | §3.1 |
| $\rho$ | 召回块预算占比 | 0.35 |
| $\mu$ | 召回块最小填充率（低于则回退） | 0.25 |
| $m,\ M$ | 候选方案数 / 尝试上限 | $3,\ 2$ |
| $c_{\min}$ | 方案闸门弃权置信度 | 0.5 |

## 1. 分片（SEGMENTER）

消息级分片，**永不按 token 切**：

$$
s_i =
\begin{cases}
\mathrm{chunk}(e_i,\,512,\,\mathrm{overlap}=64), & \mathrm{tok}(e_i) > 512 \\
e_i, & \text{otherwise}
\end{cases}
$$

固定集 $P$（system/tool schema）不进入 $S$。每新分片 $p$ 触发关联图更新（§2）。

## 2. 关联图（S1 关联计算后端：两级召回 + 惰性验证）

本节全部 S1 调用由 **S1 关联计算后端**承担；它与 §4 的 **S1 决策后端**是两个独立角色（可指向同一 `/v1/systemone` 部署，也可分开部署/用不同模型）。

**Tier-0（元数据，免费）**：同任务标签、同工具族、回复链——固定权重 $w_0 = 0.6$。

**Tier-1（候选生成）**：二选一（配置项 `recall.tier1`）：

$$
\text{embed 模式:}\quad C_1(p) = \operatorname*{top\text{-}k}_{h \in S}\ \cos\big(\phi(p),\phi(h)\big),\quad k=32
$$

$$
\text{S1 模式:}\quad w_1(p,h) = P_{\mathrm{S1}}\big(\mathrm{rel}(p,h)\big),\quad \text{单次 } \texttt{/v1/systemone} \text{ 并行 noul 批量}
$$

**Tier-2（惰性验证，仅对可能进入组装的边）**：

$$
w(p,h) =
\begin{cases}
f_{\mathrm{score}}(p,h) \in [0,1], & \mathrm{conf} \ge c_{\min} \\
0.8\, w_1(p,h), & \text{弃权}
\end{cases}
$$

**时间衰减**：

$$
w_{\mathrm{eff}}(p,h) = w(p,h)\cdot \exp\!\big(-\Delta t/\lambda\big), \qquad \Delta t = t_{\mathrm{now}} - t_h
$$

**单轮复杂度**：tier-1 ANN $O(\log n)$；tier-2 一次并行问询调用（状态摄入一次、$|C_1|$ 个问题并行评估）；总计本地几十 ms、云端约 $0.0006/轮。

## 3. 上下文组装（ASSEMBLER）

### 3.1 预算

$$
B = C_{\max} - r_{\mathrm{out}} - f_{\mathrm{fixed}}
$$

其中 $C_{\max}$ 为模型上下文窗口，$r_{\mathrm{out}}$ 输出预留（8192），$f_{\mathrm{fixed}}$ 固定开销（工具 schema 等，由 token meter 实测）。

### 3.2 受限 BFS 召回

$$
R_d(x) = \big\{ h \in S : \exists\, x \to \cdots \to h,\ \text{路径长} \le d,\ \text{每边 } w_{\mathrm{eff}} > \tau,\ \text{每节点展开} \le k \big\}
$$

最坏 $O(k^d)$，受预算提前截断。

### 3.3 预算背包（贪心）

$$
R' = \arg\max_{R \subseteq R_d(x)} \sum_{h \in R} w_{\mathrm{eff}}(x,h)
\quad \text{s.t.} \quad
\sum_{h \in R} \mathrm{tok}(h) \le \rho B
$$

按 $w_{\mathrm{eff}}$ 降序贪心装入；与近尾 $K$ 轮原文按分片 id 去重。

### 3.4 Trace-as-State 布局（因子 TAS 开）

$$
\mathrm{prompt} = \big[\,P \,\|\, T_{\mathrm{state}} \,\|\, \operatorname{sort}_{w_{\mathrm{eff}} \downarrow}(R') \,\|\, \mathrm{tail}_K \,\|\, x\,\big]
$$

要点（源自 [arXiv:2609.02702](https://arxiv.org/abs/2609.02702)）：

- **状态前置**：$T_{\mathrm{state}}$（从轨迹提炼的任务状态）置于历史之前，先于上下文可用；
- **问题在尾**：$x$ 永远最后（论文 T 实测：问题不在末尾模型行为跑偏）；
- **最强者在前**：召回块按 $w_{\mathrm{eff}}$ 降序 + 近尾原文收尾，形成 U 型注意力布局（呼应 *Lost in the Middle*, [arXiv:2307.03172](https://arxiv.org/abs/2307.03172)）；
- **缓存友好**：$P$ 永不重排；$T_{\mathrm{state}}$ 按任务边界追加（`updatePolicy: perTask` 默认）。

**论文 T 的记忆分离定理**（条件状态更新任务，状态空间 $\mathcal{S}$，$b=\log_2|\mathcal{S}|$）：

$$
\text{condition-first } [z,C]:\ \lceil b \rceil \text{ bits}
\qquad\text{vs}\qquad
\text{condition-last } [C,z]:\ \lceil b\cdot 2^{b} \rceil \text{ bits（最坏情形）}
$$

即条件前置与后置的工作记忆需求呈**指数分离**——这是 TAS 布局的理论依据。

### 3.5 回退

$$
\sum_{h \in R'} \mathrm{tok}(h) < \mu \rho B \implies \text{退化为近因窗口（chronological last-}N\text{），记录降级事件}
$$

## 4. 方案闸门（S1 决策后端 + PLAN GATE，因子 S1G 开）

LLM 产出方案集 $\Pi = \{\pi_1,\dots,\pi_m\}$（$m \le 3$）后，**直接把候选方案交给 S1 决策后端**做一次 choice 打分，取回概率 $p_i$ 与置信度 $\mathrm{conf}_i$；**PLAN GATE 消费打分结果**，只负责归一化、弃权判断、尝试上限与排序。**服务端归一**（Jev 不保证 $\sum p_i = 1$）：

$$
\hat p_i = \frac{p_i}{\sum_j p_j}
$$

**执行序**：按 $\hat p$ 降序尝试，验证器 $V(\pi)$ 判定成功；成功即弃未执行方案；尝试上限 $M=2$：

$$
\text{execute } \pi_{(1)}, \pi_{(2)}, \dots \quad \text{until } V(\pi_{(i)}) = \top \text{ or } i = M
$$

**弃权**：$\max_i \mathrm{conf}_i < c_{\min} \Rightarrow$ 保持 LLM 自身顺序。

**期望节省**（设各方案独立成功概率 $q_{(i)}$，成本 $c(\pi_i)$）：

$$
\mathbb{E}[\text{savings}] = \sum_{i=1}^{M} \Big(\prod_{j<i}(1-q_{(j)})\Big)\, q_{(i)} \sum_{j>i} c(\pi_j)
$$

闸门收益为正的条件：$\hat p$ 排序使 $q_{(i)}$ 前置（即 S1 排序与真实成功率秩相关 $> 0$）。

## 5. 成本模型

**单次 LLM 调用**：

$$
c_{\mathrm{call}} = p_{\mathrm{hit}}\, n_{\mathrm{hit}} + p_{\mathrm{miss}}\, n_{\mathrm{miss}} + p_{\mathrm{out}}\, n_{\mathrm{out}}
$$

**任务总成本**：

$$
C_{\mathrm{task}} = \sum_{\text{calls}} c_{\mathrm{call}} + C_{\mathrm{S1}}, \qquad
C_{\mathrm{S1}} = p_{\mathrm{s1}} \sum_{\text{S1 calls}} n_{\mathrm{in}}^{\mathrm{S1}} \quad (\text{Jev 输出免费})
$$

参考价（per 1M tokens，2026-09-28 核验）：`deepseek-flash` 峰时 $p_{\mathrm{hit}}=0.006,\ p_{\mathrm{miss}}=0.30,\ p_{\mathrm{out}}=1.20$（谷时减半）；GLM-5.3 为 $0.26/1.40/4.40$；Jev $p_{\mathrm{s1}}=0.042$（仅输入）。

## 6. 缓存盈亏分析（假设 H3）

设某轮：选择机制删去 $\Delta_s$ 个 token（其中比例 $h$ 本可命中缓存），TAS 重排使 $\Delta_i$ 个 token 由命中转为未中。则相对基线的成本变化：

$$
\Delta C = \underbrace{-\Delta_s\big(h\,p_{\mathrm{hit}} + (1-h)\,p_{\mathrm{miss}}\big)}_{\text{选择节省}}
\;+\; \underbrace{\Delta_i\big(p_{\mathrm{miss}} - p_{\mathrm{hit}}\big)}_{\text{重排罚金}}
$$

**盈亏平衡比**：

$$
\frac{\Delta_s}{\Delta_i} > \rho^{*} = \frac{p_{\mathrm{miss}} - p_{\mathrm{hit}}}{h\,p_{\mathrm{hit}} + (1-h)\,p_{\mathrm{miss}}}
$$

代入 `deepseek-flash` 峰时价：

| 基线命中率 $h$ | $\rho^{*}$（每失效 1 命中 token 需节省的 token 数） |
|---|---|
| 0.50 | 2.71 |
| 0.75 | 3.70 |
| 0.90 | 8.31 |
| 1.00 | 49.0 |

**解读**：命中率越高，重排代价越陡（$h \to 1$ 时每失效 1 个 token 需省 49 个才回本）——这正是 H3 必须逐调用实测、`updatePolicy` 必须可调的原因，也是论文的条件性结论轴。

## 7. 时间模型

$$
t_{\mathrm{net}} = t_{\mathrm{end}} - t_{\mathrm{req}} - t_{\mathrm{backoff}} - t_{\mathrm{approval}}, \qquad
T_{\mathrm{task}} = \sum_{\text{turns}}\big(t_{\mathrm{LLM}}^{\mathrm{net}} + t_{\mathrm{S1}} + t_{\mathrm{tool}}\big)
$$

$t_{\mathrm{approval}}$ = 权限审批等待（benchmark 以自动批准沙箱将其归零；交互会话按 tool_call 事件扣减）。S1 本地路径 $t_{\mathrm{S1}} \approx 15.6\,\mathrm{ms}$（EdgeJev INT8，4 vCPU）。

## 8. 统计规程（预注册）

**主指标（完成率，非劣效）**——配对 McNemar 精确检验，C4 vs C1 不一致对 $(b,c)$：

$$
p = \min\Big(1,\ 2\sum_{i=0}^{\min(b,c)} \binom{b+c}{i} 2^{-(b+c)}\Big) \le \alpha = 0.05
\quad\text{且}\quad
\hat\Delta_{\mathrm{solve}} = \mathrm{solve}_{C4} - \mathrm{solve}_{C1} \ge -\delta,\ \delta = 0.02
$$

**次级指标（成本/时间，优越性）**——配对 bootstrap（$B=10^4$ 次任务重采样）：

$$
\bar\Delta = \overline{\mathrm{cost}}_{C4} - \overline{\mathrm{cost}}_{C1}, \qquad
\mathrm{CI}_{95}\text{（percentile）}，\quad \text{成功} \iff \mathrm{CI}_{95}^{\mathrm{upper}} < -0.10\,\overline{\mathrm{cost}}_{C1}
$$

**多重校正**（次级族 $K=2$：成本、时间）——Holm 步降：

$$
p_{(i)}^{\mathrm{adj}} = \max_{j \le i}\Big\{\min\big(1,\ (K-j+1)\,p_{(j)}\big)\Big\}
$$

**成功判据（整体）**：完成率非劣 **且** 成本或时间 ≥10% 改善（CI 不含 0）。分析脚本在全量运行前冻结入库。

## 9. 复杂度小结

| 环节 | 复杂度 | 备注 |
|---|---|---|
| tier-1 召回（embed ANN） | $O(\log n)$ / 新分片 | HNSW 类索引 |
| tier-2 验证 | 1 次并行问询 / 轮 | 状态摄入一次 |
| BFS 召回 | $O(k^d)$ 上界 | 预算截断 |
| 组装排序 | $O(\|R'\|\log\|R'\|)$ | 每轮 |
| 遥测 | $O(1)$ / 事件 | JSONL append |

---

*引用与事实核验见 [RELATED_WORK.md](./RELATED_WORK.md)；实现规格见 [AGENT_BRIEF.md](./AGENT_BRIEF.md)。参数默认值改动需同步 AGENT_BRIEF §4 配置表。*
