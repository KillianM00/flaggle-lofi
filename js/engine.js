/* ==========================================================================
   engine.js — pure game logic. No DOM, no storage. Testable in node.
   ========================================================================== */
(function (window) {
  'use strict';

  var MAX_GUESSES = 6;
  var EARTH_R = 6371; // km
  var MAX_DIST = 20015; // half the earth's circumference
  var EPOCH = Date.UTC(2026, 0, 1); // day 0 of the daily rotation

  /* ---------- text ---------- */

  function normalize(s) {
    return String(s == null ? '' : s)
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  }

  /* ---------- geo ---------- */

  var rad = function (d) {
    return (d * Math.PI) / 180;
  };
  var deg = function (r) {
    return (r * 180) / Math.PI;
  };

  // Great-circle distance in km.
  function distance(a, b) {
    var dLat = rad(b.lat - a.lat);
    var dLng = rad(b.lng - a.lng);
    var la1 = rad(a.lat);
    var la2 = rad(b.lat);
    var h =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  // Initial bearing from a to b, in degrees clockwise from north.
  function bearing(a, b) {
    var la1 = rad(a.lat);
    var la2 = rad(b.lat);
    var dLng = rad(b.lng - a.lng);
    var y = Math.sin(dLng) * Math.cos(la2);
    var x = Math.cos(la1) * Math.sin(la2) - Math.sin(la1) * Math.cos(la2) * Math.cos(dLng);
    return (deg(Math.atan2(y, x)) + 360) % 360;
  }

  var ARROWS = ['⬆️', '↗️', '➡️', '↘️', '⬇️', '↙️', '⬅️', '↖️'];
  var ARROW_LABELS = [
    'north',
    'north-east',
    'east',
    'south-east',
    'south',
    'south-west',
    'west',
    'north-west',
  ];

  function arrowIndex(bearingDeg) {
    return Math.round(((bearingDeg % 360) + 360) % 360 / 45) % 8;
  }

  function arrowFor(bearingDeg) {
    return ARROWS[arrowIndex(bearingDeg)];
  }

  function directionLabel(bearingDeg) {
    return ARROW_LABELS[arrowIndex(bearingDeg)];
  }

  // 0–100. 100 means you're standing on it.
  function proximity(km) {
    return Math.max(0, Math.round(((MAX_DIST - Math.min(km, MAX_DIST)) / MAX_DIST) * 100));
  }

  function formatDistance(km) {
    if (km < 1) return '0 km';
    if (km < 10) return km.toFixed(1) + ' km';
    return Math.round(km).toLocaleString('en-US') + ' km';
  }

  /* ---------- seeded shuffle so the daily flag never repeats in a cycle ---- */

  function mulberry32(seed) {
    var t = seed >>> 0;
    return function () {
      t = (t + 0x6d2b79f5) >>> 0;
      var r = Math.imul(t ^ (t >>> 15), 1 | t);
      r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
      return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
    };
  }

  function shuffled(list, seed) {
    var out = list.slice();
    var rnd = mulberry32(seed);
    for (var i = out.length - 1; i > 0; i--) {
      var j = Math.floor(rnd() * (i + 1));
      var tmp = out[i];
      out[i] = out[j];
      out[j] = tmp;
    }
    return out;
  }

  // 'YYYY-MM-DD' in the player's own timezone — the puzzle flips at local midnight.
  function dateKey(date) {
    var d = date || new Date();
    var p = function (n) {
      return String(n).padStart(2, '0');
    };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }

  function dayNumber(key) {
    var parts = String(key).split('-').map(Number);
    var ms = Date.UTC(parts[0], parts[1] - 1, parts[2]) - EPOCH;
    return Math.floor(ms / 86400000);
  }

  // Same date + same country list => same flag, anywhere, forever.
  // `salt` gives a mode its own rotation, so the colour game and the geo game
  // aren't handing out the same country on the same day.
  function dailyCountry(countries, key, salt) {
    var n = countries.length;
    var day = dayNumber(key);
    var cycle = Math.floor(day / n);
    var pos = ((day % n) + n) % n;
    var order = shuffled(countries, 0x1eaf + cycle * 2654435761 + (salt || 0) * 0x9e3779b1);
    return order[pos];
  }

  var PALETTE_SALT = 7;

  function paletteCountry(countries, key) {
    return dailyCountry(countries, key, PALETTE_SALT);
  }

  function puzzleNumber(key) {
    return dayNumber(key) + 1;
  }

  /* ---------- search index ---------- */

  function createSearch(countries) {
    var entries = countries.map(function (c) {
      return { c: c, name: normalize(c.n), aliases: c.a || [] };
    });
    var exact = new Map();
    entries.forEach(function (e) {
      if (!exact.has(e.name)) exact.set(e.name, e.c);
      e.aliases.forEach(function (a) {
        if (!exact.has(a)) exact.set(a, e.c);
      });
    });

    // Exact name/alias hit, or null.
    function resolve(query) {
      return exact.get(normalize(query)) || null;
    }

    // Ranked matches for the autocomplete: name-prefix > alias-prefix >
    // name-substring > alias-substring.
    function search(query, limit) {
      var q = normalize(query);
      if (!q) return [];
      var scored = [];
      entries.forEach(function (e) {
        var score = -1;
        if (e.name === q) score = 0;
        else if (e.name.indexOf(q) === 0) score = 1;
        else if (
          e.aliases.some(function (a) {
            return a === q;
          })
        )
          score = 2;
        else if (
          e.aliases.some(function (a) {
            return a.indexOf(q) === 0;
          })
        )
          score = 3;
        else if (e.name.indexOf(q) > 0) score = 4;
        else if (
          e.aliases.some(function (a) {
            return a.indexOf(q) > 0;
          })
        )
          score = 5;
        if (score >= 0) scored.push({ c: e.c, score: score, name: e.name });
      });
      scored.sort(function (a, b) {
        return a.score - b.score || a.name.localeCompare(b.name);
      });
      return scored.slice(0, limit || 8).map(function (s) {
        return s.c;
      });
    }

    return { resolve: resolve, search: search };
  }

  /* ---------- game state ---------- */

  function createGame(answer, opts) {
    opts = opts || {};
    return {
      answer: answer.c,
      mode: opts.mode || 'daily',
      dateKey: opts.dateKey || null,
      maxGuesses: opts.maxGuesses || MAX_GUESSES,
      guesses: [],
      status: 'playing', // 'playing' | 'won' | 'lost'
      startedAt: opts.now || 0,
      endedAt: null,
    };
  }

  // Returns { state, result } — never mutates the state you pass in.
  function applyGuess(state, guessCountry, answerCountry, now) {
    if (state.status !== 'playing') return { state: state, result: null, error: 'finished' };
    if (
      state.guesses.some(function (g) {
        return g.c === guessCountry.c;
      })
    )
      return { state: state, result: null, error: 'duplicate' };

    var correct = guessCountry.c === answerCountry.c;
    var km = correct ? 0 : distance(guessCountry, answerCountry);
    var brg = correct ? 0 : bearing(guessCountry, answerCountry);
    var result = {
      c: guessCountry.c,
      name: guessCountry.n,
      emoji: guessCountry.e,
      correct: correct,
      km: km,
      distance: formatDistance(km),
      bearing: brg,
      arrow: correct ? '🎯' : arrowFor(brg),
      direction: correct ? 'here' : directionLabel(brg),
      proximity: correct ? 100 : proximity(km),
    };

    var next = {
      answer: state.answer,
      mode: state.mode,
      dateKey: state.dateKey,
      maxGuesses: state.maxGuesses,
      guesses: state.guesses.concat([result]),
      status: state.status,
      startedAt: state.startedAt,
      endedAt: state.endedAt,
    };
    if (correct) {
      next.status = 'won';
      next.endedAt = now || 0;
    } else if (next.guesses.length >= next.maxGuesses) {
      next.status = 'lost';
      next.endedAt = now || 0;
    }
    return { state: next, result: result, error: null };
  }

  /* ---------- giving up ---------- */

  // Ends a board without a win. Works for both game types: the colour game has
  // no guess cap, so this is the only way out of one you can't crack.
  function giveUp(state, now) {
    if (state.status !== 'playing') return state;
    var next = {};
    Object.keys(state).forEach(function (k) {
      next[k] = state[k];
    });
    next.status = 'lost';
    next.gaveUp = true;
    next.endedAt = now || 0;
    return next;
  }

  /* ---------- share text ---------- */

  // Worldle-style five-square proximity bar.
  function proximityBar(pct) {
    var filled = Math.floor(pct / 20);
    var remainder = pct - filled * 20;
    var bar = '';
    for (var i = 0; i < 5; i++) {
      if (i < filled) bar += '🟩';
      else if (i === filled && remainder >= 10) bar += '🟨';
      else bar += '⬜';
    }
    return bar;
  }

  function shareText(state, opts) {
    opts = opts || {};
    var head =
      '☕ Flaggle Lofi ' +
      (state.mode === 'daily' ? '#' + (opts.puzzleNumber || 0) : 'Practice') +
      ' ' +
      (state.status === 'won' ? state.guesses.length + '/' + state.maxGuesses : 'X/' + state.maxGuesses);
    var rows = state.guesses.map(function (g) {
      return proximityBar(g.proximity) + ' ' + (g.correct ? '🎉' : g.arrow);
    });
    var tail = opts.streak ? '🔥 streak ' + opts.streak : '';
    return [head].concat(rows, tail ? [tail] : []).join('\n');
  }

  /* ---------- colour-match mode (the original flaggle game) --------------
     You never see the answer. You guess a flag, and every cell of your guess
     that happens to be the same colour as the answer lights up green. No
     distance, no direction, no continent — deliberately. */

  // Returns a mask string, '1' where the guess and answer agree.
  function compareGrids(guessGrid, answerGrid) {
    if (!guessGrid || !answerGrid || guessGrid.length !== answerGrid.length) return null;
    var mask = '';
    var hits = 0;
    for (var i = 0; i < guessGrid.length; i++) {
      var same = guessGrid[i] === answerGrid[i];
      mask += same ? '1' : '0';
      if (same) hits++;
    }
    return {
      mask: mask,
      matches: hits,
      cells: guessGrid.length,
      pct: Math.round((hits / guessGrid.length) * 100),
    };
  }

  // Unlimited tries: the whole point is "in as few as possible".
  function createColourGame(answer, opts) {
    opts = opts || {};
    return {
      answer: answer.c,
      mode: opts.mode || 'palette',
      dateKey: opts.dateKey || null,
      maxGuesses: 0, // 0 means no cap
      guesses: [],
      status: 'playing',
      startedAt: opts.now || 0,
      endedAt: null,
    };
  }

  // `pixels` maps country code -> grid string.
  function applyColourGuess(state, guessCountry, answerCountry, pixels, now) {
    if (state.status !== 'playing') return { state: state, result: null, error: 'finished' };
    if (
      state.guesses.some(function (g) {
        return g.c === guessCountry.c;
      })
    )
      return { state: state, result: null, error: 'duplicate' };

    var cmp = compareGrids(pixels[guessCountry.c], pixels[answerCountry.c]);
    if (!cmp) return { state: state, result: null, error: 'no-pixels' };

    var correct = guessCountry.c === answerCountry.c;
    var result = {
      c: guessCountry.c,
      name: guessCountry.n,
      emoji: guessCountry.e,
      correct: correct,
      mask: cmp.mask,
      matches: cmp.matches,
      cells: cmp.cells,
      pct: correct ? 100 : cmp.pct,
    };

    var next = {
      answer: state.answer,
      mode: state.mode,
      dateKey: state.dateKey,
      maxGuesses: state.maxGuesses,
      guesses: state.guesses.concat([result]),
      status: correct ? 'won' : 'playing',
      startedAt: state.startedAt,
      endedAt: correct ? now || 0 : null,
    };
    return { state: next, result: result, error: null };
  }

  // A mask is one character per cell, so a long game's worth of them dwarfs
  // everything else in storage. They're pure functions of (guess, answer), so
  // drop them on the way out and rebuild them on the way in.
  function slimColourGame(state) {
    var out = {};
    Object.keys(state).forEach(function (k) {
      out[k] = state[k];
    });
    out.guesses = state.guesses.map(function (g) {
      var copy = {};
      Object.keys(g).forEach(function (k) {
        if (k !== 'mask') copy[k] = g[k];
      });
      return copy;
    });
    return out;
  }

  function rehydrateColourGame(state, answerCountry, pixels) {
    if (!state || !state.guesses) return state;
    var answerGrid = pixels[answerCountry.c];
    var out = slimColourGame(state);
    out.guesses = out.guesses.map(function (g) {
      if (g.mask) return g;
      var cmp = compareGrids(pixels[g.c], answerGrid);
      if (!cmp) return g;
      var copy = {};
      Object.keys(g).forEach(function (k) {
        copy[k] = g[k];
      });
      copy.mask = cmp.mask;
      copy.matches = cmp.matches;
      copy.cells = cmp.cells;
      copy.pct = g.correct ? 100 : cmp.pct;
      return copy;
    });
    return out;
  }

  // The best match reached so far — what the "warmest" readout shows.
  function bestMatch(state) {
    return state.guesses.reduce(function (best, g) {
      return g.pct > best ? g.pct : best;
    }, 0);
  }

  function colourShareText(state, opts) {
    opts = opts || {};
    var tries = state.guesses.length;
    var head =
      '🎨 Flaggle Lofi Colours ' +
      (state.mode === 'palette' ? '#' + (opts.puzzleNumber || 0) + ' ' : '') +
      (state.status === 'won' ? tries + (tries === 1 ? ' try' : ' tries') : 'unsolved');
    // Coarse bars only: the real masks would give the answer away.
    var rows = state.guesses.slice(-8).map(function (g) {
      return proximityBar(g.pct) + ' ' + (g.correct ? '🎯' : g.pct + '%');
    });
    var tail = opts.streak ? '🔥 streak ' + opts.streak : '';
    return [head].concat(rows, tail ? [tail] : []).join('\n');
  }

  window.Engine = {
    MAX_GUESSES: MAX_GUESSES,
    PALETTE_SALT: PALETTE_SALT,
    MAX_DIST: MAX_DIST,
    normalize: normalize,
    distance: distance,
    bearing: bearing,
    arrowFor: arrowFor,
    directionLabel: directionLabel,
    proximity: proximity,
    formatDistance: formatDistance,
    mulberry32: mulberry32,
    shuffled: shuffled,
    dateKey: dateKey,
    dayNumber: dayNumber,
    dailyCountry: dailyCountry,
    paletteCountry: paletteCountry,
    puzzleNumber: puzzleNumber,
    compareGrids: compareGrids,
    createColourGame: createColourGame,
    applyColourGuess: applyColourGuess,
    slimColourGame: slimColourGame,
    rehydrateColourGame: rehydrateColourGame,
    bestMatch: bestMatch,
    colourShareText: colourShareText,
    createSearch: createSearch,
    createGame: createGame,
    applyGuess: applyGuess,
    giveUp: giveUp,
    proximityBar: proximityBar,
    shareText: shareText,
  };
})(typeof window !== 'undefined' ? window : globalThis);
