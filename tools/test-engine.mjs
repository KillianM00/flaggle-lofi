#!/usr/bin/env node
import { loadBrowserScripts, runTests, ok, eq, close } from './harness.mjs';

const w = loadBrowserScripts(['js/data.js', 'js/engine.js']);
const E = w.Engine;
const COUNTRIES = w.COUNTRIES;
const byCode = Object.fromEntries(COUNTRIES.map((c) => [c.c, c]));

runTests('engine', {
  'normalize strips case, accents and punctuation'() {
    eq(E.normalize('  Côte d’Ivoire '), 'cote d ivoire');
    eq(E.normalize('U.S.A.'), 'u s a');
    eq(E.normalize(null), '');
  },

  'distance: known pairs'() {
    // Coordinates are country centroids, not capitals.
    close(E.distance(byCode.fr, byCode.de), 758, 60, 'France to Germany');
    close(E.distance(byCode.us, byCode.jp), 10030, 400, 'US to Japan');
    eq(Math.round(E.distance(byCode.jp, byCode.jp)), 0, 'self distance');
    ok(E.distance(byCode.cl, byCode.ru) > 15000, 'antipodal-ish pair is far');
  },

  'distance is symmetric'() {
    for (const [a, b] of [['br', 'ng'], ['au', 'ca'], ['za', 'is']]) {
      close(E.distance(byCode[a], byCode[b]), E.distance(byCode[b], byCode[a]), 0.001, `${a}/${b}`);
    }
  },

  'bearing points the right way'() {
    // Mexico is south of the United States, Canada is north.
    eq(E.arrowFor(E.bearing(byCode.us, byCode.mx)), '⬇️');
    eq(E.arrowFor(E.bearing(byCode.us, byCode.ca)), '⬆️');
    // Japan is east of China, Portugal is west of Spain.
    eq(E.arrowFor(E.bearing(byCode.cn, byCode.jp)), '➡️');
    eq(E.arrowFor(E.bearing(byCode.es, byCode.pt)), '⬅️');
    eq(E.directionLabel(0), 'north');
    eq(E.directionLabel(135), 'south-east');
    eq(E.arrowFor(359), '⬆️', 'wraps past 360');
  },

  'proximity: 100 at zero, 0 at max, monotonic'() {
    eq(E.proximity(0), 100);
    eq(E.proximity(E.MAX_DIST), 0);
    eq(E.proximity(999999), 0, 'clamped');
    ok(E.proximity(500) > E.proximity(5000), 'closer scores higher');
  },

  'formatDistance is readable'() {
    eq(E.formatDistance(0), '0 km');
    eq(E.formatDistance(5.24), '5.2 km');
    eq(E.formatDistance(12345.6), '12,346 km');
  },

  'daily pick is deterministic for a date'() {
    const a = E.dailyCountry(COUNTRIES, '2026-08-05');
    const b = E.dailyCountry(COUNTRIES, '2026-08-05');
    eq(a.c, b.c);
    ok(a.c && byCode[a.c], 'is a real country');
  },

  'daily pick changes day to day'() {
    const seen = new Set();
    for (let i = 0; i < 30; i++) {
      const d = new Date(Date.UTC(2026, 7, 1 + i));
      seen.add(E.dailyCountry(COUNTRIES, E.dateKey(new Date(d.getTime() + d.getTimezoneOffset() * 60000))).c);
    }
    ok(seen.size >= 28, `30 days produced ${seen.size} distinct flags`);
  },

  'no repeats within one full cycle'() {
    const n = COUNTRIES.length;
    const seen = new Set();
    for (let day = 0; day < n; day++) {
      const d = new Date(Date.UTC(2026, 0, 1 + day));
      const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(
        d.getUTCDate()
      ).padStart(2, '0')}`;
      seen.add(E.dailyCountry(COUNTRIES, key).c);
    }
    eq(seen.size, n, 'every country appears exactly once per cycle');
  },

  'the next cycle uses a different order'() {
    const n = COUNTRIES.length;
    const dayKey = (day) => {
      const d = new Date(Date.UTC(2026, 0, 1 + day));
      return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(
        d.getUTCDate()
      ).padStart(2, '0')}`;
    };
    let same = 0;
    for (let i = 0; i < 20; i++) {
      if (E.dailyCountry(COUNTRIES, dayKey(i)).c === E.dailyCountry(COUNTRIES, dayKey(i + n)).c) same++;
    }
    ok(same < 5, `${same}/20 positions identical across cycles`);
  },

  'dateKey and dayNumber round-trip'() {
    eq(E.dateKey(new Date(2026, 7, 5)), '2026-08-05');
    eq(E.dayNumber('2026-01-01'), 0);
    eq(E.dayNumber('2026-01-02'), 1);
    eq(E.puzzleNumber('2026-01-01'), 1);
    ok(E.dayNumber('2026-08-05') > 200);
  },

  'search resolves exact names and aliases'() {
    const s = E.createSearch(COUNTRIES);
    eq(s.resolve('japan').c, 'jp');
    eq(s.resolve('  JAPAN  ').c, 'jp');
    eq(s.resolve('usa').c, 'us');
    eq(s.resolve('holland').c, 'nl');
    eq(s.resolve('cote d ivoire').c, 'ci');
    eq(s.resolve('not a country'), null);
  },

  'search ranks prefix matches first'() {
    const s = E.createSearch(COUNTRIES);
    eq(s.search('ind')[0].c, 'in');
    eq(s.search('united')[0].n.startsWith('United'), true);
    eq(s.search('jap')[0].c, 'jp');
    eq(s.search(''), []);
  },

  'search returns at most the limit'() {
    const s = E.createSearch(COUNTRIES);
    ok(s.search('a', 5).length <= 5);
  },

  'a winning game ends on the correct guess'() {
    const answer = byCode.jp;
    let g = E.createGame(answer, { mode: 'daily', dateKey: '2026-08-05' });
    g = E.applyGuess(g, byCode.br, answer).state;
    eq(g.status, 'playing');
    eq(g.guesses[0].correct, false);
    ok(g.guesses[0].km > 1000);
    g = E.applyGuess(g, byCode.jp, answer, 1234).state;
    eq(g.status, 'won');
    eq(g.guesses.length, 2);
    eq(g.guesses[1].proximity, 100);
    eq(g.guesses[1].arrow, '🎯');
    eq(g.endedAt, 1234);
  },

  'a game is lost after six wrong guesses'() {
    const answer = byCode.jp;
    let g = E.createGame(answer);
    const wrong = ['br', 'ca', 'fr', 'ke', 'au', 'cl'];
    for (const code of wrong) g = E.applyGuess(g, byCode[code], answer).state;
    eq(g.status, 'lost');
    eq(g.guesses.length, 6);
  },

  'duplicate guesses are rejected without consuming a turn'() {
    const answer = byCode.jp;
    let g = E.createGame(answer);
    g = E.applyGuess(g, byCode.br, answer).state;
    const res = E.applyGuess(g, byCode.br, answer);
    eq(res.error, 'duplicate');
    eq(res.state.guesses.length, 1);
  },

  'guesses after the game ends are rejected'() {
    const answer = byCode.jp;
    let g = E.createGame(answer);
    g = E.applyGuess(g, byCode.jp, answer).state;
    const res = E.applyGuess(g, byCode.br, answer);
    eq(res.error, 'finished');
  },

  'applyGuess never mutates the previous state'() {
    const answer = byCode.jp;
    const g0 = E.createGame(answer);
    const g1 = E.applyGuess(g0, byCode.br, answer).state;
    eq(g0.guesses.length, 0);
    eq(g1.guesses.length, 1);
  },

  'share text has a header, a row per guess and a streak line'() {
    const answer = byCode.jp;
    let g = E.createGame(answer, { mode: 'daily' });
    g = E.applyGuess(g, byCode.br, answer).state;
    g = E.applyGuess(g, byCode.jp, answer).state;
    const txt = E.shareText(g, { puzzleNumber: 42, streak: 3 });
    const lines = txt.split('\n');
    eq(lines.length, 4, txt);
    ok(lines[0].includes('#42') && lines[0].includes('2/6'), lines[0]);
    ok(lines[3].includes('3'), 'streak line');
    ok(!/[a-z]/.test(lines[2].replace(/[^\x00-\x7F]/g, '')), 'guess rows leak no country names');
  },

  'proximity bar fills as you get closer'() {
    eq(E.proximityBar(100), '🟩🟩🟩🟩🟩');
    eq(E.proximityBar(0), '⬜⬜⬜⬜⬜');
    eq(E.proximityBar(50), '🟩🟩🟨⬜⬜');
  },
});
