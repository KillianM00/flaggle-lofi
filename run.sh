#!/usr/bin/env bash
# flaggle.lofi — serve the game locally and open it.
#
#   ./run.sh          serve on the first free port from 8730 and open a browser
#   ./run.sh --port N serve on a specific port
#   ./run.sh --no-open   just serve
#   ./run.sh test     run the whole test suite (logic + headless browser)
#   ./run.sh deploy   push to GitHub; Pages redeploys https://kmiller.dev/flaggle-lofi/
#   ./run.sh test-live  run the browser suite against the deployed site
set -euo pipefail

cd "$(dirname "$(readlink -f "$0")")"

LIVE_URL="https://kmiller.dev/flaggle-lofi/"

if [[ "${1:-}" == "test" ]]; then
  exec node tools/test-all.mjs "${@:2}"
fi

if [[ "${1:-}" == "test-live" ]]; then
  echo "☕ testing ${LIVE_URL}"
  BASE_URL="$LIVE_URL" exec node tools/test-ui.mjs
fi

if [[ "${1:-}" == "deploy" ]]; then
  if [[ -n "$(git status --porcelain)" ]]; then
    git add -A
    git commit -q -m "${2:-Update flaggle.lofi}"
    echo "☕ committed"
  else
    echo "☕ nothing new to commit"
  fi
  git push -q origin main
  echo "☕ pushed — GitHub Pages usually goes live within a minute:"
  echo "   ${LIVE_URL}"
  exit 0
fi

PORT=""
OPEN=1
while [[ $# -gt 0 ]]; do
  case "$1" in
    --port) PORT="$2"; shift 2 ;;
    --no-open) OPEN=0; shift ;;
    -h|--help) sed -n '2,9p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 1 ;;
  esac
done

free_port() {
  for p in $(seq 8730 8760); do
    if ! (exec 3<>"/dev/tcp/127.0.0.1/$p") 2>/dev/null; then echo "$p"; return; fi
    exec 3>&- 2>/dev/null || true
  done
  echo 8730
}

PORT="${PORT:-$(free_port)}"
URL="http://127.0.0.1:${PORT}/index.html"

# A real HTTP origin, so localStorage (streaks, leaderboard) actually persists —
# file:// origins get sandboxed and your stats would evaporate.
python3 -m http.server "$PORT" --bind 127.0.0.1 >/dev/null 2>&1 &
SERVER_PID=$!
trap 'kill "$SERVER_PID" 2>/dev/null || true' EXIT INT TERM

for _ in $(seq 1 40); do
  (exec 3<>"/dev/tcp/127.0.0.1/$PORT") 2>/dev/null && break
  sleep 0.1
done

echo "☕ flaggle.lofi is brewing at ${URL}"
echo "   ctrl-c to close up shop"

if [[ "$OPEN" == "1" ]]; then
  (xdg-open "$URL" >/dev/null 2>&1 &) || true
fi

wait "$SERVER_PID"
