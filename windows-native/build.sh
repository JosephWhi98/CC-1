#!/bin/zsh
# Builds ../dist/CC-1-<ver>-win-x64-native.zip (run on macOS; needs the .NET SDK, no Windows needed).
set -e
cd "$(dirname "$0")"
NODE=v24.22.2
CACHE=.cache; mkdir -p $CACHE
VER=$(tr -d '[:space:]' < ../VERSION)

# 1. multi-size .ico from the shared 1024px icon
python3 - ../native/icon-1024.png CC-1.ico $CACHE <<'PY'
import sys,struct,subprocess,os
src,dst,cache=sys.argv[1:4]
sizes=[16,32,48,64,128,256]; pngs=[]
for s in sizes:
    f=f'{cache}/ico-{s}.png'
    subprocess.run(['sips','-z',str(s),str(s),src,'--out',f],check=True,capture_output=True)
    pngs.append(open(f,'rb').read())
out=struct.pack('<HHH',0,1,len(sizes)); off=6+16*len(sizes)
for s,p in zip(sizes,pngs):
    out+=struct.pack('<BBBBHHII',s%256,s%256,0,0,1,32,len(p),off); off+=len(p)
open(dst,'wb').write(out+b''.join(pngs))
PY

# 2. compile
rm -rf bin obj
dotnet publish CC-1.csproj -c Release -p:Version=$VER -p:InformationalVersion=$VER -o bin/out >/dev/null

# 3. node.exe (checksum-verified)
Z=$CACHE/node-$NODE-win-x64.zip
if [ ! -f "$Z" ]; then
  curl -L --fail -o "$Z" "https://nodejs.org/dist/$NODE/node-$NODE-win-x64.zip"
  curl -sL --fail -o $CACHE/SHASUMS256.txt "https://nodejs.org/dist/$NODE/SHASUMS256.txt"
fi
WANT=$(grep "node-$NODE-win-x64.zip" $CACHE/SHASUMS256.txt | cut -d' ' -f1)
[ "$WANT" = "$(shasum -a 256 "$Z" | cut -d' ' -f1)" ] || { echo "checksum mismatch"; rm -f "$Z"; exit 1; }
[ -f $CACHE/node.exe ] || unzip -q -j "$Z" "node-$NODE-win-x64/node.exe" -d $CACHE

# 4. assemble
NAME=CC-1-win-x64-native
OUT=../dist/$NAME; rm -rf "$OUT"; mkdir -p "$OUT/node" "$OUT/app"
cp -R bin/out/. "$OUT/"
find "$OUT" -maxdepth 1 \( -name "*.pdb" -o -name "*.xml" -o -name "*.Wpf.dll" \) -delete
cp $CACHE/node.exe "$OUT/node/node.exe"
cp ../server.js ../VERSION update.cmd "$OUT/app/"; cp -R ../public "$OUT/app/public"
cp README.txt "$OUT/README.txt"
rm -f ../dist/CC-1-$VER-win-x64-native.zip
(cd ../dist && zip -qry CC-1-$VER-win-x64-native.zip $NAME)
find "$OUT" -maxdepth 2 | sed "s|$OUT||" | head -30
ls -lh ../dist/CC-1-$VER-win-x64-native.zip
