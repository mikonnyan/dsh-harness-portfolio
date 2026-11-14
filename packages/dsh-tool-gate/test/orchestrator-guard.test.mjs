import test from 'node:test'
import assert from 'node:assert/strict'
import { sessionRole, classifyOrchestratorOp, orchestratorDecision, SELF_FIX, SHELL_BUDGET, ORCHESTRATOR_DEFAULTS, filterTools, DEFAULT_CONFIG } from '../lib/index.js'
const NOW = Date.now()
const cfg = { ...ORCHESTRATOR_DEFAULTS, mode: 'enforce', strictOrchestratorGuard: true }
const sid = 'parent'
const session = (events = [], extra = {}) => ({ header: { id: sid, cwd: 'C:\\work' }, events, ...extra })
const dispatch = { type: 'tool/call', data: { name: 'relay_dispatch', completed: true }, turn: 1 }
const orchestrator = () => session([{ type: 'turn/start', data: { turn: 1 } }, dispatch])
const ctx = { workspace: 'C:\\work', codeRoots: ['C:\\plugins'], config: cfg, listManifests: () => [] }

test('worker and plain bypass role guard, including code edits', () => {
  assert.equal(sessionRole(session([], { meta: { parentSession: 'p' } })), 'worker')
  assert.equal(sessionRole(session()), 'plain')
  assert.equal(orchestratorDecision('edit', { file_path: 'C:\\work\\a.js' }, session(), cfg).kind, 'allow')
})
test('completed dispatch and recent pipeline infer orchestrator; expiry restores plain', () => {
  assert.equal(sessionRole(orchestrator(), NOW, ctx), 'orchestrator')
  assert.equal(sessionRole(session(), NOW, { listManifests: () => [{ parentSessionId: sid, updatedAt: new Date(NOW).toISOString() }] }), 'orchestrator')
  assert.equal(sessionRole(orchestrator(), NOW, { orchestratorTtlTurns: -1, listManifests: () => [] }), 'plain')
})
test('metadata/read allowed and code edits return bounded remedy', () => {
  assert.equal(classifyOrchestratorOp('read', { file_path: 'D:\\anything' }, ctx).class, 'A0')
  assert.equal(classifyOrchestratorOp('write', { file_path: 'C:\\work\\spec.md' }, ctx).class, 'A1')
  const d = orchestratorDecision('edit', { file_path: 'C:\\work\\lib\\a.js' }, orchestrator(), cfg, {}, NOW, { ...ctx, listManifests: () => [{ id: 'p1', parentSessionId: sid, result: 'FAIL', updatedAt: new Date(NOW).toISOString() }] })
  assert.equal(d.error.code, SELF_FIX); assert.equal(d.error.class, 'B1'); assert.equal(d.error.remedy.args.followUp.pipelineId, 'p1')
})
test('test/build and code-root mutation denied; read-only git free', () => {
  for (const command of ['npm test', 'npm --prefix C:\\work test', 'node --test test/a.test.mjs']) assert.equal(classifyOrchestratorOp('pwsh', { command }, ctx).class, 'B2')
  assert.equal(classifyOrchestratorOp('pwsh', { command: 'Copy-Item C:\\work\\a.js C:\\work\\b.js' }, ctx).class, 'B3')
  for (const command of ['git status', 'git log -1']) { const d = orchestratorDecision('pwsh', { command }, orchestrator(), cfg, {}, NOW, ctx); assert.equal(d.class, 'A0') }
})
test('C1 fourth shell denied, dynamic shell counted, warn allows', () => {
  const state = {}
  for (let i = 0; i < 3; i++) assert.match(orchestratorDecision('pwsh', { command: 'Get-ChildItem' }, orchestrator(), cfg, state, NOW, { ...ctx, turn: 2 }).notice, /orchestrator-guard/)
  assert.equal(orchestratorDecision('pwsh', { command: 'Get-ChildItem' }, orchestrator(), cfg, state, NOW, { ...ctx, turn: 2 }).error.code, SHELL_BUDGET)
  assert.equal(classifyOrchestratorOp('pwsh', { command: 'Get-Content $x' }, ctx).class, 'C1')
  assert.equal(orchestratorDecision('dev_reload_package', {}, orchestrator(), { ...cfg, mode: 'warn' }).kind, 'allow')
})
test('escape permits only guard packages within budget and TTL', () => {
  const fault = { sessionId: sid, category: 'dispatcher_fault', count: 2, lastAt: NOW, lastCode: 'START_UNAVAILABLE', turn: 1 }
  const d = orchestratorDecision('edit', { file_path: 'C:\\plugins\\dsh-tool-gate\\lib\\index.js' }, orchestrator(), cfg, {}, NOW, { ...ctx, fault })
  assert.equal(d.kind, 'allow', d.reason); assert.equal(d.escaped, true, d.reason); assert.ok(d.audit)
  assert.equal(orchestratorDecision('edit', { file_path: 'C:\\plugins\\other\\lib\\index.js' }, orchestrator(), cfg, {}, NOW, { ...ctx, fault }).kind, 'deny')
  assert.equal(orchestratorDecision('edit', { file_path: 'C:\\plugins\\dsh-tool-gate\\lib\\index.js' }, orchestrator(), cfg, {}, NOW, { ...ctx, fault: { ...fault, start_unknown: 1 } }).kind, 'deny')
  assert.equal(orchestratorDecision('edit', { file_path: 'C:\\plugins\\dsh-tool-gate\\lib\\index.js' }, orchestrator(), cfg, {}, NOW + 901000, { ...ctx, fault }).kind, 'deny')
})
test('escape ninth call and parameter-validation faults stay denied', () => {
  const fault = { sessionId: sid, category: 'dispatcher_fault', count: 2, lastAt: NOW, lastCode: 'START_UNAVAILABLE', turn: 1 }
  const args = { file_path: 'C:\\plugins\\dsh-tool-gate\\lib\\index.js' }
  assert.equal(orchestratorDecision('edit', args, orchestrator(), cfg, { escape: { activatedAt: NOW, calls: 8 } }, NOW, { ...ctx, fault }).kind, 'deny')
  assert.equal(orchestratorDecision('edit', args, orchestrator(), cfg, {}, NOW, { ...ctx, fault: { ...fault, lastCode: 'DSH_E_PREFLIGHT_BAD' } }).kind, 'deny')
})
test('dev B4 denial and malformed guard state fail open preserve catalog semantics', () => {
  assert.equal(orchestratorDecision('dev_reload_package', {}, orchestrator(), cfg, {}, NOW, ctx).error.code, SELF_FIX)
  assert.equal(orchestratorDecision('pwsh', {}, orchestrator(), cfg, {}, NOW, ctx).kind, 'allow')
})
test('rejection does not alter tools catalog', () => {
  const s = orchestrator(), catalog = [{ name: 'read' }, { name: 'dev_reload_package' }]
  const before = JSON.stringify(filterTools(catalog, s, DEFAULT_CONFIG, {}))
  orchestratorDecision('dev_reload_package', {}, s, cfg, {}, NOW, ctx)
  assert.equal(JSON.stringify(filterTools(catalog, s, DEFAULT_CONFIG, {})), before)
})
