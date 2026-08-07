/* ==========================================================================
   store.js — profiles, streaks, per-flag stats, leaderboard scoring.
   Persists to localStorage; all logic is pure enough to test in node.
   ========================================================================== */
(function (window) {
  'use strict';

  var KEY = 'flaggle-lofi:v1';
  var MAX_GUESSES = 6;

  /* ---------- scoring ---------- */

  var TRY_FLOOR = 20; // a colour solve is always worth something

  // Solve it in one and you get the lot; a sixth-guess save still pays.
  // The colour game has no guess cap, so it decays per try down to a floor.
  function pointsFor(opts) {
    if (opts.status !== 'won') return 0;
    var used = Math.max(1, opts.guesses);
    var daily = opts.mode === 'daily' || opts.mode === 'palette';
    var streakBonus = daily ? Math.min((opts.streak || 0) * 3, 45) : 0;

    if (opts.mode === 'palette' || opts.mode === 'palette-practice') {
      var full = opts.mode === 'palette' ? 120 : 24;
      var step = opts.mode === 'palette' ? 8 : 2;
      var floor = opts.mode === 'palette' ? TRY_FLOOR : 4;
      return Math.max(floor, full - (used - 1) * step) + streakBonus;
    }

    var base = opts.mode === 'daily' ? 60 : 12;
    var speed = (MAX_GUESSES - used) * (opts.mode === 'daily' ? 12 : 3);
    return base + speed + streakBonus;
  }

  function isNextDay(prevKey, key) {
    if (!prevKey) return false;
    var p = prevKey.split('-').map(Number);
    var c = key.split('-').map(Number);
    var pd = Date.UTC(p[0], p[1] - 1, p[2]);
    var cd = Date.UTC(c[0], c[1] - 1, c[2]);
    return cd - pd === 86400000;
  }

  // Returns the new { current, max } streak after a daily result. Works for any
  // holder with currentStreak / maxStreak / lastDailyKey — the profile itself
  // for the geo daily, profile.palette for the colour daily.
  function nextStreak(holder, key, won) {
    var cur = holder.currentStreak || 0;
    if (!won) return { current: 0, max: holder.maxStreak || 0 };
    var next = isNextDay(holder.lastDailyKey, key) ? cur + 1 : 1;
    return { current: next, max: Math.max(next, holder.maxStreak || 0) };
  }

  // Colour rounds have no cap, so "did you get it in six or fewer" is the bar
  // that keeps most/least-missed comparable between the two game types.
  var STAT_TRY_BAR = MAX_GUESSES;

  function tryBucket(n) {
    return n >= 10 ? '10+' : String(n);
  }

  /* ---------- flag difficulty ---------- */

  // Laplace-smoothed miss rate keeps a single unlucky flag from topping the
  // board on one sighting, while still surfacing genuinely nasty ones.
  function flagScore(rec) {
    var seen = rec.seen || 0;
    var solved = rec.solved || 0;
    var missed = seen - solved;
    return (missed + 1) / (seen + 2);
  }

  function avgGuesses(rec) {
    return rec.solved ? rec.guessesOnSolve / rec.solved : null;
  }

  function rankFlags(flags, countriesByCode, opts) {
    opts = opts || {};
    var minSeen = opts.minSeen || 1;
    var rows = [];
    Object.keys(flags || {}).forEach(function (code) {
      var rec = flags[code];
      var country = countriesByCode[code];
      if (!country || (rec.seen || 0) < minSeen) return;
      rows.push({
        c: code,
        country: country,
        seen: rec.seen || 0,
        solved: rec.solved || 0,
        missed: (rec.seen || 0) - (rec.solved || 0),
        avgGuesses: avgGuesses(rec),
        missRate: rec.seen ? ((rec.seen - rec.solved) / rec.seen) * 100 : 0,
        score: flagScore(rec),
      });
    });
    var worst = rows.slice().sort(function (a, b) {
      return b.score - a.score || b.seen - a.seen || a.country.n.localeCompare(b.country.n);
    });
    var best = rows.slice().sort(function (a, b) {
      return (
        a.score - b.score ||
        (a.avgGuesses || 99) - (b.avgGuesses || 99) ||
        b.seen - a.seen ||
        a.country.n.localeCompare(b.country.n)
      );
    });
    return { mostMissed: worst, leastMissed: best };
  }

  /* ---------- shapes ---------- */

  function emptyProfile(id, name, emoji, now) {
    return {
      id: id,
      name: name,
      emoji: emoji || '☕',
      createdAt: now || 0,
      points: 0,
      played: 0,
      wins: 0,
      currentStreak: 0,
      maxStreak: 0,
      lastDailyKey: null,
      distribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, X: 0 },
      practice: { played: 0, wins: 0, points: 0, bestRun: 0, run: 0 },
      palette: {
        played: 0,
        wins: 0,
        points: 0,
        currentStreak: 0,
        maxStreak: 0,
        lastDailyKey: null,
        bestTries: null,
        totalTries: 0,
        tries: {},
        history: {},
        practice: { played: 0, wins: 0, points: 0, totalTries: 0 },
      },
      flags: {},
      history: {},
      totalGuesses: 0,
    };
  }

  function emptyPalette() {
    return emptyProfile('', '', '', 0).palette;
  }

  function emptyState() {
    return {
      version: 1,
      activeProfile: null,
      profiles: {},
      daily: {}, // in-progress daily boards, keyed by profileId|dateKey
      settings: { hardMode: false, sound: false, volume: 0.5, rain: false, theme: 'latte' },
    };
  }

  // Fills in anything a older/partial save is missing.
  function hydrate(raw) {
    var base = emptyState();
    if (!raw || typeof raw !== 'object') return base;
    var s = {
      version: 1,
      activeProfile: raw.activeProfile || null,
      profiles: raw.profiles && typeof raw.profiles === 'object' ? raw.profiles : {},
      daily: raw.daily && typeof raw.daily === 'object' ? raw.daily : {},
      settings: Object.assign({}, base.settings, raw.settings || {}),
    };
    Object.keys(s.profiles).forEach(function (id) {
      var p = Object.assign(emptyProfile(id, 'Player', '☕', 0), s.profiles[id]);
      p.distribution = Object.assign({ 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, X: 0 }, p.distribution);
      p.practice = Object.assign({ played: 0, wins: 0, points: 0, bestRun: 0, run: 0 }, p.practice);
      p.palette = Object.assign(emptyPalette(), p.palette);
      p.palette.tries = p.palette.tries || {};
      p.palette.history = p.palette.history || {};
      p.palette.practice = Object.assign(
        { played: 0, wins: 0, points: 0, totalTries: 0 },
        p.palette.practice
      );
      p.flags = p.flags || {};
      p.history = p.history || {};
      s.profiles[id] = p;
    });
    if (!s.activeProfile || !s.profiles[s.activeProfile]) {
      var ids = Object.keys(s.profiles);
      s.activeProfile = ids.length ? ids[0] : null;
    }
    return s;
  }

  /* ---------- store ---------- */

  function createStore(storage, opts) {
    opts = opts || {};
    var now = opts.now || function () { return Date.now(); };
    var state;

    try {
      state = hydrate(JSON.parse(storage.getItem(KEY)));
    } catch (e) {
      state = emptyState();
    }

    function save() {
      try {
        storage.setItem(KEY, JSON.stringify(state));
      } catch (e) {
        /* quota or private mode — the game still works, it just won't persist */
      }
      return state;
    }

    function newId() {
      return 'p' + now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);
    }

    function profileList() {
      return Object.keys(state.profiles).map(function (id) {
        return state.profiles[id];
      });
    }

    function active() {
      return state.activeProfile ? state.profiles[state.activeProfile] : null;
    }

    function ensureProfile(name, emoji) {
      var p = active();
      if (p) return p;
      return addProfile(name || 'you', emoji || '☕');
    }

    function addProfile(name, emoji) {
      var id = newId();
      var clean = String(name || 'player').trim().slice(0, 18) || 'player';
      state.profiles[id] = emptyProfile(id, clean, emoji, now());
      state.activeProfile = id;
      save();
      return state.profiles[id];
    }

    function setActive(id) {
      if (state.profiles[id]) {
        state.activeProfile = id;
        save();
      }
      return active();
    }

    function renameProfile(id, name, emoji) {
      var p = state.profiles[id];
      if (!p) return null;
      if (name) p.name = String(name).trim().slice(0, 18) || p.name;
      if (emoji) p.emoji = emoji;
      save();
      return p;
    }

    function deleteProfile(id) {
      delete state.profiles[id];
      Object.keys(state.daily).forEach(function (k) {
        if (k.indexOf(id + '|') === 0) delete state.daily[k];
      });
      if (state.activeProfile === id) {
        var ids = Object.keys(state.profiles);
        state.activeProfile = ids.length ? ids[0] : null;
      }
      save();
    }

    /* ---- in-progress daily board ---- */

    function dailyKey(dateKey, mode) {
      return (state.activeProfile || 'anon') + '|' + (mode || 'daily') + '|' + dateKey;
    }

    function loadDaily(dateKey, mode) {
      return state.daily[dailyKey(dateKey, mode)] || null;
    }

    function saveDaily(dateKey, game, mode) {
      state.daily[dailyKey(dateKey, mode)] = game;
      // Keep the last week or so; no reason to hoard old boards.
      var keys = Object.keys(state.daily);
      if (keys.length > 40) {
        keys
          .sort()
          .slice(0, keys.length - 40)
          .forEach(function (k) {
            delete state.daily[k];
          });
      }
      save();
      return game;
    }

    /* ---- recording results ---- */

    // result: { mode, dateKey, answer, status, guesses }
    // mode is 'daily' | 'practice' | 'palette' | 'palette-practice'.
    function recordResult(result) {
      var p = ensureProfile();
      var won = result.status === 'won';
      var used = result.guesses;
      var code = result.answer;
      var isPalette = result.mode === 'palette' || result.mode === 'palette-practice';

      // A daily puzzle only ever counts once, per game type.
      if (result.mode === 'daily' && p.history[result.dateKey])
        return { alreadyRecorded: true, profile: p, points: 0, streak: p.currentStreak };
      if (result.mode === 'palette' && p.palette.history[result.dateKey])
        return { alreadyRecorded: true, profile: p, points: 0, streak: p.palette.currentStreak };

      var streak = 0;
      if (result.mode === 'daily') {
        var s = nextStreak(p, result.dateKey, won);
        p.currentStreak = s.current;
        p.maxStreak = s.max;
        p.lastDailyKey = result.dateKey;
        streak = s.current;
      } else if (result.mode === 'palette') {
        var ps = nextStreak(p.palette, result.dateKey, won);
        p.palette.currentStreak = ps.current;
        p.palette.maxStreak = ps.max;
        p.palette.lastDailyKey = result.dateKey;
        streak = ps.current;
      }

      var pts = pointsFor({ status: result.status, guesses: used, mode: result.mode, streak: streak });
      p.points += pts;

      if (result.mode === 'daily') {
        p.played += 1;
        p.wins += won ? 1 : 0;
        p.totalGuesses += used;
        p.distribution[won ? String(used) : 'X'] += 1;
        p.history[result.dateKey] = { status: result.status, guesses: used, answer: code };
      } else if (result.mode === 'practice') {
        p.practice.played += 1;
        p.practice.wins += won ? 1 : 0;
        p.practice.points += pts;
        p.practice.run = won ? p.practice.run + 1 : 0;
        p.practice.bestRun = Math.max(p.practice.bestRun, p.practice.run);
      } else if (result.mode === 'palette') {
        p.palette.played += 1;
        p.palette.points += pts;
        if (won) {
          p.palette.wins += 1;
          p.palette.totalTries += used;
          var bucket = tryBucket(used);
          p.palette.tries[bucket] = (p.palette.tries[bucket] || 0) + 1;
          p.palette.bestTries =
            p.palette.bestTries == null ? used : Math.min(p.palette.bestTries, used);
        }
        p.palette.history[result.dateKey] = { status: result.status, tries: used, answer: code };
      } else {
        p.palette.practice.played += 1;
        p.palette.practice.points += pts;
        if (won) {
          p.palette.practice.wins += 1;
          p.palette.practice.totalTries += used;
        }
      }

      var rec = p.flags[code] || { seen: 0, solved: 0, guessesOnSolve: 0, lastSeen: 0 };
      rec.seen += 1;
      // Colour rounds are unlimited, so only a solve inside the six-guess bar
      // counts as "you knew it" — otherwise every flag would look mastered.
      var countsAsSolved = won && (!isPalette || used <= STAT_TRY_BAR);
      if (countsAsSolved) {
        rec.solved += 1;
        rec.guessesOnSolve += used;
      }
      rec.lastSeen = now();
      p.flags[code] = rec;

      save();
      return {
        alreadyRecorded: false,
        profile: p,
        points: pts,
        streak: result.mode === 'palette' ? p.palette.currentStreak : p.currentStreak,
      };
    }

    /* ---- views ---- */

    function leaderboard() {
      return profileList()
        .slice()
        .sort(function (a, b) {
          return (
            b.points - a.points ||
            b.maxStreak - a.maxStreak ||
            b.wins - a.wins ||
            a.createdAt - b.createdAt
          );
        })
        .map(function (p, i) {
          var winRate = p.played ? Math.round((p.wins / p.played) * 100) : 0;
          return {
            rank: i + 1,
            medal: ['🥇', '🥈', '🥉'][i] || '🫘',
            id: p.id,
            name: p.name,
            emoji: p.emoji,
            points: p.points,
            played: p.played,
            wins: p.wins,
            winRate: winRate,
            currentStreak: p.currentStreak,
            maxStreak: p.maxStreak,
            practiceWins: p.practice.wins,
            avgGuesses: p.wins ? +(p.totalGuesses / p.played).toFixed(2) : null,
            paletteStreak: p.palette.currentStreak,
            paletteMaxStreak: p.palette.maxStreak,
            paletteWins: p.palette.wins,
            paletteAvgTries: p.palette.wins
              ? +(p.palette.totalTries / p.palette.wins).toFixed(1)
              : null,
            paletteBest: p.palette.bestTries,
          };
        });
    }

    function flagStats(countriesByCode, options) {
      var p = active();
      return rankFlags(p ? p.flags : {}, countriesByCode, options);
    }

    function settings() {
      return state.settings;
    }

    function setSetting(k, v) {
      state.settings[k] = v;
      save();
      return state.settings;
    }

    function reset() {
      state = emptyState();
      save();
    }

    return {
      raw: function () {
        return state;
      },
      save: save,
      profiles: profileList,
      active: active,
      ensureProfile: ensureProfile,
      addProfile: addProfile,
      setActive: setActive,
      renameProfile: renameProfile,
      deleteProfile: deleteProfile,
      loadDaily: loadDaily,
      saveDaily: saveDaily,
      recordResult: recordResult,
      leaderboard: leaderboard,
      flagStats: flagStats,
      settings: settings,
      setSetting: setSetting,
      reset: reset,
    };
  }

  window.Store = {
    KEY: KEY,
    create: createStore,
    pointsFor: pointsFor,
    nextStreak: nextStreak,
    isNextDay: isNextDay,
    rankFlags: rankFlags,
    flagScore: flagScore,
    tryBucket: tryBucket,
    STAT_TRY_BAR: STAT_TRY_BAR,
    emptyProfile: emptyProfile,
    hydrate: hydrate,
  };
})(typeof window !== 'undefined' ? window : globalThis);
