#!/bin/bash
# Builds "Mapping Space.app" for ANY Mac (Apple Silicon + Intel, one universal app).
#
#   npm run make-app   → build/MappingSpace-<v>.pkg  (installer for this Mac, all users)
#   npm run make-dmg   → build/MappingSpace-<v>.dmg  (drag-to-Applications, to give to others)
#
# Optional Apple signing (removes the "unidentified developer" warning on other Macs):
#   MS_SIGN_ID="Developer ID Application: Your Name (TEAMID)"   sign with your certificate
#   MS_NOTARY_PROFILE="mappingspace"   notarize the DMG (xcrun notarytool store-credentials …)
set -euo pipefail
MODE="${1:-pkg}"
cd "$(dirname "$0")/.."
ROOT="$PWD"
APP_NAME="Mapping Space"
BUILD="$ROOT/build"
OUT="$BUILD/$APP_NAME.app"
VERSION="$(node -p "require('./package.json').version")"
NODE_VERSION="${MS_NODE_VERSION:-$(node -v)}"          # e.g. v22.11.0 (same as yours)
NODE_MAJOR="${NODE_VERSION#v}"; NODE_MAJOR="${NODE_MAJOR%%.*}"
mkdir -p "$BUILD"

echo "1/6 Building the interface…"
npm --prefix client run build >/dev/null

echo "2/6 Assembling the app…"
rm -rf "$OUT"
mkdir -p "$OUT/Contents/MacOS" "$OUT/Contents/Resources/app/server" "$OUT/Contents/Resources/app/client" "$OUT/Contents/Resources/app/scripts" "$OUT/Contents/Resources/node/bin"
cp -R server/src server/package.json server/package-lock.json "$OUT/Contents/Resources/app/server/"
cp -R client/dist "$OUT/Contents/Resources/app/client/"
cp scripts/measure-admin.mjs "$OUT/Contents/Resources/app/scripts/"
(cd "$OUT/Contents/Resources/app/server" && npm ci --omit=dev --silent >/dev/null)
cp scripts/launcher.sh "$OUT/Contents/MacOS/MappingSpace"

echo "3/6 Adding universal Node.js $NODE_VERSION (Apple Silicon + Intel) from nodejs.org…"
# Official nodejs.org builds are self-contained (no Homebrew libraries), so the app runs on
# any Mac. Both architectures are merged into one binary with lipo. Checksums are verified.
CACHE="$BUILD/node-cache/$NODE_VERSION"
mkdir -p "$CACHE"
BASE="https://nodejs.org/dist/$NODE_VERSION"
[ -s "$CACHE/SHASUMS256.txt" ] || curl -fsSL "$BASE/SHASUMS256.txt" -o "$CACHE/SHASUMS256.txt"
for ARCH in arm64 x64; do
  TGZ="node-$NODE_VERSION-darwin-$ARCH.tar.gz"
  if [ ! -x "$CACHE/$ARCH/node" ]; then
    curl -fL --progress-bar "$BASE/$TGZ" -o "$CACHE/$TGZ"
    (cd "$CACHE" && grep " $TGZ\$" SHASUMS256.txt | shasum -a 256 -c - >/dev/null) || { echo "Checksum mismatch for $TGZ — aborting."; exit 1; }
    mkdir -p "$CACHE/$ARCH"
    tar -xzf "$CACHE/$TGZ" -C "$CACHE/$ARCH" --strip-components=2 "node-$NODE_VERSION-darwin-$ARCH/bin/node"
    rm -f "$CACHE/$TGZ"
  fi
done
lipo -create "$CACHE/arm64/node" "$CACHE/x64/node" -output "$OUT/Contents/Resources/node/bin/node"
lipo -info "$OUT/Contents/Resources/node/bin/node" | sed 's/^/   /'

# Node 24+ needs macOS 13.5; Node 22 needs macOS 11.
MIN_OS="11.0"; [ "$NODE_MAJOR" -ge 24 ] && MIN_OS="13.5"

echo "4/6 Icon and app info…"
ICONSET="$BUILD/AppIcon.iconset"
rm -rf "$ICONSET"; mkdir -p "$ICONSET"
for s in 16 32 128 256 512; do
  sips -z $s $s assets/icon.png --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
  sips -z $((s*2)) $((s*2)) assets/icon.png --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$OUT/Contents/Resources/AppIcon.icns"
rm -rf "$ICONSET"
cat > "$OUT/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>$APP_NAME</string>
  <key>CFBundleDisplayName</key><string>$APP_NAME</string>
  <key>CFBundleIdentifier</key><string>local.mappingspace.app</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleExecutable</key><string>MappingSpace</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>LSMinimumSystemVersion</key><string>$MIN_OS</string>
  <key>LSArchitecturePriority</key><array><string>arm64</string><string>x86_64</string></array>
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
</dict></plist>
PLIST
# Readable/runnable by every user on the Mac.
chmod -R u+rwX,go+rX,go-w "$OUT"
chmod 755 "$OUT/Contents/MacOS/MappingSpace" "$OUT/Contents/Resources/node/bin/node"

echo "5/6 Signing…"
ENT="$BUILD/node.entitlements"
cat > "$ENT" <<'XML'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>com.apple.security.cs.allow-jit</key><true/>
  <key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/>
</dict></plist>
XML
if [ -n "${MS_SIGN_ID:-}" ]; then
  echo "   with: $MS_SIGN_ID"
  codesign --force --options runtime --timestamp --entitlements "$ENT" --sign "$MS_SIGN_ID" "$OUT/Contents/Resources/node/bin/node"
  codesign --force --options runtime --timestamp --sign "$MS_SIGN_ID" "$OUT"
else
  echo "   ad-hoc (no Apple Developer ID) — other Macs will ask to confirm the first open"
  codesign --force --sign - "$OUT/Contents/Resources/node/bin/node"
  codesign --force --sign - "$OUT"
fi
codesign --verify --strict "$OUT" && echo "   signature OK"
rm -f "$ENT"

if [ "$MODE" = "dmg" ]; then
  echo "6/6 Making the DMG…"
  STAGE="$BUILD/dmgroot"
  rm -rf "$STAGE"; mkdir -p "$STAGE"
  ditto "$OUT" "$STAGE/$APP_NAME.app"
  ln -s /Applications "$STAGE/Applications"
  cat > "$STAGE/Read me first.txt" <<TXT
Mapping Space $VERSION — see what is using space on your Mac and Google Drive.

INSTALL
  Drag "Mapping Space" onto the Applications folder.

FIRST OPEN
  Open it from Launchpad / Applications. Because it isn't from the App Store, macOS may say
  it can't check the app:
    macOS 15+:  System Settings → Privacy & Security → scroll down → "Open Anyway".
    macOS 13–14: right-click the app in Applications → Open → Open.
  It opens in your web browser. Quit it with the "Quit" button (top right).

SEE EVERYTHING
  System Settings → Privacy & Security → Full Disk Access → + → add "Mapping Space".
  Without it, macOS hides Desktop, Documents, Downloads, Photos… from the app.

GOOGLE DRIVE (optional)
  Open the "Google Drive" tab and follow the 5 steps on screen (needs your own free
  Google Cloud keys; nothing is shared with anyone else).

OPTIONAL
  To play AVI/WMV/MKV and other video formats in the app: install ffmpeg (brew install ffmpeg).
  Works on Apple Silicon and Intel Macs, macOS $MIN_OS or newer. Nothing to install besides the app.

PRIVACY
  Runs only on your Mac (localhost), never uploads your files. Each Mac user has their own
  private settings. Deleting moves to Trash by default.
TXT
  DMG="$BUILD/MappingSpace-$VERSION.dmg"
  rm -f "$DMG"
  hdiutil create -volname "$APP_NAME $VERSION" -srcfolder "$STAGE" -ov -format ULFO -fs HFS+ "$DMG" >/dev/null
  rm -rf "$STAGE"
  if [ -n "${MS_SIGN_ID:-}" ]; then codesign --force --timestamp --sign "$MS_SIGN_ID" "$DMG"; fi
  if [ -n "${MS_NOTARY_PROFILE:-}" ]; then
    echo "   notarizing (a few minutes)…"
    xcrun notarytool submit "$DMG" --keychain-profile "$MS_NOTARY_PROFILE" --wait
    xcrun stapler staple "$DMG"
  fi
  rm -rf "$OUT"
  echo ""
  echo "DMG ready: $DMG  ($(du -h "$DMG" | cut -f1))"
  echo "Give this file to anyone with a Mac (Apple Silicon or Intel, macOS $MIN_OS+)."
  [ "${NO_OPEN:-}" = "1" ] || open -R "$DMG"
  exit 0
fi

echo "6/6 Making the installer for this Mac…"
# Carry your existing settings (Google keys + login) over to the app's per-user data folder.
MINE="$HOME/Library/Application Support/MappingSpace"
mkdir -p "$MINE" && chmod 700 "$MINE"
[ -f server/.env ] && [ ! -f "$MINE/.env" ] && cp server/.env "$MINE/.env" && chmod 600 "$MINE/.env"
[ -f server/.data/gdrive-token.json ] && [ ! -f "$MINE/gdrive-token.json" ] && cp server/.data/gdrive-token.json "$MINE/" && chmod 600 "$MINE/gdrive-token.json"

# Standard macOS installer package: installs to /Applications for all users. Not
# "relocatable", so it never upgrades a stray copy somewhere else.
STAGE="$BUILD/pkgroot"
rm -rf "$STAGE"; mkdir -p "$STAGE"
ditto "$OUT" "$STAGE/$APP_NAME.app"
rm -rf "$OUT"
COMP="$BUILD/component.plist"
pkgbuild --analyze --root "$STAGE" "$COMP" >/dev/null
plutil -replace 0.BundleIsRelocatable -bool NO "$COMP"
PKG="$BUILD/MappingSpace-$VERSION.pkg"
pkgbuild --root "$STAGE" --component-plist "$COMP" --install-location /Applications \
  --identifier local.mappingspace.pkg --version "$VERSION" "$PKG" >/dev/null
rm -rf "$STAGE" "$COMP"

echo ""
echo "Installer ready: $PKG"
echo "Opening it now — click Continue → Install and enter your Mac password."
echo "Afterwards every user on this Mac finds \"$APP_NAME\" in Launchpad / Applications."
echo "First time: System Settings → Privacy & Security → Full Disk Access → add \"$APP_NAME\"."
[ "${NO_OPEN:-}" = "1" ] || open "$PKG"
