#!/usr/bin/env node
// Generates js/data.js (country list) from the mledoze/countries dataset.
// Usage: node tools/gen-data.mjs <path-to-mledoze-countries.json>
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = process.argv[2];
if (!src) {
  console.error('usage: node tools/gen-data.mjs <mledoze countries.json>');
  process.exit(1);
}

const raw = JSON.parse(fs.readFileSync(src, 'utf8'));

// UN members + independent states, plus three widely-recognised extras.
const EXTRA = new Set(['PS', 'TW', 'XK']);
const picked = raw.filter(
  (c) => c.independent === true || c.unMember === true || EXTRA.has(c.cca2)
);

// Friendlier display names than the raw dataset for a guessing game.
const RENAME = {
  CD: 'DR Congo',
  CG: 'Republic of the Congo',
  KR: 'South Korea',
  KP: 'North Korea',
  GB: 'United Kingdom',
  US: 'United States',
  AE: 'United Arab Emirates',
  CZ: 'Czechia',
  CI: 'Ivory Coast',
  TL: 'East Timor',
  SZ: 'Eswatini',
  MM: 'Myanmar',
  CV: 'Cape Verde',
  VA: 'Vatican City',
  MK: 'North Macedonia',
  ST: 'Sao Tome and Principe',
  VC: 'Saint Vincent and the Grenadines',
  KN: 'Saint Kitts and Nevis',
  BA: 'Bosnia and Herzegovina',
  CF: 'Central African Republic',
  DO: 'Dominican Republic',
  TT: 'Trinidad and Tobago',
  AG: 'Antigua and Barbuda',
  PG: 'Papua New Guinea',
  SB: 'Solomon Islands',
  MH: 'Marshall Islands',
  FM: 'Micronesia',
  NL: 'Netherlands',
  LA: 'Laos',
  SY: 'Syria',
  RU: 'Russia',
  IR: 'Iran',
  BO: 'Bolivia',
  VE: 'Venezuela',
  TZ: 'Tanzania',
  MD: 'Moldova',
  BN: 'Brunei',
};

// Aliases people actually type. Merged with dataset altSpellings.
const ALIASES = {
  US: ['usa', 'u s a', 'america', 'united states of america', 'the states'],
  GB: ['uk', 'great britain', 'britain', 'england', 'scotland', 'wales', 'u k'],
  NL: ['holland', 'the netherlands'],
  CD: ['drc', 'democratic republic of the congo', 'congo kinshasa', 'zaire', 'congo'],
  CG: ['congo brazzaville', 'congo republic', 'congo'],
  AE: ['uae', 'emirates', 'u a e'],
  KR: ['republic of korea', 'korea', 's korea', 'rok'],
  KP: ['dprk', 'democratic peoples republic of korea', 'n korea', 'korea'],
  CZ: ['czech republic', 'czechia'],
  CI: ['cote divoire', "cote d'ivoire", 'ivory coast'],
  MM: ['burma'],
  SZ: ['swaziland'],
  TL: ['timor leste', 'east timor'],
  MK: ['macedonia', 'fyrom'],
  CV: ['cabo verde'],
  VA: ['holy see', 'the vatican'],
  TR: ['turkiye', 'turkey'],
  GR: ['hellas', 'hellenic republic'],
  CH: ['swiss', 'helvetia'],
  DE: ['deutschland', 'germany'],
  ES: ['espana', 'spain'],
  IT: ['italia'],
  JP: ['nippon', 'nihon'],
  CN: ['prc', 'peoples republic of china', 'mainland china'],
  TW: ['republic of china', 'chinese taipei', 'formosa'],
  RU: ['russian federation'],
  IE: ['republic of ireland', 'eire'],
  ZA: ['rsa', 'south africa'],
  DO: ['dr'],
  LA: ['lao', 'lao pdr'],
  BN: ['brunei darussalam'],
  FM: ['federated states of micronesia'],
  PS: ['state of palestine', 'palestinian territories'],
  VC: ['st vincent', 'saint vincent', 'st vincent and the grenadines'],
  KN: ['st kitts', 'saint kitts', 'st kitts and nevis'],
  LC: ['st lucia', 'saint lucia'],
  ST: ['sao tome', 'st tome and principe'],
  BA: ['bosnia', 'herzegovina'],
  CF: ['car'],
  PG: ['png'],
  NZ: ['aotearoa'],
  SR: ['surinam'],
  MW: ['nyasaland'],
  GW: ['guinea bissau'],
  GQ: ['equatorial guinea'],
  SS: ['s sudan'],
  SD: ['n sudan'],
  MR: ['mauritania'],
  BY: ['byelorussia', 'belorussia'],
  KH: ['kampuchea'],
  LK: ['ceylon'],
  TH: ['siam'],
  IR: ['persia'],
  ET: ['abyssinia'],
  GH: ['gold coast'],
  ZW: ['rhodesia'],
  ZM: ['northern rhodesia'],
  BF: ['upper volta'],
  BJ: ['dahomey'],
  NA: ['south west africa'],
  BZ: ['british honduras'],
  VU: ['new hebrides'],
  TV: ['ellice islands'],
  KI: ['gilbert islands'],
  WS: ['western samoa'],
  MG: ['malagasy'],
};

const norm = (s) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

const flagEmoji = (cc) =>
  cc === 'XK'
    ? '🏴'
    : String.fromCodePoint(...[...cc.toUpperCase()].map((ch) => 0x1f1e6 + ch.charCodeAt(0) - 65));

const out = picked
  .map((c) => {
    const code = c.cca2;
    const name = RENAME[code] || c.name.common;
    const aliasSet = new Set();
    const add = (v) => {
      if (!v) return;
      const n = norm(String(v));
      if (n && n !== norm(name)) aliasSet.add(n);
    };
    (c.altSpellings || []).forEach(add);
    add(c.name.official);
    add(c.name.common);
    (ALIASES[code] || []).forEach(add);
    add(c.cca3);

    return {
      c: code.toLowerCase(),
      n: name,
      a: [...aliasSet].sort(),
      lat: Number(c.latlng[0].toFixed(4)),
      lng: Number(c.latlng[1].toFixed(4)),
      r:
        c.region === 'Americas'
          ? (c.subregion || '').includes('South')
            ? 'South America'
            : 'North America'
          : c.region,
      sr: c.subregion || c.region,
      e: flagEmoji(code),
      cap: (c.capital && c.capital[0]) || '',
    };
  })
  .sort((a, b) => a.n.localeCompare(b.n));

const banner = `// Auto-generated by tools/gen-data.mjs — do not edit by hand.
// Source: mledoze/countries (ODbL). Flags: flagcdn.com (public domain).
// ${out.length} countries.
`;

const body = out
  .map((c) => JSON.stringify(c))
  .join(',\n  ');

const js = `${banner}window.COUNTRIES = [\n  ${body}\n];\n`;

fs.mkdirSync(path.join(ROOT, 'js'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'js', 'data.js'), js);
console.log(`wrote js/data.js — ${out.length} countries, ${(js.length / 1024).toFixed(1)} KB`);
