/**
 * @151/ui — shared design-system kit (P2.2)
 * A base that sections ADOPT then personalize. Exposes window.UI.
 *
 * Load order: MUST come right after js/core.js (which defines window.escapeHtml,
 * window.showToast, window.getServerUrl). Everything here degrades gracefully if
 * core somehow hasn't loaded yet (defensive guards, matching the codebase's
 * existing `typeof window.getServerUrl === 'function'` pattern).
 */
(function () {
  'use strict';

  var TOKEN_KEY = '151-terminal-token'; // ONE place for the auth token key.

  // ── escapeHtml: re-export core's canonical helper (do NOT reimplement) ──
  function escapeHtml(str) {
    if (typeof window.escapeHtml === 'function') return window.escapeHtml(str);
    // Fallback (core not loaded yet) — never a no-op.
    return (str == null ? '' : String(str))
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // ── toast: delegate to core's showToast (do NOT duplicate the DOM) ──
  function toast(text, type, ms) {
    if (typeof window.showToast === 'function') return window.showToast(text, type, ms);
    // Fallback so a load-order edge can't throw.
    try { console.log('[toast]', text); } catch (e) {}
  }

  // ── authFetch: ONE place for the Bearer token; caller headers win ──
  function authFetch(pathOrUrl, opts) {
    opts = opts || {};
    var url = pathOrUrl;
    // Relative path → prefix the resolved server URL.
    if (typeof url === 'string' && !/^https?:\/\//i.test(url)) {
      var base = (typeof window.getServerUrl === 'function') ? window.getServerUrl() : '';
      url = base + url;
    }
    var token = '';
    try { token = localStorage.getItem(TOKEN_KEY) || ''; } catch (e) {}
    // Default Authorization, then let caller headers override (except we seed
    // Authorization from the token if the caller didn't provide one).
    var headers = Object.assign(
      { 'Authorization': 'Bearer ' + token },
      (opts.headers || {})
    );
    var merged = Object.assign({}, opts, { headers: headers });
    return fetch(url, merged);
  }

  // ── Z: read z-index tokens for JS that must set z-index inline ──
  function readZ(name, fallback) {
    try {
      var v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
      var n = parseInt(v, 10);
      return isNaN(n) ? fallback : n;
    } catch (e) { return fallback; }
  }
  var Z = {
    get overlay() { return readZ('--z-overlay', 50); },
    get modal() { return readZ('--z-modal', 100); },
    get toast() { return readZ('--z-toast', 200); }
  };

  // ── showModal: kit-styled overlay, Esc + backdrop close ──
  // opts: { title, bodyHtml | bodyEl, buttons:[{label, variant, onClick}] }
  // Returns { close(result) }.
  function showModal(opts) {
    opts = opts || {};

    var backdrop = document.createElement('div');
    backdrop.className = 'ui-modal-backdrop';

    var modal = document.createElement('div');
    modal.className = 'ui-modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');

    if (opts.title) {
      var titleEl = document.createElement('div');
      titleEl.className = 'ui-modal-title';
      titleEl.textContent = opts.title;
      modal.appendChild(titleEl);
    }

    var body = document.createElement('div');
    body.className = 'ui-modal-body';
    if (opts.bodyEl) {
      body.appendChild(opts.bodyEl);
    } else if (opts.bodyHtml != null) {
      body.innerHTML = opts.bodyHtml; // caller is responsible for escaping.
    }
    modal.appendChild(body);

    var closed = false;
    function close(result) {
      if (closed) return;
      closed = true;
      document.removeEventListener('keydown', onKey, true);
      if (backdrop.parentNode) backdrop.parentNode.removeChild(backdrop);
      if (typeof opts.onClose === 'function') {
        try { opts.onClose(result); } catch (e) {}
      }
    }

    var buttons = opts.buttons || [];
    if (buttons.length) {
      var btnRow = document.createElement('div');
      btnRow.className = 'ui-modal-buttons';
      buttons.forEach(function (b) {
        var btn = document.createElement('button');
        btn.className = 'ui-btn' + (b.variant ? ' ui-btn-' + b.variant : '');
        btn.textContent = b.label;
        btn.onclick = function () {
          var keepOpen = false;
          if (typeof b.onClick === 'function') {
            keepOpen = b.onClick() === true; // return true to keep modal open.
          }
          if (!keepOpen) close();
        };
        btnRow.appendChild(btn);
      });
      modal.appendChild(btnRow);
    }

    function onKey(e) {
      if (e.key === 'Escape') { e.stopPropagation(); close(); }
    }
    document.addEventListener('keydown', onKey, true);

    backdrop.addEventListener('mousedown', function (e) {
      if (e.target === backdrop && opts.dismissable !== false) close();
    });

    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);

    return { close: close, el: modal };
  }

  // ── confirm: Promise<boolean> built on showModal (replaces native confirm) ──
  function confirm(message, o) {
    o = o || {};
    return new Promise(function (resolve) {
      var settled = false;
      function done(v) { if (!settled) { settled = true; resolve(v); } }
      var m = showModal({
        title: o.title || null,
        bodyHtml: '<div class="ui-confirm-text">' + escapeHtml(message) + '</div>',
        onClose: function () { done(false); }, // Esc/backdrop → false
        buttons: [
          { label: o.cancelText || 'Cancel', variant: 'ghost', onClick: function () { done(false); } },
          { label: o.okText || 'OK', variant: (o.okVariant || 'primary'), onClick: function () { done(true); } }
        ]
      });
      // If onClose fires after a button already settled, the settled guard holds.
      void m;
    });
  }

  window.UI = {
    showModal: showModal,
    confirm: confirm,
    toast: toast,
    escapeHtml: escapeHtml,
    authFetch: authFetch,
    Z: Z
  };
})();
