import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const NOW = Date.now()
const home = mkdtempSync(join(tmpdir(), 'tool-gate-v2-epoch-'))
process.env.DSH_HOME = home
mkdirSync(join(home, 'tool-gate'), { recursive: true })
writeFileSync(join(home, 'rp-guardian-sessions.json'), JSON.stringify({ enabled: [], disabled: [], globalDefault: false }))
writeFileSync(join(home, 'tool-gate', 'config.json'), JSON.stringify({ promptGovernanceV2: true, compactSchema: true }))

const gate = await import(`../lib/index.js?v2-epoch=${NOW}`)
const { V2_TOOL_DESCRIPTIONS, REDUNDANT_TOOL_SECTIONS } = await import('../lib/prompt-governance-v2.js')
const { COMPACT_MAPS_BY_VERSION } = await import('../lib/compact-schema.js')

const OLD_PARAGRAPHS = [
  'Use the read tool — not shell commands like cat — to inspect text files. Results include line numbers. Use offset and limit to continue reading large files.',
  'Use the write tool to create files or completely replace file contents. Existing files are overwritten, so read an existing file first.',
  'Use the edit tool for targeted changes to existing UTF-8 text files. It replaces literal old_string with new_string.',
  'Use the glob tool — not shell find — to discover files by path pattern. A pattern with no "/" matches basenames at any depth.',
  'Use the grep tool — not shell grep or rg — to search file contents. Use read on a matched file when you need surrounding context.',
  'Use the web_search tool to discover current information on the web. Cite the relevant URLs as markdown links.',
  'Use goal tools for one long-running completion objective in the current session. create_goal may infer goal intent from a direct human request.',
  'Use the workflow tool ONLY when the user explicitly asks for a workflow or for large multi-agent orchestration.',
  'Use the ralph tool ONLY when the direct human explicitly asks for a Ralph loop or fresh-agent iterative execution.',
  'When the user asks you to have Cursor implement, review, or otherwise do a standalone coding job, call cursor_agent.',
  'Use subagent in the background by default. Start independent delegations together in one assistant message.',
  'Use subagent_fork in the background by default. Start independent delegations together in one assistant message.',
  'Non-zero exits are reported as `[exit code: N]` markers; investigate failures before moving on. On Windows a killed process settles as `[exit code: 1]` without a signal marker.',
]
const LONG_PWSH = COMPACT_MAPS_BY_VERSION[2].pwsh.description
const NAMED = {
  'tool:read': OLD_PARAGRAPHS[0],
  'tool:write': OLD_PARAGRAPHS[1],
  'tool:edit': OLD_PARAGRAPHS[2],
  'tool:glob': OLD_PARAGRAPHS[3],
  'tool:grep': OLD_PARAGRAPHS[4],
  'tool:web_search': OLD_PARAGRAPHS[5],
  'tool:goal': OLD_PARAGRAPHS[6],
  'tool:workflow': OLD_PARAGRAPHS[7],
  'tool:ralph': OLD_PARAGRAPHS[8],
  'tool:cursor_agent': OLD_PARAGRAPHS[9],
  'tool:subagent': OLD_PARAGRAPHS[10],
  'tool:subagent_fork': OLD_PARAGRAPHS[11],
  'tool:pwsh': OLD_PARAGRAPHS[12],
}

function freezeTool(name, description) {
  const params = COMPACT_MAPS_BY_VERSION[3][name]?.expectParams || ['command']
  const properties = Object.freeze(Object.fromEntries(params.map((p) => [p, Object.freeze({ type: 'string', description: `native ${p}` })])))
  return Object.freeze({
    name,
    description,
    parameters: Object.freeze({ type: 'object', properties }),
  })
}

const TOOL_NAMES = ['pwsh', 'read', 'write', 'edit', 'glob', 'grep', 'subagent', 'subagent_fork', 'web_search', 'relay_dispatch']
const tools = TOOL_NAMES.map((name) => freezeTool(name, name === 'pwsh' ? LONG_PWSH : `${name} native description. `.repeat(40)))
const baked = OLD_PARAGRAPHS.join('\n\n')
const sections = [
  { name: 'harness:identity', text: 'You are an AI agent powered by DeepSeek Harness.' },
  { name: 'deployment:persona', text: 'Custom orchestrator persona stays.' },
  ...Object.entries(NAMED).map(([name, text]) => ({ name, text })),
  { name: 'snapshot:nodes0', text: baked },
]
const assembly = { sections, contexts: [], tools }
const committed = JSON.parse(JSON.stringify(assembly))

function legacySession() {
  const events = [{
    seq: 0,
    type: 'user/message',
    ts: NOW - 60_000,
    surfaceOp: 'append',
    data: { role: 'user', content: [{ type: 'text', text: baked }] },
  }]
  for (let n = 1; n <= 500; n++) events.push({ seq: events.length, type: 'turn/start', ts: NOW - 50_000, data: { turn: n } })
  events.push({ seq: events.length, type: 'request/header', ts: NOW - 30_000, data: { header: committed, reason: 'resume' } })
  events.push({ seq: events.length, type: 'assistant/message', ts: NOW - 30_000, data: { turn: 500 } })
  return {
    header: { id: 'session-62e684d4' },
    seq: events.length,
    surface: { nodes: [0] },
    snapshotEvents: () => events,
    eventAt: (i) => events[i],
  }
}

function harness() {
  let listener
  const ctx = {
    tools: { register() {}, get: (n) => n === 'relay_dispatch' },
    commands: { register() {} },
    effect() {},
    on(name, fn) { if (name === 'system-prompt/assemble') listener = fn },
    logger: () => ({ warn() {}, info() {} }),
  }
  gate.apply(ctx)
  return (session, input) => listener({}, { agent: { session } }, async () => input)
}

const rendered = (out) => (out.sections || []).map((s) => s.text).join('\n\n')

test('warm 500-turn orchestrator migrates once off frozen nodes[0] and snapshotEvents', async () => {
  assert.ok(LONG_PWSH.length >= 1221, 'fixture must be the long pwsh description')
  assert.ok(V2_TOOL_DESCRIPTIONS.pwsh.length < 1000)
  const session = legacySession()
  const node0 = session.snapshotEvents()[session.surface.nodes[0]]
  assert.ok(node0.data.content[0].text.includes('Use the read tool — not shell commands like cat'))
  const filtered = gate.filterTools(assembly.tools, session, gate.loadConfig(), {}, NOW)
  const pwshIn = filtered.find((t) => t.name === 'pwsh')
  assert.equal(pwshIn, assembly.tools.find((t) => t.name === 'pwsh'), 'filterTools returns the same reference')
  assert.ok(Object.isFrozen(pwshIn))
  const hot = NOW - (session.snapshotEvents().at(-1).ts) < gate.DEFAULT_CONFIG.cacheExpiryMs
  assert.equal(hot, true)

  const run = harness()
  const first = await run(session, assembly)
  const text = rendered(first)
  for (const paragraph of OLD_PARAGRAPHS) assert.equal(text.includes(paragraph), false, paragraph.slice(0, 48))
  for (const name of REDUNDANT_TOOL_SECTIONS) assert.equal(first.sections.some((s) => s.name === name), false, name)
  assert.ok(first.sections.some((s) => s.name === 'harness:identity'))
  assert.equal(first.sections.some((s) => s.name === 'snapshot:nodes0'), false)
  for (const name of ['pwsh', 'read', 'write', 'edit', 'glob', 'grep', 'subagent', 'subagent_fork', 'web_search']) {
    assert.equal(first.tools.find((t) => t.name === name).description, V2_TOOL_DESCRIPTIONS[name], name)
  }
  assert.equal(pwshIn.description, LONG_PWSH, 'frozen input description was not mutated')
  assert.ok(node0.data.content[0].text.includes('Use the read tool — not shell commands like cat'))
  const pin = gate.readPin('session-62e684d4')
  assert.equal(pin.archetype, 'ORCHESTRATOR')
  assert.equal(pin.projVersion, 3)
  assert.equal(pin.v2Epoch, 3)
  assert.equal(pin.legacy, undefined)

  const second = await run(session, assembly)
  assert.equal(gate.headerEquals(first, second), true)
  assert.equal(gate.readPin('session-62e684d4').v2Epoch, 3)
})

test.after(() => { rmSync(home, { recursive: true, force: true }); delete process.env.DSH_HOME })
