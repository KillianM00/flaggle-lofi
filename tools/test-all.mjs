#!/usr/bin/env node
// Runs every suite: data, engine, store (node) then the UI (headless firefox).
import { spawn } from 'node:child_process';
import path from 'node:path';
import { ROOT } from './harness.mjs';

const SUITES = [
  ['data', 'tools/test-data.mjs'],
  ['pixels', 'tools/test-pixels.mjs'],
  ['engine', 'tools/test-engine.mjs'],
  ['colour', 'tools/test-colour.mjs'],
  ['store', 'tools/test-store.mjs'],
  ['ui', 'tools/test-ui.mjs'],
];

const only = process.argv[2];
const run = (file) =>
  new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(ROOT, file)], {
      cwd: ROOT,
      stdio: 'inherit',
    });
    p.on('exit', (code) => resolve(code === 0));
  });

let allOk = true;
for (const [name, file] of SUITES) {
  if (only && only !== name) continue;
  console.log(`\n\x1b[1m── ${name} ──\x1b[0m`);
  const ok = await run(file);
  allOk = allOk && ok;
}

console.log(
  allOk ? '\n\x1b[32m☕ everything passes.\x1b[0m\n' : '\n\x1b[31m🫠 some suites failed.\x1b[0m\n'
);
process.exit(allOk ? 0 : 1);
