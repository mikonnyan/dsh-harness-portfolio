// Read-only corpus discovery. No message content is printed.
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
const root = process.env.DSH_TEST_SESSION_ROOT || 'C:/Users/mikon/.dsh/sessions'
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const candidates = []
for (const ws of fs.readdirSync(root)) {
  const wsPath = path.join(root, ws)
  for (const id of fs.readdirSync(wsPath)) {
    const file = path.join(wsPath, id, 'session.jsonl.zstd')
    if (!fs.existsSync(file)) continue
    const bytes = fs.readFileSync(file)
    const offsets = []
    for (let i = bytes.indexOf(MAGIC); i >= 0; i = bytes.indexOf(MAGIC, i + 4)) offsets.push(i)
    let rows = 0, checkpoints = 0, tombstones = 0, single = 0, large = 0, head = false
    let k = 0
    while (k < offsets.length) {
      let decoded
      for (let j = k + 1; j <= offsets.length; j++) {
        try { decoded = zlib.zstdDecompressSync(bytes.subarray(offsets[k], offsets[j] ?? bytes.length)); k = j; break } catch {}
      }
      if (!decoded) break
      for (const line of decoded.toString('utf8').split('\n')) {
        if (!line) continue
        let row
        try { row = JSON.parse(line) } catch { continue }
        rows++
        if (row.type === 'session') head = row.header?.version === 4 || row.version === 4
        const op = row.surfaceOp ?? row.surfaceOp0
        if (op && op !== 'append' && (op.startSeq !== undefined || op.s !== undefined || Array.isArray(op))) {
          const data = row.data ?? row.data0 ?? {}
          const source = data.source ?? data.message?.source ?? {}
          if (row.type === 'user/message' && source.kind === 'compact-checkpoint') checkpoints++
          if (row.type === 'user/message' && source.kind === 'context-compact-elide') tombstones++
          if (row.type === 'tool/result') single++
        }
        if ((row.type === 'tool/result' || row.type === 'assistant/message') && line.length > 20_000) large++
      }
    }
    if (head && checkpoints >= 2 && tombstones >= 1 && large >= 1) candidates.push({ file, rows, checkpoints, tombstones, single, large, size: bytes.length })
  }
}
console.log(JSON.stringify(candidates.sort((a,b) => b.checkpoints - a.checkpoints).slice(0, 12), null, 2))
