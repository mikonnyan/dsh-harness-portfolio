import test from 'node:test'
import assert from 'node:assert/strict'
import { COMPACT_MAP_VERSION, COMPACT_TOOL_DESCRIPTIONS, projectTools, stripHiddenBuiltinPromptSections } from '../lib/index.js'

const clone = (x) => JSON.parse(JSON.stringify(x))
const withoutDescriptions = (x) => {
  if (Array.isArray(x)) return x.map(withoutDescriptions)
  if (!x || typeof x !== 'object') return x
  return Object.fromEntries(Object.entries(x).filter(([k]) => k !== 'description').map(([k, v]) => [k, withoutDescriptions(v)]))
}
const freeze = (x) => { if (x && typeof x === 'object') { Object.freeze(x); for (const v of Object.values(x)) freeze(v) } return x }

for (const [name, map] of Object.entries(COMPACT_TOOL_DESCRIPTIONS)) {
  const tool = { name, description: 'original', parameters: { type: 'object', properties: Object.fromEntries(map.expectParams.map((p) => [p, { type: 'string', description: 'old', enum: ['x'] }])), required: [...map.expectParams], additionalProperties: false } }
  test(`${name}: deterministic, frozen-safe and schema invariant`, () => {
    const input = freeze([clone(tool)])
    const a = projectTools(input), b = projectTools(input)
    assert.equal(COMPACT_MAP_VERSION, 2)
    assert.equal(JSON.stringify(a), JSON.stringify(b))
    if (name === 'ask_user_question') assert.equal(a[0], input[0])
    else assert.notEqual(a[0], input[0])
    assert.deepEqual(withoutDescriptions(a), withoutDescriptions(input))
    assert.equal(projectTools(input, false), input)
  })
}

test('edit/read/write preserve tool descriptions and never mutate frozen long schemas', () => {
  const long = 'long original parameter description '.repeat(5)
  for (const name of ['edit', 'read', 'write']) {
    const map = COMPACT_TOOL_DESCRIPTIONS[name]
    const tool = freeze({ name, description: 'keep tool description', parameters: { type: 'object', properties: Object.fromEntries(map.expectParams.map((key) => [key, { type: 'string', description: long }])), required: [] } })
    const out = projectTools([tool])[0]
    assert.equal(out.description, 'keep tool description')
    assert.equal(out.parameters.properties.file_path.description, map.params.file_path)
    assert.notEqual(out.parameters.properties, tool.parameters.properties)
    assert.deepEqual(withoutDescriptions(out), withoutDescriptions(tool))
  }
})

test('parameter drift returns the original tool and logs', () => {
  const tool = { name: 'pwsh', description: 'old', parameters: { properties: { command: {}, extra: {} } } }
  const logs = []
  assert.equal(projectTools([tool], true, (s) => logs.push(s))[0], tool)
  assert.equal(logs.length, 1)
  assert.match(logs[0], /compact schema v2 fallback/)
})

test('read/edit/write require the real parameter names and drift fails open', () => {
  const tools = ['read', 'edit', 'write'].map((name) => ({ name, parameters: { properties: {} } }))
  assert.deepEqual(projectTools(tools), tools)
})

test('ask_user_question projects nested descriptions without changing Gemini structure', () => {
  const long = 'original description '.repeat(10)
  const leaf = (extra = {}) => ({ type: 'string', description: long, ...extra })
  const tool = { name: 'ask_user_question', description: long, parameters: { type: 'object', properties: { questions: { type: 'array', description: long, items: { type: 'object', required: ['id', 'question'], additionalProperties: false, properties: { id: leaf(), question: leaf(), header: leaf(), multi_select: { type: 'boolean', description: long }, options: { type: 'array', description: long, items: { type: 'object', properties: { label: leaf(), description: leaf() }, required: ['label'] } } } } } }, required: ['questions'], additionalProperties: false } }
  const before = clone(tool)
  const debugLogs = []
  const out = projectTools([tool], true, (line) => debugLogs.push(line))[0]
  assert.deepEqual(debugLogs, [])
  assert.deepEqual(withoutDescriptions(out), withoutDescriptions(before))
  assert.equal(out.parameters.properties.questions.items.properties.id.description, 'Stable id, echoed in the answer.')
  assert.equal(out.parameters.properties.questions.items.properties.options.items.properties.label.description, 'Short label.')
  const drifted = clone(tool)
  delete drifted.parameters.properties.questions.items.properties.options.items.properties.label
  const logs = []
  assert.equal(projectTools([drifted], true, (line) => logs.push(line))[0], drifted)
  assert.equal(logs.length, 1)
})

const paragraphs = {
  goal: 'Use goal tools for one long-running completion objective in the current session. create_goal may infer intent from direct human requests. Resume active goals explicitly when requested. '.padEnd(180, 'x'),
  workflow: 'Use the workflow tool ONLY when the user explicitly asks for a workflow or for large multi-agent orchestration. Write JavaScript that fans work out across phases. '.padEnd(180, 'x'),
  ralph: 'Use the ralph tool ONLY when the direct human explicitly asks for a Ralph loop or fresh-agent iterative execution. Each round starts a fresh child and uses the shared workspace. '.padEnd(180, 'x'),
  cursor_agent: 'When the user asks you to have Cursor implement, review, or otherwise do a standalone coding job, call cursor_agent. Give it a complete self-contained prompt including the goal and what done looks like. '.padEnd(180, 'x'),
}
const fixture = ['before', ...Object.values(paragraphs), 'after'].join('\n\n')
test('hidden builtin prompt paragraphs strip exactly and restore when extras opens', () => {
  const stripped = stripHiddenBuiltinPromptSections(fixture)
  assert.equal(stripped, 'before\n\nafter')
  assert.equal(stripHiddenBuiltinPromptSections(fixture, new Set(['extras'])), fixture)
  assert.equal(stripHiddenBuiltinPromptSections(fixture, new Set(), { hasGoalHistory: true }), ['before', paragraphs.goal, 'after'].join('\n\n'))
})
test('duplicate anchors, short text and code fences fail open', () => {
  assert.equal(stripHiddenBuiltinPromptSections(fixture + '\n\n' + paragraphs.goal), ['before', paragraphs.goal, 'after', paragraphs.goal].join('\n\n'))
  assert.equal(stripHiddenBuiltinPromptSections(paragraphs.goal.slice(0, 100)), paragraphs.goal.slice(0, 100))
  const fenced = paragraphs.goal + '\n```\nx\n```'
  assert.equal(stripHiddenBuiltinPromptSections(fenced), fenced)
})
