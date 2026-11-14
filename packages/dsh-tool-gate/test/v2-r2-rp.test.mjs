import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'tool-gate-r2-rp-'))
process.env.DSH_HOME = home
writeFileSync(join(home, 'rp-guardian-sessions.json'), JSON.stringify({ enabled: [], disabled: [], globalDefault: false }))
const gate = await import(`../lib/index.js?rp=${Date.now()}`)
const { publishArchetype } = await import('../lib/session-archetype.js')

function harness() {
  let listener
  const ctx = { tools: { register() {}, get: (n) => n === 'relay_dispatch' }, commands: { register() {} }, effect() {}, on(name, fn) { if (name === 'system-prompt/assemble') listener = fn }, logger: () => ({ warn() {}, info() {} }) }
  gate.apply(ctx)
  return (session, assembled) => listener({}, { agent: { session } }, async () => assembled)
}
const run = harness()
const rp = { sections: [{ name: 'deployment:persona', text: 'Original RP character, zero engineering markers.' }], contexts: [{ text: 'rp-context' }], tools: [{ name: 'rp_recall', description: 'native' }, { name: 'pwsh', description: 'native' }] }

test('R2 Edge 4: uncensored parent child and unknown persona are never overwritten or narrowed', async () => {
  publishArchetype('rp-parent', { archetype: 'SPECIALIZED', rp: true, suppressModeBoost: false, projVersion: 0, provisional: false })
  const child = { header: { id: 'rp-child', parentSession: 'rp-parent', cwd: 'C:/Temp/work' }, events: [] }
  const out = await run(child, rp)
  assert.equal(out, rp)
  assert.equal(gate.readPin('rp-child').archetype, 'SPECIALIZED')
  const personaOnly = { header: { id: 'persona-only' }, events: [] }
  const out2 = await run(personaOnly, rp)
  assert.equal(out2.sections[0].text, rp.sections[0].text)
})

test('R2-04: WORKER_FORK inherits parent projection verbatim, including open groups', async () => {
  const parent = { header: { id: 'fork-parent' }, events: [] }
  const input = { sections: [{ name: 'deployment:persona', text: 'You are a helpful software engineer assistant.' }], contexts: [{ text: 'dsh-super-injector（dev_' }], tools: [{ name: 'read', description: 'read native' }, { name: 'dev_plugin_status', description: 'dev native' }, { name: 'relay_dispatch', description: 'dispatch native' }] }
  const parentPin = { v: 1, archetype: 'ORCHESTRATOR', projVersion: 0, cfgPinned: { compactSchema: false, promptGovernanceV2: true, narrowReadOnlyWorkerTools: false }, cfgDigest: 'x', openSnapshot: ['dev'], permissionPreset: null, latchedAtSeq: 0 }
  gate.writePinAtomic('fork-parent', parentPin)
  const parentOut = await run(parent, input)
  const route = { provider: 'google-vertex', model: 'gemini-4-argon' }
  const child = { header: { id: 'fork-child', parentSession: 'fork-parent', seedLength: 1, provider: route.provider, model: route.model }, events: [{ type: 'request/context', data: route }] }
  const childOut = await run(child, input)
  assert.equal(gate.headerEquals(parentOut, childOut), true)
  assert.equal(gate.readPin('fork-child').archetype, 'WORKER_FORK')
  assert.equal(gate.isChildSession(child), true)
})

test('R2-04: missing parent replay miss uses pass-through, never fresh worker', async () => {
  const route = { provider: 'google-vertex', model: 'gemini-4-argon' }
  const child = { header: { id: 'fork-miss', parentSession: 'no-parent-pin', seedLength: 1, provider: route.provider, model: route.model }, events: [{ type: 'request/context', data: route }, { type: 'request/header', ts: Date.now(), data: { header: rp } }] }
  const out = await run(child, rp)
  assert.equal(gate.headerEquals(rp, out), true)
  assert.equal(gate.readPin('fork-miss').archetype, 'WORKER_FORK')
  assert.notEqual(gate.readPin('fork-miss').archetype, 'WORKER_FRESH')
})

test.after(() => { rmSync(home, { recursive: true, force: true }); delete process.env.DSH_HOME })
