#!/usr/bin/env bash
# Gate for tools/deploy.sh readiness_of() (round #2 fix, 2026-08-16).
# Contract: EXACTLY one line of output, always. On any endpoint failure
# (unreachable, 401, non-JSON, missing 'ready' key), print "ready" so the
# guard proceeds. On a real payload with ready:false, print "busy rec=… tx=…".
#
# Runs a tiny python HTTP server that flips response mode per URL path so we
# can exercise every branch without touching the live 151-machine process.

set -euo pipefail
set -o pipefail   # SAME setting as deploy.sh — reproduces the wedge condition

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
REPO="$( cd "$SCRIPT_DIR/.." && pwd )"

# Source readiness_of() by extracting it from deploy.sh — no side effects.
eval "$(awk '/^readiness_of\(\)/,/^\}$/' "$REPO/tools/deploy.sh")"

PORT=${TEST_PORT:-38517}
python3 - "$PORT" <<'PY' &
import sys, json
from http.server import BaseHTTPRequestHandler, HTTPServer
class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        p = self.path
        # readiness_of appends "/api/restart-readiness" to the base URL. The
        # base URL carries the SCENARIO in the path, so we route on that.
        if '/ready/' in p:
            self._json(200, {'ready': True, 'recording': 0, 'transcribing': 0})
        elif '/busy/' in p:
            self._json(200, {'ready': False, 'recording': 1, 'transcribing': 2})
        elif '/401/' in p:
            self._json(401, {'error': 'Unauthorized'})
        elif '/garbage/' in p:
            self.send_response(200); self.end_headers(); self.wfile.write(b'not json {{{')
        elif '/empty/' in p:
            self.send_response(200); self.end_headers()
        elif '/wrongshape/' in p:
            self._json(200, {'hello': 'world'})
        else:
            self.send_response(404); self.end_headers()
    def _json(self, code, obj):
        b = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header('Content-Type','application/json')
        self.send_header('Content-Length', str(len(b)))
        self.end_headers()
        self.wfile.write(b)
HTTPServer(('127.0.0.1', int(sys.argv[1])), H).serve_forever()
PY
SRV_PID=$!
trap 'kill $SRV_PID 2>/dev/null || true' EXIT
# Wait for server to bind
for _ in $(seq 1 40); do
  if curl -fsS --max-time 1 "http://127.0.0.1:$PORT/ready/api/restart-readiness" >/dev/null 2>&1; then break; fi
  sleep 0.1
done

pass=0; fail=0
check() {
  local label="$1" want="$2" got="$3"
  # Reject multi-line output at the SOURCE (the whole point of this test):
  # `st` set from readiness_of() must be a single word suitable for `[ "$st" = "ready" ]`.
  local lines; lines=$(printf '%s' "$got" | wc -l | tr -d ' ')
  if [ "$lines" -gt 0 ]; then
    echo "FAIL: $label -- multi-line output: $(printf '%s' "$got" | tr '\n' '|')"; fail=$((fail+1)); return
  fi
  if [ "$got" != "$want" ]; then
    echo "FAIL: $label -- want '$want' got '$got'"; fail=$((fail+1)); return
  fi
  echo "PASS: $label -- '$got'"; pass=$((pass+1))
}

# 1. Real ready payload → "ready"
st=$(readiness_of "http://127.0.0.1:$PORT/ready")
check "200 ready:true"     "ready"                     "$st"

st=$(readiness_of "http://127.0.0.1:$PORT/busy")
check "200 ready:false"    "busy rec=1 tx=2"           "$st"

st=$(readiness_of "http://127.0.0.1:$PORT/401")
check "401 Unauthorized"   "ready"                     "$st"

st=$(readiness_of "http://127.0.0.1:$PORT/garbage")
check "200 non-JSON"       "ready"                     "$st"

st=$(readiness_of "http://127.0.0.1:$PORT/empty")
check "200 empty body"     "ready"                     "$st"

st=$(readiness_of "http://127.0.0.1:$PORT/wrongshape")
check "200 wrong shape"    "ready"                     "$st"

st=$(readiness_of "http://127.0.0.1:1")
check "unreachable box"    "ready"                     "$st"

# 8. Comparison actually flows through the guard on 401 (the wedge scenario)
st=$(readiness_of "http://127.0.0.1:$PORT/401")
if [ "$st" = "ready" ]; then
  echo "PASS: [ \"\$st\" = \"ready\" ] matches on 401 → guard proceeds"; pass=$((pass+1))
else
  echo "FAIL: guard would wedge on 401 (st='$st')"; fail=$((fail+1))
fi

echo
echo "readiness_of: $pass pass / $fail fail"
[ "$fail" -eq 0 ]
