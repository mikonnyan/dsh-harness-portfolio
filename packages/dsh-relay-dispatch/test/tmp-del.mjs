import { unlinkSync } from 'node:fs'
unlinkSync('test/tmp-yaml-check.mjs')
console.log('removed')
