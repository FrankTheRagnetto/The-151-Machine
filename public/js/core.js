/* The 151 Machine — Core: globals, state, API, utilities */

// --- marked config ---
try { marked.use({ breaks: true, gfm: true }); } catch(e) { console.error('[CORE] marked not loaded:', e.message); }

// --- Global monochrome SVG icons (Feather/Lucide style) ---
window.IC = (function() {
  var A = ' viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';
  function s(d) { return '<svg' + A + '>' + d + '</svg>'; }
  return {
    // Team / session icons
    eye:           s('<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>'),
    settings:      s('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>'),
    graduationCap: s('<path d="M22 10L12 5 2 10l10 5 10-5z"/><path d="M6 12v5c0 1.66 2.69 3 6 3s6-1.34 6-3v-5"/><line x1="22" y1="10" x2="22" y2="16"/>'),
    globe:         s('<circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>'),
    gamepad:       s('<line x1="6" y1="11" x2="10" y2="11"/><line x1="8" y1="9" x2="8" y2="13"/><line x1="15" y1="12" x2="15.01" y2="12"/><line x1="18" y1="10" x2="18.01" y2="10"/><path d="M17.32 5H6.68a4 4 0 0 0-3.978 3.59c-.006.052-.01.101-.017.152C2.604 9.416 2 14.456 2 16a3 3 0 0 0 3 3c1 0 1.5-.5 2-1l1.414-1.414A2 2 0 0 1 9.828 16h4.344a2 2 0 0 1 1.414.586L17 18c.5.5 1 1 2 1a3 3 0 0 0 3-3c0-1.544-.604-6.584-.685-7.258-.007-.05-.011-.1-.017-.152A4 4 0 0 0 17.32 5z"/>'),
    music:         s('<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>'),
    broom:         s('<path d="M12 2v10"/><path d="M8 12c0 4-2 10-2 10h12s-2-6-2-10"/>'),
    power:         s('<path d="M18.36 6.64a9 9 0 1 1-12.73 0"/><line x1="12" y1="2" x2="12" y2="12"/>'),
    // Brain — RADICALLY STYLIZED (UI round, 2026-08-20, punto 9).
    // Replaces the 2026-08-16 potrace vectorization of
    // a reference image: that path was a faithful
    // TRACE (hundreds of nodes, fill=currentColor, stroke=none), so at the
    // 13-18px sizes this icon is actually used it collapsed into an ink blob.
    // This is the opposite approach — a stroked glyph in the same Feather line
    // language as every other icon here: the lateral silhouette reduced to two
    // mirrored lobe arcs over a stem, plus three gyri strokes that read as
    // folds at any size. Inherits A's stroke-width/linecap, so it thins and
    // thickens with the rest of the set instead of fighting it.
    //
    // OPTICAL SIZE FIX (2026-08-20 round 2, punto 2). Every icon here shares the
    // same 24x24 viewBox, so they all render into an identical BOX — but the box
    // is not what the eye reads, the ARTWORK inside it is. Measured getBBox():
    //     sun   22.0 x 22.0
    //     scale 20.0 x 18.0
    //     brain 15.8 x 16.5   <-- ~15% smaller in every direction
    // That is why the brain looked shrunken next to the other two Super-Agent
    // icons. The paths are correct; only their scale within the box was off, so
    // the fix is a <g> transform rather than redrawn (and re-approximated) arcs:
    // scale 1.16 about the artwork's own centre (12, 11.25), nudged +0.4 down so
    // the result is centred in the box. New bbox ~18.3 x 19.1, i.e. it now sits
    // between scale and sun instead of below both.
    // stroke-width is pre-divided (2 / 1.16 = 1.724) so the transform does NOT
    // fatten the line — the rendered stroke stays exactly 2 like the whole set.
    brain:         s('<g transform="translate(12 11.65) scale(1.16) translate(-12 -11.25)" stroke-width="1.724"><path d="M12 4.5a3 3 0 0 0-5.6 1.1A3 3 0 0 0 4.5 10a3.2 3.2 0 0 0 .8 2.2A3 3 0 0 0 6 17.2a3 3 0 0 0 3.9 1.7"/><path d="M12 4.5a3 3 0 0 1 5.6 1.1A3 3 0 0 1 19.5 10a3.2 3.2 0 0 1-.8 2.2A3 3 0 0 1 18 17.2a3 3 0 0 1-3.9 1.7"/><path d="M12 4.5v15"/><path d="M9.4 8.6q1.4.6 2.6.4"/><path d="M14.6 8.6q-1.4.6-2.6.4"/><path d="M9.1 13.4q1.6-.7 2.9-.2"/></g>'),
    sun:           s('<circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>'),
    shield:        s('<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>'),
    cpu:           s('<rect x="4" y="4" width="16" height="16" rx="2" ry="2"/><rect x="9" y="9" width="6" height="6"/><line x1="9" y1="1" x2="9" y2="4"/><line x1="15" y1="1" x2="15" y2="4"/><line x1="9" y1="20" x2="9" y2="23"/><line x1="15" y1="20" x2="15" y2="23"/><line x1="20" y1="9" x2="23" y2="9"/><line x1="20" y1="14" x2="23" y2="14"/><line x1="1" y1="9" x2="4" y2="9"/><line x1="1" y1="14" x2="4" y2="14"/>'),
    messageCircle: s('<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>'),
    // Tool icons (chat.js)
    wrench:        s('<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>'),
    bookOpen:      s('<path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>'),
    edit2:         s('<path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/>'),
    fileText:      s('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/>'),
    terminal:      s('<polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>'),
    search:        s('<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>'),
    // UI icons
    paperclip:     s('<path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.49"/>'),
    package:       s('<line x1="16.5" y1="9.4" x2="7.5" y2="4.21"/><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/>'),
    gear:          s('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>'),
    scale:         s('<line x1="12" y1="3" x2="12" y2="21"/><line x1="5" y1="6" x2="19" y2="6"/><path d="M5 6l-3 6a3 3 0 0 0 6 0z"/><path d="M19 6l-3 6a3 3 0 0 0 6 0z"/><line x1="7" y1="21" x2="17" y2="21"/>'),
    // Raccoon identity — the bandit/domino MASK (the raccoon's signature eye
    // band), NOT a paw, NOT a trash can, NOT a magnifying glass. A rounded band
    // across the eyes with two eye holes reads clearly at 1em and is unmistakably
    // "the masked one" without colliding with delete/search glyphs.
    music:         s('<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>'),
    globe:         s('<circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15 15 0 0 1 0 20 15 15 0 0 1 0-20z"/>'),
  };
})();

// --- Android Status Bar Inset (edge-to-edge fix) ---
// Android WebView in Capacitor 8 renders behind the status bar but env(safe-area-inset-top)
// returns 0. We measure the real inset at runtime via three strategies (in order):
//   1. Capacitor StatusBar plugin  →  getInfo().height  (most accurate)
//   2. screen.height - innerHeight  →  divide by pixelRatio (rough but works portrait)
//   3. Hard fallback: 52px
(function fixAndroidInsets() {
  var isAndroid = /Android/i.test(navigator.userAgent);
  if (!isAndroid) return;

  function applyInset(px) {
    var inset = Math.round(px) || 52;           // never 0
    console.log('[INSET] Android top inset:', inset + 'px');
    document.documentElement.style.setProperty('--android-inset-top', inset + 'px');
  }

  function measureFallback() {
    // screen.height includes status bar; innerHeight excludes it (roughly).
    // We take the difference and scale by devicePixelRatio to get CSS pixels.
    var dpr = window.devicePixelRatio || 1;
    var diff = (window.screen.height - window.innerHeight);
    // diff is already in CSS pixels on most Android WebViews, but can be in physical
    // pixels on some OEMs — if the result is implausibly large, scale it down.
    var inset = diff > 200 ? Math.round(diff / dpr) : diff;
    return (inset > 0 && inset < 120) ? inset : 52;
  }

  // Strategy 1: Capacitor StatusBar plugin
  var cap = window.Capacitor;
  if (cap && cap.Plugins && cap.Plugins.StatusBar && typeof cap.Plugins.StatusBar.getInfo === 'function') {
    cap.Plugins.StatusBar.getInfo().then(function(info) {
      var h = info && info.height;
      if (h && h > 0) {
        applyInset(h);
      } else {
        applyInset(measureFallback());
      }
    }).catch(function() {
      applyInset(measureFallback());
    });
  } else {
    // Plugin not available — use fallback immediately so first paint is correct.
    applyInset(measureFallback());
  }

  // Re-measure on orientation change (portrait/landscape swaps innerHeight).
  function onResize() {
    if (cap && cap.Plugins && cap.Plugins.StatusBar && typeof cap.Plugins.StatusBar.getInfo === 'function') {
      cap.Plugins.StatusBar.getInfo().then(function(info) {
        var h = info && info.height;
        applyInset((h && h > 0) ? h : measureFallback());
      }).catch(function() { applyInset(measureFallback()); });
    } else {
      applyInset(measureFallback());
    }
  }
  window.addEventListener('resize', onResize);
  window.addEventListener('orientationchange', onResize);
})();

// --- External Link Handler (open in native browser, NOT WebView/Custom Tab) ---
function _isExternalUrl(url) {
  if (!url || !/^https?:\/\//i.test(url)) return false;
  if (url.indexOf(window.location.origin) === 0) return false;
  var serverUrl = localStorage.getItem('151-server-url');
  if (serverUrl && url.indexOf(serverUrl) === 0) return false;
  return true;
}

// Pending link waiting for user confirmation
var _pendingLinkUrl = null;

// Show confirmation dialog before opening external link
function confirmOpenExternal(url) {
  _pendingLinkUrl = url;
  var dialog = document.getElementById('link-dialog');
  var preview = document.getElementById('link-url-preview');
  if (!dialog || !preview) {
    // Fallback: no dialog available, open directly
    _doOpenExternal(url);
    return;
  }
  // Show truncated URL for safety
  try {
    var parsed = new URL(url);
    preview.textContent = parsed.hostname + parsed.pathname;
  } catch(e) {
    preview.textContent = url.slice(0, 80);
  }
  dialog.classList.add('show');
}

// Dialog button handlers (attached once after DOM ready)
document.addEventListener('DOMContentLoaded', function() {
  var openBtn = document.getElementById('link-open');
  var cancelBtn = document.getElementById('link-cancel');
  var dialog = document.getElementById('link-dialog');
  if (openBtn) openBtn.addEventListener('click', function() {
    if (dialog) dialog.classList.remove('show');
    if (_pendingLinkUrl) _doOpenExternal(_pendingLinkUrl);
    _pendingLinkUrl = null;
  });
  if (cancelBtn) cancelBtn.addEventListener('click', function() {
    if (dialog) dialog.classList.remove('show');
    _pendingLinkUrl = null;
  });
  // Close on backdrop click
  if (dialog) dialog.addEventListener('click', function(e) {
    if (e.target === dialog) {
      dialog.classList.remove('show');
      _pendingLinkUrl = null;
    }
  });
});

// Actually open the URL in the native browser
var _nativeOpen = window.open.bind(window);
function _doOpenExternal(url) {
  if (window.Capacitor && window.Capacitor.Plugins) {
    // AppLauncher sends an Android ACTION_VIEW Intent → opens in default browser (Brave, Chrome, etc.)
    // NEVER use Browser plugin — it opens a Chrome Custom Tab (in-app), not the native browser
    var al = window.Capacitor.Plugins.AppLauncher;
    if (al && al.openUrl) {
      al.openUrl({ url: url }).catch(function(err) {
        console.warn('[LINK] AppLauncher failed:', err, '— trying Intent URL');
        // Fallback: Android Intent URL scheme — guaranteed to open native browser
        try {
          var intentUrl = 'intent://' + url.replace(/^https?:\/\//, '') +
            '#Intent;scheme=' + (url.startsWith('https') ? 'https' : 'http') +
            ';action=android.intent.action.VIEW;end';
          window.location.href = intentUrl;
        } catch(e2) {
          console.warn('[LINK] Intent URL failed:', e2, '— using window.open');
          _nativeOpen(url, '_blank', 'noopener');
        }
      });
    } else {
      // No AppLauncher plugin — try Intent URL directly
      try {
        var intentUrl = 'intent://' + url.replace(/^https?:\/\//, '') +
          '#Intent;scheme=' + (url.startsWith('https') ? 'https' : 'http') +
          ';action=android.intent.action.VIEW;end';
        window.location.href = intentUrl;
      } catch(e) {
        _nativeOpen(url, '_blank', 'noopener');
      }
    }
  } else {
    // Desktop/web: open in new tab
    _nativeOpen(url, '_blank', 'noopener');
  }
}

// 1. Intercept <a> clicks at capture phase → show confirmation
document.addEventListener('click', function(e) {
  var link = e.target.closest('a[href]');
  if (!link) return;
  var href = link.getAttribute('href');
  if (!href || href.startsWith('#') || href.startsWith('javascript:')) return;
  if (!_isExternalUrl(href)) return;
  e.preventDefault();
  e.stopPropagation();
  confirmOpenExternal(href);
  return false;
}, true);

// 2. Override window.open so programmatic calls also get confirmation
window.open = function(url, target, features) {
  if (_isExternalUrl(url)) {
    confirmOpenExternal(url);
    return null;
  }
  return _nativeOpen(url, target, features);
};

window.openExternal = _doOpenExternal;
window.confirmOpenExternal = confirmOpenExternal;

// --- Utilities ---
function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
window.escapeHtml = escapeHtml;

// --- Globals ---
window.authToken = localStorage.getItem('151-terminal-token');

// --- Collegamento al server: UN SOLO INDIRIZZO, e si dice ---
//
// [2026-09-22] QUI C'ERA UN RIPIEGO CHE NON ESISTEVA.
// Fino a oggi getConnectionCandidates() leggeva due chiavi di localStorage,
// '151-tailscale-url' e '151-lan-url', per costruire una LISTA di indirizzi da
// provare a turno. Cercate in tutto il progetto (public/, server/, plugins/,
// app/): quelle due chiavi NESSUNO le scrive, mai. Le uniche due occorrenze
// erano le due letture qui sopra. La lista aveva quindi SEMPRE un elemento
// solo, e il commento di ws.js che prometteva che «un indirizzo stantio non ci
// intrappola mai» raccontava una protezione inesistente.
//
// PERCHE' SI TOGLIE INVECE DI FARLE SCRIVERE — tre motivi, in ordine di peso:
//  1. LA TOPOLOGIA NON HA UNA SECONDA STRADA. Il telefono carica tutta
//     l'interfaccia da UN indirizzo solo via Tailscale: fino al 10/10 il Pi
//     (col PC dietro, tramite relay), dall'app 1.19 (11/10, strada C) il PC
//     stesso (server.url = my-pc:3170). Non esistono due vie parallele
//     verso la stessa scatola: esiste una porta sola. Un «indirizzo LAN» del
//     PC non e' un secondo ingresso, e' un indirizzo che dal telefono non risponde.
//  2. CHI ACCOPPIAVA NON C'E' PIU'. Quelle chiavi sono un residuo
//     dell'accoppiamento via QR, rimosso: l'unico posto che scrive un
//     indirizzo oggi e' il campo «server URL» della configurazione (auth.js),
//     e scrive SOLO '151-server-url'.
//  3. NESSUNO LEGGEVA L'ETICHETTA. window.connectionType ('tailscale'/'lan'/
//     'stored') veniva scritto e mai letto da nessun file: la distinzione era
//     decorativa anche dove sembrava usata.
// Un codice che finge una protezione e' peggio di uno che ammette di non
// averla: chi legge smette di cercare il guasto vero. Il ripiego non c'era, e
// adesso non e' nemmeno scritto.
//
// Cio' che resta e migliora: l'indirizzo si rilegge da localStorage A OGNI
// giro (prima window.serverUrl si fissava al caricamento della pagina, e un
// indirizzo cambiato nella configurazione restava ignorato fino al ricarico).
window.isNativeApp = window.Capacitor && window.Capacitor.isNativePlatform();
window.serverUrl = localStorage.getItem('151-server-url') || window.location.origin;

// L'unico indirizzo conosciuto. Fonte sola: la configurazione salvata; in sua
// assenza l'origine da cui la pagina e' stata servita (che sul PC e' la
// Machine stessa, e dal 11/10 lo e' anche sul telefono: server.url = il PC).
function getServerAddress() {
  return localStorage.getItem('151-server-url') || window.location.origin;
}

// [2026-09-15] IL CRONOMETRO ERA TARATO PER LA LAN, NON PER LA RETE DATI.
// Questo timeout valeva 1500ms. Misurato il 15/09: il telefono NON sta sul
// Wi-Fi di casa, sta su rete mobile (endpoint 37.161.63.197 = l'operatore), e
// su quella strada una prova paga IN SERIE la radio che si sveglia da Doze
// (secondi, non millisecondi), la risoluzione del nome MagicDNS del Pi, poi
// TCP fino alla scatola. Un collegamento soltanto LENTO sforava quindi 1,5s su
// OGNI candidato, findBestServer concludeva «nessuno raggiungibile» e l'app
// restava attaccata a un indirizzo che non aveva mai davvero smentito. È il
// «riprende da sola solo dopo un po'» del proprietario: il collegamento c'era, era il
// nostro cronometro a essere corto.
//
// 4s danno ~2,5x di margine sul risveglio della radio e restano SOTTO il tetto
// brioso di 5s della riconnessione in ws.js, così un giro intero di prove
// fallite entra dentro un solo ciclo di riconnessione invece di accavallarsi
// col successivo. Prova: tests/riconnessione-mobile.test.js.
var PROBE_TIMEOUT_MS = 4000;
window.PROBE_TIMEOUT_MS = PROBE_TIMEOUT_MS;

// Probe a URL — resolve if reachable, reject if not (PROBE_TIMEOUT_MS)
//
// [2026-09-22] DUE CURE PICCOLE SULLA STESSA RIGA.
// (a) `cache: 'no-store'`: era l'UNICA fetch della casa senza. Una risposta 200
//     ripescata dalla cache del WebView fa sembrare VIVO un indirizzo morto —
//     cioe' esattamente il verdetto che questa funzione esiste per dare, dato
//     alla rovescia. Su un telefono che si risveglia e' l'errore peggiore
//     possibile: la prova dice «c'e'» e poi il WebSocket non si apre.
// (b) AbortController: prima, allo scadere del cronometro la Promise veniva
//     rigettata ma la fetch restava APERTA a consumare radio finche' il
//     sistema non la lasciava cadere. Con un giro di riconnessione ogni pochi
//     secondi si accumulavano richieste zombie sulla stessa antenna. Adesso
//     scadere vuol dire davvero chiudere.
function probeServer(url) {
  return new Promise(function(resolve, reject) {
    var ac = (typeof AbortController === 'function') ? new AbortController() : null;
    var timeout = setTimeout(function() {
      if (ac) { try { ac.abort(); } catch(e) {} }
      reject('timeout');
    }, PROBE_TIMEOUT_MS);
    var opts = { cache: 'no-store' };
    if (ac) opts.signal = ac.signal;
    fetch(url + '/api/health', opts).then(function(res) {
      clearTimeout(timeout);
      if (res.ok) resolve(url);
      else reject('not ok');
    }).catch(function() {
      clearTimeout(timeout);
      reject('unreachable');
    });
  });
}

// Prova l'unico indirizzo conosciuto e RIFERISCE se ha risposto.
//
// [2026-09-22] Non corre piu' fra candidati, perche' un candidato solo c'e'
// sempre stato (vedi il blocco lungo sopra getServerAddress). Il nome resta
// findBestServer: e' chiamato da tre posti e il suo CONTRATTO non cambia di un
// millimetro — non rigetta mai, torna true se qualcuno ha risposto e false se
// nessuno l'ha fatto, e nel fallimento TIENE l'ultimo indirizzo noto.
//
// [2026-09-15] ORA RIFERISCE L'ESITO: risolve `true` se un candidato ha
// davvero risposto, `false` se nessuno ce l'ha fatta. Prima il ramo di
// fallimento scriveva «No candidates reachable, keeping:» e finiva lì: chi
// chiamava non aveva NESSUN modo di distinguere «ho trovato la scatola» da
// «non ho trovato niente e sto tenendo un indirizzo che potrebbe essere
// morto». Il risultato è che chi riconnette (ws.js) ripeteva lo stesso giro
// alla stessa cadenza briosa all'infinito — utile quando il proprietario guarda lo
// schermo, una batteria morta a metà giornata quando il telefono è in tasca e
// la rete non c'è. Il booleano è ciò che permette a ws.js di allungare
// l'attesa SOLO quando sta bussando al buio.
//
// NON rigetta MAI, di proposito: tre chiamanti (init.js:266, ws.js:_reconnectNow,
// ws.js:1853) si appoggiano a questa proprietà per proseguire comunque. Il
// fallimento si riporta con un valore, non con un'eccezione.
async function findBestServer() {
  var address = getServerAddress();
  if (!address) return false;
  // Si riallinea alla configurazione PRIMA di provare: se il proprietario ha cambiato
  // l'indirizzo nelle impostazioni, e' questo il momento in cui ne teniamo
  // conto. Se poi la prova fallisce l'indirizzo resta comunque (e' l'unico che
  // abbiamo: buttarlo vorrebbe dire non saper piu' dove bussare).
  if (address !== window.serverUrl) {
    console.log('[CONN] Indirizzo aggiornato dalla configurazione:', address);
    window.serverUrl = address;
  }
  try {
    await probeServer(address);
    return true;
  } catch(e) {
    // Il plurale di questo messaggio e' STORIA, non distrazione: e' il ramo che
    // tests/riconnessione-mobile.test.js sorveglia per nome dal 15/09, perche'
    // scriveva in console e finiva li' senza riferire l'esito a chi riconnette.
    console.log('[CONN] No candidates reachable, keeping:', window.serverUrl);
    return false;
  }
}
window.findBestServer = findBestServer;
window.getServerAddress = getServerAddress;

function getServerUrl() { return window.serverUrl; }
function getWsUrl() {
  return window.serverUrl.replace(/^http/, 'ws');
}
window.getServerUrl = getServerUrl;
window.getWsUrl = getWsUrl;

// --- Global State ---
window.sessions = [];
window.activeSessionId = null;
window.ws = null;
window.commands = [];
window.pendingFiles = [];
window.reconnectDelay = 1000;
window.reconnectMaxDelay = 30000;
// [2026-09-22] NON DECIDE PIU' NIENTE. Era la bandiera che diceva a onclose di
// non riconnettere, ma e' una bandiera SOLA per tutta l'app: non sapeva dire
// QUALE socket si stesse chiudendo, e l'onopen del socket nuovo la rimetteva a
// false prima che l'onclose del vecchio la leggesse. Adesso il cartellino sta
// sul socket (`sock._intentional`, ws.js). Resta scritta perche' e' pubblica e
// qualcuno potrebbe leggerla, ma non e' piu' il perno di nessuna decisione.
window.intentionalClose = false;
window.streaming = false;
window.autoScroll = true;
window.messageQueue = []; // queued messages while busy — sent after current response
window.lastHistoryHash = ''; // track last rendered history to skip redundant re-renders

// --- Centralized State Management ---
// All streaming/button/view state changes go through these functions.
// This prevents the input box from disappearing due to scattered inline toggles.

function setStreamingState(isStreaming) {
  window.streaming = isStreaming;
  if (isStreaming) {
    stopBtn.style.display = 'flex';
    requestWakeLock();
  } else {
    // [17/10/2026] La sessione aperta aspetta lavori in sottofondo: il tasto
    // rosso resta, è il modo del proprietario per fermarli (sessions.js).
    var _aspetta = typeof window.activeHasBackground === 'function' && window.activeHasBackground();
    stopBtn.style.display = _aspetta ? 'flex' : 'none';
    releaseWakeLock();
    window.streamingText = ''; window.thinkingText = '';
    // Drain queued auto-wrap — handled by plugin
    if (typeof window.drainPendingWrap === 'function') {
      setTimeout(window.drainPendingWrap, 500);
    }
  }
}
window.setStreamingState = setStreamingState;

function setViewState(state) {
  console.log('[VIEW] setViewState:', state);
  var app = document.getElementById('app');
  if (state === 'empty') {
    app.classList.remove('view-session');
    app.classList.add('view-empty');
    emptyState.style.display = 'flex';
    headerTitle.innerHTML = '<span class="header-emblem">151</span>';
  } else {
    app.classList.remove('view-empty');
    app.classList.add('view-session');
    emptyState.style.display = 'none';
  }
}
window.setViewState = setViewState;

function renderHistoryMessages(messages, append) {
  if (!append) messagesEl.innerHTML = '';
  for (let i = 0; i < messages.length; i++) {
    var entry = messages[i];
    // Skip empty assistant entries defensively — blank bubbles are a known
    // artifact of interrupted streams / crashed runs polluting history, and
    // they render as "empty response boxes" on session switch.
    var _content = entry.content == null ? '' : String(entry.content);
    if (entry.role === 'assistant' && !_content.trim() && !(entry.tools && entry.tools.length > 0)) {
      continue;
    }
    // Mirror the empty-assistant skip for user messages that become empty after
    // stripping interruption markers — otherwise we'd render a blank user bubble
    // for synthetic interjection-only entries.
    if (entry.role === 'user' && typeof window.stripInterruptionMarkers === 'function') {
      var _userStripped = window.stripInterruptionMarkers(_content);
      if (!_userStripped) continue;
    }
    // [2026-10-09] Le risposte salvate PRIMA della regola «per il proprietario» hanno già
    // dentro i passaggi un messaggio per lui (collaudo 9:47: il
    // prompt delle 9:16 ancora nei Passaggi). Si sistema qui, a schermo, senza
    // riscrivere la cronologia salvata.
    if (entry.role === 'assistant' && Array.isArray(entry.steps) && entry.steps.length && window.PerNico) {
      var _pn = window.PerNico.ripiega(entry.content, entry.steps);
      // Tracciante sul dispositivo (client-log.jsonl): prova dal telefono vero
      // che la regola gira, una riga per messaggio sistemato.
      if (_pn.steps.length !== entry.steps.length && typeof window.syncBeacon === 'function') {
        try { window.syncBeacon('PER-UTENTE-RIPIEGA', { sid: window.activeSessionId || null, ts: entry.timestamp || null, fuori: entry.steps.length - _pn.steps.length, restano: _pn.steps.length }); } catch (e) {}
      }
      entry = Object.assign({}, entry, { content: _pn.content, steps: _pn.steps });
    }
    // [08/11/2026] : una voce che non si disegna salta da sola. Prima
    // l'errore usciva dal ciclo: spariva tutto quel che veniva dopo e, aperta
    // da una card, switchSession si fermava PRIMA del join (1° tocco a vuoto,
    // «not joined to session»). tests/bolla-pc.test.js (C)
    try {
      appendMessage(entry.role, entry.content, entry.timestamp || null, false, entry.attachments);
    } catch (_appendErr) {
      console.error('[HISTORY] voce non disegnata (' + entry.role + '):', _appendErr && _appendErr.message);
      if (typeof window.syncBeacon === 'function') {
        try { window.syncBeacon('HISTORY-ENTRY-FAILED', { sid: window.activeSessionId || null, role: String(entry.role), err: String(_appendErr && _appendErr.message).slice(0, 120) }); } catch (e) {}
      }
      continue;
    }
    if (entry.role === 'assistant' && entry.thinking) {
      var msgEl = messagesEl.lastElementChild;
      if (msgEl) {
        var bodyEl = msgEl.querySelector('div:not(.msg-meta)');
        if (bodyEl) {
          // [2026-10-01] `var` dentro il ciclo: tutte le chiusure vedevano
          // l'ULTIMO toggle e l'ULTIMO pensiero — cliccare su un messaggio
          // vecchio apriva il ragionamento dell'ultimo. Ogni messaggio ha ora
          // i suoi, catturati da una funzione.
          (function(toggle, saved) {
          toggle.className = 'thinking-collapsed';
          toggle.textContent = '▶ Thinking';
          toggle.addEventListener('click', function() {
            var expanded = toggle.nextElementSibling;
            if (expanded && expanded.classList.contains('thinking-expanded')) {
              expanded.remove();
              toggle.textContent = '▶ Thinking';
            } else {
              var exp = document.createElement('div');
              exp.className = 'thinking-expanded';
              exp.textContent = saved;
              toggle.after(exp);
              toggle.textContent = '▼ Thinking';
            }
          });
          bodyEl.insertBefore(toggle, bodyEl.firstChild);
          })(document.createElement('div'), entry.thinking);
        }
      }
    }
    if (entry.role === 'assistant' && entry.steps && typeof window.attachStepsToggle === 'function') {
      window.attachStepsToggle(messagesEl.lastElementChild, entry.steps);
    }
    if (entry.role === 'assistant' && Array.isArray(entry.discarded) && entry.discarded.length
        && typeof window.ensureRedoRows === 'function') {
      window.ensureRedoRows(messagesEl.lastElementChild, entry.discarded, false);
    }
    if (entry.tools && entry.tools.length > 0) {
      window.appendToolSummary(entry.tools);
    }
  }
}
window.renderHistoryMessages = renderHistoryMessages;

// Idempotency guard (ROUND-3 dup fix): after an authoritative (re)paint, ensure no
// two FINALIZED bubbles share a content key. Keeps the FIRST (top-most / authoritative
// history) occurrence and drops later clones. The live `.streaming` node is never
// touched — it finalizes and dedups itself via the `done` path. Cheap, deterministic,
// and safe to call on every history affirmation (including the hash short-circuit),
// so a duplicate that slipped in from a concurrent paint source gets swept away.
function dedupeRenderedBubbles() {
  if (!window.messagesEl) return;
  var seen = Object.create(null);
  var swept = [];
  var nodes = window.messagesEl.querySelectorAll('.message[data-msg-key]:not(.streaming)');
  for (var i = 0; i < nodes.length; i++) {
    var k = nodes[i].getAttribute('data-msg-key');
    if (!k) continue;
    if (seen[k]) {
      swept.push(k.slice(0, 12));
      try { nodes[i].remove(); } catch (e) {}
    }
    else seen[k] = true;
  }
  // Dup repro instrumentation (b_b54bca93): a sweep here means a duplicate DID
  // reach the DOM and this backstop hid it — log it so the live repro can tell
  // which paint source raced. A dup the owner SEES has a different key (escaped this
  // sweep entirely); zero [DEDUP-SWEEP] lines around it = look at key drift.
  if (swept.length) console.warn('[DEDUP-SWEEP] removed ' + swept.length + ' duplicate bubble(s), keys: ' + swept.join(','));
  // [SYNC-PROBE 2026-08-15] Route the sweep to the beacon too — the phone has
  // no readable console, so this was invisible exactly where the dups happen.
  if (swept.length && typeof window.syncBeacon === 'function') {
    window.syncBeacon('DEDUP-SWEEP', { sid: window.activeSessionId || null, count: swept.length, keys: swept.join(',') });
  }
}
window.dedupeRenderedBubbles = dedupeRenderedBubbles;

// [SYNC-PROBE 2026-08-15] Diagnostic beacon for the phone↔PC continuity
// investigation (empty replies / dup bubbles / vanishing messages / unread dot).
// Best-effort POST to /api/client-log → lands in ~/.151machine/client-log.jsonl
// on the box that serves the API (since 2026-10-11 the PC, for the phone too;
// before that the Pi could answer during relay fallback windows).
// Mirrors ttsBeacon (input.js) incl. the JWT header (the /api gate 401s
// un-tokened POSTs). Never throws, never blocks the caller.
window.syncBeacon = function syncBeacon(tag, data) {
  try {
    console.log('[SYNC-PROBE] ' + tag, data || {});
    var base = (typeof window.getServerUrl === 'function') ? window.getServerUrl() : '';
    var body = JSON.stringify(Object.assign(
      { kind: 'sync-probe', tag: tag, t: Date.now(), ua: navigator.userAgent },
      data || {}
    ));
    var headers = { 'Content-Type': 'application/json' };
    if (window.authToken) headers['Authorization'] = 'Bearer ' + window.authToken;
    fetch(base + '/api/client-log', { method: 'POST', headers: headers, body: body, keepalive: true }).catch(function(){});
  } catch (e) {}
};

// --- Local History Cache (survives server restarts) ---
// Mirrors session history to localStorage so messages are never lost
function cacheHistory(sessionId, history) {
  if (!sessionId || !history) return;
  try {
    // Keep max 50 messages per session to stay within localStorage limits
    var trimmed = history.slice(-50);
    localStorage.setItem('151-history-' + sessionId, JSON.stringify(trimmed));
  } catch(e) { /* quota exceeded — ignore */ }
}
function getCachedHistory(sessionId) {
  try {
    return JSON.parse(localStorage.getItem('151-history-' + sessionId) || '[]');
  } catch(e) { return []; }
}
function clearCachedHistory(sessionId) {
  localStorage.removeItem('151-history-' + sessionId);
}
// Cache session list (id, title, team) so sidebar works offline
function cacheSessionList(sessionsList) {
  try {
    var slim = sessionsList.map(function(s) {
      // Keep the server-stamped Fleet identity (agentType/agentNumber) in the
      // offline cache — the phone reads from this cache when the server is
      // unreachable, and detectFleetByType() pins on agentType. Dropping it made
      // a stamped super agent fall into "Other" on the phone. manuallyRenamed is kept
      // so fleetDisplayName's title fallback still resolves from cache too.
      return {
        id: s.id, title: s.title, team: s.team, status: s.status,
        lastActivity: s.lastActivity,
        agentType: s.agentType || null,
        agentNumber: (typeof s.agentNumber === 'number') ? s.agentNumber : null,
        manuallyRenamed: !!s.manuallyRenamed,
        // : senza il modello, una lista disegnata dalla copia (PC lento
        // all'apertura) metteva un trattino sulle card fino a riaprire l'app.
        model: s.model || null
      };
    });
    localStorage.setItem('151-sessions-cache', JSON.stringify(slim));
  } catch(e) {}
  // ROUND CHAT bug 5 root pressure (2026-08-16): '151-history-<sid>' caches were
  // NEVER deleted for dead sessions, so localStorage filled up over weeks until
  // send-path writes started throwing QuotaExceededError (proven SEND-REJECT,
  // 15/8 11:42). Prune caches for sessions that no longer exist — this list is
  // the authoritative roster, so anything not in it is garbage.
  try {
    var _live = {};
    sessionsList.forEach(function(s) { if (s && s.id) _live[s.id] = 1; });
    var _doomed = [];
    for (var _ci = 0; _ci < localStorage.length; _ci++) {
      var _ck = localStorage.key(_ci);
      if (_ck && _ck.indexOf('151-history-') === 0 && !_live[_ck.slice(12)]) _doomed.push(_ck);
    }
    _doomed.forEach(function(k) { localStorage.removeItem(k); });
    if (_doomed.length) console.log('[cache] pruned', _doomed.length, 'stale history cache(s)');
  } catch (e) {}
}
function getCachedSessionList() {
  try {
    return JSON.parse(localStorage.getItem('151-sessions-cache') || '[]');
  } catch(e) { return []; }
}
// --- L'ARCHIVIO DELLE SESSIONI (2026-10-07, il proprietario: «a PC spento voglio
// vedere TUTTE le sessioni, solo senza scrivere») ---
// localStorage tiene solo le chat già aperte su questo dispositivo (50
// messaggi, e ha un tetto di ~5 MB che si era già riempito una volta:
// SEND-REJECT 15/8). L'archivio sta in IndexedDB, che ha spazio: a ogni
// elenco arrivato dal PC (/api/sessions porta la storia di OGNI sessione) si
// salvano gli ultimi ARCHIVIO_MAX messaggi di tutte. A PC o Pi spenti,
// loadSessions() le rimette nelle sessioni: si leggono tutte, si scrive no.
var ARCHIVIO_DB = '151-archivio', ARCHIVIO_STORE = 'storie', ARCHIVIO_MAX = 200;
function _archivioApri() {
  return new Promise(function(ok, ko) {
    if (typeof indexedDB === 'undefined') return ko(new Error('niente IndexedDB'));
    var r = indexedDB.open(ARCHIVIO_DB, 1);
    r.onupgradeneeded = function() { r.result.createObjectStore(ARCHIVIO_STORE); };
    r.onsuccess = function() { ok(r.result); };
    r.onerror = function() { ko(r.error); };
  });
}
function archiviaSessioni(lista) {
  if (!Array.isArray(lista) || !lista.length) return Promise.resolve(0);
  return _archivioApri().then(function(db) {
    return new Promise(function(ok) {
      var tx = db.transaction(ARCHIVIO_STORE, 'readwrite');
      var st = tx.objectStore(ARCHIVIO_STORE);
      var vivi = {}, n = 0;
      lista.forEach(function(s) {
        if (!s || !s.id) return;
        vivi[s.id] = 1;
        if (Array.isArray(s.history) && s.history.length) { st.put(s.history.slice(-ARCHIVIO_MAX), s.id); n++; }
      });
      // Le sessioni cancellate escono anche dall'archivio.
      var c = st.openCursor();
      c.onsuccess = function() { var k = c.result; if (!k) return; if (!vivi[k.key]) k.delete(); k.continue(); };
      tx.oncomplete = function() { db.close(); ok(n); };
      tx.onerror = function() { db.close(); ok(0); };
    });
  }).catch(function() { return 0; });
}
function archiviaStoria(id, history) {
  if (!id || !Array.isArray(history) || !history.length) return Promise.resolve();
  return _archivioApri().then(function(db) {
    var tx = db.transaction(ARCHIVIO_STORE, 'readwrite');
    tx.objectStore(ARCHIVIO_STORE).put(history.slice(-ARCHIVIO_MAX), id);
    tx.oncomplete = function() { db.close(); };
  }).catch(function() {});
}
function leggiArchivio() {
  return _archivioApri().then(function(db) {
    return new Promise(function(ok) {
      var out = {};
      var tx = db.transaction(ARCHIVIO_STORE, 'readonly');
      var c = tx.objectStore(ARCHIVIO_STORE).openCursor();
      c.onsuccess = function() { var k = c.result; if (!k) return; out[k.key] = k.value; k.continue(); };
      tx.oncomplete = function() { db.close(); ok(out); };
      tx.onerror = function() { db.close(); ok(out); };
    });
  }).catch(function() { return {}; });
}
// Gettone rifiutato dal server (401) = chi è qui non è più il proprietario: le copie
// delle chat sul telefono se ne vanno con il gettone (/hack 07/10).
function svuotaCopieLocali() {
  try {
    var via = [];
    for (var i = 0; i < localStorage.length; i++) {
      var k = localStorage.key(i);
      if (k && (k === '151-sessions-cache' || k.indexOf('151-history-') === 0)) via.push(k);
    }
    via.forEach(function(k) { localStorage.removeItem(k); });
  } catch (e) {}
  try { if (typeof indexedDB !== 'undefined') indexedDB.deleteDatabase(ARCHIVIO_DB); } catch (e) {}
}
window.svuotaCopieLocali = svuotaCopieLocali;
window.archiviaSessioni = archiviaSessioni;
window.archiviaStoria = archiviaStoria;
window.leggiArchivio = leggiArchivio;
window.cacheHistory = cacheHistory;
window.getCachedHistory = getCachedHistory;
window.clearCachedHistory = clearCachedHistory;
window.cacheSessionList = cacheSessionList;
window.getCachedSessionList = getCachedSessionList;

// --- Persistent Message Queue (survives app suspension/reload) ---
// Messages are saved to localStorage before sending and only cleared after server confirms receipt.
function generateNonce() {
  // Prefer crypto.randomUUID() when available (modern browsers + recent Android WebView);
  // fall back to timestamp+random for older WebViews that lack it.
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    try { return crypto.randomUUID(); } catch(e) {}
  }
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

// --- Cross-device message dedup ---
// Track nonces this device has already rendered (either sent locally or received via user_message echo)
// so we never double-render the same bubble. Kept as a Set; trimmed periodically to avoid unbounded growth.
window._renderedNonces = window._renderedNonces || new Set();
window._renderedNonceOrder = window._renderedNonceOrder || [];
window.markNonceRendered = function(nonce) {
  if (!nonce) return false;
  if (window._renderedNonces.has(nonce)) return false;
  window._renderedNonces.add(nonce);
  window._renderedNonceOrder.push(nonce);
  // Cap memory: keep last 500 nonces
  if (window._renderedNonceOrder.length > 500) {
    var drop = window._renderedNonceOrder.shift();
    window._renderedNonces.delete(drop);
  }
  return true;
};
window.hasNonceRendered = function(nonce) {
  return !!nonce && window._renderedNonces.has(nonce);
};
function getPendingMessages() {
  try {
    return JSON.parse(localStorage.getItem('claude-pending-messages') || '[]');
  } catch(e) { return []; }
}
function savePendingMessage(sessionId, content, attachments, nonce) {
  let pending = getPendingMessages();
  pending.push({ sessionId: sessionId, content: content, attachments: attachments || [], ts: Date.now(), nonce: nonce });
  localStorage.setItem('claude-pending-messages', JSON.stringify(pending));
}
function clearPendingMessages(sessionId) {
  const pending = getPendingMessages().filter(function(m) { return m.sessionId !== sessionId; });
  // ROUND CHAT bug 5 residuo (2026-08-16): at localStorage quota this setItem
  // THROWS — and it sits on the `done` path (ws.js) BEFORE finalize, so a full
  // storage turned every completed reply into an empty bubble. The outbox is a
  // crash-recovery nicety: on failure drop the key outright (also frees room).
  try {
    localStorage.setItem('claude-pending-messages', JSON.stringify(pending));
  } catch (e) {
    try { localStorage.removeItem('claude-pending-messages'); } catch (e2) {}
  }
}
function getPendingForSession(sessionId) {
  return getPendingMessages().filter(function(m) { return m.sessionId === sessionId; });
}
// [12/11/2026 ] L'outbox si svuota PER NONCE, mai «per indovinare» l'intera
// sessione: un 'ack' del messaggio A cancellava anche B mai arrivato, uno stato
// 'busy' cancellava tutto anche se il server stava facendo un ALTRO turno.
// Un messaggio esce dall'outbox solo quando il server dice di averlo (ack col suo
// nonce) o quando compare nella storia del server col suo nonce.
function _writePending(list) {
  try {
    localStorage.setItem('claude-pending-messages', JSON.stringify(list));
  } catch (e) {
    try { localStorage.removeItem('claude-pending-messages'); } catch (e2) {}
  }
}
function removePendingByNonce(nonce) {
  if (!nonce) return false;
  var all = getPendingMessages();
  var rest = all.filter(function(m) { return m.nonce !== nonce; });
  if (rest.length === all.length) return false;
  _writePending(rest);
  return true;
}
// La storia del server è la verità: un messaggio che c'è col suo nonce è arrivato.
function forgetPendingInHistory(history) {
  if (!Array.isArray(history) || !history.length) return 0;
  var seen = {};
  for (var i = 0; i < history.length; i++) {
    var h = history[i];
    if (h && h.role === 'user' && h.nonce) seen[h.nonce] = true;
  }
  var all = getPendingMessages();
  var rest = all.filter(function(m) { return !(m.nonce && seen[m.nonce]); });
  if (rest.length !== all.length) _writePending(rest);
  return all.length - rest.length;
}
// L'ack del server per UN messaggio. Un server che non manda ancora il nonce
// conferma il più vecchio della sessione (il server li prende in ordine).
function ackPending(msg, sessionId) {
  msg = msg || {};
  if (msg.nonce) removePendingByNonce(msg.nonce);
  else if (sessionId) {
    var all = getPendingMessages();
    for (var i = 0; i < all.length; i++) {
      if (all[i].sessionId === sessionId) { all.splice(i, 1); _writePending(all); break; }
    }
  }
  // Un rinvio scartato come doppione a server fermo: niente turno parte, quindi
  // la chat non deve restare appesa in «busy» (lo aveva acceso redeliverPending).
  if (msg.duplicate && msg.busy === false && window.streaming && !window.streamingText
      && !(sessionId && getPendingForSession(sessionId).length)) {
    if (window.streamingEl) {
      try { if (window.streamingEl.isConnected) window.streamingEl.remove(); } catch (e) {}
      window.streamingEl = null;
    }
    setStreamingState(false);
    if (typeof window.updateStatusDot === 'function') window.updateStatusDot('idle');
    if (typeof window.hideActivity === 'function') window.hideActivity();
  }
}
// Re-send pending messages after WS reconnects and sync is received.
// [12/11/2026 ] TUTTI, in ordine, ognuno col suo nonce, anche a server
// occupato: il server scarta i doppioni per nonce (NONCE-PERSIST, ricaricato al
// boot) e mette in coda/nel turno quelli arrivati a turno in corso. Prima: se
// window.streaming cancellava tutto, e dopo il primo cancellava gli altri.
function redeliverPending(sessionId) {
  if (!sessionId) return;
  const pending = getPendingForSession(sessionId);
  if (pending.length === 0) return;
  if (!window.ws || (typeof WebSocket !== 'undefined' && window.ws.readyState !== WebSocket.OPEN)) return;
  const now = Date.now();
  // Oltre 1 h: non si rimanda (sarebbe fuori contesto), ma si conta prima di toglierlo.
  const fresh = [];
  pending.forEach(function(m) {
    if (now - m.ts < 3600000) { fresh.push(m); return; }
    if (typeof window.syncBeacon === 'function') {
      window.syncBeacon('PENDING-STALE', { sid: sessionId, nonce: m.nonce || null, ageMs: now - m.ts });
    }
  });
  if (fresh.length !== pending.length) {
    _writePending(getPendingMessages().filter(function(m) { return !(m.sessionId === sessionId && now - m.ts >= 3600000); }));
  }
  if (fresh.length === 0) return;
  console.log('[REDELIVER] Re-sending', fresh.length, 'pending message(s) for session', sessionId.slice(0, 8));
  if (!window.streaming) {
    setStreamingState(true);
    window.streamingText = ''; window.thinkingText = '';
    window.autoScroll = true;
    updateStatusDot('busy');
    window.showThinkingState();
  }
  fresh.forEach(function(msg) {
    // [SYNC-PROBE 2026-08-15] A redelivery actually firing; ageMs = how stale.
    if (typeof window.syncBeacon === 'function') {
      window.syncBeacon('REDELIVER-PENDING', { sid: sessionId, nonce: msg.nonce || null, ageMs: now - msg.ts });
    }
    if (!msg.nonce) {
      // Voce senza nonce (client vecchio): gliene diamo uno e lo salviamo, così
      // l'ack la può togliere e un altro rinvio è un doppione.
      msg.nonce = generateNonce();
      var all = getPendingMessages();
      for (var i = 0; i < all.length; i++) {
        if (all[i].sessionId === msg.sessionId && all[i].ts === msg.ts && !all[i].nonce && all[i].content === msg.content) { all[i].nonce = msg.nonce; break; }
      }
      _writePending(all);
    }
    if (window.markNonceRendered) window.markNonceRendered(msg.nonce);
    window.ws.send(JSON.stringify({ type: 'message', content: msg.content, attachments: msg.attachments || [], nonce: msg.nonce }));
  });
}
window.generateNonce = generateNonce;
window.getPendingMessages = getPendingMessages;
window.savePendingMessage = savePendingMessage;
window.clearPendingMessages = clearPendingMessages;
window.getPendingForSession = getPendingForSession;
window.removePendingByNonce = removePendingByNonce;
window.forgetPendingInHistory = forgetPendingInHistory;
window.ackPending = ackPending;
window.redeliverPending = redeliverPending;

// --- Error handling & toast ---
function humanizeError(raw) {
  if (!raw) return 'Something went wrong. Try again.';
  if (/is busy/i.test(raw)) return 'Claude is still working on the previous message. Wait for it to finish.';
  if (/not found/i.test(raw)) return 'Session not found. Try creating a new one.';
  if (/rate limit/i.test(raw)) return 'Slow down — too many messages. Wait a moment.';
  if (/ECONNREFUSED|ENOTFOUND/i.test(raw)) return 'Could not reach Claude. Check your connection.';
  if (/spawn|ENOENT/i.test(raw)) return 'Claude CLI not found. It may need to be reinstalled.';
  if (/timeout|timed out/i.test(raw)) return 'Request timed out. Try again.';
  if (/overloaded/i.test(raw)) return 'Claude is overloaded right now. Try again in a minute.';
  if (/no conversation found|resume requires/i.test(raw)) return 'Session expired. Starting fresh...';
  if (raw.length > 100) return 'Something went wrong: ' + raw.slice(0, 80) + '...';
  return raw;
}
window.humanizeError = humanizeError;

let _toastTimer = null;
function showToast(text, type, duration) {
  const el = document.getElementById('general-toast');
  if (!el) return;
  el.textContent = text;
  el.className = 'show ' + (type || '');
  if (_toastTimer) clearTimeout(_toastTimer);
  _toastTimer = setTimeout(function() { el.className = ''; }, duration || 2500);
}
window.showToast = showToast;

// --- DOM References ---
const $ = (sel) => document.querySelector(sel);
window.$ = $;
const sidebar = $('#sidebar');
const sidebarOverlay = $('#sidebar-overlay');
const sessionList = $('#session-list');
const messagesEl = $('#messages');
const emptyState = $('#empty-state');
const inputArea = $('#input-area');
const messageInput = $('#message-input');
const sendBtn = $('#send-btn-new'); // V3: separate send button (always visible)
const micBtn = $('#mic-btn'); // V3: separate mic button (always visible)
const stopBtn = $('#stop-btn');
const attachBtn = $('#attach-btn');
const fileInput = $('#file-input');
const attachmentBar = $('#attachment-bar');
const commandPicker = $('#command-picker');
const headerTitle = $('#header-title');
const headerStatus = $('#header-status');
const connectionBanner = $('#connection-banner');
const renameDialog = $('#rename-dialog');
const renameInput = $('#rename-input');
window.sidebar = sidebar;
window.sidebarOverlay = sidebarOverlay;
window.sessionList = sessionList;
window.messagesEl = messagesEl;
window.emptyState = emptyState;
window.inputArea = inputArea;
window.messageInput = messageInput;
window.sendBtn = sendBtn;
window.micBtn = micBtn;
window.stopBtn = stopBtn;
window.attachBtn = attachBtn;
window.fileInput = fileInput;
window.attachmentBar = attachmentBar;
window.commandPicker = commandPicker;
window.headerTitle = headerTitle;
window.headerStatus = headerStatus;
window.connectionBanner = connectionBanner;
window.renameDialog = renameDialog;
window.renameInput = renameInput;

// --- Haptics & input focus ---
// [2026-10-12] Solo dopo un gesto: Chrome blocca (e scrive in console
// «Blocked call to navigator.vibrate…») ogni vibrazione prima che la pagina
// abbia ricevuto un tocco o un tasto. userActivation dove c'è, altrimenti un
// flag acceso dal primo pointerdown/keydown.
var _gestoVisto = false;
function _segnaGesto() {
  _gestoVisto = true;
  document.removeEventListener('pointerdown', _segnaGesto, true);
  document.removeEventListener('keydown', _segnaGesto, true);
}
document.addEventListener('pointerdown', _segnaGesto, true);
document.addEventListener('keydown', _segnaGesto, true);
function haptic(pattern) {
  if (!navigator.vibrate) return;
  var ua = navigator.userActivation;
  var attivata = ua ? ua.hasBeenActive : _gestoVisto;
  if (!attivata) return;
  try { navigator.vibrate(pattern); } catch(e) {}
}
window.haptic = haptic;

messageInput.addEventListener('focus', function() {
  inputArea.classList.add('focused');
});
messageInput.addEventListener('blur', function() {
  inputArea.classList.remove('focused');
});
var _draftSaveTimer = null;
messageInput.addEventListener('input', function() {
  sendBtn.classList.toggle('has-text', !!messageInput.value.trim());
  // Auto-save draft per session (debounced 500ms)
  if (_draftSaveTimer) clearTimeout(_draftSaveTimer);
  _draftSaveTimer = setTimeout(function() {
    saveDraft(window.activeSessionId, messageInput.value);
  }, 500);
});

// --- API Layer ---
//
// [2026-09-22] IL TETTO CHE MANCAVA, E LA PAGINA D'ERRORE SPACCIATA PER «NIENTE».
//
// (a) NESSUN TETTO DI TEMPO. Questa fetch non aveva ne' AbortController ne'
//     scadenza: un socket mezzo morto attraverso il relay (telefono → Pi → PC)
//     puo' restare appeso per minuti prima che il sistema lo lasci cadere. Non
//     e' solo un'attesa: loadSessions() tiene la sua Promise in
//     `_sessionsInFlight` e RESTITUISCE QUELLA a ogni chiamata successiva
//     finche' non si conclude. Una sola chiamata appesa congela quindi
//     l'aggiornamento dell'elenco per il resto della vita della pagina — anche
//     DOPO che il WebSocket e' tornato su. E' il profilo esatto di «e' tornata
//     la linea ma l'app sembra ancora morta».
//     Il tetto copre la CONNESSIONE E LE INTESTAZIONI, non lo scaricamento del
//     corpo: il cronometro si ferma appena arriva la risposta, cosi' un elenco
//     sessioni pesante su rete lenta non viene mai troncato a meta'. Ed e'
//     largo apposta (120s): qui sotto passano anche gli endpoint che lanciano
//     script veri (aggiornamenti, pulizie) che rispondono dopo minuti di
//     lavoro. Non e' un timeout d'esperienza d'uso, e' una rete di sicurezza
//     contro una fetch che non si concluderebbe MAI.
//
// (b) res.ok NON GUARDATO. Una pagina HTML 502/504 sputata dal relay cadeva nel
//     catch di res.json() e tornava `null`: indistinguibile da «il server ha
//     risposto, non c'e' niente». Chi chiama ci costruiva sopra un elenco vuoto.
//     Adesso un esito non-ok il cui corpo NON e' JSON diventa un'eccezione che
//     dice lo stato.
//     ⚠ ATTENZIONE, E' DELIBERATO: un esito non-ok con corpo JSON continua a
//     tornare il corpo, come prima. Non e' pigrizia — sessions.js si appoggia
//     ESPLICITAMENTE a questo contratto per leggere il 409 «gia' in corso» di
//     /ecosystem-restart (c'e' scritto in un commento accanto alla chiamata).
//     Trasformare ogni non-ok in throw romperebbe quel ramo in silenzio. La
//     cura qui riguarda solo cio' che oggi si perdeva: il corpo ILLEGGIBILE.
var API_TIMEOUT_MS = 120000;
window.API_TIMEOUT_MS = API_TIMEOUT_MS;

async function api(method, path, body) {
  const opts = { method, headers: {} };
  if (window.authToken) opts.headers['Authorization'] = 'Bearer ' + window.authToken;
  if (body) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const ac = (typeof AbortController === 'function') ? new AbortController() : null;
  if (ac) opts.signal = ac.signal;
  const timer = setTimeout(function() {
    if (ac) { try { ac.abort(); } catch (e) {} }
  }, API_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(getServerUrl() + '/api' + path, opts);
  } finally {
    // Fermato QUI, non dopo la lettura del corpo: il corpo puo' pesare
    // centinaia di KB e su rete mobile ha diritto a tutto il tempo che gli serve.
    clearTimeout(timer);
  }
  if (res.status === 401) {
    localStorage.removeItem('151-terminal-token');
    if (window.svuotaCopieLocali) window.svuotaCopieLocali(); // 401: le chat copiate se ne vanno col gettone
    window.authToken = null;
    if (window.mostraAccesso) window.mostraAccesso(); // 12/11: gettone nuovo senza parola
    else document.getElementById('login-overlay').classList.remove('hidden');
    throw new Error('Authentication required');
  }
  if (res.status === 204) return null;
  let parsed;
  let leggibile = true;
  try { parsed = await res.json(); } catch (e) { leggibile = false; }
  // [2026-10-07] Il telefono risponde 503 {"offline":true} quando server.url
  // (dal 11/10 il PC) non c'è (OfflineBridge.java): non è un dato, è un'assenza. Si alza come
  // errore, così chi chiama ripiega (es. offline-plugins.json) invece di
  // costruire su un oggetto che non è la risposta attesa.
  if (res.status === 503 && parsed && (parsed.offline === true || parsed.pcOffline === true)) throw new Error('offline');
  if (!leggibile) {
    // Corpo che non e' JSON. Se l'esito era un errore, questa e' la pagina
    // d'errore del relay: si dice, non si spaccia per «nessun dato».
    if (!res.ok) throw new Error('HTTP ' + res.status + ' su ' + path);
    return null;
  }
  return parsed;
}
window.api = api;

// Resolve a pendingFiles entry (Capacitor FilePicker descriptor OR browser File)
// into a Blob suitable for multipart upload.
async function resolveAttachmentBlob(entry) {
  if (entry instanceof Blob) return entry;
  if (entry.blob instanceof Blob) return entry.blob;
  if (entry.data) {
    var bin = atob(entry.data);
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: entry.mimeType || 'application/octet-stream' });
  }
  if (entry.path) {
    var Cap = window.Capacitor;
    var url = Cap && Cap.convertFileSrc ? Cap.convertFileSrc(entry.path) : entry.path;
    console.log('[attach] resolveBlob path:', entry.path, '→', url);
    var res = await fetch(url);
    if (!res.ok) throw new Error('Could not read ' + (entry.name || 'file') + ' (status ' + res.status + ')');
    return await res.blob();
  }
  console.error('[attach] unreadable entry shape:', JSON.stringify(Object.keys(entry)));
  throw new Error('Unreadable file: ' + (entry.name || 'unknown') + ' — no blob, data, or path');
}

// Upload each pending attachment individually to the Server Guardian endpoint.
// Returns [{path, name, mime, size}, ...] in the order given.
async function uploadAttachments(sessionId, entries, opts) {
  var results = [];
  // M9 Fase C · Vettore 6: draft uploads (upload-on-add, not yet sent) carry
  // ?draft=1 so the server pins them against the boot orphan-sweep. Absent ⇒
  // identical to the pre-Vettore-6 behaviour.
  var draftQS = (opts && opts.draft) ? '&draft=1' : '';
  var MAX_ATTACHMENT_BYTES = 500 * 1024 * 1024; // 500 MB — matches server cap
  for (var i = 0; i < entries.length; i++) {
    var entry = entries[i];
    var blob;
    try {
      blob = await resolveAttachmentBlob(entry);
    } catch (blobErr) {
      console.error('[attach] resolveAttachmentBlob failed:', blobErr, entry);
      throw new Error('Cannot read file: ' + (entry.name || 'unknown') + ' — ' + blobErr.message);
    }
    var name = entry.name || ('file-' + Date.now());
    var mime = entry.mimeType || entry.type || blob.type || 'application/octet-stream';
    console.log('[attach] uploading', name, blob.size, mime);
    if (blob.size > MAX_ATTACHMENT_BYTES) {
      var sizeMb = (blob.size / (1024 * 1024)).toFixed(1);
      throw new Error(name + ' exceeds 500 MB limit (' + sizeMb + ' MB)');
    }
    var form = new FormData();
    form.append('file', blob, name);
    form.append('sessionId', sessionId);
    var url = getServerUrl() + '/api/attachments?sessionId=' + encodeURIComponent(sessionId) + draftQS;
    var res;
    // M9 · pezzo 4 — restart-resilient upload. A server restart mid-upload rejects
    // the fetch with a network-level error (connection reset), NOT our timeout-abort.
    // Without a retry the paperclip attachment was silently lost (uploadAttachments
    // just threw → the caller toasted and returned). Retry ONLY network failures,
    // with backoff long enough to span a normal restart (~15s). HTTP responses (any
    // status) stop the loop and are handled below; our own 120s timeout is NOT
    // retried (the file is genuinely too big/slow).
    var UPLOAD_BACKOFF_MS = [1000, 3000, 6000, 10000];
    var UPLOAD_MAX_ATTEMPTS = UPLOAD_BACKOFF_MS.length + 1;
    for (var attempt = 0; ; attempt++) {
      var didTimeout = false;
      var timeout = null;
      try {
        var controller = new AbortController();
        timeout = setTimeout(function() { didTimeout = true; controller.abort(); }, 120000);
        res = await fetch(url, {
          method: 'POST',
          body: form,
          signal: controller.signal,
          headers: window.authToken ? { 'Authorization': 'Bearer ' + window.authToken } : {}
        });
        clearTimeout(timeout);
        break; // got an HTTP response (any status) — stop retrying, handle below
      } catch (fetchErr) {
        if (timeout) clearTimeout(timeout);
        console.error('[attach] fetch failed (attempt ' + (attempt + 1) + '/' + UPLOAD_MAX_ATTEMPTS + '):', fetchErr);
        if (didTimeout || fetchErr.name === 'AbortError') {
          throw new Error('Upload timed out — file too large or connection too slow');
        }
        // Network-level failure (likely a server restart bouncing us mid-upload).
        // Retry with backoff until attempts are exhausted, then surface the error.
        if (attempt < UPLOAD_MAX_ATTEMPTS - 1) {
          var waitMs = UPLOAD_BACKOFF_MS[attempt];
          console.warn('[attach] retrying upload of ' + name + ' in ' + waitMs + 'ms (server may be restarting)');
          await new Promise(function(r) { setTimeout(r, waitMs); });
          continue;
        }
        throw new Error('Upload network error: ' + fetchErr.message);
      }
    }
    var bodyText = '';
    try { bodyText = await res.clone().text(); } catch(e) {}
    console.log('[attach] upload response', res.status, bodyText.slice(0, 200));
    if (res.status === 401) {
      localStorage.removeItem('151-terminal-token');
      if (window.svuotaCopieLocali) window.svuotaCopieLocali(); // 401: le chat copiate se ne vanno col gettone
      window.authToken = null;
      if (window.mostraAccesso) window.mostraAccesso(); // 12/11: gettone nuovo senza parola
      else document.getElementById('login-overlay').classList.remove('hidden');
      throw new Error('Authentication required');
    }
    if (!res.ok) {
      var msg = 'Upload failed (' + res.status + ')';
      try { var j = JSON.parse(bodyText); if (j && j.error) msg = j.error; } catch(e) {}
      throw new Error(msg);
    }
    var data = JSON.parse(bodyText);
    var att = data.attachment || data;
    results.push({
      path: att.path,
      name: att.name || name,
      mime: att.mime || mime,
      size: att.size != null ? att.size : blob.size
    });
  }
  return results;
}
window.uploadAttachments = uploadAttachments;

// [2026-10-12] Tolto il registro delle viste dei portali esterni (registerPortalView,
// closeOpenPortalView, destroyAllPortalViews): i portali sono usciti dalla Machine.

// Hardware back button. [2026-10-16] The last fullscreen view it closed (the
// Raspberry dashboard) is gone; what is left is the exit when history can go back.
(function () {
  if (!window.Capacitor || !window.Capacitor.isNativePlatform || !window.Capacitor.isNativePlatform()) return;
  var App = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App;
  if (!App || typeof App.addListener !== 'function') return;

  App.addListener('backButton', function (ev) {
    try {
      if (ev && ev.canGoBack) App.exitApp();
    } catch (e) { /* swallow — back should never crash */ }
  });
})();
