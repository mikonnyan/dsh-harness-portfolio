import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'tool-gate-r2-latch-'))
process.env.DSH_HOME = home
writeFileSync(join(home, 'rp-guardian-sessions.json'), JSON.stringify({ enabled: [], disabled: [], globalDefault: false }))
const gate = await import(`../lib/index.js?latch=${Date.now()}`)
const archetype = await import('../lib/session-archetype.js')
const { COMPACT_MAPS_BY_VERSION } = await import('../lib/compact-schema.js')

function native(name) {
  const entry = COMPACT_MAPS_BY_VERSION[3][name]
  const params = entry?.expectParams || []
  return { name, description: `Native ${name}. `.repeat(40), parameters: { type: 'object', properties: Object.fromEntries(params.map((p) => [p, { type: 'string', description: `Native ${p}. `.repeat(30) }])) } }
}
const assembled = () => ({ sections: [{ name: 'deployment:persona', text: 'You are a helpful software engineer assistant.' }], contexts: [], tools: ['read', 'edit', 'pwsh', 'relay_dispatch'].map(native) })
function harness() {
  const listeners = []
  const ctx = { tools: { register() {}, get: (n) => n === 'relay_dispatch' }, commands: { register() {} }, effect() {}, on(name, fn) { if (name === 'system-prompt/assemble') listeners.push(fn) }, logger: () => ({ warn() {}, info() {} }) }
  gate.apply(ctx)
  return async (session) => {
    const chain = async (_a, _c, next) => { const a = await next(); return a }
    return listeners[0]({}, { agent: { session } }, async () => assembled())
  }
}
const run = harness()
const manifest = { schema_version: 'capability/v1', session_id: 'late-s', parent_session: 'p', workspace: 'C:/ws', read_roots: ['C:/ws'], write_roots: ['C:/ws'], net_allow: [], forbidden_ports: [3080], escalation: 'forbidden', expires_at: '9999-12-31T23:59:59.999Z' }
const reg = globalThis[Symbol.for('@dsh-external/capability-manifests')] = new Map()

test('R2-11: late manifest latches upward once, reload recovers, removal does not downgrade guards', async () => {
  const session = { header: { id: 'late-s' }, events: [] }
  const first = await run(session)
  assert.equal(gate.readPin('late-s').archetype, 'ORCHESTRATOR')
  assert.equal(gate.strictTurnDecision('edit', { file_path: 'C:/x.js' }, session, {}, { strict: true }).kind, 'deny')
  reg.set('late-s', manifest)
  assert.equal(gate.strictTurnDecision('edit', { file_path: 'C:/x.js' }, session, {}, { strict: true }).kind, 'allow')
  const second = await run(session)
  assert.equal(gate.readPin('late-s').archetype, 'WORKER_FRESH')
  assert.equal(gate.headerEquals(first, second), false)
  session.events.push({ type: 'turn/start', data: { turn: 2 } }, { type: 'assistant/message', ts: Date.now(), data: { turn: 2 } })
  session.header.title = '苏晚晴 dsh-rp-guardian'
  const third = await run(session)
  assert.equal(gate.headerEquals(second, third), true)
  reg.delete('late-s')
  assert.equal(gate.strictTurnDecision('edit', { file_path: 'C:/x.js' }, session, {}, { strict: true }).kind, 'allow')
  const fresh = await import(`../lib/index.js?latch-reload=${Date.now()}`)
  assert.equal(fresh.readPin('late-s').archetype, 'WORKER_FRESH')
})

test.after(() => { reg.delete('late-s'); rmSync(home, { recursive: true, force: true }); delete process.env.DSH_HOME })
