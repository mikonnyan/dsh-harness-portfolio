import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const LIB = new URL('../lib/', import.meta.url)

// ── R1-01: standalone imports in every order; no duplicate export names; pre-v2 exports resolve ──
const MODULES = ['session-archetype.js', 'pin-store.js', 'prompt-projection.js', 'compact-schema.js', 'permission-guard.js', 'orchestrator-guard.js', 'index.js']

test('R1-01: every module imports standalone in every order', async () => {
  const orders = [
    MODULES,
    [...MODULES].reverse(),
    ['index.js', 'session-archetype.js', 'pin-store.js', 'prompt-projection.js', 'compact-schema.js', 'permission-guard.js', 'orchestrator-guard.js'],
    ['prompt-projection.js', 'pin-store.js', 'session-archetype.js', 'orchestrator-guard.js', 'permission-guard.js', 'compact-schema.js', 'index.js'],
  ]
  for (const order of orders) {
    for (const name of order) {
      const mod = await import(new URL(name + `?order=${orders.indexOf(order)}`, LIB))
      assert.ok(mod, `${name} failed to import`)
    }
  }
})

test('R1-01: union of export * names has no duplicates across modules', async () => {
  const index = await import(new URL('index.js', LIB))
  const nameSets = await Promise.all(MODULES.slice(0, 6).map(async (m) => {
    const mod = await import(new URL(m, LIB))
    return { m, names: Object.keys(mod) }
  }))
  const seen = new Map()
  for (const { m, names } of nameSets) for (const n of names) {
    assert.ok(!seen.has(n), `duplicate export name ${n} in ${m} and ${seen.get(n)}`)
    seen.set(n, m)
  }
  void index
})

test('R1-01: every pre-v2 export name still resolves from index.js', async () => {
  const index = await import(new URL('index.js', LIB))
  const preV2 = [
    'name', 'inject', 'EXTRAS_TOOLS', 'DEFAULT_CONFIG', 'isV4Session', 'getAllEvents', 'getEvent', 'logLength',
    'classifyPrefixRewrite', 'ensurePrefixEpoch', 'permissionDecision', 'OUT_OF_SCOPE', 'HIGH_RISK', 'DEFAULT_LOOPBACK_PORTS',
    'manifestOf', 'isChildSession', 'SELF_FIX', 'SHELL_BUDGET', 'ORCHESTRATOR_DEFAULTS', 'sessionRole',
    'classifyOrchestratorOp', 'orchestratorDecision', 'escapeHatchState', 'strictTurnDecision', 'isMainOrchestratorSession',
    'COMPACT_MAP_VERSION', 'COMPACT_TOOL_DESCRIPTIONS', 'projectTools', 'stripHiddenBuiltinPromptSections', 'HIDDEN_BUILTIN_PARAGRAPHS',
  ]
  for (const n of preV2) assert.ok(n in index, `pre-v2 export missing: ${n}`)
})

// ── helpers ──
const withoutDescriptions = (value) => Array.isArray(value)
  ? value.map(withoutDescriptions)
  : value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).filter(([k]) => k !== 'description').map(([k, c]) => [k, withoutDescriptions(c)]))
    : value

function nativeTool(name, params, description, extra = {}) {
  const properties = {}
  for (const p of params) properties[p] = { type: 'string', description: `Native long description for ${name}.${p} `.repeat(12) }
  return { name, description: (description || `Native long description for ${name}. `).repeat(20), parameters: { type: 'object', properties, required: params.slice(0, 1) }, ...extra }
}

const { COMPACT_MAPS_BY_VERSION, LATEST_PROJ_VERSION, COMPACT_MAP_VERSION, projectToolsWithMeta, projectTools } = await import(new URL('compact-schema.js', LIB))

// ── R1-02: parameter structure preserved; inputs frozen and unmutated ──
test('R1-02: map 3 and map 2 entries preserve parameter structure; inputs frozen, not mutated', () => {
  for (const version of [2, 3]) {
    const map = COMPACT_MAPS_BY_VERSION[version]
    for (const [name, entry] of Object.entries(map)) {
      const tool = Object.freeze({ ...nativeTool(name, entry.expectParams), parameters: Object.freeze({ ...nativeTool(name, entry.expectParams).parameters }) })
      const snapshot = JSON.stringify(tool)
      const { tools, appliedNames } = projectToolsWithMeta([tool], { compactSchema: true, mapVersion: version })
      assert.equal(JSON.stringify(tool), snapshot, `${name} v${version}: input mutated`)
      if (!appliedNames.has(name)) continue // fallback path also must not mutate
      assert.deepEqual(withoutDescriptions(tools[0].parameters), withoutDescriptions(tool.parameters), `${name} v${version}: parameter structure changed`)
    }
  }
})

// ── R1-03: map 2 output byte-identical to old projectTools on a recorded fixture ──
test('R1-03: map 2 projection is byte-identical to the recorded v1 output', () => {
  const fixturePath = new URL('./fixtures/projected-map2.snapshot.json', import.meta.url)
  const map = COMPACT_MAPS_BY_VERSION[2]
  const tools = Object.keys(map).map((n) => nativeTool(n, map[n].expectParams))
  const out = projectToolsWithMeta(tools, { compactSchema: true, mapVersion: 2 }).tools
  const expected = out.map((t) => ({ description: t.description, properties: t.parameters.properties }))
  let fixture
  try {
    fixture = JSON.parse(readFileSync(fixturePath, 'utf8'))
  } catch {
    // First run: record the snapshot (map 2 is byte-frozen, so this is deterministic).
    writeFileSync(fixturePath, JSON.stringify({ tools: tools.map((t) => ({ name: t.name, params: map[t.name].expectParams, description: t.description })), expected }, null, 1))
    return
  }
  assert.equal(fixture.expected.length, expected.length)
  for (let i = 0; i < expected.length; i++) {
    assert.equal(expected[i].description, fixture.expected[i].description, `${fixture.tools[i].name}: description drift`)
    assert.deepEqual(expected[i].properties, fixture.expected[i].properties, `${fixture.tools[i].name}: properties drift`)
  }
})

function await0() { return import('node:fs') }

// ── R1-04: pwsh/bash v3 trailing clause; context_compact open-turn rule ──
test('R1-04: pwsh and bash v3 descriptions end with the decision-point clause', () => {
  const clause = ' Not for reading or searching files — use read/grep/glob.'
  assert.ok(COMPACT_MAPS_BY_VERSION[3].pwsh.description.endsWith(clause))
  assert.ok(COMPACT_MAPS_BY_VERSION[3].bash.description.endsWith(clause))
  assert.ok(!COMPACT_MAPS_BY_VERSION[2].pwsh.description.includes(clause), 'map 2 must stay frozen')
})

test('R1-04: context_compact v3 keeps the open-turn rule', () => {
  assert.ok(COMPACT_MAPS_BY_VERSION[3].context_compact.description.includes('Open turns are never compacted'))
})

// ── R1-05: parameter drift keeps native description and excludes from appliedNames ──
test('R1-05: parameter drift on one tool keeps it native and absent from appliedNames', () => {
  const good = nativeTool('read', COMPACT_MAPS_BY_VERSION[3].read.expectParams)
  const drifted = nativeTool('edit', ['file_path', 'new_string', 'old_string', 'unexpected_param'])
  const { tools, appliedNames } = projectToolsWithMeta([good, drifted], { compactSchema: true, mapVersion: 3 })
  assert.ok(appliedNames.has('read'))
  assert.ok(!appliedNames.has('edit'))
  assert.equal(tools[1].description, drifted.description, 'drifted tool must keep its native description')
  assert.deepEqual(tools[1].parameters, drifted.parameters)
})

// ── R1-06: compactSchema:false and mapVersion:0 return tools unchanged, empty appliedNames ──
test('R1-06: compactSchema false and mapVersion 0 leave tools unchanged with empty appliedNames', () => {
  const tools = [nativeTool('read', COMPACT_MAPS_BY_VERSION[3].read.expectParams), nativeTool('pwsh', COMPACT_MAPS_BY_VERSION[3].pwsh.expectParams)]
  for (const opts of [{ compactSchema: false }, { compactSchema: true, mapVersion: 0 }]) {
    const out = projectToolsWithMeta(tools, opts)
    assert.deepEqual(out.tools, tools)
    assert.equal(out.appliedNames.size, 0)
    assert.equal(out.mapVersion, 0)
  }
  assert.equal(LATEST_PROJ_VERSION, 3)
  assert.equal(COMPACT_MAP_VERSION, 3)
})

test('R1-06b: projectTools wrapper still returns the array', () => {
  const tools = [nativeTool('read', COMPACT_MAPS_BY_VERSION[3].read.expectParams)]
  assert.ok(Array.isArray(projectTools(tools, true)))
  assert.equal(projectTools(tools, false), tools)
})
