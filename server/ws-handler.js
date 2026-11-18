'use strict';

const PING_INTERVAL = 20000;
// BATTERY v9: how long a screen-off native client is left completely alone
// before we spend ONE ping to check it is still there. See the ping timer.
const HIDDEN_LIVENESS_MS = 15 * 60 * 1000;
const restartReadiness = require('./restart-readiness');
const schermoSpento = require('./schermo-spento');
const { createComandoChat, eComando } = require('./comando-chat');

module.exports = function setupWsHandler(wss, deps) {
  const {
    manager, isTokenValid, sendToSession, broadcastSessionStatus,
    addSessionSocket, removeSessionSocket,
    spawnStreamHandler, generateAutoTitleStage1, generateAutoTitleStage2,
    sessionMessageQueue, sessionLastJoin, globalProcessedNonces, globalReplayedSet,
    serverState, SERVER_BOOT,
  } = deps;
  // «!comando» nella chat: lo esegue il PC, non Claude.
  // Finito il comando, Claude risponde da solo se è libero, senza bolla «tu»
  //; l'uscita la mette in testa sendMessage
  // (prendiPerClaude). Se è occupato, la vede al suo prossimo turno.
  const comandoChat = createComandoChat({
    manager, sendToSession,
    risveglia: (sid, testo) => {
      if (manager.isSessionBusy(sid)) return;
      const result = manager.sendMessage(sid, testo, [], { skipUserAppend: true });
      broadcastSessionStatus(sid, 'busy');
      spawnStreamHandler(result.process, sid);
    },
  });

  // [29/10/2026] Il messaggio scritto mentre gli aiutanti lavoravano parte qui,
  // quando il modello ha smesso di parlare (session-manager.deliverWaiting).
  // A modello fermo lo stop non interrompe niente: gli aiutanti restano vivi.
  if (manager && typeof manager.setWaitingDeliverer === 'function') {
    manager.setWaitingDeliverer((sid, { content, attachments, nonce }) => {
      if (manager.isSessionBusy(sid)) {
        // Turno in attesa degli aiutanti (modello fermo): si chiude senza
        // interrompere, e il telefono — che lo stava ancora mostrando — riceve
        // la sua fine, come per un turno finito.
        const buf = manager.streamBuffers && manager.streamBuffers.get(sid);
        const held = (buf && buf.text) || '';
        manager.stopMessage(sid);
        sendToSession(sid, { type: 'done', fullResponse: held });
      }
      const result = manager.sendMessage(sid, content, attachments || [], { nonce: nonce || null });
      broadcastSessionStatus(sid, 'busy');
      spawnStreamHandler(result.process, sid);
    });
  }

  // Un messaggio del proprietario entra in una sessione: dal socket (handleMessage) o
  // dal server stesso (dettatura «Invia mentre registri»: il testo parte
  // anche se il telefono è già chiuso). ws = null → nessun ack, eco a tutti.
  function consegnaMessaggio(sid, msg, ws) {
    if (manager.isSessionBusy(sid) && typeof manager.interjectionMustWait === 'function'
        && manager.interjectionMustWait(sid)) {
      // [29/10/2026] Il modello parla e ci sono aiutanti vivi: niente interruzione.
      // [11/11/2026 ] Prima si aspettava la fine del turno (fino a 98 min, perso al riavvio): ora il
      // messaggio entra nel turno in corso alla prossima pausa (foldUserMessage); la coda resta solo di riserva.
      const piegato = typeof manager.foldUserMessage === 'function'
        && manager.foldUserMessage(sid, { content: msg.content, attachments: msg.attachments || [], nonce: msg.nonce || null });
      if (!piegato) manager.queueWaitingMessage(sid, { content: msg.content, attachments: msg.attachments || [], nonce: msg.nonce || null });
      // [12/11/2026 ] L'ack porta il nonce: il telefono toglie dall'outbox QUEL messaggio.
      if (ws) ws.send(JSON.stringify(piegato ? { type: 'ack', nonce: msg.nonce || null } : { type: 'ack', deferred: true, nonce: msg.nonce || null }));
      sendToSession(sid, {
        type: 'user_message', content: msg.content, attachments: msg.attachments || [],
        nonce: msg.nonce || null, timestamp: Date.now(),
      }, ws ? { exclude: ws } : undefined);
      return 'in-attesa';
    }

    if (manager.isSessionBusy(sid)) {
      console.log('[WS] session busy, auto-stopping before injection for', sid.slice(0, 8));
      try { manager.stopMessage(sid); } catch {}
    }

    let result;
    try {
      if (Array.isArray(msg.attachments) && msg.attachments.length) {
        console.log('[attach-srv] WS received attachments:', JSON.stringify(msg.attachments));
      }
      // [NONCE-PERSIST 2026-08-15] Thread the nonce through so sendMessage can
      // stamp it on the durable history entry (session-manager.js) — the boot
      // reseed in index.js rebuilds globalProcessedNonces from those stamps.
      result = manager.sendMessage(sid, msg.content, msg.attachments || [], { nonce: msg.nonce || null });
    } catch (err) {
      // [12/11 ] la consegna non è partita: il nonce esce dai «visti», così il rinvio del telefono non è scartato come doppione
      if (msg.nonce) globalProcessedNonces.delete(`${sid}:${msg.nonce}`);
      if (ws) ws.send(JSON.stringify({ type: 'error', message: err.message, nonce: msg.nonce || null }));
      else console.error('[WS] consegna dal server fallita per', sid.slice(0, 8), '—', err.message);
      return 'errore';
    }

    try {
      const sessForTitle = manager.sessions.get(sid);
      if (sessForTitle && !sessForTitle.manuallyRenamed && !sessForTitle.autoTitled) {
        const userCount = sessForTitle.history.filter(m => m.role === 'user').length;
        if (userCount === 1) {
          generateAutoTitleStage1(sid).catch(err =>
            console.log('[AUTO-TITLE] stage1 unhandled:', err && err.message));
        } else if (userCount === 2 && sessForTitle.deferredAutoTitle) {
          generateAutoTitleStage2(sid).catch(err =>
            console.log('[AUTO-TITLE] stage2 unhandled:', err && err.message));
        }
      }
    } catch (err) {
      console.log('[AUTO-TITLE] hook error:', err.message);
    }

    if (ws) ws.send(JSON.stringify({ type: 'ack', nonce: msg.nonce || null }));

    sendToSession(sid, {
      type: 'user_message',
      content: msg.content,
      attachments: msg.attachments || [],
      nonce: msg.nonce || null,
      timestamp: Date.now(),
    }, ws ? { exclude: ws } : undefined);

    broadcastSessionStatus(sid, 'busy');
    spawnStreamHandler(result.process, sid);
    return 'mandato';
  }

  wss.on('connection', (ws, req) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const token = url.searchParams.get('token');
    if (!token || !isTokenValid(token)) {
      ws.close(4001, 'Unauthorized');
      return;
    }

    let currentSessionId = null;
    ws.isAlive = true;

    // BATTERY v9 (2026-08-16) — "battito consapevole". A client that has told
    // us its screen is off gets no heartbeat: pinging it every 20s wakes the
    // phone radio 180x/hour all night for nothing (and the WebView answers the
    // pong at PROTOCOL level, so freezing JS timers does not stop it — this
    // half of the loop survived the v8 fix untouched).
    // Only the native app ever sets this (see the `visibility` handler below);
    // PC browsers, the relay and every non-browser client are unaffected.
    ws.isHidden = false;
    ws.hiddenSince = 0;
    ws.hiddenProbePending = false;

    const rateLimitWindow = 60000;
    const rateLimitMax = 10;
    let messageTimestamps = [];

    ws.on('pong', () => { ws.isAlive = true; });

    const pingTimer = setInterval(() => {
      // Sleeping phone: stay silent. We still PUSH real traffic to it (a
      // finished response, a notification) — those are signal and are worth a
      // radio wake. The 20s heartbeat is pure noise and is what cooked the
      // phone in the owner's pocket.
      //
      // We do not go fully silent forever, or a socket that died while we
      // weren't looking would leak for good: every HIDDEN_LIVENESS_MS we send
      // ONE probe and read the answer on the following tick. That is 4 wakes an
      // hour instead of 180 (-97.8%) while still reaping dead sockets.
      if (ws.isHidden) {
        if (ws.hiddenProbePending) {
          ws.hiddenProbePending = false;
          ws.hiddenSince = Date.now();
          if (!ws.isAlive) { ws.terminate(); }
          return;
        }
        if (Date.now() - ws.hiddenSince < HIDDEN_LIVENESS_MS) return;
        ws.isAlive = false;
        ws.hiddenProbePending = true;
        try { ws.ping(); } catch {}
        return;
      }
      if (!ws.isAlive) { ws.terminate(); return; }
      ws.isAlive = false;
      ws.ping();
    }, PING_INTERVAL);

    ws.on('close', () => {
      clearInterval(pingTimer);
      if (currentSessionId) {
        removeSessionSocket(currentSessionId, ws);
      }
      // Restart guard (punto 4): a vanished connection can't be recording.
      try { restartReadiness.dropConnection(ws); } catch {}
    });

    function buildResumePayload(sessionId) {
      const streamState = manager.getStreamState(sessionId);
      const session = manager.get(sessionId);
      const busy = manager.isSessionBusy(sessionId);
      // Detached-runs: stamp the current log seq so the client syncs its lastSeq
      // even on the full-snapshot fallback path (so subsequent reconnects can use
      // the incremental replay). 0/absent when the flag is off — harmless.
      let seq = 0;
      let epoch = null;
      if (process.env.DETACHED_RUNS) {
        try {
          const sl = require('./stream-log');
          seq = sl.currentSeq(sessionId);
          epoch = sl.currentEpoch(sessionId); // seq counter lifetime (ROUND CHAT bug 1)
        } catch {}
      }
      return {
        type: 'resume',
        sessionId,
        streaming: !!busy,
        streamedText: streamState ? streamState.text : '',
        tools: streamState ? streamState.tools : [],
        discarded: (streamState && streamState.discarded) || [],
        history: session ? session.history : [],
        seq,
        epoch,
      };
    }

    // Frame di flusso: ricostruiscono una risposta che, a turno chiuso, è già nella storia.
    const STREAM_FRAME_TYPES = new Set(['delta', 'thinking', 'thinking_start', 'tool_start',
      'tool_progress', 'tool_use', 'tool_done', 'status', 'done', 'model_info', 'stopped', 'redo']);

    function handleJoin(ws, msg) {
      // [12/10/2026] Un join senza sessionId stringa faceva crashare il processo
      // (`.slice` su null, 11 volte in server/logs/crash.log). Si scarta e si dice.
      if (typeof msg.sessionId !== 'string' || !msg.sessionId) {
        console.warn('[WS] join scartato: sessionId mancante o non stringa');
        try { ws.send(JSON.stringify({ type: 'error', message: 'join requires sessionId' })); } catch {}
        return;
      }
      if (currentSessionId && currentSessionId !== msg.sessionId) {
        removeSessionSocket(currentSessionId, ws);
      }
      currentSessionId = msg.sessionId;
      addSessionSocket(currentSessionId, ws);

      const now = Date.now();
      const lastJoin = sessionLastJoin.get(currentSessionId) || 0;
      const isRapidRejoin = (now - lastJoin) < 2000;
      sessionLastJoin.set(currentSessionId, now);
      if (!isRapidRejoin) {
        console.log('[WS] join session:', currentSessionId.slice(0, 8));
      }
      const busy = manager.isSessionBusy(currentSessionId);

      const sessionData = manager.get(currentSessionId);
      ws.send(JSON.stringify({
        type: 'sync',
        status: busy ? 'busy' : 'idle',
        serverBoot: SERVER_BOOT,
        buildHash: serverState.BUILD_HASH,
        codeHash: serverState.CODE_HASH,
        // The client's stale-code reload trigger. DEPLOY_HASH, not CODE_HASH:
        // CODE_HASH tracks the bytes on disk live (asset cache-busting), so
        // sending it here made every file a working session saved reload every
        // open window and the phone. See server/index.js refreshCodeHash SCOPE.
        deployHash: serverState.DEPLOY_HASH,
        contextTokens: sessionData ? sessionData.contextTokens : 0,
      }));

      {
        const session = manager.get(currentSessionId);
        if (session) {
          const clientLen = msg.historyLength || 0;
          if (clientLen < session.history.length) {
            const type = clientLen > 0 ? 'history_append' : 'history';
            const messages = clientLen > 0 ? session.history.slice(clientLen) : session.history;
            ws.send(JSON.stringify({ type, messages }));
          }
        }
      }

      {
        const marker = manager.consumeDeployMarker(currentSessionId);
        if (marker) {
          ws.send(JSON.stringify({ type: 'deploy_marker', session_id: currentSessionId, marker }));
        }
      }

      let queued = sessionMessageQueue.get(currentSessionId);
      // [2026-10-01] IL DOPPIONE AL RIENTRO (screenshot del proprietario, sessione
      // 0b4ab613, 13:56): sessione FINITA mentre il proprietario era altrove → qui sopra
      // parte la storia, che CONTIENE GIÀ la risposta chiusa, e poi la coda
      // rigiocava gli stessi delta + done → il client disegnava la stessa
      // risposta due volte (sparisce riaprendo, perché lì vince la storia).
      // Sessione non occupata = la storia è la verità: dalla coda si tolgono
      // i pezzi di flusso; restano solo i frame che la storia non porta (errori…).
      if (!busy && queued && queued.length) {
        const before = queued.length;
        queued = queued.filter((m) => !(m && STREAM_FRAME_TYPES.has(m.type)));
        if (before !== queued.length) {
          console.log(`[WS] coda di ${currentSessionId.slice(0, 8)}: ${before - queued.length} pezzi di flusso già nella storia, scartati`);
        }
      }
      if (queued && queued.length > 0) {
        console.log(`[WS] Flushing ${queued.length} queued messages for ${currentSessionId.slice(0, 8)}`);
        try {
          ws.send(JSON.stringify({ type: 'queued_messages', sessionId: currentSessionId, messages: queued }));
        } catch {}
      }
      sessionMessageQueue.delete(currentSessionId);

      // (Lab pending-review delivery on rejoin removed 2026-08-20 — the Lab app
      //  and its store are gone.)

      if (busy) {
        // Detached-runs: the client pairs every join with a `get_stream_state`
        // (onopen + every reconnect/visibility path), which carries lastSeq and
        // is the authoritative resume path when the flag is on. Sending the tail
        // snapshot here too would double-render against the seq replay, so skip
        // it and let get_stream_state reconcile. Off-flag = unchanged behaviour.
        if (!process.env.DETACHED_RUNS) {
          ws.send(JSON.stringify(buildResumePayload(currentSessionId)));
        }
        sessionMessageQueue.delete(currentSessionId);
      }

      try {
        const { maybeReplaySession } = require('./session-host-replay');
        const { getClient } = require('./session-host-client');
        maybeReplaySession(currentSessionId, {
          manager, client: getClient(), spawnStreamHandler,
          replayedSet: globalReplayedSet, logger: console,
        }).catch((err) => console.error('[replay] join-hook failed:', err.message));
      } catch (err) { console.error('[replay] require failed:', err.message); }
    }

    function handleStop(ws, msg) {
      // ROUND CHAT bug 4 (2026-08-16): the old handler was a silent black hole —
      // no log, errors swallowed, and a TOTAL no-op (no reply at all) when the
      // socket had no joined session. Now: always log, always answer, and tell
      // the client whether anything was actually stopped so it can show truth.
      if (!currentSessionId) {
        console.warn('[WS] stop received with no joined session — nothing to stop');
        try { ws.send(JSON.stringify({ type: 'stopped', stopped: false, reason: 'no-session' })); } catch {}
        return;
      }
      let stopped = false;
      let reason = null;
      try {
        // [17/10/2026] Solo il tasto rosso (source:'button') ferma anche i
        // lavori in sottofondo; lo stop di un messaggio scritto no.
        const stopBackground = !!(msg && msg.source === 'button');
        // [29/10/2026] Scrivere mentre il modello parla con aiutanti vivi: niente
        // stop (l'interrupt del CLI li ucciderebbe), il messaggio aspetta.
        if (!stopBackground && typeof manager.interjectionMustWait === 'function'
            && manager.interjectionMustWait(currentSessionId)) {
          console.log('[WS] stop for session:', currentSessionId.slice(0, 8), '— aiutanti vivi: niente interruzione, il messaggio aspetta');
          try { ws.send(JSON.stringify({ type: 'stopped', sessionId: currentSessionId, stopped: false, deferred: true })); } catch {}
          return;
        }
        stopped = manager.stopMessage(currentSessionId, { stopBackground }) !== false;
      } catch (err) {
        reason = err.message;
        console.error('[WS] stop failed for', currentSessionId.slice(0, 8), '—', err.message);
      }
      console.log('[WS] stop for session:', currentSessionId.slice(0, 8), '— stopped:', stopped);
      try { ws.send(JSON.stringify({ type: 'stopped', sessionId: currentSessionId, stopped, reason })); } catch {}
    }

    function handleMessage(ws, msg) {
      if (!currentSessionId) return;

      const nonceKey = msg.nonce ? `${currentSessionId}:${msg.nonce}` : null;
      if (nonceKey && globalProcessedNonces.has(nonceKey)) {
        // [12/11/2026 ] Il doppione dice QUALE messaggio (nonce) e se c'è un
        // turno in corso: a sessione ferma il telefono non resta appeso in «busy».
        console.log('[WS] duplicate nonce', msg.nonce.slice(0, 8), '— skipping');
        ws.send(JSON.stringify({ type: 'ack', nonce: msg.nonce, duplicate: true, busy: !!manager.isSessionBusy(currentSessionId) }));
        return;
      }

      console.log('[WS] message for session:', currentSessionId.slice(0, 8));

      const now = Date.now();
      messageTimestamps = messageTimestamps.filter(t => now - t < rateLimitWindow);
      if (messageTimestamps.length >= rateLimitMax) {
        // [12/11/2026 ] Il rifiuto si scrive nel log e porta il nonce; il nonce
        // NON entra fra i «visti», così il rinvio dello stesso messaggio passa.
        console.warn('[WS] rate limit: messaggio rifiutato, sessione', currentSessionId.slice(0, 8),
          'nonce', msg.nonce ? String(msg.nonce).slice(0, 8) : '-');
        ws.send(JSON.stringify({ type: 'error', message: 'Rate limit exceeded — max 10 messages per minute', nonce: msg.nonce || null }));
        return;
      }
      messageTimestamps.push(now);

      // Il nonce si registra solo qui, a messaggio accettato.
      if (nonceKey) {
        globalProcessedNonces.add(nonceKey);
        if (globalProcessedNonces.size > 2000) {
          const first = globalProcessedNonces.values().next().value;
          globalProcessedNonces.delete(first);
        }
      }

      // «!ls ~/Downloads»: un comando per il PC, non un messaggio per Claude.
      if (eComando(msg.content) && !(Array.isArray(msg.attachments) && msg.attachments.length)) {
        comandoChat.esegui({ ws, sessionId: currentSessionId, testo: msg.content.trim(), nonce: msg.nonce || null })
          .catch((e) => console.error('[COMANDO] errore:', e && e.message));
        return;
      }

      consegnaMessaggio(currentSessionId, msg, ws);
    }

    const wsHandlers = {
      join: (ws, msg) => handleJoin(ws, msg),
      ping: (ws) => ws.send(JSON.stringify({ type: 'pong' })),
      // BATTERY v9 (2026-08-16) — the client reports screen on/off. Sent from
      // the visibilitychange listener in public/js/ws.js, which fires BEFORE
      // MainActivity.onPause freezes the JS timers, so the message always makes
      // it out before the app goes quiet.
      //
      // HARD GATE: we only honour this from a client that declares itself the
      // native app (`native: true`). A PC browser tab going hidden, the Pi
      // relay, and any non-browser client never send it — their heartbeat stays
      // exactly as it was. Do not relax this: those links must stay warm.
      visibility: (ws, msg) => {
        if (!msg || msg.native !== true) return;
        const hidden = !!msg.hidden;
        if (hidden === ws.isHidden) return;
        ws.isHidden = hidden;
        ws.hiddenSince = hidden ? Date.now() : 0;
        // [10/11/2026 ] Da qui parte l'orologio di sicurezza dei pezzi
        // trattenuti (server/schermo-spento.js, LIBERA_DOPO_MS).
        if (!hidden) schermoSpento.tornatoVisibile(ws);
        ws.hiddenProbePending = false;
        // Clear any half-finished reap cycle in BOTH directions, so waking up
        // can never be mistaken for a dead socket on the very next tick.
        ws.isAlive = true;
      },
      get_stream_state: (ws, msg) => {
        const sid = msg && msg.sessionId;
        if (!sid) {
          try { ws.send(JSON.stringify({ type: 'error', message: 'get_stream_state requires sessionId' })); } catch {}
          return;
        }
        if (sid !== currentSessionId) {
          try { ws.send(JSON.stringify({ type: 'error', message: 'not joined to session' })); } catch {}
          return;
        }
        // [10/11/2026 ] Il telefono chiede cosa ha perso: da qui in poi i
        // pezzi gli arrivano dal vivo. Prima del replay, nello stesso giro: un
        // pezzo nuovo non può infilarsi in mezzo (server/schermo-spento.js, 3).
        schermoSpento.libera(ws, sid);
        // Detached-runs: replay ONLY the events the client missed (seq > lastSeq),
        // ordered + additive. If the client's lastSeq predates the retained ring
        // (a gap) or there's no log, fall back to the full tail snapshot. The
        // replayed batch carries the terminal `done`/`error` when the turn has
        // finished → the spinner clears deterministically even if the inline
        // `done` was dropped by a relay HTTP timeout on the phone path.
        if (process.env.DETACHED_RUNS) {
          try {
            // Pass the client's known epoch: a mismatch means its lastSeq is
            // from a dead counter — replaySince then treats it as 0 (bug 1).
            const r = require('./stream-log').replaySince(sid, msg.lastSeq || 0, (msg.epoch != null ? msg.epoch : null));
            if (r && r.ok) {
              ws.send(JSON.stringify({ type: 'replay', sessionId: sid, events: r.events, seq: r.seq, epoch: (r.epoch != null ? r.epoch : null) }));
              return;
            }
          } catch (err) {
            console.error('[detached] replaySince failed:', err.message);
          }
        }
        try { ws.send(JSON.stringify(buildResumePayload(sid))); } catch {}
      },
      stop: (ws, msg) => handleStop(ws, msg),
      message: (ws, msg) => handleMessage(ws, msg),
      // [READ-SYNC 2026-08-15] A device just read this session (its local
      // "risposta pronta" dot was cleared). Rebroadcast to ALL connected
      // clients — same fanout as broadcastSessionStatus (index.js:2127), and
      // the Pi's proxied phone sockets are members of this wss too. No
      // server-side persistence (durable read-state is a future step); no echo
      // loop: receiving clients only clear local state, they never re-send.
      session_read: (ws, msg) => {
        const sid = msg && msg.sessionId;
        if (!sid || typeof sid !== 'string') return;
        // [11/10/2026] Il server se lo ricorda (readAt): chi era spento lo legge
        // da /api/sessions al ritorno. Mai un errore che fermi la ripetizione.
        try { manager.markRead(sid); } catch {}
        const payload = JSON.stringify({ type: 'session_read', sessionId: sid });
        wss.clients.forEach((client) => {
          if (client.readyState === 1) {
            try { client.send(payload); } catch {}
          }
        });
      },
      // (Ponte WebSocket della dettatura — dictation_start/stop e frame binari —
      //  tolto il 12/10/2026: la dettatura passa da POST /api/dictation/transcribe.
      //  Un `dictation_stop` che il client manda ancora cade nel vuoto, innocuo.)
      // Restart guard (2026-08-16, punto 4): the client flags "I am recording a
      // voice note right now" (true on start + 30s heartbeat, false on stop).
      // Deploy/restart funnels wait for this to clear so a bounce never kills a
      // recording mid-take. See server/restart-readiness.js.
      dictation_state: (ws, msg) => {
        try { restartReadiness.noteRecording(ws, !!(msg && msg.active)); } catch {}
      },
    };

    ws.on('message', (raw, isBinary) => {
      if (isBinary) return;
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      // [12/10/2026] Un frame `null` (o non oggetto) faceva crashare il processo.
      if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return;
      if (typeof msg.type !== 'string' || !Object.prototype.hasOwnProperty.call(wsHandlers, msg.type)) return;
      // Un gestore che lancia logga e basta: un frame storto non deve mai far
      // cadere il processo (uncaughtException → riavvio).
      try { wsHandlers[msg.type](ws, msg); }
      catch (err) { console.error('[WS] gestore', msg.type, 'fallito:', err && err.message); }
    });
  });

  // : consegna dal server, una volta sola per nonce (lo stesso registro
  // dei messaggi dal telefono, ricostruito dalla storia a ogni avvio).
  function consegnaDalServer(sid, content, nonce) {
    if (!sid || !manager.sessions.has(sid)) return 'sessione-sparita';
    if (nonce) {
      const key = `${sid}:${nonce}`;
      if (globalProcessedNonces.has(key)) return 'doppione';
      globalProcessedNonces.add(key);
      if (globalProcessedNonces.size > 2000) {
        globalProcessedNonces.delete(globalProcessedNonces.values().next().value);
      }
    }
    return consegnaMessaggio(sid, { content, attachments: [], nonce: nonce || null }, null);
  }

  return { consegnaDalServer };
};
