/**
 * dsh-tool-gate — hide rarely used tool groups; unlock on demand.
 * Layer: profile bundle. Hooks: system-prompt/assemble (filter tools/contexts; deterministic description projection),
 * tools/pre-execute (zero-friction auto-unlock), tool `tool_unlock`, command `/tools`.
 * Filtering stays remove-only; compactSchema projects descriptions after filtering and preserves schema structure.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { permissionDecision } from './permission-guard.js'
import { ORCHESTRATOR_DEFAULTS, orchestratorDecision, appendEscapeAudit, sessionRole, escapeHatchState } from './orchestrator-guard.js'
export * from './permission-guard.js'
export * from './orchestrator-guard.js'
export * from './compact-schema.js'
import { projectTools, stripHiddenBuiltinPromptSections } from './compact-schema.js'

export const name = '@dsh-external/dsh-tool-gate'
export const inject = ['tools', 'commands']

export const EXTRAS_TOOLS = Object.freeze([
  'workflow', 'claude_code', 'claude_code_usage', 'cursor_agent', 'ralph',
  'create_goal', 'get_goal', 'update_goal', 'exit_plan_mode', 'dsh_session_read',
  'dsh_session_repair', 'dsh_session_search', 'dsh_supervisor_watch_tick',
  'modlens_read_image', 'x_search', 'read_page',
])

export const DEFAULT_CONFIG = {
  groups: {
    extras: { prefixes: [], names: [...EXTRAS_TOOLS], bypass: true, hint: 'create_goal/get_goal/update_goal、workflow、ralph、cursor_agent 等低频工具；仅用户明确要求时用，先 tool_unlock(extras, once) 再调用' },
    dev: { prefixes: ['dev_'], names: [], contextMatch: ['dsh-super-injector（dev_'], hint: '插件开发/热重载/注入/staging/模式切换 (dev_*)' },
    relay: { prefixes: ['mcp__harness_relay__'], names: [], hint: 'Harness 会话管理、查看/取消/续用 run' },
    connector: { prefixes: ['mcp_connector_'], names: [], hint: 'MCP 连接器配置/连接/状态' },
    browser: { prefixes: ['mcp__chrome-devtools__'], names: [], hint: '浏览器操作 (chrome-devtools)' },
  },
  defaultOn: [],
  includeSubagents: false,
  alwaysVisible: ['tool_unlock', 'relay_dispatch'],
  implicitIdleTurns: 2,
  explicitIdleTurns: 4,
  cacheExpiryMs: 300_000,
  hardIdleTurnsCap: 12,
  compactSchema: true,
  orchestratorGuard: ORCHESTRATOR_DEFAULTS,
}

export const isV4Session = (session) => typeof session?.eventAt === 'function' && typeof session?.snapshotEvents === 'function'
export const getAllEvents = (session) => isV4Session(session) ? session.snapshotEvents() : (session?.events ?? [])
export const getEvent = (session, seq) => isV4Session(session) ? session.eventAt(seq) : session?.events?.[seq]
export const logLength = (session) => isV4Session(session) ? session.seq : (session?.events?.length ?? 0)
export function classifyPrefixRewrite(session, summarySeq) {
  return globalThis[Symbol.for('@dsh-external/prefix-epoch')]?.bySession?.get(session)?.classBySummarySeq?.get(summarySeq) ?? 'rewrite'
}

const lifecycleStates = new WeakMap()
const orchestratorStates = new WeakMap()
const sessionId = Symbol('tool-gate-session-id')

/** In-memory lifecycle is replayed from the durable event log after a restart. */
export function syncLifecycle(session, cfg, now = Date.now()) {
  if (!session || !sidOf(session) || !isGated(session, cfg)) return undefined
  if (session[sessionId] !== sidOf(session)) {
    Object.defineProperty(session, sessionId, { value: sidOf(session), configurable: true })
    lifecycleStates.delete(session)
  }
  let state = lifecycleStates.get(session)
  if (!state) {
    state = { unlocked: new Set(), everTouched: new Set(), groupMeta: new Map(), currentTurn: 0,
      lastRequestAtMs: 0, lastModelActivityMs: 0, toolDeltaSinceSeries: false, newSummarySeqs: [], lastObservedCompactionSeq: 0, replayedEvents: 0 }
    lifecycleStates.set(session, state)
  }
  let latestCompactionSeq = state.lastObservedCompactionSeq
  state.newSummarySeqs = []
  const length = logLength(session)
  for (; state.replayedEvents < length; state.replayedEvents++) {
    const ev = getEvent(session, state.replayedEvents)
    if (!ev || (ev.sessionId && ev.sessionId !== sidOf(session))) continue
    if (typeof ev.data?.turn === 'number') state.currentTurn = Math.max(state.currentTurn, ev.data.turn)
    else if (ev.type === 'turn/start') state.currentTurn = Math.max(state.currentTurn, ev.data.turn)
    if (ev.type === 'request/header' || ev.type === 'assistant/message') {
      const time = typeof ev.data?.time === 'number' ? ev.data.time : (typeof ev.time === 'number' ? ev.time : now)
      state.lastModelActivityMs = Math.max(state.lastModelActivityMs, time)
      if (ev.type === 'request/header') state.lastRequestAtMs = Math.max(state.lastRequestAtMs, time)
    }
    if (ev.type === 'request/header' && (ev.data?.reason === 'series' || ev.data?.startsSeries)) state.toolDeltaSinceSeries = false
    if (ev.type === 'developer/message') {
      const text = JSON.stringify(ev.data ?? {})
      if (text.includes('tool-addition') || text.includes('tool-removal')) state.toolDeltaSinceSeries = true
    }
    if (ev.type === 'compaction/summary') {
      const seq = ev.seq ?? state.replayedEvents
      latestCompactionSeq = Math.max(latestCompactionSeq, seq)
      if (seq > state.lastObservedCompactionSeq) state.newSummarySeqs.push(seq)
    }
    if (ev.type !== 'tool/call' || !ev.data || typeof ev.data.name !== 'string') continue
    const d = ev.data
    if (d.parent || ev.parent || (typeof d.callId === 'string' && d.callId.startsWith('relay-dispatch-'))) continue
    if (d.name === 'tool_unlock') {
      let a; try { a = JSON.parse(d.arguments) } catch { continue }
      const action = a?.action ?? 'on'
      if (!Array.isArray(a.groups) || !['on', 'off', 'once'].includes(action)) continue
      for (const g of a.groups) {
        if (!cfg.groups[g]) continue
        state.everTouched.add(g)
        if (action === 'off') { state.unlocked.delete(g); state.groupMeta.delete(g); continue }
        state.unlocked.add(g)
        state.groupMeta.set(g, { unlockedAtTurn: state.currentTurn, lastUsedTurn: state.currentTurn,
          lastUsedAtMs: now, mode: action === 'once' ? 'once' : 'explicit-unlock' })
      }
      continue
    }
    const g = groupOf(d.name, cfg)
    if (!g) continue
    state.everTouched.add(g)
    if (cfg.groups[g]?.bypass) continue // implicit direct calls never alter the next tools[] prefix
    if (!state.unlocked.has(g)) state.unlocked.add(g)
    const meta = state.groupMeta.get(g) || { unlockedAtTurn: state.currentTurn,
      lastUsedTurn: state.currentTurn, lastUsedAtMs: now, mode: 'implicit-direct' }
    meta.lastUsedTurn = state.currentTurn; meta.lastUsedAtMs = now
    state.groupMeta.set(g, meta)
  }
  const cacheExpired = now - state.lastModelActivityMs >= (cfg.cacheExpiryMs ?? 300_000)
  const rewrite = state.newSummarySeqs.some((seq) => classifyPrefixRewrite(session, seq) === 'rewrite')
  const rebase = isV4Session(session) && state.newSummarySeqs.length > 0 && state.toolDeltaSinceSeries
  const boundary = cacheExpired || rewrite || rebase
  const hardCap = cfg.hardIdleTurnsCap ?? cfg.maxIdleTurnsCap ?? 12
  const relocked = []
  for (const g of state.unlocked) {
    const meta = state.groupMeta.get(g)
    if (!meta) continue // defaultOn and legacy /tools state remain explicit
    const idleTurns = state.currentTurn - meta.lastUsedTurn
    const onceExpired = meta.mode === 'once' && state.currentTurn > meta.lastUsedTurn
    const idleLimit = meta.mode === 'implicit-direct' ? (cfg.implicitIdleTurns ?? 2) : (cfg.explicitIdleTurns ?? 4)
    const candidate = meta.mode !== 'once' && idleTurns >= idleLimit
    const forced = hardCap > 0 && idleTurns >= hardCap
    if (onceExpired || (candidate && (boundary || forced))) {
      state.unlocked.delete(g); state.groupMeta.delete(g); relocked.push(g)
    }
  }
  state.lastObservedCompactionSeq = latestCompactionSeq
  return { state, relocked, cacheExpired, rewrite, rebase, boundary }
}

function lifecycleOpen(session, cfg, now) {
  const synced = syncLifecycle(session, cfg, now)
  return synced?.state.unlocked || new Set()
}

const home = () => process.env.DSH_HOME || join(homedir(), '.dsh')
export const configPath = () => join(home(), 'tool-gate', 'config.json')
export const statePath = () => join(home(), 'tool-gate', 'state.json')

/** Hot-read config (every call); missing/invalid file => defaults. */
export function loadConfig(path = configPath()) {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'))
    return { ...DEFAULT_CONFIG, ...raw, groups: { ...DEFAULT_CONFIG.groups, ...(raw.groups || {}) }, orchestratorGuard: { ...ORCHESTRATOR_DEFAULTS, ...(raw.orchestratorGuard || {}) } }
  } catch { return DEFAULT_CONFIG }
}

function loadState(path = statePath()) {
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return {} }
}
function saveState(state, path = statePath()) {
  try { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(state, null, 1)) } catch {}
}

/** Group a tool name belongs to, or undefined. */
export function groupOf(toolName, cfg) {
  if (typeof toolName !== 'string' || !toolName || cfg.alwaysVisible?.includes(toolName)) return undefined
  for (const [g, def] of Object.entries(cfg.groups)) {
    if (def.names?.includes(toolName) || def.prefixes?.some((p) => validPrefix(p) && toolName.startsWith(p))) return g
  }
  return undefined
}

const sidOf = (session) => session?.header?.id || ''

const validPrefix = (p) => typeof p === 'string' && p.length > 0
export function replaySources(session, cfg) {
  const out = {}
  const sid = sidOf(session)
  for (const ev of getAllEvents(session)) {
    if (ev?.type !== 'tool/call') continue
    const d = ev.data
    if (!d || typeof d.name !== 'string' || !d.name) continue
    if (ev.sessionId && sid && ev.sessionId !== sid) continue
    if (d.parent || ev.parent || (typeof d.callId === 'string' && d.callId.startsWith('relay-dispatch-'))) continue
    if (d.name === 'tool_unlock') {
      let a; try { a = JSON.parse(d.arguments) } catch { continue }
      if (!a || !Array.isArray(a.groups)) continue
      const on = a.action !== 'off'
      for (const g of a.groups) if (typeof g === 'string' && cfg?.groups?.[g]) out[g] = { on, src: 'tool_unlock' }
      continue
    }
    const g = cfg ? groupOf(d.name, cfg) : undefined
    if (g && !cfg.groups[g]?.bypass) out[g] = { on: true, src: '自动放行' }
  }
  return out
}
export function replayUnlocks(session, cfg) {
  return Object.fromEntries(Object.entries(replaySources(session, cfg)).map(([g, v]) => [g, v.on]))
}

/** Per-group open state with source. defaults < lifecycle (replay + cache-sync auto-relock) < /tools state (this session only). */
export function openSources(session, cfg, state = loadState(), now = Date.now()) {
  const m = {}
  for (const g of cfg.defaultOn || []) if (cfg.groups[g]) m[g] = { on: true, src: 'config 默认' }
  const synced = syncLifecycle(session, cfg, now)
  if (synced) {
    for (const g of synced.state.everTouched) {
      if (!cfg.groups[g]) continue
      const on = synced.state.unlocked.has(g)
      const mode = synced.state.groupMeta.get(g)?.mode
      m[g] = { on, src: cfg.groups[g]?.bypass && !mode ? '直调放行(缓存不变)' : (mode === 'implicit-direct' ? '自动放行' : 'tool_unlock') }
    }
  } else {
    Object.assign(m, replaySources(session, cfg))
  }
  const sid = sidOf(session)
  const st = sid && state && Object.prototype.hasOwnProperty.call(state, sid) ? state[sid] : {}
  for (const [g, v] of Object.entries(st || {})) if (cfg.groups[g] && typeof v === 'boolean') m[g] = { on: v, src: '/tools 手动' }
  return m
}
export function openGroups(session, cfg, state = loadState(), now = Date.now()) {
  const m = openSources(session, cfg, state, now)
  return new Set(Object.keys(m).filter((g) => m[g].on))
}
function isGated(session, cfg) {
  return cfg.includeSubagents || (session?.header?.delegationDepth ?? 0) === 0
}

function hasGoalHistory(session) {
  return getAllEvents(session).some((ev) => ev?.type === 'tool/call' && ev.data?.name === 'create_goal')
}

function projectSections(sections, session, cfg) {
  if (!Array.isArray(sections) || !isGated(session, cfg)) return sections
  const open = openGroups(session, cfg)
  const options = { hasGoalHistory: hasGoalHistory(session), logger: (s) => console.warn(`[tool-gate] ${s}`) }
  return sections.map((section) => typeof section?.text === 'string' ? { ...section, text: stripHiddenBuiltinPromptSections(section.text, open, options) } : section)
}

/** Pure filter used by the assemble hook (remove-only). */
export function filterTools(tools, session, cfg, state, now = Date.now()) {
  if (!Array.isArray(tools) || !isGated(session, cfg)) return tools
  const open = openGroups(session, cfg, state, now)
  return tools.filter((t) => { const g = groupOf(t.name, cfg); return g === undefined || open.has(g) })
}

/** Remove runtime contexts tied to a closed group (text contains a group's contextMatch marker). Remove-only. */
export function filterContexts(contexts, session, cfg, state, now = Date.now()) {
  if (!Array.isArray(contexts) || !contexts.length || !isGated(session, cfg)) return contexts
  const open = openGroups(session, cfg, state, now)
  const closed = Object.entries(cfg.groups).filter(([g, d]) => !open.has(g) && Array.isArray(d.contextMatch) && d.contextMatch.length)
  if (!closed.length) return contexts
  const textOf = (c) => typeof c === 'string' ? c : (typeof c?.text === 'string' ? c.text : (typeof c?.content === 'string' ? c.content : ''))
  return contexts.filter((c) => { const s = textOf(c); return !closed.some(([, d]) => d.contextMatch.some((m) => typeof m === 'string' && m && s.includes(m))) })
}

/** Plugin-internal calls (e.g. relay_dispatch, callId prefix relay-dispatch-) or nested sub-dispatches (parent set) are not model-direct: never gate them. */
export function isInternalCall(exec) {
  return !!(exec && (exec.parent || (typeof exec.callId === 'string' && exec.callId.startsWith('relay-dispatch-'))))
}

/** Pure pre-execute decision. */
export function gateDecision(toolName, session, cfg, state) {
  if (!isGated(session, cfg)) return { kind: 'allow' }
  const g = groupOf(toolName, cfg)
  if (g === undefined || openGroups(session, cfg, state).has(g)) return { kind: 'allow' }
  return { kind: 'allow', autoUnlock: g }
}

function setRolePlain(session) {
  const sid = sidOf(session); if (!sid) return
  const state = loadState(); state[sid] = { ...(state[sid] || {}), role: 'plain' }
  saveState(state)
}

function setGroups(session, groups, on) {
  const sid = sidOf(session); if (!sid || !groups.length) return
  const state = loadState()
  state[sid] = { ...(state[sid] || {}) }
  for (const g of groups) state[sid][g] = on
  saveState(state)
}

function setLifecycleGroups(session, groups, action) {
  const synced = syncLifecycle(session, loadConfig())
  if (!synced) return
  for (const g of groups) {
    synced.state.everTouched.add(g)
    if (action === 'off') { synced.state.unlocked.delete(g); synced.state.groupMeta.delete(g); continue }
    synced.state.unlocked.add(g)
    synced.state.groupMeta.set(g, { unlockedAtTurn: synced.state.currentTurn,
      lastUsedTurn: synced.state.currentTurn, lastUsedAtMs: Date.now(),
      mode: action === 'once' ? 'once' : action === 'implicit-direct' ? 'implicit-direct' : 'explicit-unlock' })
  }
}

function statusText(session, cfg) {
  const open = openGroups(session, cfg); const src = openSources(session, cfg)
  return ['### 工具组状态 (/tools)', ...Object.entries(cfg.groups).map(([g, d]) => `- **${g}**: ${open.has(g) ? '✅ 已开启（来源: ' + src[g].src + '）' : '🔒 隐藏'} — ${d.hint || ''}`),
    '', '用法: `/tools <组> on|off`、`/tools all on|off`'].join('\n')
}

export function apply(ctx) {
  const index = () => Object.entries(loadConfig().groups).map(([g, d]) => `- ${g}: ${d.hint || ''}`).join('\n')
  ctx.effect(() => ctx.tools.register({
    name: 'tool_unlock',
    description: ['打开/关闭被隐藏的工具组（下一轮请求起生效，会话内保持）。需要以下能力时先调用（知道工具名时也可直接调用，会自动解锁该组）：', index(), '参数 groups: 组名数组；action: on(默认)|off|once(单轮)。'].join('\n'),
    parameters: { type: 'object', properties: { groups: { type: 'array', items: { type: 'string' } }, action: { type: 'string', enum: ['on', 'off', 'once'] } }, required: ['groups'], additionalProperties: false },
    output: { schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string' } }, required: ['text'] }, render: (_a, v) => [{ type: 'text', text: v.text }] },
    async execute(args, exec) {
      const cfg = loadConfig()
      const action = args?.action ?? 'on'
      const on = action !== 'off'
      const gs = (Array.isArray(args?.groups) ? args.groups : []).filter((g) => typeof g === 'string')
      const bad = gs.filter((g) => !cfg.groups[g]); const ok = gs.filter((g) => cfg.groups[g])
      setLifecycleGroups(exec?.agent?.session, ok, action)
      if (!ok.length) return { text: `groups 为空或无效，未${on ? '开启' : '关闭'}任何组。${bad.length ? '未知组: ' + bad.join(', ') + '。' : ''}可选组名: ${Object.keys(cfg.groups).join(', ')}。\n当前状态: ${Object.keys(cfg.groups).map((g) => g + '=' + (openGroups(exec?.agent?.session, cfg).has(g) ? '开' : '隐藏')).join(', ')}` }
      return { text: `${action === 'once' ? '已单轮开启' : on ? '已开启' : '已关闭'}: ${ok.join(', ') || '(无)'}${bad.length ? `；未知组: ${bad.join(', ')}（可用: ${Object.keys(cfg.groups).join(', ')}）` : ''}。下一轮起生效。` }
    },
  }), name + ': tool_unlock')

  ctx.on('system-prompt/assemble', async (_a, context, next) => {
    const assembled = await next()
    try {
      const s = context?.agent?.session, cfg = loadConfig()
      const filtered = filterTools(assembled.tools, s, cfg)
      const tools = isGated(s, cfg) ? projectTools(filtered, cfg.compactSchema !== false, (m) => { try { ctx.logger('tool-gate').warn(m) } catch {} }) : filtered
      const out = { ...assembled, tools }
      if (Array.isArray(assembled.contexts)) out.contexts = filterContexts(assembled.contexts, s, cfg)
      if (Array.isArray(assembled.sections)) out.sections = projectSections(assembled.sections, s, cfg)
      return out
    } catch { return assembled }
  })

  ctx.on('tools/pre-execute', async (exec, next) => {
    if (isInternalCall(exec)) return next()
    // Child policy runs before the extensible approval chain. It can only narrow
    // access; malformed child policy fails closed and never becomes an ask/popup.
    try {
      const permission = permissionDecision(exec.name, exec.arguments || {}, exec.agent?.session)
      if (permission.kind === 'deny') {
        try { ctx.logger('tool-gate').info(`permission-deny ${permission.error?.code || 'DSH_HIGH_RISK_APPROVAL_REQUIRED'} ${exec.name}`) } catch {}
        return permission
      }
    } catch (err) {
      const { localDeny, isChildSession, manifestOf } = await import('./permission-guard.js')
      if (isChildSession(exec.agent?.session)) return localDeny('policy_evaluation_failed', manifestOf(exec.agent?.session), { detail: String(err?.message || err).slice(0, 200) })
    }
    const session = exec.agent?.session, cfg = loadConfig()
    try {
      const state = session && (orchestratorStates.get(session) || orchestratorStates.set(session, {}).get(session))
      const role = cfg.orchestratorGuard || ORCHESTRATOR_DEFAULTS
      const d = orchestratorDecision(exec.name, exec.arguments || {}, session, role, state, Date.now(), { workspace: session?.header?.cwd, cwd: session?.header?.cwd, codeRoots: [join(homedir(), '.dsh', 'plugins'), join(dirname(fileURLToPath(import.meta.url)), '..')] })
      if (d.kind === 'deny') return d
      if (d.escaped) try { appendEscapeAudit(d.audit) } catch {}
      if (d.notice) try { ctx.logger('tool-gate').info(d.notice) } catch {}
    } catch (err) { try { ctx.logger('tool-gate').info('orchestrator-guard fail-open ' + String(err?.message || err).slice(0, 120)) } catch {} }
    const prev = await next()
    if (prev.kind !== 'allow') return prev
    try {
      const d = gateDecision(exec.name, exec.agent?.session, loadConfig())
      if (d.autoUnlock && !loadConfig().groups[d.autoUnlock]?.bypass) { setLifecycleGroups(exec.agent?.session, [d.autoUnlock], 'implicit-direct'); try { ctx.logger('tool-gate').info('auto-unlocked group ' + d.autoUnlock + ' (call ' + exec.name + ')') } catch {} }
      return { kind: 'allow' }
    } catch { return prev }
  })

  ctx.effect(() => ctx.commands.register({
    name: 'tools',
    description: '工具组开关：/tools | /tools <组|all> on|off',
    input: { hint: '<group|all> on|off' },
    handler: ({ agent, rawInput }) => {
      const cfg = loadConfig(); const session = agent?.session
      const [t, a] = String(rawInput || '').trim().toLowerCase().split(/\s+/)
      if (!t) return { kind: 'success', text: statusText(session, cfg) }
      if (t === 'role') {
        if (a === 'plain') { setRolePlain(session); return { kind: 'success', text: '会话角色已手动降级为 plain（来源: /tools 手动）' } }
        if (a) return { kind: 'error', text: '用法: /tools role [plain]' }
        const state = session && (orchestratorStates.get(session) || {})
        const role = sessionRole(session, Date.now(), { ...cfg.orchestratorGuard, state: loadState()[sidOf(session)] })
        return { kind: 'success', text: `role: ${role}\nescape: ${JSON.stringify(escapeHatchState(session, cfg.orchestratorGuard, state))}` }
      }
      if (a !== 'on' && a !== 'off') return { kind: 'error', text: '用法: /tools <组|all> on|off' }
      const gs = t === 'all' ? Object.keys(cfg.groups) : [t]
      if (t !== 'all' && !cfg.groups[t]) return { kind: 'error', text: `未知组 ${t}，可用: ${Object.keys(cfg.groups).join(', ')}` }
      setGroups(session, gs, a === 'on')
      return { kind: 'success', text: statusText(session, cfg) + '\n\n（下一轮请求起生效）' }
    },
  }), name + ': /tools')
}
