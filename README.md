# DeepSeek Harness Engineering Portfolio — Production Agent Infrastructure

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Runtime: DeepSeek Harness](https://img.shields.io/badge/Runtime-DeepSeek%20Harness%20(Cordis%20DI)-0f172a.svg)](https://github.com/dsh-external/dsh-harness-portfolio)
[![Tests: Deterministic](https://img.shields.io/badge/Tests-Deterministic-16a34a.svg)](#quick-start--verification--快速验证)
[![Benchmark: Zero-Key <1s](https://img.shields.io/badge/Benchmark-Zero--Key%20%3C1s%20Repro-7c3aed.svg)](./docs/04-harness-evaluation-benchmark.md)

> **Flagship Agent Infrastructure & Context Engineering Suite for Long-Horizon Coding Agents**  
> **面向长周期软件工程 Agent 的生产级基础设施与上下文治理作品集**

---

## v4 收益看板 / Measured v4 Dashboard

| 维度 / Dimension | 最新实测 / Latest measurement | 证据边界 / Evidence boundary |
| --- | --- | --- |
| 常驻工具 / Resident tools | **137 → 22（-84%）** | 当前生产目录与真实 `filterTools` 算子；历史 G1 的 38 是旧消融点 |
| 常驻上下文 / Resident context | **102.4k → 41.5k tokens（-60%）** | v4 同源配置配对遥测，非所有工作负载保证值 |
| 缓存命中率 / Cache hit rate | **95%+** | 热前缀实测；Vertex `thinkingConfig` 隐式缓存 A/B 显示保持思考配置时缓存有效，不能把它描述成显式缓存开关 |
| 上下文安全 / Context safety | **75% 硬水位无损接管原生压缩** | `takeoverNativeCompaction` 默认在运行时暂停原生 `auto`，`dispose` 恢复原值；原事件可回召 |

---

## Executive Summary (English)

As autonomous coding agents scale from single-turn scripts to long-horizon software engineering systems connected to dozens of MCP servers, browser automation tools, and domain skills, three structural bottlenecks inevitably degrade agent reliability:

1. **First-Turn Action-Space & Prompt Bloat**: Exposing 100+ tool schemas and static skill catalogs inflates every request header by ~28.5k tokens, fractures prefix KV caches, and dilutes model attention (*Lost-in-the-Middle*).
2. **Monolithic Session Pollution & Self-Review Blind Spots**: Running search, heavy code edits, test debugging, and code review inside a single session floods the context window with transient noise, while evaluating code with the same model family introduces homogeneous blind spots.
3. **Destructive Rolling Summarization (*Anchor Collapse*)**: Traditional context compaction replaces message history with lossy natural-language summaries, erasing exact line numbers, file paths, symbol names, and error codes—forcing agents into repetitive re-reading loops.

This repository presents **three orthogonal, production-verified runtime plugins** built on the **DeepSeek Harness (DSH)** Cordis dependency-injection kernel. Together, they form a closed-loop **Input Governance → Execution Isolation → Memory Compaction** architecture:

- **[`@dsh-external/dsh-tool-gate`](./packages/dsh-tool-gate)** — **Tool Surface Governance**: Gates 4 heavy tool groups plus low-frequency extras (`137 → 22` resident tools in v4; `137 → 38` is the historical G1 ablation point) and replaces the ~9 KB static `<available_skills>` prompt block with two-phase on-demand skill loading (`skill_search` + `skill_load`), cutting static first-turn prompt overhead by **71.6%** with **zero-friction pre-execution auto-unlock** and synchronized ghost-context stripping.
- **[`@dsh-external/dsh-relay-dispatch`](./packages/dsh-relay-dispatch)** — **Heterogeneous Multi-Agent Orchestration**: Decouples the main session into a lightweight **Orchestrator** that dispatches isolated **Fresh Workers** across heterogeneous model vendors (e.g., Claude, GPT, Gemini, Grok) with capability-aware fallback chains, Eliminates `wait_run` polling loops via inline job notifications, and renders a zero-flicker parent-child session tree in the Web GUI via React Fiber introspection + pure CSS Flex `order`.
- **[`@dsh-external/dsh-context-compact`](./packages/dsh-context-compact)** — **Surgical Context Compaction**: Separates the immutable append-only event ledger (`session.events` / `.jsonl.zstd`) from the active LLM projection (`session.surface.nodes`). Empowers the agent to surgically replace individual tool results (`@call:<callId>`) or closed multi-turn spans (`@span:S<start>-<end>`) with high-density engineering conclusions, featuring **staged end-of-turn commits** and **recursive lossless recall** (`context_recall`) over nested `sourceEventSeqs` DAGs.
- **[`@dsh-external/dsh-eval-bench`](./packages/dsh-eval-bench)** — **Three-Tier Evaluation & Adversarial Benchmark Suite**: Combines **Tier-1 Production Empirical Telemetry** (**97 real sessions / 29,004 Zstd frames / 342,035 events / 21,530,371 Event Tokens → 4,490,834 Surface Tokens (20.9%) / 25/52 (48.1%) independent defect interception**), **Tier-2 Deterministic Engine Benchmarks** (`G0~G4` progressive ablations and **Needle-in-Compacted-Haystack `C0~C4` achieving 10/10 (100%) exact recall, 10/10 distractor rejection & 0/5 (0%) negative FP** in `< 1s` via `npm run bench`), and **Tier-3 Cross-Vendor Blind-Spot Decoupling (`R1~R3`: `3/25 (12.0%)` → `14/25 (56.0%)` → `25/25 (100.0%)`)**.

---

## 架构总览：三大核心支柱的协同闭环（Chinese Overview）

在生产级 Coding Agent 运行时（DeepSeek Harness）中，**高信噪比的上下文窗口（High-SNR Context Window）** 是决定多步推理上限的第一性稀缺资源。本作品集从 **入口降噪（事前）**、**主从隔离与异构互审（事中）**、**事件流无损手术刀压缩（事后）** 三个维度构建了完整的 Agent Harness Engineering 闭环：

```mermaid
flowchart TB
    subgraph Pillar1["支柱一：入口工具面治理 (dsh-tool-gate)"]
        direction TB
        RawTools["全量挂载能力<br/>137 Tools + ~9 KB 全量技能目录<br/>(~28,500 Static Tokens)"]
        Gate["system-prompt/assemble 门控过滤<br/>Remove-Only 隐藏 4 大低频重型组<br/>+ 同步剥离幽灵提示词 (Ghost Context Stripping)"]
        SkillLazy["两阶段按需技能检索<br/>skill_search (BM25 风格加权打分) → skill_load"]
        AutoUnlock["tool/pre-execute 零摩擦自动放行<br/>直呼隐藏工具名时当轮即刻放行 + 持久化解锁事件"]
        CleanSurface["精简高信噪比入口<br/>38 Core Tools (~8,100 Static Tokens, -71.6%)"]

        RawTools --> Gate --> CleanSurface
        RawTools --> SkillLazy --> CleanSurface
        CleanSurface -. "按需直呼 / tool_unlock" .-> AutoUnlock
    end

    subgraph OrchLoop["主会话：轻量化主程循环 (Lightweight Orchestrator)"]
        direction TB
        Orch["主程推理上下文 (session.surface.nodes)<br/>专注架构拆解、边界约束与关键证据抽查"]
    end

    subgraph Pillar2["支柱二：异构多智能体主从编排 (dsh-relay-dispatch)"]
        direction TB
        Dispatch["relay_dispatch({ mode, startArgs })<br/>investigate / implement / verify / review / heavy"]
        Fallback["跨厂商模型候选链 + 自动容灾降级<br/>Capability Pre-filter + 429/5xx/Timeout Retry"]
        Worker["独立 Fresh Worker 子会话<br/>上下文完全隔离 + 按模式自动收紧读写沙箱"]
        CrossReview["异构模型交叉互审 (Cross-Vendor Verification)<br/>消除同源模型自审盲区"]
        Notify["零轮询异步回传<br/>LocalJobRegistry 挂载 + Inline Notification 注入"]
        SidebarTree["Web GUI 零闪烁侧栏会话树<br/>React Fiber 探针 + 纯 CSS Flex order 拓扑重排"]

        Dispatch --> Fallback --> Worker --> CrossReview --> Notify
        Worker -. "sessions.prepare 槽注入 parentSession" .-> SidebarTree
    end

    subgraph Pillar3["支柱三：事件流级无损精确压缩 (dsh-context-compact)"]
        direction TB
        Inspect["阶段收敛自检<br/>context_compact(inspect: true) 定位 >=500 Token 巨型块"]
        Surgical["双粒度原位投影替换 (Surface Projection)<br/>单条工具结果 (@call) + 闭环历史轮次区间 (@span)"]
        Staged["Staged 延迟提交机制<br/>本轮内原文保持可见，轮末 (turn-stopping) 批量合并提交<br/>(>70% 占用或 conclude_turn: true 时立即提交)"]
        Ledger["不可变底层账本 (.jsonl.zstd)<br/>session.events 只追加不删改 + sourceEventSeqs 溯源 DAG"]
        Recall["context_recall 无损递归回召<br/>支持嵌套压缩展开、正则搜索与 120 行游标分页"]

        Inspect --> Surgical --> Staged --> Ledger
        Ledger -. "按需翻阅原卷" .-> Recall
    end

    CleanSurface ==> Orch
    Orch ==>|"1. 复杂实现/跨模型验证外包"| Dispatch
    Notify ==>|"2. 仅回传精简结构化结论"| Orch
    Orch ==>|"3. 本地探索噪音原位剔除"| Inspect
    Staged ==>|"4. 释放数万 Surface Tokens"| Orch
    Recall -.->|"5. 零失真找回精确行号/符号"| Orch
```

---

## 核心量化指标总表（Key Engineering Metrics）

| 维度 / 模块 | 核心工程指标 | 优化前（Baseline） | 优化后（Portfolio） | 关键技术机制 |
| :--- | :--- | :--- | :--- | :--- |
| **工具面与技能治理**<br/>`dsh-tool-gate` | 默认暴露工具数<br/>首轮静态 Prompt 开销<br/>技能目录静态注入<br/>复杂多步锚定遵循率<br/>首次调隐藏工具额外往返 | `137` 个工具<br/>`~28,500` Tokens<br/>`~9 KB` (`<available_skills>`)<br/>严重劣化（实测跌至 `0/9`）<br/>报错重试需 `+1` 轮 RTT | **v4 `22` 个常驻工具 (`-84%`)**<br/>**历史 G1 `~8,100` Tokens (`-71.6%`)**<br/>**`0 Bytes` 静态目录 (`-100%`)**<br/>**恢复至 `~81%` 基线水平**<br/>**`0` 额外轮次 (`Auto-Unlock`)** | 4 大重型工具组默认门控 (`dev`/`relay`/`connector`/`browser`)<br/>`filterTools` + `filterContexts` 幽灵上下文同步剥离<br/>`skill_search` + `skill_load` 两阶段按需加载<br/>`tool/pre-execute` 零摩擦自动解锁与事件流持久化 |
| **异构多智能体调度**<br/>`dsh-relay-dispatch` | 子任务等待期間主程轮询<br/>跨厂商互审与容灾降级<br/>主会话上下文污染<br/>Web 侧栏父子拓扑渲染 | 手动循环 `wait_run` 空转烧 Token<br/>单模型硬编码、自审同源盲区<br/>检索与排错噪音全部堆积主会话<br/>平铺无层级或 DOM 搬移导致 React 崩溃 | **`0` 轮询（异步通知自动唤醒）**<br/>**多候选链热读 + 自动跨渠道降级**<br/>**Fresh 子会话完全隔离，仅回传摘要**<br/>**零闪烁树状折叠（零 React Reconciliation 冲突）** | `LocalJobRegistry` + `injectInlineNotification`<br/>`dispatch-modes.yaml` 热加载 + `isModelError` 分类重试<br/>`sessions.prepare` 并发安全槽注入 `meta.parentSession`<br/>React Fiber 向上探针 + 纯 CSS `order` 与自定义属性驱动 |
| **事件流精确上下文压缩**<br/>`dsh-context-compact` | 压缩粒度与锚点保留度<br/>生产实测长程会话净收益<br/>底层历史数据有损率<br/>当轮推理上下文连续性<br/>Prefix KV Cache 友好度 | 全量滚动摘要，行号/符号/错误码丢失<br/>全盘重写历史，好坏上下文同归于尽<br/>破坏性覆盖（原文永久不可逆丢失）<br/>当轮立即截断，打断后续工具链<br/>历史头部重写导致 Prefix Cache 全失效 | **`@call` 单条结果 + `@span` 区间级手术刀**<br/>**8 会话 `753,347 → 556,615` (`-26.1% / -196,732` tok)，单会话峰值 `138,371 → 67,196` (`-51.4% / -71,175` tok)**<br/>**`0%` 有损（NICH 对抗基准 `10/10 (100%)` 回召 / `10/10` 拒识 / `0/5 (0%)` 误报）**<br/>**Staged 轮末延迟提交，本轮内原文可见**<br/>**静态指令走 `systemPrompt.section` 稳固缓存前缀** | `session.events` 追加日志与 `surface.nodes` 投影分离<br/>`surfaceOp: { op: 'replace' }` 区间合并提交<br/>`sourceEventSeqs` 溯源 DAG 递归展开 + 深度上限保护<br/>`conclude_turn: true` 同轮结轮省 1 次 LLM RTT |
| **三层实证与对抗评测基准**<br/>`dsh-eval-bench` | 生产账本过滤比 (97 会话)<br/>生产异构复核缺陷拦截率<br/>NICH 嵌套压缩大海捞针 (`C0~C4`)<br/>评审盲区正交变量解耦 (`R1~R3`)<br/>复现成本与执行耗时 | 缺乏真实生产账本普查<br/>同模型自审仅检出 `3/25 (12.0%)`（漏检 `88.0%`）<br/>硬截断 `C1` 回召 `2/10 (20%)`，滚动摘要 `C2` 回召仅 `1/10 (10%)`<br/>上下文隔离与模型异构混为一谈<br/>依赖昂贵 API Key 且不可复现 | **`21,530,371` Event → `4,490,834` Surface (`20.9%`，过滤 `79.1%`)**<br/>**`52` 个独立复核子会话实测拦截 `25` 个确认缺陷 (`25/52 = 48.1%`)**<br/>**`C3` (`697 tok, -92.9%`) / `C4` (`236 tok, -97.6%`) 实现 `10/10 (100%)` 精确回召 + `10/10` 干扰拒识 + `0/5 (0%)` 阴性误报**<br/>**`R1=3/25 (12.0%)` → `R2=14/25 (56.0%, +44.0 pp)` → `R3=25/25 (100.0%, +44.0 pp)`**<br/>**`npm run bench` 零 Key、零网络 `< 1 秒` 确定性复现** | 29,004 个 Zstd 帧与 342,035 个生产事件全量普查<br/>`G0~G4` 五阶渐进消融矩阵 (`28,500 → 8,100 tok, -71.6%`)<br/>5 深度 × 10 阳性探针 + 10 真实埋入干扰针 + 5 阴性探针<br/>`R1~R3` 三阶受控盲区解耦矩阵（52 复核 / 25 确认缺陷） |

---

## 快速导航（Repository Navigation）

### 1. 源码包（Packages）

| 包路径 | 包名 | 核心定位与亮点 | 包内文档 |
| :--- | :--- | :--- | :--- |
| [`packages/dsh-tool-gate`](./packages/dsh-tool-gate) | `@dsh-external/dsh-tool-gate` | **工具面门控与按需技能引擎**：4 大工具组按需开关、`/tools` 交互面板、零摩擦自动放行、BM25 风格中英混合 `skill_search` 与 `skill_load`。 | [`packages/dsh-tool-gate/README.md`](./packages/dsh-tool-gate/README.md) |
| [`packages/dsh-relay-dispatch`](./packages/dsh-relay-dispatch) | `@dsh-external/dsh-relay-dispatch` | **异构多模型主从调度器与侧栏会话树**：5 大内置工程派发模式（支持 YAML 热扩展）、模型能力预检与故障降级链、后台生命周期管理、React Fiber + CSS Flex `order` 零闪烁侧栏树。 | [`packages/dsh-relay-dispatch/README.md`](./packages/dsh-relay-dispatch/README.md) |
| [`packages/dsh-context-compact`](./packages/dsh-context-compact) | `@dsh-external/dsh-context-compact` | **事件流级无损精确压缩与回召**：`@call` / `@span` 双粒度原位投影替换、Staged 轮末延迟提交、`conclude_turn` 结轮优化、`sourceEventSeqs` 递归无损 `context_recall`。 | [`packages/dsh-context-compact/README.md`](./packages/dsh-context-compact/README.md)<br/>[`packages/dsh-context-compact/MIGRATION.md`](./packages/dsh-context-compact/MIGRATION.md) |
| [`packages/dsh-eval-bench`](./packages/dsh-eval-bench) | `@dsh-external/dsh-eval-bench` | **三层实证遥测与确定性对抗评测基准**：97 会话生产遥测核验、`G0~G4` 渐进消融、`T0~T2` 工具面治理对照、`C0~C4` NICH 对抗大海捞针（`10/10` 无损回召）与 `R1~R3` 盲区解耦。 | [`packages/dsh-eval-bench/README.md`](./packages/dsh-eval-bench/README.md)<br/>[`docs/04-harness-evaluation-benchmark.md`](./docs/04-harness-evaluation-benchmark.md) |

### 2. 深度架构复盘与旗舰评测报告（Architecture Deep-Dives & Evaluation Report）

- **模块 01**：[`docs/01-tool-surface-governance.md`](./docs/01-tool-surface-governance.md) — *Agent 工具面治理与按需技能加载架构复盘（137 → 38 工具门控、幽灵上下文剥离、零摩擦自动放行与两阶段技能检索）*
- **模块 02**：[`docs/02-heterogeneous-multi-agent-dispatch.md`](./docs/02-heterogeneous-multi-agent-dispatch.md) — *异构多模型主从调度与零闪烁侧栏会话树（Orchestrator-Worker 上下文隔离、跨厂商互审、非阻塞通知与 React Fiber 侧栏树渲染）*
- **模块 03**：[`docs/03-surgical-context-compaction.md`](./docs/03-surgical-context-compaction.md) — *事件流级无损精确上下文压缩：告别有损滚动摘要的 Agent 记忆手术刀（Events vs. Surface 分离、双粒度原位替换、Staged 提交与 DAG 递归无损回召）*
- **模块 04（旗舰评测报告）**：[`docs/04-harness-evaluation-benchmark.md`](./docs/04-harness-evaluation-benchmark.md) — *Harness Evaluation & Benchmark Report：三层证据分级体系、97 生产会话实测普查（21.53M Event Tokens / 48.1% 缺陷拦截）、G0~G4 渐进消融、NICH 对抗性大海捞针（10/10 精确回召 / 10/10 干扰拒识 / 0/5 阴性误报）与 R1~R3 异构盲区解耦*

---

## 三大核心模块深度解析（Pillar Highlights）

### Pillar 1: Tool Surface Governance (`@dsh-external/dsh-tool-gate`)

- **Remove-Only 严格白名单安全边界**：在 `system-prompt/assemble` 钩子中只做减法不做加法，绝不绕过宿主 Profile、Agent Preset 或权限沙箱策略。子代理（`delegationDepth > 0`）默认豁免门控，确保被委派的专职 Worker（如浏览器测试子代理）开箱即用全部工具。
- **消除“幽灵指令”幻觉（Synchronized Context Stripping）**：当某个工具组（如 `dev`）处于关闭状态时，同步扫描并剔除 `assembled.contexts` 中匹配的运行时提示词片段（如 `dsh-super-injector` 注入的热重载引导语），彻底杜绝“提示词教模型调工具，但工具声明已被隐藏”的幻觉死循环。
- **零摩擦自动解锁（Zero-Friction Auto-Unlock）**：若模型已知某个被隐藏工具的精确名称（如从用户指令中直接看到 `dev_reload_package`）并直接发起调用，`tool/pre-execute` 钩子会在执行前毫秒级拦截、自动解锁对应工具组并写入持久化会话事件，当轮调用直接放行成功，实现 **0 报错、0 额外轮次开销**。

### Pillar 2: Heterogeneous Multi-Agent Orchestration (`@dsh-external/dsh-relay-dispatch`)

- **模式驱动的语义化派发（Mode-Driven Dispatch）**：通过 `~/.dsh/dispatch-modes.yaml`（支持每次调用热读取）定义 `investigate`、`implement`、`verify`、`review`、`heavy` 等模式，自动配齐读写沙箱边界（`read-only` vs. `danger-full-access`）、推理强度（`reasoningEffort`）、前置纪律约束（`taskPrefix`）与结构化交付契约（`deliverable`）。
- **跨厂商异构互审（Cross-Vendor Verification）**：支持为编码实现（`implement`）与独立验证/代码审查（`verify` / `review`）绑定不同厂商的模型候选链，利用模型家族间的分布差异消除同源盲区；并在遇到 `429 Rate Limit`、`5xx`、超时或模型不可用时自动沿候选链无缝降级。
- **零 DOM 破坏的 React 侧栏会话树**：不在宿主 React 虚拟 DOM 管理的容器内移动或增删节点（避免触发 `NotFoundError: removeChild`），而是通过讀取 DOM 节点的 `__reactFiber$` 指针精准提取会话 UUID，结合纯 CSS `display: flex` + `order` 重排与 `--dsh-tree-depth` 缩进变量，实现零闪烁的父子会话折叠树与孤儿节点自动降级保护。

### Pillar 3: Surgical Context Compaction (`@dsh-external/dsh-context-compact`)

- **不可变事件流与活跃表面投影解耦**：底层 `session.events`（`.jsonl.zstd`）保持 100% 追加只读；压缩仅向事件流追加带 `surfaceOp: { op: 'replace', start, end }` 的替换节点，在 `session.surface.nodes` 上完成原位手术刀剔除。
- **Staged 轮末延迟提交与同轮结轮优化**：当 Agent 在单轮中一边分析大文件一边调用 `context_compact` 时，默认进入 `staged` 暂存区并在轮末（`agent/turn-stopping`）按逆序无冲突合并提交，确保当轮后续步骤仍能看到未压缩原文；当表面上下文占用率 `> 70%` 或显式传入 `conclude_turn: true`（同轮写完最终回复直接收尾，立省一次 LLM 请求往返）时则立即提交。
- **支持嵌套压缩的 DAG 递归无损回召（`context_recall`）**：每个替换节点均记录被替换的原始事件序号数组 `sourceEventSeqs` 并在摘要末尾嵌入 `[recall: @call:...]` 或 `[recall: @span:...]` 锚点。即使某段已经被压缩过的区间再次被外层 `@span` 二次压缩，`context_recall` 仍能沿 `sourceEventSeqs` 有向无环图递归展开还原最底层的原始叶子事件，并支持正则表达式过滤（附带上下文行）与 120 行游标分页读取。
- **免 YAML 的原生自动压缩协同**：`takeoverNativeCompaction` 默认开启，仅在运行时把已有 `ctx.compaction.auto: true` 置为 `false`，`dispose` 精确恢复原值；不改文件、重复调用幂等。75% 硬水位由确定性归档接管，原文仍可回召。

---

## Quick Install (1-Command)

**Option A — clone and install** (Node.js 18+; defaults to the `web` profile and all three plugins):

```bash
git clone https://github.com/mikonnyan/dsh-harness-portfolio.git && cd dsh-harness-portfolio && node scripts/install.mjs
```

Use `--mode link` for development, `--profile NAME`, `--plugins a,b`, `--dry-run`, or `--uninstall` as needed. Existing manifests are backed up before updates.

**Option B — install the pre-packed plugins from [GitHub Release v1.1.0](https://github.com/mikonnyan/dsh-harness-portfolio/releases/tag/v1.1.0)** into your current npm project:

```bash
npm install https://github.com/mikonnyan/dsh-harness-portfolio/releases/download/v1.1.0/dsh-tool-gate-0.1.0.tgz https://github.com/mikonnyan/dsh-harness-portfolio/releases/download/v1.1.0/dsh-context-compact-0.0.1.tgz https://github.com/mikonnyan/dsh-harness-portfolio/releases/download/v1.1.0/dsh-relay-dispatch-0.1.0.tgz
```

## Testing Against Latest DSH

```bash
npm run test:canary
```

The runner auto-detects `@deepseek-ai/dsh` (or set `DSH_CHECKOUT`) and runs the full contract suite. Add `-- --setup-profile` once to create the isolated `test-canary` profile without changing `web`.

## Quick Start & Verification / 快速验证

本仓库 4 个子包测试采用 Node.js 原生测试运行器与 Mock/真实 v4 契约，**核心测试与基准无需外部网络或 API Key**，可一键串行运行全仓单元与集成测试套件：

```bash
# 运行全仓统一测试套件（含 v4 运行时与原生压缩接管契约）
npm test

# 一键运行三层确定性评测基准（零 API Key，< 1 秒输出 G0~G4 / T0~T2 / C0~C4 NICH / R1~R3 完整消融报表）
npm run bench

# 语法与静态检查
npm run check
```

也可以按子包单独运行测试：

```bash
npm run test:tool-gate        # 门控过滤、Schema 投影、生命周期、权限与缓存契约
npm run test:relay-dispatch   # 模式解析、候选链容灾、槽隔离、会话树与终止级联
npm run test:context-compact  # v4 压缩、75% 硬水位、原生接管/恢复与嵌套无损回召
npm run test:eval-bench       # 当前 137→22 算子断言、历史 G1 消融、NICH 与账本守恒
```

---

## License

Released under the [MIT License](./LICENSE). Copyright (c) 2026 DeepSeek Harness Engineering Portfolio Contributors.
