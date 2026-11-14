import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const sessionsRoot = 'C:/Users/mikon/.dsh/sessions/--C-Users-mikon-Desktop-asd--'
const pipelineRoot = 'C:/Users/mikon/.dsh/relay-pipelines'
const parentLog = 'C:/Users/mikon/.dsh/relay-dispatch-parent.log'
const mainSession = 'session-62e684d4-706a-4215-9b83-8f781f1b8423'
const mode = process.argv[2] === 'delete' ? 'delete' : 'dry-run'
const now = Date.now()
const recentCutoff = now - 15 * 60 * 1000

const sessionDirs = fs.readdirSync(sessionsRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && entry.name.startsWith('session-'))
  .map((entry) => {
    const fullPath = path.join(sessionsRoot, entry.name)
    const stat = fs.statSync(fullPath)
    return { id: entry.name, path: fullPath, mtime: stat.mtimeMs }
  })
const sessionIds = new Set(sessionDirs.map((session) => session.id))
const logText = fs.readFileSync(parentLog, 'utf8')
const dispatchedIds = new Set()
for (const match of logText.matchAll(/\bid=(session-[0-9a-f-]{36})\b/gi)) {
  if (!match[0].includes('parentSession=none')) dispatchedIds.add(match[1])
}
// The log format includes parentSession after id; explicitly collect injected children.
for (const match of logText.matchAll(/\bid=(session-[0-9a-f-]{36})\b[^\r\n]*?result=inject\b/gi)) dispatchedIds.add(match[1])

const terminalPipelines = new Set(['completed', 'cancelled'])
const activePipelineIds = new Set()
const completedPipelineIds = new Set()
for (const file of fs.readdirSync(pipelineRoot).filter((name) => name.endsWith('.json'))) {
  let manifest
  try { manifest = JSON.parse(fs.readFileSync(path.join(pipelineRoot, file), 'utf8')) } catch { continue }
  const ids = (manifest.items || []).map((item) => item.sessionId).filter(Boolean)
  if (terminalPipelines.has(manifest.phase)) ids.forEach((id) => completedPipelineIds.add(id))
  else ids.forEach((id) => activePipelineIds.add(id))
}

const protectedReasons = new Map()
const protect = (id, reason) => {
  if (!protectedReasons.has(id)) protectedReasons.set(id, reason)
}
protect(mainSession, 'main-whitelist')
for (const session of sessionDirs) {
  if (session.mtime >= recentCutoff) protect(session.id, 'recent-15min')
}
for (const id of activePipelineIds) protect(id, 'active-pipeline')

const childEvidence = new Map()
const evidence = (id, kind) => {
  if (!childEvidence.has(id)) childEvidence.set(id, new Set())
  childEvidence.get(id).add(kind)
}
for (const id of dispatchedIds) if (sessionIds.has(id)) evidence(id, 'dispatch-log')
for (const id of completedPipelineIds) if (sessionIds.has(id)) evidence(id, 'completed-pipeline')
for (const id of activePipelineIds) if (sessionIds.has(id)) evidence(id, 'pipeline')

const originEvidenceErrors = []
for (const session of sessionDirs) {
  const file = path.join(session.path, 'session.jsonl.zstd')
  if (!fs.existsSync(file)) continue
  try {
    const raw = fs.readFileSync(file)
    let text
    try { text = zlib.zstdDecompressSync(raw).toString('utf8') } catch { text = raw.toString('utf8') }
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue
      if (/"parentSession"\s*:\s*"(?:session-|[^"]+)"/.test(line)) evidence(session.id, 'parentSession')
      if (/"origin"\s*:\s*"subagent"/.test(line)) evidence(session.id, 'origin-subagent')
      if (/"phase"\s*:\s*"(?:running|pending|detached)"/.test(line)) protect(session.id, 'session-running-marker')
    }
  } catch (error) {
    originEvidenceErrors.push({ id: session.id, error: String(error.message || error) })
    protect(session.id, 'unreadable-session')
  }
}

// Any explicit parent/origin evidence is enough; log-only sessions must be injected.
const deletable = []
for (const session of sessionDirs) {
  if (protectedReasons.has(session.id)) continue
  const kinds = childEvidence.get(session.id)
  if (!kinds || kinds.size === 0) continue
  if ([...kinds].every((kind) => kind === 'completed-pipeline')) {
    // A terminal manifest is authoritative; still require an actual child relationship.
  }
  deletable.push(session.id)
}

const retained = sessionDirs.filter((session) => !deletable.includes(session.id)).map((session) => ({
  id: session.id,
  reason: protectedReasons.get(session.id) || 'unproven-root-or-nonterminal',
  evidence: [...(childEvidence.get(session.id) || [])],
}))
const report = { mode, now: new Date(now).toISOString(), before: sessionDirs.length, deleteCount: deletable.length, after: sessionDirs.length - deletable.length, deletable, retained, activePipelineIds: [...activePipelineIds], originEvidenceErrors }
console.log(JSON.stringify(report, null, 2))
if (mode === 'delete') {
  for (const id of deletable) fs.rmSync(path.join(sessionsRoot, id), { recursive: true, force: false })
  const remaining = fs.readdirSync(sessionsRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name)
  console.log(JSON.stringify({ deleted: deletable.length, remaining: remaining.length, mainPresent: remaining.includes(mainSession), recentPresent: remaining.filter((id) => protectedReasons.get(id) === 'recent-15min') }, null, 2))
}
