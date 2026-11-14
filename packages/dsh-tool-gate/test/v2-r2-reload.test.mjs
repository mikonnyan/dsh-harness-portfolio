import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const NOW = Date.now()
const home = mkdtempSync(join(tmpdir(), 'tool-gate-r2-reload-'))
process.env.DSH_HOME = home
writeFileSync(join(home, 'rp-guardian-sessions.json'), JSON.stringify({ enabled: [], disabled: [], globalDefault: false }))
const old = await import(`../lib/index.js?warm-old=${Date.now()}`)
const cfgDir = join(home, 'tool-gate'); mkdirSync(cfgDir, { recursive: true })
writeFileSync(join(cfgDir, 'config.json'), JSON.stringify({ promptGovernanceV2: false, compactSchema: true }))
const { COMPACT_MAPS_BY_VERSION } = await import('../lib/compact-schema.js')
const native = (name) => {
  const params = COMPACT_MAPS_BY_VERSION[3][name]?.expectParams || []
  return { name, description: `Native ${name}. `.repeat(50), parameters: { type: 'object', properties: Object.fromEntries(params.map((p) => [p, { type: 'string', description: `Native ${p}. `.repeat(30) }])) } }
}
const input = (tools) => ({ sections: [{ name: 'deployment:persona', text: 'You are a helpful software engineer assistant.' }], contexts: [], tools: tools.map(native) })
function harness(gate) {
  let listener
  const ctx = { tools: { register() {}, get: (n) => n === 'relay_dispatch' }, commands: { register() {} }, effect() {}, on(name, fn) { if (name === 'system-prompt/assemble') listener = fn }, logger: () => ({ warn() {}, info() {} }) }
  gate.apply(ctx)
  return (session, a) => listener({}, { agent: { session } }, async () => a)
}
function committed(id, header, extra = {}) {
  return { header: { id, ...extra }, events: [{ type: 'request/header', ts: NOW - 30_000, data: { header } }, { type: 'assistant/message', ts: NOW - 30_000, data: {} }] }
}

test('R2-13/R2-14/R2-15: warm ORCHESTRATOR migrates once to v2; WORKER_FRESH and SPECIALIZED stay byte-identical', async () => {
  const runOld = harness(old)
  const orchInput = input(['read', 'pwsh', 'relay_dispatch'])
  const orch = { header: { id: 'warm-orch' }, events: [] }
  const oldHeader = await runOld(orch, orchInput)
  const warmOrch = committed('warm-orch', oldHeader)
  const workerInput = input(['read', 'edit', 'pwsh', 'web_search', 'subagent'])
  const worker = committed('warm-worker', workerInput, { parentSession: 'parent' })
  const rpInput = { sections: [{ name: 'deployment:persona', text: '<!-- rp-pic static RP' }], contexts: [], tools: [{ name: 'rp_recall', description: 'native' }, native('pwsh')] }
  const rp = committed('warm-rp', rpInput, { rp: true })
  // No pins are written into these warm legacy sessions before the simulated upgrade.
  for (const id of ['warm-orch', 'warm-worker', 'warm-rp']) rmSync(join(old.pinDir(), `${id}.json`), { force: true })
  writeFileSync(join(cfgDir, 'config.json'), JSON.stringify({ promptGovernanceV2: true, compactSchema: true }))
  const upgraded = await import(`../lib/index.js?warm-new=${Date.now()}`)
  const runNew = harness(upgraded)
  const nextOrch = await runNew(warmOrch, orchInput)
  const nextWorker = await runNew(worker, workerInput)
  const nextRp = await runNew(rp, rpInput)
  assert.equal(upgraded.headerEquals(oldHeader, nextOrch), false)
  assert.equal(nextOrch.sections.some((s) => s.name.startsWith('tool:')), false)
  const pwshDescription = nextOrch.tools.find((t) => t.name === 'pwsh').description
  const oldPwshLength = upgraded.COMPACT_MAPS_BY_VERSION[2].pwsh.description.length
  assert.ok(pwshDescription.length <= oldPwshLength * 0.25, 'pwsh description must shrink by at least 77%')
  assert.equal(upgraded.readPin('warm-orch').projVersion, 3)
  assert.equal(upgraded.readPin('warm-orch').v2Epoch, 3)
  assert.equal(upgraded.headerEquals(workerInput, nextWorker), true)
  assert.equal(upgraded.headerEquals(rpInput, nextRp), true)
  assert.equal(upgraded.readPin('warm-worker').projVersion, 0)
  // Durable pin deletion followed by another fresh import must recover the same projection.
  for (const id of ['warm-orch', 'warm-worker', 'warm-rp']) rmSync(join(upgraded.pinDir(), `${id}.json`), { force: true })
  const replayed = await import(`../lib/index.js?warm-replay=${Date.now()}`)
  const runReplay = harness(replayed)
  assert.equal(replayed.headerEquals(nextOrch, await runReplay(warmOrch, orchInput)), true)
  assert.equal(replayed.readPin('warm-orch').v2Epoch, 3)
  assert.equal(replayed.headerEquals(workerInput, await runReplay(worker, workerInput)), true)
  assert.equal(replayed.headerEquals(rpInput, await runReplay(rp, rpInput)), true)
  // Deep R2: another warm import under governance v2 preserves already-latched headers.
  const stable = await import(`../lib/index.js?warm-stable=${Date.now()}`)
  const runStable = harness(stable)
  assert.equal(stable.headerEquals(nextOrch, await runStable(warmOrch, orchInput)), true)
  assert.equal(stable.headerEquals(nextWorker, await runStable(worker, workerInput)), true)
  assert.equal(stable.headerEquals(nextRp, await runStable(rp, rpInput)), true)
  warmOrch.events.push({ type: 'assistant/message', ts: NOW, data: { turn: 2 } })
  worker.events.push({ type: 'assistant/message', ts: NOW, data: { turn: 2 } })
  const realNow = Date.now
  Date.now = () => NOW + 301_000
  try {
  await runReplay(warmOrch, orchInput)
  await runReplay(worker, workerInput)
  assert.equal(replayed.readPin('warm-orch').projVersion, 3)
  assert.equal(replayed.readPin('warm-worker').projVersion, 3)
  assert.equal(replayed.headerEquals(rpInput, await runReplay(rp, rpInput)), true)
  } finally { Date.now = realNow }
})

test('R2-13: rewrite and rebase boundaries permit version upgrades', () => {
  const pin = { v: 1, archetype: 'WORKER_FRESH', projVersion: 0, cfgPinned: { compactSchema: true, promptGovernanceV2: false, narrowReadOnlyWorkerTools: false }, cfgDigest: 'old', permissionPreset: null, latchedAtSeq: 0 }
  for (const boundary of [true, false]) {
    const out = old.nextPin(pin, { archetype: 'WORKER_FRESH' }, { boundary, cfg: { compactSchema: true, promptGovernanceV2: true }, seq: 2, latestVersion: 3 })
    assert.equal(out.pin.projVersion, boundary ? 3 : 0)
  }
})

test.after(() => { rmSync(home, { recursive: true, force: true }); delete process.env.DSH_HOME })
