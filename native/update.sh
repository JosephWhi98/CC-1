#!/bin/bash
# Swaps the running CC-1.app for the staged one, then relaunches. Started by the app itself (copied to a temp file first).
# usage: update.sh <pid-to-wait-for> <stage-dir containing CC-1.app> <path-of-installed-app>
trap '' HUP
PID="$1"; STAGE="$2"; APP="$3"
LOG="${TMPDIR:-/tmp}/cc1-update.log"
{
  echo "$(date) swap $APP <- $STAGE (waiting for $PID)"
  for i in $(seq 1 100); do kill -0 "$PID" 2>/dev/null || break; sleep 0.3; done
  OLD="$APP.old.$$"
  if mv "$APP" "$OLD"; then
    if mv "$STAGE/CC-1.app" "$APP"; then rm -rf "$OLD"; echo "swapped"; else echo "move failed, rolling back"; mv "$OLD" "$APP"; fi
  else echo "could not move the old app aside"; fi
  xattr -dr com.apple.quarantine "$APP" 2>/dev/null
  D="$(dirname "$STAGE")"; [ "$(basename "$D")" = update ] && rm -rf "$D"
  open "$APP"
} >>"$LOG" 2>&1
