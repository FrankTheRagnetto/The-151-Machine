/* The 151 Machine — WebSocket: connection, reconnect, restart */

// --- Content-hash key for idempotent DOM dedup ---
// Stable across streaming finalization because content is normalized before hashing.
window.computeMsgKey = function computeMsgKey(msg) {
  if (!msg) return '';
  var role = msg.role || '';
  var raw = msg.content == null ? '' : String(msg.content);
  // Normalize: trim + collapse all runs of whitespace to a single space so
  // streaming finalization (which may swap \n for spaces) doesn't shift the hash.
  var norm = raw.trim().replace(/\s+/g, ' ');
  var toolCount = (msg.tools && msg.tools.length) ? msg.tools.length : 0;
  var attCount  = (msg.attachments && msg.attachments.length) ? msg.attachments.length : 0;
  var seed = role + '|' + norm + '|' + toolCount + '|' + attCount;
  // djb2 hash → 16 hex chars
  var h = 5381;
  for (var i = 0; i < seed.length; i++) {
    h = (((h << 5) + h) + seed.charCodeAt(i)) >>> 0;
  }
  // Second pass on a different seed to widen to 64 bits (two 32-bit halves)
  var h2 = 0x811c9dc5;
  for (var j = 0; j < seed.length; j++) {
    h2 = (((h2 ^ seed.charCodeAt(j)) * 0x01000193) >>> 0);
  }
  return (h >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
};

// --- WebSocket state ---
var wsReconnectTimer = null;
var wsPingTimer = null;
var bannerTimeout = null;
window.wsConnected = false;
window._wsLastRecv = 0; // timestamp of last message received from server — used to detect dead/zombie sockets
var knownServerBoot = null; // tracks server boot timestamp to detect restarts
var knownBuildHash = null; // tracks BUILD_HASH to detect stale JS/CSS after deploys
var _returningFromBackground = false; // suppress "back online" toast on background wake
var inRestartMode = false;
// M9 vector 2: expose the restart-mode flag so the send path (input.js) can HOLD
// a message in the outbox instead of firing it into a socket that's dying because
// the server is restarting. Read-only getter — closure over the module var.
window.isInRestartMode = function isInRestartMode() { return inRestartMode; };
var restartPollTimer = null;
var restartTimeoutTimer = null;
var frozenState = null;
var restartReconnectDelay = 1000;

// --- Riconnessione: i DUE tetti dell'attesa ---------------------------------
// [2026-09-15] Prima qui c'era UN tetto solo, 5s, applicato sempre. Era giusto
// per metà dei casi e sbagliato per l'altra metà:
//
//   · il proprietario GUARDA lo schermo e la rete balla ⇒ 5s è esattamente giusto: la
//     radio può metterci secondi a svegliarsi e vogliamo essere lì appena la
//     strada torna. Questo tetto NON si tocca — è la ragione per cui il
//     commento del 16/08 diceva «cap the backoff LOW», e resta valida.
//   · Il telefono è IN TASCA e la rete non c'è ⇒ 5s significa bussare al buio
//     720 volte l'ora, ognuna con una prova HTTP verso OGNI candidato più
//     l'apertura di un websocket. È la stessa radio che il lavoro batteria del
//     16/08 aveva smesso di svegliare per i ping (riga ~175) — e che questo
//     anello risvegliava lo stesso, dalla porta di servizio.
//
// Il discriminante non è l'orologio: è se la prova ha TROVATO qualcuno.
// findBestServer ora lo dice (core.js). Trovato ⇒ tetto brioso. Nessuno ⇒
// l'attesa cresce fino al tetto buio.
//
// ⚠ IL TETTO BUIO NON RITARDA IL RITORNO, e questo è il punto che rende la
// cosa sicura: il risveglio vero NON passa da questo timer. `online`,
// `visibilitychange`, `pageshow`, `focus`, il resume di Capacitor e
// l'ascoltatore di rete (ws.js:1726-1757, tutti già presenti) chiamano
// _reconnectNow(), che azzera l'attesa a 500ms e riconnette SUBITO. Il timer
// lungo è solo la rete di sicurezza per quando il sistema operativo non ci
// avvisa — non è la strada principale del ritorno.
//
// Prova: tests/riconnessione-mobile.test.js
var WS_RECONNECT_CAP_BRISK = 5000;
var WS_RECONNECT_CAP_DARK = 60000;
window.WS_RECONNECT_CAP_BRISK = WS_RECONNECT_CAP_BRISK;
window.WS_RECONNECT_CAP_DARK = WS_RECONNECT_CAP_DARK;

// Pura: l'attesa successiva, date quella attuale e la risposta della prova.
// Raddoppia sempre; l'unica cosa che cambia è il tetto. Un `found` vero
// riporta subito l'attesa sotto il tetto brioso, anche se era salita al buio.
window.wsNextReconnectDelay = function wsNextReconnectDelay(current, foundServer) {
  var ceiling = foundServer ? WS_RECONNECT_CAP_BRISK : WS_RECONNECT_CAP_DARK;
  return Math.min(Math.max(1, current) * 2, ceiling);
};

// Detached-runs (window.DETACHED_RUNS): highest stream-event seq seen per
// session. In-memory only — a full page reload resets it to 0, so the server
// replays the whole turn (or sends the full tail snapshot) on a cold load.
// Updated from any event carrying `_seq` (live, replayed, or queued).
window._streamSeq = window._streamSeq || {};
window._noteSeq = function(sid, seq) {
  if (!sid || typeof seq !== 'number') return;
  if (!(window._streamSeq[sid] >= seq)) window._streamSeq[sid] = seq;
};
window._lastSeqFor = function(sid) {
  return (sid && window._streamSeq[sid]) || 0;
};

// Detached-runs: highest stream-event seq actually FOLDED INTO streamingText.
// This is DISTINCT from _streamSeq above — _streamSeq is "highest seen" and is
// advanced for EVERY incoming frame at receipt (including a resume snapshot or a
// replay batch that may re-carry text already on the screen). _appliedSeq is
// "highest already concatenated into streamingText", so a delta is appended ONLY
// when its seq exceeds it. Re-delivered or already-snapshotted deltas (seq <=
// mark) are dropped → no duplicated text on reconnect/reconcile (the "X X"
// doubling). In-memory; resets on full reload (server replays the whole turn).
// Inert when DETACHED_RUNS is off or a frame carries no numeric _seq.
window._appliedSeq = window._appliedSeq || {};
window._noteApplied = function(sid, seq) {
  if (!sid || typeof seq !== 'number') return;
  if (!(window._appliedSeq[sid] >= seq)) window._appliedSeq[sid] = seq;
};
window._alreadyApplied = function(sid, seq) {
  // true => this delta's content is already in streamingText; do NOT re-append.
  return !!(window.DETACHED_RUNS && sid && typeof seq === 'number'
    && (window._appliedSeq[sid] || 0) >= seq);
};

// ROUND CHAT bug 1/3 (2026-08-16): per-session seq-counter EPOCH. The server's
// stream-log seq counter restarts from 0 whenever its log entry is dropped
// (15-min age-out, MAX_SESSIONS eviction, restart with a stale snapshot). This
// page can stay open for DAYS holding the old high-water mark, so after a reset
// every delta AND the terminal `done` of the new turn satisfied the seq-gate
// and were discarded — proven by 20+ DONE-SEQGATED beacons with applied>seq,
// bubbleInDom=false, serverLen>0 (empty reply + ghost "Running command").
// Server now stamps `_epoch` (record) / `epoch` (resume, replay) — when it
// changes, the old counters are garbage: reset them.
window._seqEpoch = window._seqEpoch || {};
window._syncSeqEpoch = function(sid, epoch) {
  if (!sid || epoch == null) return;
  var had = window._seqEpoch[sid];
  if (had === epoch) return;
  window._seqEpoch[sid] = epoch;
  if (had != null) {
    window._streamSeq[sid] = 0;
    window._appliedSeq[sid] = 0;
    if (typeof window.syncBeacon === 'function') {
      window.syncBeacon('SEQ-EPOCH-RESET', { sid: sid, from: had, to: epoch });
    }
  }
};

window.connectWebSocket = function connectWebSocket(sessionId) {
  if (window.ws) {
    // [2026-09-22] IL CARTELLINO STA SUL SOCKET, NON SULLA FINESTRA.
    // `window.intentionalClose` e' una bandiera SOLA per tutta l'app: diceva
    // «una chiusura e' voluta», non QUALE. Restava giusta solo finche' gli
    // eventi arrivavano nell'ordine sperato. Il cartellino qui sotto viaggia
    // invece col socket che stiamo chiudendo e non puo' essere confuso con un
    // altro. La bandiera globale resta scritta perche' e' dichiarata in
    // core.js e non si tocca cio' che non serve toccare, ma la DECISIONE in
    // onclose non si appoggia piu' a lei.
    try { window.ws._intentional = true; } catch(e) {}
    window.intentionalClose = true; // prevent onclose from scheduling a reconnect
    try { window.ws.close(); } catch(e) {}
    window.ws = null;
  }
  if (wsPingTimer) { clearInterval(wsPingTimer); wsPingTimer = null; }
  if (wsReconnectTimer) { clearTimeout(wsReconnectTimer); wsReconnectTimer = null; }

  window.ws = new WebSocket(window.getWsUrl() + '/ws?token=' + encodeURIComponent(window.authToken));
  // [2026-09-22] Il socket di QUESTA chiamata, catturato una volta sola. I
  // gestori qui sotto devono poter dire «sono ancora io quello attuale?»
  // guardando un riferimento, non ricontrollando window.ws che nel frattempo
  // puo' essere diventato un altro socket. Vedi il guardiano in onclose.
  var sock = window.ws;
  // B3 (2026-08-11): tag the socket with the token it was opened on, so the
  // lightweight-switch path (switchSocketSession) can confirm the token is
  // unchanged before reusing this connection instead of reconnecting.
  window.ws._token = window.authToken;

  window.ws.onopen = function() {
    var wasDisconnected = !window.wsConnected; // track if we were previously disconnected
    window.reconnectDelay = 1000;
    restartReconnectDelay = 1000;
    window.intentionalClose = false; // clear flag now that new connection is established
    window.wsConnected = true;
    window._wsLastRecv = Date.now(); // fresh connection — seed liveness clock
    if (bannerTimeout) { clearTimeout(bannerTimeout); bannerTimeout = null; }
    window.connectionBanner.classList.remove('show');

    // P5: "Back online" toast removed — reconnection is now silent/always-live.
    _returningFromBackground = false;
    // Session-list resync on reconnect: while the socket was down we may have
    // MISSED session_created/session_deleted broadcasts, so the sidebar could be
    // stale (a session born or killed on the other device). Reconcile the full
    // authoritative list once, in-place, whenever we come back from a disconnect.
    // renderSessionList (called inside loadSessions) preserves the active view;
    // this is the same fetch the page-load path runs, just triggered on heal.
    if (wasDisconnected && typeof window.loadSessions === 'function') {
      window.loadSessions().catch(function() {});
    }
    // Tell server how many history entries we already have — server skips full send if matching
    var currentSession = window.sessions.find(function(s) { return s.id === sessionId; });
    var historyLen = currentSession && currentSession.history ? currentSession.history.length : 0;
    window.ws.send(JSON.stringify({ type: 'join', sessionId: sessionId, historyLength: historyLen }));
    // Ask for authoritative stream state AFTER join — guarantees ordering so
    // server's currentSessionId is set when get_stream_state arrives. Covers
    // the "stream finished while away" case (join alone only resumes in-flight).
    try {
      window.ws.send(JSON.stringify({ type: 'get_stream_state', sessionId: sessionId, lastSeq: window._lastSeqFor(sessionId), epoch: (window._seqEpoch && window._seqEpoch[sessionId] != null ? window._seqEpoch[sessionId] : null) }));
    } catch(e) {}

    // BATTERY v9: declare our screen state on every fresh socket. Without this
    // a socket opened (or reconnected) while hidden would be heartbeat-pinged
    // until the next visibilitychange, and one reopened after a resume would
    // stay flagged hidden on the server. State is per-socket, so it must be
    // re-sent every time we connect.
    wsSendVisibility(typeof document !== 'undefined' && document.hidden);

    // Client-side keepalive — send ping every 15s.
    // Zombie-connection watchdog: a half-open TCP socket still reports
    // readyState OPEN, so `send` succeeds silently into a dead pipe and the
    // disconnect is never noticed. The server answers every ping with a
    // `pong`, so _wsLastRecv advances each cycle on a healthy link. If it
    // hasn't advanced in >45s the link is dead — force a fresh reconnect.
    wsPingTimer = setInterval(function() {
      if (!window.ws || window.ws.readyState !== 1) return;
      // BATTERY 2026-08-16: while the app is in the background / screen off, do
      // NOT ping and do NOT run the staleness watchdog. Firing a socket write
      // every 15s wakes the radio every 15s — all night, with the audiobook
      // playing, that is what kept the phone hot and drained it. Letting the
      // socket die while hidden is FINE and intended: wsOnResume() (below) sees
      // the stale _wsLastRecv the moment the owner reopens the app and reconnects
      // there and then. This is the only place the heartbeat can be silenced
      // during audio playback, because audio keeps JS timers alive on purpose
      // (MainActivity.onPause skips pauseTimers while audioActive).
      if (typeof document !== 'undefined' && document.hidden) return;
      if (window.activeSessionId && window._wsLastRecv
          && (Date.now() - window._wsLastRecv) > 45000) {
        console.log('[WS] No server message in 45s — stale connection, reconnecting');
        window.connectWebSocket(window.activeSessionId);
        return;
      }
      window.ws.send(JSON.stringify({ type: 'ping' }));
    }, 15000);
  };

  // Frame che appartengono a UNA sessione e disegnano nella vista aperta.
  var _PER_SESSION_FRAMES = {
    delta: 1, thinking: 1, thinking_start: 1, tool_start: 1, tool_progress: 1,
    tool_use: 1, tool_done: 1, status: 1, done: 1, stopped: 1, model_info: 1,
    queued_messages: 1, user_message: 1, replay: 1, resume: 1, history: 1, history_append: 1
  };
  window.ws.onmessage = function(event) {
    window._wsLastRecv = Date.now(); // any frame proves the link is alive
    var msg = JSON.parse(event.data);
    if (msg.type !== 'pong') console.log('[WS]', msg.type, msg.status || '', window.streaming ? 'streaming' : 'idle');

    // [2026-10-01] Pezzi di risposta di UN'ALTRA sessione: si scartano. il proprietario:
    // «se passo veloce da una sessione all'altra, la risposta di una appare
    // nell'altra, poi i doppioni spariscono riaprendo». Il server ora firma
    // ogni pezzo con la sua sessione (sendToSession); quelli ancora in volo
    // dopo un cambio di sessione non finiscono più nella bolla sbagliata.
    // Niente si perde: rientrando in quella sessione la storia arriva dal server.
    if (msg.sessionId && window.activeSessionId && msg.sessionId !== window.activeSessionId
        && _PER_SESSION_FRAMES[msg.type]) {
      console.log('[WS] scartato', msg.type, 'di un\'altra sessione', String(msg.sessionId).slice(0, 8));
      return;
    }

    // Detached-runs: track the highest stream-event seq we've seen for the
    // active session. Live, replayed, and queued events all carry `_seq` and
    // re-enter this handler, so this single spot covers every delivery path.
    // Epoch FIRST: if the server's seq counter restarted (new epoch), reset our
    // counters BEFORE noting this frame's seq, or the gate compares numbers
    // from two different lifetimes (ROUND CHAT bug 1/3).
    if (window.DETACHED_RUNS) {
      var _epVal = (msg._epoch != null) ? msg._epoch : ((msg.type === 'resume' || msg.type === 'replay') ? msg.epoch : null);
      if (_epVal != null) window._syncSeqEpoch(msg.sessionId || window.activeSessionId, _epVal);
    }
    if (window.DETACHED_RUNS && typeof msg._seq === 'number') {
      window._noteSeq(msg.sessionId || window.activeSessionId, msg._seq);
    }

    // Detached-runs: ordered replay batch from the server (reply to
    // get_stream_state). Re-feed each missed event through THIS handler so it
    // goes through the real per-type logic (timeline, deltas, done) — purely
    // additive and seq-deduped, never a destructive re-render. The batch carries
    // the terminal `done`/`error` when the turn finished, so a stuck spinner
    // (dropped inline `done`) clears here on reconnect.
    if (msg.type === 'replay') {
      if (!window.DETACHED_RUNS) return;
      if (msg.sessionId && window.activeSessionId && msg.sessionId !== window.activeSessionId) return;
      var _replayEvents = msg.events || [];
      for (var _ri = 0; _ri < _replayEvents.length; _ri++) {
        try { window.ws.onmessage({ data: JSON.stringify(_replayEvents[_ri]) }); } catch (e) {}
      }
      if (typeof msg.seq === 'number') window._noteSeq(msg.sessionId || window.activeSessionId, msg.seq);
      return;
    }

    // Server is about to restart — show subtle updating banner
    if (msg.type === 'server_restarting') {
      enterRestartMode();
      return;
    }

    // Hot reload — server updated HTML without restarting. Use TV animation.
    if (msg.type === 'hot_reload') {
      console.log('[WS] Hot reload received, build:', msg.buildHash);
      window.triggerAnimatedReload('hot');
      return;
    }

    // Server-pushed notification (POST /api/notify — backup scripts, the
    // /notify-user skill). kind 'system' arrives with a longer duration set
    // server-side; both render on the existing #general-toast.
    // «!comando» (server/comando-chat.js): «running…» poi l'uscita, messaggio «PC».
    if (msg.type === 'comando_via' || msg.type === 'comando_esito') {
      if (msg.sessionId && msg.sessionId !== window.activeSessionId) return;
      var cPrima = document.querySelector('[data-comando-id="' + String(msg.id).replace(/[^a-f0-9]/g, '') + '"]');
      if (cPrima && cPrima.parentNode) cPrima.parentNode.removeChild(cPrima);
      if (typeof window.appendMessage !== 'function') return;
      if (msg.type === 'comando_via') {
        var cRec = '`'.repeat(Math.max(3, ((String(msg.cmd).match(/`+/g) || []).reduce(function (m, x) { return Math.max(m, x.length + 1); }, 0))));
        var cEl = window.appendMessage('comando', 'Running…\n\n' + cRec + 'text\n$ ' + msg.cmd + '\n' + cRec, null, true);
        if (cEl && cEl.setAttribute) cEl.setAttribute('data-comando-id', msg.id);
      } else {
        window.appendMessage('comando', msg.content || '', msg.timestamp || null, true);
        var cS = (window.sessions || []).find && window.sessions.find(function (x) { return x.id === window.activeSessionId; });
        if (cS) { if (!cS.history) cS.history = []; cS.history.push({ role: 'comando', content: msg.content || '' }); }
      }
      return;
    }

    // Sudo dal telefono: la casella della password (public/js/sudo-telefono.js).
    if (msg.type === 'sudo_chiede' || msg.type === 'sudo_chiuso') {
      if (typeof window.sudoTelefono === 'function') window.sudoTelefono(msg);
      return;
    }

    if (msg.type === 'notify') {
      if (typeof window.showToast === 'function') {
        window.showToast(msg.message || '', msg.variant || '', msg.duration || 5000);
      }
      return;
    }

    // Deploy marker — emitted once after full-restart reconnect to the
    // session that triggered the deploy. Append an inline card below history.
    if (msg.type === 'deploy_marker') {
      if (typeof window.renderDeployCard === 'function'
          && window.activeSessionId === msg.session_id) {
        requestAnimationFrame(function() {
          requestAnimationFrame(function() {
            window.renderDeployCard(msg.marker);
          });
        });
      }
      return;
    }

    // (Lab review/card frames removed 2026-08-20 — the Lab app is gone. The
    //  server no longer emits lab_review_submitted / lab_card_* at all.)

    // Model info from CLI init — set context limit per-session
    if (msg.type === 'model_info') {
      var model = (msg.model || '').toLowerCase();
      // 1M only when name carries the explicit [1m] suffix (e.g. claude-opus-4-8[1m]).
      // The Step-1 pin uses claude-opus-4-8 → 200K. Without this guard every opus
      // reads as 1M and the context-% bar under-reads ~5×.
      var limit = /\[1m\]/i.test(model) ? 1000000 : 200000;
      // Store on the session object so each session has its own limit
      var modelSid = msg.sessionId || window.activeSessionId;
      if (modelSid) {
        var modelSession = window.sessions.find(function(s) { return s.id === modelSid; });
        if (modelSession) {
          modelSession._contextLimit = limit;
          // FAMIGLIE (2026-08-16): init reports the model ACTUALLY running —
          // a family pin ('fable') resolves CLI-side, so this is where the
          // chip/card get the precise name (mirrors server noteRunningModel).
          if (msg.model && msg.model !== 'claude' && modelSession.model !== msg.model) {
            modelSession.model = msg.model;
            try { window.renderSessionList(); } catch (e) {}
            if (window.MainTopbar && typeof window.MainTopbar.refreshModel === 'function') {
              try { window.MainTopbar.refreshModel(); } catch (e) {}
            }
          }
        }
      }
      console.log('[MODEL] ' + msg.model + ' → context limit ' + limit.toLocaleString() + ' (session ' + (modelSid || '?').slice(0, 8) + ')');
      return;
    }

    // Sync: server tells us the true session state on every join
    if (msg.type === 'sync') {
      // Signal that join is complete — team launcher can now send messages
      window._resolveSyncWaiters();

      // [SYNC-PROBE 2026-08-15] The open-with-stale-card case: switchSocketSession
      // skipped get_stream_state because the local card said idle, but the server
      // now says busy → we're mid-stream with no snapshot requested (streaming
      // suspect for "a volte non vedo la risposta in diretta"). Marker is set only
      // on that skip path and consumed here; 10s window ties it to THIS open.
      try {
        var _oai = window._openAssumedIdle;
        if (_oai && _oai.sid === window.activeSessionId) {
          if (msg.status === 'busy' && (Date.now() - _oai.at) < 10000
              && typeof window.syncBeacon === 'function') {
            window.syncBeacon('OPEN-IDLE-BUT-BUSY', { sid: _oai.sid, msSinceOpen: Date.now() - _oai.at });
          }
          window._openAssumedIdle = null;
        }
      } catch (e) {}

      if (msg.serverBoot) {
        knownServerBoot = msg.serverBoot;
      }

      // Detect stale client after a REAL code change while phone was
      // backgrounded. Keyed on codeHash (content-stable) — NOT buildHash, which
      // is a per-boot nonce that changes on every restart and used to force a
      // pointless reload after each restart. Falls back to buildHash only for
      // an older server that doesn't send codeHash yet.
      // localStorage so the hash survives Capacitor WebView suspension.
      // PREFER deployHash (2026-08-27). codeHash now tracks the bytes on disk
      // live so that versioned assets can be cached immutably — which meant
      // every file a working session saved, with no deploy and no restart, sent
      // a "new" hash on the next join and reloaded every open window and the
      // phone. deployHash moves only on a real deploy. Falls back to codeHash /
      // buildHash for a server that predates the split (e.g. the Pi before it
      // gets this deploy), so behaviour there is exactly what it is today.
      var _ch = msg.deployHash || msg.codeHash || msg.buildHash;
      if (_ch) {
        // The reload must follow the PAGE, not the data channel. The phone
        // loads the document from one machine (the Pi) and can hold a socket to
        // another (a stale saved URL → the PC). Two anchors fix that:
        //  1) window.__CODE_HASH — the hash baked into THIS document by the
        //     server that actually served it (server/index.js, getIndexHtml).
        //     If the socket's server is a different origin, its hash says
        //     nothing about our code: reloading re-fetches the same page from
        //     the same origin, the mismatch survives, and we loop forever.
        //  2) the storage key is now per-origin, so two servers can no longer
        //     fight over one shared slot (that was the flapping).
        var _sockOrigin = null;
        try { _sockOrigin = new URL(window.getServerUrl(), location.href).origin; } catch (e) {}
        var _sameOrigin = !!_sockOrigin && _sockOrigin === location.origin;
        // The document's anchor must be the SAME series as _ch above: compare
        // deploy-to-deploy when the server speaks deployHash, code-to-code
        // otherwise. Mixing the two would mismatch forever and reload in a loop.
        var _docHash = msg.deployHash
          ? ((typeof window.__DEPLOY_HASH === 'string') ? window.__DEPLOY_HASH : null)
          : ((typeof window.__CODE_HASH === 'string') ? window.__CODE_HASH : null);
        var HASH_KEY = '151-code-hash:' + (_sockOrigin || 'unknown');
        // One-time migration off the shared, cross-machine key.
        try { localStorage.removeItem('151-code-hash'); } catch (e) {}

        if (!_sameOrigin) {
          // Split brain: page from A, socket to B. Never reload on B's hash —
          // it cannot converge. Record it and let the mismatch banner (see
          // window.__151_ORIGINS) tell the user which machine is which.
          if (_docHash && _docHash !== _ch) {
            console.warn('[WS] Origin split: page=' + location.origin + ' (' + _docHash + ') socket=' + _sockOrigin + ' (' + _ch + ') — NOT reloading');
          }
          try { localStorage.setItem(HASH_KEY, _ch); } catch (e) {}
          knownBuildHash = _ch;
          window.__151_ORIGINS = { page: location.origin, pageHash: _docHash, socket: _sockOrigin, socketHash: _ch, split: true };
        if (typeof window.beaconOrigins === 'function') window.beaconOrigins();
          return;
        }

        window.__151_ORIGINS = { page: location.origin, pageHash: _docHash, socket: _sockOrigin, socketHash: _ch, split: false };
        if (typeof window.beaconOrigins === 'function') window.beaconOrigins();

        // Same origin: prefer the document's own hash as the baseline. Fall
        // back to the per-origin stored hash for an older server that doesn't
        // inject __CODE_HASH yet.
        var storedHash = _docHash || localStorage.getItem(HASH_KEY);
        if (storedHash && storedHash !== _ch) {
          console.log('[WS] Code hash changed:', storedHash, '->', _ch, '— reloading');
          try { localStorage.setItem(HASH_KEY, _ch); } catch (e) {}
          // If we're already mid-restart, a TV-off + reload is imminent — don't stack a third animation.
          var _recentRestart = false;
          try {
            var _ts = parseInt(sessionStorage.getItem('151-restart-animated-at') || '0', 10);
            if (_ts && (Date.now() - _ts) < 5000) _recentRestart = true;
          } catch(e) {}
          if (inRestartMode || _recentRestart) {
            knownBuildHash = _ch;
            return;
          }
          // Loop brake. If the reload does NOT change the document's hash (page
          // served from a stale cache, or from a machine that never got the
          // deploy) we would reload forever. Two auto-reloads per session is the
          // ceiling; past that we stop and leave the manual button.
          var _reloads = 0;
          try { _reloads = parseInt(sessionStorage.getItem('151-hash-reloads') || '0', 10) || 0; } catch (e) {}
          if (_reloads >= 2) {
            console.warn('[WS] Hash reload did not converge after ' + _reloads + ' attempts — stopping (use the manual refresh)');
            knownBuildHash = _ch;
            return;
          }
          try { sessionStorage.setItem('151-hash-reloads', String(_reloads + 1)); } catch (e) {}
          // Safe reload only. Do NOT purge the service worker / caches here:
          // the SW is network-first (it already fetches fresh when online),
          // and nuking the offline shell when the phone's connection is flaky
          // left the app unable to re-download — i.e. it would not open at
          // all. A plain reload is the behaviour that worked for years.
          window.triggerAnimatedReload ? window.triggerAnimatedReload('hot') : location.reload();
          return;
        }
        // Converged: page and socket agree. Clear the loop brake.
        try { sessionStorage.removeItem('151-hash-reloads'); } catch (e) {}
        try { localStorage.setItem(HASH_KEY, _ch); } catch (e) {}
        knownBuildHash = _ch;
      }

      if (msg.status === 'idle' && window.streaming) {
        // Response completed while we were disconnected — reset streaming state
        window.setStreamingState(false);
        window.updateStatusDot('idle');
        window.hideActivity();
      }
      if (msg.status === 'busy' && !window.streaming) {
        window.setStreamingState(true);
        window.streamingText = ''; window.thinkingText = '';
        window.updateStatusDot('busy');
      }
      // [12/11/2026 ] «busy» non vuol dire «ha il NOSTRO messaggio» (può
      // essere un altro turno): niente più svuotamento per indovinare. Si rimanda
      // tutto l'outbox col suo nonce, idle o busy: il server scarta i doppioni
      // (ack col nonce) e accoda quelli arrivati a turno in corso.
      if (window.activeSessionId) {
        window.redeliverPending(window.activeSessionId);
      }
      return;
    }

    if (msg.type === 'session_renamed') {
      var s = window.sessions.find(function(s) { return s.id === msg.id; });
      if (s) {
        s.title = msg.title;
        if (s.id === window.activeSessionId) window.headerTitle.textContent = s.title;
        window.renderSessionList();
      }
      return;
    }

    // Fix 2 (2026-07-21): a fleet session was just stamped server-side with its
    // agentType + monotonic agentNumber. Patch those onto the local session object
    // so the card renders its number/color immediately — no reload. fleetDisplayName
    // reads agentNumber straight off the session, so this is all the card needs.
    if (msg.type === 'session_fleet_stamped') {
      var fs = window.sessions.find(function(s) { return s.id === msg.sessionId; });
      if (fs) {
        if (msg.agentType) fs.agentType = msg.agentType;
        if (typeof msg.agentNumber === 'number') fs.agentNumber = msg.agentNumber;
        if (msg.title) fs.title = msg.title;
        if (fs.id === window.activeSessionId && msg.title) window.headerTitle.textContent = msg.title;
        window.renderSessionList();
      }
      return;
    }

    // CHIP MODELLO (2026-08-16): a session was re-pinned to a new model (topbar
    // chip picker, any device). Patch the local session so the card label and
    // the topbar chip (which reads sessions[].model) follow immediately.
    if (msg.type === 'session_model_changed') {
      var mcs = window.sessions.find(function(s) { return s.id === msg.sessionId; });
      if (mcs && msg.model) {
        mcs.model = msg.model;
        window.renderSessionList();
      }
      if (window.MainTopbar && typeof window.MainTopbar.refreshModel === 'function') {
        try { window.MainTopbar.refreshModel(); } catch(e) {}
      }
      return;
    }

    // [2026-09-30] Lavori in background di una sessione (motore SDK): quanti
    // sono ancora vivi. Solo la card cambia; niente toast né notifica — quelli
    // arrivano col turno spontaneo di risposta.
    // [17/10/2026] Arricchito: waiting + tasks → la card dice «waiting» e il
    // tasto rosso della chat resta acceso (sessions.js, «LAVORI IN SOTTOFONDO»).
    if (msg.type === 'session_background') {
      if (typeof window.applyBackgroundUpdate === 'function') window.applyBackgroundUpdate(msg);
      return;
    }

    // Background session status updates (broadcast from server to all clients)
    if (msg.type === 'session_status_changed') {
      var s = window.sessions.find(function(s) { return s.id === msg.sessionId; });
      if (s) {
        s.status = msg.status;
        if (msg.title) s.title = msg.title;
        if (msg.lastMessage) s.lastMessage = msg.lastMessage;
        if (msg.status === 'idle') window.clearLiveStreamState(msg.sessionId);
        // Active session finished but the final `done` was lost (relay HTTP
        // timeout on a long reply over the PC<->Pi path). This status broadcast
        // still arrives reliably — clear the stuck spinner here too, exactly as
        // the `sync`/join path does (lines ~197-202). Spinner/status ONLY: no
        // DOM, history, or pending touched, so it cannot reintroduce the
        // message-vanish regression.
        if (msg.status === 'idle' && msg.sessionId === window.activeSessionId && window.streaming) {
          window.setStreamingState(false);
          window.updateStatusDot('idle');
          window.hideActivity();
        }
        // If a background session just finished, mark it as awaiting attention
        if (msg.status === 'idle' && msg.sessionId !== window.activeSessionId) {
          window.awaitingSessions.add(msg.sessionId);
          window.persistAwaiting();
          window.showToast((s.title || 'Session') + ' finished', 'success');
          // Native/web push notification (fires even when app is visible, since this is a background session)
          if (typeof window.notifyDone === 'function') {
            window.notifyDone((s.title || 'Session') + ' finished', { force: true, title: 'The 151 Machine', sessionId: msg.sessionId });
          }
        }
        // B1 (2026-08-11): a session that just STARTED working again (busy) is no
        // longer "risposta pronta". The old code only ever added to awaiting on
        // idle and never cleared it on busy, so a card stayed "ready" even after
        // the owner had already replied and the agent resumed. Clear it here so the
        // card flips straight to "sta lavorando". UI-state only — no transport,
        // history, or server broadcast touched.
        // [11/10/2026] Al lavoro = il proprietario ha risposto (da qui o da un altro
        // apparecchio): la sua notifica non dice più il vero.
        // [08/11/2026] Un turno partito senza che questo schermo mandasse niente
        // (Claude che risponde da solo dopo un «!comando», un altro apparecchio,
        // un turno spontaneo): la chat aperta mostra subito il «sta pensando»,
        // come la risposta a join (~riga 516) e sessions.js (B2). Se il turno
        // l'ha mandato questo schermo, streaming è già vero: non fa niente.
        if (msg.status === 'busy' && msg.sessionId === window.activeSessionId && !window.streaming) {
          window.setStreamingState(true);
          window.streamingText = ''; window.thinkingText = '';
          window.updateStatusDot('busy');
          if (typeof window.showThinkingState === 'function') window.showThinkingState();
        }
        if (msg.status === 'busy' && typeof window.clearSessionNotification === 'function') {
          window.clearSessionNotification(msg.sessionId);
        }
        if (msg.status === 'busy' && window.awaitingSessions.has(msg.sessionId)) {
          window.awaitingSessions.delete(msg.sessionId);
          window.persistAwaiting();
        }
        window.renderSessionList();
      }
      return;
    }

    // [READ-SYNC 2026-08-15] Another device read this session — turn off the
    // "risposta pronta" dot here too. Idempotent (Set.delete no-ops when the
    // dot isn't lit) and it NEVER re-emits session_read, so no echo loop.
    if (msg.type === 'session_read') {
      // [11/10/2026] Letta altrove: via anche la notifica di questa sessione.
      if (msg.sessionId && typeof window.clearSessionNotification === 'function') {
        window.clearSessionNotification(msg.sessionId);
      }
      if (msg.sessionId && window.awaitingSessions && window.awaitingSessions.has(msg.sessionId)) {
        window.awaitingSessions.delete(msg.sessionId);
        if (typeof window.persistAwaiting === 'function') window.persistAwaiting();
        if (typeof window.renderSessionList === 'function') window.renderSessionList();
      }
      return;
    }

    if (msg.type === 'history') {
      // [12/11/2026 ] Ciò che la storia del server ha col suo nonce è arrivato.
      if (typeof window.forgetPendingInHistory === 'function') window.forgetPendingInHistory(msg.messages);
      // Punto 3 (blank-on-open): only bail when we're ACTIVELY streaming real text
      // that a full re-render would destroy. The old guard also bailed on a bare
      // *thinking placeholder* (streamingEl set by showThinkingState with no
      // streamedText, streaming=false) — so opening a busy/awaiting session whose
      // local history was empty dropped the authoritative history and showed
      // NOTHING until a manual re-click. history_append never had this guard, which
      // is why it "sometimes" worked. We now render, then re-attach the placeholder
      // to the tail (same pattern as history_append / resume below).
      if (window.streaming && window.streamingText) return;
      // Skip re-render if history hasn't changed (prevents flicker on reconnect).
      // Keep the short-circuit so trivially-identical syncs stay snappy, but on any
      // difference we REPLACE the rendered list from scratch. Incremental append is
      // what caused duplicate bubbles after rapid rejoin — server now sends the full
      // authoritative list and we trust it.
      var lastMsg = msg.messages.length > 0 ? (msg.messages[msg.messages.length - 1].content || '') : '';
      var hash = window.activeSessionId + ':' + msg.messages.length + ':' + lastMsg.length + ':' + lastMsg.slice(-50);
      if (hash === window.lastHistoryHash && window.messagesEl.children.length > 0) {
        // Even when we skip the repaint, re-affirm idempotency: a concurrent paint
        // source (e.g. a DETACHED replay) may have added a duplicate finalized bubble
        // since the last paint. Sweep identical-key clones without a full re-render.
        if (typeof window.dedupeRenderedBubbles === 'function') window.dedupeRenderedBubbles();
        return;
      }
      window.lastHistoryHash = hash;

      // Keyed re-render: clear and rebuild from the authoritative array.
      // Dedup within the incoming list by content-hash key so a server that
      // sends the same message twice (rare but possible) doesn't render two bubbles.
      var _histMessages = msg.messages;
      if (typeof window.computeMsgKey === 'function') {
        var _seenKeys = {};
        _histMessages = _histMessages.filter(function(m) {
          var k = window.computeMsgKey(m);
          if (!k || !_seenKeys[k]) { if (k) _seenKeys[k] = true; return true; }
          return false;
        });
      }
      // Also seed _renderedNonces from the history so any in-flight user_message
      // echo for those same nonces gets deduped instead of double-rendered.
      if (window.markNonceRendered) {
        for (var _hi = 0; _hi < _histMessages.length; _hi++) {
          var _hm = _histMessages[_hi];
          if (_hm && _hm.nonce) window.markNonceRendered(_hm.nonce);
        }
      }
      window.renderHistoryMessages(_histMessages, false);

      // Punto 4a (stale cross-device open): REPLACE the local session history with
      // the server's authoritative list so a message sent from another client can
      // never be masked by a frozen local copy on the next open. (Local history is
      // serialized at page-load and otherwise only refreshed on reconnect.)
      var _histSession = window.sessions.find(function(s) { return s.id === window.activeSessionId; });
      if (_histSession) _histSession.history = msg.messages;
      // Cache history locally
      if (window.activeSessionId) window.cacheHistory(window.activeSessionId, msg.messages);
      // Punto 3 + ROUND-3 (dup fix): the full re-render detaches any live/thinking
      // bubble. Re-attach it ONLY if its content isn't ALREADY present in the freshly
      // painted authoritative history — otherwise a finished turn whose assistant
      // reply is now IN history AND still held by the streaming node would render
      // twice. Reconcile by key: duplicate → drop + reset stream state; a genuine
      // live/thinking node (in-progress stream, or a bare "Processing…" placeholder
      // with no content) → re-append as the LAST child so it stays BELOW history.
      if (window.streamingEl) {
        var _streamKey = '';
        try {
          var _streamContent = window.streamingText || '';
          _streamKey = (_streamContent && typeof window.computeMsgKey === 'function')
            ? window.computeMsgKey({ role: 'assistant', content: _streamContent })
            : ((window.streamingEl.dataset && window.streamingEl.dataset.msgKey) || '');
        } catch (e) {}
        var _alreadyPainted = _streamKey
          && window.messagesEl.querySelector('[data-msg-key="' + _streamKey + '"]:not(.streaming)');
        if (_alreadyPainted) {
          try { if (window.streamingEl.isConnected) window.streamingEl.remove(); } catch (e) {}
          window.streamingEl = null;
          window.streamingText = '';
          window.thinkingText = '';
        } else {
          window.messagesEl.appendChild(window.streamingEl);
        }
      }
      // Belt-and-suspenders: guarantee no identical-key finalized clones survive.
      if (typeof window.dedupeRenderedBubbles === 'function') window.dedupeRenderedBubbles();
      window.autoScroll = true;
      window.scrollToBottom();
      return;
    }

    // Incremental history append — server sends only new messages we're missing
    if (msg.type === 'history_append') {
      // Dedup: skip any message whose content-hash key is already in the DOM.
      // Covers the common case where the finalized streaming bubble already
      // represents the last assistant turn that the server then echoes via
      // history_append on WS join/rejoin.
      var newMessages = msg.messages;
      if (newMessages.length > 0 && typeof window.computeMsgKey === 'function') {
        newMessages = newMessages.filter(function(m) {
          var key = window.computeMsgKey(m);
          if (!key) return true; // no key computed — allow through
          // ROUND CHAT bug 2 (2026-08-16): a bubble finalized from the live
          // stream may carry its keys ONLY in data-msg-keys (plural, stamped by
          // the done handler when client/server texts differ). Checking just
          // data-msg-key re-appended the same reply on every rejoin — the
          // recurring same-key DEDUP-SWEEP loop in the client log.
          return !window.messagesEl.querySelector('[data-msg-key="' + key + '"], [data-msg-keys~="' + key + '"]');
        });
      }
      if (newMessages.length > 0) {
        window.renderHistoryMessages(newMessages, true);
      }
      // B2 (2026-08-11) bug (c): appended history (incl. the user message that
      // triggered this turn) lands at the DOM tail — behind the in-flight
      // streaming bubble — so the reply showed ABOVE the owner's message. Re-push the
      // streaming element back to last child so the live reply always stays
      // BELOW the just-appended messages. Array/history order untouched.
      if (window.streamingEl && window.streamingEl.isConnected) {
        window.messagesEl.appendChild(window.streamingEl);
      }
      // Update local session data
      var localSession = window.sessions.find(function(s) { return s.id === window.activeSessionId; });
      if (localSession && localSession.history) {
        for (var i = 0; i < msg.messages.length; i++) {
          localSession.history.push(msg.messages[i]);
        }
        window.cacheHistory(window.activeSessionId, localSession.history);
      }
      window.autoScroll = true;
      window.scrollToBottom();
      return;
    }

    // Live cross-device echo: another device on this session sent a message.
    // Server broadcasts to every subscriber EXCEPT the sender, so this path runs only
    // on devices that did NOT originate the send. Nonce dedup guards the sender's own
    // echo in the rare case the exclude path misses (e.g. same ws shared in weird states).
    if (msg.type === 'user_message') {
      if (msg.nonce && window.hasNonceRendered && window.hasNonceRendered(msg.nonce)) {
        // Our own message — already rendered optimistically
        return;
      }
      // Only render if we're actually viewing the session this applies to
      if (!window.activeSessionId) return;
      // Mark as rendered so any re-broadcast (e.g. after reconnect) is deduped
      if (msg.nonce && window.markNonceRendered) window.markNonceRendered(msg.nonce);
      // Append as a user bubble from the other device
      window.appendMessage('user', msg.content || '', msg.timestamp || null, true, msg.attachments);
      // Mirror into local session history so reconnect / history diff stays consistent
      var umSession = window.sessions.find(function(s) { return s.id === window.activeSessionId; });
      if (umSession) {
        if (!umSession.history) umSession.history = [];
        umSession.history.push({
          role: 'user',
          content: msg.content || '',
          attachments: msg.attachments || [],
          nonce: msg.nonce || undefined,
        });
        umSession.lastActivity = new Date().toISOString();
        window.cacheHistory(window.activeSessionId, umSession.history);
      }
      window.autoScroll = true;
      window.scrollToBottom();
      return;
    }

    // Resume: reconnected while a response was in progress — restore partial stream.
    // Also fired in reply to client-sent `get_stream_state` (same shape, additive
    // `sessionId` + `streaming` fields).
    if (msg.type === 'resume') {
      // Race guard: user may have switched sessions mid-roundtrip. Drop stale resumes.
      if (msg.sessionId && window.activeSessionId && msg.sessionId !== window.activeSessionId) {
        return;
      }
      // Detached-runs: this snapshot reflects the full server-side stream up to
      // `msg.seq`, so adopt it as our seen-seq — any later reconnect then asks
      // for only the events after it (incremental replay instead of full resend).
      if (window.DETACHED_RUNS && typeof msg.seq === 'number') {
        // [SYNC-PROBE 2026-08-15] Empty-reply suspect #1: this snapshot carries
        // NO text but a seq AHEAD of what we've applied — adopting it (below)
        // will seq-gate the turn's later delta/done without anything ever being
        // rendered. streamBuffers (text source) and stream-log (seq source) are
        // two different stores and can diverge (server restart / clear).
        try {
          var _rbSid = msg.sessionId || window.activeSessionId;
          var _rbApplied = (window._appliedSeq && window._appliedSeq[_rbSid]) || 0;
          if (!(msg.streamedText && String(msg.streamedText).length) && msg.seq > _rbApplied
              && typeof window.syncBeacon === 'function') {
            window.syncBeacon('RESUME-EMPTY-SEQ', {
              sid: _rbSid, seq: msg.seq, appliedBefore: _rbApplied,
              streaming: msg.streaming !== false,
              histLen: Array.isArray(msg.history) ? msg.history.length : -1
            });
          }
        } catch (e) {}
        // ROUND CHAT bug 1 FIX (2026-08-16, proven by 144 RESUME-EMPTY-SEQ
        // beacons): only adopt msg.seq as seen/APPLIED when we actually adopted
        // the server's streamedText (non-empty) or the server says the turn is
        // over (streaming:false → history is authoritative). Adopting the seq of
        // an EMPTY mid-turn snapshot poisoned the gate: the turn's later
        // delta/done were discarded without anything ever being rendered, and
        // lastSeq was inflated so the replay path re-delivered nothing.
        var _rbHasText = !!(msg.streamedText && String(msg.streamedText).length);
        if (_rbHasText || msg.streaming === false) {
          window._noteSeq(msg.sessionId || window.activeSessionId, msg.seq);
          // We just adopted the server's full streamedText up to msg.seq wholesale
          // (assignment below, not append). Mark everything up to here as APPLIED so
          // a subsequent replay/queued re-delivery of those same deltas is dropped
          // instead of re-concatenated onto the text we already have.
          window._noteApplied(msg.sessionId || window.activeSessionId, msg.seq);
        }
      }
      // Server explicitly says nothing is streaming — reconcile, don't force-create.
      if (msg.streaming === false) {
        if (window.streamingEl) {
          if (window.streamingEl.isConnected) window.streamingEl.remove();
          window.streamingEl = null;
        }
        window.setStreamingState(false);
        window.streamingText = '';
        window.thinkingText = '';
        if (msg.sessionId) window.clearLiveStreamState(msg.sessionId);
        // [12/11/2026 ] I messaggi che la storia del server ha già (col loro
        // nonce) escono dall'outbox: è la conferma vera, non una supposizione.
        if (typeof window.forgetPendingInHistory === 'function') window.forgetPendingInHistory(msg.history);
        // Determine if the server history is BEHIND the client — i.e. the user
        // just sent a message the server has not yet persisted/echoed.
        // get_stream_state fires on every window focus/visibility/reconnect, so
        // this branch routinely runs in the gap between "user sent" and "server
        // persisted" (worse on the Pi relay path). Treating that as a normal
        // reconcile destroys the optimistic last user bubble AND clears its
        // pending copy → message vanishes for good (2026-05-16 "last message
        // disappears" bug). The 2026-05-15 hash short-circuit does NOT cover
        // this — it only guarded the alt-tab full-wipe (server AHEAD). A
        // reconcile is only legitimate when the server is AHEAD (a stream
        // finished while away); NEVER when it is behind.
        var _rcSession = window.sessions.find(function(s) { return s.id === msg.sessionId; });
        var _serverBehind = false;
        if (_rcSession && Array.isArray(_rcSession.history) && _rcSession.history.length > 0
            && typeof window.computeMsgKey === 'function') {
          var _localTailUser = null;
          for (var _lt = _rcSession.history.length - 1; _lt >= 0; _lt--) {
            if (_rcSession.history[_lt] && _rcSession.history[_lt].role === 'user') {
              _localTailUser = _rcSession.history[_lt]; break;
            }
          }
          if (_localTailUser) {
            var _ltKey = window.computeMsgKey(_localTailUser);
            var _srvHas = Array.isArray(msg.history) && msg.history.some(function(m) {
              return window.computeMsgKey(m) === _ltKey;
            });
            if (_ltKey && !_srvHas) _serverBehind = true;
          }
        }
        // Unconfirmed pending sends also mean the server is behind.
        if (!_serverBehind && window.getPendingForSession
            && window.getPendingForSession(window.activeSessionId || msg.sessionId).length > 0) {
          _serverBehind = true;
        }
        // [12/11/2026 ] L'outbox non si svuota più qui: esce solo per nonce
        // (ack del server, o voce nella storia del server — sopra).
        // Clean up any orphaned "running" tool cards — server says nothing is
        // streaming, so anything still marked running is stuck from a prior
        // disconnect / crash. Force them to "done" so the UI reflects truth.
        try {
          var _orphanRunning = document.querySelectorAll('.tool-activity-card-status:not(.tool-activity-card-done)');
          for (var _orIdx = 0; _orIdx < _orphanRunning.length; _orIdx++) {
            _orphanRunning[_orIdx].textContent = 'done';
            _orphanRunning[_orIdx].classList.add('tool-activity-card-done');
            var _orCard = _orphanRunning[_orIdx].closest('.tool-activity-card');
            if (_orCard) _orCard.classList.add('tool-activity-done');
          }
          var _openGroups = document.querySelectorAll('.tool-process-group:not(.tool-process-closed)');
          for (var _ogIdx = 0; _ogIdx < _openGroups.length; _ogIdx++) {
            _openGroups[_ogIdx].classList.add('tool-process-closed');
            _openGroups[_ogIdx].classList.remove('tool-process-open');
            var _ogLabel = _openGroups[_ogIdx].querySelector('.tool-process-label');
            if (_ogLabel) _ogLabel.textContent = (_openGroups[_ogIdx]._count || 0) + ' steps completed';
          }
        } catch(e) {}
        // Authoritative history reconcile: if a stream completed while the
        // user was in another session, server's `history` is the only place
        // the final assistant message lives (buffer was cleared on finish).
        // Use hash-based check (same as the `history` handler) so we don't
        // re-render when the data hasn't actually changed — the old count-based
        // check always mismatched when renderHistoryMessages skips entries
        // (empty assistants, stripped interruptions), causing a full DOM wipe
        // on every alt-tab and scrolling to the top ("messages vanish").
        if (!_serverBehind && msg.sessionId && msg.sessionId === window.activeSessionId &&
            Array.isArray(msg.history) && msg.history.length > 0) {
          var _rLastMsg = msg.history[msg.history.length - 1].content || '';
          var _rHash = msg.sessionId + ':' + msg.history.length + ':' + _rLastMsg.length + ':' + _rLastMsg.slice(-50);
          if (_rHash !== window.lastHistoryHash || !window.messagesEl.children.length) {
            window.lastHistoryHash = _rHash;
            window.renderHistoryMessages(msg.history, false);
            var rcSession = window.sessions.find(function(s) { return s.id === msg.sessionId; });
            if (rcSession) rcSession.history = msg.history;
            if (window.cacheHistory) window.cacheHistory(msg.sessionId, msg.history);
            if (window.archiviaStoria) window.archiviaStoria(msg.sessionId, msg.history);
            window.autoScroll = true;
            window.scrollToBottom();
          }
        }
        return;
      }
      window.setStreamingState(true);
      // [12/11/2026 ] Un turno in corso non dice QUALE messaggio ha: l'outbox
      // perde solo ciò che la storia del server ha col suo nonce.
      if (typeof window.forgetPendingInHistory === 'function') window.forgetPendingInHistory(msg.history);
      // Server's streamedText is authoritative — overwrite, don't append.
      // If content matches what's already showing, keep the element to avoid flash.
      if (window.streamingEl) {
        if (!msg.streamedText || msg.streamedText !== window.streamingText || !window.streamingEl.isConnected) {
          window.streamingEl.remove();
          window.streamingEl = null;
        }
      }
      // Only re-render history if the DOM is empty or server has more messages.
      // Filter incoming list by content-hash key to avoid stacking duplicates
      // on top of messages already rendered from the HTTP session load.
      var serverHistLen = msg.history ? msg.history.length : 0;
      var domMsgCount = window.messagesEl.querySelectorAll('.message').length;
      if (serverHistLen > 0 && (domMsgCount === 0 || serverHistLen > domMsgCount + 1)) {
        var _resumeHist = msg.history;
        if (typeof window.computeMsgKey === 'function' && domMsgCount > 0) {
          _resumeHist = _resumeHist.filter(function(m) {
            var k = window.computeMsgKey(m);
            if (!k) return true;
            // bug 2 (2026-08-16): also match data-msg-keys (plural) — see the
            // identical fix in the history_append filter above.
            return !window.messagesEl.querySelector('[data-msg-key="' + k + '"], [data-msg-keys~="' + k + '"]');
          });
        }
        if (_resumeHist.length > 0 || domMsgCount === 0) {
          window.renderHistoryMessages(domMsgCount === 0 ? msg.history : _resumeHist, domMsgCount > 0);
        }
        // B2 (c): same tail-order guard as history_append — after appending
        // resumed history, re-push the streaming bubble to last child so the
        // live reply stays BELOW the restored messages.
        if (window.streamingEl && window.streamingEl.isConnected) {
          window.messagesEl.appendChild(window.streamingEl);
        }
      }
      window.streamingText = msg.streamedText || '';
      if (msg.sessionId) {
        window.saveLiveStreamState(msg.sessionId, {
          streaming: true,
          streamedText: window.streamingText,
          thinkingText: window.thinkingText || '',
        });
      }
      window.updateStatusDot('busy');
      if (msg.tools && msg.tools.length > 0) {
        for (var i = 0; i < msg.tools.length; i++) {
          window.addActivity('tool', msg.tools[i]);
        }
      }
      if (window.streamingText) {
        window.updateStreamingMessage(window.streamingText);
      } else {
        window.showThinkingState();
      }
      window._liveDiscards = Array.isArray(msg.discarded) ? msg.discarded.slice() : [];
      if (window.streamingEl && window.streamingEl.isConnected && typeof window.ensureRedoRows === 'function') {
        window.ensureRedoRows(window.streamingEl, window._liveDiscards, true);
      }
      return;
    }

    // Server confirms stop completed — resolve any pending interrupt promise
    if (msg.type === 'stopped') {
      // ROUND CHAT bug 4 (2026-08-16): immediate, truthful feedback for the
      // stop BUTTON (interjection stops don't set _stopAckPending, so they stay
      // silent). The server now says whether anything was actually stopped.
      if (window._stopAckPending) {
        window._stopAckPending = null;
        if (window._stopAckTimer) { clearTimeout(window._stopAckTimer); window._stopAckTimer = null; }
        var _sbEl = document.getElementById('stop-btn');
        if (_sbEl) _sbEl.style.opacity = '';
        if (typeof window.showToast === 'function') {
          if (msg.stopped === false) {
            window.showToast('Nothing to stop — the session was already idle' + (msg.reason ? ' (' + msg.reason + ')' : ''), 'error');
          } else {
            window.showToast('Stopped', 'success');
          }
        }
      }
      if (window._stopResolve) {
        window._stopResolve(msg); // [29/10/2026] msg.deferred = il messaggio aspetta, niente è fermato
        window._stopResolve = null;
      }
      return;
    }

    // Acknowledgment — server received the message and started Claude CLI
    if (msg.type === 'ack') {
      // [29/10/2026] deferred: arriverà quando il modello finisce di scrivere
      // (gli aiutanti in sottofondo continuano a lavorare).
      window.markLastUserStatus(msg.deferred ? 'Sends when this reply ends' : 'Received', 'received');
      // [12/11/2026 ] Esce dall'outbox SOLO il messaggio di questo nonce (prima:
      // tutta la sessione, anche B mai arrivato). Un doppione a server fermo
      // rimette la chat in idle (ackPending, core.js).
      window.ackPending(msg, window.activeSessionId);
      return;
    }

    if (msg.type === 'queued_messages') {
      console.log('[WS] Processing', msg.messages.length, 'queued messages from background session');
      var hadDone = false;
      var finalQueuedText = '';
      // Process each queued message in order — reconstruct final state
      for (var qi = 0; qi < msg.messages.length; qi++) {
        var qMsg = msg.messages[qi];
        if (qMsg.type === 'delta' && qMsg.content) {
          // Same idempotency gate as the live delta path — a queued batch can
          // re-carry deltas already shown/snapshotted; drop those by seq instead
          // of re-concatenating (duplicated-text fix). No-op without _seq.
          var _qSid = qMsg.sessionId || msg.sessionId || window.activeSessionId;
          // Queued events don't re-enter onmessage — sync the epoch here too
          // before gating (ROUND CHAT bug 1/3, 2026-08-16).
          if (qMsg._epoch != null) window._syncSeqEpoch(_qSid, qMsg._epoch);
          if (window._alreadyApplied(_qSid, qMsg._seq)) { continue; }
          window.streamingText += qMsg.content;
          window._noteApplied(_qSid, qMsg._seq);
          finalQueuedText = window.streamingText;
        } else if (qMsg.type === 'redo') {
          var _qrSid = qMsg.sessionId || msg.sessionId || window.activeSessionId;
          if (window._alreadyApplied(_qrSid, qMsg._seq)) { continue; }
          window._noteApplied(_qrSid, qMsg._seq);
          if (typeof window.markStreamRedo === 'function') window.markStreamRedo(qMsg.discarded || '');
          finalQueuedText = '';
        } else if (qMsg.type === 'done') {
          hadDone = true;
          if (qMsg.fullResponse) finalQueuedText = qMsg.fullResponse;
          if (qMsg.discarded) window._liveDiscards = qMsg.discarded.slice();
        } else if (qMsg.type === 'context_usage') {
          var qCtxSid = qMsg.sessionId || window.activeSessionId;
          if (qCtxSid) {
            var qCtxSession = window.sessions.find(function(s) { return s.id === qCtxSid; });
            if (qCtxSession) {
              qCtxSession._contextTokens = qMsg.inputTokens;
              // Prefer the server's authoritative percentage. Local fallback uses
              // 200K to match the non-1M Opus pin (CLAUDE_MODEL=claude-opus-4-8).
              // Re-check this constant if the model pin changes.
              if (typeof qMsg.percentage === 'number' && isFinite(qMsg.percentage)) {
                qCtxSession._contextPct = qMsg.percentage;
              } else {
                var qSessionLimit = qCtxSession._contextLimit || 200000;
                qCtxSession._contextPct = Math.min(Math.round((qMsg.inputTokens / qSessionLimit) * 100), 100);
              }
            }
          }
        } else if (qMsg.type === 'tool_start') {
          window.addActivity('tool', qMsg.tool, '');
        } else if (qMsg.type === 'tool_done') {
          for (var qi2 = window.activityLogEntries.length - 1; qi2 >= 0; qi2--) {
            if (window.activityLogEntries[qi2].type === 'tool' && window.activityLogEntries[qi2].raw === qMsg.tool && !window.activityLogEntries[qi2].done) {
              window.activityLogEntries[qi2].done = true;
              break;
            }
          }
        } else if (qMsg.type === 'status') {
          if (qMsg.status === 'complete') window.addActivity('done', qMsg.detail || 'Done');
        } else if (qMsg.type === 'session_renamed') {
          var qRenameSession = window.sessions.find(function(s) { return s.id === qMsg.id; });
          if (qRenameSession) { qRenameSession.title = qMsg.title; window.renderSessionList(); }
        }
      }
      // If response finished while away — finalize it now
      if (hadDone && finalQueuedText) {
        var _qFin = window.finalizeStreamingMessage(finalQueuedText);
        var _qDisc = window._liveDiscards || [];
        try {
          if (typeof window.ensureRedoRows === 'function') {
            var _qEl = (_qFin && _qFin.isConnected) ? _qFin : (window.messagesEl && window.messagesEl.querySelector('.message:last-of-type'));
            window.ensureRedoRows(_qEl, _qDisc, true);
            var _qLive = window.messagesEl ? window.messagesEl.querySelectorAll('.redo-row.redo-live') : [];
            for (var _qli = 0; _qli < _qLive.length; _qli++) _qLive[_qli].classList.remove('redo-live');
          }
        } catch (e) {}
        window._liveDiscards = [];
        window.setStreamingState(false);
        if (window.activeSessionId) window.clearLiveStreamState(window.activeSessionId);
        window.updateStatusDot('idle');
        window.hideActivity();
        if (window.activeSessionId && document.hidden) {
          window.awaitingSessions.add(window.activeSessionId);
          window.persistAwaiting();
        }
        var qSession = window.sessions.find(function(s) { return s.id === window.activeSessionId; });
        if (qSession) {
          qSession.status = 'idle';
          qSession.lastMessage = finalQueuedText.slice(0, 100);
          if (!qSession.history) qSession.history = [];
          var _qhEntry = { role: 'assistant', content: finalQueuedText };
          if (_qDisc.length) _qhEntry.discarded = _qDisc;
          qSession.history.push(_qhEntry);
          qSession.lastActivity = new Date().toISOString();
        }
        window.renderSessionList();
        window.showToast('Session completed while you were away', 'success');
        window.playDoneChime();
        if (typeof window.notifyDone === 'function') {
          var qTitle = qSession ? qSession.title : 'Session';
          window.notifyDone(qTitle + ' completed while you were away', { force: true, title: 'The 151 Machine', sessionId: window.activeSessionId });
        }
      } else if (finalQueuedText) {
        // Still streaming — update display with buffered text
        window.updateStreamingMessage(finalQueuedText);
        if (window._liveDiscards && window._liveDiscards.length && window.streamingEl && typeof window.ensureRedoRows === 'function') {
          window.ensureRedoRows(window.streamingEl, window._liveDiscards, true);
        }
        if (window.activeSessionId) {
          window.saveLiveStreamState(window.activeSessionId, {
            streaming: true,
            streamedText: finalQueuedText,
            thinkingText: window.thinkingText || '',
          });
        }
      }
      if (window.activeSessionId) window.updateContextIndicator(window.activeSessionId);
      return;
    }

    if (msg.type === 'thinking_start') {
      window.thinkingText = '';
      if (window.activeSessionId) {
        window.saveLiveStreamState(window.activeSessionId, {
          streaming: true,
          streamedText: window.streamingText || '',
          thinkingText: '',
        });
      }
      return;
    }

    if (msg.type === 'thinking') {
      window.thinkingText += msg.content;
      window.updateThinkingDisplay(window.thinkingText);
      if (window.activeSessionId) {
        window.saveLiveStreamState(window.activeSessionId, {
          streaming: true,
          streamedText: window.streamingText || '',
          thinkingText: window.thinkingText,
        });
      }
      return;
    }

    if (msg.type === 'delta') {
      // Idempotency gate: if this delta's content is already folded into
      // streamingText (re-delivered on reconnect, or already adopted via a resume
      // snapshot), drop it instead of re-appending — the fix for duplicated text
      // on reconcile. No-op when DETACHED_RUNS is off or the frame carries no _seq.
      var _dSid = msg.sessionId || window.activeSessionId;
      if (window._alreadyApplied(_dSid, msg._seq)) return;
      window.streaming = true;
      // Mark last user message as delivered on first delta
      if (!window.streamingText) window.markLastUserStatus('Delivered', 'delivered');
      // Collapse thinking when real text starts
      if (window.thinkingText && !window.streamingText) window.collapseThinking();
      window.streamingText += msg.content;
      window._noteApplied(_dSid, msg._seq);
      if (window.activeSessionId) {
        window.saveLiveStreamState(window.activeSessionId, {
          streaming: true,
          streamedText: window.streamingText,
          thinkingText: window.thinkingText || '',
        });
      }
      window.updateStreamingMessage(window.streamingText);
      return;
    }

    // [2026-10-04] Il controllo delle regole ha fatto rifare la risposta: il
    // testo arrivato finora si chiude in una riga grigia, il seguito è la nuova.
    if (msg.type === 'redo') {
      var _rdSid = msg.sessionId || window.activeSessionId;
      if (window._alreadyApplied(_rdSid, msg._seq)) return;
      window._noteApplied(_rdSid, msg._seq);
      if (typeof window.markStreamRedo === 'function') window.markStreamRedo(msg.discarded || '');
      if (window.activeSessionId) {
        window.saveLiveStreamState(window.activeSessionId, {
          streaming: true, streamedText: '', thinkingText: window.thinkingText || '',
        });
      }
      return;
    }

    if (msg.type === 'tool_start') {
      // [2026-09-10] Tolto il ramo `window.TIMELINE_UI && window.ToolTimeline`:
      // js/tool-timeline.js non è MAI stato agganciato alla pagina, quindi
      // window.ToolTimeline era sempre undefined e questo ramo non è mai
      // partito. Resta la strada vera, quella che si vedeva davvero.
      window.addActivity('tool', msg.tool, '');
      return;
    }

    if (msg.type === 'tool_progress') {
      // [2026-09-10] Qui c'era SOLO il ramo morto della timeline: il messaggio
      // si ignora, esattamente come già succedeva nei fatti.
      return;
    }

    if (msg.type === 'tool_use') {
      // Accumulate tool cards into a collapsible process group
      var messagesForCard = document.getElementById('messages');
      if (messagesForCard && window.renderToolCard) {
        var group = messagesForCard.querySelector('.tool-process-group:last-child');
        if (!group || group.classList.contains('tool-process-closed')) {
          group = document.createElement('div');
          group.className = 'tool-process-group';
          group._count = 0;
          var header = document.createElement('div');
          header.className = 'tool-process-header';
          header.innerHTML = '<span class="tool-process-arrow">&#9654;</span><span class="tool-process-label">Working...</span>';
          header.onclick = function() { group.classList.toggle('tool-process-open'); };
          group.appendChild(header);
          var body = document.createElement('div');
          body.className = 'tool-process-body';
          group.appendChild(body);
          messagesForCard.appendChild(group);
        }
        var card = window.renderToolCard(msg);
        group.querySelector('.tool-process-body').appendChild(card);
        group._count = (group._count || 0) + 1;
        group.querySelector('.tool-process-label').textContent = 'Working... (' + group._count + ' steps)';
        window.scrollToBottom();
      }
      // Full tool info arrived — update existing entry with detail instead of duplicating
      var detail = window.extractToolDetail(msg.tool, msg.input);
      var updated = false;
      for (var i = window.activityLogEntries.length - 1; i >= 0; i--) {
        if (window.activityLogEntries[i].type === 'tool' && window.activityLogEntries[i].raw === msg.tool && !window.activityLogEntries[i].detail) {
          window.activityLogEntries[i].detail = detail;
          updated = true;
          break;
        }
      }
      if (!updated) {
        window.addActivity('tool', msg.tool, detail);
      } else if (window.inlineActivityEl) {
        window.renderActivityLog(window.inlineActivityEl);
        window.scrollToBottom();
      }
      return;
    }

    if (msg.type === 'tool_done') {
      // Resolve tool activity card
      if (window.resolveToolCard && msg.tool) {
        var allCards = document.querySelectorAll('.tool-activity-card');
        for (var ci = allCards.length - 1; ci >= 0; ci--) {
          var nameEl = allCards[ci].querySelector('.tool-activity-card-name');
          var statusEl = allCards[ci].querySelector('.tool-activity-card-status');
          if (nameEl && nameEl.textContent === msg.tool && statusEl && statusEl.textContent === 'running') {
            statusEl.textContent = 'done';
            statusEl.classList.add('tool-activity-card-done');
            if (msg.output && msg.output.trim()) {
              var outputDiv = document.createElement('div');
              outputDiv.className = 'tool-output-content';
              outputDiv.textContent = msg.output;
              allCards[ci].appendChild(outputDiv);
              allCards[ci].classList.add('tool-activity-has-output');
              allCards[ci].addEventListener('click', function(e) {
                e.currentTarget.classList.toggle('tool-output-expanded');
              });
            } else {
              allCards[ci].classList.add('tool-activity-done');
            }
            break;
          }
        }
      }
      // Mark the most recent matching tool entry as done
      for (var i = window.activityLogEntries.length - 1; i >= 0; i--) {
        if (window.activityLogEntries[i].type === 'tool' && window.activityLogEntries[i].raw === msg.tool && !window.activityLogEntries[i].done) {
          window.activityLogEntries[i].done = true;
          break;
        }
      }
      if (window.inlineActivityEl) {
        window.renderActivityLog(window.inlineActivityEl);
      }
      return;
    }

    if (msg.type === 'status') {
      if (msg.status === 'thinking') {
        var label = msg.detail || 'Thinking...';
        // Make model info friendlier
        label = label.replace(/^Model:\s*claude.*$/i, 'Claude is thinking...');
        window.addActivity('thinking', label);
        window.markLastUserStatus('Working', 'delivered');
      } else if (msg.status === 'complete') {
        window.addActivity('done', msg.detail || 'Done');
      }
      return;
    }

    if (msg.type === 'done') {
      // Truncation repro instrumentation (b_653a85d4): log what the SERVER says
      // the finished turn contains vs what the client has buffered. If these
      // match but the bubble is short → client render bug (H1); if the server
      // length is already short → the turn itself was cut upstream (H2).
      try {
        console.log('[DONE-LEN] server=' + ((msg.fullResponse || '').length)
          + ' clientBuf=' + ((window.streamingText || '').length)
          + ' seq=' + (msg._seq != null ? msg._seq : '-'));
      } catch (e) {}
      // ROOT FIX (duplicate message box): seq-gate the terminal frame exactly
      // like deltas. The replay log (DETACHED_RUNS) re-dispatches a finished
      // turn's `done` on reconnect, and the Pi relay can double-deliver it. Both
      // carry a `_seq` we have already applied → finalizing again paints a second
      // identical bubble (the "due box identiche" bug). If this `done`'s seq was
      // already applied, just clear the in-progress UI and bail — never finalize
      // twice. Inert when the flag is off or no _seq is present (degrades to
      // today's behaviour). The DOM-key dedup further below stays as a backstop.
      var _doneSid = msg.sessionId || window.activeSessionId;
      if (window._alreadyApplied(_doneSid, msg._seq)) {
        // [SYNC-PROBE 2026-08-15] Empty-reply suspect #2: a `done` discarded by
        // the seq-gate. Legit when the turn was already finalized; the smoking
        // gun is bubbleInDom=false with serverLen>0 — gated WITHOUT anything
        // ever rendered (pairs with a RESUME-EMPTY-SEQ beacon just before).
        var _dgFull = msg.fullResponse || '';
        var _dgInDom = false;
        try {
          if (_dgFull && typeof window.computeMsgKey === 'function' && window.messagesEl) {
            var _dgKey = window.computeMsgKey({ role: 'assistant', content: _dgFull });
            _dgInDom = !!(_dgKey && window.messagesEl.querySelector(
              '[data-msg-key="' + _dgKey + '"], [data-msg-keys~="' + _dgKey + '"]'));
          }
          if (typeof window.syncBeacon === 'function') {
            window.syncBeacon('DONE-SEQGATED', {
              sid: _doneSid, seq: (msg._seq != null ? msg._seq : null),
              applied: (window._appliedSeq && window._appliedSeq[_doneSid]) || 0,
              serverLen: _dgFull.length, clientLen: (window.streamingText || '').length,
              bubbleInDom: _dgInDom
            });
          }
        } catch (e) {}
        // ROUND CHAT bug 1/3 FIX (2026-08-16): the gate was CONFIRMED (20+
        // beacons) to swallow REAL first-delivery `done`s after a server seq
        // reset — applied>seq, serverLen>0, bubbleInDom=false. When the reply
        // text is nowhere in the DOM, this cannot be a re-delivery of something
        // we already painted: SELF-HEAL by falling through to the normal
        // finalize below (its own multi-key dup check still guards the true-dup
        // corner). Only a `done` whose text IS on screen is dropped here — and
        // now the leftover streaming placeholder (the ghost "Claude / Running
        // command" bubble the old path left behind) is removed too.
        if (!(_dgFull && String(_dgFull).trim() && !_dgInDom)) {
          if (window.streamingEl && window.streamingEl.isConnected) {
            try { window.streamingEl.remove(); } catch (e) {}
          }
          window.streamingEl = null;
          window.setStreamingState(false);
          if (window.activeSessionId) window.clearLiveStreamState(window.activeSessionId);
          window.updateStatusDot('idle');
          window.hideActivity();
          return;
        }
      }
      window._noteApplied(_doneSid, msg._seq);
      // [12/11/2026 ] La fine di un turno non svuota l'outbox: un messaggio
      // scritto durante il turno può non essere mai arrivato. Esce solo per nonce.
      // Length-guard: both the client's live delta accumulation (streamingText)
      // and the server's final snapshot (fullResponse) can each be truncated in
      // edge cases. Prefer whichever is longer to avoid the "cut-off text" bug.
      // This is the client-side counterpart to the server's parsed.result guard.
      var _clientStream = window.streamingText || '';
      var _serverFull = msg.fullResponse || '';
      // [2026-10-09] Stessa regola «per il proprietario» anche qui (idempotente): se un
      // server non ancora aggiornato manda un messaggio per il proprietario nei passaggi,
      // torna nella risposta.
      if (msg.finalOnly && Array.isArray(msg.steps) && msg.steps.length && window.PerNico) {
        var _pnLive = window.PerNico.ripiega(_serverFull, msg.steps);
        _serverFull = _pnLive.content; msg.steps = _pnLive.steps;
      }
      var finalText;
      // [2026-10-01] Il server ha già separato la risposta dai passaggi:
      // qui NON vince il testo più lungo (quello è il muro intero).
      if (msg.finalOnly && _serverFull && String(_serverFull).trim()) {
        finalText = _serverFull;
      } else if (_clientStream && _serverFull) {
        finalText = _clientStream.length >= _serverFull.length ? _clientStream : _serverFull;
      } else {
        finalText = _clientStream || _serverFull || '';
      }
      // Empty `done` guard — if there is literally no content to render, DON'T
      // leave a blank assistant bubble in the DOM (it manifests as the "empty
      // response box" the owner complains about). Drop the streaming placeholder
      // entirely and do not push an empty entry into local history.
      var _hasFinalContent = !!(finalText && String(finalText).trim());
      // Belt-and-suspenders dedupe: the daemon can replay a finalized turn via
      // delta/done even when the session history already contains that final
      // message. Server Guardian gates this server-side too, but if a duplicate
      // slips through we must NOT finalize a second bubble on the DOM. Bug 3.
      // The bubble already on screen may have been finalized from the CLIENT
      // stream while this `done` carries the SERVER snapshot (or vice versa).
      // When those two texts differ even slightly, their content-hash keys
      // differ and a single-key check misses → a second identical box. So we
      // test every candidate text (final / server / client) against the DOM and
      // treat a hit on ANY of them as "already rendered". Bug 3 (box dup).
      var _dupEl = null;
      if (_hasFinalContent && typeof window.computeMsgKey === 'function' && window.messagesEl) {
        var _dupCandidates = [finalText, _serverFull, _clientStream];
        var _seenDupKey = {};
        for (var _dci = 0; _dci < _dupCandidates.length && !_dupEl; _dci++) {
          var _cand = _dupCandidates[_dci];
          if (!_cand || !String(_cand).trim()) continue;
          var _ck = window.computeMsgKey({ role: 'assistant', content: _cand });
          if (!_ck || _seenDupKey[_ck]) continue;
          _seenDupKey[_ck] = true;
          _dupEl = window.messagesEl.querySelector(
            '[data-msg-key="' + _ck + '"]:not(.streaming), [data-msg-keys~="' + _ck + '"]:not(.streaming)');
        }
      }
      if (_hasFinalContent && _dupEl) {
        if (window.streamingEl && window.streamingEl.isConnected) {
          try { window.streamingEl.remove(); } catch(e) {}
        }
        window.streamingEl = null;
        window.streamingText = '';
        window.thinkingText = '';
        window.setStreamingState(false);
        if (window.activeSessionId) window.clearLiveStreamState(window.activeSessionId);
        window.updateStatusDot('idle');
        window.hideActivity();
        return;
      }
      if (!_hasFinalContent) {
        if (window.streamingEl && window.streamingEl.isConnected) {
          try { window.streamingEl.remove(); } catch(e) {}
        }
        window.streamingEl = null;
        window.streamingText = '';
        window.thinkingText = '';
      } else {
        var _finalizedBubble = window.finalizeStreamingMessage(finalText);
        try {
          var _rdEl = (_finalizedBubble && _finalizedBubble.isConnected) ? _finalizedBubble
            : (window.messagesEl && window.messagesEl.querySelector('.message:last-of-type'));
          if (typeof window.ensureRedoRows === 'function') window.ensureRedoRows(_rdEl, msg.discarded || [], true);
          var _rdLive = window.messagesEl ? window.messagesEl.querySelectorAll('.redo-row.redo-live') : [];
          for (var _rdi = 0; _rdi < _rdLive.length; _rdi++) _rdLive[_rdi].classList.remove('redo-live');
        } catch (e) {}
        window._liveDiscards = [];
        if (msg.steps && msg.steps.length && typeof window.attachStepsToggle === 'function') {
          try {
            var _stEl = (_finalizedBubble && _finalizedBubble.isConnected) ? _finalizedBubble
              : (window.messagesEl && window.messagesEl.querySelector('.message:last-of-type'));
            window.attachStepsToggle(_stEl, msg.steps);
          } catch (e) {}
        }
        // Stamp EVERY candidate text's key onto the bubble we just finalized.
        // A replayed `done` from the Pi relay arrives after streamingText is
        // already cleared, so it can only offer the server text — if the bubble
        // was originally keyed off the (longer) client text the single key won't
        // match. Recording all keys now lets the next replay dedup against any
        // of them. Naturally scoped: the keys vanish when the bubble is removed.
        try {
          if (typeof window.computeMsgKey === 'function' && window.messagesEl) {
            var _allBubbles = window.messagesEl.querySelectorAll('.message');
            // finalizeStreamingMessage nulls window.streamingEl internally, so
            // read the element it RETURNS; fall back to last bubble only if null.
            var _finBubble = (_finalizedBubble && _finalizedBubble.isConnected)
              ? _finalizedBubble
              : (_allBubbles.length ? _allBubbles[_allBubbles.length - 1] : null);
            if (_finBubble) {
              var _finKeys = {};
              [finalText, _serverFull, _clientStream].forEach(function(_t) {
                if (_t && String(_t).trim()) {
                  var _kk = window.computeMsgKey({ role: 'assistant', content: _t });
                  if (_kk) _finKeys[_kk] = true;
                }
              });
              var _finKeyList = Object.keys(_finKeys);
              if (_finKeyList.length) _finBubble.dataset.msgKeys = _finKeyList.join(' ');
            }
          }
        } catch(e) {}
      }
      window.setStreamingState(false);
      if (window.activeSessionId) window.clearLiveStreamState(window.activeSessionId);
      window.updateStatusDot('idle');
      window.hideActivity();

      // Mark as awaiting input — highlighted in sidebar until user reads it.
      // Fix 4 (2026-07-21): ONLY when the user is NOT actively looking at this
      // session right now (tab hidden/backgrounded). Before, this added the ACTIVE
      // session unconditionally, so a reply that finished while the session was open
      // and focused got flagged "awaiting" — and because the on-open clear had
      // already run BEFORE the reply landed, the unread dot lingered forever (it
      // only surfaced once you switched away, id !== activeSessionId). If the tab is
      // hidden the user isn't really reading, so we still flag it then; the
      // visibility/focus handler below clears it the moment they come back to it.
      if (window.activeSessionId && document.hidden) {
        window.awaitingSessions.add(window.activeSessionId);
        window.persistAwaiting();
        window.renderSessionList();
      }

      // Show "Done" toast if the page isn't focused (phone was asleep, tab in background)
      if (document.hidden) {
        window.showToast('Response ready', 'success');
      }

      // Track new messages when scrolled up
      if (!window.autoScroll) {
        window.newMessageCount++;
        window.updateFabCount();
      }

      // Notify: chime + push notification
      window.playDoneChime();
      window.notifyDone(finalText, { sessionId: window.activeSessionId });
      // [11/10/2026] Risposta arrivata sotto gli occhi del proprietario (pagina visibile,
      // sessione aperta): è già letta — lo sappia anche il telefono, che
      // intanto può averne fatto una notifica.
      if (window.activeSessionId && !document.hidden && typeof window.segnaLetta === 'function') {
        window.segnaLetta(window.activeSessionId);
      }

      // Drain any queued auto-wrap now that streaming is done
      if (typeof window.drainPendingWrap === 'function') window.drainPendingWrap();

      // Auto-resume: if this was a context wrap, capture response and create new session
      // Check plugin state — only fire if the wrapping session matches this response's session
      var _awState = window.autoWrapState;
      if (_awState && _awState.awaitingAutoResume && _awState.autoWrapSessionId === window.activeSessionId && finalText) {
        if (typeof window.completeAutoResume === 'function') window.completeAutoResume(finalText);
        // Don't return — still update session state below
      }

      var s = window.sessions.find(function(s) { return s.id === window.activeSessionId; });
      if (s) {
        s.status = 'idle';
        s.lastMessage = (finalText).slice(0, 100);
        // Push to local history so historyLength is correct on next reconnect
        // (prevents server from re-sending this message as history_append)
        // Guard: don't pollute history with empty assistant entries — they
        // hydrate as blank bubbles on next session-switch.
        if (_hasFinalContent) {
          if (!s.history) s.history = [];
          var _lhEntry = { role: 'assistant', content: finalText };
          if (msg.discarded && msg.discarded.length) _lhEntry.discarded = msg.discarded;
          s.history.push(_lhEntry);
        }
        s.lastActivity = new Date().toISOString();

        // Auto-title is now server-side (AI-generated via session_renamed event)
      }
      window.renderSessionList();
      // Process queued messages — send next one after a short delay
      if (window.messageQueue.length > 0) {
        setTimeout(window.processQueue, 500);
      }
      return;
    }

    if (msg.type === 'permission_request') {
      if (typeof window.renderPermissionCard === 'function') {
        window.renderPermissionCard(msg);
      }
      // If the request targets a session the user isn't currently viewing,
      // flag that session as awaiting so the sidebar badge shows.
      var permTarget = msg.sessionId;
      if (permTarget && permTarget !== window.activeSessionId) {
        window.awaitingSessions.add(permTarget);
        if (typeof window.persistAwaiting === 'function') window.persistAwaiting();
        window.renderSessionList();
        var ps = window.sessions.find(function(s) { return s.id === permTarget; });
        window.showToast((ps ? ps.title : 'Session') + ' needs permission', 'info');
        if (typeof window.notifyDone === 'function' && document.hidden) {
          window.notifyDone((ps ? ps.title : 'Session') + ' is requesting permission', { force: true, title: 'The 151 Machine', sessionId: permTarget });
        }
      }
      return;
    }

    if (msg.type === 'permission_ack') {
      if (typeof window.resolvePermissionAck === 'function') {
        window.resolvePermissionAck(msg.id, msg.ok !== false);
      }
      return;
    }

    if (msg.type === 'error') {
      var friendlyError = window.humanizeError(msg.message);
      // [12/11/2026 ] Rifiutato dal limite di messaggi: resta nell'outbox (il
      // server non ha registrato il nonce) e si rimanda da solo fra un minuto.
      if (msg.nonce && /rate limit/i.test(msg.message || '') && !window._rateRetryTimer) {
        window._rateRetryTimer = setTimeout(function() {
          window._rateRetryTimer = null;
          if (window.activeSessionId) window.redeliverPending(window.activeSessionId);
        }, 61000);
      }
      // Un rinvio rifiutato dal limite non è un errore del turno che sta scorrendo.
      if (msg.nonce && /rate limit/i.test(msg.message || '') && window.streamingText) {
        window.showToast(friendlyError, 'error');
        return;
      }
      // If we have streamed text, this is a mid-stream error — finalize what we have
      if (window.streamingText) {
        window.finalizeStreamingMessage(window.streamingText + '\n\n*' + friendlyError + '*');
      } else {
        window.appendMessage('assistant', friendlyError);
      }
      window.showToast(friendlyError, 'error');
      window.setStreamingState(false);
      if (window.activeSessionId) window.clearLiveStreamState(window.activeSessionId);
      window.updateStatusDot('idle');
      window.hideActivity();
      return;
    }

    if (msg.type === 'session_cleared') {
      var sid = msg.sessionId;
      var s = window.sessions && window.sessions.find(function(x) { return x.id === sid; });
      if (s) { s.history = []; s.lastMessage = ''; }
      if (window.activeSessionId === sid) {
        var msgs = document.getElementById('messages');
        if (msgs) msgs.innerHTML = '';
      }
      if (typeof window.renderSessionList === 'function') window.renderSessionList();
      return;
    }

    // A session was created on ANOTHER device — add it here live so the list
    // stays in sync across PC + phone without a manual reload. Idempotent: if we
    // already have it (this device did the create, added it optimistically), we
    // skip. Newest-first unshift matches the server sort + createSession().
    if (msg.type === 'session_created') {
      var ns = msg.session;
      if (!ns || !ns.id) return;
      if (!window.sessions) window.sessions = [];
      if (window.sessions.some(function(x) { return x.id === ns.id; })) return;
      if (ns.hidden || ns.ephemeral) return; // never surface relay children
      window.sessions.unshift(ns);
      if (typeof window.cacheSessionList === 'function') window.cacheSessionList(window.sessions);
      if (typeof window.renderSessionList === 'function') window.renderSessionList();
      return;
    }

    // A session was deleted on ANOTHER device — remove it here live so the list
    // stays in sync across PC + phone without a manual reload. Idempotent: if we
    // already removed it optimistically (this device did the delete), the filter
    // is a no-op.
    if (msg.type === 'session_deleted') {
      // [11/10/2026] Sessione cancellata: la sua notifica non ha più nessuno da aspettare.
      if (msg.sessionId && typeof window.clearSessionNotification === 'function') {
        try { window.clearSessionNotification(msg.sessionId); } catch (e) {}
      }
      var did = msg.sessionId;
      if (!window.sessions) return;
      if (!window.sessions.some(function(x) { return x.id === did; })) return;
      window.sessions = window.sessions.filter(function(x) { return x.id !== did; });
      if (typeof window.clearCachedHistory === 'function') window.clearCachedHistory(did);
      if (window.activeSessionId === did) {
        if (typeof wsReconnectTimer !== 'undefined' && wsReconnectTimer) { clearTimeout(wsReconnectTimer); wsReconnectTimer = null; }
        window.activeSessionId = null;
        if (typeof window.showEmptyState === 'function') window.showEmptyState();
        if (typeof window.showToast === 'function') window.showToast('This chat was deleted on another device', 'info');
      }
      if (typeof window.renderSessionList === 'function') window.renderSessionList();
      return;
    }
  };

  sock.onclose = function(evt) {
    // [2026-09-22] LA CHIUSURA DEL SOCKET VECCHIO SPEGNEVA IL BATTITO DEL NUOVO.
    //
    // Questo gestore non guardava QUALE socket si stesse chiudendo: azzerava
    // `wsConnected`, spegneva `wsPingTimer` e accendeva il pallino «offline»
    // per qualunque chiusura, prima ancora di chiedersi se quel socket fosse
    // ancora il nostro.
    //
    // La strada che ci passa dentro ogni giorno e' proprio quella del telefono:
    // il guardiano dello zombie (piu' su, «No server message in 45s») chiama
    // connectWebSocket APPOSTA quando il socket e' mezzo morto. Un socket mezzo
    // morto e' quello che ci mette di piu' a chiudersi davvero — la stretta di
    // mano aspetta il timeout TCP — mentre il socket NUOVO, su una connessione
    // fresca, si apre in poche centinaia di millisecondi. Quando il vecchio
    // onclose arrivava finalmente, trovava una connessione VIVA e le spegneva
    // sotto il battito, la marcava offline e programmava una riconnessione che
    // avrebbe chiuso il socket sano per aprirne un terzo. E peggio: la bandiera
    // `intentionalClose` era gia' stata rimessa a false dall'onopen del socket
    // nuovo, quindi la guardia qui sotto non proteggeva piu' niente.
    // Cadere e «riprendere da sola dopo un po'» e' esattamente il risultato.
    //
    // Due domande, nell'ordine giusto, PRIMA di smontare qualunque cosa:

    // 1. Questa chiusura l'abbiamo voluta noi? Il cartellino e' sul socket, non
    //    sulla finestra: non puo' riferirsi a un socket diverso da questo.
    if (sock._intentional) return;

    // 2. Questo socket e' ancora quello attuale? Se nel frattempo ne e' nato un
    //    altro, questa e' l'eco di un morto: non tocca niente e non parla.
    //    (window.ws nullo = non c'e' un successore, la chiusura e' nostra.)
    if (window.ws && window.ws !== sock) return;

    window.wsConnected = false;
    if (wsPingTimer) { clearInterval(wsPingTimer); wsPingTimer = null; }
    if (!window.streaming) window.updateStatusDot('offline');

    // Auth failure (4001) — don't reconnect, show login
    if (evt.code === 4001) {
      window.authToken = null;
      localStorage.removeItem('151-terminal-token');
      if (window.svuotaCopieLocali) window.svuotaCopieLocali(); // 401: le chat copiate se ne vanno col gettone
      if (window.mostraAccesso) window.mostraAccesso(); // 12/11: gettone nuovo senza parola
      else document.getElementById('login-overlay').classList.remove('hidden');
      return;
    }

    // [2026-10-12] Il codice 4003 («solo Pi», chiuso dal Pi senza PC) non
    // esiste più: la Machine non vive più sul Pi.

    // Planned restart (4100) — enter dedicated restart flow
    if (evt.code === 4100) {
      enterRestartMode();
      return;
    }

    // [2026-10-07] OFFLINE (il PC non c'è): niente cartello «connection lost»
    // e niente tentativi a vuoto. modalita.js riapre tutto quando il PC torna.
    if (typeof window.modalitaAttuale === 'function' && window.modalitaAttuale() === 'offline') return;

    // Any other disconnect — try silent reconnect first.
    // Only show "connection lost" banner if user is actively looking at the screen.
    // When phone goes to background, WS dies naturally — no need to alarm the user.
    if (!bannerTimeout && !document.hidden) {
      bannerTimeout = setTimeout(function() {
        if (!window.wsConnected && !document.hidden) window.connectionBanner.classList.add('show');
      }, 3000);
    }

    wsReconnectTimer = setTimeout(function() {
      if (!window.activeSessionId || !window.authToken) return;
      // If the server_restarting WS message already triggered restart mode, don't double up.
      if (inRestartMode) return;
      // TETTO DOPPIO (2026-09-15). La cadenza svelta (5s) resta quella giusta
      // quando un server risponde: radio/Tailscale di un telefono che si sveglia
      // ci mettono qualche secondo, e non vogliamo strisciare fino a 30s dove
      // l'app "sembra bloccata". Ma 5s in tasca SENZA rete è un pugno ogni 5s,
      // 720 all'ora, ognuno con una prova HTTP per candidato + apertura WS:
      // la stessa radio che il lavoro batteria del 16/08 aveva smesso di
      // svegliare per i ping, risvegliata dalla porta di servizio.
      // Il discriminante NON è l'orologio: è se la prova ha TROVATO qualcuno.
      // Perciò l'attesa si calcola DOPO la prova, non prima (sotto).
      // Il tetto buio (60s) non ritarda il ritorno: online/visibilitychange/
      // pageshow/focus/resume Capacitor (ws.js:1726-1757 pre-edit) passano tutti
      // da _reconnectNow(), che riporta l'attesa a 500ms e riconnette subito.

      // PRINCIPLE: a network blip is NOT a server restart. We always re-resolve
      // the best reachable server (so a stale serverUrl — e.g. a LAN<->Tailscale
      // flip — never traps us retrying a dead URL) and then just reconnect. We
      // do NOT escalate to the full-screen "Server Restarting" flow here: that
      // dead-ends on a manual Retry button when the real problem was only a slow
      // network wake (the close+reopen friction). Genuine planned restarts still
      // get the restart UI via the explicit signals (close code 4100 and the
      // `server_restarting` WS message — both handled above); a new code hash
      // after a missed deploy is handled by the `sync` handler's reload.
      function _reconnectAfterProbe(found) {
        // L'attesa successiva la decide l'esito della prova, non l'orologio.
        window.reconnectDelay = window.wsNextReconnectDelay(window.reconnectDelay, found);
        if (!inRestartMode) window.connectWebSocket(window.activeSessionId);
      }
      window.findBestServer()
        .then(_reconnectAfterProbe)
        .catch(function() { _reconnectAfterProbe(false); });
    }, window.reconnectDelay);
  };

  window.ws.onerror = function() {
    // Errors trigger onclose, no need to handle separately
  };
};

// B3 (2026-08-11): lightweight session switch — the ROOT fix for "devo
// ri-cliccare". The socket is ONE shared connection; the server changes which
// session it's bound to on `join`. connectWebSocket used to close+reopen the
// socket on EVERY switch, which flashed "Back online" and left a stale gap
// until a re-click. Here, if the socket is already OPEN on the SAME token, we
// reuse it and just re-send join + get_stream_state — the EXACT frames onopen
// sends — with no teardown, no reconnect, no protocol change.
//
// Fallback: if the socket is absent or not OPEN (CONNECTING/CLOSING/CLOSED, or
// a zombie-OPEN whose send throws), we fall through to the ORIGINAL full
// connectWebSocket path, so the body is never left empty.
//
// KILL SWITCH: set `window.B3_LIGHT_SWITCH = false` to revert to the old
// always-reconnect behavior in one line.
window.switchSocketSession = function switchSocketSession(sessionId) {
  if (window.B3_LIGHT_SWITCH !== false
      && window.ws && window.ws.readyState === 1 /* OPEN */
      && window.ws._token === window.authToken) {
    try {
      // Punto 4a: force a FULL authoritative history on every OPEN. historyLength:0
      // makes the server send the complete `history` list (never a partial delta
      // that can silently no-op against a frozen/miscounted local length), so a
      // message sent from another device always lands on open. The `history`
      // handler's hash short-circuit skips the repaint when nothing actually
      // changed, so the common same-device open stays flicker-free.
      // (Only this switch/open path is forced full — onopen/reconnect keeps its
      // delta, and loadSessions already refreshes history on that path.)
      window.ws.send(JSON.stringify({ type: 'join', sessionId: sessionId, historyLength: 0 }));
      // ROUND-3 (dup fix): DON'T pair the full-history join with a get_stream_state
      // replay when the session is FINISHED. With DETACHED_RUNS on, get_stream_state
      // returns a `replay` of the last turn's delta+done events (server/ws-handler.js
      // get_stream_state). For an idle session the join(0) history above is already
      // complete + authoritative, so the replay is a SECOND paint of the same
      // finished assistant turn — reconciled only by a content-hash key that misses
      // when the replayed text ≠ the stored text, leaving the reply rendered TWICE.
      // We only need get_stream_state when a stream is actually in progress (busy),
      // where the history does NOT yet contain the in-flight assistant so there is
      // no turn to duplicate. A session that is busy on the server but shows idle
      // locally self-heals on the next focus/visibility get_stream_state (wsOnResume).
      var _cs = window.sessions.find(function(s) { return s.id === sessionId; });
      if (!_cs || _cs.status === 'busy') {
        window.ws.send(JSON.stringify({ type: 'get_stream_state', sessionId: sessionId, lastSeq: window._lastSeqFor(sessionId), epoch: (window._seqEpoch && window._seqEpoch[sessionId] != null ? window._seqEpoch[sessionId] : null) }));
      }
      // [SYNC-PROBE 2026-08-15] Marker only (no behavior change): we SKIPPED
      // get_stream_state because the local card says idle. If the `sync` reply
      // to this join comes back `busy`, the card was stale and we're mid-stream
      // with no snapshot — the sync handler emits OPEN-IDLE-BUT-BUSY from this.
      if (_cs && _cs.status !== 'busy') {
        window._openAssumedIdle = { sid: sessionId, at: Date.now() };
      }
      window._wsLastRecv = Date.now(); // we just proved the pipe accepts writes
      return;
    } catch (e) {
      // Zombie-OPEN socket: readyState lied, send threw. Fall through to the
      // full reconnect below rather than leaving the switch half-applied.
    }
  }
  // Fallback = today's exact behavior. Also covers the ping/zombie watchdogs,
  // which keep running untouched and still force a reconnect on a dead link.
  window.connectWebSocket(sessionId);
};

// --- Reconnect when user returns to app ---
// Single reconnect entry used by every resume/online trigger. Re-resolves the
// best reachable server FIRST (the phone's radio/Tailscale may have changed or
// only just woken), then opens a fresh socket. findBestServer never rejects
// (it swallows its own errors and keeps the old URL), so the connect always runs.
function _reconnectNow() {
  _returningFromBackground = true;
  if (wsReconnectTimer) { clearTimeout(wsReconnectTimer); wsReconnectTimer = null; }
  if (bannerTimeout) { clearTimeout(bannerTimeout); bannerTimeout = null; }
  window.connectionBanner.classList.remove('show');
  window.reconnectDelay = 500;
  window.findBestServer()
    .then(function() { if (!inRestartMode) window.connectWebSocket(window.activeSessionId); })
    .catch(function() { if (!inRestartMode) window.connectWebSocket(window.activeSessionId); });
}

function wsOnResume() {
  if (!window.activeSessionId || !window.authToken) return;
  if (inRestartMode) return;
  if (!window.ws || (window.ws.readyState !== WebSocket.OPEN && window.ws.readyState !== WebSocket.CONNECTING)) {
    _reconnectNow();
  } else if (window.ws.readyState === WebSocket.OPEN) {
    // readyState OPEN cannot be trusted after a background suspension:
    // Android often tears down the TCP socket while JS is frozen, leaving a
    // "zombie" — readyState still says OPEN, sends succeed silently into a
    // dead pipe, and nothing ever reconnects. This was why the app showed
    // disconnected on resume and only a full close+reopen fixed it.
    var _staleMs = window._wsLastRecv ? (Date.now() - window._wsLastRecv) : Infinity;
    if (_staleMs > 25000) {
      // Long since we last heard from the server — typical after the app was
      // backgrounded for minutes. Don't bother probing, just reconnect now.
      _reconnectNow();
      return;
    }
    // Recently active — socket is probably fine. Resync stream state and
    // actively probe with a ping; if no frame lands within 4s the socket is
    // a zombie, so reconnect then.
    var _probeAt = Date.now();
    try {
      window.ws.send(JSON.stringify({ type: 'get_stream_state', sessionId: window.activeSessionId, lastSeq: window._lastSeqFor(window.activeSessionId) }));
      window.ws.send(JSON.stringify({ type: 'ping' }));
    } catch(e) {
      _reconnectNow();
      return;
    }
    setTimeout(function() {
      if (window.ws && window.ws.readyState === WebSocket.OPEN
          && (!window._wsLastRecv || window._wsLastRecv < _probeAt)) {
        console.log('[WS] Resume probe unanswered — zombie socket, reconnecting');
        _reconnectNow();
      }
    }, 4000);
  }
}

// Fix 4 (2026-07-21): when the user returns to the tab, the session they're
// actively viewing is BY DEFINITION read — clear its unread/awaiting flag so the
// dot can never linger on a session that's open in front of them (covers the case
// where a reply finished while the tab was hidden and got flagged awaiting).
function clearActiveAwaitingOnReturn() {
  if (window.activeSessionId && window.awaitingSessions && window.awaitingSessions.has(window.activeSessionId)) {
    window.awaitingSessions.delete(window.activeSessionId);
    if (typeof window.persistAwaiting === 'function') window.persistAwaiting();
    if (typeof window.renderSessionList === 'function') window.renderSessionList();
  }
  // [READ-SYNC 2026-08-15 → 11/10/2026] Propagate the "read" to the other
  // device SEMPRE (server rebroadcasts session_read to every client): la
  // notifica del telefono esiste anche quando qui il pallino non era acceso.
  // Best-effort: on foreground return the socket may still be reconnecting.
  if (window.activeSessionId && document.visibilityState === 'visible' && typeof window.segnaLetta === 'function') {
    window.segnaLetta(window.activeSessionId);
  }
}

// BATTERY v9 (2026-08-16) — tell the server whether our screen is on. A server
// that knows we are asleep stops pinging us, which is what stops the phone
// radio waking every 20s all night. The v8 round silenced only OUR ping; the
// server's kept coming, and the WebView answers those pongs at protocol level
// (no JS involved), so freezing the timers never stopped them.
//
// `native: true` is the server's gate: only the app suppresses the heartbeat.
// A PC browser tab going hidden must NOT, so this is a no-op off-device.
function wsSendVisibility(hidden) {
  try {
    if (!window.isNativeApp) return;
    if (!window.ws || window.ws.readyState !== 1) return;
    window.ws.send(JSON.stringify({ type: 'visibility', hidden: !!hidden, native: true }));
  } catch (e) {}
}
window.wsSendVisibility = wsSendVisibility;

document.addEventListener('visibilitychange', function() {
  // Send FIRST: on the way down this is the last thing we get to do before
  // MainActivity.onPause freezes the timers.
  wsSendVisibility(document.hidden);
  if (document.visibilityState === 'visible') { clearActiveAwaitingOnReturn(); wsOnResume(); }
});
window.addEventListener('pageshow', function() { clearActiveAwaitingOnReturn(); wsOnResume(); });
window.addEventListener('focus', function() { clearActiveAwaitingOnReturn(); wsOnResume(); });
// Exposed so the header reload button can do a lightweight reconnect
// (same safe path as returning from background) instead of a hard reload.
window.wsOnResume = wsOnResume;

if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App) {
  try {
    window.Capacitor.Plugins.App.addListener('appStateChange', function(state) {
      if (state && state.isActive) wsOnResume();
    });
    window.Capacitor.Plugins.App.addListener('resume', wsOnResume);
  } catch(e) {}
}

// Reconnect the instant the OS reports connectivity is back. On a phone the
// radio/Tailscale usually wakes a beat AFTER the app resumes, so a resume-time
// reconnect can land before the network is ready; this catches the real moment
// the link returns instead of waiting on a backoff timer. wsOnResume is a no-op
// when the socket is already healthy, so firing it on every event is safe.
window.addEventListener('online', wsOnResume);

if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Network) {
  try {
    window.Capacitor.Plugins.Network.addListener('networkStatusChange', function(status) {
      if (status && status.connected) wsOnResume();
    });
  } catch(e) {}
}

// --- Animated Reload ---
// Unified TV-off → reload → TV-on path for both hot reload and full restart.
window.triggerAnimatedReload = function triggerAnimatedReload(mode) {
  // Save state
  try {
    var rs = {
      sessionId: window.activeSessionId,
      draftText: window.messageInput ? window.messageInput.value : '',
      scrollTop: window.messagesEl ? window.messagesEl.scrollTop : 0,
    };
    sessionStorage.setItem('151-restart-state', JSON.stringify(rs));
    sessionStorage.setItem('151-restart-pending', mode || 'hot');
    sessionStorage.setItem('151-restart-animated-at', String(Date.now()));
    if (rs.sessionId && rs.draftText) window.saveDraft(rs.sessionId, rs.draftText);
  } catch(e) {}

  // TV-off animation then reload
  var overlay = document.getElementById('restart-overlay');
  var mainApp = document.getElementById('app');
  overlay.classList.remove('tv-off', 'restarting', 'tv-on');
  overlay.classList.add('show');
  mainApp.style.animation = 'tvOff 0.6s cubic-bezier(0.55, 0, 1, 0.45) forwards';

  setTimeout(function() {
    location.reload();
  }, 650);
};

// --- Dedicated Restart Flow ---
// Separate from generic reconnect. Triggered by code 4100 or server_restarting message.

function enterRestartMode() {
  if (inRestartMode) return;
  inRestartMode = true;
  try { sessionStorage.setItem('151-restart-animated-at', String(Date.now())); } catch(e) {}

  // Freeze current UI state
  frozenState = {
    sessionId: window.activeSessionId,
    scrollTop: window.messagesEl.scrollTop,
    draftText: window.messageInput.value,
    wasStreaming: window.streaming,
    view: window.emptyState.style.display === 'flex' ? 'empty' : 'session',
  };

  // Cancel generic reconnect
  if (wsReconnectTimer) { clearTimeout(wsReconnectTimer); wsReconnectTimer = null; }
  if (bannerTimeout) { clearTimeout(bannerTimeout); bannerTimeout = null; }
  window.connectionBanner.classList.remove('show');

  // Phase 1: TV-off animation on the whole screen
  var overlay = document.getElementById('restart-overlay');
  var text = document.getElementById('restart-text');
  var sub = document.getElementById('restart-sub');
  var retryBtn = document.getElementById('restart-retry');
  text.textContent = 'Server Restarting';
  sub.textContent = 'Your session will resume automatically';
  retryBtn.classList.remove('show');

  // Show overlay behind the app first, then trigger TV-off on app
  overlay.classList.remove('tv-off', 'restarting', 'tv-on');
  overlay.classList.add('show');

  // Animate the main app content with TV-off
  var mainApp = document.getElementById('app');
  mainApp.style.animation = 'tvOff 0.6s cubic-bezier(0.55, 0, 1, 0.45) forwards';

  // After TV-off completes, show the restart screen
  setTimeout(function() {
    mainApp.classList.add('restart-hidden');
    mainApp.style.animation = '';
    overlay.classList.add('restarting');
    startRestartPolling();
  }, 650);

  // 30s timeout — show retry button
  restartTimeoutTimer = setTimeout(function() {
    text.textContent = 'Taking longer than expected...';
    sub.textContent = '';
    retryBtn.classList.add('show');
  }, 30000);
}

function startRestartPolling() {
  if (restartPollTimer) clearTimeout(restartPollTimer);
  var pollStart = Date.now();

  function poll() {
    // Re-resolve the best reachable server each poll so the restart flow can
    // recover even if the network path changed while the phone was away
    // (otherwise it would hammer a now-dead URL and never exit restart mode).
    window.findBestServer().catch(function() {}).then(function() {
      return fetch(window.getServerUrl() + '/api/health', { cache: 'no-store' });
    })
      .then(function(res) { return res.json(); })
      .then(function(data) {
        if (data.ok) {
          restartReconnectDelay = 1000;
          restartPollTimer = null;
          if (data.boot && knownServerBoot && data.boot !== knownServerBoot) {
            knownServerBoot = data.boot;
            try {
              var rs = {
                sessionId: frozenState ? frozenState.sessionId : window.activeSessionId,
                draftText: frozenState ? frozenState.draftText : window.messageInput.value,
                scrollTop: frozenState ? frozenState.scrollTop : window.messagesEl.scrollTop,
              };
              sessionStorage.setItem('151-restart-state', JSON.stringify(rs));
              sessionStorage.setItem('151-restart-pending', 'full');
              sessionStorage.setItem('151-restart-animated-at', String(Date.now()));
              if (rs.sessionId && rs.draftText) window.saveDraft(rs.sessionId, rs.draftText);
            } catch(e) {}
            location.reload();
            return;
          }
          if (data.boot) knownServerBoot = data.boot;
          exitRestartMode();
          return;
        }
        throw new Error('server not ready');
      })
      .catch(function() {
        if (Date.now() - pollStart > 5000) {
          document.getElementById('restart-text').textContent = 'Reconnecting...';
        }
        restartReconnectDelay = Math.min(restartReconnectDelay * 2, window.reconnectMaxDelay || 30000);
        restartPollTimer = setTimeout(poll, restartReconnectDelay);
      });
  }

  restartReconnectDelay = 1000;
  restartPollTimer = setTimeout(poll, restartReconnectDelay);
}

function exitRestartMode() {
  if (!inRestartMode) return;

  if (restartTimeoutTimer) { clearTimeout(restartTimeoutTimer); restartTimeoutTimer = null; }
  if (restartPollTimer) { clearTimeout(restartPollTimer); restartPollTimer = null; }

  // Refresh session list from new server, then reconnect WebSocket
  if (frozenState && frozenState.sessionId && window.authToken) {
    window.loadSessions().then(function() { window.renderSessionList(); }).catch(function() {});
    window.connectWebSocket(frozenState.sessionId);
  }

  // Phase 2: Fade back in
  var overlay = document.getElementById('restart-overlay');
  var mainApp = document.getElementById('app');

  // Restore app display first (behind overlay)
  mainApp.classList.remove('restart-hidden');
  mainApp.style.opacity = '0';

  // Restore view state BEFORE animation so input area is ready
  if (frozenState && frozenState.view === 'session') {
    window.setViewState('session');
  }

  // Fade overlay out, fade app in
  try { sessionStorage.setItem('151-restart-landed-at', String(Date.now())); } catch(e) {}
  requestAnimationFrame(function() {
    overlay.classList.add('tv-on');
    mainApp.style.transition = 'opacity 0.6s ease';
    mainApp.style.opacity = '1';
  });

  // Clean up after animation
  setTimeout(function() {
    overlay.classList.remove('show', 'restarting', 'tv-off', 'tv-on');
    mainApp.style.transition = '';
    mainApp.style.opacity = '';

    if (frozenState) {
      window.messageInput.value = frozenState.draftText || '';
      var savedScroll = frozenState.scrollTop;
      frozenState = null;
      // Double rAF + 50ms delay so scroll lands AFTER the deploy card appends
      // (deploy_marker handler also uses double rAF; we need to settle after it).
      requestAnimationFrame(function() {
        requestAnimationFrame(function() {
          setTimeout(function() {
            if (window.messagesEl) window.messagesEl.scrollTop = savedScroll;
          }, 50);
        });
      });
    }

    inRestartMode = false;

    // Novità dopo la consegna (window.showWhatsNew, sotto).
    window.showWhatsNew();

    // Force input visible after restart
    window.ensureInputVisible();
  }, 650);
}

// --- Novità dopo una consegna ---
// Poche righe semplici, solo ciò che il proprietario vede cambiare: il server manda le
// righe «Novità: …» dei commit (server/novita.js). Ogni apparecchio ricorda
// l'ultima versione vista; la prima volta impara e non mostra niente.
// Si chiude col tasto, toccando ovunque, o da sola dopo 10 secondi.
var _novitaInCorso = false;
var NOVITA_VISTO = '151-novita-visto';
window.showWhatsNew = function showWhatsNew() {
  if (_novitaInCorso) return;
  _novitaInCorso = true;
  var visto = '';
  try { visto = localStorage.getItem(NOVITA_VISTO) || ''; } catch (e) {}
  fetch(window.getServerUrl() + '/api/changelog?since=' + encodeURIComponent(visto), { cache: 'no-store' })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      _novitaInCorso = false;
      if (!data || !data.head) return;
      try { localStorage.setItem(NOVITA_VISTO, data.head); } catch (e) {}
      var righe = data.changes || [];
      if (!righe.length) return;
      var popup = document.getElementById('restart-changelog');
      var list = document.getElementById('changelog-items');
      if (!popup || !list) return;
      list.innerHTML = '';
      righe.forEach(function(testo) {
        var li = document.createElement('li');
        li.textContent = testo;
        list.appendChild(li);
      });
      if (data.more > 0) {
        var piu = document.createElement('li');
        piu.className = 'changelog-more';
        piu.textContent = '+ ' + data.more + ' more';
        list.appendChild(piu);
      }
      var timer = null;
      function chiudi() {
        popup.classList.remove('show');
        popup.onclick = null;
        if (timer) { clearTimeout(timer); timer = null; }
      }
      popup.onclick = chiudi; // tasto, scheda o sfondo: ogni tocco chiude
      popup.classList.add('show');
      timer = setTimeout(chiudi, 10000);
    })
    .catch(function() { _novitaInCorso = false; });
};

document.getElementById('restart-retry').onclick = function() {
  document.getElementById('restart-text').textContent = 'Reconnecting...';
  this.classList.remove('show');
  if (restartTimeoutTimer) { clearTimeout(restartTimeoutTimer); restartTimeoutTimer = null; }
  startRestartPolling();
  restartTimeoutTimer = setTimeout(function() {
    document.getElementById('restart-text').textContent = 'Taking longer than expected...';
    document.getElementById('restart-retry').classList.add('show');
  }, 30000);
};

// --- Wake Lock — keep screen alive during active streaming ---
var _wakeLock = null;
window.requestWakeLock = async function requestWakeLock() {
  if (!('wakeLock' in navigator)) return;
  try {
    _wakeLock = await navigator.wakeLock.request('screen');
    _wakeLock.addEventListener('release', function() { _wakeLock = null; });
  } catch(e) {}
};
window.releaseWakeLock = function releaseWakeLock() {
  if (_wakeLock) { _wakeLock.release(); _wakeLock = null; }
};

// --- Done Notification: chime + push ---
// Actual implementations live in chime-notifications plugin.
// These are thin dispatchers so bare-name calls work inside the IIFE.
// Plugin overrides window.* versions when it loads.
window.playDoneChime = window.playDoneChime || function() {};
window.notifyDone = window.notifyDone || function() {};
window.requestNotificationPermission = window.requestNotificationPermission || function() {};
