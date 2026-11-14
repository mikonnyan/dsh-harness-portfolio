/** Salience tags for @auto (v5 §7). Corrections and open items are kept verbatim. */

const CORRECTION = /不要|别|不是|改成|改用|改为|错了|修正|不对|wrong|don't|instead|\bnot\b/i
const OPEN_ITEM = /下一步|接下来|TODO|待办|之后再|要不要|是否|待确认/i
const DONE_STATUS = new Set(['completed', 'complete', 'done', 'cancelled', 'canceled'])

export function clipVerbatim(text, max = 300) {
  const chars = Array.from(String(text || '').trim())
  if (chars.length <= max) return chars.join('')
  return chars.slice(0, max).join('')
}

export function userTextOf(ev) {
  const blocks = ev?.data?.content || ev?.data?.message?.content || []
  if (!Array.isArray(blocks)) return ''
  return blocks.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n')
}

export function assistantTextOf(ev) {
  const blocks = ev?.data?.message?.content || ev?.data?.content || []
  if (!Array.isArray(blocks)) return ''
  return blocks.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n')
}

function linesOf(text) {
  return String(text || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
}

function todoPayload(ev) {
  if (ev?.type !== 'tool/call' || ev.data?.name !== 'todo_write') return null
  let args = ev.data.arguments ?? ev.data.args
  if (typeof args === 'string') {
    try { args = JSON.parse(args) } catch { return null }
  }
  const todos = args?.todos || args?.items
  return Array.isArray(todos) ? todos : null
}

/** Pull user corrections, structured todos, and tail open-items. Order is preserved. */
export function collectSalience(events) {
  const list = Array.isArray(events) ? events.filter(Boolean) : []
  const corrections = []
  const seen = new Set()
  const openMap = new Map()
  const pushCorrection = (line) => {
    const text = clipVerbatim(line)
    if (!text || seen.has(text)) return
    seen.add(text)
    corrections.push(text)
  }
  const pushOpen = (line) => {
    const text = clipVerbatim(String(line || '').replace(/^[-*•]+\s*/, '').replace(/^\d+[.)]\s*/, ''))
    if (!text || openMap.has(text)) return
    openMap.set(text, text)
  }
  let lastUser = -1
  let lastAssistant = -1
  list.forEach((ev, i) => {
    if (ev.type === 'user/message') lastUser = i
    if (ev.type === 'assistant/message') lastAssistant = i
  })
  let prev = null
  for (let i = 0; i < list.length; i++) {
    const ev = list[i]
    const weightTail = i === lastUser || i === lastAssistant
    const todos = todoPayload(ev)
    if (todos) {
      for (const item of todos) {
        const content = typeof item === 'string' ? item : item?.content || item?.text || ''
        const status = String(item?.status || 'pending').toLowerCase()
        const text = clipVerbatim(content)
        if (!text) continue
        if (DONE_STATUS.has(status)) openMap.delete(text)
        else if (!openMap.has(text)) openMap.set(text, text)
      }
    } else if (ev.type === 'user/message') {
      const text = userTextOf(ev).trim()
      if (prev === 'assistant/message' && text && Array.from(text).length <= 80) pushCorrection(text)
      for (const line of linesOf(text)) {
        if (CORRECTION.test(line)) pushCorrection(line)
        else if (weightTail && OPEN_ITEM.test(line)) pushOpen(line)
      }
    } else if (ev.type === 'assistant/message') {
      const text = assistantTextOf(ev)
      const tail = linesOf(text).slice(weightTail ? -8 : -4)
      for (const line of tail) if (OPEN_ITEM.test(line)) pushOpen(line)
    }
    prev = ev.type
  }
  return { corrections, openItems: [...openMap.values()] }
}

export function renderSalienceSections({ corrections = [], openItems = [], anchors = [], narrative = [] } = {}) {
  const section = (title, rows, cap) => {
    const body = []
    for (const row of rows) {
      if (!row) continue
      if (cap && body.join('\n').length > cap) break
      body.push(row)
    }
    return `## ${title}\n${body.join('\n') || '（无）'}`
  }
  return [
    section('决定与纠正', corrections),
    section('未完成事项', openItems),
    section('锚点', anchors),
    section('经过', narrative, 1500),
  ].join('\n')
}
