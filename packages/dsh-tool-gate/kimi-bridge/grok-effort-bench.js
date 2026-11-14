// Grok effort-tier benchmark: xhigh vs high vs medium on cursor-agent CLI.
// Locates the Cursor CLI agent binary, runs 4 tests per tier, writes JSON results.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const OUT_FILE = join(dirname(fileURLToPath(import.meta.url)), 'grok-effort-bench-results.json');

function findVersionedCursorAgent() {
  const local = process.env.LOCALAPPDATA;
  if (!local) return null;
  const versions = join(local, 'cursor-agent', 'versions');
  if (!existsSync(versions)) return null;
  const dirs = readdirSync(versions, { withFileTypes: true }).filter((d) => d.isDirectory() && !/\.previous$/i.test(d.name)).map((d) => d.name).sort().reverse();
  for (const name of dirs) {
    const dir = join(versions, name);
    const node = join(dir, 'node.exe');
    const script = join(dir, 'index.js');
    if (existsSync(node) && existsSync(script)) return { node, script, label: dir };
  }
  return null;
}

function findAgentBin() {
  const versioned = findVersionedCursorAgent();
  if (versioned) return versioned;
  const cands = [];
  const home = process.env.USERPROFILE || process.env.HOME;
  const npmBin = join(process.env.APPDATA || join(home, 'AppData', 'Roaming'), 'npm');
  for (const n of ['cursor-agent.cmd', 'cursor-agent']) cands.push(join(npmBin, n));
  try {
    const p = require.resolve('dsh-cursor-acp/lib/resolve-agent.js');
    const m = require(p);
    const f = typeof m === 'function' ? m() : (m.resolveAgent ? m.resolveAgent() : null);
    if (f) cands.unshift(String(f.command || f.bin || f));
  } catch {}
  try {
    const p = require.resolve('dsh-cursor-passthrough/package.json');
    const pkg = require(p);
    if (pkg.bin) cands.unshift(join(dirname(p), pkg.bin.cursorAgent || pkg.bin.agent || Object.values(pkg.bin)[0]));
  } catch {}
  const local = process.env.LOCALAPPDATA || join(home, 'AppData', 'Local');
  for (const d of [join(local, 'cursor-agent'), join(home, '.cursor', 'local'), join(home, '.cursor', 'bin'), join(home, '.local', 'bin')]) {
    for (const n of ['cursor-agent.cmd', 'cursor-agent.exe', 'agent.cmd']) cands.push(join(d, n));
  }
  for (const c of cands) {
    try { if (c && existsSync(c) && !/\\\.grok\\/i.test(c)) return c; } catch {}
  }
  try {
    const hit = execFileSync('where.exe', ['cursor-agent'], { encoding: 'utf8' }).trim().split(/\r?\n/).find((p) => p && !/\\\.grok\\/i.test(p));
    if (hit) return hit;
  } catch {}
  return null;
}

function agentLaunch(bin, args) {
  if (bin && typeof bin === 'object' && bin.node && bin.script) return { cmd: bin.node, args: [bin.script, ...args], label: bin.label };
  if (typeof bin === 'string' && /\.(cmd|bat)$/i.test(bin)) return { cmd: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', bin, ...args], label: bin };
  return { cmd: bin, args, label: String(bin) };
}

const bin = findAgentBin();
console.log('agent bin:', bin && bin.label ? bin.label : bin);
if (!bin) { console.error('NOT_FOUND'); process.exit(2); }

const TIERS = ['grok-4.7-xhigh-fast', 'grok-4.7-high-fast', 'grok-4.7-medium-fast'];

const TESTS = {
  A_pong: 'Reply with exactly the single word: pong. Nothing else.',
  B_mutex: `Below is a JS mutex-queue implementation with concurrency bugs. Do NOT read any files or explore any repo — answer from the code given here alone. Output EXACTLY five lines, each starting with the tag shown, then stop:
ROOT: <one sentence: the root cause of the mutual-exclusion window>
OVERLAP: <one sentence: how two task bodies can overlap despite the mutex>
CLOSE_HANG: <one sentence: why close() makes waiting promises never settle>
CLOSE_WAIT: <one sentence: why close() does not wait for the running task>
NOT_BUGS: <one point that looks like a bug but is actually fine>

\`\`\`js
class MutexQueue {
  constructor() { this.queue = []; this.running = false; this.waiters = []; this.closed = false; }
  async run(task) {
    if (this.closed) throw new Error('closed');
    if (this.running) {
      await new Promise(res => this.waiters.push(res));
    }
    this.running = true;
    try { return await task(); }
    finally {
      this.running = false;
      const wake = this.waiters.shift();
      if (wake) wake();
    }
  }
  close() { this.closed = true; this.waiters.length = 0; }
}
\`\`\``,
  C_spec: `Do NOT read any files or explore any repo. From the facts below, write EXACTLY six lines, each starting S1: through S6:, one fact per line. Do not use the words: certainly, delve, restart, secret, credential. Then stop.
Facts: (1) reasoningEffortFor maps model names to effort levels. (2) glm-5.3 rejects reasoning_effort=none. (3) max_tokens below 4096 is raised to 4096. (4) tool_choice uses the strings "auto"/"required". (5) GET /health does not stop the process. (6) AK/SK must never be committed to git.`,
  D_state: `Do NOT read any files or explore any repo — pure reasoning from the code given here. This async state machine has a subtle bug. Output EXACTLY four lines with these tags, then stop:
ROOT: <one sentence: the precise root cause>
SCENARIO: <one sentence: the shortest interleaving that triggers it>
FIX: <one sentence: the minimal fix>
INVARIANT: <one sentence: the invariant that must hold>

\`\`\`js
class Door {
  constructor() { this.state = 'closed'; this.pending = null; }
  async open() {
    if (this.state === 'open') return;
    if (this.pending) return this.pending;
    this.pending = (async () => {
      await new Promise(r => setTimeout(r, 50));
      this.state = 'open';
    })();
    try { return await this.pending; } finally { this.pending = null; }
  }
  async close() {
    this.state = 'closed';
  }
}
// usage: open(); close(); open();  — second open can silently no-op or double-fire
\`\`\``,
};

function runOne(model, testName, prompt, timeoutSec) {
  const workdir = mkdtempSync(join(tmpdir(), 'grokbench-'));
  const t0 = Date.now();
  let out = '', timedOut = false;
  try {
    const launch = agentLaunch(bin, [
      '--print', '--output-format', 'stream-json', '--mode', 'ask', '--trust',
      '--model', model, prompt,
    ]);
    out = execFileSync(launch.cmd, launch.args, { encoding: 'utf8', timeout: timeoutSec * 1000 + 30000, cwd: workdir, maxBuffer: 64 * 1024 * 1024 });
  } catch (e) {
    if (e.killed || e.code === 'ETIMEDOUT' || /ETIMEDOUT|timed out/i.test(String(e.message || '') + String(e.code || ''))) timedOut = true;
    out = (e.stdout || '') + (e.stderr || '');
  }
  const wall = Date.now() - t0;
  // parse stream-json events
  let apiMs = null, outputTokens = null, inputTokens = null, cacheRead = null;
  let text = '', toolCalls = 0, firstOutAt = null;
  const tFirst = t0;
  for (const line of out.split(/\r?\n/)) {
    const l = line.trim();
    if (!l.startsWith('{')) continue;
    let ev; try { ev = JSON.parse(l); } catch { continue; }
    if (ev.type === 'tool_call' || ev.type === 'tool_use') toolCalls++;
    if (ev.type === 'system' || ev.subtype === 'system') { /* cli preamble */ }
    if (ev.type === 'assistant' && typeof ev.message?.content === 'string' && ev.message.content) {
      if (firstOutAt === null) firstOutAt = Date.now(); text += ev.message.content;
    }
    if (ev.type === 'assistant' && Array.isArray(ev.message?.content)) {
      for (const b of ev.message.content) {
        if (b.type === 'text' && b.text) { if (firstOutAt === null) firstOutAt = Date.now(); text += b.text; }
        if (b.type === 'tool_use' || b.type === 'tool_call') toolCalls++;
      }
      const u = ev.message.usage || {};
      if (u.output_tokens != null) outputTokens = (outputTokens || 0) + u.output_tokens;
      if (u.input_tokens != null) inputTokens = (inputTokens || 0) + u.input_tokens;
      if (u.cache_read_input_tokens != null) cacheRead = (cacheRead || 0) + u.cache_read_input_tokens;
      if (u.output_tokens != null && u.input_tokens != null && apiMs === null) {
        // duration_api_ms may live at top level of result event instead
      }
    }
    if (ev.type === 'result') {
      apiMs = ev.duration_api_ms ?? ev.durationApiMs ?? null;
      if (outputTokens === null) outputTokens = ev.outputTokens ?? ev.usage?.output_tokens ?? null;
      if (inputTokens === null) inputTokens = ev.inputTokens ?? ev.usage?.input_tokens ?? null;
      if (cacheRead === null) cacheRead = ev.cacheReadTokens ?? ev.usage?.cache_read_input_tokens ?? null;
      if (ev.result) text = text || ev.result;
    }
  }
  return { model, test: testName, wallMs: wall, apiMs, outputTokens, inputTokens, cacheRead, toolCalls, timedOut, text: text.slice(0, 2000), rawSample: out.slice(0, 800) };
}

const results = [];
for (const model of TIERS) {
  for (const [name, prompt] of Object.entries(TESTS)) {
    const timeout = name === 'B_mutex' ? 240 : name === 'D_state' ? 180 : 120;
    const r = runOne(model, name, prompt, timeout);
    results.push(r);
    writeFileSync(OUT_FILE, JSON.stringify(results, null, 2));
    console.log(`${model} ${name}: wall=${r.wallMs}ms api=${r.apiMs} out=${r.outputTokens} timeout=${r.timedOut} tools=${r.toolCalls}`);
  }
}
console.log('DONE results written', OUT_FILE);
