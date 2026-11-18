/**
 * The 151 Machine — Updates plugin (client)
 * ===================================================================
 * Apps-panel plugin (category "app"), renderInPanel pattern, no build step.
 * Everything visible is in English.
 *
 * ── One gesture ──
 * The top of the panel is a single status block: how many updates wait and
 * ONE big button, «Update everything» («così clicco solo su update sarebbe
 * gasante»). Copying the command and pasting it in a terminal stays as the
 * quieter second road underneath. The channels are a compact list below,
 * each row closed by default (<details>): its own command, the package list
 * and the long explanations.
 *
 * ── Update everything (server: plugins/updates/server.js + runner.py) ──
 * The client never sends a command: it asks the server to start, and the
 * server runs ONLY the commands of the outdated channels. The flow, all in
 * the same block, never a system popup:
 *   tap → a short confirm (Update / Cancel) → POST /update/start
 *   → the live view: progress bar, ONE sentence on what is happening, the
 *     last lines of the output (Show all for the whole log), and the PC's
 *     question when it asks one (password, yes/no, a numbered choice, text)
 *   → the result: done (+ «Restart the PC when you can»), stopped, or
 *     interrupted, with the last lines.
 * The run lives on the PC, not in the panel: close the app, come back, and
 * GET /update/current re-attaches to it. There is NO Stop button on purpose
 * (/hack: stopping pacman halfway breaks the system).
 * The password («se serve la password dovrei poterla inserire da dentro la
 * machine»): a type=password field, autocomplete=new-password; on Send the
 * field is emptied at once and the value lives only inside the submit
 * handler — no variable, no storage keeps it.
 *
 * Polling goes through window.Battito (public/js/battito.js): ~1 s while the
 * update runs, asleep with the screen off, gone when the run ends or the
 * panel closes. The live view is updated piece by piece, never repainted
 * whole, so a half-typed answer is never wiped.
 *
 * Look: colours, fonts, radii, sizes only from main.css variables; the 320 px
 * panel is the only width: everything wraps, nothing scrolls
 * sideways. History: git log -- plugins/updates/client.js.
 */
(function () {
  'use strict';
  var PLUGIN_ID = 'updates';
  var SLOW_MS = 15000;      // after this the loading line says "still checking"
  var CEILING_MS = 150000;  // server probes stop at 120 s; give up a bit later
  var POLL_MS = 1000;       // live view while the update runs
  var RECENT_MS = 3600000;  // a finished run shows on top for one hour
  var TAIL_LINES = 8;
  var LOG_CAP = 400000;     // characters of log kept in the panel
  var DISMISS_KEY = 'updates-dismissed-run';
  var poller = null;        // the ONE live poll of this plugin (a reopen stops the old one)

  function call(path, opts) {
    opts = opts || {};
    var url = '/api/plugins/' + PLUGIN_ID + path;
    if (window.UI && typeof window.UI.authFetch === 'function') return window.UI.authFetch(url, opts);
    var tok = '';
    try { tok = localStorage.getItem('151-terminal-token') || ''; } catch (_) {}
    opts.headers = Object.assign({ Authorization: 'Bearer ' + tok }, opts.headers || {});
    return fetch((window.getServerUrl ? window.getServerUrl() : '') + url, opts);
  }
  function postJson(path, body) {
    return call(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (b) { return { status: r.status, body: b || {} }; });
      });
  }

  // Pure (no DOM), so the view can be rendered and checked by a test in node.
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function toast(msg) {
    if (window.showToast) window.showToast(msg);
    else if (window.UI && window.UI.toast) window.UI.toast(msg);
  }

  // The shared helper (public/js/chat.js) resolves true/false and knows the
  // plain-http phone, where navigator.clipboard is missing. Never call
  // navigator.clipboard directly here.
  function copyText(text) {
    if (window.copyToClipboard) return window.copyToClipboard(text);
    return Promise.resolve(false);
  }

  // Drawn icons, same stroke family as the rest of the Machine.
  var SVG = 'viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';
  var IC_COPY = '<svg ' + SVG + '><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
  var IC_CHECK = '<svg ' + SVG + '><polyline points="20 6 9 17 4 12"/></svg>';
  var IC_AGAIN = '<svg ' + SVG + '><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg>';
  var IC_CHEV = '<svg ' + SVG + ' class="upd-chev"><polyline points="9 6 15 12 9 18"/></svg>';
  var IC_GO = '<svg ' + SVG.replace('width="16" height="16"', 'width="18" height="18"') + '><path d="M12 3v12"/><polyline points="7 10 12 15 17 10"/><path d="M5 21h14"/></svg>';
  var IC_LOCK = '<svg ' + SVG + '><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>';
  var IC_ASK = '<svg ' + SVG + '><circle cx="12" cy="12" r="10"/><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3"/><path d="M12 17h.01"/></svg>';
  var IC_POWER = '<svg ' + SVG + '><path d="M12 2v10"/><path d="M18.4 6.6a9 9 0 1 1-12.8 0"/></svg>';

  var CSS = [
    // The wrap scrolls itself: .app-mount (main.css) is a fixed-height,
    // overflow:hidden column, so the plugin owns its vertical scroll.
    '.upd-wrap{flex:1 1 auto;min-height:0;overflow-y:auto;overflow-x:hidden;overscroll-behavior:contain;-webkit-overflow-scrolling:touch;box-sizing:border-box;padding:var(--space-3) var(--space-3) var(--space-6);color:var(--text);font:var(--fs-sm)/1.5 var(--font)}',
    '.upd-wrap *{box-sizing:border-box}',
    '.upd-top{display:flex;align-items:center;gap:var(--space-2);margin-bottom:var(--space-3)}',
    '.upd-meta{flex:1 1 auto;min-width:0;font-size:var(--fs-xs);line-height:1.4;color:var(--text-dim);overflow-wrap:anywhere}',
    '.upd-meta b{color:var(--text);font-weight:600}',
    '.upd-again{flex:0 0 auto;display:inline-flex;align-items:center;gap:6px;min-height:44px;padding:0 var(--space-3);border-radius:var(--r-md);border:1px solid rgba(var(--border-rgb),.28);background:rgba(var(--border-rgb),.12);color:var(--text);font:600 var(--fs-sm) var(--font);cursor:pointer;transition:background var(--motion-fast)}',
    '.upd-again:hover{background:rgba(var(--border-rgb),.2)}',
    '.upd-again[disabled]{opacity:.55;cursor:default}',
    '.upd-wrap button:focus-visible,.upd-wrap input:focus-visible,.upd-ch>summary:focus-visible{outline:2px solid var(--accent-bright);outline-offset:2px}',

    // ── The one status block ──
    '.upd-hero{border-radius:var(--r-lg);border:1px solid rgba(var(--border-rgb),.16);background:rgba(var(--accent-bright-rgb),.05);padding:var(--space-4);margin-bottom:var(--space-5);animation:upd-in var(--motion-base) var(--ease-out)}',
    '.upd-hero.is-work,.upd-hero.is-run{border-color:rgba(var(--accent-bright-rgb),.45);background:rgba(var(--accent-bright-rgb),.1);box-shadow:var(--shadow-md)}',
    '.upd-hero.is-down,.upd-hero.is-failed{border-color:rgba(var(--red-rgb),.4);background:rgba(var(--red-rgb),.07)}',
    '.upd-hero.is-lost{border-color:rgba(var(--orange-rgb),.4);background:rgba(var(--orange-rgb),.06)}',
    '.upd-hero.is-ok{border-color:rgba(var(--green-rgb),.4);background:rgba(var(--green-rgb),.07)}',
    '@keyframes upd-in{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}',
    '.upd-h{display:flex;align-items:center;gap:var(--space-2);margin:0;font-size:var(--fs-lg);font-weight:700;line-height:1.25;letter-spacing:-.01em;color:var(--text);text-wrap:balance}',
    '.upd-h.calm{font-size:var(--fs-base);font-weight:600}',
    '.upd-dot{flex:0 0 auto;width:10px;height:10px;border-radius:50%;background:var(--text-dim)}',
    '.upd-dot.ok{background:var(--green)}.upd-dot.warn{background:var(--orange)}.upd-dot.bad{background:var(--red)}',
    '.upd-dot.busy{background:var(--accent-bright);animation:upd-pulse 1.2s var(--ease-in-out) infinite}',
    '@keyframes upd-pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.35;transform:scale(.7)}}',
    '.upd-lede{margin:var(--space-1) 0 0;font-size:var(--fs-sm);color:var(--text-dim);overflow-wrap:anywhere}',
    '.upd-lede b{color:var(--text);font-weight:600}',
    ".upd-code{display:block;margin:var(--space-2) 0 0;padding:var(--space-3);border-radius:var(--r-md);border:1px solid rgba(var(--border-rgb),.14);background:var(--surface-code);color:var(--text-code);font:var(--fs-xs)/1.55 var(--mono);white-space:pre-wrap;overflow-wrap:anywhere;user-select:all;-webkit-user-select:all}",
    '.upd-code .t{display:inline-block;max-width:100%;overflow-wrap:anywhere}',
    // The main gesture: Update everything (and the confirm's Update).
    '.upd-go{display:flex;align-items:center;justify-content:center;gap:var(--space-2);width:100%;min-height:52px;margin-top:var(--space-4);padding:0 var(--space-4);border-radius:var(--r-md);border:1px solid rgba(var(--accent-bright-rgb),.75);background:var(--accent);color:var(--bg);font:700 var(--fs-base) var(--font);letter-spacing:.005em;cursor:pointer;box-shadow:var(--shadow-sm);transition:background var(--motion-fast),transform var(--motion-fast) var(--ease-out)}',
    '.upd-go:hover{background:var(--accent-bright);color:var(--bg)}',
    '.upd-go:active{transform:scale(.98)}',
    '.upd-go[disabled]{opacity:.6;cursor:default;transform:none}',
    '.upd-confirm{margin-top:var(--space-4);padding-top:var(--space-4);border-top:1px solid rgba(var(--accent-bright-rgb),.3);animation:upd-in var(--motion-base) var(--ease-out)}',
    '.upd-confirm p{margin:0;font-size:var(--fs-base);font-weight:600;line-height:1.4;color:var(--text);text-wrap:pretty}',
    '.upd-confirm p span{display:block;margin-top:2px;font-size:var(--fs-sm);font-weight:400;color:var(--text-dim)}',
    '.upd-pair{display:grid;grid-template-columns:1fr 1fr;gap:var(--space-2);margin-top:var(--space-3)}',
    '.upd-pair .upd-go{margin-top:0}',
    '.upd-ghost{display:flex;align-items:center;justify-content:center;gap:6px;min-height:44px;padding:0 var(--space-4);border-radius:var(--r-md);border:1px solid rgba(var(--border-rgb),.3);background:transparent;color:var(--text);font:600 var(--fs-sm) var(--font);cursor:pointer;transition:background var(--motion-fast)}',
    '.upd-ghost:hover{background:rgba(var(--border-rgb),.14)}',
    '.upd-pair .upd-ghost{min-height:52px;font-size:var(--fs-base)}',
    // The second road: copy the command.
    '.upd-alt{margin-top:var(--space-4)}',
    '.upd-alt>summary{display:flex;align-items:center;gap:var(--space-2);min-height:44px;list-style:none;cursor:pointer;font-size:var(--fs-xs);color:var(--text-dim)}',
    '.upd-alt>summary::-webkit-details-marker{display:none}.upd-alt>summary::marker{content:""}',
    '.upd-alt[open] .upd-chev{transform:rotate(90deg)}',
    '.upd-copy,.upd-copy2{display:inline-flex;align-items:center;gap:6px;min-height:44px;margin:var(--space-2) 0 0;padding:0 var(--space-4);border-radius:var(--r-md);border:1px solid rgba(var(--accent-bright-rgb),.45);background:rgba(var(--accent-bright-rgb),.14);color:var(--text);font:600 var(--fs-sm) var(--font);cursor:pointer;transition:background var(--motion-fast),border-color var(--motion-fast),color var(--motion-fast)}',
    '.upd-copy:hover,.upd-copy2:hover{background:rgba(var(--accent-bright-rgb),.24)}',
    '.upd-copy2{margin-bottom:var(--space-3)}',
    '.upd-copy.done,.upd-copy2.done{background:rgba(var(--green-rgb),.16);border-color:rgba(var(--green-rgb),.5);color:var(--green)}',
    '.upd-hint{margin:var(--space-2) 0 0;font-size:var(--fs-xs);line-height:1.45;color:var(--text-dim)}',
    '.upd-warn{margin:var(--space-3) 0 0;font-size:var(--fs-xs);line-height:1.45;color:var(--orange)}',
    '.upd-hero.is-down .upd-lede{color:var(--text)}',

    // ── The live update ──
    '.upd-phrase{font-size:var(--fs-md)}',
    '.upd-bar{position:relative;height:8px;margin-top:var(--space-4);border-radius:var(--r-pill);background:rgba(var(--border-rgb),.2);overflow:hidden}',
    '.upd-bar i{position:absolute;inset:0;border-radius:inherit;background:var(--accent-bright);transform-origin:left center;transition:transform var(--motion-slow) var(--ease-out)}',
    '.upd-bar.ind i{right:auto;width:32%;animation:upd-slide 1.5s var(--ease-in-out) infinite}',
    '@keyframes upd-slide{from{transform:translateX(-100%)}to{transform:translateX(320%)}}',
    '.upd-prog{display:flex;align-items:baseline;gap:var(--space-2);margin-top:var(--space-2);font-size:var(--fs-xs);color:var(--text-dim)}',
    '.upd-prog .p{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--mono)}',
    '.upd-prog .c{flex:0 0 auto;font-variant-numeric:tabular-nums;color:var(--text)}',
    '.upd-tail{margin:var(--space-3) 0 0;padding:var(--space-2) var(--space-3);border-radius:var(--r-md);background:var(--surface-code);color:var(--text-dim);font:var(--fs-xs)/1.5 var(--mono)}',
    '.upd-tail div{white-space:pre-wrap;overflow-wrap:anywhere;min-height:1.5em}',
    '.upd-tail div:last-child{color:var(--text-code)}',
    '.upd-tail:empty,.upd-run.is-all .upd-tail,.upd-ask-slot:not(:empty)~.upd-tail{display:none}',
    '.upd-all{margin:var(--space-2) 0 0;max-height:55vh;overflow:auto;overscroll-behavior:contain;padding:var(--space-3);border-radius:var(--r-md);border:1px solid rgba(var(--border-rgb),.14);background:var(--surface-code);color:var(--text-code);font:var(--fs-xs)/1.5 var(--mono);white-space:pre-wrap;overflow-wrap:anywhere}',
    '.upd-all[hidden]{display:none}',
    '.upd-note{margin:var(--space-2) 0 0;font-size:var(--fs-xs);color:var(--text-dim)}',
    // The question: the one thing that needs the owner, so it wears the attention colour.
    '.upd-ask{margin:var(--space-4) 0 0;padding:var(--space-4);border-radius:var(--r-md);border:1px solid rgba(var(--orange-rgb),.6);background:rgba(var(--orange-rgb),.09);box-shadow:var(--shadow-md);animation:upd-in var(--motion-base) var(--ease-out)}',
    '.upd-ask-t{display:flex;align-items:center;gap:var(--space-2);margin:0;font-size:var(--fs-base);font-weight:700;line-height:1.3;color:var(--text)}',
    '.upd-ask-t svg{flex:0 0 auto;color:var(--orange)}',
    '.upd-ask-sub{margin:var(--space-1) 0 0;font-size:var(--fs-xs);line-height:1.45;color:var(--text-dim)}',
    '.upd-ask-sub.bad{color:var(--red);font-weight:600}',
    '.upd-ask-q{margin:var(--space-3) 0 0;padding:var(--space-2) var(--space-3);border-radius:var(--r-sm);background:var(--surface-code);color:var(--text-code);font:var(--fs-xs)/1.5 var(--mono);white-space:pre-wrap;overflow-wrap:anywhere}',
    '.upd-ask-row{display:flex;gap:var(--space-2);margin-top:var(--space-3)}',
    '.upd-in{flex:1 1 auto;min-width:0;min-height:48px;padding:0 var(--space-3);border-radius:var(--r-md);border:1px solid rgba(var(--border-rgb),.4);background:var(--bg);color:var(--text);font:var(--fs-base) var(--font)}',
    '.upd-in:focus{border-color:var(--accent-bright)}',
    '.upd-send{flex:0 0 auto;min-height:48px;min-width:72px;padding:0 var(--space-4);border-radius:var(--r-md);border:1px solid rgba(var(--accent-bright-rgb),.75);background:var(--accent);color:var(--bg);font:700 var(--fs-sm) var(--font);cursor:pointer}',
    '.upd-send:hover{background:var(--accent-bright)}',
    '.upd-send[disabled],.upd-ans[disabled]{opacity:.55;cursor:default}',
    '.upd-ans-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:var(--space-2);margin-top:var(--space-3)}',
    '.upd-ans{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;min-height:52px;padding:var(--space-1) var(--space-3);border-radius:var(--r-md);border:1px solid rgba(var(--border-rgb),.4);background:rgba(var(--border-rgb),.12);color:var(--text);font:700 var(--fs-base) var(--font);cursor:pointer;overflow-wrap:anywhere;text-align:center}',
    '.upd-ans:hover{background:rgba(var(--border-rgb),.22)}',
    '.upd-ans small{font:500 var(--fs-xs) var(--font);color:var(--text-dim)}',
    '.upd-ans small.n{font-family:var(--mono)}',
    '.upd-ans.is-def{border-color:rgba(var(--accent-bright-rgb),.7);background:rgba(var(--accent-bright-rgb),.18)}',
    '.upd-ask-msg{margin:var(--space-2) 0 0;font-size:var(--fs-xs);line-height:1.45;color:var(--text-dim)}',
    '.upd-ask-msg:empty{display:none}',
    '.upd-ask-msg.bad{color:var(--red);font-weight:600}',
    // The result.
    '.upd-restart{display:flex;gap:var(--space-3);align-items:flex-start;margin:var(--space-3) 0 0;padding:var(--space-3);border-radius:var(--r-md);border:1px solid rgba(var(--orange-rgb),.5);background:rgba(var(--orange-rgb),.1)}',
    '.upd-restart svg{flex:0 0 auto;margin-top:2px;color:var(--orange)}',
    '.upd-restart b{display:block;font-size:var(--fs-base);color:var(--text)}',
    '.upd-restart span{font-size:var(--fs-xs);color:var(--text-dim)}',
    '.upd-end{display:flex;flex-wrap:wrap;gap:var(--space-2);margin-top:var(--space-3)}',

    // ── Channels: compact rows, closed by default ──
    '.upd-sec{margin:0 0 var(--space-1);font-size:var(--fs-xs);font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--text-dim)}',
    '.upd-chs{border-top:1px solid rgba(var(--border-rgb),.14)}',
    '.upd-ch{border-bottom:1px solid rgba(var(--border-rgb),.14)}',
    '.upd-ch>summary{display:flex;align-items:center;gap:var(--space-2);min-height:48px;padding:var(--space-2) 0;list-style:none;cursor:pointer}',
    '.upd-ch>summary::-webkit-details-marker{display:none}',
    '.upd-ch>summary::marker{content:""}',
    '.upd-chev{flex:0 0 auto;color:var(--text-dim);transition:transform var(--motion-fast) var(--ease-out)}',
    '.upd-ch[open] .upd-chev{transform:rotate(90deg)}',
    '.upd-nm{flex:1 1 auto;min-width:0;line-height:1.3}',
    '.upd-nm b{font-size:var(--fs-sm);font-weight:600;color:var(--text)}',
    '.upd-nm span{display:block;font-size:var(--fs-xs);color:var(--text-dim);overflow-wrap:anywhere}',
    '.upd-nm span.why.bad{color:var(--red)}.upd-nm span.why.warn{color:var(--orange)}',
    '.upd-ch.is-current .upd-nm b{color:var(--text-dim)}',
    '.upd-st{flex:0 0 auto;font-size:var(--fs-xs);font-weight:600;white-space:nowrap;color:var(--text-dim)}',
    '.upd-st.on{padding:2px var(--space-2);border-radius:var(--r-pill);background:rgba(var(--orange-rgb),.13);border:1px solid rgba(var(--orange-rgb),.45);color:var(--orange)}',
    '.upd-st.ok{color:var(--green)}',
    '.upd-st.warn{color:var(--orange)}',
    '.upd-st.bad{color:var(--red)}',
    '.upd-body{padding:0 0 var(--space-3) 24px;font-size:var(--fs-xs);color:var(--text-dim)}',
    '.upd-body p{margin:0 0 var(--space-2)}',
    '.upd-body p b{color:var(--text);font-weight:600}',
    '.upd-body .upd-warn{margin:0 0 var(--space-2)}',
    '.upd-body .upd-code{margin:0;font-size:var(--fs-xs)}',
    '.upd-list{margin:0 0 var(--space-3);padding:0;list-style:none;max-height:240px;overflow-x:hidden;overflow-y:auto;overscroll-behavior:contain}',
    '.upd-list li{display:flex;flex-wrap:wrap;gap:2px var(--space-2);align-items:baseline;padding:5px 0;border-bottom:1px solid rgba(var(--border-rgb),.08)}',
    '.upd-list li:last-child{border-bottom:none}',
    '.upd-list .n{flex:1 1 auto;min-width:0;color:var(--text);word-break:break-all}',
    '.upd-list .g{flex:0 0 auto;font-size:var(--fs-xs);line-height:1.3;border:1px solid rgba(var(--border-rgb),.24);border-radius:var(--r-xs);padding:0 4px}',
    '.upd-list .v{flex:0 1 auto;min-width:0;max-width:100%;margin-left:auto;overflow-wrap:anywhere;font:var(--fs-xs) var(--mono)}',
    '.upd-foot{margin:var(--space-4) 0 0;font-size:var(--fs-xs);line-height:1.5;color:var(--text-dim)}',
    '.upd-foot b{color:var(--text);font-weight:600}',
    '@media (prefers-reduced-motion:reduce){.upd-hero,.upd-confirm,.upd-ask,.upd-dot.busy{animation:none}.upd-chev,.upd-bar i{transition:none}.upd-bar.ind i{animation:none;width:100%;opacity:.35}}',
  ].join('\n');

  function injectCSS() {
    if (document.getElementById('updates-css')) return;
    var st = document.createElement('style');
    st.id = 'updates-css';
    st.textContent = CSS;
    document.head.appendChild(st);
  }

  // ── Pure view ─────────────────────────────────────────────────────
  // "Arch — system + AUR" → { name: "Arch", kind: "system + AUR" }
  function split(name) {
    var p = String(name || '?').split(' — ');
    return { name: p[0], kind: p.slice(1).join(' — ') };
  }
  function andList(a) {
    if (a.length < 2) return a.join('');
    return a.slice(0, -1).join(', ') + ' and ' + a[a.length - 1];
  }
  function plural(n, w) { return n + ' ' + w + (n === 1 ? '' : 's'); }
  // A channel whose probe left notes (timed out, missing helper, unreadable
  // reply) was only partly checked: never shown as a clean "up to date".
  function incomplete(ch) { return (ch.notes || []).length > 0; }
  function shown(ch) { return ch.state !== 'absent' && ch.state !== 'empty'; }
  function hhmm(iso) {
    var d = new Date(iso);
    return isNaN(d) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  function cap(s) { s = String(s || ''); return s.charAt(0).toUpperCase() + s.slice(1); }

  // A command breaks only BETWEEN its arguments: each word is a nowrap span,
  // so «--answerclean=None» never splits into «--» and «answerclean».
  // (Only a single word wider than the panel still breaks, inside .t.)
  function cmdHtml(cmd) {
    return '<code class="upd-code">' + String(cmd).split(' ').map(function (w) {
      return '<span class="t">' + esc(w) + '</span>';
    }).join(' ') + '</code>';
  }

  function copyBtn(i, main) {
    return main
      ? '<button type="button" class="upd-copy" data-copy="' + i + '">' + IC_COPY + '<span>Copy command</span></button>'
      : '<button type="button" class="upd-copy2" data-copy="' + i + '">' + IC_COPY + '<span>Copy</span></button>';
  }

  function itemList(items) {
    if (!items || !items.length) return '';
    return '<ul class="upd-list">' + items.map(function (it) {
      return '<li>' +
        (it.group ? '<span class="g">' + esc(it.group) + '</span>' : '') +
        '<span class="n">' + esc(it.name) + '</span>' +
        '<span class="v">' + (it.from ? esc(it.from) + ' → ' : '') + esc(it.to || '') + '</span></li>';
    }).join('') + '</ul>';
  }

  function channelRow(ch, cmds) {
    var nm = split(ch.name), st, stCls, rowCls = 'upd-ch';
    if (ch.state === 'error') { st = 'error'; stCls = 'bad'; }
    else if (ch.state === 'outdated') { st = plural(ch.count, 'update'); stCls = 'on'; rowCls += ' is-outdated'; }
    else if (incomplete(ch)) { st = 'not sure'; stCls = 'warn'; }
    else { st = 'up to date'; stCls = 'ok'; rowCls += ' is-current'; }

    // Errors do not hide behind the fold: the reason is the row's second line.
    var sub = nm.kind;
    if (ch.state === 'error') sub = ch.reason || 'could not be checked';
    else if (ch.state !== 'outdated' && incomplete(ch)) sub = ch.notes[0];
    var body = '';
    if (ch.state === 'error') body += '<p class="upd-warn">Could not check: ' + esc(ch.reason || 'unknown error') + '</p>';
    (ch.notes || []).forEach(function (n) { body += '<p class="upd-warn">' + esc(n) + '</p>'; });
    if (ch.state === 'outdated') {
      cmds.push(ch.command);
      body +=
        '<p>Just this channel:</p>' +
        cmdHtml(ch.command) + copyBtn(cmds.length - 1, false) +
        (ch.detail ? '<p><b>Waiting:</b> ' + esc(ch.detail) + '.</p>' : '') +
        itemList(ch.items) +
        '<p><b>What the command does:</b> ' + esc(ch.does) + '</p>' +
        '<p><b>What it silences:</b> ' + esc(ch.silences) + '</p>';
    }
    body += '<p><b>What it is:</b> ' + esc(ch.what || ch.short) + '</p>';

    return '<details class="' + rowCls + '"><summary>' + IC_CHEV +
      '<span class="upd-nm"><b>' + esc(nm.name) + '</b>' + (sub ? '<span' + (sub !== nm.kind ? ' class="why ' + stCls + '"' : '') + '>' + esc(sub) + '</span>' : '') + '</span>' +
      '<span class="upd-st ' + stCls + '">' + esc(st) + '</span></summary>' +
      '<div class="upd-body">' + body + '</div></details>';
  }

  // Arch goes through sudo: only then does the PC ask for its password.
  function needsPassword(d) {
    return (d.allInOneChannels || []).some(function (n) { return /^Arch\b/.test(n); });
  }

  function heroReady(d, cmds, model) {
    var label = (d.machine && d.machine.label) || 'this machine';
    var chs = (d.channels || []).filter(shown);
    var errs = chs.filter(function (c) { return c.state === 'error'; });
    var unsure = chs.filter(function (c) { return c.state !== 'error' && incomplete(c); });
    var probs = errs.concat(unsure).map(function (c) { return split(c.name).name; });
    var probLine = probs.length
      ? andList(probs) + (probs.length === 1 ? ' was' : ' were') + ' not fully checked — see ' + (probs.length === 1 ? 'its row' : 'the rows') + ' below.'
      : '';
    var notice = model && model.notice ? '<p class="upd-warn" role="status">' + esc(model.notice) + '</p>' : '';

    if (d.allInOne) {
      cmds.push(d.allInOne);
      var total = d.totalUpdates || 0;
      var names = (d.allInOneChannels || []).map(function (n) { return split(n).name; });
      var gesture;
      if (model && (model.confirm || model.starting)) {
        // The confirm lives IN the block, never a system popup.
        gesture = '<div class="upd-confirm" role="group" aria-label="Confirm the update">' +
          '<p>Update ' + esc(plural(total, 'package')) + ' now?' +
          (needsPassword(d) ? '<span>The PC asks for its password.</span>' : '') + '</p>' +
          '<div class="upd-pair">' +
          '<button type="button" class="upd-go" data-act="start"' + (model.starting ? ' disabled' : '') + '>' + (model.starting ? 'Starting…' : 'Update') + '</button>' +
          '<button type="button" class="upd-ghost" data-act="cancel"' + (model.starting ? ' disabled' : '') + '>Cancel</button>' +
          '</div></div>';
      } else {
        gesture = '<button type="button" class="upd-go" data-act="confirm">' + IC_GO + '<span>Update everything</span></button>';
      }
      return '<section class="upd-hero is-work" aria-live="polite">' +
        '<h3 class="upd-h">' + esc(plural(total, 'update')) + ' waiting</h3>' +
        '<p class="upd-lede">In ' + esc(andList(names)) + '.' + (names.length > 1 ? ' One tap updates them all, in order.' : '') + '</p>' +
        gesture + notice +
        (probLine ? '<p class="upd-warn">' + esc(probLine) + '</p>' : '') +
        '<details class="upd-alt"><summary>' + IC_CHEV + '<span>Or paste the command in a terminal</span></summary>' +
        cmdHtml(d.allInOne) +
        copyBtn(cmds.length - 1, true) +
        '<p class="upd-hint">Paste it in a terminal on ' + esc(label) + '. It asks you to confirm, and to pick a provider when a package has more than one.</p>' +
        '</details>' +
        '</section>';
    }
    if (!chs.length) {
      return '<section class="upd-hero" aria-live="polite"><h3 class="upd-h calm"><span class="upd-dot"></span>No update channels here</h3>' +
        '<p class="upd-lede">None of yay, Flatpak, npm or uv is set up on ' + esc(label) + '.</p>' + notice + '</section>';
    }
    if (probs.length) {
      return '<section class="upd-hero" aria-live="polite"><h3 class="upd-h calm"><span class="upd-dot warn"></span>Nothing to update found</h3>' +
        '<p class="upd-warn">' + esc(probLine) + '</p>' + notice + '</section>';
    }
    return '<section class="upd-hero" aria-live="polite"><h3 class="upd-h calm"><span class="upd-dot ok"></span>Everything is up to date</h3>' +
      '<p class="upd-lede">' + esc(andList(chs.map(function (c) { return split(c.name).name; }))) + ' checked at ' + esc(hhmm(d.generatedAt)) + '.</p>' + notice + '</section>';
  }

  // ── The run: pure helpers ─────────────────────────────────────────
  function logLines(log) {
    return String(log || '').split('\n').filter(function (l) { return /\S/.test(l); });
  }
  function tailLines(log, n) { var a = logLines(log); return a.slice(Math.max(0, a.length - n)); }

  // ONE sentence on what is happening, from the last useful line.
  function phrase(run) {
    var st = run.st || {};
    if (run.state === 'starting') return 'Starting…';
    if (liveAsk(run)) return 'Waiting for you';
    var lines = logLines(run.log).filter(function (l) { return !/^\[151/.test(l); });
    var last = lines[lines.length - 1] || '';
    var recent = lines.slice(-6).join('\n');
    var m, p = st.progress;
    if (/:: Running post-transaction hooks|^\(\s*\d+\/\d+\)\s+(?:Arming|Reloading|Refreshing|Updating (?:the|icon|module|linux|fontconfig|desktop|MIME|GIO|GTK|journal|system)|Cleaning|Creating|Restarting)/i.test(last)) return 'Finishing up…';
    if (p && new RegExp('\\(\\s*' + p.n + '\\/' + p.total + '\\)\\s+' + p.what).test(last)) {
      return (p.what === 'removing' ? 'Removing ' : 'Updating ') + p.n + ' of ' + p.total;
    }
    var builds = String(run.log || '').match(/==> Making package: (\S+)/g);
    if (builds && /^==> |^\s+-> |^(?:make|cmake|ninja|gcc|cc|g\+\+|cargo|go|npm|meson|\[\s*\d+%\])/.test(last)) {
      return 'Building ' + cap(builds[builds.length - 1].replace(/^==> Making package: /, '')) + '…';
    }
    if (/checking keyring|checking package integrity|loading package files|checking for file conflicts|checking available disk space|checking keys/i.test(last)) return 'Checking the packages…';
    if (/:: Synchronizing|:: Retrieving|downloading|\d+(?:\.\d+)?\s*[KMG]iB\/s|Total Download|-> Downloading|Cloning into/i.test(last)) return 'Downloading…';
    if (/Looking for updates|Updating (?:app|runtime)\/|^\s*\d+\.\s+\S+\s+\S+\s+[ui]\s|flatpak/i.test(recent) && !/pacman|yay/.test(last)) return 'Updating Flatpak apps…';
    if (/^(?:changed|added|removed) \d+ packages?|^npm (?:warn|notice)/i.test(last)) return 'Updating npm packages…';
    if ((m = last.match(/^(?:Updated|Resolved|Prepared|Installed|Uninstalled)\s/)) && m) return 'Updating Python tools…';
    if (p) return 'Updating ' + Math.min(p.n, p.total) + ' of ' + p.total;
    return 'Working…';
  }

  function progressHtml(run) {
    var p = run.st && run.st.progress;
    var waiting = !!liveAsk(run);
    if (!p || !p.total) {
      return '<div class="upd-bar' + (waiting ? '' : ' ind') + '" role="progressbar" aria-label="Update progress"><i' + (waiting ? ' style="transform:scaleX(0)"' : '') + '></i></div>' +
        '<div class="upd-prog"><span class="p">' + esc(waiting ? 'Paused until you answer' : run.state === 'starting' ? 'Opening the terminal on the PC' : 'Preparing') + '</span></div>';
    }
    var frac = Math.max(0.02, Math.min(1, p.n / p.total)).toFixed(3);
    return '<div class="upd-bar" role="progressbar" aria-label="Update progress" aria-valuemin="0" aria-valuemax="' + p.total + '" aria-valuenow="' + p.n + '"><i style="transform:scaleX(' + frac + ')"></i></div>' +
      '<div class="upd-prog"><span class="p">' + esc(p.pkg) + '</span><span class="c">' + p.n + ' / ' + p.total + '</span></div>';
  }

  function tailHtml(log) {
    return tailLines(log, TAIL_LINES).map(function (l) { return '<div>' + esc(l) + '</div>'; }).join('');
  }

  // The options of a numbered choice: «1) jack2  2) pipewire-jack».
  function choices(ctx) {
    var out = [], re = /(?:^|\s)(\d{1,3})\)\s+(\S+)/g, m;
    while ((m = re.exec(String(ctx || '')))) out.push({ n: m[1], name: m[2] });
    return out;
  }

  // The question block. Every answer goes through one form/button with
  // data-answer, and the client never keeps what was typed.
  function askHtml(ask, run) {
    if (!ask) return '';
    var msg = '<p class="upd-ask-msg" role="status"></p>';
    var line = String(ask.line || '');
    if (ask.kind === 'password') {
      var wrong = /Sorry, try again/i.test(tailLines(run && run.log, 4).join('\n'));
      return '<form class="upd-ask" data-kind="password" autocomplete="off" novalidate>' +
        '<label class="upd-ask-t" for="upd-answer">' + IC_LOCK + '<span>Password of the PC</span></label>' +
        '<p class="upd-ask-sub' + (wrong ? ' bad' : '') + '">' + (wrong
          ? 'That password was wrong. Try again.'
          : 'The system updates need it. It goes to the PC only, and is not kept.') + '</p>' +
        '<div class="upd-ask-row"><input id="upd-answer" class="upd-in" type="password" name="upd-pc-password" autocomplete="new-password" autocapitalize="off" autocorrect="off" spellcheck="false" required>' +
        '<button type="submit" class="upd-send">Send</button></div>' + msg + '</form>';
    }
    if (ask.kind === 'yesno') {
      var def = (line.match(/\[([yY])\/([nN])\]/) || []);
      var yDef = def[1] === 'Y', nDef = def[2] === 'N';
      return '<div class="upd-ask" data-kind="yesno" role="group" aria-labelledby="upd-ask-t">' +
        '<p class="upd-ask-t" id="upd-ask-t">' + IC_ASK + '<span>The PC is asking</span></p>' +
        '<p class="upd-ask-q">' + esc(line) + '</p>' +
        '<div class="upd-ans-grid">' +
        '<button type="button" class="upd-ans' + (yDef ? ' is-def' : '') + '" data-answer="y">Yes' + (yDef ? '<small>default</small>' : '') + '</button>' +
        '<button type="button" class="upd-ans' + (nDef ? ' is-def' : '') + '" data-answer="n">No' + (nDef ? '<small>default</small>' : '') + '</button>' +
        '</div>' + msg + '</div>';
    }
    if (ask.kind === 'choice') {
      var opts = choices(ask.ctx), dm = line.match(/default=(\d+)/), d = dm ? dm[1] : null;
      var q = '<p class="upd-ask-q">' + esc(String(ask.ctx || line).replace(/\n+$/, '')) + '</p>';
      var pick = opts.length && opts.length <= 8
        ? '<div class="upd-ans-grid">' + opts.map(function (o) {
          return '<button type="button" class="upd-ans' + (o.n === d ? ' is-def' : '') + '" data-answer="' + esc(o.n) + '">' + esc(o.n) +
            '<small class="n">' + esc(o.name) + '</small>' + (o.n === d ? '<small>default</small>' : '') + '</button>';
        }).join('') + '</div>'
        : '<form class="upd-ask-row" data-kind="choice"><input id="upd-answer" class="upd-in" type="text" inputmode="numeric" pattern="[0-9]*" maxlength="3" aria-label="Number" placeholder="' + esc(d || '1') + '" autocomplete="off">' +
          '<button type="submit" class="upd-send">Send</button></form>';
      return '<div class="upd-ask" data-kind="choice" role="group" aria-labelledby="upd-ask-t">' +
        '<p class="upd-ask-t" id="upd-ask-t">' + IC_ASK + '<span>Pick one</span></p>' + q + pick + msg + '</div>';
    }
    // text (and anything unknown)
    return '<form class="upd-ask" data-kind="text" autocomplete="off">' +
      '<label class="upd-ask-t" for="upd-answer">' + IC_ASK + '<span>The PC is asking</span></label>' +
      '<p class="upd-ask-q">' + esc(String(ask.ctx || line).replace(/\n+$/, '')) + '</p>' +
      '<div class="upd-ask-row"><input id="upd-answer" class="upd-in" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" maxlength="256" aria-label="Answer">' +
      '<button type="submit" class="upd-send">Send</button></div>' +
      '<p class="upd-ask-sub">Leave it empty and Send to keep the default.</p>' + msg + '</form>';
  }

  // The ask the panel should show: the server's, unless it is the one just
  // answered (same output size: the PC has not moved on yet).
  function liveAsk(run) {
    var a = run.st && run.st.ask;
    if (!a || (run.answeredAt != null && run.answeredAt === run.size)) return null;
    return a;
  }
  function askKey(a) { return a ? a.kind + '|' + a.line + '|' + (a.ctx || '') : ''; }

  // The last lines, then one row of buttons (Show all + extra), then the
  // full log when asked. With the full log open the short tail steps aside.
  function logBlock(run, extra) {
    return '<div class="upd-tail" aria-label="Last lines of the output">' + tailHtml(run.log) + '</div>' +
      '<div class="upd-end"><button type="button" class="upd-ghost" data-act="all" aria-expanded="' + (run.showAll ? 'true' : 'false') + '">' + (run.showAll ? 'Hide the full log' : 'Show all') + '</button>' + (extra || '') + '</div>' +
      '<pre class="upd-all"' + (run.showAll ? '' : ' hidden') + '>' + (run.showAll ? esc(run.log) : '') + '</pre>';
  }

  function runSection(run) {
    var meta = (run.st && run.st.meta) || run.meta || {};
    var chans = (meta.channels || []).map(function (n) { return split(n).name; });
    var started = meta.startedAt ? hhmm(meta.startedAt) : '';
    var sub = (started ? 'Started ' + esc(started) : '') + (chans.length ? (started ? ' · ' : '') + esc(andList(chans)) : '');
    if (run.state === 'starting' || run.state === 'live') {
      var ask = liveAsk(run);
      return '<section class="upd-hero is-run upd-run' + (run.showAll ? ' is-all' : '') + '" data-run="' + esc(run.id || '') + '">' +
        '<div class="upd-run-head">' +
        '<h3 class="upd-h upd-phrase" aria-live="polite"><span class="upd-dot busy"></span><span class="tx">' + esc(phrase(run)) + '</span></h3>' +
        (sub ? '<p class="upd-lede">' + sub + '</p>' : '') +
        progressHtml(run) +
        (run.note ? '<p class="upd-note" role="status">' + esc(run.note) + '</p>' : '') +
        '</div>' +
        '<div class="upd-ask-slot" data-key="' + esc(askKey(ask)) + '">' + askHtml(ask, run) + '</div>' +
        logBlock(run) +
        '<p class="upd-hint">It keeps going if you close the app. It cannot be cut short on purpose: halting it halfway can break the system.</p>' +
        '</section>';
    }
    var st = run.st || {}, head, cls, extra = '';
    if (run.state === 'ok') {
      cls = 'is-ok';
      head = '<span class="upd-dot ok"></span>Done — ' + (st.changed > 0 ? esc(plural(st.changed, 'package')) + ' updated' : 'everything updated');
      if (st.restartAdvised) {
        extra = '<div class="upd-restart" role="status">' + IC_POWER +
          '<div><b>Restart the PC when you can</b><span>New system parts are waiting.</span></div></div>';
      }
    } else if (run.state === 'lost') {
      cls = 'is-lost';
      head = '<span class="upd-dot warn"></span>The update was interrupted';
      extra = '<p class="upd-lede">It stopped without finishing. The last lines:</p>';
    } else {
      cls = 'is-failed';
      head = '<span class="upd-dot bad"></span>The update stopped';
      extra = '<p class="upd-lede">' + (st.exit != null ? 'It ended with code ' + esc(st.exit) + '. ' : '') + 'The last lines:</p>';
    }
    return '<section class="upd-hero ' + cls + ' upd-run' + (run.showAll ? ' is-all' : '') + '" data-run="' + esc(run.id || '') + '" aria-live="polite">' +
      '<h3 class="upd-h calm">' + head + '</h3>' +
      (sub ? '<p class="upd-lede">' + sub + '</p>' : '') +
      extra + logBlock(run, '<button type="button" class="upd-ghost" data-act="dismiss">Dismiss</button>') +
      '</section>';
  }

  function isLive(run) { return !!run && (run.state === 'starting' || run.state === 'live'); }

  // model: { phase: 'loading', slow } | { phase: 'down', headline, detail } |
  //        { phase: 'ready', data }, plus optionally run, confirm, starting,
  //        notice. Returns { html, cmds }.
  function view(model, who) {
    var cmds = [], label = (who && who.label) || 'Computer';
    var meta, hero = '', list = '', foot = '', run = model.run || null, live = isLive(run);
    if (model.phase === 'loading') {
      meta = '<b>' + esc(label) + '</b> · checking';
      hero = '<section class="upd-hero" aria-live="polite"><h3 class="upd-h calm"><span class="upd-dot busy"></span>Checking for updates…</h3>' +
        '<p class="upd-lede">' + (model.slow
          ? 'Still checking. The network checks can take up to 2 minutes.'
          : 'Asking yay, Flatpak, npm and uv. Usually a few seconds.') + '</p></section>';
    } else if (model.phase === 'down') {
      meta = '<b>' + esc(label) + '</b> · no data';
      hero = '<section class="upd-hero is-down" aria-live="polite"><h3 class="upd-h calm"><span class="upd-dot bad"></span>' + esc(model.headline) + '</h3>' +
        (model.detail ? '<p class="upd-lede">' + esc(model.detail) + '</p>' : '') +
        '<p class="upd-hint">Nothing was changed. Try “Check again”.</p></section>';
    } else {
      var d = model.data, m = d.machine || {};
      meta = '<b>' + esc(m.label || label) + '</b>' + (m.hostname ? ' · ' + esc(m.hostname) : '') + ' · checked ' + esc(hhmm(d.generatedAt));
      hero = heroReady(d, cmds, model);
      var chs = (d.channels || []).filter(shown);
      if (chs.length) {
        list = '<h4 class="upd-sec">Channels</h4><div class="upd-chs">' +
          chs.map(function (c) { return channelRow(c, cmds); }).join('') + '</div>';
      }
      var absent = (d.channels || []).filter(function (c) { return !shown(c); })
        .map(function (c) { return split(c.name).name; });
      if (absent.length) foot += '<p class="upd-foot">Not set up on ' + esc(m.label || label) + ': ' + esc(andList(absent)) + '.</p>';
    }
    if (live) {
      // While it runs, the run is the whole panel: the old count is a lie.
      meta = '<b>' + esc(label) + '</b> · updating';
      hero = ''; list = ''; foot = '';
    }
    if (!live) foot += '<p class="upd-foot">Update everything runs only the commands of the channels below. The password goes to the PC and nowhere else.</p>';
    var html = '<div class="upd-wrap">' +
      '<div class="upd-top"><div class="upd-meta">' + meta + '</div>' +
      (live ? '' : '<button type="button" class="upd-again"' + (model.phase === 'loading' ? ' disabled' : '') + '>' + IC_AGAIN +
      '<span>' + (model.phase === 'loading' ? 'Checking…' : 'Check again') + '</span></button>') + '</div>' +
      (run ? runSection(run) : '') + hero + list + foot + '</div>';
    return { html: html, cmds: cmds };
  }

  // ── Panel ──────────────────────────────────────────────────────────
  function mount(host) {
    injectCSS();
    if (poller) { poller.stop(); poller = null; }
    var gen = 0, who = null, slowTimer = null;
    var S = { phase: 'loading' };   // the model; S.run is the update, if any
    var v = { cmds: [] };

    function render() {
      var keep = host.querySelector('.upd-wrap');
      var top = keep ? keep.scrollTop : 0;
      v = view(S, who);
      host.innerHTML = v.html;
      var wrap = host.querySelector('.upd-wrap');
      if (wrap && S.phase === 'ready') wrap.scrollTop = top;
      wire();
      if (S.run && isLive(S.run)) focusAsk();
    }

    function wire() {
      var again = host.querySelector('.upd-again');
      if (again) again.addEventListener('click', check);
      host.querySelectorAll('[data-copy]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          var text = v.cmds[+btn.getAttribute('data-copy')];
          var lbl = btn.querySelector('span'), was = lbl.textContent, icon = btn.querySelector('svg').outerHTML;
          copyText(text).then(function (ok) {
            if (!ok) { toast('Copy failed: select the command and copy it by hand'); return; }
            btn.classList.add('done');
            btn.querySelector('svg').outerHTML = IC_CHECK;
            lbl.textContent = btn.classList.contains('upd-copy2') ? 'Copied' : 'Copied — paste it in a terminal';
            setTimeout(function () {
              btn.classList.remove('done');
              var s = btn.querySelector('svg'); if (s) s.outerHTML = icon;
              lbl.textContent = was;
            }, 1800);
          });
        });
      });
      host.querySelectorAll('[data-act]').forEach(function (btn) {
        btn.addEventListener('click', function () { act(btn.getAttribute('data-act')); });
      });
      wireAsk();
    }

    function act(what) {
      if (what === 'confirm') { S.confirm = true; S.notice = ''; render(); var b = host.querySelector('[data-act="start"]'); if (b) b.focus(); }
      else if (what === 'cancel') { S.confirm = false; render(); var g = host.querySelector('[data-act="confirm"]'); if (g) g.focus(); }
      else if (what === 'start') start();
      else if (what === 'dismiss') {
        try { localStorage.setItem(DISMISS_KEY, S.run.id); } catch (_) {}
        S.run = null; render();
      } else if (what === 'all') {
        S.run.showAll = !S.run.showAll;
        var btn = host.querySelector('[data-act="all"]'), pre = host.querySelector('.upd-all');
        if (!btn || !pre) return;
        btn.textContent = S.run.showAll ? 'Hide the full log' : 'Show all';
        btn.setAttribute('aria-expanded', S.run.showAll ? 'true' : 'false');
        pre.hidden = !S.run.showAll;
        var sec = host.querySelector('.upd-run'); if (sec) sec.classList.toggle('is-all', S.run.showAll);
        pre.textContent = S.run.showAll ? S.run.log : '';
        if (S.run.showAll) pre.scrollTop = pre.scrollHeight;
      }
    }

    // ── Start ──
    function start() {
      S.starting = true; S.notice = ''; render();
      postJson('/update/start', { confirm: true }).then(function (x) {
        S.starting = false; S.confirm = false;
        if (x.status === 200 && x.body.id) {
          attach(x.body.id, { startedAt: Date.now(), channels: x.body.channels, totalUpdates: x.body.totalUpdates });
        } else if (x.status === 409 && x.body.id) {
          attach(x.body.id, null, 'An update was already running: this is it.');
        } else if (x.status === 400 && /nothing to update/i.test(x.body.error || '')) {
          S.notice = 'Nothing to update any more.'; check();
        } else if (x.status === 401) {
          S.notice = 'The Machine wants you to log in again. Nothing was started.'; render();
        } else {
          S.notice = 'Could not start: ' + (x.body.error || ('the server answered ' + x.status)) + '. Nothing was changed.'; render();
        }
      }).catch(function () {
        S.starting = false;
        S.notice = 'The Machine could not be reached. Nothing was started.'; render();
      });
    }

    // ── Live run ──
    function attach(id, meta, note) {
      S.run = { id: id, state: 'starting', meta: meta || null, log: '', size: 0, st: null, note: note || '', misses: 0, showAll: false, answeredAt: null };
      render();
      if (poller) poller.stop();
      var busy = false, run = S.run;
      function tick() {
        if (!host.isConnected || S.run !== run) { stop(); return; }
        if (busy) return;
        busy = true;
        call('/update/status?id=' + encodeURIComponent(id) + '&since=' + run.size)
          .then(function (r) {
            if (r.status === 404) return { gone: true };
            if (!r.ok) throw new Error('HTTP ' + r.status);
            return r.json();
          })
          .then(function (st) {
            busy = false;
            if (S.run !== run) return;
            if (st.gone) { run.state = 'lost'; run.st = run.st || {}; run.st.lost = true; stop(); render(); check(); return; }
            absorb(run, st);
          })
          .catch(function () {
            busy = false;
            if (S.run !== run) return;
            run.misses++;
            if (run.misses === 3) setNote(run, 'No news from the Machine for a few seconds. The update goes on; still trying.');
          });
      }
      var b = window.Battito && typeof window.Battito.ogni === 'function'
        ? window.Battito.ogni('updates-run', POLL_MS, tick)
        : null;
      function stop() { if (b) { b.ferma(); b = null; } if (poller && poller.run === run) poller = null; }
      poller = { run: run, stop: stop };
      if (!b) setNote(run, 'Live updates are off here (no heartbeat). Reopen the panel to see the progress.');
    }

    function setNote(run, text) {
      run.note = text;
      var head = host.querySelector('.upd-run-head');
      if (!head) return;
      var n = head.querySelector('.upd-note');
      if (!n) { n = document.createElement('p'); n.className = 'upd-note'; n.setAttribute('role', 'status'); head.appendChild(n); }
      n.textContent = text;
    }

    function absorb(run, st) {
      if (run.misses >= 3) { run.misses = 0; run.note = ''; }
      run.misses = 0;
      run.size = st.size || 0;
      run.log = (run.log + (st.chunk || '')).slice(-LOG_CAP);
      run.st = st;
      if (!run.meta && st.meta) run.meta = st.meta;
      if (!st.running) {
        run.state = st.lost ? 'lost' : (st.exit === 0 ? 'ok' : 'failed');
        if (poller && poller.run === run) poller.stop();
        render();
        check();             // the counts below are fresh again
        return;
      }
      var first = run.state === 'starting';
      run.state = 'live';
      if (first || !host.querySelector('.upd-run-head')) { render(); return; }
      patchLive(run);
    }

    // Piece by piece: the head, the tail, the full log; the question only
    // when it changes — a half-typed password is never wiped by a tick.
    function patchLive(run) {
      var tx = host.querySelector('.upd-phrase .tx');
      var ph = phrase(run);
      if (tx && tx.textContent !== ph) tx.textContent = ph;
      var head = host.querySelector('.upd-run-head');
      var bar = head.querySelector('.upd-bar'), prog = head.querySelector('.upd-prog');
      var holder = document.createElement('div');
      holder.innerHTML = progressHtml(run);
      var nb = holder.querySelector('.upd-bar'), np = holder.querySelector('.upd-prog');
      if (bar && nb && bar.className !== nb.className) { bar.replaceWith(nb); }
      else if (bar && nb) {
        var i = bar.querySelector('i'), ni = nb.querySelector('i');
        if (i.getAttribute('style') !== ni.getAttribute('style')) i.setAttribute('style', ni.getAttribute('style') || '');
        ['aria-valuemax', 'aria-valuenow'].forEach(function (k) { if (nb.hasAttribute(k)) bar.setAttribute(k, nb.getAttribute(k)); });
      }
      if (prog && np && prog.innerHTML !== np.innerHTML) prog.innerHTML = np.innerHTML;
      var tail = host.querySelector('.upd-tail'), th = tailHtml(run.log);
      if (tail && tail.innerHTML !== th) tail.innerHTML = th;
      var pre = host.querySelector('.upd-all');
      if (pre && run.showAll) {
        var atEnd = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 8;
        if (pre.textContent.length !== run.log.length) pre.textContent = run.log;
        if (atEnd) pre.scrollTop = pre.scrollHeight;
      }
      var slot = host.querySelector('.upd-ask-slot'), ask = liveAsk(run), key = askKey(ask);
      if (slot && slot.getAttribute('data-key') !== key) {
        slot.setAttribute('data-key', key);
        slot.innerHTML = askHtml(ask, run);
        wireAsk();
        focusAsk();
      }
    }

    function focusAsk() {
      var slot = host.querySelector('.upd-ask-slot');
      if (!slot || !slot.firstChild) return;
      var f = slot.querySelector('input') || slot.querySelector('.upd-ans.is-def') || slot.querySelector('.upd-ans');
      if (!f) return;
      try { f.focus({ preventScroll: true }); } catch (_) { f.focus(); }
      try { slot.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch (_) {}
    }

    function wireAsk() {
      var slot = host.querySelector('.upd-ask-slot');
      if (!slot || slot.__wired === slot.getAttribute('data-key')) return;
      slot.__wired = slot.getAttribute('data-key');
      slot.querySelectorAll('[data-answer]').forEach(function (b) {
        b.addEventListener('click', function () { send(b.getAttribute('data-answer')); });
      });
      slot.querySelectorAll('form').forEach(function (f) {
        f.addEventListener('submit', function (e) {
          e.preventDefault();
          var input = f.querySelector('input');
          if (!input) return;
          var kind = slot.querySelector('.upd-ask').getAttribute('data-kind');
          if (kind === 'password' && !input.value) { msg('Type the password first.', true); input.focus(); return; }
          if (kind === 'choice' && !/^\d{1,3}$/.test(input.value)) { msg('Type one of the numbers.', true); input.focus(); return; }
          // The value lives only in this call: the field is emptied at once,
          // nothing keeps it (/hack 16/10).
          var body = JSON.stringify({ id: S.run.id, text: input.value });
          input.value = '';
          sendBody(body);
          body = null;
        });
      });
    }

    function msg(text, bad) {
      var m = host.querySelector('.upd-ask-msg');
      if (!m) return;
      m.textContent = text;
      m.classList.toggle('bad', !!bad);
    }

    function send(text) { sendBody(JSON.stringify({ id: S.run.id, text: text })); }

    function sendBody(body) {
      var run = S.run;
      var slot = host.querySelector('.upd-ask-slot');
      var ctrls = slot ? slot.querySelectorAll('button,input') : [];
      ctrls.forEach(function (c) { c.disabled = true; });
      msg('Sending…');
      call('/update/answer', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body })
        .then(function (r) {
          if (S.run !== run) return;
          if (r.ok) {
            run.answeredAt = run.size;
            msg('Sent. The update goes on.');
            if (poller && poller.run === run && window.Battito) { /* the next tick picks it up */ }
            return;
          }
          ctrls.forEach(function (c) { c.disabled = false; });
          if (r.status === 403) msg('This device is not on Tailscale, so it cannot answer the PC. Turn Tailscale on, or answer from the PC.', true);
          else if (r.status === 409) msg('That question is gone: the update has moved on.', true);
          else if (r.status === 400) msg('The PC did not accept that answer. Try again.', true);
          else if (r.status === 401) msg('Log in to the Machine again, then answer.', true);
          else msg('Could not send (the server answered ' + r.status + '). Try again.', true);
          var i = slot && slot.querySelector('input'); if (i) i.focus();
        })
        .catch(function () {
          ctrls.forEach(function (c) { c.disabled = false; });
          msg('Could not reach the Machine. Try again.', true);
        });
    }

    // A finished run from the last hour shows on top, until dismissed.
    function showResult(cur) {
      var dismissed = '';
      try { dismissed = localStorage.getItem(DISMISS_KEY) || ''; } catch (_) {}
      if (!cur || cur.id === dismissed || !cur.meta || Date.now() - cur.meta.startedAt > RECENT_MS) return;
      call('/update/status?id=' + encodeURIComponent(cur.id) + '&since=0')
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (st) {
          if (!st || st.running || (S.run && S.run.id !== cur.id)) return;
          S.run = { id: cur.id, state: st.lost ? 'lost' : (st.exit === 0 ? 'ok' : 'failed'), meta: st.meta || cur.meta, log: (st.chunk || '').slice(-LOG_CAP), size: st.size, st: st, showAll: false };
          render();
        })
        .catch(function () {});
    }

    // ── Check ──
    function check() {
      var my = ++gen;
      clearTimeout(slowTimer);
      S.phase = 'loading'; S.slow = false; S.confirm = false;
      if (!isLive(S.run)) render();
      slowTimer = setTimeout(function () { if (my === gen) { S.slow = true; if (!isLive(S.run)) render(); } }, SLOW_MS);
      var ctl = typeof AbortController === 'function' ? new AbortController() : null;
      var ceiling = setTimeout(function () { if (ctl) ctl.abort(); }, CEILING_MS);
      function done(model) {
        clearTimeout(ceiling);
        if (my !== gen) return;          // a newer check owns the panel
        clearTimeout(slowTimer);
        S.phase = model.phase; S.data = model.data; S.headline = model.headline; S.detail = model.detail; S.slow = false;
        if (!isLive(S.run)) render();    // a live run is never repainted by a check
      }
      // whoami is cheap: the block gets its real name before the slow probes.
      if (!who) {
        call('/whoami').then(function (r) { return r.ok ? r.json() : null; })
          .then(function (me) {
            if (!me || !me.label || who) return;
            who = me;
            if (my === gen && S.phase === 'loading' && !isLive(S.run)) render();   // name the meta line
          })
          .catch(function () {});
      }
      call('/check', ctl ? { signal: ctl.signal } : {})
        .then(function (r) {
          return r.json().catch(function () { return null; }).then(function (d) { return { ok: r.ok, status: r.status, d: d }; });
        })
        .then(function (x) {
          if (x.ok && x.d && x.d.machine && !x.d.error) { who = x.d.machine; done({ phase: 'ready', data: x.d }); }
          else done({ phase: 'down', headline: 'The check failed', detail: (x.d && x.d.error) || ('The server answered ' + x.status + '.') });
        })
        .catch(function (e) {
          var aborted = e && e.name === 'AbortError';
          done({ phase: 'down', headline: aborted ? 'No answer in time' : 'No reply from the server',
            detail: aborted ? 'Nothing came back after 2½ minutes.' : 'The Machine could not be reached from here.' });
        });
    }

    // Is an update already running on the PC? Then the live view, at once.
    call('/update/current').then(function (r) { return r.ok ? r.json() : null; })
      .then(function (c) {
        var cur = c && c.run;
        if (!cur) return;
        if (cur.running) attach(cur.id, cur.meta);
        else showResult(cur);
      })
      .catch(function () {});
    check();
  }

  var api = {
    renderInPanel: function (container) { mount(container); },
    view: view,
    // For tests/updates-un-gesto.test.js (pure: strings in, strings out).
    _test: { phrase: phrase, askHtml: askHtml, runSection: runSection, choices: choices },
  };
  if (window.The151Machine && window.The151Machine.register) window.The151Machine.register(PLUGIN_ID, api);
})();
