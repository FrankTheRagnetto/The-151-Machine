#!/usr/bin/env bash
# tools/test-istanza.sh — the whole suite, LIVE tests included, against a
# throwaway copy of this working tree.
#
# It copies the tree to /tmp/gate-istanza-XXXXXXXX, starts it on an ephemeral
# port given by the kernel (never your real port), with a fake HOME (no real
# sessions, memory or trash) and without the session-host daemon, points
# tests/run-all.js at it and always kills it at the end (tools/gate-istanza.sh).
#
# Usage: npm run test:instance      (needs git, curl, and `npm install` done)
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 1
. tools/gate-istanza.sh
trap gate_istanza_spegni EXIT INT TERM HUP
gate_istanza_accendi || { echo "the throwaway instance did not start"; exit 1; }
echo "throwaway instance on $GATE_ISTANZA_BASE"
TEST_HOST="$GATE_ISTANZA_BASE" SMOKE_ENV_FILE="$GATE_ISTANZA_DIR/.env" node tests/run-all.js "$@"
