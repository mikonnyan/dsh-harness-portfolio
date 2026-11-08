# MIGRATION.md — `dsh-context-compact` 升级指南 (`0.1.0-rc.7` → `0.2.2-rc.1`)

本文档基于 DSH `0.2.2-rc.1` 源码整理，列出从 `0.1.0-rc.7`（Session Format v0/v3）升级到 `0.2.2-rc.1`（Session Format v4）时，插件需要修改的**每一处文件、函数、旧写法→新写法、以及 DSH 依据位置**。

---

## 一眼速查总表

| # | 变更项 | 本插件修改位置 (`lib/index.js` / `package.json`) | 旧写法 (`0.1.0-rc.7`) | 新写法 (`0.2.2-rc.1`) | DSH 0.2.2-rc.1 依据 (`文件:行`) |
|---|---|---|---|---|---|
| 1 | **`surfaceOp` replace 字段重命名** | `lib/index.js`: `commitSpanCompaction`、`commitResultCompaction` | `{ op: 'replace', start: s, end: e }` | `{ op: 'replace', startSeq: s, endSeq: e }`（注：`shadowedRange` 仍为 `{ start, end }`） | `dsh-session/lib/types/types.d.ts:466-470`<br>`dsh-session/lib/index.js:293-296, 310`<br>`dsh-token-meter/lib/index.js:148, 310` |
| 2 | **`tool/result` 消息结构扁平化 (`role: 'tool'`)** | `lib/index.js`: `planResultCompaction`、`extractEventText` | `role: 'user'`，内容在 `message.content[0].content` (`type: 'tool-result'` 包裹层) | `role: 'tool'`，顶层带 `toolCallId`，`message.content` 直接是 `ContentBlock[]` | `dsh-llm/lib/types/message.d.ts:152-160`<br>`dsh-session/lib/index.js:394-412, 1216-1219`<br>`dsh-compaction-tool-result-pruner/lib/index.js:150-158` |
| 3 | **`session.events` 移除 → `eventAt` / `snapshotEvents`** | `lib/index.js`: `inspectSessionLog`、`resolveLeafSurfaceSeqs`、`resolveSurfaceNodeTurns`、`buildLargeBlocksDirectory`、`buildInspectReport`、`resolveEndpointSurfaceIndices`、`planResultCompaction`、`executeRecall`、`flushStagedCompactions` | `session.events[seq]` / `for (const ev of session.events)` | `session.eventAt(seq)` / `session.snapshotEvents()` | `dsh-session/lib/types/index.d.ts:217, 228`<br>`dsh-session/lib/index.js:1441-1460` |
| 4 | **`compactCheckpointSource` 的 `kind` 变更** | `lib/index.js`: `compactCheckpointSource` | `{ kind: 'plugin', plugin: 'compact', compactionId }` | `{ kind: 'compact-checkpoint', compactionId }`（或直接调 `@deepseek-ai/dsh-compaction` 的 `compactCheckpointSource`） | `dsh-llm/lib/types/message.d.ts:95-108`<br>`dsh-compaction/lib/index.js:109-130`<br>`dsh-client-ui-chat/lib/client.js:11585` |
| 5 | **保护 `surface.nodes[0]` (`system/message`) 不被覆盖** | `lib/index.js`: `buildLargeBlocksDirectory`、`buildInspectReport`、`resolveEndpointSurfaceIndices`、`planSpanCompaction`、`computeSurfaceCutBalance` | `system` 在 `request/header` 中，`surface.nodes` 无 `system/message` | `surface.nodes[0]` 为 `system/message`，跳过 `system/message` 与 `developer/message`，禁止纳入 `spans` 替换区间 | `dsh-session/lib/types/types.d.ts:450`<br>`dsh-session/lib/index.js:267, 419-423`<br>`dsh-compaction-basic/lib/index.js:396-415` |
| 6 | **`package.json` 版本兼容门禁 (`engines.dsh`)** | `package.json` | 仅声明 `peerDependencies` | 新增 `"engines": { "dsh": ">=0.1.0-rc.0 <0.3.0-0" }` | `dsh-app-boot/lib/index.js:1119-1144, 1806, 3113` |
| 7 | **大块目录使用 `ctx.systemPrompt.context()`** | `lib/index.js`: `apply` | `ctx.systemPrompt.context({ name: 'context-compact:directory', order: 85, text: ... })`（本插件已直接采用该方式） | 保持 `ctx.systemPrompt.context(...)`（新版生成 `source.kind === 'runtime-context'`，可调 `order: 190` 并过滤 `hasSpillNotice`） | `dsh-agent-loop/lib/index.js:297-349`<br>`dsh-spill-policy/README.md:49-58` |

---

## 逐项修改明细（文件 / 函数 / 旧写法 → 新写法 / DSH 依据）

### 1. `SurfaceOp` 替换字段：`start` / `end` → `startSeq` / `endSeq`

- **DSH 依据**：
  - `dsh-session/lib/types/types.d.ts:466-470`
  - `dsh-session/lib/index.js:293-296, 310`（`isReplaceOp` 严格校验 `Object.keys(op).length === 3` 且键名必须为 `op`、`startSeq`、`endSeq`）
  - `dsh-compaction/lib/types/types.d.ts:40-42, 90-93` & `dsh-token-meter/lib/index.js:148, 310`（注意：`compaction/prune` 与 `compaction/summary` 的 `data.shadowedRange` 内部字段**仍然是** `{ start, end }`，不改名！）
- **修改文件与函数**：
  1. `lib/index.js` → `commitSpanCompaction(session, tokenMeter, plan)`
  2. `lib/index.js` → `commitResultCompaction(session, tokenMeter, plan, activeCallId)`
- **旧写法 (`0.1.0-rc.7`)**：
  ```js
  // commitSpanCompaction & commitResultCompaction
  surfaceOp: {
    op: 'replace',
    start: currentPlan.startSeq, // 或 seq
    end: currentPlan.endSeq,     // 或 seq
  }
  ```
- **新写法 (`0.2.2-rc.1`)**：
  ```js
  // shadowedRange 保持 { start, end } 不变！
  // 但 user/message 与 tool/result 的 surfaceOp 必须改为 startSeq / endSeq：
  surfaceOp: {
    op: 'replace',
    startSeq: currentPlan.startSeq, // 或 seq
    endSeq: currentPlan.endSeq,     // 或 seq
  }
  ```

---

### 2. `tool/result` 消息结构：`role: 'user'` 嵌套块 → `role: 'tool'` 扁平 `ContentBlock[]`

- **DSH 依据**：
  - `dsh-llm/lib/types/message.d.ts:152-160`（`ToolResultMessage` 改为 `role: 'tool'`，顶层带 `toolCallId: ToolCallId`、`isError?: boolean`，`content` 直接是 `ContentBlock[]`）
  - `dsh-session/lib/index.js:394-412`（`assertToolResultRewrite` 校验除 `message.content` 外其余字段完全相等）
  - `dsh-session/lib/index.js:1216-1219`（`assertMessageEventShape` 校验 `message.role === 'tool'` 且 `message.toolCallId === message.source.callId`）
  - `dsh-compaction-tool-result-pruner/lib/index.js:150-158`
- **修改文件与函数**：
  1. `lib/index.js` → `planResultCompaction(session, tokenMeter, itemSpec, activeCallId, minSavingsTokens)`
  2. `lib/index.js` → `extractEventText(ev, callMap)`
- **旧写法 (`0.1.0-rc.7`)**：
  ```js
  // planResultCompaction:
  const origResultBlock = targetEvent.data.message.content[0]
  const newMessage = freezeMessage({
    ...targetEvent.data.message,
    content: [{
      ...origResultBlock,
      content: newContent,
    }],
  })

  // extractEventText:
  const blocks = msg?.content?.[0]?.content ?? []
  ```
- **新写法 (`0.2.2-rc.1`)**：
  ```js
  // planResultCompaction:
  const origMessage = session.deriveEventMessage(targetEvent) // role: 'tool', toolCallId, source: { kind: 'tool', callId }
  const newMessage = freezeMessage({
    ...origMessage,
    content: newContent, // 直接赋 ContentBlock[]
  })

  // extractEventText:
  const blocks = Array.isArray(msg?.content?.[0]?.content)
    ? msg.content[0].content
    : (msg?.content ?? [])
  ```

---

### 3. `session.events` 移除 → 改用 `session.eventAt(seq)` 与 `session.snapshotEvents()`

- **DSH 依据**：
  - `dsh-session/lib/types/index.d.ts:217, 228`
  - `dsh-session/lib/index.js:1441-1460`（`session.events` getter 已移除，提供按序号读取 `session.eventAt(seq)` 与快照读取 `session.snapshotEvents(fromSeq?, toSeqExclusive?)`）
- **修改文件与函数**：
  - `lib/index.js` → 新增辅助函数 `getEvent(session, seq)` 与 `getAllEvents(session)`，并替换各函数中的 `session.events`：
    ```js
    function getEvent(session, seq) {
      return typeof session.eventAt === 'function' ? session.eventAt(seq) : session.events[seq]
    }
    function getAllEvents(session) {
      return typeof session.snapshotEvents === 'function' ? session.snapshotEvents() : session.events
    }
    ```

---

### 4. `compactCheckpointSource` 的 `source.kind` 变更

- **DSH 依据**：
  - `dsh-llm/lib/types/message.d.ts:95-108`（移除通用 `plugin` kind）
  - `dsh-compaction/lib/index.js:109-130`（`compactCheckpointSource` 返回 `{ kind: 'compact-checkpoint', compactionId, ... }`）
- **新写法 (`0.2.2-rc.1`)**：
  ```js
  export function compactCheckpointSource(compactionId, sourceCommandId) {
    return Object.freeze({
      kind: 'compact-checkpoint',
      compactionId,
      ...(sourceCommandId === undefined ? {} : { sourceCommandId }),
    })
  }
  ```

---

### 5. 禁止覆盖 `surface.nodes[0]` (`system/message`) 及跳过 `system/message` / `developer/message`

- **DSH 依据**：
  - `dsh-session/lib/types/types.d.ts:450`
  - `dsh-session/lib/index.js:267, 419-423`（`assertSystemHeadRewrite`：若 `surface.nodes[0]` 是 `system/message`，任何包含 `nodes[0]` 的 `replace` 必须也是单节点 `system/message`）
- **新写法 (`0.2.2-rc.1`)**：
  ```js
  if (startIdx === 0 && getEvent(session, surfaceNodes[0])?.type === 'system/message') {
    startIdx = 1
  }
  for (let i = startIdx; i <= endIdx; i++) {
    const ev = getEvent(session, surfaceNodes[i])
    if (ev?.type === 'system/message' || ev?.type === 'developer/message') {
      throw new Error(`span cannot overwrite ${ev.type} at seq ${ev.seq}`)
    }
  }
  ```
