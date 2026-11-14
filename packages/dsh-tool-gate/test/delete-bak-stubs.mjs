import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
// Regression guard (2026-11-14): the package root must stay free of .bak leftovers.
// The old git-env-live.mjs.bak / delete-stub.tmp.mjs.bak stubs were moved to
// ../.bak-trash-20261114/ once their content was superseded by test/git-env-live.test.mjs.
test('package root has zero .bak files', () => {
  for (const f of ['../git-env-live.mjs.bak', '../delete-stub.tmp.mjs.bak']) {
    const p = new URL(`${f}`, import.meta.url).pathname.replace(/^\/([A-Za-z]):/, '$1:')
    assert.equal(existsSync(p), false, `${f} must not come back`)
  }
})
