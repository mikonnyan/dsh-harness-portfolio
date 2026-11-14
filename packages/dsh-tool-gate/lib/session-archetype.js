/**
 * dsh-tool-gate v2 — session-archetype.js
 * Leaf module (A14): NO imports from sibling lib modules.
 * Owns: v4 session accessors, manifestOf, RP evidence detection, the 5-archetype
 * classifier, and the shared archetype registry (Symbol.for('@dsh-external/session-archetype')).
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { statSync } from 'node:fs'
import { homedir } from 'node:os'

// ── v4 session accessors (moved from index.js, unchanged) ──
export const isV4Session = (session) => typeof session?.eventAt === 'function' && typeof session?.snapshotEvents === 'function'
export const getAllEvents = (session) => isV4Session(session) ? session.snapshotEvents() : (session?.events ?? [])
export const getEvent = (session, seq) => isV4Session(session) ? session.eventAt(seq) : (session?.events?.[seq])
export const logLength = (session) => isV4Session(session) ? session.seq : (session?.events?.length ?? 0)

// ── manifestOf (moved from permission-guard.js, unchanged) ──
export function manifestOf(session) {
  const h = session?.header || {}
  const direct = h.capabilityManifest || h.capability_manifest || session?.capabilityManifest || session?.capability_manifest
  if (direct) return direct
  const reg = globalThis[Symbol.for('@dsh-external/capability-manifests')]
  if (reg && typeof reg.get === 'function') {
    return reg.get(h) || (h.id ? reg.get(h.id) : null) || null
  }
  return null
}

// ── Archetype lattice (A1/A2/A3) ──
export const ARCHETYPE_RANK = Object.freeze({
  STANDALONE: 0, ORCHESTRATOR: 1, WORKER_FRESH: 2, WORKER_FORK: 2, SPECIALIZED: 3,
})
export const ARCHETYPE_REGISTRY_KEY = Symbol.for('@dsh-external/session-archetype')

const RP_CWD_PATTERN = /(?:^|[\\/])xiaoshuo(?:[\\/]|$)|(?:^|[\\/])mac-v4-sync(?:[\\/]|$)/i
const RP_MARKER = '<!-- rp-pic'

/** In-process subagent_fork child: seeded with parent turns, or a fork descriptor. */
export function isForkChildSession(session) {
  const h = session?.header || {}
  if (typeof h.seedLength === 'number' && h.seedLength > 0) return true
  for (const ev of getAllEvents(session)) {
    if (ev?.type !== 'subagent/descriptor') continue
    if (ev.data?.provider === 'fork' || ev.provider === 'fork') return true
  }
  return false
}

/** Non-empty provider+model pair. Either side blank is not a route. */
export function modelPair(provider, model) {
  if (typeof provider !== 'string' || typeof model !== 'string') return null
  const p = provider.trim()
  const m = model.trim()
  if (!p || !m) return null
  return { provider: p, model: m }
}

function explicitModelRoute(session) {
  for (const src of [session?.header, session?.options, session?.agentOptions, session?.meta]) {
    const route = modelPair(src?.provider, src?.model)
    if (route) return route
  }
  return null
}

function routeFromEvent(ev) {
  if (!ev || typeof ev !== 'object') return null
  const data = ev.data && typeof ev.data === 'object' ? ev.data : {}
  if (ev.type === 'request/context') return modelPair(data.provider, data.model)
  if (ev.type === 'request/header') {
    const header = data.header && typeof data.header === 'object' ? data.header : data
    const cfg = header.config && typeof header.config === 'object' ? header.config : null
    if (cfg) return modelPair(cfg.provider, cfg.model)
    return modelPair(header.provider, header.model)
  }
  // descriptor.provider is the subagent driver ('fork'), not the LLM provider.
  if (ev.type === 'subagent/descriptor') return modelPair(data.agentProvider, data.agentModel)
  return null
}

function latestModelRoute(events, start, end) {
  for (let i = end - 1; i >= start; i--) {
    const route = routeFromEvent(events[i])
    if (route) return route
  }
  return null
}

/** Child LLM route. Live options and the post-seed suffix beat inherited parent headers. */
export function childModelRoute(session, deps = {}) {
  const live = modelPair(deps.route?.provider, deps.route?.model)
  if (live) return live
  const events = getAllEvents(session)
  const seed = session?.header?.seedLength
  const start = typeof seed === 'number' && seed > 0 ? Math.min(seed, events.length) : 0
  const own = latestModelRoute(events, start, events.length)
  if (own) return own
  const explicit = explicitModelRoute(session)
  if (explicit) return explicit
  if (start > 0) return latestModelRoute(events, 0, start)
  return null
}

/** Parent LLM route: live parent session, else the inherited seed prefix. */
export function parentModelRoute(session, deps = {}) {
  const parentId = session?.header?.parentSession || session?.meta?.parentSession || session?.parentSession
  if (parentId && typeof deps.getSession === 'function') {
    try {
      const parent = deps.getSession(parentId)
      if (parent) {
        const explicit = explicitModelRoute(parent)
        if (explicit) return explicit
        const events = getAllEvents(parent)
        const route = latestModelRoute(events, 0, events.length)
        if (route) return route
      }
    } catch { /* parent lookup is best-effort */ }
  }
  const seed = session?.header?.seedLength
  if (typeof seed === 'number' && seed > 0) {
    const events = getAllEvents(session)
    return latestModelRoute(events, 0, Math.min(seed, events.length))
  }
  return null
}

/** KV prefix reuse is valid only when the fork child calls the exact same model. */
export function sameModelFork(session, deps = {}) {
  if (!isForkChildSession(session)) return false
  const child = childModelRoute(session, deps)
  const parent = parentModelRoute(session, deps)
  if (!child || !parent) return false
  return child.provider === parent.provider && child.model === parent.model
}

// ── RP guardian state (mtime-memoized, never throws) — A10 ──
let rpCache = { path: '', mtimeMs: -1, value: { enabled: [], disabled: [], globalDefault: false } }
export function loadRpGuardianState(path) {
  const file = path || join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'rp-guardian-sessions.json')
  try {
    const stat = { path: file, mtimeMs: statSync(file).mtimeMs }
    if (stat.path === rpCache.path && stat.mtimeMs === rpCache.mtimeMs) return rpCache.value
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    const value = {
      enabled: Array.isArray(raw.enabled) ? raw.enabled : [],
      disabled: Array.isArray(raw.disabled) ? raw.disabled : [],
      globalDefault: raw.globalDefault === true,
    }
    rpCache = { path: file, mtimeMs: stat.mtimeMs, value }
    return value
  } catch {
    return { enabled: [], disabled: [], globalDefault: false }
  }
}

const rpPositive = new WeakMap()
const rpNegative = new WeakMap()

/**
 * Rank-ordered RP evidence detection (§9.5.2 + A10).
 * Returns the first matching rule's evidence string, or null.
 * Positive evidence is sticky per session; a negative result is cached per logLength.
 * No title reads, no directory scans in the assemble path, depth cap 4.
 */
export function detectRpEvidence(session, assembly = null, deps = {}) {
  if (!session) return null
  if (rpPositive.get(session)) return rpPositive.get(session)
  const length = logLength(session)
  const neg = rpNegative.get(session)
  if (neg && neg.length === length) return null
  const h = session.header || {}
  const sid = h.id || ''
  const evidence = rpEvidenceUncached(session, assembly, deps)
  if (evidence) { rpPositive.set(session, evidence); return evidence }
  rpNegative.set(session, { length })
  return null
}

function rpEvidenceUncached(session, assembly, deps) {
  const h = session.header || {}
  const meta = session.meta || {}
  const sid = h.id || ''
  // Rule 1 — explicit header/meta flags.
  if (h.rp === true || meta.rp === true || h.kind === 'rp' || meta.kind === 'rp') return 'explicit_rp_flag'
  // Rule 2 — guardian activation state (mirrors guardian order; A10).
  const rawState = deps.rpState || loadRpGuardianState()
  const rpState = { enabled: Array.isArray(rawState?.enabled) ? rawState.enabled : [], disabled: Array.isArray(rawState?.disabled) ? rawState.disabled : [], globalDefault: rawState?.globalDefault === true }
  if (sid && rpState.enabled.includes(sid)) return 'rp_guardian_enabled'
  if (rpState.globalDefault === true && !(sid && rpState.disabled.includes(sid))) return 'rp_guardian_global_default'
  // Rule 3 — parent lineage / manifest (depth cap 4, visited set; manifest field only).
  const manifest = manifestOf(session)
  if (manifest && (manifest.rp === true || manifest.dispatch_mode === 'uncensored' || /rp|uncensored/i.test(String(manifest.dispatch_mode || '')))) return 'manifest_rp_or_uncensored_mode'
  const visited = new Set()
  let parent = session, depth = 0
  while (parent && depth < 4) {
    const parentId = parent?.header?.parentSession || parent?.meta?.parentSession || parent?.parentSession
    if (!parentId || typeof parentId !== 'string') break
    if (visited.has(parentId)) break
    visited.add(parentId)
    const rec = readArchetype(parentId)
    if (rec?.rp === true) return 'parent_session_is_rp'
    if (typeof deps.getSession === 'function') {
      const parentSession = deps.getSession(parentId)
      if (parentSession && (parentSession.header?.rp === true || parentSession.meta?.rp === true)) return 'parent_session_is_rp'
      parent = parentSession
    } else parent = null
    depth++
  }
  // Rule 4 — section / tool ownership in this assembly.
  const sections = assembly?.sections || []
  if (sections.some((s) => typeof s?.name === 'string' && (s.name.startsWith('rp:') || s.name.startsWith('rp-guardian:')))) return 'rp_section_owner'
  if (assembly?.tools?.some((t) => t?.name === 'rp_recall')) return 'rp_tool_owner'
  const persona = sections.find((s) => s?.name === 'deployment:persona')
  if (typeof persona?.text === 'string' && persona.text.includes(RP_MARKER)) return 'rp_persona_content'
  // Rule 5 — creation-time workspace path only (no title, no plugin-dev false positive).
  const cwd = h.cwd || h.workspace || meta.cwd
  if (typeof cwd === 'string' && RP_CWD_PATTERN.test(cwd)) return 'rp_workspace_path'
  return null
}

/**
 * Unified classifier (§9.2.1 + A1). Returns { archetype, evidence[], passthrough? }.
 * Rank order: SPECIALIZED(3) > WORKER(2) > ORCHESTRATOR(1) > STANDALONE(0).
 */
export function classifySession(session, assembly = null, deps = {}) {
  if (!session) return { archetype: 'STANDALONE', evidence: [] }
  const evidence = []
  const h = session.header || {}
  const meta = session.meta || {}
  const manifest = manifestOf(session)
  const sections = Array.isArray(assembly?.sections) ? assembly.sections : []
  if (sections.some((s) => s?.complete === true || ['tools:sdk', 'tools:code-only', 'cordis:composition'].includes(s?.name))) return { archetype: 'SPECIALIZED', evidence: ['complete_or_sdk_section'] }
  const isChild = Boolean(h.parentSession || session.parentSession || meta.parentSession || (h.delegationDepth ?? 0) > 0 || manifest)
  const rp = detectRpEvidence(session, assembly, deps)
  if (rp) evidence.push(rp)
  if (isChild) {
    // Rank 3 beats rank 2 (§9.5.3 4a).
    if (rp) return { archetype: 'SPECIALIZED', evidence }
    // WORKER_FORK shares the parent KV prefix, so the child must be the same provider+model.
    if (isForkChildSession(session)) {
      const same = sameModelFork(session, deps)
      evidence.push(same ? 'same_model_fork' : 'fork_model_mismatch')
      return { archetype: same ? 'WORKER_FORK' : 'WORKER_FRESH', evidence }
    }
    return { archetype: 'WORKER_FRESH', evidence }
  }
  if (rp) return { archetype: 'SPECIALIZED', evidence }
  // Top-level: ORCHESTRATOR iff relay_dispatch is registered on the host catalog
  // (A1: deps.hasRegisteredTool), falling back to assembly.tools.
  const hasDispatch = Boolean(deps.hasRegisteredTool?.('relay_dispatch')) || (Array.isArray(assembly?.tools) && assembly.tools.some((t) => t?.name === 'relay_dispatch'))
  if (hasDispatch) return { archetype: 'ORCHESTRATOR', evidence: ['relay_dispatch_registered'] }
  return { archetype: 'STANDALONE', evidence: [] }
}

/** A2: guards use the higher rank of (pin, live); a rank only falls at a PMW. */
export function effectiveArchetype(pin, live) {
  const liveArch = live?.archetype || 'STANDALONE'
  if (!pin || typeof pin.archetype !== 'string') return liveArch
  return (ARCHETYPE_RANK[pin.archetype] ?? 0) >= (ARCHETYPE_RANK[liveArch] ?? 0) ? pin.archetype : liveArch
}

// ── Shared registry (A9) ──
const REGISTRY_CAP = 2000
function ensureRegistry() {
  let reg = globalThis[ARCHETYPE_REGISTRY_KEY]
  if (!reg || typeof reg.get !== 'function' || typeof reg.set !== 'function') {
    reg = new Map()
    globalThis[ARCHETYPE_REGISTRY_KEY] = reg
  }
  return reg
}
export function publishArchetype(sessionId, record) {
  if (typeof sessionId !== 'string' || !sessionId || !record) return
  const reg = ensureRegistry()
  if (reg.size >= REGISTRY_CAP && !reg.has(sessionId)) {
    reg.delete(reg.keys().next().value)
  }
  reg.set(sessionId, record)
}
export function readArchetype(sessionId) {
  if (typeof sessionId !== 'string' || !sessionId) return undefined
  return ensureRegistry().get(sessionId)
}
export function clearArchetype(sessionId) {
  if (typeof sessionId === 'string' && sessionId) ensureRegistry().delete(sessionId)
}
