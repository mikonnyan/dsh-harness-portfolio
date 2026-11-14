import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { classifySession, detectRpEvidence, publishArchetype } from '../lib/session-archetype.js'
import { nextPin, cfgDigestOf } from '../lib/pin-store.js'
import { projectAssembly, isDefaultEngineeringPersona, ORCHESTRATOR_PERSONA } from '../lib/prompt-projection.js'
import { strictTurnDecision } from '../lib/orchestrator-guard.js'

const ledger = JSON.parse(readFileSync(new URL('./fixtures/tool-constraint-ledger.json', import.meta.url), 'utf8'))
const native = (name, params = []) => ({ name, description: `Native ${name}. `.repeat(30), parameters: { type: 'object', properties: Object.fromEntries(params.map((p) => [p, { type: 'string', description: `Native ${p}. `.repeat(20) }])) } })
const assembly = (tools = [native('read'), native('relay_dispatch')]) => ({ sections: [{ name: 'deployment:persona', text: 'A private character with no engineering-template marker.' }], contexts: [{ text: 'stable' }], tools })

test('R2-01/R2-10: role classification is stable and catalog order independent', () => {
  const session = { header: { id: 'r2-order' }, events: [] }
  assert.equal(classifySession(session, { tools: [] }, { hasRegisteredTool: () => true }).archetype, 'ORCHESTRATOR')
  assert.equal(classifySession(session, { tools: [native('relay_dispatch')] }, { hasRegisteredTool: () => false }).archetype, 'ORCHESTRATOR')
  const pin = { v: 1, archetype: 'STANDALONE', projVersion: 3, cfgDigest: cfgDigestOf({}), permissionPreset: null, latchedAtSeq: 0 }
  assert.equal(nextPin(pin, { archetype: 'ORCHESTRATOR' }, { boundary: false, cfg: {} }).changed, false)
})

test('R2-06/R2-07/R2-09: RP precedence, title negatives, globalDefault and parent inheritance', () => {
  const rpState = { enabled: ['parent-rp'], disabled: ['off'], globalDefault: true }
  assert.equal(detectRpEvidence({ header: { id: 'off', title: 'dsh-rp-guardian' } }, null, { rpState }), null)
  assert.equal(detectRpEvidence({ header: { id: 'new', title: '苏晚晴 dsh-rp-guardian' } }, null, { rpState }), 'rp_guardian_global_default')
  const child = { header: { id: 'child-rp', parentSession: 'parent-rp' }, events: [] }
  publishArchetype('parent-rp', { archetype: 'SPECIALIZED', rp: true, suppressModeBoost: false, projVersion: 0, provisional: false })
  assert.equal(classifySession(child, null, { rpState }).archetype, 'SPECIALIZED')
  assert.equal(detectRpEvidence({ header: { id: 'manifest-rp', capabilityManifest: { dispatch_mode: 'uncensored' }, cwd: 'C:/Temp/work' } }, null, { rpState: {} }), 'manifest_rp_or_uncensored_mode')
  for (const name of ['complete', 'tools:sdk', 'tools:code-only', 'cordis:composition']) {
    const a = { sections: [{ name, ...(name === 'complete' ? { complete: true } : {}) }], tools: [] }
    assert.equal(classifySession({ header: { id: `sdk-${name}`, includeSubagents: true } }, a, {}).archetype, 'SPECIALIZED')
  }
})

test('R2-04/R2-08: unknown persona and parent fork projection are verbatim', () => {
  const a = assembly()
  const pin = { v: 1, archetype: 'WORKER_FORK', parentArchetype: 'ORCHESTRATOR', projVersion: 3, cfgPinned: { compactSchema: false, promptGovernanceV2: true, narrowReadOnlyWorkerTools: false }, latchedAtSeq: 0 }
  const out = projectAssembly(a, pin, new Set(['dev']), { ledger })
  assert.equal(out.sections[0].text, a.sections[0].text)
  assert.deepEqual(out.tools, a.tools)
  assert.deepEqual(out.contexts, a.contexts)
  assert.equal(isDefaultEngineeringPersona('You are a helpful software engineer assistant.'), true)
  assert.equal(isDefaultEngineeringPersona('You are a custom persona.'), false)
})

test('R2-11/R2-12: late latch and 2000 monotone evidence sequences', () => {
  const names = ['STANDALONE', 'ORCHESTRATOR', 'WORKER_FRESH', 'SPECIALIZED']
  const ranks = { STANDALONE: 0, ORCHESTRATOR: 1, WORKER_FRESH: 2, SPECIALIZED: 3 }
  let seed = 0x52a1
  for (let n = 0; n < 2000; n++) {
    let pin = null, rank = 0
    for (let step = 0; step < 8; step++) {
      seed = (seed * 1664525 + 1013904223) >>> 0
      const live = { archetype: names[seed % names.length] }
      const boundary = seed % 17 === 0
      const before = pin
      pin = nextPin(pin, live, { boundary, cfg: {}, seq: step }).pin
      if (!boundary && before) assert.ok(ranks[pin.archetype] >= rank)
      rank = ranks[pin.archetype]
    }
  }
  const worker = { header: { id: 'late-worker', parentSession: 'p' }, events: [{ type: 'turn/start', data: { turn: 1 } }] }
  assert.equal(strictTurnDecision('read', { file_path: 'C:/a.md' }, worker, {}, { strict: true }).kind, 'allow')
})
