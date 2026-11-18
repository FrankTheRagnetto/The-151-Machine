'use strict';
// Loopback-only gate for POST /api/setup — FIX 1.
// The old predicate treated the ENTIRE tailnet (100.x) as local-trusted, so any
// device on the tailnet could create the first password WITHOUT the pairing key.
// Now: only TRUE loopback may setup without a key; everything else (LAN, tailnet)
// must present a valid pairing token or gets a 403.
// NOTE: this governs ONLY the first-time /api/setup path — the finger/password
// login endpoint is separate and intentionally untouched.

function isLoopback(ip) {
  return /^(::1|::ffff:127\.|127\.)/.test(String(ip || ''));
}

// True iff a setup request from `ip` presenting `pairingKey` is allowed given the
// current server `pairingToken`.
function setupAllowed(ip, pairingKey, pairingToken) {
  if (isLoopback(ip)) return true;
  return !!pairingKey && pairingKey === pairingToken;
}

module.exports = { isLoopback, setupAllowed };
