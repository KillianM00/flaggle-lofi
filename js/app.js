/* ==========================================================================
   app.js — wiring: views, boards, stats, leaderboard, ambience.

   Two game types share one board widget:
     geo    — you see the flag, misses give distance + direction (flaggle-ish daily)
     colour — the flag is hidden; a guess lights up green wherever your flag
              shares a colour with the answer. No geography, unlimited tries.
   ========================================================================== */
(function (window, document) {
  'use strict';

  var E = window.Engine;
  var P = window.Palette;
  var PIXELS = window.FLAG_PIXELS;
  var COUNTRIES = window.COUNTRIES;
  var BY_CODE = {};
  COUNTRIES.forEach(function (c) {
    BY_CODE[c.c] = c;
  });
  var SEARCH = E.createSearch(COUNTRIES);
  var store = window.Store.create(window.localStorage);

  var REGIONS = ['Africa', 'Asia', 'Europe', 'North America', 'South America', 'Oceania'];
  var REGION_EMOJI = {
    all: '🌍',
    Africa: '🦒',
    Asia: '🏯',
    Europe: '🏰',
    'North America': '🌵',
    'South America': '🦜',
    Oceania: '🐠',
  };
  var AVATARS = ['☕', '🫖', '🧋', '🍵', '🥐', '🍂', '🌙', '🎧', '📻', '🐈', '🦉', '🌱', '🫘', '🍄', '⭐', '🧸'];
  var QUOTES = [
    'no ads, no accounts, no rush.',
    'the kettle is always on.',
    'a flag a day keeps the atlas away.',
    'take the long way round.',
    'somewhere it is raining right now.',
    'best served with a second cup.',
  ];
  var VIEWS = ['daily', 'colours', 'practice', 'stats', 'board'];

  var $ = function (id) {
    return document.getElementById(id);
  };
  var el = function (tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };
  var flagSrc = function (code) {
    return 'flags/' + code + '.svg';
  };

  /* ---------------------------------------------------------------- toast */

  var toastTimer = null;
  function toast(msg) {
    var t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      t.classList.remove('show');
    }, 2200);
  }

  /* ------------------------------------------------------- grid rendering */

  function hexToRgb(hex) {
    return [
      parseInt(hex.slice(1, 3), 16),
      parseInt(hex.slice(3, 5), 16),
      parseInt(hex.slice(5, 7), 16),
    ];
  }

  function missColour() {
    return document.documentElement.getAttribute('data-theme') === 'midnight'
      ? P.MISS_COLOR_DARK
      : P.MISS_COLOR;
  }

  // The similarity flag: green where your guess shares the answer's colour,
  // flat dark everywhere else. Your own flag is shown beside it, so the result
  // reads as a silhouette of what you got right.
  function paintMask(canvas, mask) {
    if (!mask) return;
    var w = P.GRID_W;
    var h = P.GRID_H;
    canvas.width = w;
    canvas.height = h;
    var ctx = canvas.getContext('2d');
    var image = ctx.createImageData(w, h);
    var data = image.data;
    var hit = hexToRgb(P.MATCH_COLOR);
    var miss = hexToRgb(missColour());
    for (var i = 0; i < mask.length; i++) {
      var c = mask.charCodeAt(i) === 49 ? hit : miss; // '1'
      var p = i * 4;
      data[p] = c[0];
      data[p + 1] = c[1];
      data[p + 2] = c[2];
      data[p + 3] = 255;
    }
    ctx.putImageData(image, 0, 0);
  }

  /* --------------------------------------------------------- autocomplete */

  function createPicker(inputId, listId, onPick) {
    var input = $(inputId);
    var list = $(listId);
    var items = [];
    var active = -1;

    function close() {
      list.hidden = true;
      list.innerHTML = '';
      items = [];
      active = -1;
    }

    function render() {
      list.innerHTML = '';
      items.forEach(function (c, i) {
        var b = el('button', 'suggestion' + (i === active ? ' active' : ''));
        b.type = 'button';
        // No flag thumbnail and no continent here on purpose — the dropdown
        // must never show you what you are trying to work out.
        b.appendChild(el('span', 'sname', c.n));
        b.appendChild(el('span', 'skey', i === active ? '↵' : ''));
        b.addEventListener('mousedown', function (ev) {
          ev.preventDefault();
          choose(c);
        });
        list.appendChild(b);
      });
      list.hidden = items.length === 0;
    }

    function refresh() {
      items = SEARCH.search(input.value, 7);
      active = items.length ? 0 : -1;
      render();
    }

    function choose(c) {
      input.value = '';
      close();
      onPick(c);
    }

    function submit() {
      if (active >= 0 && items[active]) return choose(items[active]);
      var exact = SEARCH.resolve(input.value);
      if (exact) return choose(exact);
      if (items.length) return choose(items[0]);
      if (input.value.trim()) {
        toast('🤔 never heard of it');
        input.classList.add('shake');
        setTimeout(function () {
          input.classList.remove('shake');
        }, 400);
      }
    }

    input.addEventListener('input', refresh);

    input.addEventListener('keydown', function (ev) {
      if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
        ev.preventDefault();
        if (!items.length) return;
        active = (active + (ev.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length;
        render();
      } else if (ev.key === 'Tab' && items.length && !ev.shiftKey) {
        // Complete the highlighted country in place — don't submit, don't
        // let focus jump away.
        ev.preventDefault();
        input.value = items[active >= 0 ? active : 0].n;
        refresh();
      } else if (ev.key === 'Enter') {
        ev.preventDefault();
        submit();
      } else if (ev.key === 'Escape') {
        close();
      }
    });

    input.addEventListener('blur', function () {
      setTimeout(close, 120);
    });

    return { input: input, submit: submit, close: close, refresh: refresh };
  }

  /* ----------------------------------------------------------- board view */

  function createBoard(cfg) {
    var board = {
      mode: cfg.mode,
      kind: cfg.kind, // 'geo' | 'colour'
      game: null,
      answer: null,
      picker: null,
      lastPoints: 0,
      lastStreak: 0,
    };

    var has = function (id) {
      return cfg[id] ? $(cfg[id]) : null;
    };

    function applyBlur() {
      var img = $(cfg.flagId);
      if (!board.game || board.kind !== 'geo') return;
      var steamy = store.settings().hardMode;
      var over = board.game.status !== 'playing';
      if (!steamy || over) {
        img.style.filter = 'none';
        return;
      }
      var left = board.game.maxGuesses - board.game.guesses.length;
      img.style.filter = 'blur(' + (left * 2.6).toFixed(1) + 'px)';
    }

    function renderStage() {
      var single = has('singleId');
      var pair = has('pairId');

      if (board.kind === 'geo') {
        if (pair) pair.hidden = true;
        if (single) single.hidden = false;
        var img = $(cfg.flagId);
        var src = flagSrc(board.answer.c);
        if (img.getAttribute('src') !== src) img.setAttribute('src', src);
        img.alt = board.game.status === 'playing' ? 'mystery flag' : 'flag of ' + board.answer.n;
        applyBlur();
        return;
      }

      // Colour mode: the answer is never drawn. You see your own flag on the
      // left and what it shares with the answer on the right — and because the
      // winning guess IS the answer, the reveal falls out for free.
      if (single) single.hidden = true;
      if (pair) pair.hidden = false;

      var guessImg = $(cfg.guessFlagId);
      var canvas = $(cfg.canvasId);
      var guessVeil = has('guessVeilId');
      var resultVeil = has('resultVeilId');
      var guessCap = has('guessCapId');
      var resultCap = has('resultCapId');
      var last = board.game.guesses[board.game.guesses.length - 1];

      // Giving up is the only time the answer gets drawn without being guessed.
      if (board.game.gaveUp) {
        if (guessVeil) guessVeil.hidden = true;
        guessImg.hidden = false;
        guessImg.style.filter = 'none';
        guessImg.setAttribute('src', flagSrc(board.answer.c));
        guessImg.alt = 'flag of ' + board.answer.n;
        if (guessCap) guessCap.textContent = '🏳️ ' + board.answer.n;
        if (last) {
          if (resultVeil) resultVeil.hidden = true;
          canvas.hidden = false;
          paintMask(canvas, last.mask);
          if (resultCap) resultCap.textContent = 'best you got: ' + E.bestMatch(board.game) + '%';
        } else {
          canvas.hidden = true;
          if (resultVeil) resultVeil.hidden = false;
          if (resultCap) resultCap.textContent = 'no guesses made';
        }
        return;
      }

      if (!last) {
        guessImg.hidden = true;
        guessImg.removeAttribute('src');
        canvas.hidden = true;
        if (guessVeil) guessVeil.hidden = false;
        if (resultVeil) resultVeil.hidden = false;
        if (guessCap) guessCap.textContent = 'your guess';
        if (resultCap) resultCap.textContent = 'your result';
        return;
      }

      var won = board.game.status === 'won';
      if (guessVeil) guessVeil.hidden = true;
      if (resultVeil) resultVeil.hidden = true;
      guessImg.hidden = false;
      guessImg.style.filter = 'none';
      var gsrc = flagSrc(last.c);
      if (guessImg.getAttribute('src') !== gsrc) guessImg.setAttribute('src', gsrc);
      guessImg.alt = 'flag of ' + last.name;
      canvas.hidden = false;
      paintMask(canvas, last.mask);
      if (guessCap) guessCap.textContent = (won ? '🎉 ' : '') + last.name;
      if (resultCap)
        resultCap.textContent = won ? 'every cell matched' : last.pct + '% shared';
    }

    function renderCounters() {
      var dots = has('dotsId');
      var tries = has('triesId');

      if (board.kind === 'geo') {
        if (tries) tries.hidden = true;
        if (!dots) return;
        dots.hidden = false;
        dots.innerHTML = '';
        for (var i = 0; i < board.game.maxGuesses; i++) {
          var d = el('span', 'dot-pip');
          var g = board.game.guesses[i];
          if (g) d.className = 'dot-pip ' + (g.correct ? 'won' : 'used');
          dots.appendChild(d);
        }
        return;
      }

      if (dots) dots.hidden = true;
      if (!tries) return;
      tries.hidden = false;
      tries.innerHTML = '';
      var n = board.game.guesses.length;
      var count = el('span', null, '');
      count.innerHTML = 'tries <b>' + n + '</b>';
      tries.appendChild(count);
      if (n) {
        var last = board.game.guesses[n - 1];
        // Say whose flag is on the stage — otherwise the grid is a riddle. Once
        // the round is over the stage shows the answer, so the label would lie.
        if (board.game.status === 'playing') {
          tries.appendChild(el('span', 'faint', 'showing ' + last.name + ' · ' + last.pct + '%'));
        }
        var warm = el('span', 'warmth', '');
        warm.textContent = '🔥 warmest ' + E.bestMatch(board.game) + '%';
        tries.appendChild(warm);
      } else {
        tries.appendChild(el('span', 'faint', 'as few as you can'));
      }
    }

    function renderGuesses() {
      var host = $(cfg.guessesId);
      host.innerHTML = '';
      // Six geo guesses read best in play order; a colour game can run to
      // thirty, so the newest goes on top.
      var rows =
        board.kind === 'colour' ? board.game.guesses.slice().reverse() : board.game.guesses;
      rows.forEach(function (g) {
        var li = el('li', 'guess' + (g.correct ? ' hit' : ''));

        if (board.kind === 'colour') {
          li.className = 'guess colour-row' + (g.correct ? ' hit' : '');
          li.appendChild(el('span', 'gname', g.name));

          var mini = el('span', 'pair-mini');
          var flag = el('img', 'mini-flag');
          flag.src = flagSrc(g.c);
          flag.alt = '';
          flag.title = g.name;
          mini.appendChild(flag);
          var canvas = document.createElement('canvas');
          canvas.className = 'mini-mask';
          canvas.title = g.matches + ' of ' + g.cells + ' cells shared';
          paintMask(canvas, g.mask);
          mini.appendChild(canvas);
          li.appendChild(mini);

          li.appendChild(el('span', 'gprox', g.correct ? '🎯' : g.pct + '%'));
          host.appendChild(li);
          return;
        }

        var img = el('img');
        img.src = flagSrc(g.c);
        img.alt = '';
        li.appendChild(img);
        li.appendChild(el('span', 'gname', g.name));
        if (g.correct) {
          li.appendChild(el('span', 'gdist', 'that’s the one'));
        } else {
          li.appendChild(el('span', 'gdist', g.distance));
          var gbar = el('span', 'prox-bar');
          var gfill = el('i');
          gfill.style.width = g.proximity + '%';
          gbar.appendChild(gfill);
          li.appendChild(gbar);
        }
        li.appendChild(el('span', 'garrow', g.arrow));
        li.appendChild(el('span', 'gprox', g.proximity + '%'));
        host.appendChild(li);
      });
    }

    function shareTextFor() {
      var p = store.active();
      if (board.kind === 'colour') {
        return E.colourShareText(board.game, {
          puzzleNumber: E.puzzleNumber(paletteKey),
          streak: p ? p.palette.currentStreak : 0,
        });
      }
      return E.shareText(board.game, {
        puzzleNumber: E.puzzleNumber(dailyKey),
        streak: p ? p.currentStreak : 0,
      });
    }

    function renderResult() {
      var host = $(cfg.resultId);
      if (board.game.status === 'playing') {
        host.hidden = true;
        host.innerHTML = '';
        return;
      }
      var won = board.game.status === 'won';
      var a = board.answer;
      var tries = board.game.guesses.length;
      host.innerHTML = '';
      host.hidden = false;

      var heads = won
        ? board.kind === 'colour'
          ? ['found it 🎨', 'nailed the palette ✨', 'good eye 👁️', 'colour theory 🧠']
          : ['nice one ☕', 'smooth 🎧', 'you knew it 🌙', 'perfect pour ✨']
        : board.game.gaveUp
          ? ['no shame in it 🏳️', 'that one was mean 🍂', 'we all fold sometimes 🌧️']
          : ['next time 🫠', 'so close-ish 🍂', 'one got away 🌧️'];
      host.appendChild(el('h3', null, heads[tries % heads.length]));

      var ans = el('p', 'answer');
      ans.innerHTML =
        (a.e || '🏳️') +
        ' <strong>' +
        a.n +
        '</strong>' +
        (a.cap ? ' · <span class="muted">' + a.cap + '</span>' : '');
      host.appendChild(ans);

      if (board.kind === 'colour' && won) {
        host.appendChild(
          el('p', 'muted', 'in ' + tries + (tries === 1 ? ' try' : ' tries'))
        );
      }

      if (board.lastPoints) {
        var pts = el('p', 'muted');
        pts.innerHTML =
          '<span class="points-pop">+' + board.lastPoints + '</span> points' +
          (board.lastStreak ? ' · 🔥 ' + board.lastStreak + ' day streak' : '');
        host.appendChild(pts);
      }

      var actions = el('div', 'result-actions');
      var share = el('button', 'btn', '📋 copy result');
      share.addEventListener('click', function () {
        copy(shareTextFor());
      });
      actions.appendChild(share);

      if (cfg.startRound) {
        var next = el('button', 'btn primary', '🎲 next flag');
        next.title = 'or press `';
        next.addEventListener('click', function () {
          cfg.startRound();
        });
        actions.appendChild(next);
        host.appendChild(actions);
      } else {
        var timer = el('span', 'chip small', '');
        actions.appendChild(timer);
        // Append first: the countdown stops itself once its node leaves the DOM.
        host.appendChild(actions);
        tickCountdown(timer);
      }
    }

    function render() {
      renderStage();
      renderCounters();
      renderGuesses();
      renderResult();

      var over = board.game.status !== 'playing';
      var giveUpBtn = has('giveUpId');
      if (giveUpBtn) {
        giveUpBtn.hidden = over;
        disarmGiveUp();
      }
      board.picker.input.disabled = over;
      $(cfg.goId).disabled = over;
      board.picker.input.placeholder = over
        ? cfg.startRound
          ? 'press ` for another 🎲'
          : 'come back tomorrow ☕'
        : board.kind === 'colour'
          ? 'guess any flag 🎨'
          : 'which country? ☕';
    }

    function guess(country) {
      if (!board.game || board.game.status !== 'playing') return;
      var res =
        board.kind === 'colour'
          ? E.applyColourGuess(board.game, country, board.answer, PIXELS, Date.now())
          : E.applyGuess(board.game, country, board.answer, Date.now());

      if (res.error === 'duplicate') {
        toast('🔁 already guessed ' + country.n);
        return;
      }
      if (res.error === 'no-pixels') {
        toast('🫠 no colour data for that flag');
        return;
      }
      if (res.error) return;
      board.game = res.state;

      var warmth = board.kind === 'colour' ? res.result.pct : res.result.proximity;
      if (res.result.correct) window.LofiAudio.sfx('win');
      else if (warmth >= (board.kind === 'colour' ? 70 : 88)) window.LofiAudio.sfx('near');
      else window.LofiAudio.sfx('miss');

      board.lastPoints = 0;
      board.lastStreak = 0;
      if (board.game.status !== 'playing') {
        var rec = store.recordResult({
          mode: board.mode,
          dateKey: board.game.dateKey,
          answer: board.answer.c,
          status: board.game.status,
          guesses: board.game.guesses.length,
        });
        board.lastPoints = rec.points;
        board.lastStreak = cfg.startRound ? 0 : rec.streak;
        if (cfg.onFinish) cfg.onFinish(board);
      }
      if (cfg.persist) cfg.persist(board.game);
      render();
    }

    var armed = false;
    var armTimer = null;

    function disarmGiveUp() {
      var btn = has('giveUpId');
      armed = false;
      clearTimeout(armTimer);
      if (btn) {
        btn.textContent = '🏳️ give up';
        btn.classList.remove('armed');
      }
    }

    // Two taps, not a modal: one arms it, the second within a few seconds does
    // it. Losing a streak to a stray click would be miserable.
    function onGiveUp() {
      if (!board.game || board.game.status !== 'playing') return;
      var btn = has('giveUpId');
      if (!armed) {
        armed = true;
        if (btn) {
          btn.textContent = '🏳️ really give up?';
          btn.classList.add('armed');
        }
        clearTimeout(armTimer);
        armTimer = setTimeout(disarmGiveUp, 4000);
        return;
      }
      disarmGiveUp();

      board.game = E.giveUp(board.game, Date.now());
      board.lastPoints = 0;
      board.lastStreak = 0;
      window.LofiAudio.sfx('miss');

      // A forfeited geo board counts as having used every guess, so it doesn't
      // flatter your average; a colour board counts the tries actually spent.
      var used =
        board.kind === 'geo' && board.game.maxGuesses
          ? board.game.maxGuesses
          : board.game.guesses.length;
      var rec = store.recordResult({
        mode: board.mode,
        dateKey: board.game.dateKey,
        answer: board.answer.c,
        status: 'lost',
        guesses: used,
      });
      board.lastStreak = 0;
      void rec;
      if (cfg.onFinish) cfg.onFinish(board);
      if (cfg.persist) cfg.persist(board.game);
      render();
      toast('🏳️ it was ' + board.answer.n);
    }

    board.giveUp = onGiveUp;

    board.start = function (answer, game, kind, mode) {
      if (kind) board.kind = kind;
      if (mode) board.mode = mode;
      board.answer = answer;
      board.game = game;
      board.lastPoints = 0;
      board.lastStreak = 0;
      render();
      board.picker.input.value = '';
      board.picker.close();
    };
    board.render = render;
    board.picker = createPicker(cfg.inputId, cfg.suggestionsId, guess);
    $(cfg.goId).addEventListener('click', function () {
      board.picker.submit();
    });
    if (cfg.giveUpId) $(cfg.giveUpId).addEventListener('click', onGiveUp);
    return board;
  }

  /* ------------------------------------------------------------ clipboard */

  function copy(text) {
    var done = function () {
      toast('📋 copied — go on, brag');
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () {
        legacyCopy(text, done);
      });
    } else {
      legacyCopy(text, done);
    }
  }

  function legacyCopy(text, done) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
      done();
    } catch (e) {
      toast('copy failed — here it is:\n' + text);
    }
    document.body.removeChild(ta);
  }

  // Each finished board gets its own ticker — the daily and the colour puzzle
  // can both be done at once, and one must not stop the other's clock. Each
  // stops itself when its node is re-rendered out of the document.
  function tickCountdown(node) {
    var timer = null;
    function upd() {
      if (!node.isConnected) {
        clearInterval(timer);
        return;
      }
      var now = new Date();
      var next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
      var ms = next - now;
      var h = Math.floor(ms / 3600000);
      var m = Math.floor((ms % 3600000) / 60000);
      var s = Math.floor((ms % 60000) / 1000);
      node.textContent =
        '⏳ next flag in ' + h + 'h ' + String(m).padStart(2, '0') + 'm ' + String(s).padStart(2, '0') + 's';
    }
    upd();
    timer = setInterval(upd, 1000);
  }

  /* --------------------------------------------------------------- daily */

  var dailyKey = E.dateKey();
  var paletteKey = dailyKey;
  var dailyAnswer = E.dailyCountry(COUNTRIES, dailyKey);
  var paletteAnswer = E.paletteCountry(COUNTRIES, paletteKey);

  var daily = createBoard({
    mode: 'daily',
    kind: 'geo',
    flagId: 'daily-flag',
    dotsId: 'daily-dots',
    guessesId: 'daily-guesses',
    resultId: 'daily-result',
    inputId: 'daily-input',
    suggestionsId: 'daily-suggestions',
    goId: 'daily-go',
    giveUpId: 'daily-giveup',
    persist: function (game) {
      store.saveDaily(dailyKey, game, 'daily');
    },
    onFinish: function () {
      renderStats();
      renderLeaderboard();
    },
  });

  var colours = createBoard({
    mode: 'palette',
    kind: 'colour',
    pairId: 'colours-pair',
    guessFlagId: 'colours-guess-flag',
    canvasId: 'colours-canvas',
    guessVeilId: 'colours-guess-veil',
    resultVeilId: 'colours-result-veil',
    guessCapId: 'colours-guess-cap',
    resultCapId: 'colours-result-cap',
    triesId: 'colours-tries',
    guessesId: 'colours-guesses',
    resultId: 'colours-result',
    inputId: 'colours-input',
    suggestionsId: 'colours-suggestions',
    goId: 'colours-go',
    giveUpId: 'colours-giveup',
    persist: function (game) {
      // Masks are 9600 cells each; keeping thirty of them would blow the
      // localStorage quota. They're recomputed on load instead.
      store.saveDaily(paletteKey, E.slimColourGame(game), 'palette');
    },
    onFinish: function () {
      renderStats();
      renderLeaderboard();
    },
  });

  function loadDaily() {
    dailyKey = E.dateKey();
    dailyAnswer = E.dailyCountry(COUNTRIES, dailyKey);
    var saved = store.loadDaily(dailyKey, 'daily');
    var game =
      saved && saved.answer === dailyAnswer.c
        ? saved
        : E.createGame(dailyAnswer, { mode: 'daily', dateKey: dailyKey });
    daily.start(dailyAnswer, game, 'geo', 'daily');
    $('daily-sub').textContent = '#' + E.puzzleNumber(dailyKey) + ' · ' + prettyDate(dailyKey);
  }

  function loadColours() {
    paletteKey = E.dateKey();
    paletteAnswer = E.paletteCountry(COUNTRIES, paletteKey);
    var saved = store.loadDaily(paletteKey, 'palette');
    var game =
      saved && saved.answer === paletteAnswer.c
        ? E.rehydrateColourGame(saved, paletteAnswer, PIXELS)
        : E.createColourGame(paletteAnswer, { mode: 'palette', dateKey: paletteKey });
    colours.start(paletteAnswer, game, 'colour', 'palette');
    $('colours-sub').textContent = '#' + E.puzzleNumber(paletteKey) + ' · ' + prettyDate(paletteKey);
  }

  function prettyDate(key) {
    var p = key.split('-').map(Number);
    var d = new Date(p[0], p[1] - 1, p[2]);
    return d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
  }

  function renderLegend() {
    var host = $('colours-legend');
    host.innerHTML = '';
    P.COLORS.forEach(function (c) {
      var s = el('div', 'swatch');
      var box = el('i');
      box.style.background = c.hex;
      s.appendChild(box);
      s.appendChild(el('span', null, c.name));
      host.appendChild(s);
    });
    var m = el('div', 'swatch match');
    var mbox = el('i');
    mbox.style.background = P.MATCH_COLOR;
    m.appendChild(mbox);
    m.appendChild(el('span', null, 'you got it right'));
    host.appendChild(m);
  }

  /* ------------------------------------------------------------ practice */

  var practiceRegion = 'all';
  var practiceSmart = false;
  var practiceStyle = 'geo'; // 'geo' | 'colour'
  var lastPracticeCode = null;

  var practice = createBoard({
    mode: 'practice',
    kind: 'geo',
    flagId: 'practice-flag',
    singleId: 'practice-single',
    pairId: 'practice-pair',
    guessFlagId: 'practice-guess-flag',
    canvasId: 'practice-canvas',
    guessVeilId: 'practice-guess-veil',
    resultVeilId: 'practice-result-veil',
    guessCapId: 'practice-guess-cap',
    resultCapId: 'practice-result-cap',
    dotsId: 'practice-dots',
    triesId: 'practice-tries',
    guessesId: 'practice-guesses',
    resultId: 'practice-result',
    inputId: 'practice-input',
    suggestionsId: 'practice-suggestions',
    goId: 'practice-go',
    giveUpId: 'practice-giveup',
    startRound: function () {
      startPractice();
    },
    onFinish: function () {
      renderStats();
      renderLeaderboard();
      renderPracticeStats();
    },
  });

  function practicePool() {
    return practiceRegion === 'all'
      ? COUNTRIES
      : COUNTRIES.filter(function (c) {
          return c.r === practiceRegion;
        });
  }

  // Weak-spot mode leans on the flags this profile keeps getting wrong.
  function pickPractice() {
    var full = practicePool();
    var pool = full.length > 1
      ? full.filter(function (c) {
          return c.c !== lastPracticeCode;
        })
      : full;
    var p = store.active();
    var flags = (p && p.flags) || {};
    var weights = pool.map(function (c) {
      if (!practiceSmart) return 1;
      var rec = flags[c.c];
      if (!rec || !rec.seen) return 1.6; // never seen: worth a look
      var missRate = (rec.seen - rec.solved) / rec.seen;
      return 0.35 + missRate * 4;
    });
    var total = weights.reduce(function (a, b) {
      return a + b;
    }, 0);
    var r = Math.random() * total;
    for (var i = 0; i < pool.length; i++) {
      r -= weights[i];
      if (r <= 0) return pool[i];
    }
    return pool[pool.length - 1];
  }

  function startPractice() {
    var answer = pickPractice();
    lastPracticeCode = answer.c;
    if (practiceStyle === 'colour') {
      practice.start(answer, E.createColourGame(answer, { mode: 'palette-practice' }), 'colour', 'palette-practice');
    } else {
      practice.start(answer, E.createGame(answer, { mode: 'practice' }), 'geo', 'practice');
    }
    practice.picker.input.focus();
  }

  function renderPracticeFilters() {
    var host = $('practice-filters');
    host.innerHTML = '';
    ['all'].concat(REGIONS).forEach(function (r) {
      var b = el(
        'button',
        practiceRegion === r ? 'on' : '',
        REGION_EMOJI[r] + ' ' + (r === 'all' ? 'everywhere' : r.toLowerCase())
      );
      b.addEventListener('click', function () {
        practiceRegion = r;
        renderPracticeFilters();
        startPractice();
      });
      host.appendChild(b);
    });
    $('practice-pool').textContent = practicePool().length + ' flags in the pot';
  }

  function renderPracticeStyle() {
    $('btn-style-geo').classList.toggle('on', practiceStyle === 'geo');
    $('btn-style-colour').classList.toggle('on', practiceStyle === 'colour');
  }

  function setPracticeStyle(style) {
    if (practiceStyle === style) return;
    practiceStyle = style;
    store.setSetting('practiceStyle', style);
    renderPracticeStyle();
    startPractice();
    toast(style === 'colour' ? '🎨 colour matching' : '🌍 geo hints');
  }

  function renderPracticeStats() {
    var p = store.ensureProfile();
    var pr = p.practice;
    var cp = p.palette.practice;
    var host = $('practice-stats');
    host.innerHTML = '';
    [
      ['🌍', pr.played, 'geo rounds'],
      ['✅', pr.wins, 'geo solved'],
      ['⚡', pr.run, 'run'],
      ['🏅', pr.bestRun, 'best run'],
      ['🎨', cp.played, 'colour rounds'],
      ['🎯', cp.wins ? (cp.totalTries / cp.wins).toFixed(1) : '—', 'avg tries'],
    ].forEach(function (row) {
      var s = el('div', 'stat');
      s.appendChild(el('div', 'v', String(row[1])));
      s.appendChild(el('div', 'k', row[0] + ' ' + row[2]));
      host.appendChild(s);
    });
  }

  /* --------------------------------------------------------------- stats */

  function renderStats() {
    var p = store.ensureProfile();
    $('stats-who').textContent = p.emoji + ' ' + p.name;

    var grid = $('stats-grid');
    grid.innerHTML = '';
    var avg = p.wins ? (p.totalGuesses / p.played).toFixed(1) : '—';
    [
      ['🔥', p.currentStreak, 'geo streak'],
      ['🏔️', p.maxStreak, 'best geo'],
      ['🎨', p.palette.currentStreak, 'colour streak'],
      ['⛰️', p.palette.maxStreak, 'best colour'],
      ['🌅', p.played, 'dailies'],
      ['📈', p.played ? Math.round((p.wins / p.played) * 100) + '%' : '—', 'win rate'],
      ['🎲', avg, 'avg guesses'],
      ['🫘', p.points, 'points'],
    ].forEach(function (row) {
      var s = el('div', 'stat');
      s.appendChild(el('div', 'v', String(row[1])));
      s.appendChild(el('div', 'k', row[0] + ' ' + row[2]));
      grid.appendChild(s);
    });

    renderDistribution($('stats-dist'), ['1', '2', '3', '4', '5', '6', 'X'], p.distribution);
    renderDistribution(
      $('colour-dist'),
      ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10+'],
      p.palette.tries
    );

    var colourSummary = $('colour-dist-summary');
    if (p.palette.wins) {
      colourSummary.textContent =
        'best ' + p.palette.bestTries + ' · average ' +
        (p.palette.totalTries / p.palette.wins).toFixed(1) + ' tries';
    } else {
      colourSummary.textContent = 'no colour solves yet';
    }

    var ranked = store.flagStats(BY_CODE);
    renderFlagList('most-missed', ranked.mostMissed.slice(0, 8), 'bad', 'no misses yet — go get some ☕');
    renderFlagList(
      'least-missed',
      ranked.leastMissed
        .filter(function (r) {
          return r.solved > 0;
        })
        .slice(0, 8),
      'good',
      'solve a few and your best flags show up here 🌱'
    );
  }

  function renderDistribution(host, keys, counts) {
    host.innerHTML = '';
    var max = Math.max.apply(
      null,
      keys.map(function (k) {
        return counts[k] || 0;
      })
    );
    var bestKey = null;
    keys.forEach(function (k) {
      if ((counts[k] || 0) === max && max > 0 && !bestKey && k !== 'X') bestKey = k;
    });
    keys.forEach(function (k) {
      var n = counts[k] || 0;
      var row = el('div', 'dist-row' + (k === bestKey ? ' best' : ''));
      row.appendChild(el('span', 'lbl', k));
      var bar = el('span', 'bar');
      var fill = el('i');
      fill.style.width = (max ? Math.max((n / max) * 100, n ? 6 : 0) : 0) + '%';
      bar.appendChild(fill);
      row.appendChild(bar);
      row.appendChild(el('span', 'n', String(n)));
      host.appendChild(row);
    });
  }

  function renderFlagList(id, rows, tone, emptyMsg) {
    var host = $(id);
    host.innerHTML = '';
    if (!rows.length) {
      var li = el('li', 'empty', emptyMsg);
      li.style.background = 'transparent';
      li.style.border = '0';
      host.appendChild(li);
      return;
    }
    rows.forEach(function (r) {
      var li = el('li');
      var img = el('img');
      img.src = flagSrc(r.c);
      img.alt = '';
      li.appendChild(img);
      li.appendChild(el('span', 'fname', r.country.n));
      li.appendChild(
        el(
          'span',
          'fmeta',
          r.solved + '/' + r.seen + (r.avgGuesses ? ' · ' + r.avgGuesses.toFixed(1) + '🎲' : '')
        )
      );
      li.appendChild(
        el(
          'span',
          'rate-pill ' + tone,
          tone === 'bad' ? Math.round(r.missRate) + '% miss' : Math.round(100 - r.missRate) + '% hit'
        )
      );
      host.appendChild(li);
    });
  }

  /* --------------------------------------------------------- leaderboard */

  var pendingEmoji = AVATARS[0];

  function renderLeaderboard() {
    var host = $('leaderboard');
    host.innerHTML = '';
    var rows = store.leaderboard();
    var meId = store.active() ? store.active().id : null;

    if (!rows.length) {
      host.appendChild(el('li', 'empty', 'nobody has ordered yet ☕'));
      return;
    }

    rows.forEach(function (r) {
      var li = el('li', r.id === meId ? 'me' : '');
      li.appendChild(el('span', 'medal', r.medal));

      var who = el('div', 'who');
      var nm = el('div', 'nm');
      nm.appendChild(el('span', null, r.emoji + ' ' + r.name));
      if (r.id === meId) nm.appendChild(el('span', 'tag-you', 'you'));
      who.appendChild(nm);
      who.appendChild(
        el(
          'div',
          'sub',
          '🔥' + r.currentStreak + ' · 🏔️' + r.maxStreak + ' · ' + r.wins + '/' + r.played +
            ' (' + r.winRate + '%)'
        )
      );
      who.appendChild(
        el(
          'div',
          'sub',
          '🎨' + r.paletteStreak + ' · ⛰️' + r.paletteMaxStreak + ' · ' + r.paletteWins +
            ' solved' + (r.paletteAvgTries ? ' · ' + r.paletteAvgTries + ' avg' : '')
        )
      );
      li.appendChild(who);

      var pts = el('div', 'pts', String(r.points));
      pts.appendChild(el('small', null, 'POINTS'));
      li.appendChild(pts);

      if (r.id !== meId) {
        var swap = el('button', 'chip small', 'play as');
        swap.addEventListener('click', function () {
          store.setActive(r.id);
          refreshProfile();
          toast('☕ now playing as ' + r.name);
        });
        li.appendChild(swap);
      } else if (rows.length > 1) {
        var del = el('button', 'chip small', '🗑️');
        del.title = 'remove ' + r.name;
        del.addEventListener('click', function () {
          if (window.confirm('remove ' + r.name + ' and their stats?')) {
            store.deleteProfile(r.id);
            refreshProfile();
          }
        });
        li.appendChild(del);
      }
      host.appendChild(li);
    });
  }

  function renderEmojiPicker() {
    var host = $('emoji-picker');
    host.innerHTML = '';
    AVATARS.forEach(function (e) {
      var b = el('button', 'emoji-opt' + (e === pendingEmoji ? ' on' : ''), e);
      b.addEventListener('click', function () {
        pendingEmoji = e;
        renderEmojiPicker();
      });
      host.appendChild(b);
    });
  }

  function refreshProfile() {
    var p = store.ensureProfile();
    $('profile-name').textContent = p.name;
    $('btn-profile').firstChild.textContent = p.emoji + ' ';
    loadDaily();
    loadColours();
    renderStats();
    renderLeaderboard();
    renderPracticeStats();
  }

  /* ------------------------------------------------------------ settings */

  function applyTheme() {
    var midnight = store.settings().theme === 'midnight';
    document.documentElement.setAttribute('data-theme', midnight ? 'midnight' : 'latte');
    $('btn-theme').textContent = midnight ? '☀️' : '🌙';
    // The miss colour is theme-dependent, so every painted mask is now stale.
    if (colours.game) colours.render();
    if (practice.game && practice.kind === 'colour') practice.render();
  }

  function applyAudioUi() {
    var s = store.settings();
    $('btn-sound').classList.toggle('on', !!s.sound);
    $('btn-rain').classList.toggle('on', !!s.rain);
    $('eq').classList.toggle('on', !!s.sound);
    $('np-label').textContent = s.sound
      ? s.rain ? 'lofi + rain' : 'lofi beats'
      : s.rain ? 'just rain' : 'silence';
  }

  function applySteamy() {
    $('btn-steamy').classList.toggle('on', !!store.settings().hardMode);
    daily.render();
    if (practice.game) practice.render();
  }

  /* ---------------------------------------------------------------- tabs */

  function showView(name) {
    VIEWS.forEach(function (v) {
      $('view-' + v).hidden = v !== name;
    });
    Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (t) {
      t.classList.toggle('active', t.dataset.view === name);
    });
    if (name === 'stats') renderStats();
    if (name === 'board') renderLeaderboard();
    if (name === 'practice') {
      renderPracticeStats();
      if (!practice.game) startPractice();
    }
    try {
      window.history.replaceState(null, '', '#' + name);
    } catch (e) {
      /* file:// can be picky; the tab still switched */
    }
  }

  function currentView() {
    for (var i = 0; i < VIEWS.length; i++) if (!$('view-' + VIEWS[i]).hidden) return VIEWS[i];
    return 'daily';
  }

  /* ------------------------------------------------------- import/export */

  function exportSave() {
    var data = JSON.stringify(store.raw(), null, 2);
    try {
      var blob = new Blob([data], { type: 'application/json' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'flaggle-lofi-save.json';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      toast('⬇️ saved to your downloads');
    } catch (e) {
      copy(data);
    }
  }

  function importSave() {
    var input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json,.json';
    input.addEventListener('change', function () {
      var file = input.files && input.files[0];
      if (!file) return;
      var reader = new FileReader();
      reader.onload = function () {
        try {
          var parsed = JSON.parse(String(reader.result));
          window.localStorage.setItem(window.Store.KEY, JSON.stringify(window.Store.hydrate(parsed)));
          toast('⬆️ imported — reloading');
          setTimeout(function () {
            window.location.reload();
          }, 700);
        } catch (e) {
          toast('🤨 that file was not a flaggle save');
        }
      };
      reader.readAsText(file);
    });
    input.click();
  }

  /* ---------------------------------------------------------------- boot */

  function boot() {
    store.ensureProfile('you', '☕');
    practiceStyle = store.settings().practiceStyle === 'colour' ? 'colour' : 'geo';

    Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (t) {
      t.addEventListener('click', function () {
        showView(t.dataset.view);
      });
    });

    $('btn-theme').addEventListener('click', function () {
      store.setSetting('theme', store.settings().theme === 'midnight' ? 'latte' : 'midnight');
      applyTheme();
    });

    $('btn-sound').addEventListener('click', function () {
      var actual = window.LofiAudio.setMusic(!store.settings().sound);
      store.setSetting('sound', actual);
      applyAudioUi();
      if (actual) toast('🎧 beats to guess flags to');
    });

    $('btn-rain').addEventListener('click', function () {
      var actual = window.LofiAudio.setRain(!store.settings().rain);
      store.setSetting('rain', actual);
      applyAudioUi();
      if (actual) toast('🌧️ it started raining');
    });

    $('btn-steamy').addEventListener('click', function () {
      store.setSetting('hardMode', !store.settings().hardMode);
      applySteamy();
      toast(store.settings().hardMode ? '🌫️ the window fogged up' : '✨ wiped clean');
    });

    $('btn-style-geo').addEventListener('click', function () {
      setPracticeStyle('geo');
    });
    $('btn-style-colour').addEventListener('click', function () {
      setPracticeStyle('colour');
    });

    $('btn-smart').addEventListener('click', function () {
      practiceSmart = !practiceSmart;
      $('btn-smart').classList.toggle('on', practiceSmart);
      toast(practiceSmart ? '🧠 serving your weak spots' : '🎲 back to pure random');
      startPractice();
    });

    $('btn-profile').addEventListener('click', function () {
      showView('board');
    });

    $('btn-add').addEventListener('click', function () {
      var name = $('new-name').value.trim();
      if (!name) {
        toast('✍️ needs a name');
        return;
      }
      store.addProfile(name, pendingEmoji);
      $('new-name').value = '';
      refreshProfile();
      toast('🪑 pulled up a chair for ' + name);
    });

    $('new-name').addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter') $('btn-add').click();
    });

    $('btn-export').addEventListener('click', exportSave);
    $('btn-import').addEventListener('click', importSave);
    $('btn-reset').addEventListener('click', function () {
      if (window.confirm('wipe every player, streak and stat on this machine?')) {
        store.reset();
        window.location.reload();
      }
    });

    // ` deals a fresh practice round from anywhere. No country name contains a
    // backtick, so it's safe to grab even while typing a guess.
    document.addEventListener('keydown', function (ev) {
      if (ev.key !== '`' || ev.ctrlKey || ev.metaKey || ev.altKey) return;
      var tag = (ev.target.tagName || '').toLowerCase();
      if (tag === 'input' && ev.target.id === 'new-name') return;
      ev.preventDefault();
      if (currentView() !== 'practice') showView('practice');
      startPractice();
      toast('🎲 fresh flag');
    });

    // Keep the dailies honest if the tab is left open past midnight.
    setInterval(function () {
      if (E.dateKey() !== dailyKey) {
        loadDaily();
        loadColours();
        toast('🌅 a new pair of flags just landed');
      }
    }, 30000);

    $('footer-quote').textContent = QUOTES[E.dayNumber(dailyKey) % QUOTES.length];

    applyTheme();
    applyAudioUi();
    renderEmojiPicker();
    renderLegend();
    renderPracticeFilters();
    renderPracticeStyle();
    refreshProfile();
    applySteamy();

    var hash = (window.location.hash || '').replace('#', '');
    showView(VIEWS.indexOf(hash) >= 0 ? hash : 'daily');

    // Autoplay is blocked until the player interacts; pick the music back up
    // on their first click if it was on when they left.
    if (store.settings().sound || store.settings().rain) {
      var resume = function () {
        if (store.settings().sound) window.LofiAudio.setMusic(true);
        if (store.settings().rain) window.LofiAudio.setRain(true);
        applyAudioUi();
        document.removeEventListener('pointerdown', resume);
        document.removeEventListener('keydown', resume);
      };
      document.addEventListener('pointerdown', resume);
      document.addEventListener('keydown', resume);
    }

    window.FlaggleApp = {
      store: store,
      daily: daily,
      colours: colours,
      practice: practice,
      showView: showView,
      currentView: currentView,
      startPractice: startPractice,
      setPracticeStyle: setPracticeStyle,
      giveUp: function (which) {
        var b = which === 'colours' ? colours : which === 'practice' ? practice : daily;
        b.giveUp();
      },
      answerCode: function () {
        return dailyAnswer.c;
      },
      paletteAnswerCode: function () {
        return paletteAnswer.c;
      },
      practiceAnswerCode: function () {
        return practice.answer ? practice.answer.c : null;
      },
      practiceStyle: function () {
        return practiceStyle;
      },
    };
    document.body.dataset.ready = '1';
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})(window, document);
