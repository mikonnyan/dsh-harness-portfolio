import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const LIB = new URL('../lib/', import.meta.url)
const {
  splitSentences, isDefaultEngineeringPersona, buildDisciplineSection, liveCarriers,
  canDropToolSection, loadConstraintLedger, projectAssembly, ORCHESTRATOR_PERSONA, WORKER_PERSONA,
} = await import(new URL('prompt-projection.js', LIB))
const { projectToolsWithMeta, COMPACT_MAPS_BY_VERSION } = await import(new URL('compact-schema.js', LIB))

const ledger = JSON.parse(readFileSync(new URL('./fixtures/tool-constraint-ledger.json', import.meta.url), 'utf8'))
const snapshot = JSON.parse(readFileSync(new URL('./fixtures/native-sections.snapshot.json', import.meta.url), 'utf8'))

// ── R1-07: ledger coverage — every sentence of every tool:* section has >=1 carrier ──
test('R1-07: every snapshot sentence maps to a ledger entry with >=1 carrier', () => {
  for (const [name, text] of Object.entries(snapshot.sections)) {
    const entry = ledger.sections[name]
    assert.ok(entry, `no ledger entry for ${name}`)
    const ledgerSentences = new Set(entry.sentences.map((s) => s.text))
    for (const sentence of splitSentences(text)) {
      assert.ok(ledgerSentences.has(sentence), `uncovered sentence in ${name}: ${sentence.slice(0, 60)}`)
    }
    for (const s of entry.sentences) {
      assert.ok(Array.isArray(s.carriers) && s.carriers.length >= 1, `${name}: sentence with no carrier`)
    }
  }
})

test('R1-07: an injected extra sentence fails coverage', () => {
  const doctored = JSON.parse(JSON.stringify(snapshot))
  doctored.sections['tool:read'] += ' A brand new sentence that no ledger entry covers.'
  for (const [name, text] of Object.entries(doctored.sections)) {
    const entry = ledger.sections[name]
    if (!entry) continue
    const ledgerSentences = new Set(entry.sentences.map((s) => s.text))
    for (const sentence of splitSentences(text)) {
      if (sentence.includes('brand new sentence')) {
        assert.ok(!ledgerSentences.has(sentence), 'injected sentence must not be covered')
      }
    }
  }
})

// ── R1-08: buildDisciplineSection over all 2^9 subsets ──
const DISCIPLINE_TOOLS = ['read', 'grep', 'glob', 'write', 'edit', 'pwsh', 'bash', 'job_output', 'subagent']

test('R1-08: discipline section over all 2^9 subsets: no absent tool named, <=2 lines, <=420 units, order-independent', () => {
  for (let mask = 0; mask < 1 << 9; mask++) {
    const names = DISCIPLINE_TOOLS.filter((_, i) => mask & (1 << i))
    const section = buildDisciplineSection(new Set(names))
    if (!names.length) { assert.equal(section, null); continue }
    // Spec-verbatim §9.4.2: subsets firing no clause yield null (e.g. {write}, {web_search}).
    if (!section) continue
    assert.equal(section.name, 'tool-gate:discipline')
    const lines = section.text.split('\n')
    assert.ok(lines.length <= 2, `subset ${mask}: ${lines.length} lines`)
    assert.ok(section.text.length <= 420, `subset ${mask}: ${section.text.length} units`)
    for (const absent of DISCIPLINE_TOOLS.filter((n) => !names.includes(n))) {
      assert.ok(!section.text.includes(absent + ' is'), `subset ${mask}: names absent tool ${absent}`)
    }
    // Order independence: shuffled insertion produces identical output.
    const shuffled = [...names].reverse()
    assert.equal(buildDisciplineSection(new Set(shuffled)).text, section.text, `subset ${mask}: order-dependent`)
  }
})

// ── R1-09: fallback permutations — every ledger sentence keeps >=1 live carrier ──
function assemblyWith(tools, sections) {
  return { tools, sections, contexts: [] }
}
function nativeTool(name, params, description) {
  const properties = {}
  for (const p of params) properties[p] = { type: 'string', description: ('Native long description for ' + name + '.' + p + ' ').repeat(12) }
  return { name, description: (description || 'Native long description for ' + name + '. ').repeat(20), parameters: { type: 'object', properties, required: params.slice(0, 1) } }
}
const map3 = COMPACT_MAPS_BY_VERSION[3]
const allTools = ['read', 'grep', 'glob', 'write', 'edit', 'pwsh', 'bash', 'job_output', 'subagent', 'web_search']
  .map((n) => nativeTool(n, map3[n].expectParams))
const allSections = Object.entries(snapshot.sections).map(([name, text]) => ({ name, text }))

function assertNoDeadCarriers(label, assembled, pin, opts = {}) {
  const out = projectAssembly(assembled, pin, new Set(), { ledger, ...opts })
  const visible = new Set(out.tools.map((t) => t?.name))
  const live = liveCarriers(visible, new Set(out.meta.appliedNames), out.meta.disciplineEmitted ? buildDisciplineSection(visible)?.text : null)
  for (const [name, entry] of Object.entries(ledger.sections)) {
    if (!assembled.sections.some((s) => s.name === name)) continue
    const dropped = out.meta.dropped.includes(name)
    for (const s of entry.sentences) {
      const hasLive = s.carriers.some((c) => live.has(c))
      if (dropped) assert.ok(hasLive, `${label}: dropped ${name} with dead carriers (sentence: ${s.text.slice(0, 50)})`)
    }
    assert.ok(!(dropped && !hasAnyCarrier(entry, live)), `${label}: ${name} dropped with all carriers dead`)
  }
  return out
}
const hasAnyCarrier = (entry, live) => entry.sentences.every((s) => s.carriers.some((c) => live.has(c)))

const ORCH_PIN = { v: 1, archetype: 'ORCHESTRATOR', projVersion: 3, cfgPinned: { compactSchema: true, promptGovernanceV2: true, narrowReadOnlyWorkerTools: false }, cfgDigest: 'x', permissionPreset: null, latchedAtSeq: 0 }

test('R1-09: fallback permutations keep every ledger sentence covered', () => {
  // (a) edit drift
  const driftedEdit = { ...nativeTool('edit', ['file_path', 'new_string', 'old_string', 'surprise']), name: 'edit' }
  const toolsA = allTools.map((t) => t.name === 'edit' ? driftedEdit : t)
  assertNoDeadCarriers('edit-drift', assemblyWith(toolsA, allSections), ORCH_PIN)
  // (b) compactSchema false
  const pinB = { ...ORCH_PIN, cfgPinned: { ...ORCH_PIN.cfgPinned, compactSchema: false } }
  const outB = assertNoDeadCarriers('compact-false', assemblyWith(allTools, allSections), pinB)
  assert.equal(outB.meta.disciplineEmitted, false)
  assert.deepEqual(outB.meta.dropped, [])
  // (c) bash only, applied
  const toolsC = allTools.map((t) => t.name === 'pwsh' ? nativeTool('bash', map3.bash.expectParams) : t).filter((t) => t.name !== 'bash' || true)
  const sectionsC = allSections.filter((s) => s.name !== 'tool:pwsh')
  assertNoDeadCarriers('bash-applied', assemblyWith(toolsC, sectionsC), ORCH_PIN)
  // (d) bash only, drifted
  const driftedBash = nativeTool('bash', ['command', 'unexpected'])
  const toolsD = allTools.map((t) => t.name === 'pwsh' ? driftedBash : t)
  const sectionsD = allSections.filter((s) => s.name !== 'tool:pwsh')
  assertNoDeadCarriers('bash-drifted', assemblyWith(toolsD, sectionsD), ORCH_PIN)
  // (e) worker surface
  const WORKER_PIN = { ...ORCH_PIN, archetype: 'WORKER_FRESH' }
  const outE = assertNoDeadCarriers('worker', assemblyWith(allTools, allSections), WORKER_PIN)
  assert.ok(!outE.tools.some((t) => t.name === 'subagent'), 'worker must not see subagent')
})

// ── R1-10: A7 minimality + the §9.4.2 table equals canDropToolSection (all-applied) ──
test('R1-10: compactSchema false => no discipline, native sections byte-identical', () => {
  const pin = { ...ORCH_PIN, cfgPinned: { ...ORCH_PIN.cfgPinned, compactSchema: false } }
  const out = projectAssembly(assemblyWith(allTools, allSections), pin, new Set(), { ledger })
  assert.equal(out.meta.disciplineEmitted, false)
  assert.deepEqual(out.meta.dropped, [])
  for (const section of allSections) {
    const kept = out.sections.find((s) => s.name === section.name)
    assert.ok(kept, `${section.name} dropped under compactSchema:false`)
    assert.equal(kept.text, section.text)
  }
})

test('R1-10: canDropToolSection table on the all-applied case', () => {
  const visible = new Set(allTools.map((t) => t.name))
  const applied = new Set(allTools.map((t) => t.name))
  const discipline = buildDisciplineSection(visible)
  const live = liveCarriers(visible, applied, discipline.text)
  // All ledger sections with every carrier live are droppable.
  for (const name of Object.keys(ledger.sections)) {
    assert.equal(canDropToolSection(name, live, ledger), true, `${name} should drop when all carriers live`)
  }
  assert.equal(canDropToolSection('tool:unknown', live, ledger), false)
  assert.equal(canDropToolSection('not-a-tool-section', live, ledger), false)
  // With no live carriers at all, nothing drops.
  const dead = new Set()
  for (const name of Object.keys(ledger.sections)) {
    assert.equal(canDropToolSection(name, dead, ledger), false)
  }
})

// ── R1-11: P7 persona replacement ──
const DEFAULT_TEMPLATES = [
  'You are a hands-on software engineer who delivers working output fast. Work directly: write or edit code, run commands, and verify results yourself.',
  'You are a coding agent. Follow instructions carefully.',
  'You are a helpful software engineer assistant. Be concise.',
  'You are an AI agent powered by DeepSeek Harness. You are interacting with the user through a GUI.',
]
const NON_DEFAULT = [
  '苏晚晴是一位温柔的角色扮演者。',
  'You are a custom subagent persona for data analysis.',
  '   ',
  'You are a coding agent. Follow instructions carefully.\nExtra appended sentence.',
  'You are a coding agent with a twist.',
  'You are the RP guardian.',
  'You are a helpful translator.',
  '晚晴 HANDOVER persona text.',
  'You are a hands-on software engineer who delivers chaos.',
  'You are an AI agent powered by something else entirely.',
  'You are a playwright writing novels.',
  'You are a coding agent',
]

test('R1-11: the 4 default templates are replaced under ORCHESTRATOR and WORKER', () => {
  for (const text of DEFAULT_TEMPLATES) {
    assert.ok(isDefaultEngineeringPersona(text), `should match: ${text.slice(0, 40)}`)
  }
})

test('R1-11: 12 non-default personas are byte-identical under every archetype', () => {
  const archetypes = ['ORCHESTRATOR', 'WORKER_FRESH', 'WORKER_FORK', 'STANDALONE']
  for (const text of NON_DEFAULT) {
    assert.equal(isDefaultEngineeringPersona(text), false, `false positive on: ${text.slice(0, 40)}`)
    for (const archetype of archetypes) {
      const pin = { ...ORCH_PIN, archetype }
      const sections = [{ name: 'deployment:persona', text }, ...allSections]
      const out = projectAssembly(assemblyWith(allTools, sections), pin, new Set(), { ledger })
      const persona = out.sections.find((s) => s.name === 'deployment:persona')
      assert.equal(persona.text, text, `${archetype}: persona mutated`)
    }
  }
})

test('R1-11: default persona replaced with role persona', () => {
  for (const [archetype, expected] of [['ORCHESTRATOR', ORCHESTRATOR_PERSONA], ['WORKER_FRESH', WORKER_PERSONA]]) {
    const pin = { ...ORCH_PIN, archetype }
    const sections = [{ name: 'deployment:persona', text: DEFAULT_TEMPLATES[0] }, ...allSections]
    const out = projectAssembly(assemblyWith(allTools, sections), pin, new Set(), { ledger, model: 'test-model', cwd: 'C:/ws' })
    const persona = out.sections.find((s) => s.name === 'deployment:persona')
    assert.equal(persona.text, expected.replaceAll('{{model}}', 'test-model').replaceAll('{{cwd}}', 'C:/ws'))
  }
})

// ── R1-12: splitSentences golden cases ──
test('R1-12: splitSentences on 20 golden cases (CJK, code spans, whitespace)', () => {
  const cases = [
    ['One sentence.', ['One sentence.']],
    ['Two. Sentences.', ['Two.', 'Sentences.']],
    ['A. B! C?', ['A.', 'B!', 'C?']],
    ['Line one\nLine two', ['Line one', 'Line two']],
    ['中文句号。第二句！', ['中文句号。', '第二句！']],
    ['No terminal punctuation', ['No terminal punctuation']],
    ['', []],
    ['   ', []],
    ['Dr. Smith went home. He slept.', ['Dr. Smith went home.', 'He slept.']],
    ['e.g. this. That.', ['e.g. this.', 'That.']],
    ['3.14 is pi. Yes.', ['3.14 is pi.', 'Yes.']],
    ['`code. span` stays. Next.', ['`code. span` stays.', 'Next.']],
    ['Ends with period.', ['Ends with period.']],
    ['Multiple\n\nnewlines\nhere.', ['Multiple', 'newlines', 'here.']],
    ['Mixed。Punctuation! Works?', ['Mixed。', 'Punctuation!', 'Works?']],
    ['Tab\tseparated. Fine.', ['Tab\tseparated.', 'Fine.']],
    ['Trailing whitespace.   ', ['Trailing whitespace.']],
    ['Question? Answer.', ['Question?', 'Answer.']],
    ['A.B.C. Dots.', ['A.B.C. Dots.']],
    ['Final\n', ['Final']],
  ]
  for (const [input, expected] of cases) {
    assert.deepEqual(splitSentences(input), expected, `input: ${JSON.stringify(input)}`)
  }
})
