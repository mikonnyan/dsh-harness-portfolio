#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

function detect() {
  const candidates = [];
  if (process.env.DSH_CHECKOUT) candidates.push(process.env.DSH_CHECKOUT);
  const global = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['root', '-g'], { encoding: 'utf8' });
  if (global.status === 0) candidates.push(path.join(global.stdout.trim(), '@deepseek-ai', 'dsh'));
  if (process.env.APPDATA) candidates.push(path.join(process.env.APPDATA, 'npm', 'node_modules', '@deepseek-ai', 'dsh'));
  candidates.push('/usr/local/lib/node_modules/@deepseek-ai/dsh', '/usr/lib/node_modules/@deepseek-ai/dsh', path.join(os.homedir(), '.npm-global', 'lib', 'node_modules', '@deepseek-ai', 'dsh'));
  return candidates.find(p => fs.existsSync(path.join(p, 'package.json')));
}
const checkout = detect();
if (!checkout) { console.error('Cannot detect @deepseek-ai/dsh. Set DSH_CHECKOUT to its installation directory.'); process.exit(1); }
console.log(`DSH checkout: ${checkout}`);
if (process.argv.includes('--setup-profile')) {
  const dir = path.join(os.homedir(), '.dsh', 'profiles', 'test-canary');
  const file = path.join(dir, 'package.json');
  fs.mkdirSync(dir, { recursive: true });
  if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak-${Date.now()}`);
  else fs.writeFileSync(file, JSON.stringify({ name: 'dsh-profile-test-canary', private: true, dependencies: {}, bundles: {} }, null, 2) + '\n');
  console.log(`Canary profile ready: ${dir}`);
}
const result = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['test'], { stdio: 'inherit', cwd: path.dirname(new URL(import.meta.url).pathname.replace(/^\/(?:[A-Za-z]:)/, m => m.slice(1))).replace(/\/scripts$/, ''), env: { ...process.env, DSH_CHECKOUT: checkout, DSH_PROFILE: 'test-canary' } });
process.exit(result.status ?? 1);
