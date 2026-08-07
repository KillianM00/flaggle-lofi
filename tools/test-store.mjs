#!/usr/bin/env node
import { loadBrowserScripts, makeLocalStorage, runTests, ok, eq } from './harness.mjs';

const w = loadBrowserScripts(['js/data.js', 'js/store.js']);
const S = w.Store;
const COUNTRIES = w.COUNTRIES;
const byCode = Object.fromEntries(COUNTRIES.map((c) => [c.c, c]));

let clock = 1_000_000;
const mk = (seed) => {
  const ls = makeLocalStorage(seed);
  return { ls, store: S.create(ls, { now: () => clock++ }) };
};

// Plays a daily result for a profile.
const play = (store, { date, answer, status, guesses, mode = 'daily' }) =>
  store.recordResult({ mode, dateKey: date, answer, status, guesses });

runTests('store', {
  'starts empty and creates a profile on demand'() {
    const { store } = mk();
    eq(store.profiles().length, 0);
    const p = store.ensureProfile('slot', '🐈');
    eq(p.name, 'slot');
    eq(store.profiles().length, 1);
    eq(store.active().id, p.id);
  },

  'profile names are trimmed and capped'() {
    const { store } = mk();
    const p = store.addProfile('   a-really-long-name-that-keeps-going   ', '🍵');
    eq(p.name.length <= 18, true);
    eq(p.name, 'a-really-long-name');
  },

  'state survives a reload'() {
    const { ls, store } = mk();
    store.addProfile('barista', '☕');
    play(store, { date: '2026-08-01', answer: 'jp', status: 'won', guesses: 2 });
    const reloaded = S.create(ls, { now: () => clock++ });
    eq(reloaded.profiles().length, 1);
    eq(reloaded.active().points > 0, true);
    eq(reloaded.active().flags.jp.seen, 1);
  },

  'corrupt storage falls back to a clean state'() {
    const ls = makeLocalStorage({ [S.KEY]: '{not json' });
    const store = S.create(ls, { now: () => clock++ });
    eq(store.profiles().length, 0);
  },

  'hydrate backfills missing fields on a partial save'() {
    const s = S.hydrate({ profiles: { x: { id: 'x', name: 'old' } } });
    eq(s.profiles.x.currentStreak, 0);
    eq(s.profiles.x.distribution.X, 0);
    eq(s.profiles.x.practice.bestRun, 0);
    eq(s.activeProfile, 'x');
    eq(s.settings.hardMode, false);
  },

  /* ---- streaks ---- */

  'consecutive daily wins build a streak'() {
    const { store } = mk();
    store.addProfile('streaky');
    play(store, { date: '2026-08-01', answer: 'jp', status: 'won', guesses: 3 });
    eq(store.active().currentStreak, 1);
    play(store, { date: '2026-08-02', answer: 'br', status: 'won', guesses: 3 });
    play(store, { date: '2026-08-03', answer: 'ke', status: 'won', guesses: 3 });
    eq(store.active().currentStreak, 3);
    eq(store.active().maxStreak, 3);
  },

  'a loss resets the current streak but keeps the max'() {
    const { store } = mk();
    store.addProfile('streaky');
    play(store, { date: '2026-08-01', answer: 'jp', status: 'won', guesses: 3 });
    play(store, { date: '2026-08-02', answer: 'br', status: 'won', guesses: 3 });
    play(store, { date: '2026-08-03', answer: 'ke', status: 'lost', guesses: 6 });
    eq(store.active().currentStreak, 0);
    eq(store.active().maxStreak, 2);
  },

  'skipping a day breaks the streak'() {
    const { store } = mk();
    store.addProfile('streaky');
    play(store, { date: '2026-08-01', answer: 'jp', status: 'won', guesses: 3 });
    play(store, { date: '2026-08-02', answer: 'br', status: 'won', guesses: 3 });
    play(store, { date: '2026-08-05', answer: 'ke', status: 'won', guesses: 3 });
    eq(store.active().currentStreak, 1, 'restarts at 1');
    eq(store.active().maxStreak, 2);
  },

  'streaks survive a month boundary'() {
    eq(S.isNextDay('2026-01-31', '2026-02-01'), true);
    eq(S.isNextDay('2026-12-31', '2027-01-01'), true);
    eq(S.isNextDay('2026-08-01', '2026-08-03'), false);
    eq(S.isNextDay(null, '2026-08-01'), false);
  },

  'the same daily puzzle cannot be recorded twice'() {
    const { store } = mk();
    store.addProfile('dup');
    play(store, { date: '2026-08-01', answer: 'jp', status: 'won', guesses: 2 });
    const pts = store.active().points;
    const again = play(store, { date: '2026-08-01', answer: 'jp', status: 'won', guesses: 1 });
    eq(again.alreadyRecorded, true);
    eq(store.active().points, pts, 'no extra points');
    eq(store.active().played, 1);
    eq(store.active().flags.jp.seen, 1);
  },

  /* ---- scoring ---- */

  'faster daily solves score higher'() {
    const one = S.pointsFor({ status: 'won', guesses: 1, mode: 'daily', streak: 0 });
    const six = S.pointsFor({ status: 'won', guesses: 6, mode: 'daily', streak: 0 });
    ok(one > six, `${one} vs ${six}`);
    eq(six, 60);
    eq(one, 120);
  },

  'a loss scores nothing and streak bonus is capped'() {
    eq(S.pointsFor({ status: 'lost', guesses: 6, mode: 'daily' }), 0);
    const huge = S.pointsFor({ status: 'won', guesses: 1, mode: 'daily', streak: 999 });
    eq(huge, 120 + 45, 'bonus caps at 45');
  },

  'practice is worth less than the daily'() {
    const daily = S.pointsFor({ status: 'won', guesses: 3, mode: 'daily', streak: 0 });
    const practice = S.pointsFor({ status: 'won', guesses: 3, mode: 'practice', streak: 0 });
    ok(practice < daily / 3, `${practice} vs ${daily}`);
  },

  /* ---- distribution + history ---- */

  'the guess distribution tracks wins and losses'() {
    const { store } = mk();
    store.addProfile('dist');
    play(store, { date: '2026-08-01', answer: 'jp', status: 'won', guesses: 2 });
    play(store, { date: '2026-08-02', answer: 'br', status: 'won', guesses: 2 });
    play(store, { date: '2026-08-03', answer: 'ke', status: 'lost', guesses: 6 });
    const d = store.active().distribution;
    eq(d['2'], 2);
    eq(d.X, 1);
    eq(store.active().played, 3);
    eq(store.active().wins, 2);
  },

  /* ---- flag stats ---- */

  'most missed surfaces the flags you keep failing'() {
    const { store } = mk();
    store.addProfile('learner');
    // Chad: seen 3, never solved. Japan: seen 3, always solved first try.
    for (const d of ['2026-08-01', '2026-08-02', '2026-08-03'])
      play(store, { date: d, answer: 'td', status: 'lost', guesses: 6 });
    for (let i = 0; i < 3; i++)
      play(store, { mode: 'practice', answer: 'jp', status: 'won', guesses: 1 });
    const { mostMissed, leastMissed } = store.flagStats(byCode);
    eq(mostMissed[0].c, 'td');
    eq(mostMissed[0].missRate, 100);
    eq(mostMissed[0].seen, 3);
    eq(leastMissed[0].c, 'jp');
    eq(leastMissed[0].avgGuesses, 1);
  },

  'a single miss does not outrank a repeated one'() {
    const { store } = mk();
    store.addProfile('smooth');
    play(store, { mode: 'practice', answer: 'td', status: 'lost', guesses: 6 });
    for (let i = 0; i < 4; i++)
      play(store, { mode: 'practice', answer: 'bt', status: 'lost', guesses: 6 });
    const { mostMissed } = store.flagStats(byCode);
    eq(mostMissed[0].c, 'bt', 'four misses beats one miss');
  },

  'flag stats ignore unknown codes and respect minSeen'() {
    const { store } = mk();
    store.addProfile('x');
    play(store, { mode: 'practice', answer: 'jp', status: 'won', guesses: 1 });
    store.active().flags.zz = { seen: 9, solved: 0, guessesOnSolve: 0 };
    const all = store.flagStats(byCode);
    eq(all.mostMissed.some((r) => r.c === 'zz'), false, 'unknown code dropped');
    const strict = store.flagStats(byCode, { minSeen: 5 });
    eq(strict.mostMissed.length, 0);
  },

  'practice results feed flag stats but not the daily streak'() {
    const { store } = mk();
    store.addProfile('p');
    play(store, { date: '2026-08-01', answer: 'jp', status: 'won', guesses: 2 });
    const streakBefore = store.active().currentStreak;
    play(store, { mode: 'practice', answer: 'ke', status: 'lost', guesses: 6 });
    eq(store.active().currentStreak, streakBefore, 'practice loss does not break the streak');
    eq(store.active().played, 1, 'practice is not a daily play');
    eq(store.active().practice.played, 1);
    eq(store.active().flags.ke.seen, 1);
  },

  'practice tracks a best run'() {
    const { store } = mk();
    store.addProfile('p');
    for (let i = 0; i < 4; i++)
      play(store, { mode: 'practice', answer: 'jp', status: 'won', guesses: 2 });
    eq(store.active().practice.run, 4);
    play(store, { mode: 'practice', answer: 'bt', status: 'lost', guesses: 6 });
    eq(store.active().practice.run, 0);
    eq(store.active().practice.bestRun, 4);
  },

  /* ---- leaderboard ---- */

  'the leaderboard ranks by points and awards medals'() {
    const { store } = mk();
    const a = store.addProfile('ace', '🥐');
    play(store, { date: '2026-08-01', answer: 'jp', status: 'won', guesses: 1 });
    play(store, { date: '2026-08-02', answer: 'br', status: 'won', guesses: 1 });
    const b = store.addProfile('mid', '🧋');
    store.setActive(b.id);
    play(store, { date: '2026-08-01', answer: 'jp', status: 'won', guesses: 5 });
    const c = store.addProfile('new', '🌱');
    store.setActive(c.id);

    const lb = store.leaderboard();
    eq(lb.length, 3);
    eq(lb[0].name, 'ace');
    eq(lb[0].medal, '🥇');
    eq(lb[1].name, 'mid');
    eq(lb[2].name, 'new');
    eq(lb[2].points, 0);
    eq(lb[0].winRate, 100);
    eq(lb[0].maxStreak, 2);
    eq(a.id !== b.id, true);
  },

  'each profile keeps its own stats'() {
    const { store } = mk();
    const a = store.addProfile('a');
    play(store, { date: '2026-08-01', answer: 'jp', status: 'won', guesses: 1 });
    const b = store.addProfile('b');
    play(store, { date: '2026-08-01', answer: 'jp', status: 'lost', guesses: 6 });
    store.setActive(a.id);
    eq(store.active().wins, 1);
    eq(store.active().flags.jp.solved, 1);
    store.setActive(b.id);
    eq(store.active().wins, 0);
    eq(store.active().flags.jp.solved, 0);
  },

  'deleting a profile removes it and re-points active'() {
    const { store } = mk();
    const a = store.addProfile('a');
    const b = store.addProfile('b');
    store.saveDaily('2026-08-01', { answer: 'jp', guesses: [] });
    store.deleteProfile(b.id);
    eq(store.profiles().length, 1);
    eq(store.active().id, a.id);
    eq(store.loadDaily('2026-08-01'), null, "b's board went with it");
  },

  /* ---- in-progress boards ---- */

  'an in-progress daily board round-trips per profile and date'() {
    const { ls, store } = mk();
    const a = store.addProfile('a');
    store.saveDaily('2026-08-05', { answer: 'jp', guesses: [{ c: 'br' }], status: 'playing' });
    eq(store.loadDaily('2026-08-05').guesses.length, 1);
    eq(store.loadDaily('2026-08-04'), null, 'other dates are untouched');

    const b = store.addProfile('b');
    eq(store.loadDaily('2026-08-05'), null, 'other profiles get a fresh board');

    const reloaded = S.create(ls, { now: () => clock++ });
    reloaded.setActive(a.id);
    eq(reloaded.loadDaily('2026-08-05').guesses.length, 1, 'survives reload');
  },

  'old boards get pruned'() {
    const { store } = mk();
    store.addProfile('a');
    for (let i = 1; i <= 60; i++)
      store.saveDaily(`2026-08-${String(i).padStart(2, '0')}`, { answer: 'jp', guesses: [] });
    ok(Object.keys(store.raw().daily).length <= 40, 'capped');
    ok(store.loadDaily('2026-08-60'), 'newest kept');
  },

  /* ---- settings ---- */

  'settings persist'() {
    const { ls, store } = mk();
    store.setSetting('hardMode', true);
    store.setSetting('volume', 0.3);
    const reloaded = S.create(ls, { now: () => clock++ });
    eq(reloaded.settings().hardMode, true);
    eq(reloaded.settings().volume, 0.3);
  },

  'a storage that throws does not break the game'() {
    const ls = makeLocalStorage();
    ls.setItem = () => {
      throw new Error('QuotaExceeded');
    };
    const store = S.create(ls, { now: () => clock++ });
    store.addProfile('a');
    play(store, { date: '2026-08-01', answer: 'jp', status: 'won', guesses: 2 });
    ok(store.active().points > 0, 'in-memory state still advances');
  },
});

runTests('store · colour mode', {
  'a new profile starts with an empty palette record'() {
    const { store } = mk();
    const p = store.ensureProfile('c');
    eq(p.palette.played, 0);
    eq(p.palette.currentStreak, 0);
    eq(p.palette.bestTries, null);
    eq(p.palette.tries, {});
  },

  'hydrate backfills the palette record on an older save'() {
    const s = S.hydrate({ profiles: { x: { id: 'x', name: 'old', points: 5 } } });
    eq(s.profiles.x.palette.played, 0);
    eq(s.profiles.x.palette.maxStreak, 0);
    eq(s.profiles.x.palette.practice.played, 0);
    eq(s.profiles.x.points, 5, 'existing fields survive');
  },

  'colour solves score by tries, down to a floor'() {
    const one = S.pointsFor({ status: 'won', guesses: 1, mode: 'palette', streak: 0 });
    const five = S.pointsFor({ status: 'won', guesses: 5, mode: 'palette', streak: 0 });
    const forty = S.pointsFor({ status: 'won', guesses: 40, mode: 'palette', streak: 0 });
    eq(one, 120);
    eq(five, 120 - 4 * 8);
    eq(forty, 20, 'never goes below the floor');
    ok(one > five && five > forty, 'monotonic');
  },

  'the colour streak bonus applies and caps'() {
    eq(S.pointsFor({ status: 'won', guesses: 1, mode: 'palette', streak: 5 }), 120 + 15);
    eq(S.pointsFor({ status: 'won', guesses: 1, mode: 'palette', streak: 900 }), 120 + 45);
  },

  'colour practice is worth far less than the colour daily'() {
    const daily = S.pointsFor({ status: 'won', guesses: 3, mode: 'palette', streak: 0 });
    const prac = S.pointsFor({ status: 'won', guesses: 3, mode: 'palette-practice', streak: 0 });
    ok(prac < daily / 4, `${prac} vs ${daily}`);
  },

  'the colour daily keeps its own streak, separate from the geo one'() {
    const { store } = mk();
    store.addProfile('two-streaks');
    play(store, { date: '2026-08-01', answer: 'jp', status: 'won', guesses: 2 });
    play(store, { date: '2026-08-02', answer: 'br', status: 'won', guesses: 2 });
    eq(store.active().currentStreak, 2);
    eq(store.active().palette.currentStreak, 0, 'colour streak untouched by geo play');

    play(store, { mode: 'palette', date: '2026-08-01', answer: 'se', status: 'won', guesses: 4 });
    play(store, { mode: 'palette', date: '2026-08-02', answer: 'no', status: 'won', guesses: 3 });
    play(store, { mode: 'palette', date: '2026-08-03', answer: 'fi', status: 'won', guesses: 9 });
    eq(store.active().palette.currentStreak, 3);
    eq(store.active().palette.maxStreak, 3);
    eq(store.active().currentStreak, 2, 'geo streak unchanged by colour play');
  },

  'a skipped day breaks the colour streak on its own'() {
    const { store } = mk();
    store.addProfile('c');
    play(store, { mode: 'palette', date: '2026-08-01', answer: 'se', status: 'won', guesses: 2 });
    play(store, { mode: 'palette', date: '2026-08-04', answer: 'no', status: 'won', guesses: 2 });
    eq(store.active().palette.currentStreak, 1);
    eq(store.active().palette.maxStreak, 1);
  },

  'the colour daily can only be recorded once'() {
    const { store } = mk();
    store.addProfile('c');
    play(store, { mode: 'palette', date: '2026-08-01', answer: 'se', status: 'won', guesses: 5 });
    const pts = store.active().points;
    const again = play(store, { mode: 'palette', date: '2026-08-01', answer: 'se', status: 'won', guesses: 1 });
    eq(again.alreadyRecorded, true);
    eq(store.active().points, pts);
    eq(store.active().palette.played, 1);
  },

  'the two dailies on the same date are recorded independently'() {
    const { store } = mk();
    store.addProfile('c');
    play(store, { date: '2026-08-01', answer: 'jp', status: 'won', guesses: 3 });
    const r = play(store, { mode: 'palette', date: '2026-08-01', answer: 'se', status: 'won', guesses: 3 });
    eq(r.alreadyRecorded, false, 'the geo daily does not block the colour one');
    eq(store.active().played, 1);
    eq(store.active().palette.played, 1);
  },

  'colour stats track tries, best and the distribution'() {
    const { store } = mk();
    store.addProfile('c');
    play(store, { mode: 'palette', date: '2026-08-01', answer: 'se', status: 'won', guesses: 4 });
    play(store, { mode: 'palette', date: '2026-08-02', answer: 'no', status: 'won', guesses: 2 });
    play(store, { mode: 'palette', date: '2026-08-03', answer: 'fi', status: 'won', guesses: 14 });
    const pal = store.active().palette;
    eq(pal.wins, 3);
    eq(pal.bestTries, 2);
    eq(pal.totalTries, 20);
    eq(pal.tries['4'], 1);
    eq(pal.tries['2'], 1);
    eq(pal.tries['10+'], 1, 'long games bucket together');
    eq(S.tryBucket(9), '9');
    eq(S.tryBucket(10), '10+');
    eq(S.tryBucket(99), '10+');
  },

  'a colour solve inside six tries counts as knowing the flag'() {
    const { store } = mk();
    store.addProfile('c');
    play(store, { mode: 'palette', date: '2026-08-01', answer: 'se', status: 'won', guesses: 3 });
    const rec = store.active().flags.se;
    eq(rec.seen, 1);
    eq(rec.solved, 1);
    eq(rec.guessesOnSolve, 3);
  },

  'a colour solve that took forever counts as a miss for flag stats'() {
    const { store } = mk();
    store.addProfile('c');
    play(store, { mode: 'palette', date: '2026-08-01', answer: 'km', status: 'won', guesses: 17 });
    const rec = store.active().flags.km;
    eq(rec.seen, 1);
    eq(rec.solved, 0, 'seventeen tries is not mastery');
    const { mostMissed } = store.flagStats(byCode);
    eq(mostMissed[0].c, 'km');
    eq(mostMissed[0].missRate, 100);
  },

  'colour practice feeds flag stats but no streak'() {
    const { store } = mk();
    store.addProfile('c');
    play(store, { mode: 'palette', date: '2026-08-01', answer: 'se', status: 'won', guesses: 2 });
    const before = store.active().palette.currentStreak;
    play(store, { mode: 'palette-practice', answer: 'ke', status: 'won', guesses: 3 });
    eq(store.active().palette.currentStreak, before, 'practice does not extend the streak');
    eq(store.active().palette.played, 1, 'not counted as a daily');
    eq(store.active().palette.practice.played, 1);
    eq(store.active().flags.ke.solved, 1);
  },

  'colour points land in the shared leaderboard total'() {
    const { store } = mk();
    const a = store.addProfile('geo');
    play(store, { date: '2026-08-01', answer: 'jp', status: 'won', guesses: 3 });
    const geoOnly = store.active().points;
    play(store, { mode: 'palette', date: '2026-08-01', answer: 'se', status: 'won', guesses: 3 });
    ok(store.active().points > geoOnly, 'colour points add to the same total');

    const lb = store.leaderboard();
    eq(lb[0].paletteStreak, 1);
    eq(lb[0].paletteWins, 1);
    eq(lb[0].paletteBest, 3);
    eq(lb[0].paletteAvgTries, 3);
    eq(lb[0].currentStreak, 1, 'geo streak still reported separately');
    ok(a.id);
  },

  'in-progress boards for the two modes do not collide'() {
    const { ls, store } = mk();
    const a = store.addProfile('c');
    store.saveDaily('2026-08-05', { answer: 'jp', guesses: [{ c: 'br' }] });
    store.saveDaily('2026-08-05', { answer: 'se', guesses: [{ c: 'fi' }, { c: 'no' }] }, 'palette');
    eq(store.loadDaily('2026-08-05').answer, 'jp');
    eq(store.loadDaily('2026-08-05', 'palette').answer, 'se');
    eq(store.loadDaily('2026-08-05', 'palette').guesses.length, 2);

    const reloaded = S.create(ls, { now: () => clock++ });
    reloaded.setActive(a.id);
    eq(reloaded.loadDaily('2026-08-05', 'palette').answer, 'se', 'survives reload');
    eq(reloaded.loadDaily('2026-08-05').answer, 'jp');
  },
});

runTests('store · giving up', {
  'giving up on the geo daily breaks the streak and pays nothing'() {
    const { store } = mk();
    store.addProfile('quitter');
    play(store, { date: '2026-08-01', answer: 'jp', status: 'won', guesses: 2 });
    play(store, { date: '2026-08-02', answer: 'br', status: 'won', guesses: 2 });
    const before = store.active().points;
    eq(store.active().currentStreak, 2);
    play(store, { date: '2026-08-03', answer: 'td', status: 'lost', guesses: 6 });
    eq(store.active().currentStreak, 0, 'streak gone');
    eq(store.active().maxStreak, 2, 'best kept');
    eq(store.active().points, before, 'no points for folding');
    eq(store.active().distribution.X, 1);
    eq(store.active().played, 3);
  },

  'giving up on the colour daily breaks only the colour streak'() {
    const { store } = mk();
    store.addProfile('quitter');
    play(store, { date: '2026-08-01', answer: 'jp', status: 'won', guesses: 2 });
    play(store, { mode: 'palette', date: '2026-08-01', answer: 'se', status: 'won', guesses: 3 });
    play(store, { mode: 'palette', date: '2026-08-02', answer: 'cl', status: 'lost', guesses: 8 });
    eq(store.active().palette.currentStreak, 0, 'colour streak gone');
    eq(store.active().palette.maxStreak, 1);
    eq(store.active().palette.played, 2);
    eq(store.active().palette.wins, 1, 'a forfeit is not a win');
    eq(store.active().currentStreak, 1, 'the geo streak is untouched');
  },

  'a forfeited flag counts as missed'() {
    const { store } = mk();
    store.addProfile('quitter');
    play(store, { mode: 'palette', date: '2026-08-01', answer: 'km', status: 'lost', guesses: 4 });
    const rec = store.active().flags.km;
    eq(rec.seen, 1);
    eq(rec.solved, 0);
    eq(rec.guessesOnSolve, 0);
    const { mostMissed } = store.flagStats(byCode);
    eq(mostMissed[0].c, 'km');
    eq(mostMissed[0].missRate, 100);
  },

  'giving up in practice breaks the run but not any daily streak'() {
    const { store } = mk();
    store.addProfile('quitter');
    play(store, { date: '2026-08-01', answer: 'jp', status: 'won', guesses: 2 });
    play(store, { mode: 'practice', answer: 'ke', status: 'won', guesses: 2 });
    eq(store.active().practice.run, 1);
    play(store, { mode: 'practice', answer: 'td', status: 'lost', guesses: 6 });
    eq(store.active().practice.run, 0, 'run broken');
    eq(store.active().practice.bestRun, 1);
    eq(store.active().currentStreak, 1, 'daily streak safe');
    eq(store.active().palette.currentStreak, 0);
  },

  'a forfeited daily still cannot be replayed for points'() {
    const { store } = mk();
    store.addProfile('quitter');
    play(store, { date: '2026-08-01', answer: 'jp', status: 'lost', guesses: 6 });
    const retry = play(store, { date: '2026-08-01', answer: 'jp', status: 'won', guesses: 1 });
    eq(retry.alreadyRecorded, true);
    eq(store.active().points, 0);
    eq(store.active().wins, 0);
  },
});
