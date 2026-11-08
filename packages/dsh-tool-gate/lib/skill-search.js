/**
 * skill-search — on-demand skill discovery and loading, replacing
 * `dsh-tool-skill`'s full-catalog injection.
 *
 * WHY: the available-skills reminder (`<available_skills>`, ~9KB with many
 * skills) is injected into the first step by dsh-tool-skill and again after
 * every promotion/compaction. We remove the catalog injection entirely and
 * expose two small tools instead:
 *
 *  - `skill_search` — list skills whose name/description match a query
 *    (summaries only, bounded; no bodies). Supports English tokens, Chinese
 *    2-gram fragments, and `*`/empty query to list all skill names.
 *  - `skill_load` — load ONE skill's full instructions by exact name and
 *    inject them for the NEXT request via `agent.inject` (the non-waking
 *    next-step inbox).
 *
 * NOTE: this plugin REPLACES the `dsh-tool-skill` row in the preset composition.
 */

export const name = 'skill-search'
export const inject = ['agents', 'tools', 'skills']

const MAX_RESULTS = 20
const MAX_NAMES = 60

function toJsonSchema(spec) {
  const properties = {}
  const required = []
  for (const [key, meta] of Object.entries(spec || {})) {
    const prop = { type: meta.type }
    if (meta.description) prop.description = meta.description
    properties[key] = prop
    if (meta.required) required.push(key)
  }
  return { type: 'object', properties, required, additionalProperties: false }
}

export function apply(ctx) {
  const tokens = (text) => (text || '').toLowerCase().split(/[^a-z0-9_-]+/).filter(Boolean)
  const cjkFrags = (text) => {
    const out = []
    for (const run of (text || '').match(/[\u4e00-\u9fff]+/g) || []) {
      if (run.length <= 2) out.push(run)
      else for (let i = 0; i < run.length - 1; i++) out.push(run.slice(i, i + 2))
    }
    return out
  }
  const score = (skill, query) => {
    const hay = `${skill.name} ${skill.description ?? ''} ${skill.whenToUse ?? ''}`.toLowerCase()
    const q = (query || '').trim().toLowerCase()
    let s = 0
    if (q && hay.includes(q)) s += 10
    for (const t of tokens(q)) if (hay.includes(t)) s += 2
    for (const f of cjkFrags(q)) if (hay.includes(f)) s += 1
    return s
  }

  ctx.tools.register({
    name: 'skill_search',
    description: 'Search the available skills by keyword and return matching skill names with short descriptions. This session keeps NO skill catalog in the prompt — if a task looks like it matches a skill (document conversion, image processing, game reviews, markdown, PDF, spreadsheets, …), call skill_search FIRST to find it, then skill_load to activate it. Do NOT assume skill names from memory. Chinese keywords are supported (e.g. 生图, 文档); empty query or * lists all skill names.',
    parameters: toJsonSchema({
      query: { type: 'string', required: true, description: 'search keywords (e.g. "pdf", "obsidian", "game review")' },
    }),
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string' } }, required: ['text'] },
      render: (_a, v) => [{ type: 'text', text: v.text }],
    },
    async execute(args, exec) {
      const scope = exec?.agent ?? ctx
      try {
        const all = await ctx.skills.list({
          scope,
          cwd: exec?.agent?.session?.header?.cwd,
          signal: exec?.signal,
        })
        const q = String(args.query ?? '').trim()
        if (q === '' || q === '*') {
          const names = all.map((s) => s.name)
          const shown = names.slice(0, MAX_NAMES).join(', ')
          const more = names.length > MAX_NAMES ? `, …(${names.length - MAX_NAMES} more)` : ''
          return { text: `Skills (${names.length}): ${shown}${more}\n\nLoad one with skill_load (exact name).` }
        }
        const matches = all.map((skill) => ({ skill, s: score(skill, q) })).filter((x) => x.s > 0).sort((x, y) => y.s - x.s).map((x) => x.skill)
        const head = matches.slice(0, MAX_RESULTS)
        const lines = head.map((skill) => {
          const desc = (skill.description || '').split('\n')[0]
          return `- ${skill.name}: ${desc}`
        })
        if (lines.length === 0) return { text: `No skills match "${args.query}". Use skill_search with other keywords.` }
        const extra = matches.length > MAX_RESULTS ? `\n…(${matches.length - MAX_RESULTS} more)` : ''
        return { text: `Matching skills (${matches.length}):\n${lines.join('\n')}${extra}\n\nLoad one with skill_load (exact name).` }
      } catch (error) {
        return { text: `skill_search unavailable: ${String((error && error.message) || error)}` }
      }
    },
  })

  ctx.tools.register({
    name: 'skill_load',
    description: 'Load the full instructions of ONE skill by its exact name (from skill_search results) and inject them for the next request. Call this before acting on a task that matches the skill.',
    parameters: toJsonSchema({
      name: { type: 'string', required: true, description: 'exact skill name (kebab-case, from skill_search)' },
    }),
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string' } }, required: ['text'] },
      render: (_a, v) => [{ type: 'text', text: v.text }],
    },
    async execute(args, exec) {
      try {
        const agent = exec?.agent
        if (agent === undefined) return { text: 'skill_load requires an agent context.' }
        const skill = await ctx.skills.get(args.name, {
          scope: agent,
          cwd: agent.session.header.cwd,
          signal: exec?.signal,
        })
        if (skill === undefined) {
          return { text: `No skill named "${args.name}". Run skill_search to list available skills.` }
        }
        const body = extractSkillBody(skill)
        if (body.length === 0) {
          return { text: `Skill "${args.name}" has no loadable body.` }
        }
        agent.inject({
          id: `skill-load-${args.name}-${Date.now()}`,
          role: 'user',
          content: [{ type: 'text', text: body }],
          source: { kind: 'skill-invocation', name: args.name, form: 'instructions' },
        })
        return { text: `Skill "${args.name}" loaded; its instructions will be injected for the next request.` }
      } catch (error) {
        return { text: `skill_load failed: ${String((error && error.message) || error)}` }
      }
    },
  })
}

function extractSkillBody(skill) {
  const content = skill?.content ?? skill?.instructions ?? skill?.body
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map((part) => (typeof part === 'string' ? part : JSON.stringify(part))).join('\n')
  }
  return ''
}
