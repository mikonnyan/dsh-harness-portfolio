import { writeFileSync } from 'node:fs'
import { COMPACT_MAPS_BY_VERSION, projectToolsWithMeta } from '../lib/compact-schema.js'

const map = COMPACT_MAPS_BY_VERSION[2]
const names = Object.keys(map)
const tools = names.map((n) => ({
  name: n,
  description: ('Native long description for ' + n + '. ').repeat(20),
  parameters: {
    type: 'object',
    properties: Object.fromEntries(map[n].expectParams.map((p) => [p, { type: 'string', description: ('Native long description for ' + n + '.' + p + ' ').repeat(12) }])),
    required: map[n].expectParams.slice(0, 1),
  },
}))
const out = projectToolsWithMeta(tools, { compactSchema: true, mapVersion: 2 }).tools
const fixture = {
  tools: tools.map((t) => ({ name: t.name, params: map[t.name].expectParams, description: t.description })),
  expected: out.map((t) => ({ description: t.description, properties: t.parameters.properties })),
}
writeFileSync(new URL('./projected-map2.snapshot.json', import.meta.url), JSON.stringify(fixture, null, 1))
console.log('fixture written:', out.length, 'tools')
