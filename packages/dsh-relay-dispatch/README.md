# `@dsh-external/dsh-relay-dispatch`

**异构多模型主从调度与零闪烁侧栏会话树插件（DeepSeek Harness External Plugin）**

`@dsh-external/dsh-relay-dispatch` 是面向 DeepSeek Harness (DSH) 构建的生产级主从多智能体调度基础设施（Agent Orchestration Infrastructure）。它将原本需要主会话阻塞或手动轮询 `wait_run` 的底层 Relay 调用，升级为**异步托管后台任务 + 模式化异构模型候选链 + 自动父子会话树挂载与可视化**的完整闭环。

---

## 核心特性

### 1. 主从上下文隔离与 Token 预算治理
- **一键异步派发**：主会话调用 `relay_dispatch({ mode, startArgs: { workspace, task } })` 后立即拿到 `jobId` 与 `runId` 并结束当前轮次，由插件在后台托管切片等待（`sliceMs: 30000`）。
- **单往返内联交付（`buildDelivery`）**：任务结束时，若结构化结论在 `DETAIL_BUDGET_BYTES`（3000 UTF-8 字节）预算内，直接在完成通知中内联完整结论（标记 `full_in_detail=1`），省去主会话二次调用 `job_output` 的 LLM 往返开销；若超出预算，则按 UTF-8 字素安全边界（`Intl.Segmenter`）截断生成头部预览，并附带精确的 `job_output` 全文拉取指引。

### 2. 模式化异构模型路由与自动降级（`dispatch-modes.yaml`）
- **热读配置**：每次派发动态读取 `~/.dsh/dispatch-modes.yaml`（或环境变量 `DSH_DISPATCH_MODES_PATH`），修改模式、权限预设、候选模型链与交付模板后**无需重启 DSH 即刻生效**；文件缺失或格式损坏时自动平滑回退至内置 `BUILTIN_MODES`。
- **5 大标准工程模式**：`investigate`（快速只读调查）、`implement`（代码实现）、`verify`（异构交叉验证）、`review`（深度代码审查）、`heavy`（带阶段性检查点的复杂工程任务）。
- **能力预检与故障切换**：先通过 `list_capabilities` 过滤当前环境不存在的模型；当 `start_run` 遭遇 `429 Rate Limit`、`502/503/504`、连接超时等渠道级错误（`isModelError`）时自动降级到候选链下一个模型；而对参数校验、工作区未注册等请求级错误则立即快速失败（Fail-fast）。

### 3. 通信可靠性与自愈机制
- **非侵入式停滞提醒（Stall Detection）**：综合监控子会话 `lastEventSeq`、`assistantText` 长度、本地 `session.events` 数量及事件时间戳。当子任务超过 `stallMinutes`（默认 15 分钟）无实质进展时，提取最后一个工具调用名（`extractLastToolName`）与会话链接，通过 `agent.followup()`（绝不使用 `inject` 打断正在推理的主会话）排队投递一次卡死提醒，且同一停滞周期不重复刷屏。
- **取消宽限期防挂死（`cancelGraceMs`）**：当外部触发取消（`cancelRequested: true`）但子会话卡在长耗时工具调用而维持 `running` 状态时，最多等待 `cancelGraceMs`（默认 60 秒）即强制以 `cancelled` 收口后台任务；若检测到宿主子会话已出现 `turn/end` 或 `idle`，则零等待立即收口。
- **轮询瞬时错误重试**：后台 `wait_run` 切片轮询若遇 `fetch failed`、`ECONNRESET` 等瞬时网络抖动，自动按 `waitMaxRetries`（默认 3 次）退避重试，避免长任务因瞬时闪断丢失状态。

### 4. 宿主逆向扩展与侧栏父子会话折叠树
- **无侵入注入 `parentSession`**：在官方 `start_run` 未暴露 `parentSession` 参数的前提下，通过 `Symbol.for('relay-dispatch.prepare')` + `generation` 代数锁幂等包装 `sessions.prepare` 与 `/api` 路由处理器。结合串行化 `startChain` 槽窗口、HTTP 请求头指纹识别（`classifyApiRequest` 区分浏览器手动新建与 Relay 调用）及事后 `sessionId` 一致性校验，确保父子关系 100% 准确挂载且支持无限次插件热重载。
- **React Fiber + CSS `order` 零闪烁侧栏树（`lib/client.js`）**：前端插件从 DOM 节点的 `__reactFiber$` 向上回溯提取会话 `node.id`，在不移动任何 React 托管 DOM 节点的前提下，使用 Flex 容器与 `style.order` 完成父子会话重排、多级缩进、展开/折叠状态持久化（`localStorage`）以及选中子会话自动展开祖先，彻底规避 React reconciliation 冲突与 HoverCard 动态插入 `role="status"` 子节点引发的 MutationObserver 重排死循环。

---

## 目录结构

```text
packages/dsh-relay-dispatch/
├── lib/
│   ├── index.js                     # 后端插件主体（工具注册、模式路由、后台轮询、parentSession 注入）
│   └── client.js                    # 前端插件（侧栏父子会话折叠树、React Fiber 解析、CSS order 排序）
├── test/
│   └── unit.mjs                     # 完整单元与集成测试套件（含 Mock Harness / Cordis / JobRegistry）
├── cordis.patch.yml                 # DSH Bundle 注入补丁配置
├── dispatch-modes.example.yaml      # 派发模式与异构模型候选链配置示例
├── package.json
└── README.md
```

---

## 快速开始与验证

### 1. 准备模式配置文件
将 `dispatch-modes.example.yaml` 拷贝至 `~/.dsh/dispatch-modes.yaml`（可通过环境变量 `DSH_DISPATCH_MODES_PATH` 自定义路径）：

```bash
cp dispatch-modes.example.yaml ~/.dsh/dispatch-modes.yaml
```

### 2. 环境变量说明（可选）
| 环境变量 | 说明 | 默认值 |
| :--- | :--- | :--- |
| `DSH_HOME` | DSH 用户配置根目录 | `~/.dsh` |
| `DSH_DISPATCH_MODES_PATH` | 派发模式 YAML 路径 | `~/.dsh/dispatch-modes.yaml` |
| `DSH_RELAY_PARENT_LOG_PATH` | `parentSession` 注入诊断日志路径 | `~/.dsh/relay-dispatch-parent.log` |
| `DSH_WEB_URL` | Web GUI 基础 URL（用于生成停滞提醒深链） | `http://127.0.0.1:3080` |
| `DSH_ROOT` | 测试运行时的 DSH 全局安装路径 | `%APPDATA%/npm/node_modules/@deepseek-ai/dsh` |

### 3. 运行语法检查与单元测试
```bash
node --check lib/index.js
node --check lib/client.js
node test/unit.mjs
```
