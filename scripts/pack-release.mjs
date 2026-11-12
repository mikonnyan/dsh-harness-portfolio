#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'dist', 'release');
fs.mkdirSync(output, { recursive: true });
for (const file of fs.readdirSync(output)) if (file.endsWith('.tgz') || file === 'SHA256SUMS.txt') fs.rmSync(path.join(output, file));
const artifacts = [];
for (const name of fs.readdirSync(path.join(root, 'packages'))) {
  const dir = path.join(root, 'packages', name);
  const manifest = path.join(dir, 'package.json');
  if (!fs.existsSync(manifest)) continue;
  const pkg = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  const result = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['pack', dir, '--pack-destination', output, '--json'], { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) { console.error(result.stderr); process.exit(result.status ?? 1); }
  const info = JSON.parse(result.stdout)[0];
  const source = path.join(output, info.filename);
  const target = path.join(output, `${name}-${pkg.version}.tgz`);
  if (source !== target) fs.renameSync(source, target);
  artifacts.push(target);
  console.log(`Packed ${path.basename(target)}`);
}
const sums = artifacts.map(file => `${crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}  ${path.basename(file)}`).join('\n') + '\n';
fs.writeFileSync(path.join(output, 'SHA256SUMS.txt'), sums);
if (process.argv.includes('--publish')) {
  const files = [...artifacts, path.join(output, 'SHA256SUMS.txt')];
  const view = spawnSync('gh', ['release', 'view', 'v1.1.0', '--repo', 'mikonnyan/dsh-harness-portfolio'], { stdio: 'ignore' });
  const args = view.status === 0 ? ['release', 'upload', 'v1.1.0', ...files, '--clobber', '--repo', 'mikonnyan/dsh-harness-portfolio'] : ['release', 'create', 'v1.1.0', ...files, '--title', 'v1.1.0 — DSH v4 Session & One-Command Installer', '--notes', 'Cross-platform one-command plugin installer, isolated canary test runner, and pre-packed plugin archives.', '--repo', 'mikonnyan/dsh-harness-portfolio'];
  const release = spawnSync('gh', args, { stdio: 'inherit', cwd: root });
  process.exit(release.status ?? 1);
}
