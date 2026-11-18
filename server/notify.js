'use strict';
// POST /api/notify — outbound notification channel (toast on every connected
// client). The endpoint was documented in the /notify-user skill and called by
// the backup scripts but never existed
// (2026-08-12 audit). Extracted here (same pattern as setup-auth.js) so the
// exact shipped handler can be integration-tested without booting index.js.
//
// Auth: callers curl from loopback WITHOUT a JWT, so true loopback is trusted —
// same trust rule as /api/setup. Anything else needs a Bearer token.
// Delivery: WS broadcast {type:'notify'} → ws.js shows the existing #general-toast.

const VARIANTS = ['success', 'info', 'warning', 'error'];

function createNotifyHandler({ getWss, isTokenValid, isLoopback }) {
  return function notifyHandler(req, res) {
    const ip = (req.socket && req.socket.remoteAddress) || '';
    const auth = req.headers.authorization || '';
    const authed = auth.startsWith('Bearer ') && isTokenValid(auth.slice(7));
    if (!isLoopback(ip) && !authed) return res.status(401).json({ error: 'Unauthorized' });

    const body = req.body || {};
    const message = typeof body.message === 'string' ? body.message.trim().slice(0, 500) : '';
    if (!message) return res.status(400).json({ error: 'message required' });

    // 'system' is accepted per the skill contract but delivered as a longer
    // toast — the chat renderer has no system role, and inventing one is not
    // this endpoint's job. sessionId is passed through for a future upgrade.
    const kind = body.type === 'system' ? 'system' : 'toast';
    const variant = VARIANTS.includes(body.variant) ? body.variant : 'info';
    const parsed = parseInt(body.duration, 10);
    const duration = Math.min(Math.max(parsed > 0 ? parsed : (kind === 'system' ? 8000 : 5000), 1000), 60000);

    const payload = JSON.stringify({
      type: 'notify',
      kind,
      message,
      variant,
      duration,
      sessionId: typeof body.sessionId === 'string' ? body.sessionId : null,
    });

    let delivered = 0;
    const wss = getWss();
    if (wss && wss.clients) {
      wss.clients.forEach((client) => {
        if (client.readyState === 1) {
          try { client.send(payload); delivered++; } catch {}
        }
      });
    }
    console.log(`[NOTIFY] ${kind}/${variant} → ${delivered} client(s): ${message.slice(0, 80)}`);
    res.json({ ok: true, delivered });
  };
}

module.exports = { createNotifyHandler };
