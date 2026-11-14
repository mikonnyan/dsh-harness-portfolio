// Sync portfolio to origin: status -> add -A -> commit -> push (env-sanitized git).
// Usage: node scripts/git-sync.mjs [commit-message]
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
const execFileAsync = promisify(execFile)

const msg = process.argv[2] || 'cleanup: remove .bak temp backups; sync core packages; fix attach-first test'

function sanitizedEnv() {
  const env = { ...process.env }
  for (const key of Object.keys(env)) if (key.startsWith('GIT_CONFIG')) delete env[key]
  return env
}

async function git(...args) {
  const { stdout, stderr } = await execFileAsync('git', ['-c', 'core.quotepath=off', ...args], {
    cwd: process.cwd(),
    env: sanitizedEnv(),
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  })
  return { stdout: String(stdout).trimEnd(), stderr: String(stderr).trimEnd() }
}

const statusOut = await git('status', '--porcelain=v1', '-b')
console.log('=== STATUS ===')
console.log(statusOut.stdout)

const diff = await git('diff', '--stat', 'HEAD')
console.log('=== DIFFSTAT ===')
console.log(diff.stdout)

// Guard: refuse to commit .bak files or known sensitive files
const lines = statusOut.stdout.split('\n').filter((l) => l && !l.startsWith('##'))
const bad = lines.filter((l) => /\.bak/i.test(l) || /(^|[\/])(\.env(\..*)?|\.credentials\.yaml|secrets?)($|[\/])/i.test(l))
if (bad.length) {
  console.error('SENSITIVE_OR_BAK_DETECTED:')
  for (const b of bad) console.error('  ' + b)
  process.exit(2)
}

console.log('=== ADD ===')
console.log((await git('add', '-A')).stdout)

console.log('=== COMMIT ===')
try {
  console.log((await git('commit', '-m', msg)).stdout)
} catch (e) {
  console.log('commit skipped or failed: ' + String(e.message).split('\n')[0])
}

console.log('=== PUSH ===')
try {
  console.log((await git('push', 'origin', 'main')).stdout || (await git('push', 'origin', 'HEAD')).stdout)
} catch (e) {
  console.log('push failed: ' + String(e.message).split('\n').slice(0, 5).join('\n'))
}

const final = await git('status', '--porcelain=v1', '-b')
console.log('=== FINAL STATUS ===')
console.log(final.stdout)
