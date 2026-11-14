/**
 * dsh-tool-gate v2 — pin-store.js
 * Durable session pin (schema v1), candidate replay recovery (A6), and the pure
 * monotone transition table nextPin (A1/A3).
 */
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { ARCHETYPE_RANK } from './session-archetype.js'

export const PIN_SCHEMA_VERSION = 1
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/
const memoryPins = new Map()

export const pinDir = () => join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'tool-gate', 'pins')

const canonical = (value) => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`
}
/** 12 hex chars of SHA-256 over the pin-relevant config fields (A5: change detector only). */
export function cfgDigestOf(cfg = {}) {
  const material = canonical({
    compactSchema: cfg.compactSchema !== false,
    promptGovernanceV2: cfg.promptGovernanceV2 === true,
    narrowReadOnlyWorkerTools: cfg.narrowReadOnlyWorkerTools === true,
  })
  return createHash('sha256').update(material).digest('hex').slice(0, 12)
}

function pinPath(sessionId) { return join(pinDir(), `${sessionId}.json`) }

export function readPin(sessionId) {
  if (typeof sessionId !== 'string' || !sessionId) return null
  if (!SAFE_ID.test(sessionId)) return memoryPins.get(sessionId) || null
  try {
    const pin = JSON.parse(readFileSync(pinPath(sessionId), 'utf8'))
    if (!pin || pin.v !== PIN_SCHEMA_VERSION || typeof pin.archetype !== 'string') return null
    return pin
  } catch { return memoryPins.get(sessionId) || null }
}

/** Atomic write: tmp + renameSync, 3 attempts, then memory-only; never throws (A11). */
export function writePinAtomic(sessionId, pin) {
  if (typeof sessionId !== 'string' || !sessionId || !pin) return false
  if (!SAFE_ID.test(sessionId)) { memoryPins.set(sessionId, pin); return false }
  memoryPins.set(sessionId, pin)
  const file = pinPath(sessionId)
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      mkdirSync(pinDir(), { recursive: true })
      const tmp = `${file}.tmp-${process.pid}-${attempt}`
      writeFileSync(tmp, JSON.stringify(pin))
      renameSync(tmp, file)
      return true
    } catch { /* retry */ }
  }
  return false
}

/** Delete pins older than maxAgeMs (default 30d), at most `limit` (default 200) per sweep (A11). */
export function sweepPins(now = Date.now(), opts = {}) {
  const maxAgeMs = opts.maxAgeMs ?? 2_592_000_000
  const limit = opts.limit ?? 200
  let removed = 0
  try {
    const names = readdirSync(pinDir()).filter((n) => n.endsWith('.json'))
    const stale = []
    for (const name of names) {
      if (removed >= limit) break
      try {
        const file = join(pinDir(), name)
        if (now - statSync(file).mtimeMs >= maxAgeMs) { unlinkSync(file); removed++ }
      } catch { /* skip */ }
    }
    void stale
  } catch { /* dir missing */ }
  return removed
}

/**
 * A6 candidate replay: when no pin file exists and the session is warm, project the
 * assembly under each candidate (liveArchetype, projVersion in [3, 2, 0]) and pin the
 * first whose output header-equals the last committed header. No string sniffing.
 */
export function recoverPinByReplay(session, assembled, cfg, live, project, options = {}) {
  const candidates = []
  const archetypes = [...new Set([live?.archetype, live?.parentArchetype, 'ORCHESTRATOR', 'WORKER_FRESH', 'STANDALONE', 'SPECIALIZED'].filter(Boolean))]
  for (const archetype of archetypes) {
    for (const projVersion of [3, 2, 0]) candidates.push({ archetype, projVersion, parentArchetype: live?.parentArchetype, openSnapshot: live?.openSnapshot })
  }
  for (const candidate of candidates) {
    try {
      const projectedCandidate = { ...candidate, openSnapshot: options.openSnapshot || candidate.openSnapshot }
      if (project(assembled, projectedCandidate, cfg) === true) return makePin(projectedCandidate, cfg, live)
    } catch { /* try next */ }
  }
  if (options.fallbackPin) return { ...makePin({ ...options.fallbackPin, archetype: live?.archetype || 'STANDALONE', parentArchetype: live?.parentArchetype }, cfg, live), legacy: options.fallbackPin.legacy }
  return makePin({ archetype: live?.archetype || 'STANDALONE', projVersion: 3 }, cfg, live)
}
function makePin(candidate, cfg, live) {
  return {
    v: PIN_SCHEMA_VERSION,
    archetype: candidate.archetype,
    projVersion: candidate.projVersion,
    cfgPinned: {
      compactSchema: cfg?.compactSchema !== false,
      promptGovernanceV2: cfg?.promptGovernanceV2 === true,
      narrowReadOnlyWorkerTools: cfg?.narrowReadOnlyWorkerTools === true,
    },
    cfgDigest: cfgDigestOf(cfg || {}),
    permissionPreset: null,
    parentArchetype: candidate.parentArchetype,
    openSnapshot: candidate.openSnapshot,
    legacy: candidate.archetype === 'SPECIALIZED' ? undefined : candidate.projVersion === 2 ? 'v1-pipeline' : candidate.projVersion === 0 ? 'passthrough' : undefined,
    latchedAtSeq: 0,
  }
}

/**
 * Pure monotone transition table (A1/A3). Returns { pin, changed, reason }.
 * - init: no previous pin.
 * - upward: immediate move, allowed only into rank >= 2 (→WORKER, →SPECIALIZED); at most 2 per session.
 * - pmw: any other move (including 0↔1 both directions and downward) only at a boundary.
 * - rejected: FRESH↔FORK lineage change (logged by caller).
 */
export function nextPin(pin, live, ctx = {}) {
  const liveArch = live?.archetype || 'STANDALONE'
  const seq = typeof ctx.seq === 'number' ? ctx.seq : 0
  const boundary = ctx.boundary === true
  const cfg = ctx.cfg || {}
  const latestVersion = typeof ctx.latestVersion === 'number' ? ctx.latestVersion : 3
  const base = {
    v: PIN_SCHEMA_VERSION,
    archetype: liveArch,
    projVersion: latestVersion,
    cfgPinned: {
      compactSchema: cfg.compactSchema !== false,
      promptGovernanceV2: cfg.promptGovernanceV2 === true,
      narrowReadOnlyWorkerTools: cfg.narrowReadOnlyWorkerTools === true,
    },
    cfgDigest: cfgDigestOf(cfg),
    permissionPreset: pin?.permissionPreset ?? null,
    openSnapshot: pin?.openSnapshot,
    parentArchetype: pin?.parentArchetype,
    latchedAtSeq: seq,
  }
  if (!pin || typeof pin.archetype !== 'string') return { pin: base, changed: true, reason: 'init' }
  // A fork of SPECIALIZED is SPECIALIZED, with its parent's projection lineage retained.
  if (pin.archetype === 'WORKER_FORK' && pin.parentArchetype === 'SPECIALIZED' && liveArch === 'SPECIALIZED') return { pin, changed: false, reason: 'none' }
  const fromRank = ARCHETYPE_RANK[pin.archetype] ?? 0
  const toRank = ARCHETYPE_RANK[liveArch] ?? 0
  // A3: fork lineage is decided once, at pin creation.
  if ((pin.archetype === 'WORKER_FRESH' && liveArch === 'WORKER_FORK') || (pin.archetype === 'WORKER_FORK' && liveArch === 'WORKER_FRESH')) {
    return { pin: { ...pin, latchedAtSeq: pin.latchedAtSeq }, changed: false, reason: 'rejected' }
  }
  const cfgChanged = pin.cfgDigest !== base.cfgDigest
  const versionChanged = pin.projVersion !== base.projVersion
  const archetypeChanged = pin.archetype !== liveArch
  if (archetypeChanged && toRank >= 2 && (fromRank < toRank || (fromRank < 2 && toRank === 2))) {
    // A1: immediate upward move into rank >= 2 (count cap enforced by caller).
    if (pin.archetype === 'WORKER_FORK' && pin.parentArchetype === 'SPECIALIZED' && liveArch === 'SPECIALIZED') return { pin, changed: false, reason: 'none' }
    return { pin: { ...base, parentArchetype: pin.parentArchetype || pin.archetype, openSnapshot: pin.openSnapshot }, changed: true, reason: 'upward' }
  }
  if (archetypeChanged || cfgChanged || versionChanged) {
    if (!boundary) return { pin, changed: false, reason: 'none' }
    const parentArchetype = pin.archetype === 'WORKER_FORK' ? pin.parentArchetype : pin.archetype
    return { pin: { ...base, parentArchetype, legacy: undefined }, changed: true, reason: 'pmw' }
  }
  // Pinned config bytes survive hot config changes, including legacy projection upgrades.
  if (pin.projVersion !== latestVersion && boundary) return { pin: { ...base, parentArchetype: pin.parentArchetype, legacy: undefined }, changed: true, reason: 'pmw' }
  return { pin, changed: false, reason: 'none' }
}

/** Resolve the pin for a session: read durable, else advance via nextPin. */
export function resolvePin(session, assembled, cfg, synced = {}, now = Date.now(), deps = {}) {
  const sid = session?.header?.id
  if (typeof sid !== 'string' || !sid) return null
  let existing = readPin(sid)
  const live = deps.live || { archetype: 'STANDALONE', evidence: [] }
  const last = deps.lastHeader?.()
  const warm = last && deps.lastModelActivityMs > 0 && now - deps.lastModelActivityMs < (cfg.cacheExpiryMs ?? 300_000)
  if (!existing && live.archetype === 'WORKER_FORK' && live.parentArchetype) {
    existing = makePin({ ...live, archetype: 'WORKER_FORK', projVersion: live.projVersion ?? 3 }, cfg, live)
    existing.openSnapshot = live.openSnapshot
    writePinAtomic(sid, existing)
  }
  // A6: recover by replaying the exact projection against committed bytes, never string sniffing.
  if (!existing && warm && !synced.boundary && typeof deps.replay === 'function') {
    existing = recoverPinByReplay(session, assembled, cfg, live, deps.replay, { openSnapshot: deps.openSnapshot, fallbackPin: live.archetype === 'WORKER_FORK' ? { projVersion: 0, legacy: 'passthrough', parentArchetype: live.parentArchetype } : null })
    writePinAtomic(sid, existing)
  }
  const seq = typeof deps.seq === 'number' ? deps.seq : 0
  const result = nextPin(existing, live, { boundary: synced.boundary === true, cfg, seq, latestVersion: 3 })
  if (result.reason === 'upward' && (existing?.immediateBusts ?? 0) >= 2) {
    // A1: at most 2 immediate busts per session lifetime; defer to a real PMW.
    return existing
  }
  if (result.reason === 'init' || result.changed) {
    const pin = result.reason === 'upward'
      ? { ...result.pin, immediateBusts: (existing?.immediateBusts ?? 0) + 1 }
      : { ...result.pin, legacy: result.pin.projVersion === 2 ? 'v1-pipeline' : result.pin.projVersion === 0 ? 'passthrough' : undefined }
    writePinAtomic(sid, pin)
    return pin
  }
  return result.pin
}
