#!/usr/bin/env bash
# pc-watchdog.sh — independent safety net for The 151 Machine on the PC peer.
#
# WHY: same gap as the Pi — if the web app (151-machine) dies and PM2 doesn't
# bring it back, the PC browser AND the phone (which proxies to the PC) lose
# service until a human notices. This cron watchdog closes that gap.
#
# SESSION SAFETY: this ONLY ever revives the 151-machine web app (--only).
# It must NEVER touch 151-session-host or whisper-stt: the session-host owns
# live CLI/SDK chats, and restarting it would kill active sessions. The
# watchdog acts only when the web app is already unhealthy (chats already
# affected), and recovers main alone — daemon + whisper left untouched.
#
# Installed via the PC user crontab:
#   * * * * * /path/to/the-151-machine/tools/pc-watchdog.sh
set -uo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PATH="$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

URL="http://127.0.0.1:3170/api/health"
ECO="$REPO/ecosystem.linux.config.js"
PM2="$(command -v pm2 || echo "$HOME/.local/bin/pm2")"
LOG="$REPO/tools/pc-watchdog.log"
LOCK="/tmp/pc-watchdog.lock"
COOLDOWN_FILE="/tmp/pc-watchdog.last-restart"
COOLDOWN_SECS=180
# Same restart.lock the in-process restart funnel writes (server/deploy.js
# RESTART_LOCK_PATH = <repo>/tmp/restart.lock). If a deploy/graceful-restart is
# in flight we must NOT bounce 151-machine on top of it (double restart = the
# crash-loop aggravator). TTL mirrors deploy.js (60s).
RESTART_LOCK="$REPO/tmp/restart.lock"
RESTART_LOCK_TTL=60

log() { echo "$(date '+%F %T') $*" >> "$LOG"; }

exec 9>"$LOCK" 2>/dev/null || exit 0
flock -n 9 || exit 0

PORT=3170

# True when a restart is genuinely in flight: lock file present, ts within TTL,
# and the holder pid is still alive. A stale/dead-pid lock is treated as free
# (mirrors deploy.js isRestartLockHeld). No jq/python dependency — the lock is a
# single-line JSON the funnel controls.
deploy_lock_held() {
  [ -f "$RESTART_LOCK" ] || return 1
  local raw pid ts now ts_s age
  raw=$(cat "$RESTART_LOCK" 2>/dev/null) || return 1
  pid=$(printf '%s' "$raw" | grep -oE '"pid":[0-9]+'  | head -1 | grep -oE '[0-9]+')
  ts=$(printf '%s'  "$raw" | grep -oE '"ts":[0-9]+'   | head -1 | grep -oE '[0-9]+')
  [ -n "$pid" ] && [ -n "$ts" ] || return 1
  now=$(date +%s)
  ts_s=$(( ts / 1000 ))            # deploy.js stores Date.now() in ms
  age=$(( now - ts_s ))
  [ "$age" -ge 0 ] && [ "$age" -lt "$RESTART_LOCK_TTL" ] || return 1  # stale → free
  kill -0 "$pid" 2>/dev/null || return 1                             # dead pid → free
  return 0
}

healthy() {
  curl -fsS -m 15 "$URL" 2>/dev/null | grep -q '"ok":true'
}

# TCP-level liveness: is anything accepting on the port? An ALIVE-but-busy
# server (event loop briefly blocked by SDK work, heavy request, etc.) still
# accepts connections even when /api/health is momentarily slow. A truly dead
# app refuses the connection. This is the gate that stops false-positive
# restarts from nuking a live session.
port_open() {
  timeout 3 bash -c "exec 3<>/dev/tcp/127.0.0.1/$PORT" 2>/dev/null
}

# If the restart funnel holds the lock, a deploy/graceful-restart is in flight —
# skip this whole tick so we never stack a second restart on top of it.
if deploy_lock_held; then
  log "restart.lock held (deploy/restart in flight) — skipping tick"
  exit 0
fi

# Ride out a legitimate restart window before acting: 5 probes over ~48s.
for i in 1 2 3 4 5; do
  if healthy; then exit 0; fi
  [ "$i" -lt 5 ] && sleep 12
done

# Health failed 5x over ~48s. Before restarting, make sure the app is REALLY
# dead — not just slow. If the port still accepts connections, the process is
# alive and serving; restarting it would kill live sessions for nothing.
if port_open; then
  log "HEALTH slow but port $PORT still accepting — app ALIVE, NOT restarting (protects live sessions)"
  exit 0
fi

now=$(date +%s)
if [ -f "$COOLDOWN_FILE" ]; then
  last=$(cat "$COOLDOWN_FILE" 2>/dev/null || echo 0)
  if [ $((now - last)) -lt "$COOLDOWN_SECS" ]; then
    log "DOWN but within ${COOLDOWN_SECS}s cooldown ($((now-last))s ago) — skip"
    exit 0
  fi
fi

log "DOWN — port $PORT refused + health failed — reviving 151-machine (MAIN ONLY) from ecosystem file"
echo "$now" > "$COOLDOWN_FILE"

# MAIN ONLY — never session-host, never whisper-stt.
# ONE action based on pm2 state (never both): a `start` on top of an
# already-restarting process would re-bounce it. `describe` also respawns the
# pm2 daemon if it had died (→ absent → start branch). Errored/stopped entries
# still exist in pm2 (→ present → restart from file re-reads env).
if "$PM2" describe 151-machine >/dev/null 2>&1; then
  log "151-machine present in pm2 — restarting from ecosystem file"
  "$PM2" restart "$ECO" --only 151-machine >> "$LOG" 2>&1 || true
else
  log "151-machine absent in pm2 — starting from ecosystem file"
  "$PM2" start "$ECO" --only 151-machine >> "$LOG" 2>&1 || true
fi

sleep 6
if healthy; then
  log "REVIVED ok"
else
  log "STILL DOWN after revive attempt — needs a human"
fi

tail -n 500 "$LOG" > "$LOG.tmp" 2>/dev/null && mv "$LOG.tmp" "$LOG" || true
