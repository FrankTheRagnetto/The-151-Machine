#!/usr/bin/env bash
# Boot the 151 Machine PM2 stack FROM the ecosystem file (not from a saved
# pm2 dump snapshot). This removes the stale-snapshot drift that silently
# reverted env flags on reboot, and removes the need to ever run `pm2 save`.
#
# Respects the IMMUTABLE restart discipline: session-host daemon FIRST, wait
# for its TCP IPC port to be live, THEN main, then whisper.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PM2="$(command -v pm2 || echo "$HOME/.local/bin/pm2")"
ECO="$REPO/ecosystem.linux.config.js"
cd "$REPO" || exit 1

# start-or-restart an app FROM the file (restart-from-file re-reads env)
boot_app() {
  local name="$1"
  if "$PM2" describe "$name" >/dev/null 2>&1; then
    "$PM2" restart "$ECO" --only "$name"
  else
    "$PM2" start "$ECO" --only "$name"
  fi
}

# 1. daemon first
boot_app 151-session-host

# 2. wait for daemon IPC (TCP 127.0.0.1:3172) up to 30s before starting main
for _i in $(seq 1 30); do
  if (exec 3<>/dev/tcp/127.0.0.1/3172) 2>/dev/null; then exec 3>&- 3<&-; break; fi
  sleep 1
done

# 3. main
boot_app 151-machine

# 4. whisper (independent; order not critical)
boot_app whisper-stt

# 5. Not a blind boot: verify the web app actually came up healthy (small retry
# to ride out the boot window). Warn loudly if not — the cron watchdog will keep
# trying — but don't fail the boot unit over it (whisper/session-host are up).
HEALTH_URL="http://127.0.0.1:3170/api/health"
ok=false
for _i in $(seq 1 8); do
  if curl -fsS -m 8 "$HEALTH_URL" 2>/dev/null | grep -q '"ok":true'; then ok=true; break; fi
  sleep 3
done
if $ok; then
  echo "[pm2-boot] 151-machine health OK"
else
  echo "[pm2-boot] WARNING: 151-machine not healthy after boot — check 'pm2 logs 151-machine'" >&2
fi

# 6. [2026-10-12] Le copie locali dei portali esterni (5001-5003) non le accende
# più la Machine: il proprietario ha tolto dalla Machine gli accessi ai portali («la machine
# non ha più necessità di entrare nei portali»), e il loro script di avvio se
# n'è andato con loro. Se restano sotto pm2, è una scelta, non di qui.

exit 0
