#!/bin/sh
set -eu
echo '[Startup] Container entry reached; starting Xvfb and one-shot monitor (840s limit)'
set +e
timeout --verbose --signal=TERM --kill-after=10s 840s xvfb-run -a -e /dev/stderr node dist/src/index.js --run-once
result=$?
set -e
echo "[Startup] Monitor process exited: $result"
exit "$result"
