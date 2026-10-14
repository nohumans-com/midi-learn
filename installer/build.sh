#!/bin/bash
# Build "MIDI Learn <version>.pkg", a macOS installer to hand to someone else. It installs:
#
#   - the Add On into LUNA's Add Ons folder (only the files the page loads), and
#   - the MIDI bridge with its own Node runtime and MIDI module, run at every login by
#     /Library/LaunchAgents/com.uaudio.midi-learn.bridge.plist,
#
# so the person you send it to needs neither Node nor npm. The Node runtime is the official
# nodejs.org build (arm64 + x64, joined into one universal binary), checked against its SHASUMS.
#
#   npm run installer        # -> .build/MIDI Learn <version>.pkg
#
# .build/ starts with a dot so `npm run pack` leaves it out of the .lunaaddon.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
HERE="$ROOT/installer"
NODE_VERSION=v24.21.0
LABEL=com.uaudio.midi-learn.bridge
VERSION=$(node -p "require('$ROOT/manifest.json').version")
ADDON_NAME=$(node -p "require('$ROOT/manifest.json').package_name")

BUILD="$ROOT/.build"
CACHE="$BUILD/cache"
STAGE="$BUILD/stage"
PAYLOAD="$STAGE/root"
APP="$PAYLOAD/Library/Application Support/MIDI Learn"
OUT="$BUILD/MIDI Learn $VERSION.pkg"
rm -rf "$STAGE"
mkdir -p "$CACHE" "$APP/Bridge" "$APP/Add On" "$PAYLOAD/Library/LaunchAgents"

# The vendored SDK bundle must carry the load-retry patch (README: "The vendored SDK is patched").
grep -q 'if (this.loading === loading) this.loading = void 0' "$ROOT/vendor/luna.global.js" \
  || { echo "vendor/luna.global.js is missing the load-retry patch; rebuild it (README)" >&2; exit 1; }

echo "Node $NODE_VERSION"
[ -f "$CACHE/SHASUMS256-$NODE_VERSION.txt" ] \
  || curl -fsSL -o "$CACHE/SHASUMS256-$NODE_VERSION.txt" "https://nodejs.org/dist/$NODE_VERSION/SHASUMS256.txt"
for arch in arm64 x64; do
  tgz="node-$NODE_VERSION-darwin-$arch.tar.gz"
  [ -f "$CACHE/$tgz" ] || curl -fL --progress-bar -o "$CACHE/$tgz" "https://nodejs.org/dist/$NODE_VERSION/$tgz"
done
(cd "$CACHE" && grep -E "  node-$NODE_VERSION-darwin-(arm64|x64)\.tar\.gz$" "SHASUMS256-$NODE_VERSION.txt" | shasum -a 256 -c -)
for arch in arm64 x64; do
  mkdir -p "$STAGE/node-$arch"
  tar -xzf "$CACHE/node-$NODE_VERSION-darwin-$arch.tar.gz" -C "$STAGE/node-$arch" --strip-components 2 "node-$NODE_VERSION-darwin-$arch/bin/node"
done
lipo -create -output "$APP/Bridge/node" "$STAGE/node-arm64/node" "$STAGE/node-x64/node"
codesign --verify --strict "$APP/Bridge/node"

echo "Bridge"
cp "$ROOT/bridge/midi-bridge.mjs" "$HERE/bridge/run.sh" "$APP/Bridge/"
cp "$HERE/bridge/uninstall.sh" "$APP/"
# The bridge's runtime dependencies, copied from node_modules as npm resolved them.
npm ls --prefix "$ROOT" --omit=dev --all --parseable | tail -n +2 | while read -r dep; do
  rel=${dep#"$ROOT/"}
  mkdir -p "$APP/Bridge/$(dirname "$rel")"
  [ -e "$APP/Bridge/$rel" ] || cp -R "$dep" "$APP/Bridge/$rel"
done
find "$APP/Bridge/node_modules/@julusian/midi/prebuilds" -mindepth 1 -maxdepth 1 ! -name 'midi-darwin-*' -exec rm -rf {} +
sed "s|@LABEL@|$LABEL|" "$HERE/bridge/bridge.plist" > "$PAYLOAD/Library/LaunchAgents/$LABEL.plist"
plutil -lint -s "$PAYLOAD/Library/LaunchAgents/$LABEL.plist"

# Start the staged bridge on each architecture, away from the real one's port and settings.
for arch in arm64 x86_64; do
  log="$STAGE/smoke-$arch.log"
  MIDI_LEARN_PORT=18797 MIDI_LEARN_STATE_DIR="$STAGE/smoke-state" \
    arch "-$arch" "$APP/Bridge/node" "$APP/Bridge/midi-bridge.mjs" > "$log" 2>&1 &
  pid=$!
  # Up to 30 s: Rosetta translates the x64 runtime on its first launch.
  for _ in $(seq 300); do grep -q 'bridge on ws://' "$log" && break; kill -0 "$pid" 2>/dev/null || break; sleep 0.1; done
  kill "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
  grep -q 'bridge on ws://' "$log" || { echo "The bridge did not start on $arch:" >&2; cat "$log" >&2; exit 1; }
  echo "  starts on $arch"
done
rm -rf "$STAGE/smoke-state"

echo "Add On"
mkdir -p "$APP/Add On/$ADDON_NAME"
cp -R "$ROOT/index.html" "$ROOT/main.js" "$ROOT/logic.js" "$ROOT/manifest.json" "$ROOT/vendor" "$APP/Add On/$ADDON_NAME/"

echo "Package"
find "$PAYLOAD" -name .DS_Store -delete
chmod 755 "$APP/Bridge/run.sh" "$APP/uninstall.sh" "$HERE/scripts/preinstall" "$HERE/scripts/postinstall"
pkgbuild --quiet --root "$PAYLOAD" --scripts "$HERE/scripts" --identifier com.uaudio.midi-learn \
  --version "$VERSION" --ownership recommended "$STAGE/midi-learn.pkg"
sed "s|@VERSION@|$VERSION|g" "$HERE/distribution.xml" > "$STAGE/distribution.xml"
productbuild --quiet --distribution "$STAGE/distribution.xml" --resources "$HERE/resources" \
  --package-path "$STAGE" "$OUT"
rm -rf "$STAGE"
echo "Built $OUT ($(du -h "$OUT" | cut -f1 | tr -d ' '))"
