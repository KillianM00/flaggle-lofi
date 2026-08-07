/* ==========================================================================
   audio.js — a tiny lofi house band, generated live in WebAudio.
   No files, no network: dusty pads, brushed drums, vinyl crackle, rain.
   ========================================================================== */
(function (window) {
  'use strict';

  var BPM = 72;
  var BEAT = 60 / BPM;
  var LOOKAHEAD = 0.25; // seconds of notes scheduled ahead
  var TICK = 40; // ms between scheduler runs

  // Four bars of sleepy jazz: Dm9 → G13 → Cmaj9 → Am11.
  var PROGRESSION = [
    { root: 38, voices: [62, 65, 69, 72] },
    { root: 43, voices: [59, 65, 69, 74] },
    { root: 36, voices: [60, 64, 67, 71] },
    { root: 33, voices: [57, 64, 67, 72] },
  ];

  function mtof(m) {
    return 440 * Math.pow(2, (m - 69) / 12);
  }

  var ctx = null;
  var master = null;
  var musicGain = null;
  var rainGain = null;
  var sfxGain = null;
  var noiseBuffer = null;
  var timer = null;
  var nextNoteTime = 0;
  var step = 0; // 8th notes since start
  var playing = false;
  var raining = false;
  var volume = 0.5;

  function ensureContext() {
    if (ctx) return ctx;
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();

    master = ctx.createGain();
    master.gain.value = volume;
    // A gentle bus compressor keeps the whole thing soft and glued.
    var comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -20;
    comp.ratio.value = 3;
    comp.attack.value = 0.02;
    comp.release.value = 0.28;
    master.connect(comp);
    comp.connect(ctx.destination);

    musicGain = ctx.createGain();
    musicGain.gain.value = 0;
    // Tape-ish top end roll-off.
    var tape = ctx.createBiquadFilter();
    tape.type = 'lowpass';
    tape.frequency.value = 3200;
    tape.Q.value = 0.4;
    musicGain.connect(tape);
    tape.connect(master);

    rainGain = ctx.createGain();
    rainGain.gain.value = 0;
    rainGain.connect(master);

    sfxGain = ctx.createGain();
    sfxGain.gain.value = 0.9;
    sfxGain.connect(master);

    noiseBuffer = makeNoise(2);
    startVinyl();
    startRain();
    return ctx;
  }

  function makeNoise(seconds) {
    var len = Math.floor(ctx.sampleRate * seconds);
    var buf = ctx.createBuffer(1, len, ctx.sampleRate);
    var data = buf.getChannelData(0);
    for (var i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    return buf;
  }

  function noiseSource(loop) {
    var src = ctx.createBufferSource();
    src.buffer = noiseBuffer;
    src.loop = !!loop;
    return src;
  }

  /* ---------- always-on beds ---------- */

  var vinylGain = null;

  function startVinyl() {
    var src = noiseSource(true);
    var hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 1800;
    var lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 7000;
    vinylGain = ctx.createGain();
    vinylGain.gain.value = 0;
    src.connect(hp);
    hp.connect(lp);
    lp.connect(vinylGain);
    vinylGain.connect(master);
    src.start();
  }

  var rainSrcGain = null;

  function startRain() {
    var src = noiseSource(true);
    var lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 1100;
    var hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 380;
    rainSrcGain = ctx.createGain();
    rainSrcGain.gain.value = 1;
    src.connect(hp);
    hp.connect(lp);
    lp.connect(rainSrcGain);
    rainSrcGain.connect(rainGain);
    src.start();

    // Slow swells so it breathes instead of hissing flatly.
    var lfo = ctx.createOscillator();
    lfo.frequency.value = 0.06;
    var lfoGain = ctx.createGain();
    lfoGain.gain.value = 0.25;
    lfo.connect(lfoGain);
    lfoGain.connect(rainSrcGain.gain);
    lfo.start();
  }

  /* ---------- instruments ---------- */

  function pad(time, midi, dur, level) {
    var g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, time);
    g.gain.exponentialRampToValueAtTime(level, time + 0.5);
    g.gain.setTargetAtTime(0.0001, time + dur * 0.55, dur * 0.25);

    var filt = ctx.createBiquadFilter();
    filt.type = 'lowpass';
    filt.frequency.setValueAtTime(700, time);
    filt.frequency.linearRampToValueAtTime(1500, time + dur * 0.5);
    filt.Q.value = 0.6;

    [0, 7].forEach(function (detune) {
      var o = ctx.createOscillator();
      o.type = 'triangle';
      o.frequency.value = mtof(midi);
      o.detune.value = detune - 3;
      o.connect(filt);
      o.start(time);
      o.stop(time + dur + 0.6);
    });

    filt.connect(g);
    g.connect(musicGain);
  }

  function bass(time, midi, dur) {
    var o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.value = mtof(midi - 12);
    var g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, time);
    g.gain.exponentialRampToValueAtTime(0.32, time + 0.03);
    g.gain.setTargetAtTime(0.0001, time + dur * 0.4, 0.18);
    o.connect(g);
    g.connect(musicGain);
    o.start(time);
    o.stop(time + dur + 0.3);
  }

  function keys(time, midi, level) {
    var o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.value = mtof(midi);
    var o2 = ctx.createOscillator();
    o2.type = 'triangle';
    o2.frequency.value = mtof(midi + 12);
    var g2 = ctx.createGain();
    g2.gain.value = 0.12;
    o2.connect(g2);

    var g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, time);
    g.gain.exponentialRampToValueAtTime(level, time + 0.012);
    g.gain.setTargetAtTime(0.0001, time + 0.05, 0.35);

    o.connect(g);
    g2.connect(g);
    g.connect(musicGain);
    o.start(time);
    o2.start(time);
    o.stop(time + 1.6);
    o2.stop(time + 1.6);
  }

  function kick(time) {
    var o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(120, time);
    o.frequency.exponentialRampToValueAtTime(42, time + 0.12);
    var g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, time);
    g.gain.exponentialRampToValueAtTime(0.5, time + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, time + 0.32);
    o.connect(g);
    g.connect(musicGain);
    o.start(time);
    o.stop(time + 0.4);
  }

  function snare(time) {
    var src = noiseSource(false);
    var bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1600;
    bp.Q.value = 0.7;
    var g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, time);
    g.gain.exponentialRampToValueAtTime(0.16, time + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, time + 0.19);
    src.connect(bp);
    bp.connect(g);
    g.connect(musicGain);
    src.start(time);
    src.stop(time + 0.25);
  }

  function hat(time, level) {
    var src = noiseSource(false);
    var hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 7000;
    var g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, time);
    g.gain.exponentialRampToValueAtTime(level, time + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, time + 0.06);
    src.connect(hp);
    hp.connect(g);
    g.connect(musicGain);
    src.start(time);
    src.stop(time + 0.09);
  }

  function crackle(time) {
    var src = noiseSource(false);
    var bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 2600 + Math.random() * 2600;
    var g = ctx.createGain();
    g.gain.setValueAtTime(0.05 + Math.random() * 0.05, time);
    g.gain.exponentialRampToValueAtTime(0.0001, time + 0.03);
    src.connect(bp);
    bp.connect(g);
    g.connect(master);
    src.start(time);
    src.stop(time + 0.05);
  }

  /* ---------- the loop ---------- */

  function scheduleStep(n, time) {
    var bar = Math.floor(n / 8) % PROGRESSION.length;
    var inBar = n % 8;
    var chord = PROGRESSION[bar];

    if (inBar === 0) {
      chord.voices.forEach(function (v, i) {
        pad(time + i * 0.02, v, BEAT * 4, 0.055);
      });
      bass(time, chord.root, BEAT * 1.5);
      kick(time);
    }
    if (inBar === 3) bass(time, chord.root + 7, BEAT * 0.8);
    if (inBar === 4) {
      kick(time + BEAT * 0.05);
      // A lazy comped chord on the and-of-three.
      chord.voices.slice(1).forEach(function (v, i) {
        keys(time + 0.012 * i, v, 0.07);
      });
    }
    if (inBar === 2 || inBar === 6) snare(time);
    // Swung 8ths, quietly.
    hat(time, inBar % 2 === 0 ? 0.035 : 0.018);
    if (Math.random() < 0.5) crackle(time + Math.random() * BEAT);
    if (inBar === 7 && Math.random() < 0.4) keys(time + BEAT * 0.25, chord.voices[3] + 12, 0.045);
  }

  function scheduler() {
    if (!ctx) return;
    while (nextNoteTime < ctx.currentTime + LOOKAHEAD) {
      scheduleStep(step, nextNoteTime);
      // Swing: every other 8th lands a touch late.
      var swing = step % 2 === 0 ? 1.08 : 0.92;
      nextNoteTime += (BEAT / 2) * swing;
      step++;
    }
  }

  /* ---------- public ---------- */

  function resume() {
    ensureContext();
    if (ctx && ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  function setMusic(on) {
    if (!on && !ctx) {
      playing = false;
      return false;
    }
    if (!resume()) return false;
    playing = !!on;
    var t = ctx.currentTime;
    musicGain.gain.cancelScheduledValues(t);
    musicGain.gain.setTargetAtTime(playing ? 0.55 : 0.0001, t, playing ? 0.8 : 0.4);
    vinylGain.gain.cancelScheduledValues(t);
    vinylGain.gain.setTargetAtTime(playing ? 0.02 : 0.0001, t, 0.6);

    if (playing && !timer) {
      nextNoteTime = ctx.currentTime + 0.15;
      timer = setInterval(scheduler, TICK);
    } else if (!playing && timer) {
      clearInterval(timer);
      timer = null;
    }
    return playing;
  }

  function setRain(on) {
    if (!on && !ctx) {
      raining = false;
      return false;
    }
    if (!resume()) return false;
    raining = !!on;
    var t = ctx.currentTime;
    rainGain.gain.cancelScheduledValues(t);
    rainGain.gain.setTargetAtTime(raining ? 0.07 : 0.0001, t, 1.2);
    return raining;
  }

  function setVolume(v) {
    volume = Math.max(0, Math.min(1, v));
    if (master) master.gain.setTargetAtTime(volume, ctx.currentTime, 0.1);
    return volume;
  }

  // Little UI sounds. They ride the same bus so they sit in the mix.
  var SFX = {
    win: [72, 76, 79, 84],
    near: [67, 71],
    miss: [59, 56],
    tick: [84],
  };

  function sfx(name) {
    if (!ctx || (!playing && !raining)) return false; // stay silent unless the room is on
    var notes = SFX[name];
    if (!notes) return false;
    var t = ctx.currentTime + 0.01;
    notes.forEach(function (m, i) {
      var o = ctx.createOscillator();
      o.type = name === 'miss' ? 'triangle' : 'sine';
      o.frequency.value = mtof(m);
      var g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t + i * 0.075);
      g.gain.exponentialRampToValueAtTime(name === 'win' ? 0.14 : 0.09, t + i * 0.075 + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.075 + 0.4);
      o.connect(g);
      g.connect(sfxGain);
      o.start(t + i * 0.075);
      o.stop(t + i * 0.075 + 0.45);
    });
    return true;
  }

  window.LofiAudio = {
    setMusic: setMusic,
    setRain: setRain,
    setVolume: setVolume,
    sfx: sfx,
    isPlaying: function () {
      return playing;
    },
    isRaining: function () {
      return raining;
    },
    // exposed for tests
    _internals: function () {
      return { ctx: ctx, BPM: BPM, progression: PROGRESSION, mtof: mtof };
    },
  };
})(typeof window !== 'undefined' ? window : globalThis);
