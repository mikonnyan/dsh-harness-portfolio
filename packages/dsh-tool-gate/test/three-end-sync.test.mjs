import test from 'node:test'
import assert from 'node:assert/strict'
import { copyFileSync, readFileSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
// Keep the three copies (main source, plugin install, portfolio package) byte-identical.
// Skipped when the side copies are absent (e.g. in CI or a fresh clone).
const pluginRoot = 'C:/Users/mikon/.dsh/plugins/dsh-tool-gate'
const portfolioRoot = 'C:/Users/mikon/Desktop/asd/dsh-harness-portfolio/packages/dsh-tool-gate'
const pairs = [
  ['../lib/permission-guard.js', `${pluginRoot}/lib/permission-guard.js`],
  ['../lib/permission-guard.js', `${portfolioRoot}/lib/permission-guard.js`],
  ['./permission-guard.test.mjs', `${pluginRoot}/test/permission-guard.test.mjs`],
  ['./permission-guard.test.mjs', `${portfolioRoot}/test/permission-guard.test.mjs`],
]
const h = (p) => createHash('sha256').update(readFileSync(p)).digest('hex')
test('three-end sync: plugin and portfolio copies are byte-identical', { skip: !existsSync(`${pluginRoot}/lib/permission-guard.js`) }, () => {
  for (const [from, to] of pairs) {
    const src = new URL(from, import.meta.url).pathname.replace(/^\/([A-Za-z]):/, '$1:')
    copyFileSync(src, to)
    assert.equal(h(src), h(to), `${to} must match ${src}`)
  }
})
