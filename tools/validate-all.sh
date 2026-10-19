#!/bin/sh
# Run every validation in the repo. Exit 1 if any fails. Needs work/ (tools/setup-workspace.sh).
cd "$(dirname "$0")/.."
fail=0
run() { printf '%-28s ' "$1"; shift; if out=$("$@" 2>&1); then echo "PASS  $(echo "$out" | tail -1)"; else echo "FAIL"; echo "$out" | tail -5; fail=1; fi; }
PKG=$(sed -n 's/^package \(.*\);/\1./p' docs/proto/*.proto)
run "schema: protoc"     sh -c "cd docs/proto && protoc -I . -I \"\${PROTOC_INCLUDE:-/opt/anaconda3/include}\" --descriptor_set_out=/dev/null *.proto && echo ok"
run "schema: wire tags"  node --max-old-space-size=8192 tools/verify-proto-wire.mjs work/app/.webpack/main/index.js docs/proto/*.proto "$PKG"
run "01 audio capture"   node tools/audio-validate.mjs
[ -f tools/transport-verify.mjs ] && run "02 transport" node tools/transport-verify.mjs
run "03 trigger/context" node tools/ctx-validate.mjs
run "04 status pill"     node tools/gui-verify.mjs
[ -f .brandrules ] && run "brand name absent" tools/debrand.sh --check
exit $fail
