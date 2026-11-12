#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const all = ['dsh-tool-gate', 'dsh-context-compact', 'dsh-relay-dispatch'];
const args = process.argv.slice(2);
const flags = new Set(args.filter(a => a.startsWith('--')));
function value(name, fallback) { const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1]; }
const profile = value('--profile', 'web');
const mode = value('--mode', 'copy');
const uninstall = flags.has('--uninstall');
const dryRun = flags.has('--dry-run');
if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(profile)) throw new Error('Invalid --profile');
if (!['copy', 'link'].includes(mode)) throw new Error('--mode must be copy or link');
const selected = value('--plugins', all.join(',')).split(',').map(x => x.trim()).filter(Boolean);
if (!selected.length || selected.some(x => !all.includes(x))) throw new Error(`Allowed plugins: ${all.join(', ')}`);
const home = path.join(os.homedir(), '.dsh');
const profileDir = path.join(home, 'profiles', profile);
const manifest = path.join(profileDir, 'package.json');
function backup(file) { if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`); }
function remove(target) { if (dryRun) return console.log(`DRY-RUN remove ${target}`); fs.rmSync(target, { recursive: true, force: true }); console.log(`Removed ${target}`); }
function install(source, target) {
  if (dryRun) return console.log(`DRY-RUN ${mode} ${source} -> ${target}`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const previous = fs.lstatSync(target, { throwIfNoEntry: false });
  if (previous?.isSymbolicLink() || previous?.isFile()) fs.rmSync(target, { force: true });
  else if (previous) fs.renameSync(target, `${target}.bak-${Date.now()}`);
  if (mode === 'link') fs.symlinkSync(source, target, process.platform === 'win32' ? 'junction' : 'dir');
  else fs.cpSync(source, target, { recursive: true, filter: p => !p.includes(`${path.sep}node_modules${path.sep}`) && !p.includes(`${path.sep}test${path.sep}`) });
  console.log(`${mode === 'link' ? 'Linked' : 'Copied'} ${path.basename(target)} -> ${target}`);
}
const data = fs.existsSync(manifest) ? JSON.parse(fs.readFileSync(manifest, 'utf8')) : { name: `dsh-profile-${profile}`, private: true };
data.dependencies ??= {};
data.bundles ??= {};
for (const name of selected) {
  const source = path.join(root, 'packages', name);
  const target = path.join(profileDir, 'node_modules', '@dsh-external', name);
  const shared = path.join(home, 'plugins', name);
  if (uninstall) { remove(target); remove(shared); delete data.dependencies[`@dsh-external/${name}`]; delete data.bundles[`@dsh-external/${name}`]; }
  else {
    if (!fs.existsSync(path.join(source, 'package.json'))) throw new Error(`Missing plugin: ${name}`);
    install(source, target); install(source, shared);
    data.dependencies[`@dsh-external/${name}`] = `file:node_modules/@dsh-external/${name}`;
    data.bundles[`@dsh-external/${name}`] = true;
  }
}
if (dryRun) console.log(`DRY-RUN update ${manifest}`);
else { fs.mkdirSync(profileDir, { recursive: true }); if (fs.existsSync(manifest)) backup(manifest); fs.writeFileSync(manifest, JSON.stringify(data, null, 2) + '\n'); console.log(`Updated ${manifest}`); }
console.log(`${dryRun ? 'Dry-run complete' : uninstall ? 'Uninstall complete' : 'Install complete'}: profile=${profile}, plugins=${selected.join(',')}`);
