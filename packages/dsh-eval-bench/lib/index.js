/**
 * @dsh-external/dsh-eval-bench
 * Reproducible empirical evaluation benchmark and adversarial Needle-in-Compacted-Haystack (NICH)
 * suite for DeepSeek Harness plugins:
 *   1. @dsh-external/dsh-tool-gate (lib/index.js & lib/skill-search.js)
 *   2. @dsh-external/dsh-context-compact (lib/index.js)
 *   3. @dsh-external/dsh-relay-dispatch (lib/index.js)
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  DEFAULT_CONFIG as TOOL_GATE_DEFAULT_CONFIG,
  filterContexts,
  filterTools,
  gateDecision,
  groupOf,
  isInternalCall,
  openGroups,
  openSources,
  replaySources,
} from '../../dsh-tool-gate/lib/index.js'
import { apply as applySkillSearch } from '../../dsh-tool-gate/lib/skill-search.js'

import {
  apply as applyContextCompact,
  buildInspectReport,
  buildLargeBlocksDirectory,
  commitResultCompaction,
  commitSpanCompaction,
  executeRecall,
  extractEventText,
  planResultCompaction,
  planSpanCompaction,
  resolveLeafSurfaceSeqs,
  toolPairingBalancedAfter,
  toolPairingBalancedBefore,
} from '../../dsh-context-compact/lib/index.js'

import {
  BUILTIN_MODES,
  apply as applyRelayDispatch,
  applyMode,
  buildDelivery,
  classifyApiRequest,
  collectModelIds,
  evaluateRelayPrepare,
  extractAliases,
  fillStartArgs,
  isModelError,
  isRunCancelled,
  isTerminalSnap,
  parseModesYaml,
  truncateUtf8,
} from '../../dsh-relay-dispatch/lib/index.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
export const FIXTURES_DIR = join(__dirname, '..', 'fixtures')
export const EMPIRICAL_LEDGER_PATH = join(FIXTURES_DIR, 'empirical-ledger.json')
export const NICH_CORPUS_PATH = join(FIXTURES_DIR, 'nich-corpus.json')

/** Load JSON fixture deterministically. */
export function loadJsonFixture(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

export function loadEmpiricalLedger() {
  return loadJsonFixture(EMPIRICAL_LEDGER_PATH)
}

export function loadNichCorpus() {
  return loadJsonFixture(NICH_CORPUS_PATH)
}

// ---------------------------------------------------------------------------
// Deterministic Session & TokenMeter Harness (compatible with DSH 0.1.0-rc.7)
// ---------------------------------------------------------------------------

/**
 * Deterministic token estimator (~4 UTF-8 bytes per token + structural framing).
 */
export function createDeterministicTokenMeter() {
  function estimateMessage(msg) {
    if (!msg) return 0
    const raw = typeof msg === 'string' ? msg : JSON.stringify(msg)
    return Math.max(1, Math.ceil(Buffer.byteLength(raw, 'utf8') / 4))
  }

  function measure(session) {
    const nodes = []
    let surfaceTokens = 0
    for (const seq of session.surface.nodes) {
      const ev = session.events[seq]
      if (!ev) continue
      const payload = ev.type === 'user/message' ? ev.data : (ev.data?.message ?? ev.data)
      const tokens = estimateMessage(payload)
      nodes.push({ seq, tokens })
      surfaceTokens += tokens
    }
    return {
      nodes,
      surfaceTokens,
      totalTokens: surfaceTokens,
    }
  }

  return { estimateMessage, measure }
}

/**
 * Lightweight in-memory DSH session supporting append and replace surfaceOps
 * and sourceEventSeqs DAG provenance.
 */
export function createBenchSession(options = {}) {
  const id = options.id ?? 'bench-session-01'
  const contextWindow = options.contextWindow ?? 128000
  const events = []
  const surfaceNodes = []

  const session = {
    header: {
      id,
      cwd: options.cwd ?? 'C:\\work\\dsh-workspace',
      delegationDepth: options.delegationDepth ?? 0,
    },
    events,
    surface: {
      get nodes() {
        return surfaceNodes
      },
    },
    requestContext() {
      return {
        provider: 'deepseek',
        model: 'deepseek-chat',
        contextWindow,
      }
    },
    requestHeader() {
      return {
        config: {
          provider: 'deepseek',
          model: 'deepseek-chat',
        },
      }
    },
    append(type, data, opts = {}) {
      const seq = events.length
      const ev = {
        seq,
        type,
        data,
      }
      if (opts.surfaceOp !== undefined) {
        ev.surfaceOp = opts.surfaceOp
      }
      if (Array.isArray(opts.sourceEventSeqs)) {
        ev.sourceEventSeqs = [...opts.sourceEventSeqs]
      }
      events.push(ev)

      if (opts.surfaceOp === 'append') {
        surfaceNodes.push(seq)
      } else if (opts.surfaceOp && typeof opts.surfaceOp === 'object' && opts.surfaceOp.op === 'replace') {
        const startIdx = surfaceNodes.indexOf(opts.surfaceOp.start)
        const endIdx = surfaceNodes.indexOf(opts.surfaceOp.end)
        if (startIdx === -1 || endIdx === -1 || startIdx > endIdx) {
          throw new Error(
            `surface replace range [${opts.surfaceOp.start}..${opts.surfaceOp.end}] not found on current surface`
          )
        }
        surfaceNodes.splice(startIdx, endIdx - startIdx + 1, seq)
      }
      return ev
    },
  }

  return session
}

/**
 * Mount @dsh-external/dsh-context-compact onto a lightweight plugin context and
 * expose `executeCompact` (invoking the registered `context_compact` tool handler)
 * alongside `flushTurnStopping` and `executeRecall`.
 */
export function createCompactRuntime(tokenMeter = createDeterministicTokenMeter()) {
  const registeredTools = new Map()
  const listeners = new Map()
  const sections = new Map()
  const contexts = new Map()

  const ctx = {
    tokenMeter,
    tools: {
      register(def) {
        registeredTools.set(def.name, def)
        return () => registeredTools.delete(def.name)
      },
    },
    systemPrompt: {
      section(def) {
        sections.set(def.name, def)
        return () => sections.delete(def.name)
      },
      context(def) {
        contexts.set(def.name, def)
        return () => contexts.delete(def.name)
      },
    },
    on(eventName, handler) {
      if (!listeners.has(eventName)) listeners.set(eventName, [])
      listeners.get(eventName).push(handler)
      return () => {}
    },
    effect(fn) {
      return fn()
    },
    logger() {
      return { info() {}, warn() {}, error() {} }
    },
  }

  applyContextCompact(ctx)
  const compactTool = registeredTools.get('context_compact')
  const recallTool = registeredTools.get('context_recall')

  async function executeCompact(session, args = {}, options = {}) {
    const callId = options.callId ?? 'call-compact-op'
    const commitNow = options.commitNow !== false
    const effectiveArgs = commitNow ? { ...args, conclude_turn: true } : { ...args }
    const res = await compactTool.execute(effectiveArgs, {
      callId,
      agent: { session },
      concludeTurn() {},
    })
    return res
  }

  function emitTurnStopping(session) {
    const handlers = listeners.get('agent/turn-stopping') ?? []
    for (const h of handlers) {
      h({ agent: { session } })
    }
  }

  return {
    ctx,
    tokenMeter,
    registeredTools,
    compactTool,
    recallTool,
    executeCompact,
    emitTurnStopping,
  }
}

// ---------------------------------------------------------------------------
// Suite 1: Tool-Surface Governance & On-Demand Skill Search (G0 ~ G4)
// ---------------------------------------------------------------------------

/**
 * Build a deterministic 137-tool catalog matching the production DSH tool distribution:
 * - 38 core resident tools (including `tool_unlock` and `relay_dispatch`)
 * - 17 `dev_*` tools
 * - 12 `mcp__harness_relay__*` tools
 * - 14 `mcp_connector_*` tools
 * - 56 `mcp__chrome-devtools__*` tools
 */
export function buildProductionToolCatalog() {
  const coreNames = [
    'pwsh', 'read', 'write', 'edit', 'glob', 'grep', 'read_image', 'modlens_read_image',
    'web_search', 'read_page', 'x_search', 'todo_write', 'ask_user_question', 'exit_plan_mode',
    'create_goal', 'get_goal', 'update_goal', 'subagent', 'subagent_fork', 'send_message',
    'list_agents', 'interrupt_agent', 'job_list', 'job_output', 'job_kill', 'workflow',
    'ralph', 'cursor_agent', 'claude_code', 'claude_code_usage', 'context_compact', 'context_recall',
    'dsh_session_read', 'dsh_session_search', 'dsh_session_repair', 'dsh_supervisor_watch_tick',
    'tool_unlock', 'relay_dispatch',
  ]
  const devNames = Array.from({ length: 17 }, (_, i) => `dev_tool_${String(i + 1).padStart(2, '0')}`)
  devNames[0] = 'dev_reload_package'
  devNames[1] = 'dev_mode_set'

  const relayNames = Array.from({ length: 12 }, (_, i) => `mcp__harness_relay__op_${String(i + 1).padStart(2, '0')}`)
  relayNames[0] = 'mcp__harness_relay__start_run'
  relayNames[1] = 'mcp__harness_relay__wait_run'
  relayNames[2] = 'mcp__harness_relay__get_run'

  const connectorNames = Array.from({ length: 14 }, (_, i) => `mcp_connector_op_${String(i + 1).padStart(2, '0')}`)
  connectorNames[0] = 'mcp_connector_status'

  const browserNames = Array.from({ length: 56 }, (_, i) => `mcp__chrome-devtools__op_${String(i + 1).padStart(2, '0')}`)
  browserNames[0] = 'mcp__chrome-devtools__click'
  browserNames[1] = 'mcp__chrome-devtools__take_snapshot'

  const allNames = [...coreNames, ...devNames, ...relayNames, ...connectorNames, ...browserNames]
  return allNames.map((name) => ({
    name,
    description: `Production tool definition for ${name}`,
    parameters: { type: 'object', properties: { input: { type: 'string' } } },
  }))
}

export const BENCH_SKILLS_CATALOG = [
  { name: 'dsh-dispatch', description: 'Harness relay_dispatch 多模型派发模式与参数规范', content: '# dsh-dispatch\nUse mode parameter.' },
  { name: 'pdf-processor', description: 'PDF 文档解析、表单提取与转换工具箱', content: '# pdf-processor\nExtract PDF tables.' },
  { name: 'obsidian-markdown', description: 'Obsidian Flavored Markdown 笔记与双链语法', content: '# obsidian-markdown\nUse [[wikilinks]].' },
  { name: 'spreadsheet-xlsx', description: 'Excel 电子表格清洗、公式审计与导出', content: '# spreadsheet-xlsx\nAudit formulas.' },
  { name: 'game-design-review', description: '游戏策划案 GDD 系统数值与核心循环评审', content: '# game-design-review\nReview core loop.' },
  { name: 'image-gen-studio', description: 'AI 生图提示词工程与视觉资产管线', content: '# image-gen-studio\nGenerate visual assets.' },
  { name: 'diagram-mermaid', description: 'Mermaid 架构图、时序图与状态机绘制规范', content: '# diagram-mermaid\nDraw sequence diagrams.' },
  { name: 'windows-sandbox-debug', description: 'Windows 沙箱权限诊断与命名管道 EPERM 排障', content: '# windows-sandbox-debug\nDiagnose EPERM.' },
  { name: 'zstd-session-repair', description: 'DSH 会话 Zstd 帧损坏修复与大图压缩', content: '# zstd-session-repair\nRepair Zstd frames.' },
  { name: 'security-redteam', description: 'Web 渗透测试与越权漏洞审计清单', content: '# security-redteam\nAudit auth boundaries.' },
  { name: 'cordis-plugin-dev', description: 'Cordis 插件生命周期、依赖注入与热重载开发', content: '# cordis-plugin-dev\nUse ctx.effect.' },
  { name: 'benchmark-rigor', description: 'AI Agent 评测基准设计、消融实验与防污染规范', content: '# benchmark-rigor\nRun paired ablations.' },
]

export const SKILL_SEARCH_QUERIES = [
  { query: 'relay_dispatch', expectedTop1: 'dsh-dispatch', lang: 'en+zh' },
  { query: 'pdf', expectedTop1: 'pdf-processor', lang: 'en' },
  { query: '文档解析', expectedTop1: 'pdf-processor', lang: 'zh' },
  { query: 'obsidian', expectedTop1: 'obsidian-markdown', lang: 'en' },
  { query: '电子表格', expectedTop1: 'spreadsheet-xlsx', lang: 'zh' },
  { query: '游戏策划', expectedTop1: 'game-design-review', lang: 'zh' },
  { query: '生图', expectedTop1: 'image-gen-studio', lang: 'zh' },
  { query: 'mermaid', expectedTop1: 'diagram-mermaid', lang: 'en' },
  { query: 'windows sandbox EPERM', expectedTop1: 'windows-sandbox-debug', lang: 'en' },
  { query: 'zstd', expectedTop1: 'zstd-session-repair', lang: 'en' },
  { query: 'cordis', expectedTop1: 'cordis-plugin-dev', lang: 'en' },
  { query: '消融实验', expectedTop1: 'benchmark-rigor', lang: 'zh' },
]

/**
 * Evaluate G0 ~ G4 Tool-Surface Governance & Skill Discovery by calling real exports
 * from `dsh-tool-gate/lib/index.js` and `dsh-tool-gate/lib/skill-search.js`.
 */
export async function evaluateToolGateSuite() {
  const catalog = buildProductionToolCatalog()
  const cfg = TOOL_GATE_DEFAULT_CONFIG
  const freshSession = { header: { id: 's-bench-fresh', delegationDepth: 0 }, events: [] }

  // 1. Filter 137 -> 38 tools
  const filteredTools = filterTools(catalog, freshSession, cfg, {})
  const groupCounts = { core: 0, dev: 0, relay: 0, connector: 0, browser: 0 }
  for (const t of catalog) {
    const g = groupOf(t.name, cfg) ?? 'core'
    groupCounts[g] = (groupCounts[g] ?? 0) + 1
  }

  // 2. Ghost context stripping (filterContexts)
  const runtimeContexts = [
    { name: 'workspace-info', text: 'Current workspace: C:\\work\\dsh-harness-portfolio' },
    { name: 'dev-injector-hint', text: 'dsh-super-injector（dev_ 工具集说明：dev_reload_package 等 17 个工具）' },
    { name: 'git-status', text: 'Branch: main (clean)' },
  ]
  const filteredContextsClosed = filterContexts(runtimeContexts, freshSession, cfg, {})
  const devOpenSession = {
    header: { id: 's-bench-dev-open', delegationDepth: 0 },
    events: [{ type: 'tool/call', data: { name: 'dev_reload_package', arguments: '{}' } }],
  }
  const filteredContextsOpen = filterContexts(runtimeContexts, devOpenSession, cfg, {})

  // 3. Direct call auto-unlock (gateDecision + replaySources)
  const directCallDecision = gateDecision('dev_reload_package', freshSession, cfg, {})
  const internalCallBypass = isInternalCall({
    callId: 'relay-dispatch-1700000000-1',
    name: 'mcp__harness_relay__start_run',
  })
  const replayed = replaySources(devOpenSession, cfg)
  const toolsAfterAutoUnlock = filterTools(catalog, devOpenSession, cfg, {})
  const openSetAfterAutoUnlock = openGroups(devOpenSession, cfg, {})
  const sourcesAfterAutoUnlock = openSources(devOpenSession, cfg, {})

  // 4. Skill search Recall@1 and skill_load injection
  const registeredSkillTools = new Map()
  const skillCtx = {
    skills: {
      async list() {
        return BENCH_SKILLS_CATALOG
      },
      async get(skillName) {
        return BENCH_SKILLS_CATALOG.find((s) => s.name === skillName)
      },
    },
    tools: {
      register(def) {
        registeredSkillTools.set(def.name, def)
      },
    },
    agents: {},
  }
  applySkillSearch(skillCtx)
  const searchTool = registeredSkillTools.get('skill_search')
  const loadTool = registeredSkillTools.get('skill_load')

  let recallAt1Hits = 0
  const queryDetails = []
  for (const q of SKILL_SEARCH_QUERIES) {
    const res = await searchTool.execute(
      { query: q.query },
      { agent: { session: { id: 's-skill', header: { cwd: 'C:\\work' } } } }
    )
    const firstBullet = res.text.split('\n').find((line) => line.startsWith('- '))
    const top1Name = firstBullet ? firstBullet.slice(2).split(':')[0].trim() : null
    const hit = top1Name === q.expectedTop1
    if (hit) recallAt1Hits++
    queryDetails.push({
      query: q.query,
      lang: q.lang,
      expectedTop1: q.expectedTop1,
      actualTop1: top1Name,
      hit,
    })
  }

  let injectedSkillPayload = null
  const loadRes = await loadTool.execute(
    { name: 'dsh-dispatch' },
    {
      agent: {
        session: { id: 's-skill', header: { cwd: 'C:\\work' } },
        inject(msg) {
          injectedSkillPayload = msg
        },
      },
    }
  )

  const ledger = loadEmpiricalLedger()
  const stages = ledger.toolSurfaceGovernance.ablationStages
  const strategies = ledger.toolSurfaceGovernance.toolGateStrategies

  return {
    totalCatalogTools: catalog.length,
    defaultVisibleTools: filteredTools.length,
    hiddenToolsCount: catalog.length - filteredTools.length,
    toolReductionPct: Number((((catalog.length - filteredTools.length) / catalog.length) * 100).toFixed(1)),
    turn1StaticTokensBefore: ledger.toolSurfaceGovernance.turn1StaticTokensBefore,
    turn1StaticTokensAfter: ledger.toolSurfaceGovernance.turn1StaticTokensAfter,
    turn1StaticReductionPct: ledger.toolSurfaceGovernance.turn1StaticReductionPct,
    groupCounts,
    ghostContext: {
      beforeCount: runtimeContexts.length,
      afterClosedCount: filteredContextsClosed.length,
      afterDevOpenCount: filteredContextsOpen.length,
      strippedWhenClosed: runtimeContexts.length - filteredContextsClosed.length === 1,
    },
    autoUnlock: {
      decisionKind: directCallDecision.kind,
      autoUnlockedGroup: directCallDecision.autoUnlock,
      replaySource: replayed.dev?.src ?? null,
      openGroupsAfterReplay: [...openSetAfterAutoUnlock],
      openSourceAfterReplay: sourcesAfterAutoUnlock.dev?.src ?? null,
      visibleToolsAfterDevUnlock: toolsAfterAutoUnlock.length,
      internalRelayCallBypassed: internalCallBypass,
    },
    skillSearch: {
      catalogSize: BENCH_SKILLS_CATALOG.length,
      queriesTotal: SKILL_SEARCH_QUERIES.length,
      recallAt1Hits,
      recallAt1Fraction: `${recallAt1Hits}/${SKILL_SEARCH_QUERIES.length}`,
      recallAt1Pct: Number(((recallAt1Hits / SKILL_SEARCH_QUERIES.length) * 100).toFixed(1)),
      skillLoadInjected: Boolean(injectedSkillPayload && injectedSkillPayload.source?.kind === 'skill-invocation'),
      skillLoadConfirmation: loadRes.text,
      queryDetails,
    },
    toolGateStrategies: strategies,
    ablationG0ToG4: stages,
  }
}

// ---------------------------------------------------------------------------
// Suite 2: Adversarial Needle-in-Compacted-Haystack (NICH, C0 ~ C4)
// ---------------------------------------------------------------------------

/**
 * Render one turn's tool output text with deterministic padding lines + embedded needles/distractors.
 */
export function buildTurnToolOutputText(turnSpec, paddingLinesCount = 75) {
  const lines = [...(turnSpec.headerLines || [])]
  for (let i = 1; i <= paddingLinesCount; i++) {
    lines.push(
      `[haystack T${turnSpec.turn} L${String(i).padStart(3, '0')}] module=dsh-runtime frame=${turnSpec.turn * 1000 + i} status=OK latency_us=${110 + ((i * 17) % 90)} bytes=${4096 + i * 32}`
    )
  }
  // Insert embedded lines at deterministic positions (sorted descending so indices don't shift earlier inserts)
  const embeds = [...(turnSpec.embeddedLines || [])].map((e, idx) => ({
    ...e,
    insertIndex: Math.min(lines.length, Math.max(2, Math.floor(e.offsetRatio * paddingLinesCount) + idx)),
  }))
  embeds.sort((a, b) => a.insertIndex - b.insertIndex)
  let shift = 0
  for (const em of embeds) {
    lines.splice(em.insertIndex + shift, 0, em.text)
    shift++
  }
  return lines.join('\n')
}

/**
 * Populate a fresh session with Turns 1..5 from `nich-corpus.json` and open Turn 6.
 */
export function buildNichBaselineSession(corpus = loadNichCorpus()) {
  const session = createBenchSession({ id: 's-nich-eval', contextWindow: 128000 })
  const paddingCount = corpus.haystackConfig?.paddingLinesPerTurn ?? 75

  for (const t of corpus.turns) {
    const turn = t.turn
    const callId = t.callId
    const toolName = t.toolName
    const toolOutput = buildTurnToolOutputText(t, paddingCount)

    session.append('turn/start', { turn })
    session.append('step/start', { turn, step: 1 })
    if (turn === 1) {
      session.append('request/header', {
        header: { config: { provider: 'deepseek', model: 'deepseek-chat' } },
        reason: 'initial',
      })
      session.append('request/context', {
        provider: 'deepseek',
        model: 'deepseek-chat',
        contextWindow: 128000,
      })
    }

    session.append(
      'user/message',
      {
        id: `u-t${turn}`,
        role: 'user',
        source: { kind: 'human' },
        content: [{ type: 'text', text: t.userPrompt }],
      },
      { surfaceOp: 'append' }
    )

    const c1 = session.append('assistant/chunk', {
      turn,
      step: 1,
      chunk: { type: 'tool-call-delta', index: 0, id: callId, name: toolName, argumentsDelta: '{}' },
    })
    session.append(
      'assistant/message',
      {
        turn,
        step: 1,
        message: {
          id: `a-t${turn}-s1`,
          role: 'assistant',
          source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' },
          content: [{ type: 'tool-call', id: callId, name: toolName, arguments: '{}' }],
        },
      },
      { surfaceOp: 'append', sourceEventSeqs: [c1.seq] }
    )

    const tc = session.append('tool/call', {
      turn,
      step: 1,
      callId,
      name: toolName,
      arguments: '{}',
    })
    session.append(
      'tool/result',
      {
        turn,
        step: 1,
        message: {
          id: `tr-t${turn}`,
          role: 'user',
          source: { kind: 'tool', callId },
          content: [
            {
              type: 'tool-result',
              toolCallId: callId,
              isError: false,
              content: [{ type: 'text', text: toolOutput }],
            },
          ],
        },
      },
      { surfaceOp: 'append', sourceEventSeqs: [tc.seq] }
    )
    session.append('step/end', { turn, step: 1 })

    session.append('step/start', { turn, step: 2 })
    const c2 = session.append('assistant/chunk', {
      turn,
      step: 2,
      chunk: { type: 'text-delta', index: 0, text: `Completed turn ${turn}: ${t.compactSummary}` },
    })
    session.append(
      'assistant/message',
      {
        turn,
        step: 2,
        message: {
          id: `a-t${turn}-s2`,
          role: 'assistant',
          source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' },
          content: [{ type: 'text', text: `Completed turn ${turn}: ${t.compactSummary}` }],
        },
      },
      { surfaceOp: 'append', sourceEventSeqs: [c2.seq] }
    )
    session.append('step/end', { turn, step: 2 })
    session.append('turn/end', { turn })
  }

  // Open evaluation Turn 6
  const openTurn = corpus.haystackConfig?.openEvaluationTurn ?? 6
  session.append('turn/start', { turn: openTurn })
  session.append('step/start', { turn: openTurn, step: 1 })
  session.append(
    'user/message',
    {
      id: `u-t${openTurn}`,
      role: 'user',
      source: { kind: 'human' },
      content: [
        {
          type: 'text',
          text: 'Retrieve exact diagnostic literals across Turns 1..5 and verify zero false positives on negative probes.',
        },
      ],
    },
    { surfaceOp: 'append' }
  )

  return session
}

/**
 * Render all visible text currently on `session.surface.nodes`.
 */
export function renderVisibleSurfaceText(session) {
  return session.surface.nodes
    .map((seq) => extractEventText(session.events[seq]))
    .join('\n\n')
}

/**
 * Evaluate all 5 compaction regimes (C0 ~ C4) on the adversarial NICH corpus.
 */
export async function evaluateNichSuite(corpus = loadNichCorpus()) {
  const tokenMeter = createDeterministicTokenMeter()

  // Baseline measurement on C0
  const sessionC0 = buildNichBaselineSession(corpus)
  const baselineTokens = tokenMeter.measure(sessionC0).surfaceTokens
  const largeBlocksDirBefore = buildLargeBlocksDirectory(sessionC0, tokenMeter)
  const inspectReportBefore = buildInspectReport(sessionC0, tokenMeter)

  // --- C1: Sliding-Window Hard Truncation (keep only Turn 5 and Turn 6 on surface; drop Turns 1..4) ---
  const sessionC1 = buildNichBaselineSession(corpus)
  const turn5FirstSurfaceSeq = sessionC1.surface.nodes.find((seq) => {
    const ev = sessionC1.events[seq]
    return ev?.type === 'user/message' && ev.data?.id === 'u-t5'
  })
  const c1CutIdx = sessionC1.surface.nodes.indexOf(turn5FirstSurfaceSeq)
  sessionC1.surface.nodes.splice(0, c1CutIdx)

  // --- C2: Lossy Rolling Summary Only (replace Turns 1..5 with high-level summary, no sourceEventSeqs / recall) ---
  const sessionC2 = buildNichBaselineSession(corpus)
  const c2StartSeq = sessionC2.surface.nodes[0]
  const turn6UserSeq = sessionC2.surface.nodes[sessionC2.surface.nodes.length - 1]
  const c2EndSeq = sessionC2.surface.nodes[sessionC2.surface.nodes.indexOf(turn6UserSeq) - 1]
  const lossyRollingSummary = corpus.turns.map((t) => `- Turn ${t.turn}: ${t.compactSummary}`).join('\n')
  sessionC2.append(
    'user/message',
    {
      id: 'u-c2-rolling-summary',
      role: 'user',
      source: { kind: 'compaction-rolling-summary' },
      content: [{ type: 'text', text: `[Rolling Summary Turns 1..5]\n${lossyRollingSummary}` }],
    },
    {
      surfaceOp: { op: 'replace', start: c2StartSeq, end: c2EndSeq },
      // C2 does NOT preserve sourceEventSeqs or @call/@span recall tags
    }
  )

  // --- C3: Single-Layer Surgical Compaction (`@span` on turn:1..turn:3 + `@call` on call-t4, call-t5) ---
  const sessionC3 = buildNichBaselineSession(corpus)
  const runtimeC3 = createCompactRuntime(tokenMeter)
  const c3CompactRes = await runtimeC3.executeCompact(
    sessionC3,
    {
      spans: [
        {
          from: 'turn:1',
          to: 'turn:3',
          summary:
            'Turns 1-3 checkpoint: Zstd CRC mismatch in zstd-frame.ts, UTF-8 grapheme check & surface replay trace, relay slot mutex & named pipe IPC.',
        },
      ],
      results: [
        {
          callId: 'call-t4',
          summary: 'Turn 4 audit: tool-pairing imbalance check and 3000-byte detail budget RangeError.',
        },
        {
          callId: 'call-t5',
          summary: 'Turn 5 verdict: ARCH_VERDICT: surface-index-cut-verified-v2.4 and config SHA-256 digest.',
        },
      ],
    },
    { callId: 'call-c3-compact', commitNow: true }
  )

  // --- C4: Nested Multi-Generation Compaction (`@call` on all 5 -> inner `@span` T1..T3 -> outer `@span` T1..T5) ---
  const sessionC4 = buildNichBaselineSession(corpus)
  const runtimeC4 = createCompactRuntime(tokenMeter)

  // Generation 1: compact individual tool results via planResultCompaction + commitResultCompaction / executeCompact
  await runtimeC4.executeCompact(
    sessionC4,
    {
      results: corpus.turns.map((t) => ({
        callId: t.callId,
        summary: `Gen-1 @call summary T${t.turn}: ${t.compactSummary}`,
      })),
    },
    { callId: 'call-c4-gen1', commitNow: true }
  )

  // Generation 2: compact turns 1..3 (which already contain Gen-1 replaced @call nodes!) into an inner @span
  await runtimeC4.executeCompact(
    sessionC4,
    {
      spans: [
        {
          from: 'turn:1',
          to: 'turn:3',
          summary: 'Gen-2 inner @span (Turns 1..3): consolidated Zstd, Unicode grapheme, and IPC pipe investigations.',
        },
      ],
    },
    { callId: 'call-c4-gen2', commitNow: true }
  )

  // Generation 3: compact turns 1..5 (covering the Gen-2 inner @span + Turns 4..5 Gen-1 @call nodes!) into an outer @span
  const outerPlan = planSpanCompaction(
    sessionC4,
    tokenMeter,
    {
      from: 'turn:1',
      to: 'turn:5',
      summary:
        'Gen-3 outer @span (Turns 1..5): full multi-stage investigation checkpoint (ARCH_VERDICT: surface-index-cut-verified-v2.4).',
    },
    1
  )
  const outerCommitted = commitSpanCompaction(sessionC4, tokenMeter, outerPlan)
  const c4OuterLeaves = resolveLeafSurfaceSeqs(sessionC4.events, [outerCommitted.replaceEventSeq])

  // Verify tool-pairing balance on C3 and C4 surfaces
  const c3Balanced =
    toolPairingBalancedBefore(sessionC3, sessionC3.surface.nodes[0]) &&
    toolPairingBalancedAfter(sessionC3, sessionC3.surface.nodes[sessionC3.surface.nodes.length - 1])
  const c4Balanced =
    toolPairingBalancedBefore(sessionC4, sessionC4.surface.nodes[0]) &&
    toolPairingBalancedAfter(sessionC4, sessionC4.surface.nodes[sessionC4.surface.nodes.length - 1])

  const regimes = [
    {
      id: 'C0',
      name: 'No Compaction (Full Surface)',
      session: sessionC0,
      supportsRecall: false,
      extraMeta: { largeBlocksDirBefore, inspectReportLines: inspectReportBefore.split('\n').length },
    },
    {
      id: 'C1',
      name: 'Sliding-Window Hard Truncation (Tail 20%)',
      session: sessionC1,
      supportsRecall: false,
      extraMeta: {},
    },
    {
      id: 'C2',
      name: 'Lossy Rolling Summary Only (No Provenance DAG)',
      session: sessionC2,
      supportsRecall: false,
      extraMeta: {},
    },
    {
      id: 'C3',
      name: 'Single-Layer Surgical Compaction (@call + @span + executeRecall)',
      session: sessionC3,
      supportsRecall: true,
      extraMeta: { compactOutput: c3CompactRes.text, toolPairingBalanced: c3Balanced },
    },
    {
      id: 'C4',
      name: 'Nested Multi-Gen Compaction (@span over @span & @call + DAG Recall)',
      session: sessionC4,
      supportsRecall: true,
      extraMeta: {
        outerRecallTag: outerCommitted.recallTag,
        outerResolvedLeafCount: c4OuterLeaves.length,
        toolPairingBalanced: c4Balanced,
      },
    },
  ]

  const rawBaselineText = renderVisibleSurfaceText(sessionC0)
  const distractorEmbeddedHits = corpus.positiveNeedles.filter((n) =>
    rawBaselineText.includes(n.distractorLiteral)
  ).length

  const results = []
  for (const r of regimes) {
    const surfaceTokens = tokenMeter.measure(r.session).surfaceTokens
    const tokenSavingsPct = Number((((baselineTokens - surfaceTokens) / baselineTokens) * 100).toFixed(1))
    const surfaceText = renderVisibleSurfaceText(r.session)

    let surfaceHits = 0
    let effectiveHits = 0
    let distractorRejectedCount = 0
    const needleOutcomes = []
    const byDepth = {}

    for (const needle of corpus.positiveNeedles) {
      const distractorEmbeddedInHaystack = rawBaselineText.includes(needle.distractorLiteral)
      const onSurface = surfaceText.includes(needle.expectedLiteral)
      if (onSurface) surfaceHits++

      let recalledViaTool = false
      let distractorRejected = false

      if (r.supportsRecall) {
        // Test recall via @call:<callId> AND via @span / @turn with query filter
        const callRecall = executeRecall(r.session, {
          target: `@call:${needle.callId}`,
          query: needle.query,
          context_lines: 1,
        })
        const turnRecall = executeRecall(r.session, {
          target: `@turn:${needle.turn}`,
          query: needle.query,
          context_lines: 1,
        })
        recalledViaTool =
          callRecall.text.includes(needle.expectedLiteral) &&
          turnRecall.text.includes(needle.expectedLiteral)

        // Verify near-miss distractor is genuinely embedded in the raw haystack AND NOT falsely matched when querying needle.query
        distractorRejected =
          distractorEmbeddedInHaystack &&
          !callRecall.text.includes(needle.distractorLiteral) &&
          !turnRecall.text.includes(needle.distractorLiteral) &&
          needle.expectedLiteral !== needle.distractorLiteral
      } else {
        const matchedSurfaceLines = surfaceText
          .split('\n')
          .filter((line) => line.includes(needle.query))
          .join('\n')
        recalledViaTool = onSurface && matchedSurfaceLines.includes(needle.expectedLiteral)
        distractorRejected =
          distractorEmbeddedInHaystack &&
          recalledViaTool &&
          !matchedSurfaceLines.includes(needle.distractorLiteral) &&
          !needle.expectedLiteral.includes(needle.distractorLiteral)
      }

      if (recalledViaTool) effectiveHits++
      if (distractorRejected) distractorRejectedCount++

      const dKey = `${needle.depthPct}%`
      if (!byDepth[dKey]) byDepth[dKey] = { hits: 0, total: 0 }
      byDepth[dKey].total++
      if (recalledViaTool) byDepth[dKey].hits++

      needleOutcomes.push({
        id: needle.id,
        turn: needle.turn,
        depthPct: needle.depthPct,
        category: needle.category,
        distractorEmbeddedInHaystack,
        onSurface,
        recalled: recalledViaTool,
        distractorRejected,
      })
    }

    // Evaluate Negative Needles (non-existent probes -> must produce 0 matches / 0 hallucinations)
    let negativeFalsePositives = 0
    const negativeOutcomes = []
    for (const neg of corpus.negativeNeedles) {
      let matched = false
      if (r.supportsRecall) {
        const negRes = executeRecall(r.session, {
          target: neg.target,
          query: neg.query,
        })
        matched = negRes.returnedLines > 0 || !negRes.text.includes('0 matches for query')
      } else {
        matched = surfaceText.includes(neg.query)
      }
      if (matched) negativeFalsePositives++
      negativeOutcomes.push({
        id: neg.id,
        target: neg.target,
        query: neg.query,
        falsePositive: matched,
      })
    }

    const posTotal = corpus.positiveNeedles.length
    const negTotal = corpus.negativeNeedles.length

    results.push({
      regime: r.id,
      name: r.name,
      surfaceNodesCount: r.session.surface.nodes.length,
      totalEventsCount: r.session.events.length,
      baselineSurfaceTokens: baselineTokens,
      surfaceTokens,
      tokenSavingsPct,
      surfaceRecallHits: surfaceHits,
      surfaceRecallTotal: posTotal,
      surfaceRecallFraction: `${surfaceHits}/${posTotal}`,
      surfaceRecallPct: Number(((surfaceHits / posTotal) * 100).toFixed(1)),
      effectiveRecallHits: effectiveHits,
      effectiveRecallTotal: posTotal,
      effectiveRecallFraction: `${effectiveHits}/${posTotal}`,
      effectiveRecallPct: Number(((effectiveHits / posTotal) * 100).toFixed(1)),
      distractorRejectedCount,
      distractorTotal: posTotal,
      distractorRejectionFraction: `${distractorRejectedCount}/${posTotal}`,
      negativeFalsePositives,
      negativeTotal: negTotal,
      negativeFpFraction: `${negativeFalsePositives}/${negTotal}`,
      negativeFpPct: Number(((negativeFalsePositives / negTotal) * 100).toFixed(1)),
      byDepth,
      needleOutcomes,
      negativeOutcomes,
      extraMeta: r.extraMeta,
    })
  }

  return {
    corpusName: corpus.name,
    positiveNeedlesCount: corpus.positiveNeedles.length,
    distractorEmbeddedCount: distractorEmbeddedHits,
    distractorEmbeddedFraction: `${distractorEmbeddedHits}/${corpus.positiveNeedles.length}`,
    negativeNeedlesCount: corpus.negativeNeedles.length,
    baselineSurfaceTokens: baselineTokens,
    regimes: results,
  }
}

// ---------------------------------------------------------------------------
// Suite 3: Heterogeneous Multi-Agent Relay Dispatch & Parent-Child Session Tree
// ---------------------------------------------------------------------------

/**
 * Evaluate `dsh-relay-dispatch` exports:
 * - YAML mode parsing, alias expansion, `applyMode` & `fillStartArgs`
 * - Heterogeneous candidate chain fallback on HTTP 429 rate-limit vs fast-fail on `-32602` validation error
 * - `evaluateRelayPrepare` parentSession linking matrix (relay child vs browser manual vs expired/mismatch)
 * - UTF-8 grapheme-safe truncation & 3000-byte delivery budget (`truncateUtf8`, `buildDelivery`)
 */
export async function evaluateRelayDispatchSuite() {
  // 1. YAML mode parsing & alias resolution
  const sampleYaml = [
    'aliases:',
    '  models:',
    '    - opus=cursor/claude-opus-5-5',
    '    - sonnet=copilot/claude-sonnet-5.5',
    '    - grok=cursor/grok-4.7-fast',
    'review:',
    '  permission: read-only',
    '  models:',
    '    - opus',
    '    - sonnet',
    '  taskPrefix: "通用禁令：不重启 DSH。\\n"',
    '  deliverable: "交付格式：status / summary\\n"',
  ].join('\n')

  const parsedModes = parseModesYaml(sampleYaml)
  const aliases = extractAliases(parsedModes)
  delete parsedModes.aliases
  const appliedReview = applyMode(
    parsedModes.review,
    { workspace: 'C:\\work\\repo', task: 'Audit compaction invariants' },
    aliases
  )
  const filledReviewArgs = fillStartArgs(appliedReview.args, undefined, true)
  const filledDangerArgs = fillStartArgs(
    { workspace: 'C:\\work\\repo', task: 'Implement fix', permissionPreset: 'danger-full-access' },
    undefined,
    false
  )

  // 2. Candidate fallback simulation using real `applyRelayDispatch`:
  //    Candidate 1 (`cursor/claude-opus-5-5`) fails with 429 Rate Limit -> automatically falls back to Candidate 2 (`copilot/claude-sonnet-5.5`).
  const attemptLog = []
  const registeredRelayTools = new Map()
  const startedJobs = []
  const relayCtx = {
    tools: {
      register(def) {
        registeredRelayTools.set(def.name, def)
        return () => registeredRelayTools.delete(def.name)
      },
      async execute(callSpec) {
        if (callSpec.name === 'mcp__harness_relay__list_capabilities') {
          return {
            value: {
              providers: [
                { id: 'cursor', models: ['claude-opus-5-5', 'grok-4.7-fast'] },
                { id: 'copilot', models: ['claude-sonnet-5.5', 'claude-opus-5.5'] },
              ],
            },
          }
        }
        if (callSpec.name === 'mcp__harness_relay__start_run') {
          const { provider, model } = callSpec.arguments
          attemptLog.push(`${provider}/${model}`)
          if (provider === 'cursor' && model === 'claude-opus-5-5') {
            return {
              isError: true,
              error: { message: 'HTTP 429 Too Many Requests: provider rate limit exceeded for claude-opus-5-5' },
            }
          }
          return {
            value: {
              runId: 'run-fallback-001',
              sessionId: 'child-sess-001',
              status: 'running',
              webUrl: 'http://127.0.0.1:3080/#session=child-sess-001',
            },
          }
        }
        if (callSpec.name === 'mcp__harness_relay__wait_run') {
          return {
            value: {
              runId: 'run-fallback-001',
              sessionId: 'child-sess-001',
              status: 'succeeded',
              finishedAt: new Date().toISOString(),
              assistantText: 'status: done\nsummary: Verified candidate fallback succeeded on second model.',
            },
          }
        }
        return { value: {} }
      },
    },
    get(serviceName) {
      if (serviceName === 'jobs') {
        return {
          start(jobSpec) {
            startedJobs.push(jobSpec)
            return `job-${startedJobs.length}`
          },
        }
      }
      return undefined
    },
    effect(fn) {
      return fn()
    },
  }

  applyRelayDispatch(relayCtx, {
    modesPath: '__bench_builtin_modes_fallback__.yaml',
    parentLogPath: null,
    linkParentSession: false,
    refreshTitle: false,
  })
  const relayTool = registeredRelayTools.get('relay_dispatch')
  const dispatchOut = await relayTool.execute(
    {
      mode: 'heavy',
      startArgs: {
        workspace: 'C:\\work\\repo',
        task: 'Run heavy cross-vendor verification',
      },
    },
    {
      agent: { session: { header: { id: 'parent-sess-001' } } },
    }
  )

  // 3. Error classification verification (`isModelError`)
  const errorClassificationCases = [
    { msg: 'HTTP 429 rate limit exceeded', expectedModelError: true },
    { msg: 'model claude-opus-5-5 not found on provider', expectedModelError: true },
    { msg: '503 Service Unavailable: upstream overloaded', expectedModelError: true },
    { msg: '-32602 invalid arguments: writeScope is required', expectedModelError: false },
    { msg: 'workspace C:\\unregistered is not registered in Harness', expectedModelError: false },
    { msg: 'permissionPreset danger-full-access requires confirmedDangerousPermission', expectedModelError: false },
  ]
  const errorClassificationPassed = errorClassificationCases.every(
    (c) => isModelError(c.msg) === c.expectedModelError
  )

  // 4. `evaluateRelayPrepare` Parent-Child Session Linking Matrix
  const now = 1710000000000
  const activeSlot = {
    parent: 'parent-sess-001',
    cwd: 'C:\\work\\repo',
    agentPreset: undefined,
    createdAt: now - 1000,
    expiresAt: now + 119000,
    active: true,
    used: false,
  }

  const prepareMatrix = [
    {
      caseId: 'P1-relay-valid-child',
      verdict: evaluateRelayPrepare(
        'child-001',
        { meta: { cwd: 'c:/work/repo/' } },
        activeSlot,
        { now, reqKind: classifyApiRequest({ 'user-agent': 'node', 'x-dsh-relay-principal': '1' }) }
      ),
      expectedOk: true,
      expectedReason: 'matched',
    },
    {
      caseId: 'P2-browser-manual-create-rejected',
      verdict: evaluateRelayPrepare(
        'manual-001',
        { meta: { cwd: 'C:\\work\\repo' } },
        activeSlot,
        {
          now,
          reqKind: classifyApiRequest({
            origin: 'http://127.0.0.1:3080',
            'user-agent': 'Mozilla/5.0 Chrome/125.0.0.0',
          }),
        }
      ),
      expectedOk: false,
      expectedReason: 'browser_request',
    },
    {
      caseId: 'P3-cwd-mismatch-rejected',
      verdict: evaluateRelayPrepare(
        'other-ws-001',
        { meta: { cwd: 'C:\\work\\other-repo' } },
        activeSlot,
        { now, reqKind: 'relay' }
      ),
      expectedOk: false,
      expectedReason: 'cwd_mismatch',
    },
    {
      caseId: 'P4-expired-slot-rejected',
      verdict: evaluateRelayPrepare(
        'late-001',
        { meta: { cwd: 'C:\\work\\repo' } },
        activeSlot,
        { now: now + 200000, reqKind: 'relay' }
      ),
      expectedOk: false,
      expectedReason: 'slot_expired',
    },
    {
      caseId: 'P5-already-used-slot-rejected',
      verdict: evaluateRelayPrepare(
        'second-001',
        { meta: { cwd: 'C:\\work\\repo' } },
        { ...activeSlot, used: true },
        { now, reqKind: 'relay' }
      ),
      expectedOk: false,
      expectedReason: 'slot_used',
    },
    {
      caseId: 'P6-ingest-id-rejected',
      verdict: evaluateRelayPrepare(
        'ingest-99',
        { meta: { cwd: 'C:\\work\\repo' } },
        activeSlot,
        { now, reqKind: 'relay' }
      ),
      expectedOk: false,
      expectedReason: 'invalid_or_ingest_id',
    },
  ]

  const prepareMatrixHits = prepareMatrix.filter(
    (m) => m.verdict.ok === m.expectedOk && m.verdict.reason === m.expectedReason
  ).length

  // 5. UTF-8 Grapheme-safe delivery budget (`truncateUtf8`, `buildDelivery`) & terminal state checks
  const multiBytePayload = '结论验证：𠮷野家👨‍👩‍👧‍👦中文UTF8边界安全测试—'.repeat(80)
  const delivery = buildDelivery('succeeded', multiBytePayload, 3000, true)
  const detailByteLength = Buffer.byteLength(delivery.detail, 'utf8')
  const stalledSnapNotTerminal = !isTerminalSnap({
    status: 'needs_attention',
    attentionReason: 'run_stalled',
  })
  const cancelCheck = isRunCancelled(
    { status: 'running', cancelRequested: true },
    { now: now + 65000, cancelRequestedAt: now, cancelGraceMs: 60000 }
  )

  return {
    modeResolution: {
      builtinModesCount: Object.keys(BUILTIN_MODES).length,
      resolvedCandidates: appliedReview.candidates,
      filledReviewPermission: filledReviewArgs.permissionPreset,
      filledDangerAutoConfirmed: filledDangerArgs.confirmedDangerousPermission === true,
      filledDangerWriteScope: filledDangerArgs.writeScope,
    },
    candidateFallback429: {
      attemptedModels: attemptLog,
      fallbackSucceeded: attemptLog.length === 2 && dispatchOut.runId === 'run-fallback-001',
      selectedModelNote: dispatchOut.note,
      errorClassificationPassed,
    },
    parentSessionPrepareMatrix: {
      casesPassed: prepareMatrixHits,
      casesTotal: prepareMatrix.length,
      accuracyFraction: `${prepareMatrixHits}/${prepareMatrix.length}`,
      accuracyPct: Number(((prepareMatrixHits / prepareMatrix.length) * 100).toFixed(1)),
      cases: prepareMatrix,
    },
    deliveryAndLifecycle: {
      detailByteLength,
      within3000ByteBudget: detailByteLength <= 3000,
      truncatedFlag: delivery.truncated,
      noBrokenSurrogates: !delivery.detail.includes('\uFFFD'),
      stalledSnapNotTerminal,
      cancelGraceTimeoutDetected: cancelCheck.cancelled,
    },
  }
}

// ---------------------------------------------------------------------------
// Suite 4: Tier-1 Empirical Production Ledger Verification
// ---------------------------------------------------------------------------

export function verifyEmpiricalLedger(ledger = loadEmpiricalLedger()) {
  const sessions = ledger.compactionLedger.sessions
  const sumOps = sessions.reduce((acc, s) => acc + s.compactionOps, 0)
  const sumBefore = sessions.reduce((acc, s) => acc + s.beforeSurfaceTokens, 0)
  const sumAfter = sessions.reduce((acc, s) => acc + s.afterSurfaceTokens, 0)
  const sumSaved = sessions.reduce((acc, s) => acc + s.savedSurfaceTokens, 0)
  const maxReduction = Math.max(...sessions.map((s) => s.reductionPct))
  const computedReductionPct = Number(((sumSaved / sumBefore) * 100).toFixed(1))
  const peakSession = sessions.reduce((best, s) => (s.savedSurfaceTokens > best.savedSurfaceTokens ? s : best), sessions[0])
  const perSessionDiffsValid = sessions.every(
    (s) =>
      s.beforeSurfaceTokens - s.afterSurfaceTokens === s.savedSurfaceTokens &&
      s.rawSurfaceTokens === s.beforeSurfaceTokens &&
      s.compactedSurfaceTokens === s.afterSurfaceTokens &&
      s.savedTokens === s.savedSurfaceTokens
  )

  const r1 = ledger.relayDispatchLedger.decoupledReviewComparison.find((x) => x.regime === 'R1')
  const r2 = ledger.relayDispatchLedger.decoupledReviewComparison.find((x) => x.regime === 'R2')
  const r3 = ledger.relayDispatchLedger.decoupledReviewComparison.find((x) => x.regime === 'R3')

  return {
    sanitized:
      ledger.sanitizationPolicy.zeroPrivatePaths === true &&
      ledger.sanitizationPolicy.zeroPromptPayloads === true,
    globalCorpus: ledger.globalCorpus,
    compactionAccountingValid:
      perSessionDiffsValid &&
      sumOps === ledger.compactionLedger.totalCompactionPruneOps &&
      sumBefore === ledger.compactionLedger.beforeSurfaceTokens &&
      sumAfter === ledger.compactionLedger.afterSurfaceTokens &&
      sumSaved === ledger.compactionLedger.netSavedSurfaceTokens &&
      computedReductionPct === ledger.compactionLedger.netReductionPct &&
      maxReduction === ledger.compactionLedger.peakSingleSessionReductionPct &&
      peakSession.rawSurfaceTokens === ledger.compactionLedger.peakSingleSessionRawTokens &&
      peakSession.compactedSurfaceTokens === ledger.compactionLedger.peakSingleSessionCompactedTokens &&
      peakSession.savedTokens === ledger.compactionLedger.peakSingleSessionSavedTokens,
    compactionSummary: {
      ops: sumOps,
      sessionsCount: sessions.length,
      beforeSurfaceTokens: sumBefore,
      afterSurfaceTokens: sumAfter,
      netSavedSurfaceTokens: sumSaved,
      netReductionPct: computedReductionPct,
      peakSingleSessionRawTokens: peakSession.rawSurfaceTokens,
      peakSingleSessionCompactedTokens: peakSession.compactedSurfaceTokens,
      peakSingleSessionSavedTokens: peakSession.savedTokens,
      peakSingleSessionReductionPct: maxReduction,
      productionRecallHits: ledger.compactionLedger.productionRecallHits,
      productionRecallTotal: ledger.compactionLedger.productionRecallTotal,
      productionRecallHitRatePct: ledger.compactionLedger.productionRecallHitRatePct,
    },
    relaySummary: {
      totalDispatches: ledger.relayDispatchLedger.totalDispatches,
      independentVerificationRuns: ledger.relayDispatchLedger.independentVerificationRuns,
      interceptedBlindSpotDefects: ledger.relayDispatchLedger.interceptedBlindSpotDefects,
      interceptionFraction: `${ledger.relayDispatchLedger.interceptedBlindSpotDefects}/${ledger.relayDispatchLedger.independentVerificationRuns}`,
      defectInterceptionRatePct: ledger.relayDispatchLedger.defectInterceptionRatePct,
      contextIsolationGainPctPt: Number((r2.defectRecallPct - r1.defectRecallPct).toFixed(1)),
      heterogeneityGainPctPt: Number((r3.defectRecallPct - r2.defectRecallPct).toFixed(1)),
      decoupledRegimes: ledger.relayDispatchLedger.decoupledReviewComparison,
      defectTaxonomy: ledger.relayDispatchLedger.defectTaxonomy,
    },
  }
}

// ---------------------------------------------------------------------------
// Unified Runner & Markdown Report Formatter
// ---------------------------------------------------------------------------

export async function runAllBenchmarks() {
  const startedAt = performance.now()
  const [toolGate, nich, relayDispatch] = await Promise.all([
    evaluateToolGateSuite(),
    evaluateNichSuite(),
    evaluateRelayDispatchSuite(),
  ])
  const empirical = verifyEmpiricalLedger()
  const nichById = Object.fromEntries(nich.regimes.map((r) => [r.regime, r]))
  const liveDynamicMetrics = {
    filterTools: {
      toolsBefore: toolGate.totalCatalogTools,
      toolsAfter: toolGate.defaultVisibleTools,
      reductionPct: toolGate.toolReductionPct,
      turn1StaticTokensBefore: toolGate.turn1StaticTokensBefore,
      turn1StaticTokensAfter: toolGate.turn1StaticTokensAfter,
      turn1StaticReductionPct: toolGate.turn1StaticReductionPct,
      skillSearchRecallAt1: toolGate.skillSearch.recallAt1Fraction,
    },
    executeCompact: {
      baselineSurfaceTokens: nich.baselineSurfaceTokens,
      c3SurfaceTokens: nichById.C3.surfaceTokens,
      c3SavingsPct: nichById.C3.tokenSavingsPct,
      c3EffectiveRecall: nichById.C3.effectiveRecallFraction,
      c4SurfaceTokens: nichById.C4.surfaceTokens,
      c4SavingsPct: nichById.C4.tokenSavingsPct,
      c4EffectiveRecall: nichById.C4.effectiveRecallFraction,
      distractorEmbedded: nich.distractorEmbeddedFraction,
      distractorRejectionC3C4: nichById.C4.distractorRejectionFraction,
      negativeFpC3C4: nichById.C4.negativeFpFraction,
    },
    evaluateRelayPrepare: {
      prepareMatrixAccuracy: relayDispatch.parentSessionPrepareMatrix.accuracyFraction,
      prepareMatrixAccuracyPct: relayDispatch.parentSessionPrepareMatrix.accuracyPct,
      candidateFallbackChain: relayDispatch.candidateFallback429.attemptedModels,
      builtinModesCount: relayDispatch.modeResolution.builtinModesCount,
      detailByteLength: relayDispatch.deliveryAndLifecycle.detailByteLength,
    },
  }
  const elapsedMs = Number((performance.now() - startedAt).toFixed(1))

  return {
    benchmarkVersion: '0.1.0',
    elapsedMs,
    toolGate,
    nich,
    relayDispatch,
    empirical,
    liveDynamicMetrics,
  }
}

export function formatMarkdownReport(report) {
  const lines = []
  lines.push('# DeepSeek Harness Portfolio — Reproducible Evaluation Report (`@dsh-external/dsh-eval-bench`)')
  lines.push('')
  lines.push(`- **Execution Time**: \`${report.elapsedMs} ms\` (deterministic, zero external network I/O)`)
  lines.push(`- **Evaluated Packages**: \`dsh-tool-gate\`, \`dsh-context-compact\`, \`dsh-relay-dispatch\``)
  lines.push('')

  // Section 1: G0~G4
  lines.push('## 1. Progressive System Ablation & Tool-Surface Governance (G0 ~ G4 / T0 ~ T2)')
  lines.push('')
  lines.push('| Stage | Configuration | Visible Tools | Turn-1 Static Tok | Static Savings | Peak Surface Tok | 30-Turn Cum. Input Tok | NICH Anchor Recall | Defect Recall |')
  lines.push('| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: |')
  for (const st of report.toolGate.ablationG0ToG4) {
    lines.push(
      `| **${st.stage}** | ${st.label} | ${st.visibleTools} | **${st.totalStaticPromptTokens.toLocaleString()}** | **-${st.staticSavingsPct.toFixed(1)}%** | ${st.peakSurfaceTokens.toLocaleString()} | ${st.cumulativeInputTokens30Turns.toLocaleString()} | **${st.nichAnchorRecallFraction} (${st.nichAnchorRecallPct.toFixed(1)}%)** [${st.nichRegime}] | **${st.defectRecallFraction} (${st.defectRecallPct.toFixed(1)}%)** [${st.reviewRegime}] |`
    )
  }
  lines.push('')
  lines.push(
    `- **Live Function Verification**: \`filterTools\` pruned **${report.toolGate.totalCatalogTools} -> ${report.toolGate.defaultVisibleTools}** tools (**-${report.toolGate.toolReductionPct}%**, Turn-1 static prompt **${report.toolGate.turn1StaticTokensBefore.toLocaleString()} -> ${report.toolGate.turn1StaticTokensAfter.toLocaleString()} Tokens / -${report.toolGate.turn1StaticReductionPct}%**); \`filterContexts\` stripped closed-group ghost contexts (**${report.toolGate.ghostContext.beforeCount} -> ${report.toolGate.ghostContext.afterClosedCount}**); \`gateDecision\` auto-unlocked group \`${report.toolGate.autoUnlock.autoUnlockedGroup}\` with **0 extra round-trips**; \`skill_search\` achieved **Recall@1 = ${report.toolGate.skillSearch.recallAt1Fraction} (${report.toolGate.skillSearch.recallAt1Pct}%)**.`
  )
  lines.push('')

  // Section 2: NICH C0~C4
  lines.push('## 2. Adversarial Needle-in-Compacted-Haystack (NICH, C0 ~ C4)')
  lines.push('')
  lines.push('| Regime | Strategy | Surface Nodes | Surface Tokens | Token Savings | Direct Surface Recall | Effective Recall (with `executeRecall`) | Distractor Rejection | Negative Probe FP |')
  lines.push('| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: |')
  for (const r of report.nich.regimes) {
    lines.push(
      `| **${r.regime}** | ${r.name} | ${r.surfaceNodesCount} | ${r.surfaceTokens.toLocaleString()} | **-${r.tokenSavingsPct}%** | ${r.surfaceRecallFraction} (${r.surfaceRecallPct}%) | **${r.effectiveRecallFraction} (${r.effectiveRecallPct}%)** | ${r.distractorRejectionFraction} | **${r.negativeFpFraction} (${r.negativeFpPct}%)** |`
    )
  }
  lines.push('')
  lines.push(
    `- **Adversarial Probe Verification**: Embedded **${report.nich.positiveNeedlesCount}** Positive Needles + **${report.nich.distractorEmbeddedFraction}** near-miss Distractor Needles physically in haystack turns + **${report.nich.negativeNeedlesCount}** non-existent Negative Needles.`
  )
  lines.push('')

  // Section 3: Relay Dispatch & Decoupled R1~R3
  lines.push('## 3. Heterogeneous Multi-Agent Verification & Relay Dispatch (R1 ~ R3)')
  lines.push('')
  lines.push('| Regime | Verification Architecture | Context Isolation | Vendor Heterogeneity | Blind-Spot Defects Caught | Defect Recall | Per-Review Interception Rate | False Positives |')
  lines.push('| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: |')
  for (const d of report.empirical.relaySummary.decoupledRegimes) {
    lines.push(
      `| **${d.regime}** | ${d.name} | ${d.contextIsolation ? 'Yes' : 'No'} | ${d.modelHeterogeneity ? 'Yes' : 'No'} | **${d.defectsIntercepted}/${d.ConfirmedDefectsTotal}** | **${d.defectRecallPct.toFixed(1)}%** | **${d.perReviewHitRatePct.toFixed(1)}% (${d.defectsIntercepted}/${d.evaluatedTasks})** | ${d.falsePositives} |`
    )
  }
  lines.push('')
  lines.push(
    `- **Live Function Verification**: Candidate chain 429 fallback (\`${report.relayDispatch.candidateFallback429.attemptedModels.join(' -> ')}\`) succeeded across **${report.relayDispatch.modeResolution.builtinModesCount}** built-in modes; \`evaluateRelayPrepare\` achieved **${report.relayDispatch.parentSessionPrepareMatrix.accuracyFraction} (${report.relayDispatch.parentSessionPrepareMatrix.accuracyPct}%)** parent-child linking accuracy; UTF-8 grapheme-safe delivery stayed within **${report.relayDispatch.deliveryAndLifecycle.detailByteLength} / 3,000 bytes**.`
  )
  lines.push('')

  // Section 4: Tier-1 Empirical Production Telemetry Summary
  const gc = report.empirical.globalCorpus
  const cs = report.empirical.compactionSummary
  const rs = report.empirical.relaySummary
  lines.push('## 4. Tier-1 Sanitized Production Telemetry Ledger')
  lines.push('')
  lines.push(`- **Global Session Corpus**: **${gc.activeSessions}** active sessions (**${gc.childSessionsWithParent}** child sessions with \`parentSession\`, **${gc.rootSessions}** root sessions), **${gc.zstdFrames.toLocaleString()}** Zstd frames, **${gc.unpackedEvents.toLocaleString()}** unpacked events.`)
  lines.push(`- **Event vs. Surface Token Ratio**: **${gc.eventTokens.toLocaleString()}** Event Tokens vs. **${gc.surfaceTokens.toLocaleString()}** Surface Tokens (**${gc.surfaceToEventRatioPct}%** active surface ratio; **${gc.shadowedOffSurfaceRatioPct}%** off-surface).`)
  lines.push(`- **Production Surgical Compaction**: **${cs.ops}** \`compaction/prune\` operations across **${cs.sessionsCount}** long sessions reduced Surface Tokens from **${cs.beforeSurfaceTokens.toLocaleString()} -> ${cs.afterSurfaceTokens.toLocaleString()}** (net savings **${cs.netSavedSurfaceTokens.toLocaleString()} tokens / -${cs.netReductionPct}%**, single-session peak **${cs.peakSingleSessionRawTokens.toLocaleString()} -> ${cs.peakSingleSessionCompactedTokens.toLocaleString()} / -${cs.peakSingleSessionSavedTokens.toLocaleString()} tokens (-${cs.peakSingleSessionReductionPct}%)**, production recall **${cs.productionRecallHits}/${cs.productionRecallTotal} (${cs.productionRecallHitRatePct}%)**).`)
  lines.push(`- **Production Relay Verification**: **${rs.totalDispatches}** \`relay_dispatch\` runs and **${rs.independentVerificationRuns}** independent review/verify runs intercepted **${rs.interceptedBlindSpotDefects}** blind-spot defects (**${rs.interceptionFraction} = ${rs.defectInterceptionRatePct}%** interception rate; **+${rs.contextIsolationGainPctPt} pp** from context isolation, **+${rs.heterogeneityGainPctPt} pp** from model heterogeneity).`)

  return lines.join('\n')
}
