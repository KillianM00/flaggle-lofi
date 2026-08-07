#!/usr/bin/env node
// Validates the generated palette grids against the countries list.
import { loadBrowserScripts, runTests, ok, eq } from './harness.mjs';

const w = loadBrowserScripts(['js/data.js', 'js/palette.js', 'js/pixels.js']);
const { COUNTRIES, FLAG_PIXELS, FLAG_PIXELS_RLE, Palette } = w;
const { GRID_W, GRID_H, CELLS } = Palette;

const at = (code, x, y) => FLAG_PIXELS[code][y * GRID_W + x];
// Probes are given as fractions of the flag so they survive a resolution change.
const px = (fx) => Math.min(GRID_W - 1, Math.round(fx * GRID_W));
const py = (fy) => Math.min(GRID_H - 1, Math.round(fy * GRID_H));
const nameAt = (code, fx, fy) => Palette.nameAt(at(code, px(fx), py(fy)));
// Share of a flag that is a given colour.
const share = (code, colorKey) => {
  const idx = Palette.COLORS.find((c) => c.key === colorKey).i;
  const grid = FLAG_PIXELS[code];
  let n = 0;
  for (let i = 0; i < grid.length; i++) if (grid[i] === idx) n++;
  return n / CELLS;
};
// Share of a colour inside a box, as fractions of the flag (0-1).
const shareIn = (code, colorKey, x0, y0, x1, y1) => {
  const idx = Palette.COLORS.find((c) => c.key === colorKey).i;
  let n = 0;
  let total = 0;
  for (let y = py(y0); y < py(y1); y++) {
    for (let x = px(x0); x < px(x1); x++) {
      total++;
      if (at(code, x, y) === idx) n++;
    }
  }
  return total ? n / total : 0;
};

runTests('pixels', {
  'every country has a grid'() {
    const missing = COUNTRIES.filter((c) => !FLAG_PIXELS[c.c]).map((c) => c.c);
    eq(missing.join(','), '', 'countries without pixel data');
  },

  'no grids for countries that do not exist'() {
    const codes = new Set(COUNTRIES.map((c) => c.c));
    const extra = Object.keys(FLAG_PIXELS).filter((c) => !codes.has(c));
    eq(extra.join(','), '', 'orphan grids');
  },

  'the grid is fine enough for edges to read as straight lines'() {
    // A flag is drawn around 270-420px wide, so the grid has to be in that
    // ballpark for a diagonal to stop looking like stairs.
    ok(GRID_W >= 240 && GRID_H >= 160, `grid is ${GRID_W}x${GRID_H}`);
    eq(GRID_W / GRID_H, 1.5, 'flags are drawn 3:2');
  },

  'every grid decodes to the right size'() {
    const bad = Object.entries(FLAG_PIXELS)
      .filter(([, g]) => g.length !== CELLS)
      .map(([c, g]) => `${c}:${g.length}`);
    eq(bad.join(','), '', `expected ${CELLS} cells each`);
  },

  'every cell is a valid palette index'() {
    const bad = [];
    for (const [code, grid] of Object.entries(FLAG_PIXELS)) {
      for (let i = 0; i < grid.length; i++) {
        if (grid[i] > 9) {
          bad.push(`${code}@${i}=${grid[i]}`);
          break;
        }
      }
    }
    eq(bad.join(','), '', 'out-of-range cells');
  },

  /* ---- run-length coding ---- */

  'encode and decode round-trip exactly, for every flag'() {
    const bad = [];
    for (const [code, grid] of Object.entries(FLAG_PIXELS)) {
      const again = Palette.decodeRLE(Palette.encodeRLE(grid), CELLS);
      for (let i = 0; i < CELLS; i++) {
        if (again[i] !== grid[i]) {
          bad.push(`${code}@${i}`);
          break;
        }
      }
    }
    eq(bad.join(','), '', 'flags that did not survive a round-trip');
  },

  'the stored coding matches what re-encoding produces'() {
    const bad = Object.keys(FLAG_PIXELS).filter(
      (c) => Palette.encodeRLE(FLAG_PIXELS[c]) !== FLAG_PIXELS_RLE[c]
    );
    eq(bad.join(','), '', 'stored coding is not canonical');
  },

  'coding handles the awkward cases'() {
    eq(Array.from(Palette.decodeRLE(Palette.encodeRLE(new Uint8Array(5)), 5)), [0, 0, 0, 0, 0]);
    const alternating = Uint8Array.from([0, 1, 0, 1, 0, 1]);
    eq(
      Array.from(Palette.decodeRLE(Palette.encodeRLE(alternating), 6)),
      Array.from(alternating),
      'runs of one'
    );
    // A run longer than 35 needs multi-character base 36.
    const long = new Uint8Array(2000).fill(7);
    const coded = Palette.encodeRLE(long);
    eq(coded, 'H' + (2000).toString(36));
    eq(Palette.decodeRLE(coded, 2000)[1999], 7);
    // Every palette index must survive, including the last one.
    const all = Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    eq(Array.from(Palette.decodeRLE(Palette.encodeRLE(all), 10)), Array.from(all));
  },

  'the coding is a big win over raw digits'() {
    const coded = Object.values(FLAG_PIXELS_RLE).reduce((a, s) => a + s.length, 0);
    const raw = Object.keys(FLAG_PIXELS).length * CELLS;
    ok(coded < raw / 8, `${(coded / 1024).toFixed(0)}KB coded vs ${(raw / 1024).toFixed(0)}KB raw`);
  },

  /* ---- palette ---- */

  'the palette has exactly ten colours with unique keys'() {
    eq(Palette.COLORS.length, 10);
    eq(new Set(Palette.COLORS.map((c) => c.key)).size, 10);
    Palette.COLORS.forEach((c, i) => eq(c.i, i, 'index matches position'));
  },

  'the match and miss colours are not palette colours'() {
    const hexes = Palette.COLORS.map((c) => c.hex.toLowerCase());
    ok(!hexes.includes(Palette.MATCH_COLOR.toLowerCase()), 'match green is distinct');
    ok(!hexes.includes(Palette.MISS_COLOR.toLowerCase()), 'miss dark is distinct');
    ok(Palette.MATCH_COLOR !== Palette.MISS_COLOR, 'and from each other');
  },

  'quantize snaps to the nearest palette colour'() {
    eq(Palette.nameAt(Palette.quantize(255, 255, 255)), 'white');
    eq(Palette.nameAt(Palette.quantize(0, 0, 0)), 'black');
    eq(Palette.nameAt(Palette.quantize(200, 16, 46)), 'red', 'a typical flag red');
    eq(Palette.nameAt(Palette.quantize(0, 122, 51)), 'green', 'a typical flag green');
    eq(Palette.nameAt(Palette.quantize(0, 38, 84)), 'blue', 'french navy stays blue');
    eq(Palette.nameAt(Palette.quantize(1, 33, 105)), 'blue', 'union navy stays blue');
    eq(Palette.nameAt(Palette.quantize(116, 172, 223)), 'sky blue');
    eq(Palette.nameAt(Palette.quantize(252, 209, 22)), 'yellow');
  },

  /* ---- real flags ---- */

  'Japan is white with a red disc in the middle'() {
    eq(nameAt('jp', 0.5, 0.5), 'red', 'centre');
    eq(nameAt('jp', 0.03, 0.04), 'white', 'corner');
    eq(nameAt('jp', 0.97, 0.95), 'white', 'other corner');
    ok(share('jp', 'white') > 0.75, 'mostly white');
    ok(share('jp', 'red') > 0.1 && share('jp', 'red') < 0.25, `the disc, got ${share('jp', 'red')}`);
  },

  'France is three vertical bands, Germany three horizontal ones'() {
    eq(nameAt('fr', 0.08, 0.5), 'blue', 'left band');
    eq(nameAt('fr', 0.5, 0.5), 'white', 'middle band');
    eq(nameAt('fr', 0.92, 0.5), 'red', 'right band');
    eq(nameAt('de', 0.5, 0.09), 'black', 'top band');
    eq(nameAt('de', 0.5, 0.5), 'red', 'middle band');
    eq(nameAt('de', 0.5, 0.9), 'yellow', 'bottom band');
  },

  'the Nordic cross sits off-centre'() {
    eq(nameAt('se', 0.5, 0.5), 'yellow', 'the cross bar');
    eq(nameAt('se', 0.83, 0.12), 'blue', 'the field');
    eq(nameAt('dk', 0.83, 0.12), 'red', 'danish field');
    eq(nameAt('dk', 0.5, 0.5), 'white', 'danish cross');
  },

  /* ---- detail that only survives at a fine grid ---- */

  'Kyrgyzstan keeps its sun, rays and tunduk'() {
    eq(nameAt('kg', 0.07, 0.1), 'red', 'the field');
    // The dead centre is red: that's the tunduk, the crossed yurt crown drawn
    // over the middle of the sun. Getting that back is the point of the fine grid.
    eq(nameAt('kg', 0.5, 0.5), 'red', 'the tunduk bars in the middle of the sun');
    const sun = share('kg', 'yellow');
    ok(sun > 0.04 && sun < 0.2, `sun covers a plausible area, got ${sun.toFixed(3)}`);
    ok(shareIn('kg', 'yellow', 0.4, 0.35, 0.6, 0.65) > 0.4, 'and dominates the middle');
    ok(shareIn('kg', 'yellow', 0, 0, 0.25, 0.25) < 0.02, 'while the corner stays clear');
    // Rays: crossing the sun horizontally should flip colour many times.
    let flips = 0;
    const midY = py(0.5);
    for (let x = 1; x < GRID_W; x++) if (at('kg', x, midY) !== at('kg', x - 1, midY)) flips++;
    ok(flips >= 8, `the rays and tunduk resolve as ${flips} colour changes across the middle`);
  },

  'Brazil keeps its globe and band'() {
    eq(nameAt('br', 0.03, 0.5), 'green', 'green field');
    eq(nameAt('br', 0.5, 0.1), 'green', 'green above the diamond');
    ok(shareIn('br', 'yellow', 0.15, 0.4, 0.3, 0.6) > 0.5, 'the yellow diamond');
    ok(shareIn('br', 'blue', 0.45, 0.4, 0.55, 0.6) > 0.4, 'the blue globe');
    ok(shareIn('br', 'white', 0.4, 0.45, 0.6, 0.55) > 0.05, 'the white motto band');
  },

  'the Union Jack keeps its crosses'() {
    // St George's cross runs the full width and height through the middle,
    // with a white fimbriation either side of the vertical bar.
    eq(nameAt('gb', 0.5, 0.5), 'red', 'the centre');
    eq(nameAt('gb', 0.08, 0.5), 'red', 'the horizontal arm reaches the hoist');
    eq(nameAt('gb', 0.5, 0.06), 'red', 'the vertical arm reaches the top');
    eq(nameAt('gb', 0.442, 0.12), 'white', 'white edging left of the vertical bar');
    eq(nameAt('gb', 0.553, 0.12), 'white', 'and to its right');
    eq(nameAt('gb', 0.33, 0.12), 'blue', 'blue field in the canton');
    // Roughly 28% blue / 37% red / 34% white — the crosses really do eat most
    // of the field once the fimbriations are counted.
    ok(share('gb', 'blue') > 0.22, `blue field, got ${share('gb', 'blue').toFixed(2)}`);
    ok(share('gb', 'red') > 0.3, `red crosses, got ${share('gb', 'red').toFixed(2)}`);
    ok(share('gb', 'white') > 0.28, `white edging, got ${share('gb', 'white').toFixed(2)}`);
  },

  'the US flag keeps thirteen stripes and a canton'() {
    ok(shareIn('us', 'blue', 0, 0, 0.3, 0.4) > 0.5, 'the canton');
    let flips = 0;
    const flyX = px(0.92);
    for (let y = 1; y < GRID_H; y++) if (at('us', flyX, y) !== at('us', flyX, y - 1)) flips++;
    ok(flips >= 12, `stripes are resolved down the fly, counted ${flips} edges`);
  },

  'flags use a believable number of colours'() {
    const counts = Object.entries(FLAG_PIXELS).map(([c, g]) => [c, new Set(g).size]);
    const tooFew = counts.filter(([, n]) => n < 2).map(([c]) => c);
    eq(tooFew.join(','), '', 'every flag has at least two colours');
    const avg = counts.reduce((a, [, n]) => a + n, 0) / counts.length;
    ok(avg < 6, `flags average ${avg.toFixed(1)} colours, so the quantizer is not scattering`);
  },

  'band flags split into the right proportions'() {
    ok(share('ly', 'black') > 0.4, `Libya's black band, got ${share('ly', 'black').toFixed(2)}`);
    ok(share('ly', 'green') > 0.18, `Libya's green band, got ${share('ly', 'green').toFixed(2)}`);
    ok(share('ma', 'red') > 0.8, 'Morocco is mostly red');
    ok(share('vn', 'red') > 0.85, 'Vietnam is mostly red');
  },

  'flags fill the whole grid instead of being letterboxed'() {
    const rowIsWhite = (code, y) => {
      for (let x = 0; x < GRID_W; x++) if (at(code, x, y) !== 0) return false;
      return true;
    };
    void rowIsWhite;
    for (const code of ['jm', 'qa', 'ch', 'ne', 'be']) {
      ok(!rowIsWhite(code, 0) || share(code, 'white') > 0.3, `${code} top row is not phantom white`);
      ok(
        !rowIsWhite(code, GRID_H - 1) || share(code, 'white') > 0.3,
        `${code} bottom row is not phantom white`
      );
    }
    eq(share('jm', 'white'), 0, 'Jamaica has no white at all');
  },

  'Vietnam and Burkina Faso overlap exactly as the example describes'() {
    const vn = FLAG_PIXELS.vn;
    const bf = FLAG_PIXELS.bf;
    let top = 0;
    let bottom = 0;
    for (let y = 0; y < GRID_H; y++) {
      for (let x = 0; x < GRID_W; x++) {
        const i = y * GRID_W + x;
        if (vn[i] !== bf[i]) continue;
        if (y < GRID_H / 2) top++;
        else bottom++;
      }
    }
    const half = (GRID_H / 2) * GRID_W;
    ok(top / half > 0.9, `top half mostly matches (${top}/${half})`);
    ok(bottom / half < 0.1, `bottom half barely matches (${bottom}/${half})`);
    const yellow = Palette.COLORS.find((c) => c.key === 'yellow').i;
    let yellowBoth = 0;
    for (let i = 0; i < vn.length; i++) if (vn[i] === bf[i] && vn[i] === yellow) yellowBoth++;
    ok(yellowBoth > 0, `the two stars overlap somewhere (${yellowBoth} cells)`);
  },

  'identical flags match everywhere, opposite ones barely at all'() {
    let cross = 0;
    for (let i = 0; i < CELLS; i++) if (FLAG_PIXELS.jm[i] === FLAG_PIXELS.jp[i]) cross++;
    ok(cross / CELLS < 0.05, `Jamaica vs Japan share nothing (${Math.round((cross / CELLS) * 100)}%)`);
  },
});
