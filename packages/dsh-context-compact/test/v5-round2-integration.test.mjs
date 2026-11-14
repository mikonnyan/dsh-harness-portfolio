import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  apply, planSpanCompaction, commitSpanCompaction, executeRecall, summaryFrontierIndex,
  extractSummaryText, publishPrefixClass,
} from '../lib/index.js'
import { extractRecallTags } from '../lib/coalesce.js'
import { DEFAULT_CONFIG, filterTools, ensurePrefixEpoch } from '../../dsh-tool-gate/lib/index.js'

const DSH_ROOT = path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai')
const { Context } = await import(pathToFileURL(path.join(DSH_ROOT, 'cordis', 'lib', 'index.js')).href)
const { default: SessionStore } = await import(pathToFileURL(path.join(DSH_ROOT, 'dsh-session', 'lib', 'index.js')).href)
const { TokenMeter } = await import(pathToFileURL(path.join(DSH_ROOT, 'dsh-token-meter', 'lib', 'index.js')).href)

async function harness() {
  const ctx = new Context()
  ctx.provide('tools', { register() { return () => {} } })
  ctx.provide('systemPrompt', { section() { return () => {} }, context() { return () => {} } })
  ctx.sessions = new SessionStore(ctx)
  ctx.tokenMeter = new TokenMeter(ctx)
  apply(ctx, { takeoverNativeCompaction: false, autoCoalesce: true, autoEngine: false, recallBudget: false, autoCompact: false })
  const session = ctx.sessions.create('round2-live-store', { meta: { cwd: 'C:/Users/mikon/Desktop/asd' } })
  return { ctx, session }
}

function turn(session, n) {
  session.append('turn/start', { turn: n })
  session.append('user/message', { id: `u${n}`, role: 'user', source: { kind: 'human' }, content: [{ type: 'text', text: `ORIGINAL_${n} ${'original-payload '.repeat(600)}` }] }, { surfaceOp: 'append' })
  session.append('turn/end', { turn: n, reason: { kind: 'completed' } })
}
function summaries(session) {
  return session.surface.nodes.map((seq) => session.events[seq]).filter((ev) => ev?.data?.source?.kind === 'plugin' && ev?.data?.source?.plugin === 'compact')
}

test('real SessionStore + PMW: before-request autoCoalesce caps the header and original spans still recall', async (t) => {
  const { ctx, session } = await harness()
  t.after(() => {})
  for (let n = 1; n <= 26; n++) {
    turn(session, n)
    commitSpanCompaction(session, ctx.tokenMeter, planSpanCompaction(session, ctx.tokenMeter, { from: `turn:${n}`, to: `turn:${n}`, summary: `decision-${n} ${'record '.repeat(240)}` }, 1))
  }
  turn(session, 27)
  const before = summaries(session)
  assert.equal(before.length, 26)
  const tags = before.flatMap((ev) => extractRecallTags(extractSummaryText(ev)))
  const tokens = before.reduce((n, ev) => n + Math.ceil(extractSummaryText(ev).length / 4), 0)
  assert.ok(tokens >= 12000 && tokens <= 14000, `before=${tokens}`)
  publishPrefixClass(session, session.seq, 'rewrite')
  await ctx.serial('agent/before-request', { agent: { session } }, () => {})
  const after = summaries(session)
  const afterTokens = after.reduce((n, ev) => n + Math.ceil(extractSummaryText(ev).length / 4), 0)
  assert.ok(after.length <= 6, `PMW before-request left ${after.length} summary blocks`)
  assert.ok(after.length < before.length)
  assert.ok(afterTokens <= 5000, `PMW before-request left ${afterTokens} tok`)
  for (const tag of tags) {
    const result = executeRecall(session, { target: tag.match(/@span:[^\]]+/)[0], query: 'ORIGINAL_', context_lines: 0 })
    assert.ok(result.returnedLines > 0, tag)
  }
  assert.equal(summaryFrontierIndex(session), after.length)
  assert.ok(ctx.tokenMeter.measure(session).totalTokens < tokens, 'coalesce must shrink the header')
})

test('same-process PMW: compaction publishes rewrite and tool-gate relocks idle dev only there', async (t) => {
  const { ctx, session } = await harness()
  t.after(() => {})
  session.append('turn/start', { turn: 1 })
  session.append('request/header', { turn: 1, time: 100 })
  session.append('tool/call', { turn: 1, name: 'tool_unlock', arguments: JSON.stringify({ groups: ['dev'], action: 'on' }) }, { ts: 110 })
  session.append('turn/start', { turn: 20 })
  session.append('request/header', { turn: 20, time: 200 })
  const tools = [{ name: 'read' }, { name: 'dev_reload_package' }]
  assert.equal(filterTools(tools, session, DEFAULT_CONFIG, {}, 300).length, 2)
  assert.equal(filterTools(tools, session, DEFAULT_CONFIG, {}, 300).length, 2)
  session.append('compaction/summary', { summary: [{ type: 'text', text: 'rewrite PMW' }] })
  publishPrefixClass(session, session.events.at(-1).seq, 'rewrite')
  const rec = ensurePrefixEpoch(session)
  assert.equal(rec.pmw.open, true)
  const gated = filterTools(tools, session, DEFAULT_CONFIG, {}, 300)
  assert.deepEqual(gated.map((x) => x.name), ['read'])
  assert.equal(rec.requestClock.now, 300)
})

test('same-process PMW cold boundary and 200 rapid identical requests keep stable tool prefix', async (t) => {
  const { ctx, session } = await harness()
  t.after(() => {})
  session.append('turn/start', { turn: 1, time: 1 })
  session.append('request/header', { turn: 1, time: 100 })
  session.append('tool/call', { turn: 1, name: 'tool_unlock', arguments: JSON.stringify({ groups: ['dev'], action: 'on' }), time: 110 })
  session.append('turn/start', { turn: 20, time: 200 })
  const tools = [{ name: 'read' }, { name: 'dev_reload_package' }]
  const before = JSON.stringify(filterTools(tools, session, DEFAULT_CONFIG, {}, 300))
  const hot = await Promise.all(Array.from({ length: 200 }, () => Promise.resolve(JSON.stringify(filterTools(tools, session, DEFAULT_CONFIG, {}, 300)))))
  assert.ok(hot.every((x) => x === before))
  const cold = filterTools(tools, session, DEFAULT_CONFIG, {}, 300200)
  assert.deepEqual(cold.map((x) => x.name), ['read'])
})
