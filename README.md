# Agent Shell

A terminal-native AI agent. `source agent.zsh` embeds into zsh.

- [Core Advantages](#core-advantages)
- [Dependencies](#dependencies)
- [Architecture](#architecture)
- [Quick Start](#quick-start)
- [Configuration](#configuration)
- [Terminal UX](#what-you-see-in-the-terminal)
- [Benchmarks](#agent-shell-vs-qwen-code-benchmarks)

## Core Advantages

Agent Shell is a terminal plugin built entirely on Zsh. With the simplest possible interaction model—
one command, one gray suggestion, one auto-execution—and a node-chain context structure,
it explores a new direction for AI agents.

- **Minimal** — single tool, zero abstractions, no state machine
- **Low overhead** — no tool definitions, no LSP, no checkpoints
- **Extensible** — Extensions/Plugs freely distributable; framework layer decoupled from capability layer
- **Node model** — node-chain inheritance avoids stacking full history
- **Terminal-native** — source inside tmux and go; no GUI dependencies

Current real-world benchmarks at the end of this document.

## Dependencies

- [Bun](https://bun.sh) ≥ 1.0
- [jq](https://stedolan.github.io/jq/)
- tmux

## Architecture

### Node Model

Each node is a `nodes/<id>/` directory containing three files:

| File       | Purpose             | Description                                                      |
| ---------- | ------------------- | ---------------------------------------------------------------- |
| `parent`   | Parent node ID      | Forms a tree/DAG hierarchy; root's parent is empty               |
| `context`  | System prompt       | Inherited upward along the parent chain, forming the LLM's system message chain |
| `plug`     | Shell script        | Sourced into the current shell on `credential claim`, providing execution capability |

A node requires at least one of `context` or `plug`. The two serve distinct roles:

- **`context`** tells the agent what you are and what you know—declarative knowledge injection
- **`plug`** tells the agent what you can do—imperative execution capability

### Extension System

An Extension is a free-form distribution format built on Agent Shell and Zsh. Anything that works is valid—as long as you want it.

### agshrc

`.agshrc` is a bootstrap script sourced at shell init. It activates before any node—when needed, not when unneeded.

- **Recommended practice**: put "can't live without it" things here—`prompt` commands, keybindings, extension references.
- **Actual capability**: can directly manipulate the node tree and inject environment—the framework imposes no hard constraints; consensus is defined by you.
- **Relationship to nodes**: agshrc is the invasive low-level entry point; nodes are the declarative consensus state layer.

`credential claim` enters consensus; `credential drop` exits consensus. The chain protocol is the rule set for passing consensus.

## Quick Start

```bash
# 1. Configure .env
cp .env.example .env
# Edit .env, fill in AGENT_API_KEY and model config

# 2. Make sure you're in tmux, then source
source agent.zsh

# 3. Create a node and activate it
prompt my-agent "You are a code review expert"
credential claim my-agent

credential drop  # Exit
```

## Configuration

### Model Configuration

**DeepSeek**:

```env
AGENT_API_KEY=sk-your-key
AGENT_BASE_URL=https://api.deepseek.com
AGENT_MODEL=deepseek-v4-pro
AGENT_REASONING_EFFORT=high
```

See [Environment Variables](#environment-variables) for all available options.

## What You See in the Terminal

```
─── After source agent.zsh ───
Agent Shell v1.x
  prompt     - Create prompt node
  credential - Claim / drop credential
  Ctrl+G     - Pause / resume
  Ctrl+T     - Retry API call
  Type agent help for full command list

[none] ~ % █                                           ◇


─── prompt my-agent "You are a code review expert" ───
[prompt] created node 'my-agent' -> nodes/my-agent/
[none] ~ % █                                           ◇


─── credential claim my-agent ───
[credential] CREDENTIAL set to: my-agent
[my-agent] ~ % █                                      ◌ 0r 0t/s
  ↑ Prompt returns immediately               ↑ API request sent


─── API streaming ───
[my-agent] ~ % █                                     ◌ 320r 45t/s
                                                     ↑ Live token count


─── Response arrives, gray suggestion appears ───
[my-agent] ~ % █ git status                          ◀ 280r 42t/s
                  ─────────────
                  ↑ POSTDISPLAY (gray text)

  → Wait 2 seconds, auto-fill and execute (do nothing)
  → Or press Tab, command enters edit area, modify then press Enter


─── Enter to execute (auto-timeout or manual trigger) ───
On branch main
nothing to commit, working tree clean
[my-agent] ~ % █                                           ◇


─── Start typing → gray suggestion disappears ───
[my-agent] ~ % ll█                                         ◇
               ↑ Agent retracts suggestion, re-requests next round



For paused, error, and other states see [RPROMPT Status Icons](#rprompt-status-icons).

```

### RPROMPT Status Icons

The agent's current state is always shown on the right side of the terminal:

| Icon | Meaning       | When it appears |
|------|---------------|-----------------|
| ◇    | Idle          | Not activated or between rounds |
| ◌    | Thinking      | API request in flight; token count shown on the right |
| ◀    | Suggestion    | Gray command displayed, awaiting your action |
| ●    | Paused        | Ctrl+G was pressed |
| ✗    | Error         | Last API call failed; Ctrl+T to retry |
| ⚠    | Fatal error   | State corrupted; credential drop then re-claim |

### POSTDISPLAY Gray Suggestions

Gray text appears after your cursor without occupying your input area. **By default, auto-executes after 2 seconds**—you do nothing.
```

  Auto-execute timeout (default)  — Wait 2 seconds, command auto-fills and executes
  Press Tab or →                   — Don't want to wait? Accept command into edit area, modify or press Enter
  Start typing                     — Gray text disappears, agent retracts suggestion, re-requests next round
  Press Enter directly             — Intercepted; nothing happens (waiting for your choice)

```

### Keyboard Shortcuts

| Key             | Description                |
|-----------------|----------------------------|
| `Tab` / `→`     | Accept gray suggestion     |
| `Ctrl+G`        | Pause / resume             |
| `Ctrl+T`        | Retry last API call        |

### Environment Variables

| Variable                  | Default                                          | Description                                |
|---------------------------|--------------------------------------------------|--------------------------------------------|
| `AGENT_API_KEY`           | (required)                                        | API key                                    |
| `AGENT_BASE_URL`          | `https://dashscope.aliyuncs.com/compatible-mode` | API endpoint                               |
| `AGENT_MODEL`             | `qwen-max`                                        | Model name                                 |
| `AGENT_EXEC_DELAY`        | `2`                                               | Suggestion auto-execute delay (seconds)    |
| `AGENT_EXEC_TIMEOUT`      | `0`                                               | Command execution timeout (seconds, 0=off) |
| `AGENT_REASONING_EFFORT`  | `high`                                            | DeepSeek reasoning depth                   |
| `AGENT_NODES_PATH`        | `.agsh/nodes`                                     | Node tree root directory                   |
| `AGENT_DEBUG`             | `false`                                           | Debug logging                              |

Priority: environment variable > `.agshrc` > `~/.agshrc` > `.env` > default

## Agent Shell vs Qwen Code Benchmarks

The following four benchmark groups compare Agent Shell against Qwen Code under identical prompts and scenarios. The difference lies in the frameworks themselves—Agent Shell relies on a node-chain protocol and single-tool architecture, while Qwen Code relies on a full infrastructure stack: system prompts, tool definitions, LSP, checkpoints, and more. To align the comparison baseline, two analytic anchors are established: −25K/req subtracts per-request personalization config, leaving only the initial system prompt; −50K/req subtracts the entire framework shell, leaving only the task's own tokens. The main test uses deepseek-v4-pro (abbreviated as DSv4Pro below).

Note: Qwen Code had subagent mode enabled. Subagent system prompts are smaller; −50K deducts based on the main agent's prompt size. Actual sub-task consumption may be higher than this estimate.


### Overview

| Task   | Type     | AS Req | AS Token | QC Req | QC Token | QC −25K | QC −50K | AS Score | QC Score |
|--------|----------|--------|----------|--------|----------|---------|---------|----------|----------|
| A      | Audit    | 24     | 1.45M    | 136    | 7.06M    | 3.66M   | 0.26M   | 43.9     | 43.8     |
| B      | Fix      | 160    | 2.27M    | 99     | 8.90M    | 6.43M   | 3.95M   | 44.4     | 35.6     |
| C      | Long-run | 192    | 4.98M    | 294    | 22.65M   | 15.30M  | 7.95M   | 38.2     | 43.7     |
| D      | Open-ended| 153   | 7.29M    | 130    | 11.42M   | 8.17M   | 4.92M   | 32.0     | 46.5     |
| **Total**|         | 529    | 15.99M   | 659    | 50.02M   | 33.55M  | 17.07M  |          |          |

Qwen Code's raw token count is 3.1× that of Agent Shell. After −50K it drops to 17.07M, only 6.8% higher.

### Scenario Analysis

#### A — Audit Task


|             | Req | Hit    | Miss   | Hit Rate | Token | −25K  | −50K  | Score |
|-------------|-----|--------|--------|----------|-------|-------|-------|-------|
| Agent Shell | 24  | 1.35M  | 0.09M  | 93.7%    | 1.45M | —     | —     | 43.9  |
| Qwen Code   | 136 | 6.56M  | 0.42M  | 94.0%    | 7.06M | 3.66M | 0.26M | 43.8  |

Tied score. Only **1 drill-down**.

Agent Shell has not implemented deep optimizations like tool result truncation, so context inflates. Qwen Code performs tool result truncation; after stripping the framework shell, **−50K is only 0.26M**.

#### B — Fix Task


|             | Req | Hit    | Miss   | Hit Rate | Token | −25K  | −50K  | Score |
|-------------|-----|--------|--------|----------|-------|-------|-------|-------|
| Agent Shell | 160 | 2.08M  | 0.13M  | 93.9%    | 2.27M | —     | —     | 44.4  |
| Qwen Code   | 99  | 8.58M  | 0.28M  | 96.8%    | 8.90M | 6.43M | 3.95M | 35.6  |

The sole lead. **9 drill-downs**.

The fix scenario has moderate complexity. The model made correct decisions and split nodes effectively, dramatically reducing context cost—demonstrating the node model's structural advantage in suitable scenarios.

#### C — Long-Running Task


|             | Req | Hit    | Miss   | Hit Rate | Token | −25K   | −50K  | Score |
|-------------|-----|--------|--------|----------|-------|--------|-------|-------|
| Agent Shell | 192 | 4.79M  | 0.13M  | 97.2%    | 4.98M | —      | —     | 38.2  |
| Qwen Code   | 294 | 21.63M | 0.87M  | 96.2%    | 22.65M| 15.30M | 7.95M | 43.7  |

38.2/70. 6 drill-downs.

Context cost reduction is significant—**after −50K: 4.98M vs 7.95M**, using nearly 40% fewer tokens. However, a completion gap exists. During long-task progression, the model's utilization accuracy of the framework declines—parent-child anchoring drifts, and after chain breakage context cannot be maintained.

#### D — Open-Ended Task


|             | Req | Hit    | Miss   | Hit Rate | Token | −25K  | −50K  | Score |
|-------------|-----|--------|--------|----------|-------|-------|-------|-------|
| Agent Shell | 153 | 7.10M  | 0.13M  | 98.1%    | 7.29M | —     | —     | 32.0  |
| Qwen Code   | 130 | 10.92M | 0.43M  | 95.9%    | 11.42M| 8.17M | 4.92M | 46.5  |

32.0/70, the largest gap among the four scenarios. 3 drill-downs.

**14.5-point gap**. Under difficult tasks, Agent Shell demands the model handle both code comprehension and node planning simultaneously; attention splits and neither side lands—drill-down underutilization, **parent self-referencing cycles**. When task decomposition enters the regression phase, execution errors occur before the node even starts, and the framework goes down.

#### Distribution

DSv4Pro score distribution across four scenarios:

- **When the framework stays intact** (Task A 43.9, Task B 44.4), score variance is within 0.5—the framework behaves stably within this range.
- **When the framework breaks** (Task C 38.2, Task D 32.0), score decline correlates positively with task complexity.

DSv4Pro has a usable window: when task complexity does not exceed the model's ability to operate the chain protocol, the node chain provides a stable, consistent experience. Beyond this window, chain breakage is not gradual—accompanied by parent self-referencing cycles and drill-down underutilization, the agent crashes outright.

### Task D Retest — Kimi K3

> Full interaction log at [`docs/benchmarks/k3-tqdm-monitor.log`](docs/benchmarks/k3-tqdm-monitor.log).

Same scenario, same framework, same Task D prompt—only the model changed to Kimi K3.

| Model    | Score | Chain Length | Chain Breaks | Protocol Violations | API Calls | Tests Passed | New Tests |
|----------|-------|--------------|--------------|----------------------|-----------|--------------|-----------|
| DSv4Pro  | 32.0  | —            | Present      | Present              | 153       | —            | —         |
| Kimi K3  | 57.1  | 24           | 0            | 0                    | 261       | 168          | +27       |

Full chain protocol execution. 24 nodes auto-orchestrated in four phases—three-way parallel audit, aggregation, batched fixes, convergence verification—emerging naturally under protocol constraints. 168 tests passed, 27 added. Cross-version compatibility, pristine A/B comparisons, self-limiting scope—the actual work covered engineering judgment beyond the scoring rubric.

The framework's contract is inclusive enough. Under it, the model and Extensions explore the boundaries of capability.

With the single-agent 24-node chain fully executed, multi-agent parallelism on the same node tree, dynamic topologies, adaptive drilling—these directions are already visible in embryonic form within the 24-node chain. Each node has independent context, each isolated. The protocol remains open.


### Comparison

The node-chain protocol imposes hard requirements on the model. DSv4Pro falls short on Tasks C and D—chain breaks, parent self-referencing cycles. Kimi K3 meets the bar on Task D—24-node stable chain, zero breaks, zero protocol violations. A single observation; cross-validation needed.

### Summary

Agent Shell is a foundational framework. The current tests reflect baseline state with no plugin augmentation.

**Structural Advantages**

- **Drill-down decomposition efficiency**: splits tasks into independent sub-nodes with incremental context inheritance. In the fix task, it produced a 44.4 score with 2.27M tokens; Qwen Code after −50K still required 3.95M and scored only 35.6—token efficiency and execution quality simultaneously dominant.
- **Inherently low overhead of single-tool architecture**: no tool definitions, no LSP, no checkpoints. Raw task tokens total 15.99M; Qwen Code after stripping its entire framework shell sits at 17.07M, only 6.8% higher.

**Current Baseline**

- **Output granularity**: tool call results are not truncated, inflating context. This weakness dragged up token consumption in the audit scenario. Output-truncation plugins can address this directly.
- **Execution guardrails**: the framework stays extremely minimal and performs no behavioral validation. Under difficult tasks, anomalous model operations (parent self-referencing cycles) went unintercepted; execution errors during the regression phase caused a direct crash. Guardrails belong to the plugin layer.
- **Model compatibility**: the node-chain protocol has a capability threshold. DSv4Pro's anchoring drift in Tasks C and D caused chain breakage. The Kimi K3 observation on Task D—zero chain breaks, zero protocol violations—suggests this limitation naturally eases as models evolve. A single data point is not a conclusion.
- **Attention allocation**: under difficult tasks, the model handles both code comprehension and node planning simultaneously; split attention leaves neither side well-covered—drill-down underutilized, node decisions inaccurate. Plugins are needed to offload framework decision-making burden.

Agent Shell's value as a foundational framework lies in the node-chain protocol and drill-down decomposition mechanism.
Not in baking everything into the framework layer.
