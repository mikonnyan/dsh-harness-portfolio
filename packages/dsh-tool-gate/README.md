# `@dsh-external/dsh-tool-gate`

**DeepSeek Harness 工具面治理与按需技能加载（Tool-Surface Governance & On-Demand Skill Loading）**

`@dsh-external/dsh-tool-gate` 是面向 DeepSeek Harness (DSH) 的轻量级工具面治理（Tool-Surface Governance）插件包。它通过 **重型工具组默认门控（Tool Group Gating）**、**运行时幽灵上下文联动剥离（Context Stripping）** 与 **按需技能搜索加载（On-Demand Skill Discovery & Loading）**，将常规会话首轮可见工具数从 **137 个收敛至 38 个**，同时彻底消除 ~9KB 全量 `<available_skills>` 目录注入。

---

## 核心特性

1. **4 大重型工具组默认隐藏（137 → 38）**
   - 默认隐藏低频高开销工具组：`dev` (`dev_*`)、`relay` (`mcp__harness_relay__*`)、`connector` (`mcp_connector_*`)、`browser` (`mcp__chrome-devtools__*`)。
   - 保留高频核心编码工具与 `tool_unlock`、`relay_dispatch` 常驻入口。
2. **显式解锁 + 零摩擦自动放行（Zero-Friction Auto-Unlock）**
   - **模型显式解锁**：调用常驻工具 `tool_unlock({ groups: ["dev"], action: "on" | "off" })`，下一轮请求起生效。
   - **直接调用自动放行**：若模型已知工具名并直接发起调用，`tools/pre-execute` 钩子不报错拦截，而是当场放行执行并自动将该组标记为已解锁。
   - **手动斜杠命令**：支持 `/tools` 查看各组状态及来源，`/tools <group|all> on|off` 手动切换。
3. **幽灵指令联动剥离（Ghost Context Stripping）**
   - 在 `system-prompt/assemble` 阶段，根据未解锁工具组的 `contextMatch` 规则同步过滤 `assembled.contexts`（例如 `dev` 组未解锁时剥离 `dsh-super-injector` 运行时说明），防止“提示词里教模型用工具，但工具表里找不到”的幽灵指令诱导。
4. **三级状态优先级与断点续传（Resume-Safe Durability）**
   - 状态优先级：`config.json 默认配置` < `durable session events 事件流重放` < `/tools 手动状态覆盖`。
   - 跨会话恢复（Resume/Fork）时自动扫描历史 `tool/call` 事件重放解锁状态，且自动过滤插件内部调用（`relay-dispatch-*`）与子代理嵌套调用（`parent`）。
5. **按需技能加载（`./skill-search`）**
   - 替代全量注入 `<available_skills>` 的默认插件，提供 `skill_search`（支持英文分词、中文 2-gram 切片与 `*` 全量枚举）和 `skill_load`（通过 `agent.inject` 注入单条技能全文至下一轮请求）。

---

## 目录结构

```text
packages/dsh-tool-gate/
├── cordis.patch.yml          # DSH Profile Bundle 挂载声明
├── package.json              # 包定义与导出入口
├── README.md                 # 使用与配置说明
├── lib/
│   ├── index.js              # dsh-tool-gate 主插件（工具组过滤、上下文剥离、tool_unlock、/tools）
│   └── skill-search.js       # 按需技能检索与注入插件（skill_search、skill_load）
└── test/
    ├── gate.test.mjs         # 工具门控与状态重放单元测试
    └── skill-search.test.mjs # 技能检索与加载单元测试
```

---

## 安装与挂载

### 1. 挂载 `dsh-tool-gate`（Profile Bundle 层）

在 `~/.dsh/profiles/web/package.json` 中链接本包并加入 `dsh.profile.bundles`：

```json
{
  "dependencies": {
    "@dsh-external/dsh-tool-gate": "link:./packages/dsh-tool-gate"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@dsh-external/dsh-tool-gate"
      ]
    }
  }
}
```

### 2. 挂载 `skill-search`（Agent Preset 层）

在自定义 Preset 的 `agent.cordis.yml` 中，用 `skill-search.js` 替换原有的 `@deepseek-ai/dsh-tool-skill`：

```yaml
- id: skill-filesystem
  name: '@deepseek-ai/dsh-skill-filesystem'

- id: skill-search
  name: '@dsh-external/dsh-tool-gate/skill-search'
```

---

## 热更新配置（无需重启）

配置文件默认位于 `~/.dsh/tool-gate/config.json`（可通过环境变量 `DSH_HOME` 覆盖根目录，文件缺省时回退至内置 `DEFAULT_CONFIG`）：

```json
{
  "groups": {
    "dev": {
      "prefixes": ["dev_"],
      "names": [],
      "contextMatch": ["dsh-super-injector（dev_"],
      "hint": "插件开发/热重载/注入/staging/模式切换 (dev_*)"
    },
    "relay": {
      "prefixes": ["mcp__harness_relay__"],
      "names": [],
      "hint": "Harness 会话管理、查看/取消/续用 run"
    },
    "connector": {
      "prefixes": ["mcp_connector_"],
      "names": [],
      "hint": "MCP 连接器配置/连接/状态"
    },
    "browser": {
      "prefixes": ["mcp__chrome-devtools__"],
      "names": [],
      "hint": "浏览器操作 (chrome-devtools)"
    }
  },
  "defaultOn": [],
  "includeSubagents": false,
  "alwaysVisible": ["tool_unlock", "relay_dispatch"]
}
```

---

## 验证与测试

```bash
npm run check
npm test
```
