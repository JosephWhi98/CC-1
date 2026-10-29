#!/bin/zsh
# Build both apps and publish a GitHub release for the version in ./VERSION.
set -e
cd "$(dirname "$0")"
VER=$(tr -d '[:space:]' < VERSION)
TAG="v$VER"
[ -z "$(git status --porcelain)" ] || { echo "Commit your changes first (working tree is dirty)."; exit 1; }
grep -q "^## $VER" CHANGELOG.md || { echo "CHANGELOG.md has no '## $VER' section."; exit 1; }

./native/build.sh
./windows-native/build.sh
rm -f "dist/CC-1-$VER-mac.zip"
ditto -c -k --keepParent dist/CC-1.app "dist/CC-1-$VER-mac.zip"
ASSETS=("dist/CC-1-$VER-mac.zip" "dist/CC-1-$VER-win-x64-native.zip")

NOTES=$(awk -v v="## $VER" '$0 ~ "^"v {f=1; next} /^## /{f=0} f' CHANGELOG.md)
if command -v gh >/dev/null; then
  git tag -a "$TAG" -m "CC-1 $VER" 2>/dev/null || true
  git push origin HEAD "$TAG"
  gh release create "$TAG" "${ASSETS[@]}" --title "CC-1 $VER" --notes "$NOTES" $( [[ $VER == 0.* ]] && echo --prerelease )
else
  echo; echo "gh CLI not installed. Do it by hand:"
  echo "  git tag -a $TAG -m 'CC-1 $VER' && git push origin HEAD $TAG"
  echo "  then create a release for $TAG on GitHub and upload:"; printf '    %s\n' "${ASSETS[@]}"
fi
