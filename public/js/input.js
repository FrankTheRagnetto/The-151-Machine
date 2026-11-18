/* The 151 Machine — Input: sending, commands, attachments, TTS, events */

// --- Message history (per-session Up/Down arrow recall) ---
var _inputHistory = {};
var _historyIndex = -1;
var _historyDraft = '';

window.pushInputHistory = function(sessionId, text) {
  if (!text || !sessionId) return;
  if (!_inputHistory[sessionId]) _inputHistory[sessionId] = [];
  var hist = _inputHistory[sessionId];
  if (hist[hist.length - 1] === text) return;
  hist.push(text);
  if (hist.length > 100) hist.shift();
  _historyIndex = -1;
};

// --- Sending Messages ---
var _sending = false;

function setSendingLock(active) {
  _sending = active;
  var btn = document.getElementById('send-btn-new');
  var bar = document.getElementById('attachment-bar');
  if (btn) {
    btn.disabled = active;
    btn.classList.toggle('uploading', active);
  }
  if (bar) bar.classList.toggle('uploading', active);
}

// --- Quota-proof persistence for the send path (BUG B root fix, 2026-08-15) ---
// PROVEN by the on-device send-probe (PC ~/.151machine/client-log.jsonl,
// 11:42:19-11:43:16): with localStorage at quota, savePendingMessage's setItem
// THROWS QuotaExceededError inside sendMessage BEFORE ws.send — the async
// function rejects, nothing is sent, no error surfaces, and every retry dies
// the same way ("premo invia → non parte nulla"). Long messages fail first
// because the write is bigger. Persistence is a crash-recovery nicety — it must
// NEVER abort the send. On outbox-write failure the (expendable) outbox key is
// dropped and the write retried once, which also restores storage headroom.
function _safeSavePending(sessionId, content, attachments, nonce) {
  try { savePendingMessage(sessionId, content, attachments, nonce); }
  catch (e) {
    console.warn('[send] pending persist failed (quota?) — dropping outbox, retrying:', e && e.message);
    try {
      localStorage.removeItem('claude-pending-messages');
      savePendingMessage(sessionId, content, attachments, nonce);
    } catch (e2) {
      console.warn('[send] pending persist still failing — sending without outbox:', e2 && e2.message);
    }
  }
}
// Non-fatal wrapper for the other localStorage writes on the send path
// (saveDraft via sessions.js _writeDrafts and persistAwaiting are unwrapped and
// would abort the send exactly the same way once the pending write is fixed).
function _safeStore(label, fn) {
  try { fn(); } catch (e) { console.warn('[send] non-fatal persist failed (' + label + '):', e && e.message); }
}

window.sendMessage = async function sendMessage() {
  if (_sending) return;

  const messageInput = $('#message-input');
  const commandPicker = $('#command-picker');
  const sendBtn = $('#send-btn-new');
  const attachmentBar = $('#attachment-bar');

  console.log('[attach] sendMessage entry', {
    pendingFiles: (window.pendingFiles && window.pendingFiles.length) || 0,
    pluginPending: (typeof window.getPendingFiles === 'function' ? window.getPendingFiles().length : 'n/a'),
    path: 'sendMessage'
  });

  const text = messageInput.value.trim();
  if (!text && pendingFiles.length === 0) return;
  window.pushInputHistory(window.activeSessionId, text);
  if (!activeSessionId) return;

  var hasFiles = pendingFiles.length > 0;
  if (hasFiles) setSendingLock(true);

  haptic(10);
  // Clear awaiting state — user is responding
  if (awaitingSessions.has(activeSessionId)) {
    awaitingSessions.delete(activeSessionId);
    _safeStore('awaiting', persistAwaiting);
    renderSessionList();
  }
  // il proprietario risponde: la notifica di questa sessione sparisce ovunque.
  try { if (typeof window.segnaLetta === 'function') window.segnaLetta(activeSessionId); } catch (e) {}

  // «!comando»: lo esegue il PC (server/comando-chat.js).
  // Claude non si ferma se sta lavorando e non parte: niente «thinking».
  if (!hasFiles && /^!\s*\S/.test(text) && !/^!!/.test(text)) {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      showToast('Not connected to the PC: command not sent', 'error');
      return;
    }
    var cNonce = generateNonce();
    window.markNonceRendered(cNonce);
    appendMessage('user', text, null, true, []);
    var sc = sessions.find(function(x) { return x.id === activeSessionId; });
    if (sc) { if (!sc.history) sc.history = []; sc.history.push({ role: 'user', content: text }); }
    messageInput.value = '';
    _safeStore('draft', function() { saveDraft(activeSessionId, ''); });
    autoResize();
    window.hideCommands();
    sendBtn.classList.remove('has-text');
    ws.send(JSON.stringify({ type: 'message', content: text, attachments: [], nonce: cNonce }));
    return;
  }

  // If busy, inject the message mid-stream:
  // Stop current response, show user message, then re-send with interruption context
  if (streaming) {
    haptic([10, 20, 10]);

    // Upload any pending attachments FIRST so they ride along with the injection
    var injectAttachments = [];
    if (hasFiles) {
      try {
        console.log('[attach] uploading (interrupt path)', pendingFiles.length, 'file(s)');
        // M9 Vettore 6: reuse any upload-on-add ref, upload only the rest.
        injectAttachments = await window._materializeAttachments(activeSessionId, pendingFiles);
        console.log('[attach] uploaded', injectAttachments);
        window.clearAttachments();
      } catch (err) {
        console.error('[attach] upload failed (interrupt path)', err);
        showToast('Upload failed: ' + (err.message || err), 'error');
        setSendingLock(false);
        return;
      }
    }

    setSendingLock(false);

    // Show user message immediately
    appendMessage('user', text, null, true, injectAttachments);
    messageInput.value = '';
    _safeStore('draft', function() { saveDraft(activeSessionId, ''); });
    autoResize();
    window.hideCommands();
    sendBtn.classList.remove('has-text');

    // Capture partial response before stopping
    var partialText = streamingText || '';

    // Stop Claude and wait for server confirmation before sending injection
    var stopConfirmed = new Promise(function(resolve) {
      window._stopResolve = resolve;
      // Fallback timeout in case ack never arrives
      setTimeout(resolve, 2000);
    });

    if (ws && activeSessionId) {
      ws.send(JSON.stringify({ type: 'stop' }));
    }

    var injectionText = text;
    if (partialText.length > 200) {
      injectionText = '[INTERRUPTION: You were responding and the user interjected mid-response. Your partial response so far was ' + partialText.length + ' characters long. The user said:]\n\n' + text + '\n\n[Take note of what the user said. If they asked you to stop, acknowledge and ask what to do next. If they added information, incorporate it and continue your work. If they corrected something, adjust accordingly.]';
    } else if (partialText) {
      injectionText = '[INTERRUPTION: You were responding (partial: "' + partialText.slice(0, 200) + '..."). The user interjected:]\n\n' + text + '\n\n[Take note of what the user said and continue accordingly.]';
    } else {
      injectionText = '[INTERRUPTION: You were working when the user interjected:]\n\n' + text + '\n\n[Take note of what the user said and continue accordingly.]';
    }

    stopConfirmed.then(function(stopAck) {
      // [29/10/2026] Aiutanti in sottofondo vivi e il modello sta scrivendo: il
      // server NON ha fermato niente (fermare li ucciderebbe) e il messaggio
      // aspetta che il modello finisca, poi parte da solo. La risposta continua
      // a scorrere: niente «[Stopped]», niente «sei stato interrotto».
      if (stopAck && stopAck.deferred) {
        var waitNonce = generateNonce();
        _safeSavePending(activeSessionId, text, injectAttachments, waitNonce);
        window.markNonceRendered(waitNonce);
        var ws0 = sessions.find(function(x) { return x.id === activeSessionId; });
        if (ws0) {
          if (!ws0.history) ws0.history = [];
          ws0.history.push({ role: 'user', content: text, attachments: injectAttachments });
          ws0.lastActivity = new Date().toISOString();
          cacheHistory(activeSessionId, ws0.history);
        }
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'message', content: text, attachments: injectAttachments, nonce: waitNonce }));
        } else {
          if (activeSessionId) connectWebSocket(activeSessionId);
          appendMessage('system', 'Reconnecting — your message is saved and will be sent automatically.');
        }
        return;
      }
      // Finalize old streaming element so partial response is preserved
      if (window.streamingEl) {
        if (partialText) {
          window.finalizeStreamingMessage(partialText + '\n\n*[Stopped]*');
        } else {
          if (window.streamingEl.isConnected) try { window.streamingEl.remove(); } catch(e) {}
          window.streamingEl = null;
        }
      }
      setStreamingState(false);
      var nonce = generateNonce();
      _safeSavePending(activeSessionId, injectionText, injectAttachments, nonce);
      window.markNonceRendered(nonce);
      var s = sessions.find(function(s) { return s.id === activeSessionId; });
      if (s) {
        if (!s.history) s.history = [];
        s.history.push({ role: 'user', content: text, attachments: injectAttachments });
        s.lastActivity = new Date().toISOString();
        cacheHistory(activeSessionId, s.history);
      }
      setStreamingState(true);
      streamingText = ''; thinkingText = '';
      autoScroll = true;
      updateStatusDot('busy');
      window.showThinkingState();
      // M9 vector 2 (DETACHED_RUNS-gated): also hold in the outbox if the server
      // is restarting, so an interjection typed at the bounce instant isn't fired
      // into a dying socket. Flag OFF ⇒ byte-identical.
      var _holdForRestart = !!(window.DETACHED_RUNS && typeof window.isInRestartMode === 'function' && window.isInRestartMode());
      if (ws && ws.readyState === WebSocket.OPEN && !_holdForRestart) {
        console.log('[attach] sending with', injectAttachments);
        ws.send(JSON.stringify({ type: 'message', content: injectionText, attachments: injectAttachments, nonce: nonce }));
      } else {
        // Socket dropped (relay blip) or server restarting — the message is already
        // persisted above (savePendingMessage), so hold it; reconnect + pending-flush
        // (redeliverPending) redelivers it instead of dropping it. Don't kick a manual
        // reconnect while in restart mode — the restart poll owns reconnection.
        if (activeSessionId && !_holdForRestart) connectWebSocket(activeSessionId);
        appendMessage('system', 'Reconnecting — your message is saved and will be sent automatically.');
      }
    });
    return;
  }

  let attachments = [];
  if (hasFiles) {
    try {
      console.log('[attach] uploading', pendingFiles.length, 'file(s)');
      // M9 Vettore 6: reuse any upload-on-add ref, upload only the rest.
      attachments = await window._materializeAttachments(activeSessionId, pendingFiles);
      console.log('[attach] uploaded', attachments);
      window.clearAttachments();
    } catch (err) {
      console.error('[attach] upload failed', err);
      showToast('Upload failed: ' + (err.message || err), 'error');
      setSendingLock(false);
      return;
    }
  }

  setSendingLock(false);

  // Persist message BEFORE sending — survives app kill, WS drop, phone sleep.
  // Quota-proof: a failed persist must never abort the send (the proven BUG B).
  var sendNonce = generateNonce();
  _safeSavePending(activeSessionId, text, attachments, sendNonce);
  // Mark as rendered so any server echo of this same nonce is deduped on this device
  window.markNonceRendered(sendNonce);

  const s = sessions.find(function(s) { return s.id === activeSessionId; });
  if (s) {
    if (!s.history) s.history = [];
    s.history.push({ role: 'user', content: text, attachments: attachments });
    s.lastActivity = new Date().toISOString();
    cacheHistory(activeSessionId, s.history);
  }

  appendMessage('user', text, null, true, attachments);
  messageInput.value = '';
  _safeStore('draft', function() { saveDraft(activeSessionId, ''); });
  autoResize();
  window.hideCommands();

  // Ensure WS is open before sending. M9 vector 2 (DETACHED_RUNS-gated): if the
  // server is restarting, HOLD the (already-persisted, line ~174) message in the
  // outbox and let the restart poll → reconnect → redeliverPending send it — don't
  // fire it into a socket that's dying because the server is going down. Flag OFF ⇒
  // _holdForRestart is always false ⇒ byte-identical to before.
  var _holdForRestart = !!(window.DETACHED_RUNS && typeof window.isInRestartMode === 'function' && window.isInRestartMode());
  if (!ws || ws.readyState !== WebSocket.OPEN || _holdForRestart) {
    if (activeSessionId && !_holdForRestart) connectWebSocket(activeSessionId);
    appendMessage('system', 'Reconnecting — your message is saved and will be sent automatically.');
    return;
  }

  setStreamingState(true);
  streamingText = ''; thinkingText = '';
  autoScroll = true;
  updateStatusDot('busy');
  window.showThinkingState();

  // Send pulse animation on the orb
  haptic(10);
  sendBtn.classList.add('send-pulse');
  setTimeout(function() { sendBtn.classList.remove('send-pulse'); }, 300);

  console.log('[attach] sending with', attachments);
  ws.send(JSON.stringify({ type: 'message', content: text, attachments: attachments, nonce: sendNonce }));
};

function processQueue() {
  if (messageQueue.length === 0) return;
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    // WS not ready — retry in 500ms
    setTimeout(processQueue, 500);
    return;
  }
  const next = messageQueue.shift();
  if (!next.content && (!next.attachments || !next.attachments.length)) return processQueue();
  // Message is already shown in chat — just send to server
  setStreamingState(true);
  streamingText = ''; thinkingText = '';
  autoScroll = true;
  updateStatusDot('busy');
  window.showThinkingState();
  var _qNonce = next.nonce || generateNonce();
  window.markNonceRendered(_qNonce);
  ws.send(JSON.stringify({ type: 'message', content: next.content, attachments: next.attachments || [], nonce: _qNonce }));
}
window.processQueue = processQueue;

// --- Slash Commands ---
var _cmdActiveIndex = -1;

window.loadCommands = async function loadCommands() {
  try {
    commands = await api('GET', '/commands');
    // Sort alphabetically for consistent display
    commands.sort(function(a, b) { return a.name.localeCompare(b.name); });
  } catch(e) {
    console.warn('[INIT] loadCommands failed:', e.message);
    commands = [];
  }
};

function highlightMatch(text, filter) {
  if (!filter) return escapeHtml(text);
  var lower = text.toLowerCase();
  var idx = lower.indexOf(filter.toLowerCase());
  if (idx === -1) return escapeHtml(text);
  var before = text.slice(0, idx);
  var match = text.slice(idx, idx + filter.length);
  var after = text.slice(idx + filter.length);
  return escapeHtml(before) + '<span class="match">' + escapeHtml(match) + '</span>' + escapeHtml(after);
}

window.showCommands = function showCommands(filter) {
  var commandPicker = $('#command-picker');
  var messageInput = $('#message-input');
  var filtered = filter
    ? commands.filter(function(c) { return c.name.toLowerCase().includes(filter.toLowerCase()); })
    : commands.slice();

  if (filtered.length === 0) {
    window.hideCommands();
    _cmdActiveIndex = -1;
    return;
  }

  var countLabel = filter
    ? filtered.length + ' of ' + commands.length + ' commands'
    : filtered.length + ' commands';

  var html = '<div class="command-picker-header">' + countLabel + '</div>';
  html += filtered.map(function(c, i) {
    return '<div class="command-item" data-name="' + escapeHtml(c.name) + '" data-index="' + i + '">' +
      '<div class="command-name">/' + highlightMatch(c.name, filter) + '</div>' +
      (c.description ? '<div class="command-desc">' + escapeHtml(c.description) + '</div>' : '') +
    '</div>';
  }).join('');

  commandPicker.innerHTML = html;
  _cmdActiveIndex = -1;

  var items = commandPicker.querySelectorAll('.command-item');
  for (var i = 0; i < items.length; i++) {
    (function(item) {
      item.onclick = function() {
        selectCommand(item.dataset.name);
      };
    })(items[i]);
  }

  commandPicker.classList.add('show');
};

function selectCommand(name) {
  var messageInput = $('#message-input');
  messageInput.value = '/' + name + ' ';
  window.hideCommands();
  messageInput.focus();
  // Trigger input event so draft save + send button update
  messageInput.dispatchEvent(new Event('input', { bubbles: true }));
}

window.hideCommands = function hideCommands() {
  $('#command-picker').classList.remove('show');
  _cmdActiveIndex = -1;
};

window.commandPickerNavigate = function commandPickerNavigate(e) {
  var commandPicker = $('#command-picker');
  if (!commandPicker.classList.contains('show')) return false;

  var items = commandPicker.querySelectorAll('.command-item');
  if (items.length === 0) return false;

  if (e.key === 'ArrowUp') {
    e.preventDefault();
    _cmdActiveIndex = _cmdActiveIndex <= 0 ? items.length - 1 : _cmdActiveIndex - 1;
    updateActiveCommand(items);
    return true;
  }
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    _cmdActiveIndex = _cmdActiveIndex >= items.length - 1 ? 0 : _cmdActiveIndex + 1;
    updateActiveCommand(items);
    return true;
  }
  if (e.key === 'Enter' || e.key === 'Tab') {
    if (_cmdActiveIndex >= 0 && _cmdActiveIndex < items.length) {
      e.preventDefault();
      selectCommand(items[_cmdActiveIndex].dataset.name);
      return true;
    }
    // If nothing selected but picker is open, select first on Tab
    if (e.key === 'Tab' && items.length > 0) {
      e.preventDefault();
      selectCommand(items[0].dataset.name);
      return true;
    }
  }
  if (e.key === 'Escape') {
    e.preventDefault();
    window.hideCommands();
    return true;
  }
  return false;
};

function updateActiveCommand(items) {
  for (var i = 0; i < items.length; i++) {
    items[i].classList.toggle('active', i === _cmdActiveIndex);
  }
  if (_cmdActiveIndex >= 0 && items[_cmdActiveIndex]) {
    items[_cmdActiveIndex].scrollIntoView({ block: 'nearest' });
  }
}

// --- File Attachments ---
window.addFiles = function addFiles(files) {
  for (let i = 0; i < files.length; i++) pendingFiles.push(files[i]);
  window.renderAttachments();
  // M9 Fase C · Vettore 6 (DETACHED_RUNS-gated): upload-on-add so the returned
  // ref can be persisted in the draft and survive a reload/restart. Flag OFF ⇒
  // nothing uploads here; files upload at send-time exactly as before
  // (byte-identical). Fire-and-forget — a failure just falls back to send-time.
  if (window.DETACHED_RUNS) window._uploadPendingOnAdd();
};

function removeFile(index) {
  var removed = pendingFiles[index];
  pendingFiles.splice(index, 1);
  window.renderAttachments();
  // M9 Vettore 6: an already-uploaded ref that's removed from compose must be
  // unpinned server-side (the boot sweep can reclaim it) + dropped from the draft.
  if (window.DETACHED_RUNS && removed && removed._ref && removed._ref.path) {
    _unpinDraftPaths([removed._ref.path]);
    _persistDraftAttachments();
  }
}
window.removeFile = removeFile;

window.clearAttachments = function clearAttachments() {
  // M9 Vettore 6: unpin every uploaded ref before clearing. On send this is the
  // right thing — the attachment is now in history, which protects it instead.
  if (window.DETACHED_RUNS) {
    var paths = pendingFiles
      .filter(function(f) { return f && f._ref && f._ref.path; })
      .map(function(f) { return f._ref.path; });
    if (paths.length) _unpinDraftPaths(paths);
  }
  pendingFiles = [];
  window.renderAttachments();
  if (window.DETACHED_RUNS) _persistDraftAttachments();
};

// M9 Fase C · Vettore 6 helpers (all no-ops / never called when DETACHED_RUNS off).
// Persist the current compose refs into the active session's draft.
function _persistDraftAttachments(sid) {
  sid = sid || window.activeSessionId;
  if (!sid || typeof window.saveDraftAttachments !== 'function') return;
  var refs = [];
  for (var i = 0; i < pendingFiles.length; i++) {
    if (pendingFiles[i] && pendingFiles[i]._ref) refs.push(pendingFiles[i]._ref);
  }
  window.saveDraftAttachments(sid, refs);
}

// Tell the server these draft-pinned paths are no longer in a draft. Fire-and-forget.
function _unpinDraftPaths(paths) {
  if (!paths || !paths.length) return;
  try {
    fetch(getServerUrl() + '/api/attachments/unpin', {
      method: 'POST',
      headers: Object.assign(
        { 'Content-Type': 'application/json' },
        window.authToken ? { 'Authorization': 'Bearer ' + window.authToken } : {}
      ),
      body: JSON.stringify({ paths: paths })
    }).catch(function() {});
  } catch (e) {}
}

// Upload-on-add: upload any pending entry lacking a ref, stamp entry._ref, then
// persist the refs into the draft. Marks entries _uploading so the chip can show
// progress and the send path knows not to double-fire.
window._uploadPendingOnAdd = async function _uploadPendingOnAdd() {
  var sid = window.activeSessionId;
  if (!sid) return;
  var todo = pendingFiles.filter(function(f) { return f && !f._ref && !f._uploading; });
  if (!todo.length) return;
  todo.forEach(function(f) { f._uploading = true; });
  window.renderAttachments();
  for (var i = 0; i < todo.length; i++) {
    var entry = todo[i];
    try {
      var refs = await window.uploadAttachments(sid, [entry], { draft: true });
      entry._ref = refs[0];
    } catch (e) {
      console.warn('[attach] upload-on-add failed (will retry at send):', e.message || e);
    }
    entry._uploading = false;
  }
  _persistDraftAttachments(sid);
  window.renderAttachments();
};

// Resolve compose entries to refs: reuse a ref uploaded-on-add, upload the rest.
// With DETACHED_RUNS off no entry has _ref, so this uploads all entries — the
// exact pre-Vettore-6 behaviour.
window._materializeAttachments = async function _materializeAttachments(sid, entries) {
  var refs = new Array(entries.length);
  var pending = [], idx = [];
  for (var i = 0; i < entries.length; i++) {
    if (entries[i] && entries[i]._ref) refs[i] = entries[i]._ref;
    else { pending.push(entries[i]); idx.push(i); }
  }
  if (pending.length) {
    var up = await window.uploadAttachments(sid, pending);
    for (var j = 0; j < up.length; j++) refs[idx[j]] = up[j];
  }
  return refs;
};

// Rebuild the compose bar for a session from its persisted draft refs. Each entry
// is a ref-only descriptor (no blob) flagged _uploaded so the send path won't
// try to re-read a blob it no longer has. DETACHED_RUNS-gated.
window._rehydrateDraftAttachments = function _rehydrateDraftAttachments(sid) {
  if (!window.DETACHED_RUNS) return;
  // Reset compose for the target session WITHOUT unpinning (the refs belong to
  // this session's draft and stay pinned until sent/removed).
  pendingFiles = [];
  var refs = (typeof window.loadDraftAttachments === 'function') ? window.loadDraftAttachments(sid) : [];
  for (var i = 0; i < refs.length; i++) {
    var r = refs[i];
    if (!r || !r.path) continue;
    pendingFiles.push({ name: r.name, size: r.size, mime: r.mime, path: r.path, _ref: r, _uploaded: true });
  }
  window.renderAttachments();
};

function formatAttachmentSize(bytes) {
  if (bytes == null || isNaN(bytes)) return '';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

window.renderAttachments = function renderAttachments() {
  const attachmentBar = $('#attachment-bar');
  if (pendingFiles.length === 0) {
    attachmentBar.classList.remove('has-files');
    attachmentBar.innerHTML = '';
    return;
  }
  attachmentBar.classList.add('has-files');
  attachmentBar.innerHTML = pendingFiles.map(function(f, i) {
    var name = f.name || 'file';
    var size = formatAttachmentSize(f.size);
    // M9 Vettore 6: reflect upload-on-add progress on the chip.
    var uploading = !!(f && f._uploading);
    return '<div class="attachment-chip' + (uploading ? ' uploading' : '') + '">' +
      '<span>' + IC.paperclip + ' ' + escapeHtml(name) +
        (size ? ' <span class="chip-size">(' + size + ')</span>' : '') +
        (uploading ? ' <span class="chip-status">…</span>' : '') + '</span>' +
      '<button class="remove" data-index="' + i + '">&times;</button>' +
    '</div>';
  }).join('');
  const removes = attachmentBar.querySelectorAll('.remove');
  for (let i = 0; i < removes.length; i++) {
    (function(btn) {
      btn.onclick = function() { removeFile(parseInt(btn.dataset.index)); };
    })(removes[i]);
  }
};

// (Lab Review auto-send removed 2026-08-20 with the Lab app.)

// --- Text-to-Speech (Edge TTS via /api/tts) ---
var ttsCurrentBtn = null;
var ttsCurrentAudio = null;  // Active AudioBufferSourceNode (Web Audio)
// 29/09/2026 — la voce passa da Web Audio, NON da un <audio>. Un <audio> lungo
// fa chiedere a Chromium il focus audio PERMANENTE: il player di musica del proprietario
// lo perdeva per sempre, si fermava e spariva dalla tendina. Web Audio non tocca
// il focus: resta solo la richiesta TEMPORANEA di ttsAudioFocusRequest (la
// stessa della dettatura), e all'abbandono la musica riparte da sola.
var ttsCtx = null;
function ttsContext() {
  if (!ttsCtx) {
    var C = window.AudioContext || window.webkitAudioContext;
    if (C) { try { ttsCtx = new C(); } catch (_) { ttsCtx = null; } }
  }
  return ttsCtx;
}
function ttsSuspend() {
  // Contesto fermo quando non parla: niente flusso audio aperto a vuoto.
  try { if (ttsCtx && ttsCtx.state === 'running') ttsCtx.suspend(); } catch (_) {}
}
var ttsNonce = 0;            // Incremented on each request; old callbacks check this
var ttsFocusHeld = false;

function ttsLog() {
  try { console.log.apply(console, ['[tts]'].concat([].slice.call(arguments))); } catch(e) {}
}

// Send a tiny diagnostic beacon to the server so phone-side TTS failures are
// visible without a console (read server: ~/.151machine/client-log.jsonl).
function ttsBeacon(stage, data) {
  try {
    var base = (typeof window.getServerUrl === 'function') ? window.getServerUrl() : '';
    var body = JSON.stringify({ kind: 'tts', stage: stage, data: data || {}, ua: navigator.userAgent, t: Date.now() });
    var headers = { 'Content-Type': 'application/json' };
    // The /api auth gate rejects un-tokened POSTs, so the beacon MUST carry the
    // JWT or it 401s and nothing is ever logged (the long-standing blind spot).
    if (window.authToken) headers['Authorization'] = 'Bearer ' + window.authToken;
    fetch(base + '/api/client-log', {
      method: 'POST',
      headers: headers,
      body: body,
      keepalive: true
    }).catch(function(){});
  } catch(e) {}
}

function ttsAudioFocusRequest() {
  try {
    if (window.AndroidAudioFocus && typeof window.AndroidAudioFocus.request === 'function') {
      window.AndroidAudioFocus.request();
      ttsFocusHeld = true;
      ttsLog('audio focus requested');
    }
  } catch(e) { ttsLog('audio focus request failed', e); }
}

function ttsAudioFocusAbandon() {
  if (!ttsFocusHeld) return;
  try {
    if (window.AndroidAudioFocus && typeof window.AndroidAudioFocus.abandon === 'function') {
      window.AndroidAudioFocus.abandon();
      ttsLog('audio focus abandoned');
    }
  } catch(e) { ttsLog('audio focus abandon failed', e); }
  ttsFocusHeld = false;
}

function ttsStopCurrent() {
  ttsNonce++;
  if (ttsCurrentAudio) {
    try { ttsCurrentAudio.onended = null; ttsCurrentAudio.stop(); } catch(_) {}
    ttsCurrentAudio = null;
  }
  ttsSuspend();
  if (ttsCurrentBtn) {
    ttsCurrentBtn.classList.remove('speaking');
    ttsCurrentBtn.innerHTML = window.ICON_SPEAKER;
    ttsCurrentBtn = null;
  }
  ttsAudioFocusAbandon();
}

window.ttsSpeak = function ttsSpeak(text, btn) {
  ttsLog('ttsSpeak start, len=', (text||'').length);

  // Toggle off if same button clicked (whether audio exists or still fetching)
  if (ttsCurrentBtn === btn) {
    ttsStopCurrent();
    return;
  }

  // Stop any in-progress TTS
  ttsStopCurrent();

  // Clean text: strip markdown syntax, code blocks, URLs
  var clean = text
    .replace(/```[\s\S]*?```/g, ' code block ')
    .replace(/`[^`]+`/g, function(m) { return m.slice(1, -1); })
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/#{1,6}\s/g, '')
    .replace(/[*_~]{1,3}/g, '')
    .replace(/https?:\/\/\S+/g, ' link ')
    .replace(/\|/g, ' ')
    .replace(/[-]{3,}/g, ' ')
    .replace(/\n+/g, '. ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!clean) return;

  ttsNonce++;
  var myNonce = ttsNonce;

  ttsCurrentBtn = btn;
  btn.classList.add('speaking');
  btn.innerHTML = window.ICON_STOP;

  // Il contesto si sveglia DENTRO il gesto del tocco: dopo, i pezzi possono
  // arrivare anche dopo secondi di rete e suonano lo stesso (niente più trucco
  // del silenzio in loop per tenere "benedetto" un <audio>).
  var ctx = ttsContext();
  if (!ctx) { ttsStopCurrent(); return; }
  try { ctx.resume(); } catch (_) {}
  ttsAudioFocusRequest();

  var serverBase = (typeof window.getServerUrl === 'function') ? window.getServerUrl() : '';
  var TTS_CLIENT_RETRIES = 3;
  var TTS_CLIENT_DELAY = 2000;

  // Split the cleaned text into small pieces on sentence boundaries and play
  // their mp3s back-to-back through the shared Web Audio context (woken inside
  // the tap above). The server caches each piece by hash, so replays are instant.
  // CHUNK SIZE (2026-06-28, evidence-driven): was 1800. The phone beacon showed
  // a 1800-char piece = a ~1.5MB mp3 that took ~19s to synthesize+stream over
  // the phone→Pi→PC relay before ANY audio, and the biggest pieces 500'd under
  // Edge-TTS load. Smaller pieces synthesize in a few seconds (first audio comes
  // fast), are far less likely to 500, and — since each piece's PLAYBACK far
  // outlasts the next piece's fetch — still chain gaplessly with only ONE fetch
  // in flight at a time (see playChunk: next is prefetched only once the current
  // one is actually playing, so there is no concurrent-synth burst).
  var TTS_MAX = 700;
  var ttsChunks = [];
  (function buildChunks() {
    var sentences = clean.split(/(?<=[.!?])\s+/);
    var cur = '';
    function push() { if (cur.trim()) { ttsChunks.push(cur.trim()); cur = ''; } }
    for (var i = 0; i < sentences.length; i++) {
      var s = sentences[i];
      while (s.length > TTS_MAX) {
        var cut = s.lastIndexOf(' ', TTS_MAX);
        if (cut <= 0) cut = TTS_MAX;
        if ((cur + ' ' + s.slice(0, cut)).length > TTS_MAX) push();
        cur += (cur ? ' ' : '') + s.slice(0, cut);
        push();
        s = s.slice(cut).replace(/^\s+/, '');
      }
      if ((cur + ' ' + s).length > TTS_MAX && cur) { push(); cur = s; }
      else { cur += (cur ? ' ' : '') + s; }
    }
    push();
  })();

  function ttsReset() {
    if (ttsNonce !== myNonce) return;
    btn.classList.remove('speaking');
    btn.innerHTML = window.ICON_SPEAKER;
    ttsCurrentBtn = null;
    ttsCurrentAudio = null;
    ttsSuspend();
    ttsAudioFocusAbandon();
  }

  if (!ttsChunks.length) { ttsReset(); return; }
  ttsBeacon('start', { chunks: ttsChunks.length, cleanLen: clean.length });

  // Fetch one chunk's mp3 → Promise<AudioBuffer>. Retries on 5xx / network error.
  function fetchChunkBlob(chunkIndex, attempt) {
    ttsLog('fetch chunk', (chunkIndex + 1), 'of', ttsChunks.length, 'attempt', attempt);
    ttsBeacon('fetch-start', { chunk: chunkIndex + 1, of: ttsChunks.length, len: ttsChunks[chunkIndex].length, attempt: attempt });
    var fetchOpts = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: ttsChunks[chunkIndex] })
    };
    if (window.authToken) fetchOpts.headers['Authorization'] = 'Bearer ' + window.authToken;
    return fetch(serverBase + '/api/tts', fetchOpts).then(function(res) {
      if (!res.ok) {
        if (res.status >= 500 && attempt < TTS_CLIENT_RETRIES) {
          return new Promise(function(r) { setTimeout(r, TTS_CLIENT_DELAY); })
            .then(function() { return fetchChunkBlob(chunkIndex, attempt + 1); });
        }
        ttsBeacon('server-error', { chunk: chunkIndex + 1, status: res.status });
        throw new Error('server ' + res.status);
      }
      return res.arrayBuffer().then(function(buf) {
        ttsBeacon('fetch-ok', { chunk: chunkIndex + 1, of: ttsChunks.length, bytes: buf.byteLength });
        return ctx.decodeAudioData(buf);
      });
    }).catch(function(err) {
      if (attempt < TTS_CLIENT_RETRIES) {
        return new Promise(function(r) { setTimeout(r, TTS_CLIENT_DELAY); })
          .then(function() { return fetchChunkBlob(chunkIndex, attempt + 1); });
      }
      throw err;
    });
  }

  // Prefetch cache: _blobP[i] is a Promise<AudioBuffer>, fetched at most once.
  var _blobP = [];
  function ensureBlob(i) {
    if (i < 0 || i >= ttsChunks.length) return null;
    if (!_blobP[i]) _blobP[i] = fetchChunkBlob(i, 1);
    return _blobP[i];
  }

  function playChunk(i) {
    if (ttsNonce !== myNonce) { ttsLog('nonce stale, aborting'); return; }
    if (i >= ttsChunks.length) { ttsReset(); return; }

    ensureBlob(i).then(function(buffer) {
      if (ttsNonce !== myNonce) return;
      var src = ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(ctx.destination);
      src.onended = function() {
        ttsLog('chunk ended', (i + 1));
        if (ttsNonce !== myNonce) return;
        playChunk(i + 1);
      };
      ttsCurrentAudio = src;
      src.start();
      ttsBeacon('playing', { chunk: i + 1 });
      ttsLog('playing chunk', (i + 1));
      // Prefetch the NEXT chunk only now that this one is playing — at most ONE
      // /api/tts synth in flight (no concurrent-synth burst), still gapless
      // because playback far outlasts the next fetch.
      ensureBlob(i + 1);
    }).catch(function(err) {
      if (ttsNonce !== myNonce) return;
      // One piece failed to synthesize (e.g. an Edge-TTS 500). Don't kill the
      // whole message — skip it and continue with the next piece.
      ttsBeacon('server-error', { chunk: i + 1, fatal: false, skip: true, msg: String((err && err.message) || err) });
      ttsLog('chunk fetch failed, skipping', err);
      if (i + 1 < ttsChunks.length) playChunk(i + 1);
      else ttsReset();
    });
  }

  playChunk(0);
};

// --- Event Listeners (attached after DOM ready) ---
document.addEventListener('DOMContentLoaded', function() {
  const messageInput = $('#message-input');
  const commandPicker = $('#command-picker');
  const sendBtn = $('#send-btn-new');
  const stopBtn = $('#stop-btn');
  const attachBtn = $('#attach-btn');
  const fileInput = $('#file-input');
  const headerTitle = $('#header-title');
  const renameDialog = $('#rename-dialog');
  const renameInput = $('#rename-input');
  const sidebarOverlay = $('#sidebar-overlay');
  const sessionList = $('#session-list');

  $('#menu-btn').onclick = openSidebar;
  sidebarOverlay.onclick = closeSidebar;

  // Swipe right from left edge to open sidebar
  let touchStartX = 0;
  let touchStartY = 0;
  document.addEventListener('touchstart', function(e) {
    touchStartX = e.touches[0].clientX;
    touchStartY = e.touches[0].clientY;
  }, { passive: true });

  document.addEventListener('touchend', function(e) {
    const dx = e.changedTouches[0].clientX - touchStartX;
    const dy = Math.abs(e.changedTouches[0].clientY - touchStartY);
    if (touchStartX < 50 && dx > 60 && dy < 80) {
      openSidebar();
    }
  }, { passive: true });

  // Sidebar header removed — new session via team launcher (all-teams-btn).
  // Grid view removed — list view is the only mode. Clean up any legacy flag.
  try { localStorage.removeItem('151-terminal-grid'); } catch(e) {}
  if (sessionList) sessionList.classList.remove('grid-view');

  // ROUND CHAT bug 4 instrumentation (2026-08-16): today's 3 no-op stop taps
  // left ZERO trace — the 15/8 send/tap probe lived only uncommitted in core.js
  // and was wiped by this morning's rewrite (353a19a). Minimal targeted beacons,
  // auto-expire 2026-09-15, never touch the input path.
  var _STOP_PROBE_UNTIL = 1789430400000; // 2026-09-15T00:00Z
  function _stopProbe(tag, data) {
    try {
      if (Date.now() < _STOP_PROBE_UNTIL && typeof window.syncBeacon === 'function') window.syncBeacon(tag, data);
    } catch (e) {}
  }

  stopBtn.onclick = function() {
    haptic(25);
    // Bug 4 FIX: the old handler fired ws.send with NO readyState check — on a
    // CONNECTING/CLOSED socket (screen-off socket death, deploy-restart gap)
    // send() THROWS, the whole handler dies silently and the tap does exactly
    // nothing, with no feedback. Now: truth first, feedback always.
    var _wsOpen = !!(ws && ws.readyState === WebSocket.OPEN);
    _stopProbe('STOP-TAP', {
      sid: activeSessionId || null, wsOpen: _wsOpen ? 1 : 0,
      streaming: window.streaming ? 1 : 0
    });
    if (!activeSessionId) return;
    if (!_wsOpen) {
      if (typeof showToast === 'function') showToast('Connection lost — reconnecting, tap Stop again in a moment', 'error');
      try { connectWebSocket(activeSessionId); } catch (e) {}
      return;
    }
    // Pending state until the server acks with `stopped` (handled in ws.js).
    stopBtn.style.opacity = '0.45';
    if (window._stopAckTimer) clearTimeout(window._stopAckTimer);
    window._stopAckPending = Date.now();
    window._stopAckTimer = setTimeout(function() {
      if (window._stopAckPending) {
        window._stopAckPending = null;
        stopBtn.style.opacity = '';
        if (typeof showToast === 'function') showToast('Stop not confirmed by the server', 'error');
        _stopProbe('STOP-NOACK', { sid: activeSessionId || null });
      }
    }, 2500);
    if (ws && activeSessionId) {
      try {
        // [17/10/2026] source:'button' = il tasto rosso: il server ferma anche
        // i lavori in sottofondo (lo stop di un messaggio scritto no).
        ws.send(JSON.stringify({ type: 'stop', source: 'button' }));
      } catch (e) {
        window._stopAckPending = null;
        if (window._stopAckTimer) { clearTimeout(window._stopAckTimer); window._stopAckTimer = null; }
        stopBtn.style.opacity = '';
        if (typeof showToast === 'function') showToast('Stop not sent (unstable connection) — try again', 'error');
        _stopProbe('STOP-SEND-FAIL', { sid: activeSessionId || null, err: (e && e.message) || '' });
        return;
      }
      var partialBeforeStop = window.streamingText || '';
      setTimeout(function() {
        // Finalize old streaming element so partial response is preserved
        if (window.streamingEl) {
          if (partialBeforeStop) {
            window.finalizeStreamingMessage(partialBeforeStop + '\n\n*[Stopped]*');
          } else {
            if (window.streamingEl.isConnected) try { window.streamingEl.remove(); } catch(e) {}
            window.streamingEl = null;
          }
        }
        setStreamingState(false);
        var followUp = '[The user manually stopped your response. Acknowledge briefly that you were interrupted and ask what they need — keep it to one short sentence.]';
        var nonce = generateNonce();
        window.markNonceRendered(nonce);
        setStreamingState(true);
        streamingText = ''; thinkingText = '';
        autoScroll = true;
        updateStatusDot('busy');
        window.showThinkingState();
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'message', content: followUp, attachments: [], nonce: nonce }));
        }
      }, 800);
    }
  };

  // --- Voice Auto-Send ---
  // /send — waits 3s then sends (gives time to keep dictating)
  // /end — sends immediately (use at the end of a message)
  let autoSendTimer = null;
  const AUTO_SEND_TRIGGER = /\s*\/send\s*$/i;
  const AUTO_END_TRIGGER = /\s*\/end\s*$/i;
  const AUTO_SEND_DELAY = 3000; // 3 seconds

  window.checkAutoSend = function checkAutoSend() {
    if (autoSendTimer) { clearTimeout(autoSendTimer); autoSendTimer = null; }
    const val = messageInput.value;
    // /end → immediate send
    if (AUTO_END_TRIGGER.test(val)) {
      messageInput.value = val.replace(AUTO_END_TRIGGER, '').trim();
      autoResize();
      if (messageInput.value) window.sendMessage();
      return;
    }
    // /send → delayed send (3s) — read fresh value when timer fires
    if (AUTO_SEND_TRIGGER.test(val)) {
      autoSendTimer = setTimeout(function() {
        var current = messageInput.value;
        messageInput.value = current.replace(AUTO_SEND_TRIGGER, '').trim();
        autoResize();
        if (messageInput.value) window.sendMessage();
        autoSendTimer = null;
      }, AUTO_SEND_DELAY);
    }
  };

  messageInput.oninput = function() {
    autoResize();
    const val = messageInput.value;
    if (val.startsWith('/') && !val.includes(' ')) {
      window.showCommands(val.slice(1));
    } else {
      window.hideCommands();
    }
    window.checkAutoSend();
  };

  messageInput.onkeydown = function(e) {
    // Let command picker handle navigation keys first
    if (window.commandPickerNavigate(e)) return;

    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      var sessionId = window.activeSessionId;
      var hist = (sessionId && _inputHistory[sessionId]) || [];
      if (!hist.length) return;

      var cursorAtStart = messageInput.selectionStart === 0 && messageInput.selectionEnd === 0;
      var cursorAtEnd = messageInput.selectionStart === messageInput.value.length;
      var isEmpty = messageInput.value === '';

      if (e.key === 'ArrowUp' && (isEmpty || cursorAtStart)) {
        e.preventDefault();
        if (_historyIndex === -1) {
          // First Up press — save current draft
          _historyDraft = messageInput.value;
          _historyIndex = hist.length - 1;
        } else if (_historyIndex > 0) {
          _historyIndex--;
        }
        messageInput.value = hist[_historyIndex];
        autoResize();
        // Move cursor to start so repeated Up works correctly
        messageInput.setSelectionRange(0, 0);
      } else if (e.key === 'ArrowDown' && (isEmpty || cursorAtEnd)) {
        e.preventDefault();
        if (_historyIndex === -1) return;
        if (_historyIndex < hist.length - 1) {
          _historyIndex++;
          messageInput.value = hist[_historyIndex];
        } else {
          // Past the end — restore the draft
          _historyIndex = -1;
          messageInput.value = _historyDraft;
        }
        autoResize();
        // Move cursor to end
        var len = messageInput.value.length;
        messageInput.setSelectionRange(len, len);
      }
      return;
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      console.log('[attach] Enter keydown', {
        pendingFiles: (window.pendingFiles && window.pendingFiles.length) || 0,
        path: 'messageInput.onkeydown:Enter'
      });
      window.sendMessage();
    }
  };

  // Close picker when tapping outside
  document.addEventListener('click', function(e) {
    if (!e.target.closest('#command-picker') && !e.target.closest('#message-input')) {
      window.hideCommands();
    }
  });

  if (!attachBtn) {
    console.error('[attach] #attach-btn not found at bind time');
  } else if (!fileInput) {
    console.error('[attach] #file-input not found at bind time');
  } else {
    attachBtn.addEventListener('click', function(ev) {
      console.log('[attach] tap');
      haptic(10);
      var Cap = window.Capacitor;
      var hasNativePicker = !!(Cap && Cap.isNativePlatform && Cap.isNativePlatform()
        && Cap.Plugins && Cap.Plugins.FilePicker
        && typeof Cap.Plugins.FilePicker.pickFiles === 'function');

      if (hasNativePicker) {
        // Fire-and-forget; if it rejects (plugin missing / not registered), fall back.
        var nativePromise;
        try {
          nativePromise = Cap.Plugins.FilePicker.pickFiles({ types: ['*/*'], readData: false, limit: 0 });
        } catch (syncErr) {
          console.warn('[attach] native picker threw sync, using web fallback:', syncErr);
          try { fileInput.click(); } catch(e) { console.error('[attach] fileInput.click() failed:', e); }
          return;
        }
        Promise.resolve(nativePromise).then(function(result) {
          var picked = (result && result.files) || [];
          if (picked.length) window.addFiles(picked);
        }).catch(function(err) {
          console.warn('[attach] native picker rejected, using web fallback:', err);
          // User gesture is lost here; best we can do is click the input anyway.
          try { fileInput.click(); } catch(e) { console.error('[attach] fileInput.click() failed:', e); }
        });
        return;
      }

      // No native picker available — trigger web file input SYNCHRONOUSLY
      // (Android WebView requires the click() to happen within the user gesture).
      console.log('[attach] using web fallback (no native FilePicker)');
      try {
        fileInput.click();
      } catch (e) {
        console.error('[attach] fileInput.click() failed:', e);
      }
    });
  }
  fileInput.onchange = function() {
    window.addFiles(Array.from(fileInput.files));
    fileInput.value = '';
  };

  headerTitle.onclick = function() {
    if (activeSessionId) openRenameDialog(activeSessionId);
  };

  $('#rename-cancel').onclick = closeRenameDialog;
  $('#rename-save').onclick = function() {
    const id = renameDialog.dataset.sessionId;
    const title = renameInput.value.trim();
    if (id && title) {
      renameSession(id, title);
      closeRenameDialog();
    }
  };

  renameInput.onkeydown = function(e) {
    if (e.key === 'Enter') $('#rename-save').click();
    if (e.key === 'Escape') closeRenameDialog();
  };

  // Dictation (mic button, STT) is handled entirely by public/js/dictation.js.

  // Send button: always sends
  sendBtn.onclick = function() {
    console.log('[attach] send-btn click', {
      pendingFiles: (window.pendingFiles && window.pendingFiles.length) || 0,
      path: 'send-btn.onclick'
    });
    window.sendMessage();
  };

  // --- Keyboard / composer-visibility sync ---
  // Problem: Android default adjustResize shrinks the WebView when the keyboard
  // opens, so the composer (flex column, margin-bottom: var(--bottom-inset))
  // rides up naturally. BUT if the user backgrounds the app with the keyboard
  // open and returns, the native keyboard is still on screen while the WebView
  // has been restored at full height — no resize event fires, so the composer
  // sits behind the keyboard. Fix: track keyboard height via visualViewport and
  // Capacitor Keyboard plugin events, expose --keyboard-height, and re-sync on
  // every resume.
  var root = document.documentElement;

  // [2026-10-01] Il tracciante TYPING-TRACE (6413ed8) che ha trovato la causa
  // del tremolio è stato tolto: cura confermata dal proprietario, era codice da buttare.

  // [2026-09-30] CURA DEL TREMOLIO (misurata col tracciante TYPING-TRACE su un telefono vero, 30/09 — tolto il 01/10).
  // Quello che il tracciante ha visto, sul telefono vero:
  //  (1) con la tastiera aperta la WebView NON si rimpicciolisce più
  //      (innerHeight resta 832: targetSdk 36 = edge-to-edge, adjustResize
  //      ignorato). Il browser invece PANORAMICA il visual viewport di ~350px
  //      per mostrare il cursore — e lo ritocca di 1px a OGNI tasto (357↔358);
  //  (2) due padroni per la stessa variabile: il plugin Keyboard scriveva 315,
  //      e 10ms dopo il visualViewport la riscriveva a 0, perché la formula
  //      sottraeva offsetTop (832−517−300 = 15 → «tastiera chiusa»). Il
  //      compositore saliva di 315px e ricadeva: il su-e-giù che vedeva il proprietario.
  // Cura: (a) viewport meta `interactive-widget=resizes-content` (index.html),
  // che rimette il comportamento adjustResize per cui il CSS è scritto;
  // (b) UN solo padrone — il visualViewport; il plugin serve solo da sveglia
  // per rimisurare; (c) formula senza offsetTop; (d) scroll e classi solo
  // quando il valore CAMBIA, mai a ogni evento.
  var _kbLast = -1;
  function setKbHeight(px) {
    var v = Math.max(0, Math.round(px || 0));
    if (v === _kbLast) return; // stesso valore: niente scroll, niente layout
    _kbLast = v;
    root.style.setProperty('--keyboard-height', v + 'px');
    document.body.classList.toggle('keyboard-open', v > 0);
    // Snap composer/messages into view when keyboard appears mid-resume
    if (v > 0) {
      // If the field being typed into is the Cloud tree-wide search box (top of
      // the sidebar), do NOT yank the chat composer into view — that pushed the
      // search input off the top of the screen so you couldn't see what you
      // typed. Just keep the page pinned to the top so the search box stays put.
      var ae = document.activeElement;
      if (ae && ae.id === 'files-search-input') {
        window.scrollTo(0, 0);
        try { ae.scrollIntoView({ block: 'center', behavior: 'instant' }); } catch(e) {}
        return;
      }
      // Super-Agent inline compose (sidebar card textarea, Round 3 2026-08-16):
      // do NOT yank the chat composer into view — that shoved the whole screen
      // up and parked the compose Send button at the top, unreachable. The
      // sidebar's bottom is lifted above the keyboard via --keyboard-height
      // (body.keyboard-open #sidebar rule); here we just keep the page pinned
      // and scroll the compose panel (textarea + Send) into the visible strip.
      if (ae && ae.classList && ae.classList.contains('agent-compose-input')) {
        window.scrollTo(0, 0);
        var panel = ae.closest ? ae.closest('.agent-compose') : null;
        try { (panel || ae).scrollIntoView({ block: 'center', behavior: 'instant' }); } catch(e) {}
        return;
      }
      var ia = document.getElementById('input-area');
      if (ia) {
        try { ia.scrollIntoView({ block: 'end', behavior: 'instant' }); } catch(e) {}
      }
      window.scrollTo(0, 0);
    }
  }

  function measureFromVisualViewport() {
    if (!window.visualViewport) return -1;
    // When keyboard is up, visualViewport.height < layout height.
    var layoutH = window.innerHeight;
    var vvH = window.visualViewport.height;
    // NIENTE offsetTop: quando il browser panoramica la vista per mostrare il
    // cursore, offsetTop cresce ma la tastiera è sempre lì (vedi cura sopra).
    var diff = layoutH - vvH;
    return diff > 80 ? diff : 0; // ignore small toolbars
  }

  // [2026-09-30, secondo giro] LA CORNICE SEGUE L'AREA VISIBILE — cura vera.
  // Dopo il primo giro il proprietario: «il riquadro vola su, spazio morto, non sta sopra
  // la tastiera». Misurato: il compositore saliva DUE volte — margin-bottom
  // di 358px (--keyboard-height) PIÙ la panoramica del telefono (vvTop fino a
  // 300). Nel telefono nativo non si rincorre più la tastiera con un margine:
  // #app diventa fixed, alto QUANTO il visualViewport e posato DOVE sta
  // (offsetTop). Qualunque panoramica faccia il browser, la cornice riempie
  // esattamente lo schermo sopra la tastiera: barra in cima, compositore
  // appoggiato alla tastiera, messaggi in mezzo. CSS: body.vv-shell in main.css.
  // Capacitor in modalità URL remoto può arrivare DOPO il caricamento di questo
  // file: si ricontrolla a ogni misura, e l'accensione è una volta sola.
  var SHELL = false;
  var _shH = -1, _shT = -1;
  function shellOn() {
    if (SHELL) return true;
    if (window.visualViewport && window.Capacitor &&
        typeof window.Capacitor.isNativePlatform === 'function' && window.Capacitor.isNativePlatform()) {
      SHELL = true;
      document.body.classList.add('vv-shell');
      fitShell();
    }
    return SHELL;
  }
  function fitShell() {
    var vv = window.visualViewport;
    var h = Math.round(vv.height), top = Math.round(vv.offsetTop);
    if (h === _shH && top === _shT) return;
    var m = document.getElementById('messages');
    var pinned = m && (m.scrollHeight - m.clientHeight - m.scrollTop) < 80;
    _shH = h; _shT = top;
    root.style.setProperty('--app-h', h + 'px');
    root.style.setProperty('--app-top', top + 'px');
    root.style.setProperty('--keyboard-height', '0px'); // mai margine in più: la cornice basta
    document.body.classList.toggle('keyboard-open', (window.innerHeight - h) > 80);
    // Eri in fondo alla chat? Ci resti anche se la cornice si è accorciata.
    if (pinned) m.scrollTop = m.scrollHeight;
  }
  shellOn();

  function syncFromVisualViewport(e) {
    if (shellOn()) { fitShell(); return; }
    var h = measureFromVisualViewport();
    if (h >= 0) setKbHeight(h);
  }

  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', syncFromVisualViewport);
    window.visualViewport.addEventListener('scroll', syncFromVisualViewport);
  }

  // Capacitor Keyboard plugin (authoritative on native, fires even when
  // visualViewport event doesn't — e.g. on resume with keyboard already open).
  function wireKeyboardPlugin() {
    if (!(window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Keyboard)) return false;
    var Kb = window.Capacitor.Plugins.Keyboard;
    shellOn();
    try {
      // Con visualViewport il plugin NON scrive l'altezza: sveglia e basta
      // (il visualViewport è l'unico padrone). Senza, resta il ripiego vecchio.
      var vvOwns = !!window.visualViewport;
      Kb.addListener('keyboardWillShow', function(info) { vvOwns ? setTimeout(syncFromVisualViewport, 60) : setKbHeight(info && info.keyboardHeight); });
      Kb.addListener('keyboardDidShow',  function(info) { vvOwns ? syncFromVisualViewport() : setKbHeight(info && info.keyboardHeight); });
      Kb.addListener('keyboardWillHide', function() { vvOwns ? setTimeout(syncFromVisualViewport, 60) : setKbHeight(0); });
      Kb.addListener('keyboardDidHide',  function() { vvOwns ? syncFromVisualViewport() : setKbHeight(0); });
    } catch(e) { console.warn('[KB] listener wire failed', e); }
    return true;
  }
  if (!wireKeyboardPlugin()) {
    // Plugins may not be ready at load in remote-URL mode — retry briefly.
    var tries = 0;
    var iv = setInterval(function() {
      if (wireKeyboardPlugin() || ++tries > 20) clearInterval(iv);
    }, 250);
  }

  // THE BUG FIX: on resume / visibility restore, the keyboard may still be up
  // natively but the WebView won't fire a resize. Force a re-measure, and if
  // the focused element is our textarea, ask the Keyboard plugin (if present)
  // or rely on visualViewport's post-resume tick.
  function onResume() {
    // Give WebView a tick to settle, then remeasure twice (first tick often
    // still reports full height before Android re-applies the IME inset).
    setTimeout(syncFromVisualViewport, 50);
    setTimeout(syncFromVisualViewport, 300);
    setTimeout(function() {
      // If textarea still focused and we have 0 kb height but the native
      // keyboard is up, nudge focus to re-trigger the IME inset.
      // In modalità cornice --keyboard-height è SEMPRE 0 apposta: questa spinta
      // chiuderebbe e riaprirebbe la tastiera a ogni ritorno. La cornice rilegge
      // già il visualViewport ai tick qui sopra.
      if (!shellOn() && document.activeElement === messageInput && parseInt(getComputedStyle(root).getPropertyValue('--keyboard-height')) === 0) {
        try {
          messageInput.blur();
          // Short delay before refocusing so Android re-issues the show event.
          setTimeout(function() { messageInput.focus(); }, 50);
        } catch(e) {}
      }
    }, 500);
  }

  document.addEventListener('visibilitychange', function() {
    if (document.visibilityState === 'visible') onResume();
  });
  window.addEventListener('pageshow', onResume);
  window.addEventListener('focus', onResume);

  if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App) {
    try {
      window.Capacitor.Plugins.App.addListener('appStateChange', function(state) {
        if (state && state.isActive) onResume();
      });
      window.Capacitor.Plugins.App.addListener('resume', onResume);
    } catch(e) {}
  }

  // Global keyboard shortcuts
  document.addEventListener('keydown', function(e) {
    // Ctrl+K or Cmd+K — focus input
    if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
      e.preventDefault();
      messageInput.focus();
      return;
    }
    // Escape — stop generation if streaming, or blur input
    if (e.key === 'Escape') {
      if (window.streaming) {
        e.preventDefault();
        var stopBtn = document.getElementById('stop-btn');
        if (stopBtn) stopBtn.click();
        return;
      }
      messageInput.blur();
      return;
    }
    // Ctrl+N or Cmd+N — new session (when not typing)
    if ((e.ctrlKey || e.metaKey) && e.key === 'n' && document.activeElement !== messageInput) {
      e.preventDefault();
      var allTeamsBtn = document.getElementById('all-teams-btn');
      if (allTeamsBtn) allTeamsBtn.click();
      return;
    }
  });
});
