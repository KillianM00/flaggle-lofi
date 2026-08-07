// Tiny zero-dependency test harness + browser-script loader for node.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export class AssertionError extends Error {}

export function ok(cond, msg = 'expected truthy') {
  if (!cond) throw new AssertionError(msg);
}

export function eq(actual, expected, msg = '') {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new AssertionError(`${msg ? msg + ': ' : ''}expected ${b}, got ${a}`);
}

export function close(actual, expected, tol, msg = '') {
  if (!(Math.abs(actual - expected) <= tol))
    throw new AssertionError(`${msg ? msg + ': ' : ''}expected ${expected}±${tol}, got ${actual}`);
}

export function throws(fn, msg = 'expected throw') {
  try {
    fn();
  } catch {
    return;
  }
  throw new AssertionError(msg);
}

// Loads browser scripts (which assign onto `window`) into a sandbox and
// returns the resulting window object.
export function loadBrowserScripts(files, extraGlobals = {}) {
  const sandbox = { console, Math, Date, JSON, ...extraGlobals };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  for (const f of files) {
    const code = fs.readFileSync(path.join(ROOT, f), 'utf8');
    vm.runInContext(code, sandbox, { filename: f });
  }
  return sandbox;
}

export function loadCountries() {
  return loadBrowserScripts(['js/data.js']).COUNTRIES;
}

// Minimal localStorage stand-in for testing storage-backed modules.
export function makeLocalStorage(seed = {}) {
  const store = new Map(Object.entries(seed));
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
    get length() {
      return store.size;
    },
    key: (i) => [...store.keys()][i] ?? null,
    _dump: () => Object.fromEntries(store),
  };
}

export function runTests(suite, tests) {
  let pass = 0;
  const failures = [];
  for (const [name, fn] of Object.entries(tests)) {
    try {
      fn();
      pass++;
      console.log(`  \x1b[32m✓\x1b[0m ${name}`);
    } catch (err) {
      failures.push([name, err]);
      console.log(`  \x1b[31m✗\x1b[0m ${name}`);
      console.log(`      ${err.message.split('\n').join('\n      ')}`);
      if (!(err instanceof AssertionError)) console.log(`      ${err.stack}`);
    }
  }
  const total = pass + failures.length;
  const color = failures.length ? '\x1b[31m' : '\x1b[32m';
  console.log(`${color}${suite}: ${pass}/${total} passed\x1b[0m\n`);
  if (failures.length) process.exitCode = 1;
  return failures.length === 0;
}
