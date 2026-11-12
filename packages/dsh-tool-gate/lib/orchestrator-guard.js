import { appendFileSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { isChildSession, normalizeCommand, pathWithin } from './permission-guard.js'

export const SELF_FIX = 'DSH_E_ORCHESTRATOR_SELF_FIX'
export const SHELL_BUDGET = 'DSH_E_ORCHESTRATOR_SHELL_BUDGET'
export const ORCHESTRATOR_DEFAULTS = Object.freeze({
  mode: 'warn', orchestratorTtlTurns: 20, orchestratorTtlMs: 21_600_000,
  shellBudgetPerTurn: 3,
  codeExtensions: ['js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'json', 'yaml', 'yml', 'py', 'ps1', 'sh'],
  metaRoots: ['~/.dsh/relay-pipelines', '~/.dsh/dispatch-modes.yaml', '~/.dsh/AGENTS.md'],
  escape: { failures: 2, windowTurns: 6, budgetCalls: 8, ttlMs: 900_000, packages: ['dsh-relay-dispatch', 'dsh-tool-gate'] },
})
const eventsOf = (s) => typeof s?.snapshotEvents === 'function' ? s.snapshotEvents() : (s?.events || [])
const turnOf = (events) => events.reduce((n, e) => Math.max(n, Number(e?.data?.turn ?? (e.type === 'turn/start' ? e.turn : 0)) || 0), 0)
const expand = (p) => String(p || '').replace(/^~(?=[\\/])/, homedir())
const completedDispatch = (e) => ['tool/result', 'tool/call'].includes(e?.type) && (e.data?.name === 'relay_dispatch' || e.data?.tool === 'relay_dispatch') && (e.type === 'tool/call' ? e.data?.completed === true || e.data?.status === 'completed' : !e.data?.error)
function manifests(deps, now) {
  if (typeof deps?.listManifests === 'function') return deps.listManifests(now) || []
  const dir = deps?.pipelineDir || join(homedir(), '.dsh', 'relay-pipelines')
  const key = `${dir}:${Math.floor(now / 30_000)}`
  if (manifestCache.key !== key) {
    manifestCache = { key, value: [] }
    try {
      for (const name of readdirSync(dir)) if (name.endsWith('.json')) {
        try { manifestCache.value.push(JSON.parse(readFileSync(join(dir, name), 'utf8'))) } catch {}
      }
    } catch {}
  }
  return manifestCache.value
}
let manifestCache = { key: '', value: [] }

export function sessionRole(session, now = Date.now(), deps = {}) {
  if (!session || isChildSession(session) || session.header?.delegationDepth > 0 || session.meta?.parentSession || session.parentSession) return 'worker'
  if (deps.state?.role === 'plain' || session.roleOverride === 'plain') return 'plain'
  const sid = session.header?.id, events = eventsOf(session), turn = turnOf(events)
  for (let i = events.length - 1; i >= 0; i--) if (completedDispatch(events[i])) {
    return turn - turnOf(events.slice(i)) <= (deps.orchestratorTtlTurns ?? ORCHESTRATOR_DEFAULTS.orchestratorTtlTurns) ? 'orchestrator' : 'plain'
  }
  if (manifests(deps, now).some((m) => m?.parentSessionId === sid && now - Date.parse(m.updatedAt) <= (deps.orchestratorTtlMs ?? ORCHESTRATOR_DEFAULTS.orchestratorTtlMs) && now >= Date.parse(m.updatedAt))) return 'orchestrator'
  return 'plain'
}

const rootsOf = (ctx = {}) => [ctx.workspace, ...(ctx.codeRoots || []), ...(ctx.writeRoots || [])].filter(Boolean)
function inRoots(target, ctx) { return rootsOf(ctx).some((r) => pathWithin(target, r, ctx.cwd)) }
function inMeta(target, cfg) { return (cfg.metaRoots || []).some((r) => pathWithin(target, expand(r))) }
function codeFile(target, cfg) { return new RegExp(`\\.(?:${(cfg.codeExtensions || []).join('|')})$`, 'i').test(target || '') }
const A0 = new Set(['relay_dispatch', 'job_output', 'job_list', 'job_kill', 'context_compact', 'context_recall', 'todo_write', 'ask_user_question', 'read', 'grep', 'glob'])
export function classifyOrchestratorOp(toolName, args = {}, ctx = {}) {
  const cfg = { ...ORCHESTRATOR_DEFAULTS, ...(ctx.config || {}) }, name = String(toolName || '').toLowerCase()
  if (A0.has(name)) return { class: 'A0', reason: 'orchestration_or_read' }
  if (name.startsWith('dev_')) return { class: 'B4', reason: 'orchestrator_dev_tool', target: toolName }
  if (['write', 'edit'].includes(name)) {
    const target = args.file_path || args.path || ''
    if (inMeta(target, cfg) || (/\.md$/i.test(target) && inRoots(target, ctx))) return { class: 'A1', reason: 'orchestration_metadata', target }
    if (codeFile(target, cfg) && inRoots(target, ctx)) return { class: 'B1', reason: 'orchestrator_code_edit', target }
    return { class: 'A0', reason: 'non_code_file', target }
  }
  if (!['pwsh', 'bash', 'shell', 'cmd'].includes(name)) return { class: 'A0', reason: 'unclassified_tool' }
  const target = args.command || '', c = normalizeCommand(target, args.workdir || args.cwd || ctx.cwd)
  if (!c.executable) return { class: 'C1', reason: 'unparseable_shell', target }
  if (c.executable === 'git' && ['status', 'log', 'rev-parse'].includes(c.argv[0]) || c.executable === 'git' && c.argv[0] === 'diff' && c.argv.includes('--stat')) return { class: 'A0', reason: 'read_only_git', target }
  if (c.executable === 'npm' && (c.argv[0] === 'test' || c.argv[0] === 'run' || c.argv[0] === '--prefix' && c.argv[2] === 'test')) return { class: 'B2', reason: 'orchestrator_test_or_build', target }
  if (['pnpm', 'yarn', 'npx'].includes(c.executable) && c.argv.includes('test') || ['vitest', 'pytest'].includes(c.executable)) return { class: 'B2', reason: 'orchestrator_test_or_build', target }
  if (c.executable === 'node' && (c.argv[0] === '--test' || /(?:^|[\\/])test[\\/]/i.test(c.argv[0] || ''))) return { class: 'B2', reason: 'orchestrator_test_or_build', target }
  if (['copy-item', 'move-item', 'remove-item', 'set-content', 'out-file', 'robocopy'].includes(c.executable) || c.executable === 'git' && ['apply', 'stash'].includes(c.argv[0]) || c.executable === 'git' && c.argv[0] === 'checkout' && c.argv.includes('--')) {
    return c.argv.slice(1).some((p) => inRoots(p, ctx)) ? { class: 'B3', reason: 'orchestrator_code_mutation', target } : { class: 'C1', reason: 'shell_mutation', target }
  }
  return { class: 'C1', reason: 'other_shell', target }
}

export function recentPipelineFor(session, now = Date.now(), deps = {}) {
  return manifests(deps, now).filter((m) => m?.parentSessionId === session?.header?.id && (!deps.failedOnly || /FAIL|PARTIAL|UNVERIFIED/.test(m.result || m.RESULT || ''))).sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0] || null
}
export function loadDispatcherFault(deps = {}) {
  if (deps.fault !== undefined) return deps.fault
  try { return JSON.parse(readFileSync(join(deps.pipelineDir || join(homedir(), '.dsh', 'relay-pipelines'), '.dispatcher-fault.json'), 'utf8')) } catch { return null }
}
export function escapeHatchState(session, cfg = ORCHESTRATOR_DEFAULTS, state = {}, now = Date.now(), deps = {}) {
  const fault = loadDispatcherFault(deps), esc = { ...ORCHESTRATOR_DEFAULTS.escape, ...(cfg.escape || {}) }
  const valid = fault?.sessionId === session?.header?.id && fault.category === 'dispatcher_fault' && fault.count >= esc.failures && !/^DSH_E_PREFLIGHT_/.test(fault.lastCode || '') && fault.start_unknown !== 1 && now - fault.lastAt <= esc.ttlMs && (state.turn ?? turnOf(eventsOf(session))) - (fault.turn ?? turnOf(eventsOf(session))) <= esc.windowTurns
  const active = valid && (state.escape?.calls || 0) < esc.budgetCalls && now - (state.escape?.activatedAt ?? fault.lastAt) <= esc.ttlMs
  return { active, fault, calls: state.escape?.calls || 0, budgetCalls: esc.budgetCalls }
}
const escapeTarget = (op, packages) => {
  const target = op.target || ''
  if (op.class === 'B4') return packages.some((p) => target.toLowerCase().includes(p))
  if (op.class === 'B2') return packages.some((p) => target.toLowerCase().includes(p))
  return packages.some((p) => new RegExp(`(?:^|[\\\\/])${p}(?:[\\\\/]|$)`, 'i').test(target))
}
export function selfFixDeny(op, pipeline, code = SELF_FIX) {
  const error = { ok: false, code, retryable: false, escalation: 'forbidden', directive: 'dispatch_followup', class: op.class, reason: op.reason, target: String(op.target || '').slice(0, 100), remedy: { tool: 'relay_dispatch', args: { followUp: { pipelineId: pipeline?.pipelineId || pipeline?.id || null, patch: '<一句话修复指令>' } } }, escape: 'bootstrap 逃生舱未激活：需 relay_dispatch 连续 2 次启动前失败' }
  return { kind: 'deny', decision: 'DENY_LOCAL', error, reason: JSON.stringify(error) }
}
export function orchestratorDecision(toolName, args = {}, session, cfg = ORCHESTRATOR_DEFAULTS, state = {}, now = Date.now(), deps = {}) {
  const config = { ...ORCHESTRATOR_DEFAULTS, ...cfg, escape: { ...ORCHESTRATOR_DEFAULTS.escape, ...(cfg.escape || {}) } }, role = sessionRole(session, now, { ...deps, ...config, state })
  if (role !== 'orchestrator' || config.mode === 'off') return { kind: 'allow', role }
  const op = classifyOrchestratorOp(toolName, args, { ...deps, config })
  if (op.class === 'A0') return { kind: 'allow', role, ...op }
  if (op.class === 'A1') return { kind: 'allow', role, ...op, counted: true }
  if (op.class === 'C1') {
    const turn = deps.turn ?? turnOf(eventsOf(session)); if (state.turn !== turn) { state.turn = turn; state.shellCalls = 0 }
    state.shellCalls = (state.shellCalls || 0) + 1
    if (state.shellCalls > config.shellBudgetPerTurn) return selfFixDeny(op, recentPipelineFor(session, now, { ...deps, failedOnly: true }), SHELL_BUDGET)
    return { kind: 'allow', role, ...op, notice: `[orchestrator-guard] 主会话 shell 调用 ${state.shellCalls}/${config.shellBudgetPerTurn}` }
  }
  const escape = escapeHatchState(session, config, state, now, deps)
  if (escape.active && ['B1', 'B2', 'B3', 'B4'].includes(op.class) && escapeTarget(op, config.escape?.packages || ORCHESTRATOR_DEFAULTS.escape.packages)) {
    state.escape = { activatedAt: state.escape?.activatedAt ?? escape.fault.lastAt, calls: escape.calls + 1 }
    return { kind: 'allow', role, ...op, escaped: true, audit: { ts: new Date(now).toISOString(), sessionId: session.header.id, tool: toolName, target: op.target, faultRef: escape.fault.lastCode } }
  }
  if (config.mode === 'warn') return { kind: 'allow', role, ...op, notice: `[orchestrator-guard] guard.warn.${op.class}` }
  return selfFixDeny(op, recentPipelineFor(session, now, { ...deps, failedOnly: true }))
}
export function appendEscapeAudit(audit, deps = {}) {
  const dir = deps.pipelineDir || join(homedir(), '.dsh', 'relay-pipelines')
  mkdirSync(dir, { recursive: true }); appendFileSync(join(dir, 'escape-audit.jsonl'), JSON.stringify(audit) + '\n')
}
