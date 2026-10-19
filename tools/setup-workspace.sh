#!/bin/sh
# Recreate the gitignored analysis workspace every validator reads:
#   work/app     the app.asar, extracted
#   work/pretty  prettier-formatted copies of the main and renderer bundles (the line numbers cited in docs/)
# Usage: tools/setup-workspace.sh "/Applications/<App>.app"
set -e
APP="$1"
[ -d "$APP/Contents/Resources" ] || { echo "usage: $0 /Applications/<App>.app" >&2; exit 2; }
cd "$(dirname "$0")/.."
rm -rf work && mkdir -p work/pretty/main
npx -y @electron/asar@3.2.17 extract "$APP/Contents/Resources/app.asar" work/app
W=work/app/.webpack
for f in "$W"/main/*.js; do
  npx -y prettier@3.3.3 --parser babel "$f" > "work/pretty/main/$(basename "$f")"
done
for d in "$W"/renderer/*/; do
  n=$(basename "$d"); [ -f "$d/index.js" ] || continue
  mkdir -p "work/pretty/renderer/$n"
  for f in index.js preload.js; do
    [ -f "$d/$f" ] && npx -y prettier@3.3.3 --parser babel "$d/$f" > "work/pretty/renderer/$n/$f"
  done
done
(cd tools && npm install --silent)
echo "workspace ready"
