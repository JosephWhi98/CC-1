#!/bin/zsh
# Builds CC-1.app into ../dist
set -e
cd "$(dirname "$0")"
VER=$(tr -d '[:space:]' < ../VERSION)
APP=../dist/CC-1.app
rm -rf "$APP"; mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
swiftc -O main.swift -o "$APP/Contents/MacOS/CC-1"
cp ../server.js ../VERSION "$APP/Contents/Resources/"
cp -R ../public "$APP/Contents/Resources/public"
[ -f AppIcon.icns ] && cp AppIcon.icns "$APP/Contents/Resources/"
cat > "$APP/Contents/Info.plist" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleName</key><string>CC-1</string>
<key>CFBundleDisplayName</key><string>CC-1</string>
<key>CFBundleIdentifier</key><string>app.cc1.gui</string>
<key>CFBundleExecutable</key><string>CC-1</string>
<key>CFBundleIconFile</key><string>AppIcon</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>$VER</string>
<key>CFBundleVersion</key><string>$VER</string>
<key>LSMinimumSystemVersion</key><string>11.0</string>
<key>NSHighResolutionCapable</key><true/>
<key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict></plist>
PL
codesign --force --sign - "$APP" 2>/dev/null || true
echo "built $APP"
