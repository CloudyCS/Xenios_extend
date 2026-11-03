#!/bin/zsh
# Builds the client harness and runs it against the local Worker.
#   run.sh OUT_DIR
# OUT_DIR gets the binary, a throwaway home for the app code, the server's data
# and logs. Nothing leaves 127.0.0.1.
set -euo pipefail
out=${1:?usage: run.sh OUT_DIR}
here=${0:A:h}
src=${here:h:h:h:h}/src
diag=${here:h}
key=harness-attestation-key-not-a-secret
port=8788
mkdir -p $out
rm -rf $out/home $out/server
mkdir -p $out/home

clang++ -std=c++20 -O1 -g -fno-objc-arc -Wall -Wno-unused-function \
  -I $here/shim -I $src \
  $here/harness.mm \
  $src/xenia/ui/ios/shared/ios_diagnostics_outbox.mm \
  $src/xenia/ui/ios/shared/ios_session_stats.mm \
  $src/xenia/ui/ios/shared/ios_fault_record.mm \
  $src/xenia/ui/ios/shared/ios_online_features.mm \
  -framework Foundation -lz -o $out/xenios-diag-harness

if lsof -nP -iTCP:$port -sTCP:LISTEN >/dev/null 2>&1; then
  echo "port $port is busy (a server from an earlier run?)" >&2
  exit 1
fi
ATTESTATION_KEY=$key node $diag/dev/server.mjs $out/server $port > $out/server.log 2>&1 &
server=$!
trap 'kill $server 2>/dev/null; defaults delete xenios-diag-harness >/dev/null 2>&1 || true' EXIT
sleep 1
result=0
CFFIXED_USER_HOME=$out/home XENIOS_TEST_ATTESTATION_KEY=$key \
  $out/xenios-diag-harness http://127.0.0.1:$port/v1/diag > $out/harness.log 2>&1 || result=$?
curl -s -X POST http://127.0.0.1:$port/__cron > /dev/null || result=1
sqlite3 -header $out/server/d1.sqlite \
  "SELECT build_id, official, model, title_id, end_reason, median_fps, low1_fps, stutter_pct,
     first_frame_ms, pipelines_compiled, stored_pipelines, gpu_errors FROM sessions;
   SELECT build_id, official, source, kind, title_id, signature FROM crashes;" > $out/server-rows.txt
grep -E '^(PASS|FAIL|ALL|FAILED)' $out/harness.log
exit $result
