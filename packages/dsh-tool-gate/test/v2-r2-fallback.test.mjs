import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { projectAssembly } from '../lib/prompt-projection.js'
import { COMPACT_MAPS_BY_VERSION, projectToolsWithMeta } from '../lib/compact-schema.js'

const ledger = JSON.parse(readFileSync(new URL('./fixtures/tool-constraint-ledger.json', import.meta.url), 'utf8'))
const snapshot = JSON.parse(readFileSync(new URL('./fixtures/native-sections.snapshot.json', import.meta.url), 'utf8'))
const native = (name, drift = false) => {
  const params = [...(COMPACT_MAPS_BY_VERSION[3][name]?.expectParams || [])]
  if (drift) params.push('upstream_new_parameter')
  return { name, description: `Native ${name} full text. `.repeat(40), parameters: { type: 'object', properties: Object.fromEntries(params.map((p) => [p, { type: 'string', description: `Native ${p}. `.repeat(30) }])) } }
}
const sections = Object.entries(snapshot.sections).map(([name, text]) => ({ name, text }))
const pin = (compactSchema = true) => ({ v: 1, archetype: 'ORCHESTRATOR', projVersion: 3, cfgPinned: { compactSchema, promptGovernanceV2: true, narrowReadOnlyWorkerTools: false }, latchedAtSeq: 0 })

test('R2 Edge 3: edit and pwsh drift preserve their native negative constraints and tools', () => {
  for (const name of ['edit', 'pwsh']) {
    const a = { sections, contexts: [], tools: [native('read'), native(name, true)] }
    const out = projectAssembly(a, pin(), new Set(), { ledger })
    assert.equal(out.tools.find((t) => t.name === name), a.tools[1])
    assert.equal(out.sections.find((s) => s.name === `tool:${name}`)?.text, snapshot.sections[`tool:${name}`])
    assert.ok(!out.meta.appliedNames.includes(name))
  }
})

test('R2 Edge 3: compactSchema false is byte-identical and emits no discipline', () => {
  const a = { sections, contexts: [], tools: [native('read'), native('edit'), native('pwsh')] }
  const out = projectAssembly(a, pin(false), new Set(), { ledger })
  assert.deepEqual(out.sections, a.sections)
  assert.deepEqual(out.tools, a.tools)
  assert.equal(out.meta.disciplineEmitted, false)
  assert.equal(projectToolsWithMeta(a.tools, { compactSchema: false }).appliedNames.size, 0)
})
