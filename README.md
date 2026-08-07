# ☕ flaggle.lofi

**Play it: [kmiller.dev/flaggle-lofi](https://kmiller.dev/flaggle-lofi/)**

A cozy take on [flaggle.net](https://flaggle.net), with **two flags a day**:

- **🎨 colours** — the real flaggle game. You never see the answer. Guess any flag and
  every part of *your* flag that shares a colour with the answer lights up green.
  Ten-colour palette, unlimited tries, score is how few you needed. No geography at all.
- **🌅 daily** — see the flag, name the country in six. Misses give you the distance to
  the answer, an arrow pointing at it, and how warm you are.

Plus everything the original doesn't have — a leaderboard, separate streaks per game,
most/least missed flags, practice mode for either style, and a lofi coffee-shop
soundtrack synthesised in the browser rather than streamed from anywhere.

No accounts, no tracking, no build step — and once loaded it makes no network calls at
all, so it works on a plane.

> **Your progress lives in the browser it was made in.** Streaks, stats and the
> leaderboard are stored in `localStorage`, so your laptop and your phone each keep their
> own save. Use **⬇️ export save** / **⬆️ import save** on the leaderboard tab to move one
> across. A genuinely shared leaderboard would need a server, which this deliberately
> doesn't have.

## Running it

```bash
./run.sh              # serves on a free port and opens your browser
./run.sh --port 8080  # pick the port
./run.sh --no-open    # just serve
```

## Deploying

It's a static site on GitHub Pages, served from `main`. Any push redeploys it:

```bash
./run.sh deploy                 # commit everything and push
./run.sh deploy "your message"  # with a commit message
./run.sh test-live              # run the browser suite against the live site
```

There's also a desktop entry (`flaggle.lofi`) in your applications menu.

> Serve it over `http://` rather than opening `index.html` directly — browsers sandbox
> `file://` origins and your streaks wouldn't survive a reload. `run.sh` handles this.

## What's in it

| | |
|---|---|
| 🌅 **Daily** | Same flag for everyone, every day, on a 197-day rotation with no repeats. Six guesses, distance + direction + proximity after each miss. |
| 🎨 **Colours** | A second daily on its own rotation. The flag is never shown — you deduce it from which cells of your guesses turn green. Unlimited tries, its own streak. |
| 🎯 **Practice** | Endless rounds in **either** style, filterable by continent. **🧠 weak spots** weights the deal toward the flags you keep missing. Feeds your flag stats but never touches a daily streak. |
| 📊 **Stats** | Both streaks, win rate, average guesses, the geo guess distribution, the colour try spread, and your **most missed** / **least missed** flags. |
| 🏆 **Leaderboard** | Everyone who plays on this machine, ranked by total points, with medals and both streaks per player. |
| 🏳️ **Give up** | On any board. Two taps to confirm, then the answer is revealed — it costs you the streak and pays nothing, but the colour game has no guess cap, so there has to be a way out. |
| 🌫️ **Steamy mode** | In geo mode, the flag starts fogged up and clears a little with every guess. |
| 🎧 **Lofi** | Dusty jazz chords, brushed drums, vinyl crackle and optional rain — all generated live in WebAudio. No audio files. |
| 🌙 **Themes** | Latte and midnight roast. |

**Hotkeys** — `Tab` completes the highlighted country in place (no submit, no focus jump),
`↑`/`↓` move through the list, `Enter` guesses, and `` ` `` deals a fresh practice round
from any tab. The autocomplete deliberately shows **names only** — no flag thumbnails and
no continent hints, since either would hand you the answer.

Points: a geo solve is **60** plus **+12** per guess saved; a colour solve is **120**
decaying **-8** per try down to a floor of 20. Both add **+3** per day of streak (capped
at +45) into one shared total. Practice pays a little, so grinding it can't buy the
leaderboard.

### How the colour matching works

Every flag is rasterised once into a **300×200** grid — 60,000 cells — and each cell
snapped to the nearest of ten colours in CIELAB, so "nearest" means what your eye would
say. That's roughly one cell per screen pixel at the size a flag is actually drawn, so
edges land as straight lines rather than stair-steps, and Kyrgyzstan's sun rays, the Union
Jack's diagonals and all thirteen US stripes survive intact.

A guess compares its grid to the answer's cell by cell. Matching cells paint bright green,
everything else paints flat dark, and your own flag sits beside the result so you can read
the green as a silhouette of what you got right. It's the same reduced palette flaggle
uses, so some flags do lose detail.

Stored raw that would be 11.5 MB of JavaScript; run-length coded it's 353 KB. Masks are
never written to storage either — they're recomputed from (guess, answer) on load.

## Layout

```
index.html          markup
css/style.css       the whole look
js/data.js          197 countries — generated, don't hand-edit
js/palette.js       the ten colours, the CIELAB quantizer, run-length coding
js/pixels.js        197 colour grids at 300×200 — generated, don't hand-edit
js/engine.js        pure game logic: daily picks, distance, colour matching, share text
js/store.js         profiles, both streaks, flag stats, leaderboard scoring
js/audio.js         the WebAudio lofi band
js/app.js           wiring — one board widget, two game types
flags/*.svg         197 flags, local
tools/              generators + test suites
```

`engine.js` and `store.js` hold all the rules and have no DOM or storage
dependencies, which is why they can be tested straight in node.

## Tests

```bash
./run.sh test           # everything
node tools/test-ui.mjs  # just the browser suite
HEADED=1 node tools/test-ui.mjs   # watch it play
BASE_URL=https://kmiller.dev/flaggle-lofi/ node tools/test-ui.mjs   # test what's deployed
```

Six suites: `data` (dataset vs. flag files), `pixels` (the generated grids — real flags spot-checked
cell by cell, and the run-length coding round-tripped for all 197), `engine` (geo maths, daily rotation, game state), `colour`
(matching, unlimited tries, and that no geography leaks into a colour result), `store`
(both streaks, scoring, per-flag stats, persistence) and `ui`, which drives the real app
in headless Firefox via geckodriver — playing both games, reading pixels back off the canvas to prove
the mask is exactly two colours in the right places, checking the answer appears nowhere in the
colours page, exercising the hotkeys, and reloading mid-game. Screenshots land in
`screenshots/`.

## Regenerating the country data

```bash
curl -sL https://raw.githubusercontent.com/mledoze/countries/master/countries.json -o /tmp/countries.json
node tools/gen-data.mjs /tmp/countries.json
node tools/test-data.mjs
```

And the colour grids (needs Firefox — it renders the SVGs):

```bash
node tools/gen-pixels.mjs
node tools/test-pixels.mjs
```

## Credits

Country data from [mledoze/countries](https://github.com/mledoze/countries) (ODbL).
Flags from [flagcdn.com](https://flagcdn.com), public domain. Game concept: flaggle /
Worldle.
