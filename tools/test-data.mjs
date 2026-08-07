#!/usr/bin/env node
// Validates js/data.js against the flags/ directory.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCountries, runTests, ok, eq } from './harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const COUNTRIES = loadCountries();

runTests('data', {
  'has ~197 countries'() {
    ok(COUNTRIES.length >= 195 && COUNTRIES.length <= 200, `got ${COUNTRIES.length}`);
  },
  'every country has a flag file on disk'() {
    const missing = COUNTRIES.filter(
      (c) => !fs.existsSync(path.join(ROOT, 'flags', `${c.c}.svg`))
    ).map((c) => c.c);
    eq(missing.join(','), '', 'missing flag files');
  },
  'every flag file is real SVG content'() {
    const bad = COUNTRIES.filter((c) => {
      const head = fs.readFileSync(path.join(ROOT, 'flags', `${c.c}.svg`), 'utf8').slice(0, 200);
      return !head.includes('<svg');
    }).map((c) => c.c);
    eq(bad.join(','), '', 'files that are not SVG');
  },
  'no orphan flag files'() {
    const codes = new Set(COUNTRIES.map((c) => c.c));
    const orphans = fs
      .readdirSync(path.join(ROOT, 'flags'))
      .filter((f) => f.endsWith('.svg'))
      .map((f) => f.replace('.svg', ''))
      .filter((c) => !codes.has(c));
    eq(orphans.join(','), '', 'orphan flags');
  },
  'codes and names are unique'() {
    eq(new Set(COUNTRIES.map((c) => c.c)).size, COUNTRIES.length, 'unique codes');
    eq(new Set(COUNTRIES.map((c) => c.n)).size, COUNTRIES.length, 'unique names');
  },
  'coordinates are sane'() {
    const bad = COUNTRIES.filter(
      (c) =>
        !Number.isFinite(c.lat) ||
        !Number.isFinite(c.lng) ||
        Math.abs(c.lat) > 90 ||
        Math.abs(c.lng) > 180
    ).map((c) => c.c);
    eq(bad.join(','), '', 'bad coords');
  },
  'regions are from the known set'() {
    const known = new Set(['Africa', 'Asia', 'Europe', 'North America', 'South America', 'Oceania']);
    const bad = [...new Set(COUNTRIES.map((c) => c.r))].filter((r) => !known.has(r));
    eq(bad.join(','), '', 'unknown regions');
  },
  'every region has enough countries for practice mode'() {
    const counts = {};
    for (const c of COUNTRIES) counts[c.r] = (counts[c.r] || 0) + 1;
    for (const [r, n] of Object.entries(counts)) ok(n >= 10, `${r} only has ${n}`);
  },
  'spot-check known coordinates'() {
    const byCode = Object.fromEntries(COUNTRIES.map((c) => [c.c, c]));
    ok(Math.abs(byCode.jp.lat - 36) < 3, 'japan lat');
    ok(Math.abs(byCode.br.lng + 55) < 10, 'brazil lng');
    eq(byCode.us.n, 'United States');
    eq(byCode.cd.n, 'DR Congo');
    eq(byCode.kr.n, 'South Korea');
  },
  'common aliases resolve to exactly one country'() {
    const index = new Map();
    for (const c of COUNTRIES) {
      for (const a of [c.n.toLowerCase(), ...c.a]) {
        if (!index.has(a)) index.set(a, []);
        index.get(a).push(c.c);
      }
    }
    for (const [alias, code] of [
      ['usa', 'us'],
      ['uk', 'gb'],
      ['holland', 'nl'],
      ['uae', 'ae'],
      ['drc', 'cd'],
      ['burma', 'mm'],
      ['ivory coast', 'ci'],
      ['persia', 'ir'],
      ['czech republic', 'cz'],
      ['east timor', 'tl'],
    ]) {
      const hits = index.get(alias) || [];
      eq(hits.join(','), code, `alias "${alias}"`);
    }
  },
  'flag emoji present for all but Kosovo'() {
    const bad = COUNTRIES.filter((c) => !c.e || [...c.e].length < 1).map((c) => c.c);
    eq(bad.join(','), '', 'missing emoji');
  },
});
