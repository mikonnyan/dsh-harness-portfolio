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
import { ORCHESTRATOR_DEFAULTS, orchestratorDecision, appendEscapeAudit, sessionRole, escapeHatchState, strictTurnDecision, isMainOrchestratorSession } from './orchestrator-guard.js'
export * from './permission-guard.js'
export * from './orchestrator-guard.js'
export * from './compact-schema.js'
export * from './session-archetype.js'
export * from './pin-store.js'
export * from './prompt-projection.js'
import { isV4Session, getAllEvents, getEvent, logLength, manifestOf, classifySession, detectRpEvidence, effectiveArchetype, publishArchetype, readArchetype, modelPair } from './session-archetype.js'
const moduleQuery = import.meta.url.includes('?') ? '?' + import.meta.url.split('?')[1] : ''
const { resolvePin, readPin, writePinAtomic, nextPin, recoverPinByReplay } = await import(`./pin-store.js${moduleQuery}`)
import { projectAssembly } from './prompt-projection.js'
import { projectTools, projectToolsWithMeta, projectLegacyV1, stripHiddenBuiltinPromptSections } from './compact-schema.js'
import { ensureOrchestratorV2Epoch, applyOrchestratorV2Surface, V2_EPOCH } from './prompt-governance-v2.js'
export { ensureOrchestratorV2Epoch, applyOrchestratorV2Surface, V2_EPOCH }

export const name = '@dsh-external/dsh-tool-gate'
export const inject = ['tools', 'commands']

// v4 accessors now live in session-archetype.js; re-exported via `export *` above.
export { isV4Session, getAllEvents, getEvent, logLength, manifestOf }

export const EXTRAS_TOOLS = Object.freeze([
  'workflow', 'claude_code', 'claude_code_usage', 'cursor_agent', 'ralph',
  'create_goal', 'get_goal', 'update_goal', 'exit_plan_mode', 'dsh_session_read',
  'dsh_session_repair', 'dsh_session_search', 'dsh_supervisor_watch_tick',
  'modlens_read_image', 'x_search', 'read_page',
])

export const DEFAULT_CONFIG = {
  groups: {
    extras: { prefixes: [], names: [...EXTRAS_TOOLS], bypass: true, hint: 'create_goal/get_goal/update_goal、workflow、ralph、cursor_agent 等低频工具；仅用户明确要求时用，先 tool_unlock(extras, once) 再调用' },
    dev: { prefixes: ['dev_'], names: [], bypass: true, contextMatch: ['dsh-super-injector（dev_'], hint: '插件开发/热重载/注入/staging/模式切换 (dev_*)' },
    relay: { prefixes: ['mcp__harness_relay__'], names: [], bypass: true, hint: 'Harness 会话管理、查看/取消/续用 run' },
    connector: { prefixes: ['mcp_connector_'], names: [], hint: 'MCP 连接器配置/连接/状态' },
    browser: { prefixes: ['mcp__chrome-devtools__'], names: [], hint: '浏览器操作 (chrome-devtools)' },
  },
  defaultOn: [],
  includeSubagents: false,
  alwaysVisible: ['tool_unlock', 'relay_dispatch'],
  implicitIdleTurns: 2,
  explicitIdleTurns: 4,
  manualIdleTurns: 8,
  cacheExpiryMs: 300_000,
  hardIdleTurnsCap: 0,
  cacheHitRatio: 0.1,
  bypassPromote: { turns: 3, hits: 4 },
  compactSchema: true,
  promptGovernanceV2: true,
  narrowReadOnlyWorkerTools: false,
  driftDetector: 'shadow',
  pinMaxAgeMs: 2_592_000_000,
  orchestratorGuard: ORCHESTRATOR_DEFAULTS,
  strictOrchestratorGuard: false,
}

// v4 accessors moved to session-archetype.js (A14); re-exported near the top.
export function classifyPrefixRewrite(session, summarySeq) {
  return globalThis[Symbol.for('@dsh-external/prefix-epoch')]?.bySession?.get(session)?.classBySummarySeq?.get(summarySeq) ?? 'rewrite'
}

/** Shared PMW registry v2. v1 records are upgraded in place; classBySummarySeq is preserved. */
export function ensurePrefixEpoch(session) {
  const key = Symbol.for('@dsh-external/prefix-epoch')
  let reg = globalThis[key]
  if (!reg || typeof reg !== 'object') {
    reg = { v: 2, bySession: new WeakMap() }
    globalThis[key] = reg
  } else {
    if (!reg.bySession) reg.bySession = new WeakMap()
    reg.v = 2
  }
  if (!session) return null
  let rec = reg.bySession.get(session)
  if (!rec) {
    rec = { classBySummarySeq: new Map(), requestClock: { now: 0, requestSeq: 0, length: -1 }, pmw: { open: false, reason: null, requestSeq: 0 }, calibration: 1 }
    reg.bySession.set(session, rec)
  } else {
    rec.classBySummarySeq ??= new Map()
    rec.requestClock ??= { now: 0, requestSeq: 0, length: -1 }
    rec.pmw ??= { open: false, reason: null, requestSeq: rec.requestClock.requestSeq || 0 }
    if (typeof rec.calibration !== 'number' || !(rec.calibration > 0)) rec.calibration = 1
  }
  return rec
}

function eventStamp(ev, index) {
  const t = ev?.ts ?? ev?.timestamp ?? ev?.data?.ts ?? ev?.data?.timestamp
  if (typeof t === 'number' && Number.isFinite(t)) return t
  return index + 1
}

function modelActivityTime(ev) {
  const t = ev?.ts ?? ev?.timestamp ?? ev?.data?.time ?? ev?.time
  return typeof t === 'number' && Number.isFinite(t) ? t : null
}

/** Hot-cache force relock only when N*c*G > (1-c)*A. Missing sizes never force. */
export function hotCacheForceRelock(cfg = {}) {
  const cap = cfg.hardIdleTurnsCap ?? cfg.maxIdleTurnsCap ?? 0
  if (!(cap > 0)) return false
  const c = typeof cfg.cacheHitRatio === 'number' ? cfg.cacheHitRatio : 0.1
  const G = cfg.groupSchemaTokens
  const A = cfg.prefixTokens
  const N = cfg.remainingRequests
  if (!(G > 0) || !(A > 0) || !(N > 0) || !(c >= 0) || !(c < 1)) return false
  return N * c * G > (1 - c) * A
}

function publishPmw(session, now, open, reason) {
  const rec = ensurePrefixEpoch(session)
  if (!rec) return
  const length = logLength(session)
  if (rec.requestClock.length !== length) {
    rec.requestClock.requestSeq = (rec.requestClock.requestSeq || 0) + 1
    rec.requestClock.length = length
    rec.requestClock.now = now
  } else if (!(rec.requestClock.now > 0)) rec.requestClock.now = now
  rec.pmw = { open: Boolean(open), reason: open ? reason : null, requestSeq: rec.requestClock.requestSeq }
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
    state = { unlocked: new Set(), everTouched: new Set(), groupMeta: new Map(), manualRelocked: new Set(), currentTurn: 0, firstTurn: null,
      lastRequestAtMs: 0, lastModelActivityMs: 0, toolDeltaSinceSeries: false, newSummarySeqs: [], lastObservedCompactionSeq: 0, replayedEvents: 0 }
    lifecycleStates.set(session, state)
  }
  state.manualRelocked ??= new Set()
  let latestCompactionSeq = state.lastObservedCompactionSeq
  const length = logLength(session)
  if (state.replayedEvents < length) {
    state.newSummarySeqs = []
    for (; state.replayedEvents < length; state.replayedEvents++) {
      const ev = getEvent(session, state.replayedEvents)
      if (!ev || (ev.sessionId && ev.sessionId !== sidOf(session))) continue
      const stamp = eventStamp(ev, state.replayedEvents)
      if (typeof ev.data?.turn === 'number') state.currentTurn = Math.max(state.currentTurn, ev.data.turn)
      else if (ev.type === 'turn/start' && typeof ev.data?.turn === 'number') state.currentTurn = Math.max(state.currentTurn, ev.data.turn)
      if (typeof ev.data?.turn === 'number' && state.firstTurn == null) state.firstTurn = ev.data.turn
      if (ev.type === 'request/header' || ev.type === 'assistant/message') {
        const time = modelActivityTime(ev)
        if (time !== null) {
          state.lastModelActivityMs = Math.max(state.lastModelActivityMs, time)
          if (ev.type === 'request/header') state.lastRequestAtMs = Math.max(state.lastRequestAtMs, time)
        }
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
            lastUsedAtMs: stamp, mode: action === 'once' ? 'once' : 'explicit-unlock', pending: false, bypassHits: [] })
        }
        continue
      }
      const g = groupOf(d.name, cfg)
      if (!g) continue
      state.everTouched.add(g)
      if (cfg.groups[g]?.bypass) {
        const meta = state.groupMeta.get(g) || { unlockedAtTurn: state.currentTurn, lastUsedTurn: state.currentTurn, lastUsedAtMs: stamp, mode: 'bypass', pending: false, bypassHits: [] }
        if (meta.mode !== 'explicit-unlock' && meta.mode !== 'once' && meta.mode !== 'manual') meta.mode = 'bypass'
        const hits = Array.isArray(meta.bypassHits) ? meta.bypassHits : []
        hits.push(state.currentTurn)
        const window = cfg.bypassPromote?.turns ?? 3
        const need = cfg.bypassPromote?.hits ?? 4
        meta.bypassHits = hits.filter((t) => state.currentTurn - t < window)
        meta.lastUsedTurn = state.currentTurn
        meta.lastUsedAtMs = stamp
        meta.promote = meta.bypassHits.length >= need
        state.groupMeta.set(g, meta)
        continue
      }
      if (!state.unlocked.has(g)) state.unlocked.add(g)
      const meta = state.groupMeta.get(g) || { unlockedAtTurn: state.currentTurn,
        lastUsedTurn: state.currentTurn, lastUsedAtMs: stamp, mode: 'implicit-direct', pending: false, bypassHits: [] }
      meta.lastUsedTurn = state.currentTurn; meta.lastUsedAtMs = stamp
      state.groupMeta.set(g, meta)
    }
    state.summarySnap = { length, seqs: [...state.newSummarySeqs], toolDelta: state.toolDeltaSinceSeries }
    state.lastObservedCompactionSeq = latestCompactionSeq
  } else {
    state.newSummarySeqs = state.summarySnap?.length === length ? [...state.summarySnap.seqs] : []
    if (state.summarySnap?.length === length) state.toolDeltaSinceSeries = state.summarySnap.toolDelta
  }
  const cacheExpired = state.lastModelActivityMs > 0 && now - state.lastModelActivityMs >= (cfg.cacheExpiryMs ?? 300_000)
  const rewrite = state.newSummarySeqs.some((seq) => classifyPrefixRewrite(session, seq) === 'rewrite')
  const rebase = isV4Session(session) && state.newSummarySeqs.length > 0 && state.toolDeltaSinceSeries
  const boundary = cacheExpired || rewrite || rebase
  const pmwReason = cacheExpired ? 'cold' : (rewrite || rebase) ? 'rewrite' : null
  publishPmw(session, now, boundary, pmwReason)
  const hardCap = cfg.hardIdleTurnsCap ?? cfg.maxIdleTurnsCap ?? 0
  const hotForce = !boundary && hotCacheForceRelock(cfg)
  for (const [g, meta] of state.groupMeta) {
    if (!meta?.promote || !boundary) continue
    state.unlocked.add(g)
    meta.mode = 'implicit-direct'
    meta.promote = false
    meta.pending = false
    meta.unlockedAtTurn = state.currentTurn
    meta.lastUsedTurn = state.currentTurn
  }
  const relocked = []
  for (const g of [...state.unlocked]) {
    const meta = state.groupMeta.get(g)
    if (!meta || meta.mode === 'defaultOn') continue
    const idleTurns = state.currentTurn - meta.lastUsedTurn
    const idleLimit = meta.mode === 'manual' ? (cfg.manualIdleTurns ?? 8)
      : meta.mode === 'implicit-direct' ? (cfg.implicitIdleTurns ?? 2)
      : (cfg.explicitIdleTurns ?? 4)
    const onceExpired = meta.mode === 'once' && state.currentTurn > meta.lastUsedTurn
    const idleHit = meta.mode !== 'once' && meta.mode !== 'bypass' && idleTurns >= idleLimit
    if (onceExpired || idleHit) meta.pending = true
    const forced = hotForce && hardCap > 0 && idleTurns >= hardCap
    if (meta.pending && (boundary || forced)) {
      if (meta.mode === 'manual') state.manualRelocked.add(g)
      state.unlocked.delete(g); state.groupMeta.delete(g); relocked.push(g)
    }
  }
  return { state, relocked, cacheExpired, rewrite, rebase, boundary, pmw: boundary }
}

function lifecycleOpen(session, cfg, now) {
  const synced = syncLifecycle(session, cfg, now)
  return synced?.state.unlocked || new Set()
}

/** §10.3: lifecycle side effects only when logLength changed; repeated calls at the same length are side-effect-free. */
export function advanceLifecycleIfLogGrew(session, cfg = loadConfig(), now = Date.now()) {
  if (!session || !sidOf(session)) return { boundary: false, advanced: false }
  const length = logLength(session)
  const key = `${sidOf(session)}:${length}`
  if (advanceClock.key === key) return { boundary: advanceClock.boundary, advanced: false }
  let synced = syncLifecycle(session, cfg, now)
  // v2 pins cover workers too; replay PMW even though legacy group filtering ignores children.
  if (!synced) synced = syncLifecycle(session, { ...cfg, includeSubagents: true }, now)
  advanceClock = { key, boundary: Boolean(synced?.boundary) }
  return { boundary: Boolean(synced?.boundary), advanced: Boolean(synced) }
}
let advanceClock = { key: '', boundary: false }

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

export function lastCommittedHeader(session) {
  const events = getAllEvents(session)
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]?.type !== 'request/header') continue
    return events[i].data?.header || events[i].data || null
  }
  return null
}
export function headerEquals(committed, projected) {
  if (!committed || !projected) return false
  const pick = (v) => ({ sections: v.sections || [], contexts: v.contexts || [], tools: v.tools || [] })
  return JSON.stringify(pick(committed)) === JSON.stringify(pick(projected))
}
function filteredForReplay(assembled, session, cfg, openSnapshot) {
  const open = new Set(openSnapshot || [])
  const out = { ...assembled }
  if (Array.isArray(out.tools) && isGated(session, cfg)) out.tools = out.tools.filter((t) => { const g = groupOf(t.name, cfg); return g === undefined || open.has(g) })
  if (Array.isArray(out.contexts) && isGated(session, cfg)) {
    const closed = Object.entries(cfg.groups).filter(([g, d]) => !open.has(g) && Array.isArray(d.contextMatch))
    out.contexts = out.contexts.filter((c) => { const text = typeof c === 'string' ? c : c?.text || c?.content || ''; return !closed.some(([, d]) => d.contextMatch.some((m) => m && text.includes(m))) })
  }
  return out
}

function projectToolsWithMetaForLegacy(tools, pin, cfg) {
  return projectToolsWithMeta(tools, { compactSchema: pin.cfgPinned?.compactSchema ?? cfg.compactSchema !== false, mapVersion: pin.legacy === 'v1-pipeline' ? 2 : pin.projVersion }).tools
}

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
      const meta = synced.state.groupMeta.get(g)
      const mode = meta?.mode
      const on = synced.state.unlocked.has(g)
      let src = 'tool_unlock'
      if (!on && (mode === 'bypass' || (cfg.groups[g]?.bypass && mode !== 'explicit-unlock' && mode !== 'once' && mode !== 'manual' && mode !== 'implicit-direct'))) src = '直调放行(缓存不变)'
      else if (mode === 'implicit-direct') src = '自动放行'
      else if (mode === 'manual') src = '/tools 手动'
      m[g] = { on, src }
    }
  } else {
    Object.assign(m, replaySources(session, cfg))
  }
  const sid = sidOf(session)
  const st = sid && state && Object.prototype.hasOwnProperty.call(state, sid) ? state[sid] : {}
  for (const [g, v] of Object.entries(st || {})) {
    if (!cfg.groups[g] || typeof v !== 'boolean') continue
    if (v === true && synced && cfg.groups[g].defaultOn !== true) {
      if (synced.state.manualRelocked?.has(g)) {
        m[g] = { on: false, src: '/tools 手动' }
        continue
      }
      let meta = synced.state.groupMeta.get(g)
      if (!meta) {
        const baseline = synced.state.firstTurn ?? 0
        meta = { mode: 'manual', unlockedAtTurn: baseline, lastUsedTurn: baseline, lastUsedAtMs: synced.state.lastModelActivityMs || now, pending: false, bypassHits: [] }
        synced.state.groupMeta.set(g, meta)
        synced.state.unlocked.add(g)
        synced.state.everTouched.add(g)
      } else if (!meta.mode) meta.mode = 'manual'
      const idle = synced.state.currentTurn - (meta.lastUsedTurn ?? 0)
      if (meta.mode === 'manual' && idle >= (cfg.manualIdleTurns ?? 8)) meta.pending = true
      if (meta.pending && (synced.boundary || hotCacheForceRelock(cfg))) {
        synced.state.manualRelocked.add(g)
        synced.state.unlocked.delete(g)
        synced.state.groupMeta.delete(g)
        m[g] = { on: false, src: '/tools 手动' }
        continue
      }
    }
    m[g] = { on: v, src: '/tools 手动' }
  }
  return m
}
export function openGroups(session, cfg, state = loadState(), now = Date.now()) {
  const m = openSources(session, cfg, state, now)
  return new Set(Object.keys(m).filter((g) => m[g].on))
}
function isGated(session, cfg) {
  if (cfg?.includeSubagents) return true
  if (!session) return true
  return isMainOrchestratorSession(session)
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

/** Pure filter used by the assemble hook (remove-only). Returns the same tool object references; callers that rewrite descriptions must copy first (those objects may be frozen). */
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

function parentSessionLookup(ctx, id) {
  if (!id) return null
  try {
    const agent = ctx.get?.('agents')?.get?.(id)
    const session = ctx.get?.('sessions')?.get?.(id) || agent?.session || null
    const route = modelPair(agent?.options?.provider, agent?.options?.model)
    if (!session) return route ? { header: { id, provider: route.provider, model: route.model } } : null
    if (!route || (session.header?.provider && session.header?.model)) return session
    return {
      header: { ...(session.header || {}), provider: route.provider, model: route.model },
      options: agent?.options,
      snapshotEvents: typeof session.snapshotEvents === 'function' ? () => session.snapshotEvents() : undefined,
      eventAt: typeof session.eventAt === 'function' ? (n) => session.eventAt(n) : undefined,
      seq: session.seq,
      events: session.events,
    }
  } catch { return null }
}

function classifyDeps(ctx, agent) {
  const route = modelPair(agent?.options?.provider, agent?.options?.model)
  return {
    hasRegisteredTool: typeof ctx?.tools?.get === 'function' ? (n) => { try { return Boolean(ctx.tools.get(n)) } catch { return false } } : undefined,
    ...(route ? { route } : {}),
    getSession: (id) => parentSessionLookup(ctx, id),
  }
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
    const s = context?.agent?.session
    const sid = s?.header?.id
    const deps = classifyDeps(ctx, context?.agent)
    // Pre-next(): publish a provisional archetype record so downstream mode-boost stands down (A9).
    let provisional = null
    if (typeof sid === 'string' && sid) {
      try {
        provisional = classifySession(s, null, deps)
        const prior = readPin(sid)
        publishArchetype(sid, { archetype: provisional.archetype, rp: provisional.archetype === 'SPECIALIZED', suppressModeBoost: prior?.projVersion === 3 && (prior.archetype === 'ORCHESTRATOR' || prior.archetype === 'WORKER_FRESH'), projVersion: prior?.projVersion ?? 3, provisional: true })
      } catch { /* provisional is best-effort */ }
    }
    const assembled = await next()
    try {
      const cfg = loadConfig()
      // No session id: pure pass-through on sessionless probes (F6).
      if (typeof sid !== 'string' || !sid) return assembled
      // Lifecycle side effects only when logLength changed (purity contract).
      const synced = advanceLifecycleIfLogGrew(s, cfg)
      const now = Date.now()
      let live = classifySession(s, assembled, deps)
      let parentPin = null
      if (live.archetype === 'WORKER_FORK') {
        const parentId = s.header?.parentSession || s.meta?.parentSession
        parentPin = readPin(parentId)
        if (!parentPin && readArchetype(parentId)?.archetype === 'SPECIALIZED') parentPin = { archetype: 'SPECIALIZED', projVersion: 0 }
        if (!parentPin && lastCommittedHeader(s)) {
          parentPin = recoverPinByReplay(s, assembled, cfg, { ...live, archetype: 'ORCHESTRATOR' }, (_input, candidate, candidateCfg) => {
            const replayPin = { ...candidate, cfgPinned: { compactSchema: candidateCfg.compactSchema !== false, promptGovernanceV2: candidateCfg.promptGovernanceV2 === true, narrowReadOnlyWorkerTools: candidateCfg.narrowReadOnlyWorkerTools === true } }
            return headerEquals(lastCommittedHeader(s), projectAssembly(assembled, replayPin, new Set(candidate.openSnapshot || []), { open: new Set(candidate.openSnapshot || []), manifest: manifestOf(s), model: s.header?.model, cwd: s.header?.cwd }))
          }, { fallbackPin: { projVersion: 0, legacy: 'passthrough' } })
          if (parentPin) writePinAtomic(parentId, parentPin)
        }
        live = { ...live, parentArchetype: parentPin?.archetype === 'WORKER_FORK' ? parentPin.parentArchetype : parentPin?.archetype, openSnapshot: parentPin?.openSnapshot, projVersion: parentPin?.projVersion }
        if (live.parentArchetype === 'SPECIALIZED') live = { ...live, archetype: 'SPECIALIZED' }
      }
      let pin = resolvePin(s, assembled, cfg, synced, now, { live, seq: logLength(s), openSnapshot: [...openGroups(s, cfg, {}, now)], lastHeader: () => lastCommittedHeader(s), lastModelActivityMs: (() => { let t = 0; for (const ev of getAllEvents(s)) if (ev.type === 'request/header' || ev.type === 'assistant/message') t = Math.max(t, ev.ts ?? ev.time ?? ev.data?.ts ?? 0); return t })(), replay: (_input, candidate, candidateCfg) => {
        const replayPin = { ...candidate, cfgPinned: { compactSchema: candidateCfg.compactSchema !== false, promptGovernanceV2: candidateCfg.promptGovernanceV2 === true, narrowReadOnlyWorkerTools: candidateCfg.narrowReadOnlyWorkerTools === true } }
        if (replayPin.projVersion === 2) {
          const filtered = filteredForReplay(assembled, s, cfg, replayPin.openSnapshot)
          filtered.tools = projectToolsWithMetaForLegacy(filtered.tools, replayPin, candidateCfg)
          filtered.sections = (filtered.sections || []).map((section) => typeof section?.text === 'string' ? { ...section, text: stripHiddenBuiltinPromptSections(section.text, new Set(replayPin.openSnapshot || []), { hasGoalHistory: hasGoalHistory(s) }) } : section)
          return headerEquals(lastCommittedHeader(s), filtered)
        }
        if (replayPin.archetype === 'SPECIALIZED') return headerEquals(lastCommittedHeader(s), assembled)
        return headerEquals(lastCommittedHeader(s), projectAssembly(assembled, replayPin, new Set(replayPin.openSnapshot || []), { open: new Set(replayPin.openSnapshot || []), manifest: manifestOf(s), model: s.header?.model, cwd: s.header?.cwd }))
      } })
      if (!pin) return assembled
      // Warm legacy orchestrators migrate once, even inside the hot-cache window, then stay locked.
      pin = ensureOrchestratorV2Epoch(pin, live, cfg, sid)
      if (pin?.archetype === 'ORCHESTRATOR' && typeof pin.surfaceModel !== 'string') {
        pin = { ...pin, surfaceModel: typeof s?.header?.model === 'string' ? s.header.model : '', surfaceCwd: typeof s?.header?.cwd === 'string' ? s.header.cwd : '' }
        writePinAtomic(sid, pin)
      }
      // Publish the final record (replaces the provisional one; A9).
      publishArchetype(sid, {
        archetype: pin.archetype,
        rp: Boolean(detectRpEvidence(s, assembled)),
        suppressModeBoost: pin.projVersion === 3 && (pin.archetype === 'ORCHESTRATOR' || pin.archetype === 'WORKER_FRESH'),
        projVersion: pin.projVersion,
        provisional: false,
      })
      // SPECIALIZED and legacy passthrough: return assembled untouched (A12, P7).
      if (pin.archetype === 'SPECIALIZED' || pin.legacy === 'passthrough') return assembled
      // Legacy v1 sessions keep the frozen v1 pipeline until rollout completes.
      if (pin.legacy === 'v1-pipeline' || pin.projVersion === 0 || cfg.promptGovernanceV2 !== true) {
        const open = new Set(pin.openSnapshot || openGroups(s, cfg))
        const filtered = pin.openSnapshot ? filteredForReplay(assembled, s, cfg, pin.openSnapshot).tools : filterTools(assembled.tools, s, cfg)
        const tools = isGated(s, cfg) ? projectToolsWithMetaForLegacy(filtered, pin, cfg) : filtered
        const out = { ...assembled, tools }
        if (Array.isArray(assembled.contexts)) out.contexts = pin.openSnapshot ? filteredForReplay(assembled, s, cfg, pin.openSnapshot).contexts : filterContexts(assembled.contexts, s, cfg)
        if (Array.isArray(assembled.sections)) out.sections = pin.projVersion === 3 ? assembled.sections : assembled.sections.map((section) => typeof section?.text === 'string' ? { ...section, text: stripHiddenBuiltinPromptSections(section.text, open, { hasGoalHistory: hasGoalHistory(s) }) } : section)
        return out
      }
      const openList = pin.openSnapshot || [...openGroups(s, cfg)]
      const gated = pin.openSnapshot
        ? filteredForReplay(assembled, s, cfg, pin.openSnapshot)
        : { ...assembled, tools: filterTools(assembled.tools, s, cfg), ...(Array.isArray(assembled.contexts) ? { contexts: filterContexts(assembled.contexts, s, cfg) } : {}) }
      const forkInherit = pin.archetype === 'WORKER_FORK' && parentPin && typeof parentPin.surfaceModel === 'string'
      const projected = projectAssembly(gated, pin, new Set(openList), {
        open: new Set(openList),
        logger: (m) => { try { ctx.logger('tool-gate').warn(m) } catch {} },
        manifest: manifestOf(s),
        model: forkInherit ? parentPin.surfaceModel : s?.header?.model,
        cwd: forkInherit ? parentPin.surfaceCwd : s?.header?.cwd,
      })
      const govern = pin.archetype === 'ORCHESTRATOR' || (pin.archetype === 'WORKER_FORK' && pin.parentArchetype === 'ORCHESTRATOR')
      const surface = govern
        ? applyOrchestratorV2Surface(projected, { open: new Set(openList), hasGoalHistory: hasGoalHistory(s) })
        : projected
      return { ...assembled, sections: surface.sections, contexts: projected.contexts, tools: surface.tools }
    } catch {
      try {
        const fallbackCfg = loadConfig()
        if (fallbackCfg.promptGovernanceV2 === true && classifySession(s, assembled, deps).archetype === 'ORCHESTRATOR') {
          const safe = applyOrchestratorV2Surface(assembled, { open: openGroups(s, fallbackCfg), hasGoalHistory: hasGoalHistory(s) })
          return { ...assembled, sections: safe.sections, tools: safe.tools }
        }
      } catch { /* fail open */ }
      return assembled
    }
  })

  ctx.on('tools/pre-execute', async (exec, next) => {
    if (isInternalCall(exec)) return next()
    const session = exec.agent?.session, cfg = loadConfig()
    // Guard before bypass, so dev_* cannot skip the orchestrator budget.
    if ((cfg.strictOrchestratorGuard === true || cfg.strictOrchestratorGuard === 'shadow') && isMainOrchestratorSession(session)) try {
      const state = session && (orchestratorStates.get(session) || orchestratorStates.set(session, {}).get(session))
      const strict = strictTurnDecision(exec.name, exec.arguments || {}, session, state, { strict: cfg.strictOrchestratorGuard, callId: exec.callId, cwd: session?.header?.cwd })
      if (strict.kind === 'deny') return strict
      if (strict.notice) try { ctx.logger('tool-gate').info(strict.notice) } catch {}
      if (cfg.strictOrchestratorGuard === true) {
        const role = cfg.orchestratorGuard || ORCHESTRATOR_DEFAULTS
        const d = orchestratorDecision(exec.name, exec.arguments || {}, session, role, state, Date.now(), { workspace: session?.header?.cwd, cwd: session?.header?.cwd, codeRoots: [join(homedir(), '.dsh', 'plugins'), join(dirname(fileURLToPath(import.meta.url)), '..')] })
        if (d.kind === 'deny') return d
        if (d.escaped) try { appendEscapeAudit(d.audit) } catch {}
        if (d.notice) try { ctx.logger('tool-gate').info(d.notice) } catch {}
      }
    } catch (err) { try { ctx.logger('tool-gate').info('orchestrator-guard fail-open ' + String(err?.message || err).slice(0, 120)) } catch {} }
    // Child policy can only narrow access; malformed child policy fails closed.
    try {
      const permission = permissionDecision(exec.name, exec.arguments || {}, session)
      if (permission.kind === 'deny') {
        try { ctx.logger('tool-gate').info(`permission-deny ${permission.error?.code || 'DSH_HIGH_RISK_APPROVAL_REQUIRED'} ${exec.name}`) } catch {}
        return permission
      }
    } catch (err) {
      const { localDeny, isChildSession, manifestOf } = await import('./permission-guard.js')
      if (isChildSession(session)) return localDeny('policy_evaluation_failed', manifestOf(session), { detail: String(err?.message || err).slice(0, 200) })
    }
    const prev = await next()
    if (prev.kind !== 'allow') {
      const g = groupOf(exec.name, cfg)
      if (g && cfg.groups[g]?.bypass && prev?.error && typeof prev.error === 'object') prev.error.schemaHint = `${exec.name} 直调失败，未把 ${g} 组写入 tools[]`
      return prev
    }
    try {
      const d = gateDecision(exec.name, session, cfg)
      if (d.autoUnlock && !cfg.groups[d.autoUnlock]?.bypass) { setLifecycleGroups(session, [d.autoUnlock], 'implicit-direct'); try { ctx.logger('tool-gate').info('auto-unlocked group ' + d.autoUnlock + ' (call ' + exec.name + ')') } catch {} }
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
      if (t === 'pin') {
        const pin = sid ? readPin(sid) : null
        return { kind: 'success', text: pin ? JSON.stringify(pin, null, 1) : '当前会话无 pin（将在下一次 assemble 时创建）' }
      }
      if (t === 'repin') {
        if (!sid) return { kind: 'error', text: '无会话 id，无法 repin' }
        const live = classifySession(session, null, {})
        const result = nextPin(readPin(sid), live, { boundary: true, cfg, seq: logLength(session), latestVersion: 3 })
        writePinAtomic(sid, result.pin)
        return { kind: 'success', text: `repin: ${result.pin.archetype} projVersion=${result.pin.projVersion} reason=${result.reason}\n（本轮 header 将重建一次）` }
      }
      if (a !== 'on' && a !== 'off') return { kind: 'error', text: '用法: /tools <组|all> on|off' }
      const gs = t === 'all' ? Object.keys(cfg.groups) : [t]
      if (t !== 'all' && !cfg.groups[t]) return { kind: 'error', text: `未知组 ${t}，可用: ${Object.keys(cfg.groups).join(', ')}` }
      setGroups(session, gs, a === 'on')
      return { kind: 'success', text: statusText(session, cfg) + '\n\n（下一轮请求起生效）' }
    },
  }), name + ': /tools')
}
