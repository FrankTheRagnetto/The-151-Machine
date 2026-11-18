/* The 151 Machine — Dictation
 *
 * Primary path (Android/iOS): native Capacitor VoiceRecorder plugin.
 *   tap → requestAudioRecordingPermission + startRecording (+ Android audio focus)
 *   tap again → stopRecording → base64 → ArrayBuffer → single WS binary frame
 *   Server decodes container (aac/m4a/webm) via ffmpeg autodetect.
 *
 * Fallback path (browser / no plugin): legacy getUserMedia + MediaRecorder
 *   streaming webm/opus chunks every 500ms over WS.
 *
 * Protocol (unchanged):
 *   → {type:'dictation_start', language:'auto', format:'webm'|'aac'}
 *   → binary audio frames
 *   → {type:'dictation_stop'}
 *   ← {type:'dictation_ready'|'dictation_partial'|'dictation_final'|'dictation_error'}
 *
 * Tap-to-toggle only. Single onClick handler. No hold.
 * No waveform/pulse — red button is the only visual feedback.
 */
(function() {
  'use strict';

  var micBtn       = document.getElementById('mic-btn');
  var messageInput = document.getElementById('message-input');
  var sendBtn      = document.getElementById('send-btn-new');
  var inputRow     = document.getElementById('input-row');
  if (!micBtn || !messageInput || !sendBtn || !inputRow) return;

  var LOG = function() {
    try { console.log.apply(console, ['[dictation]'].concat([].slice.call(arguments))); } catch(e) {}
  };

  // --- State ---
  var state = 'idle'; // idle | starting | recording | stopping
  var mode  = null;   // 'native' | 'webview'
  var mediaStream = null;
  var recorder = null;
  var recordedChunks = [];   // webview: full clip collected locally, shipped on stop
  var sessionIdRemote = null;
  var maxDurationTimer = null;

  // Never-lose-audio state: the last recorded clip survives timeout/error so
  // the owner can retry (or grab the saved file) instead of re-recording 15+ min.
  var lastClipBlob = null;   // Blob of the last shipped clip; cleared only on a real final
  var lastClipFmt  = 'webm';
  var recordStartTs = 0;     // wall-clock start of the current recording (for duration)
  var progressTimer = null;  // ticks real elapsed-time feedback during transcription
  var autoRetried = false;   // gate: on a transport drop, re-ship the buffered clip at most once
  var startSessionId = null; // : la sessione dove la presa è cominciata
  var invioWebview = null;   // : «Invia» premuto sulla presa del browser (shipWebviewClip lo legge)

  // Safety ceiling on a single recording (NOT an artificial limit). the owner wants no
  // duration limit — up to ~1h in one shot. This only guards a mic left recording
  // by accident; at the ceiling we stop and transcribe (never discard the audio).
  var MAX_RECORDING_MS = 60 * 60 * 1000;

  // Quanto aspettare una singola POST prima di considerarla morta.
  // MISURATO sui log veri di whisper (2383 passaggi, 2026-08-14→22): mediana
  // 0.125x realtime, p95 0.394x, PEGGIORE ASSOLUTO 1.84x e 108s in valore
  // assoluto. Il vecchio pavimento di 30 minuti era ~300x il caso peggiore mai
  // visto: nessun errore veniva mai dichiarato, e la rotella girava all'infinito
  // mentre il testo era già pronto sul PC. Ora: 90s di pavimento + 3x la durata
  // reale del clip — comunque il doppio abbondante del peggior caso misurato.
  var TRANSCRIBE_MIN_WAIT_MS = 90 * 1000;
  var TRANSCRIBE_WAIT_FACTOR = 3;
  function transcribeWaitMs(durationMs) {
    var d = (typeof durationMs === 'number' && durationMs > 0) ? durationMs : 0;
    return Math.max(TRANSCRIBE_MIN_WAIT_MS, Math.round(d * TRANSCRIBE_WAIT_FACTOR));
  }

  // --- Consegna recuperabile (2026-08-22) ------------------------------------
  // Il testo non viaggia più su una sola risposta HTTP. Ogni clip ha un id; il
  // server deposita il risultato con quella chiave e il client se lo va a
  // prendere (GET /api/dictation/result/<id>) in parallelo alla POST, dopo un
  // fallimento, e persino al riavvio dell'app. Se la POST muore per strada
  // (telefono in standby, cambio rete, WebView congelata) la consegna è solo
  // rimandata, non persa.
  var PENDING_KEY = '151_dictation_pending';
  function newClipId() {
    var r = '';
    try {
      if (window.crypto && window.crypto.getRandomValues) {
        var a = new Uint8Array(12);
        window.crypto.getRandomValues(a);
        for (var i = 0; i < a.length; i++) r += ('0' + a[i].toString(16)).slice(-2);
      }
    } catch (e) {}
    if (!r) r = String(Date.now()) + Math.random().toString(36).slice(2, 10);
    return 'c' + r;
  }
  function rememberPending(clipId) {
    try { localStorage.setItem(PENDING_KEY, JSON.stringify({ clipId: clipId, at: Date.now() })); } catch (e) {}
  }
  function forgetPending() {
    try { localStorage.removeItem(PENDING_KEY); } catch (e) {}
  }
  function fetchClipResult(clipId) {
    var base = (typeof window.getServerUrl === 'function') ? (window.getServerUrl() || '') : '';
    var headers = {};
    if (window.authToken) headers['Authorization'] = 'Bearer ' + window.authToken;
    return fetch(base + '/api/dictation/result/' + encodeURIComponent(clipId), { headers: headers })
      .then(function(res) {
        if (res.status === 404) return null;      // non ancora pronto
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function(j) {
        return (j && j.status === 'done' && typeof j.text === 'string') ? j.text : null;
      });
  }

  function startMaxDurationTimer() {
    recordStartTs = Date.now();
    if (maxDurationTimer) clearTimeout(maxDurationTimer);
    maxDurationTimer = setTimeout(function() {
      if (state === 'recording' || state === 'starting') {
        toast('1h limit — stopping & transcribing', 'info');
        stopDictation();
      }
    }, MAX_RECORDING_MS);
  }
  function clearMaxDurationTimer() {
    if (maxDurationTimer) { clearTimeout(maxDurationTimer); maxDurationTimer = null; }
  }

  // --- Never lose the audio ---------------------------------------------------
  // Persist the recorded clip to disk so a timeout/error NEVER loses it. On PC
  // (webview) this triggers a plain browser download; the owner keeps the file and can
  // re-run it via Dictation.retry() or re-attach it.
  function saveClipToDisk(reason) {
    if (!lastClipBlob || !lastClipBlob.size) return false;
    try {
      var ext = (lastClipFmt === 'm4a' || lastClipFmt === 'mp4') ? 'm4a'
              : (lastClipFmt === 'ogg' ? 'ogg'
              : (lastClipFmt === 'aac' ? 'aac' : 'webm'));
      var ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      var name = 'dictation-' + ts + '.' + ext;
      var url = URL.createObjectURL(lastClipBlob);
      var a = document.createElement('a');
      a.href = url; a.download = name;
      document.body.appendChild(a); a.click();
      setTimeout(function() {
        try { document.body.removeChild(a); URL.revokeObjectURL(url); } catch(e) {}
      }, 2000);
      LOG('clip saved to disk', name, reason || '');
      return true;
    } catch(e) {
      LOG('saveClipToDisk failed', e);
      return false;
    }
  }

  // Progress feedback lives on the mic button itself (inline pulse), NOT a black
  // toast that flickered every few seconds ("Trascrizione… -1 min"). While whisper
  // works, the button carries a 'transcribing' class; CSS animates a calm pulse.
  function setMicTranscribing(on) {
    if (!micBtn) return;
    if (on) {
      micBtn.classList.remove('recording', 'starting');
      micBtn.classList.add('transcribing');
      micBtn.title = 'Transcribing…';
    } else {
      micBtn.classList.remove('transcribing');
      micBtn.title = 'Voice input';
    }
  }
  // Back-compat no-ops (old callers removed; kept so nothing throws if referenced).
  function stopProgressTicker() {
    if (progressTimer) { clearInterval(progressTimer); progressTimer = null; }
  }

  // Ship one blob to whisper via HTTP POST (NOT the chat /ws socket). The old path
  // sent the audio as a WS binary frame on window.ws — the same socket chat uses
  // through phone→Pi→PC, so a socket hiccup broke chat AND dictation and silently
  // dropped 10-15 min of audio. HTTP POST is independent of that socket and retries
  // on failure. One clip = one POST = one whisper pass (no chunking). The recorded
  // blob is retained (lastClipBlob) so a total failure still saves to disk — never lost.
  var currentClipId = null;   // id della clip in volo (stabile fra i ritenti)
  var clipSettled   = true;   // gate: la clip corrente è già stata consegnata?
  var pollTimer     = null;

  function stopClipPolling() {
    if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
  }

  // Consegna: UNICO punto di atterraggio del testo, chiunque lo porti (la
  // risposta della POST o il ritiro per id). Il gate impedisce il doppio incollo.
  function deliverText(text, via) {
    if (clipSettled) return;
    clipSettled = true;
    stopClipPolling();
    forgetPending();
    LOG('consegnato via', via, 'chars', (text || '').length);
    // Arrivo in ritardo (avevamo già rimesso il pulsante a riposo): i vecchi
    // segnaposto nel campo di testo non valgono più — si scrive al cursore.
    if (state === 'idle') resetPartialMarkersToCaret();
    commitFinal(text || '');
    lastClipBlob = null;
    setMicTranscribing(false);
    finalizeStop();
  }

  // Ritiro periodico in parallelo alla POST. È questo che salva la consegna
  // quando il socket muore in silenzio: la POST può non rispondere mai, il
  // ritiro atterra appena la rete/WebView tornano vive.
  function startClipPolling(clipId, firstDelayMs, deadlineTs) {
    stopClipPolling();
    function tick() {
      if (clipSettled) return;
      if (Date.now() > deadlineTs) { stopClipPolling(); return; }
      fetchClipResult(clipId).then(function(text) {
        if (text === null) { pollTimer = setTimeout(tick, 8000); return; }
        deliverText(text, 'ritiro-per-id');
      }).catch(function() {
        pollTimer = setTimeout(tick, 8000);
      });
    }
    pollTimer = setTimeout(tick, firstDelayMs);
  }

  function sendClip(blob, fmt, durationMs, invio) {
    if (!blob || !blob.size) { toast('No audio captured', 'error'); finalizeStop(); return; }
    if (invio) { inviaDaSolo(blob, fmt, durationMs, invio); return; }
    lastClipBlob = blob;
    lastClipFmt  = fmt;
    state = 'stopping';
    clipSettled = false;
    currentClipId = newClipId();
    rememberPending(currentClipId);
    setMicTranscribing(true);
    // Il ritiro parte in parallelo: primo colpo a 15s, poi ogni 8s, con una
    // scadenza generosa legata alla durata reale del clip.
    startClipPolling(currentClipId, 15000, Date.now() + Math.max(10 * 60 * 1000, (durationMs || 0) * 6));
    postClipHttp(blob, fmt, durationMs, 0);
  }

  // Map our fmt to a filename extension (whisper sniffs the container from bytes,
  // but a sane name keeps logs readable).
  function fmtExt(fmt) {
    if (fmt === 'm4a' || fmt === 'mp4') return 'm4a';
    if (fmt === 'ogg') return 'ogg';
    if (fmt === 'aac') return 'aac';
    return 'webm';
  }

  // POST the clip to the server's HTTP transcription endpoint with automatic retry
  // (3 attempts, exponential backoff). Independent of the chat socket. On the phone
  // the server proxies this to the PC where whisper runs.
  function postClipHttp(blob, fmt, durationMs, attempt) {
    var MAX_ATTEMPTS = 3;
    var base = (typeof window.getServerUrl === 'function') ? (window.getServerUrl() || '') : '';
    var form = new FormData();
    form.append('file', blob, 'dictation.' + fmtExt(fmt));

    var ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    // Generous ceiling derived from the clip's real duration (whisper on CPU is
    // slower than realtime). Only aborts a genuinely hung request.
    var waitMs = transcribeWaitMs(durationMs);
    var timer = setTimeout(function() { try { ctrl && ctrl.abort(); } catch(e) {} }, waitMs);
    LOG('http transcribe attempt', attempt + 1, 'wait', Math.round(waitMs / 1000) + 's');

    var headers = {};
    if (window.authToken) headers['Authorization'] = 'Bearer ' + window.authToken;

    fetch(base + '/api/dictation/transcribe?language=auto&clipId=' + encodeURIComponent(currentClipId || ''), {
      method: 'POST',
      body: form,
      headers: headers,
      signal: ctrl ? ctrl.signal : undefined,
    }).then(function(res) {
      clearTimeout(timer);
      if (!res.ok) {
        return res.text().then(function(t) { throw new Error('HTTP ' + res.status + ' ' + t.slice(0, 120)); });
      }
      return res.json();
    }).then(function(json) {
      // One-line success telemetry: confirm dictation now lands on attempt 1
      // (zero retries). If this ever logs attempt 2+, the model went cold again.
      LOG('transcribe OK on attempt', attempt + 1, 'of', MAX_ATTEMPTS, '(0 = first-try win)');
      deliverText((json && typeof json.text === 'string') ? json.text : '', 'risposta-post');
    }).catch(function(err) {
      clearTimeout(timer);
      if (clipSettled) return;   // il ritiro per id ha già consegnato: silenzio
      console.warn('[dictation] http transcribe failed', attempt + 1, err && err.message);
      // Prima di ricaricare l'audio: il testo potrebbe essere GIÀ pronto sul PC
      // e solo la risposta essersi persa. Chiedere l'id costa nulla ed evita una
      // seconda trascrizione completa.
      var clipId = currentClipId;
      var afterCheck = function() {
        if (clipSettled) return;
        if (attempt + 1 < MAX_ATTEMPTS) {
          var backoff = 800 * Math.pow(2, attempt); // 0.8s, 1.6s
          toast('Retrying transcription…', 'warning');
          setTimeout(function() { if (!clipSettled) postClipHttp(blob, fmt, durationMs, attempt + 1); }, backoff);
          return;
        }
        // Finiti i ritenti la clip NON viene abbandonata: il ritiro per id resta
        // acceso fino alla sua scadenza (l'audio è già dal server, il testo
        // arriverà appena la rete regge). L'audio locale resta salvato.
        saveClipToDisk('http-failed');
        toast('Transcription delayed — still listening, audio saved', 'warning');
        // Il pulsante torna a riposo,
        // ma il ritiro per id resta acceso: se il testo arriva dopo, atterra.
        setMicTranscribing(false);
        finalizeStop();
      };
      if (clipId) fetchClipResult(clipId).then(function(text) {
        if (text !== null) deliverText(text, 'ritiro-dopo-errore');
        else afterCheck();
      }).catch(afterCheck);
      else afterCheck();
    });
  }

  // --- «Invia mentre registri» -------------------------
  // Invia durante la presa = l'audio si trascrive e parte DA SOLO nella sessione
  // dove la presa è cominciata; il proprietario può uscire dalla sessione o chiudere l'app.
  // Il microfono resta com'era: il testo va nel campo della sessione aperta.
  // La consegna la fa il server (server/dettatura-invio.js): qui si carica
  // l'audio e basta. Finché il server non dice «fatta», la clip resta salvata
  // sul telefono (IndexedDB): se l'app muore durante il caricamento, alla
  // riapertura riparte da sola. Una volta sola: stesso clipId = nessun doppione.
  var INVII_DB = '151-dettatura-invii';
  var INVII_STORE = 'invii';
  var INVII_MAX_TENTATIVI = 5;
  var invii = {};            // clipId → vivo in questa pagina (carica o aspetta)

  function inviiDb() {
    return new Promise(function(resolve, reject) {
      if (!window.indexedDB) { reject(new Error('IndexedDB assente')); return; }
      var r = window.indexedDB.open(INVII_DB, 1);
      r.onupgradeneeded = function() { r.result.createObjectStore(INVII_STORE, { keyPath: 'clipId' }); };
      r.onsuccess = function() { resolve(r.result); };
      r.onerror = function() { reject(r.error); };
    });
  }
  function inviiOp(modo, fn) {
    return inviiDb().then(function(db) {
      return new Promise(function(resolve, reject) {
        var tx = db.transaction(INVII_STORE, modo);
        var req = fn(tx.objectStore(INVII_STORE));
        tx.oncomplete = function() { db.close(); resolve(req ? req.result : undefined); };
        tx.onerror = tx.onabort = function() { db.close(); reject(tx.error); };
      });
    });
  }
  function inviiSalva(rec) { return inviiOp('readwrite', function(st) { return st.put(rec); }); }
  function inviiTogli(clipId) { return inviiOp('readwrite', function(st) { return st['delete'](clipId); }).catch(function() {}); }
  function inviiTutti() { return inviiOp('readonly', function(st) { return st.getAll(); }); }

  function leggiRisultatoInvio(clipId) {
    var base = (typeof window.getServerUrl === 'function') ? (window.getServerUrl() || '') : '';
    var headers = {};
    if (window.authToken) headers['Authorization'] = 'Bearer ' + window.authToken;
    return fetch(base + '/api/dictation/result/' + encodeURIComponent(clipId), { headers: headers })
      .then(function(res) {
        if (res.status === 404) return null;
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function(j) { return (j && j.status === 'done') ? j : null; });
  }

  // Il tasto Invia premuto durante la presa.
  function inviaMentreRegistri() {
    var sid = startSessionId || window.activeSessionId || null;
    if (!sid) { stopDictation(); return; }   // nessuna sessione: come il microfono
    // Il testo già scritto nel campo della STESSA sessione parte insieme al vocale.
    var prefisso = '';
    if (window.activeSessionId === sid && messageInput.value.trim()) {
      prefisso = messageInput.value.trim();
      messageInput.value = '';
      resetPartialMarkersToCaret();
      setHasText();
    }
    if (typeof window.haptic === 'function') window.haptic(10);
    LOG('invia mentre registri -> sessione', String(sid).slice(0, 8), 'prefisso', prefisso.length);
    stopDictation({ sessionId: sid, prefix: prefisso });
  }

  function inviaDaSolo(blob, fmt, durationMs, invio) {
    var rec = {
      clipId: newClipId(), sessionId: invio.sessionId, prefix: invio.prefix || '',
      blob: blob, fmt: fmt, durationMs: durationMs || 0, at: Date.now(), tentativi: 1
    };
    invii[rec.clipId] = true;
    // Il microfono torna libero subito: il resto non ha più bisogno della pagina.
    finalizeStop();
    toast('Transcribing — it will send itself', 'info');
    inviiSalva(rec).catch(function(e) { LOG('invio: copia sul telefono non salvata', e && e.message); })
      .then(function() { caricaInvio(rec, 0); });
  }

  function caricaInvio(rec, attempt) {
    var MAX = 3;
    var base = (typeof window.getServerUrl === 'function') ? (window.getServerUrl() || '') : '';
    var form = new FormData();
    form.append('prefix', rec.prefix || '');
    form.append('file', rec.blob, 'dictation.' + fmtExt(rec.fmt));
    var headers = {};
    if (window.authToken) headers['Authorization'] = 'Bearer ' + window.authToken;
    var url = base + '/api/dictation/transcribe?language=auto&clipId=' + encodeURIComponent(rec.clipId) +
      '&sendTo=' + encodeURIComponent(rec.sessionId);
    fetch(url, { method: 'POST', body: form, headers: headers }).then(function(res) {
      if (res.status === 202) return res.json();
      return res.text().then(function(t) {
        var e = new Error('HTTP ' + res.status + ' ' + t.slice(0, 120));
        e.definitivo = (res.status === 400 || res.status === 413);
        throw e;
      });
    }).then(function(j) {
      LOG('invio accettato', rec.clipId, j && j.state);
      seguiInvio(rec);
    }).catch(function(err) {
      LOG('invio: caricamento fallito', attempt + 1, err && err.message);
      if (err && err.definitivo) {
        delete invii[rec.clipId];
        inviiTogli(rec.clipId);
        toast('Voice message not sent: ' + err.message, 'error');
        return;
      }
      if (attempt + 1 < MAX) {
        setTimeout(function() { caricaInvio(rec, attempt + 1); }, 800 * Math.pow(2, attempt));
        return;
      }
      // Resta salvato sul telefono: riparte alla prossima apertura dell'app.
      delete invii[rec.clipId];
      toast('PC not reachable — the voice message will send when it is', 'warning');
    });
  }

  // Dopo «accettata» il messaggio è affare del server: si chiede solo quando
  // cancellare la copia sul telefono, e SOLO a schermo acceso (batteria): a
  // schermo spento si smette, e al ritorno ci pensa riprendiInvii.
  function seguiInvio(rec) {
    var scade = Date.now() + Math.max(10 * 60 * 1000, (rec.durationMs || 0) * 6);
    function ritiroInvio() {
      if (Date.now() > scade || document.hidden) { delete invii[rec.clipId]; return; }
      leggiRisultatoInvio(rec.clipId).then(function(j) {
        if (!j) { setTimeout(ritiroInvio, 8000); return; }
        chiudiInvio(rec, j);
      }).catch(function() { setTimeout(ritiroInvio, 8000); });
    }
    setTimeout(ritiroInvio, 5000);
  }

  function chiudiInvio(rec, j) {
    delete invii[rec.clipId];
    inviiTogli(rec.clipId);
    if (j.sent === false && j.text) {
      // La sessione non c'è più: il testo non si perde, va nel campo.
      resetPartialMarkersToCaret();
      commitFinal(unisciTesto(rec.prefix, j.text));
      toast('That chat is gone — the text is in the box', 'warning');
    }
    LOG('invio chiuso', rec.clipId, 'sent', j.sent);
  }
  function unisciTesto(a, b) {
    a = String(a || '').trim(); b = String(b || '').trim();
    return (a && b) ? (a + ' ' + b) : (a || b);
  }

  // Alla riapertura (e al ritorno in primo piano): le clip rimaste a metà.
  var riprendendo = false;
  function riprendiInvii() {
    if (riprendendo || !window.authToken) return;
    riprendendo = true;
    inviiTutti().then(function(lista) {
      (lista || []).forEach(function(rec) {
        if (!rec || !rec.clipId || invii[rec.clipId]) return;
        if (Date.now() - (rec.at || 0) > 24 * 60 * 60 * 1000 || (rec.tentativi || 0) >= INVII_MAX_TENTATIVI) {
          LOG('invio abbandonato', rec.clipId, 'tentativi', rec.tentativi);
          inviiTogli(rec.clipId);
          return;
        }
        invii[rec.clipId] = true;
        leggiRisultatoInvio(rec.clipId).then(function(j) {
          if (j) { chiudiInvio(rec, j); return; }
          rec.tentativi = (rec.tentativi || 0) + 1;
          inviiSalva(rec).catch(function() {});
          LOG('invio ripreso', rec.clipId);
          caricaInvio(rec, 0);
        }).catch(function() { delete invii[rec.clipId]; });
      });
    }).catch(function(e) { LOG('invii illeggibili', e && e.message); })
      .then(function() { riprendendo = false; });
  }

  // Il tasto Invia durante la presa: preso PRIMA del suo gestore (input.js),
  // in fase di cattura sul documento.
  function catturaInvia(e) {
    if (state !== 'recording' && state !== 'starting') return;
    var t = e.target;
    if (!t || !(t === sendBtn || (sendBtn.contains && sendBtn.contains(t)))) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.stopImmediatePropagation) e.stopImmediatePropagation();
    inviaMentreRegistri();
  }

  // Riavvio dell'app con una clip in sospeso (caso tipico su Android: la WebView
  // viene uccisa mentre whisper lavora). Al caricamento si chiede una volta se
  // il testo è pronto: se sì, atterra da solo nell'input.
  function recoverPendingClip() {
    var raw = null;
    try { raw = localStorage.getItem(PENDING_KEY); } catch (e) { return; }
    if (!raw) return;
    var p = null;
    try { p = JSON.parse(raw); } catch (e) { forgetPending(); return; }
    if (!p || !p.clipId || (Date.now() - (p.at || 0)) > 24 * 60 * 60 * 1000) { forgetPending(); return; }
    fetchClipResult(p.clipId).then(function(text) {
      if (text === null) return;               // ancora in corso: si riproverà al prossimo avvio
      forgetPending();
      if (!text.trim()) return;
      resetPartialMarkersToCaret();
      commitFinal(text);
      toast('Recovered a pending dictation', 'info');
      LOG('recuperata clip pendente', p.clipId, text.length, 'char');
    }).catch(function() {});
  }

  var partialStart = 0;
  var partialEnd = 0;
  var committedBase = '';

  // --- Helpers ---
  function toast(msg, kind) {
    if (typeof window.showToast === 'function') window.showToast(msg, kind || 'warning');
    LOG('toast', kind || 'warning', msg);
  }

  function setHasText() {
    sendBtn.classList.toggle('has-text', messageInput.value.trim().length > 0);
    if (typeof window.autoResize === 'function') window.autoResize();
    if (typeof window.saveDraft === 'function' && window.activeSessionId) {
      try { window.saveDraft(window.activeSessionId, messageInput.value); } catch(e) {}
    }
  }

  function rewritePartial(text) {
    var v = messageInput.value;
    var head = v.slice(0, partialStart);
    var tail = v.slice(partialEnd);
    messageInput.value = head + text + tail;
    partialEnd = partialStart + text.length;
    setHasText();
  }

  function commitFinal(text) {
    var t = text;
    if (partialStart > 0) {
      var prevChar = messageInput.value.charAt(partialStart - 1);
      if (prevChar && prevChar !== ' ' && prevChar !== '\n' && t && !/^[\s,.!?;:]/.test(t)) {
        t = ' ' + t;
      }
    }
    rewritePartial(t);
    partialStart = partialEnd;
  }

  function resetPartialMarkersToCaret() {
    var caret = (typeof messageInput.selectionStart === 'number')
      ? messageInput.selectionStart
      : messageInput.value.length;
    partialStart = caret;
    partialEnd = caret;
    committedBase = messageInput.value;
  }

  // --- Plugin detection ---
  function getVoiceRecorder() {
    try {
      if (window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform()
          && window.Capacitor.Plugins && window.Capacitor.Plugins.VoiceRecorder) {
        return window.Capacitor.Plugins.VoiceRecorder;
      }
    } catch(e) {}
    return null;
  }

  // --- Android audio focus bridge (injected by MainActivity.java) ---
  function audioFocusRequest() {
    try {
      if (window.AndroidAudioFocus && typeof window.AndroidAudioFocus.request === 'function') {
        window.AndroidAudioFocus.request();
        LOG('audio focus requested');
      }
    } catch(e) { LOG('audio focus request failed', e); }
  }
  function audioFocusAbandon() {
    try {
      if (window.AndroidAudioFocus && typeof window.AndroidAudioFocus.abandon === 'function') {
        window.AndroidAudioFocus.abandon();
        LOG('audio focus abandoned');
      }
    } catch(e) { LOG('audio focus abandon failed', e); }
  }


  // --- WS ---
  function sendJson(obj) {
    if (window.ws && window.ws.readyState === 1) {
      window.ws.send(JSON.stringify(obj));
      return true;
    }
    return false;
  }

  function onWsMessage(msg) {
    if (!msg || !msg.type) return;
    LOG('ws<-', msg.type, msg.text ? '"'+String(msg.text).slice(0,60)+'"' : (msg.message || ''));
    if (msg.type === 'dictation_ready') {
      sessionIdRemote = msg.sessionId || null;
      // In webview mode, this is the cue to start the MediaRecorder stream.
      if (mode === 'webview' && state === 'starting' && recorder && recorder.state === 'inactive') {
        try {
          recorder.start(500);
          state = 'recording';
          startMaxDurationTimer();
          micBtn.classList.add('recording');
          micBtn.title = 'Listening… tap to stop';
        } catch(e) {
          console.error('[dictation] recorder.start failed', e);
          toast('Mic start failed');
          hardStop();
        }
      }
      // In native mode, recording is already underway — nothing to do on ready.
    } else if (msg.type === 'dictation_partial') {
      if (typeof msg.text === 'string') rewritePartial(msg.text);
    } else if (msg.type === 'dictation_final') {
      if (typeof msg.text === 'string') commitFinal(msg.text);
      if (state === 'stopping') {
        stopProgressTicker();
        lastClipBlob = null; // success — safe to drop the retained clip
        finalizeStop();
      }
    } else if (msg.type === 'dictation_error') {
      if (state === 'stopping' && autoRetryClip()) return;
      stopProgressTicker();
      saveClipToDisk('server-error');
      toast('Voice: ' + (msg.message || 'error') + ' — audio saved to disk', 'error');
      hardStop();
    }
  }

  function patchWs() {
    var installed = null;
    function install() {
      if (!window.ws) return;
      if (installed === window.ws) return;
      installed = window.ws;
      var prev = window.ws.onmessage;
      window.ws.onmessage = function(event) {
        if (prev) prev.call(window.ws, event);
        try {
          var m = JSON.parse(event.data);
          if (m && typeof m.type === 'string' && m.type.indexOf('dictation_') === 0) {
            onWsMessage(m);
          }
        } catch(e) {}
      };
      var prevClose = window.ws.onclose;
      window.ws.onclose = function(event) {
        if (prevClose) prevClose.call(window.ws, event);
        // Dictation transcription now runs over an independent HTTP POST, so a
        // chat-socket close must NOT abort an in-flight transcription (that was
        // the old bug: a socket hiccup killed the dictation and lost the audio).
        // Deliberately do nothing here.
      };
    }
    install();
    // [2026-09-22 BATTERIA] Prima: `setInterval(install, 1000)` — ogni secondo,
    // PER SEMPRE, senza nessuna condizione d'uscita. Non bussa al server (legge
    // solo window.ws e riattacca il gestore quando ws.js sostituisce il socket),
    // ma è comunque un risveglio al secondo tutta la notte: su Android la
    // WebView congela i timer in pausa MA NON mentre suona l'audio, che è
    // proprio la notte del proprietario con l'audiolibro acceso.
    // A schermo spento non c'è niente da riattaccare: la dettatura la fa partire
    // il proprietario, e per farlo lo schermo deve essere acceso. Il battito fa un giro
    // immediato appena si torna visibili, quindi il gestore è già installato
    // prima che lui possa toccare il tasto.
    if (window.Battito && typeof window.Battito.ogni === 'function') {
      // [2026-11-10 BATTERIA ] 1 s → 5 s: il server non manda più
      // messaggi dictation_* sul socket dal 12/10 (la dettatura passa da
      // POST /api/dictation/transcribe), quindi un riattacco più lento non
      // perde niente; era solo un risveglio al secondo a schermo acceso.
      window.Battito.ogni('dettatura-riattacco', 5000, install, { subitoAllAvvio: false });
    } else {
      // Nessun ripiego su setInterval: sarebbe la seconda meccanica che questo
      // lavoro toglie. Si grida e si resta col solo install() già fatto sopra.
      console.error('[DICT] battito.js non caricato: il riattacco al socket non gira. ' +
        'Controlla l\'ordine degli script in public/index.html.');
    }
  }

  // --- base64 -> ArrayBuffer ---
  function base64ToArrayBuffer(b64) {
    var bin = atob(b64);
    var len = bin.length;
    var buf = new ArrayBuffer(len);
    var view = new Uint8Array(buf);
    for (var i = 0; i < len; i++) view[i] = bin.charCodeAt(i);
    return buf;
  }

  // --- Native (Capacitor VoiceRecorder) path ---
  // Da Android 11 un'app non visibile riceve SILENZIO dal microfono: la
  // registrazione "si fermava" a telefono bloccato o fuori dall'app. MicService
  // (servizio in primo piano di tipo microfono) la tiene viva; si accende al tap,
  // con l'app ancora visibile, e si spegne a registrazione finita. Idempotente.
  function micService(on) {
    try {
      if (window.AndroidMic) { if (on) window.AndroidMic.start(); else window.AndroidMic.stop(); }
    } catch(e) {}
  }

  // [2026-11-10 ] Pagina nuova = nessuna registrazione viva in QUESTA
  // pagina. Ma la pagina si ricarica da sola (ritorno del PC dalla copia
  // offline in modalita.js, hash nuovo dopo una consegna e riavvio del server
  // in ws.js, OfflineBridge che ricarica dopo un errore): se succede a metà
  // presa, lo stato JS muore e nessuno chiama più AndroidMic.stop → MicService
  // resta in primo piano per sempre («app attive» di Samsung in sottofondo).
  // Il registratore nativo invece SOPRAVVIVE al ricaricamento (il plugin vive
  // col Bridge, non con la pagina): se registra ancora, la presa si ADOTTA
  // (tasto rosso, il tocco la ferma e la trascrive: niente audio perso);
  // altrimenti il servizio orfano si spegne.
  function riconciliaMicAllAvvio() {
    if (!window.AndroidMic) return;           // non è l'app Android
    var VR = getVoiceRecorder();
    var spegniSeFermo = function(perche) {
      if (state !== 'idle') return;           // una presa nata in questa pagina: è sua
      LOG('avvio: nessuna registrazione viva (' + perche + ') -> MicService spento');
      micService(false);
    };
    if (!VR || typeof VR.getCurrentStatus !== 'function') { spegniSeFermo('niente plugin'); return; }
    var st;
    try { st = VR.getCurrentStatus(); } catch (e) { spegniSeFermo('stato illeggibile'); return; }
    Promise.resolve(st).then(function(r) {
      var s = r && r.status;
      if (s !== 'RECORDING' && s !== 'PAUSED') { spegniSeFermo('stato ' + (s || '?')); return; }
      if (state !== 'idle') return;
      // Presa viva dalla pagina di prima: la si adotta.
      LOG('avvio: registrazione nativa ancora viva -> adottata');
      mode = 'native';
      state = 'recording';
      autoRetried = false;
      startSessionId = null;   // la pagina di prima non l'ha detto: vale quella aperta
      notifyDictationState(true);
      // MicService NON si riaccende qui: è già acceso dalla pagina di prima, e
      // un nuovo start da sottofondo (Android 12+) fa fallire startForeground
      // → MicService.onStartCommand cade nel ramo spegni() → presa muta.
      resetPartialMarkersToCaret();
      startMaxDurationTimer();
      micBtn.classList.remove('starting');
      micBtn.classList.add('recording');
      micBtn.title = 'Listening… tap to stop';
      toast('Recording still running — tap the mic to stop', 'info');
    }).catch(function() { spegniSeFermo('stato in errore'); });
  }

  async function startNative(VR) {
    state = 'starting';
    micBtn.classList.add('starting');
    LOG('native: requesting permission');
    try {
      var perm = await VR.requestAudioRecordingPermission();
      if (!perm || perm.value === false) {
        toast('Mic permission denied');
        state = 'idle';
        micBtn.classList.remove('starting');
        return;
      }
    } catch(e) {
      console.warn('[dictation] permission request failed', e);
    }

    audioFocusRequest();

    LOG('native: startRecording');
    micService(true);
    try {
      await VR.startRecording();
    } catch(e) {
      micService(false);
      console.error('[dictation] startRecording failed', e);
      toast('Mic start failed: ' + (e && e.message ? e.message : 'unknown'), 'error');
      audioFocusAbandon();
      state = 'idle';
      micBtn.classList.remove('starting');
      return;
    }

    resetPartialMarkersToCaret();
    state = 'recording';
    startMaxDurationTimer();
    micBtn.classList.remove('starting');
    micBtn.classList.add('recording');
    micBtn.title = 'Listening… tap to stop';
    if (typeof window.haptic === 'function') window.haptic(15);
    LOG('native: recording');
  }

  async function stopNative(VR, invio) {
    state = 'stopping';
    micBtn.classList.remove('recording');
    micBtn.classList.add('stopping');
    LOG('native: stopRecording');
    var result;
    try {
      result = await VR.stopRecording();
      micService(false);
    } catch(e) {
      micService(false);
      console.error('[dictation] stopRecording failed', e);
      toast('Mic stop failed: ' + (e && e.message ? e.message : 'unknown'), 'error');
      audioFocusAbandon();
      finalizeStop();
      return;
    }
    audioFocusAbandon();

    var v = result && result.value ? result.value : null;
    LOG('native: stop result', v ? ('mime=' + v.mimeType + ' bytes=' + (v.recordDataBase64 ? v.recordDataBase64.length : 0) + ' ms=' + v.msDuration) : 'null');
    if (!v || !v.recordDataBase64) {
      toast('No audio captured', 'error');
      finalizeStop();
      return;
    }

    var mime = v.mimeType || 'audio/aac';
    var fmt = 'aac';
    if (/webm/i.test(mime)) fmt = 'webm';
    else if (/ogg/i.test(mime)) fmt = 'ogg';
    else if (/mp4|m4a/i.test(mime)) fmt = 'm4a';
    else fmt = 'aac';
    LOG('native: detected mime=' + mime + ' -> fmt=' + fmt);

    // Build the blob once, hand it to the shared shipper. sendClip persists it so
    // a timeout/error can never lose the audio, and derives the wait from the real
    // recorded duration (v.msDuration).
    var nativeBlob;
    try {
      var buf = base64ToArrayBuffer(v.recordDataBase64);
      nativeBlob = new Blob([buf], { type: mime });
    } catch(e) {
      console.error('[dictation] decode audio failed', e);
      toast('Upload failed: ' + (e && e.message ? e.message : 'unknown'), 'error');
      finalizeStop();
      return;
    }
    sendClip(nativeBlob, fmt, (typeof v.msDuration === 'number' ? v.msDuration : 0), invio);
  }

  // --- Webview (getUserMedia + MediaRecorder) fallback ---
  function pickMime() {
    var prefs = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/ogg;codecs=opus',
      'audio/mp4'
    ];
    if (!window.MediaRecorder) return null;
    for (var i = 0; i < prefs.length; i++) {
      if (MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(prefs[i])) {
        return prefs[i];
      }
    }
    return '';
  }

  async function startWebview() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      toast('Mic not supported on this device');
      return;
    }
    state = 'starting';
    micBtn.classList.add('starting');
    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch(e) {
      micBtn.classList.remove('starting');
      state = 'idle';
      if (e && (e.name === 'NotAllowedError' || e.name === 'SecurityError')) {
        toast('Mic permission denied');
      } else {
        toast('Mic error: ' + (e && e.name ? e.name : 'unknown'));
      }
      return;
    }

    var mime = pickMime();
    if (mime === null) {
      toast('Recording not supported');
      teardownStream();
      state = 'idle';
      micBtn.classList.remove('starting');
      return;
    }

    resetPartialMarkersToCaret();

    try {
      recorder = mime ? new MediaRecorder(mediaStream, { mimeType: mime })
                      : new MediaRecorder(mediaStream);
    } catch(e) {
      console.error('[dictation] MediaRecorder ctor failed', e);
      toast('Recording failed to start');
      teardownStream();
      state = 'idle';
      micBtn.classList.remove('starting');
      return;
    }

    // RECORD-THEN-TRANSCRIBE (PC): collect the whole clip locally; do NOT stream
    // or transcribe live. On stop we ship it as ONE blob for a single pass —
    // the same one-shot model the native phone path already uses. This is what
    // the owner asked for: mic-on = record only, mic-off = transcribe everything in
    // one go. It also removes the tail-cut caused by racing `dictation_stop`
    // against in-flight streamed chunks.
    recordedChunks = [];
    recorder.ondataavailable = function(ev) {
      if (ev.data && ev.data.size) recordedChunks.push(ev.data);
    };

    recorder.onerror = function(e) {
      console.error('[dictation] recorder error', e);
      toast('Mic error');
      hardStop();
    };

    // No timeslice → a single dataavailable fires on stop() with the full clip.
    try {
      recorder.start();
      state = 'recording';
      startMaxDurationTimer();
      micBtn.classList.remove('starting');
      micBtn.classList.add('recording');
      micBtn.title = 'Listening… tap to stop';
    } catch(e) {
      console.error('[dictation] recorder.start failed', e);
      toast('Recording failed to start');
      teardownStream();
      state = 'idle';
      micBtn.classList.remove('starting');
      return;
    }
    if (typeof window.haptic === 'function') window.haptic(15);
  }

  function stopWebview(invio) {
    invioWebview = invio || null;
    state = 'stopping';
    micBtn.classList.remove('recording');
    micBtn.classList.add('stopping');
    // Flush the recorder; the full clip lands in ondataavailable, then onstop
    // ships it as ONE blob (so the trailing words are never cut off).
    if (recorder && recorder.state !== 'inactive') {
      recorder.onstop = function() { shipWebviewClip(); };
      try { recorder.stop(); } catch(e) { shipWebviewClip(); }
    } else {
      shipWebviewClip();
    }
  }

  // Build one blob from the collected chunks and transcribe it in a single pass.
  function shipWebviewClip() {
    teardownStream(); // mic hardware can be released — we already hold the audio
    var blob = null;
    try {
      if (recordedChunks.length) {
        blob = new Blob(recordedChunks, { type: recordedChunks[0].type || 'audio/webm' });
      }
    } catch(e) {}
    recordedChunks = [];
    if (!blob || !blob.size) {
      toast('No audio captured', 'error');
      finalizeStop();
      return;
    }
    var mime = blob.type || 'audio/webm';
    var fmt = 'webm';
    if (/ogg/i.test(mime)) fmt = 'ogg';
    else if (/mp4|m4a/i.test(mime)) fmt = 'm4a';

    var durationMs = recordStartTs ? (Date.now() - recordStartTs) : 0;
    var invio = invioWebview; invioWebview = null;
    sendClip(blob, fmt, durationMs, invio);
  }

  // Re-transmit the last recorded clip (after a timeout/error) without re-recording.
  function reshipClip() {
    if (!lastClipBlob || !lastClipBlob.size) { toast('No audio to resend', 'warning'); return; }
    if (state !== 'idle') { toast('Wait for the current step to finish', 'warning'); return; }
    micBtn.classList.add('stopping');
    // Duration is unknown on retry -> the generous floor applies.
    sendClip(lastClipBlob, lastClipFmt, 0);
  }

  // On a transport drop mid-transcription (socket died before `final`), re-ship the
  // buffered clip ONCE automatically instead of only saving it for a manual retry.
  // Visible to the user ("riprovo…") so nothing happens silently. Returns false (so
  // the caller runs its save-and-give-up path) if we've already retried or have no clip.
  function autoRetryClip() {
    if (autoRetried || !lastClipBlob || !lastClipBlob.size) return false;
    autoRetried = true;
    stopProgressTicker();
    finalizeStop();            // back to idle so reshipClip's state guard passes
    toast('Connection lost during transcription — retrying…', 'warning');
    setTimeout(reshipClip, 800);
    return true;
  }

  // --- Common ---
  function finalizeStop() {
    clearMaxDurationTimer();
    teardownStream();
    recorder = null;
    sessionIdRemote = null;
    state = 'idle';
    // Restart guard: dictation over — the server may bounce freely again.
    try { notifyDictationState(false); } catch(e) {}
    mode = null;
    micBtn.classList.remove('recording', 'starting', 'stopping', 'transcribing');
    micBtn.title = 'Voice input';
    LOG('finalized -> idle');
  }

  function hardStop() {
    try { if (recorder && recorder.state !== 'inactive') recorder.stop(); } catch(e) {}
    var VR = getVoiceRecorder();
    if (VR && mode === 'native') {
      VR.stopRecording().catch(function() {});
      audioFocusAbandon();
      micService(false);
    }
    sendJson({ type: 'dictation_stop' });
    finalizeStop();
  }

  function teardownStream() {
    if (mediaStream) {
      try { mediaStream.getTracks().forEach(function(t){ t.stop(); }); } catch(e) {}
      mediaStream = null;
    }
  }

  // --- Restart guard signal (2026-08-16, punto 4) ---
  // Tell the server "I'm busy dictating" so a deploy/restart WAITS instead of
  // killing the take. active:true at start + heartbeat every 30s while any
  // dictation activity is going on (recording OR waiting for the transcript —
  // state stays non-idle until finalizeStop). active:false when we return to
  // idle. Server side: ws-handler 'dictation_state' → restart-readiness.js
  // (entries expire after 90s, so a dead phone never blocks deploys).
  //
  // [2026-09-22 BATTERIA] QUESTO TIMER RESTA UN setInterval NUDO, apposta, e NON
  // passa da window.Battito. È l'unico giro di questo file che DEVE girare anche
  // a schermo spento: il proprietario detta col telefono in mano e lo schermo si può
  // spegnere a metà presa; se il battito tacesse, la voce del server scadrebbe
  // dopo 90s e un deploy ucciderebbe la dettatura in corso — cioè il guasto che
  // questo codice esiste per impedire. Costo reale: 2 messaggi al minuto SOLO
  // mentre si detta, non per sempre. Dichiarato nella lista delle eccezioni di
  // tests/timer-a-schermo-spento.test.js.
  var guardBeatTimer = null;
  function notifyDictationState(active) {
    sendJson({ type: 'dictation_state', active: !!active });
    if (active && !guardBeatTimer) {
      guardBeatTimer = setInterval(function() {
        if (state !== 'idle') sendJson({ type: 'dictation_state', active: true });
        else { clearInterval(guardBeatTimer); guardBeatTimer = null; sendJson({ type: 'dictation_state', active: false }); }
      }, 30000);
    } else if (!active && guardBeatTimer) {
      clearInterval(guardBeatTimer);
      guardBeatTimer = null;
    }
  }

  // --- Dispatch ---
  async function startDictation() {
    if (state !== 'idle') return;
    // No chat-socket requirement anymore: recording is local and transcription is
    // an independent HTTP POST. If the network is down at stop time, the clip is
    // saved to disk (never lost) and can be retried.
    autoRetried = false;
    startSessionId = window.activeSessionId || null;
    notifyDictationState(true);
    var VR = getVoiceRecorder();
    if (VR) {
      mode = 'native';
      await startNative(VR);
    } else {
      mode = 'webview';
      await startWebview();
    }
  }

  function stopDictation(invio) {
    if (state !== 'recording' && state !== 'starting') return;
    if (mode === 'native') {
      var VR = getVoiceRecorder();
      if (VR) { stopNative(VR, invio); return; }
    }
    stopWebview(invio);
  }

  // --- Single tap-to-toggle click handler ---
  function onMicTap(e) {
    if (e) { e.preventDefault(); e.stopPropagation(); }
    if (state === 'idle') startDictation();
    else if (state === 'recording' || state === 'starting') stopDictation();
  }

  function claimMicButton() {
    if (micBtn.style.display === 'none') micBtn.style.display = '';
    micBtn.onclick = onMicTap;
    micBtn.classList.add('mic-dictation');
  }

  claimMicButton();
  setTimeout(claimMicButton, 500);
  setTimeout(claimMicButton, 1500);
  setTimeout(claimMicButton, 3000);

  patchWs();
  riconciliaMicAllAvvio();
  document.addEventListener('click', catturaInvia, true);
  document.addEventListener('visibilitychange', function() {
    if (document.visibilityState === 'visible') riprendiInvii();
  });

  // Ritiro all'avvio: aspetta di avere il gettone d'accesso, poi chiede una
  // volta sola se c'è una dettatura rimasta appesa dall'ultima sessione.
  (function scheduleRecovery() {
    var tries = 0;
    (function attempt() {
      tries++;
      if (window.authToken) { recoverPendingClip(); riprendiInvii(); return; }
      if (tries < 20) setTimeout(attempt, 1000);
    })();
  })();

  window.Dictation = {
    state: function() { return state; },
    mode:  function() { return mode; },
    stop:  function() { stopDictation(); },
    retry: reshipClip,                                   // re-send the last clip
    hasClip: function() { return !!(lastClipBlob && lastClipBlob.size); },
    saveClip: function() { return saveClipToDisk('manual'); }
  };
})();
