/* The 151 Machine — Sessions: CRUD, list, switching, launcher */

// --- Session Management ---

// ─── Boot triple-fetch GIRO PRESTAZIONI ──────────────────
// MEASURED: /api/sessions was requested THREE times on a single cold boot, at
// 313 KB each — 941 KB, the second-heaviest thing the app does, and two thirds
// of it pure waste. The three callers are:
//   1. init.js  — a boot probe that fetches the list only to see whether the
//      token is accepted, then THROWS THE BODY AWAY;
//   2. init.js:53 → loadSessions(), the real one;
//   3. ws.js:138 → loadSessions() again the moment the socket opens, which at
//      boot is while (2) is still in flight.
// Two different causes, so two different cures — neither of which may suppress
// a genuine later refresh (a delete or a rename must still repaint the list).
//
// Cure for (3): collapse CONCURRENT calls onto one request. If a load is
// already in flight, hand back the same promise instead of opening a second
// one. This is time-independent, so a refresh requested a second later still
// really refetches — only the duplicate-while-busy disappears.
// Cure for (1): a one-shot handoff — init.js parses the probe's body and parks
// it in window.__bootSessions; the first loadSessions() consumes it instead of
// re-asking. One-shot and age-capped, so it can never serve a stale list.
var _sessionsInFlight = null;
var BOOT_HANDOFF_MAX_AGE_MS = 10000;

window.loadSessions = function loadSessions() {
  if (_sessionsInFlight) return _sessionsInFlight;
  _sessionsInFlight = _loadSessions().finally(function () { _sessionsInFlight = null; });
  return _sessionsInFlight;
};

// [2026-10-07] MAI UNA SCHERMATA VUOTA. Prova del proprietario (Mullvad acceso sul
// PC): il Pi non sapeva ancora che il PC era sparito e passava al PC la
// richiesta delle sessioni, che restava appesa — l'app restava vuota finché
// non si ricaricava (riprodotto: 70 s e oltre). Ora, se il server non risponde
// entro COPIA_DOPO_MS, si mostra SUBITO la copia del telefono (elenco + storie
// dall'archivio) e si continua ad aspettare: quando il server arriva, i dati
// veri prendono il posto della copia da soli.
var COPIA_DOPO_MS = 2500;

async function _copiaDelTelefono() {
  var lista = window.getCachedSessionList();
  // Con la storia di OGNI sessione dall'archivio del telefono: a PC (o Pi)
  // spento si leggono tutte, non solo quelle già aperte qui.
  try {
    var _arch = await window.leggiArchivio();
    lista.forEach(function(s) {
      if ((!s.history || !s.history.length) && Array.isArray(_arch[s.id])) s.history = _arch[s.id];
    });
  } catch (_) {}
  return lista;
}

async function _dalServer() {
  var lista;
  // Consume the boot probe's already-downloaded body, if it is fresh.
  var handoff = window.__bootSessions;
  window.__bootSessions = null;
  if (handoff && Array.isArray(handoff.data) && (Date.now() - handoff.at) < BOOT_HANDOFF_MAX_AGE_MS) {
    lista = handoff.data;
  } else {
    lista = await window.api('GET', '/sessions');
  }
  if (!Array.isArray(lista)) throw new Error('invalid session list');
  // Restore context % from server-persisted contextTokens
  for (var i = 0; i < lista.length; i++) {
    if (lista[i].contextTokens) {
      // Fallback before model_info arrives: non-1M Opus pin = 200K window
      var lim = lista[i]._contextLimit || 200000;
      lista[i]._contextTokens = lista[i].contextTokens;
      lista[i]._contextPct = Math.min(Math.round((lista[i].contextTokens / lim) * 100), 100);
    }
  }
  window.cacheSessionList(lista);
  // L'archivio di tutte le storie, per leggerle a PC spento (core.js).
  try { window.archiviaSessioni(lista); } catch (_) {}
  // Notifiche del telefono contro la verità del server (anche dopo che Samsung
  // ha ucciso l'app): restano solo quelle delle sessioni che aspettano il proprietario.
  try { if (typeof window.riconciliaNotifiche === 'function') window.riconciliaNotifiche(lista); } catch (_) {}
  return lista;
}

async function _loadSessions() {
  var server = _dalServer().then(function(l) { return { lista: l }; }, function(e) { return { errore: e }; });
  // Se all'avvio il server ha già taciuto (init.js), la copia si mostra subito.
  var aspetta = window.__serverLento ? 0 : COPIA_DOPO_MS;
  window.__serverLento = false;
  var tardi = new Promise(function(r) { setTimeout(function() { r({ tardi: true }); }, aspetta); });
  var primo = await Promise.race([server, tardi]);
  if (primo.lista) {
    window.sessions = primo.lista;
  } else {
    // Server lento o assente: la copia del telefono, subito.
    window.sessions = await _copiaDelTelefono();
    if (primo.tardi) {
      // Il server può ancora rispondere: quando arriva, i dati veri sostituiscono la copia.
      server.then(function(esito) {
        if (!esito.lista) return;
        window.sessions = esito.lista;
        window.renderSessionList();
        var attiva = window.activeSessionId && esito.lista.find(function(s) { return s.id === window.activeSessionId; });
        if (attiva && typeof window.switchSession === 'function') window.switchSession(attiva.id);
      });
    }
  }
  window.renderSessionList();
  // Raccoon card removed from the agents row (2026-08-15 — Raccoon eliminated).
  // Findings badge now seeds only inside the trash panel (see toggleTrash path).
}

window.createSession = async function createSession(title) {
  const session = await window.api('POST', '/sessions', { title: title || undefined });
  // FIX A (2026-08-11): the `session_created` WS broadcast (server fan-out incl.
  // sender) can land BEFORE this POST resolves; ws.js already inserted the row
  // (deduped). A blind unshift here would add the SAME id a second time → two
  // cards flicker until a refetch. So dedup: if the id is already present,
  // replace it in-place with the authoritative POST object; else unshift.
  var _existingIdx = window.sessions.findIndex(function(s) { return s.id === session.id; });
  if (_existingIdx !== -1) {
    window.sessions.splice(_existingIdx, 1, session);
  } else {
    window.sessions.unshift(session); // newest first — matches server sort order
  }
  window.renderSessionList();
  window.switchSession(session.id);
};

window.deleteSession = async function deleteSession(id) {
  // Capture the row BEFORE we drop it, così se la DELETE sul server fallisce
  // possiamo rimetterla esattamente dov'era.
  var _deleted = window.sessions.find(function(s) { return s.id === id; });
  if (!_deleted) return; // already gone (e.g. a live session_deleted broadcast beat us)
  var _deletedIdx = window.sessions.indexOf(_deleted);

  // OPTIMISTIC removal — drop the row + re-render FIRST so the session
  // disappears instantly, instead of lingering through the (slow on phone:
  // phone->Pi->PC) server round-trip. The DELETE fires in the background.
  window.sessions = window.sessions.filter(function(s) { return s.id !== id; });
  if (window.activeSessionId === id) {
    if (wsReconnectTimer) { clearTimeout(wsReconnectTimer); wsReconnectTimer = null; }
    window.activeSessionId = null;
    // On delete, fall back to the adjacent remaining session (the one you were
    // near). Se non ne resta NESSUNA si mostra il vuoto, e basta.
    //
    // [2026-09-10] Qui c'era il secondo anello del ciclo che il proprietario non
    // sopportava: cancellata l'ultima sessione ne nasceva subito un'altra
    // (_launchTeam('overseer')), e cancellando anche quella se ne ripresentava
    // un'altra ancora — cancellare non arrivava mai a zero. Zero è uno stato
    // legittimo: chi cancella l'ultima sessione VUOLE zero. Non lo si tappa.
    if (window.sessions.length > 0) {
      var _nextIdx = _deletedIdx < window.sessions.length ? _deletedIdx : window.sessions.length - 1;
      window.switchSession(window.sessions[_nextIdx].id);
    } else {
      window.showEmptyState();
    }
  }
  window.renderSessionList();

  // [2026-09-10] Qui c'era il popup pollice su/giù dell'Osservatorio, che
  // chiedeva un voto a ogni sessione cancellata. Tolto insieme a tutto il ramo
  // del cruscotto: nessuno guardava i voti. I 307 già dati restano nel registro
  // eventi (~/.151machine/events/), inerti — un log non si cancella (legge 1).
  window.clearCachedHistory(id);
  if (typeof window.clearSessionWrapState === 'function') window.clearSessionWrapState(id);

  try {
    await window.api('DELETE', '/sessions/' + id);
  } catch (e) {
    // Server delete failed — put the row back where it was so we never silently
    // "lose" a session that actually still exists on the server.
    if (!window.sessions.some(function(s) { return s.id === id; })) {
      var at = (_deletedIdx >= 0 && _deletedIdx <= window.sessions.length) ? _deletedIdx : window.sessions.length;
      window.sessions.splice(at, 0, _deleted);
      window.renderSessionList();
    }
    if (typeof window.showToast === 'function') window.showToast('Could not delete session', 'error');
  }
};

window.renameSession = async function renameSession(id, title) {
  await window.api('PATCH', '/sessions/' + id, { title: title });
  const s = window.sessions.find(function(s) { return s.id === id; });
  if (s) {
    // Fix B: on a FLEET session the number is a locked prefix — the edit only
    // sets the label AFTER it. Mirror the server (rename() does the same strip)
    // so the local card updates instantly WITHOUT dropping the number.
    if (s.agentType && typeof s.agentNumber === 'number') {
      var label = fleetStripPrefix(s, title);
      s.agentLabel = label || null;
      s.manuallyRenamed = true;
      s.title = (s.agentType.toUpperCase() + ' ' + s.agentNumber) + (label ? ' ' + label : '');
    } else {
      s.title = title;
    }
  }
  window.renderSessionList();
  if (window.activeSessionId === id) headerTitle.textContent = (s ? s.title : title);
};

// --- RIAVVIO UNICO DELL'ECOSISTEMA (2026-08-20) ---------------------------
// «Restart machine» in the plugin panel (17/10/2026; before: a hold on the
// reload button) ⇒ tools/deploy.sh --force on the PC: stamp, restart the PC,
// verify (the Pi leg is gone since 2026-10-12). Before this, the full restart lived only in a terminal and
// was unreachable from inside the app (and from the phone entirely).
// Deliberately NOT reachable by a slip of the thumb: always a confirm first.
function _ecosystemRestartOverlay() {
  // Paint the restart screen IMMEDIATELY. deploy.sh takes a few seconds to get
  // to the actual bounce, and a button that looks like it did nothing is what
  // makes people press it twice. When the socket really drops, ws.js's own
  // restart flow takes over and starts polling — the classes are the same ones,
  // so the two hand over without a flicker.
  try {
    var overlay = document.getElementById('restart-overlay');
    var mainApp = document.getElementById('app');
    if (!overlay || !mainApp) return;
    var text = document.getElementById('restart-text');
    var sub = document.getElementById('restart-sub');
    var retryBtn = document.getElementById('restart-retry');
    if (text) text.textContent = 'Restarting everything';
    if (sub) sub.textContent = 'The PC. A minute or two — your session comes back by itself.';
    if (retryBtn) retryBtn.classList.remove('show');
    overlay.classList.remove('tv-off', 'restarting', 'tv-on');
    overlay.classList.add('show');
    mainApp.style.animation = 'tvOff 0.6s cubic-bezier(0.55, 0, 1, 0.45) forwards';
    setTimeout(function() {
      mainApp.classList.add('restart-hidden');
      mainApp.style.animation = '';
      overlay.classList.add('restarting');
    }, 650);
  } catch (e) { console.warn('[eco-restart] overlay failed', e); }
}

async function _ecosystemRestart(btn) {
  var msg = 'Restart EVERYTHING?\n\nThe Machine on the PC goes down and comes back up. ' +
            'It takes a minute or two and every running session stops.';
  // ui-kit.js è un <script> di index.html caricato PRIMA di questo file:
  // window.UI c'è sempre, niente ripiego sulla finestra nativa del browser.
  var ok = await window.UI.confirm(msg, { okText: 'Restart all', okVariant: 'danger' });
  if (!ok) return;
  if (btn) { btn.classList.add('loading'); btn.disabled = true; }
  try {
    var r = await window.api('POST', '/ecosystem-restart');
    if (r && r.ok) {
      _ecosystemRestartOverlay();
      return;
    }
    // NOTE: window.api() only throws on 401 / network — every other status comes
    // back as a parsed body. So a 409 "già in corso" lands HERE, not in catch.
    if (typeof window.showToast === 'function') window.showToast((r && r.error) || 'Restart refused');
  } catch (e) {
    var why = (e && e.message) ? e.message : 'error';
    if (typeof window.showToast === 'function') window.showToast('Restart did not start: ' + why);
    console.error('[eco-restart]', e);
  } finally {
    if (btn) { btn.classList.remove('loading'); btn.disabled = false; }
  }
}

// [17/10/2026] Il riavvio si chiama dal pannello dei plugin («Restart machine»,
// ui.js). Stessa strada di sempre: conferma, POST /ecosystem-restart, schermata.
window.ecosystemRestart = function ecosystemRestart() { return _ecosystemRestart(null); };


// Draft store. M9 Fase C · Vettore 6 extends the per-session draft from a plain
// string to { text, attachments:[refs] }, RETRO-COMPATIBLE: a legacy string value
// normalises to { text, attachments:[] }. To keep flag-off byte-identical, an
// entry with NO attachments is still written as a plain string (the historical
// shape) — the object shape only appears once a draft actually carries an
// attachment ref (which only happens with DETACHED_RUNS on).
function _readDrafts() {
  try { return JSON.parse(localStorage.getItem('151-terminal-drafts') || '{}'); } catch(e) { return {}; }
}
function _writeDrafts(drafts) {
  localStorage.setItem('151-terminal-drafts', JSON.stringify(drafts));
}
function _normDraft(v) {
  if (typeof v === 'string') return { text: v, attachments: [] };
  if (v && typeof v === 'object') return { text: v.text || '', attachments: Array.isArray(v.attachments) ? v.attachments : [] };
  return { text: '', attachments: [] };
}
function _putDraft(drafts, sessionId, text, attachments) {
  var hasText = !!(text && text.trim());
  var atts = Array.isArray(attachments) ? attachments : [];
  if (!hasText && atts.length === 0) { delete drafts[sessionId]; return; }
  drafts[sessionId] = atts.length ? { text: text || '', attachments: atts } : (text || '');
}

function saveDraft(sessionId, text, attachments) {
  if (!sessionId) return;
  var drafts = _readDrafts();
  // attachments omitted ⇒ preserve whatever refs are already stored (text-only
  // callers must not wipe a persisted attachment ref).
  var atts = (attachments === undefined) ? _normDraft(drafts[sessionId]).attachments : (attachments || []);
  _putDraft(drafts, sessionId, text, atts);
  _writeDrafts(drafts);
}

function loadDraft(sessionId) {
  if (!sessionId) return '';
  return _normDraft(_readDrafts()[sessionId]).text;
}

// Replace ONLY the attachment refs for a session's draft, preserving its text.
function saveDraftAttachments(sessionId, refs) {
  if (!sessionId) return;
  var drafts = _readDrafts();
  var cur = _normDraft(drafts[sessionId]);
  _putDraft(drafts, sessionId, cur.text, refs || []);
  _writeDrafts(drafts);
}
window.saveDraftAttachments = saveDraftAttachments;

function loadDraftAttachments(sessionId) {
  if (!sessionId) return [];
  return _normDraft(_readDrafts()[sessionId]).attachments;
}
window.loadDraftAttachments = loadDraftAttachments;

// [11/10/2026] «Questa sessione il proprietario l'ha vista»: via la sua notifica qui, e il
// server lo ripete a ogni apparecchio (session_read, ws-handler.js) e se lo
// segna (readAt), così anche un telefono che era spento lo scopre al ritorno.
// Best-effort: socket chiuso = vale la pulizia locale. Un invio ogni 3 s per
// sessione basta (focus e visibilitychange arrivano a raffica).
var _lettaInviata = {};
window.segnaLetta = function segnaLetta(id) {
  if (!id) return;
  try { if (typeof window.clearSessionNotification === 'function') window.clearSessionNotification(id); } catch (e) {}
  var adesso = Date.now();
  if (_lettaInviata[id] && adesso - _lettaInviata[id] < 3000) return;
  try {
    if (window.ws && window.ws.readyState === 1) {
      window.ws.send(JSON.stringify({ type: 'session_read', sessionId: id }));
      _lettaInviata[id] = adesso;
    }
  } catch (e) {}
};

window.switchSession = function switchSession(id) {
  haptic([10, 30, 10]);
  // B2 (2026-08-11) bug (a): re-clicking the ALREADY-active chat used to re-run
  // the full teardown (streamingEl.remove(), lastHistoryHash='', history re-render
  // wiping messagesEl) — which blanks the live/partial body and looks like "clicco
  // e si azzera". No-op guard: same id → only the cheap UI touch-ups, then return.
  // No render, no teardown, nothing destructive.
  if (id === window.activeSessionId) {
    window.closeSidebar();
    ensureInputVisible();
    scrollToBottom(true);
    return;
  }
  // Save draft from current session before switching
  if (window.activeSessionId) {
    saveDraft(window.activeSessionId, messageInput.value);
    if (window.streaming || window.streamingText || window.thinkingText || window.streamingEl) {
      window.saveLiveStreamState(window.activeSessionId, {
        streaming: !!window.streaming,
        streamedText: window.streamingText || '',
        thinkingText: window.thinkingText || '',
      });
    }
  }
  // Clear awaiting — user is viewing this session now
  if (window.awaitingSessions.has(id)) {
    window.awaitingSessions.delete(id);
    persistAwaiting();
  }
  // [READ-SYNC 2026-08-15 → 11/10/2026] Propagate the "read" to the other
  // device SEMPRE, non solo quando qui era «da leggere»: la notifica del
  // telefono esiste anche se il PC non aveva il pallino acceso.
  window.segnaLetta(id);
  window.activeSessionId = id;
  // Punto 2: remember that this session has been opened at least once so the
  // preview row (finished && alreadyOpened && idle) can light up for it later.
  if (window.openedSessions && !window.openedSessions.has(id)) {
    window.openedSessions.add(id);
    persistOpened();
  }
  localStorage.setItem('151-terminal-session', id);
  messageQueue = []; // clear queue when switching sessions
  streaming = false;
  streamingText = ''; thinkingText = '';
  releaseWakeLock(); // clean up wake lock from previous session
  // Stop TTS if playing
  if ('speechSynthesis' in window && speechSynthesis.speaking) speechSynthesis.cancel();
  if (streamingEl) { streamingEl.remove(); streamingEl = null; }
  // Cancel pending render timers from old session
  if (typeof _mdRenderTimer !== 'undefined') clearTimeout(_mdRenderTimer);
  if (typeof _renderTimer !== 'undefined') clearTimeout(_renderTimer);
  autoScroll = true; // always scroll to bottom on session switch
  lastHistoryHash = ''; // force re-render on session switch
  // Clean up activity log state (old elements wiped by innerHTML = '')
  if (activityElapsedTimer) { clearInterval(activityElapsedTimer); activityElapsedTimer = null; }
  inlineActivityEl = null;
  activityLogEntries = [];
  activityStartTime = null;
  // Hide scroll-to-bottom button
  scrollBottomBtn.classList.remove('visible');
  const session = window.sessions.find(function(s) { return s.id === id; });
  if (!session) {
    console.warn('[SWITCH] Session not found:', id, '— falling back');
    localStorage.removeItem('151-terminal-session');
    if (window.sessions.length > 0) {
      window.switchSession(window.sessions[0].id);
    } else {
      window.showEmptyState();
    }
    return;
  }

  headerTitle.textContent = session.title;
  window.updateStatusDot(session.status);
  setViewState('session');
  setStreamingState(false);

  // Use server history, fall back to local cache if empty
  var historyToRender = (session.history && session.history.length > 0)
    ? session.history
    : window.getCachedHistory(session.id);
  renderHistoryMessages(historyToRender, false);
  if (session._liveStream && (session._liveStream.streaming || session._liveStream.streamedText || session._liveStream.thinkingText)) {
    if (session._liveStream.streaming) window.setStreamingState(true);
    window.streamingText = session._liveStream.streamedText || '';
    window.thinkingText = session._liveStream.thinkingText || '';
    if (window.streamingText) {
      window.updateStreamingMessage(window.streamingText);
    } else if (window.thinkingText) {
      window.showThinkingState();
      window.updateThinkingDisplay(window.thinkingText);
    } else if (session._liveStream.streaming) {
      // Streaming but no text yet — show a live thinking bubble so the user
      // sees the session is alive. Without this branch the Stop button
      // appears but the chat area stays blank until the next delta.
      window.showThinkingState();
    }
  } else if (session.status === 'busy') {
    // B2 (2A): the SERVER says this session is busy but we have no local live
    // stream (it never streamed on THIS device) — without this the body stays
    // static until the resume lands, looking blank. Show a transient "sta
    // rispondendo" bubble now; get_stream_state/resume replaces it with the
    // real text, and history / resume(streaming=false) / done clear it. No
    // orphan spinner is introduced (all those paths already reset streamingEl).
    window.showThinkingState();
  }
  // Cache whatever we rendered
  if (historyToRender.length > 0) window.cacheHistory(session.id, historyToRender);
  // Pre-compute history hash so incoming WS history event skips re-render
  // (prevents the flicker of wipe → re-render identical content)
  if (session.history && session.history.length > 0) {
    const _lastEntry = session.history[session.history.length - 1];
    const _lastContent = _lastEntry.content || '';
    lastHistoryHash = id + ':' + session.history.length + ':' + _lastContent.length + ':' + _lastContent.slice(-50);
  }

  // B3 (2026-08-11): reuse the existing OPEN socket via a lightweight re-join
  // instead of tearing it down on every switch. switchSocketSession falls back
  // to the full connectWebSocket(id) whenever the socket isn't OPEN, so this is
  // strictly safer than the old unconditional reconnect.
  window.switchSocketSession(id);
  // NOTE: get_stream_state is sent right after `join` (both in onopen and in the
  // lightweight switch) — this guarantees server-side `currentSessionId` is set
  // before the request arrives. Sending it standalone here caused a race:
  // get_stream_state could reach the server before join → "not joined to session".
  window.renderSessionList();
  window.closeSidebar();
  ensureInputVisible();
  scrollToBottom(true);
  // Restore per-session draft (text + M9 Vettore 6 attachment refs)
  messageInput.value = loadDraft(id);
  if (typeof window._rehydrateDraftAttachments === 'function') window._rehydrateDraftAttachments(id);
  sendBtn.classList.toggle('has-text', !!messageInput.value.trim());
  // Don't auto-focus — it forces the keyboard open on mobile which is annoying

};

// --- Delete session with confirmation ---

function confirmDeleteSession(sessionId) {
  window.UI.confirm('Delete this session?', { okText: 'Delete', okVariant: 'danger' })
    .then(function (ok) { if (ok) window.deleteSession(sessionId); });
}


// --- UI Helpers ---

// Track sessions that just finished responding (awaiting user input)
window.awaitingSessions = new Set(
  JSON.parse(localStorage.getItem('151-terminal-awaiting') || '[]')
);

function persistAwaiting() {
  localStorage.setItem('151-terminal-awaiting', JSON.stringify([...window.awaitingSessions]));
}

// Punto 2: sessions the owner has OPENED at least once. This is the
// "alreadyOpened" half of the (finished && alreadyOpened && idle) condition that
// gates the message-preview row under the name. Persisted so it survives reloads.
window.openedSessions = new Set(
  JSON.parse(localStorage.getItem('151-terminal-opened') || '[]')
);

function persistOpened() {
  localStorage.setItem('151-terminal-opened', JSON.stringify([...window.openedSessions]));
}
window.persistOpened = persistOpened;

function getTeamIcon(teamKey) {
  if (!teamKey) return IC.messageCircle;
  var team = TEAMS[teamKey];
  return team ? team.icon : IC.messageCircle;
}

// Detect a live session running a given slash-command (e.g. '/writer').
// Real signal: scans history for a user message whose text starts with the
// command. Most recently active match wins.
function detectAgentSession(command) {
  var bestId = null, bestTime = -1;
  for (var i = 0; i < window.sessions.length; i++) {
    var s = window.sessions[i];
    var hist = (s && s.history) || [];
    var ran = false;
    for (var h = 0; h < hist.length; h++) {
      var e = hist[h];
      if (e && e.role === 'user' && typeof e.content === 'string' &&
          e.content.trim().indexOf(command) === 0) {
        ran = true;
        break;
      }
    }
    if (!ran) continue;
    var t = new Date(s.lastActivity || s.created).getTime() || 0;
    if (t >= bestTime) { bestTime = t; bestId = s.id; }
  }
  return bestId;
}

// Fleet card display name — UPPERCASE type + monotonic ticket, read straight off
// the live session object (FLIP 2026-07-20). The number is the agentNumber the
// server STAMPED at spawn (session-manager _stampFleet) — NOT window._fleetCounters,
// which raced on every refresh. `kind` is only a fallback label when a live
// session hasn't been passed / hasn't been stamped yet.
function fleetDisplayName(session, kind) {
  var names = FLEET_TYPE_BY_KEY; // i tipi dal file delle squadre (applySquadre)
  // Fix B: the number is a LOCKED prefix ("WRITER 45") computed from the
  // stamped agentType+agentNumber — it can NEVER be wiped by a title edit. The
  // user's editable text is a SEPARATE label (agentLabel) appended AFTER the
  // locked prefix, so the card name and the editable title are ONE object that
  // always keeps its number. We deliberately do NOT return session.title
  // verbatim on a manual rename anymore — that was the bug that dropped the
  // number the instant the owner edited the name.
  var base = (session && session.agentType) || names[kind] || String(kind || '');
  var n = (session && typeof session.agentNumber === 'number') ? session.agentNumber : null;
  var prefix = (n != null ? (base + ' ' + n) : base).toUpperCase(); // LOCKED
  var label = (session && session.agentLabel) ? String(session.agentLabel).trim() : '';
  if (!prefix) return (session && session.title) || label || '';
  return label ? (prefix + ' ' + label) : prefix;
}

// Fix B helper — strip the LOCKED "TYPE N" prefix (any casing) off a full title
// so only the user's editable label remains. Used by the rename path + dialog so
// editing the name can never touch the number.
function fleetStripPrefix(session, text) {
  var t = String(text || '').trim();
  if (!session || !session.agentType || typeof session.agentNumber !== 'number') return t;
  var re = new RegExp('^' + session.agentType + '\\s*' + session.agentNumber + '\\s*', 'i');
  return t.replace(re, '').trim();
}
window.fleetStripPrefix = fleetStripPrefix;

// Fleet slot pinning — find the live session for a given fleet TYPE by its
// stamped agentType (FLIP 2026-07-20). Most recently active match wins.
// Returns the session id or null.
//
// Fix C (defense-in-depth): the PRIMARY signal is the server-stamped agentType
// (correctly serialized at session-manager _serialize). If a client ever holds
// a session WITHOUT agentType (e.g. an older cached serialize, or a data path
// that dropped the field), we FALL BACK to the same slash-command history scan
// the pre-FLIP UI used, so the agent still pins into its Fleet slot
// instead of leaking into "Other". This makes the pin robust across every
// device regardless of how fresh its session data is. (The phone's own case was
// a STALE cached bundle — see report — which a deploy/cache-bust resolves; this
// fallback prevents a data-shaped regression from ever unpinning again.)
// Un tipo che il file delle squadre non dichiara più cade in «Other» come una
// sessione normale.
function detectFleetByType(agentType) {
  var bestId = null, bestTime = -1;
  for (var i = 0; i < window.sessions.length; i++) {
    var s = window.sessions[i];
    if (!s || s.agentType !== agentType) continue;
    var t = new Date(s.lastActivity || s.created).getTime() || 0;
    if (t >= bestTime) { bestTime = t; bestId = s.id; }
  }
  if (bestId) return bestId;
  // Fallback: no agentType match — scan history for the opening slash-command.
  var key = Object.keys(FLEET_TYPE_BY_KEY).filter(function(k) { return FLEET_TYPE_BY_KEY[k] === agentType; })[0];
  if (key) return detectAgentSession('/' + key);
  return null;
}

// Fleet slot key → stamped agentType. Keeps the render order/keys intact while
// the pin source moves to agentType. Vuota nel codice: la riempie applySquadre
// coi «super» del file delle squadre (stessi tipi del server, server/squadre.js).
var FLEET_TYPE_BY_KEY = {};

// Model id → short human label for the session card: strip the "claude-"
// prefix and the "[1m]" tier suffix, capitalize the name words, keep the
// version digits dash-joined: "claude-fable-5[1m]" → "Fable 5",
// "claude-opus-5" → "Opus 5", "claude-opus-4-8" → "Opus 4-8".
// Returns '' on missing/blank input so callers can render it straight into HTML.
function prettifyModelId(id) {
  if (!id || typeof id !== 'string') return '';
  var bare = id.replace(/^claude-/i, '').replace(/\[1m\]$/i, '');
  var parts = bare.split('-');
  var i = parts.length;
  while (i > 0 && /^\d+$/.test(parts[i - 1])) i--; // trailing numerics = version
  var name = parts.slice(0, i).map(function(w) {
    return w.charAt(0).toUpperCase() + w.slice(1);
  }).join(' ');
  // «5.5», never «5-5».
  var ver = parts.slice(i).filter(function(p) { return !/^\d{8}$/.test(p); }).join('.'); // no date stamp
  return (name + (ver ? ' ' + ver : '')).trim() || bare;
}

// ── LAVORI IN SOTTOFONDO (inizio) ──────────────────────────────────────────
// [17/10/2026] Una sessione che aspetta lavori in sottofondo (turno in
// attesa, o turno chiuso con lavori vivi) dice «waiting», nello stesso blu
// pulsante di «working». Niente tasto sulla card («non l'ho mai chiesto; se
// voglio fermarla la apro e premo il tasto rosso»): il tasto rosso della chat
// si vede anche a turno chiuso quando la sessione aperta aspetta, e col suo
// stop (source:'button') il server ferma anche i lavori.
// Il server manda session_background {backgroundTasks, waiting, tasks}.
// Prova: tests/attesa-sottofondo-ui.test.js.

// [29/10/2026] La card dice sempre QUANTI aiutanti sono vivi («waiting
// for 3») e quanti sono stati fermati («1 stopped»), invece di farli sparire.
// Prova: tests/attesa-sottofondo-ui.test.js (legge B2).

// Quanti lavori, se il turno è tenuto aperto solo per loro, quanti fermati.
function bgTaskSummary(s) {
  var list = Array.isArray(s.backgroundTaskList) ? s.backgroundTaskList : [];
  return { count: Math.max(Number(s.backgroundTasks) || 0, list.length), waiting: s.backgroundWaiting === true,
    stopped: Math.max(0, Number(s.backgroundStopped) || 0) };
}

function bgStoppedText(b) { return b.stopped > 0 ? b.stopped + ' stopped' : ''; }

// L'etichetta della riga 2 per i lavori in sottofondo. '' = niente da dire.
function bgUnderNameHtml(s) {
  var b = bgTaskSummary(s);
  var st = bgStoppedText(b);
  var tail = st ? ' · ' + st : '';
  if (b.count > 0) return '<div class="session-status-label is-waiting">waiting for ' + b.count + tail + '</div>';
  if (b.waiting) return '<div class="session-status-label is-waiting">waiting' + tail + '</div>';
  if (!st) return '';
  if (s.status === 'busy') return '<div class="session-status-label is-busy">working' + tail + '</div>';
  return '<div class="session-status-label is-stopped">' + st + '</div>';
}

// La sessione aperta ha lavori in sottofondo vivi? (core.js setStreamingState)
window.activeHasBackground = function activeHasBackground() {
  var id = window.activeSessionId;
  if (!id || !Array.isArray(window.sessions)) return false;
  var s = window.sessions.find(function(x) { return x.id === id; });
  if (!s) return false;
  var b = bgTaskSummary(s);
  return b.count > 0 || b.waiting;
};

// Tasto rosso della chat a turno chiuso: si vede finché la sessione aperta
// aspetta. Mentre la risposta scorre lo governa setStreamingState: non si tocca.
function syncStopForBackground() {
  var btn = window.stopBtn;
  if (!btn || !btn.style || window.streaming) return;
  btn.style.display = window.activeHasBackground() ? 'flex' : 'none';
}

window.applyBackgroundUpdate = function applyBackgroundUpdate(msg) {
  var s = window.sessions.find(function(x) { return x.id === msg.sessionId; });
  if (!s) return;
  s.backgroundTasks = Number(msg.backgroundTasks) || 0;
  s.backgroundWaiting = msg.waiting === true;
  s.backgroundTaskList = Array.isArray(msg.tasks) ? msg.tasks : [];
  s.backgroundStopped = Number(msg.backgroundStopped) || 0;
  if (s.id === window.activeSessionId) syncStopForBackground();
  window.renderSessionList();
};

// ── LAVORI IN SOTTOFONDO (fine) ──

// Build the markup for one session row. `isSpecial` adds the special card treatment.
// `displayTitle` (optional) overrides the shown title — used by Fleet cards to
// render the UPPERCASE type+number from the roster instead of the auto-title.
// `iconOverride` (optional) forces the card icon — used by live Fleet cards so
// each shows ITS agent's glyph instead of the generic getTeamIcon(s.team),
// which returns a chat bubble when team is null (Fix 5).
function buildSessionItemHtml(s, isSpecial, displayTitle, iconOverride) {
  // Model label replaces the old relative-time stamp on the card (2026-08-15):
  // "what is this running on" beats "un minuto fa". Full model id stays in the
  // tooltip (keeps the [1m]-tier info reachable). Degrades to '' if the DTO
  // hasn't shipped `model` yet — never renders undefined.
  const modelId = s.model || '';
  const modelLabel = prettifyModelId(modelId);
  const isActive = s.id === window.activeSessionId;
  const isAwaiting = window.awaitingSessions.has(s.id) && !isActive;
  const isBusy = s.status === 'busy';
  const wasOpened = !!(window.openedSessions && window.openedSessions.has(s.id));
  const teamIcon = iconOverride || getTeamIcon(s.team);
  // Punti 1+2 (2026-08-11): the NAME always sits on top; the row UNDER the name is
  // EITHER a plain-language status label OR the message preview — never both.
  //   busy                              → "sta lavorando"
  //   awaiting (finished, not re-opened) → "risposta pronta"
  //   finished + already opened + idle   → the message preview (the ONLY state the
  //                                        preview text is shown; see reused signals
  //                                        openedSessions + awaitingSessions from B1).
  //   anything else (idle, never opened) → an empty spacer so row height is stable.
  var underNameHtml;
  // [17/10/2026] Sessione che ASPETTA lavori in sottofondo (modello fermo):
  // non più «working» muto, ma cosa aspetta + tasto stop (bgUnderNameHtml).
  // «reply ready» vince sull'attesa a turno chiuso: si apre e lì si vede.
  var bgHtml = (isBusy || !isAwaiting) ? bgUnderNameHtml(s) : '';
  var isWaitingBg = bgHtml.indexOf('is-waiting') >= 0;
  var bgStopped = bgStoppedText(bgTaskSummary(s));
  if (bgHtml) {
    underNameHtml = bgHtml;
  } else if (isBusy) {
    underNameHtml = '<div class="session-status-label is-busy">working</div>';
  } else if (isAwaiting) {
    underNameHtml = '<div class="session-status-label is-awaiting">reply ready' + (bgStopped ? ' · ' + bgStopped : '') + '</div>';
  } else if (wasOpened) {
    underNameHtml = '<div class="session-preview">' + escapeHtml(s.lastMessage || 'New session') + '</div>';
  } else {
    underNameHtml = '<div class="session-preview session-preview-empty">&nbsp;</div>';
  }
  var statusClass = s.status === 'busy' ? ' busy-session' : ' idle-session';
  var teamClass = s.team ? ' team-' + s.team : '';
  var classes = 'session-item' + teamClass;
  if (s._wrapped || s.status === 'wrapped') classes += ' wrapped';
  if (isActive) classes += ' active';
  else if (isAwaiting) classes += ' awaiting';
  else if (isWaitingBg) classes += ' bg-waiting';
  else if (isBusy) classes += ' in-progress';
  else classes += statusClass;
  if (isSpecial) classes += ' special';
  // [17/10/2026] il proprietario: chi lavora o aspetta è nello STESSO blu pulsante (nome,
  // etichetta, bordo), per tutte — super agenti compresi — e
  // resta blu anche selezionata. Finita, torna al colore suo (main.css, is-live).
  if ((isBusy || isWaitingBg) && !isAwaiting) classes += ' is-live';
  return '<div class="session-item-wrap" data-id="' + s.id + '">' +
    '<div class="' + classes + '" data-id="' + s.id + '">' +
      '<div class="session-team-icon">' + teamIcon + '</div>' +
      '<div class="session-dot ' + (s.status || 'idle') + (s.team ? ' team-' + s.team : '') + '"></div>' +
      '<div class="session-info">' +
        // [17/10/2026] Riga 1: solo il nome (così si legge quasi sempre
        // intero). Riga 2: a sinistra lo stato o l'inizio dell'ultimo
        // messaggio, a destra la pastiglia del modello.
        '<div class="session-header">' +
          '<span class="session-title">' + escapeHtml(displayTitle || s.title) + '</span>' +
        '</div>' +
        '<div class="session-sub">' +
          underNameHtml +
          // 2026-08-20: the model reads as a PILL, not as loose grey text that
          // looked like a timestamp (it still carries the .session-time class so
          // existing layout/colour rules keep applying).
          '<span class="session-time session-model-pill" title="' + escapeHtml(modelId) + '">' + escapeHtml(modelLabel) + '</span>' +
        '</div>' +
      '</div>' +
      '<button class="session-delete" data-id="' + s.id + '" title="Delete session"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button>' +
    '</div>' +
  '</div>';
}

window.renderSessionList = function renderSessionList() {
  // Prune awaiting entries for deleted sessions
  var sessionIds = new Set(window.sessions.map(function(s) { return s.id; }));
  var pruned = false;
  window.awaitingSessions.forEach(function(id) {
    if (!sessionIds.has(id)) { window.awaitingSessions.delete(id); pruned = true; }
  });
  if (pruned) persistAwaiting();
  // Same prune for the opened-once set so it can't leak deleted ids forever.
  var prunedOpened = false;
  if (window.openedSessions) {
    window.openedSessions.forEach(function(id) {
      if (!sessionIds.has(id)) { window.openedSessions.delete(id); prunedOpened = true; }
    });
    if (prunedOpened) persistOpened();
  }

  // --- La scheda speciale: c'è SOLO se il file delle squadre dichiara un
  // super con "special": true (nome, icona e colore suoi). Pin source (FLIP
  // 2026-07-20): the server-stamped agentType. If several match, the most
  // recently active one wins. It renders ONLY in its own pinned section and is
  // excluded from the normal groups below.
  var specKey = superSpeciale();
  var specialId = specKey ? detectFleetByType(FLEET_TYPE_BY_KEY[specKey]) : null;

  // --- Super-Agents: gli altri super agenti scelti ---
  // Each maps to a live session (if one is running its skill) or null. Live
  // fleet sessions are pinned in the Fleet section and excluded from the
  // normal groups below, exactly like the special card.
  var fleetIds = {};        // key -> session id (or null)
  var pinnedIds = new Set();
  if (specialId) pinnedIds.add(specialId);
  var accesi = superAccesi(); // solo quelli scelti: gli altri vanno in «Other»
  for (var fi = 0; fi < accesi.length; fi++) {
    var fk = accesi[fi];
    var sid = FLEET_TYPE_BY_KEY[fk] ? detectFleetByType(FLEET_TYPE_BY_KEY[fk]) : detectSuperSession(fk);
    if (sid && pinnedIds.has(sid)) sid = null; // never double-pin one session
    fleetIds[fk] = sid;
    if (sid) pinnedIds.add(sid);
  }

  // ONE "Other" section for every non-fleet session (Fix 3). The old
  // working / waiting-for-feedback split is gone — a single bucket, newest first.
  const groups = { other: [] };
  const groupLabels = { other: 'Other' };
  for (let i = 0; i < window.sessions.length; i++) {
    if (pinnedIds.has(window.sessions[i].id)) continue; // special or Fleet — pinned above
    if (window.sessions[i].hidden) continue; // Father's relay children — invisible/ephemeral
    groups.other.push(window.sessions[i]);
  }
  // Sort by last activity (newest first)
  groups.other.sort(function(a, b) {
    var aTime = new Date(a.lastActivity || a.created).getTime();
    var bTime = new Date(b.lastActivity || b.created).getTime();
    return bTime - aTime;
  });

  let html = '';

  // Pinned Super-Agents section — the special card and the other super agents,
  // grouped together in ONE pinned section at the top of the sidebar. A LIVE
  // card carries its agent's colored aura; placeholders stay grey. A live
  // session (running its skill) renders as a normal item; otherwise a
  // click-to-spawn placeholder that seeds a new session with the skill.
  // Senza nessun super agente la sezione non si disegna affatto.
  var specialSession = specialId
    ? window.sessions.find(function(s) { return s.id === specialId; })
    : null;
  // Round 3 (2026-08-16): one mini icon per agent, light grey when that agent
  // is idle, lit with the agent's own color when its session is LIVE.
  var conSuper = !!specKey || accesi.length > 0;
  if (conSuper) {
    html += '<div class="session-group fleet-group" data-group="fleet">';
    html += '<div class="session-group-label">Super-Agents' +
          '<span class="sg-icons">' +
            (specKey ? '<span class="sg-icon sg-special' + (specialSession ? ' lit" style="color:rgb(' + superRgb(specKey) + ')' : '') + '">' + TEAMS[specKey].icon + '</span>' : '') +
            accesi.map(function(k) { return '<span class="sg-icon sg-' + k + (fleetIds[k] ? ' lit" style="color:rgb(' + superRgb(k) + ')' : '') + '">' + TEAMS[k].icon + '</span>'; }).join('') +
          '</span></div>';
  }
  // Order: the special card, then the others by their «pos».
  // Each slot renders a live session card (if one is running its skill) or a
  // click-to-spawn placeholder. Live Fleet cards show the UPPERCASE type +
  // roster number from the instant of spawn (fleetDisplayName).
  function agentSlotHtml(akey) {
    var team = TEAMS[akey];
    var liveId = fleetIds[akey];
    if (liveId) {
      var liveSession = window.sessions.find(function(s) { return s.id === liveId; });
      if (liveSession) return superVeste(buildSessionItemHtml(liveSession, false,
        FLEET_TYPE_BY_KEY[akey] ? fleetDisplayName(liveSession, akey) : (liveSession.title || team.title), (team && team.icon) || null), akey);
    }
    // H: placeholder shows the UPPERCASE agent name,
    // matching the live-card fleetDisplayName treatment — not the team title.
    var agentName = String((team && team.title) || akey).toUpperCase();
    // [12/11 il proprietario «still retarded»] la scheda «Run /…» di un agente non aperto resta GRIGIA: il colore è solo della sessione viva.
    return '<button class="agent-placeholder agent-' + akey + '" data-agent="' + akey + '" ' +
             'title="' + escapeHtml(agentName) + '">' +
             '<span class="agent-placeholder-icon">' + team.icon + '</span>' +
             '<span class="agent-placeholder-text">' +
               '<span class="ap-title">' + escapeHtml(agentName) + '</span>' +
               '<span class="ap-sub">Run ' + escapeHtml(team.command || '/' + akey) + '</span>' +
             '</span>' +
           '</button>';
  }
  // 1 — la scheda speciale (special card / placeholder), se il file la dichiara
  if (specKey && specialSession) {
    html += buildSessionItemHtml(specialSession, true, fleetDisplayName(specialSession, specKey), TEAMS[specKey].icon);
  } else if (specKey) {
    var specName = String(TEAMS[specKey].title || specKey).toUpperCase();
    html += '<button class="special-placeholder" id="special-start" title="' + escapeHtml(specName) + '">' +
              '<span class="special-placeholder-icon">' + TEAMS[specKey].icon + '</span>' +
              '<span class="special-placeholder-text">' +
                '<span class="dp-title">' + escapeHtml(specName) + '</span>' +
                '<span class="dp-sub">Run ' + escapeHtml(TEAMS[specKey].command || '/' + specKey) + '</span>' +
              '</span>' +
            '</button>';
  }
  // 2… — gli altri super agenti scelti, nel loro ordine
  accesi.forEach(function(k) { html += agentSlotHtml(k); });
  if (conSuper) html += '</div>';

  const groupOrder = ['other'];
  const groupEmptyText = { other: 'No other sessions' };
  for (let g = 0; g < groupOrder.length; g++) {
    const key = groupOrder[g];
    const count = groups[key].length;
    html += '<div class="session-group" data-group="' + key + '">';
    html += '<div class="session-group-label">' + groupLabels[key] +
            '<span class="sg-count">' + count + '</span></div>';
    if (count === 0) {
      html += '<div class="session-group-empty">' + groupEmptyText[key] + '</div>';
      html += '</div>';
      continue;
    }
    for (let j = 0; j < groups[key].length; j++) {
      html += buildSessionItemHtml(groups[key][j], false);
    }
    html += '</div>';
  }
  sessionList.innerHTML = html;

  const items = sessionList.querySelectorAll('.session-item');
  for (let i = 0; i < items.length; i++) {
    (function(item) {
      item.onclick = function(e) {
        if (e.target.classList.contains('session-delete')) return;
        window.switchSession(item.dataset.id);
      };
    })(items[i]);
  }

  const deletes = sessionList.querySelectorAll('.session-delete');
  for (let i = 0; i < deletes.length; i++) {
    (function(btn) {
      btn.onclick = function(e) {
        e.stopPropagation();
        confirmDeleteSession(btn.dataset.id);
      };
    })(deletes[i]);
  }

  const titles = sessionList.querySelectorAll('.session-title');
  for (let i = 0; i < titles.length; i++) {
    (function(el) {
      el.ondblclick = function(e) {
        e.stopPropagation();
        const id = el.closest('.session-item').dataset.id;
        window.openRenameDialog(id);
      };
    })(titles[i]);
  }

  // Special placeholder — click opens the inline compose box (Send with text
  // seeds the first message; Send empty spawns the bare agent session).
  var dStart = document.getElementById('special-start');
  if (dStart && specKey) {
    dStart.onclick = function() {
      if (typeof window._toggleAgentCompose === 'function') window._toggleAgentCompose(dStart, specKey);
    };
  }

  // Fleet placeholders — click opens the inline compose box for that agent.
  var fleetBtns = sessionList.querySelectorAll('.agent-placeholder');
  for (let i = 0; i < fleetBtns.length; i++) {
    (function(btn) {
      btn.onclick = function() {
        if (typeof window._toggleAgentCompose === 'function') window._toggleAgentCompose(btn, btn.dataset.agent);
      };
    })(fleetBtns[i]);
  }

  // Raccoon card + card-badge removed from the agents row (2026-08-15 —
  // Raccoon eliminated). The trash panel for findings went too (2026-10-12).

  // Empty-state hub: keep the recent-sessions strip in sync with the list
  renderRecentStrip();
};

// Recent sessions strip — shown on empty state above the launcher grid.
// Top 5 by most recent activity; click to jump back into that chat.
function renderRecentStrip() {
  var strip = document.getElementById('recent-sessions-strip');
  if (!strip) return;
  var recent = window.sessions.slice().sort(function(a, b) {
    var aTime = new Date(a.lastActivity || a.created).getTime();
    var bTime = new Date(b.lastActivity || b.created).getTime();
    return bTime - aTime;
  }).slice(0, 5);
  if (recent.length === 0) {
    strip.hidden = true;
    strip.innerHTML = '';
    return;
  }
  strip.hidden = false;
  var html = '';
  for (var i = 0; i < recent.length; i++) {
    var s = recent[i];
    var teamClass = s.team ? ' team-' + s.team : '';
    var statusClass = s.status === 'busy' ? ' busy'
                    : s.status === 'wrapping' ? ' wrapping' : '';
    // Same treatment as the session card (2026-08-15): model label instead of
    // relative time, '' if the DTO doesn't carry `model` — never undefined.
    var pillModel = prettifyModelId(s.model || '');
    html +=
      '<button class="recent-pill' + teamClass + statusClass + '"' +
              ' data-id="' + s.id + '"' +
              ' title="' + escapeHtml(s.title) + '">' +
        '<span class="recent-pill-title">' + escapeHtml(s.title) + '</span>' +
        '<span class="recent-pill-time" title="' + escapeHtml(s.model || '') + '">' + escapeHtml(pillModel) + '</span>' +
      '</button>';
  }
  strip.innerHTML = html;
  var pills = strip.querySelectorAll('.recent-pill');
  for (var k = 0; k < pills.length; k++) {
    (function(p) {
      p.onclick = function() { window.switchSession(p.dataset.id); };
    })(pills[k]);
  }
}

window.updateStatusDot = function updateStatusDot(status) {
  headerStatus.className = '';
  headerStatus.classList.add('session-dot', status);
  const s = window.sessions.find(function(s) { return s.id === window.activeSessionId; });
  if (s) s.status = status;
};

window.showEmptyState = function showEmptyState() {
  localStorage.removeItem('151-terminal-session');
  window.activeSessionId = null;
  setViewState('empty');
  headerTitle.innerHTML = '<span class="header-emblem">151</span>';
  headerStatus.className = '';
  if ('speechSynthesis' in window && speechSynthesis.speaking) speechSynthesis.cancel();
};

window.openSidebar = function openSidebar() {
  sidebar.classList.add('open');
  sidebarOverlay.classList.add('show');
};

window.closeSidebar = function closeSidebar() {
  sidebar.classList.remove('open');
  sidebarOverlay.classList.remove('show');
};

window.openRenameDialog = function openRenameDialog(sessionId) {
  const s = window.sessions.find(function(s) { return s.id === sessionId; });
  if (!s) return;
  // Fix B: for a FLEET session, the "WRITER 45" number is a LOCKED prefix —
  // the user only edits the label AFTER it. Prefill the input with the label
  // ALONE (not the full title, which is what let an edit wipe the number), and
  // surface the locked prefix as the placeholder so it's clear what stays fixed.
  if (s.agentType && typeof s.agentNumber === 'number') {
    renameInput.value = s.agentLabel || '';
    renameInput.placeholder = (s.agentType.toUpperCase() + ' ' + s.agentNumber) + ' — add a label';
  } else {
    renameInput.value = s.title;
    renameInput.placeholder = 'Session name';
  }
  renameDialog.classList.add('show');
  renameDialog.dataset.sessionId = sessionId;
  renameInput.focus();
  renameInput.select();
};

window.closeRenameDialog = function closeRenameDialog() {
  renameDialog.classList.remove('show');
};

// Composer sizing bounds. COMPOSER_MIN must stay equal to the #message-input
// min-height in main.css and to the #send-btn height — that shared number is
// what makes the single-line composer sit centred on the button row instead of
// hanging below it. COMPOSER_MAX must stay equal to the CSS max-height.
var COMPOSER_MIN = 38;
var COMPOSER_MAX = 120;

function autoResize() {
  // Flicker-free resize: hide overflow during measurement, batch in single frame
  messageInput.style.overflow = 'hidden';
  messageInput.style.height = 'auto';
  var full = messageInput.scrollHeight;
  // Clamp BOTH ends. Clamping only the top let an empty textarea report a
  // scrollHeight smaller than one rendered line, so the placeholder ended up
  // vertically clipped in an under-sized box.
  var needed = Math.max(COMPOSER_MIN, Math.min(full, COMPOSER_MAX));
  messageInput.style.height = needed + 'px';
  messageInput.style.overflow = '';
  // When the box is capped and text overflows, keep the line you're
  // typing on in view (follow the caret instead of freezing above it).
  if (full > COMPOSER_MAX) messageInput.scrollTop = messageInput.scrollHeight;
}
window.autoResize = autoResize; // expose for plugins (STT)

// ROOT FIX (2026-08-20 round 2, punto 4a) — the composer used to keep the
// height of the PREVIOUS session's draft when you opened a new one, so entering
// a session with an empty draft still showed a tall box.
//
// The cause was not any single call site: `messageInput.value = …` is assigned
// from twelve places across sessions.js, input.js, init.js and dictation.js, and
// only some of them remembered to call autoResize() afterwards. Patching the one
// that was reported (draft restore) left the other eleven broken — switching
// sessions, slash-command insert, team-launcher prefill, history recall, the
// old Idea Dumper's clear, and any future plugin all had the same hole.
//
// So the resize is moved INTO the assignment. We shadow the `value` property on
// this one element with a setter that delegates to the native one and then
// sizes the box. Every existing and future assignment is covered, and no call
// site has to remember anything. (autoResize only reads scrollHeight/style, so
// there is no recursion.) Typing is already handled by the 'input' listener.
(function installComposerAutoSize() {
  if (!messageInput) return;
  var desc = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
  if (!desc || !desc.set || !desc.get) return; // exotic engine — leave as-is
  Object.defineProperty(messageInput, 'value', {
    configurable: true,
    enumerable: true,
    get: function() { return desc.get.call(this); },
    set: function(v) { desc.set.call(this, v); try { autoResize(); } catch (e) {} }
  });
  // Size it once at boot so the very first paint is already correct.
  try { autoResize(); } catch (e) {}
})();

// --- Team Launcher v2 ---
// Nel codice c'è solo la sessione nuova: le squadre le sceglie chi usa l'app
// con il file delle squadre (~/.151machine/squadre.json, GET /api/squadre,
// server/squadre.js), che si UNISCE qui al boot (window.applySquadre).
const TEAMS = {
  'overseer':     { title: 'New Session',          command: null,                      color: null,    icon: IC.messageCircle },
  'blank':        { title: 'Blank Session',        command: null,                      color: null,    icon: IC.messageCircle },
};

// [12/11/2026] I super agenti li sceglie il proprietario (plugin «Super agents», in
// fondo al pannello dei plugin): QUALI stanno in alto, in che ordine, con che
// colore e icona. I punti di partenza (quali ci sono, colore, icona, nome, e
// quale è la scheda speciale) vengono dai «super» del file delle squadre; nel
// codice nessuno. Le scelte arrivano dal plugin (plugins/super-agents/client.js)
// e restano sul telefono anche a PC spento (localStorage).
// Prove: tests/super-agenti.test.js, tests/squadre.test.js.
window.SUPER_DEFAULT = {};
var SUPER_KEY_RE = /^[a-z0-9-]{1,32}$/;
// La chiave della scheda speciale: il primo super del file con "special": true.
function superSpeciale() {
  var d = window.SUPER_DEFAULT;
  return Object.keys(d).filter(function(k) { return d[k] && d[k].special === true; })[0] || null;
}
window.superSpeciale = superSpeciale;
window.superScelte = function(cfg) {
  var out = {};
  var keys = Object.keys(window.SUPER_DEFAULT);
  var sk = superSpeciale();
  Object.keys(cfg || {}).forEach(function(k) { if (SUPER_KEY_RE.test(k) && keys.indexOf(k) < 0) keys.push(k); });
  keys.forEach(function(k, i) {
    var d = window.SUPER_DEFAULT[k] || { on: false, color: '#a78bfa', icon: 'messageCircle', pos: 100 + i };
    var c = (cfg && cfg[k]) || {};
    var nome = typeof c.name === 'string' && c.name.trim() ? c.name.trim().slice(0, 40) : (d.name || k.charAt(0).toUpperCase() + k.slice(1));
    out[k] = {
      on: k === sk ? true : (typeof c.on === 'boolean' ? c.on : !!d.on),
      color: /^#[0-9a-fA-F]{6}$/.test(c.color || '') ? c.color : (d.color || '#a78bfa'),
      icon: (c.icon && window.IC && window.IC[c.icon]) ? c.icon : (d.icon || 'messageCircle'),
      name: nome,
      pos: k === sk ? -1 : (typeof c.pos === 'number' && isFinite(c.pos) ? c.pos : d.pos),
    };
    if (k === sk) out[k].special = true;
  });
  return out;
};
window.superAgents = (function() {
  try { return window.superScelte(JSON.parse(localStorage.getItem('super-agents') || 'null')); } catch (_) { return window.superScelte(null); }
})();
// Ogni super agente riceve qui le sue regole (bordo, alone, icona, «reply
// ready», pulsazione, pannello di composizione) col suo colore: nessuna regola
// per nome in main.css.
function superCssAggiunti(s) {
  return Object.keys(s).map(function(k) {
    var c = s[k].color, v = 'var(--agent-' + k + '-rgb)';
    var it = '#session-list .session-item.team-' + k;
    return it + '{border-left-color:' + c + ';box-shadow:inset 0 0 0 1px ' + c + '4d,0 0 12px ' + c + '26}' +
      it + ' .session-team-icon,' + it + ' .session-time{color:' + c + ';opacity:1}' +
      '.session-dot.team-' + k + '{background:' + c + '}' +
      '.session-item.team-' + k + '.active{--bleed-rgb:' + v + '}' +
      '.session-item.team-' + k + '.in-progress{--pulse-rgb:' + v + '}' +
      '.session-item.team-' + k + '.awaiting{border-left-color:' + c + '}' +
      '.session-item.team-' + k + '.awaiting .session-title{color:' + c + '}' +
      '.session-item.team-' + k + '.awaiting::after{background:' + c + '}' +
      '.session-item.team-' + k + '.awaiting .session-status-label.is-awaiting{background:' + c + '}' +
      '.agent-compose.agent-' + k + '{background:rgba(' + v + ',0.10);border-color:rgba(' + v + ',0.45)}' +
      '.agent-compose.agent-' + k + ' .agent-compose-send{background:rgba(' + v + ',0.25);color:' + c + '}';
  }).join('');
}
function hexRgb(hex) {
  return [1, 3, 5].map(function(i) { return parseInt(hex.substr(i, 2), 16); }).join(', ');
}
window.applySuperAgents = function(cfg, salva) {
  var s = window.superScelte(cfg);
  window.superAgents = s;
  if (salva) { try { localStorage.setItem('super-agents', JSON.stringify(s)); } catch (_) {} }
  var root = document.documentElement && document.documentElement.style;
  Object.keys(s).forEach(function(k) {
    var hex = s[k].color;
    if (root) {
      root.setProperty('--agent-' + k, hex);
      root.setProperty('--agent-' + k + '-rgb', hexRgb(hex));
      // La scheda speciale prende il colore del suo agente (main.css, .special).
      if (s[k].special) {
        root.setProperty('--agent-special', hex);
        root.setProperty('--agent-special-rgb', hexRgb(hex));
      }
    }
    if (!TEAMS[k]) TEAMS[k] = { title: s[k].name, command: '/' + k, color: k, icon: null, super: true };
    if (window.IC[s[k].icon]) TEAMS[k].icon = window.IC[s[k].icon];
  });
  if (typeof document.getElementById === 'function') {
    var st = document.getElementById('super-agents-css');
    if (!st && document.createElement && document.head) { st = document.createElement('style'); st.id = 'super-agents-css'; document.head.appendChild(st); }
    if (st) st.textContent = superCssAggiunti(s);
  }
  if (typeof window.renderSessionList === 'function') { try { window.renderSessionList(); } catch (_) {} }
};

// Il file delle squadre (GET /api/squadre) → TEAMS, SUPER_DEFAULT, i tipi
// numerati e i modelli di nascita. Si UNISCE ai default (che restano), poi la
// lista si ridisegna. Dato vuoto o rotto = niente cambia (solo New Session).
window.squadre = {};
window.applySquadre = function(d) {
  d = (d && typeof d === 'object' && !Array.isArray(d)) ? d : {};
  window.squadre = d;
  var teams = (d.teams && typeof d.teams === 'object') ? d.teams : {};
  Object.keys(teams).forEach(function(k) {
    var t = teams[k];
    if (!SUPER_KEY_RE.test(k) || !t || typeof t !== 'object') return;
    TEAMS[k] = {
      title: (typeof t.title === 'string' && t.title.trim()) ? t.title.trim() : k,
      command: (typeof t.command === 'string' && /^\/[A-Za-z0-9_-]+$/.test(t.command)) ? t.command : null,
      color: (typeof t.color === 'string' && SUPER_KEY_RE.test(t.color)) ? t.color : null,
      icon: (t.icon && window.IC[t.icon]) || IC.messageCircle,
    };
  });
  var sup = (d.super && typeof d.super === 'object') ? d.super : {};
  var base = {}, tipi = {};
  Object.keys(sup).forEach(function(k, i) {
    var x = sup[k];
    if (!SUPER_KEY_RE.test(k) || !x || typeof x !== 'object') return;
    var nome = (typeof x.name === 'string' && x.name.trim()) ? x.name.trim().slice(0, 40) : k.charAt(0).toUpperCase() + k.slice(1);
    base[k] = {
      on: x.on !== false,
      color: /^#[0-9a-fA-F]{6}$/.test(x.color || '') ? x.color : '#a78bfa',
      icon: (x.icon && window.IC[x.icon]) ? x.icon : 'messageCircle',
      name: nome,
      pos: (typeof x.pos === 'number' && isFinite(x.pos)) ? x.pos : i,
      special: x.special === true,
    };
    tipi[k] = nome;
    if (!TEAMS[k]) TEAMS[k] = { title: nome, command: '/' + k, color: k, icon: null, super: true };
  });
  window.SUPER_DEFAULT = base;
  FLEET_TYPE_BY_KEY = tipi;
  window.SPAWN_MODEL_DEFAULTS = window.SPAWN_MODEL_DEFAULTS || {};
  var mod = (d.spawnModels && typeof d.spawnModels === 'object') ? d.spawnModels : {};
  Object.keys(mod).forEach(function(k) {
    if (SUPER_KEY_RE.test(k) && typeof mod[k] === 'string') window.SPAWN_MODEL_DEFAULTS[k] = mod[k];
  });
  var scelte = null;
  try { scelte = JSON.parse(localStorage.getItem('super-agents') || 'null'); } catch (_) {}
  window.applySuperAgents(scelte); // ridisegna la lista
};
window.loadSquadre = async function() {
  var d = null;
  try { d = await window.api('GET', '/squadre'); } catch (_) { d = null; }
  // PC spento: l'ultima copia vista resta sul telefono.
  if (d && typeof d === 'object') { try { localStorage.setItem('151-squadre', JSON.stringify(d)); } catch (_) {} }
  else { try { d = JSON.parse(localStorage.getItem('151-squadre') || 'null'); } catch (_) { d = null; } }
  window.applySquadre(d);
};
// Primo disegno subito, dall'ultima copia vista (colori, icone, scheda speciale).
window.applySquadre((function() { try { return JSON.parse(localStorage.getItem('151-squadre') || 'null'); } catch (_) { return null; } })());

// Gli scelti, scheda speciale esclusa (ha la sua scheda), nel loro ordine.
function superAccesi() {
  var s = window.superAgents;
  return Object.keys(s).filter(function(k) { return !s[k].special && s[k].on; })
    .sort(function(a, b) { return s[a].pos - s[b].pos; });
}
// [12/11 il proprietario «so many more things should be green»] Ogni super agente
// vestito come la scheda speciale, nel suo colore: sfondo, strisce, nome, modello, icona.
function superRgb(k) {
  var hex = (window.superAgents[k] && window.superAgents[k].color) || '#a78bfa';
  return hexRgb(hex);
}
function superVeste(html, k) {
  return String(html).replace(/class="session-item(?=[ "])/, 'style="--sc-rgb:' + superRgb(k) + '" class="session-item super-card');
}
// La sessione viva di un agente aggiunto: l'ultima nata dalla sua scheda (team)
// o aperta col suo comando.
function detectSuperSession(k) {
  var best = null, bt = -1;
  for (var i = 0; i < window.sessions.length; i++) {
    var x = window.sessions[i];
    if (!x || x.team !== k || x.hidden) continue;
    var t = new Date(x.lastActivity || x.created).getTime() || 0;
    if (t >= bt) { bt = t; best = x.id; }
  }
  return best || detectAgentSession('/' + k);
}

// [2026-09-22] Tolta window._toggleCard(cardId), che apriva e chiudeva le
// mattonelle `.launcher-card` cercandole per id `card-<id>`. Nessuno la
// chiamava: cercata in tutto il repo (public/, plugins/, index.html e gli
// onclick scritti a mano, app/), zero lettori. La classe `.expanded` che
// metteva la governa oggi altro codice; le regole CSS restano dove sono.

// SELETTORE MODELLO ALLO SPAWN (2026-08-16, round #6) ------------------------
// The families a human can CLICK. Mirrors the server's SELECTABLE_FAMILIES
// (server/model-fallback.js): Haiku (16/8) and Sonnet (19/8) are deliberately
// absent from every menu — both survive untouched in the internal automatic
// fallback ladder and on sessions already pinned to them.
window.SELECTABLE_MODEL_FAMILIES = ['fable', 'opus'];

// Families that must NEVER appear as a clickable option, even if a server still
// lists them (an older PC the phone is talking to, or a process started before
// this change). A DENY-list, not an allow-list, so a future family the server
// adds still rides through to the menus with zero client changes.
// This is the line that makes the removal hold on the PHONE too: the APK loads
// the page from the Pi but can talk to a PC that has not been redeployed yet,
// and that PC would still offer Sonnet from /api/models.
window.NON_SELECTABLE_MODEL_FAMILIES = ['haiku', 'sonnet'];
window.filterSelectableModels = function(list) {
  var deny = window.NON_SELECTABLE_MODEL_FAMILIES || [];
  return (Array.isArray(list) ? list : []).filter(function(m) {
    var fam = String(m || '').toLowerCase().replace(/^claude-/, '').match(/^[a-z]+/);
    return deny.indexOf(fam ? fam[0] : '') === -1;
  });
};

// Per-agent default model for the spawn selector. 'overseer' is the New
// Session button in the sidebar footer: it defaults to Opus. Gli altri li dà il
// file delle squadre («spawnModels», applySquadre). A key missing here = the
// selector opens on Opus for a chosen super agent, no selector otherwise
// (ordinary team cards spawn on the terminal default exactly as before).
window.SPAWN_MODEL_DEFAULTS = Object.assign({ overseer: 'opus' }, window.SPAWN_MODEL_DEFAULTS || {});

window._launchTeam = async function(teamKey, firstPrompt, spawnModel) {
  const team = TEAMS[teamKey];
  if (!team) return;
  await window.createSession(team.title);
  // PIN ALLA NASCITA (2026-08-16): pin the just-born session to the model
  // chosen in the spawn selector, through the SAME door the topbar chip uses
  // (PATCH /sessions/:id/model → manager.setModel). Awaited BEFORE the opening
  // turn is sent, so the very first spawn already runs on the picked family.
  var _model = (spawnModel || '').trim();
  if (window.activeSessionId && _model) {
    try {
      var _dto = await window.api('PATCH', '/sessions/' + window.activeSessionId + '/model', { model: _model });
      var _ms = window.sessions.find(function(s) { return s.id === window.activeSessionId; });
      // The server resolves a bare family to a precise id ('opus' →
      // 'claude-opus-5'), so chip + card read a real version at once.
      if (_ms) _ms.model = (_dto && _dto.model) || _model;
    } catch (e) {
      if (typeof window.showToast === 'function') window.showToast('Could not set model: ' + e.message, 'error');
    }
  }
  if (window.activeSessionId) {
    // Tag session with team color
    if (team.color) {
      try { await window.api('PATCH', '/sessions/' + window.activeSessionId + '/team', { team: team.color }); } catch {}
      var s = window.sessions.find(function(s) { return s.id === window.activeSessionId; });
      if (s) {
        s.team = team.color;
        // Optimistic Fleet pin (Fix 2): stamp agentType client-side NOW so
        // detectFleetByType lands the fresh agent in its own slot immediately,
        // without waiting for a reload to fetch the server-stamped type. The
        // real agentNumber fills in on the next roster refresh (fleetDisplayName
        // tolerates a null number until then).
        if (FLEET_TYPE_BY_KEY[teamKey]) s.agentType = FLEET_TYPE_BY_KEY[teamKey];
        window.renderSessionList();
      }
    }
    // Compose the opening turn. If the user typed a first prompt in the inline
    // compose box, deliver BOTH the skill command and their prompt together as
    // the FIRST message so the fresh agent starts warm. Empty prompt = behave
    // exactly as before (command only, or bare session if no command).
    var fp = (firstPrompt || '').trim();
    if (team.command || fp) {
      await waitForWsReady();
      if (team.command && fp) {
        messageInput.value = team.command + '\n\n' + fp;
      } else if (team.command) {
        messageInput.value = team.command;
      } else {
        messageInput.value = fp;
      }
      sendMessage();
    }
  }
};

// Click-to-compose — clicking a Fleet agent card (or the special card) opens
// an inline compose box (textarea + Send) attached to that card. Send delivers
// the typed prompt as the FIRST message of a fresh agent session (alongside the
// skill command). Sending with an empty textarea spawns the bare agent exactly
// as a plain click did before. Clicking the card again closes the box.
// opts (2026-08-19, New Session button):
//   placement: 'above'  → park the panel ABOVE the button instead of right
//                         under it (see the placement block at the bottom).
//   beforeLaunch: fn    → run just before _launchTeam fires (mobile: close the
//                         sidebar overlay, which the old direct click did).
window._toggleAgentCompose = function(btn, teamKey, opts) {
  opts = opts || {};
  // Toggle closed if this button's compose box is already open. Cards keep the
  // panel as their next sibling; a placement:'above' panel is NOT a sibling, so
  // the live panel is also tracked on the button itself.
  var existing = (btn._composePanel && btn._composePanel.isConnected)
    ? btn._composePanel
    : btn.nextElementSibling;
  if (existing && existing.classList && existing.classList.contains('agent-compose')) {
    existing.remove();
    btn._composePanel = null;
    btn.classList.remove('compose-open');
    return;
  }
  // Close any other open compose boxes first (one at a time).
  var others = document.querySelectorAll('.agent-compose');
  for (var i = 0; i < others.length; i++) others[i].remove();
  var openBtns = document.querySelectorAll('.compose-open');
  for (var j = 0; j < openBtns.length; j++) openBtns[j].classList.remove('compose-open');

  var panel = document.createElement('div');
  panel.className = 'agent-compose agent-' + teamKey;
  var ta = document.createElement('textarea');
  ta.className = 'agent-compose-input';
  ta.rows = 3;
  // JOB 3(a) (2026-07-22): main text + subtext, NO dash/hyphen between them.
  // A newline in the placeholder renders the subtext on its own line.
  ta.placeholder = 'First message (optional)\nsend empty for a bare agent';
  // SELETTORE MODELLO ALLO SPAWN (2026-08-16, round #6) — Super-Agents only.
  // Sits on the action row to the LEFT of Send; the pick applies to the session
  // that is about to be BORN (see _launchTeam), exactly like the topbar chip
  // re-pins an open one. Same families as the chip (Haiku excluded).
  var actions = document.createElement('div');
  actions.className = 'agent-compose-actions';
  // [12/11 ] ogni super agente scelto ha il selettore
  var chosen = (window.SPAWN_MODEL_DEFAULTS || {})[teamKey] || (window.superAgents && window.superAgents[teamKey] && window.superAgents[teamKey].on ? 'opus' : '');
  var picker = null;
  if (chosen) {
    picker = document.createElement('div');
    picker.className = 'agent-compose-model';
    var mbtn = document.createElement('button');
    mbtn.className = 'agent-compose-model-btn';
    mbtn.type = 'button';
    mbtn.title = 'Model for the new session';
    function labelFor(fam) {
      return (typeof window.prettifyModelId === 'function' && window.prettifyModelId(fam)) || fam;
    }
    mbtn.innerHTML = '<span class="acm-label"></span><span class="acm-caret" aria-hidden="true">&#9662;</span>';
    function paint() { mbtn.querySelector('.acm-label').textContent = labelFor(chosen); }
    paint();
    var menu = document.createElement('div');
    menu.className = 'agent-compose-model-menu';
    menu.hidden = true;
    function renderMenu() {
      var fams = window.SELECTABLE_MODEL_FAMILIES || ['fable', 'opus'];
      menu.innerHTML = fams.map(function(f) {
        return '<div class="acm-row" data-model="' + f + '" role="button" tabindex="0">'
          + '<span>' + labelFor(f) + '</span>'
          + (f === chosen ? '<span class="acm-check" aria-hidden="true">&#10003;</span>' : '')
          + '</div>';
      }).join('');
    }
    renderMenu();
    mbtn.onclick = function(e) {
      e.stopPropagation();
      menu.hidden = !menu.hidden;
      if (!menu.hidden) renderMenu();
    };
    menu.onclick = function(e) {
      e.stopPropagation();
      var row = e.target.closest ? e.target.closest('.acm-row') : null;
      if (!row || !row.dataset.model) return;
      chosen = row.dataset.model;
      paint();
      menu.hidden = true;
    };
    picker.appendChild(mbtn);
    picker.appendChild(menu);
    actions.appendChild(picker);
  }
  var send = document.createElement('button');
  send.className = 'agent-compose-send';
  send.type = 'button';
  send.textContent = 'Send';
  function fire() {
    var val = ta.value;
    var model = chosen;
    panel.remove();
    btn._composePanel = null;
    btn.classList.remove('compose-open');
    if (typeof opts.beforeLaunch === 'function') opts.beforeLaunch();
    if (typeof window._launchTeam === 'function') window._launchTeam(teamKey, val, model);
  }
  send.onclick = fire;
  ta.onkeydown = function(e) {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); fire(); }
  };
  panel.appendChild(ta);
  actions.appendChild(send);
  panel.appendChild(actions);
  // PLACEMENT (2026-08-19) — a Fleet card drops its panel DOWN, immediately
  // under itself (unchanged). The New Session button sits at the very bottom of
  // the sidebar, so its panel goes ABOVE it, as the first child of
  // #sidebar-footer: the footer grows upward and #session-list (flex:1,
  // scrollable) yields the space, so the whole panel is on screen BY
  // CONSTRUCTION — no absolute positioning that could spill off the viewport.
  var host = (opts.placement === 'above' && btn.closest) ? btn.closest('#sidebar-footer') : null;
  if (host) {
    panel.classList.add('agent-compose--above');
    host.insertBefore(panel, host.firstChild);
  } else {
    btn.insertAdjacentElement('afterend', panel);
  }
  btn._composePanel = panel;
  btn.classList.add('compose-open');
  // Round 3 (2026-08-16): NO autofocus on touch devices — focusing here popped
  // the keyboard the instant the card was tapped, shoving the whole screen up.
  // On phone the keyboard appears only when the user taps the textarea itself.
  // Desktop (fine pointer) keeps the convenience focus.
  if (!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches)) ta.focus();
};

// Generic one-click skill launcher — opens a fresh blank session and fires an
// arbitrary slash-command. Mirrors the command path of _launchTeam without
// requiring a TEAMS entry.
// [2026-09-10] Il vecchio chiamante (il plugin launch-actions) è stato tolto.
// Questa funzione RESTA perché ha un chiamante vivo: public/js/ui.js:150, le
// voci di tipo "skill" del pannello.
window._launchSkill = async function(command, title) {
  if (!command) return;
  await window.createSession(title || 'Session');
  if (window.activeSessionId && command) {
    await waitForWsReady();
    messageInput.value = command;
    sendMessage();
  }
};

// Resolves when WS is open AND server has responded to join (sync received)
let _syncResolvers = [];
function waitForWsReady() {
  return new Promise(function(resolve) {
    if (ws && ws.readyState === WebSocket.OPEN && wsConnected && _syncResolvers.length === 0) {
      resolve();
      return;
    }
    _syncResolvers.push(resolve);
    setTimeout(function() {
      var idx = _syncResolvers.indexOf(resolve);
      if (idx !== -1) { _syncResolvers.splice(idx, 1); resolve(); }
    }, 5000);
  });
}

window._resolveSyncWaiters = function _resolveSyncWaiters() {
  var resolvers = _syncResolvers.slice();
  _syncResolvers = [];
  resolvers.forEach(function(r) { r(); });
};

// --- Trash (deleted-chat recycle bin) --------------------------------------

function _trashTime(iso) {
  try { return formatRelativeTime(iso); } catch (e) { return ''; }
}

window.openTrash = async function openTrash() {
  var dlg = document.getElementById('trash-dialog');
  if (!dlg) return;
  dlg.classList.add('show');
  document.getElementById('trash-viewer').hidden = true;
  document.getElementById('trash-list').hidden = false;
  await window.renderTrashList();
};

window.closeTrash = function closeTrash() {
  var dlg = document.getElementById('trash-dialog');
  if (dlg) dlg.classList.remove('show');
};

window.renderTrashList = async function renderTrashList() {
  var list = document.getElementById('trash-list');
  if (!list) return;
  list.innerHTML = '<div class="trash-empty">Loading…</div>';
  var items = [];
  try { items = await window.api('GET', '/trash'); } catch (e) { items = []; }
  if (!items || !items.length) {
    list.innerHTML = '<div class="trash-empty">No deleted chats.</div>';
    return;
  }
  // [2026-10-12] Si disegnano le prime TRASH_PRIMA righe; il resto arriva col
  // bottone «Show more» (un cestino di centinaia di chat era un unico innerHTML
  // enorme all'apertura). I bottoni sono legati per delega sulla lista, così
  // valgono anche per le righe aggiunte dopo.
  var TRASH_PRIMA = 50;
  function rigaCestino(t) {
    // Model in the trash. Entries deleted before 2026-08-20 carry no model in
    // their snapshot — it is genuinely unrecoverable (the history messages never
    // held it), so label them instead of silently dropping the pill.
    var tModelId = t.model || '';
    var tModelLabel = tModelId ? (prettifyModelId(tModelId) || tModelId) : 'unknown model';
    var tModelPill = '<span class="trash-item-model' + (tModelId ? '' : ' is-unknown') + '"' +
      ' title="' + escapeHtml(tModelId || 'model not recorded when deleted') + '">' +
      escapeHtml(tModelLabel) + '</span>';
    return '<div class="trash-item" data-id="' + t.id + '">' +
      '<div class="trash-item-info">' +
        '<span class="trash-item-title">' + escapeHtml(t.title || 'Untitled') + '</span>' +
        '<span class="trash-item-meta">' + tModelPill + (t.messageCount || 0) + ' msg · deleted ' + _trashTime(t.deletedAt) + '</span>' +
      '</div>' +
      '<div class="trash-item-actions">' +
        '<button class="trash-view" data-id="' + t.id + '" data-title="' + escapeHtml(t.title || 'Untitled') + '" title="View transcript">View</button>' +
        '<button class="trash-restore" data-id="' + t.id + '" title="Restore chat">Restore</button>' +
        '<button class="trash-purge" data-id="' + t.id + '" title="Delete forever">&times;</button>' +
      '</div>' +
    '</div>';
  }
  list.innerHTML = items.slice(0, TRASH_PRIMA).map(rigaCestino).join('');
  if (items.length > TRASH_PRIMA) {
    var altre = items.slice(TRASH_PRIMA);
    var piu = document.createElement('button');
    piu.className = 'trash-more';
    piu.type = 'button';
    piu.textContent = 'Show more (' + altre.length + ')';
    piu.onclick = function() {
      piu.insertAdjacentHTML('beforebegin', altre.map(rigaCestino).join(''));
      piu.remove();
    };
    list.appendChild(piu);
  }

  list.onclick = function(ev) {
    var b = ev.target && ev.target.closest ? ev.target.closest('button') : null;
    if (!b || !list.contains(b)) return;
    if (b.classList.contains('trash-view')) {
      window.viewTrash(b.dataset.id, b.dataset.title);
    } else if (b.classList.contains('trash-restore')) {
      window.restoreTrash(b.dataset.id);
    } else if (b.classList.contains('trash-purge')) {
      var id = b.dataset.id;
      window.UI.confirm('Delete this chat forever? This cannot be undone.', { okText: 'Delete forever', okVariant: 'danger' })
        .then(function (ok) { if (ok) window.purgeTrash(id); });
    }
  };
};

window.viewTrash = async function viewTrash(id, title) {
  var viewer = document.getElementById('trash-viewer');
  var list = document.getElementById('trash-list');
  var txtEl = document.getElementById('trash-viewer-text');
  var titleEl = document.getElementById('trash-viewer-title');
  try {
    var res = await window.api('GET', '/trash/' + id);
    txtEl.textContent = (res && res.text) || '(empty)';
  } catch (e) {
    txtEl.textContent = '(could not load)';
  }
  titleEl.textContent = title || 'Transcript';
  list.hidden = true;
  viewer.hidden = false;
  var copyBtn = document.getElementById('trash-viewer-copy');
  copyBtn.innerHTML = window.ICON_COPY || 'Copy';
  copyBtn.onclick = function() {
    _copyText(txtEl.textContent, 'Transcript copied');
    _flashCopied(copyBtn);
  };
};

// Green-tick feedback on an icon button, mirroring the message copy buttons.
function _flashCopied(btn) {
  if (!btn) return;
  var idle = window.ICON_COPY || 'Copy';
  btn.innerHTML = window.ICON_CHECK || '✓';
  btn.classList.add('copied');
  setTimeout(function() {
    btn.innerHTML = idle;
    btn.classList.remove('copied');
  }, 1500);
}

window.restoreTrash = async function restoreTrash(id) {
  try {
    var session = await window.api('POST', '/trash/' + id + '/restore');
    if (typeof window.showToast === 'function') window.showToast('Chat restored', 'success');
    await window.loadSessions();
    window.closeTrash();
    if (session && session.id) window.switchSession(session.id);
  } catch (e) {
    if (typeof window.showToast === 'function') window.showToast('Restore failed', 'error');
  }
};

window.purgeTrash = async function purgeTrash(id) {
  try {
    await window.api('DELETE', '/trash/' + id);
    await window.renderTrashList();
  } catch (e) {
    if (typeof window.showToast === 'function') window.showToast('Delete failed', 'error');
  }
};

// --- Copy current conversation ---------------------------------------------

function _copyText(text, okMsg) {
  function done() { if (typeof window.showToast === 'function') window.showToast(okMsg || 'Copied', 'success'); }
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(_fallbackCopy);
    } else { _fallbackCopy(); }
  } catch (e) { _fallbackCopy(); }
  function _fallbackCopy() {
    try {
      var ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      document.execCommand('copy'); document.body.removeChild(ta);
      done();
    } catch (e2) {
      if (typeof window.showToast === 'function') window.showToast('Copy failed', 'error');
    }
  }
}

// [2026-09-22] Tolta window.copyCurrentChat(), un secondo «copia la chat»
// rimasto senza tasto: nessuno la chiamava (cercata in tutto il repo, anche
// negli onclick e in app/) e il #copy-chat-btn che cercava non esiste. Quella
// VIVA e' handleCopyChat() dentro plugins/quick-actions/client.js, appesa alla
// voce `copy-chat` di config.json — formato diverso, e quello che il proprietario vede.

// [2026-10-12] Tolto il pannello «Raccoon findings» del cestino (openRaccoonFindings,
// _raccoonCopyAll e i loro bottoni) insieme alle rotte /api/raccoon/*: Raccoon e'
// fuori dalla flotta dal 2026-08-15 e la sua skill e' archiviata dal 03/10.

(function wireTrashAndCopy() {
  function init() {
    var tb = document.getElementById('trash-btn');
    if (tb) tb.onclick = function() { window.openTrash(); };
    var tc = document.getElementById('trash-close');
    if (tc) tc.onclick = function() { window.closeTrash(); };
    // (Observatory mount removed from the Trash panel 2026-08-20 — the owner.)
    var back = document.getElementById('trash-viewer-back');
    if (back) back.onclick = function() {
      document.getElementById('trash-viewer').hidden = true;
      document.getElementById('trash-list').hidden = false;
    };
    var dlg = document.getElementById('trash-dialog');
    if (dlg) dlg.addEventListener('click', function(e) {
      if (e.target === dlg) window.closeTrash();
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
