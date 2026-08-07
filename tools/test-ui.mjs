#!/usr/bin/env node
// End-to-end: drives the real app in headless Firefox.
import fs from 'node:fs';
import path from 'node:path';
import { serve, newSession } from './webdriver.mjs';
import { ROOT, ok, eq, AssertionError } from './harness.mjs';

const SHOTS = process.env.SHOT_DIR || path.join(ROOT, 'screenshots');
fs.mkdirSync(SHOTS, { recursive: true });

// BASE_URL runs the whole suite against a deployed site instead of a local
// copy — the same checks, but proving what's actually live.
const REMOTE = process.env.BASE_URL;
const { close: closeServer, url } = REMOTE
  ? { close: () => {}, url: REMOTE.replace(/\/$/, '') }
  : await serve(8731);
if (REMOTE) console.log(`(testing against ${url})`);
const d = await newSession({ headless: process.env.HEADED !== '1' });

let pass = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } catch (err) {
    failures.push(name);
    console.log(`  \x1b[31m✗\x1b[0m ${name}`);
    console.log(`      ${err.message}`);
    if (!(err instanceof AssertionError)) console.log(`      ${err.stack?.split('\n')[1] || ''}`);
    try {
      await d.screenshot(path.join(SHOTS, `fail-${name.replace(/[^a-z0-9]+/gi, '-')}.png`));
    } catch {
      /* screenshot is best-effort */
    }
  }
}

// --- helpers ---------------------------------------------------------------

const boot = async (query = '') => {
  await d.go(`${url}/index.html${query}`);
  await d.waitFor("document.body.dataset.ready === '1'", { label: 'app boot' });
  await d.execute(`window.__errs = []; window.addEventListener('error', function (e) {
    window.__errs.push(String(e.message));
  });`);
};

const wipe = () => d.execute('window.localStorage.clear(); return true;');

const type = (id, value) =>
  d.execute(
    `var i = document.getElementById(arguments[0]); i.focus(); i.value = arguments[1];
     i.dispatchEvent(new Event('input', { bubbles: true })); return i.value;`,
    [id, value]
  );

const click = (sel) =>
  d.execute(
    `var n = document.querySelector(arguments[0]);
     if (!n) throw new Error('no element: ' + arguments[0]);
     n.click(); return true;`,
    [sel]
  );

const guess = async (board, name) => {
  await type(`${board}-input`, name);
  await click(`#${board}-go`);
};

const errs = () => d.execute('return window.__errs || [];');

// Screenshots are viewport-sized, so bring the interesting bit into frame and
// let the CSS transitions settle before shooting.
const shot = async (name, sel) => {
  if (sel) {
    await d.execute(
      `var n = document.querySelector(arguments[0]);
       if (n) n.scrollIntoView({ block: 'center' });
       return true;`,
      [sel]
    );
  }
  await new Promise((r) => setTimeout(r, 700));
  return d.screenshot(path.join(SHOTS, name));
};

// --- tests -----------------------------------------------------------------

console.log('\nui (headless firefox)');

await boot();
await wipe();
await boot();

await test('boots with today\'s flag and a fresh profile', async () => {
  const s = await d.execute(`return {
    answer: window.FlaggleApp.answerCode(),
    src: document.getElementById('daily-flag').getAttribute('src'),
    loaded: document.getElementById('daily-flag').naturalWidth > 0,
    dots: document.querySelectorAll('#daily-dots .dot-pip').length,
    profile: document.getElementById('profile-name').textContent,
    sub: document.getElementById('daily-sub').textContent,
  };`);
  eq(s.src, `flags/${s.answer}.svg`);
  ok(s.loaded, 'flag image actually rendered');
  eq(s.dots, 6, 'six guess pips');
  eq(s.profile, 'you');
  ok(/^#\d+ · /.test(s.sub), `puzzle number + date, got "${s.sub}"`);
});

await test('autocomplete ranks and filters as you type', async () => {
  await type('daily-input', 'jap');
  const s = await d.execute(`return {
    open: !document.getElementById('daily-suggestions').hidden,
    first: document.querySelector('#daily-suggestions .suggestion').textContent,
    count: document.querySelectorAll('#daily-suggestions .suggestion').length,
  };`);
  ok(s.open, 'dropdown opened');
  ok(s.first.includes('Japan'), `first suggestion was "${s.first}"`);
  ok(s.count <= 7, 'capped at 7');

  await type('daily-input', 'usa');
  const alias = await d.execute(
    `return document.querySelector('#daily-suggestions .suggestion').textContent;`
  );
  ok(alias.includes('United States'), `alias search gave "${alias}"`);
  await type('daily-input', '');
});

await test('the dropdown never shows a flag you could copy from', async () => {
  for (const board of ['daily', 'colours']) {
    await type(`${board}-input`, 'a');
    const s = await d.execute(
      `var list = document.getElementById(arguments[0] + '-suggestions');
       return {
         count: list.querySelectorAll('.suggestion').length,
         images: list.querySelectorAll('img, canvas, svg').length,
         backgrounds: Array.prototype.filter.call(list.querySelectorAll('*'), function (n) {
           var bg = getComputedStyle(n).backgroundImage;
           return bg && bg !== 'none';
         }).length,
         text: list.textContent,
       };`,
      [board]
    );
    ok(s.count > 0, `${board} dropdown has suggestions`);
    eq(s.images, 0, `${board} dropdown has no flag imagery`);
    eq(s.backgrounds, 0, `${board} dropdown has no background images either`);
    // Region emoji would leak the continent in colour mode, where geography
    // is meant to be no help at all.
    ok(!/[\u{1F984}-\u{1F9FF}]/u.test(s.text.replace(/\u21b5/g, '')), `no tells: "${s.text}"`);
    await type(`${board}-input`, '');
  }
});

await test('Tab completes the highlighted country without submitting', async () => {
  await type('daily-input', 'switz');
  const before = await d.execute(
    `return document.querySelectorAll('#daily-guesses .guess').length;`
  );
  await d.execute(`document.getElementById('daily-input').dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));`);
  const s = await d.execute(`return {
    value: document.getElementById('daily-input').value,
    rows: document.querySelectorAll('#daily-guesses .guess').length,
    focused: document.activeElement.id,
    open: !document.getElementById('daily-suggestions').hidden,
  };`);
  eq(s.value, 'Switzerland', 'completed in place');
  eq(s.rows, before, 'did not submit the guess');
  eq(s.focused, 'daily-input', 'focus stayed put');
  ok(s.open, 'the list refreshed rather than closing');

  // Arrow down first, then Tab, completes the second match instead.
  await type('daily-input', 'ir');
  const options = await d.execute(
    `return Array.prototype.map.call(document.querySelectorAll('#daily-suggestions .suggestion'),
      function (n) { return n.textContent.replace('\u21b5', '').trim(); });`
  );
  await d.execute(`var i = document.getElementById('daily-input');
    i.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
    i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));`);
  const second = await d.execute(`return document.getElementById('daily-input').value;`);
  eq(second, options[1], 'completed whatever was highlighted');
  await type('daily-input', '');
});

await test('a wrong guess shows distance, arrow and proximity', async () => {
  const answer = await d.execute('return window.FlaggleApp.answerCode();');
  const wrong = answer === 'nz' ? 'Iceland' : 'New Zealand';
  await guess('daily', wrong);
  const s = await d.execute(`return {
    rows: document.querySelectorAll('#daily-guesses .guess').length,
    name: document.querySelector('#daily-guesses .gname').textContent,
    dist: document.querySelector('#daily-guesses .gdist').textContent,
    arrow: document.querySelector('#daily-guesses .garrow').textContent,
    prox: document.querySelector('#daily-guesses .gprox').textContent,
    used: document.querySelectorAll('#daily-dots .dot-pip.used').length,
    hit: document.querySelectorAll('#daily-guesses .guess.hit').length,
  };`);
  eq(s.rows, 1);
  eq(s.name, wrong);
  ok(/km$/.test(s.dist), `distance "${s.dist}"`);
  ok(/[⬆↗➡↘⬇↙⬅↖]/u.test(s.arrow), `arrow "${s.arrow}"`);
  ok(/^\d+%$/.test(s.prox), `proximity "${s.prox}"`);
  eq(s.used, 1, 'one pip used');
  eq(s.hit, 0, 'not marked as a hit');
});

await test('guessing the same country twice does not burn a turn', async () => {
  const before = await d.execute(
    `return document.querySelectorAll('#daily-guesses .guess').length;`
  );
  const name = await d.execute(`return document.querySelector('#daily-guesses .gname').textContent;`);
  await guess('daily', name);
  const s = await d.execute(`return {
    rows: document.querySelectorAll('#daily-guesses .guess').length,
    toast: document.getElementById('toast').textContent,
  };`);
  eq(s.rows, before, 'no new row');
  ok(s.toast.includes('already guessed'), `toast said "${s.toast}"`);
});

await test('nonsense input is rejected with a nudge', async () => {
  const before = await d.execute(
    `return document.querySelectorAll('#daily-guesses .guess').length;`
  );
  await guess('daily', 'qqqqzzz');
  const s = await d.execute(`return {
    rows: document.querySelectorAll('#daily-guesses .guess').length,
    toast: document.getElementById('toast').textContent,
  };`);
  eq(s.rows, before);
  ok(s.toast.includes('never heard of it'), `toast said "${s.toast}"`);
});

await test('an in-progress board survives a reload', async () => {
  const before = await d.execute(`return {
    rows: document.querySelectorAll('#daily-guesses .guess').length,
    name: document.querySelector('#daily-guesses .gname').textContent,
  };`);
  await boot();
  const after = await d.execute(`return {
    rows: document.querySelectorAll('#daily-guesses .guess').length,
    name: document.querySelector('#daily-guesses .gname').textContent,
  };`);
  eq(after, before, 'same guesses after reload');
});

await test('steamy mode blurs the flag and clears as you guess', async () => {
  await click('#btn-steamy');
  const blurred = await d.execute(`return {
    on: document.getElementById('btn-steamy').classList.contains('on'),
    filter: document.getElementById('daily-flag').style.filter,
  };`);
  ok(blurred.on, 'toggle is on');
  const px = parseFloat(blurred.filter.replace(/[^\d.]/g, ''));
  ok(px > 0, `blur applied, got "${blurred.filter}"`);

  const answer = await d.execute('return window.FlaggleApp.answerCode();');
  const wrong = ['Chile', 'Nepal', 'Kenya', 'Portugal'].find((n) => n.toLowerCase() !== answer);
  await guess('daily', wrong);
  const after = await d.execute(`return document.getElementById('daily-flag').style.filter;`);
  const px2 = parseFloat(after.replace(/[^\d.]/g, ''));
  ok(px2 < px, `blur cleared a step: ${px} -> ${px2}`);
  await click('#btn-steamy');
});

await test('winning ends the round, pays points and locks the input', async () => {
  const answer = await d.execute(`return window.COUNTRIES.find(function (c) {
    return c.c === window.FlaggleApp.answerCode();
  });`);
  await guess('daily', answer.n);
  const s = await d.execute(`return {
    status: window.FlaggleApp.daily.game.status,
    hit: document.querySelectorAll('#daily-guesses .guess.hit').length,
    resultShown: !document.getElementById('daily-result').hidden,
    result: document.getElementById('daily-result').textContent,
    disabled: document.getElementById('daily-input').disabled,
    goDisabled: document.getElementById('daily-go').disabled,
    won: document.querySelectorAll('#daily-dots .dot-pip.won').length,
    filter: document.getElementById('daily-flag').style.filter,
    points: window.FlaggleApp.store.active().points,
    streak: window.FlaggleApp.store.active().currentStreak,
  };`);
  eq(s.status, 'won');
  eq(s.hit, 1);
  ok(s.resultShown, 'result panel visible');
  ok(s.result.includes(answer.n), 'names the country');
  ok(s.result.includes('points'), 'shows points earned');
  ok(s.result.includes('next flag in'), 'shows the countdown');
  ok(s.disabled && s.goDisabled, 'input locked');
  eq(s.won, 1);
  eq(s.filter, 'none', 'flag revealed');
  ok(s.points > 0, `earned ${s.points} points`);
  eq(s.streak, 1, 'streak started');
  await shot('01-daily-won.png', '#daily-result');
});

await test('the share text is spoiler-free', async () => {
  const txt = await d.execute(`return window.Engine.shareText(window.FlaggleApp.daily.game, {
    puzzleNumber: 217, streak: 1
  });`);
  const lines = txt.split('\n');
  ok(lines[0].includes('Flaggle Lofi'), lines[0]);
  ok(/\d\/6/.test(lines[0]), 'shows the score');
  const answerName = await d.execute(`return window.COUNTRIES.find(function (c) {
    return c.c === window.FlaggleApp.answerCode();
  }).n;`);
  ok(!txt.includes(answerName), 'does not leak the answer');
  ok(txt.includes('🔥'), 'includes the streak');
});

await test('a finished daily stays finished after a reload', async () => {
  await boot();
  const s = await d.execute(`return {
    status: window.FlaggleApp.daily.game.status,
    disabled: document.getElementById('daily-input').disabled,
    played: window.FlaggleApp.store.active().played,
  };`);
  eq(s.status, 'won');
  ok(s.disabled, 'still locked');
  eq(s.played, 1, 'counted exactly once');
});

await test('stats show the streak, distribution and flag boards', async () => {
  await click('.tab[data-view="stats"]');
  const s = await d.execute(`return {
    visible: !document.getElementById('view-stats').hidden,
    stats: Array.prototype.map.call(document.querySelectorAll('#stats-grid .stat'), function (n) {
      return n.querySelector('.k').textContent.trim() + '=' + n.querySelector('.v').textContent;
    }),
    distRows: document.querySelectorAll('#stats-dist .dist-row').length,
    distTotal: Array.prototype.reduce.call(document.querySelectorAll('#stats-dist .n'), function (a, n) {
      return a + Number(n.textContent);
    }, 0),
    least: document.querySelectorAll('#least-missed li:not(.empty)').length,
    who: document.getElementById('stats-who').textContent,
  };`);
  ok(s.visible, 'stats view shown');
  ok(s.stats.some((x) => x.startsWith('🔥 geo streak=1')), s.stats.join(' | '));
  ok(s.stats.some((x) => x.startsWith('📈 win rate=100%')), s.stats.join(' | '));
  eq(s.distRows, 7, '1-6 plus X');
  eq(s.distTotal, 1, 'one recorded game');
  eq(s.least, 1, 'the solved flag shows in least missed');
  ok(s.who.includes('you'));
  await shot('02-stats.png', '#stats-dist');
});

await test('practice deals a flag and the region filter changes the pool', async () => {
  await click('.tab[data-view="practice"]');
  await d.waitFor("document.getElementById('practice-flag').naturalWidth > 0", {
    label: 'practice flag to load',
  });
  const s = await d.execute(`return {
    answer: window.FlaggleApp.practiceAnswerCode(),
    src: document.getElementById('practice-flag').getAttribute('src'),
    loaded: document.getElementById('practice-flag').naturalWidth > 0,
    pool: document.getElementById('practice-pool').textContent,
    filters: document.querySelectorAll('#practice-filters button').length,
  };`);
  ok(s.answer, 'dealt a flag');
  eq(s.src, `flags/${s.answer}.svg`);
  ok(s.loaded, 'practice flag rendered');
  eq(s.filters, 7, 'everywhere + six regions');
  ok(s.pool.includes('197'), `pool label "${s.pool}"`);

  await d.execute(`Array.prototype.find.call(document.querySelectorAll('#practice-filters button'),
    function (b) { return b.textContent.indexOf('oceania') >= 0; }).click();`);
  const after = await d.execute(`return {
    pool: document.getElementById('practice-pool').textContent,
    region: window.COUNTRIES.find(function (c) {
      return c.c === window.FlaggleApp.practiceAnswerCode();
    }).r,
  };`);
  eq(after.region, 'Oceania', 'deals from the chosen region');
  ok(!after.pool.includes('197'), `pool shrank: "${after.pool}"`);

  await d.execute(`document.querySelectorAll('#practice-filters button')[0].click();`);
});

await test('a practice win counts for flag stats but not the daily streak', async () => {
  const before = await d.execute(`return {
    streak: window.FlaggleApp.store.active().currentStreak,
    played: window.FlaggleApp.store.active().played,
  };`);
  const name = await d.execute(`return window.COUNTRIES.find(function (c) {
    return c.c === window.FlaggleApp.practiceAnswerCode();
  }).n;`);
  await guess('practice', name);
  const s = await d.execute(`return {
    status: window.FlaggleApp.practice.game.status,
    streak: window.FlaggleApp.store.active().currentStreak,
    played: window.FlaggleApp.store.active().played,
    practicePlayed: window.FlaggleApp.store.active().practice.played,
    run: window.FlaggleApp.store.active().practice.run,
    resultShown: !document.getElementById('practice-result').hidden,
    hasNext: document.getElementById('practice-result').textContent.includes('next flag'),
  };`);
  eq(s.status, 'won');
  eq(s.streak, before.streak, 'daily streak untouched');
  eq(s.played, before.played, 'not counted as a daily');
  eq(s.practicePlayed, 1);
  eq(s.run, 1);
  ok(s.resultShown && s.hasNext, 'result offers another flag');
});

await test('next flag deals a different country', async () => {
  const prev = await d.execute('return window.FlaggleApp.practiceAnswerCode();');
  await d.execute(`Array.prototype.find.call(document.querySelectorAll('#practice-result button'),
    function (b) { return b.textContent.indexOf('next flag') >= 0; }).click();`);
  const s = await d.execute(`return {
    answer: window.FlaggleApp.practiceAnswerCode(),
    rows: document.querySelectorAll('#practice-guesses .guess').length,
    resultHidden: document.getElementById('practice-result').hidden,
    enabled: !document.getElementById('practice-input').disabled,
  };`);
  ok(s.answer !== prev, 'new flag');
  eq(s.rows, 0, 'board cleared');
  ok(s.resultHidden, 'result cleared');
  ok(s.enabled, 'input live again');
  await shot('03-practice.png', '#practice-filters');
});

await test('losing a practice round records a miss', async () => {
  const answer = await d.execute('return window.FlaggleApp.practiceAnswerCode();');
  const wrongs = await d.execute(
    `return window.COUNTRIES.filter(function (c) { return c.c !== arguments[0]; })
      .slice(0, 6).map(function (c) { return c.n; });`,
    [answer]
  );
  for (const w of wrongs) await guess('practice', w);
  const s = await d.execute(
    `return {
      status: window.FlaggleApp.practice.game.status,
      rows: document.querySelectorAll('#practice-guesses .guess').length,
      run: window.FlaggleApp.store.active().practice.run,
      bestRun: window.FlaggleApp.store.active().practice.bestRun,
      seen: window.FlaggleApp.store.active().flags[arguments[0]].seen,
      solved: window.FlaggleApp.store.active().flags[arguments[0]].solved,
      revealed: document.getElementById('practice-result').textContent,
    };`,
    [answer]
  );
  eq(s.status, 'lost');
  eq(s.rows, 6, 'six guesses used');
  eq(s.run, 0, 'run broken');
  eq(s.bestRun, 1);
  eq(s.seen, 1);
  eq(s.solved, 0);
  ok(s.revealed.length > 0, 'the answer is revealed');
});

await test('most missed picks up the flag that beat you', async () => {
  await click('.tab[data-view="stats"]');
  const s = await d.execute(`return {
    most: Array.prototype.map.call(document.querySelectorAll('#most-missed li'), function (n) {
      return n.textContent;
    }),
    pill: document.querySelector('#most-missed .rate-pill').textContent,
  };`);
  ok(s.most.length >= 1, 'most missed has entries');
  ok(s.most[0].includes('0/1'), `top row "${s.most[0]}"`);
  eq(s.pill, '100% miss');
});

await test('leaderboard adds players, ranks them and switches profile', async () => {
  await click('.tab[data-view="board"]');
  await type('new-name', 'juno');
  await d.execute(`document.querySelectorAll('#emoji-picker .emoji-opt')[3].click();`);
  await click('#btn-add');
  const s = await d.execute(`return {
    rows: document.querySelectorAll('#leaderboard li').length,
    me: document.querySelector('#leaderboard li.me .nm').textContent,
    medals: Array.prototype.map.call(document.querySelectorAll('#leaderboard .medal'), function (n) {
      return n.textContent;
    }),
    names: Array.prototype.map.call(document.querySelectorAll('#leaderboard .nm > span:first-child'),
      function (n) { return n.textContent.trim(); }),
    points: Array.prototype.map.call(document.querySelectorAll('#leaderboard .pts'), function (n) {
      return parseInt(n.textContent, 10);
    }),
    header: document.getElementById('profile-name').textContent,
  };`);
  eq(s.rows, 2, 'two players');
  ok(s.me.includes('juno'), `active is juno, got "${s.me}"`);
  eq(s.medals[0], '🥇');
  eq(s.medals[1], '🥈');
  ok(s.points[0] > s.points[1], `ranked by points: ${s.points.join(' > ')}`);
  eq(s.names, ['☕ you', '🍵 juno'], 'the player with points is on top');
  eq(s.header, 'juno', 'header follows the active profile');

  // The new player starts clean.
  const fresh = await d.execute(`return {
    points: window.FlaggleApp.store.active().points,
    guesses: document.querySelectorAll('#daily-guesses .guess').length,
    disabled: document.getElementById('daily-input').disabled,
  };`);
  eq(fresh.points, 0);
  eq(fresh.guesses, 0, 'juno gets a fresh board');
  ok(!fresh.disabled, 'juno can still play today');
  await shot('04-leaderboard.png', '#leaderboard');
});

await test('switching back restores the first player\'s finished board', async () => {
  await d.execute(`Array.prototype.find.call(document.querySelectorAll('#leaderboard button'),
    function (b) { return b.textContent === 'play as'; }).click();`);
  const s = await d.execute(`return {
    name: document.getElementById('profile-name').textContent,
    status: window.FlaggleApp.daily.game.status,
    rows: document.querySelectorAll('#daily-guesses .guess').length,
  };`);
  eq(s.name, 'you');
  eq(s.status, 'won', 'their completed board came back');
  ok(s.rows > 0);
});

await test('theme toggle flips to midnight roast and sticks', async () => {
  await click('#btn-theme');
  const dark = await d.execute(`return {
    theme: document.documentElement.getAttribute('data-theme'),
    icon: document.getElementById('btn-theme').textContent,
    bg: getComputedStyle(document.body).backgroundColor,
  };`);
  eq(dark.theme, 'midnight');
  eq(dark.icon, '☀️');
  await shot('05-midnight.png', '#leaderboard');

  await boot();
  const kept = await d.execute(`return document.documentElement.getAttribute('data-theme');`);
  eq(kept, 'midnight', 'survives reload');
  await click('#btn-theme');
});

await test('the lofi player actually starts an audio graph', async () => {
  await click('#btn-sound');
  const s = await d.executeAsync(`var done = arguments[arguments.length - 1];
    setTimeout(function () {
      var i = window.LofiAudio._internals();
      done({
        playing: window.LofiAudio.isPlaying(),
        state: i.ctx ? i.ctx.state : null,
        time: i.ctx ? i.ctx.currentTime : 0,
        label: document.getElementById('np-label').textContent,
        eq: document.getElementById('eq').classList.contains('on'),
        saved: JSON.parse(localStorage.getItem('flaggle-lofi:v1')).settings.sound,
      });
    }, 600);`);
  ok(s.playing, 'reports playing');
  eq(s.state, 'running', 'audio context is running');
  ok(s.time > 0, 'the clock is moving');
  eq(s.label, 'lofi beats');
  ok(s.eq, 'equaliser animating');
  eq(s.saved, true, 'preference saved');

  await click('#btn-rain');
  const rain = await d.execute(`return {
    raining: window.LofiAudio.isRaining(),
    label: document.getElementById('np-label').textContent,
  };`);
  ok(rain.raining);
  eq(rain.label, 'lofi + rain');
  await click('#btn-sound');
  await click('#btn-rain');
});


/* ------------------------------- colour mode ------------------------------ */

await test('colour mode hides the answer until you find it', async () => {
  await click('.tab[data-view="colours"]');
  const s = await d.execute(`return {
    visible: !document.getElementById('view-colours').hidden,
    answer: window.FlaggleApp.paletteAnswerCode(),
    guessVeil: !document.getElementById('colours-guess-veil').hidden,
    resultVeil: !document.getElementById('colours-result-veil').hidden,
    canvasHidden: document.getElementById('colours-canvas').hidden,
    imgHidden: document.getElementById('colours-guess-flag').hidden,
    imgSrc: document.getElementById('colours-guess-flag').getAttribute('src'),
    guessCap: document.getElementById('colours-guess-cap').textContent,
    resultCap: document.getElementById('colours-result-cap').textContent,
    tries: document.getElementById('colours-tries').textContent,
    sub: document.getElementById('colours-sub').textContent,
    dailyAnswer: window.FlaggleApp.answerCode(),
  };`);
  ok(s.visible, 'colours view shown');
  ok(s.guessVeil && s.resultVeil, 'both frames are veiled before any guess');
  ok(s.canvasHidden && s.imgHidden, 'nothing of the flag is drawn yet');
  eq(s.imgSrc, null, 'no flag is loaded into the DOM at all');
  eq(s.guessCap, 'your guess');
  eq(s.resultCap, 'your result');
  ok(s.tries.includes('0'), `tries starts at zero, got "${s.tries}"`);
  ok(/^#\d+ · /.test(s.sub), s.sub);
  ok(s.answer !== s.dailyAnswer, 'a different puzzle from the geo daily');
});

await test('nowhere on the colours page is the answer reachable', async () => {
  const s = await d.execute(`
    var view = document.getElementById('view-colours');
    var answer = window.FlaggleApp.paletteAnswerCode();
    var name = window.COUNTRIES.find(function (c) { return c.c === answer; }).n;
    var srcs = Array.prototype.map.call(view.querySelectorAll('img'), function (n) {
      return n.getAttribute('src') || '';
    });
    return { srcs: srcs, leaks: view.textContent.indexOf(name) >= 0, name: name };`);
  eq(s.srcs.filter((x) => x.length).length, 0, 'no flag images on the page');
  eq(s.leaks, false, `the answer "${s.name}" is not written anywhere`);
});

await test('a colour guess lights up only the shared cells', async () => {
  await guess('colours', 'Vietnam');
  const s = await d.execute(`return {
    rows: document.querySelectorAll('#colours-guesses .guess').length,
    name: document.querySelector('#colours-guesses .gname').textContent,
    pct: document.querySelector('#colours-guesses .gprox').textContent,
    canvasShown: !document.getElementById('colours-canvas').hidden,
    veilHidden: document.getElementById('colours-result-veil').hidden,
    guessShown: !document.getElementById('colours-guess-flag').hidden,
    guessSrc: document.getElementById('colours-guess-flag').getAttribute('src'),
    guessCap: document.getElementById('colours-guess-cap').textContent,
    resultCap: document.getElementById('colours-result-cap').textContent,
    miniFlags: document.querySelectorAll('#colours-guesses .mini-flag').length,
    miniMasks: document.querySelectorAll('#colours-guesses .mini-mask').length,
    tries: document.getElementById('colours-tries').textContent,
    game: {
      guesses: window.FlaggleApp.colours.game.guesses.length,
      maskLen: window.FlaggleApp.colours.game.guesses[0].mask.length,
      cells: window.FlaggleApp.colours.game.guesses[0].cells,
    },
  };`);
  eq(s.rows, 1);
  eq(s.name, 'Vietnam');
  ok(/^\d+%$/.test(s.pct), `a match percentage, got "${s.pct}"`);
  ok(s.canvasShown && s.veilHidden, 'the mask replaced the veil');
  ok(s.guessShown, 'your own flag is shown beside the result');
  eq(s.guessSrc, 'flags/vn.svg', 'and it is the flag you guessed');
  eq(s.guessCap, 'Vietnam');
  ok(/^\d+% shared$/.test(s.resultCap), `result caption, got "${s.resultCap}"`);
  eq(s.miniFlags, 1, 'the row pairs your flag with its result');
  eq(s.miniMasks, 1);
  ok(s.tries.includes('Vietnam'), `the stage says whose flag it is: "${s.tries}"`);
  ok(s.tries.includes('warmest'), 'warmest readout appears');
  eq(s.game.maskLen, s.game.cells, 'mask covers every cell');
});

await test('the mask is actually painted green where it matches', async () => {
  const s = await d.execute(`
    var c = document.getElementById('colours-canvas');
    var ctx = c.getContext('2d');
    var data = ctx.getImageData(0, 0, c.width, c.height).data;
    var tally = {}, clear = 0;
    for (var i = 0; i < data.length; i += 4) {
      if (data[i + 3] === 0) clear++;
      else {
        var k = data[i] + ',' + data[i + 1] + ',' + data[i + 2];
        tally[k] = (tally[k] || 0) + 1;
      }
    }
    function rgb(hex) {
      return parseInt(hex.slice(1, 3), 16) + ',' + parseInt(hex.slice(3, 5), 16) + ',' +
        parseInt(hex.slice(5, 7), 16);
    }
    var mask = window.FlaggleApp.colours.game.guesses[0].mask;
    var ones = mask.split('').filter(function (m) { return m === '1'; }).length;
    return {
      tally: tally, clear: clear, ones: ones, cells: mask.length,
      match: rgb(window.Palette.MATCH_COLOR), miss: rgb(window.Palette.MISS_COLOR),
      size: c.width + 'x' + c.height,
      grid: window.Palette.GRID_W + 'x' + window.Palette.GRID_H,
    };`);
  eq(s.clear, 0, 'every cell is painted');
  eq(s.size, s.grid, 'one canvas pixel per grid cell');
  // Only two colours may appear: the match green and the flat miss dark. A
  // ghost of the guess would show up here as extra colours.
  eq(Object.keys(s.tally).sort(), [s.match, s.miss].sort(), 'exactly two colours painted');
  eq(s.tally[s.match], s.ones, 'green covers exactly the matching cells');
  eq(s.tally[s.match] + s.tally[s.miss], s.cells, 'and the rest is flat dark');
});

await test('colour mode gives no distance, direction or continent', async () => {
  const s = await d.execute(`return {
    text: document.getElementById('view-colours').textContent,
    result: window.FlaggleApp.colours.game.guesses[0],
  };`);
  ok(!/\bkm\b/.test(s.text), 'no distances on the page');
  ok(!/[⬆↗➡↘⬇↙⬅↖]/u.test(s.text), 'no direction arrows on the page');
  for (const banned of ['km', 'distance', 'bearing', 'arrow', 'direction', 'proximity']) {
    eq(s.result[banned], undefined, `guess result must not carry ${banned}`);
  }
});

await test('colour mode never runs out of guesses', async () => {
  const answer = await d.execute('return window.FlaggleApp.paletteAnswerCode();');
  const wrongs = await d.execute(
    `return window.COUNTRIES.filter(function (c) { return c.c !== arguments[0] && c.c !== 'vn'; })
      .slice(0, 9).map(function (c) { return c.n; });`,
    [answer]
  );
  for (const wname of wrongs) await guess('colours', wname);
  const s = await d.execute(`return {
    status: window.FlaggleApp.colours.game.status,
    rows: document.querySelectorAll('#colours-guesses .guess').length,
    disabled: document.getElementById('colours-input').disabled,
    newestFirst: document.querySelector('#colours-guesses .gname').textContent,
  };`);
  eq(s.status, 'playing', 'still going after ten tries');
  eq(s.rows, 10);
  ok(!s.disabled, 'still accepting guesses');
  eq(s.newestFirst, wrongs[wrongs.length - 1], 'newest guess on top');
  await shot('07-colours.png', '#colours-tries');
});

await test('solving colour mode reveals the flag and pays by tries', async () => {
  const answer = await d.execute(`return window.COUNTRIES.find(function (c) {
    return c.c === window.FlaggleApp.paletteAnswerCode();
  });`);
  const before = await d.execute('return window.FlaggleApp.store.active().points;');
  await guess('colours', answer.n);
  const s = await d.execute(`return {
    status: window.FlaggleApp.colours.game.status,
    imgShown: !document.getElementById('colours-guess-flag').hidden,
    imgSrc: document.getElementById('colours-guess-flag').getAttribute('src'),
    guessCap: document.getElementById('colours-guess-cap').textContent,
    resultCap: document.getElementById('colours-result-cap').textContent,
    result: document.getElementById('colours-result').textContent,
    disabled: document.getElementById('colours-input').disabled,
    points: window.FlaggleApp.store.active().points,
    palette: window.FlaggleApp.store.active().palette,
    lastPct: window.FlaggleApp.colours.game.guesses.slice(-1)[0].pct,
  };`);
  eq(s.status, 'won');
  ok(s.imgShown, 'the answer flag is finally shown');
  eq(s.imgSrc, `flags/${answer.c}.svg`, 'the winning guess is the answer');
  eq(s.guessCap, `🎉 ${answer.n}`);
  eq(s.resultCap, 'every cell matched');
  eq(s.lastPct, 100, 'a correct guess matches every cell');
  ok(s.result.includes(answer.n), 'names the country');
  ok(s.result.includes('11 tries'), `reports the try count: "${s.result}"`);
  ok(s.result.includes('next flag in'), 'shows the countdown');
  ok(s.disabled, 'input locked for the day');
  ok(s.points > before, 'points awarded');
  eq(s.palette.wins, 1);
  eq(s.palette.currentStreak, 1, 'colour streak started');
  eq(s.palette.bestTries, 11);
  eq(s.palette.tries['10+'], 1, 'bucketed');
  await shot('08-colours-won.png', '#colours-result');
});

await test('the colour streak is tracked separately from the geo one', async () => {
  const s = await d.execute(`return {
    geo: window.FlaggleApp.store.active().currentStreak,
    colour: window.FlaggleApp.store.active().palette.currentStreak,
    geoPlayed: window.FlaggleApp.store.active().played,
    colourPlayed: window.FlaggleApp.store.active().palette.played,
  };`);
  eq(s.geo, 1);
  eq(s.colour, 1);
  eq(s.geoPlayed, 1);
  eq(s.colourPlayed, 1);
});

await test('the colour share text reports tries and hides the answer', async () => {
  const s = await d.execute(`
    var txt = window.Engine.colourShareText(window.FlaggleApp.colours.game, { puzzleNumber: 9, streak: 1 });
    var name = window.COUNTRIES.find(function (c) {
      return c.c === window.FlaggleApp.paletteAnswerCode();
    }).n;
    return { txt: txt, leaks: txt.indexOf(name) >= 0 };`);
  ok(s.txt.includes('Colours'), s.txt);
  ok(s.txt.includes('11 tries'), s.txt);
  eq(s.leaks, false, 'no answer in the share text');
});

await test('a finished colour board survives a reload', async () => {
  await boot();
  await click('.tab[data-view="colours"]');
  const s = await d.execute(`return {
    status: window.FlaggleApp.colours.game.status,
    rows: document.querySelectorAll('#colours-guesses .guess').length,
    imgShown: !document.getElementById('colours-guess-flag').hidden,
    played: window.FlaggleApp.store.active().palette.played,
    masks: window.FlaggleApp.colours.game.guesses.every(function (g) {
      return typeof g.mask === 'string' && g.mask.length === window.Palette.CELLS;
    }),
  };`);
  eq(s.status, 'won');
  eq(s.rows, 11);
  ok(s.imgShown, 'still revealed');
  ok(s.masks, 'masks were recomputed on load, not read from storage');
  eq(s.played, 1, 'counted exactly once');
});

await test('a long colour game stays small in storage', async () => {
  // 9600-cell masks kept verbatim would blow the localStorage quota within a
  // single game, so they must not be written at all.
  const s = await d.execute(`
    var raw = localStorage.getItem('flaggle-lofi:v1');
    var parsed = JSON.parse(raw);
    var board = null;
    Object.keys(parsed.daily).forEach(function (k) {
      if (k.indexOf('|palette|') >= 0) board = parsed.daily[k];
    });
    return {
      kb: raw.length / 1024,
      hasMaskKey: raw.indexOf('"mask"') >= 0,
      longRuns: /[01]{200}/.test(raw),
      guesses: board ? board.guesses.length : 0,
      keptFields: board ? Object.keys(board.guesses[0]).sort() : [],
      cells: window.Palette.CELLS,
    };`);
  eq(s.guesses, 11, 'the whole game was saved');
  eq(s.hasMaskKey, false, 'no mask field survives the trip to storage');
  eq(s.longRuns, false, 'and no mask-shaped payload either');
  ok(s.kb < 20, `saved state is ${s.kb.toFixed(1)}KB for 11 guesses of ${s.cells} cells each`);
  eq(s.keptFields, ['c', 'cells', 'correct', 'emoji', 'matches', 'name', 'pct']);
});

await test('the colour legend lists all ten plus the match colour', async () => {
  const s = await d.execute(`return {
    swatches: document.querySelectorAll('#colours-legend .swatch').length,
    match: document.querySelectorAll('#colours-legend .swatch.match').length,
    names: Array.prototype.map.call(document.querySelectorAll('#colours-legend .swatch span'),
      function (n) { return n.textContent; }),
  };`);
  eq(s.swatches, 11, 'ten colours plus the match colour');
  eq(s.match, 1);
  ok(s.names.includes('sky blue') && s.names.includes('brown'), s.names.join(','));
});

await test('the stats page shows both streaks and the colour try spread', async () => {
  await click('.tab[data-view="stats"]');
  const s = await d.execute(`return {
    stats: Array.prototype.map.call(document.querySelectorAll('#stats-grid .stat'), function (n) {
      return n.querySelector('.k').textContent.trim() + '=' + n.querySelector('.v').textContent;
    }),
    colourRows: document.querySelectorAll('#colour-dist .dist-row').length,
    colourTotal: Array.prototype.reduce.call(document.querySelectorAll('#colour-dist .n'),
      function (a, n) { return a + Number(n.textContent); }, 0),
    summary: document.getElementById('colour-dist-summary').textContent,
  };`);
  ok(s.stats.some((x) => x.startsWith('🎨 colour streak=1')), s.stats.join(' | '));
  ok(s.stats.some((x) => x.startsWith('🔥 geo streak=1')), s.stats.join(' | '));
  eq(s.colourRows, 10, '1-9 plus 10+');
  eq(s.colourTotal, 1);
  ok(s.summary.includes('best 11'), s.summary);
});

await test('the leaderboard reports colour streaks too', async () => {
  await click('.tab[data-view="board"]');
  const s = await d.execute(`return {
    lines: Array.prototype.map.call(document.querySelectorAll('#leaderboard li.me .sub'),
      function (n) { return n.textContent; }),
  };`);
  eq(s.lines.length, 2, 'a line each for geo and colour');
  ok(s.lines[1].includes('🎨1'), `colour streak line: "${s.lines[1]}"`);
  ok(s.lines[1].includes('1 solved'), s.lines[1]);
});

/* --------------------------- practice hint styles -------------------------- */

await test('practice can switch to colour matching', async () => {
  await click('.tab[data-view="practice"]');
  await click('#btn-style-colour');
  const s = await d.execute(`return {
    style: window.FlaggleApp.practiceStyle(),
    kind: window.FlaggleApp.practice.kind,
    mode: window.FlaggleApp.practice.mode,
    veilShown: !document.getElementById('practice-guess-veil').hidden,
    imgHidden: document.getElementById('practice-single').hidden,
    pairShown: !document.getElementById('practice-pair').hidden,
    dotsHidden: document.getElementById('practice-dots').hidden,
    triesShown: !document.getElementById('practice-tries').hidden,
    on: document.getElementById('btn-style-colour').classList.contains('on'),
    geoOff: !document.getElementById('btn-style-geo').classList.contains('on'),
  };`);
  eq(s.style, 'colour');
  eq(s.kind, 'colour');
  eq(s.mode, 'palette-practice');
  ok(s.veilShown && s.imgHidden && s.pairShown, 'the practice flag is hidden too');
  ok(s.dotsHidden && s.triesShown, 'pips swapped for a try counter');
  ok(s.on && s.geoOff, 'the toggle reflects the mode');
});

await test('a colour practice win records tries but no daily streak', async () => {
  const before = await d.execute(`return {
    streak: window.FlaggleApp.store.active().palette.currentStreak,
    played: window.FlaggleApp.store.active().palette.played,
  };`);
  const name = await d.execute(`return window.COUNTRIES.find(function (c) {
    return c.c === window.FlaggleApp.practiceAnswerCode();
  }).n;`);
  await guess('practice', name);
  const s = await d.execute(`return {
    status: window.FlaggleApp.practice.game.status,
    streak: window.FlaggleApp.store.active().palette.currentStreak,
    played: window.FlaggleApp.store.active().palette.played,
    practice: window.FlaggleApp.store.active().palette.practice,
    imgShown: !document.getElementById('practice-guess-flag').hidden,
  };`);
  eq(s.status, 'won');
  eq(s.streak, before.streak, 'daily colour streak untouched');
  eq(s.played, before.played, 'not counted as the colour daily');
  eq(s.practice.played, 1);
  eq(s.practice.wins, 1);
  ok(s.imgShown, 'the answer is revealed at the end');
});

await test('switching back to geo restores the flag and the pips', async () => {
  await click('#btn-style-geo');
  const s = await d.execute(`return {
    style: window.FlaggleApp.practiceStyle(),
    kind: window.FlaggleApp.practice.kind,
    mode: window.FlaggleApp.practice.mode,
    imgShown: !document.getElementById('practice-single').hidden,
    veilHidden: document.getElementById('practice-pair').hidden,
    dotsShown: !document.getElementById('practice-dots').hidden,
    triesHidden: document.getElementById('practice-tries').hidden,
    pips: document.querySelectorAll('#practice-dots .dot-pip').length,
  };`);
  eq(s.style, 'geo');
  eq(s.kind, 'geo');
  eq(s.mode, 'practice');
  ok(s.imgShown && s.veilHidden, 'the flag is back on show, the pair is gone');
  ok(s.dotsShown && s.triesHidden, 'pips are back');
  eq(s.pips, 6);
});

await test('the practice hint style is remembered across a reload', async () => {
  await click('#btn-style-colour');
  await boot();
  const s = await d.execute(`return window.FlaggleApp.practiceStyle();`);
  eq(s, 'colour', 'restored from settings');
  await d.execute(`window.FlaggleApp.setPracticeStyle('geo');`);
});

/* --------------------------------- hotkeys -------------------------------- */

await test('backtick deals a fresh practice round from any tab', async () => {
  await click('.tab[data-view="daily"]');
  const before = await d.execute(`return {
    view: window.FlaggleApp.currentView(),
    answer: window.FlaggleApp.practiceAnswerCode(),
  };`);
  eq(before.view, 'daily');
  await d.execute(`document.dispatchEvent(
    new KeyboardEvent('keydown', { key: '\`', bubbles: true, cancelable: true }));`);
  const s = await d.execute(`return {
    view: window.FlaggleApp.currentView(),
    answer: window.FlaggleApp.practiceAnswerCode(),
    rows: document.querySelectorAll('#practice-guesses .guess').length,
    toast: document.getElementById('toast').textContent,
  };`);
  eq(s.view, 'practice', 'jumped to practice');
  ok(s.answer && s.answer !== before.answer, 'dealt a different flag');
  eq(s.rows, 0, 'fresh board');
  ok(s.toast.includes('fresh flag'), s.toast);
});

await test('backtick works mid-round and while the guess box has focus', async () => {
  await type('practice-input', 'Peru');
  const before = await d.execute('return window.FlaggleApp.practiceAnswerCode();');
  await d.execute(`var i = document.getElementById('practice-input'); i.focus();
    i.dispatchEvent(new KeyboardEvent('keydown', { key: '\`', bubbles: true, cancelable: true }));`);
  const s = await d.execute(`return {
    answer: window.FlaggleApp.practiceAnswerCode(),
    value: document.getElementById('practice-input').value,
    view: window.FlaggleApp.currentView(),
  };`);
  ok(s.answer !== before, 'skipped to a new flag');
  eq(s.value, '', 'the half-typed guess was cleared');
  eq(s.view, 'practice');
});

await test('backtick is left alone while naming a new player', async () => {
  await click('.tab[data-view="board"]');
  await d.execute(`var i = document.getElementById('new-name'); i.focus(); i.value = 'a';
    i.dispatchEvent(new KeyboardEvent('keydown', { key: '\`', bubbles: true, cancelable: true }));`);
  const s = await d.execute(`return window.FlaggleApp.currentView();`);
  eq(s, 'board', 'stayed on the leaderboard');
  await d.execute(`document.getElementById('new-name').value = '';`);
});

await test('both countdowns keep ticking when the day is fully played', async () => {
  // The two boards used to share one interval, so finishing both froze the
  // first board's clock.
  await d.execute(`window.FlaggleApp.showView('daily');`);
  const first = await d.execute(`return {
    daily: document.querySelector('#daily-result .chip').textContent,
    colours: document.querySelector('#colours-result .chip').textContent,
  };`);
  ok(first.daily.includes('next flag in'), first.daily);
  ok(first.colours.includes('next flag in'), first.colours);
  await new Promise((r) => setTimeout(r, 2200));
  const second = await d.execute(`return {
    daily: document.querySelector('#daily-result .chip').textContent,
    colours: document.querySelector('#colours-result .chip').textContent,
  };`);
  ok(second.daily !== first.daily, `daily clock moved: ${first.daily} -> ${second.daily}`);
  ok(second.colours !== first.colours, `colour clock moved: ${first.colours} -> ${second.colours}`);
});

/* -------------------------------- give up --------------------------------- */

await test('give up needs two taps, and the first can be walked back', async () => {
  await boot();
  await wipe();
  await boot();
  await click('.tab[data-view="colours"]');
  await guess('colours', 'Vietnam');

  const idle = await d.execute(`return {
    shown: !document.getElementById('colours-giveup').hidden,
    label: document.getElementById('colours-giveup').textContent,
    armed: document.getElementById('colours-giveup').classList.contains('armed'),
  };`);
  ok(idle.shown, 'the button is offered while playing');
  eq(idle.label, '🏳️ give up');
  ok(!idle.armed);

  await click('#colours-giveup');
  const armed = await d.execute(`return {
    label: document.getElementById('colours-giveup').textContent,
    armed: document.getElementById('colours-giveup').classList.contains('armed'),
    status: window.FlaggleApp.colours.game.status,
    played: window.FlaggleApp.store.active().palette.played,
  };`);
  eq(armed.label, '🏳️ really give up?', 'one tap only arms it');
  ok(armed.armed);
  eq(armed.status, 'playing', 'nothing has happened yet');
  eq(armed.played, 0, 'and nothing was recorded');

  // Guessing again disarms it, so a stray click can't linger.
  await guess('colours', 'Sweden');
  const disarmed = await d.execute(`return {
    label: document.getElementById('colours-giveup').textContent,
    armed: document.getElementById('colours-giveup').classList.contains('armed'),
    status: window.FlaggleApp.colours.game.status,
  };`);
  eq(disarmed.label, '🏳️ give up', 'back to resting');
  ok(!disarmed.armed);
  eq(disarmed.status, 'playing');
});

await test('the second tap reveals the answer and records a loss', async () => {
  const answer = await d.execute(`return window.COUNTRIES.find(function (c) {
    return c.c === window.FlaggleApp.paletteAnswerCode();
  });`);
  await click('#colours-giveup');
  await click('#colours-giveup');
  const s = await d.execute(`return {
    status: window.FlaggleApp.colours.game.status,
    gaveUp: window.FlaggleApp.colours.game.gaveUp,
    imgShown: !document.getElementById('colours-guess-flag').hidden,
    imgSrc: document.getElementById('colours-guess-flag').getAttribute('src'),
    guessCap: document.getElementById('colours-guess-cap').textContent,
    resultCap: document.getElementById('colours-result-cap').textContent,
    result: document.getElementById('colours-result').textContent,
    buttonHidden: document.getElementById('colours-giveup').hidden,
    inputDisabled: document.getElementById('colours-input').disabled,
    toast: document.getElementById('toast').textContent,
    points: window.FlaggleApp.store.active().points,
    palette: window.FlaggleApp.store.active().palette,
    rows: document.querySelectorAll('#colours-guesses .guess').length,
    tries: document.getElementById('colours-tries').textContent,
  };`);
  eq(s.status, 'lost');
  eq(s.gaveUp, true);
  ok(!s.tries.includes('showing'), `the stage shows the answer now, not a guess: "${s.tries}"`);
  ok(s.tries.includes('warmest'), 'but the warmest reading stays');
  ok(s.imgShown, 'the answer is finally revealed');
  eq(s.imgSrc, `flags/${answer.c}.svg`);
  eq(s.guessCap, `🏳️ ${answer.n}`);
  ok(s.resultCap.startsWith('best you got:'), s.resultCap);
  ok(s.result.includes(answer.n), 'the result panel names it');
  ok(s.buttonHidden, 'the button retires once the round is over');
  ok(s.inputDisabled, 'no more guessing');
  ok(s.toast.includes(answer.n), s.toast);
  eq(s.points, 0, 'folding pays nothing');
  eq(s.palette.played, 1);
  eq(s.palette.wins, 0);
  eq(s.palette.currentStreak, 0);
  eq(s.rows, 2, 'the guesses you did make are still listed');
  await shot('09-gave-up.png', '#colours-pair');
});

await test('a forfeited board stays forfeited after a reload', async () => {
  await boot();
  await click('.tab[data-view="colours"]');
  const s = await d.execute(`return {
    status: window.FlaggleApp.colours.game.status,
    gaveUp: window.FlaggleApp.colours.game.gaveUp,
    imgShown: !document.getElementById('colours-guess-flag').hidden,
    buttonHidden: document.getElementById('colours-giveup').hidden,
    played: window.FlaggleApp.store.active().palette.played,
    masks: window.FlaggleApp.colours.game.guesses.every(function (g) {
      return typeof g.mask === 'string';
    }),
  };`);
  eq(s.status, 'lost');
  eq(s.gaveUp, true);
  ok(s.imgShown, 'still revealed');
  ok(s.buttonHidden);
  eq(s.played, 1, 'counted exactly once');
  ok(s.masks, 'masks came back');
});

await test('giving up on the geo daily forfeits the remaining guesses', async () => {
  await click('.tab[data-view="daily"]');
  const answer = await d.execute(`return window.COUNTRIES.find(function (c) {
    return c.c === window.FlaggleApp.answerCode();
  });`);
  const wrong = answer.n === 'Chile' ? 'Peru' : 'Chile';
  await guess('daily', wrong);
  await click('#daily-giveup');
  await click('#daily-giveup');
  const s = await d.execute(`return {
    status: window.FlaggleApp.daily.game.status,
    gaveUp: window.FlaggleApp.daily.game.gaveUp,
    flagSrc: document.getElementById('daily-flag').getAttribute('src'),
    filter: document.getElementById('daily-flag').style.filter,
    result: document.getElementById('daily-result').textContent,
    inputDisabled: document.getElementById('daily-input').disabled,
    played: window.FlaggleApp.store.active().played,
    wins: window.FlaggleApp.store.active().wins,
    streak: window.FlaggleApp.store.active().currentStreak,
    distributionX: window.FlaggleApp.store.active().distribution.X,
    totalGuesses: window.FlaggleApp.store.active().totalGuesses,
    rows: document.querySelectorAll('#daily-guesses .guess').length,
  };`);
  eq(s.status, 'lost');
  eq(s.gaveUp, true);
  eq(s.flagSrc, `flags/${answer.c}.svg`);
  eq(s.filter, 'none', 'and it is not fogged any more');
  ok(s.result.includes(answer.n));
  ok(s.inputDisabled);
  eq(s.played, 1);
  eq(s.wins, 0);
  eq(s.streak, 0);
  eq(s.distributionX, 1);
  eq(s.totalGuesses, 6, 'a forfeit counts as using the whole board');
  eq(s.rows, 1, 'the one guess made is kept');
});

await test('give up cannot be triggered once a round is already over', async () => {
  const before = await d.execute(`return {
    played: window.FlaggleApp.store.active().played,
    points: window.FlaggleApp.store.active().points,
  };`);
  await d.execute(`window.FlaggleApp.giveUp('daily'); window.FlaggleApp.giveUp('daily');`);
  const s = await d.execute(`return {
    played: window.FlaggleApp.store.active().played,
    points: window.FlaggleApp.store.active().points,
    status: window.FlaggleApp.daily.game.status,
  };`);
  eq(s.played, before.played, 'no second recording');
  eq(s.points, before.points);
  eq(s.status, 'lost');
});

await test('giving up in practice reveals the flag and moves on', async () => {
  await click('.tab[data-view="practice"]');
  await d.execute(`window.FlaggleApp.setPracticeStyle('geo');`);
  const answer = await d.execute('return window.FlaggleApp.practiceAnswerCode();');
  await click('#practice-giveup');
  await click('#practice-giveup');
  const s = await d.execute(
    `return {
      status: window.FlaggleApp.practice.game.status,
      played: window.FlaggleApp.store.active().practice.played,
      run: window.FlaggleApp.store.active().practice.run,
      seen: window.FlaggleApp.store.active().flags[arguments[0]].seen,
      solved: window.FlaggleApp.store.active().flags[arguments[0]].solved,
      hasNext: document.getElementById('practice-result').textContent.includes('next flag'),
    };`,
    [answer]
  );
  eq(s.status, 'lost');
  eq(s.played, 1);
  eq(s.run, 0);
  eq(s.seen, 1);
  eq(s.solved, 0, 'a forfeited flag counts as missed');
  ok(s.hasNext, 'and you can deal another straight away');

  // The backtick shortcut still works right after folding.
  await d.execute(`document.dispatchEvent(
    new KeyboardEvent('keydown', { key: '\`', bubbles: true, cancelable: true }));`);
  const next = await d.execute(`return {
    answer: window.FlaggleApp.practiceAnswerCode(),
    status: window.FlaggleApp.practice.game.status,
    giveUpShown: !document.getElementById('practice-giveup').hidden,
  };`);
  ok(next.answer !== answer, 'new flag dealt');
  eq(next.status, 'playing');
  ok(next.giveUpShown, 'and the button is back for the new round');
});

await test('no javascript errors along the way', async () => {
  const list = await errs();
  eq(list, [], 'window errors');
});

await test('the layout holds up on a phone', async () => {
  await d.setWindow(390, 844);
  await boot();
  const s = await d.execute(`return {
    overflow: document.documentElement.scrollWidth > window.innerWidth + 1,
    tabsVisible: document.querySelector('.tabs').getBoundingClientRect().height > 0,
    flagWidth: document.querySelector('.flag-frame').getBoundingClientRect().width,
    inner: window.innerWidth,
  };`);
  ok(!s.overflow, 'no horizontal scroll');
  ok(s.tabsVisible, 'tabs still there');
  ok(s.flagWidth <= s.inner, `flag fits: ${s.flagWidth} <= ${s.inner}`);
  await shot('06-mobile.png');
  await d.setWindow(1100, 1000);
});

// --- teardown --------------------------------------------------------------

const total = pass + failures.length;
const color = failures.length ? '\x1b[31m' : '\x1b[32m';
console.log(`${color}ui: ${pass}/${total} passed\x1b[0m`);
if (failures.length) {
  console.log(`failed: ${failures.join(', ')}`);
  process.exitCode = 1;
}
console.log(`screenshots -> ${SHOTS}`);

await d.quit();
closeServer();
