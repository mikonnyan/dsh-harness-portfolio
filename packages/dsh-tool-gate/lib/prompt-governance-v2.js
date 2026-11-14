/**
 * One-time v2 epoch for warm legacy orchestrators.
 * DSH rebuilds system/tools every step from system-prompt/assemble (agent-loop
 * buildRequest). A committed request/header or surface nodes[0] is only the
 * cache baseline — it must not be replayed back out once governance v2 is on.
 * filterTools is remove-only and returns the same object references; those
 * objects may already be frozen, so description replacement always copies.
 */
import { cfgDigestOf, PIN_SCHEMA_VERSION, writePinAtomic } from './pin-store.js'
import { PWSH_COMPACT_DESCRIPTION } from './compact-schema.js'

export const V2_EPOCH = 3

const NOT_FOR_READING = ' Not for reading or searching files — use read/grep/glob.'
export const V2_TOOL_DESCRIPTIONS = Object.freeze({
  pwsh: PWSH_COMPACT_DESCRIPTION,
  read: 'Read a UTF-8 text file. Results include line numbers. Use offset and limit for large files. Not shell cat.',
  write: 'Create or overwrite a UTF-8 file. Read existing files first; prefer edit for targeted changes.',
  edit: 'Replace literal old_string with new_string in a UTF-8 file (unique unless replace_all). Read the file first unless created or edited this session.',
  glob: 'Find files by glob (files only, newest first). A pattern with no "/" matches basenames at any depth. Not shell find.',
  grep: 'Search file contents with a regex. Use read on a match for surrounding context. Not shell grep or rg.',
  web_search: 'Search the web for current information; returns optional summary plus source URLs. Cite relevant URLs as markdown links.',
  subagent: 'Delegate a self-contained task. The child does not see this conversation: pass a complete prompt. Start independent delegations together. Default background.',
  subagent_fork: 'Like subagent, but the child inherits completed turns of this conversation. Start independent delegations together. Default background.',
})

/** Named host sections that repeat the tool schema. Dropped for ORCHESTRATOR. */
export const REDUNDANT_TOOL_SECTIONS = Object.freeze([
  'tool:read', 'tool:write', 'tool:edit', 'tool:glob', 'tool:grep', 'tool:pwsh', 'tool:bash',
  'tool:web_search', 'tool:goal', 'tool:workflow', 'tool:ralph', 'tool:cursor_agent',
  'tool:subagent', 'tool:subagent_fork',
])

const PARAGRAPH_ANCHORS = Object.freeze([
  /^Use the read tool — not shell commands like cat\b/,
  /^Use the write tool\b/,
  /^Use the edit tool\b/,
  /^Use the glob tool — not shell find\b/,
  /^Use the grep tool — not shell grep\b/,
  /^Use the web_search tool\b/,
  /^Use goal tools for one long-running completion objective\b/,
  /^Use the workflow tool ONLY when\b/,
  /^Use the ralph tool ONLY when\b/,
  /^When the user asks you to have Cursor implement, review\b/,
  /^Use subagent in the background by default\b/,
  /^Use subagent_fork in the background by default\b/,
  /^Non-zero exits are reported as `\[exit code: N\]` markers; investigate failures before moving on\b/,
])

const EXTRAS_SECTIONS = new Set(['tool:goal', 'tool:workflow', 'tool:ralph', 'tool:cursor_agent'])

export function orchestratorV2Locked(pin) {
  return pin?.archetype === 'ORCHESTRATOR'
    && pin.projVersion === 3
    && pin.v2Epoch === V2_EPOCH
    && !pin.legacy
    && pin.cfgPinned?.promptGovernanceV2 === true
}

/**
 * Hot-cache window no longer keeps an unmigrated orchestrator on the legacy
 * projection. The first assemble after governance v2 locks projVersion 3;
 * later assembles keep that pin so the prefix stays byte-stable.
 */
export function ensureOrchestratorV2Epoch(pin, live, cfg, sessionId) {
  if (cfg?.promptGovernanceV2 !== true) return pin
  if (live?.archetype !== 'ORCHESTRATOR' || !pin) return pin
  if (orchestratorV2Locked(pin)) return pin
  const next = {
    ...pin,
    v: pin.v || PIN_SCHEMA_VERSION,
    archetype: 'ORCHESTRATOR',
    projVersion: 3,
    legacy: undefined,
    v2Epoch: V2_EPOCH,
    cfgPinned: {
      compactSchema: cfg.compactSchema !== false,
      promptGovernanceV2: true,
      narrowReadOnlyWorkerTools: cfg.narrowReadOnlyWorkerTools === true,
    },
    cfgDigest: cfgDigestOf(cfg),
  }
  if (sessionId) writePinAtomic(sessionId, next)
  return next
}

function sectionKept(name, open, hasGoalHistory) {
  if (!EXTRAS_SECTIONS.has(name)) return false
  if (open.has('extras')) return true
  return name === 'tool:goal' && hasGoalHistory === true
}

function stripParagraphs(text) {
  if (typeof text !== 'string' || !text) return text
  const parts = text.split(/(\n{2,})/)
  const kept = []
  for (let i = 0; i < parts.length; i += 2) {
    const paragraph = parts[i]
    const hit = PARAGRAPH_ANCHORS.some((re) => re.test(paragraph.trimStart()))
    if (hit) continue
    if (kept.length) kept.push(parts[i - 1] ?? '\n\n')
    kept.push(paragraph)
  }
  return kept.join('').trim()
}

function copyTool(tool) {
  const copy = { ...tool }
  if (tool.parameters && typeof tool.parameters === 'object') {
    try { copy.parameters = structuredClone(tool.parameters) }
    catch { copy.parameters = { ...tool.parameters } }
  }
  return copy
}

/** Replace schema descriptions with the v2 text. Never writes through a frozen input. */
export function applyV2ToolDescriptions(tools) {
  if (!Array.isArray(tools)) return tools
  return tools.map((tool) => {
    const next = V2_TOOL_DESCRIPTIONS[tool?.name]
    if (typeof next !== 'string' || typeof tool?.description !== 'string') return tool
    if (Buffer.byteLength(next) >= Buffer.byteLength(tool.description)) return tool
    const copy = copyTool(tool)
    copy.description = next
    return copy
  })
}

/**
 * ORCHESTRATOR surface: drop redundant tool:* sections (by name and by the
 * paragraph text a snapshot/nodes[0] blob may have baked in) and apply v2
 * descriptions on copies of the tool objects.
 */
export function applyOrchestratorV2Surface(projected, opts = {}) {
  const open = opts.open instanceof Set ? opts.open : new Set(Array.isArray(opts.open) ? opts.open : [])
  const sections = []
  for (const section of Array.isArray(projected?.sections) ? projected.sections : []) {
    const name = section?.name
    if (typeof name === 'string' && REDUNDANT_TOOL_SECTIONS.includes(name) && !sectionKept(name, open, opts.hasGoalHistory)) continue
    if (typeof section?.text !== 'string') { sections.push(section); continue }
    const text = stripParagraphs(section.text)
    if (!text) continue
    sections.push(text === section.text ? section : { ...section, text })
  }
  return {
    ...projected,
    sections,
    tools: applyV2ToolDescriptions(projected?.tools),
  }
}
