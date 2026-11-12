// Live against installed dsh-session. Not in `npm test` until the session dialect matches this fixture.
import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { cpSync, mkdirSync, readdirSync, symlinkSync, rmSync, writeFileSync } from 'node:fs'
import { planSpanCompaction, commitSpanCompaction, executeRecall, isV4Session, classifySurfaceNode, inspectSessionLog, summaryFrontierIndex } from '../lib/index.js'

const OLD_ROOT = path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules')
const OLD = path.join(OLD_ROOT, '@deepseek-ai')
const runtime = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(?:[A-Za-z]:)/, (m) => m.slice(1))), '.v4-runtime')
const scoped = path.join(runtime, 'node_modules', '@deepseek-ai')
rmSync(runtime, { recursive: true, force: true })
mkdirSync(scoped, { recursive: true })
for (const name of readdirSync(OLD)) {
  if (name.startsWith('dsh-')) cpSync(path.join(OLD, name), path.join(scoped, name), { recursive: true })
}
const brandDir = path.join(scoped, 'dsh-brand'); mkdirSync(brandDir, { recursive: true })
writeFileSync(path.join(brandDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-brand', type: 'module', exports: './index.js' }))
writeFileSync(path.join(brandDir, 'index.js'), `export const brandNumber = (x) => x; export const brandString = (x) => x`)
// Session imports only message helpers; avoid the unrelated RPC service surface.
const llmDir = path.join(scoped, 'dsh-llm'); mkdirSync(path.join(llmDir, 'lib'), { recursive: true })
writeFileSync(path.join(llmDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-llm', type: 'module', exports: './lib/index.js' }))
writeFileSync(path.join(llmDir, 'lib', 'index.js'), `import { randomUUID } from 'node:crypto'\nexport function freezeMessage(m) { return m }\nexport function createUserMessage(m) { return { ...m, id: randomUUID(), role: 'user' } }\nexport function createSystemMessage(text) { return { id: randomUUID(), role: 'system', source: { kind: 'system-prompt' }, content: [{ type: 'text', text }] } }\nexport function assembleAssistantStream() { return null }\nexport function lastAssistantStreamChunk() { return null }\nexport function callConfigEquals(a,b) { return JSON.stringify(a) === JSON.stringify(b) }`)
for (const name of readdirSync(OLD)) {
  if (name === 'dsh-util-values' || name === 'dsh-util-crypto' || name === 'dsh-session' || name === 'dsh-token-meter' || name === 'dsh-llm') continue
  const dest = path.join(scoped, name)
  try { symlinkSync(path.join(OLD, name), dest, 'junction') } catch (err) { if (err.code !== 'EEXIST') throw err }
}
const utilDir = path.join(scoped, 'dsh-util-values'); mkdirSync(utilDir, { recursive: true })
writeFileSync(path.join(utilDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-util-values', type: 'module', exports: './index.js' }))
const cryptoDir = path.join(scoped, 'dsh-util-crypto'); mkdirSync(cryptoDir, { recursive: true })
writeFileSync(path.join(cryptoDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-util-crypto', type: 'module', exports: './index.js' }))
writeFileSync(path.join(cryptoDir, 'index.js'), `export { randomUUID } from 'node:crypto'`)
writeFileSync(path.join(utilDir, 'index.js'), `export function assertNever(x) { throw new Error('unexpected '+x) }\nexport function snapshotJsonValue(x) { return x === undefined ? undefined : structuredClone(x) }\nexport function deepEqualJson(a,b) { return JSON.stringify(a) === JSON.stringify(b) }\nexport function deepFreeze(x, seen = new WeakSet()) { if (!x || typeof x !== 'object' || seen.has(x)) return x; seen.add(x); Object.freeze(x); for (const v of Object.values(x)) deepFreeze(v, seen); return x }`)
symlinkSync(path.join(OLD_ROOT, 'zod'), path.join(runtime, 'node_modules', 'zod'), 'junction')
symlinkSync(OLD, path.join(runtime, 'node_modules', '.old-deepseek'), 'junction')
const NEW = scoped
const { Context } = await import(pathToFileURL(path.join(OLD, 'cordis', 'lib', 'index.js')).href)
const { default: SessionStore } = await import(pathToFileURL(path.join(NEW, 'dsh-session', 'lib', 'index.js')).href)
const { estimateMessage } = await import(pathToFileURL(path.join(NEW, 'dsh-token-meter', 'lib', 'types', 'estimate.js')).href)
class TokenMeter {
  estimateMessage(message) { return estimateMessage(message) }
  measure(session) {
    const nodes = session.surface.nodes.map((seq) => {
      const ev = session.eventAt(seq)
      const tokens = estimateMessage(session.deriveEventMessage(ev))
      return { seq, tokens, heuristicTokens: tokens }
    })
    const surfaceTokens = nodes.reduce((sum, node) => sum + node.tokens, 0)
    return { nodes, surfaceTokens, totalTokens: surfaceTokens }
  }
}
const url = (p) => pathToFileURL(p).href
test.after(() => { rmSync(runtime, { recursive: true, force: true }) })

async function harness() {
  const ctx = new Context()
  const sessions = new SessionStore(ctx)
  const meter = new TokenMeter(ctx)
  ctx.sessions = sessions; ctx.tokenMeter = meter
  return { ctx, sessions, meter }
}
function turn(session, n, text) {
  session.append('turn/start', { turn: n })
  session.append('step/start', { turn: n, step: 1 })
  if (n === 1) {
    session.append('request/header', { header: { config: { provider: 'deepseek', model: 'deepseek-chat' } }, reason: 'initial' })
    session.append('request/context', { provider: 'deepseek', model: 'deepseek-chat', contextWindow: 100000 })
  }
  session.append('user/message', { id: `u-${n}`, role: 'user', source: { kind: 'human' }, content: [{ type: 'text', text }] }, { surfaceOp: 'append' })
  session.append('assistant/message', { turn: n, step: 1, message: { id: `a-${n}`, role: 'assistant', source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' }, content: [{ type: 'tool-call', id: `v4-${n}`, name: 'read', arguments: '{}' }] } }, { surfaceOp: 'append' })
  const call = session.append('tool/call', { turn: n, step: 1, callId: `v4-${n}`, name: 'read', arguments: '{}' })
  session.append('tool/result', { turn: n, step: 1, message: { id: `r-${n}`, role: 'tool', toolCallId: `v4-${n}`, source: { kind: 'tool', callId: `v4-${n}` }, content: [{ type: 'text', text }] } }, { surfaceOp: 'append', sourceEventSeqs: [call.seq] })
  session.append('step/end', { turn: n, step: 1 })
  session.append('turn/end', { turn: n, reason: { kind: 'completed' } })
}

test('real DSH v4 non-contiguous B-topology, auto island closure, legal sources and token claims', async () => {
  const { sessions, meter } = await harness()
  const s = sessions.create('real-v4', { meta: { cwd: 'C:/work/workspace' } })
  s.append('system/message', { message: { id: 'sys', role: 'system', source: { kind: 'system-prompt' }, content: [{ type: 'text', text: 'system prompt' }] } }, { surfaceOp: 'append' })
  for (let n = 1; n <= 8; n++) turn(s, n, `TURN_${n} ${'payload '.repeat(500)}`)
  assert.equal(isV4Session(s), true)
  const plan = planSpanCompaction(s, meter, { turns: [1, 3, 4], summary: 'v4 selected 1,3-4.' }, 1)
  const committed = commitSpanCompaction(s, meter, plan)
  assert.equal(s.eventAt(committed.replaceEventSeq).data.source.kind, 'compact-checkpoint')
  const tomb = s.snapshotEvents().find((ev) => ev.data?.source?.kind === 'context-compact-elide')
  assert.ok(tomb)
  assert.ok(tomb.data.content.length > 0)
  assert.equal(typeof tomb.surfaceOp.startSeq, 'number')
  assert.equal(typeof tomb.surfaceOp.endSeq, 'number')
  const cpIndex = s.surface.nodes.indexOf(committed.replaceEventSeq)
  assert.ok(s.surface.nodes.slice(cpIndex + 1).some((seq) => s.eventAt(seq)?.data?.turn === 2), 'island T2 follows summary')
  for (const ev of s.snapshotEvents()) if (ev.type === 'compaction/summary' || ev.type === 'compaction/prune') {
    const replacement = s.eventAt(ev.seq + 1)
    assert.deepEqual({ start: replacement.surfaceOp.startSeq, end: replacement.surfaceOp.endSeq }, ev.data.shadowedRange)
  }
  assert.equal(executeRecall(s, { target: committed.recallTag.replace('[recall: ', '').replace(']', ''), query: 'TURN_2', context_lines: 0 }).returnedLines, 0)
  const classesBeforeAuto = s.surface.nodes.map((seq) => [seq, classifySurfaceNode(s, seq, inspectSessionLog(s)).kind])
  const prefixBeforeAuto = structuredClone(s.eventAt(committed.replaceEventSeq))
  const next = planSpanCompaction(s, meter, { from: 'auto', to: 'turn:7', summary: 'v4 auto closes island and appends summary.' }, 1)
  const second = commitSpanCompaction(s, meter, next)
  const text = s.eventAt(second.replaceEventSeq).data.content.map((b) => b.text ?? '').join('\n')
  assert.ok(text.includes('[Compact turns:2,5..7]'), text)
  assert.equal(s.snapshotEvents().some((ev) => s.surface.nodes.includes(ev.seq) && ev.data?.source?.kind === 'context-compact-elide'), false, JSON.stringify({ surface: s.surface.nodes, remaining: s.surface.nodes.filter((seq) => s.eventAt(seq)?.data?.source?.kind === 'context-compact-elide'), classesBeforeAuto, frontier: summaryFrontierIndex(s), planned: next.clusters, shadowed: next.shadowedSeqs }))
  assert.deepEqual(s.eventAt(committed.replaceEventSeq), prefixBeforeAuto, 'prefix checkpoint bytes stay immutable')
  assert.equal(s.eventAt(s.surface.nodes[0]).type, 'system/message')
  assert.ok(s.deriveMessages().every((m) => Array.isArray(m.content) && m.content.length > 0))
  assert.equal(s.snapshotEvents().filter((ev) => s.surface.nodes.includes(ev.seq) && ev.data?.source?.kind === 'compact-checkpoint').length, 2)
})
