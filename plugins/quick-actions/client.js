(function() {
  var PLUGIN_ID = 'quick-actions';
  var actions = [];

  // --- Icon map (Lucide SVG strings, keyed by action id) ---
  // Only the actions listed in config.json. Paste, Extend and the
  // slash-command «chat» action were never configured: removed 2026-10-12.
  // [2026-10-16] Wrap is back in the middle, in place of Idea (the owner: «un
  // semplice /wrap button, come avevamo un tempo») — same glyph as before
  // f864ec6 (16/08), when it was removed.
  var ICONS = {
    'wrap':        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="5" rx="2"/><path d="M4 9v9a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9"/><path d="m9.5 17 5-5"/><path d="m9.5 12 5 5"/></svg>',
    // File (2026-08-16 round #4): the SAME paperclip glyph that lived in the
    // input row (#attach-btn, index.html) — moved here verbatim so the toolbar
    // button reads identical to what the owner already knows.
    'attach-file': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>',
    'copy-chat':   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>'
  };


  function showToast(text, type) {
    if (window.The151Machine && window.The151Machine.showToast) {
      window.The151Machine.showToast(text, type === 'error' ? 6000 : 3000);
    }
  }

  // --- Handler: File (2026-08-16 round #4) — the paperclip moved from the
  //     input row to the toolbar (more room for the composer). The REAL picker
  //     logic stays bound to the now-invisible #attach-btn (input.js: Capacitor
  //     FilePicker on the phone, web file-input fallback on PC/browser) — this
  //     just forwards the tap, so both platforms keep the exact same behavior.
  function handleAttachFile() {
    var btn = document.getElementById('attach-btn');
    if (btn) { btn.click(); }
    else { showToast('File picker not found', 'error'); }
  }

  // --- Handler: Copy Chat (formatted transcript to clipboard) ---
  function formatChatHistory(history) {
    if (!history || history.length === 0) return '';
    var DIVIDER = '────────────────────────────────────';
    var blocks = [];
    history.forEach(function(m) {
      var content = (m.content || '').toString().trim();
      if (!content) return;
      var role = m.role === 'user' ? 'USER' : 'CLAUDE';
      blocks.push(DIVIDER + '\n' + role + '\n' + DIVIDER + '\n\n' + content);
    });
    return blocks.join('\n\n\n');
  }

  function writeClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text);
    }
    // Legacy fallback (older WebViews)
    return new Promise(function(resolve, reject) {
      try {
        var ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        var ok = document.execCommand('copy');
        document.body.removeChild(ta);
        ok ? resolve() : reject(new Error('execCommand copy failed'));
      } catch (e) {
        reject(e);
      }
    });
  }

  function handleCopyChat() {
    var sessionId = window.The151Machine.getActiveSession();
    if (!sessionId) {
      showToast('No active session', 'error');
      return;
    }
    var s = window.sessions && window.sessions.find(function(x){ return x.id === sessionId; });
    var history = (s && s.history) || [];
    if (history.length === 0) {
      showToast('Chat is empty', 'error');
      return;
    }
    var text = formatChatHistory(history);
    writeClipboard(text).then(function() {
      var turns = history.filter(function(m){ return (m.content || '').toString().trim(); }).length;
      showToast('Copied ' + turns + ' messages', 'success');
    }).catch(function(e) {
      showToast('Copy failed: ' + e.message, 'error');
    });
  }

  // --- Handler: Wrap (2026-10-16, back from before f864ec6) — writes /wrap in
  //     the open chat and sends it. Anything already typed stays above it.
  function handleWrap() {
    var sessionId = window.The151Machine && window.The151Machine.getActiveSession
      ? window.The151Machine.getActiveSession() : null;
    if (!sessionId) {
      showToast('No active session', 'error');
      return;
    }
    var input = document.getElementById('message-input');
    if (!input) return;
    var existing = input.value.trim();
    input.value = existing ? existing + '\n/wrap' : '/wrap';
    input.dispatchEvent(new Event('input'));
    if (typeof window.sendMessage === 'function') window.sendMessage();
  }

  function registerActions(actionList) {
    actionList.forEach(function(action) {
      var opts = {
        label: action.label,
        iconSvg: ICONS[action.id] || '',
        primary: !!action.primary,
        onClick: function() {
          if (action.type === 'special') {
            if (action.id === 'attach-file') {
              handleAttachFile();
            } else if (action.id === 'copy-chat') {
              handleCopyChat();
            } else if (action.id === 'wrap') {
              handleWrap();
            }
          }
        }
      };
      window.The151Machine.registerToolbarAction(PLUGIN_ID + '-' + action.id, opts);
    });
  }

  function init() {
    var cfgUrl = '/api/plugins/' + PLUGIN_ID + '/config';
    // The shared kit authFetch (ONE place for the token). ui-kit.js is a
    // <script> in index.html, so it is always loaded before any plugin.
    window.UI.authFetch(cfgUrl, {})
    .then(function(r) { return r.json(); })
    .then(function(config) {
      actions = config.actions || [];
      registerActions(actions);
    })
    .catch(function(err) {
      console.error('[quick-actions] Failed to load config:', err);
    });
  }

  if (window.The151Machine && window.The151Machine.register) {
    window.The151Machine.register(PLUGIN_ID, {});
  }

  init();
})();
