import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const LIB = new URL('../lib/', import.meta.url)
const {
  WORKER_DENIED_TOOLS, WORKER_CONTROL_ONLY_TOOLS, WORKER_DENIED_PATTERN, WORKER_CONTROL_ONLY_PREFIXES,
  toolVisibleForWorker, permissionDecision,
} = await import(new URL('permission-guard.js', LIB))
const { ARCHETYPE_RANK, classifySession, effectiveArchetype, publishArchetype } = await import(new URL('session-archetype.js', LIB))
const { readPin, writePinAtomic, sweepPins, cfgDigestOf, nextPin, PIN_SCHEMA_VERSION } = await import(new URL('pin-store.js', LIB))

// ── 133-tool fixture (representative names across the host surface) ──
const TOOL_NAMES = [
  ...['read', 'write', 'edit', 'glob', 'grep', 'pwsh', 'bash', 'web_search', 'todo_write', 'ask_user_question',
    'subagent', 'subagent_fork', 'send_message', 'interrupt_agent', 'list_agents', 'job_output', 'job_list', 'job_kill',
    'skill_search', 'skill_load', 'tool_unlock', 'exit_plan_mode', 'context_compact', 'context_recall', 'relay_dispatch',
    'workflow', 'claude_code', 'claude_code_usage', 'cursor_agent', 'ralph', 'create_goal', 'get_goal', 'update_goal',
    'dsh_session_read', 'dsh_session_repair', 'dsh_session_search', 'dsh_supervisor_watch_tick', 'modlens_read_image',
    'x_search', 'read_page', 'relay_dispatch'],
  ...['dev_plugin_status', 'dev_reload_package', 'dev_inject_plugin', 'dev_uninject_plugin', 'dev_scaffold_plugin',
    'dev_build_plugin', 'dev_release_plugin', 'dev_install_package', 'dev_self_test', 'dev_stage_add', 'dev_stage_call',
    'dev_stage_promote', 'dev_stage_demote', 'dev_stage_list', 'dev_mode_set', 'dev_mode_status', 'dev_mode_subagent',
    'dev_heal_links', 'dev_fix_patch', 'dev_clear_routes'],
  ...['mcp__chrome-devtools__click', 'mcp__chrome-devtools__navigate_page', 'mcp__chrome-devtools__take_snapshot',
    'mcp__chrome-devtools__evaluate_script', 'mcp__chrome-devtools__list_pages', 'mcp__chrome-devtools__fill',
    'mcp__chrome-devtools__press_key', 'mcp__chrome-devtools__screenshot', 'mcp__chrome-devtools__close_page',
    'mcp__chrome-devtools__new_page', 'mcp__chrome-devtools__resize_page', 'mcp__chrome-devtools__hover',
    'mcp__chrome-devtools__drag', 'mcp__chrome-devtools__wait_for', 'mcp__chrome-devtools__emulate'],
  ...['mcp_connector_catalog', 'mcp_connector_configure', 'mcp_connector_connect', 'mcp_connector_disconnect',
    'mcp_connector_status', 'mcp_connector_health_check', 'mcp_connector_import_json', 'mcp_connector_install_from_url',
    'mcp_connector_migrate_legacy', 'mcp_connector_migration_preview', 'mcp_connector_publish',
    'mcp_connector_refresh_catalog', 'mcp_connector_set_enabled', 'mcp_connector_tools_list'],
  ...['mcp__harness_relay__start_run', 'mcp__harness_relay__wait_run', 'mcp__harness_relay__get_run',
    'mcp__harness_relay__list_runs', 'mcp__harness_relay__steer_run', 'mcp__harness_relay__cancel_run',
    'mcp__harness_relay__doctor', 'mcp__harness_relay__list_capabilities', 'mcp__harness_relay__list_services',
    'mcp__harness_relay__list_workspaces', 'mcp__harness_relay__start_review', 'mcp__harness_relay__reply_run'],
  ...['mcp__tools__report_export', 'mcp__tools__report_import', 'mcp__tools__report_list', 'mcp__tools__report_get',
    'mcp__tools__report_delete', 'mcp__tools__report_share', 'mcp__tools__report_stats', 'mcp__tools__report_tag',
    'mcp__tools__report_search', 'mcp__tools__report_bulk', 'mcp__tools__report_clone', 'mcp__tools__report_archive'],
  ...['unknown_plugin_tool_a', 'unknown_plugin_tool_b', 'unknown_plugin_tool_c', 'unknown_plugin_tool_d',
    'unknown_plugin_tool_e', 'unknown_plugin_tool_f', 'unknown_plugin_tool_g', 'unknown_plugin_tool_h',
    'unknown_plugin_tool_i', 'unknown_plugin_tool_j'],
]

// ── R1-13: hidden = denied ∪ controlOnly; visibility & deny agreement ──
test('R1-13: hidden set equals denied ∪ controlOnly over the fixture', () => {
  const denied = new Set(WORKER_DENIED_TOOLS)
  const control = new Set(WORKER_CONTROL_ONLY_TOOLS)
  assert.ok(!denied.has('exit_plan_mode') && !control.has('exit_plan_mode'), 'exit_plan_mode must be removed (A8)')
  for (const name of TOOL_NAMES) {
    const visible = toolVisibleForWorker(name, null, {})
    const inDenied = denied.has(name.toLowerCase()) || WORKER_DENIED_PATTERN.test(name)
    const inControl = control.has(name.toLowerCase()) || WORKER_CONTROL_ONLY_PREFIXES.some((p) => name.toLowerCase().startsWith(p))
    assert.equal(visible, !(inDenied || inControl), `visibility mismatch for ${name}`)
  }
})

test('R1-13: exit_plan_mode, context_compact, context_recall and unknown plugin tools are visible', () => {
  for (const name of ['exit_plan_mode', 'context_compact', 'context_recall', 'unknown_plugin_tool_a', 'read', 'write', 'edit', 'pwsh']) {
    assert.ok(toolVisibleForWorker(name, null, {}), `${name} should be visible`)
  }
})

test('R1-13: every denied name returns a deny from permissionDecision with a valid manifest', () => {
  const manifest = {
    v: 1, session_id: 'test-sid', parent_session: 'parent-sid', workspace: 'C:/ws',
    read_roots: ['C:/ws'], write_roots: ['C:/ws'], net_allow: [], dispatch_mode: 'implement',
  }
  const deniedNames = TOOL_NAMES.filter((n) => !toolVisibleForWorker(n, null, {}) && (WORKER_DENIED_TOOLS.has(n.toLowerCase()) || WORKER_DENIED_PATTERN.test(n)))
  for (const name of deniedNames) {
    const decision = permissionDecision(name, {}, { parent_session: 'parent-sid', header: { id: 'test-sid', parentSession: 'parent-sid', capabilityManifest: manifest } })
    assert.equal(decision.kind, 'deny', `${name} must deny`)
  }
})

// ── R1-14: narrowReadOnlyWorkerTools ──
const EMPTY_WRITE_MANIFEST = {
  schema_version: 'capability/v1', session_id: 'ro-sid', parent_session: 'parent-sid', workspace: 'C:/ws',
  read_roots: [{ root_id: 'ws', canonical_path: 'C:/ws' }], write_roots: [], net_allow: [], dispatch_mode: 'verify',
  escalation: 'forbidden', forbidden_ports: [3080], expires_at: '9999-12-31T23:59:59.999Z',
}

test('R1-14: default hides nothing extra; true hides write/edit only for empty-write manifest', () => {
  // Default: write/edit visible even with empty write roots.
  assert.ok(toolVisibleForWorker('write', EMPTY_WRITE_MANIFEST, {}))
  assert.ok(toolVisibleForWorker('edit', EMPTY_WRITE_MANIFEST, {}))
  // narrow=true: hidden for the empty-write manifest.
  assert.equal(toolVisibleForWorker('write', EMPTY_WRITE_MANIFEST, { narrowReadOnlyWorkerTools: true }), false)
  assert.equal(toolVisibleForWorker('edit', EMPTY_WRITE_MANIFEST, { narrowReadOnlyWorkerTools: true }), false)
  // read stays visible.
  assert.ok(toolVisibleForWorker('read', EMPTY_WRITE_MANIFEST, { narrowReadOnlyWorkerTools: true }))
})

// ── R1-15: pin store ──
test('R1-15: atomic write round-trips; corrupt reads null; unsafe id memory-only; sweep respects age and limit', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pins-'))
  process.env.DSH_HOME = dir
  // Re-import to pick up the temp DSH_HOME.
  const fresh = await import(new URL('pin-store.js?fresh=1', LIB))
  const pin = {
    v: PIN_SCHEMA_VERSION, archetype: 'ORCHESTRATOR', projVersion: 3,
    cfgPinned: { compactSchema: true, promptGovernanceV2: true, narrowReadOnlyWorkerTools: false },
    cfgDigest: cfgDigestOf({}), permissionPreset: null, latchedAtSeq: 7,
  }
  assert.equal(fresh.writePinAtomic('sess-ok', pin), true)
  assert.deepEqual(fresh.readPin('sess-ok'), pin)
  // Corrupt file reads as null.
  writeFileSync(join(fresh.pinDir(), 'sess-bad.json'), '{not json')
  assert.equal(fresh.readPin('sess-bad'), null)
  // Unsafe id: memory-only (returns false).
  assert.equal(fresh.writePinAtomic('../escape!@#', pin), false)
  assert.equal(fresh.writePinAtomic('', pin), false)
  // Sweep: age and limit.
  const now = Date.now()
  writeFileSync(join(fresh.pinDir(), 'sess-old.json'), JSON.stringify({ ...pin, latchedAtSeq: 1 }))
  const removed = fresh.sweepPins(now + 40 * 24 * 3600 * 1000, { maxAgeMs: 30 * 24 * 3600 * 1000, limit: 200 })
  assert.ok(removed >= 1, 'sweep must remove the stale pin')
  assert.equal(fresh.readPin('sess-old'), null)
  rmSync(dir, { recursive: true, force: true })
  delete process.env.DSH_HOME
})

test('R1-15: cfgDigestOf is stable and 12 hex chars', () => {
  const d1 = cfgDigestOf({ compactSchema: true, promptGovernanceV2: false, narrowReadOnlyWorkerTools: false })
  const d2 = cfgDigestOf({ compactSchema: true, promptGovernanceV2: false, narrowReadOnlyWorkerTools: false })
  assert.equal(d1, d2)
  assert.match(d1, /^[0-9a-f]{12}$/)
  assert.notEqual(d1, cfgDigestOf({ compactSchema: true, promptGovernanceV2: true, narrowReadOnlyWorkerTools: false }))
})

// ── R1-16: nextPin truth table, 5×5 × boundary ──
const ARCHETYPES = ['STANDALONE', 'ORCHESTRATOR', 'WORKER_FRESH', 'WORKER_FORK', 'SPECIALIZED']
const basePin = (archetype) => ({
  v: PIN_SCHEMA_VERSION, archetype, projVersion: 3,
  cfgPinned: { compactSchema: true, promptGovernanceV2: true, narrowReadOnlyWorkerTools: false },
  cfgDigest: cfgDigestOf({ compactSchema: true, promptGovernanceV2: true, narrowReadOnlyWorkerTools: false }),
  permissionPreset: null, latchedAtSeq: 1,
})

test('R1-16: nextPin truth table over all 5x5 archetype pairs x boundary', () => {
  for (const from of ARCHETYPES) {
    for (const to of ARCHETYPES) {
      for (const boundary of [false, true]) {
        const pin = basePin(from)
        const live = { archetype: to, evidence: [] }
        const { pin: next, changed, reason } = nextPin(pin, live, { boundary, cfg: { compactSchema: true, promptGovernanceV2: true, narrowReadOnlyWorkerTools: false }, seq: 2, latestVersion: 3 })
        const fromRank = ARCHETYPE_RANK[from], toRank = ARCHETYPE_RANK[to]
        if (from === to) {
          assert.equal(changed, false, `${from}->${to} boundary=${boundary}: no change expected`)
          continue
        }
        if ((from === 'WORKER_FRESH' && to === 'WORKER_FORK') || (from === 'WORKER_FORK' && to === 'WORKER_FRESH')) {
          assert.equal(reason, 'rejected', `${from}->${to}: lineage change must be rejected`)
          assert.equal(changed, false)
          continue
        }
        if (toRank >= 2 && fromRank < toRank) {
          // §10 A1: immediate upward move into rank >= 2, including WORKER -> SPECIALIZED.
          assert.equal(changed, true, `${from}->${to}: immediate upward move expected`)
          assert.equal(reason, 'upward')
          continue
        }
        // Everything else needs a boundary.
        if (!boundary) {
          assert.equal(changed, false, `${from}->${to} boundary=false: must not move`)
          assert.deepEqual(next, pin)
        } else {
          assert.equal(changed, true, `${from}->${to} boundary=true: must move at PMW`)
          assert.equal(next.archetype, to)
          assert.equal(reason, 'pmw')
        }
      }
    }
  }
})

test('R1-16: init with no previous pin', () => {
  const { pin, changed, reason } = nextPin(null, { archetype: 'STANDALONE' }, { cfg: {}, seq: 0 })
  assert.equal(reason, 'init')
  assert.equal(changed, true)
  assert.equal(pin.archetype, 'STANDALONE')
})

// ── classifySession / effectiveArchetype sanity (part of R1 test scope) ──
test('classifySession: five archetypes', () => {
  assert.deepEqual(classifySession(null), { archetype: 'STANDALONE', evidence: [] })
  const top = { header: { id: 'a' } }
  assert.equal(classifySession(top, { tools: [{ name: 'relay_dispatch' }] }, {}).archetype, 'ORCHESTRATOR')
  assert.equal(classifySession(top, { tools: [] }, { hasRegisteredTool: () => true }).archetype, 'ORCHESTRATOR')
  assert.equal(classifySession(top, { tools: [] }, { hasRegisteredTool: () => false }).archetype, 'STANDALONE')
  const child = { header: { id: 'b', parentSession: 'a' } }
  assert.equal(classifySession(child, null, {}).archetype, 'WORKER_FRESH')
  const parent = { header: { id: 'a', provider: 'google-vertex', model: 'gemini-4-argon' }, events: [] }
  const fork = { header: { id: 'c', parentSession: 'a', seedLength: 3, provider: 'google-vertex', model: 'gemini-4-argon' }, events: [] }
  assert.equal(classifySession(fork, null, { getSession: (id) => id === 'a' ? parent : null }).archetype, 'WORKER_FORK')
  const rp = { header: { id: 'd', rp: true } }
  assert.equal(classifySession(rp, null, {}).archetype, 'SPECIALIZED')
  const rpChild = { header: { id: 'e', parentSession: 'd' } }
  publishArchetype('d', { archetype: 'SPECIALIZED', rp: true })
  assert.equal(classifySession(rpChild, null, {}).archetype, 'SPECIALIZED')
})

test('effectiveArchetype: higher rank wins (A2)', () => {
  assert.equal(effectiveArchetype(null, { archetype: 'WORKER_FRESH' }), 'WORKER_FRESH')
  assert.equal(effectiveArchetype({ archetype: 'WORKER_FRESH' }, { archetype: 'STANDALONE' }), 'WORKER_FRESH')
  assert.equal(effectiveArchetype({ archetype: 'STANDALONE' }, { archetype: 'ORCHESTRATOR' }), 'ORCHESTRATOR')
  assert.equal(effectiveArchetype({ archetype: 'SPECIALIZED' }, { archetype: 'WORKER_FRESH' }), 'SPECIALIZED')
})
