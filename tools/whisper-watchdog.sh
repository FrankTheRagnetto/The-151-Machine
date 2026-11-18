#!/usr/bin/env bash
# whisper-watchdog.sh — independent safety net for the whisper-stt service.
#
# WHY: whisper-stt runs under PM2 with max_restarts:5 + min_uptime:30s. That
# rides out transient crashes, but if it crash-loops past the limit PM2 parks
# it in "errored" and STOPS trying — STT then dies SILENTLY (voice notes /
# transcription just stop working, no alarm, until a human notices). pc-watchdog
# deliberately never touches whisper (scope purity: it only revives the web app),
# so nothing closes this gap. This cron does.
#
# SESSION SAFETY: restarting whisper-stt is HARMLESS to live chats — whisper is
# a standalone STT worker, NOT the session-host. (Only 151-session-host owns live
# CLI/SDK sessions; this script never touches it.) So we can safely revive
# whisper whenever its /health is down.
#
# Installed via the PC user crontab:
#   * * * * * /path/to/the-151-machine/tools/whisper-watchdog.sh
set -uo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PATH="$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

PORT=3173
URL="http://127.0.0.1:${PORT}/health"
ECO="$REPO/ecosystem.linux.config.js"
PM2="$(command -v pm2 || echo "$HOME/.local/bin/pm2")"
LOG="$REPO/tools/whisper-watchdog.log"
LOCK="/tmp/whisper-watchdog.lock"
COOLDOWN_FILE="/tmp/whisper-watchdog.last-restart"
COOLDOWN_SECS=180

log() { echo "$(date '+%F %T') $*" >> "$LOG"; }

exec 9>"$LOCK" 2>/dev/null || exit 0
flock -n 9 || exit 0

healthy() {
  curl -fsS -m 15 "$URL" 2>/dev/null | grep -q '"ok": *true'
}

# TCP-level liveness: an ALIVE-but-busy worker (mid-transcription, model load)
# still accepts connections even when /health is momentarily slow. A truly dead
# service refuses. This gate stops false-positive restarts mid-transcription.
port_open() {
  timeout 3 bash -c "exec 3<>/dev/tcp/127.0.0.1/${PORT}" 2>/dev/null
}

# Ride out a legitimate restart window before acting. whisper has min_uptime 30s
# + restart_delay 15s + exp backoff, and model load takes time — so give it
# longer than the web-app watchdog: 5 probes over ~60s.
for i in 1 2 3 4 5; do
  if healthy; then exit 0; fi
  [ "$i" -lt 5 ] && sleep 15
done

# Health failed 5x over ~60s. If the port still accepts, the worker is alive but
# busy (loading a big clip / model) — don't restart mid-work.
if port_open; then
  log "HEALTH slow but port ${PORT} still accepting — worker ALIVE (busy), NOT restarting"
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

log "DOWN — port ${PORT} refused + health failed — reviving whisper-stt (STT ONLY) from ecosystem file"
echo "$now" > "$COOLDOWN_FILE"

# STT ONLY — never 151-machine, never 151-session-host. `start` catches a PM2
# 'errored'/'stopped' entry (past max_restarts); `restart` catches a hung one.
"$PM2" start   "$ECO" --only whisper-stt >> "$LOG" 2>&1 || true
"$PM2" restart "$ECO" --only whisper-stt >> "$LOG" 2>&1 || true

sleep 8
if healthy; then
  log "REVIVED ok"
else
  log "STILL DOWN after revive attempt — needs a human (check logs/whisper-stt-error.log)"
fi

tail -n 500 "$LOG" > "$LOG.tmp" 2>/dev/null && mv "$LOG.tmp" "$LOG" || true
