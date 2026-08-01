# Agent Shell

终端原生的 AI Agent。`source agent.zsh` 嵌入 zsh。

- [核心优势](#核心优势)
- [依赖](#依赖)
- [架构](#架构)
- [快速开始](#快速开始)
- [配置](#配置)
- [终端交互](#你在终端里看到什么)
- [基准测试](#agent-shell-vs-qwen-code-基准测试)

## 核心优势

Agent Shell 是一个完全依赖 Zsh 的终端插件。以最朴素的交互方式——
一行命令、一个灰色建议、一次自动执行——和节点链式上下文结构，
探索新型 Agent 的方向。

- **极简** — 单工具、零抽象、无状态机
- **低开销** — 无 tool definitions、无 LSP、无 checkpoint
- **可拓展** — Extension/Plug 自由分发，框架层与能力层分离
- **Node 模型** — 节点链继承，避免全量历史堆叠
- **终端原生** — tmux 内 source 即用，无 GUI 依赖

当前实测表现见文末。

## 依赖

- [Bun](https://bun.sh) ≥ 1.0
- [jq](https://stedolan.github.io/jq/)
- tmux

## 架构

### 节点模型

每个节点是一个 `nodes/<id>/` 目录，包含三个文件：

| 文件        | 作用       | 说明                                                      |
| ----------- | ---------- | --------------------------------------------------------- |
| `parent`  | 父节点 ID  | 形成树/DAG 层级，root 的 parent 为空                      |
| `context` | 系统提示词 | 沿父链向上继承，构成 LLM 的 system message 链             |
| `plug`    | Shell 脚本 | `credential claim` 时 source 进当前 shell，提供执行能力 |

节点至少需要 `context` 和 `plug` 之一。两者分工明确：

- **`context`** 告诉 agent 你是什么、你知道什么——声明式的知识注入
- **`plug`** 告诉 agent 你能做什么——命令式的执行能力

### Extension 系统

Extension 是一种基于 Agent Shell 与 Zsh 的自由分发格式。任何可工作的形式都可以——只要你想。

### agshrc

`.agshrc` 是 shell init 时 source 的引导脚本。它先于一切节点激活——需要的时候激活，不需要的时候不激活。

- **推荐实践**：放"不开不行"的东西——`prompt` 命令、快捷键绑定、extension 引用。
- **实际能力**：可以直接操作 node tree、注入环境——框架不强约束，共识由你定义。
- **与 node 的关系**：agshrc 是侵入式的底层入口，node 是声明式的共识状态层。

`credential claim` 进入共识，`credential drop` 退出共识。chain protocol 是共识的传递规则。

## 快速开始

```bash
# 1. 配置 .env
cp .env.example .env
# 编辑 .env，填入 AGENT_API_KEY 和模型配置

# 2. 确认在 tmux 中，然后 source
source agent.zsh

# 3. 创建节点并启动
prompt my-agent "你是一个代码审查专家"
credential claim my-agent

credential drop  # 退出
```

## 配置

### 模型配置

**DeepSeek**：

```env
AGENT_API_KEY=sk-your-key
AGENT_BASE_URL=https://api.deepseek.com
AGENT_MODEL=deepseek-v4-pro
AGENT_REASONING_EFFORT=high
```

所有可选变量见[环境变量](#环境变量)。

## 你在终端里看到什么

```
─── source agent.zsh 后 ───
Agent Shell v1.x
  prompt     - 创建提示词节点
  credential - 申领/释放凭证
  Ctrl+G     - 暂停/恢复
  Ctrl+T     - 重试 API
  输入 agent help 查看完整命令

[none] ~ % █                                           ◇


─── prompt my-agent "你是审查专家" ───
[prompt] created node 'my-agent' -> nodes/my-agent/
[none] ~ % █                                           ◇


─── credential claim my-agent ───
[credential] CREDENTIAL set to: my-agent
[my-agent] ~ % █                                      ◌ 0r 0t/s
  ↑ 提示符立刻回来                           ↑ API 请求已发出


─── API 响应中 ───
[my-agent] ~ % █                                     ◌ 320r 45t/s
                                                     ↑ 实时 token 计数


─── 响应到达，出现灰色建议 ───
[my-agent] ~ % █ git status                          ◀ 280r 42t/s
                  ─────────────
                  ↑ POSTDISPLAY（灰色）

  → 等 2 秒，自动填入并执行（什么都不用做）
  → 或者按 Tab，命令进入编辑区，可修改后手动 Enter


─── Enter 执行（超时自动或手动触发）───
On branch main
nothing to commit, working tree clean
[my-agent] ~ % █                                           ◇


─── 直接打字 → 灰色建议消失 ───
[my-agent] ~ % ll█                                         ◇
               ↑ agent 收回建议，下轮重新请求



暂停、出错等状态见下方 [RPROMPT 状态图标](#rprompt-状态图标)。

```

### RPROMPT 状态图标

终端右侧始终显示 agent 当前状态：

| 图标 | 含义 | 出现时机 |
|------|------|----------|
| ◇ | 空闲 | 未激活或两轮之间 |
| ◌ | 思考中 | API 请求已发出，右侧显示 token 计数 |
| ◀ | 有建议 | 灰色命令已显示，等你处理 |
| ● | 已暂停 | 按了 Ctrl+G |
| ✗ | 出错 | 上次 API 调用失败，Ctrl+T 重试 |
| ⚠ | 致命错误 | 状态损坏，credential drop 后重新 claim |

### POSTDISPLAY 灰色建议

灰色文字出现在光标之后，不占用你的输入区。**默认等 2 秒自动执行**——什么都不用做。
```

  超时自动执行（默认）  — 等 2 秒，命令自动填入并执行
  按 Tab 或 →           — 不想等？接受命令到编辑区，可修改或直接 Enter
  直接打字               — 灰色消失，agent 收回建议，下轮重新请求
  直接按 Enter           — 被拦截，什么都不会发生（等你做选择）

```

### 快捷键

| 按键 | 说明 |
|------|------|
| `Tab` / `→` | 接受灰色建议 |
| `Ctrl+G` | 暂停/恢复 |
| `Ctrl+T` | 重试上次 API 调用 |

### 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `AGENT_API_KEY` | （必填） | API 密钥 |
| `AGENT_BASE_URL` | `https://dashscope.aliyuncs.com/compatible-mode` | API 端点 |
| `AGENT_MODEL` | `qwen-max` | 模型名称 |
| `AGENT_EXEC_DELAY` | `2` | 建议自动执行延迟（秒） |
| `AGENT_EXEC_TIMEOUT` | `0` | 命令执行超时（秒，0=禁用） |
| `AGENT_REASONING_EFFORT` | `high` | DeepSeek 推理深度 |
| `AGENT_NODES_PATH` | `.agsh/nodes` | 节点树根目录 |
| `AGENT_DEBUG` | `false` | 调试日志 |

优先级：环境变量 > `.agshrc` > `~/.agshrc` > `.env` > 默认值

## Agent Shell vs Qwen Code 基准测试

以下四组基准测试在相同 prompt、相同场景下对比 Agent Shell 与 Qwen Code。差异在于框架本身——Agent Shell 依赖节点链协议和单工具架构，Qwen Code 依赖 system prompt、tool definitions、LSP、checkpoint 等完整基础设施。为对齐比较基准，设置两个分析锚点：−25K/req 扣除个性化配置，仅剩初始系统提示词；−50K/req 扣除全部框架壳，仅剩任务本身 token。主体测试使用 deepseek-v4-pro（下称 DSv4Pro）。

注意：Qwen Code 开启了 subagent 模式。subagent 的系统提示词更小，−50K 按主 agent 提示词大小扣除，实际子任务消耗可能高于此估算值。


### 总览

| Task | 类型   | AS Req | AS Token | QC Req | QC Token | QC −25K | QC −50K | AS 得分 | QC 得分 |
|------|--------|--------|---------|--------|---------|---------|---------|---------|---------|
| A    | 审计   | 24     | 1.45M   | 136    | 7.06M   | 3.66M   | 0.26M   | 43.9    | 43.8    |
| B    | 修复   | 160    | 2.27M   | 99     | 8.90M   | 6.43M   | 3.95M   | 44.4    | 35.6    |
| C    | 长程   | 192    | 4.98M   | 294    | 22.65M  | 15.30M  | 7.95M   | 38.2    | 43.7    |
| D    | 开放性 | 153    | 7.29M   | 130    | 11.42M  | 8.17M   | 4.92M   | 32.0    | 46.5    |
| **合计** |     | 529    | 15.99M  | 659    | 50.02M  | 33.55M  | 17.07M  |         |         |

Qwen Code 原始 token 是 Agent Shell 的 3.1 倍，−50K 后降至 17.07M，仅高 6.8%。

### 场景分析

#### A — 审计任务


| | Req | Hit | Miss | 命中率 | Token | −25K | −50K | 得分 |
|---|---|---|---|---|---|---|---|---|
| Agent Shell | 24 | 1.35M | 0.09M | 93.7% | 1.45M | — | — | 43.9 |
| Qwen Code | 136 | 6.56M | 0.42M | 94.0% | 7.06M | 3.66M | 0.26M | 43.8 |

同分。drill-down 仅 **1 次**。

Agent Shell 未做工具结果裁切这类深度调优，上下文因此膨胀。Qwen Code 做了工具结果裁切，剥离框架壳后 **−50K 仅 0.26M**。

#### B — 修复任务


| | Req | Hit | Miss | 命中率 | Token | −25K | −50K | 得分 |
|---|---|---|---|---|---|---|---|---|
| Agent Shell | 160 | 2.08M | 0.13M | 93.9% | 2.27M | — | — | 44.4 |
| Qwen Code | 99 | 8.58M | 0.28M | 96.8% | 8.90M | 6.43M | 3.95M | 35.6 |

唯一领先。**drill-down 9 次**。

修复场景复杂度适中，模型正确决策、有效拆分节点，上下文成本大幅缩减，体现了节点模型在合适场景下的结构性优势。

#### C — 长程任务


| | Req | Hit | Miss | 命中率 | Token | −25K | −50K | 得分 |
|---|---|---|---|---|---|---|---|---|
| Agent Shell | 192 | 4.79M | 0.13M | 97.2% | 4.98M | — | — | 38.2 |
| Qwen Code | 294 | 21.63M | 0.87M | 96.2% | 22.65M | 15.30M | 7.95M | 43.7 |

38.2/70。drill-down 6 次。

上下文成本缩减显著——**−50K 后 4.98M 对 7.95M**，少用近四成 token。但任务完成度存在差距。长任务推进中，模型对框架的利用准确率下降——父子节点锚定失准，链断裂后上下文无法延续。

#### D — 开放性任务


| | Req | Hit | Miss | 命中率 | Token | −25K | −50K | 得分 |
|---|---|---|---|---|---|---|---|---|
| Agent Shell | 153 | 7.10M | 0.13M | 98.1% | 7.29M | — | — | 32.0 |
| Qwen Code | 130 | 10.92M | 0.43M | 95.9% | 11.42M | 8.17M | 4.92M | 46.5 |

32.0/70，四场景中差距最大。drill-down 3 次。

**分差 14.5**。困难任务下 Agent Shell 要求模型同时处理代码理解和节点规划，注意力分散后两边都不到位——drill-down 利用不足，**parent 自引用成环**。任务分拆进入回归阶段时执行出错，节点尚未启动框架就宕机了。

#### 分布

DSv4Pro 四个场景的得分分布：

- **框架未断裂时**（Task A 43.9、Task B 44.4），得分方差在 0.5 以内——框架在此区间内行为稳定。
- **框架断裂时**（Task C 38.2、Task D 32.0），得分下降与任务复杂度正相关。

DSv4Pro 存在一个可利用区间：当任务复杂度未超出模型对链协议的操控能力时，节点链提供稳定的一致体验。超出此区间后，链断裂不是渐进式的——伴随 parent 自引用成环和 drill-down 利用不足，agent 直接宕机。

### D 复测 — Kimi K3

> 完整交互记录见 [`docs/benchmarks/k3-tqdm-monitor.log`](docs/benchmarks/k3-tqdm-monitor.log)。

同一场景、同一框架、同一 Task D prompt，仅切换模型为 Kimi K3。

| 模型 | 得分 | 节点链长 | 链断裂 | 协议违规 | API 调用 | 测试通过 | 新增测试 |
|------|------|----------|--------|----------|----------|----------|----------|
| DSv4Pro | 32.0 | — | 出现 | 出现 | 153 | — | — |
| Kimi K3 | 57.1 | 24 | 0 | 0 | 261 | 168 | +27 |

链协议全路径执行。24 节点四阶段自动编排——三路审计并行、汇总、分批修复、收敛验证——在协议约束下自然涌现。168 测试通过，27 新增。跨版本兼容、pristine A/B 对照、自限 scope——实际工作覆盖了评分标准之外的工程判断。

框架的契约足够包容。模型与 Extension 在此之下探索能力的边界。

单 agent 的 24 节点链跑通后，同一棵节点树上的多 agent 并行、动态拓扑、自适应钻取——这些方向在 24 节点链中已见雏形。每个节点独立 context，各自隔离。协议保持开放。


### 对照

节点链协议对模型存在硬性要求。DSv4Pro 在 Task C、D 上力有不逮——链断裂，parent 自引用成环。K3 在 Task D 上满足——24 节点稳定链，零断裂，零协议违规。单次观测，有待交叉验证。
### 小结

Agent Shell 是基础框架，当前测试反映的是无插件增强的基线状态。

**结构性优势**

- **drill-down 分拆效率**：将任务拆分为独立子节点、增量继承上下文。修复任务中以 2.27M token 产出 44.4 分，Qwen Code −50K 后仍需 3.95M 且仅得 35.6 分——token 效率与执行质量同时占优。
- **单工具架构的内生低开销**：无 tool definitions、无 LSP、无 checkpoint。裸任务 token 合计 15.99M，Qwen Code 剥离全部框架壳后为 17.07M，仅高 6.8%。

**当前基线**

- **输出粒度**：工具调用结果未做裁切，上下文因此膨胀。审计场景中这一缺陷拖高了 token 消耗。输出截断类插件可直接解决。
- **执行护栏**：框架保持极简，不做行为校验。困难任务中模型异常操作（parent 自引用成环）未被拦截，回归阶段执行出错直接导致宕机。护栏属于插件层关注点。
- **模型适配**：节点链协议存在能力门槛。DSv4Pro 在 Task C、D 中锚定失准导致链断裂。K3 在 Task D 上的观测——零链断裂、零协议违规——表明此限制随模型进化自然缓解。单点数据不足以构成结论。
- **精力分配**：困难任务下模型同时处理代码理解和节点规划，注意力分散后两边都不到位——drill-down 利用不足，节点决策失准。需插件分担框架决策负担。

Agent Shell 作为基础框架的价值在于节点链协议和 drill-down 分拆机制。
而非内置到框架层。
