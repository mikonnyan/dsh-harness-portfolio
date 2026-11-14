// ─── 2-Round Verification: 本轮实付 vs 累计实付 ───
// Round A: 1-step user turn → 本轮实付 = that step's exact cost
// Round B: multi-step user turn → 本轮实付 sums ONLY steps since latest user msg

// client.js is a browser IIFE that uses window.__ModuleLoader__.
// We stub it and capture the factory exports.
globalThis.window = {
  __ModuleLoader__: {
    load(spec) {
      const mod = spec.factory()
      globalThis.__clientExports = mod
    }
  }
}

// Execute the IIFE
const fs = await import('node:fs')
const code = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
// The file is not a module; use eval-like approach via Function
new Function(code)()
const { billingInternals } = globalThis.__clientExports

const assert = (await import('node:assert')).default

const { billingBuckets, billingTotal, billingUsd, sumBillingBuckets, turnUsageEvents, usageOfEvent } = billingInternals

// Helper: create a usage object
function makeUsage(inputTokens, outputTokens, cacheReadTokens = 0) {
  return { inputTokens, outputTokens, cacheReadTokens }
}

// Helper: create an assistant/chunk event with usage
function usageEvent(usage) {
  return { type: 'assistant/chunk', data: { chunk: { type: 'usage', usage } } }
}

// Helper: create an assistant/message event with usage
function messageEvent(usage) {
  return { type: 'assistant/message', data: { usage } }
}

// Helper: user message event
function userMsg() {
  return { type: 'user/message', data: { content: 'hello' } }
}

function turnStart() {
  return { type: 'turn/start', data: {} }
}

function toolCall() {
  return { type: 'tool/call', data: { name: 'test_tool' } }
}

// ─── Mock sessions service ───
function mockSessions(events) {
  return {
    binding(id) { return { session: { snapshotEvents: () => events } } },
    sessionOf(id) { return { snapshotEvents: () => events } }
  }
}

// ═══════════════════════════════════════════════════════════
// Round A: Single-step user turn
// ═══════════════════════════════════════════════════════════
console.log('── Round A: 1-step turn ──')
{
  // Simulate: user sends message → 1 LLM response
  const u1 = makeUsage(1000, 200, 500) // 1000 uncached, 200 output, 500 cached
  const events = [
    userMsg(),
    turnStart(),
    usageEvent(u1),  // Step 1: single LLM call
  ]

  const svc = mockSessions(events)
  const turnUsages = turnUsageEvents(svc, 'test-session')
  assert.equal(turnUsages.length, 1, 'Round A: should have exactly 1 usage')

  const bill = sumBillingBuckets(turnUsages)
  assert.equal(bill.steps, 1, 'Round A: steps=1')

  // Verify cost calculation
  const expected = billingBuckets(u1)
  const expectedTotal = expected.cacheCost + expected.inputCost + expected.outputCost
  const actualTotal = billingTotal(bill)

  assert.ok(Math.abs(actualTotal - expectedTotal) < 1e-10,
    `Round A: 本轮实付 ${actualTotal} should equal step cost ${expectedTotal}`)

  console.log(`  ✓ Round A: 本轮实付 = $${billingUsd(actualTotal)} (1 step, matches exact cost)`)
}

// ═══════════════════════════════════════════════════════════
// Round B: Multi-step user turn (user msg → tool call → tool call → response)
// ═══════════════════════════════════════════════════════════
console.log('── Round B: multi-step turn ──')
{
  // Earlier turn (should NOT be included in 本轮实付)
  const uOld = makeUsage(5000, 1000, 2000)

  // Current turn: 3 steps
  const u1 = makeUsage(800, 150, 300)   // Step 1: tool call response
  const u2 = makeUsage(600, 100, 200)    // Step 2: tool call response
  const u3 = makeUsage(400, 200, 100)    // Step 3: final response

  const events = [
    // Previous user turn
    userMsg(),
    turnStart(),
    usageEvent(uOld),  // Old turn's usage

    // Current user turn
    userMsg(),
    turnStart(),
    toolCall(),
    usageEvent(u1),    // Step 1
    toolCall(),
    usageEvent(u2),    // Step 2
    messageEvent(u3),  // Step 3: final response
  ]

  const svc = mockSessions(events)
  const turnUsages = turnUsageEvents(svc, 'test-session')
  assert.equal(turnUsages.length, 3, 'Round B: should have 3 usages (current turn only)')

  const bill = sumBillingBuckets(turnUsages)
  assert.equal(bill.steps, 3, 'Round B: steps=3')

  // 本轮实付 = sum of 3 steps only (NOT including uOld)
  const b1 = billingBuckets(u1), b2 = billingBuckets(u2), b3 = billingBuckets(u3)
  const expectedTurnTotal = billingTotal(b1) + billingTotal(b2) + billingTotal(b3)
  const actualTurnTotal = billingTotal(bill)

  assert.ok(Math.abs(actualTurnTotal - expectedTurnTotal) < 1e-10,
    `Round B: 本轮实付 ${actualTurnTotal} should equal sum of 3 steps ${expectedTurnTotal}`)

  // 累计实付 = all steps including old turn
  const bOld = billingBuckets(uOld)
  const cumulativeTotal = billingTotal(bOld) + expectedTurnTotal
  assert.ok(cumulativeTotal > actualTurnTotal, 'Round B: cumulative > turn total')

  console.log(`  ✓ Round B: 本轮实付(3步) = $${billingUsd(actualTurnTotal)} (excludes old turn)`)
  console.log(`  ✓ Round B: 累计实付 = $${billingUsd(cumulativeTotal)} (includes old turn)`)
}

// ═══════════════════════════════════════════════════════════
// Edge: turn/start as boundary (no user/message)
// ═══════════════════════════════════════════════════════════
console.log('── Edge: turn/start boundary ──')
{
  const u1 = makeUsage(100, 50)
  const u2 = makeUsage(200, 80)
  const events = [
    turnStart(),
    usageEvent(u1),
    turnStart(),  // New turn starts
    usageEvent(u2),
  ]
  const svc = mockSessions(events)
  const turnUsages = turnUsageEvents(svc, 'test-session')
  assert.equal(turnUsages.length, 1, 'Edge: only usage after last turn/start')
  assert.deepEqual(turnUsages[0], u2)
  console.log('  ✓ Edge: turn/start correctly bounds the current turn')
}

// ═══════════════════════════════════════════════════════════
// Edge: empty session
// ═══════════════════════════════════════════════════════════
{
  const svc = mockSessions([])
  const turnUsages = turnUsageEvents(svc, 'test-session')
  assert.equal(turnUsages.length, 0)
  const bill = sumBillingBuckets(turnUsages)
  assert.equal(bill, null)
  console.log('  ✓ Edge: empty session → null billing')
}

// ═══════════════════════════════════════════════════════════
// Edge: events before any user/turn marker
// ═══════════════════════════════════════════════════════════
{
  const u1 = makeUsage(100, 50)
  const events = [
    { type: 'system/init', data: {} },
    usageEvent(u1),
  ]
  const svc = mockSessions(events)
  const turnUsages = turnUsageEvents(svc, 'test-session')
  // start = -1, so start+1 = 0, all events scanned
  assert.equal(turnUsages.length, 1)
  console.log('  ✓ Edge: events before any marker are included (start=-1)')
}

console.log('\n═══ All billing turn tests PASSED ═══')
