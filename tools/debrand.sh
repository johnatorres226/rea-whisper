#!/bin/sh
# Strip the vendor brand name from repo files. Rules live in ./.brandrules (gitignored,
# because the rules themselves contain the name): one perl substitution per line, plus a
# `check:<regex>` line used by --check.
#   tools/debrand.sh            rewrite every tracked + untracked-not-ignored text file
#   tools/debrand.sh --check    exit 1 if any such file still matches (run before commit)
set -e
cd "$(dirname "$0")/.."
RULES=.brandrules
[ -f "$RULES" ] || { echo "missing $RULES" >&2; exit 2; }
PAT=$(sed -n 's/^check://p' "$RULES")
FILES=$(git ls-files -co --exclude-standard | grep -v '^tools/package-lock.json$')
if [ "$1" = "--check" ]; then
  HITS=$(echo "$FILES" | xargs grep -il -- "$PAT" 2>/dev/null || true)
  [ -z "$HITS" ] && { echo "brand check: clean"; exit 0; }
  echo "brand check: name found in:"; echo "$HITS"; exit 1
fi
SUBS=$(grep -v '^check:' "$RULES" | tr '\n' ';')
echo "$FILES" | xargs grep -il -- "$PAT" 2>/dev/null | while read -r f; do perl -pi -e "$SUBS" "$f"; echo "debranded $f"; done
