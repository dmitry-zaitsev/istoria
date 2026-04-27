#!/usr/bin/env node
// Sets the project version across package.json, root Cargo.toml
// (workspace.package.version), and src-tauri/tauri.conf.json. Used by
// the Release workflow and locally when cutting a release by hand.
//
// Usage: node scripts/set-version.mjs 1.2.3

import fs from 'node:fs';

const v = process.argv[2];
if (!v || !/^\d+\.\d+\.\d+$/.test(v)) {
  console.error(`bad version: ${JSON.stringify(v)} (want X.Y.Z)`);
  process.exit(1);
}

const writeJson = (path, mutate) => {
  const obj = JSON.parse(fs.readFileSync(path, 'utf8'));
  mutate(obj);
  fs.writeFileSync(path, JSON.stringify(obj, null, 2) + '\n');
};

writeJson('package.json', p => { p.version = v; });
writeJson('src-tauri/tauri.conf.json', t => { t.version = v; });

const cargoPath = 'Cargo.toml';
const re = /(\[workspace\.package\][\s\S]*?\nversion\s*=\s*")[^"]+(")/;
const c = fs.readFileSync(cargoPath, 'utf8');
if (!re.test(c)) {
  console.error('Cargo.toml: workspace.package version not found');
  process.exit(1);
}
fs.writeFileSync(cargoPath, c.replace(re, `$1${v}$2`));

console.log(`set version → ${v}`);
