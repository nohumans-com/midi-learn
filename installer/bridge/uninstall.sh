#!/bin/sh
# Remove MIDI Learn: the bridge, its login agent and the Add On. Your mappings
# (~/Library/Application Support/MIDI Learn) and the log (~/Library/Logs) stay.
#
#   sudo "/Library/Application Support/MIDI Learn/uninstall.sh"
set -e
[ "$(id -u)" = 0 ] || exec sudo "$0" "$@"
LABEL=com.uaudio.midi-learn.bridge
ID=com.uaudio.midi-learn
ADDONS="/Library/Application Support/Universal Audio/LUNA/Add Ons"

for uid in $(ps -axo uid= -o comm= | awk '/loginwindow/ {print $1}' | sort -u); do
  launchctl bootout "gui/$uid/$LABEL" 2>/dev/null || true
done
rm -f "/Library/LaunchAgents/$LABEL.plist"
for entry in "$ADDONS"/*; do
  if grep -qs "\"id\": *\"$ID\"" "$entry/manifest.json"; then rm -rf "$entry"; fi
done
rm -rf "/Library/Application Support/MIDI Learn"
pkgutil --forget com.uaudio.midi-learn >/dev/null 2>&1 || true
echo "MIDI Learn removed."
