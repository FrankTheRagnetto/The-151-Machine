/* The 151 Machine — Chat: messages, streaming, activity, scroll */

// --- Inline SVG icons (mirror bottom input-bar style: 18x18, stroke currentColor, sw 2) ---
window.ICON_COPY = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
window.ICON_CHECK = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>';
window.ICON_SPEAKER = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>';

window.ICON_STOP = '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="1.5"/></svg>';

// Returns Promise<boolean> — true ONLY when the text really landed on the
// clipboard, so callers show "Copiato!" only on genuine success.
window.copyToClipboard = function(text) {
  // Async Clipboard API is reliable ONLY in a secure context. On the PHONE the
  // app loads over plain http (Tailscale) = NON-secure: navigator.clipboard may
  // still exist but writeText() rejects ASYNCHRONOUSLY — and by the time that
  // .catch fires the click's user-gesture has expired, so a fallback execCommand
  // there silently returns false. THAT is the intermittent "copy didn't work".
  // So in a non-secure context we skip straight to the synchronous fallback,
  // which runs INSIDE the gesture and copies reliably + repeatably.
  if (navigator.clipboard && navigator.clipboard.writeText && window.isSecureContext) {
    return navigator.clipboard.writeText(text)
      .then(function() { return true; })
      .catch(function() { return fallbackCopy(text); });
  }
  return Promise.resolve(fallbackCopy(text));
  // readonly stops the mobile keyboard stealing focus; setSelectionRange is
  // required for the selection to stick inside the Android WebView.
  function fallbackCopy(t) {
    try {
      var ta = document.createElement('textarea');
      ta.value = t;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.top = '-9999px';
      ta.style.left = '-9999px';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      try { ta.setSelectionRange(0, t.length); } catch(e) {}
      var ok = false;
      try { ok = document.execCommand('copy'); } catch(e) { ok = false; }
      document.body.removeChild(ta);
      return ok;
    } catch(e) {
      return false;
    }
  }
};

// --- State vars (shared cross-file via window) ---
window.streamingEl = null;
window.streamingText = '';
window.thinkingText = '';

window.getSessionById = function(sessionId) {
  if (!sessionId || !window.sessions) return null;
  return window.sessions.find(function(s) { return s.id === sessionId; }) || null;
};

// Strip harness interruption markers from user bubbles at render time.
// input.js wraps user interjections with [INTERRUPTION: ...] / [Take note ...]
// so the server-side Claude CLI gets context. the owner should never see these
// scaffolding markers in his own messages — strip them before display/copy.
window.stripInterruptionMarkers = function(content) {
  if (content == null) return '';
  var out = String(content);
  // Leading [INTERRUPTION: ...] header — may span multiple lines. Consume the
  // trailing ":]\n\n" so only the user's actual text remains.
  out = out.replace(/^\s*\[INTERRUPTION:[\s\S]*?\]\s*\n*/, '');
  // Trailing [Take note ...] / [...continue accordingly.] footer.
  out = out.replace(/\n*\s*\[Take note[\s\S]*?\]\s*$/, '');
  return out.trim();
};

window.saveLiveStreamState = function(sessionId, patch) {
  var session = window.getSessionById(sessionId);
  if (!session) return;
  if (!session._liveStream) session._liveStream = {};
  if (patch && typeof patch === 'object') {
    Object.assign(session._liveStream, patch);
  }
};

window.clearLiveStreamState = function(sessionId) {
  var session = window.getSessionById(sessionId);
  if (session) delete session._liveStream;
};

// Detect [mockup:URL label] patterns and replace with iframes
const MOCKUP_RE = /\[mockup:(https?:\/\/[^\s\]]+)\s*([^\]]*)\]/g;

function formatTime(date) {
  const d = date || new Date();
  const h = d.getHours();
  const m = d.getMinutes();
  return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m;
}

function formatRelativeTime(date) {
  if (!date) return '';
  const now = new Date();
  const d = new Date(date);
  const diffMs = now - d;
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHr = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHr / 24);

  if (diffSec < 60) return 'just now';
  if (diffMin < 60) return diffMin + 'm ago';
  if (diffHr < 24) return diffHr + 'h ago';
  if (diffDay === 1) return 'yesterday';
  if (diffDay < 7) return diffDay + 'd ago';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

window.appendMessage = function(role, content, timestamp, animate, attachments) {
  const div = document.createElement('div');
  div.className = 'message ' + role;
  if (animate !== false) div.classList.add('new-msg');
  // For user messages, strip interruption markers before render so the owner never
  // sees the [INTERRUPTION: ...] / [Take note ...] harness scaffolding. The
  // server/CLI still receives the wrapped version via input.js — this is a
  // pure display transform. Assistant messages pass through unchanged.
  var displayContent = content;
  if (role === 'user' && typeof window.stripInterruptionMarkers === 'function') {
    displayContent = window.stripInterruptionMarkers(content);
  }
  if (typeof window.computeMsgKey === 'function') {
    div.dataset.msgKey = window.computeMsgKey({ role: role, content: content });
  }

  // Meta line (role label + timestamp)
  const meta = document.createElement('div');
  meta.className = 'msg-meta';
  // 'comando' = l'uscita di un «!comando» (server/comando-chat.js): la scrive il PC.
  const roleLabel = role === 'user' ? 'You' : (role === 'comando' ? 'PC' : 'Claude');
  const time = formatTime(timestamp ? new Date(timestamp) : new Date());
  meta.innerHTML = '<span class="msg-role">' + roleLabel + '</span><span>' + time + '</span>';
  div.appendChild(meta);

  // Attachment indicator — show "📎 name1, name2" when this message carried files.
  // Attachment objects are { path, name, mime, size } (see core.js uploadAttachments).
  if (attachments && attachments.length) {
    const attWrap = document.createElement('div');
    attWrap.className = 'msg-attachments';
    const names = [];
    for (var _ai = 0; _ai < attachments.length; _ai++) {
      var _a = attachments[_ai];
      names.push((_a && (_a.name || _a.filename)) || 'file');
    }
    attWrap.textContent = '📎 ' + names.join(', ');
    attWrap.title = names.join(', ');
    div.appendChild(attWrap);
  }

  // Status line for user messages
  if (role === 'user') {
    const statusLine = document.createElement('div');
    statusLine.className = 'msg-status sent';
    statusLine.textContent = animate !== false ? 'Sent' : '';
    div._statusLine = statusLine;
  }

  // Content
  const body = document.createElement('div');
  const _optParts = role === 'assistant' ? window.PezzoBottoni.separa(content) : null;
  if (role === 'assistant') {
    // [2026-10-09] Solo il VERO pezzo dei bottoni A/B diventa bottoni
    // (pezzo-bottoni.js): citato nel codice o nel testo resta visibile.
    const noOpts = _optParts.body;
    const mockups = [];
    const cleanContent = window.PezzoBottoni.mostraCitazioni(noOpts).replace(MOCKUP_RE, function(match, url, label) {
      const id = 'mockup-' + mockups.length;
      mockups.push({ id: id, url: url, label: label.trim() || 'Mockup' });
      return '<div id="' + id + '"></div>';
    });
    try {
      body.innerHTML = DOMPurify.sanitize(marked.parse(cleanContent));
      for (let i = 0; i < mockups.length; i++) {
        const placeholder = body.querySelector('#' + mockups[i].id);
        if (placeholder) {
          placeholder.innerHTML =
            '<div class="mockup-label">' + escapeHtml(mockups[i].label) + '</div>' +
            '<iframe class="mockup-frame" src="' + escapeHtml(mockups[i].url) + '" sandbox="allow-scripts allow-same-origin" loading="lazy"></iframe>';
        }
      }
      window.addCodeCopyButtons(body);
    } catch(e) {
      // marked/DOMPurify unavailable (offline shell / partial cache) — don't let
      // the whole history render throw and vanish the message.
      body.textContent = noOpts;
    }
  } else {
    // [2026-10-01] I messaggi del proprietario con la loro forma (il proprietario: «copio un
    // messaggio formattato e lo incollo in un'altra sessione, o lo formatto
    // io a mano: a capo, elenchi… e nella bolla diventa un muro»). Prima era
    // textContent senza white-space: gli a-capo collassavano. Ora la stessa
    // resa markdown delle risposte (marked con breaks:true, sanificato).
    try {
      body.className = 'user-md';
      body.innerHTML = DOMPurify.sanitize(marked.parse(window.PezzoBottoni.mostraCitazioni(displayContent || '')));
    } catch (e) {
      body.className = 'user-plain';
      body.textContent = displayContent;
    }
  }
  div.appendChild(body);

  const copyBtn = document.createElement('button');
  copyBtn.className = 'copy-btn';
  // Both roles use the glyph icon — the user bubble used to spell out the word
  // "Copy", which read as stray body text next to the message.
  const copyIdleHTML = window.ICON_COPY;
  const checkHTML = window.ICON_CHECK;
  copyBtn.innerHTML = copyIdleHTML;
  copyBtn.setAttribute('aria-label', 'Copy message');
  // For user messages, copy what's displayed (markers stripped) so clipboard
  // matches the bubble. For assistant, the text minus the real A/B block only.
  // [08/11/2026] (2): _optParts esiste solo per le risposte di Claude.
  // Prima ogni ruolo non-«user» leggeva _optParts.body: il messaggio «PC» di un
  // «!comando» lanciava, non nasceva mai e fermava il disegno della storia
  // (riaprendo la chat sparivano «PC» e la risposta). tests/bolla-pc.test.js
  const copyText = role === 'assistant'
    ? _optParts.body
    : (displayContent || '');
  copyBtn.onclick = function() {
    window.copyToClipboard(copyText || div.textContent).then(function(ok) {
      if (!ok) return;
      copyBtn.innerHTML = checkHTML;
      copyBtn.classList.add('copied');
      setTimeout(function() {
        copyBtn.innerHTML = copyIdleHTML;
        copyBtn.classList.remove('copied');
      }, 1500);
    });
  };
  div.appendChild(copyBtn);

  // TTS listen button for assistant messages — always attach (feature-detect at click time)
  if (role === 'assistant') {
    const listenBtn = document.createElement('button');
    listenBtn.className = 'listen-btn';
    listenBtn.innerHTML = window.ICON_SPEAKER;
    listenBtn.setAttribute('aria-label', 'Listen to message');
    listenBtn.onclick = function() {
      window.ttsSpeak(copyText || div.textContent, listenBtn);
    };
    div.appendChild(listenBtn);
  }

  // Render options buttons for assistant messages (history)
  if (role === 'assistant') {
    div._body = body;
    parseAndRenderOptions(div, _optParts.options);
  }

  // Append status line for user messages (after copy btn)
  if (role === 'user' && div._statusLine) {
    div.appendChild(div._statusLine);
  }

  messagesEl.appendChild(div);
  window.scrollToBottom();
  return div;
};

function markLastUserStatus(text, className) {
  const msgs = messagesEl.querySelectorAll('.message.user');
  if (msgs.length === 0) return;
  const last = msgs[msgs.length - 1];
  const status = last.querySelector('.msg-status');
  if (status) {
    status.textContent = text;
    status.className = 'msg-status ' + className;
  }
}

let _renderTimer = null;
let _mdRenderTimer = null;
let _lastMdRender = '';

window.updateStreamingMessage = function(fullText) {
  // [2026-11-10 BATTERIA ] Si scorre solo quando l'altezza cambia davvero:
  // bolla nuova, puntini tolti, o il testo ridisegnato (ogni 120 ms, sotto).
  // Prima un requestAnimationFrame + lettura di scrollHeight a OGNI pezzo,
  // anche quando la bolla non era cambiata di un pixel.
  var cambiaAltezza = false;
  if (!window.streamingEl) {
    cambiaAltezza = true;
    window.streamingEl = document.createElement('div');
    window.streamingEl.className = 'message assistant streaming';
    var meta = document.createElement('div');
    meta.className = 'msg-meta';
    meta.innerHTML = '<span class="msg-role">Claude</span><span>' + formatTime() + '</span>';
    window.streamingEl.appendChild(meta);
    window.streamingEl._body = document.createElement('div');
    window.streamingEl._body.className = 'streaming-text';
    window.streamingEl.appendChild(window.streamingEl._body);
    messagesEl.appendChild(window.streamingEl);
  }
  // Clear thinking state when real text arrives
  if (window.streamingEl.classList.contains('thinking-state')) {
    window.streamingEl.classList.remove('thinking-state');
    const dots = window.streamingEl._body.querySelector('.thinking-dots');
    if (dots) dots.remove();
    cambiaAltezza = true;
  }
  // Debounced incremental markdown render (every 300ms)
  if (!_mdRenderTimer) {
    _mdRenderTimer = setTimeout(function() {
      _mdRenderTimer = null;
      if (window.streamingEl && window.streamingEl._body && window.streamingText !== _lastMdRender) {
        _lastMdRender = window.streamingText;
        try {
          window.streamingEl._body.innerHTML = DOMPurify.sanitize(marked.parse(
            window.PezzoBottoni.mostraCitazioni(window.PezzoBottoni.separa(window.streamingText, { inDiretta: true }).body)));
          window.addCodeCopyButtons(window.streamingEl._body);
        } catch(e) {
          window.streamingEl._body.textContent = window.streamingText;
        }
        window.scrollToBottom();
      }
    }, 120);
  }
  if (cambiaAltezza && !_renderTimer) {
    _renderTimer = requestAnimationFrame(function() {
      _renderTimer = null;
      window.scrollToBottom();
    });
  }
};

function renderMockups(el, text) {
  const mockups = [];
  const clean = (text || '').replace(MOCKUP_RE, function(match, url, label) {
    const id = 'mockup-' + Math.random().toString(36).slice(2, 8);
    mockups.push({ id: id, url: url, label: label.trim() || 'Mockup' });
    return '<div id="' + id + '"></div>';
  });
  el.innerHTML = DOMPurify.sanitize(marked.parse(clean));
  for (let i = 0; i < mockups.length; i++) {
    const ph = el.querySelector('#' + mockups[i].id);
    if (ph) {
      ph.innerHTML =
        '<div class="mockup-label">' + escapeHtml(mockups[i].label) + '</div>' +
        '<iframe class="mockup-frame" src="' + escapeHtml(mockups[i].url) + '" sandbox="allow-scripts allow-same-origin" loading="lazy"></iframe>';
    }
  }
  window.addCodeCopyButtons(el);
}

window.finalizeStreamingMessage = function(fullText) {
  // Close ALL open tool process groups and force all running cards to "done"
  var openGroups = document.querySelectorAll('.tool-process-group:not(.tool-process-closed)');
  for (var gi = 0; gi < openGroups.length; gi++) {
    openGroups[gi].classList.add('tool-process-closed');
    openGroups[gi].classList.remove('tool-process-open');
    var label = openGroups[gi].querySelector('.tool-process-label');
    if (label) label.textContent = (openGroups[gi]._count || 0) + ' steps completed';
  }
  // Force any lingering "running" tool cards to "done"
  var runningCards = document.querySelectorAll('.tool-activity-card-status:not(.tool-activity-card-done)');
  for (var ri = 0; ri < runningCards.length; ri++) {
    runningCards[ri].textContent = 'done';
    runningCards[ri].classList.add('tool-activity-card-done');
    if (runningCards[ri].closest('.tool-activity-card')) {
      runningCards[ri].closest('.tool-activity-card').classList.add('tool-activity-done');
    }
  }
  // Fallback path: if no streaming element exists in the DOM (delta phase skipped,
  // already finalized, or DOM was wiped mid-stream), append as a normal message so
  // the final content is NEVER lost. We also check isConnected so a stale reference
  // to a detached node doesn't swallow the content.
  var _hasLiveStreamEl = !!(window.streamingEl && (typeof window.streamingEl.isConnected === 'undefined' || window.streamingEl.isConnected));
  if (!_hasLiveStreamEl) {
    // Clear any stale detached reference
    window.streamingEl = null;
    var _appendedEl = null;
    if (fullText) {
      _appendedEl = window.appendMessage('assistant', fullText);
    }
    window.streamingText = ''; window.thinkingText = '';
    window.scrollToBottom();
    return _appendedEl;
  }
  var _finalizedEl = null;
  if (window.streamingEl) {
    // Smooth transition: mark as finalizing, swap content, remove streaming
    window.streamingEl.classList.remove('streaming');
    window.streamingEl.classList.add('finalizing');
    // Flush any pending render timers
    if (_renderTimer) { cancelAnimationFrame(_renderTimer); _renderTimer = null; }
    if (_mdRenderTimer) { clearTimeout(_mdRenderTimer); _mdRenderTimer = null; }
    _lastMdRender = '';

    const bodyEl = window.streamingEl._body || window.streamingEl;
    const finalContent = fullText || window.streamingText;

    // Parse markdown and render (replaces raw text). Strip the <options> block
    // FIRST: parseAndRenderOptions builds the buttons from the raw finalContent
    // below, but DOMPurify removes the unknown <options>/<option> tags while
    // KEEPING their inner text — which would leave the option labels dangling as
    // plain text next to the buttons. Rendering the stripped text avoids that
    // (mirrors the history path, chat.js render which strips before rendering).
    const _finParts = window.PezzoBottoni.separa(finalContent);
    renderMockups(bodyEl, window.PezzoBottoni.mostraCitazioni(_finParts.body));

    // Plant content-hash key so subsequent history_append can dedup against it
    if (typeof window.computeMsgKey === 'function') {
      window.streamingEl.dataset.msgKey = window.computeMsgKey({ role: 'assistant', content: finalContent });
    }

    // Update timestamp to completion time
    const metaTime = window.streamingEl.querySelector('.msg-meta span:last-child');
    if (metaTime) metaTime.textContent = formatTime();

    // Create copy button BEFORE options so parseAndRenderOptions can insert before it
    const copyBtn = document.createElement('button');
    copyBtn.className = 'copy-btn';
    const copyIdleHTML = window.ICON_COPY;
    const checkHTML = window.ICON_CHECK;
    copyBtn.innerHTML = copyIdleHTML;
    copyBtn.setAttribute('aria-label', 'Copy message');
    const cleanText = _finParts.body;
    copyBtn.onclick = function() {
      window.copyToClipboard(cleanText).then(function(ok) {
      if (!ok) return;
      copyBtn.innerHTML = checkHTML;
      copyBtn.classList.add('copied');
      setTimeout(function() { copyBtn.innerHTML = copyIdleHTML; copyBtn.classList.remove('copied'); }, 1500);
      });
    };
    window.streamingEl.appendChild(copyBtn);

    // TTS listen button — always attach (feature-detect at click time)
    {
      const listenBtn = document.createElement('button');
      listenBtn.className = 'listen-btn';
      listenBtn.innerHTML = window.ICON_SPEAKER;
      listenBtn.setAttribute('aria-label', 'Listen to message');
      listenBtn.onclick = function() {
        window.ttsSpeak(cleanText, listenBtn);
      };
      window.streamingEl.appendChild(listenBtn);
    }

    // Parse <options> blocks into tappable buttons (after copy btn exists)
    parseAndRenderOptions(window.streamingEl, _finParts.options);

    // Remove finalizing class after transition
    var _elForTransition = window.streamingEl;
    setTimeout(function() {
      if (_elForTransition) _elForTransition.classList.remove('finalizing');
    }, 150);

    _finalizedEl = window.streamingEl;
    window.streamingEl = null;
  }
  window.streamingText = ''; window.thinkingText = '';
  window.scrollToBottom();

  // Update local history cache with the completed response
  if (activeSessionId) {
    var localSession = sessions.find(function(s) { return s.id === activeSessionId; });
    if (localSession && localSession.history) {
      cacheHistory(activeSessionId, localSession.history);
    }
  }
  // Return the bubble we just finalized so callers (ws.js dedup-key stamping)
  // operate on the CORRECT element instead of the now-nulled global.
  return _finalizedEl;
};

// Bottoni A/B dalle etichette già separate da PezzoBottoni.separa (solo il
// vero pezzo finale). [2026-10-09] Tolta la vecchia pulizia che riscriveva
// l'HTML cancellando ogni «&lt;options&gt;» visibile: ora le citazioni nel
// testo devono restare, e il vero pezzo non arriva mai nell'HTML.
function parseAndRenderOptions(msgEl, opts) {
  if (!Array.isArray(opts) || opts.length === 0) return;

  // Create buttons
  const bar = document.createElement('div');
  bar.className = 'options-bar';
  for (let i = 0; i < opts.length; i++) {
    (function(optText) {
      const btn = document.createElement('button');
      btn.className = 'option-btn';
      btn.textContent = optText;
      btn.onclick = function() {
        messageInput.value = optText;
        sendMessage();
        // Disable all option buttons after selection
        const allBtns = bar.querySelectorAll('.option-btn');
        for (let j = 0; j < allBtns.length; j++) {
          allBtns[j].disabled = true;
          allBtns[j].style.opacity = '0.3';
        }
        btn.style.opacity = '1';
        btn.style.borderColor = 'var(--green)';
        btn.style.color = 'var(--green)';
      };
      bar.appendChild(btn);
    })(opts[i]);
  }

  // Insert before copy button
  const copyBtn = msgEl.querySelector('.copy-btn');
  if (copyBtn) {
    msgEl.insertBefore(bar, copyBtn);
  } else {
    msgEl.appendChild(bar);
  }
}

// Detect language from code block class (e.g. language-js, language-python)
const LANG_LABELS = {
  js: 'JS', javascript: 'JS', ts: 'TS', typescript: 'TS',
  py: 'Python', python: 'Python', rb: 'Ruby', ruby: 'Ruby',
  go: 'Go', rust: 'Rust', java: 'Java', cpp: 'C++', c: 'C',
  cs: 'C#', csharp: 'C#', php: 'PHP', swift: 'Swift',
  kotlin: 'Kotlin', sh: 'Shell', bash: 'Shell', zsh: 'Shell',
  html: 'HTML', css: 'CSS', scss: 'SCSS', json: 'JSON',
  yaml: 'YAML', yml: 'YAML', xml: 'XML', sql: 'SQL',
  md: 'Markdown', markdown: 'Markdown', txt: 'Text',
  gdscript: 'GDScript', gd: 'GDScript', lua: 'Lua',
  toml: 'TOML', ini: 'INI', dockerfile: 'Docker',
};

function detectLang(pre) {
  const code = pre.querySelector('code');
  if (!code) return null;
  const cls = code.className || '';
  const match = cls.match(/language-(\w+)/);
  if (match) return LANG_LABELS[match[1].toLowerCase()] || match[1].toUpperCase();
  return null;
}

window.addCodeCopyButtons = function(container) {
  const pres = container.querySelectorAll('pre');
  for (let i = 0; i < pres.length; i++) {
    const pre = pres[i];
    if (pre.querySelector('.code-copy-btn')) continue;

    // Syntax highlighting
    var codeEl = pre.querySelector('code');
    if (codeEl && window.hljs) {
      try { window.hljs.highlightElement(codeEl); } catch(e) {}
    }

    // Language badge
    const lang = detectLang(pre);
    if (lang) {
      const badge = document.createElement('span');
      badge.className = 'code-lang-badge';
      badge.textContent = lang;
      pre.appendChild(badge);
    }

    // Copy button with checkmark animation
    const btn = document.createElement('button');
    btn.className = 'code-copy-btn';
    // Single glyph, never the word "Copy": on a narrow phone the word collided
    // with the code it sat on top of. \u29c9 idle \u00b7 \u2713 copied \u00b7 \u2715 failed.
    var CODE_COPY_IDLE = '\u29c9';
    btn.textContent = CODE_COPY_IDLE;
    btn.setAttribute('aria-label', 'Copy code');
    btn.setAttribute('title', 'Copy code');
    (function(pre, btn) {
      btn.onclick = function() {
        const code = pre.querySelector('code');
        window.copyToClipboard(code ? code.textContent : pre.textContent).then(function(ok) {
          if (!ok) { btn.textContent = '\u2715'; setTimeout(function() { btn.textContent = CODE_COPY_IDLE; }, 1500); return; }
          btn.textContent = '\u2713';
          btn.classList.add('copied');
          setTimeout(function() { btn.textContent = CODE_COPY_IDLE; btn.classList.remove('copied'); }, 1500);
        });
      };
    })(pre, btn);
    pre.appendChild(btn);

    // Auto-collapse long code blocks (>8 lines)
    const code = pre.querySelector('code');
    const text = code ? code.textContent : pre.textContent;
    const lineCount = (text.match(/\n/g) || []).length + 1;
    if (lineCount > 8 && window.innerWidth < 600) {
      pre.classList.add('collapsed');
      const expandBtn = document.createElement('button');
      expandBtn.className = 'code-expand-btn';
      expandBtn.textContent = 'Show ' + lineCount + ' lines';
      (function(pre, expandBtn, lineCount) {
        expandBtn.onclick = function() {
          if (pre.classList.contains('collapsed')) {
            pre.classList.remove('collapsed');
            expandBtn.textContent = 'Collapse';
          } else {
            pre.classList.add('collapsed');
            expandBtn.textContent = 'Show ' + lineCount + ' lines';
          }
        };
      })(pre, expandBtn, lineCount);
      pre.parentNode.insertBefore(expandBtn, pre.nextSibling);
    }
  }
};

// [2026-10-01] Passaggi intermedi ripiegati in cima alla risposta (il proprietario:
// «solo la risposta finale»). Il testo che la sessione scrive fra uno
// strumento e l'altro non è per lui: sta qui sotto un «▶ Passaggi», chiuso.
window.attachStepsToggle = function(msgEl, steps) {
  if (!msgEl || !Array.isArray(steps) || !steps.length) return;
  if (msgEl.querySelector(':scope .steps-collapsed')) return; // già attaccato
  var bodyEl = msgEl._body || msgEl.querySelector('div:not(.msg-meta)');
  if (!bodyEl) return;
  var text = steps.join('\n\n');
  var toggle = document.createElement('div');
  toggle.className = 'thinking-collapsed steps-collapsed';
  var label = '▶ Steps (' + steps.length + ')';
  toggle.textContent = label;
  toggle.addEventListener('click', function() {
    var next = toggle.nextElementSibling;
    if (next && next.classList.contains('steps-expanded')) {
      next.remove();
      toggle.textContent = label;
    } else {
      var exp = document.createElement('div');
      exp.className = 'thinking-expanded steps-expanded';
      exp.textContent = text;
      toggle.after(exp);
      toggle.textContent = '▼ Steps (' + steps.length + ')';
    }
  });
  bodyEl.insertBefore(toggle, bodyEl.firstChild);
};

// [2026-10-04] RISPOSTA RIFATTA. Il controllo delle regole comuni ha fatto
// rifare una risposta: la versione scartata si chiude in una riga grigia
// SOPRA la risposta buona; toccandola si riapre. Le righe sono elementi a sé
// (non .message), subito prima del fumetto: le pulizie dei doppioni non le
// vedono e il fumetto che arriva in diretta non le cancella.
function buildRedoRow(text, live) {
  var row = document.createElement('div');
  row.className = 'redo-row' + (live ? ' redo-live' : '');
  var label = document.createElement('div');
  label.className = 'redo-label';
  var CHIUSA = '↺ Reply redone: tap to see the first version';
  var APERTA = '▼ First version, discarded';
  label.textContent = CHIUSA;
  label.setAttribute('role', 'button');
  label.tabIndex = 0;
  function toggle() {
    var box = row.querySelector(':scope > .redo-text');
    if (box) { box.remove(); label.textContent = CHIUSA; return; }
    box = document.createElement('div');
    box.className = 'redo-text';
    try { box.innerHTML = DOMPurify.sanitize(marked.parse(text || '')); }
    catch (e) { box.textContent = text || ''; }
    row.appendChild(box);
    label.textContent = APERTA;
  }
  label.addEventListener('click', toggle);
  label.addEventListener('keydown', function(e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
  row.appendChild(label);
  return row;
}

// Mette le righe `list` subito prima di `bubbleEl` (togliendo quelle che già
// c'erano lì). live=true: righe del turno in corso — quelle vecchie in diretta
// rimaste altrove (il fumetto si è spostato) vengono tolte.
window.ensureRedoRows = function(bubbleEl, list, live) {
  if (!bubbleEl || !bubbleEl.parentNode) return;
  var prev = bubbleEl.previousElementSibling;
  while (prev && prev.classList && prev.classList.contains('redo-row')) {
    var p2 = prev.previousElementSibling; prev.remove(); prev = p2;
  }
  if (live && messagesEl) {
    var stale = messagesEl.querySelectorAll('.redo-row.redo-live');
    for (var i = 0; i < stale.length; i++) stale[i].remove();
  }
  if (!Array.isArray(list)) return;
  for (var j = 0; j < list.length; j++) {
    if (list[j] && String(list[j]).trim()) bubbleEl.parentNode.insertBefore(buildRedoRow(list[j], live), bubbleEl);
  }
};

// In diretta: il testo arrivato finora è la versione scartata. Si chiude nella
// riga grigia e il fumetto riparte da vuoto per la versione rifatta.
window.markStreamRedo = function(text) {
  window._liveDiscards = (window._liveDiscards || []).concat([text]);
  window.streamingText = '';
  _lastMdRender = '';
  if (window.streamingEl && window.streamingEl._body) window.streamingEl._body.innerHTML = '';
  if (window.streamingEl && window.streamingEl.isConnected) {
    window.ensureRedoRows(window.streamingEl, window._liveDiscards, true);
  }
};

window.appendToolSummary = function(tools) {
  if (!tools || tools.length === 0) return;
  // Count unique tools and show friendly names
  const counts = {};
  for (let i = 0; i < tools.length; i++) {
    const name = window.friendlyToolName(tools[i]);
    counts[name] = (counts[name] || 0) + 1;
  }
  const summary = Object.keys(counts).map(function(name) {
    return counts[name] > 1 ? name + ' x' + counts[name] : name;
  }).join(', ');

  const div = document.createElement('div');
  div.className = 'tool-card';
  div.innerHTML =
    '<div class="tool-card-header">' +
      '<span class="arrow">&#9654;</span>' +
      '<span>' + tools.length + ' tool' + (tools.length > 1 ? 's' : '') + ': ' + escapeHtml(summary) + '</span>' +
    '</div>' +
    '<div class="tool-card-body"><pre><code>' + tools.map(function(t) { return escapeHtml(window.friendlyToolName(t)); }).join('\n') + '</code></pre></div>';
  div.querySelector('.tool-card-header').onclick = function() { div.classList.toggle('open'); };
  messagesEl.appendChild(div);
};

// --- Scroll Management ---
let newMessageCount = 0;

window.scrollToBottom = function(force) {
  if (!force && !autoScroll) return;
  newMessageCount = 0;
  updateFabCount();
  requestAnimationFrame(function() {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  });
};

function updateFabCount() {
  const countEl = scrollBottomBtn.querySelector('.fab-count');
  if (countEl) {
    countEl.textContent = newMessageCount > 0 ? newMessageCount + ' new' : '';
  }
}

// Stop auto-scroll when user scrolls up, re-enable when near bottom
const scrollBottomBtn = document.getElementById('scroll-bottom-btn');

// --- FAB anchoring (2026-08-16) ---
// Keep the scroll-to-bottom pill ALWAYS just above the composer island,
// whatever its current height (multi-line textarea, toolbar row, attachment
// bar, keyboard margin). We measure #input-area's top edge and publish
// --fab-bottom, which #scroll-bottom-btn's CSS consumes (main.css). When the
// composer is hidden (non-session views) the rect collapses to 0 — keep the
// CSS fallback in that case instead of parking the FAB off-screen.
(function anchorFabToComposer() {
  var inputAreaEl = document.getElementById('input-area');
  if (!inputAreaEl) return;
  function positionFab() {
    var r = inputAreaEl.getBoundingClientRect();
    if (!r.height) {
      document.documentElement.style.removeProperty('--fab-bottom');
      return;
    }
    var b = Math.round(window.innerHeight - r.top + 10);
    document.documentElement.style.setProperty('--fab-bottom', Math.max(b, 10) + 'px');
  }
  try {
    new ResizeObserver(function() { requestAnimationFrame(positionFab); }).observe(inputAreaEl);
  } catch (e) {}
  window.addEventListener('resize', positionFab);
  // Keyboard open/close shifts the composer via margin (--keyboard-height),
  // which a ResizeObserver on the element won't see — visualViewport does.
  if (window.visualViewport) window.visualViewport.addEventListener('resize', positionFab);
  positionFab();
})();
function checkScrollPosition() {
  const nearBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 60;
  autoScroll = nearBottom;
  if (nearBottom) {
    newMessageCount = 0;
    updateFabCount();
    scrollBottomBtn.classList.remove('visible');
  } else if (messagesEl.style.display !== 'none') {
    scrollBottomBtn.classList.add('visible');
  }
}

// On touch/wheel, only disable auto-scroll if user is NOT near the bottom
// This prevents accidental auto-scroll kill when tapping near the input area
messagesEl.addEventListener('touchstart', function() {
  var nearBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 80;
  if (!nearBottom) autoScroll = false;
}, { passive: true });
messagesEl.addEventListener('touchend', function() { setTimeout(checkScrollPosition, 100); }, { passive: true });
messagesEl.addEventListener('wheel', function() {
  var nearBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 80;
  if (!nearBottom) autoScroll = false;
}, { passive: true });
messagesEl.addEventListener('scroll', function() { checkScrollPosition(); }, { passive: true });

// Tap on message to show copy/listen buttons (mobile can't hover)
let _tappedMsg = null;
let _tappedTimer = null;
messagesEl.addEventListener('click', function(e) {
  var msg = e.target.closest('.message');
  if (!msg) return;
  // Don't interfere with button clicks
  if (e.target.closest('.copy-btn, .listen-btn, .code-copy-btn, .code-expand-btn, .tool-card-header, .option-btn, a')) return;
  // Clear previous
  if (_tappedMsg && _tappedMsg !== msg) _tappedMsg.classList.remove('tapped');
  if (_tappedTimer) clearTimeout(_tappedTimer);
  msg.classList.add('tapped');
  _tappedMsg = msg;
  _tappedTimer = setTimeout(function() { msg.classList.remove('tapped'); _tappedMsg = null; }, 3000);
});

scrollBottomBtn.onclick = function() {
  autoScroll = true;
  newMessageCount = 0;
  updateFabCount();
  messagesEl.scrollTop = messagesEl.scrollHeight;
  scrollBottomBtn.classList.remove('visible');
};

// --- Inline Activity Log (in chat area) ---
let inlineActivityEl = null;
let activityLogEntries = [];
// ─── Bridge onto window GIRO PRESTAZIONI ─────────────────
// ws.js reads `window.activityLogEntries` at three places (ws.js:960, :1109,
// :1153, all in the tool_start/tool_done path). A top-level `let` in a classic
// script creates a SCRIPT-scoped binding, not a property of window — so those
// three reads have always been `undefined`, and every one of them threw
// "Cannot read properties of undefined (reading 'length')". That is the error
// the owner sees in the console on every page load: it fires the first time a
// tool_done is drained from the queue, which on a session with history is
// during boot. The consequence beyond the noise is that finished tools were
// never marked done in the activity log.
//
// Defined as an accessor rather than a second array on purpose: this variable
// is REASSIGNED (chat.js:1012 and sessions.js:433 both do `activityLogEntries
// = []`). A plain `window.activityLogEntries = activityLogEntries` would have
// pinned window to the first array and quietly desynced on the next clear —
// the same class of bug, just harder to see.
Object.defineProperty(window, 'activityLogEntries', {
  get: function () { return activityLogEntries; },
  set: function (v) { activityLogEntries = v; },
  configurable: true,
});
let activityStartTime = null;
let activityElapsedTimer = null;

// Friendly tool name map
const TOOL_LABELS = {
  'Read': 'Reading file',
  'Edit': 'Editing code',
  'Write': 'Writing file',
  'Bash': 'Running command',
  'Grep': 'Searching code',
  'Glob': 'Finding files',
  'Agent': 'Running subagent',
  'TodoWrite': 'Updating tasks',
  'WebFetch': 'Fetching URL',
  'WebSearch': 'Searching web',
  'Skill': 'Loading skill',
  'EnterPlanMode': 'Planning',
  'ExitPlanMode': 'Plan complete',
  'NotebookEdit': 'Editing notebook',
  'AskUserQuestion': 'Asking question',
};

// Extract a short detail string from tool input (file path, command, etc.)
window.extractToolDetail = function(toolName, input) {
  if (!input || typeof input !== 'object') return '';
  // Read, Edit, Write → file_path (show just filename)
  if (input.file_path) {
    const parts = input.file_path.replace(/\\/g, '/').split('/');
    return parts[parts.length - 1] || input.file_path;
  }
  // Bash → command (truncated)
  if (input.command) {
    const cmd = input.command.trim().split('\n')[0]; // first line only
    return cmd.length > 50 ? cmd.slice(0, 47) + '...' : cmd;
  }
  // Grep/Glob → pattern
  if (input.pattern) return '"' + input.pattern + '"';
  // Skill → skill name
  if (input.skill) return input.skill;
  // Agent → description
  if (input.description) return input.description;
  // WebFetch/WebSearch → url or query
  if (input.url) return input.url;
  if (input.query) return input.query;
  return '';
};

window.friendlyToolName = function(raw) {
  // Check exact match
  if (TOOL_LABELS[raw]) return TOOL_LABELS[raw];
  // Check MCP tools (mcp__server__tool)
  if (raw.startsWith('mcp__')) {
    const parts = raw.split('__');
    const server = parts[1] || '';
    const tool = parts.slice(2).join('_') || '';
    // Clean up common server names
    const serverLabels = {
      'github': 'GitHub',
      'workspace': 'Google Workspace',
      'jcodemunch': 'Analyzing code',
      'context7': 'Fetching docs',
      'neon': 'Database',
      'happy': 'Happy',
    };
    const label = serverLabels[server];
    if (label) {
      if (tool) {
        // Make tool name readable
        const cleanTool = tool.replace(/_/g, ' ').replace(/^(get|list|search|create|update|delete|read|find|manage)\s/i, '');
        return label + ': ' + cleanTool;
      }
      return label;
    }
    return tool.replace(/_/g, ' ') || raw;
  }
  return raw;
};

function formatElapsed(ms) {
  let s = Math.floor(ms / 1000);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  s = s % 60;
  return m + ':' + (s < 10 ? '0' : '') + s;
}

window.ensureActivityLog = function() {
  if (!inlineActivityEl) {
    inlineActivityEl = document.createElement('div');
    inlineActivityEl.id = 'inline-activity';
    inlineActivityEl.classList.add('active');
    // Embed inside the streaming message bubble (or create one if needed)
    if (window.streamingEl) {
      window.streamingEl.appendChild(inlineActivityEl);
    } else {
      // No streaming element yet — create a minimal one so activity has a home
      window.streamingEl = document.createElement('div');
      window.streamingEl.className = 'message assistant streaming thinking-state';
      const meta = document.createElement('div');
      meta.className = 'msg-meta';
      meta.innerHTML = '<span class="msg-role">Claude</span><span>' + formatTime() + '</span>';
      window.streamingEl.appendChild(meta);
      window.streamingEl._body = document.createElement('div');
      window.streamingEl._body.className = 'streaming-text';
      window.streamingEl.appendChild(window.streamingEl._body);
      window.streamingEl.appendChild(inlineActivityEl);
      messagesEl.appendChild(window.streamingEl);
    }
    activityStartTime = Date.now();
    // Start elapsed timer
    if (activityElapsedTimer) clearInterval(activityElapsedTimer);
    activityElapsedTimer = setInterval(updateElapsed, 1000);
  }
  return inlineActivityEl;
};

function updateElapsed() {
  if (!inlineActivityEl || !activityStartTime) return;
  const el = inlineActivityEl.querySelector('.activity-elapsed');
  if (el) el.textContent = formatElapsed(Date.now() - activityStartTime);
}

// --- Thinking State Display ---
window.showThinkingState = function() {
  window.addActivity('thinking', 'Processing...');
  // Create a visible thinking bubble in the chat if no streaming element exists yet
  if (!window.streamingEl) {
    window.streamingEl = document.createElement('div');
    window.streamingEl.className = 'message assistant streaming thinking-state';
    const meta = document.createElement('div');
    meta.className = 'msg-meta';
    meta.innerHTML = '<span class="msg-role">Claude</span><span>' + formatTime() + '</span>';
    window.streamingEl.appendChild(meta);
    window.streamingEl._body = document.createElement('div');
    window.streamingEl._body.className = 'streaming-text';
    window.streamingEl.appendChild(window.streamingEl._body);
    // Add thinking dots
    const dots = document.createElement('div');
    dots.className = 'thinking-dots';
    dots.innerHTML = '<span></span><span></span><span></span>';
    window.streamingEl._body.appendChild(dots);
    messagesEl.appendChild(window.streamingEl);
    window.scrollToBottom();
  }
};

window.updateThinkingDisplay = function(text) {
  // Ensure streaming element exists
  if (!window.streamingEl) window.showThinkingState();
  const body = window.streamingEl._body;
  if (!body) return;
  // Remove dots if present
  const dots = body.querySelector('.thinking-dots');
  if (dots) dots.remove();
  // Get or create thinking text element
  let thinkEl = body.querySelector('.thinking-text');
  if (!thinkEl) {
    thinkEl = document.createElement('div');
    thinkEl.className = 'thinking-text';
    body.appendChild(thinkEl);
  }
  // Show only the last ~500 chars for readability (scroll to end)
  const displayText = text.length > 500 ? '...' + text.slice(-500) : text;
  thinkEl.textContent = displayText;
  thinkEl.scrollTop = thinkEl.scrollHeight;
  window.scrollToBottom();
};

function collapseThinking() {
  if (!window.streamingEl || !window.streamingEl._body) return;
  const thinkEl = window.streamingEl._body.querySelector('.thinking-text');
  if (thinkEl) thinkEl.remove();
  // Add collapsed toggle
  const saved = window.thinkingText;
  const toggle = document.createElement('div');
  toggle.className = 'thinking-collapsed';
  toggle.textContent = '\u25B6 Show thinking';
  toggle.addEventListener('click', function() {
    const expanded = toggle.nextElementSibling;
    if (expanded && expanded.classList.contains('thinking-expanded')) {
      expanded.remove();
      toggle.textContent = '\u25B6 Show thinking';
    } else {
      const exp = document.createElement('div');
      exp.className = 'thinking-expanded';
      exp.textContent = saved;
      toggle.after(exp);
      toggle.textContent = '\u25BC Hide thinking';
    }
  });
  window.streamingEl._body.prepend(toggle);
}

window.addActivity = function(type, text, detail) {
  const log = window.ensureActivityLog();
  const friendlyText = (type === 'tool') ? window.friendlyToolName(text) : text;
  const entry = { type: type, text: friendlyText, raw: text, detail: detail || '' };
  activityLogEntries.push(entry);

  renderActivityLog(log);
  window.scrollToBottom();
};

function renderActivityLog(log) {
  const icons = { thinking: '&#9679;', tool: IC.gear, done: '&#10003;' };
  const entries = activityLogEntries;
  let html = '';

  // Show collapsed count if more than 7 entries
  let showFrom = 0;
  if (entries.length > 7) {
    showFrom = entries.length - 6;
    html += '<div class="activity-collapsed">' + showFrom + ' previous steps</div>';
  }

  // Show recent completed entries
  for (let i = showFrom; i < entries.length - 1; i++) {
    const e = entries[i];
    const icon = e.done ? '&#10003;' : (icons[e.type] || '&#9679;');
    const itemClass = e.done ? 'done' : e.type;
    html += '<div class="activity-log-item ' + itemClass + '">' +
      '<span class="al-icon">' + icon + '</span>' +
      '<span class="al-text">' + escapeHtml(e.text) +
      (e.detail ? ' <span class="al-detail">' + escapeHtml(e.detail) + '</span>' : '') +
      '</span></div>';
  }

  // Current item with spinner + elapsed time
  const last = entries[entries.length - 1];
  if (last) {
    const elapsed = activityStartTime ? formatElapsed(Date.now() - activityStartTime) : '';
    html += '<div class="activity-current">' +
      '<div class="activity-spinner"></div>' +
      '<span>' + escapeHtml(last.text) +
      (last.detail ? ' <span class="al-detail">' + escapeHtml(last.detail) + '</span>' : '') +
      '</span>' +
      '<span class="activity-elapsed">' + elapsed + '</span>' +
    '</div>';
  }

  log.innerHTML = html;
}

window.hideActivity = function() {
  if (activityElapsedTimer) { clearInterval(activityElapsedTimer); activityElapsedTimer = null; }
  if (inlineActivityEl) {
    // Compact summary stays embedded in the message
    const totalMs = activityStartTime ? (Date.now() - activityStartTime) : 0;
    const totalTime = activityStartTime ? formatElapsed(totalMs) : '';
    const toolCount = activityLogEntries.filter(function(e) { return e.type === 'tool'; }).length;
    let summary = '';
    if (toolCount > 0) {
      summary = toolCount + ' tool' + (toolCount > 1 ? 's' : '') + ' used';
      if (totalTime) summary += ' · ' + totalTime;
    }
    // P7: emit exactly ONE summary check, and only for real work — at least
    // one tool AND >= 1s elapsed. Otherwise drop the element (no ghost check,
    // no "0s"). The live tool timeline above is untouched.
    if (summary && toolCount > 0 && totalMs >= 1000) {
      inlineActivityEl.innerHTML = '<div class="activity-log-item done">' +
        '<span class="al-icon">&#10003;</span>' +
        '<span class="al-text">' + summary + '</span>' +
      '</div>';
    } else {
      inlineActivityEl.remove();
    }
    inlineActivityEl = null;
    activityLogEntries = [];
    activityStartTime = null;
  }
};

// Tool Activity Cards — show what Claude is doing
window.renderToolCard = function(msg) {
  var card = document.createElement('div');
  card.className = 'tool-activity-card';
  if (msg.tool === 'Edit' || msg.tool === 'Write' || msg.tool === 'Bash') {
    card.classList.add('tool-activity-card--sensitive');
  }
  card.id = 'tool-' + (msg.toolUseId || Date.now());

  var icon = IC.wrench;
  if (msg.tool === 'Read') icon = IC.bookOpen;
  else if (msg.tool === 'Edit') icon = IC.edit2;
  else if (msg.tool === 'Write') icon = IC.fileText;
  else if (msg.tool === 'Bash') icon = IC.terminal;
  else if (msg.tool === 'Glob' || msg.tool === 'Grep') icon = IC.search;

  var detail = '';
  if (msg.input) {
    if (msg.input.file_path) detail = msg.input.file_path.replace(/^C:\\Users\\[^\\]+\\/, '~/');
    else if (msg.input.command) detail = msg.input.command.substring(0, 80) + (msg.input.command.length > 80 ? '...' : '');
    else if (msg.input.pattern) detail = msg.input.pattern;
    else if (msg.input.path) detail = msg.input.path.replace(/^C:\\Users\\[^\\]+\\/, '~/');
  }

  var detailEl = detail ? '<div class="tool-activity-card-detail">' + escapeForToolCard(detail) + '</div>' : '';
  card.innerHTML = '<span class="tool-activity-card-icon">' + icon + '</span>' +
    '<span class="tool-activity-card-name">' + escapeForToolCard(msg.tool || 'Tool') + '</span>' +
    detailEl +
    '<span class="tool-activity-card-status">running</span>';

  return card;
};

window.resolveToolCard = function(toolUseId) {
  var card = document.querySelector('#tool-' + toolUseId) ||
             document.querySelector('.tool-activity-card:last-child');
  if (card) {
    var status = card.querySelector('.tool-activity-card-status');
    if (status) {
      status.textContent = 'done';
      status.classList.add('tool-activity-card-done');
    }
    card.classList.add('tool-activity-done');
  }
};

function escapeForToolCard(str) {
  var div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// --- Permission Prompt Cards ---
// Rendered in-line in the chat stream when Claude CLI requests tool approval.
// Server contract: ws msg `permission_request` {id, sessionId, tool, input, description}
// Client replies on same WS: `permission_response` {id, decision: allow|allow_always|deny}
// Server acks: `permission_ack` {id, ok}

// Track live cards by id across sessions so we can resolve acks and dedupe
window._permissionCards = window._permissionCards || {};
// Per-session pending cards (so we can re-attach when user switches in)
window._permissionBySession = window._permissionBySession || {};

function describePermissionInput(tool, input) {
  if (!input || typeof input !== 'object') return '';
  var t = (tool || '').toLowerCase();
  // Bash: prominently show command
  if (t === 'bash' && input.command) {
    return { type: 'command', value: String(input.command) };
  }
  // File tools: show path
  var pathKey = input.file_path || input.path || input.notebook_path;
  if (pathKey && (t === 'read' || t === 'write' || t === 'edit' || t === 'notebookedit' || t === 'glob' || t === 'grep')) {
    var extra = '';
    if (t === 'edit' && typeof input.old_string === 'string') {
      extra = '\n\n--- old ---\n' + input.old_string + '\n\n--- new ---\n' + (input.new_string || '');
    } else if (t === 'write' && typeof input.content === 'string') {
      extra = '\n\n' + input.content;
    } else if (t === 'grep' && input.pattern) {
      extra = '\npattern: ' + input.pattern;
    }
    return { type: 'path', value: String(pathKey) + extra };
  }
  // Fallback: pretty JSON
  try {
    return { type: 'json', value: JSON.stringify(input, null, 2) };
  } catch(e) {
    return { type: 'json', value: String(input) };
  }
}

window.renderPermissionCard = function renderPermissionCard(req) {
  if (!req || !req.id) return null;
  // Dedup
  if (window._permissionCards[req.id]) return window._permissionCards[req.id];

  var targetSession = req.sessionId || window.activeSessionId;
  var isActive = targetSession === window.activeSessionId;

  var card = document.createElement('div');
  card.className = 'message permission-card';
  card.dataset.permissionId = req.id;
  card.dataset.sessionId = targetSession || '';

  var meta = document.createElement('div');
  meta.className = 'msg-meta';
  meta.innerHTML = '<span class="msg-role perm-role">Permission</span><span>' + formatTime() + '</span>';
  card.appendChild(meta);

  var title = document.createElement('div');
  title.className = 'perm-title';
  title.textContent = req.tool || 'Tool';
  card.appendChild(title);

  if (req.description) {
    var desc = document.createElement('div');
    desc.className = 'perm-desc';
    desc.textContent = req.description;
    card.appendChild(desc);
  }

  var parsed = describePermissionInput(req.tool, req.input);
  var bodyWrap = document.createElement('div');
  bodyWrap.className = 'perm-body';
  if (parsed && parsed.type === 'command') {
    var cmdLabel = document.createElement('div');
    cmdLabel.className = 'perm-body-label';
    cmdLabel.textContent = 'command';
    bodyWrap.appendChild(cmdLabel);
  } else if (parsed && parsed.type === 'path') {
    var pLabel = document.createElement('div');
    pLabel.className = 'perm-body-label';
    pLabel.textContent = 'path';
    bodyWrap.appendChild(pLabel);
  }
  var pre = document.createElement('pre');
  pre.className = 'perm-body-pre';
  var raw = parsed ? parsed.value : '';
  var LIMIT = 600;
  var truncated = raw.length > LIMIT;
  pre.textContent = truncated ? raw.slice(0, LIMIT) + '\u2026' : raw;
  bodyWrap.appendChild(pre);
  if (truncated) {
    var expandBtn = document.createElement('button');
    expandBtn.type = 'button';
    expandBtn.className = 'perm-expand';
    expandBtn.textContent = 'Show full';
    expandBtn.onclick = function() {
      if (pre._expanded) {
        pre.textContent = raw.slice(0, LIMIT) + '\u2026';
        expandBtn.textContent = 'Show full';
        pre._expanded = false;
      } else {
        pre.textContent = raw;
        expandBtn.textContent = 'Show less';
        pre._expanded = true;
      }
    };
    bodyWrap.appendChild(expandBtn);
  }
  card.appendChild(bodyWrap);

  var actions = document.createElement('div');
  actions.className = 'perm-actions';

  function makeBtn(label, decision, cls) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'perm-btn ' + cls;
    b.textContent = label;
    b.onclick = function() { window.respondToPermission(req.id, decision); };
    return b;
  }
  var allowBtn  = makeBtn('Allow', 'allow', 'perm-allow');
  var alwaysBtn = makeBtn('Allow always', 'allow_always', 'perm-always');
  var denyBtn   = makeBtn('Deny', 'deny', 'perm-deny');
  actions.appendChild(allowBtn);
  actions.appendChild(alwaysBtn);
  actions.appendChild(denyBtn);
  card.appendChild(actions);

  var statusLine = document.createElement('div');
  statusLine.className = 'perm-status';
  card.appendChild(statusLine);

  card._setWaiting = function(decision) {
    card.classList.add('perm-waiting');
    card.dataset.chosen = decision;
    allowBtn.disabled = alwaysBtn.disabled = denyBtn.disabled = true;
    statusLine.textContent = 'Waiting\u2026';
  };
  card._setResolved = function(decision) {
    card.classList.remove('perm-waiting');
    card.classList.add('perm-resolved');
    var isDeny = decision === 'deny';
    card.classList.add(isDeny ? 'perm-denied' : 'perm-allowed');
    allowBtn.disabled = alwaysBtn.disabled = denyBtn.disabled = true;
    var label = decision === 'allow' ? 'Allowed'
              : decision === 'allow_always' ? 'Allowed (always, this session)'
              : 'Denied';
    statusLine.innerHTML = (isDeny ? '\u2715 ' : '\u2713 ') + label;
  };
  card._setExpired = function() {
    card.classList.remove('perm-waiting');
    card.classList.add('perm-expired');
    allowBtn.disabled = alwaysBtn.disabled = denyBtn.disabled = true;
    statusLine.textContent = 'Expired (handled elsewhere)';
  };

  window._permissionCards[req.id] = card;
  if (targetSession) {
    if (!window._permissionBySession[targetSession]) window._permissionBySession[targetSession] = [];
    window._permissionBySession[targetSession].push(req.id);
  }

  // Only attach to DOM if user is looking at the originating session.
  // Otherwise keep it in memory; if session is switched to, re-attach via switchSession hook is unnecessary —
  // server will resend state / card lives on until ack anyway. Simpler: only render to DOM when active.
  if (isActive && window.messagesEl) {
    window.messagesEl.appendChild(card);
    window.scrollToBottom();
  }
  return card;
};

window.respondToPermission = function respondToPermission(id, decision) {
  var card = window._permissionCards[id];
  if (!card) return;
  if (card.classList.contains('perm-resolved') || card.classList.contains('perm-expired')) return;
  if (card._setWaiting) card._setWaiting(decision);
  try {
    if (window.ws && window.ws.readyState === 1) {
      window.ws.send(JSON.stringify({ type: 'permission_response', id: id, decision: decision }));
    } else {
      // WS not open — mark as expired-ish
      if (card._setExpired) card._setExpired();
    }
  } catch(e) {
    if (card._setExpired) card._setExpired();
  }
};

window.resolvePermissionAck = function resolvePermissionAck(id, ok) {
  var card = window._permissionCards[id];
  if (!card) return;
  var chosen = card.dataset.chosen || 'allow';
  if (ok) {
    if (card._setResolved) card._setResolved(chosen);
  } else {
    if (card._setExpired) card._setExpired();
  }
};

// Deploy card — appended after full-restart reconnect to show what was deployed.
window.renderDeployCard = function(marker) {
  if (!window.messagesEl || !marker) return;
  var card = document.createElement('div');
  card.className = 'message deploy-card';
  var when = new Date(marker.ts).toLocaleTimeString();
  var files = (marker.files_changed || []).slice(0, 6).join(', ');
  var sha = (marker.commit_sha || '').slice(0, 7);
  card.innerHTML =
    '<div class="deploy-card-header">\u2726 Deployed \u2014 ' + escapeForToolCard(when) + '</div>' +
    '<div class="deploy-card-body">' +
      '<div class="deploy-card-mode">Mode: ' + escapeForToolCard(marker.mode || 'full') + '</div>' +
      (marker.commit_msg ? '<div class="deploy-card-msg">' + escapeForToolCard(marker.commit_msg) + '</div>' : '') +
      (files ? '<div class="deploy-card-files">Files: ' + escapeForToolCard(files) + '</div>' : '') +
      (sha ? '<div class="deploy-card-sha">SHA: ' + escapeForToolCard(sha) + '</div>' : '') +
    '</div>';
  window.messagesEl.appendChild(card);
};
