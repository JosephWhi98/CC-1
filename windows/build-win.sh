#!/bin/zsh
# Builds ../dist/CC-1-win-x64.zip (run on macOS or Linux; no Windows needed).
set -e
cd "$(dirname "$0")"
V=v45.0.0
CACHE=.cache; mkdir -p $CACHE
ZIP=$CACHE/electron-$V-win32-x64.zip
if [ ! -f "$ZIP" ]; then
  curl -L --fail -o "$ZIP" "https://github.com/electron/electron/releases/download/$V/electron-$V-win32-x64.zip"
  curl -sL --fail -o $CACHE/SHASUMS256.txt "https://github.com/electron/electron/releases/download/$V/SHASUMS256.txt"
fi
WANT=$(grep "electron-$V-win32-x64.zip" $CACHE/SHASUMS256.txt | cut -d' ' -f1)
GOT=$(shasum -a 256 "$ZIP" | cut -d' ' -f1)
[ "$WANT" = "$GOT" ] || { echo "checksum mismatch for $ZIP"; rm -f "$ZIP"; exit 1; }

OUT=../dist/CC-1-win-x64; rm -rf "$OUT" ../dist/CC-1-win-x64.zip; mkdir -p "$OUT"
unzip -q "$ZIP" -d "$OUT"
mv "$OUT/electron.exe" "$OUT/CC-1.exe"
rm -f "$OUT/resources/default_app.asar"
APP="$OUT/resources/app"; mkdir -p "$APP"
VER=$(tr -d '[:space:]' < ../VERSION)
cp main.js preload.js "$APP/"
sed "s/\"version\": \"[^\"]*\"/\"version\": \"$VER\"/" package.json > "$APP/package.json"
cp ../VERSION "$APP/"
cp ../server.js "$APP/"; cp -R ../public "$APP/public"
cp ../native/icon-1024.png "$APP/icon.png"
python3 - "$APP/icon.png" "$OUT/CC-1.ico" <<'PY'
import sys,struct,subprocess
src,dst=sys.argv[1:3]
subprocess.run(['sips','-z','256','256',src,'--out','.cache/icon-256.png'],check=True,capture_output=True) if __import__('shutil').which('sips') else None
png=open('.cache/icon-256.png','rb').read() if __import__('os').path.exists('.cache/icon-256.png') else open(src,'rb').read()
open(dst,'wb').write(struct.pack('<HHH',0,1,1)+struct.pack('<BBBBHHII',0,0,0,0,1,32,len(png),22)+png)
PY
cp README.txt "$OUT/README.txt"
(cd ../dist && zip -qry CC-1-win-x64.zip CC-1-win-x64)
mv ../dist/CC-1-win-x64.zip "../dist/CC-1-$VER-win-x64.zip"
ls -lh "../dist/CC-1-$VER-win-x64.zip"
