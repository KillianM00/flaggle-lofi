#!/usr/bin/env node
// Colour-match mode: the original flaggle game, with no geography in it.
import { loadBrowserScripts, runTests, ok, eq } from './harness.mjs';

const w = loadBrowserScripts(['js/data.js', 'js/palette.js', 'js/pixels.js', 'js/engine.js']);
const E = w.Engine;
const COUNTRIES = w.COUNTRIES;
const PX = w.FLAG_PIXELS;
const byCode = Object.fromEntries(COUNTRIES.map((c) => [c.c, c]));

const play = (state, code, answerCode) =>
  E.applyColourGuess(state, byCode[code], byCode[answerCode], PX, 0);

runTests('colour', {
  'a flag compared with itself matches everywhere'() {
    const cmp = E.compareGrids(PX.jp, PX.jp);
    eq(cmp.pct, 100);
    eq(cmp.matches, cmp.cells);
    ok(/^1+$/.test(cmp.mask), 'mask is all ones');
  },

  'unrelated flags barely match'() {
    const cmp = E.compareGrids(PX.jm, PX.jp);
    ok(cmp.pct < 5, `Jamaica vs Japan = ${cmp.pct}%`);
  },

  'comparison is symmetric and mask length matches the grid'() {
    const a = E.compareGrids(PX.fr, PX.nl);
    const b = E.compareGrids(PX.nl, PX.fr);
    eq(a.pct, b.pct);
    eq(a.mask.length, PX.fr.length);
  },

  'mismatched or missing grids return null rather than lying'() {
    eq(E.compareGrids(PX.jp, undefined), null);
    eq(E.compareGrids('111', '11'), null);
    eq(E.compareGrids(null, null), null);
  },

  'the worked example behaves as described'() {
    // Guessing Vietnam when the answer is Burkina Faso: the top half lights up
    // (both red) and part of the star, but nothing in the bottom half.
    const cmp = E.compareGrids(PX.vn, PX.bf);
    const W = w.Palette.GRID_W;
    const H = w.Palette.GRID_H;
    let top = 0;
    let bottom = 0;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (cmp.mask[y * W + x] === '1') (y < H / 2 ? (top += 1) : (bottom += 1));
      }
    }
    ok(top > bottom * 5, `top half dominates the match (${top} vs ${bottom})`);
    ok(cmp.pct > 40 && cmp.pct < 70, `a partial match, got ${cmp.pct}%`);
  },

  'a closer guess scores a higher percentage'() {
    // Ireland and Ivory Coast are the same flag mirrored; Ireland vs Japan is not.
    const near = E.compareGrids(PX.ie, PX.it).pct;
    const far = E.compareGrids(PX.ie, PX.jp).pct;
    ok(near > far, `Ireland/Italy ${near}% should beat Ireland/Japan ${far}%`);
  },

  'the colour game has no guess cap'() {
    const answer = byCode.jp;
    let g = E.createColourGame(answer, { mode: 'palette', dateKey: '2026-08-05' });
    eq(g.maxGuesses, 0, 'no cap');
    const wrongs = COUNTRIES.filter((c) => c.c !== 'jp').slice(0, 25);
    for (const c of wrongs) g = E.applyColourGuess(g, c, answer, PX, 0).state;
    eq(g.guesses.length, 25);
    eq(g.status, 'playing', 'still going after 25 tries');
    g = play(g, 'jp', 'jp').state;
    eq(g.status, 'won');
    eq(g.guesses.length, 26);
  },

  'guess results carry no geography whatsoever'() {
    const answer = byCode.jp;
    let g = E.createColourGame(answer);
    g = play(g, 'br', 'jp').state;
    const result = g.guesses[0];
    const keys = Object.keys(result).sort();
    eq(keys, ['c', 'cells', 'correct', 'emoji', 'mask', 'matches', 'name', 'pct']);
    for (const banned of ['km', 'distance', 'bearing', 'arrow', 'direction', 'proximity']) {
      eq(result[banned], undefined, `must not expose ${banned}`);
    }
  },

  'winning marks the game won and stamps the time'() {
    const answer = byCode.se;
    let g = E.createColourGame(answer);
    g = play(g, 'fi', 'se').state;
    eq(g.status, 'playing');
    g = E.applyColourGuess(g, byCode.se, answer, PX, 999).state;
    eq(g.status, 'won');
    eq(g.endedAt, 999);
    eq(g.guesses[1].pct, 100);
    eq(g.guesses[1].correct, true);
  },

  'duplicates and post-win guesses are rejected'() {
    const answer = byCode.jp;
    let g = E.createColourGame(answer);
    g = play(g, 'br', 'jp').state;
    eq(play(g, 'br', 'jp').error, 'duplicate');
    eq(play(g, 'br', 'jp').state.guesses.length, 1);
    g = play(g, 'jp', 'jp').state;
    eq(play(g, 'ke', 'jp').error, 'finished');
  },

  'a country with no pixel data fails loudly'() {
    const g = E.createColourGame(byCode.jp);
    const res = E.applyColourGuess(g, byCode.br, byCode.jp, {}, 0);
    eq(res.error, 'no-pixels');
    eq(res.state.guesses.length, 0);
  },

  'applyColourGuess does not mutate the previous state'() {
    const g0 = E.createColourGame(byCode.jp);
    const g1 = play(g0, 'br', 'jp').state;
    eq(g0.guesses.length, 0);
    eq(g1.guesses.length, 1);
  },

  'bestMatch tracks the warmest guess so far'() {
    const answer = byCode.se;
    let g = E.createColourGame(answer);
    eq(E.bestMatch(g), 0);
    g = play(g, 'jp', 'se').state;
    const first = E.bestMatch(g);
    g = play(g, 'fi', 'se').state;
    ok(E.bestMatch(g) >= first, 'never goes down');
    g = play(g, 'se', 'se').state;
    eq(E.bestMatch(g), 100);
  },

  'the colour daily is deterministic and differs from the geo daily'() {
    const a = E.paletteCountry(COUNTRIES, '2026-08-05');
    const b = E.paletteCountry(COUNTRIES, '2026-08-05');
    eq(a.c, b.c, 'same every time');
    let clashes = 0;
    for (let i = 0; i < 60; i++) {
      const d = new Date(Date.UTC(2026, 0, 1 + i));
      const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(
        d.getUTCDate()
      ).padStart(2, '0')}`;
      if (E.paletteCountry(COUNTRIES, key).c === E.dailyCountry(COUNTRIES, key).c) clashes++;
    }
    ok(clashes <= 2, `the two modes rarely coincide (${clashes}/60 days)`);
  },

  'the colour rotation also covers every country once per cycle'() {
    const n = COUNTRIES.length;
    const seen = new Set();
    for (let day = 0; day < n; day++) {
      const d = new Date(Date.UTC(2026, 0, 1 + day));
      const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(
        d.getUTCDate()
      ).padStart(2, '0')}`;
      seen.add(E.paletteCountry(COUNTRIES, key).c);
    }
    eq(seen.size, n);
  },

  'share text reports tries and leaks neither answer nor mask'() {
    const answer = byCode.se;
    let g = E.createColourGame(answer, { mode: 'palette' });
    g = play(g, 'fi', 'se').state;
    g = play(g, 'se', 'se').state;
    const txt = E.colourShareText(g, { puzzleNumber: 12, streak: 4 });
    const lines = txt.split('\n');
    ok(lines[0].includes('Colours'), lines[0]);
    ok(lines[0].includes('#12') && lines[0].includes('2 tries'), lines[0]);
    ok(!txt.includes('Sweden') && !txt.includes('Finland'), 'no country names');
    ok(!/[01]{20}/.test(txt), 'no raw mask');
    ok(txt.includes('🔥'), 'streak line');
  },

  'share text says unsolved when it is'() {
    let g = E.createColourGame(byCode.se, { mode: 'palette' });
    g = play(g, 'fi', 'se').state;
    ok(E.colourShareText(g, {}).includes('unsolved'));
  },

  'a long game keeps the share text short'() {
    let g = E.createColourGame(byCode.jp, { mode: 'palette' });
    for (const c of COUNTRIES.filter((x) => x.c !== 'jp').slice(0, 20))
      g = E.applyColourGuess(g, c, byCode.jp, PX, 0).state;
    g = play(g, 'jp', 'jp').state;
    const lines = E.colourShareText(g, { puzzleNumber: 1 }).split('\n');
    ok(lines.length <= 10, `trimmed to ${lines.length} lines`);
  },
});

runTests('colour · storage', {
  'slimming drops masks and nothing else'() {
    let g = E.createColourGame(byCode.se, { mode: 'palette', dateKey: '2026-08-05' });
    g = play(g, 'fi', 'se').state;
    g = play(g, 'no', 'se').state;
    const slim = E.slimColourGame(g);
    eq(slim.answer, g.answer);
    eq(slim.dateKey, g.dateKey);
    eq(slim.status, g.status);
    eq(slim.guesses.length, 2);
    for (const guess of slim.guesses) {
      eq(guess.mask, undefined, 'mask dropped');
      ok(guess.c && guess.name && typeof guess.pct === 'number', 'the rest survives');
    }
    ok(g.guesses[0].mask, 'the original is untouched');
  },

  'a slimmed game is far smaller on the wire'() {
    let g = E.createColourGame(byCode.se, { mode: 'palette' });
    for (const c of COUNTRIES.slice(0, 12)) g = E.applyColourGuess(g, c, byCode.se, PX, 0).state;
    const full = JSON.stringify(g).length;
    const slim = JSON.stringify(E.slimColourGame(g)).length;
    ok(slim < full / 20, `${slim} bytes vs ${full}`);
    ok(slim < 4000, `${slim} bytes for a twelve-guess board`);
  },

  'rehydrating restores masks identical to the originals'() {
    let g = E.createColourGame(byCode.cl, { mode: 'palette' });
    for (const code of ['vn', 'de', 'ps', 'kg', 'cl']) g = play(g, code, 'cl').state;
    const restored = E.rehydrateColourGame(E.slimColourGame(g), byCode.cl, PX);
    eq(restored.guesses.length, g.guesses.length);
    restored.guesses.forEach((guess, i) => {
      eq(guess.mask, g.guesses[i].mask, `guess ${i} mask`);
      eq(guess.pct, g.guesses[i].pct, `guess ${i} percentage`);
      eq(guess.matches, g.guesses[i].matches, `guess ${i} match count`);
    });
    eq(restored.status, 'won');
    eq(restored.guesses[4].pct, 100, 'the winning guess still reads 100%');
  },

  'rehydrating is safe on empty and already-full boards'() {
    const fresh = E.createColourGame(byCode.se, { mode: 'palette' });
    eq(E.rehydrateColourGame(fresh, byCode.se, PX).guesses.length, 0);
    let g = play(fresh, 'fi', 'se').state;
    const twice = E.rehydrateColourGame(E.rehydrateColourGame(g, byCode.se, PX), byCode.se, PX);
    eq(twice.guesses[0].mask, g.guesses[0].mask);
    eq(E.rehydrateColourGame(null, byCode.se, PX), null);
  },
});

runTests('engine · giving up', {
  'giving up ends the game without a win'() {
    let g = E.createColourGame(byCode.cl, { mode: 'palette', dateKey: '2026-08-05' });
    g = play(g, 'vn', 'cl').state;
    const done = E.giveUp(g, 4242);
    eq(done.status, 'lost');
    eq(done.gaveUp, true);
    eq(done.endedAt, 4242);
    eq(done.answer, 'cl', 'the answer is still there to reveal');
    eq(done.guesses.length, 1, 'the guesses you did make are kept');
  },

  'giving up does not mutate the game you passed in'() {
    let g = E.createColourGame(byCode.cl, { mode: 'palette' });
    g = play(g, 'vn', 'cl').state;
    E.giveUp(g, 1);
    eq(g.status, 'playing');
    eq(g.gaveUp, undefined);
  },

  'you can give up before guessing anything'() {
    const g = E.createColourGame(byCode.cl, { mode: 'palette' });
    const done = E.giveUp(g, 1);
    eq(done.status, 'lost');
    eq(done.guesses.length, 0);
    eq(E.bestMatch(done), 0);
  },

  'giving up after the game ended changes nothing'() {
    let g = E.createColourGame(byCode.cl, { mode: 'palette' });
    g = play(g, 'cl', 'cl').state;
    eq(g.status, 'won');
    const after = E.giveUp(g, 9);
    eq(after.status, 'won');
    eq(after.gaveUp, undefined);
    eq(after, g, 'the same state comes back untouched');
  },

  'a given-up geo board keeps its unused guesses'() {
    let g = E.createGame(byCode.jp, { mode: 'daily', dateKey: '2026-08-05' });
    g = E.applyGuess(g, byCode.br, byCode.jp, 0).state;
    const done = E.giveUp(g, 5);
    eq(done.status, 'lost');
    eq(done.gaveUp, true);
    eq(done.guesses.length, 1);
    eq(done.maxGuesses, 6, 'the cap is untouched');
    eq(E.applyGuess(done, byCode.ke, byCode.jp, 0).error, 'finished', 'no more guessing');
  },

  'a given-up game survives the storage round-trip'() {
    let g = E.createColourGame(byCode.cl, { mode: 'palette', dateKey: '2026-08-05' });
    g = play(g, 'vn', 'cl').state;
    g = E.giveUp(g, 7);
    const back = E.rehydrateColourGame(E.slimColourGame(g), byCode.cl, PX);
    eq(back.status, 'lost');
    eq(back.gaveUp, true);
    eq(back.guesses[0].mask, g.guesses[0].mask);
  },
});
