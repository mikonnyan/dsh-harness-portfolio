# @dsh-external/dsh-context-compact

**面向 DeepSeek Harness 的事件流级精确压缩、无损回召与原生自动压缩免配置接管。**

**Surgical event-stream compaction, lossless recall, and zero-config native auto-compaction takeover for DeepSeek Harness.**

## 中文

### 为什么需要它

传统滚动摘要会丢失文件路径、行号、符号和错误码。本插件只改写发送给模型的 `session.surface.nodes` 投影，底层追加式事件账本保持完整；需要时可通过 `context_recall` 沿 `sourceEventSeqs` 溯源图找回原文。

- `context_compact`：按单个工具结果（`@call`）或已闭合轮次区间（`@span`）压缩；支持暂存后轮末提交、`conclude_turn`、软水位提示及 75% 硬水位零 LLM 接管。
- `context_recall`：支持嵌套压缩、正则/子串检索、上下文行与最多 120 行游标分页。
- 安全边界：校验工具调用/结果配对；不修改或删除原生压缩文件；异常与卸载恢复路径可重复执行。

### 安装与即插即用

将本包作为标准 DSH 插件安装并按宿主插件市场指引启用。支持当前声明的 DSH 版本及 Cordis 4 运行时；无需额外运行时依赖。

`takeoverNativeCompaction` **默认为 `true`**：插件加载时，如果 `ctx.compaction` 存在且其实例 `auto === true`，仅在内存中将它设为 `false`，避免原生自动压缩与本插件同时争抢上下文。无需手改 YAML。

插件 `dispose` 时将该实例的 `auto` 精确恢复为接管前的值；重复恢复是幂等的。设置为 `false`、没有原生实例、或原生原本未开启自动压缩时均不改动。

```yaml
# 仅在希望保留原生 auto 行为时显式关闭接管
takeoverNativeCompaction: false
```

卸下插件后，注册的工具和提示词由宿主生命周期清理，原生 `auto` 同步恢复，不留下文件改写。

### 常用工具

| 工具 | 用途 |
| --- | --- |
| `context_compact({ results, spans })` | 压缩指定工具结果或已闭合区间；摘要须保留结论和精确锚点 |
| `context_compact({ inspect: true })` | 检查大型表面节点，不执行压缩 |
| `context_compact({ conclude_turn: true })` | 满足回复已完成等安全条件时立即提交并结轮 |
| `context_recall({ target, query, line_range })` | 无损读取原始事件或全局检索 |

硬水位默认 `0.75`，目标水位默认 `0.55`；自动归档使用确定性摘要，原文仍可回召。这里的“无损”指原始事件未被破坏且可检索，不代表摘要本身包含全部原文。

### 验证与许可证

```bash
npm test
node --check lib/index.js
```

BSD-3-Clause © mikonnyan。源码与发布说明见包元数据中的 GitHub 仓库。

---

## English

### Why this plugin

Rolling summaries can erase paths, line numbers, symbols, and error codes. This plugin changes only the model-facing `session.surface.nodes` projection while preserving the append-only event ledger. `context_recall` traverses the `sourceEventSeqs` provenance graph whenever exact source text is needed.

- **`context_compact`** targets individual tool results (`@call`) or closed spans (`@span`), with staged turn-end commits, `conclude_turn`, soft-watermark hints, and deterministic zero-LLM takeover at the 75% hard watermark.
- **`context_recall`** handles nested compaction, regex/substring search, context lines, and cursor pagination of up to 120 lines.
- **Safety invariants** protect tool-call/result pairing and leave native compaction files untouched; cleanup is idempotent.

### Install and zero-config coexistence

Install and enable this package as a standard DSH plugin using the host plugin-market workflow. It supports the declared DSH range and Cordis 4 without additional runtime dependencies.

**`takeoverNativeCompaction` defaults to `true`.** On startup, if `ctx.compaction` exists with instance value `auto === true`, the plugin changes only that in-memory value to `false`, preventing two automatic compactors from competing. **No YAML edit is required.**

On plugin `dispose`, the exact previous value is restored. Restoration is idempotent. The plugin makes no change when takeover is disabled, native compaction is absent, or native `auto` was not enabled.

```yaml
# Opt out only when native automatic behavior should remain active
takeoverNativeCompaction: false
```

Removing the plugin lets the host unregister its tools and prompt hooks and restores native `auto`; no file rewrite is left behind.

### Tools

| Tool | Purpose |
| --- | --- |
| `context_compact({ results, spans })` | Compact selected tool results or closed spans with precise engineering summaries |
| `context_compact({ inspect: true })` | Inspect large surface nodes without compaction |
| `context_compact({ conclude_turn: true })` | Commit immediately and conclude only when safety checks pass |
| `context_recall({ target, query, line_range })` | Retrieve original events or search globally without loss |

The hard watermark defaults to `0.75`, targeting `0.55`. Automatic archival uses deterministic summaries and preserves recallable originals. “Lossless” means the underlying events remain intact and retrievable—not that a summary duplicates every source token.

### Verify and license

```bash
npm test
node --check lib/index.js
```

BSD-3-Clause © mikonnyan. See the GitHub repository in package metadata for source and release notes.
