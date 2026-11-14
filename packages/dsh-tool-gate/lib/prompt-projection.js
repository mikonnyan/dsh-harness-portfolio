/**
 * dsh-tool-gate v2 — prompt-projection.js
 * Persona templates (P7 exact-template replacement), the spec-verbatim
 * tool-gate:discipline section (§9.4.2), the constraint-ledger-gated tool:*
 * section drops (A7 + §9.4.2 table), and projectAssembly.
 */
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { projectToolsWithMeta } from './compact-schema.js'
import { toolVisibleForWorker } from './permission-guard.js'

// ── P7: exact default-engineering persona templates (match iff the ENTIRE text equals a template) ──
export const KNOWN_DEFAULT_PERSONA_PATTERNS = Object.freeze([
  /^You are a coding agent powered by the .+ model\. Your working directory is .+\.$/,
  /^You are a helpful software engineer assistant\.(?: Before acting, decide the task type \(build or fix\) and adopt the matching style: build → hands-on production; fix → inspect-and-plan\.)?$/,
  /^You are a hands-on software engineer who delivers working output fast\. Work directly:/,
  /^You are a methodical software architect and engineer\. Plan before editing:/,
  /^You are a hands-on software engineer who delivers working output fast\. Work directly: write or edit code, run commands, and verify results yourself\.?$/,
  /^You are a coding agent\. Follow instructions carefully\.?$/,
  /^You are a helpful software engineer assistant\. Be concise\.?$/,
  /^You are an AI agent powered by DeepSeek Harness\. You are interacting with the user through a GUI\.?$/,
])
export const ORCHESTRATOR_PERSONA = 'You are the main orchestrator of a DeepSeek Harness session. You do not write or edit code directly: you delegate implementation and verification via relay_dispatch, keep your own context small, and integrate the results. Model: {{model}}. Workspace: {{cwd}}.'
export const WORKER_PERSONA = 'You are a delegated implementation/verification worker. Work hands-on inside your authorized scope: read, write, edit and run tests directly, and report a compact result. Model: {{model}}. Workspace: {{cwd}}.'

/** P7: replace ONLY on an exact default-template match; custom personas are preserved byte-for-byte. */
export function isDefaultEngineeringPersona(text) {
  if (typeof text !== 'string' || !text.trim()) return false
  const trimmed = text.trim()
  return KNOWN_DEFAULT_PERSONA_PATTERNS.some((p) => p.test(trimmed))
}

// Abbreviations whose trailing period never ends a sentence; single-letter tokens
// ("A.") do end one, but multi-letter dot-runs ("A.B.C.") do not.
const ABBREV = new Set(['dr', 'mr', 'mrs', 'ms', 'prof', 'st', 'vs', 'etc', 'e.g', 'i.e', 'no', 'inc', 'jr', 'sr'])

/** Split after [.!?。！？] followed by whitespace, or on newline; trim; drop empties. CJK-safe, abbreviation/code-span aware. */
export function splitSentences(text) {
  if (typeof text !== 'string' || !text) return []
  const out = []
  let buf = ''
  let inCodeSpan = false
  const flush = () => { if (buf.trim()) out.push(buf.trim()); buf = '' }
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    buf += ch
    if (ch === '`') { inCodeSpan = !inCodeSpan; continue }
    if (ch === '\n') { if (!inCodeSpan) flush(); continue }
    if (inCodeSpan) continue
    if (/[。！？]/.test(ch)) { flush(); continue }
    if (/[.!?]/.test(ch)) {
      const next = text[i + 1]
      if (next !== undefined && !/\s/.test(next)) continue // 3.14, A.B.C, e.g
      if (next === undefined) { flush(); continue }
      if (ch !== '.') { flush(); continue } // ! and ? always split at whitespace
      // Period at whitespace: inspect the token it terminates.
      let start = i
      while (start > 0 && /[A-Za-z0-9.]/.test(text[start - 1])) start--
      const token = text.slice(start, i).toLowerCase()
      if (ABBREV.has(token)) continue // Dr. Smith, e.g. this
      if (/^[a-z0-9](\.[a-z0-9])+$/.test(token)) continue // A.B.C. Dots.
      flush()
    }
  }
  flush()
  return out
}

// ── Constraint ledger (schema constraint-ledger/v1, §9.4.3) ──
const LEDGER_CACHE = { path: '', mtimeMs: -1, value: null }
export function loadConstraintLedger(path) {
  const file = path || join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'tool-gate', 'tool-constraint-ledger.json')
  try {
    const mtimeMs = statSync(file).mtimeMs
    if (LEDGER_CACHE.path === file && LEDGER_CACHE.mtimeMs === mtimeMs) return LEDGER_CACHE.value
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    const version = raw?.schemaVersion || raw?.schema_version
    if (version !== 'constraint-ledger/v1') throw new Error('bad schema')
    LEDGER_CACHE.path = file; LEDGER_CACHE.mtimeMs = mtimeMs; LEDGER_CACHE.value = raw
    return raw
  } catch { return null }
}

// ── tool-gate:discipline (§9.4.2, spec-verbatim; order slot 100) ──
export function buildDisciplineSection(visibleNames) {
  const line1 = []
  const fsReaders = ['read', 'grep', 'glob'].filter((n) => visibleNames.has(n))
  const hasShell = visibleNames.has('pwsh') || visibleNames.has('bash')
  if (fsReaders.length && hasShell) {
    line1.push(`use ${fsReaders.join('/')}, not shell cat/grep/rg/find; use offset/limit to continue large files`)
  } else if (visibleNames.has('read')) {
    line1.push('use offset/limit to continue large files')
  }
  const fsWriters = ['write', 'edit'].filter((n) => visibleNames.has(n))
  if (fsWriters.length && visibleNames.has('read')) {
    line1.push(`read an existing file before ${fsWriters.join('/')}`)
  }
  if (line1.length) line1[0] = `Files: ${line1[0]}`
  if (hasShell) line1.push('Shell ([exit code: N]): investigate failures before moving on.')

  const line2 = []
  if (visibleNames.has('job_output') || visibleNames.has('job_kill')) {
    line2.push('Background jobs: never busy-poll; collect relevant jobs with job_output and job_kill unneeded ones before final answer; do not duplicate running work.')
  }
  if (visibleNames.has('subagent') || visibleNames.has('subagent_fork')) {
    line2.push('Start independent delegations together in one message.')
  }
  const text = [line1.join('; ').replace(/;\s*Shell/, '. Shell'), line2.join(' ')].filter(Boolean).join('\n')
  return text ? { name: 'tool-gate:discipline', text } : null
}

const toSet = (v) => (v instanceof Set ? v : new Set(Array.isArray(v) ? v : []))

/**
 * A7 live carriers. `schema:<tool>` is live iff the tool is visible AND its compact
 * schema was applied; `discipline:<id>` is live iff the corresponding discipline
 * clause is present in the emitted discipline text; bare `discipline` is live iff
 * the discipline section was emitted at all.
 */
export function liveCarriers(visibleNames, appliedNames, disciplineText) {
  const visible = toSet(visibleNames)
  const applied = toSet(appliedNames)
  const live = new Set()
  for (const tool of applied) if (visible.has(tool)) live.add(`schema:${tool}`)
  if (typeof disciplineText === 'string' && disciplineText) {
    live.add('discipline')
    // The discipline text is a pure function of visibleNames (§9.4.2), so clause
    // presence is derived from the same visible set.
    const fsReaders = ['read', 'grep', 'glob'].filter((n) => visible.has(n))
    const hasShell = visible.has('pwsh') || visible.has('bash')
    if (fsReaders.length && hasShell) {
      live.add('discipline:read')
      if (visible.has('grep')) live.add('discipline:grep')
      if (visible.has('glob')) live.add('discipline:glob')
    } else if (visible.has('read')) {
      live.add('discipline:read')
    }
    if ((visible.has('write') || visible.has('edit')) && visible.has('read')) {
      if (visible.has('write')) live.add('discipline:write')
      if (visible.has('edit')) live.add('discipline:edit')
    }
    if (hasShell) {
      if (visible.has('pwsh')) live.add('discipline:pwsh')
      if (visible.has('bash')) live.add('discipline:bash')
    }
    if (visible.has('job_output') || visible.has('job_kill')) live.add('discipline:job_output')
    if (visible.has('subagent') || visible.has('subagent_fork')) live.add('discipline:subagent')
  }
  return live
}

/** A7: a tool:* section is dropped iff every one of its ledger sentences has >=1 live carrier. */
export function canDropToolSection(sectionName, live, ledger) {
  if (typeof sectionName !== 'string' || !sectionName.startsWith('tool:')) return false
  if (!ledger || typeof ledger !== 'object') return false
  const entry = ledger.sections?.[sectionName] || ledger.tools?.[sectionName]
  if (!entry) return false
  const sentences = Array.isArray(entry.sentences) ? entry.sentences : []
  if (!sentences.length) return false
  return sentences.every((s) => {
    const carriers = Array.isArray(s.carriers) ? s.carriers : (Array.isArray(s) ? s : [])
    return carriers.some((c) => typeof c === 'string' && live.has(c))
  })
}

/** Stable digest of a projected assembly for drift shadow detection (CP-2.5). */
export function headerDigest(projected) {
  const sections = Array.isArray(projected?.sections) ? projected.sections : []
  const tools = Array.isArray(projected?.tools) ? projected.tools : []
  const sysLen = sections.reduce((n, s) => n + (typeof s?.text === 'string' ? s.text.length : 0), 0)
  const toolsLen = tools.reduce((n, t) => n + (typeof t?.description === 'string' ? t.description.length : 0), 0)
  return {
    sectionNames: sections.map((s) => s?.name).filter(Boolean),
    toolNames: tools.map((t) => t?.name).filter(Boolean),
    sysLen,
    toolsLen,
  }
}

/**
 * §9.4.2 exact per-section drop table. Pure; returns a Map of section name -> boolean
 * structural precondition. Ledger coverage (A7) is applied on top in projectAssembly:
 * a section is dropped iff the table says true AND every ledger sentence keeps a live
 * carrier (fail-safe: uncovered or unknown sections are never dropped).
 */
function structuralDropTable(visible, applied, disciplineEmitted) {
  const hasShell = visible.has('pwsh') || visible.has('bash')
  const appliedShell = (visible.has('pwsh') && applied.has('pwsh')) || (visible.has('bash') && applied.has('bash'))
  return {
    'tool:read': disciplineEmitted && visible.has('read') && (!hasShell || appliedShell),
    'tool:glob': disciplineEmitted && applied.has('glob') && (!hasShell || appliedShell),
    'tool:grep': disciplineEmitted && applied.has('grep') && (!hasShell || appliedShell),
    'tool:write': !visible.has('write') || (disciplineEmitted && applied.has('write')),
    'tool:edit': !visible.has('edit') || (disciplineEmitted && applied.has('edit')),
    'tool:pwsh': !visible.has('pwsh') || (disciplineEmitted && applied.has('pwsh')),
    'tool:bash': !visible.has('bash') || (disciplineEmitted && applied.has('bash')),
    'tool:job_output': (!visible.has('job_output') && !visible.has('job_kill')) || (disciplineEmitted && (!visible.has('job_output') || applied.has('job_output'))),
    'tool:web_search': !visible.has('web_search') || applied.has('web_search'),
    'tool:subagent': !visible.has('subagent') || (disciplineEmitted && applied.has('subagent')),
    'tool:subagent_fork': !visible.has('subagent_fork') || (disciplineEmitted && applied.has('subagent_fork')),
  }
}

/**
 * Role-aware assembly projection (§3.3 matrix).
 * - ORCHESTRATOR: persona replaced (P7), discipline + ledger-gated drops, compact schema v3.
 * - WORKER_FRESH/WORKER_FORK: worker tool surface (toolVisibleForWorker), compact schema.
 * - STANDALONE: no persona replacement, compact schema + ledger-gated drops.
 * - SPECIALIZED: passthrough is handled by the caller (index.js hook).
 * Returns { sections, contexts, tools, meta } with meta arrays per spec line 1037.
 */
export function projectAssembly(assembled, pin, open, opts = {}) {
  const out = {
    sections: Array.isArray(assembled?.sections) ? [...assembled.sections] : [],
    contexts: Array.isArray(assembled?.contexts) ? [...assembled.contexts] : [],
    tools: Array.isArray(assembled?.tools) ? [...assembled.tools] : [],
    meta: { dropped: [], kept: [], appliedNames: [], disciplineEmitted: false },
  }
  if (!assembled || !pin) return out
  if (pin.projVersion === 0) return out
  const archetype = pin.archetype || 'STANDALONE'
  const ledger = opts.ledger || loadConstraintLedger()
  const logger = opts.logger
  const manifest = opts.manifest ?? null
  const worker = archetype === 'WORKER_FRESH' || (archetype === 'WORKER_FORK' && pin.parentArchetype === 'WORKER_FRESH')
  // P6: a fork projects its parent's exact surface, never a synthesized WORKER_FORK surface.
  const projectedArchetype = archetype === 'WORKER_FORK' ? (pin.parentArchetype || 'ORCHESTRATOR') : archetype
  // Tool surface.
  if (worker) {
    out.tools = out.tools.filter((t) => toolVisibleForWorker(t?.name, manifest, { narrowReadOnlyWorkerTools: pin.cfgPinned?.narrowReadOnlyWorkerTools === true, now: opts.now }))
  }
  if (pin.projVersion === 0 && opts.headerEquals?.(out)) return out
  const visibleNames = new Set(out.tools.map((t) => t?.name).filter(Boolean))
  const projected = projectToolsWithMeta(out.tools, {
    compactSchema: pin.cfgPinned?.compactSchema !== false,
    mapVersion: pin.projVersion || 3,
    logger,
  })
  out.tools = projected.tools
  const appliedNames = projected.appliedNames
  // Two-pass A7 minimality: emit the discipline section only when it enables at
  // least one additional ledger-covered drop.
  const dropPass = (disciplineEmitted, disciplineText) => {
    const table = structuralDropTable(visibleNames, appliedNames, disciplineEmitted)
    const live = liveCarriers(visibleNames, appliedNames, disciplineText)
    const dropped = []
    for (const section of out.sections) {
      const name = section?.name
      if (typeof name !== 'string' || table[name] !== true) continue
      if (!canDropToolSection(name, live, ledger)) continue
      dropped.push(name)
    }
    return dropped
  }
  let discipline = null
  let dropped = dropPass(false, null)
  if (dropped.length === 0) {
    const candidate = buildDisciplineSection(visibleNames)
    if (candidate) {
      const withDiscipline = dropPass(true, candidate.text)
      if (withDiscipline.length > 0) { discipline = candidate; dropped = withDiscipline }
    }
  }
  const dropSet = new Set(dropped)
  const sectionsIn = out.sections
  out.sections = []
  for (const section of sectionsIn) {
    const name = section?.name
    if (typeof name === 'string' && dropSet.has(name)) { out.meta.dropped.push(name); continue }
    if (name === 'deployment:persona' && isDefaultEngineeringPersona(section?.text) && (projectedArchetype === 'ORCHESTRATOR' || worker)) {
      const persona = projectedArchetype === 'ORCHESTRATOR' ? ORCHESTRATOR_PERSONA : WORKER_PERSONA
      out.sections.push({ ...section, text: persona.replaceAll('{{model}}', opts.model || '').replaceAll('{{cwd}}', opts.cwd || '') })
      continue
    }
    out.sections.push(section)
  }
  if (discipline) { out.sections.push({ ...discipline, order: 100 }); out.meta.disciplineEmitted = true }
  out.meta.appliedNames = [...appliedNames]
  out.meta.kept = sectionsIn.map((s) => s?.name).filter((n) => typeof n === 'string' && !dropSet.has(n))
  return out
}
