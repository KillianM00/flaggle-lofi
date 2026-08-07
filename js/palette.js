/* ==========================================================================
   palette.js — the ten colours every flag gets squashed into.
   Shared by the pixel generator and the game, so they can never drift apart.
   ========================================================================== */
(function (window) {
  'use strict';

  // Order matters: the index is what gets stored in js/pixels.js.
  var PALETTE = [
    { i: 0, key: 'white', name: 'white', hex: '#f4f1ea', rgb: [244, 241, 234], emoji: '⬜' },
    { i: 1, key: 'black', name: 'black', hex: '#1c1a19', rgb: [28, 26, 25], emoji: '⬛' },
    { i: 2, key: 'grey', name: 'grey', hex: '#9a9691', rgb: [154, 150, 145], emoji: '🩶' },
    { i: 3, key: 'red', name: 'red', hex: '#cf2033', rgb: [207, 32, 51], emoji: '🟥' },
    { i: 4, key: 'orange', name: 'orange', hex: '#e8802a', rgb: [232, 128, 42], emoji: '🟧' },
    { i: 5, key: 'yellow', name: 'yellow', hex: '#f5cb2e', rgb: [245, 203, 46], emoji: '🟨' },
    { i: 6, key: 'green', name: 'green', hex: '#0f7a3d', rgb: [15, 122, 61], emoji: '🟩' },
    { i: 7, key: 'sky', name: 'sky blue', hex: '#5cb4de', rgb: [92, 180, 222], emoji: '🩵' },
    // Anchored dark on purpose: real flag navies (#002654, #012169, #0A3161)
    // sit between blue and black in Lab, and a brighter anchor sends them black.
    { i: 8, key: 'blue', name: 'blue', hex: '#14357f', rgb: [20, 53, 127], emoji: '🟦' },
    { i: 9, key: 'brown', name: 'brown', hex: '#8a5a2f', rgb: [138, 90, 47], emoji: '🟫' },
  ];

  // Deliberately nothing like the palette's own green, so a match can't be
  // mistaken for a flag that happens to be green there. Everything that does
  // NOT match is painted flat dark, the way flaggle does it — the result is a
  // silhouette of what you got right, not a tinted copy of your guess.
  var MATCH_COLOR = '#57bf6a';
  var MISS_COLOR = '#302a26';
  var MISS_COLOR_DARK = '#4a423b';

  // Roughly one cell per screen pixel at the size a flag is actually drawn, so
  // edges land as straight lines instead of stair-steps. Run-length coding is
  // what makes a grid this fine affordable.
  var GRID_W = 300;
  var GRID_H = 200;

  /* ---- sRGB -> CIELAB, so "nearest colour" matches what an eye would say --- */

  function srgbToLinear(v) {
    v /= 255;
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  }

  function rgbToLab(r, g, b) {
    var R = srgbToLinear(r);
    var G = srgbToLinear(g);
    var B = srgbToLinear(b);
    // sRGB D65 -> XYZ
    var x = (R * 0.4124564 + G * 0.3575761 + B * 0.1804375) / 0.95047;
    var y = R * 0.2126729 + G * 0.7151522 + B * 0.072175;
    var z = (R * 0.0193339 + G * 0.119192 + B * 0.9503041) / 1.08883;
    var f = function (t) {
      return t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116;
    };
    var fx = f(x);
    var fy = f(y);
    var fz = f(z);
    return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
  }

  var LABS = PALETTE.map(function (p) {
    return rgbToLab(p.rgb[0], p.rgb[1], p.rgb[2]);
  });

  var cache = new Map();

  // Nearest palette index for an rgb triple.
  function quantize(r, g, b) {
    var key = (r << 16) | (g << 8) | b;
    var hit = cache.get(key);
    if (hit !== undefined) return hit;
    var lab = rgbToLab(r, g, b);
    var best = 0;
    var bestD = Infinity;
    for (var i = 0; i < LABS.length; i++) {
      var dl = lab[0] - LABS[i][0];
      var da = lab[1] - LABS[i][1];
      var db = lab[2] - LABS[i][2];
      var d = dl * dl + da * da + db * db;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    cache.set(key, best);
    return best;
  }

  /* ---- run-length coding -------------------------------------------------
     A 120x80 grid is 9600 cells; stored raw that's ~1.9 MB of JavaScript for
     197 flags. Flags are enormous flat regions, so run-length coding takes it
     to a fraction of that. Format: an uppercase A–J names the colour, followed
     by the run length in base 36. Base-36 digits are 0-9a-z, so the next
     uppercase letter is an unambiguous terminator — no separators needed. */

  function encodeRLE(cells) {
    var out = '';
    var run = 1;
    for (var i = 1; i <= cells.length; i++) {
      if (i < cells.length && cells[i] === cells[i - 1]) {
        run++;
        continue;
      }
      out += String.fromCharCode(65 + cells[i - 1]) + run.toString(36);
      run = 1;
    }
    return out;
  }

  var isMarker = function (code) {
    return code >= 65 && code <= 90;
  };

  function decodeRLE(str, cells) {
    var out = new Uint8Array(cells || GRID_W * GRID_H);
    var pos = 0;
    var i = 0;
    while (i < str.length) {
      var colour = str.charCodeAt(i) - 65;
      i++;
      var start = i;
      while (i < str.length && !isMarker(str.charCodeAt(i))) i++;
      var run = parseInt(str.slice(start, i), 36);
      if (!(run > 0)) break;
      var end = Math.min(pos + run, out.length);
      for (; pos < end; pos++) out[pos] = colour;
    }
    return out;
  }

  function expandAll(rleMap) {
    var out = {};
    Object.keys(rleMap).forEach(function (code) {
      out[code] = decodeRLE(rleMap[code], GRID_W * GRID_H);
    });
    return out;
  }

  window.Palette = {
    COLORS: PALETTE,
    MATCH_COLOR: MATCH_COLOR,
    MISS_COLOR: MISS_COLOR,
    MISS_COLOR_DARK: MISS_COLOR_DARK,
    GRID_W: GRID_W,
    GRID_H: GRID_H,
    CELLS: GRID_W * GRID_H,
    rgbToLab: rgbToLab,
    quantize: quantize,
    encodeRLE: encodeRLE,
    decodeRLE: decodeRLE,
    expandAll: expandAll,
    hexAt: function (i) {
      return (PALETTE[i] || PALETTE[0]).hex;
    },
    nameAt: function (i) {
      return (PALETTE[i] || PALETTE[0]).name;
    },
  };
})(typeof window !== 'undefined' ? window : globalThis);
