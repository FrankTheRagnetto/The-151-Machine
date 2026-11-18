/**
 * session-host-gate.js — Boot-time pipe readiness gate for the main 151-machine
 * server. Blocks `startServer()` until the session-host daemon is reachable, so
 * the first session spawn after a full reboot / `pm2 restart all` doesn't hit
 * "session-host unreachable".
 *
 * Contract:
 *   waitForDaemon({ timeoutMs = 15000, pollIntervalMs = 250 })
 *     - NO-OP when process.env.USE_SESSION_HOST !== '1' (resolves immediately).
 *     - Otherwise polls `client.list()` every pollIntervalMs until an ack
 *       comes back, resolves void. On timeout, rejects with a clear Error.
 *
 * Caller (server/index.js) is expected to `process.exit(1)` on rejection so
 * PM2 + the watchdog respawn the main server. The daemon is a separate PM2
 * app (see ecosystem.config.js, Phase 3a, 2026-04-18), so watchdog v6 can
 * heal it independently while we're out.
 *
 * Why not just rely on session-host-client's reconnect loop? The reconnect
 * eventually recovers, but any spawn issued in the first ~0–5 s window would
 * reject with "session-host unreachable" through sendMessage() → the user
 * sees an empty reply box and concludes the app broke again. The gate turns
 * that race into a deterministic boot-time wait.
 */

'use strict';

const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_POLL_MS = 250;

async function waitForDaemon({ timeoutMs = DEFAULT_TIMEOUT_MS, pollIntervalMs = DEFAULT_POLL_MS } = {}) {
  if (process.env.USE_SESSION_HOST !== '1') return;

  const { getClient } = require('./session-host-client');
  const client = getClient();
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  let attempt = 0;

  while (Date.now() < deadline) {
    attempt++;
    try {
      // list() internally calls _ensureConnected + _request. On a fresh boot
      // where the daemon isn't listening yet, _connect rejects synchronously
      // and _connectPromise is cleared — we just retry.
      await client.list();
      console.log(`[session-host-gate] daemon reachable (attempt ${attempt})`);
      return;
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, pollIntervalMs));
    }
  }
  const msg = `session-host daemon unreachable after ${timeoutMs}ms (${attempt} attempts)` +
    (lastErr ? `: ${lastErr.message}` : '');
  throw new Error(msg);
}

module.exports = { waitForDaemon };
