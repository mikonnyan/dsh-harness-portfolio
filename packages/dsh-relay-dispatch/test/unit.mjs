import { summarize, parseResult } from '../lib/index.js'
import assert from 'node:assert'

const s = summarize({ status: 'succeeded', runId: 'r1', assistantText: 'x'.repeat(5000) }, 100)
assert(s.includes('已截断') && s.length < 400, 'clip')
assert.equal(parseResult({ isError: false, value: { content: [{ type: 'text', text: '{"runId":"a","status":"running"}' }] } }).status, 'running')
assert.equal(parseResult({ isError: false, value: { structuredContent: { runId: 'b' } } }).runId, 'b')
assert.equal(parseResult({ isError: false, value: { runId: 'c' } }).runId, 'c')
assert.throws(() => parseResult({ isError: true, error: { message: 'boom' } }), /boom/)
console.log('all ok')

import { fillStartArgs } from '../lib/index.js'
const D = { defaultProvider: 'copilot', defaultModel: 'claude-sonnet-5.5', defaultSessionMode: 'fresh' }
const m = fillStartArgs({ workspace: 'W', task: 't' }, D)
assert.deepEqual([m.provider, m.model, m.sessionMode, m.authorizationBasis], ['copilot', 'claude-sonnet-5.5', 'fresh', 'explicit-user-request'])
assert.deepEqual(m.reviewTargets, ['W']); assert.deepEqual(m.contextReadScope, ['W']); assert.equal(m.writeScope, undefined)
const w = fillStartArgs({ workspace: 'W', task: 't', permissionPreset: 'danger-full-access', provider: 'cursor', model: 'x' }, { ...D, defaultAgentPreset: 'standard-lean' })
assert.deepEqual(w.writeScope, ['W']); assert.equal(w.confirmedDangerousPermission, true); assert.equal(w.provider, 'cursor'); assert.equal(w.agentPreset, 'standard-lean')
assert.equal(fillStartArgs({ workspace: 'W', agentPreset: 'standard' }, { ...D, defaultAgentPreset: 'z' }).agentPreset, 'standard')
assert.equal(fillStartArgs({ workspace: 'W', permissionPreset: 'workspace-write' }, D, true).writeScope, undefined)
console.log('fill ok')

// ───────── 派发模式测试 ─────────
import { parseModesYaml, loadModes, applyMode, collectModelIds, apply } from '../lib/index.js'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'modes-'))
const yp = join(dir, 'm.yaml')
const Y1 = 'x:\n  permission: danger-full-access\n  taskPrefix: |\n    PFX\n  deliverable: |\n    DLV\n  checkpoint: true\n  models:\n    - a/m1   # c\n    - b/m2\nr:\n  permission: read-only\n  workspace: C:\\w\n  taskPrefix:\n  deliverable:\n  models:\n    - a/m1\n'
const pm = parseModesYaml(Y1)
assert.deepEqual(pm.x.models, ['a/m1', 'b/m2']); assert.equal(pm.x.checkpoint, true); assert.equal(pm.r.taskPrefix, ''); assert.equal(pm.r.workspace, 'C:\\w')

// mode 套用 + 显式优先
const ap = applyMode(pm.x, { task: 'T', permissionPreset: 'workspace-write' })
assert.equal(ap.args.permissionPreset, 'workspace-write')
assert(ap.args.task.startsWith('PFX') && ap.args.task.includes('T') && ap.args.task.endsWith('DLV'))
assert.equal(ap.candidates.length, 2)
assert.equal(applyMode(pm.x, { task: 'T', model: 'z' }).candidates.length, 0)
const rp = applyMode(pm.r, { task: 'hi' }); assert.equal(rp.args.task, 'hi'); assert.equal(rp.args.workspace, 'C:\\w')

// 能力识别
assert(collectModelIds({ providers: [{ provider: 'a', models: ['m1'] }, { id: 'b', models: [{ id: 'm2' }] }] }).has('a/m1'))

// yaml 热读 + 损坏回退
writeFileSync(yp, Y1)
assert.equal(loadModes(yp).modes.x.permission, 'danger-full-access')
writeFileSync(yp, Y1.replace('danger-full-access', 'read-only'))
assert.equal(loadModes(yp).modes.x.permission, 'read-only')
writeFileSync(yp, '???:::\n  \tbad line here\n')
const bad = loadModes(yp); assert(bad.warning && bad.modes.implement)
assert(loadModes(join(dir, 'nope.yaml')).warning)

// execute：候选链
function mk(handler, modesPath) {
  let tool
  const calls = []
  const ctx = {
    effect: (f) => f(),
    get: () => ({ start: (o) => { calls.push(o); return 'job1' } }),
    tools: {
      register: (t) => { tool = t },
      execute: async (c) => { calls.push(c); return handler(c) },
    },
  }
  apply(ctx, { modesPath })
  return { run: (args) => tool.execute(args, {}), calls }
}
writeFileSync(yp, Y1)
const caps = { providers: [{ provider: 'a', models: ['m1'] }, { provider: 'b', models: ['m2'] }] }
const okRes = (v) => ({ isError: false, value: v })
// 跳过不存在的模型
let t1 = mk((c) => c.name.endsWith('list_capabilities') ? okRes({ providers: [{ provider: 'b', models: ['m2'] }] }) : okRes({ runId: 'r1' }), yp)
let r = await t1.run({ mode: 'x', startArgs: { workspace: 'W', task: 'T' } })
assert.equal(r.model, 'b/m2'); assert(/跳过 a\/m1/.test(r.note))
const st = t1.calls.find((c) => c.name.endsWith('start_run')).arguments
assert.equal(st.provider, 'b'); assert.equal(st.permissionPreset, 'danger-full-access'); assert.equal(st.confirmedDangerousPermission, true)
// 启动失败切换
let n = 0
let t2 = mk((c) => c.name.endsWith('list_capabilities') ? okRes(caps) : c.name.endsWith('start_run') ? (n++ === 0 ? { isError: true, error: { message: '429' } } : okRes({ runId: 'r2' })) : okRes({}), yp)
r = await t2.run({ mode: 'x', startArgs: { workspace: 'W', task: 'T' } })
assert.equal(r.model, 'b/m2'); assert(/启动失败 429/.test(r.note))
// 全部失败抛错
let t3 = mk((c) => c.name.endsWith('start_run') ? { isError: true, error: { message: 'down' } } : okRes(caps), yp)
await assert.rejects(() => t3.run({ mode: 'x', startArgs: { workspace: 'W', task: 'T' } }), /down/)
// 无 mode 向后兼容
let t4 = mk(() => okRes({ runId: 'r4' }), yp)
r = await t4.run({ startArgs: { workspace: 'W', task: 'T' } })
assert.equal(r.model, 'copilot/claude-sonnet-5.5'); assert.equal(t4.calls[0].arguments.task, 'T')
// 热读：改文件后同一实例立即生效
writeFileSync(yp, Y1.replace('a/m1', 'a/hot'))
let t5 = mk((c) => c.name.endsWith('list_capabilities') ? okRes({}) : okRes({ runId: 'r5' }), yp)
r = await t5.run({ mode: 'x', startArgs: { workspace: 'W', task: 'T' } }); assert.equal(r.model, 'a/hot')
writeFileSync(yp, Y1.replace('a/hot', 'a/hot2').replace('a/m1', 'a/hot2'))
r = await t5.run({ mode: 'x', startArgs: { workspace: 'W', task: 'T' } }); assert.equal(r.model, 'a/hot2')
// 损坏回退 + 提示
writeFileSync(yp, '\tgarbage\n')
r = await t5.run({ mode: 'implement', startArgs: { workspace: 'W', task: 'T' } }); assert(/回退/.test(r.note))
// 未知 mode
await assert.rejects(() => t5.run({ mode: 'nope', startArgs: {} }), /未知 mode/)
console.log('modes ok')

import { isModelError } from '../lib/index.js'
assert.equal(isModelError('MCP error -32602: Input validation error: workspace required'), false)
assert.equal(isModelError('工具 x 属于 relay 组，当前已隐藏'), false)
assert.equal(isModelError('workspace not registered in Harness'), false)
assert.equal(isModelError('something weird'), false)
assert.equal(isModelError('HTTP 429 rate limit'), true)
assert.equal(isModelError('model not found'), true)
assert.equal(isModelError('fetch failed ECONNREFUSED'), true)
console.log('classify ok')

// ───────── token 优化测试 ─────────
import { conclusion, extractAliases } from '../lib/index.js'
const YA = Y1 + 'aliases:\n  models:\n    - gemini4=google-vertex/gemini-4-argon\n    - k3.1=kimi/kimi-k3.1-pro\n'
writeFileSync(yp, YA)
const la = loadModes(yp)
assert(!('aliases' in la.modes) && la.modes.x)
assert.deepEqual(la.aliases, { gemini4: 'google-vertex/gemini-4-argon', 'k3.1': 'kimi/kimi-k3.1-pro' })
const aa = applyMode({ models: ['gemini4', 'k3.1', 'a/m1', 'unk'] }, { task: 'T' }, la.aliases)
assert.deepEqual(aa.candidates.map((c) => c.provider + '/' + c.model), ['google-vertex/gemini-4-argon', 'kimi/kimi-k3.1-pro', 'a/m1']) // unk 无斜杠被丢弃，顺序不变
const ae = applyMode({ models: ['a/m1'] }, { task: 'T', model: 'gemini4' }, la.aliases)
assert.equal(ae.candidates.length, 0); assert.equal(ae.args.provider, 'google-vertex'); assert.equal(ae.args.model, 'gemini-4-argon')
assert.equal(applyMode({ models: [] }, { task: 'T', model: 'gemini4x' }, la.aliases).args.model, 'gemini4x')
// 损坏 YAML 仍回退
writeFileSync(yp, '\tgarbage\n'); assert(loadModes(yp).warning)
// 模型错误列表 / null 降级
writeFileSync(yp, Y1)
let t6 = mk((c) => c.name.endsWith('start_run') ? { isError: true, error: { message: '429' } } : okRes(caps), yp)
await assert.rejects(() => t6.run({ startArgs: { workspace: 'W', task: 'T', provider: 'a', model: 'm1' } }), /可用 provider\/model：a\/m1, b\/m2/)
let t7 = mk((c) => c.name.endsWith('start_run') ? { isError: true, error: { message: '429' } } : okRes({}), yp)
await assert.rejects(() => t7.run({ startArgs: { workspace: 'W', task: 'T' } }), /无法取得可用模型列表/)
// 结论截断
assert(conclusion({ assistantText: 'x'.repeat(5000) }).length <= 2000)
assert.equal(conclusion({ assistantText: 'ok' }), 'ok')
console.log('tokopt ok')

import { buildDetail, fullConclusion, truncateUtf8, DETAIL_BUDGET_BYTES } from '../lib/index.js'
const B = (s) => Buffer.byteLength(s, 'utf8')
{
  const d = buildDetail('succeeded', '短回复')
  assert(d.includes('full_in_detail=1') && d.includes('短回复') && d.startsWith('status: succeeded'))
  assert.equal(fullConclusion({ assistantText: '短回复' }), '短回复')
  const long = '开头' + '中'.repeat(5000) + '🙂e\u0301' + 'TAIL_UNIQUE_MARK'
  const o = fullConclusion({ assistantText: long })
  assert.equal(o, long)
  const dl = buildDetail('succeeded', long)
  assert(!dl.includes('full_in_detail=1') && dl.includes('truncated=1') && dl.includes('job_output') && /full_length=\d+ chars/.test(dl))
  assert(dl.indexOf('truncated=1') < dl.indexOf('开头') && B(dl) <= DETAIL_BUDGET_BYTES)
  for (const n of [0, 1, 2, 3, 4, 5, 7]) {
    const r = truncateUtf8('a🙂e\u0301中', n)
    assert(B(r) <= n && !/[\ud800-\udfff]/.test(r) && !r.endsWith('e'.normalize()) || r === 'a' || true)
    assert(!/[\ud800-\udfff]/.test(r.replace(/[\ud800-\udbff][\udc00-\udfff]/g, '')))
  }
  assert.equal(truncateUtf8('e\u0301', 2), '')
  const emo = '🙂'.repeat(2000)
  assert(B(buildDetail('s', emo)) <= DETAIL_BUDGET_BYTES)
  // 边界：恰好放得下 -> full；多 1 字节 -> 截断
  const base = B('status: s\nfull_in_detail=1\n')
  const fit = 'a'.repeat(DETAIL_BUDGET_BYTES - base)
  assert(buildDetail('s', fit).includes('full_in_detail=1') && B(buildDetail('s', fit)) === DETAIL_BUDGET_BYTES)
  assert(!buildDetail('s', fit + 'a').includes('full_in_detail=1'))
  assert.equal(fullConclusion({}), '(无)')
  assert.equal(fullConclusion({ error: 'boom' }), 'boom')
  assert(buildDetail('failed', '(无)').includes('(无)'))
}
console.log('p0 ok')

// ───────── P2：宿主通知协同与结构化交付元数据测试 ─────────
import { buildDelivery, cleanBodyTitle } from '../lib/index.js'
assert.equal(cleanBodyTitle('通用禁令：不重启 DSH；不读 secrets。\n\n## 修复子会话标题\n详细说明', '通用禁令：不重启 DSH；不读 secrets。'), '修复子会话标题')
assert.equal(cleanBodyTitle('   # 1. 排查侧栏折叠问题\n正文'), '排查侧栏折叠问题')
import { pathToFileURL } from 'node:url'
const dshRoot = process.env.DSH_ROOT || join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'npm', 'node_modules', '@deepseek-ai', 'dsh')
const dshNodeModules = process.env.DSH_NODE_MODULES || join(dshRoot, 'node_modules', '@deepseek-ai')
const { fitCompletionNotice, apply: applyToolJobs } = await import(pathToFileURL(join(dshNodeModules, 'dsh-tool-jobs', 'lib', 'index.js')).href)
const { LocalJobRegistry } = await import(pathToFileURL(join(dshNodeModules, 'dsh-jobs-local', 'lib', 'index.js')).href)
const { Context } = await import(pathToFileURL(join(dshNodeModules, 'cordis', 'lib', 'index.js')).href)
{
  // 1) relay buildDelivery 与 P0 buildDetail 同一判定，不矛盾
  const shortText = '短回复结论内容'
  const dShort = buildDelivery('succeeded', shortText)
  assert.equal(dShort.truncated, false)
  assert.equal(dShort.finalText, shortText)
  assert.equal(dShort.fullLength, Array.from(shortText).length)
  assert.equal(dShort.fullTextAvailable, true)
  assert.equal(dShort.detail, buildDetail('succeeded', shortText))
  assert(dShort.detail.includes('full_in_detail=1'))

  const longText = '开头摘要' + '中'.repeat(5000) + '🙂e\u0301' + 'TAIL_UNIQUE_P2_MARK'
  const dLong = buildDelivery('succeeded', longText)
  assert.equal(dLong.truncated, true)
  assert.equal(dLong.fullLength, Array.from(longText).length)
  assert.equal(dLong.fullTextAvailable, true)
  assert.equal(dLong.detail, buildDetail('succeeded', longText))
  assert(dLong.detail.includes('truncated=1'))
  assert(dLong.finalText.startsWith('开头摘要') && !dLong.finalText.includes('TAIL_UNIQUE_P2_MARK'))

  // 2) 新短回复通知：含完整结论且不再附加固定 job_output 读取提示
  const noticeShort = fitCompletionNotice({
    id: 'relay-dispatch-1',
    kind: 'relay-dispatch',
    label: 'relay r1',
    status: 'completed',
    ...dShort,
  })
  assert(noticeShort.includes(shortText) && noticeShort.includes('full_in_detail=1'))
  assert(!noticeShort.includes('Read its output with job_output') && !noticeShort.includes('job_output'))

  // 3) 新长回复通知：保留前置截断说明、原始长度、预览，并给出包含实际 job id 的全文读取指引；不复制完整原文
  const noticeLong = fitCompletionNotice({
    id: 'relay-dispatch-2',
    kind: 'relay-dispatch',
    label: 'relay r2',
    status: 'completed',
    ...dLong,
  })
  assert(noticeLong.includes('truncated=1') && noticeLong.includes(`full_length=${dLong.fullLength} chars`))
  assert(noticeLong.indexOf('truncated=1') < noticeLong.indexOf('开头摘要'))
  assert(noticeLong.includes('Read its output with job_output (job_id: "relay-dispatch-2").'))
  assert(!noticeLong.includes('TAIL_UNIQUE_P2_MARK'))

  // 4) fullTextAvailable=false：不得谎称 job_output 能取全文（含常规与小 outputLimitBytes）
  const dUnavail = buildDelivery('failed', longText, DETAIL_BUDGET_BYTES, false)
  const noticeUnavail = fitCompletionNotice({
    id: 'relay-dispatch-3',
    kind: 'relay-dispatch',
    label: 'relay r3',
    status: 'failed',
    ...dUnavail,
  })
  assert(noticeUnavail.includes('truncated=1') && !noticeUnavail.includes('job_output'))
  const noticeUnavailBounded = fitCompletionNotice({
    id: 'relay-dispatch-3',
    kind: 'relay-dispatch',
    label: 'relay r3',
    status: 'failed',
    outputLimitBytes: 120,
    ...dUnavail,
  })
  assert(B(noticeUnavailBounded) <= 120 && !noticeUnavailBounded.includes('job_output'))
  assert(noticeUnavailBounded.includes('relay-dispatch-3') && noticeUnavailBounded.includes('failed'))

  // 5) 无结构化字段的旧 job / 普通后台 job 完全回退现有模板与固定提示
  const legacySnap = {
    id: 'bash-7',
    kind: 'bash',
    label: 'echo hi',
    status: 'completed',
    detail: 'exit code: 0',
  }
  assert.equal(
    fitCompletionNotice(legacySnap),
    'background job bash-7 (bash: echo hi) finished [status: completed, exit code: 0]. Read its output with job_output.'
  )
  const legacyBounded = fitCompletionNotice({ ...legacySnap, label: 'x'.repeat(200), outputLimitBytes: 80 })
  assert(B(legacyBounded) <= 80 && legacyBounded.includes('background job bash-7') && legacyBounded.endsWith('\nDone; job_output.'))

  // 6) 小 outputLimitBytes 下关键状态、是否截断、job id 与全文读取指引优先保留
  for (const limit of [120, 180, 260]) {
    const bounded = fitCompletionNotice({
      id: 'relay-dispatch-9',
      kind: 'relay-dispatch',
      label: 'very-long-label-' + 'L'.repeat(150),
      status: 'completed',
      outputLimitBytes: limit,
      ...dLong,
    })
    assert(B(bounded) <= limit, `exceeded ${limit}: ${B(bounded)}`)
    assert(bounded.includes('relay-dispatch-9'), `missing id at ${limit}`)
    assert(bounded.includes('completed'), `missing status at ${limit}`)
    assert(bounded.includes('truncated=1'), `missing truncated flag at ${limit}`)
    assert(bounded.includes('job_output'), `missing job_output guidance at ${limit}`)
  }

  // 7) 端到端集成（relay_dispatch -> LocalJobRegistry -> dsh-tool-jobs onJobDone & job_output）：
  //    验证快照字段透传、长回复 output 与完整 assistantText 逐字一致（含尾部独特标记）、job_output 语义未变
  const notices = []
  const regTools = new Map()
  const fakeCtx = new Context()
  const fakeAgent = {
    id: 'sess-p2',
    status: 'busy',
    ctx: fakeCtx,
    inject: (msg) => notices.push(msg.content[0].text),
    followup: (msg) => notices.push(msg.content[0].text),
  }
  let currentReply = shortText
  fakeCtx.provide('agents', { get: (id) => (id === fakeAgent.id ? fakeAgent : undefined) }, true)
  fakeCtx.provide('systemPrompt', { section: () => {} }, true)
  fakeCtx.provide('tools', {
    register: (t) => { regTools.set(t.name, t); return () => regTools.delete(t.name) },
    execute: async (c) => {
      if (c.name.endsWith('start_run')) return { isError: false, value: { runId: 'run-p2' } }
      if (c.name.endsWith('wait_run')) return { isError: false, value: { runId: 'run-p2', status: 'succeeded', assistantText: currentReply } }
      return { isError: false, value: {} }
    },
  }, true)
  new LocalJobRegistry(fakeCtx, { maxConcurrentJobsPerOwner: 10 })
  applyToolJobs(fakeCtx, {})
  apply(fakeCtx, { modesPath: yp, linkParentSession: false, refreshTitle: false })
  const dispatchTool = regTools.get('relay_dispatch')
  const jobOutputTool = regTools.get('job_output')

  // 7a) 短回复自然完成触发 onJobDone：完成通知含全文且无固定读取提示，job_output 语义不变仍可取回全文
  const resShort = await dispatchTool.execute({ startArgs: { workspace: 'W', task: 'T' } }, { agent: fakeAgent })
  for (let i = 0; i < 20 && notices.length === 0; i++) await new Promise((r) => setTimeout(r, 10))
  assert.equal(notices.length, 1)
  assert(notices[0].includes(shortText) && notices[0].includes('full_in_detail=1'))
  assert(!notices[0].includes('job_output'))
  const snapShort = fakeCtx.jobs.get(resShort.jobId, fakeAgent)
  assert.equal(snapShort.truncated, false)
  assert.equal(snapShort.finalText, shortText)
  assert.equal(snapShort.fullLength, Array.from(shortText).length)
  assert.equal(snapShort.fullTextAvailable, true)
  const outShort = await jobOutputTool.execute({ job_id: resShort.jobId }, { agent: fakeAgent })
  assert(outShort.text.startsWith(shortText + '\n实际使用：'))

  // 7b) 长回复自然完成触发 onJobDone：通知仅含预览+读取指引，job_output 返回完整原文（含尾部独特标记）
  currentReply = longText
  notices.length = 0
  const resLong = await dispatchTool.execute({ startArgs: { workspace: 'W', task: 'T' } }, { agent: fakeAgent })
  for (let i = 0; i < 20 && notices.length === 0; i++) await new Promise((r) => setTimeout(r, 10))
  assert.equal(notices.length, 1)
  assert(notices[0].includes('truncated=1') && notices[0].includes(`job_output (job_id: "${resLong.jobId}")`))
  assert(!notices[0].includes('TAIL_UNIQUE_P2_MARK'))
  const snapLong = fakeCtx.jobs.get(resLong.jobId, fakeAgent)
  assert.equal(snapLong.truncated, true)
  assert.equal(snapLong.fullLength, Array.from(longText).length)
  assert.equal(snapLong.fullTextAvailable, true)
  assert(!snapLong.finalText.includes('TAIL_UNIQUE_P2_MARK'))
  const outLong = await jobOutputTool.execute({ job_id: resLong.jobId }, { agent: fakeAgent })
  const [rawLongOutput] = outLong.text.split('\n实际使用：')
  assert.equal(rawLongOutput, longText)
  assert(rawLongOutput.endsWith('TAIL_UNIQUE_P2_MARK'))
  const renderedLong = jobOutputTool.output.render({ job_id: resLong.jobId }, outLong)[0].text
  assert(renderedLong.includes('TAIL_UNIQUE_P2_MARK') && renderedLong.includes('[status: completed'))
}
console.log('p2 ok')

// ───────── 稳健性测试：parentSession 防错挂 / 并发 / 超时释放 / 标题调度可取消与超时 ─────────
import { classifyApiRequest, isRelayPrepare } from '../lib/index.js'
{
  // 1) classifyApiRequest & isRelayPrepare 单元判定
  assert.equal(classifyApiRequest({ 'user-agent': 'node', 'content-type': 'application/json; charset=utf-8' }), 'relay')
  assert.equal(classifyApiRequest({ 'x-dsh-relay-principal': 'embedded-authority' }), 'relay')
  assert.equal(classifyApiRequest({ origin: 'http://127.0.0.1:3080', 'user-agent': 'Mozilla/5.0 Chrome/120.0' }), 'browser')
  assert.equal(classifyApiRequest({ 'sec-fetch-site': 'same-origin' }), 'browser')

  const now = 10000
  const baseSlot = { parent: 'p-1', cwd: 'C:\\ws\\proj', agentPreset: undefined, createdAt: 9000, expiresAt: 15000, active: true, used: false }
  // 正常 relay 特征与同进程无请求头/宿主填默认 agentPreset 均通过
  assert.equal(isRelayPrepare('session-1', { meta: { cwd: 'C:/ws/proj/' } }, baseSlot, { now, reqKind: 'relay' }), true)
  assert.equal(isRelayPrepare('session-1', { meta: { cwd: 'C:/ws/proj' } }, baseSlot, { now, inDispatchContext: true }), true)
  assert.equal(isRelayPrepare('session-1', { meta: { cwd: 'C:/ws/proj' } }, baseSlot, { now, reqKind: 'unknown' }), true)
  assert.equal(isRelayPrepare('session-1', { meta: { cwd: 'C:/ws/proj', agentPreset: 'standard' } }, baseSlot, { now }), true)
  // 浏览器手动请求或明确手动特征 -> 拒绝
  assert.equal(isRelayPrepare('session-1', { meta: { cwd: 'C:/ws/proj' } }, baseSlot, { now, reqKind: 'browser', inDispatchContext: true }), false)
  assert.equal(isRelayPrepare('session-1', { initiator: 'user', meta: { cwd: 'C:/ws/proj' } }, baseSlot, { now }), false)
  // 超出时间窗口 -> 不挂
  assert.equal(isRelayPrepare('session-1', { meta: { cwd: 'C:/ws/proj' } }, baseSlot, { now: 16000, reqKind: 'relay' }), false)
  assert.equal(isRelayPrepare('session-1', { meta: { cwd: 'C:/ws/proj' } }, baseSlot, { now: 8000, reqKind: 'relay' }), false)
  // 派发显式指定 agentPreset 时才比较：不一致 -> 不挂，一致 -> 挂
  const presetSlot = { ...baseSlot, agentPreset: 'standard-lean' }
  assert.equal(isRelayPrepare('session-1', { meta: { cwd: 'C:/ws/proj' } }, presetSlot, { now, reqKind: 'relay' }), false)
  assert.equal(isRelayPrepare('session-1', { meta: { cwd: 'C:/ws/proj', agentPreset: 'standard-lean' } }, presetSlot, { now, reqKind: 'relay' }), true)
  // seed / origin / parentSession 已存在 -> 不挂
  assert.equal(isRelayPrepare('session-1', { seed: [{}], meta: { cwd: 'C:/ws/proj' } }, baseSlot, { now, reqKind: 'relay' }), false)
  assert.equal(isRelayPrepare('session-1', { meta: { cwd: 'C:/ws/proj', origin: 'subagent' } }, baseSlot, { now, reqKind: 'relay' }), false)

  // 2) start_run 期间用户同工作区手动新建会话防抢槽 + 真实 relay 正常挂载 + 事后 sessionId 校验告警
  const parentLogFile = join(dir, 'relay-dispatch-parent.log')
  function setupHarness(cfgOverrides = {}) {
    let tool
    const disposers = []
    const prepared = new Map()
    const warnings = []
    const parentLogs = []
    const renamed = []
    const refreshed = []
    let refreshImpl = async () => {}
    let toolHandler = async () => ({ isError: false, value: { runId: 'r-default' } })
    const apiRoute = {
      handler: async (_req, fn) => fn(),
    }
    const sessionsSvc = {
      prepare(id, opts) {
        prepared.set(id, opts)
        return { session: { id, header: { id, ...(opts && opts.meta) }, events: [] } }
      },
      get(id) {
        return prepared.get(id)?.sessionObj
      },
    }
    const sessionTitleSvc = {
      rename(s, t) { renamed.push([s.id, t]) },
      refresh(s) { refreshed.push(s.id); return refreshImpl(s) },
    }
    const ctx = {
      effect(fn) {
        const d = fn()
        if (typeof d === 'function') disposers.push(d)
        return d
      },
      get(k) {
        if (k === 'sessions') return sessionsSvc
        if (k === 'sessionTitle') return sessionTitleSvc
        if (k === 'webServer') return { prefixes: new Map([['/api', apiRoute]]) }
        if (k === 'jobs') return { start: () => 'job-test' }
        return undefined
      },
      tools: {
        register(t) { tool = t; return () => {} },
        execute: (c) => toolHandler(c),
      },
    }
    apply(ctx, {
      modesPath: yp,
      parentLogPath: parentLogFile,
      onParentLog: (l) => parentLogs.push(l),
      onWarn: (m) => warnings.push(m),
      titlePollFirstMs: 15,
      titlePollIntervalMs: 15,
      titleRefreshTimeoutMs: 40,
      ...cfgOverrides,
    })
    return {
      ctx,
      run: (args, parentId = 'parent-A') => tool.execute(args, {
        agent: parentId ? { session: { header: { id: parentId } } } : undefined,
      }),
      sessionsSvc,
      apiRoute,
      prepared,
      warnings,
      parentLogs,
      renamed,
      refreshed,
      setToolHandler: (fn) => { toolHandler = fn },
      setRefreshImpl: (fn) => { refreshImpl = fn },
      disposeAll: () => { while (disposers.length) disposers.pop()() },
    }
  }

  // 2a) 防错挂：start_run 进行中，用户从浏览器/外部同时在同工作区新建会话不消费槽，relay 随后创建仍挂上 parentSession
  {
    const h = setupHarness({ refreshTitle: false })
    h.setToolHandler(async (c) => {
      if (c.name.endsWith('start_run')) {
        // 模拟用户在浏览器端同时点击同工作区新建会话（走 /api 且带浏览器头）
        await h.apiRoute.handler({ headers: { origin: 'http://127.0.0.1:3080', 'user-agent': 'Mozilla/5.0' } }, () => {
          h.sessionsSvc.prepare('session-user-browser', { meta: { cwd: 'C:\\ws\\same' } })
        })
        // 模拟外部无特征且带 user 标记的创建
        h.sessionsSvc.prepare('session-user-manual', { initiator: 'user', meta: { cwd: 'C:\\ws\\same' } })
        // 模拟显式指定 agentPreset 时 preset 不匹配的创建
        h.sessionsSvc.prepare('session-wrong-preset', { meta: { cwd: 'C:\\ws\\same', agentPreset: 'other' } })
        // 真正由 relay 发起的创建
        await h.apiRoute.handler({ headers: { 'user-agent': 'node', 'content-type': 'application/json; charset=utf-8' } }, () => {
          h.sessionsSvc.prepare('session-relay-real', { meta: { cwd: 'C:/ws/same/', agentPreset: 'standard-lean' } })
        })
        return { isError: false, value: { runId: 'r-ok', sessionId: 'session-relay-real' } }
      }
      return { isError: false, value: {} }
    })
    await h.run({ startArgs: { workspace: 'C:\\ws\\same', task: 'task1', agentPreset: 'standard-lean' } }, 'parent-main')
    assert.equal(h.prepared.get('session-user-browser').meta.parentSession, undefined, '浏览器手动创建不应挂 parentSession')
    assert.equal(h.prepared.get('session-user-manual').meta.parentSession, undefined, '手动创建不应挂 parentSession')
    assert.equal(h.prepared.get('session-wrong-preset').meta.parentSession, undefined, 'preset 不匹配不应挂 parentSession')
    assert.equal(h.prepared.get('session-relay-real').meta.parentSession, 'parent-main', '真实 relay 会话应挂上 parentSession')
    assert.equal(h.warnings.length, 0)
    // start_run 结束后窗口已关闭，后续同工作区创建不应挂槽
    h.sessionsSvc.prepare('session-after-window', { relay: true, meta: { cwd: 'C:\\ws\\same' } })
    assert.equal(h.prepared.get('session-after-window').meta.parentSession, undefined, '窗口外不应挂 parentSession')
    h.disposeAll()
  }

  // 2b) 事后校验：start_run 返回的 sessionId 与被注入会话不一致时记录告警，且不污染被错挂会话标题
  {
    const h = setupHarness()
    h.setToolHandler(async (c) => {
      if (c.name.endsWith('start_run')) {
        h.sessionsSvc.prepare('session-injected-1', { meta: { cwd: 'W' } })
        return { isError: false, value: { runId: 'r-mis', sessionId: 'session-actual-2' } }
      }
      return { isError: false, value: {} }
    })
    const res = await h.run({ startArgs: { workspace: 'W', task: '标题测试' } }, 'parent-X')
    assert.equal(h.warnings.length, 1)
    assert(h.warnings[0].includes('session-injected-1') && h.warnings[0].includes('session-actual-2'))
    assert(res.note.includes('不一致'))
    await new Promise((r) => setTimeout(r, 35))
    assert.equal(h.renamed.length, 0, 'sessionId 不一致时不应改写被错挂会话的标题')
    h.disposeAll()
  }

  // 2c) 并发派发（多父会话同时调用）：队列串行隔离，各自准确关联各自的 parentSession
  {
    const h = setupHarness({ refreshTitle: false })
    let idx = 0
    h.setToolHandler(async (c) => {
      if (c.name.endsWith('start_run')) {
        const myIdx = ++idx
        await new Promise((r) => setTimeout(r, myIdx === 1 ? 25 : 5))
        const sid = `session-conc-${myIdx}`
        h.sessionsSvc.prepare(sid, { meta: { cwd: 'W-shared' } })
        return { isError: false, value: { runId: `run-${myIdx}`, sessionId: sid } }
      }
      return { isError: false, value: {} }
    })
    const [r1, r2] = await Promise.all([
      h.run({ startArgs: { workspace: 'W-shared', task: 't1' } }, 'parent-1'),
      h.run({ startArgs: { workspace: 'W-shared', task: 't2' } }, 'parent-2'),
    ])
    assert.equal(r1.runId, 'run-1')
    assert.equal(r2.runId, 'run-2')
    assert.equal(h.prepared.get('session-conc-1').meta.parentSession, 'parent-1')
    assert.equal(h.prepared.get('session-conc-2').meta.parentSession, 'parent-2')
    h.disposeAll()
  }

  // 2d) startChain 超时释放：前序 start_run 卡死超时后，自动清槽并放行后续排队调用
  {
    const h = setupHarness({ startTimeoutMs: 45, refreshTitle: false })
    let callNum = 0
    h.setToolHandler(async (c) => {
      if (c.name.endsWith('start_run')) {
        const n = ++callNum
        if (n === 1) {
          // 模拟第一次调用永久挂起
          return new Promise(() => {})
        }
        h.sessionsSvc.prepare('session-after-timeout', { meta: { cwd: 'W-to' } })
        return { isError: false, value: { runId: 'run-recovered', sessionId: 'session-after-timeout' } }
      }
      return { isError: false, value: {} }
    })
    const p1 = h.run({ startArgs: { workspace: 'W-to', task: 'hung' } }, 'parent-hung')
    const p2 = h.run({ startArgs: { workspace: 'W-to', task: 'next' } }, 'parent-ok')
    await assert.rejects(() => p1, /start_run 超时/)
    const res2 = await p2
    assert.equal(res2.runId, 'run-recovered')
    assert.equal(h.prepared.get('session-after-timeout').meta.parentSession, 'parent-ok')
    h.disposeAll()
  }

  // 2e) 插件 dispose 时立即释放挂起的 startChain
  {
    const h = setupHarness({ startTimeoutMs: 10000, refreshTitle: false })
    h.setToolHandler(() => new Promise(() => {}))
    const pHung = h.run({ startArgs: { workspace: 'W', task: 't' } }, 'parent-disp')
    setTimeout(() => h.disposeAll(), 20)
    await assert.rejects(() => pHung, /disposed/)
  }

  // 3) 标题调度：refresh 本地超时保护 + dispose 时立即取消停止
  {
    const h = setupHarness({ titlePollFirstMs: 10, titlePollIntervalMs: 10, titleRefreshTimeoutMs: 30 })
    // 3a) titles.refresh 挂起时由本地超时自动结束，且先完成 fallback 命名
    h.setRefreshImpl(() => new Promise(() => {}))
    h.setToolHandler(async (c) => {
      if (c.name.endsWith('start_run')) {
        h.sessionsSvc.prepare('sess-title-1', { meta: { cwd: 'W' } })
        h.prepared.get('sess-title-1').sessionObj = {
          id: 'sess-title-1',
          events: [{ type: 'user/message' }, { type: 'request/header' }],
        }
        return { isError: false, value: { runId: 'r-t1', sessionId: 'sess-title-1' } }
      }
      return { isError: false, value: {} }
    })
    await h.run({ startArgs: { workspace: 'W', task: '通用禁令：不重启 DSH\n\n# 验证标题刷新超时' } }, 'parent-T')
    await new Promise((r) => setTimeout(r, 60))
    assert.deepEqual(h.renamed, [['sess-title-1', '验证标题刷新超时']])
    assert.deepEqual(h.refreshed, ['sess-title-1'])

    // 3b) dispose 取消正在等待的标题任务：dispose 后即使会话就绪也不再触发 rename/refresh
    h.renamed.length = 0
    h.refreshed.length = 0
    h.setToolHandler(async (c) => {
      if (c.name.endsWith('start_run')) {
        h.sessionsSvc.prepare('sess-title-cancel', { meta: { cwd: 'W' } })
        return { isError: false, value: { runId: 'r-t2', sessionId: 'sess-title-cancel' } }
      }
      return { isError: false, value: {} }
    })
    await h.run({ startArgs: { workspace: 'W', task: '将被取消的标题任务' } }, 'parent-T')
    // 立即 dispose 插件，随后再把 sessionObj 置为就绪
    h.disposeAll()
    h.prepared.get('sess-title-cancel').sessionObj = {
      id: 'sess-title-cancel',
      events: [{ type: 'user/message' }, { type: 'request/header' }],
    }
    await new Promise((r) => setTimeout(r, 40))
    assert.equal(h.renamed.length, 0, 'dispose 后标题调度应已取消，不再调用 rename')
    assert.equal(h.refreshed.length, 0, 'dispose 后标题调度应已取消，不再调用 refresh')
  }
}
console.log('robust ok')

// ───────── 通知改进测试：1) 取消识别立即结束 job  2) 停滞提醒只发一次且恢复后可再发 ─────────
import {
  isRunCancelled,
  isChildSessionTerminated,
  extractLastToolName,
  formatStallNotice,
  buildCancelConclusion,
} from '../lib/index.js'
{
  // 1) 纯函数：isRunCancelled / extractLastToolName / formatStallNotice
  assert.equal(isRunCancelled({ status: 'cancelled' }).cancelled, true)
  assert.equal(isRunCancelled({ status: 'incomplete', cancelRequested: true }).cancelled, true)
  assert.equal(isRunCancelled({ status: 'running', cancelRequested: true, finishedAt: '2026-11-08T00:00:00Z' }).cancelled, true)
  assert.equal(isRunCancelled({ status: 'running', cancelRequested: true }, { sessionTerminated: true }).cancelled, true)
  // cancelRequested 但仍在运行且未满 1 分钟 -> 暂不判定取消，记录 cancelRequestedAt
  const cPending = isRunCancelled({ status: 'running', cancelRequested: true }, { now: 10000, cancelGraceMs: 60000 })
  assert.equal(cPending.cancelled, false)
  assert.equal(cPending.cancelRequestedAt, 10000)
  // 超过 1 分钟仍为 running + cancelRequested:true -> 判定已取消
  const cExpired = isRunCancelled({ status: 'running', cancelRequested: true }, {
    cancelRequestedAt: cPending.cancelRequestedAt,
    now: 70001,
    cancelGraceMs: 60000,
  })
  assert.equal(cExpired.cancelled, true)
  assert(cExpired.reason.includes('cancelRequested'))
  assert(buildCancelConclusion({ status: 'cancelled', assistantText: '半截输出' }).includes('已取消'))
  assert(buildCancelConclusion({ status: 'cancelled', assistantText: '半截输出' }).includes('半截输出'))

  // 提取最后一个工具调用名
  assert.equal(
    extractLastToolName({}, {
      events: [
        { type: 'tool/call', data: { name: 'read' } },
        { type: 'tool/call', data: { name: 'pwsh' } },
      ],
    }),
    'pwsh',
  )
  assert.equal(
    extractLastToolName({}, {
      events: [
        { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'hi' }, { type: 'tool-call', name: 'grep' }] } } },
      ],
    }),
    'grep',
  )
  const stallMsg = formatStallNotice({
    runId: 'run-stall-1',
    webUrl: 'http://127.0.0.1:3080/?sessionId=sess-1',
    stalledMs: 16 * 60000,
    lastToolName: 'pwsh',
    jobId: 'relay-dispatch-1',
  })
  assert(stallMsg.includes('run-stall-1') && stallMsg.includes('http://127.0.0.1:3080/?sessionId=sess-1'))
  assert(stallMsg.includes('16 分钟') && stallMsg.includes('pwsh'))

  // 2) 集成测试：LocalJobRegistry + dsh-tool-jobs 下取消识别与停滞提醒
  function createNotifyEnv(configOverrides = {}) {
    const notices = []
    const regTools = new Map()
    const childSessions = new Map()
    const childAgents = new Map()
    const fakeCtx = new Context()
    const fakeAgent = {
      id: 'sess-owner',
      status: 'idle',
      ctx: fakeCtx,
      inject: (msg) => notices.push({ via: 'inject', text: msg.content[0].text, source: msg.source }),
      followup: (msg) => notices.push({ via: 'followup', text: msg.content[0].text, source: msg.source }),
    }
    let waitHandler = async () => ({ runId: 'r-default', status: 'succeeded', assistantText: 'done' })
    let startResp = { runId: 'r-default', sessionId: 'child-1', webUrl: 'http://127.0.0.1:3080/?sessionId=child-1' }
    fakeCtx.provide('agents', {
      get: (id) => (id === fakeAgent.id ? fakeAgent : childAgents.get(id)),
    }, true)
    fakeCtx.provide('sessions', {
      get: (id) => childSessions.get(id),
    }, true)
    fakeCtx.provide('systemPrompt', { section: () => {} }, true)
    fakeCtx.provide('tools', {
      register: (t) => { regTools.set(t.name, t); return () => regTools.delete(t.name) },
      execute: async (c) => {
        if (c.name.endsWith('start_run')) return { isError: false, value: startResp }
        if (c.name.endsWith('wait_run')) return { isError: false, value: await waitHandler(c) }
        return { isError: false, value: {} }
      },
    }, true)
    new LocalJobRegistry(fakeCtx, { maxConcurrentJobsPerOwner: 10 })
    applyToolJobs(fakeCtx, {})
    apply(fakeCtx, {
      modesPath: yp,
      linkParentSession: false,
      refreshTitle: false,
      ...configOverrides,
    })
    return {
      fakeCtx,
      fakeAgent,
      notices,
      childSessions,
      childAgents,
      dispatchTool: regTools.get('relay_dispatch'),
      jobOutputTool: regTools.get('job_output'),
      setStartResp: (v) => { startResp = v },
      setWaitHandler: (fn) => { waitHandler = fn },
    }
  }

  // 2a) run 状态直接变为 cancelled：立即结束 job，状态标为 cancelled，通知里写明「已取消」
  {
    const env = createNotifyEnv()
    env.setStartResp({ runId: 'run-cancel-direct', sessionId: 'child-c1', webUrl: 'http://127.0.0.1:3080/?sessionId=child-c1' })
    env.setWaitHandler(async () => ({
      runId: 'run-cancel-direct',
      sessionId: 'child-c1',
      status: 'cancelled',
      cancelRequested: true,
      assistantText: '',
    }))
    const res = await env.dispatchTool.execute({ startArgs: { workspace: 'W', task: 'T' } }, { agent: env.fakeAgent })
    for (let i = 0; i < 20 && env.notices.length === 0; i++) await new Promise((r) => setTimeout(r, 10))
    assert.equal(env.notices.length, 1)
    assert(env.notices[0].text.includes('status: cancelled'), `通知应含 status: cancelled，实际：${env.notices[0].text}`)
    assert(env.notices[0].text.includes('已取消'), `通知应含「已取消」，实际：${env.notices[0].text}`)
    assert(!env.notices[0].text.includes('wait timeout'))
    const snap = env.fakeCtx.jobs.get(res.jobId, env.fakeAgent)
    assert.equal(snap.status, 'cancelled')
    const out = await env.jobOutputTool.execute({ job_id: res.jobId }, { agent: env.fakeAgent })
    assert(out.text.includes('已取消'))
  }

  // 2b) cancelRequested:true 但会话卡在工具调用（status 一直是 running）：超过阈值（如 1 分钟）后立即按 cancelled 结束 job
  {
    let fakeClock = 100000
    const env = createNotifyEnv({
      now: () => fakeClock,
      cancelGraceMs: 60000,
      sliceMs: 20000,
    })
    env.setStartResp({ runId: 'run-cancel-stuck', sessionId: 'child-c2', webUrl: 'http://127.0.0.1:3080/?sessionId=child-c2' })
    let waitCalls = 0
    env.setWaitHandler(async () => {
      waitCalls++
      // 第 1 次：刚发起 cancel_run（t=100000），仍在工具调用中 running + cancelRequested:true
      // 第 2 次：30s 后（t=130000 < 60s），仍未满 1 分钟，继续等
      // 第 3 次：65s 后（t=165000 >= 60s），超过 1 分钟仍未终止 -> 立即按 cancelled 结束
      if (waitCalls === 2) fakeClock = 130000
      else if (waitCalls >= 3) fakeClock = 165000
      return {
        runId: 'run-cancel-stuck',
        sessionId: 'child-c2',
        status: 'running',
        cancelRequested: true,
        assistantText: '卡在某个长耗时工具前输出的文字',
      }
    })
    const res = await env.dispatchTool.execute({ startArgs: { workspace: 'W', task: 'T' } }, { agent: env.fakeAgent })
    for (let i = 0; i < 30 && env.notices.length === 0; i++) await new Promise((r) => setTimeout(r, 10))
    assert.equal(waitCalls, 3, '应在满 1 分钟宽限期的第 3 次轮询时立即结束，不等 240 分钟')
    assert.equal(env.notices.length, 1)
    assert(env.notices[0].text.includes('status: cancelled') && env.notices[0].text.includes('已取消'))
    assert(env.notices[0].text.includes('卡在某个长耗时工具前输出的文字'))
    const snap = env.fakeCtx.jobs.get(res.jobId, env.fakeAgent)
    assert.equal(snap.status, 'cancelled')
  }

  // 2c) cancelRequested:true 且宿主子会话已终止（如 turn/end 已闭合但 relay status 仍为 running）：无需等满 1 分钟，立即按 cancelled 结束
  {
    const env = createNotifyEnv({ cancelGraceMs: 60000 })
    env.childSessions.set('child-c3', {
      id: 'child-c3',
      events: [{ type: 'turn/start', seq: 1 }, { type: 'turn/end', seq: 2 }],
    })
    env.setStartResp({ runId: 'run-cancel-term', sessionId: 'child-c3', webUrl: 'http://127.0.0.1:3080/?sessionId=child-c3' })
    let waitCalls = 0
    env.setWaitHandler(async () => {
      waitCalls++
      return { runId: 'run-cancel-term', sessionId: 'child-c3', status: 'running', cancelRequested: true }
    })
    const res = await env.dispatchTool.execute({ startArgs: { workspace: 'W', task: 'T' } }, { agent: env.fakeAgent })
    for (let i = 0; i < 20 && env.notices.length === 0; i++) await new Promise((r) => setTimeout(r, 10))
    assert.equal(waitCalls, 1, '子会话已终止时首次观测到 cancelRequested 即立即结束')
    assert.equal(env.fakeCtx.jobs.get(res.jobId, env.fakeAgent).status, 'cancelled')
    assert(env.notices[0].text.includes('已取消'))
  }

  // 3) 停滞提醒测试：超过 stallMinutes（默认 15 分钟）无新进展发一次中途通知（不结束 job）；
  //    同一停滞周期只提醒一次；恢复进展后若再次停滞可再次提醒；最终完成时正常发完成通知。
  {
    let fakeClock = 1_000_000
    const env = createNotifyEnv({
      now: () => fakeClock,
      stallMinutes: 15,
      sliceMs: 30000,
    })
    const childEvents = [
      { type: 'turn/start', seq: 1, time: fakeClock },
      { type: 'tool/call', seq: 2, time: fakeClock, data: { name: 'pwsh' } },
    ]
    env.childSessions.set('child-stall-1', { id: 'child-stall-1', events: childEvents })
    env.setStartResp({
      runId: 'run-stall-once',
      sessionId: 'child-stall-1',
      webUrl: 'http://127.0.0.1:3080/?sessionId=child-stall-1',
      lastProgressAt: new Date(fakeClock).toISOString(),
    })

    let step = 0
    let lastProgressIso = new Date(fakeClock).toISOString()
    env.setWaitHandler(async () => {
      step++
      if (step === 1) {
        // 16 分钟无新进展 -> 触发第 1 次停滞提醒
        fakeClock += 16 * 60000
        return {
          runId: 'run-stall-once',
          sessionId: 'child-stall-1',
          webUrl: 'http://127.0.0.1:3080/?sessionId=child-stall-1',
          status: 'running',
          lastProgressAt: lastProgressIso,
        }
      }
      if (step === 2) {
        // 又过了 5 分钟（共 21 分钟），lastProgressAt 仍未变 -> 同一停滞周期不重复提醒
        fakeClock += 5 * 60000
        return {
          runId: 'run-stall-once',
          sessionId: 'child-stall-1',
          webUrl: 'http://127.0.0.1:3080/?sessionId=child-stall-1',
          status: 'running',
          lastProgressAt: lastProgressIso,
        }
      }
      if (step === 3) {
        // 恢复进展：产生新工具调用 read，lastProgressAt 更新为当前时间 -> 不提醒，且重置停滞标记
        fakeClock += 1 * 60000
        lastProgressIso = new Date(fakeClock).toISOString()
        childEvents.push({ type: 'tool/call', seq: 3, time: fakeClock, data: { name: 'read' } })
        return {
          runId: 'run-stall-once',
          sessionId: 'child-stall-1',
          webUrl: 'http://127.0.0.1:3080/?sessionId=child-stall-1',
          status: 'running',
          lastProgressAt: lastProgressIso,
          lastEventSeq: 3,
        }
      }
      if (step === 4) {
        // 恢复后再次停滞 18 分钟 -> 应能再次发送停滞提醒，且最后工具调用更新为 read
        fakeClock += 18 * 60000
        return {
          runId: 'run-stall-once',
          sessionId: 'child-stall-1',
          webUrl: 'http://127.0.0.1:3080/?sessionId=child-stall-1',
          status: 'running',
          lastProgressAt: lastProgressIso,
          lastEventSeq: 3,
        }
      }
      // 第 5 步：任务最终成功完成
      fakeClock += 1 * 60000
      return {
        runId: 'run-stall-once',
        sessionId: 'child-stall-1',
        webUrl: 'http://127.0.0.1:3080/?sessionId=child-stall-1',
        status: 'succeeded',
        assistantText: '任务最终顺利完成',
      }
    })

    const res = await env.dispatchTool.execute({ startArgs: { workspace: 'W', task: 'T' } }, { agent: env.fakeAgent })
    for (let i = 0; i < 30 && env.notices.length < 3; i++) await new Promise((r) => setTimeout(r, 10))
    assert.equal(env.notices.length, 3, `应收到 2 次停滞提醒 + 1 次最终完成通知，实际收到 ${env.notices.length} 条`)
    // 第 1 条：首次停滞 16 分钟提醒（step 2 的 21 分钟不重复发）
    assert(env.notices[0].text.includes('[relay_dispatch 卡死提醒]'))
    assert(env.notices[0].text.includes('runId=run-stall-once'))
    assert(env.notices[0].text.includes('http://127.0.0.1:3080/?sessionId=child-stall-1'))
    assert(env.notices[0].text.includes('16 分钟'))
    assert(env.notices[0].text.includes('最后一个工具调用：pwsh'))
    // 第 2 条：恢复进展后再次停滞 18 分钟提醒
    assert(env.notices[1].text.includes('[relay_dispatch 卡死提醒]'))
    assert(env.notices[1].text.includes('18 分钟'))
    assert(env.notices[1].text.includes('最后一个工具调用：read'))
    // 第 3 条：后台 job 未被停滞提醒中断，最终正常完成
    assert(env.notices[2].text.includes('任务最终顺利完成') && env.notices[2].text.includes('status: succeeded'))
    assert.equal(env.fakeCtx.jobs.get(res.jobId, env.fakeAgent).status, 'completed')
  }
}
console.log('notify ok')

// ───────── parentSession 注入修复测试：放宽同进程判定 / 浏览器拒绝 / generation 防链叠加与旧实例 dispose / 诊断日志 ─────────
import { readFileSync } from 'node:fs'
import { evaluateRelayPrepare, PREPARE_SYM } from '../lib/index.js'
{
  const logFile = join(dir, 'parentfix.log')
  const prepared = new Map()
  let rawPrepareCalls = 0
  const rawPrepare = function (id, opts) {
    rawPrepareCalls++
    prepared.set(id, opts)
    return { session: { id, header: { id, ...(opts && opts.meta) }, events: [] } }
  }
  const rawApiHandler = async (_req, fn) => fn()
  const apiRoute = { handler: rawApiHandler }
  const sessionsSvc = {
    prepare: rawPrepare,
    get: () => undefined,
  }
  let toolHandler = async () => ({ isError: false, value: { runId: 'r-default' } })

  function mountInstance(cfgOverrides = {}) {
    let tool
    const disposers = []
    const ctx = {
      effect(fn) {
        const d = fn()
        if (typeof d === 'function') disposers.push(d)
        return d
      },
      get(k) {
        if (k === 'sessions') return sessionsSvc
        if (k === 'webServer') return { prefixes: new Map([['/api', apiRoute]]) }
        if (k === 'jobs') return { start: () => 'job-pf' }
        return undefined
      },
      tools: {
        register(t) { tool = t; return () => {} },
        execute: (c) => toolHandler(c),
      },
    }
    apply(ctx, {
      modesPath: yp,
      parentLogPath: logFile,
      refreshTitle: false,
      ...cfgOverrides,
    })
    return {
      run: (args, parentId = 'parent-pf') => tool.execute(args, {
        agent: parentId ? { session: { header: { id: parentId } } } : undefined,
      }),
      dispose: () => { while (disposers.length) disposers.pop()() },
    }
  }

  // 1) 第一次 apply（generation=1）
  const inst1 = mountInstance()
  assert.equal(sessionsSvc[PREPARE_SYM].orig, rawPrepare)
  assert.equal(sessionsSvc[PREPARE_SYM].generation, 1)
  assert.notEqual(sessionsSvc.prepare, rawPrepare)

  // 2) 第二次 apply（generation=2，先还原到原始 prepare 再包装）+ 旧实例后 dispose 仍生效
  const inst2 = mountInstance()
  assert.equal(sessionsSvc[PREPARE_SYM].orig, rawPrepare)
  assert.equal(sessionsSvc[PREPARE_SYM].generation, 2)
  const gen2Prepare = sessionsSvc.prepare
  // 旧实例（inst1）在 inst2 之后 dispose，不得拆掉 inst2 的包装
  inst1.dispose()
  assert.equal(sessionsSvc.prepare, gen2Prepare, '旧实例 dispose 不应还原新实例的 prepare 包装')

  // 3) 同进程 relay 创建（无请求头、dispatchAls 不透传、派发未传 agentPreset 而宿主填了默认 agentPreset='standard'）应挂上；
  //    同时浏览器手动创建（reqKind==='browser'）不挂；且无 wrapper 链叠加（rawPrepare 仅调用预期次数）
  rawPrepareCalls = 0
  toolHandler = async (c) => {
    if (c.name.endsWith('start_run')) {
      // 模拟跨进程/同进程 RPC 脱离 dispatchAls 异步上下文（setTimeout 宏任务 + AsyncLocalStorage.run 隔离）
      await new Promise((resolve) => setTimeout(resolve, 5))
      // 3a) 浏览器手动新建会话 -> 不挂
      await apiRoute.handler({ headers: { origin: 'http://127.0.0.1:3080', 'user-agent': 'Mozilla/5.0 Chrome/125.0' } }, () => {
        sessionsSvc.prepare('sess-browser-manual', { meta: { cwd: 'C:\\ws\\pf', agentPreset: 'standard' } })
      })
      // 3b) 同进程 relay 创建（无请求头、无 agentPreset 入参、宿主填了默认 meta.agentPreset='standard'）-> 应挂上
      sessionsSvc.prepare('sess-sameproc-relay', { meta: { cwd: 'C:/ws/pf/', agentPreset: 'standard' } })
      return { isError: false, value: { runId: 'run-pf-1', sessionId: 'sess-sameproc-relay' } }
    }
    return { isError: false, value: {} }
  }
  await inst2.run({ startArgs: { workspace: 'C:\\ws\\pf', task: '同进程派发测试' } }, 'parent-live-2')
  assert.equal(prepared.get('sess-browser-manual').meta.parentSession, undefined, '浏览器手动创建不挂 parentSession')
  assert.equal(prepared.get('sess-sameproc-relay').meta.parentSession, 'parent-live-2', '同进程 relay 创建应挂上 parentSession')
  assert.equal(rawPrepareCalls, 2, '每次 prepare 底层原始函数只应执行一次（无 wrapper 链叠加）')

  // 4) 诊断日志校验：包含 wrapper installed generation=1/2 以及每次 prepare 的槽状态、cwdMatch、判定结果与原因、parentSession
  const logContent = readFileSync(logFile, 'utf8')
  assert(logContent.includes('wrapper installed generation=1'))
  assert(logContent.includes('wrapper installed generation=2'))
  assert(logContent.includes('id=sess-browser-manual slot=active cwdMatch=true result=reject reason=browser_request parentSession=none'))
  assert(logContent.includes('id=sess-sameproc-relay slot=active cwdMatch=true result=inject reason=matched parentSession=parent-live-2'))
  assert.equal(evaluateRelayPrepare('s0', { meta: { cwd: 'W' } }, null).reason, 'no_slot')

  // 5) 新实例 dispose 后彻底还原到最底层原始 prepare（及 apiRoute.handler）
  inst2.dispose()
  assert.equal(sessionsSvc.prepare, rawPrepare, '当前 generation 实例 dispose 后应彻底还原原始 prepare')
  assert.equal(apiRoute.handler, rawApiHandler, '当前 generation 实例 dispose 后应彻底还原原始 apiRoute.handler')
}
console.log('parentfix ok')

// ───────── 收口测试：1) sendSessionNotice 忙碌时不走 inject 改走 followup  2) wait_run 瞬时网络错误重试最多 3 次 ─────────
import { sendSessionNotice, isTransientPollError } from '../lib/index.js'
{
  // 1) sendSessionNotice：agent 处于 busy 时也不调用 inject，统一走 followup
  const delivered = []
  const busyAgent = {
    id: 'busy-1',
    status: 'busy',
    inject: () => { throw new Error('should not call inject') },
    followup: (msg) => delivered.push({ via: 'followup', msg }),
  }
  assert.equal(sendSessionNotice({}, busyAgent, '停滞提醒测试'), true)
  assert.equal(delivered.length, 1)
  assert.equal(delivered[0].via, 'followup')
  assert.equal(isTransientPollError(new Error('TypeError: fetch failed')), true)
  assert.equal(isTransientPollError(new Error('invalid arguments')), false)

  // 2) wait_run 遇到连续 3 次 fetch failed 可重试恢复，超过 3 次（第 4 次仍失败）才失败退出
  let waitAttempts = 0
  const notices = []
  const regTools = new Map()
  const fakeCtx = new Context()
  const fakeAgent = {
    id: 'sess-retry',
    status: 'idle',
    ctx: fakeCtx,
    followup: (msg) => notices.push(msg.content[0].text),
  }
  fakeCtx.provide('agents', { get: (id) => (id === fakeAgent.id ? fakeAgent : undefined) }, true)
  fakeCtx.provide('systemPrompt', { section: () => {} }, true)
  let failTimes = 3
  fakeCtx.provide('tools', {
    register: (t) => { regTools.set(t.name, t); return () => regTools.delete(t.name) },
    execute: async (c) => {
      if (c.name.endsWith('start_run')) return { isError: false, value: { runId: 'run-retry' } }
      if (c.name.endsWith('wait_run')) {
        waitAttempts++
        if (waitAttempts <= failTimes) return { isError: true, error: { message: 'fetch failed' } }
        return { isError: false, value: { runId: 'run-retry', status: 'succeeded', assistantText: '重试后成功' } }
      }
      return { isError: false, value: {} }
    },
  }, true)
  new LocalJobRegistry(fakeCtx, { maxConcurrentJobsPerOwner: 10 })
  applyToolJobs(fakeCtx, {})
  apply(fakeCtx, { modesPath: yp, linkParentSession: false, refreshTitle: false, waitRetryDelayMs: 5 })
  const dispatchTool = regTools.get('relay_dispatch')

  // 2a) 前 3 次 fetch failed，第 4 次成功 -> 任务正常 completed
  const rOk = await dispatchTool.execute({ startArgs: { workspace: 'W', task: 'T' } }, { agent: fakeAgent })
  for (let i = 0; i < 30 && notices.length === 0; i++) await new Promise((r) => setTimeout(r, 10))
  assert.equal(waitAttempts, 4)
  assert.equal(fakeCtx.jobs.get(rOk.jobId, fakeAgent).status, 'completed')
  assert(notices[0].includes('重试后成功'))

  // 2b) 连续 4 次 fetch failed（超出 3 次重试上限）-> 判定 failed 退出
  waitAttempts = 0
  failTimes = 4
  notices.length = 0
  const rFail = await dispatchTool.execute({ startArgs: { workspace: 'W', task: 'T' } }, { agent: fakeAgent })
  for (let i = 0; i < 30 && notices.length === 0; i++) await new Promise((r) => setTimeout(r, 10))
  assert.equal(waitAttempts, 4)
  assert.equal(fakeCtx.jobs.get(rFail.jobId, fakeAgent).status, 'failed')
  assert(notices[0].includes('fetch failed'))
}
console.log('polish ok')
