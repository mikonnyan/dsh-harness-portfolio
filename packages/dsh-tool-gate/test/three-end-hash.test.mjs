import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
// Local repo hygiene (2026-11-14): the three deployment copies must stay byte-identical.
const h = (p) => { try { return createHash('sha256').update(readFileSync(p)).digest('hex') } catch { return 'MISSING' } }
test('three-end SHA-256: lib and tests identical across main, plugin and portfolio', { skip: !existsSync('C:/Users/mikon/.dsh/plugins/dsh-tool-gate/lib/permission-guard.js') }, () => {
  const groups = {
    'lib/permission-guard.js': [
      'C:/Users/mikon/Desktop/asd/dsh-tool-gate/lib/permission-guard.js',
      'C:/Users/mikon/.dsh/plugins/dsh-tool-gate/lib/permission-guard.js',
      'C:/Users/mikon/Desktop/asd/dsh-harness-portfolio/packages/dsh-tool-gate/lib/permission-guard.js',
    ],
    'test/permission-guard.test.mjs': [
      'C:/Users/mikon/Desktop/asd/dsh-tool-gate/test/permission-guard.test.mjs',
      'C:/Users/mikon/.dsh/plugins/dsh-tool-gate/test/permission-guard.test.mjs',
      'C:/Users/mikon/Desktop/asd/dsh-harness-portfolio/packages/dsh-tool-gate/test/permission-guard.test.mjs',
    ],
  }
  for (const [name, paths] of Object.entries(groups)) {
    const digests = paths.map(h)
    assert.notEqual(digests[0], 'MISSING', `${name} main missing`)
    assert.ok(digests.every((d) => d === digests[0]), `${name} diverged: ${digests.join(' ')}`)
  }
})

