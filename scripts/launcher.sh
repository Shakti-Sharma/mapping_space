#!/bin/bash
# Mapping Space launcher (inside "Mapping Space.app/Contents/MacOS").
# Starts this macOS user's own server (own port, data folder and session key),
# or just reopens the browser if it is already running.
set -u
alert() { /usr/bin/osascript -e "display dialog \"$1\" with title \"Mapping Space\" buttons {\"OK\"} default button 1 with icon caution" >/dev/null 2>&1; }
HERE="$(cd "$(dirname "$0")" && pwd)"
RES="$HERE/../Resources/app"
if [ ! -r "$RES/server/src/index.js" ]; then
  alert "Mapping Space can't read its own files as user $(id -un). Reinstall it with the Mapping Space installer (.pkg) so every user can open it."
  exit 1
fi
RES="$(cd "$RES" && pwd)"
DATA="$HOME/Library/Application Support/MappingSpace"
LOG="$HOME/Library/Logs/MappingSpace.log"
mkdir -p "$DATA" "$(dirname "$LOG")"
chmod 700 "$DATA"

# Each Mac user gets their own port: first user (uid 501) → 4000, next → 4001 …
UID_NUM=$(id -u)
PORT=$((4000 + (UID_NUM >= 501 ? UID_NUM - 501 : 0) % 100))
URL_FILE="$DATA/session-url"
PID_FILE="$DATA/server.pid"

# Already running for this user? Just open it again.
if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null && [ -f "$URL_FILE" ]; then
  /usr/bin/open "$(cat "$URL_FILE")"
  exit 0
fi

# Find Node.js (apps opened from Finder don't get your shell PATH).
NODE=""
for c in "$HERE/../Resources/node/bin/node" /opt/homebrew/bin/node /usr/local/bin/node "$HOME"/.nvm/versions/node/*/bin/node "$HOME/.volta/bin/node" /usr/bin/node; do
  [ -x "$c" ] && NODE="$c" && break
done
[ -z "$NODE" ] && NODE="$(/bin/bash -lc 'command -v node' 2>/dev/null)"
if [ -z "$NODE" ] || [ ! -x "$NODE" ]; then
  alert "Mapping Space needs Node.js 18 or newer. Install it from nodejs.org (or 'brew install node'), then open Mapping Space again."
  /usr/bin/open "https://nodejs.org/en/download"
  exit 1
fi
export PATH="$(dirname "$NODE"):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

rm -f "$URL_FILE"
echo "--- $(date) start: user=$(id -un) uid=$UID_NUM port=$PORT node=$NODE ($("$NODE" -v 2>&1))" >>"$LOG"
export MS_APP=1 MS_DATA_DIR="$DATA" MS_URL_FILE="$URL_FILE" PORT
nohup "$NODE" "$RES/server/src/index.js" >>"$LOG" 2>&1 &
echo $! > "$PID_FILE"

# Wait for the server to write its session link, then open the browser.
for _ in $(seq 1 100); do
  if [ -s "$URL_FILE" ]; then /usr/bin/open "$(cat "$URL_FILE")"; exit 0; fi
  kill -0 "$(cat "$PID_FILE")" 2>/dev/null || break
  sleep 0.1
done
REASON="$(tail -n 4 "$LOG" 2>/dev/null | tr '"\\' "'/" | tr '\n' ' ' | cut -c1-400)"
alert "Mapping Space could not start (user $(id -un)). $REASON  —  Full log: ~/Library/Logs/MappingSpace.log"
exit 1
