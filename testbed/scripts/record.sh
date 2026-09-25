#!/usr/bin/env bash
#
# Records the two browser runs with agent-browser, against a running `npm run dev` (start it with
# slow pacing so progress is visible: TESTBED_PACE_MS=1500 TESTBED_SLEEP_MS=6000 npm run dev).
#
#   scripts/record.sh debug-ui   the libpetri debug UI following a `sleep` run live (WebM + PNGs)
#   scripts/record.sh studio     Mastra Studio running `sleep`, its steps progressing (WebM + PNGs)
#
# Output goes to recordings/. Notes from making these work:
# - `record start` opens a NEW tab at the current URL; anything typed before it is lost. Open the
#   page and set the viewport first, then start recording, then interact.
# - The debug UI does not fit the net to the view, and it lists new sessions only on Refresh.
#   browser/fit.js zooms (through the viewer's own wheel handling) until the net fits.
# - A deep link `?sessionId=` subscribes in replay mode (paused); selecting the session with the
#   mode select on "Live" is what follows it live.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
OUT="$ROOT/recordings"
MASTRA_PORT="${TESTBED_MASTRA_PORT:-4111}"
DEBUG_PORT="${TESTBED_DEBUG_PORT:-4112}"
mkdir -p "$OUT"

ab() { agent-browser "$@"; }
ref() { grep -oE "$1 \[[^]]*ref=e[0-9]+" | grep -oE 'e[0-9]+$' | head -1; }

case "${1:-}" in
  debug-ui)
    ab close --all >/dev/null 2>&1 || true; sleep 2   # a relaunch races an immediate open
    ab open "http://localhost:$DEBUG_PORT/debug/petri/ui/" >/dev/null
    ab set viewport 1920 1080 >/dev/null
    sleep 2
    ab record start "$OUT/debug-ui-sleep-live.webm"
    sleep 1
    run="$(cd "$ROOT" && npx tsx scripts/drive.ts --no-wait sleep | awk '{print $3}')"
    ab click '#refresh-sessions' >/dev/null
    sleep 0.3
    ab select '#session-select' "$run" >/dev/null
    sleep 1   # the new session's net renders asynchronously; fit it once it is there
    ab eval "$(cat "$HERE/browser/fit.js")" >/dev/null
    ab screenshot "$OUT/debug-ui-sleep-live-t1.png" >/dev/null
    sleep 4; ab screenshot "$OUT/debug-ui-sleep-live-sleeping.png" >/dev/null
    sleep 8; ab screenshot "$OUT/debug-ui-sleep-live-done.png" >/dev/null
    ab record stop
    ;;
  studio)
    ab close --all >/dev/null 2>&1 || true; sleep 2   # a relaunch races an immediate open
    ab open "http://localhost:$MASTRA_PORT/workflows/sleep/graph" >/dev/null
    ab set viewport 1920 1080 >/dev/null
    sleep 3
    ab record start "$OUT/studio-sleep-run.webm"
    sleep 3
    snap="$(ab snapshot -i)"
    ab fill "@$(ref 'spinbutton "N \*"' <<<"$snap")" 1 >/dev/null
    ab click "@$(ref 'button "Run"' <<<"$snap")" >/dev/null
    sleep 0.8; ab screenshot "$OUT/studio-sleep-first-step.png" >/dev/null
    sleep 2.5; ab screenshot "$OUT/studio-sleep-sleeping.png" >/dev/null
    sleep 8.5; ab screenshot "$OUT/studio-sleep-done.png" >/dev/null
    ab record stop
    ;;
  *)
    echo "usage: $0 debug-ui|studio" >&2; exit 2 ;;
esac
