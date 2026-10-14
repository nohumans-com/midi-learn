#!/bin/sh
# Started by launchd at every login (/Library/LaunchAgents/com.uaudio.midi-learn.bridge.plist).
# Runs the bridge on the Node runtime installed beside it, logging where `npm run bridge:status` looks.
PATH=/usr/bin:/bin:/usr/sbin:/sbin
DIR=$(cd "$(dirname "$0")" && pwd)
: "${HOME:=$(eval echo "~$(id -un)")}"
LOG="$HOME/Library/Logs/midi-learn-bridge.log"
mkdir -p "$HOME/Library/Logs"
# Keep the log from growing without end: one older copy, rolled at 5 MB.
[ "$(stat -f%z "$LOG" 2>/dev/null || echo 0)" -gt 5000000 ] && mv -f "$LOG" "$LOG.1"
exec "$DIR/node" "$DIR/midi-bridge.mjs" >>"$LOG" 2>&1
