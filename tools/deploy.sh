#!/usr/bin/env bash
# deploy.sh -- one-shot deploy of the 151 Machine on the PC, with verification.
# Permanent replacement for the old multi-step /deploy ceremony.
#
# THE single deploy/restart flow: one command,
# fresh code on the PC, restarted, dictation-guarded, health-checked.
# Replaces bare `pm2 restart`.
# [2026-10-12] Il Pi non riceve più la Machine:
# niente più deploy-pi.sh, hash del Pi, attesa del Pi né --no-pi. Il telefono
# parla solo col PC dalla 1.19. Storia: git log -- tools/deploy-pi.sh.
#
# Flow:
#   0. re-launch DETACHED (setsid) so PM2 killing the PC's process tree at
#      step 5 cannot kill the deploy itself before it verifies the restart
#   1. detect changed .js files (mtime since last successful deploy)
#   2. node -c syntax check on each
#   3. stamp content-stable CODE_HASH (LC_ALL=C — deterministic)
#   4. capture pre-deploy hash on the PC
#   4.5 DICTATION GUARD: wait until no client is recording/transcribing
#   5. POST /api/deploy to PC (auto-picks full vs hot from changed paths)
#   6. wait for PC BUILD_HASH to change → confirms restart
#   7. PC smoke: /api/health ok=true, codeHash == stamped tree, deploy-smoke.sh
#   8. touch tools/.last-deploy → next run's mtime cutoff; one-line summary
# Clients (phone + desktop) show the restart overlay during the bounce and
# auto-reload on the new codeHash — no manual refresh ever.
#
# Exit non-zero on any failure. Does NOT auto-rollback.
#
# Flags:
#   --hot         force hot reload (server.js changes need full — script
#                 detects this automatically, this flag only forces ON tiny
#                 deploys that would otherwise hot-reload anyway)
#   --force       redeploy even when nothing changed
#   --dry-run     show plan, change nothing
#   -h | --help   this text

set -euo pipefail

# ── Config ──────────────────────────────────────────────────────────────────
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
REPO_DIR="$( cd "$SCRIPT_DIR/.." && pwd )"
cd "$REPO_DIR"

# ── 0. SOPRAVVIVERE AL PROPRIO RIAVVIO (2026-08-19) ──────────────────────────
#
# Perché questo blocco esiste, e perché è la PRIMA cosa che fa lo script.
#
# Al passo 5 lo script chiede al PC di riavviarsi (POST /api/deploy); PM2
# riavvia l'app AMMAZZANDO TUTTO L'ALBERO dei suoi processi figli. Ma il deploy
# quasi sempre parte da dentro una sessione della Machine (il bottone «ricarica»
# compreso) — cioè è esso stesso un figlio di quell'app. Risultato: lo script si
# ammazzava da solo esattamente lì, exit 137, prima di verificare il riavvio
# (allora anche prima di arrivare al Pi, che dal 12/10/2026 non c'è più).
#
# La cura: al primo avvio lo script si RILANCIA in una sessione di processi
# tutta sua (setsid = fuori dall'albero dell'app, quindi la mattanza di PM2 non
# lo tocca) e il processo chiamante resta a guardare il log. Se il chiamante
# viene ucciso, il deploy vero PROSEGUE lo stesso fino al DEPLOY OK.
#
# Chi guarda dal terminale non si accorge di niente: vede l'output scorrere
# uguale a prima, in diretta, e riprende lo stesso codice di uscita.
# --dry-run e --help non riavviano niente, quindi non si staccano: sarebbe solo
# un giro di rete in più per due righe di testo.
if [ -z "${DEPLOY_DETACHED:-}" ]; then
  _SKIP_DETACH=false
  for _a in "$@"; do
    case "$_a" in --dry-run|-h|--help) _SKIP_DETACH=true ;; esac
  done
  if ! $_SKIP_DETACH; then
    _LOGDIR="$HOME/.151machine/deploy-logs"
    mkdir -p "$_LOGDIR"
    _LOG="$_LOGDIR/deploy-$(date +%Y%m%d-%H%M%S).log"
    _STATUS="$_LOG.status"
    # Il log si annuncia PRIMA di staccarsi: se il chiamante muore a metà, questa
    # riga è già uscita ed è l'unico modo di sapere dove guardare.
    printf "[INFO]  deploy staccato dall'albero dei processi — log: %s\n" "$_LOG"
    # $0 dentro `bash -c` = il primo argomento dopo la stringa, cioè _STATUS;
    # "$@" = script + flag originali. Lo stato d'uscita finisce su file perché il
    # pid di setsid non è affidabile (setsid fa fork se è già capogruppo).
    DEPLOY_DETACHED=1 setsid nohup bash -c 'bash "$@"; echo $? > "$0"' \
      "$_STATUS" "$SCRIPT_DIR/$(basename "${BASH_SOURCE[0]}")" "$@" \
      > "$_LOG" 2>&1 < /dev/null &
    # Segue il log in diretta finché il figlio non deposita il suo stato.
    ( tail -n +1 -F "$_LOG" 2>/dev/null ) &
    _TAILPID=$!
    _waited=0
    while [ ! -f "$_STATUS" ] && [ $_waited -lt 900 ]; do sleep 1; _waited=$((_waited+1)); done
    sleep 1
    kill "$_TAILPID" 2>/dev/null || true
    wait "$_TAILPID" 2>/dev/null || true
    if [ -f "$_STATUS" ]; then
      exit "$(cat "$_STATUS")"
    fi
    printf "[WARN]  deploy ancora in corso dopo 15 minuti — segui: tail -f %s\n" "$_LOG"
    exit 0
  fi
fi

PC_URL="${DEPLOY_PC_URL:-http://localhost:3170}"
LAST_DEPLOY_FILE="$SCRIPT_DIR/.last-deploy"
HASH_TIMEOUT=30   # seconds to wait for PC hash to change

# ── Colours ─────────────────────────────────────────────────────────────────
if [ -t 1 ]; then
  RED='\033[0;31m'; GRN='\033[0;32m'; CYA='\033[0;36m'; YEL='\033[0;33m'
  BLD='\033[1m'; NC='\033[0m'
else
  RED=''; GRN=''; CYA=''; YEL=''; BLD=''; NC=''
fi
info()  { printf "${CYA}[INFO]${NC}  %s\n"  "$*"; }
ok()    { printf "${GRN}[OK]${NC}    %s\n"  "$*"; }
warn()  { printf "${YEL}[WARN]${NC}  %s\n"  "$*"; }
_FAIL_LOGGED=0
fail()  {
  printf "${RED}[FAIL]${NC}  %s\n"  "$*" >&2
  # Observatory: a deploy that did not land. One-shot (first fail only) +
  # fire-and-forget — logging must never change deploy behaviour. Skip dry-runs.
  if [ "$_FAIL_LOGGED" = "0" ] && [ "${DRY_RUN:-false}" != "true" ] && [ "${EVENTS_LOG:-1}" != "0" ]; then
    _FAIL_LOGGED=1
    local _ed="${EVENTS_DIR:-$HOME/.151machine/events}"
    local _msg; _msg=$(printf '%s' "$*" | tr -d '"\\' | cut -c1-160)
    mkdir -p "$_ed" 2>/dev/null \
      && printf '{"ts":"%s","event":"deploy_failed","reason":"%s"}\n' \
         "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" "$_msg" \
         >> "$_ed/events.jsonl" 2>/dev/null || true
  fi
}
step()  { printf "\n${BLD}── %s ──${NC}\n" "$*"; }

# ── Flags ───────────────────────────────────────────────────────────────────
FORCE_HOT=false
DRY_RUN=false
FORCE=false
for arg in "$@"; do
  case "$arg" in
    --hot)     FORCE_HOT=true ;;
    --dry-run) DRY_RUN=true ;;
    --force)   FORCE=true ;;
    -h|--help)
      sed -n '2,35p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      fail "Unknown flag: $arg"; exit 1 ;;
  esac
done

START=$(date +%s)

# ── 1. Detect changed files ─────────────────────────────────────────────────
step "Detect changes"

# If sentinel missing, fall back to last 2h. Always limited to tracked source
# trees so we never pick up node_modules, *.bak, /tmp scratch, etc.
SEARCH_DIRS=(server public plugins package.json ecosystem.linux.config.js)
PRUNE='( -path */node_modules -o -path */.cache -o -path */__pycache__ -o -path */.venv -o -path */venv -o -path */.git -o -path server/logs -o -name *.bak -o -name *.bak.* -o -name *.bak-* -o -name *.tmp -o -name *.log -o -name sessions.json -o -name .usage-log.jsonl -o -name .state.json -o -name .csv-baseline.json -o -name .csv-decisions.json -o -name .sync-status.json -o -name .download.lock -o -name .storage-state.json -o -name .analisi.json -o -name .scorta-*.json -o -name .chain.json -o -name .download-result.json -o -name .hetzner-copy.json -o -name .spotify-tokens.json -o -name .fetch.log -o -name .progress.json -o -name .download.log -o -name .download-status.json -o -name .last-deploy ) -prune'

# Source-only filter applied to the find output so a heap of synced .log files
# never trip a "files changed" deploy. (Was mirrored by the Pi sync's exclusion
# set until 2026-10-12, when the Pi sync was removed.)
filter_source() {
  grep -Ev '(^|/)(build-hash\.txt|sessions\.json|\.usage-log\.jsonl|\.state\.json|\.csv-baseline\.json|\.csv-decisions\.json|\.sync-status\.json|\.download\.lock|\.storage-state\.json|\.analisi\.json|\.scorta-.*\.json|\.chain\.json|\.download-result\.json|\.hetzner-copy\.json|\.spotify-tokens\.json|\.fetch\.log|\.progress\.json|\.download(-status)?\.log|\.download-status\.json|.*\.bak([.-].*)?|.*\.log|.*\.tmp|.*~)$' \
   | grep -Ev '(^|/)(server/logs/|node_modules/|\.cache/)' \
   || true
}

if [ -f "$LAST_DEPLOY_FILE" ]; then
  info "Since: $(date -r "$LAST_DEPLOY_FILE" '+%Y-%m-%d %H:%M:%S')"
  # shellcheck disable=SC2086
  CHANGED=$(find "${SEARCH_DIRS[@]}" -type d $PRUNE -o -type f -newer "$LAST_DEPLOY_FILE" -print 2>/dev/null | filter_source | sort -u || true)
else
  info "First run — using last 2h as fallback"
  # shellcheck disable=SC2086
  CHANGED=$(find "${SEARCH_DIRS[@]}" -type d $PRUNE -o -type f -mmin -120 -print 2>/dev/null | filter_source | sort -u || true)
fi

if [ -z "$CHANGED" ]; then
  CHANGED=""
fi

CHANGED_COUNT=$(printf "%s\n" "$CHANGED" | grep -c . || true)
if [ "$CHANGED_COUNT" -gt 0 ]; then
  info "Changed files ($CHANGED_COUNT):"
  printf "  %s\n" $CHANGED
fi

# ── Zero-change guard: NEVER restart for nothing ────────────────────────────
# A deploy that changes 0 files used to "deploy anyway" → a full restart that
# bounced the server (and every live session) for no reason. That redundant
# bounce is the restart-loop aggravator. Refuse it. Recovery restarts use pm2;
# a genuine re-push of identical code is --force.
if [ "$CHANGED_COUNT" -eq 0 ] && ! $FORCE; then
  ok "Nothing changed since last deploy — skipping (no restart)."
  info "Use --force to redeploy byte-identical code, or pm2 to restart."
  exit 0
fi

# ── 2. Syntax check changed .js ─────────────────────────────────────────────
if [ "$CHANGED_COUNT" -gt 0 ]; then
  step "Syntax check"
  JS_FILES=$(printf "%s\n" "$CHANGED" | grep '\.js$' || true)
  if [ -n "$JS_FILES" ]; then
    while IFS= read -r f; do
      if ! node -c "$f" 2>&1; then
        fail "Syntax error in $f"; exit 1
      fi
    done <<< "$JS_FILES"
    ok "All .js files parse"
  else
    info "No .js files in changeset"
  fi
fi

# ── 3. Decide mode ──────────────────────────────────────────────────────────
step "Mode"
NEEDS_FULL=false
if [ "$CHANGED_COUNT" -eq 0 ]; then
  NEEDS_FULL=true   # play safe when we don't know what changed
fi
while IFS= read -r f; do
  case "$f" in
    server/*|plugins/*/server.js|plugins/*/manifest.json|plugins/_registry.json|package.json|ecosystem*.js|.env)
      NEEDS_FULL=true ;;
  esac
done <<< "$CHANGED"

if $FORCE_HOT && ! $NEEDS_FULL; then
  MODE=hot
elif $NEEDS_FULL; then
  MODE=full
else
  MODE=hot
fi
info "Mode: $MODE"

if $DRY_RUN; then
  ok "Dry-run complete — nothing deployed"
  exit 0
fi

# ── 3.5 Stamp content-stable CODE_HASH ───────────────────────────────────────
# server/build-hash.txt holds a hash of the deployed SOURCE content. The server
# reads it as CODE_HASH → drives client asset ?v= + the reload trigger, so the
# client only reloads on a REAL code change (not on every restart, where the
# per-boot BUILD_HASH nonce changes). Excludes build-hash.txt
# itself + runtime state so the hash reflects code only and is order-stable.
# 2026-08-16: LC_ALL=C on the sort — the ambient locale (it_IT) collates
# case-insensitively and skips punctuation, so the hash depended on the machine
# locale. C = bytewise = deterministic, and matches the server's own live
# compute (server/build-hash.js computeContentHash, Buffer.compare order).
step "Stamp code hash"
# public/plugins escluso (29/09/2026): copie rigenerate dal server DOPO questo
# timbro → falso rosso «Code equality». Vedi server/build-hash.js CONTENT_ROOTS.
CODE_HASH=$(find server public/js public/css plugins -type f \
    \( -name '*.js' -o -name '*.css' -o -name '*.html' -o -name '*.json' \) \
    ! -name 'build-hash.txt' \
    ! -path '*/node_modules/*' ! -path '*/.cache/*' ! -path '*/.venv/*' \
    ! -path '*/venv/*' ! -path '*/__pycache__/*' ! -path '*/.git/*' \
    ! -name 'sessions.json' ! -name '.state.json' ! -name '.storage-state.json' \
    ! -name '.csv-baseline.json' ! -name '.csv-decisions.json' \
    ! -name '.sync-status.json' ! -name '.download.lock' \
    ! -name '.spotify-tokens.json' ! -name '.chain.json' \
    ! -name '.download-result.json' ! -name '.analisi.json' \
    ! -name '.hetzner-copy.json' \
    ! -name '.scorta-*.json' \
    -print0 2>/dev/null | LC_ALL=C sort -z | xargs -0 sha256sum 2>/dev/null \
    | sha256sum | cut -c1-12)
if [ -z "$CODE_HASH" ]; then
  fail "Could not compute code hash"; exit 1
fi
printf '%s\n' "$CODE_HASH" > server/build-hash.txt
ok "CODE_HASH: $CODE_HASH (server/build-hash.txt)"

# ── 4. Pre-deploy state ─────────────────────────────────────────────────────
step "Pre-deploy"

get_hash() {
  curl -fsS --max-time 5 "$1/api/build-hash" 2>/dev/null \
    | python3 -c "import sys,json;print(json.load(sys.stdin).get('hash',''))" 2>/dev/null \
    || echo ""
}
get_health_ok() {
  curl -fsS --max-time 5 "$1/api/health" 2>/dev/null \
    | python3 -c "import sys,json;print('1' if json.load(sys.stdin).get('ok') else '0')" 2>/dev/null \
    || echo "0"
}
# Content hash of the code a box is actually serving (server/index.js
# /api/health → codeHash). Distinct from /api/build-hash, which is a per-boot
# nonce: that one proves a restart happened, this one proves WHICH code came up.
get_code_hash() {
  curl -fsS --max-time 5 "$1/api/health" 2>/dev/null \
    | python3 -c "import sys,json;print(json.load(sys.stdin).get('codeHash') or '')" 2>/dev/null \
    || echo ""
}

PC_HASH_PRE=$(get_hash "$PC_URL")
if [ -z "$PC_HASH_PRE" ]; then
  fail "PC unreachable at $PC_URL — is 151-machine running? Try: pm2 restart 151-machine"
  exit 1
fi
ok "PC hash (before): $PC_HASH_PRE"

# ── 4.5 Dictation guard (punto 4, 2026-08-16) ───────────────────────────────
# Never bounce a server while someone is recording a voice note or waiting for
# a transcription. The server exposes GET /api/restart-readiness (public, like
# /api/health): {ready, recording, transcribing}. We poll until it is clear,
# then proceed on our own ("parte da solo"). A missing endpoint (older server)
# or unreachable box counts as ready — the guard must never brick a deploy.
# The server's restart funnel (server/restart-control.js) runs the same wait
# in-process as a second guard. Timeout: DICTATION_WAIT_TIMEOUT (default 20 min).
DICTATION_WAIT_TIMEOUT="${DICTATION_WAIT_TIMEOUT:-1200}"

readiness_of() {
  # → EXACTLY one line: "ready" | "busy rec=N tx=M".
  # Any failure — endpoint missing on older server, 401 error body, timeout,
  # unreachable, malformed JSON, unexpected shape — counts as ready. The guard
  # must NEVER wedge a deploy on infrastructure noise.
  #
  # Round #2 root cause (2026-08-16): the earlier version used
  #   out=$(curl -fsS … | python3 -c '… fallback print("ready") …') || out="ready"
  # Under `set -o pipefail`, curl -f made the pipeline fail on any non-2xx, so
  # BOTH python's fallback print AND the `|| out=ready` fired. python's stdout
  # ("ready\n") was captured into $out AND the `||` branch overwrote it with
  # "ready" — but earlier variants without the `|| out=…` guard let a double
  # "ready\nready" reach the caller. `head -n 1` guards the tail, but this
  # rewrite makes the double-line impossible by construction: HTTP status is
  # captured separately (curl -o/-w, NO -f) so python only ever runs on a real
  # body when the status is 2xx, and python is the SOLE stdout producer.
  local body http rc
  body=$(curl -sS --max-time 5 -o - -w '\n@@HTTP@@%{http_code}' "$1/api/restart-readiness" 2>/dev/null || true)
  http="${body##*@@HTTP@@}"
  body="${body%$'\n'@@HTTP@@*}"
  rc=$(HTTP="$http" BODY="$body" python3 - <<'PY' 2>/dev/null
import os, json
http = (os.environ.get('HTTP') or '').strip()
body = os.environ.get('BODY') or ''
# Non-2xx (401 on old Pi code, 404, 5xx) or empty body → ready.
if not http.startswith('2') or not body.strip():
    print('ready'); raise SystemExit(0)
try:
    d = json.loads(body)
except Exception:
    print('ready'); raise SystemExit(0)
# Real payload: {ready, recording, transcribing}. Anything else → ready.
if not isinstance(d, dict) or 'ready' not in d:
    print('ready'); raise SystemExit(0)
if d.get('ready') is True:
    print('ready')
else:
    print('busy rec=%s tx=%s' % (d.get('recording', 0), d.get('transcribing', 0)))
PY
)
  # Belt-and-suspenders: if python somehow died / emitted nothing, force "ready".
  printf '%s\n' "${rc:-ready}" | awk 'NF{print;exit} END{if(!NR)print "ready"}'
}

wait_dictation_clear() {
  local label="$1" url="$2" waited=0 st
  st=$(readiness_of "$url")
  [ "$st" = "ready" ] && return 0
  warn "$label: vocale/trascrizione in corso ($st) — aspetto che il testo sia consegnato..."
  while [ $waited -lt "$DICTATION_WAIT_TIMEOUT" ]; do
    sleep 5; waited=$((waited + 5))
    st=$(readiness_of "$url")
    if [ "$st" = "ready" ]; then ok "$label: dettatura conclusa (${waited}s) — si riparte"; return 0; fi
    if [ $((waited % 30)) -eq 0 ]; then info "$label: ancora in corso ($st, ${waited}s)"; fi
  done
  warn "$label: timeout dopo ${DICTATION_WAIT_TIMEOUT}s — procedo comunque"
  return 0
}

step "Dictation guard"
wait_dictation_clear "PC" "$PC_URL"
ok "Nessuna registrazione in corso — via libera"

# ── 5. POST /api/deploy ─────────────────────────────────────────────────────
step "PC deploy"

FILES_JSON=$(printf "%s\n" $CHANGED | python3 -c "
import sys,json
lines=[l.strip() for l in sys.stdin if l.strip()]
print(json.dumps(lines))")

PAYLOAD=$(FORCE_FLAG=$($FORCE && echo true || echo false) python3 -c "
import json,sys,os
print(json.dumps({
  'mode': '$MODE',
  'session_id': '',
  'commit_msg': 'deploy.sh — $CHANGED_COUNT file(s)',
  'files_changed': json.loads('''$FILES_JSON'''),
  'force': os.environ.get('FORCE_FLAG') == 'true',
}))")

deploy_once() {
  curl -fsS -X POST "$PC_URL/api/deploy" \
    -H 'Content-Type: application/json' \
    -H 'x-caller: deploy-sh' \
    -d "$PAYLOAD" 2>&1 || true
}

RESP=$(deploy_once)
if echo "$RESP" | grep -q deploy_in_progress; then
  warn "Another deploy in progress, retrying in 3s..."
  sleep 3
  RESP=$(deploy_once)
fi
if ! echo "$RESP" | grep -q '"status"'; then
  fail "Deploy request failed: $RESP"; exit 1
fi
ok "Deploy accepted: $RESP"

# ── 6. Wait for PC restart ──────────────────────────────────────────────────
step "PC ready"

elapsed=0
while [ $elapsed -lt $HASH_TIMEOUT ]; do
  NEW=$(get_hash "$PC_URL")
  if [ -n "$NEW" ] && [ "$NEW" != "$PC_HASH_PRE" ]; then
    PC_HASH_POST="$NEW"
    break
  fi
  sleep 1
  elapsed=$((elapsed + 1))
done

if [ -z "${PC_HASH_POST:-}" ]; then
  fail "PC hash did not change in ${HASH_TIMEOUT}s — deploy may have failed. Check: pm2 logs 151-machine --lines 40"
  exit 1
fi
ok "PC hash (after):  $PC_HASH_POST  ($((elapsed + 1))s)"

if [ "$(get_health_ok "$PC_URL")" != "1" ]; then
  fail "PC /api/health not ok after deploy"; exit 1
fi
ok "PC /api/health: ok"

# ── 7. [2026-10-12] Il passo «Pi sync» (deploy-pi.sh + attesa dell'hash del Pi)
# non c'è più: la Machine non vive più sul Pi.

# ── 7.4 Code equality gate ──────────────────────────────────────────────────
# Everything above only proves the daemon RESTARTED (/api/build-hash is a
# per-boot nonce — it changes even when zero code changed). This asserts the one
# thing that actually matters: the PC is serving byte-identical code to the tree
# we just stamped.
step "Code equality"
PC_CODE=$(get_code_hash "$PC_URL")
if [ -z "$PC_CODE" ]; then
  fail "PC did not report codeHash on /api/health — the new server code is not running there."
  fail "  Check: pm2 logs 151-machine --lines 40"
  exit 1
fi
if [ "$PC_CODE" != "$CODE_HASH" ]; then
  fail "PC is serving code that is NOT what we just stamped."
  fail "  stamped (tree): $CODE_HASH"
  fail "  serving (PC):   $PC_CODE"
  fail "  The PC restarted but came up on different content. Check: pm2 logs 151-machine --lines 40"
  exit 1
fi
ok "PC codeHash matches the stamped tree: $PC_CODE"

# ── 7.5 Full smoke test ─────────────────────────────────────────────────────
# Belt-and-suspenders verification: pm2 status of both daemons + /api/version
# + session-host TCP ack. /api/health and /api/build-hash were already
# checked inline above; the smoke covers the remaining surface.
step "Smoke test"
if [ -x "$SCRIPT_DIR/deploy-smoke.sh" ]; then
  if ! "$SCRIPT_DIR/deploy-smoke.sh"; then
    fail "Post-deploy smoke failed — server is up but some surface is wrong."
    exit 1
  fi
else
  warn "deploy-smoke.sh missing or not executable — skipping deep smoke"
fi

# ── 8. Mark deploy success ──────────────────────────────────────────────────
touch "$LAST_DEPLOY_FILE"

# ── 8.5 [2026-10-12] Il passo che rimetteva in ordine le copie locali dei
# portali esterni (5001-5003) non c'è più: la Machine non entra più nei portali
#. Le copie, se restano sotto pm2, sono una scelta.

# ── 9. Summary ──────────────────────────────────────────────────────────────
END=$(date +%s)
ELAPSED=$((END - START))

echo
printf "${BLD}═══════════════════════════════════════${NC}\n"
printf "${BLD}  DEPLOY OK${NC}\n"
printf "${BLD}═══════════════════════════════════════${NC}\n"
printf "  Files:   %d changed\n" "$CHANGED_COUNT"
printf "  Mode:    %s\n" "$MODE"
printf "  PC:      %s → ${GRN}%s${NC}\n" "$PC_HASH_PRE" "$PC_HASH_POST"
printf "  Elapsed: %ds\n" "$ELAPSED"
echo

# ── 10. Observatory stamp ────────────────────────────────────────────────────
# Record this deploy in the same event log the server writes to, so the #1
# action shows up in the system's self-view. Fire-and-forget: a logging hiccup
# must never fail an otherwise-successful deploy. Kill switch: EVENTS_LOG=0.
if [ "${EVENTS_LOG:-1}" != "0" ]; then
  EVENTS_DIR="${EVENTS_DIR:-$HOME/.151machine/events}"
  mkdir -p "$EVENTS_DIR" 2>/dev/null \
    && printf '{"ts":"%s","event":"deploy","mode":"%s","files":%s,"duration_ms":%s}\n' \
       "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" "$MODE" "${CHANGED_COUNT:-0}" "$((ELAPSED * 1000))" \
       >> "$EVENTS_DIR/events.jsonl" 2>/dev/null || true
fi
