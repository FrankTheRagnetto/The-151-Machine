#!/usr/bin/env bash
# tools/deploy-smoke.sh — Linux port of deploy-smoke.ps1
#
# Automated post-deploy smoke test. Call as final step of any PM2 restart
# workflow. Exits 0 on full green, 1 on any failure (with details printed).
#
# Checks:
#   1. PM2 reports both 151-machine + 151-session-host online
#   2. /api/health returns { ok: true }
#   3. /api/version answers 200 (was /api/restart-banner, removed 2026-10-12)
#   4. session-host TCP socket responds to {type:"ack"} ping (daemon alive)
#   5. session-host returns sessions list on {type:"list"} (daemon has state)
#
# Replaces the Windows PowerShell smoke that became unrunnable after the
# 2026-05-18 EndeavourOS migration. The named-pipe IPC was switched to TCP
# fallback on Linux (server/session-host/index.js TCP_FALLBACK_PORT=3172),
# so checks 4 & 5 talk to localhost:3172 instead of \\.\pipe\151-session-host.

set -uo pipefail

HOST_URL="${HOST_URL:-http://localhost:3170}"
SESSION_HOST_PORT="${SESSION_HOST_PORT:-3172}"

if [ -t 1 ]; then
  RED='\033[0;31m'; GRN='\033[0;32m'; CYA='\033[0;36m'; NC='\033[0m'
else
  RED=''; GRN=''; CYA=''; NC=''
fi

issues=()
fail() { issues+=("$1"); }
say()  { printf "${CYA}[deploy-smoke]${NC} %s\n" "$*"; }

say "Running post-deploy verification..."

# 1. PM2 state — both processes must be online
if ! command -v pm2 >/dev/null 2>&1; then
  fail "pm2 binary not on PATH"
else
  pm2_json="$(pm2 jlist 2>/dev/null || echo '[]')"
  for proc in 151-machine 151-session-host; do
    status=$(echo "$pm2_json" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
except Exception:
    print('parse-error'); sys.exit(0)
for p in data:
    if p.get('name') == '$proc':
        print(p.get('pm2_env', {}).get('status', 'unknown'))
        break
else:
    print('missing')
" 2>/dev/null)
    if [ "$status" != "online" ]; then
      fail "$proc is '$status' (expected online)"
    fi
  done
fi

# 2. /api/health
health="$(curl -fsS -m 5 "$HOST_URL/api/health" 2>/dev/null || echo '')"
if [ -z "$health" ]; then
  fail "/api/health unreachable"
else
  ok=$(echo "$health" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('ok', False))" 2>/dev/null || echo "False")
  if [ "$ok" != "True" ]; then
    fail "/api/health returned ok=$ok"
  else
    boot=$(echo "$health" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('boot','?'))" 2>/dev/null)
    sessions=$(echo "$health" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('sessions','?'))" 2>/dev/null)
    say "  health: ok=true, boot=$boot, sessions=$sessions"
  fi
fi

# 3. /api/version — must respond 200 (public route; replaces /api/restart-banner,
#    removed 2026-10-12 because no client read it any more)
version_code=$(curl -s -o /dev/null -w "%{http_code}" -m 5 "$HOST_URL/api/version" 2>/dev/null || echo "000")
if [ "$version_code" != "200" ]; then
  fail "/api/version status=$version_code"
fi

# 4 + 5. session-host TCP ping
# After the hello, `type:"list"` is the session-host's status-and-state query; it responds with
# {type:"ack", ok:true, sessions:[...]}. One ping covers both "daemon alive"
# (the ack) and "daemon has state" (the sessions array).
# [17/10/2026] The session-host refuses anyone without its key (/hack punto 1):
# first line {type:"hello", key} from ~/.151machine/session-host.key (never
# printed), then list. We print only the line that answers the list (the one
# with "sessions"); an older daemon answers hello with an error and still acks.
resp=$(python3 - <<PY 2>/dev/null
import socket, json, os
try:
    try:
        key = open(os.path.expanduser('~/.151machine/session-host.key')).read().strip()
    except Exception:
        key = ''
    s = socket.create_connection(('127.0.0.1', $SESSION_HOST_PORT), timeout=3)
    s.sendall((json.dumps({'type': 'hello', 'key': key}) + '\n').encode())
    s.sendall((json.dumps({'type': 'list', 'reqId': 'smoke'}) + '\n').encode())
    buf = b''
    s.settimeout(3)
    found = ''
    while not found:
        chunk = s.recv(4096)
        if not chunk: break
        buf += chunk
        for line in buf.decode(errors='replace').split('\n'):
            if '"sessions"' in line:
                found = line.strip()
                break
    s.close()
    print(found or ('NOACK:' + buf.decode(errors='replace')[:200].replace(key, '***') if key else 'NOACK'))
except Exception as e:
    print('ERR:' + str(e))
PY
)
if [[ "$resp" != *'"type":"ack"'* ]]; then
  fail "session-host did not ack list query (resp=${resp:0:200})"
else
  session_count=$(echo "$resp" | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d.get('sessions',[])))" 2>/dev/null || echo "?")
  say "  session-host: ack ok, $session_count sessions tracked"
fi

# Verdict
if [ ${#issues[@]} -eq 0 ]; then
  printf "${GRN}[deploy-smoke] ALL CHECKS PASSED${NC}\n"
  exit 0
else
  printf "${RED}[deploy-smoke] FAILURES (%d):${NC}\n" "${#issues[@]}"
  for i in "${issues[@]}"; do printf "  - %s\n" "$i"; done
  exit 1
fi
