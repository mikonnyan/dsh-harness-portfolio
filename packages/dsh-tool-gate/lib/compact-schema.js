export const COMPACT_MAP_VERSION = 2
const SP = 'Wider mode for a one-shot retry of an operation the sandbox just denied.'
const JU = '与 sandbox_permissions 同时必填：一句简体中文，说明为何需要更宽权限。'
export const COMPACT_TOOL_DESCRIPTIONS = Object.freeze({
  edit: {
    expectParams: ['file_path', 'justification', 'new_string', 'old_string', 'replace_all', 'sandbox_permissions'],
    params: {
      file_path: 'Path to edit.', old_string: 'Literal text to replace; must match exactly.',
      new_string: 'Literal replacement; empty string deletes.',
      replace_all: 'Replace all matches. Default false: old_string must be unique.',
      sandbox_permissions: SP, justification: JU,
    },
  },
  write: {
    expectParams: ['content', 'file_path', 'justification', 'sandbox_permissions'],
    params: { file_path: 'Path to write.', content: 'Full UTF-8 content.', sandbox_permissions: SP, justification: JU },
  },
  read: {
    expectParams: ['file_path', 'limit', 'offset'],
    params: { file_path: 'Path to read.', limit: 'Max lines. Default 2000.', offset: '1-based first line. Default 1.' },
  },
  pwsh: {
    expectParams: ['command', 'description', 'justification', 'run_in_background', 'sandbox_permissions', 'timeoutMs', 'workdir'],
    description: 'Run a PowerShell command (`pwsh -Command`); returns stdout/stderr. Each call is a fresh process: no cwd/variables persist — pass `workdir`, never `cd`. Use Windows paths (`C:\\...`) and `$env:NAME`. Non-zero exit shows `[exit code: N]`; a force-killed command also shows exit 1 — that is an interruption, not a failure. Long output keeps only its tail; the full output file path is reported. `run_in_background: true` returns a job id (read with `job_output`, stop with `job_kill`). Sandbox: `[sandbox: file access denied under <mode> mode]` is a policy denial — do not retry another way. Read-only mode is ConstrainedLanguage: cmdlets and core types (`[string]`,`[datetime]`,`[regex]`,`[guid]`) only; .NET static calls (`[System.IO.*]::`, `[math]`), `Add-Type`, COM and reflection fail with "only core types". Confined modes cannot open named pipes: Node `child_process` with default `stdio:\'pipe\'` fails with EPERM (`inherit`/`ignore` work) — do not retry another way. Escalation: only after a real denial, retry the exact same command once with the narrowest `sandbox_permissions` plus a one-sentence `justification`; never speculatively. If approval prompts are disabled, or an escalation is rejected, the denial is final.',
    params: {
      description: '简体中文主动语态 5-10 字，说明命令作用（UI 展示）。',
      justification: '与 sandbox_permissions 同时必填：一句简体中文，说明为何需要更宽权限。',
      sandbox_permissions: 'Wider mode for a one-shot retry of a command the sandbox just denied.',
      run_in_background: 'Return a job id immediately; no timeout applies.',
      timeoutMs: 'Timeout in ms; the command is killed on expiry.',
      workdir: 'Working directory; defaults to the session workspace.',
    },
  },
  subagent: {
    expectParams: ['description', 'prompt', 'run_in_background'],
    description: 'Delegate a self-contained task to a subagent with its own context. It does NOT see this conversation: give a complete standalone prompt. Returns only its final result. Runs in the background by default and returns a durable subagent id; you are notified when it settles; `send_message` continues the same child. Set `run_in_background: false` only when your next action depends on the result.',
    params: { prompt: 'Complete, self-contained task; include everything the subagent needs.', description: 'Short (3-5 word) display label.', run_in_background: 'Default true.' },
  },
  subagent_fork: {
    expectParams: ['description', 'prompt', 'run_in_background'],
    description: 'Like `subagent`, but the child inherits all completed turns of this conversation (not the current in-flight turn). Use when the subtask builds on existing context. Same background/notification/`send_message` behaviour as `subagent`.',
    params: { prompt: 'The task; state only what is new.', description: 'Short (3-5 word) display label.', run_in_background: 'Default true.' },
  },
  list_agents: {
    expectParams: ['scope'],
    description: 'List your background subagents (id, label, status) to recall what you started — not to poll; you are notified on completion. Status: running = working now; idle = between turns; ready = stored only, resumable. The snapshot does not guarantee delivery; `send_message` does the real check. `send_message` works only for direct children (depth 1); deeper agents can only be targeted by `interrupt_agent`.',
    params: { scope: '`children` (default) or `descendants` (whole tree).' },
  },
  send_message: {
    expectParams: ['message', 'subagent_id'],
    description: 'Send a message to a background subagent; it becomes its next turn. If the subagent is busy the message waits, so it cannot redirect work already underway. Returns only delivery confirmation, never the subagent\'s answer. A failure means it was NOT delivered.', params: {},
  },
  interrupt_agent: {
    expectParams: ['agent_id'],
    description: 'Cancel the current turn of a background agent (direct child or deeper). Only that turn stops: queued messages stay parked, its own children keep running, and it stays available. Returns as soon as the request is accepted; interrupting a finished agent is a no-op.', params: {},
  },
  job_output: {
    expectParams: ['job_id', 'timeout_ms', 'wait'],
    description: 'Read a background job. Stream jobs return only output since the last read; final-output jobs return their result once settled. Ends with `[status: ...]`. Non-blocking unless `wait: true`; a timed-out wait returns `[status: running]` and leaves the job alive.',
    params: { wait: 'Block until terminal status or timeout.', timeout_ms: 'Max wait in ms (only with wait: true).' },
  },
  glob: {
    expectParams: ['path', 'pattern'],
    description: 'Find files by glob. Returns file paths only — never directories — including hidden and ignored files, newest first, max 100 (overflow is saved to a file). A pattern without "/" matches basenames at any depth; include a separator to anchor depth.',
    params: { pattern: 'Glob, e.g. "**/*.ts", "src/**/*.test.js".', path: 'Directory to search; defaults to the workspace.' },
  },
  grep: {
    expectParams: ['include', 'path', 'pattern'],
    description: 'Search file contents with a ripgrep regex. Returns matching lines with line numbers grouped by file; first 250 matches inline, the rest saved to a file.',
    params: { include: 'One glob filter (e.g. "*.{js,jsx}"); not a list, no negation.', path: 'File or directory; defaults to the workspace.' },
  },
  todo_write: {
    expectParams: ['todos'],
    description: 'Record the task list for multi-step work. Send the ENTIRE list every call — it replaces the previous one. Statuses: pending | in_progress | completed. Keep at least one `in_progress` while work remains; mark `completed` immediately when done. Skip for trivial single-step tasks.',
    params: { todos: 'The complete list.' },
  },
  skill_search: {
    expectParams: ['query'],
    description: 'Search available skills by keyword (Chinese supported; empty or * lists all). No skill catalog is in the prompt: if a task may match a skill, search first, then `skill_load`. Never guess skill names.', params: { query: 'Keywords.' },
  },
  ask_user_question: {
    expectParams: ['questions'],
    description: 'Ask the user concise questions when you need a confirmation, a choice, or missing information. Each question has a stable id echoed in the answer.',
    params: { questions: 'Questions to ask.' },
    nested: {
      'questions[].id': 'Stable id, echoed in the answer.',
      'questions[].question': 'The question.',
      'questions[].header': 'Optional short heading.',
      'questions[].multi_select': 'Allow multiple selections. Default false.',
      'questions[].options': 'Optional choices; put a recommended one first with "(Recommended)".',
      'questions[].options[].label': 'Short label.',
      'questions[].options[].description': 'One-sentence tradeoff.',
    },
  },
})

const withoutDescriptions = (value) => Array.isArray(value)
  ? value.map(withoutDescriptions)
  : value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'description').map(([key, child]) => [key, withoutDescriptions(child)]))
    : value

function projectNested(properties, nested, logger, toolName) {
  const originalFingerprint = JSON.stringify(withoutDescriptions(properties))
  const projectedRoot = structuredClone({ properties })
  const projected = projectedRoot.properties
  for (const [path, description] of Object.entries(nested || {})) {
    let node = projectedRoot
    const parts = path.split('.')
    for (let i = 0; i < parts.length; i++) {
      const match = /^([^[]+)(\[\])?$/.exec(parts[i])
      if (!match || !node || typeof node !== 'object') return null
      const children = node?.properties
      if (!children || typeof children !== 'object') return null
      if (!Object.hasOwn(children, match[1])) return null
      node = children[match[1]]
      if (match[2]) node = node?.items
    }
    if (!node || typeof node.description !== 'string' || Buffer.byteLength(description) >= Buffer.byteLength(node.description)) continue
    node.description = description
  }
  if (JSON.stringify(withoutDescriptions(projected)) !== originalFingerprint) {
    try { logger?.(`compact schema fallback ${toolName}: nested structure changed`) } catch {}
    return null
  }
  return projected
}

export function projectTools(tools, compactSchema = true, logger) {
  if (!compactSchema || !Array.isArray(tools)) return tools
  return tools.map((tool) => {
    const map = COMPACT_TOOL_DESCRIPTIONS[tool?.name]
    if (!map) return tool
    const properties = tool.parameters?.properties
    const actual = properties && typeof properties === 'object' ? Object.keys(properties).sort() : []
    const expected = [...map.expectParams].sort()
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      try { logger?.(`compact schema v${COMPACT_MAP_VERSION} fallback ${tool.name}: parameter names changed`) } catch {}
      return tool
    }
    const originalFingerprint = JSON.stringify(withoutDescriptions(tool.parameters))
    const projected = projectNested(properties, map.nested, logger, tool.name)
    if (!projected) {
      try { logger?.(`compact schema v${COMPACT_MAP_VERSION} fallback ${tool.name}: nested parameter path changed`) } catch {}
      return tool
    }
    for (const [name, description] of Object.entries(map.params)) {
      const old = projected[name]?.description
      if (typeof old === 'string' && Buffer.byteLength(description) < Buffer.byteLength(old)) projected[name] = { ...projected[name], description }
    }
    const description = typeof map.description === 'string' && typeof tool.description === 'string' && Buffer.byteLength(map.description) < Buffer.byteLength(tool.description) ? map.description : tool.description
    const result = { ...tool, description, parameters: { ...tool.parameters, properties: projected } }
    if (JSON.stringify(withoutDescriptions(result.parameters)) !== originalFingerprint) {
      try { logger?.(`compact schema v${COMPACT_MAP_VERSION} fallback ${tool.name}: schema structure changed`) } catch {}
      return tool
    }
    return result
  })
}

export const HIDDEN_BUILTIN_PARAGRAPHS = Object.freeze([
  { id: 'goal', group: 'extras', start: /^Use goal tools for one long-running completion objective\b/ },
  { id: 'workflow', group: 'extras', start: /^Use the workflow tool ONLY when\b/ },
  { id: 'ralph', group: 'extras', start: /^Use the ralph tool ONLY when\b/ },
  { id: 'cursor_agent', group: 'extras', start: /^When the user asks you to have Cursor implement, review\b/ },
])

export function stripHiddenBuiltinPromptSections(text, open = new Set(), options = {}) {
  if (typeof text !== 'string') return text
  try {
    const parts = text.split(/(\n{2,})/)
    const remove = new Set()
    for (const rule of HIDDEN_BUILTIN_PARAGRAPHS) {
      if (open.has(rule.group) || (rule.id === 'goal' && options.hasGoalHistory)) continue
      const matches = []
      for (let i = 0; i < parts.length; i += 2) if (rule.start.test(parts[i])) matches.push(i)
      if (matches.length !== 1) {
        if (matches.length > 1) try { options.logger?.(`hidden prompt section ${rule.id}: duplicate anchors`) } catch {}
        continue
      }
      const paragraph = parts[matches[0]]
      if (paragraph.length >= 150 && paragraph.length <= 1500 && !paragraph.includes('```')) remove.add(matches[0])
    }
    if (!remove.size) return text
    return parts.filter((_, i) => !remove.has(i) && !(i % 2 === 1 && remove.has(i - 1))).join('')
  } catch { return text }
}
