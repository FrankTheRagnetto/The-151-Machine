/* The 151 Machine — Native Top Bar (Visual Architect, 2026-04-12; updated 2026-04-14)
 *
 * [2026-10-16] THE BLACK BAR IS GONE. It was #status-bar-slot >
 * #main-topbar: the usage pill on the left, «The 151 Machine» in the centre.
 * What this module still draws:
 *   - the USAGE PILL (Claude Code 5h session + 7d weekly %), built by ONE
 *     factory (buildUsage) and mounted in two places — the Sessions heading
 *     (#sidebar-header) and the chat row (#header, the phone's place: the
 *     sidebar is hidden there; main.css hides this copy from 1024px up).
 *     Tapping either opens #cc-usage-popup anchored to the one tapped.
 *   - the active session's MODEL chip on the chat row (#header-model-chip).
 * The wordmark went with the bar: the name stays on the login screen, in the
 * tab title and in the «151» emblem of the empty view.
 * Retired: the "daily protocol done" sun+X indicator (dailylog), the context-%
 * brain chip (2026-08-16), the RAM pill (2026-08-20), the «pc»/«pi» pills and
 * the bar itself (2026-10-16).
 *
 * All endpoints require JWT auth (token key: 151-terminal-token).
 * Poll every 5s. Degrade gracefully: show "—" on failure, never crash.
 *
 * [2026-09-22 BATTERIA] I due giri periodici di questo file (i quattro endpoint
 * ogni 5s, e la guardia del modello ogni 1s) passano da window.Battito
 * (public/js/battito.js): a schermo spento NON bussano, e al ritorno riparte
 * tutto con un giro immediato. Prima erano due `setInterval` nudi: ~48
 * richieste al minuto per sempre, anche di notte con l'audiolibro acceso —
 * esattamente la radio che il lavoro batteria del 16/08/2026 aveva smesso di
 * svegliare in ws.js, e che qui continuava a essere svegliata perché quella
 * riparazione aveva toccato solo ws.js. Sentinella:
 * tests/timer-a-schermo-spento.test.js.
 *
 */
(function() {
  var POLL_MS = 5000;
  // [2026-11-10 BATTERIA ] La pastiglia 5h/7d cambia di qualche punto
  // l'ora e il server la tiene in cache 60 s: chiederla ogni 5 s erano 12
  // richieste al minuto per niente. Ora al massimo una al minuto (il giro da
  // 5 s resta, ma senza rete: pollModel è locale).
  var CC_USAGE_MS = 60000;
  var _ccUltimaDomanda = 0;
  var LASTKNOWN_KEY = '151-lastknown-chips';
  var STALE_AFTER_MS = 5 * 60 * 1000; // 5 minutes — past this, the pill gets data-stale="1"
  var pollTimer = null;      // maniglia di window.Battito, non un id di setInterval
  var modelloBattito = null; // idem
  var lastCtxSessionId = null;
  // In-memory mirror of persisted chip state so we can write only the fields
  // that currently have a value (avoid clobbering a fresh poll with stale
  // data from another field).
  var _lastKnown = {};

  function loadLastKnown() {
    try {
      var raw = localStorage.getItem(LASTKNOWN_KEY);
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch (e) {}
    return null;
  }

  function saveLastKnown(patch) {
    try {
      Object.assign(_lastKnown, patch);
      _lastKnown.savedAt = Date.now();
      localStorage.setItem(LASTKNOWN_KEY, JSON.stringify(_lastKnown));
    } catch (e) {}
  }

  function markStaleIfOld(savedAt) {
    // Painted from a snapshot older than 5 minutes → dim the pill until the
    // next good poll. (The «device-s24» class that lived below went with the
    // bar on 2026-10-16: its only reader was the bar's top padding.)
    if (savedAt && (Date.now() - savedAt > STALE_AFTER_MS)) _cc.stale = true;
    paintUsage();
  }

  function token() {
    try { return localStorage.getItem('151-terminal-token') || ''; } catch(e) { return ''; }
  }

  function serverBase() {
    try { return (typeof getServerUrl === 'function' ? getServerUrl() : '') || ''; } catch(e) { return ''; }
  }

  function apiGet(path) {
    return fetch(serverBase() + path, {
      headers: { 'Authorization': 'Bearer ' + token() },
      cache: 'no-store'
    }).then(function(r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  }

  function apiPatch(path, body) {
    return fetch(serverBase() + path, {
      method: 'PATCH',
      headers: { 'Authorization': 'Bearer ' + token(), 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {})
    }).then(function(r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  }

  // --- Inline SVG icons, Feather-style (stroke=2, 24x24, round caps), 14px render.
  //     `currentColor` so they inherit theme tokens / chip color.
  var SVG_ATTRS = 'viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';
  var ICON = {
    // ICON.model (sparkle) DELETED 2026-08-20 round 2, punto 1 — the model chip
    // is now text-only, so the glyph had no remaining consumer.
    // ICON.ram DELETED 2026-08-20 round 2, punto 6 — the RAM pill was removed
    // from the bar entirely (layout decided by the owner), so nothing renders it.
    // ICON.usage (saetta) TOLTA il 2026-09-22 insieme al blocco «usage»: il
    // suo unico lettore possibile era pillWithBar('usage', ICON.usage), e
    // quella chiamata non e' mai esistita nel bar.innerHTML.
    // Claude Code 5h session limit: clock face.
    ccClock: '<svg ' + SVG_ATTRS + '><circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/></svg>',
    // Claude Code 7d weekly limit: calendar.
    // [2026-09-10] Dopo questa riga c'erano i tre disegni del vecchio
    // indicatore "protocollo giornaliero fatto" (dailylog, check, xmark).
    // La mattonella tb-dailylog è stata ritirata dalla barra (vedi il commento
    // della barra, tolta il 16/10) e da allora nessuno chiedeva più quei glifi:
    // verificato con una ricerca in tutto il repo, zero lettori.
    ccCal: '<svg ' + SVG_ATTRS + '><rect x="3" y="5" width="18" height="16" rx="2"/><line x1="3" y1="10" x2="21" y2="10"/><line x1="8" y1="3" x2="8" y2="7"/><line x1="16" y1="3" x2="16" y2="7"/></svg>'
  };

  // --- The usage pill, in the «Sessions» heading --------
  // ONE home: #sidebar-header, after the «Sessions» title. The second copy on
  // the chat row (#header, for the phone) was removed the same day: «I'm okay
  // with them only being on the left sidebar». On the phone they are
  // one swipe away, in the sidebar.
  // Idempotent: called on every poll, it re-creates the pill only if its host
  // re-rendered and wiped it, and paints it at once from the last value.
  function ensureUsage() {
    ensureModelChip();
    var side = document.getElementById('sidebar-header');
    if (side && !side.querySelector('.cc-usage')) side.appendChild(buildUsage());
    paintUsage();
    return document.querySelector('.cc-usage');
  }

  function buildUsage() {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'cc-usage tb-hidden';
    b.setAttribute('data-k', 'ccusage');
    b.setAttribute('aria-expanded', 'false');
    b.setAttribute('aria-label', 'Claude Code usage, 5 hours and weekly. Tap for reset times.');
    // Clock = 5h session limit, calendar = 7d weekly. Each % colours itself by
    // level (main.css .cc-seg[data-level]). Hidden until there is a value, so
    // it never flickers «—» on a cold boot.
    b.innerHTML = [
      '<span class="cc-seg" data-which="session" data-level="empty">',
        '<span class="cc-ico" aria-hidden="true">' + ICON.ccClock + '</span>',
        '<span class="cc-val">—</span>',
      '</span>',
      '<span class="cc-seg" data-which="weekly" data-level="empty">',
        '<span class="cc-ico" aria-hidden="true">' + ICON.ccCal + '</span>',
        '<span class="cc-val">—</span>',
      '</span>'
    ].join('');
    // A real <button>: Enter and Space work without a keydown handler.
    b.addEventListener('click', function() { toggleCcUsagePopup(b); });
    return b;
  }

  // The model chip lives on the SESSION NAME ROW (2026-08-20), immediately after
  // #header-title, not inside the status bar. Idempotent: safe to call on every
  // bar (re)build. Returns the chip element, or null if the header isn't up yet.
  function ensureModelChip() {
    var existing = document.getElementById('header-model-chip');
    if (existing) return existing;
    var header = document.getElementById('header');
    var titleEl = document.getElementById('header-title');
    if (!header || !titleEl) return null;
    var el = document.createElement('span');
    el.id = 'header-model-chip';
    el.className = 'tb-chip tb-pill tb-model';
    el.setAttribute('data-k', 'model');
    el.setAttribute('role', 'button');
    el.setAttribute('tabindex', '0');
    // NAME ONLY (2026-08-20 round 2, punto 1): the sparkle glyph was decoration
    // on a chip whose entire job is to say one word. No .tb-ico here any more.
    el.innerHTML = '<span class="tb-val">—</span>';
    // CHIP MODELLO CLICCABILE: tapping opens
    // the per-session model picker. The pick re-pins the OPEN session only.
    el.addEventListener('click', function() { toggleModelPopup(); });
    el.addEventListener('keydown', function(e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleModelPopup(); }
    });
    titleEl.insertAdjacentElement('afterend', el);
    return el;
  }

  // Only the model chip goes through here now; the usage pill has two copies
  // and is painted by paintUsage().
  function chip(k) {
    return document.querySelector('#header [data-k="' + k + '"]');
  }

  function setChip(k, text, opts) {
    var el = chip(k);
    if (!el) return;
    var val = el.querySelector('.tb-val');
    if (val) val.textContent = text;
    if (opts && opts.hidden) el.classList.add('tb-hidden');
    else el.classList.remove('tb-hidden');
    if (opts && opts.state) {
      el.dataset.state = opts.state;
    } else if (el.dataset.state) {
      delete el.dataset.state;
    }
    // [2026-09-22, secondo giro di potatura] Tolto il ramo `tb-has-bar`, che
    // guidava la barretta di avanzamento delle pastiglie (--pct per la
    // larghezza, data-level per il colore). La classe tb-has-bar la metteva
    // SOLO pillWithBar(), tolta stamattina, e nessun chiamante di setChip()
    // passa piu' `opts.pct`: il ramo era un `if` che non poteva accendersi.
    // Tolte nello stesso atto le sue regole CSS (.tb-has-bar, .tb-bar,
    // .tb-fill, main.css). La pastiglia ccusage NON passa di qui per il
    // colore: ha le sue regole su .tb-cc-seg[data-level] e il suo
    // _writeCcSegment().
  }

  // --- Individual fetchers (each isolated so one failure never blocks others) ---

  // Active session model chip (2026-08-16, replaces the context-% chip).
  // Source of truth: sessions[].model (DTO field, refreshed via WS/model_info),
  // prettified by sessions.js's global prettifyModelId ("claude-fable-5[1m]"
  // → "Fable 5"). Tracks the last shown label so the 1s watcher can catch a
  // mid-session model downgrade, not just session switches.
  var lastModelLabel = null;

  function pollModel() {
    var sid = window.activeSessionId;
    lastCtxSessionId = sid || null;
    var label = '—';
    var fullId = '';
    try {
      if (sid) {
        var sess = (Array.isArray(window.sessions) ? window.sessions : []).find(function(s) { return s && s.id === sid; });
        fullId = (sess && sess.model) || '';
        if (fullId && typeof window.prettifyModelId === 'function') {
          label = window.prettifyModelId(fullId) || '—';
        } else if (fullId) {
          label = fullId;
        }
      }
    } catch (e) {}
    lastModelLabel = label;
    setChip('model', label);
    var el = chip('model');
    if (el) el.title = fullId || 'Active session model';
  }

  // --- Per-session model picker popup --------
  // Chip tap → list of pickable models from GET /api/models (Fable 5, Opus 5,
  // Opus 4-8). Picking one PATCHes /api/sessions/:id/model — the pin applies to
  // the OPEN session only (super agents included) from its NEXT message; the
  // server broadcasts session_model_changed so chip + card update on every
  // device (PC and phone). List cached after first fetch; refreshed each open.
  var _modelList = null;

  function toggleModelPopup() {
    var existing = document.getElementById('model-pick-popup');
    if (existing) {
      existing.remove();
      document.removeEventListener('click', dismissModelPopup);
      return;
    }
    if (!window.activeSessionId) return; // nothing open — nothing to re-pin
    var hadCache = !!_modelList;
    if (hadCache) renderModelPopup(_modelList);
    apiGet('/api/models').then(function(d) {
      if (!d || !Array.isArray(d.models) || !d.models.length) return;
      // VIA HAIKU (2026-08-16, round #6) E VIA SONNET (2026-08-19): drop any
      // family that must not be hand-picked, even if the server still lists it
      // (older PC behind the phone, or a process started before this change).
      // Deny-list — a NEW family the server adds still shows up untouched.
      _modelList = (typeof window.filterSelectableModels === 'function')
        ? window.filterSelectableModels(d.models)
        : d.models;
      if (!_modelList.length) _modelList = d.models;
      // Re-render only on first open (no cache yet) or if still open.
      if (!hadCache || document.getElementById('model-pick-popup')) renderModelPopup(_modelList);
    }).catch(function() {
      // Offline / error with no cache → fall back to the static families so
      // the picker still opens (server validates the id anyway). Mirrors the
      // server's SELECTABLE_FAMILIES — Haiku (2026-08-16) and Sonnet
      // (2026-08-19) are NOT clickable; both survive only in the internal
      // automatic fallback ladder and on sessions already pinned to them.
      if (!_modelList) renderModelPopup(window.SELECTABLE_MODEL_FAMILIES || ['fable', 'opus']);
    });
  }

  function renderModelPopup(models) {
    var existing = document.getElementById('model-pick-popup');
    if (existing) existing.remove();
    var anchorEl = chip('model');
    if (!anchorEl) return;
    var rect = anchorEl.getBoundingClientRect();
    var sid = window.activeSessionId;
    var sess = (Array.isArray(window.sessions) ? window.sessions : []).find(function(s) { return s && s.id === sid; });
    var current = (sess && sess.model) || '';

    var popup = document.createElement('div');
    popup.id = 'model-pick-popup';
    popup.style.top = (rect.bottom + 6) + 'px';
    var popupWidth = 180;
    popup.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - popupWidth - 8)) + 'px';
    popup.style.width = popupWidth + 'px';

    // FAMIGLIE (2026-08-16): entries are bare family names ('fable', 'opus',
    // 'sonnet', 'haiku'). The active row is the family of the session's
    // CURRENT model ('claude-fable-5[1m]' → 'fable'), so the check follows the
    // precise model the chip shows.
    var curFamMatch = current.toLowerCase().replace(/^claude-/, '').match(/^[a-z]+/);
    var curFam = curFamMatch ? curFamMatch[0] : '';
    var rows = models.map(function(id) {
      var label = (typeof window.prettifyModelId === 'function' && window.prettifyModelId(id)) || id;
      var active = (id.toLowerCase() === curFam) ? '1' : '0';
      return '<div class="mp-row" data-model="' + id + '" data-active="' + active + '" role="button" tabindex="0" title="' + id + '">'
        + '<span class="mp-label">' + label + '</span>'
        + (active === '1' ? '<span class="mp-check" aria-hidden="true">&#10003;</span>' : '')
        + '</div>';
    }).join('');
    popup.innerHTML = '<div class="mp-title">Session model</div>' + rows;
    document.body.appendChild(popup);

    popup.addEventListener('click', function(e) {
      var row = e.target.closest ? e.target.closest('.mp-row') : null;
      if (row && row.dataset.model) pickModel(row.dataset.model);
    });
    setTimeout(function() {
      document.addEventListener('click', dismissModelPopup);
    }, 0);
  }

  function pickModel(id) {
    var sid = window.activeSessionId;
    var popup = document.getElementById('model-pick-popup');
    if (popup) popup.remove();
    document.removeEventListener('click', dismissModelPopup);
    if (!sid) return;
    apiPatch('/api/sessions/' + sid + '/model', { model: id }).then(function(dto) {
      // Optimistic local update for THIS device (the WS broadcast confirms and
      // covers every other device). Use the server's RESOLVED model (round #5,
      // 1a) — a bare family like 'opus' comes back as 'claude-opus-5', so the
      // chip shows the precise version AT ONCE, never the bare "Opus" first.
      var resolved = (dto && dto.model) || id;
      var sess = (Array.isArray(window.sessions) ? window.sessions : []).find(function(s) { return s && s.id === sid; });
      if (sess) sess.model = resolved;
      pollModel();
      if (typeof window.renderSessionList === 'function') { try { window.renderSessionList(); } catch(e) {} }
    }).catch(function(err) {
      if (typeof window.showToast === 'function') window.showToast('Could not change model: ' + err.message, 'error');
      pollModel(); // re-show the truth
    });
  }

  function dismissModelPopup(e) {
    var popup = document.getElementById('model-pick-popup');
    var el = chip('model');
    if (!popup) return;
    var inside = popup.contains(e.target) || (el && el.contains(e.target));
    if (!inside) {
      popup.remove();
      document.removeEventListener('click', dismissModelPopup);
    }
  }

  // [2026-09-22] TOLTO L'INTERO BLOCCO «usage» (formatUsage, pollUsage,
  // formatTokens, toggleUsagePopup, renderUsagePopup, dismissUsagePopup).
  // Era il vecchio conteggio di token letto da /api/status/usage, che a sua
  // volta legge server/.usage-log.jsonl — un file che dal 2026-05-14 non
  // scrive piu' nessuno. Il perno: `pollAll()` (qui sotto) chiama pollModel
  // e pollClaudeCliUsage — pollUsage NO, e nessun
  // altro lo chiamava. La pastiglia `data-k="usage"` non era piu' nemmeno
  // disegnata (l'unico a disegnarla era pillWithBar, tolto piu' sopra), quindi
  // setChip('usage', …) e chip('usage') parlavano con un elemento inesistente
  // e il pannello non si apriva da nessun tasto. Quel che vive oggi e' la
  // pastiglia ccusage (5h + 7d), qui sotto, alimentata da
  // /api/status/claude-cli-usage — un'altra rotta, un altro dato.
  // CONSEGUENZA GIA' RACCOLTA: /api/status/usage e /api/status/usage-detail
  // erano rimaste senza nessun chiamante, e sono cadute nel secondo giro dello
  // stesso giorno insieme a tutto il contatore di token (server/status.js).

  // Claude Code subscription utilization (5h session + 7d weekly).
  // Server caches the upstream call for 60s; pollAll asks at most every
  // CC_USAGE_MS (60 s) since 10/11/2026 — 5 s was 11 cache hits out of 12.
  function _ccLevel(pct) {
    if (typeof pct !== 'number' || !isFinite(pct)) return 'empty';
    if (pct < 60) return 'low';
    if (pct < 85) return 'mid';
    return 'high';
  }

  // What every copy of the pill shows. ONE state, painted onto all copies, so
  // the heading and the chat row can never disagree.
  var _cc = { s: null, w: null, shown: false, stale: false };

  function paintUsage() {
    var els = document.querySelectorAll('.cc-usage');
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      _writeCcSegment(el, 'session', _cc.s);
      _writeCcSegment(el, 'weekly', _cc.w);
      el.classList.toggle('tb-hidden', !_cc.shown);
      if (_cc.stale) el.dataset.stale = '1';
      else if (el.dataset.stale) delete el.dataset.stale;
      el.title = 'Claude Code usage — tap for reset times';
    }
  }

  function _writeCcSegment(root, which, pct) {
    var el = root.querySelector('[data-which="' + which + '"]');
    if (!el) return;
    var val = el.querySelector('.cc-val');
    if (val) val.textContent = (pct == null) ? '—' : (pct + '%');
    el.dataset.level = _ccLevel(pct);
  }

  // Transient upstream error: if there is a value to show (memory or
  // localStorage), keep it and dim it. Hide only when there has NEVER been
  // one. The pill must never flicker out.
  function ccUsageFailed() {
    if (_lastCcUsage) _cc.stale = true;
    else _cc.shown = false;
    paintUsage();
  }

  function pollClaudeCliUsage() {
    apiGet('/api/status/claude-cli-usage').then(function(d) {
      if (!d || d.error) return ccUsageFailed();
      var s = (typeof d.session_pct === 'number') ? Math.round(d.session_pct) : null;
      var w = (typeof d.weekly_pct  === 'number') ? Math.round(d.weekly_pct)  : null;
      if (s == null && w == null) return ccUsageFailed();
      _lastCcUsage = d;
      // Fresh data → clear the dimming, unless the server itself says it is
      // serving last-known-good after an upstream error.
      _cc = { s: s, w: w, shown: true, stale: !!d.stale };
      paintUsage();
      if (document.getElementById('cc-usage-popup')) renderCcUsagePopup(d);
      saveLastKnown({ ccUsage: { session: s, weekly: w } });
    }).catch(ccUsageFailed);
  }

  // --- Claude Code usage popup ----------------------------------------------
  // One popup for both windows (5h and weekly) with their reset times. It
  // opens from EVERY copy of the pill, anchored to the copy that was tapped.

  // Last value cached from /api/status/claude-cli-usage so we can render the
  // popup instantly without a second fetch (popup opens on click, data has
  // already been polled).
  var _lastCcUsage = null;

  function formatCountdown(secondsUntilReset) {
    if (typeof secondsUntilReset !== 'number' || !isFinite(secondsUntilReset) || secondsUntilReset <= 0) return null;
    var d = Math.floor(secondsUntilReset / 86400);
    var h = Math.floor((secondsUntilReset % 86400) / 3600);
    var m = Math.floor((secondsUntilReset % 3600) / 60);
    if (d > 0) return d + 'd ' + h + 'h';
    if (h > 0) return h + 'h ' + m + 'm';
    if (m > 0) return m + 'm';
    return '< 1m';
  }

  function formatResetWhen(unixSec, includeDate) {
    if (typeof unixSec !== 'number' || !isFinite(unixSec)) return '—';
    var d = new Date(unixSec * 1000);
    var hh = String(d.getHours()).padStart(2, '0');
    var mm = String(d.getMinutes()).padStart(2, '0');
    if (!includeDate) return hh + ':' + mm;
    var days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    var months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return days[d.getDay()] + ' ' + d.getDate() + ' ' + months[d.getMonth()] + ', ' + hh + ':' + mm;
  }

  function levelFromPct(pct) {
    if (typeof pct !== 'number' || !isFinite(pct)) return 'empty';
    if (pct < 60) return 'low';
    if (pct < 85) return 'mid';
    return 'high';
  }

  var _ccAnchor = null; // the copy of the pill that opened the popup

  function closeCcUsagePopup() {
    var existing = document.getElementById('cc-usage-popup');
    if (existing) existing.remove();
    document.removeEventListener('click', dismissCcUsagePopup);
    document.removeEventListener('keydown', escCcUsagePopup);
    var els = document.querySelectorAll('.cc-usage');
    for (var i = 0; i < els.length; i++) els[i].setAttribute('aria-expanded', 'false');
  }

  function toggleCcUsagePopup(anchor) {
    var open = !!document.getElementById('cc-usage-popup');
    var same = open && anchor === _ccAnchor;
    closeCcUsagePopup();
    if (same) return; // second tap on the same pill closes it
    _ccAnchor = anchor || null;
    // Use cached data if available — refresh in the background.
    if (_lastCcUsage) renderCcUsagePopup(_lastCcUsage);
    apiGet('/api/status/claude-cli-usage').then(function(d) {
      if (!d || d.error) return;
      _lastCcUsage = d;
      if (document.getElementById('cc-usage-popup')) renderCcUsagePopup(d);
    }).catch(function() {});
  }

  // The tapped copy if it is still on screen, otherwise the first visible one
  // (e.g. the sidebar closed while the popup was open).
  function usageAnchor() {
    function visible(el) { return el && el.isConnected && el.getClientRects().length > 0; }
    if (visible(_ccAnchor)) return _ccAnchor;
    var els = document.querySelectorAll('.cc-usage');
    for (var i = 0; i < els.length; i++) if (visible(els[i])) return els[i];
    return null;
  }

  function renderCcUsagePopup(data) {
    var existing = document.getElementById('cc-usage-popup');
    if (existing) existing.remove();
    // The usage poll (every 60 s) re-renders an open popup: only a fresh open plays the
    // entrance (.up-enter in main.css), a refresh must not blink.
    var fresh = !existing;

    var anchorEl = usageAnchor();
    if (!anchorEl) return;
    var rect = anchorEl.getBoundingClientRect();

    var sPct = (typeof data.session_pct === 'number') ? Math.round(data.session_pct) : null;
    var wPct = (typeof data.weekly_pct  === 'number') ? Math.round(data.weekly_pct)  : null;
    var sReset = data.session_resets_at;
    var wReset = data.weekly_resets_at;
    var now = Math.floor(Date.now() / 1000);
    var sCountdown = sReset ? formatCountdown(sReset - now) : null;
    var wCountdown = wReset ? formatCountdown(wReset - now) : null;

    function row(label, pct, countdown, resetAt, includeDate) {
      var pctText = (pct == null) ? '—' : (pct + '%');
      var lvl = levelFromPct(pct);
      var resetLine = '';
      if (resetAt) {
        resetLine = '<div class="up-resets">Resets in <strong>' + (countdown || '—') + '</strong> · ' + formatResetWhen(resetAt, includeDate) + '</div>';
      }
      return [
        '<div class="up-row">',
          '<div class="up-head">',
            '<span class="up-label">' + label + '</span>',
            '<span class="up-value">' + pctText + '</span>',
          '</div>',
          '<div class="up-bar"><span class="up-fill" data-level="' + lvl + '" style="width:' + (pct == null ? 0 : pct) + '%"></span></div>',
          resetLine,
        '</div>'
      ].join('');
    }

    var popup = document.createElement('div');
    popup.id = 'cc-usage-popup';
    if (fresh) popup.className = 'up-enter';
    popup.setAttribute('role', 'dialog');
    popup.setAttribute('aria-label', 'Claude Code usage');
    popup.style.top = (rect.bottom + 8) + 'px';
    // Right edge under the pill's right edge, kept 8px inside the screen.
    var popupWidth = Math.min(240, window.innerWidth - 16);
    popup.style.left = Math.max(8, Math.min(rect.right - popupWidth, window.innerWidth - popupWidth - 8)) + 'px';
    popup.style.width = popupWidth + 'px';

    popup.innerHTML = [
      '<div class="up-title">Claude Code usage</div>',
      row('Session (5h)', sPct, sCountdown, sReset, false),
      row('Weekly (7d)',  wPct, wCountdown, wReset, true),
      '<div class="up-note">From Anthropic — your subscription.</div>',
    ].join('');

    document.body.appendChild(popup);
    anchorEl.setAttribute('aria-expanded', 'true');
    setTimeout(function() {
      document.addEventListener('click', dismissCcUsagePopup);
      document.addEventListener('keydown', escCcUsagePopup);
    }, 0);
  }

  // A tap on any copy of the pill is handled by its own click (toggle / move
  // the popup); anything else outside the popup closes it.
  function dismissCcUsagePopup(e) {
    var popup = document.getElementById('cc-usage-popup');
    if (!popup) return;
    var onPill = e.target && e.target.closest && e.target.closest('.cc-usage');
    if (!popup.contains(e.target) && !onPill) closeCcUsagePopup();
  }

  function escCcUsagePopup(e) {
    if (e.key === 'Escape') closeCcUsagePopup();
  }

  // [2026-10-16] pollServer, pollRaspberry and the «Laptop» popup are gone
  // with the «pc» and «pi» pills. When the
  // PC is not reachable the phone already says so in the chat area
  // («PC not reachable», public/js/modalita.js casaOffline).

  function hydrateFromLastKnown() {
    var saved = loadLastKnown();
    if (!saved) return;
    _lastKnown = saved;
    // Paint each chip with whatever we persisted last. Missing fields stay
    // at their default ('—' / no state). (saved.ctx from the retired context
    // chip and saved.ram from the retired RAM pill are simply ignored — stale
    // localStorage entries are harmless and expire on the next save.)
    if (saved.ccUsage) {
      var hs = (typeof saved.ccUsage.session === 'number') ? saved.ccUsage.session : null;
      var hw = (typeof saved.ccUsage.weekly  === 'number') ? saved.ccUsage.weekly  : null;
      if (hs != null || hw != null) {
        _cc = { s: hs, w: hw, shown: true, stale: true };
        paintUsage();
        // Seed in-memory cache so the very first poll, if it errors, doesn't
        // hide the pill — keeps it alive across cold boots + blips.
        _lastCcUsage = { session_pct: hs, weekly_pct: hw };
      }
    }
    markStaleIfOld(saved.savedAt);
  }

  function pollAll() {
    if (!token()) return; // not authed yet
    ensureUsage();
    pollModel();
    if (Date.now() - _ccUltimaDomanda >= CC_USAGE_MS) {
      _ccUltimaDomanda = Date.now();
      pollClaudeCliUsage();
    }
  }

  // React to session switches — refresh the model chip immediately.
  function watchActiveSession() {
    var origSwitch = window.switchSession;
    if (typeof origSwitch === 'function' && !origSwitch.__topbarWrapped) {
      window.switchSession = function() {
        var r = origSwitch.apply(this, arguments);
        try { pollModel(); } catch(e) {}
        return r;
      };
      window.switchSession.__topbarWrapped = true;
    }
    // Also watch for direct assignments AND mid-session model changes (a
    // session can drop from Opus to a smaller model — the chip must follow).
    // [2026-09-22] Passa dal battito condiviso: guardava ogni secondo PER
    // SEMPRE e, quando vedeva un cambio, chiamava pollModel() → apiGet. A
    // schermo spento non c'è nessun cambio di modello da inseguire, perché non
    // c'è nessuno che cambia sessione: è tempo di radio buttato.
    // subitoAlRitorno:false perché al ritorno ci pensa 'topbar-poll', che
    // chiama pollModel dentro pollAll — non serve bussare due volte.
    // [2026-11-10 BATTERIA ] 1 s → 3 s: è un controllo locale, ma era un
    // risveglio al secondo a schermo acceso; il cambio di sessione lo segue già
    // switchSession qui sopra, all'istante.
    modelloBattito = window.Battito.ogni('topbar-modello', 3000, function() {
      if (window.activeSessionId !== lastCtxSessionId) {
        pollModel();
        return;
      }
      try {
        var sid = window.activeSessionId;
        if (!sid) return;
        var sess = (Array.isArray(window.sessions) ? window.sessions : []).find(function(s) { return s && s.id === sid; });
        var fullId = (sess && sess.model) || '';
        var label = fullId
          ? ((typeof window.prettifyModelId === 'function' && window.prettifyModelId(fullId)) || fullId)
          : '—';
        if (label !== lastModelLabel) pollModel();
      } catch (e) {}
    }, { subitoAllAvvio: false, subitoAlRitorno: false });
  }

  function start() {
    // [2026-09-22] battito.js è un prerequisito duro, non un di più: senza, la
    // barra tornerebbe a bussare 48 volte al minuto tutta la notte. Se manca si
    // grida e ci si ferma — un ripiego su setInterval sarebbe esattamente la
    // seconda meccanica che questo lavoro esiste per togliere.
    if (!window.Battito || typeof window.Battito.ogni !== 'function') {
      console.error('[TOPBAR] battito.js non caricato: la barra di stato resta ferma. ' +
        'Controlla l\'ordine degli script in public/index.html.');
      return;
    }
    ensureUsage();
    // Paint last-known values BEFORE the first poll so the pill isn't blank
    // during a server outage / cold boot with the server unreachable.
    hydrateFromLastKnown();
    watchActiveSession();
    // [2026-09-22] Il giro degli endpoint passa dal battito condiviso
    // (public/js/battito.js): a schermo spento NON bussa, al ritorno riparte e
    // fa subito un giro così i numeri non sono di mezz'ora fa.
    if (pollTimer) pollTimer.ferma();
    pollTimer = window.Battito.ogni('topbar-poll', POLL_MS, pollAll);
  }

  // Boot: wait for DOM + slot to exist.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }

  // Expose for debugging.
  window.MainTopbar = { refresh: pollAll, refreshModel: pollModel };
})();
