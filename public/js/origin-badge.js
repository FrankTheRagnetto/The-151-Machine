/* The 151 Terminal — Origin Badge
 *
 * Answers, without a cable and without a laptop: "which machine is my phone
 * actually talking to?"
 *
 * The phone loads the PAGE from one box (the APK's capacitor server.url: the
 * Pi until 2026-10-10, the PC since app 1.19 on 2026-10-11, «strada C») and
 * sends its DATA to whichever box window.serverUrl resolves to. Until the 11/10
 * those could differ; nothing in the UI ever said so, which is why a phone
 * running old code looked like a mystery instead of a mismatch.
 *
 * NOTHING IS DRAWN IN THE TOPBAR (2026-08-19). The visible badge is gone — see
 * the note above render(). Two outputs remain, both silent:
 *   1. window.showOriginPanel() — the full picture (page/data + both hashes) on
 *      demand, from the console, whether or not anything looks wrong;
 *   2. a one-shot ORIGIN beacon (window.syncBeacon) on the first server frame,
 *      which lands in ~/.151machine/client-log.jsonl ON THE BOX THAT SERVES THE
 *      API — so the split is readable from a terminal too, with no device access.
 *
 * Read-only: this file reports, it never changes which server is used.
 */
(function () {
  'use strict';

  var STYLE_ID = 'origin-badge-style';
  var CSS =
    '#origin-panel{position:fixed;left:50%;transform:translateX(-50%);top:56px;z-index:99998;' +
    'max-width:min(92vw,420px);padding:12px 14px;border-radius:10px;' +
    'background:rgba(20,20,22,.97);color:#eee;border:1px solid rgba(255,255,255,.14);' +
    'box-shadow:0 8px 28px rgba(0,0,0,.45);font-size:12px;line-height:1.5;' +
    'font-family:ui-monospace,SFMono-Regular,Menlo,monospace;}' +
    '#origin-panel .op-row{display:flex;justify-content:space-between;gap:12px;}' +
    '#origin-panel .op-k{opacity:.6;}' +
    '#origin-panel .op-warn{margin-top:8px;color:#e0a300;font-weight:600;}' +
    '#origin-panel .op-ok{margin-top:8px;color:#5ac47d;}' +
    '#origin-panel .op-close{margin-top:10px;text-align:right;opacity:.6;cursor:pointer;}';

  function injectCss() {
    if (document.getElementById(STYLE_ID)) return;
    var s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent = CSS;
    (document.head || document.documentElement).appendChild(s);
  }

  // Short human name for a machine, so the panel reads "laptop" instead of a
  // Tailscale FQDN the owner would have to decode in his head. (The "raspberry"
  // name and the Pi's address left on 2026-10-16: the Pi is unplugged.)
  function shortName(originStr) {
    if (!originStr) return '?';
    var host = originStr;
    try { host = new URL(originStr).hostname; } catch (e) {}
    var h = host.toLowerCase();
    if (h === 'localhost' || h === '127.0.0.1') return 'this box';
    if (h.indexOf('100.') === 0 || h.indexOf('192.168.') === 0 || h.indexOf('10.') === 0) return h;
    return h.split('.')[0] || h;
  }

  function pageOrigin() {
    try { return location.origin; } catch (e) { return ''; }
  }
  function socketOrigin() {
    try {
      if (typeof window.getServerUrl !== 'function') return '';
      var u = window.getServerUrl();
      // Guard: new URL(undefined, base) silently resolves to the base origin,
      // which would report "one machine" when we simply do not know yet.
      if (typeof u !== 'string' || !u) return '';
      return new URL(u, location.href).origin;
    } catch (e) { return ''; }
  }

  function readState() {
    var o = window.__151_ORIGINS || {};
    var page = o.page || pageOrigin();
    var sock = o.socket || socketOrigin();
    return {
      page: page,
      socket: sock,
      pageHash: (typeof o.pageHash === 'string' ? o.pageHash : (typeof window.__CODE_HASH === 'string' ? window.__CODE_HASH : null)),
      socketHash: o.socketHash || null,
      // Unknown socket origin is NOT a split — say nothing rather than lie.
      split: !!(page && sock && page !== sock),
    };
  }

  function togglePanel() {
    var p = document.getElementById('origin-panel');
    if (p) { p.parentNode.removeChild(p); return; }
    injectCss();
    var st = readState();
    p = document.createElement('div');
    p.id = 'origin-panel';
    function row(k, v) {
      return '<div class="op-row"><span class="op-k">' + k + '</span><span>' + v + '</span></div>';
    }
    var html = '';
    html += row('page from', shortName(st.page));
    html += row('page code', st.pageHash || 'unknown');
    html += row('data to', st.socket ? shortName(st.socket) : 'not connected yet');
    html += row('data code', st.socketHash || 'unknown');
    if (st.split) {
      html += '<div class="op-warn">Two different machines.<br>The screen comes from ' +
        shortName(st.page) + ', the answers come from ' + shortName(st.socket) + '.</div>';
    } else if (st.socket) {
      html += '<div class="op-ok">One machine — ' + shortName(st.page) + '.</div>';
    }
    html += '<div class="op-close">tap to close</div>';
    p.innerHTML = html;
    p.addEventListener('click', function () { if (p.parentNode) p.parentNode.removeChild(p); });
    document.body.appendChild(p);
  }

  // NOTHING IN THE TOPBAR (2026-08-19). The badge used to park a permanent
  // "raspberry" between the reload button and the right sidebar. Two reasons it
  // is gone for good and not merely hidden-when-healthy:
  //   1. on the phone the split WAS the normal state until 2026-10-10 — the
  //      APK loaded the page from the Pi while the socket could resolve to the
  //      PC — so a "show only when split" badge would have been permanently on,
  //      in orange (since 1.19, 11/10, page and data both come from the PC);
  //   2. the split stopped being dangerous the moment ws.js started comparing
  //      the PAGE's own __CODE_HASH instead of the socket's, so it is a fact to
  //      record, not an alarm to raise.
  // The machinery stays: the ORIGIN beacon still lands in client-log.jsonl on
  // the box that serves the API, and the full panel is one call away.
  // [2026-10-12] render()/window.renderOriginBadge removed: it only deleted a
  // badge that is never drawn any more (ws.js no longer calls it).
  // The diagnosis must not depend on anything being visible: call
  // window.showOriginPanel() from the console to see page/data + both hashes.
  window.showOriginPanel = togglePanel;

  // One-shot beacon on the first server frame. Lands in client-log.jsonl on the
  // box that serves the API — the same box the phone is talking to, which is
  // precisely the fact we want recorded.
  var beaconSent = false;
  window.beaconOrigins = function beaconOrigins() {
    if (beaconSent) return;
    var st = readState();
    if (!st.socket) return;
    beaconSent = true;
    if (typeof window.syncBeacon === 'function') {
      window.syncBeacon('ORIGIN', {
        page: st.page, pageHash: st.pageHash,
        socket: st.socket, socketHash: st.socketHash,
        split: st.split,
      });
    }
  };

  // [2026-10-12] boot() went with render(): it only called render(), and
  // calling it after render() was removed threw at every start
  // (tests/origin-badge.test.js).
})();
