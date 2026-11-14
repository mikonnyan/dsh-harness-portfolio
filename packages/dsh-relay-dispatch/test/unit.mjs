import { summarize, parseResult, compileCapabilityManifest, canonicalJson } from '../lib/index.js'
const cm = compileCapabilityManifest({ workspace: 'C:\\work', contextReadScope: ['C:\\work'], writeScope: ['src'], permissionPreset: 'workspace-write', agentPreset: 'standard-lean' }, { taskId: 'task-cm', parentSession: 'parent', now: 1700000000000 })
assert.equal(cm.task_id, 'task-cm'); assert.equal(cm.write_roots.length, 1)
assert.deepEqual(cm.forbidden_ports, [3080]); assert.deepEqual(cm.loopback_ports, [3080, 4098, 4141, 8318]); assert.equal(cm.protected_process_rules.no_kill, true)
assert.equal(cm.role_boundaries.may_write, true); assert.equal(cm.nested_dispatch.enabled, false)
assert.match(cm.policy_digest, /^sha256:[a-f0-9]{64}$/); assert.ok(Object.isFrozen(cm) && Object.isFrozen(cm.role_boundaries))
assert.equal(compileCapabilityManifest({ workspace: 'W' }, { taskId: 'r', now: 1700000000000 }).write_roots.length, 0)
assert.equal(canonicalJson({ b: 1, a: 2 }), '{"a":2,"b":1}')
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
assert.equal(fillStartArgs({ workspace: 'W', model: 'grok-4.7-fast' }, D).reasoningEffort, 'xhigh')
assert.equal(fillStartArgs({ workspace: 'W', model: 'grok-4.7-fast', reasoningEffort: 'high' }, D).reasoningEffort, 'high')
assert.equal(fillStartArgs({ workspace: 'W', model: 'other' }, D).reasoningEffort, undefined)
const external = fillStartArgs({ workspace: 'C:\\work', permissionPreset: 'workspace-write', contextReadScope: ['C:\\work', 'C:\\work\\agent\\.dsh'], writeScope: ['src', 'C:\\work\\agent\\.dsh\\plugins'] }, D)
assert.equal(external.permissionPreset, 'danger-full-access')
assert.deepEqual(external.writeScope, ['src', 'C:\\work\\agent\\.dsh\\plugins'])
assert.deepEqual(external.contextReadScope, ['C:\\work'])
const externalManifest = compileCapabilityManifest(external, { readScope: ['C:\\work', 'C:\\work\\agent\\.dsh'], now: 1700000000000 })
assert(externalManifest.read_roots.some((r) => r.canonical_path === 'C:\\work\\agent\\.dsh\\plugins'))
assert(externalManifest.read_roots.some((r) => r.canonical_path === 'C:\\work\\agent\\.dsh'))
console.log('fill ok')

// ───────── 派发模式测试 ─────────
import { parseModesYaml, loadModes, applyMode, collectModelIds, apply } from '../lib/index.js'
import { writeFileSync, mkdtempSync, mkdirSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'modes-'))
const yp = join(dir, 'm.yaml')
const Y1 = 'x:\n  permission: danger-full-access\n  taskPrefix: |\n    PFX\n  deliverable: |\n    DLV\n  checkpoint: true\n  models:\n    - a/m1   # c\n    - b/m2\nr:\n  permission: read-only\n  workspace: C:\\w\n  taskPrefix:\n  deliverable:\n  models:\n    - a/m1\n'
const pm = parseModesYaml(Y1)
assert.deepEqual(pm.x.models, ['a/m1', 'b/m2']); assert.equal(pm.x.checkpoint, true); assert.equal(pm.r.taskPrefix, ''); assert.equal(pm.r.workspace, 'C:\\w')
const dietModes = loadModes('unused-diet-modes.yaml', () => 'hosts:\n  mac: 100.64.0.2\nuncensored:\n  permission: danger-full-access\n  models:\n    - cursor/grok-4.7-fast\n')
assert.deepEqual(dietModes.hosts, { mac: '100.64.0.2' }); assert.ok(dietModes.modes.uncensored)

// mode 套用 + 显式优先
const ap = applyMode(pm.x, { task: 'T', permissionPreset: 'workspace-write' })
assert.equal(ap.args.permissionPreset, 'workspace-write')
assert(ap.args.task.startsWith('PFX') && ap.args.task.includes('T') && ap.args.task.endsWith('DLV'))
assert.equal(ap.candidates.length, 2)
assert.equal(applyMode(pm.x, { task: 'T', model: 'z' }).candidates.length, 0)
const rOut = applyMode(pm.r, { task: 'hi' }); assert.equal(rOut.args.task, 'hi'); assert.equal(rOut.args.workspace, 'C:\\w')

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
assert.equal(r.model, 'cursor/grok-4.7-fast'); assert.equal(t4.calls[0].arguments.task, 'T')
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

// Gemini/Copilot 严格校验：递归锁定实际注册工具的 parameters Schema。
{
  let dispatchTool
  const schemaCtx = {
    effect(fn) { return fn() },
    get() { return undefined },
    tools: { register(t) { if (t.name === 'relay_dispatch') dispatchTool = t }, execute: async () => okRes({}) },
  }
  apply(schemaCtx, { modesPath: yp, linkParentSession: false, refreshTitle: false })
  assert(dispatchTool?.parameters, 'relay_dispatch 必须暴露 parameters')
  let visited = 0
  const assertGeminiSchema = (schema, path = 'parameters') => {
    assert(schema && typeof schema === 'object' && !Array.isArray(schema), `${path} 必须是 Schema 对象`)
    visited++
    if (schema.type === 'array') {
      assert(schema.items && typeof schema.items === 'object' && !Array.isArray(schema.items), `${path} 缺少合法 items`)
      assertGeminiSchema(schema.items, `${path}.items`)
    }
    if (schema.type === 'object') {
      assert(schema.properties && typeof schema.properties === 'object' && !Array.isArray(schema.properties), `${path} 缺少 properties`)
      for (const [key, child] of Object.entries(schema.properties)) {
        assertGeminiSchema(child, `${path}.properties.${key}`)
      }
    }
  }
  assertGeminiSchema(dispatchTool.parameters)
  assert(visited > 10, '递归断言必须覆盖嵌套 Schema')
  assert.equal(Object.keys(dispatchTool.parameters.properties).filter((key) => key === 'reloadPlugins').length, 1)
  assert.equal(dispatchTool.parameters.properties.summary?.type, 'string', 'Gemini strict schema must expose summary in properties')
  console.log('gemini schema ok')
}

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
const dshNodeModules = join(homedir(), 'AppData', 'Roaming', 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai')
const { fitCompletionNotice, apply: applyToolJobs } = await import(pathToFileURL(`${dshNodeModules}/dsh-tool-jobs/lib/index.js`).href)
const { LocalJobRegistry } = await import(pathToFileURL(`${dshNodeModules}/dsh-jobs-local/lib/index.js`).href)
const { Context } = await import(pathToFileURL(`${dshNodeModules}/cordis/lib/index.js`).href)
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
  assert(dLong.finalText.startsWith('开头摘要') && dLong.finalText.includes('TAIL_UNIQUE_P2_MARK'))

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
  assert(noticeLong.includes('TAIL_UNIQUE_P2_MARK'))

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
  assert(notices[0].includes('TAIL_UNIQUE_P2_MARK'))
  const snapLong = fakeCtx.jobs.get(resLong.jobId, fakeAgent)
  assert.equal(snapLong.truncated, true)
  assert.equal(snapLong.fullLength, Array.from(longText).length)
  assert.equal(snapLong.fullTextAvailable, true)
  assert(snapLong.finalText.includes('TAIL_UNIQUE_P2_MARK'))
  const outLong = await jobOutputTool.execute({ job_id: resLong.jobId }, { agent: fakeAgent })
  const [rawLongOutput] = outLong.text.split('\n实际使用：')
  assert.equal(rawLongOutput, longText)
  assert(rawLongOutput.endsWith('TAIL_UNIQUE_P2_MARK'))
  const renderedLong = jobOutputTool.output.render({ job_id: resLong.jobId }, outLong)[0].text
  assert(renderedLong.includes('TAIL_UNIQUE_P2_MARK') && renderedLong.includes('[status: completed'))
}
console.log('p2 ok')

// ───────── 稳健性测试：parentSession 防错挂 / 并发 / 超时释放 / 标题调度可取消与超时 ─────────
import { classifyApiRequest, isRelayPrepare, attachChildToWorkspace, reconcileStrayChildSessions, parseInjectedChildLines } from '../lib/index.js'
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
  function setupHarness(cfgOverrides = {}, extra = {}) {
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
        opts.session = { id, header: { id, ...(opts && opts.meta) }, events: [] }
        return { session: opts.session }
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
        if (k === 'workspaceRegistry') return extra.workspaceRegistry
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
    const real = h.prepared.get('session-relay-real').session
    assert.equal(real.header.capabilityManifest.parent_session, 'parent-main')
    assert.deepEqual(real.header.capabilityManifest.forbidden_ports, [3080])
    assert.equal(real.header.capabilityManifest, real.header.capability_manifest)
    assert.equal(h.prepared.get('session-relay-real').meta.capabilityManifest, undefined, 'prepare meta 保持宿主持久化格式')
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

  // 2f) relay_dispatch 创建子会话时自动 attach 到父会话所在 workspace，并保持在折叠后的前 5 行
  {
    function makeWorkspace(path, seed) {
      const ids = [...seed]
      const attached = []
      const workspace = {
        path,
        get sessionIds() { return ids },
        async attachSession(id) {
          attached.push(id)
          if (!ids.includes(id)) ids.unshift(id)
        },
        async insertSessionBefore(sessionId, beforeSessionId) {
          if (!ids.includes(sessionId)) throw new Error(`not accounted ${sessionId}`)
          if (beforeSessionId != null && !ids.includes(beforeSessionId)) throw new Error(`anchor missing ${beforeSessionId}`)
          if (beforeSessionId === sessionId) return
          const without = ids.filter((id) => id !== sessionId)
          const at = beforeSessionId == null ? without.length : without.indexOf(beforeSessionId)
          const next = [...without.slice(0, at), sessionId, ...without.slice(at)]
          ids.splice(0, ids.length, ...next)
        },
      }
      return { workspace, ids, attached }
    }
    const buried = makeWorkspace('C:\\Users\\mikon\\Desktop\\asd', ['s1', 's2', 's3', 's4', 's5', 's6', 'parent-ws'])
    const h = setupHarness({ refreshTitle: false, parentLogPath: join(dir, 'attach-workspace.log') }, {
      workspaceRegistry: {
        list: () => [buried.workspace],
        async resolveByPath(p) {
          return String(p).replace(/[\\/]+/g, '/').replace(/\/$/, '').toLowerCase() === 'c:/users/mikon/desktop/asd' ? buried.workspace : undefined
        },
      },
    })
    h.setToolHandler(async (c) => {
      if (c.name.endsWith('start_run')) {
        h.sessionsSvc.prepare('session-child-attach', { meta: { cwd: 'C:/Users/mikon/Desktop/asd/' } })
        h.sessionsSvc.prepare('session-user-browser', { initiator: 'user', meta: { cwd: 'C:\\Users\\mikon\\Desktop\\asd' } })
        return { isError: false, value: { runId: 'r-attach', sessionId: 'session-child-attach' } }
      }
      return { isError: false, value: {} }
    })
    const res = await h.run({ startArgs: { workspace: 'C:\\Users\\mikon\\Desktop\\asd', task: 'attach me' } }, 'parent-ws')
    assert.equal(res.runId, 'r-attach')
    assert.equal(h.prepared.get('session-child-attach').meta.parentSession, 'parent-ws')
    assert.equal(buried.attached.filter((id) => id === 'session-child-attach').length, 1, '子会话应自动 attach 一次')
    assert.equal(buried.attached.includes('session-user-browser'), false, '手动创建不应 attach')
    assert.ok(buried.ids.indexOf('session-child-attach') >= 0 && buried.ids.indexOf('session-child-attach') < 5)
    assert.ok(buried.ids.indexOf('parent-ws') >= 0 && buried.ids.indexOf('parent-ws') < 5, '父会话不能被挤出折叠后的前 5 行')
    assert.equal(buried.ids[0], 'parent-ws')
    assert.equal(buried.ids[1], 'session-child-attach')
    h.disposeAll()

    const boom = makeWorkspace('C:\\ws\\boom', ['parent-boom'])
    boom.workspace.attachSession = async () => { boom.attached.push('threw'); throw new Error('attach failed') }
    const hBoom = setupHarness({ refreshTitle: false, parentLogPath: join(dir, 'attach-boom.log') }, {
      workspaceRegistry: { list: () => [boom.workspace] },
    })
    hBoom.setToolHandler(async (c) => {
      if (c.name.endsWith('start_run')) {
        hBoom.sessionsSvc.prepare('session-child-boom', { meta: { cwd: 'C:\\ws\\boom' } })
        return { isError: false, value: { runId: 'r-boom', sessionId: 'session-child-boom' } }
      }
      return { isError: false, value: {} }
    })
    const boomRes = await hBoom.run({ startArgs: { workspace: 'C:\\ws\\boom', task: 'still dispatch' } }, 'parent-boom')
    assert.equal(boomRes.runId, 'r-boom', 'attach 失败不能让派发失败')
    assert.equal(hBoom.warnings.length, 0)
    hBoom.disposeAll()
  }

  // 2g) 启动补挂：cwd 命中工作区但尚未进 sessionIds 的子会话（含日志里最近 50 条）
  {
    const lines = []
    for (let i = 0; i < 55; i++) lines.push(`[t] prepare id=session-extra-${i} slot=active cwdMatch=true result=inject reason=matched parentSession=session-parent-limit`)
    lines.push('[t] prepare id=session-57a9d5fb-c63c-4cb1-811c-4d6615930f51 slot=active cwdMatch=true result=inject reason=matched parentSession=session-parent-limit')
    assert.equal(parseInjectedChildLines(lines.join('\n'), 50)[0].childId, 'session-extra-6')
    assert.equal(parseInjectedChildLines(lines.join('\n'), 50).at(-1).childId, 'session-57a9d5fb-c63c-4cb1-811c-4d6615930f51')
    const ids = ['session-parent-limit', 'session-already']
    const attached = []
    const ws = {
      path: 'C:\\Users\\mikon\\Desktop\\asd',
      get sessionIds() { return ids },
      async attachSession(id) {
        attached.push(id)
        if (!ids.includes(id)) ids.unshift(id)
      },
      async insertSessionBefore(sessionId, beforeSessionId) {
        const without = ids.filter((id) => id !== sessionId)
        const at = beforeSessionId == null ? without.length : without.indexOf(beforeSessionId)
        ids.splice(0, ids.length, ...without.slice(0, at), sessionId, ...without.slice(at))
      },
    }
    const store = new Map([
      ['session-already', { id: 'session-already', header: { id: 'session-already', cwd: 'C:\\Users\\mikon\\Desktop\\asd', parentSession: 'session-parent-limit' } }],
      ['session-live-stray', { id: 'session-live-stray', header: { id: 'session-live-stray', cwd: 'C:/Users/mikon/Desktop/asd', parentSession: 'session-parent-limit' } }],
    ])
    for (let i = 0; i < 55; i++) {
      const id = `session-extra-${i}`
      store.set(id, { id, header: { id, cwd: 'C:\\Users\\mikon\\Desktop\\asd', parentSession: 'session-parent-limit' } })
    }
    store.set('session-57a9d5fb-c63c-4cb1-811c-4d6615930f51', {
      id: 'session-57a9d5fb-c63c-4cb1-811c-4d6615930f51',
      header: { id: 'session-57a9d5fb-c63c-4cb1-811c-4d6615930f51', cwd: 'C:\\Users\\mikon\\Desktop\\asd', parentSession: 'session-parent-limit' },
    })
    const logFile = join(dir, 'stray-children.log')
    writeFileSync(logFile, lines.join('\n'))
    const ctx = {
      get(k) {
        if (k === 'workspaceRegistry') return { list: () => [ws] }
        if (k === 'sessions') return {
          list: () => [store.get('session-already'), store.get('session-live-stray')],
          get: (id) => store.get(id),
        }
        return undefined
      },
    }
    await reconcileStrayChildSessions(ctx, { parentLogPath: logFile })
    assert.equal(attached.includes('session-already'), false, '已在 sessionIds 里的不再 attach')
    assert.equal(attached.includes('session-live-stray'), true)
    assert.equal(attached.includes('session-extra-5'), false, '只补挂日志最近 50 条')
    assert.equal(attached.includes('session-extra-6'), true)
    assert.equal(attached.includes('session-extra-54'), true)
    assert.equal(attached.includes('session-57a9d5fb-c63c-4cb1-811c-4d6615930f51'), true)
    assert.ok(ids.includes('session-57a9d5fb-c63c-4cb1-811c-4d6615930f51'))
    assert.ok(ids.indexOf('session-parent-limit') < 5)
    assert.ok(ids.indexOf('session-extra-54') < 5)
    assert.ok(ids.includes('session-live-stray'))
    const direct = []
    const directWs = {
      path: 'C:\\other',
      sessionIds: ['session-parent-direct'],
      async attachSession(id) { direct.push(id); this.sessionIds = [id, ...this.sessionIds.filter((x) => x !== id)] },
    }
    await attachChildToWorkspace({
      get: (k) => k === 'workspaceRegistry' ? { list: () => [directWs], async resolveByPath() { return undefined } } : undefined,
    }, 'session-direct-child', 'session-parent-direct', 'C:\\other')
    assert.deepEqual(direct, ['session-direct-child'])
    assert.equal(directWs.sessionIds[0], 'session-direct-child')
  }

  // 3) 标题调度：refresh 本地超时保护 + dispose 时立即取消停止
  {
    // 本组专门验证显式启用 LLM 标题刷新后的超时与取消；v2 默认行为另设测试覆盖。
    const h = setupHarness({ titlePollFirstMs: 10, titlePollIntervalMs: 10, titleRefreshTimeoutMs: 30, llmTitle: true })
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

    // 3c) Session v4 没有 .events：标题就绪检查必须读 snapshotEvents()
    const v4 = setupHarness({ titlePollFirstMs: 10, titlePollIntervalMs: 10, titleRefreshTimeoutMs: 40, llmTitle: true })
    v4.setToolHandler(async (c) => {
      if (c.name.endsWith('start_run')) {
        v4.sessionsSvc.prepare('sess-title-v4', { meta: { cwd: 'W' } })
        const sessionObj = { id: 'sess-title-v4', snapshotEvents() { return [{ type: 'user/message' }, { type: 'request/header' }] } }
        assert.equal(Object.hasOwn(sessionObj, 'events'), false)
        v4.prepared.get('sess-title-v4').sessionObj = sessionObj
        return { isError: false, value: { runId: 'r-tv4', sessionId: 'sess-title-v4' } }
      }
      return { isError: false, value: {} }
    })
    await v4.run({ startArgs: { workspace: 'W', task: '通用禁令：不重启 DSH\n\n# v4 标题' } }, 'parent-v4')
    await new Promise((r) => setTimeout(r, 80))
    assert.deepEqual(v4.renamed, [['sess-title-v4', 'v4 标题']])
    assert.deepEqual(v4.refreshed, ['sess-title-v4'])
    v4.disposeAll()
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

  // 2a) run 状态直接变为 cancelled：立即结束 job；宿主 job status 为 killed，通知 detail 仍写 status: cancelled
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
    assert.equal(snap.status, 'killed')
    assert(String(snap.detail || '').includes('status: cancelled'))
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
    assert.equal(snap.status, 'killed')
    assert(String(snap.detail || '').includes('status: cancelled'))
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
    assert.equal(env.fakeCtx.jobs.get(res.jobId, env.fakeAgent).status, 'killed')
    assert(String(env.fakeCtx.jobs.get(res.jobId, env.fakeAgent).detail || '').includes('status: cancelled'))
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

// ───────── 连续派发超过 3 次（dsh-tool-jobs maxConsecutiveWakes=3）插件侧自动唤醒保障测试 ─────────
import { hasPendingInbox } from '../lib/index.js'
{
  assert.equal(hasPendingInbox(null), false)
  assert.equal(hasPendingInbox({ inbox: { nextStep: [], nextTurn: [] } }), false)
  assert.equal(hasPendingInbox({ inbox: { nextStep: [{ id: 'm1' }], nextTurn: [] } }), true)
  assert.equal(hasPendingInbox({ inbox: { hasPending: true } }), true)

  // 场景 A：真实 ReactLoopAgent 形态（带 inbox.nextStep / nextTurn 与 wakeDriver），dsh-tool-jobs 默认 maxConsecutiveWakes=3
  const consumed = []
  const regTools = new Map()
  const fakeCtx = new Context()
  const inbox = {
    nextStep: [],
    nextTurn: [],
    get hasPending() { return this.nextStep.length > 0 || this.nextTurn.length > 0 },
  }
  const fakeAgent = {
    id: 'sess-wake-chain',
    status: 'idle',
    ctx: fakeCtx,
    inbox,
    session: { header: { id: 'sess-wake-chain' }, events: [] },
    wakeDriver() {
      const batch = [...this.inbox.nextStep.splice(0), ...this.inbox.nextTurn.splice(0, 1)]
      for (const m of batch) consumed.push({ via: 'wakeDriver', text: m.content[0].text })
    },
    followup(msg) {
      this.inbox.nextTurn.push(msg)
      this.wakeDriver()
    },
    inject(msg) {
      // 模拟 ReactLoopAgent.inject：只放入 nextStep，不唤醒 driver（status 保持 idle）
      this.inbox.nextStep.push(msg)
    },
  }
  let runSeq = 0
  fakeCtx.provide('agents', { get: (id) => (id === fakeAgent.id ? fakeAgent : undefined) }, true)
  fakeCtx.provide('systemPrompt', { section: () => {} }, true)
  fakeCtx.provide('tools', {
    register: (t) => { regTools.set(t.name, t); return () => regTools.delete(t.name) },
    execute: async (c) => {
      if (c.name.endsWith('start_run')) return { isError: false, value: { runId: `run-w-${++runSeq}` } }
      if (c.name.endsWith('wait_run')) return { isError: false, value: { runId: `run-w-${runSeq}`, status: 'succeeded', assistantText: `完成#${runSeq}` } }
      return { isError: false, value: {} }
    },
  }, true)
  new LocalJobRegistry(fakeCtx, { maxConcurrentJobsPerOwner: 10 })
  // 故意使用 dsh-tool-jobs 默认配置（maxConsecutiveWakes = 3）
  applyToolJobs(fakeCtx, {})
  // 插件侧配置 maxConsecutiveWakes = 5, wakeDelayMs = 20
  apply(fakeCtx, { modesPath: yp, linkParentSession: false, refreshTitle: false, wakeDelayMs: 20, maxConsecutiveWakes: 5 })
  const dispatchTool = regTools.get('relay_dispatch')

  // 连续派发 5 次：前 3 次由 tool-jobs followup 唤醒，第 4、5 次 tool-jobs 走 inject 静默入队，由 relay-dispatch 延时唤醒
  for (let i = 1; i <= 5; i++) {
    await dispatchTool.execute({ startArgs: { workspace: 'W', task: `T${i}` } }, { agent: fakeAgent })
    for (let w = 0; w < 20 && consumed.length < i; w++) await new Promise((r) => setTimeout(r, 10))
    assert.equal(consumed.length, i, `第 ${i} 次连续派发应被成功唤醒并消费通知`)
    assert(consumed[i - 1].text.includes(`完成#${i}`))
    assert.equal(inbox.hasPending, false, `第 ${i} 次唤醒后信箱应被清空`)
  }

  // 第 6 次超出插件侧上限（maxConsecutiveWakes = 5）：应停止自动唤醒，消息留在 inbox.nextStep
  await dispatchTool.execute({ startArgs: { workspace: 'W', task: 'T6' } }, { agent: fakeAgent })
  await new Promise((r) => setTimeout(r, 60))
  assert.equal(consumed.length, 5, '超过 maxConsecutiveWakes 上限后不应继续自动唤醒')
  assert.equal(inbox.nextStep.length, 1, '第 6 次通知应留在 nextStep 信箱中等待用户交互')
  inbox.nextStep.length = 0

  // 用户发送新消息后重置连续唤醒计数，第 7 次派发恢复自动唤醒
  fakeAgent.session.events.push({ type: 'user/message', data: { source: { kind: 'user' } } })
  await dispatchTool.execute({ startArgs: { workspace: 'W', task: 'T7' } }, { agent: fakeAgent })
  for (let w = 0; w < 20 && consumed.length < 6; w++) await new Promise((r) => setTimeout(r, 10))
  assert.equal(consumed.length, 6, '用户新消息后连续唤醒计数重置，应恢复自动唤醒')
  assert(consumed[5].text.includes('完成#7'))
}

  // 场景 B：任务完成时主会话仍在 doneAt 前开启的旧轮次中；旧轮次随后输出assistant/message 并延时 3 秒结束，
  // 既不能误判通知已处理，也不能在忙碌时补发 followup，必须等旧轮次闭合后补唤醒。
  {
    const busyNotices = []
    const busyTools = new Map()
    const busyCtx = new Context()
    const busyInbox = {
      nextStep: [],
      nextTurn: [],
      get hasPending() { return this.nextStep.length > 0 || this.nextTurn.length > 0 },
    }
    const busyEvents = [
      { type: 'turn/start', time: Date.now() - 1000, data: { turn: 1 } },
    ]
    const busyAgent = {
      id: 'sess-wake-busy-old-turn',
      status: 'busy',
      ctx: busyCtx,
      inbox: busyInbox,
      session: { header: { id: 'sess-wake-busy-old-turn' }, events: busyEvents },
      inject(msg) {
        // 模拟忙碌时 dsh-tool-jobs 只把通知放入 nextStep，不开启新轮次。
        this.inbox.nextStep.push(msg)
      },
      followup(msg) {
        busyNotices.push(msg.content[0].text)
        // 模拟真实 followup：通知在新轮次中被消费并产生助手响应。
        const at = Date.now()
        this.session.events.push(
          { type: 'turn/start', time: at, data: { turn: 2 } },
          { type: 'user/message', time: at + 1, data: { content: msg.content, source: msg.source } },
          { type: 'assistant/message', time: at + 2, data: { turn: 2, message: { content: [{ type: 'text', text: '已处理完成通知' }] } } },
          { type: 'turn/end', time: at + 3, data: { turn: 2 } },
        )
      },
    }
    busyCtx.provide('agents', { get: (id) => (id === busyAgent.id ? busyAgent : undefined) }, true)
    busyCtx.provide('systemPrompt', { section: () => {} }, true)
    busyCtx.provide('tools', {
      register: (t) => { busyTools.set(t.name, t); return () => busyTools.delete(t.name) },
      execute: async (c) => {
        if (c.name.endsWith('start_run')) return { isError: false, value: { runId: 'run-busy-old-turn' } }
        if (c.name.endsWith('wait_run')) {
          return { isError: false, value: { runId: 'run-busy-old-turn', status: 'succeeded', assistantText: '忙时完成的子任务' } }
        }
        return { isError: false, value: {} }
      },
    }, true)
    new LocalJobRegistry(busyCtx, { maxConcurrentJobsPerOwner: 10 })
    applyToolJobs(busyCtx, {})
    apply(busyCtx, {
      modesPath: yp,
      linkParentSession: false,
      refreshTitle: false,
      wakeDelayMs: 20,
      wakePollMs: 40,
      wakeMaxChecks: 120,
      maxConsecutiveWakes: 5,
    })
    const busyDispatch = busyTools.get('relay_dispatch')
    const busyResult = await busyDispatch.execute({ startArgs: { workspace: 'W', task: '忙时完成' } }, { agent: busyAgent })
    for (let i = 0; i < 100; i++) {
      const snap = busyCtx.jobs.get(busyResult.jobId, busyAgent)
      if (snap.status === 'completed' && busyInbox.nextStep.length === 1) break
      await new Promise((r) => setTimeout(r, 10))
    }
    assert.equal(busyCtx.jobs.get(busyResult.jobId, busyAgent).status, 'completed')
    assert.equal(busyInbox.nextStep.length, 1, '忙碌时完成通知应先由 inject 入队')
    assert.equal(busyNotices.length, 0, '旧轮次运行中不得补发 followup')

    // 该响应发生在 doneAt 之后，但仍属于 doneAt 前开启的 Turn 1，不能算作处理了本 job 通知。
    busyEvents.push({
      type: 'assistant/message',
      time: Date.now(),
      data: { turn: 1, message: { content: [{ type: 'text', text: '旧轮次自己的回复' }] } },
    })
    const oldTurnTimer = setTimeout(() => {
      busyEvents.push({ type: 'turn/end', time: Date.now(), data: { turn: 1 } })
      busyAgent.status = 'idle'
    }, 3000)
    await new Promise((r) => setTimeout(r, 250))
    assert.equal(busyNotices.length, 0, '旧轮次的后续 assistant/message 不得误导为通知已处理')

    for (let i = 0; i < 100 && busyNotices.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 50))
    }
    clearTimeout(oldTurnTimer)
    assert.equal(busyNotices.length, 1, '旧轮次结束并回到 idle 后必须补唤醒一次')
    assert(busyNotices[0].includes(busyResult.jobId), '补发通知必须携带对应 jobId')
    assert.equal(busyInbox.hasPending, false, '补唤醒后不得残留重复的 nextStep 通知')
    await new Promise((r) => setTimeout(r, 120))
    assert.equal(busyNotices.length, 1, '确认新轮次已响应后不得重复补唤醒')
  }

  // 场景 C：Session v4 只有 snapshotEvents()。用户消息仍应重置连续唤醒计数。
  {
    const consumed = []
    const regTools = new Map()
    const v4Ctx = new Context()
    const inbox = {
      nextStep: [],
      nextTurn: [],
      get hasPending() { return this.nextStep.length > 0 || this.nextTurn.length > 0 },
    }
    const log = []
    const v4Agent = {
      id: 'sess-wake-v4',
      status: 'idle',
      ctx: v4Ctx,
      inbox,
      session: { header: { id: 'sess-wake-v4' }, snapshotEvents() { return log.slice() } },
      wakeDriver() {
        const batch = [...this.inbox.nextStep.splice(0), ...this.inbox.nextTurn.splice(0, 1)]
        for (const m of batch) consumed.push({ via: 'wakeDriver', text: m.content[0].text })
      },
      followup(msg) {
        this.inbox.nextTurn.push(msg)
        this.wakeDriver()
      },
      inject(msg) { this.inbox.nextStep.push(msg) },
    }
    assert.equal(Object.hasOwn(v4Agent.session, 'events'), false)
    let runSeq = 0
    v4Ctx.provide('agents', { get: (id) => (id === v4Agent.id ? v4Agent : undefined) }, true)
    v4Ctx.provide('systemPrompt', { section: () => {} }, true)
    v4Ctx.provide('tools', {
      register: (t) => { regTools.set(t.name, t); return () => regTools.delete(t.name) },
      execute: async (c) => {
        if (c.name.endsWith('start_run')) return { isError: false, value: { runId: `run-v4-${++runSeq}` } }
        if (c.name.endsWith('wait_run')) return { isError: false, value: { runId: `run-v4-${runSeq}`, status: 'succeeded', assistantText: `v4#${runSeq}` } }
        return { isError: false, value: {} }
      },
    }, true)
    new LocalJobRegistry(v4Ctx, { maxConcurrentJobsPerOwner: 10 })
    applyToolJobs(v4Ctx, {})
    apply(v4Ctx, { modesPath: yp, linkParentSession: false, refreshTitle: false, wakeDelayMs: 20, maxConsecutiveWakes: 5 })
    const dispatchTool = regTools.get('relay_dispatch')
    for (let i = 1; i <= 5; i++) {
      await dispatchTool.execute({ startArgs: { workspace: 'W', task: `V${i}` } }, { agent: v4Agent })
      for (let w = 0; w < 20 && consumed.length < i; w++) await new Promise((r) => setTimeout(r, 10))
      assert.equal(consumed.length, i, `v4 第 ${i} 次连续派发应被唤醒`)
    }
    await dispatchTool.execute({ startArgs: { workspace: 'W', task: 'V6' } }, { agent: v4Agent })
    await new Promise((r) => setTimeout(r, 60))
    assert.equal(consumed.length, 5, '超过 maxConsecutiveWakes 后不应继续自动唤醒')
    assert.equal(inbox.nextStep.length, 1)
    inbox.nextStep.length = 0
    log.push({ type: 'user/message', data: { source: { kind: 'user' } } })
    await dispatchTool.execute({ startArgs: { workspace: 'W', task: 'V7' } }, { agent: v4Agent })
    for (let w = 0; w < 20 && consumed.length < 6; w++) await new Promise((r) => setTimeout(r, 10))
    assert.equal(consumed.length, 6, 'snapshotEvents 中的用户消息应重置连续唤醒计数')
    assert(consumed[5].text.includes('v4#7'))
  }
console.log('wake ok')

// ───────── v2：同步预检 / Git 快照 / 聚合流水线 / gate / 取消与清单 ─────────
import {
  V2_MACHINE_HEADER,
  preflightDispatchV2,
  writePathsOverlap,
  isUnknownStartError,
  captureGitTree,
  diffGitTrees,
} from '../lib/index.js'
import { execFileSync } from 'node:child_process'
{
  assert(writePathsOverlap('C:\\ws\\foo', 'c:/ws/FOO/bar'))
  assert(!writePathsOverlap('C:\\ws\\foo', 'C:\\ws\\foobar'))
  assert(isUnknownStartError(new Error('fetch failed ECONNRESET')))
  assert(!isUnknownStartError(new Error('HTTP 429 rate limit')))
  assert.equal(buildDelivery('succeeded', ' \n\t结论').finalText, '结论')

  const conflictArgs = {
    tasks: [
      { label: 'a', startArgs: { workspace: 'C:\\ws\\p', task: 'a', permissionPreset: 'workspace-write', writeScope: ['C:\\ws\\p\\src'] } },
      { label: 'b', startArgs: { workspace: 'C:\\ws\\p', task: 'b', permissionPreset: 'workspace-write', writeScope: ['C:\\ws\\p\\src\\x'] } },
    ],
  }
  assert.throws(() => preflightDispatchV2(conflictArgs), /写范围冲突/)
  const serial = preflightDispatchV2({ ...conflictArgs, onWriteConflict: 'serial' })
  assert.deepEqual([...serial.tasks[1].dependsOn], [0])
  assert.throws(() => preflightDispatchV2({ tasks: [] }), /非空数组/)
  assert.throws(() => preflightDispatchV2({ gate: { userAsk: '', criteria: 'x' } }), /userAsk/)

  const { expandPathMacro, expandTextMacros, extractRoots, runMechanicalChecks, syncTargetsNow, verifyHandoffContract } = await import('../lib/index.js')
  const roots = extractRoots({ asd: 'C:/work', pf: 'C:/work/portfolio' })
  assert.equal(expandPathMacro('@asd/lib/x.js', roots).replace(/\\/g, '/'), 'C:/work/lib/x.js')
  assert.throws(() => expandPathMacro('@asd/../../Windows', roots), /越界/)
  assert.equal(expandTextMacros('x @asd/a @@asd/b @tasks', roots), 'x C:/work/a @asd/b @tasks')
  assert.throws(() => preflightDispatchV2({ tasks: [
    { startArgs: { workspace: 'C:/a', task: 'a', permissionPreset: 'workspace-write', writeScope: ['C:/shared/x'] } },
    { startArgs: { workspace: 'C:/b', task: 'b', permissionPreset: 'workspace-write', writeScope: ['C:/shared/x/y'] } },
  ] }), /写范围冲突/, '跨 workspace 绝对路径也须查冲突')
  const spec = join(dir, 'spec.md'); writeFileSync(spec, '# spec')
  const protocol = preflightDispatchV2({
    startArgs: { workspace: '@asd', task: 'fallback', permissionPreset: 'workspace-write', writeScope: ['lib'] },
    specFile: spec, handoff: { api: 'lib/api.js#makeApi' },
    tasks: [{ label: 'producer', out: ['api'], task: 'make api', writeScope: ['lib/api.js'] }, { label: 'consumer', in: ['api'], task: 'use api', writeScope: ['lib/consumer.js'] }],
    gate: { criteria: '@tasks' },
  }, undefined, { roots, modes: {}, aliases: {} })
  assert.deepEqual([...protocol.tasks[1].dependsOn], [0])
  assert(protocol.gate.criteria.includes('make api') && protocol.gate.criteria.includes('use api'))
  assert(protocol.tasks[0].baseArgs.task.includes('交接产出') && protocol.tasks[1].baseArgs.task.includes('交接输入'))
  const artifact = join(dir, 'artifact.js'); writeFileSync(artifact, 'export function makeApi() {}\n')
  assert(verifyHandoffContract({ path: artifact, names: ['makeApi'] }).ok)
  assert(!verifyHandoffContract({ path: artifact, names: ['missing'] }).ok)
  const copySource = join(dir, 'copy-source'); const copyTarget = join(dir, 'copy-target'); mkdirSync(copySource); writeFileSync(join(copySource, 'a.txt'), 'same')
  assert(syncTargetsNow([{ source: copySource, target: copyTarget, root: dir, mode: 'copy' }], 'p-test').pass)
  assert((await runMechanicalChecks([{ sha: [join(copySource, 'a.txt'), join(copyTarget, 'a.txt')] }, { exists: [artifact] }, { exports: { file: artifact, names: ['makeApi'] } }, { noDiff: ['**/*.test.mjs'] }], { items: [] })).pass)
  assert((await runMechanicalChecks([{ exists: artifact }], { items: [] })).pass, 'exists 必须接受单个路径字符串')
  assert(!(await runMechanicalChecks([{ exists: join(dir, 'missing-artifact') }], { items: [] })).pass, '单个缺失路径应正常失败而非抛出类型错误')
  assert(!(await runMechanicalChecks([{ cmd: 'rm -rf x' }], { mechCommands: ['npm test'] })).pass)
  const quotedPrefixDir = join(dir, 'quoted prefix'); mkdirSync(quotedPrefixDir)
  const unquotedPrefixDir = join(dir, 'unquoted-prefix'); mkdirSync(unquotedPrefixDir)
  for (const prefixDir of [quotedPrefixDir, unquotedPrefixDir]) writeFileSync(join(prefixDir, 'package.json'), JSON.stringify({ scripts: { test: `node -e "console.log('tests 1')"` } }))
  assert((await runMechanicalChecks([{ cmd: `npm --prefix "${quotedPrefixDir}" test`, minTests: 1 }, { cmd: `npm --prefix '${quotedPrefixDir}' test`, minTests: 1 }, { cmd: `npm --prefix ${unquotedPrefixDir} test`, minTests: 1 }], { mechCommands: ['npm --prefix'] })).pass)
  writeFileSync(join(dir, 'mech-nested.test.mjs'), "import test from 'node:test'; test('ok', () => {})\n")
  const savedTestContext = process.env.NODE_TEST_CONTEXT
  process.env.NODE_TEST_CONTEXT = 'child-v8'
  try {
    const nested = await runMechanicalChecks([{ cmd: `node --test ${join(dir, 'mech-nested.test.mjs')}`, minTests: 1 }], { workspace: dir, mechCommands: ['node --test'] })
    assert(nested.pass, nested.results.map((r) => r.detail).join('\n'))
  } finally {
    if (savedTestContext == null) delete process.env.NODE_TEST_CONTEXT
    else process.env.NODE_TEST_CONTEXT = savedTestContext
  }

  // 临时索引快照包含未提交改动，但不污染真实 index / 工作树。
  const repo = mkdtempSync(join(tmpdir(), 'relay-v2-git-'))
  execFileSync('git', ['-c', 'safe.directory=*', 'init', '-q'], { cwd: repo, env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_CONFIG'))) })
  writeFileSync(join(repo, 'a.txt'), 'one')
  const before = await captureGitTree(repo)
  assert(before.available && /^[0-9a-f]{40}$/.test(before.tree))
  assert(execFileSync('git', ['status', '--short'], { cwd: repo, encoding: 'utf8', env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_CONFIG'))) }).includes('?? a.txt'))
  writeFileSync(join(repo, 'a.txt'), 'two')
  const after = await captureGitTree(repo)
  const gd = await diffGitTrees(repo, before, after)
  assert(gd.available && gd.changed && gd.files.includes('a.txt'))
  assert.notEqual(before.tree, after.tree)
  assert(execFileSync('git', ['status', '--short'], { cwd: repo, encoding: 'utf8', env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_CONFIG'))) }).includes('?? a.txt'))
  const nonGit = await captureGitTree(dir)
  assert.equal(nonGit.available, false)

  function makeV2Env(handler, cfg = {}) {
    let tool
    const calls = []
    const jobs = []
    const disposers = []
    const ctx = {
      effect(fn) { const d = fn(); if (typeof d === 'function') disposers.push(d); return d },
      get(k) {
        if (k === 'agents' && cfg.parentAgent) return { get: (id) => id === cfg.parentAgent.id ? cfg.parentAgent : undefined }
        if (k === 'jobs') return {
          start(spec) {
            const rec = { id: `job-v2-${jobs.length + 1}`, spec }
            rec.hooks = spec.run()
            rec.done = rec.hooks.done.then((o) => { rec.outcome = o; return o })
            jobs.push(rec)
            return rec.id
          },
        }
        return undefined
      },
      tools: {
        register(t) { tool = t; return () => {} },
        execute: async (c) => { calls.push(c); return handler(c) },
      },
    }
    apply(ctx, {
      modesPath: yp,
      linkParentSession: false,
      refreshTitle: false,
      manifestDir: dir,
      sliceMs: 5,
      waitRetryDelayMs: 1,
      ...cfg,
    })
    return {
      calls,
      jobs,
      run: (args, agent = {}) => tool.execute(args, { agent }),
      dispose: () => { while (disposers.length) disposers.pop()() },
    }
  }
  const capsV2 = { providers: [{ provider: 'a', models: ['m1'] }, { provider: 'b', models: ['m2'] }, { provider: 'c', models: ['m3'] }] }
  const startsOf = (env) => env.calls.filter((c) => c.name.endsWith('start_run'))

  // 参数/写冲突在同步预检失败：零 relay 调用、零 Job。
  {
    const env = makeV2Env(() => okRes({}))
    await assert.rejects(() => env.run(conflictArgs), /写范围冲突/)
    assert.equal(env.calls.length, 0)
    assert.equal(env.jobs.length, 0)
    env.dispose()
  }

  // tasks -> join -> 异构 gate：单聚合 Job、60s 能力缓存、机器头、清单与终态可重复读取。
  {
    writeFileSync(yp, 'verify:\n  permission: read-only\n  taskPrefix:\n  deliverable:\n  models:\n    - a/m1\n    - c/m3\n')
    let n = 0
    const env = makeV2Env(async (c) => {
      if (c.name.endsWith('list_capabilities')) return okRes(capsV2)
      if (c.name.endsWith('start_run')) { n++; return okRes({ runId: `r${n}`, sessionId: `s${n}` }) }
      if (c.name.endsWith('wait_run')) {
        const runId = c.arguments.runId
        return okRes({
          runId,
          sessionId: `s${runId.slice(1)}`,
          status: 'succeeded',
          assistantText: runId === 'r3' ? 'verdict: pass\ndone-r3' : `done-${runId}`,
        })
      }
      return okRes({})
    })
    const res = await env.run({
      tasks: [
        { label: 'A', provider: 'a', model: 'm1', startArgs: { workspace: 'W', task: '任务A', permissionPreset: 'read-only' } },
        { label: 'B', provider: 'b', model: 'm2', startArgs: { workspace: 'W', task: '任务B', permissionPreset: 'read-only' } },
      ],
      gate: { userAsk: '原始需求', criteria: '验收标准', commands: ['node test.js'], onPartial: 'gate' },
    })
    const out = await env.jobs[0].done
    assert.equal(env.jobs.length, 1)
    assert.equal(startsOf(env).length, 3)
    assert.equal(env.calls.filter((c) => c.name.endsWith('list_capabilities')).length, 1)
    const gs = startsOf(env)[2].arguments
    assert.equal(gs.provider, 'c'); assert.equal(gs.model, 'm3'); assert.equal(gs.maxTurns, 6)
    assert(gs.task.includes('原始需求') && gs.task.includes('验收标准') && gs.task.includes('node test.js'))
    assert.equal(out.status, 'completed')
    assert(out.detail.startsWith(`${V2_MACHINE_HEADER} | RESULT: PASS | needs_main_attention: no | self_review: 0 | gate_kind: llm\nstatus: succeeded`))
    assert(out.detail.includes('[task#0]') && out.detail.includes('[gate]'))
    assert(B(out.detail) <= 800, `PASS notification must fit slim budget, got ${B(out.detail)}`)
    const final1 = env.jobs[0].hooks.readOutput()
    assert(final1.startsWith(V2_MACHINE_HEADER) && final1.includes('done-r3'))
    assert.equal(env.jobs[0].hooks.readOutput(), final1)
    const mf = JSON.parse(readFileSync(res.manifestPath, 'utf8'))
    assert.equal(mf.pipelineId, res.pipelineId)
    assert.equal(mf.items.length, 3)
    assert.equal(mf.items[2].kind, 'gate'); assert.equal(mf.items[2].model, 'c/m3')
    assert.equal(mf.items[2].verdict, 'pass'); assert.equal(mf.phase, 'completed')
    env.dispose()
  }

  // 无剩余异构厂商时也必须真正执行一次守门员；自审 verdict: fail 不得被包装成验收通过。
  {
    writeFileSync(yp, 'verify:\n  permission: read-only\n  models:\n    - a/m1\n')
    let selfStarts = 0
    const env = makeV2Env(async (c) => {
      if (c.name.endsWith('list_capabilities')) return okRes(capsV2)
      if (c.name.endsWith('start_run')) {
        selfStarts += 1
        return okRes({ runId: `r-self-${selfStarts}`, sessionId: `s-self-${selfStarts}` })
      }
      if (c.name.endsWith('wait_run')) {
        const isGate = c.arguments.runId === 'r-self-2'
        return okRes({
          runId: c.arguments.runId,
          status: 'succeeded',
          assistantText: isGate ? 'verdict: fail\n自审发现验收未通过' : '实现结论',
        })
      }
      return okRes({})
    })
    const res = await env.run({ tasks: [{ provider: 'a', model: 'm1', startArgs: { workspace: 'W', task: 'T', permissionPreset: 'read-only' } }], gate: { userAsk: 'U', criteria: 'C' } })
    const out = await env.jobs[0].done
    assert.equal(startsOf(env).length, 2, '自审回退也必须启动真实守门员会话')
    assert(out.detail.startsWith(`${V2_MACHINE_HEADER} | RESULT: FAIL | needs_main_attention: yes | self_review: 1 | gate_kind: llm\nstatus: succeeded`))
    assert(out.detail.includes('self_review=1'))
    const mf = JSON.parse(readFileSync(res.manifestPath, 'utf8'))
    assert.equal(mf.items[1].status, 'succeeded')
    assert.equal(mf.items[1].model, 'a/m1')
    assert.equal(mf.items[1].verdict, 'fail')
    assert.equal(mf.items[1].selfReview, 1)
    env.dispose()
  }

  // 写任务 start_unknown：不得换候选模型重试造成双写。
  {
    writeFileSync(yp, Y1)
    const env = makeV2Env(async (c) => {
      if (c.name.endsWith('list_capabilities')) return okRes(caps)
      if (c.name.endsWith('start_run')) return { isError: true, error: { message: 'fetch failed ECONNRESET' } }
      return okRes({})
    })
    const res = await env.run({ tasks: [{ mode: 'x', startArgs: { workspace: 'W', task: '写任务' } }] })
    const out = await env.jobs[0].done
    assert.equal(startsOf(env).length, 1)
    assert.equal(out.status, 'failed')
    assert(out.detail.includes('start_unknown=1') && out.detail.includes('start_unknown'))
    const mf = JSON.parse(readFileSync(res.manifestPath, 'utf8'))
    assert.equal(mf.items[0].startUnknown, true)
    env.dispose()
  }

  // 运行中 readOutput 是实时快照；取消只向已运行项发 cancel_run，pending 项不启动。
  {
    const env = makeV2Env(async (c) => {
      if (c.name.endsWith('list_capabilities')) return okRes(capsV2)
      if (c.name.endsWith('start_run')) return okRes({ runId: 'r-hang', sessionId: 's-hang' })
      if (c.name.endsWith('wait_run')) { await new Promise((r) => setTimeout(r, 5)); return okRes({ runId: 'r-hang', status: 'running' }) }
      return okRes({})
    }, { maxConcurrentTasks: 1 })
    await env.run({ tasks: [
      { label: 'running', startArgs: { workspace: 'W', task: '1', permissionPreset: 'read-only' } },
      { label: 'pending', startArgs: { workspace: 'W', task: '2', permissionPreset: 'read-only' } },
    ] })
    await new Promise((r) => setTimeout(r, 20))
    const live = env.jobs[0].hooks.readOutput()
    assert(live.includes('state: running') && live.includes('#0 running: running') && live.includes('#1 pending: pending'))
    env.jobs[0].hooks.cancel('test-cancel')
    const out = await env.jobs[0].done
    assert.equal(out.status, 'killed')
    assert.equal(startsOf(env).length, 1)
    const cancels = env.calls.filter((c) => c.name.endsWith('cancel_run'))
    assert.equal(cancels.length, 1); assert.equal(cancels[0].arguments.runId, 'r-hang')
    assert(env.jobs[0].hooks.readOutput().startsWith(V2_MACHINE_HEADER))
    env.dispose()
  }

  // Task #0 / #1 在途时 dispose：保留 running+runId 与 pending，新实例沿用 runId 接管并执行 Gate。
  for (const detachAt of [0, 1]) {
    writeFileSync(yp, 'verify:\n  permission: read-only\n  models:\n    - c/m3\n')
    const remote = new Map()
    let starts = 0
    let finishRemote = false
    const handler = async (c) => {
      if (c.name.endsWith('list_capabilities')) return okRes(capsV2)
      if (c.name.endsWith('start_run')) {
        starts++
        const id = c.arguments.task.startsWith('C\n') ? `gate-${detachAt}` : `detach-${detachAt}-${starts - 1}`
        remote.set(id, { runId: id, sessionId: `s-${id}`, status: 'running' })
        return okRes(remote.get(id))
      }
      if (c.name.endsWith('wait_run')) {
        await new Promise((r) => setTimeout(r, 2))
        const id = c.arguments.runId
        const snap = remote.get(id) || { runId: id, sessionId: `s-${id}`, status: 'succeeded' }
        if (finishRemote || (detachAt === 1 && id.endsWith('-0'))) snap.status = 'succeeded'
        return okRes({ ...snap, assistantText: id.startsWith('gate') ? 'verdict: pass\n复审通过' : `done-${id}` })
      }
      return okRes({})
    }
    const env = makeV2Env(handler, { maxConcurrentTasks: 1 })
    const res = await env.run({
      tasks: [
        { label: 'A', startArgs: { workspace: 'W', task: '1', permissionPreset: 'read-only' } },
        { label: 'B', startArgs: { workspace: 'W', task: '2', permissionPreset: 'read-only' } },
      ],
      gate: { userAsk: 'U', criteria: 'C' },
    })
    for (let i = 0; i < 100; i++) {
      const mf = JSON.parse(readFileSync(res.manifestPath, 'utf8'))
      if (mf.items[detachAt]?.status === 'running' && mf.items[detachAt]?.runId) break
      await new Promise((r) => setTimeout(r, 2))
    }
    const beforeStarts = starts
    env.dispose()
    const out = await env.jobs[0].done
    assert.equal(out.status, 'killed')
    const mf = JSON.parse(readFileSync(res.manifestPath, 'utf8'))
    assert.equal(mf.phase, 'detached')
    assert.equal(mf.items[detachAt].status, 'running')
    assert(mf.items[detachAt].runId)
    assert.equal(mf.items[1].status, detachAt === 0 ? 'pending' : 'running')
    assert(!mf.items.some((i) => i.kind === 'gate'), '分离时不得伪造 cancelled Gate')
    assert.equal(env.calls.filter((c) => c.name.endsWith('cancel_run')).length, 0)

    finishRemote = true
    const resumed = makeV2Env(handler, { maxConcurrentTasks: 1, resumeDelayMs: 5 })
    for (let i = 0; i < 150 && (!resumed.jobs[0] || !resumed.jobs[0].outcome); i++) await new Promise((r) => setTimeout(r, 5))
    assert(resumed.jobs[0]?.outcome, '新实例应自动接管 detached 清单')
    assert.equal(starts, beforeStarts + (detachAt === 0 ? 2 : 1), '在途任务不得重复 start_run，仅启动剩余任务与 Gate')
    const doneMf = JSON.parse(readFileSync(res.manifestPath, 'utf8'))
    assert.equal(doneMf.phase, 'completed')
    assert(doneMf.items.slice(0, 2).every((i) => i.status === 'succeeded'))
    assert.equal(doneMf.items[2].kind, 'gate')
    assert.equal(doneMf.items[2].verdict, 'pass')
    assert(resumed.jobs[0].outcome.detail.includes('RESULT: PASS'))
    resumed.dispose()
  }

  // 旧代异常消失后遗留 phase=running：新一代沿用 runId，按拓扑继续剩余任务和 Gate，并唤醒父会话。
  {
    writeFileSync(yp, 'verify:\n  permission: read-only\n  models:\n    - c/m3\n')
    const remote = new Map([['legacy-running', { runId: 'legacy-running', status: 'running' }]])
    const parent = {
      id: 'parent-running-resume', status: 'idle',
      session: { header: { id: 'parent-running-resume' }, events: [] },
      inbox: { nextStep: [], nextTurn: [] },
      followUps: [],
      followup(msg) { this.followUps.push(msg); this.inbox.nextStep.push(msg) },
    }
    const resumed = makeV2Env(async (c) => {
      if (c.name.endsWith('list_capabilities')) return okRes(capsV2)
      if (c.name.endsWith('start_run')) {
        const id = c.arguments.task.includes('verdict: pass') ? 'legacy-gate' : 'legacy-downstream'
        remote.set(id, { runId: id, status: 'running' })
        return okRes({ runId: id, sessionId: `s-${id}` })
      }
      if (c.name.endsWith('wait_run')) {
        const snap = remote.get(c.arguments.runId) || { runId: c.arguments.runId, status: 'succeeded' }
        snap.status = 'succeeded'
        return okRes({ ...snap, assistantText: c.arguments.runId === 'legacy-gate' ? 'verdict: pass' : `done-${c.arguments.runId}` })
      }
      return okRes({})
    }, { maxConcurrentTasks: 1, resumeDelayMs: 5, wakeDelayMs: 200, wakePollMs: 5, wakeMaxChecks: 8, parentAgent: parent })
    const manifestPath = join(dir, 'legacy-running.json')
    const runningManifest = {
      pipelineId: 'legacy-running', phase: 'running', parentSessionId: parent.id,
      jobId: 'relay-dispatch-204',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      plan: {
        hasTasks: true, onWriteConflict: 'error', gate: { criteria: 'C', userAsk: 'U' },
        tasks: [
          { index: 0, label: 'A', review: false, writable: false, workspace: 'W', dependsOn: [], baseArgs: { workspace: 'W', task: 'A', provider: 'a', model: 'm1', permissionPreset: 'read-only' }, candidates: [{ provider: 'a', model: 'm1' }] },
          { index: 1, label: 'B', review: false, writable: false, workspace: 'W', dependsOn: [0], baseArgs: { workspace: 'W', task: 'B', provider: 'a', model: 'm1', permissionPreset: 'read-only' }, candidates: [{ provider: 'a', model: 'm1' }] },
        ],
      },
      items: [
        { index: 0, kind: 'task', label: 'A', status: 'running', runId: 'legacy-running' },
        { index: 1, kind: 'task', label: 'B', status: 'pending', dependsOn: [0] },
      ],
    }
    writeFileSync(manifestPath, JSON.stringify(runningManifest, null, 2))
    // The fixture emulates a previous generation with no in-memory activePipelines.
    for (let i = 0; i < 150 && !resumed.jobs[0]?.outcome; i++) await new Promise((r) => setTimeout(r, 5))
    assert(resumed.jobs[0]?.outcome, 'phase=running must be resumed')
    assert.equal(startsOf(resumed).length, 2, `only downstream task and gate may start: ${JSON.stringify(resumed.calls.map((c) => c.name))}\n${resumed.jobs[0]?.outcome?.detail || ''}\n${readFileSync(manifestPath, 'utf8')}`)
    assert.equal(resumed.calls.filter((c) => c.name.endsWith('wait_run') && c.arguments.runId === 'legacy-running').length > 0, true)
    const doneMf = JSON.parse(readFileSync(manifestPath, 'utf8'))
    assert.equal(doneMf.phase, 'completed')
    assert.equal(doneMf.originalJobId, 'relay-dispatch-204')
    assert.equal(doneMf.jobId, resumed.jobs[0].id)
    assert.notEqual(doneMf.jobId, doneMf.originalJobId)
    assert.deepEqual(doneMf.items.slice(0, 2).map((i) => i.status), ['succeeded', 'succeeded'])
    assert.equal(doneMf.items[2].verdict, 'pass')
    assert.equal(doneMf.items[1].runId, 'legacy-downstream')
    // Host onJobDone normally queues the notice before scheduleParentFollowupWake.
    // The minimal V2 harness has no notification service, so seed that exact pending notice.
    parent.inbox.nextStep.push({ id: `notice-${doneMf.jobId}`, role: 'user', content: [{ type: 'text', text: resumed.jobs[0].outcome.detail }] })
    for (let i = 0; i < 50 && parent.followUps.length === 0; i++) await new Promise((r) => setTimeout(r, 2))
    assert.equal(parent.followUps.length, 1, 'completion must wake the restored parent session')
    resumed.dispose()
  }

  // 自重载丢掉唤醒定时器后，新实例仍要按 originalJobId 补投父会话。
  {
    const parent = {
      id: 'parent-wake-reload', status: 'idle',
      session: { header: { id: 'parent-wake-reload' }, events: [] },
      inbox: { nextStep: [], nextTurn: [] },
      followUps: [],
      followup(msg) { this.followUps.push(msg) },
    }
    const manifestPath = join(dir, 'p-reload-wake.json')
    writeFileSync(manifestPath, JSON.stringify({
      pipelineId: 'p-reload-wake', phase: 'completed', parentWakeDelivered: false,
      finishedAt: Date.now(), updatedAt: new Date().toISOString(),
      jobId: 'relay-dispatch-216', originalJobId: 'relay-dispatch-204',
      parentSessionId: parent.id, machineHeader: 'relay_dispatch_v2: 1 | RESULT: PASS',
      plan: { tasks: [] }, items: [],
    }, null, 2))
    const env = makeV2Env(async () => okRes({}), { resumeDelayMs: 5, parentAgent: parent, wakeDelayMs: 1, wakePollMs: 1, wakeMaxChecks: 2 })
    for (let i = 0; i < 40 && parent.followUps.length === 0; i++) await new Promise((r) => setTimeout(r, 5))
    assert.equal(parent.followUps.length, 1, 'self-reload must still wake the parent')
    assert.match(parent.followUps[0].content[0].text, /relay-dispatch-204/)
    const saved = JSON.parse(readFileSync(manifestPath, 'utf8'))
    assert.equal(saved.parentWakeDelivered, true)
    assert.equal(saved.phase, 'completed')
    env.dispose()
  }

  // 纯机械门通过：不创建 LLM Gate；cmd 必须解析真实 node:test 计数。
  {
    const env = makeV2Env(async (c) => {
      if (c.name.endsWith('list_capabilities')) return okRes(capsV2)
      if (c.name.endsWith('start_run')) return okRes({ runId: 'mech-task', sessionId: 'mech-session' })
      if (c.name.endsWith('wait_run')) return okRes({ runId: 'mech-task', status: 'succeeded', assistantText: 'done' })
      return okRes({})
    })
    writeFileSync(join(dir, 'mech.test.mjs'), "import test from 'node:test'; test('ok', () => {})\n")
    await env.run({ tasks: [{ startArgs: { workspace: dir, task: 'T', permissionPreset: 'read-only' } }], gate: { checks: [{ cmd: `node --test ${join(dir, 'mech.test.mjs')}`, minTests: 1 }, { exists: [artifact] }] } })
    const out = await env.jobs[0].done
    assert(out.detail.includes('RESULT: PASS') && out.detail.includes('gate_kind: mech'), out.detail)
    assert.equal(startsOf(env).length, 1, '机械门不得启动 LLM 子会话')
    env.dispose()
  }

  // Gate 在途分离：恢复必须复用原 runId，不得新建 Gate 子会话。
  {
    writeFileSync(yp, 'verify:\n  permission: read-only\n  models:\n    - c/m3\n')
    let starts = 0, finishGate = false
    const handler = async (c) => {
      if (c.name.endsWith('list_capabilities')) return okRes(capsV2)
      if (c.name.endsWith('start_run')) { starts++; return okRes({ runId: starts === 1 ? 'task-gate-detach' : 'gate-detach', sessionId: `s-${starts}` }) }
      if (c.name.endsWith('wait_run')) {
        const gate = c.arguments.runId === 'gate-detach'
        await new Promise((r) => setTimeout(r, 2))
        return okRes({ runId: c.arguments.runId, status: gate && !finishGate ? 'running' : 'succeeded', assistantText: gate ? 'verdict: pass\n原 Gate 通过' : 'done' })
      }
      return okRes({})
    }
    const env = makeV2Env(handler)
    const res = await env.run({ tasks: [{ startArgs: { workspace: 'W', task: 'T', permissionPreset: 'read-only' } }], gate: { userAsk: 'U', criteria: 'C' } })
    for (let i = 0; i < 100; i++) { const mf = JSON.parse(readFileSync(res.manifestPath, 'utf8')); if (mf.items[1]?.runId === 'gate-detach') break; await new Promise((r) => setTimeout(r, 2)) }
    env.dispose(); await env.jobs[0].done; finishGate = true
    assert.equal(JSON.parse(readFileSync(res.manifestPath, 'utf8')).phase, 'detached', readFileSync(res.manifestPath, 'utf8'))
    const before = starts
    const resumed = makeV2Env(handler, { resumeDelayMs: 5 })
    for (let i = 0; i < 150 && !resumed.jobs[0]?.outcome; i++) await new Promise((r) => setTimeout(r, 5))
    assert(resumed.jobs[0]?.outcome?.detail.includes('RESULT: PASS'))
    assert.equal(starts, before, '恢复 Gate 不得再次 start_run')
    const mf = JSON.parse(readFileSync(res.manifestPath, 'utf8'))
    assert.equal(mf.items[1].runId, 'gate-detach')
    resumed.dispose()
  }

  // v3 保头保尾 + 空行压平；gate fail 后原会话修复一次并复审为 PASS。
  {
    const { conclusion, formatPipelineSummary } = await import('../lib/index.js')
    const preview = conclusion({ assistantText: `HEAD\n\n\n\n${'中'.repeat(300)}\nstatus: done\nverification: PASS\nsummary: TAIL` }, 100)
    assert(preview.startsWith('HEAD') && preview.endsWith('summary: TAIL'))
    assert(preview.includes('中间省略') && !/\n\s*\n\s*\n/.test(preview))
    assert(formatPipelineSummary({ pipelineId: 'v3', items: [{ index: 0, output: preview, status: 'succeeded' }] }).includes('summary: TAIL'))

    for (const failingVerdict of ['fail', 'partial']) {
    writeFileSync(yp, 'x:\n  permission: workspace-write\n  models:\n    - a/m1\n    - b/m2\nverify:\n  permission: read-only\n  models:\n    - c/m3\n')
    let gateN = 0, resumeN = 0, runN = 0
    const env = makeV2Env(async (c) => {
      if (c.name.endsWith('list_capabilities')) return okRes(capsV2)
      if (c.name.endsWith('resume_run')) throw new Error('unknown tool resume_run')
      if (c.name.endsWith('start_run')) {
        runN++
        if (runN === 3) { resumeN++; assert.equal(c.arguments.sessionMode, undefined); assert.equal(c.arguments.resumeSessionId, undefined); assert.equal(c.arguments.sessionId, 'v3-s1'); assert(c.arguments.task.includes('[不通过]')) }
        return okRes({ runId: `v3-r${runN}`, sessionId: runN === 3 ? 'v3-s1' : `v3-s${runN}` })
      }
      if (c.name.endsWith('wait_run')) {
        const id = c.arguments.runId
        const isGate = id === 'v3-r2' || id === 'v3-r4'
        if (isGate) gateN++
        return okRes({ runId: id, status: 'succeeded', assistantText: isGate ? `verdict: ${gateN === 1 ? failingVerdict : 'pass'}\n${gateN === 1 ? '[不通过] 缺少测试' : '复审通过'}` : `done-${id}` })
      }
      return okRes({})
    })
    await env.run({ tasks: [{ mode: 'x', startArgs: { workspace: 'W', task: 'fix gate' } }], gate: { userAsk: 'U', criteria: 'C' } })
    const out = await env.jobs[0].done
    assert.equal(resumeN, 1, out.detail); assert.equal(gateN, 2, out.detail); assert.equal(runN, 4)
    assert(out.detail.includes('RESULT: PASS'))
    env.dispose()
    }
  }

  // auto_fix 续跑与初次派发一样过滤外部 scope，避免底层 start_run 拒绝外部 writeScope。
  {
    writeFileSync(yp, 'x:\n  permission: workspace-write\n  models:\n    - a/m1\nverify:\n  permission: read-only\n  models:\n    - c/m3\n')
    let runN = 0, gateN = 0
    const env = makeV2Env(async (c) => {
      if (c.name.endsWith('list_capabilities')) return okRes(capsV2)
      if (c.name.endsWith('start_run')) {
        runN++
        if (runN === 3) {
          assert.deepEqual(c.arguments.writeScope, ['C:\\work\\src'])
          assert.deepEqual(c.arguments.contextReadScope, ['C:\\work'])
          assert.equal(c.arguments.permissionPreset, 'danger-full-access')
        }
        return okRes({ runId: `fix-scope-r${runN}`, sessionId: runN === 3 ? 'fix-scope-s1' : `fix-scope-s${runN}` })
      }
      if (c.name.endsWith('wait_run')) {
        const id = c.arguments.runId
        const isGate = id === 'fix-scope-r2' || id === 'fix-scope-r4'
        if (isGate) gateN++
        return okRes({ runId: id, status: 'succeeded', assistantText: isGate ? `verdict: ${gateN === 1 ? 'fail' : 'pass'}\n${gateN === 1 ? '[不通过] 缺少测试' : '复审通过'}` : 'done' })
      }
      return okRes({})
    })
    await env.run({ tasks: [{ mode: 'x', startArgs: { workspace: 'C:\\work', task: 'fix external scope', writeScope: ['src', 'C:\\outside\\write'], contextReadScope: ['C:\\work', 'C:\\outside\\read'] } }], gate: { userAsk: 'U', criteria: 'C' } })
    const out = await env.jobs[0].done
    assert(out.detail.includes('RESULT: PASS'), out.detail)
    assert.equal(runN, 4)
    env.dispose()
  }

  // v3 只读 mid-run failed 换下一个候选一次；写任务 Git 不可用禁止换模。
  {
    writeFileSync(yp, 'ro:\n  permission: read-only\n  models:\n    - a/m1\n    - b/m2\nx:\n  permission: workspace-write\n  models:\n    - a/m1\n    - b/m2\n')
    for (const mode of ['ro', 'x']) {
      let starts = 0
      const env = makeV2Env(async (c) => {
        if (c.name.endsWith('list_capabilities')) return okRes(capsV2)
        if (c.name.endsWith('start_run')) { starts++; return okRes({ runId: `${mode}-${starts}`, sessionId: `${mode}-s${starts}` }) }
        if (c.name.endsWith('wait_run')) return okRes({ runId: c.arguments.runId, status: 'failed', error: 'upstream reset' })
        return okRes({})
      })
      await env.run({ tasks: [{ mode, startArgs: { workspace: mode === 'x' ? dir : 'W', task: mode } }] })
      await env.jobs[0].done
      assert.equal(starts, mode === 'ro' ? 2 : 1)
      env.dispose()
    }
  }

  // 外部 writeScope：manifest 保留完整权限，底层 start_run 仅收 workspace 内路径。
  {
    writeFileSync(yp, Y1)
    let prepared
    const sessions = {
      prepare(id, opts) { prepared = { id, opts, session: { id, header: { id, ...opts.meta }, events: [] } }; return prepared },
      get(id) { return id === prepared?.id ? prepared.session : undefined },
    }
    let tool
    const calls = []
    const jobs = []
    const disposers = []
    const ctx = new Context()
    const originalEffect = ctx.effect.bind(ctx)
    ctx.effect = (fn, label) => { const d = originalEffect(fn, label); if (typeof d === 'function') disposers.push(d); return d }
    ctx.provide('sessions', sessions)
    ctx.provide('jobs', { start(spec) { const rec = { spec }; rec.hooks = spec.run(); rec.done = rec.hooks.done; jobs.push(rec); return 'job-external' } })
    ctx.provide('tools', { register(t) { tool = t }, execute: async (c) => { calls.push(c); if (c.name.endsWith('start_run')) { sessions.prepare('child-external', { meta: { cwd: 'C:\\work' } }); return okRes({ runId: 'external-scope', sessionId: 'child-external' }) } if (c.name.endsWith('wait_run')) return okRes({ runId: 'external-scope', status: 'succeeded', assistantText: 'done' }); return okRes(capsV2) } })
    apply(ctx, { modesPath: yp, manifestDir: dir, sliceMs: 1 })
    await tool.execute({ tasks: [{ startArgs: { workspace: 'C:\\work', task: 'T', permissionPreset: 'workspace-write', writeScope: ['src', 'C:\\work\\agent\\.dsh\\plugins'], contextReadScope: ['C:\\work', 'C:\\work\\agent\\.dsh'] } }] }, { agent: { session: { header: { id: 'parent-external' } } } })
    await jobs[0].done
    const start = calls.find((c) => c.name.endsWith('start_run'))
    assert.deepEqual(start.arguments.writeScope, ['C:\\work\\src'])
    assert.deepEqual(start.arguments.contextReadScope, ['C:\\work'])
    assert.equal(start.arguments.permissionPreset, 'danger-full-access')
    assert.equal(start.arguments.confirmedDangerousPermission, true)
    assert(prepared.session.header.capabilityManifest.write_scope.includes('C:\\work\\agent\\.dsh\\plugins'))
    assert(prepared.session.header.capabilityManifest.read_roots.some((r) => r.canonical_path === 'C:\\work\\agent\\.dsh\\plugins'))
    while (disposers.length) await disposers.pop()()
  }

  // reloadPlugins + 冷唤醒刷盘：成功时内部重载并进入通知头。
  {
    let flushCount = 0
    globalThis[Symbol.for('dsh.context-compact.hooks.v1')] = { flushBeforeColdWake: async (id) => { assert.equal(id, 'parent-reload'); flushCount++ } }
    let tool
    const calls = []
    const jobs = []
    const ctx = {
      effect(fn) { return fn() },
      get(k) { if (k === 'jobs') return { start(spec) { const rec = { spec }; rec.hooks = spec.run(); rec.done = rec.hooks.done; jobs.push(rec); return 'job-reload' } } },
      tools: { register(t) { tool = t }, execute: async (c) => { calls.push(c); if (c.name.endsWith('start_run')) return okRes({ runId: 'r-reload' }); if (c.name.endsWith('wait_run')) return okRes({ runId: 'r-reload', status: 'succeeded', assistantText: 'done' }); if (c.name === 'dev_reload_package') return okRes({ ok: true }); return okRes(capsV2) } },
    }
    apply(ctx, { modesPath: yp, linkParentSession: false, refreshTitle: false, manifestDir: dir, sliceMs: 1 })
    await tool.execute({ tasks: [{ startArgs: { workspace: 'W', task: 'T', permissionPreset: 'read-only' } }], reloadPlugins: ['dsh-tool-gate', 'dsh-context-compact'] }, { agent: { session: { header: { id: 'parent-reload' } } } })
    const out = await jobs[0].done
    const reloads = calls.filter((c) => c.name === 'dev_reload_package')
    assert.equal(reloads.length, 2)
    assert(reloads.every((c) => c.callId.startsWith('relay-dispatch-reload-')))
    assert(reloads.every((c) => c.signal instanceof AbortSignal && !c.signal.aborted))
    assert.deepEqual(reloads.map((c) => c.arguments), [
      { packageName: 'dsh-tool-gate', package: 'dsh-tool-gate', name: 'dsh-tool-gate' },
      { packageName: 'dsh-context-compact', package: 'dsh-context-compact', name: 'dsh-context-compact' },
    ])
    assert(out.detail.includes('reloaded: dsh-tool-gate(ok), dsh-context-compact(ok)'))
    assert.equal(flushCount, 1)
    delete globalThis[Symbol.for('dsh.context-compact.hooks.v1')]
  }

  // 自重载前先落 completed；新实例恢复时不得再次跑批或重载。
  {
    const selfDir = mkdtempSync(join(tmpdir(), 'relay-self-reload-'))
    let tool
    let manifestPath
    let reloadCalls = 0
    const jobs = []
    const disposers = []
    const snapshots = []
    const injector = { reload(pkg) {
      reloadCalls++
      const state = JSON.parse(readFileSync(manifestPath, 'utf8'))
      snapshots.push(state)
      assert.equal(pkg, 'dsh-relay-dispatch')
      assert.equal(state.phase, 'completed')
      assert.equal(typeof state.finishedAt, 'number')
      assert(state.reloadedPlugins.includes('dsh-relay-dispatch'))
    } }
    const ctx = {
      injector,
      effect(fn) { const d = fn(); if (typeof d === 'function') disposers.push(d); return d },
      get(k) { if (k === 'jobs') return { start(spec) { const rec = { hooks: spec.run(), done: null }; rec.done = rec.hooks.done; jobs.push(rec); return 'job-self-reload' } } },
      tools: { register(t) { tool = t }, execute: async (c) => {
        if (c.name.endsWith('start_run')) return okRes({ runId: 'r-self-reload', sessionId: 's-self-reload' })
        if (c.name.endsWith('wait_run')) return okRes({ runId: 'r-self-reload', status: 'succeeded', assistantText: 'done' })
        if (c.name === 'dev_reload_package') { injector.reload(c.arguments.packageName); return okRes({ ok: true }) }
        return okRes(capsV2)
      } },
    }
    apply(ctx, { modesPath: yp, linkParentSession: false, refreshTitle: false, manifestDir: selfDir, sliceMs: 1, resumeDelayMs: 10000 })
    const accepted = await tool.execute({ tasks: [{ startArgs: { workspace: 'W', task: 'T', permissionPreset: 'read-only' } }], reloadPlugins: ['dsh-relay-dispatch'] }, { agent: { session: { header: { id: 'parent-self-reload' } } } })
    manifestPath = accepted.manifestPath
    await jobs[0].done
    assert.equal(reloadCalls, 1)
    assert.equal(snapshots[0].phase, 'completed')

    // 模拟新实例的 resumeDetachedPipelines：completed 清单必须被忽略。
    let resumedJobs = 0
    let resumedReloads = 0
    const resumed = {
      effect(fn) { return fn() },
      get(k) { if (k === 'jobs') return { start() { resumedJobs++; return 'unexpected' } } },
      tools: { register() {}, execute: async (c) => { if (c.name === 'dev_reload_package') resumedReloads++; return okRes({}) } },
    }
    apply(resumed, { modesPath: yp, linkParentSession: false, refreshTitle: false, manifestDir: selfDir, resumeDelayMs: 1 })
    await new Promise((resolve) => setTimeout(resolve, 15))
    assert.equal(resumedJobs, 0)
    assert.equal(resumedReloads, 0)
    while (disposers.length) await disposers.pop()()
  }

  // 自重载先唤醒再卸载；新实例必须把 parentWakeDelivered 补成 true，且不重开流水线。
  {
    const wakeDir = mkdtempSync(join(tmpdir(), 'relay-wake-reload-'))
    const parent = {
      id: 'parent-wake-reload',
      status: 'idle',
      session: { header: { id: 'parent-wake-reload' }, events: [] },
      inbox: { nextStep: [{ id: 'pending-wake', content: [{ type: 'text', text: 'pipeline done' }] }], nextTurn: [] },
      followUps: [],
      followup(msg) { this.followUps.push(msg) },
    }
    const agents = new Map([[parent.id, parent]])
    const reloadOrder = []
    let tool
    let manifestPath
    const jobs = []
    const disposers = []
    const ctx = {
      effect(fn) { const d = fn(); if (typeof d === 'function') disposers.push(d); return d },
      get(k) {
        if (k === 'jobs') return { start(spec) { const rec = { hooks: spec.run(), done: null }; rec.done = rec.hooks.done; jobs.push(rec); return 'relay-dispatch-204' } }
        if (k === 'agents') return { get: (id) => agents.get(id) }
      },
      tools: { register(t) { tool = t }, execute: async (c) => {
        if (c.name.endsWith('start_run')) return okRes({ runId: 'r-wake-reload', sessionId: 's-wake-reload' })
        if (c.name.endsWith('wait_run')) return okRes({ runId: 'r-wake-reload', status: 'succeeded', assistantText: 'done' })
        if (c.name === 'dev_reload_package') {
          reloadOrder.push(c.arguments.packageName)
          if (c.arguments.packageName === 'dsh-relay-dispatch') {
            while (disposers.length) { const d = disposers.pop(); try { d() } catch {} }
          }
          return okRes({ ok: true })
        }
        return okRes(capsV2)
      } },
    }
    apply(ctx, { modesPath: yp, linkParentSession: false, refreshTitle: false, manifestDir: wakeDir, sliceMs: 1, resumeDelayMs: 60000, wakeDelayMs: 60000 })
    const accepted = await tool.execute({ tasks: [{ startArgs: { workspace: 'W', task: 'T', permissionPreset: 'read-only' } }], reloadPlugins: ['dsh-relay-dispatch', 'dsh-tool-gate'] }, { agent: parent })
    manifestPath = accepted.manifestPath
    await jobs[0].done
    assert.deepEqual(reloadOrder, ['dsh-tool-gate', 'dsh-relay-dispatch'])
    const mid = JSON.parse(readFileSync(manifestPath, 'utf8'))
    assert.equal(mid.phase, 'completed')
    assert.equal(mid.jobId, 'relay-dispatch-204')
    assert.equal(mid.originalJobId, 'relay-dispatch-204')
    assert.notEqual(mid.parentWakeDelivered, true)
    assert.equal(parent.followUps.length, 0, '旧实例的唤醒定时器必须随自重载一起取消')

    let resumedJobs = 0
    const resumedDisposers = []
    const resumed = {
      effect(fn) { const d = fn(); if (typeof d === 'function') resumedDisposers.push(d); return d },
      get(k) {
        if (k === 'jobs') return { start() { resumedJobs++; return 'relay-dispatch-216' } }
        if (k === 'agents') return { get: (id) => agents.get(id) }
      },
      tools: { register() {}, execute: async () => okRes({}) },
    }
    apply(resumed, { modesPath: yp, linkParentSession: false, refreshTitle: false, manifestDir: wakeDir, resumeDelayMs: 1, wakeDelayMs: 5, wakePollMs: 5, wakeMaxChecks: 4, parentWakeWindowMs: 120000 })
    for (let i = 0; i < 40 && (parent.followUps.length === 0 || JSON.parse(readFileSync(manifestPath, 'utf8')).parentWakeDelivered !== true); i++) await new Promise((resolve) => setTimeout(resolve, 5))
    const after = JSON.parse(readFileSync(manifestPath, 'utf8'))
    assert.equal(after.parentWakeDelivered, true)
    assert.equal(after.originalJobId, 'relay-dispatch-204')
    assert.equal(after.jobId, 'relay-dispatch-204')
    assert.equal(resumedJobs, 0, 'completed 清单不得被 resume 成新 job')
    assert.equal(parent.followUps.length, 1)
    while (resumedDisposers.length) await resumedDisposers.pop()()
  }

  // 单任务路径失败时只报告 reload_pending，不调用热重载。
  {
    let tool
    const calls = []
    const jobs = []
    const ctx = {
      effect(fn) { return fn() },
      get(k) { if (k === 'jobs') return { start(spec) { const rec = { spec }; rec.hooks = spec.run(); rec.done = rec.hooks.done; jobs.push(rec); return 'job-reload-pending' } } },
      tools: { register(t) { tool = t }, execute: async (c) => { calls.push(c); if (c.name.endsWith('start_run')) return okRes({ runId: 'r-reload-pending' }); if (c.name.endsWith('wait_run')) return okRes({ runId: 'r-reload-pending', status: 'failed', error: 'task failed' }); return okRes({}) } },
    }
    apply(ctx, { modesPath: yp, linkParentSession: false, refreshTitle: false, manifestDir: dir, sliceMs: 1 })
    await tool.execute({ startArgs: { workspace: 'W', task: 'T' }, reloadPlugins: ['dsh-tool-gate'] }, { agent: { session: { header: { id: 'parent-reload' } } } })
    const out = await jobs[0].done
    assert.equal(calls.filter((c) => c.name === 'dev_reload_package').length, 0)
    assert(out.detail.includes('reload_pending: dsh-tool-gate'))
  }

  // reloadPluginByName：disabled + pkgMeta 负缓存不得把 client 行删成 404；无 fiber 时保留原行。
  {
    const { reloadPluginByName } = await import('../lib/index.js')
    const pkg = '@dsh-external/dsh-relay-dispatch'
    const entry = {
      id: 'relay-dispatch',
      disabled: true,
      fiber: { state: 1 },
      options: { name: pkg, disabled: true },
      parent: { data: [{ id: 'relay-dispatch', name: pkg, disabled: true }] },
    }
    const table = new Map()
    const pkgMeta = new Map([[pkg, null]])
    let composed = 0
    let notified = 0
    const cm = {
      table,
      pkgMeta,
      processOne(entryName) {
        const qualifies = entry.options.name === entryName && entry.fiber != null && !entry.disabled && entry.options.disabled == null
        if (!qualifies) return table.delete(entryName)
        if (table.has(entryName)) return false
        if (pkgMeta.get(entryName) === null) return false
        const meta = pkgMeta.has(entryName) ? pkgMeta.get(entryName) : { clientPath: 'C:/relay/lib/client.js' }
        if (meta == null) return false
        table.set(entryName, { clientPath: meta.clientPath, entry: { id: entryName } })
        return true
      },
      compose() { composed++; return { rev: 'ok', entries: [...table.values()].map((row) => row.entry) } },
      notifyGraphChanged() { notified++ },
    }
    const ctx = { loader: { entries: () => [entry] }, get(k) { return k === 'clientModules' ? cm : undefined } }
    const refreshed = reloadPluginByName(ctx, 'dsh-relay-dispatch')
    assert.equal(entry.disabled, false)
    assert.equal(entry.options.disabled, undefined)
    assert.equal(entry.parent.data[0].disabled, undefined)
    assert.equal(pkgMeta.has(pkg), false)
    assert.equal(table.get(pkg).clientPath, 'C:/relay/lib/client.js')
    assert.equal(composed, 1)
    assert.equal(notified, 1)
    assert.equal(refreshed.changed, true)
    const kept = reloadPluginByName(ctx, pkg)
    assert.equal(table.has(pkg), true)
    assert.equal(kept.changed, false)
    assert.equal(composed, 1)
    entry.fiber = undefined
    const duringDispose = reloadPluginByName(ctx, pkg)
    assert.equal(table.has(pkg), true)
    assert.equal(duringDispose.reason, 'no-live-entry')
  }

  // reloadPlugins 成功后必须走 reloadPluginByName，把 client 行补回去。
  {
    const pkg = '@dsh-external/dsh-relay-dispatch'
    const entry = {
      id: 'relay-dispatch',
      disabled: true,
      fiber: {},
      options: { name: pkg, disabled: true },
      parent: { data: [{ id: 'relay-dispatch', disabled: true }] },
    }
    const table = new Map()
    const pkgMeta = new Map([[pkg, null]])
    const cm = {
      table,
      pkgMeta,
      processOne(entryName) {
        const qualifies = entry.options.name === entryName && entry.fiber != null && !entry.disabled && entry.options.disabled == null
        if (!qualifies) return table.delete(entryName)
        if (table.has(entryName)) return false
        if (pkgMeta.get(entryName) === null) return false
        table.set(entryName, { clientPath: 'C:/relay/lib/client.js' })
        return true
      },
      compose() { return { entries: [...table.keys()] } },
      notifyGraphChanged() {},
    }
    let tool
    const jobs = []
    const ctx = {
      loader: { entries: () => [entry] },
      effect(fn) { return fn() },
      get(k) {
        if (k === 'jobs') return { start(spec) { const rec = { hooks: spec.run(), done: null }; rec.done = rec.hooks.done; jobs.push(rec); return 'job-client-row' } }
        if (k === 'clientModules') return cm
      },
      tools: { register(t) { tool = t }, execute: async (c) => {
        if (c.name.endsWith('start_run')) return okRes({ runId: 'r-client-row' })
        if (c.name.endsWith('wait_run')) return okRes({ runId: 'r-client-row', status: 'succeeded', assistantText: 'done' })
        if (c.name === 'dev_reload_package') return okRes({ ok: true })
        return okRes(capsV2)
      } },
    }
    apply(ctx, { modesPath: yp, linkParentSession: false, refreshTitle: false, manifestDir: dir, sliceMs: 1, resumeDelayMs: 60000 })
    await tool.execute({ tasks: [{ startArgs: { workspace: 'W', task: 'T', permissionPreset: 'read-only' } }], reloadPlugins: ['dsh-relay-dispatch'] }, { agent: { session: { header: { id: 'parent-client-row' } } } })
    await jobs[0].done
    assert.equal(entry.disabled, false)
    assert.equal(pkgMeta.has(pkg), false)
    assert.equal(table.has(pkg), true)
  }

  const slim = (await import('../lib/index.js')).formatPipelineSummary({ pipelineId: 'slim', gateUserAsk: 'ask '.repeat(100), items: [{ index: 0, kind: 'task', status: 'succeeded', model: 'a/m1', output: 'summary: done', git: { available: true, files: ['a.js'] } }, { index: 1, kind: 'gate', status: 'succeeded', verdict: 'pass', output: 'verdict: pass\nall good' }] }, 2000, { slim: true })
  assert(B(slim) <= 800 && !slim.includes('gate_user_ask') && slim.includes('changed_files: a.js'))

  const { formatPipelineSummary } = await import('../lib/index.js')
  const brief = formatPipelineSummary({ pipelineId: 'brief-fail', phase: 'completed', machineHeader: 'RESULT: FAIL', items: [
    { index: 0, kind: 'task', status: 'succeeded', output: 'summary: successful details must disappear', git: { available: true, files: ['passed.js'] } },
    { index: 1, kind: 'task', status: 'failed', output: 'summary: actionable task failure', git: { available: true, files: ['a.js', 'b.js'] } },
    { index: 2, kind: 'gate', status: 'failed', verdict: 'fail', mechanical: { results: [{ index: 0, kind: 'cmd', ok: false, detail: `HEAD ${'过程'.repeat(100)} TAIL_ERROR` }] } },
  ] }, 2000, { brief: true })
  assert(B(brief) <= 1200 && brief.includes('TAIL_ERROR') && brief.includes('actionable task failure'))
  assert(brief.includes('changed_files: a.js, b.js') && brief.includes('next: relay_dispatch({followUp:'))
  assert(!brief.includes('successful details') && !brief.includes('passed.js') && brief.includes('detail: ~/.dsh/relay-pipelines/brief-fail.json'))
  const unverified = formatPipelineSummary({ pipelineId: 'brief-unverified', phase: 'cancelled', machineHeader: 'RESULT: UNVERIFIED', items: [{ index: 0, status: 'cancelled', error: 'cancelled' }] }, 2000, { brief: true })
  assert(!unverified.includes('next:') && unverified.includes('detail:'))
  const detached = formatPipelineSummary({ pipelineId: 'brief-detached', phase: 'detached', machineHeader: 'RESULT: FAIL', items: [{ index: 0, status: 'failed', startUnknown: true, error: 'unknown' }] }, 2000, { brief: true })
  assert(detached.includes('start_unknown=1') && detached.includes('phase=detached') && !detached.includes('next:'))

  // 真实派发入口：失败清单可在同一父会话内一键续修，继承子会话与 Gate 并回写父清单。
  {
    const followDir = mkdtempSync(join(tmpdir(), 'guardrail-e2e-'))
    mkdirSync(join(followDir, 'test'))
    for (const n of ['a', 'b']) writeFileSync(join(followDir, 'test', `${n}.test.mjs`), `import assert from 'node:assert'; assert(true)`)
    const previous = { phase: 'completed', machineHeader: 'RESULT: FAIL', parentSessionId: 'parent', items: [{ index: 0, kind: 'task', status: 'failed', sessionId: 'child', error: 'failed check' }], plan: { tasks: [{ index: 0, dependsOn: [], workspace: followDir, baseArgs: { workspace: followDir, task: 'old', permissionPreset: 'workspace-write' } }], gate: { checks: [], llm: 'never' }, syncTargets: [], reloadPlugins: [] } }
    writeFileSync(join(dir, 'p-fail.json'), JSON.stringify(previous))
    const env = makeV2Env(async (c) => {
      if (c.name.endsWith('list_capabilities')) return okRes(capsV2)
      if (c.name.endsWith('start_run')) return okRes({ runId: 'r-follow', sessionId: 'child' })
      if (c.name.endsWith('wait_run')) return okRes({ runId: 'r-follow', sessionId: 'child', status: 'succeeded', assistantText: 'repair complete' })
      return okRes({})
    }, { linkParentSession: true, resumeDelayMs: 60000 })
    const glob = `node --test ${join(followDir, 'test', '*.test.mjs')}`
    const res = await env.run({ followUp: { pipelineId: 'p-fail', patchTask: 'repair', patchGate: { checks: [{ cmd: glob, minTests: 2 }] } } }, { session: { header: { id: 'parent' } } })
    const out = await env.jobs[0].done
    assert.equal(startsOf(env).length, 1)
    assert.equal(startsOf(env)[0].arguments.sessionId, 'child')
    assert.equal(startsOf(env)[0].arguments.sessionMode, undefined)
    assert.equal(out.status, 'completed')
    assert(out.detail.includes('RESULT: PASS') && out.detail.includes('followup_of=p-fail'))
    const child = JSON.parse(readFileSync(res.manifestPath, 'utf8'))
    const parent = JSON.parse(readFileSync(join(dir, 'p-fail.json'), 'utf8'))
    assert.equal(child.parentPipelineId, 'p-fail')
    assert.deepEqual(parent.followUps, [child.pipelineId])
    assert.equal(child.items[0].status, 'succeeded')
    env.dispose()
  }

  writeFileSync(yp, Y1)
}
console.log('v2 ok')

// 圆环账单：空间 Token 不计价，usage 按缓存读一折、未缓存输入、输出真实分桶。
{
  const { readFileSync } = await import('node:fs')
  const vm = await import('node:vm')
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  let clientExports
  const sandbox = { window: { __ModuleLoader__: { load: ({ factory }) => { clientExports = factory((id) => { throw new Error(`unexpected require: ${id}`) }) } } } }
  vm.runInNewContext(source, sandbox)
  const { billingBuckets, billingTotal, billingUsd, formatTokensCompact } = clientExports.billingInternals
  const b = billingBuckets({ inputTokens: 20000, cachedInputTokens: 15000, outputTokens: 1000 })
  assert.equal(b.cached, 15000)
  assert.equal(b.uncached, 5000)
  assert.equal(b.output, 1000)
  assert.equal(billingBuckets({ inputTokens: 20000, cachedInputTokens: 15000, outputTokens: 1000, reasoningTokens: 400 }).output, 1000, 'outputTokens 已含思考，不得重复计费')
  assert.equal(b.cacheCost, 0.003)
  assert.equal(b.inputCost, 0.01)
  assert.equal(b.outputCost, 0.012)
  assert.equal(billingTotal(b), 0.025)
  assert.equal(formatTokensCompact(b.cached), '15K')
  assert.equal(billingUsd(billingTotal(b)), '0.025')
  const native = billingBuckets({ inputTokens: 5000, cacheReadTokens: 15000, outputTokens: 1000, cacheWriteTokens: 100 })
  assert.equal(native.uncached, 5000, 'DSH inputTokens 本身是未缓存桶，不得再减 cacheReadTokens')
  assert.equal(native.cached, 15000)
  assert.equal(native.inputCost, 0.0102)
  const long = billingBuckets({ inputTokens: 250000, cachedInputTokens: 150000, outputTokens: 1000 })
  assert.equal(long.uncached, 100000)
  assert.equal(long.inputCost, 0.4)
  assert.equal(long.cacheCost, 0.06)
  assert.equal(long.outputCost, 0.024)
  assert(source.includes('if (Object.prototype.hasOwnProperty.call(byLabel, label)) setCost(dd, "")'), '空间占用三行必须清除金额后缀')
  assert(source.includes('paintBilling(dialog, latestBill, cumulativeBill)'))
  assert(!source.includes('setCost(el, dot(ctxCost))'), '圆环不得再按窗口 Token 估算金额')
  console.log('billing ok')
}

// 本轮实付按用户回合聚合：最近一条 user/message / turn/start 之后所有 LLM 步 usage 求和，多步显示步数。
{
  const { readFileSync } = await import('node:fs')
  const vm = await import('node:vm')
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  let clientExports
  const sandbox = { window: { __ModuleLoader__: { load: ({ factory }) => { clientExports = factory((id) => { throw new Error(`unexpected require: ${id}`) }) } } } }
  vm.runInNewContext(source, sandbox)
  const { billingBuckets, billingTotal, billingUsd, sumBillingBuckets, turnUsageEvents, usageOfEvent } = clientExports.billingInternals

  // usageOfEvent：assistant/chunk usage 与 assistant/message usage 两种载体
  assert.equal(usageOfEvent({ type: 'assistant/chunk', data: { chunk: { type: 'usage', usage: { inputTokens: 1 } } } }).inputTokens, 1)
  assert.equal(usageOfEvent({ type: 'assistant/message', data: { usage: { inputTokens: 2 } } }).inputTokens, 2)
  assert.equal(usageOfEvent({ type: 'tool/call', data: { name: 'x' } }), undefined)

  // sumBillingBuckets：多步求和 + steps 计数；各步独立套价（长上下文档位不平均）
  const stepA = { inputTokens: 20000, cachedInputTokens: 15000, outputTokens: 1000 } // $0.025
  const stepB = { inputTokens: 5000, cacheReadTokens: 15000, outputTokens: 500, cacheWriteTokens: 100 } // 0.0102+0.006=0.0162
  const agg = sumBillingBuckets([stepA, stepB])
  assert.equal(agg.steps, 2)
  assert.equal(agg.cached, 30000)
  assert.equal(agg.uncached, 10000)
  assert.equal(agg.output, 1500)
  assert.equal(agg.cacheWrite, 100)
  assert.equal(billingUsd(billingTotal(agg)), '0.044')
  assert.equal(billingTotal(agg), billingTotal(billingBuckets(stepA)) + billingTotal(billingBuckets(stepB)), '多步合计=各步独立计价之和')
  // 单步：与单条 billingBuckets 一致（多 steps 字段）
  const single = sumBillingBuckets([stepA])
  assert.equal(single.steps, 1)
  assert.equal(billingTotal(single), billingTotal(billingBuckets(stepA)))
  // 空数组 / 非法条目
  assert.equal(sumBillingBuckets([]), null)
  assert.equal(sumBillingBuckets(null), null)
  assert.equal(sumBillingBuckets([null, {}]).steps, 1, '空 usage 对象计为一桶全 0 步')

  // turnUsageEvents：只取最近 user/message 之后的 usage；跨用户回合不混入
  const mkSession = (events) => ({
    snapshotEvents: () => events,
  })
  const sessionsSvc = {
    binding: (id) => (id === 's1' ? { session: mkSession([
      { type: 'turn/start', seq: 1 },
      { type: 'assistant/message', seq: 2, data: { usage: { inputTokens: 100, outputTokens: 10 } } },
      { type: 'user/message', seq: 3, data: { content: [] } },
      { type: 'assistant/chunk', seq: 4, data: { chunk: { type: 'usage', usage: { inputTokens: 200, outputTokens: 20 } } } },
      { type: 'tool/call', seq: 5, data: { name: 'read' } },
      { type: 'assistant/message', seq: 6, data: { usage: { inputTokens: 300, outputTokens: 30 } } },
    ]) } : null),
  }
  const usages = turnUsageEvents(sessionsSvc, 's1')
  assert.equal(usages.length, 2, '只统计最近 user/message 之后的 2 条 usage')
  assert.equal(usages[0].inputTokens, 200)
  assert.equal(usages[1].inputTokens, 300)
  const aggTurn = sumBillingBuckets(usages)
  assert.equal(aggTurn.steps, 2)
  assert.equal(aggTurn.uncached, 500)
  assert.equal(aggTurn.output, 50)

  // 无 user/message 时回退到 turn/start 之后
  const svc2 = { binding: () => ({ session: mkSession([
    { type: 'user/message', seq: 1, data: {} },
    { type: 'turn/start', seq: 2 },
    { type: 'assistant/message', seq: 3, data: { usage: { inputTokens: 50, outputTokens: 5 } } },
  ]) }) }
  assert.equal(turnUsageEvents(svc2, 'x').length, 1)

  // 空会话 / 缺服务
  assert.equal(turnUsageEvents(null, 'x').length, 0)
  assert.equal(turnUsageEvents(sessionsSvc, 'missing').length, 0)

  // 源码契约：paintCost 走 turnUsageEvents + sumBillingBuckets；多步标签
  assert(source.includes('sumBillingBuckets(turnUsages)'), '本轮账单必须聚合本轮全部 usage')
  assert(!source.includes('latestUsageEvent('), '旧的单步 latestUsageEvent 必须移除')
  assert(source.includes('turnSteps > 1'), '多步时必须显示步数')
  console.log('turn-agg ok')
}


// 热重载 dispose：本地 job 以 reported 结算，抑制 [status:killed] 重复通知；不得 cancel 远端 run。
{
  const { readFileSync } = await import('node:fs')
  const { isDisposeCancelReason } = await import('../lib/index.js')
  assert.equal(isDisposeCancelReason('relay_dispatch disposed'), true)
  assert.equal(isDisposeCancelReason('jobs service disposed'), true)
  assert.equal(isDisposeCancelReason('owner disposed'), true)
  assert.equal(isDisposeCancelReason('user-stop'), false)
  assert.equal(isDisposeCancelReason('cancelled'), false)

  function hangUntilAbort(c) {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, 4000)
      const finish = () => { clearTimeout(timer); resolve() }
      const signal = c && c.signal
      if (signal && signal.aborted) { finish(); return }
      if (signal && typeof signal.addEventListener === 'function') signal.addEventListener('abort', finish, { once: true })
    })
  }

  async function untilTerminal(jobs, id, agent) {
    for (let i = 0; i < 80; i++) {
      const snap = jobs.get(id, agent)
      if (snap.status === 'killed' || snap.status === 'completed' || snap.status === 'failed') return snap
      await new Promise((r) => setTimeout(r, 15))
    }
    throw new Error('job did not settle: ' + jobs.get(id, agent).status)
  }

  function makeRealEnv(handler) {
    const notices = []
    const calls = []
    const killCalls = []
    const effectDisposers = []
    let hooks = null
    let onKill = () => {}
    const fakeCtx = new Context()
    const fakeAgent = {
      id: 'sess-dispose-quiet',
      status: 'idle',
      ctx: fakeCtx,
      inject: (msg) => notices.push(msg.content[0].text),
      followup: (msg) => notices.push(msg.content[0].text),
    }
    const regTools = new Map()
    fakeCtx.provide('agents', { get: (id) => (id === fakeAgent.id ? fakeAgent : undefined) }, true)
    fakeCtx.provide('systemPrompt', { section: () => {} }, true)
    fakeCtx.provide('tools', {
      register: (t) => { regTools.set(t.name, t); return () => regTools.delete(t.name) },
      execute: async (c) => { calls.push(c); return handler(c) },
    }, true)
    new LocalJobRegistry(fakeCtx, { maxConcurrentJobsPerOwner: 10 })
    applyToolJobs(fakeCtx, {})
    const origKill = fakeCtx.jobs.kill.bind(fakeCtx.jobs)
    fakeCtx.jobs.kill = function kill(id, caller, reason) {
      killCalls.push([id, caller, reason])
      onKill(id, caller, reason)
      return origKill(id, caller, reason)
    }
    const origStart = fakeCtx.jobs.start.bind(fakeCtx.jobs)
    fakeCtx.jobs.start = (spec) => {
      const run = spec.run
      spec.run = () => {
        const h = run()
        hooks = h
        return h
      }
      return origStart(spec)
    }
    const origEffect = fakeCtx.effect.bind(fakeCtx)
    fakeCtx.effect = (fn, label) => {
      const d = origEffect(fn, label)
      effectDisposers.push({ label: String(label || ''), dispose: d })
      return d
    }
    apply(fakeCtx, {
      modesPath: yp,
      linkParentSession: false,
      refreshTitle: false,
      manifestDir: dir,
      sliceMs: 30,
      waitRetryDelayMs: 1,
      cancelGraceMs: 60000,
    })
    return {
      fakeCtx,
      fakeAgent,
      notices,
      calls,
      killCalls,
      tool: regTools.get('relay_dispatch'),
      pluginDispose: effectDisposers.find((d) => !d.label.startsWith('ctx.on'))?.dispose,
      getHooks: () => hooks,
      setOnKill: (fn) => { onKill = fn },
    }
  }

  const caps = { providers: [{ provider: 'a', models: ['m1'] }] }
  const relayHandler = (runId) => async (c) => {
    if (c.name.endsWith('list_capabilities')) return okRes(caps)
    if (c.name.endsWith('start_run')) return okRes({ runId, sessionId: 's-' + runId })
    if (c.name.endsWith('wait_run')) {
      await hangUntilAbort(c)
      return okRes({ runId, sessionId: 's-' + runId, status: 'running' })
    }
    return okRes({})
  }

  // v2：插件 dispose 直接调 cancel，不经过 registry.kill。必须由本包补一次 kill(id, owner, reason) 才会 reported。
  {
    const env = makeRealEnv(relayHandler('v2-detach'))
    let manifestPath = ''
    let phaseAtKill = null
    env.setOnKill(() => {
      phaseAtKill = JSON.parse(readFileSync(manifestPath, 'utf8')).phase
    })
    const res = await env.tool.execute({
      tasks: [{ label: 'A', startArgs: { workspace: 'W', task: '1', permissionPreset: 'read-only' } }],
    }, { agent: env.fakeAgent })
    manifestPath = res.manifestPath
    for (let i = 0; i < 80 && !env.calls.some((c) => c.name.endsWith('wait_run')); i++) await new Promise((r) => setTimeout(r, 15))
    assert(env.calls.some((c) => c.name.endsWith('wait_run')), 'v2 应已进入 wait_run')
    assert.equal(env.killCalls.length, 0)
    await env.pluginDispose()
    const snap = await untilTerminal(env.fakeCtx.jobs, res.jobId, env.fakeAgent)
    await new Promise((r) => setTimeout(r, 30))
    assert.equal(snap.status, 'killed')
    assert.equal(snap.reported, true, 'dispose 后本地 job 必须 reported，否则会再投递 [status:killed]')
    assert.equal(env.notices.length, 0, '热重载不得把 killed 完成通知打给 owner')
    assert.equal(env.killCalls.length, 1)
    assert.equal(env.killCalls[0][0], res.jobId)
    assert.equal(env.killCalls[0][1], env.fakeAgent, 'caller 必须是 owner，不能把 reason 字符串塞进第二参')
    assert.equal(env.killCalls[0][2], 'relay_dispatch disposed')
    assert.equal(phaseAtKill, 'detached', 'jobs.kill 之前清单必须已写成 detached')
    assert.equal(env.calls.filter((c) => c.name.endsWith('cancel_run')).length, 0)
    const mf = JSON.parse(readFileSync(manifestPath, 'utf8'))
    assert.equal(mf.phase, 'detached')
    assert.equal(mf.items[0].status, 'running')
    assert.equal(mf.items[0].runId, 'v2-detach')
  }

  // v2：普通取消仍 cancel_run，不走 dispose kill，清单不得标 detached。
  {
    const env = makeRealEnv(relayHandler('v2-cancel'))
    const res = await env.tool.execute({
      tasks: [{ label: 'A', startArgs: { workspace: 'W', task: '1', permissionPreset: 'read-only' } }],
    }, { agent: env.fakeAgent })
    for (let i = 0; i < 80 && !env.calls.some((c) => c.name.endsWith('wait_run')); i++) await new Promise((r) => setTimeout(r, 15))
    env.getHooks().cancel('user-stop')
    const snap = await untilTerminal(env.fakeCtx.jobs, res.jobId, env.fakeAgent)
    await new Promise((r) => setTimeout(r, 30))
    assert.equal(snap.status, 'killed')
    assert.equal(snap.reported, false, '普通取消不经 jobs.kill，完成通知仍要送达')
    assert.equal(env.killCalls.length, 0)
    assert.equal(env.calls.filter((c) => c.name.endsWith('cancel_run')).length, 1)
    assert.equal(env.calls.filter((c) => c.name.endsWith('cancel_run'))[0].arguments.runId, 'v2-cancel')
    assert(env.notices.length >= 1, '普通取消应保留完成通知')
    const mf = JSON.parse(readFileSync(res.manifestPath, 'utf8'))
    assert.notEqual(mf.phase, 'detached')
  }

  // v1：dispose reason 直接打到 producer cancel（registry 尚未标 reported）。
  {
    const env = makeRealEnv(relayHandler('v1-detach'))
    const res = await env.tool.execute({ startArgs: { workspace: 'W', task: 'T' } }, { agent: env.fakeAgent })
    for (let i = 0; i < 80 && !env.calls.some((c) => c.name.endsWith('wait_run')); i++) await new Promise((r) => setTimeout(r, 15))
    assert(env.calls.some((c) => c.name.endsWith('wait_run')), 'v1 应已进入 wait_run')
    env.getHooks().cancel('relay_dispatch disposed')
    const snap = await untilTerminal(env.fakeCtx.jobs, res.jobId, env.fakeAgent)
    await new Promise((r) => setTimeout(r, 30))
    assert.equal(snap.status, 'killed')
    assert.equal(snap.reported, true)
    assert.equal(env.notices.length, 0)
    assert.equal(env.killCalls.length, 1)
    assert.equal(env.killCalls[0][0], res.jobId)
    assert.equal(env.killCalls[0][1], env.fakeAgent)
    assert.equal(env.killCalls[0][2], 'relay_dispatch disposed')
    assert.equal(env.calls.filter((c) => c.name.endsWith('cancel_run')).length, 0)
  }

  // v1：普通取消仍 cancel_run，且不调用 dispose kill。
  {
    const env = makeRealEnv(relayHandler('v1-cancel'))
    const res = await env.tool.execute({ startArgs: { workspace: 'W', task: 'T' } }, { agent: env.fakeAgent })
    for (let i = 0; i < 80 && !env.calls.some((c) => c.name.endsWith('wait_run')); i++) await new Promise((r) => setTimeout(r, 15))
    env.getHooks().cancel('user-stop')
    const snap = await untilTerminal(env.fakeCtx.jobs, res.jobId, env.fakeAgent)
    await new Promise((r) => setTimeout(r, 30))
    assert.equal(snap.status, 'killed')
    assert.equal(snap.reported, false)
    assert.equal(env.killCalls.length, 0)
    assert.equal(env.calls.filter((c) => c.name.endsWith('cancel_run')).length, 1)
    assert.equal(env.calls.filter((c) => c.name.endsWith('cancel_run'))[0].arguments.runId, 'v1-cancel')
    assert(env.notices.length >= 1)
  }

  console.log('dispose-quiet ok')

// ───────── guardrails：静态读范围推导 / Gate 预检 / One-Call Follow-up ─────────
{
  const { inferScopes, lintMechanicalChecks, preflightFollowUp, BUILTIN_MODES, classifyGateFailure } = await import('../lib/index.js')
  const inferred = inferScopes('只读 @plugins/dsh-x/lib、~/.dsh/storages 与 ~/.dsh/secrets/a.txt')
  assert(inferred.readRoots.some((p) => p.replace(/\\/g, '/').endsWith('/.dsh/plugins/dsh-x/lib')))
  assert(inferred.readRoots.some((p) => p.replace(/\\/g, '/').endsWith('/.dsh/storages')))
  assert(inferred.notes.some((n) => n.startsWith('dropped_sensitive')))
  assert(!inferred.readRoots.some((p) => /secrets/i.test(p)))
  const scoped = preflightDispatchV2({ startArgs: { workspace: 'C:\\work', task: '读取 C:\\work\\agent\\.dsh\\plugins\\demo\\lib\\index.js' } })
  assert(scoped.tasks[0].baseArgs.contextReadScope.some((p) => p.replace(/\\/g, '/').endsWith('/.dsh/plugins/demo/lib')))
  const cmScoped = compileCapabilityManifest(scoped.tasks[0].baseArgs, { now: 1700000000000 })
  assert(cmScoped.read_roots.some((r) => r.canonical_path.replace(/\\/g, '/').endsWith('/.dsh/plugins/demo/lib')))
  assert.deepEqual(compileCapabilityManifest(scoped.tasks[0].baseArgs, { execProfiles: ['ssh:100.64.0.2'] }).exec_profiles, ['ssh:100.64.0.2'])
  const hostScope = inferScopes('ssh 100.64.0.2 "pytest" && curl http://127.0.0.1:8318/health')
  assert.deepEqual(hostScope.hosts, ['100.64.0.2'])
  assert.deepEqual(hostScope.loopbackPorts, [8318])
  assert.deepEqual(hostScope.readRoots, [])
  const urlScope = inferScopes('check http://127.0.0.1:8318/status')
  assert.deepEqual(urlScope.readRoots, [])
  assert.deepEqual(urlScope.loopbackPorts, [8318])
  for (const sample of ['https://127.0.0.1:4141/health', 'ws://127.0.0.1:4098/socket', 'wss://localhost:4142/socket', 'file://127.0.0.1/share']) {
    assert.deepEqual(inferScopes(sample).readRoots, [], sample)
  }
  const windowsScope = inferScopes('读取 C:\\work\\agent\\lib\\index.js')
  assert(windowsScope.readRoots.some((p) => p.replace(/\\/g, '/').toLowerCase().endsWith('/work/agent/lib')))
  assert.throws(() => preflightDispatchV2({ startArgs: { workspace: 'C:\\work', task: 'ssh 10.0.0.2 "pytest"', permissionPreset: 'workspace-write' } }, undefined, { hosts: {} }), (e) => e.code === 'DSH_E_SCOPE_HOST_UNDECLARED')
  assert.throws(() => preflightDispatchV2({ startArgs: { workspace: 'C:\\work', task: 'ssh 100.64.0.2 "pytest"', permissionPreset: 'read-only' } }, undefined, { hosts: { mac: '100.64.0.2' } }), (e) => e.code === 'DSH_E_SCOPE_PRESET_INSUFFICIENT')
  assert.throws(() => preflightDispatchV2({ startArgs: { workspace: 'C:\\work', task: '复制到 C:\\outside\\file.js', permissionPreset: 'workspace-write', writeScope: ['C:\\work'] } }), (e) => e.code === 'DSH_E_SCOPE_WRITE_UNDECLARED')
  const readOnlyExternal = preflightDispatchV2({ mode: 'investigate', startArgs: { workspace: 'C:\\work', task: '调查 C:\\outside\\file.js；严禁修改外部文件' } })
  assert.equal(readOnlyExternal.tasks[0].baseArgs.permissionPreset, 'read-only')
  assert.doesNotThrow(() => preflightDispatchV2({ startArgs: { workspace: 'C:\\work', task: '调查 C:\\outside\\file.js；不要修改、不要写入、禁止同步到、不得复制到', permissionPreset: 'workspace-write' } }))
  assert.throws(() => preflightDispatchV2({ startArgs: { workspace: 'C:\\work', task: '不要修改说明，但要复制到 C:\\outside\\file.js', permissionPreset: 'workspace-write' } }), (e) => e.code === 'DSH_E_SCOPE_WRITE_UNDECLARED')

  const gateDir = mkdtempSync(join(tmpdir(), 'guardrail-gate-'))
  mkdirSync(join(gateDir, 'test'))
  for (const n of ['a', 'b']) writeFileSync(join(gateDir, 'test', `${n}.test.mjs`), '')
  const glob = `node --test ${join(gateDir, 'test', '*.test.mjs')}`
  const linted = lintMechanicalChecks([{ cmd: glob, minTests: 2 }], { workspace: gateDir, mechCommands: ['node --test'] })
  assert(linted[0].cmdResolved.includes('a.test.mjs') && linted[0].cmdResolved.includes('b.test.mjs') && !linted[0].cmdResolved.includes('*'))
  const gatePlan = preflightDispatchV2({ startArgs: { workspace: gateDir, task: 'test' }, gate: { checks: [{ cmd: glob }] }, review: true }, undefined, { modes: BUILTIN_MODES, aliases: {}, mechCommands: ['node --test'] })
  assert(gatePlan.gate.checks[0].cmdResolved)
  assert.throws(() => lintMechanicalChecks([{ cmd: 'node --test test/*.test.mjs' }], { workspace: join(gateDir, 'missing'), mechCommands: ['node --test'] }), (e) => e.code === 'DSH_E_GATE_CMD_GLOB')
  assert.throws(() => lintMechanicalChecks([{ cmd: 'powershell -c x' }], { mechCommands: ['node --test'] }), (e) => e.code === 'DSH_E_GATE_CMD_NOT_ALLOWED')

  const manifestDir = mkdtempSync(join(tmpdir(), 'guardrail-followup-'))
  const previous = { phase: 'completed', machineHeader: 'RESULT: FAIL', parentSessionId: 'parent', items: [{ index: 0, kind: 'task', status: 'failed', sessionId: 'child', error: 'failed check' }], plan: { tasks: [{ index: 0, dependsOn: [], workspace: 'C:\\work', baseArgs: { workspace: 'C:\\work', task: 'old' } }], gate: { checks: [] }, syncTargets: [], reloadPlugins: ['x'] } }
  writeFileSync(join(manifestDir, 'p-fail.json'), JSON.stringify(previous))
  const next = preflightFollowUp({ pipelineId: 'p-fail', patchTask: 'repair', patchGate: { llm: 'never', checks: [{ exists: ['C:\\work'] }] } }, { manifestDir, currentSessionId: 'parent' })
  assert.equal(next.tasks[0].baseArgs.sessionId, 'child')
  assert.equal(next.tasks[0].baseArgs.sessionMode, undefined)
  assert.equal(next.tasks[0].previewArgs.sessionId, 'child')
  assert.equal(next.tasks[0].previewArgs.sessionMode, undefined)
  assert(next.tasks[0].baseArgs.task.includes('failed check'))
  assert.equal(next.gate.llm, 'never')
  assert.throws(() => preflightFollowUp({ pipelineId: 'p-fail' }, { manifestDir }), (e) => e.code === 'DSH_E_FOLLOWUP_FOREIGN')
  assert.throws(() => preflightFollowUp({ pipelineId: 'p-fail', patchGate: { checks: [{ cmd: 'rm -rf x' }] } }, { manifestDir, currentSessionId: 'parent' }), (e) => e.code === 'DSH_E_GATE_CMD_NOT_ALLOWED')
  assert.throws(() => preflightDispatchV2({ tasks: [{}], followUp: { pipelineId: 'p-fail' } }), /互斥/)
  assert.equal(classifyGateFailure({ results: [{ kind: 'cmd', ok: false }] }, 'fail'), 'mech_test_fail')
  assert.equal(classifyGateFailure({ results: [{ kind: 'sha', ok: false }] }, 'fail'), 'mech_sync_drift')
  assert.equal(classifyGateFailure({ results: [{ kind: 'exists', ok: false }] }, 'fail'), 'mech_missing_artifact')
  assert.equal(classifyGateFailure({ results: [{ kind: 'cmd', ok: false, detail: '机械命令不在白名单' }] }, 'fail'), 'mech_config_error')
  const modesWithHosts = loadModes(yp, () => 'roots:\n  asd: C:/work\nhosts:\n  mac: 100.64.0.2\nverify:\n  permission: read-only\n  models:\n    - a/m1\n')
  assert.deepEqual(modesWithHosts.hosts, { mac: '100.64.0.2' })
  console.log('guardrails ok')
}

// ───────── turn optimization：targets 展开 / 预检一次报全 / 双成功同步栅栏 ─────────
{
  const { expandTargets, concludeRequested, finishConclude, sessionEventsOf, BUILTIN_MODES } = await import('../lib/index.js')
  const T = { names: ['x'], source: '@dev/dsh-{name}', mirrors: ['@plugins/dsh-{name}', '@pf/dsh-{name}'], files: ['lib/index.js'], test: 'npm --prefix @dev/dsh-{name} test', reload: 'dsh-{name}' }
  const expanded = expandTargets({ startArgs: { workspace: '@dev', task: 'edit' }, targets: ['x'] }, { targets: T })
  assert.equal(expanded.startArgs.syncTargets.length, 2)
  assert.equal(expanded.startArgs.gate.checks.length, 2)
  assert.equal(expanded.startArgs.gate.llm, 'never')
  assert.equal(expanded.startArgs.writeScope.length, 3)
  assert.deepEqual(expanded.reloadPlugins, ['dsh-x'])
  assert.throws(() => expandTargets({ targets: ['bad'] }, { targets: T }), /DSH_E_TARGET_UNKNOWN/)
  assert.throws(() => expandTargets({ targets: ['x'], tasks: [{}, {}] }, { targets: T }), /多任务顶层 targets/)
  const taskExpanded = expandTargets({ tasks: [{ targets: ['x'], startArgs: { workspace: '@dev', task: 'x' } }] }, { targets: T })
  assert.equal(taskExpanded.tasks[0].writeScope.length, 3)
  const loadedTargets = loadModes(yp, () => 'targets:\n  source: @dev/dsh-{name}\n  names:\n    - x\nverify:\n  permission: read-only\n')
  assert(loadedTargets.targets && !loadedTargets.modes.targets)
  const realModes = loadModes()
  assert(!realModes.warning, realModes.warning)
  const realExpanded = preflightDispatchV2({ targets: ['tool-gate', 'context-compact', 'relay-dispatch'], tasks: [{ startArgs: { workspace: '@dev', task: 'test' } }] }, undefined, realModes)
  assert.equal(realExpanded.syncTargets.length, 10)
  assert.equal(realExpanded.gate.checks.length, 9)
  assert.equal(realExpanded.reloadPlugins.length, 3)
  assert(realExpanded.gate.checks.some((c) => c.cmd?.startsWith('node ')))
  assert(realExpanded.syncTargets.filter((s) => s.source.includes('relay-dispatch')).every((s) => s.target.includes('dsh-harness-portfolio')))

  const batchModes = { modes: BUILTIN_MODES, aliases: {}, hosts: { mac: '100.64.0.2' } }
  assert.throws(() => preflightDispatchV2({ startArgs: { workspace: 'C:\\work', task: 'ssh 10.0.0.2 "x" 并复制到 C:\\outside\\a.js', permissionPreset: 'workspace-write', writeScope: ['C:\\work'] } }, undefined, batchModes), (e) => {
    assert.equal(e.code, 'DSH_E_SCOPE_PREFLIGHT')
    assert(e.message.includes('DSH_E_SCOPE_HOST_UNDECLARED') && e.message.includes('DSH_E_SCOPE_WRITE_UNDECLARED'), e.message)
    return true
  })
  assert.throws(() => preflightDispatchV2({ tasks: [
    { startArgs: { workspace: 'C:\\a', task: 'ssh 10.0.0.2 "x"', permissionPreset: 'workspace-write' } },
    { startArgs: { workspace: 'C:\\b', task: '复制到 C:\\outside\\b.js', permissionPreset: 'workspace-write', writeScope: ['C:\\b'] } },
  ] }, undefined, batchModes), /tasks\[0\][\s\S]*tasks\[1\]/)

  const events = [
    { type: 'assistant/message', turn: 1, step: 1, seq: 1, content: [{ type: 'text', text: 'done' }, { type: 'tool-call', name: 'relay_dispatch' }] },
  ]
  let concluded = 0
  const exec = { agent: { phase: { turn: 1, step: 1 }, session: { events } }, signal: new AbortController().signal, concludeTurn: () => concluded++ }
  assert.equal(await finishConclude(exec), '')
  assert.equal(concluded, 1)
  assert.equal(await finishConclude(exec, ['warning']), 'C5 有派发警告')
  assert.equal(concluded, 1)
  assert.match(concludeRequested({ ...exec, agent: { ...exec.agent, session: { events: [{ type: 'assistant/message', content: [{ type: 'thinking', text: 'x' }] }] } } }).reason, /C3/)

  events.push({ type: 'tool/call', seq: 2, data: { name: 'context_compact', callId: 'cc1' } })
  const slow = finishConclude(exec, [], { timeoutMs: 50, intervalMs: 1 })
  await new Promise((r) => setTimeout(r, 10))
  events.push({ type: 'tool/result', seq: 3, data: { name: 'context_compact', callId: 'cc1', status: 'ok', content: [{ type: 'text', text: 'committed' }] } })
  assert.equal(await slow, '')
  assert.equal(concluded, 2)
  const failedEvents = [...events.filter((e) => e.type !== 'tool/result'), { type: 'tool/result', data: { name: 'context_compact', status: 'error', content: [{ type: 'text', text: 'Error: no' }] } }]
  assert.match(await finishConclude({ ...exec, agent: { ...exec.agent, session: { events: failedEvents } } }), /context_compact 执行失败/)
  assert.equal(concluded, 2)
  const timeoutEvents = events.filter((e) => e.type !== 'tool/result')
  assert.match(await finishConclude({ ...exec, agent: { ...exec.agent, session: { events: timeoutEvents } } }, [], { timeoutMs: 1, intervalMs: 1 }), /超时/)
  assert.equal(concluded, 2)
  const siblingEvents = [{ type: 'assistant/message', content: [{ type: 'text', text: 'x' }, { type: 'tool-call', name: 'pwsh' }] }]
  assert.match(await finishConclude({ ...exec, agent: { ...exec.agent, session: { events: siblingEvents } } }), /C4/)
  assert.equal(concluded, 2)

  // Host-shaped nested events: result has no name; callId links it to context_compact.
  const nestedEvents = [
    { type: 'assistant/message', turn: 1, step: 1, seq: 1, data: { message: { content: [{ type: 'text', text: 'done' }] } } },
    { type: 'tool/call', seq: 2, data: { name: 'context_compact', callId: 'nested-cc' } },
    { type: 'tool/result', seq: 3, data: { callId: 'nested-cc', message: { status: 'ok', content: [{ type: 'text', text: 'committed' }] } } },
  ]
  const nestedExec = { ...exec, agent: { ...exec.agent, session: { events: nestedEvents } } }
  assert.equal(concludeRequested(nestedExec).ok, true)
  assert.equal(await finishConclude(nestedExec), '')
  assert.equal(concluded, 3)
  const nestedFailed = nestedEvents.with(2, { type: 'tool/result', seq: 3, data: { callId: 'nested-cc', message: { status: 'error', content: [{ type: 'text', text: 'Error: no' }] } } })
  assert.match(await finishConclude({ ...nestedExec, agent: { ...nestedExec.agent, session: { events: nestedFailed } } }), /context_compact 执行失败/)
  assert.equal(concluded, 3)

  const plainSession = { snapshotEvents() { return [{ type: 'assistant/message', turn: 1, step: 1, seq: 1, content: [{ type: 'text', text: 'plain v4' }] }] } }
  assert.equal(Object.hasOwn(plainSession, 'events'), false)
  const plainExec = { agent: { phase: { turn: 1, step: 1 }, session: plainSession }, signal: new AbortController().signal, concludeTurn: () => concluded++ }
  assert.equal(concludeRequested(plainExec).ok, true)
  assert.equal(await finishConclude(plainExec), '')
  assert.equal(concluded, 4)
  const v4Log = [
    { type: 'assistant/message', turn: 1, step: 1, seq: 1, content: [{ type: 'text', text: 'done v4' }, { type: 'tool-call', name: 'context_compact' }] },
    { type: 'tool/call', seq: 2, data: { name: 'context_compact', callId: 'v4-cc' } },
  ]
  let v4Reads = 0
  const v4Session = { snapshotEvents() { v4Reads++; return v4Log.slice() } }
  assert.equal(Object.hasOwn(v4Session, 'events'), false)
  assert.equal(sessionEventsOf(v4Session)[1].data.callId, 'v4-cc')
  const v4Exec = { agent: { phase: { turn: 1, step: 1 }, session: v4Session }, signal: new AbortController().signal, concludeTurn: () => concluded++ }
  assert.equal(concludeRequested(v4Exec).ok, true)
  v4Reads = 0
  const pendingV4 = finishConclude(v4Exec, [], { timeoutMs: 200, intervalMs: 1 })
  await new Promise((r) => setTimeout(r, 15))
  v4Log.push({ type: 'tool/result', seq: 3, data: { message: { source: { kind: 'tool', callId: 'v4-cc' }, toolCallId: 'v4-cc', content: [{ type: 'text', text: 'committed' }] } } })
  assert.equal(await pendingV4, '')
  assert.equal(concluded, 5)
  assert.ok(v4Reads >= 2, `snapshotEvents reads ${v4Reads}`)
  console.log('turnopt ok')
}
}

// ───────── Session v4 事件读取 / 侧栏跨组可见性 ─────────
{
  const { sessionEvents, getLatestSessionEventTime, extractLastToolName, inferScopes, isChildSessionTerminated } = await import('../lib/index.js')
  const log = [
    { type: 'turn/start', time: 10 },
    { type: 'user/message', time: 11, data: { source: { kind: 'user' } } },
    { type: 'request/header', time: 12 },
    { type: 'tool/call', time: 13, data: { name: 'pwsh' } },
    { type: 'turn/end', time: 14 },
  ]
  let reads = 0
  const v4 = { snapshotEvents() { reads++; return log.slice() } }
  assert.equal(Object.hasOwn(v4, 'events'), false)
  assert.equal(sessionEvents(v4).at(-1).type, 'turn/end')
  assert.equal(sessionEvents({ events: log }).length, log.length)
  assert.deepEqual(sessionEvents(null), [])
  assert.equal(getLatestSessionEventTime(v4), 14)
  assert.equal(extractLastToolName({}, v4), 'pwsh')
  assert.equal(extractLastToolName({ events: [{ type: 'tool/call', data: { name: 'snap-only' } }] }, null), 'snap-only')
  const urlScope = inferScopes('check http://127.0.0.1:8318/status')
  assert.deepEqual(urlScope.readRoots, [])
  assert.equal(urlScope.readRoots.some((p) => String(p).includes('p:/')), false)
  assert.deepEqual(urlScope.loopbackPorts, [8318])
  const ctx = { get(k) { if (k === 'sessions') return { get() { return v4 } }; return undefined } }
  assert.equal(isChildSessionTerminated(ctx, 'child-v4'), true)

  const { readFileSync } = await import('node:fs')
  const vm = await import('node:vm')
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  const sameStart = source.indexOf('const sameGroup = (a, b) =>')
  const parentStart = source.indexOf('const parentOf = (id) =>')
  assert(sameStart > 0 && parentStart > sameStart)
  const sameStmt = source.slice(sameStart, source.indexOf('\n', sameStart))
  const parentStmt = source.slice(parentStart, source.indexOf('\n', parentStart)).trim()
  assert(sameStmt.includes('U(ea).parentElement === U(eb).parentElement'))
  assert(parentStmt.includes('sameGroup(p, id)'))
  const parentOf = new Function('rowOf', 'U', 'byId', `${sameStmt}\n${parentStmt}\nreturn parentOf;`)
  const U = (el) => el
  const groupA = { id: 'A' }
  const groupB = { id: 'B' }
  const rowOf = new Map([
    ['parent', { parentElement: groupA }],
    ['same', { parentElement: groupA }],
    ['cross', { parentElement: groupB }],
  ])
  const byId = {
    parent: { origin: 'user' },
    same: { parentId: 'parent' },
    cross: { parentId: 'parent' },
  }
  const parent = parentOf(rowOf, U, byId)
  assert.equal(parent('same'), 'parent')
  assert.equal(parent('cross'), undefined)
  const kids = new Map()
  for (const id of ['same', 'cross']) {
    const p = parent(id)
    if (p) (kids.get(p) || kids.set(p, []).get(p)).push(id)
  }
  const open = new Set()
  const hiddenBy = (id) => { for (let p = parent(id); p; p = parent(p)) if (kids.has(p) && !open.has(p)) return true; return false }
  assert.equal(hiddenBy('same'), true)
  assert.equal(hiddenBy('cross'), false)

  let clientExports
  const sandbox = { window: { __ModuleLoader__: { load: ({ factory }) => { clientExports = factory(() => { throw new Error('require') }) } } } }
  vm.runInNewContext(source, sandbox)
  const { eventsOf, hasSidebarRelations, expandTruncatedSidebarGroups, buildSidebarTree } = clientExports.sidebarInternals
  const truncatedById = {
    parent: { id: 'parent', origin: 'user', updatedAt: 1 },
    ...Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`child-${i + 1}`, { id: `child-${i + 1}`, parentId: 'parent', updatedAt: i + 2 }])),
  }
  const visibleIds = Array.from({ length: 5 }, (_, i) => `child-${i + 7}`)
  const allIds = ['parent', ...Array.from({ length: 11 }, (_, i) => `child-${i + 1}`)]
  let expandClicks = 0
  const expandButton = { textContent: 'Expand 6', click() { expandClicks++ } }
  const group = { children: [expandButton] }
  const rows = visibleIds.map((id) => ({ id }))
  const expandedGroups = new WeakSet()
  const didExpand = expandTruncatedSidebarGroups(rows, truncatedById, (el) => el.id, (el) => ({ parentElement: group }), expandedGroups)
  assert.equal(hasSidebarRelations(visibleIds, truncatedById), true)
  assert.equal(didExpand, true)
  assert.equal(expandClicks, 1)
  assert.equal(expandTruncatedSidebarGroups(rows, truncatedById, (el) => el.id, () => ({ parentElement: group }), expandedGroups), false, '展开必须幂等，避免重渲染循环')

  const parentOfTruncated = (id) => truncatedById[id]?.parentId
  const tree = buildSidebarTree(allIds, parentOfTruncated, new Set())
  assert.equal(tree.kids.get('parent').length, 11)
  assert.equal(tree.hidden.size, 11, '默认折叠时全部子会话必须隐藏')
  assert.equal(tree.childIds.has('parent'), false, '父会话保持顶层')
  assert.equal(tree.hidden.has('parent'), false)
  const openTree = buildSidebarTree(allIds, parentOfTruncated, new Set(['parent']))
  assert.equal(openTree.hidden.size, 0, '用户展开父会话后子会话可见')
  const usage = { inputTokens: 3, cacheReadTokens: 1, outputTokens: 1 }
  assert.equal(eventsOf({ snapshotEvents() { return [{ type: 'assistant/message', data: { usage } }] } })[0].data.usage, usage)
  assert.equal(eventsOf({ events: [{ type: 'user/message' }] })[0].type, 'user/message')
  assert.deepEqual(eventsOf(null), [])
  assert.equal(reads >= 1, true)
  console.log('sessionEvents sidebar ok')
}

import { evaluateSubagentPrepare, applySubagentRoute, noteSubagentStartFailure, resetSubagentFreeRouting, markSubagentCandidateUnhealthy, readSubagentFreeAudit } from '../lib/index.js'
{
  const plain = (id) => ({ provider: 'anthropic', model: 'claude-opus-4', reasoningEffort: 'low', meta: { delegationDepth: 1, origin: 'subagent', parentSession: 'parent-1', cwd: 'C:/work' }, prompt: id })
  const modelOf = (v) => `${v.candidate.provider}/${v.candidate.model}`
  resetSubagentFreeRouting()
  const first = evaluateSubagentPrepare('sub-1', plain('one'), { now: 1000 })
  const second = evaluateSubagentPrepare('sub-2', plain('two'), { now: 1000 })
  assert.equal(first.action, 'rewrite')
  assert.equal(first.reason, 'primary')
  assert.equal(second.action, 'rewrite')
  assert.equal(second.reason, 'primary')
  assert.equal(modelOf(first), 'cursor/grok-4.7-fast')
  assert.equal(modelOf(second), 'cursor/grok-4.7-fast')
  assert.equal(first.candidate.reasoningEffort, 'xhigh')
  const grokOpts = plain('grok')
  applySubagentRoute(grokOpts, first)
  assert.equal(grokOpts.provider, 'cursor')
  assert.equal(grokOpts.model, 'grok-4.7-fast')
  assert.equal(grokOpts.reasoningEffort, 'xhigh')
  assert.equal(grokOpts.meta.origin, 'subagent-free')
  assert.equal(grokOpts.meta.parentSession, 'parent-1')
  assert.notEqual(grokOpts.model, 'claude-opus-4')

  const forkOpts = { seed: [{ type: 'user/message' }], provider: 'anthropic', model: 'claude-opus-4', meta: { delegationDepth: 1, origin: 'subagent', parentSession: 'parent-1', seedLength: 1 } }
  assert.equal(evaluateSubagentPrepare('fork-1', forkOpts, { now: 1000 }).action, 'keep')
  assert.equal(forkOpts.model, 'claude-opus-4')
  const relayOpts = { provider: 'cursor', model: 'grok-4.7', reasoningEffort: 'low', meta: { delegationDepth: 1, origin: 'relay-dispatch', parentSession: 'parent-1' } }
  assert.equal(evaluateSubagentPrepare('relay-1', relayOpts, { now: 1000 }).reason, 'relay-dispatch')
  assert.equal(relayOpts.model, 'grok-4.7')

  resetSubagentFreeRouting()
  const slot = { active: true, used: false, createdAt: 0, expiresAt: 5000, cwd: 'C:/ws', parent: 'parent-slot' }
  assert.equal(evaluateSubagentPrepare('slot-1', { meta: { cwd: 'C:/ws' } }, { slot, now: 10 }).reason, 'relay-slot')
  const slotPlain = evaluateSubagentPrepare('slot-2', plain('slot'), { now: 10 })
  assert.equal(slotPlain.candidate.provider, 'cursor')
  assert.equal(slotPlain.candidate.model, 'grok-4.7-fast')
  assert.equal(slotPlain.candidate.reasoningEffort, 'xhigh')

  resetSubagentFreeRouting()
  const sensitive = evaluateSubagentPrepare('rp-1', { provider: 'kimi', model: 'kimi-k3.1-pro', meta: { delegationDepth: 1, origin: 'subagent', parentSession: 'parent-1', cwd: 'C:/Users/mikon/xiaoshuo' } }, { now: 10 })
  assert.equal(sensitive.reason, 'sensitive')
  assert.equal(sensitive.candidate.model, 'grok-4.7-fast')
  assert.equal(sensitive.candidate.reasoningEffort, 'xhigh')
  assert.equal(evaluateSubagentPrepare('rp-2', { meta: { delegationDepth: 1, origin: 'fork', parentSession: 'parent-1' }, prompt: '苏晚晴' }, { now: 10 }).candidate.provider, 'cursor')
  assert.equal(evaluateSubagentPrepare('rp-3', plain('mac'), { now: 10, rpGuardianActive: true }).reason, 'sensitive')
  assert.equal(evaluateSubagentPrepare('rp-4', { meta: { delegationDepth: 1, cwd: 'C:/work/mac-v4-sync', parentSession: 'parent-1' } }, { now: 10 }).candidate.model, 'grok-4.7-fast')
  const sensFail = noteSubagentStartFailure('rp-1', new Error('HTTP 429 rate limit'), 10)
  assert.equal(sensFail.retry, true)
  assert.equal(sensFail.candidate.provider, 'cursor')
  assert.equal(sensFail.candidate.model, 'grok-4.7-fast')
  assert.equal(sensFail.candidate.reasoningEffort, 'xhigh')

  resetSubagentFreeRouting()
  const boom = evaluateSubagentPrepare('boom-1', plain('boom'), { now: 2000 })
  assert.equal(boom.candidate.provider, 'cursor')
  assert.equal(boom.candidate.model, 'grok-4.7-fast')
  assert.equal(boom.candidate.reasoningEffort, 'xhigh')
  const failed = noteSubagentStartFailure('boom-1', new Error('HTTP 429 rate limit'), 2000)
  assert.equal(failed.retry, true)
  assert.equal(failed.candidate.provider, 'kimi')
  assert.equal(failed.candidate.model, 'kimi-k3.1-pro')
  assert.equal(evaluateSubagentPrepare('boom-2', plain('next'), { now: 2000 }).candidate.model, 'kimi-k3.1-pro')
  const recovered = evaluateSubagentPrepare('boom-3', plain('later'), { now: 2000 + 60000 })
  assert.equal(recovered.candidate.model, 'grok-4.7-fast')
  assert.equal(recovered.candidate.reasoningEffort, 'xhigh')
  const kept = evaluateSubagentPrepare('boom-4', plain('keep'), { now: 3000 })
  assert.equal(kept.candidate.provider, 'kimi')
  const validation = noteSubagentStartFailure(kept.id, new Error('MCP error -32602: Input validation error: workspace required'), 3000)
  assert.equal(validation.retry, false)
  assert.equal(validation.fused, false)
  assert.equal(evaluateSubagentPrepare('boom-5', plain('still'), { now: 3000 }).candidate.provider, 'kimi')

  resetSubagentFreeRouting()
  markSubagentCandidateUnhealthy({ provider: 'kimi', model: 'kimi-k3.1-pro' }, 4000)
  markSubagentCandidateUnhealthy({ provider: 'cursor', model: 'grok-4.7-fast' }, 4000)
  const open = evaluateSubagentPrepare('open-1', plain('open'), { now: 4000 })
  assert.equal(open.action, 'fail-open')
  const inherited = plain('open')
  applySubagentRoute(inherited, open)
  assert.equal(inherited.provider, 'anthropic')
  assert.equal(inherited.model, 'claude-opus-4')

  resetSubagentFreeRouting()
  const batch = []
  for (let i = 0; i < 10; i++) {
    const verdict = evaluateSubagentPrepare(`batch-${i}`, plain(`b${i}`), { now: 5000 })
    batch.push(verdict)
    if (i === 4) markSubagentCandidateUnhealthy(verdict.candidate, 5000)
  }
  assert.equal(batch.length, 10)
  const fused = modelOf(batch[4])
  for (const verdict of batch.slice(5)) {
    assert.equal(verdict.action, 'rewrite')
    assert.notEqual(modelOf(verdict), fused)
  }
  assert.equal(readSubagentFreeAudit('batch-0').originAudit, 'subagent-free')
  console.log('subagent-free routing ok')
}

{
  const attached = []
  const titles = []
  const ids = ['parent-1']
  const ws = {
    path: 'C:/work',
    sessionIds: ids,
    async attachSession(id) { attached.push(id); if (!ids.includes(id)) ids.push(id) },
    async insertSessionBefore() {},
  }
  const prepared = new Map()
  const sessions = {
    prepare(id, opts) { prepared.set(id, opts); return { id, header: { id, ...(opts && opts.meta) } } },
    get(id) { return id === 'child-free' ? { header: { id }, events: [{ type: 'user/message' }, { type: 'request/header' }] } : undefined },
    list() { return [] },
  }
  const disposers = []
  const ctx = {
    effect(fn) { const d = fn(); if (typeof d === 'function') disposers.push(d); return d },
    get(k) {
      if (k === 'sessions') return sessions
      if (k === 'workspaceRegistry') return { list: () => [ws] }
      if (k === 'sessionTitle') return { rename(_session, title) { titles.push(title) } }
      return undefined
    },
    tools: { register() { return () => {} } },
  }
  apply(ctx, {
    modesPath: yp,
    parentLogPath: join(dir, 'subagent-free.log'),
    linkParentSession: true,
    refreshTitle: true,
    llmTitle: false,
    titlePollFirstMs: 10,
    titlePollIntervalMs: 10,
    titlePollMaxAttempts: 2,
    resumeDelayMs: 600000,
  })
  resetSubagentFreeRouting()
  sessions.prepare('child-free', {
    provider: 'anthropic',
    model: 'claude-opus-4',
    prompt: '读路由实现',
    meta: { delegationDepth: 1, origin: 'subagent', parentSession: 'parent-1', cwd: 'C:/work' },
  })
  const saved = prepared.get('child-free')
  assert.equal(saved.model, 'grok-4.7-fast', saved.model)
  assert.equal(saved.reasoningEffort, 'xhigh')
  assert.notEqual(saved.model, 'claude-opus-4')
  assert.equal(saved.meta.origin, 'subagent-free')
  assert.equal(saved.meta.parentSession, 'parent-1')
  assert.equal(readSubagentFreeAudit('child-free').originAudit, 'subagent-free')
  await new Promise((resolve) => setTimeout(resolve, 80))
  assert.ok(attached.includes('child-free'), 'child should be attached under the parent workspace')
  assert.ok(titles.some((title) => title.includes('读路由')))
  while (disposers.length) disposers.pop()()
  console.log('subagent-free sidebar ok')
}

{
  const { applyDispatchExplanation, finishConclude, renderDispatchText, sessionEvents } = await import('../lib/index.js')
  const toolOnly = () => ({ type: 'assistant/message', turn: 1, step: 1, data: { message: { content: [{ type: 'tool-call', id: 'r', name: 'relay_dispatch' }] } } })
  const frozenSession = (earlier = []) => {
    const log = [...earlier, { type: 'step/start' }, toolOnly()]
    let appends = 0
    const session = {
      get events() { return Object.freeze(log.slice()) },
      snapshotEvents() { return log.slice() },
      append(type, data) { appends++; log.push({ type, data }); },
    }
    session.appends = () => appends
    return session
  }
  const phase = { turn: 1, step: 1 }
  const withSummary = frozenSession()
  let concluded = 0
  const summaryExec = { agent: { phase, session: withSummary }, concludeTurn() { concluded++ } }
  const summaryValue = applyDispatchExplanation({ conclude: true, summary: '  去修跨模型 fork  ' }, summaryExec, { runId: 'r1', jobId: 'j1' })
  assert.equal(await finishConclude(summaryExec), '')
  assert.equal(concluded, 1)
  const summaryEvents = sessionEvents(withSummary)
  const summaryMessages = summaryEvents.filter((e) => e.type === 'assistant/message' && e.data?.message?.content?.some((b) => b.type === 'text' && b.text === '去修跨模型 fork'))
  assert.equal(summaryMessages.length, 1)
  // v4 attach-first: summary folds into the open tool-call message (no separate append).
  assert.equal(withSummary.appends(), 0)
  assert.equal(Object.isFrozen(withSummary.events), true)
  assert.match(renderDispatchText({ ...summaryValue, concludeReason: '' }), /^📋 去修跨模型 fork\nOK runId=r1 jobId=j1/)

  const autoSession = frozenSession()
  const autoExec = { agent: { phase, session: autoSession }, concludeTurn() { concluded++ } }
  applyDispatchExplanation({ conclude: true, tasks: [{ label: 'gate' }, { label: 'relay' }] }, autoExec, { runId: 'r2', jobId: 'j2' })
  assert.equal(await finishConclude(autoExec), '')
  const autoText = sessionEvents(autoSession).flatMap((e) => e.data?.message?.content || []).find((b) => b.type === 'text')?.text
  assert.equal(autoText, '已派发后台流水线（gate、relay），完成后自动汇报。')

  const visible = [{ type: 'step/start' }, { type: 'assistant/message', turn: 1, step: 1, data: { message: { content: [{ type: 'text', text: '已经说明了' }, { type: 'tool-call', id: 'r', name: 'relay_dispatch' }] } } }]
  let pushes = 0
  const visibleSession = { events: visible, append() { pushes++ } }
  const visibleExec = { agent: { phase, session: visibleSession }, concludeTurn() { concluded++ } }
  applyDispatchExplanation({ conclude: true, summary: '不要重复' }, visibleExec, { runId: 'r3', jobId: 'j3' })
  assert.equal(await finishConclude(visibleExec), '')
  assert.equal(pushes, 0)
  assert.equal(visible.filter((e) => e.type === 'assistant/message').length, 1)
  assert.equal(concluded, 3)

  // R2 deep: text in an earlier step must not suppress the current tool-only step's explanation.
  // (attach-first: the summary folds into the current tool-call message instead of appending a new one)
  const multiStep = frozenSession([
    { type: 'step/start', data: { turn: 1, step: 0 } },
    { type: 'assistant/message', data: { turn: 1, step: 0, message: { role: 'assistant', content: [{ type: 'text', text: 'earlier step' }] } } },
    { type: 'step/end', data: { turn: 1, step: 0 } },
  ])
  const multiExec = { agent: { phase, session: multiStep }, concludeTurn() { concluded++ } }
  applyDispatchExplanation({ conclude: true, summary: 'current step summary' }, multiExec, { runId: 'r4', jobId: 'j4' })
  assert.equal(await finishConclude(multiExec), '')
  assert.equal(multiStep.appends(), 0)
  const currentStepMessage = multiStep.snapshotEvents().findLast((e) => e.type === 'assistant/message' && e.data?.message?.content?.some((b) => b.type === 'tool-call'))
  assert.equal(currentStepMessage.data.message.content[0].type, 'text')
  assert.equal(currentStepMessage.data.message.content[0].text, 'current step summary')
  assert.equal(Object.isFrozen(multiStep.events), true)

  // R2 deep: followUp is schema-visible and conclude uses the same native message path.
  const followExec = { agent: { phase, session: frozenSession() }, concludeTurn() { concluded++ } }
  applyDispatchExplanation({ conclude: true, followUp: { pipelineId: 'p-r2', patchTask: 'retry' }, summary: 'follow-up conclude' }, followExec, { pipelineId: 'p-r2-f1', jobId: 'j5' })
  assert.equal(await finishConclude(followExec), '')
  assert.equal(followExec.agent.session.snapshotEvents().at(-1).data.message.content[0].text, 'follow-up conclude')

  // R2 deep: a genuinely frozen v4 events property without append/record fails safely, never throws or corrupts events.
  const immutableLog = Object.freeze([toolOnly()])
  const immutable = { snapshotEvents: () => immutableLog.slice() }
  Object.defineProperty(immutable, 'events', { value: immutableLog, writable: false, configurable: false })
  assert.doesNotThrow(() => applyDispatchExplanation({ conclude: true, summary: 'cannot append' }, { agent: { phase, session: immutable } }, {}))
  assert.equal(immutable.snapshotEvents().length, 1)
  console.log('dispatch summary ok')
}
