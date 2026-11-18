/* The 151 Machine — UI: plugin loader, apps panel, global API */

// ─── Plugin script version stamp GIRO PRESTAZIONI ────────
// This used to be `?t=' + Date.now()`, which gave every plugin script a URL
// that had never been seen before and could never be seen again. MEASURED: the
// enabled plugins ship 964 KB of client.js (entertainment alone is 487 KB), and
// that 964 KB was re-downloaded, uncompressed, on EVERY page load — not because
// caching was disabled, but because the URL itself made caching impossible. The
// server's `no-store` was hiding it; with the server now caching versioned
// assets, this line would have silently kept plugins as the one thing that
// never benefits.
//
// window.__CODE_HASH is the same content-stable hash index.html stamps on core
// JS/CSS (server/index.js getIndexHtml), and it covers plugins/ and
// public/plugins/ (server/build-hash.js CONTENT_ROOTS) — so editing a plugin
// client DOES move it, and the browser re-fetches. Falling back to Date.now()
// keeps the old behaviour if the hash is somehow absent: worse caching, never
// stale code.
function pluginVersionTag() {
  return window.__CODE_HASH ? ('?v=' + window.__CODE_HASH) : ('?t=' + Date.now());
}

// Load client-side plugin scripts (online from server, offline from bundle)
async function loadClientPlugins() {
  var plugins;
  var offline = false;
  try {
    plugins = await api('GET', '/plugins');
  } catch(e) {
    offline = true;
    try {
      var res = await fetch('/offline-plugins.json');
      plugins = await res.json();
    } catch(e2) { return; }
  }
  window._pluginsData = plugins;
  window._pluginsOffline = offline;
  plugins.forEach(function(p) {
    if (p.enabled && p.hasClient) {
      var script = document.createElement('script');
      var base = offline ? '' : (typeof getServerUrl === 'function' ? getServerUrl() : '');
      script.src = base + '/plugins/' + p.id + '/client.js' + pluginVersionTag();
      script.dataset.pluginId = p.id;
      document.head.appendChild(script);
    }
  });
}
window.loadClientPlugins = loadClientPlugins;

// --- Apps Panel ---
var appsPanel = document.getElementById('apps-panel');
var appsOverlay = document.getElementById('apps-overlay');
var appsList = document.getElementById('apps-list');
var appsContainer = document.getElementById('apps-container');
var appsBtn = document.getElementById('apps-btn');
var activeAppId = null;
// Intestazione del pannello (round 8): titolo e freccia indietro stanno in
// cima accanto alla X, non dentro il plugin. `appNames` tiene i nomi presi
// da /plugins, perché openApp riceve solo l'id ma il titolo deve dire
// "Quick Actions", non "quick-actions" e tantomeno "Plugins".
var appsBackBtn = document.getElementById('apps-back');
var appsTitleEl = document.querySelector('#apps-header h2');
var appNames = {};

// Un solo posto che decide cosa c'è scritto in cima e se la freccia si vede:
// due chiamanti (apri app / torna all'elenco) e nessuna riga fuori sincrono.
function setAppsHeader(name) {
  if (appsTitleEl) appsTitleEl.textContent = name || 'Plugins';
  if (appsBackBtn) appsBackBtn.hidden = !name;
}

function openAppsPanel() {
  // Reset to menu cards every time — prevent auto-reopening last-used app
  activeAppId = null;
  appsList.style.display = '';
  appsContainer.innerHTML = '';
  setAppsHeader(null);
  appsPanel.classList.add('open');
  appsOverlay.classList.add('show');
  appsBtn.classList.add('panel-open');
  loadAppPlugins();
}
window.openAppsPanel = openAppsPanel;

// ── Apps panel: editorial grouped layout ──────────────────────────────────
// The panel is a curated hub, not a flat plugin list. Two groups, in order
// ("Scuola", the portals, removed 2026-10-12):
//   "Le mie cose" (viola)  — personal apps (empty in this copy: the notes check
//                            needed a server route this copy does not have)
//   "Sistema" (grigio)     — mechanical utilities at the bottom: Backup, Update, Pulizia
// Items are one of three kinds:
//   plugin   → an app-category plugin (openApp); only rendered if present+enabled
//   skill    → opens a fresh blank session running a slash-command (_launchSkill)
//   endpoint → fires a server POST in place (Backup)
// Plugin items inherit their real icon/name/description from /api/plugins (so
// they look exactly as they do elsewhere). skill/endpoint items carry their own.
var APP_GROUPS = [
  { id: 'mine', items: [
    // The panel descriptions (Backup · Updates · Cleanup) share
    // ONE form, corrected to ENGLISH on 2026-08-20 (round 2, punto 3 — the owner
    // wanted English, not shortened Italian): bare verb + object, two words, no
    // article, no trailing period. The rest of the panel is English, so an
    // Italian island in it read as a mistake.
  ]},
  { id: 'system', items: [
    // Backup is a plugin since 16/10/2026 (plugins/backup/): the Entertainment
    // disk, plus the nightly Hetzner copy that this tile used to start.
    { kind: 'plugin', pluginId: 'backup', desc: 'Update disk' },
    { kind: 'plugin', pluginId: 'updates', desc: 'Update everything' },
    // [07/11/2026] Terminal tolto: i comandi si scrivono in chat con «!» (server/comando-chat.js).
    { kind: 'endpoint', endpoint: '/system-cleanup', report: true, running: 'Cleaning up…', title: 'System cleanup', icon: IC.broom, label: 'Cleanup', desc: 'Free space' },
    // [17/10/2026] il proprietario: il riavvio della Machine è una voce in fondo. Stessa
    // strada di prima (sessions.js, _ecosystemRestart: conferma, poi POST
    // /ecosystem-restart); prima stava nella pressione lunga della freccina.
    // [12/11/2026 ] il proprietario: i super agenti si scelgono qui, in fondo («tanto è vuota»);
    // subito sopra «Restart machine», che resta l'ultima.
    { kind: 'plugin', pluginId: 'super-agents', desc: 'Choose agents' },
    { kind: 'action', action: 'restartMachine', icon: IC.power, label: 'Restart machine', desc: 'Restart everything' }
  ]}
];

// Run an item's action. Plugins open in-panel; skills open a fresh session;
// endpoints POST in place with a toast.
async function runAppItem(item) {
  if (item.kind === 'plugin') { openApp(item.pluginId); return; }
  if (item.kind === 'skill') {
    closeAppsPanel();
    if (typeof window._launchSkill === 'function') window._launchSkill(item.command, item.title || item.label);
    return;
  }
  if (item.kind === 'endpoint') {
    if (item.report) {
      // Mechanical script that returns a text report to read (update, cleanup). Show a spinner toast, then the output in a modal.
      closeAppsPanel();
      showToast(item.running || 'Please wait…');
      try {
        var r = await api('POST', item.endpoint);
        showReportModal(item.title || item.label, (r && r.output) || 'No output.');
      } catch (e) { showToast('Action failed'); }
    } else {
      try { await api('POST', item.endpoint); showToast(item.toast || 'Done'); }
      catch (e) { showToast('Action failed'); }
    }
    return;
  }
  if (item.kind === 'action' && item.action === 'restartMachine') {
    closeAppsPanel();
    if (typeof window.ecosystemRestart === 'function') window.ecosystemRestart();
    return;
  }
}

// Simple full-text report modal for mechanical utilities. Monospace <pre> so the
// script output reads exactly as in a terminal. Tap the backdrop or ✕ to close.
function showReportModal(title, text) {
  var old = document.getElementById('report-modal');
  if (old) old.remove();
  var wrap = document.createElement('div');
  wrap.id = 'report-modal';
  wrap.innerHTML =
    '<div class="report-backdrop"></div>' +
    '<div class="report-sheet">' +
      '<div class="report-head"><span>' + (title || 'Report') + '</span>' +
      '<button class="report-close" aria-label="Close">&times;</button></div>' +
      '<pre class="report-body"></pre>' +
    '</div>';
  wrap.querySelector('.report-body').textContent = text;
  function close() { wrap.remove(); }
  wrap.querySelector('.report-backdrop').onclick = close;
  wrap.querySelector('.report-close').onclick = close;
  document.body.appendChild(wrap);
}
window.showReportModal = showReportModal;

// Build one item as a native app-card row (same language as the rest of the
// app). Grouping is conveyed by color + spacing, not text headers. Plugin items
// pull their real icon/name/description from the fetched app object.
function buildAppItem(item, app) {
  var el = document.createElement('div');
  el.className = 'apps-card';
  var label, desc, iconVal;
  if (item.kind === 'plugin' && app) {
    el.dataset.pluginId = item.pluginId;
    // An explicit item.desc WINS over the manifest description. The manifest
    // text is the plugin's own (English, technical, reused in the plugin
    // manager); the hub wants the short uniform Italian line. Overriding here
    // rather than rewriting the manifest keeps both surfaces honest.
    label = app.name; desc = item.desc || app.description || ''; iconVal = app.icon || IC.package;
  } else {
    label = item.label; desc = item.desc || ''; iconVal = item.icon || IC.package;
  }
  var iconHtml = (typeof iconVal === 'string' && iconVal.match(/\.(png|jpg|svg)$/i))
    ? '<img src="' + iconVal + '" style="width:24px;height:24px;object-fit:contain;">'
    : iconVal;
  el.innerHTML = '<span class="apps-card-icon">' + iconHtml + '</span>' +
    '<div class="apps-card-info"><div class="apps-card-name">' + label + '</div>' +
    '<div class="apps-card-desc">' + desc + '</div></div>';
  el.onclick = function() { runAppItem(item); };
  // Raggiungibile da tastiera (12/10/2026): è un <div>, quindi ruolo, posto
  // nel giro del Tab e Invio/Spazio come un bottone vero.
  el.setAttribute('role', 'button');
  el.tabIndex = 0;
  el.onkeydown = function(e) {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    // A modalità offline le carte sono spente (main.css: pointer-events none):
    // la tastiera non deve aggirarlo.
    if (document.documentElement.getAttribute('data-modalita') === 'offline') return;
    runAppItem(item);
  };
  return el;
}

function closeAppsPanel() {
  appsPanel.classList.remove('open');
  appsOverlay.classList.remove('show');
  appsBtn.classList.remove('panel-open');
}
window.closeAppsPanel = closeAppsPanel;

function toggleAppsPanel() {
  if (appsPanel.classList.contains('open')) {
    closeAppsPanel();
  } else {
    openAppsPanel();
  }
}
window.toggleAppsPanel = toggleAppsPanel;

async function loadAppPlugins() {
  try {
    var plugins;
    try { plugins = await api('GET', '/plugins'); }
    catch (eApi) {
      // [2026-10-07] OFFLINE: il Pi non c'è, l'elenco viene dalla copia nel
      // telefono — lo stesso che loadClientPlugins ha già usato all'avvio.
      if (window._pluginsOffline && Array.isArray(window._pluginsData)) plugins = window._pluginsData;
      else { var r = await fetch('/offline-plugins.json'); plugins = await r.json(); }
    }
    var apps = plugins.filter(function(p) { return p.category === 'app' && p.enabled; });
    var appById = {};
    apps.forEach(function(a) { appById[a.id] = a; appNames[a.id] = a.name || a.id; });
    renderAppsPanel(appById);
    // If a previously active app is still valid, re-open it
    if (activeAppId) {
      if (appById[activeAppId]) openApp(activeAppId);
      else { activeAppId = null; backToAppsList(); }
    }
  } catch(e) {
    appsList.innerHTML = '';
    appsContainer.innerHTML = '<div class="apps-empty"><div class="apps-empty-icon">!</div>Could not load apps.</div>';
  }
}

// Render the editorial grouped hub into #apps-list. Plugin items only appear
// when their plugin is present+enabled; skill/endpoint items always appear.
// A group with no available items is skipped entirely.
function renderAppsPanel(appById) {
  appsList.innerHTML = '';
  APP_GROUPS.forEach(function(group) {
    var items = group.items.filter(function(it) {
      return it.kind !== 'plugin' || appById[it.pluginId];
    });
    if (!items.length) return;

    var section = document.createElement('div');
    section.className = 'apps-group apps-group-' + group.id;
    items.forEach(function(it) {
      section.appendChild(buildAppItem(it, it.kind === 'plugin' ? appById[it.pluginId] : null));
    });
    appsList.appendChild(section);
  });
}

function backToAppsList() {
  activeAppId = null;
  appsList.style.display = '';
  appsContainer.innerHTML = '';
  setAppsHeader(null);
}

function openApp(pluginId) {
  activeAppId = pluginId;
  appsList.style.display = 'none';

  // Titolo e freccia salgono nell'intestazione: qui sotto resta SOLO il
  // plugin, a tutta altezza. La riga con la freccia che stava qui (con gli
  // stili scritti a mano dentro l'HTML) è sparita apposta.
  setAppsHeader(appNames[pluginId] || pluginId);

  appsContainer.innerHTML = '<div id="app-mount-' + pluginId + '" class="app-mount"></div>';

  var handlers = window.The151Machine.plugins[pluginId];
  if (handlers && typeof handlers.renderInPanel === 'function') {
    handlers.renderInPanel(document.getElementById('app-mount-' + pluginId));
  } else if (handlers && typeof handlers.open === 'function') {
    handlers.open();
  }
}

appsBtn.onclick = toggleAppsPanel;
document.getElementById('apps-close').onclick = closeAppsPanel;
if (appsBackBtn) appsBackBtn.onclick = backToAppsList;
appsOverlay.onclick = closeAppsPanel;

// Swipe left from right edge to open apps panel
var _appSwipeStartX = 0, _appSwipeStartY = 0;
document.addEventListener('touchstart', function(e) {
  _appSwipeStartX = e.touches[0].clientX;
  _appSwipeStartY = e.touches[0].clientY;
}, { passive: true });
document.addEventListener('touchend', function(e) {
  var dx = e.changedTouches[0].clientX - _appSwipeStartX;
  var dy = Math.abs(e.changedTouches[0].clientY - _appSwipeStartY);
  if (_appSwipeStartX > window.innerWidth - 50 && dx < -60 && dy < 80) {
    openAppsPanel();
  }
}, { passive: true });

// --- JOB 1: global horizontal swipe to open/close the side panels (touch only) ---
// Reuses the EXACT existing toggle mechanism — openSidebar/closeSidebar for the
// LEFT session list, openAppsPanel/closeAppsPanel for the RIGHT apps bar (the same
// functions the menu/apps buttons and the pre-existing EDGE swipes call). This is
// ADDITIVE: the left-edge swipe (input.js) and right-edge swipe (above) are left
// untouched — this broader gesture just makes the panels reachable from anywhere,
// which matters on Android where the system back-gesture eats true edge swipes.
// Guarded on touch so desktop is completely unaffected. Phone config is NOT
// touched — this only reads sidebar/appsPanel state and calls the shared toggles.
(function initPanelSwipe() {
  var isTouch = ('ontouchstart' in window) ||
                (navigator.maxTouchPoints > 0) ||
                (window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
  if (!isTouch) return; // desktop / mouse: no-op

  var sx = 0, sy = 0, st = 0, tracking = false;

  // True if the touch began inside an element that scrolls horizontally (code
  // blocks, tables) — we must not hijack its scroll into a panel open.
  function startedInScrollableX(node) {
    var el = node, depth = 0;
    while (el && el.nodeType === 1 && el !== document.body && depth < 8) {
      if (el.scrollWidth > el.clientWidth + 4) {
        var ov = '';
        try { ov = getComputedStyle(el).overflowX; } catch (e) {}
        if (ov === 'auto' || ov === 'scroll') return true;
      }
      el = el.parentElement; depth++;
    }
    return false;
  }

  document.addEventListener('touchstart', function(e) {
    if (!e.touches || e.touches.length !== 1) { tracking = false; return; }
    sx = e.touches[0].clientX;
    sy = e.touches[0].clientY;
    st = Date.now();
    tracking = true;
  }, { passive: true });

  document.addEventListener('touchend', function(e) {
    if (!tracking) return;
    tracking = false;
    if (!e.changedTouches || !e.changedTouches.length) return;
    var dx = e.changedTouches[0].clientX - sx;
    var dy = e.changedTouches[0].clientY - sy;
    // A decisive, dominantly-horizontal flick only.
    if (Date.now() - st > 700) return;
    if (Math.abs(dx) < 70) return;
    if (Math.abs(dx) < Math.abs(dy) * 2) return;
    if (startedInScrollableX(e.target)) return;

    var sidebarOpen = window.sidebar && window.sidebar.classList.contains('open');
    var appsOpen = appsPanel && appsPanel.classList.contains('open');

    if (dx > 0) {
      // left -> right: reveal the LEFT session list (or close the right bar)
      if (appsOpen) closeAppsPanel();
      else if (!sidebarOpen) openSidebar();
    } else {
      // right -> left: reveal the RIGHT apps bar (or close the left list)
      if (sidebarOpen) closeSidebar();
      else if (!appsOpen) openAppsPanel();
    }
  }, { passive: true });
})();

// --- Dead-first-tap rescuer for the side panels (BUG A root fix, 2026-08-15) ---
// ROOT CAUSE (proven in an emulated-touch Chromium harness + on-device tracer):
// after a horizontal FLICK over the chat, the browser suppresses any tap that
// lands within its post-fling window (~200ms emulated, longer on device) — the
// tap fires touchstart+touchend on the session item but NO click is ever
// synthesized. It is velocity-based (holding the finger still before lifting
// kills it) and independent of panel animation, text selection, focus, and
// touch-action — which is why all six earlier fixes failed. The button path
// only "worked" because reaching the top-left button spaces the taps out.
// FIX: don't fight the suppression — detect the swallowed tap and re-issue its
// click. Scoped to taps INSIDE #sidebar / #apps-panel / their overlays; all
// listeners passive (nothing is prevented — no c48d029-style regression);
// never fires when a real click arrives, when the tap was a fling-stop on a
// scrolling panel list, or when it was clearing a text selection.
(function initTapRescue() {
  var isTouch = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);
  if (!isTouch) return;
  var pending = null;
  var lastPanelScrollT = 0;

  function panelOf(node) {
    if (!node || !node.closest) return null;
    return node.closest('#sidebar') || node.closest('#apps-panel') ||
           node.closest('#sidebar-overlay') || node.closest('#apps-overlay');
  }

  // Any scroll inside a panel marks the moment — a tap right after it is a
  // legitimate fling-stop whose click the browser suppresses on purpose.
  document.addEventListener('scroll', function (e) {
    var t = e.target;
    if (t && t.nodeType === 1 && panelOf(t)) lastPanelScrollT = Date.now();
  }, { passive: true, capture: true });

  document.addEventListener('touchstart', function (e) {
    pending = null;
    if (!e.touches || e.touches.length !== 1) return;
    var panel = panelOf(e.target);
    if (!panel) return;
    if (Date.now() - lastPanelScrollT < 120) return; // fling-stop tap
    var sel = null;
    try { sel = window.getSelection(); } catch (err) {}
    if (sel && sel.type === 'Range') return; // tap is clearing a selection
    pending = { x: e.touches[0].clientX, y: e.touches[0].clientY, t: Date.now(),
                target: e.target, moved: 0, clicked: false };
  }, { passive: true, capture: true });

  document.addEventListener('touchmove', function (e) {
    if (!pending || !e.touches || !e.touches.length) return;
    var d = Math.max(Math.abs(e.touches[0].clientX - pending.x), Math.abs(e.touches[0].clientY - pending.y));
    if (d > pending.moved) pending.moved = d;
  }, { passive: true, capture: true });

  document.addEventListener('touchend', function () {
    var p = pending;
    pending = null;
    if (!p) return;
    if (p.moved > 12) return;                        // not a tap
    if (Date.now() - p.t > 400) return;              // long-press etc.
    if (Date.now() - lastPanelScrollT < 120) return; // panel scrolled during the touch
    var onClick = function () { p.clicked = true; };
    document.addEventListener('click', onClick, true);
    setTimeout(function () {
      document.removeEventListener('click', onClick, true);
      if (p.clicked) return;                          // real click arrived — do nothing
      var el = p.target;
      if (!el || !el.isConnected || !panelOf(el)) return;
      try { el.click(); } catch (err) {}
      console.log('[tap-rescue] re-issued suppressed click on', el.id || el.className || el.tagName);
    }, 250);
  }, { passive: true, capture: true });
})();

// --- The151Machine Plugin API ---
var _wsMessageHandlers = [];
window.The151Machine = {
  plugins: {},
  register: function(pluginId, handlers) {
    window.The151Machine.plugins[pluginId] = handlers;
  },
  get: function(pluginId) {
    return window.The151Machine.plugins[pluginId] || null;
  },
  api: api,
  showToast: showToast,
  getActiveSession: function() { return activeSessionId; },
  openAppsPanel: openAppsPanel,
  closeAppsPanel: closeAppsPanel,
  getAppsContainer: function() { return appsContainer; },
  // Subscribe to WS messages (plugins call this)
  onWsMessage: function(handler) {
    if (typeof handler === 'function') _wsMessageHandlers.push(handler);
  },
  // --- Slot System ---
  // [2026-10-16] registerStatusWidget/removeStatusWidget tolti con la barra in
  // alto (#status-bar-slot) in cui scrivevano: nessun plugin li chiamava.
  _toolbarActions: {},

  registerToolbarAction: function(id, opts) {
    // ('file-browser-browse' dropped 2026-08-20 — the File Browser app is gone.)
    if (id === 'quick-actions-backup') return;
    var slot = document.getElementById('toolbar-slot');
    if (!slot) return;
    var el = slot.querySelector('[data-action-id="' + id + '"]');
    if (!el) {
      el = document.createElement('button');
      el.className = 'toolbar-action';
      el.dataset.actionId = id;
      slot.appendChild(el);
    }
    if (opts.primary) {
      el.classList.add('is-primary');
    } else {
      el.classList.remove('is-primary');
    }
    var iconSpan = document.createElement('span');
    iconSpan.className = 'action-icon';
    if (opts.iconSvg && opts.iconSvg.trim()) {
      iconSpan.innerHTML = opts.iconSvg;
    } else {
      iconSpan.textContent = opts.icon || '';
    }
    var labelSpan = document.createElement('span');
    labelSpan.className = 'action-label';
    labelSpan.textContent = opts.label || '';
    el.textContent = '';
    el.appendChild(iconSpan);
    el.appendChild(labelSpan);
    el.onclick = opts.onClick || null;
    window.The151Machine._toolbarActions[id] = true;
    slot.classList.remove('slot--hidden');
  },

  removeToolbarAction: function(id) {
    var slot = document.getElementById('toolbar-slot');
    if (!slot) return;
    var el = slot.querySelector('[data-action-id="' + id + '"]');
    if (el) el.remove();
    delete window.The151Machine._toolbarActions[id];
    if (Object.keys(window.The151Machine._toolbarActions).length === 0) {
      slot.classList.add('slot--hidden');
    }
  },

  getSetting: function(pluginId, key, fallback) {
    try {
      var raw = localStorage.getItem('151-plugin-' + pluginId + '-' + key);
      return raw !== null ? raw : fallback;
    } catch(e) { return fallback; }
  },
};

// All teams button
// 2026-08-19: New Session no longer spawns on the spot. It opens the SAME
// inline compose panel a Super-Agent card opens (optional first message +
// spawn-model selector), only anchored ABOVE the button, since the button lives
// at the bottom of the sidebar. The model defaults to Opus
// (SPAWN_MODEL_DEFAULTS.overseer in sessions.js) so a new working session never
// silently burns the weekly Fable budget. Send with an empty box = exactly the
// old behaviour (blank Overseer-routed session). A second click closes it.
var allTeamsBtn = document.getElementById('all-teams-btn');
if (allTeamsBtn) {
  allTeamsBtn.onclick = function() {
    if (typeof window._toggleAgentCompose === 'function') {
      window._toggleAgentCompose(allTeamsBtn, 'overseer', {
        placement: 'above',
        // The sidebar must stay OPEN while the panel is being filled in; on
        // phone it slides away only when the session is actually launched.
        beforeLaunch: closeSidebar
      });
      return;
    }
    closeSidebar();
    if (typeof window._launchTeam === 'function') window._launchTeam('overseer');
  };
}

// [2026-09-10] Il gemello del bottone qui sopra, sulla schermata «Nessuna
// sessione attiva» (index.html #empty-state). Da quando zero sessioni è uno
// stato legittimo, quella pagina si vede per davvero e deve portare con sé il
// modo di uscirne: senza questo, l'unica strada era il menu laterale.
// Deliberatamente SENZA il pannello di composizione del gemello: lì il pannello
// va sopra il bottone, dentro #sidebar-footer, che qui non esiste. Un click =
// una sessione nuova, il comportamento nudo che il bottone laterale aveva prima
// del 2026-08-19 ed esattamente ciò che «il modo ovvio per aprirne una» vuol
// dire su una pagina vuota.
var emptyNewBtn = document.getElementById('empty-new-session');
if (emptyNewBtn) {
  emptyNewBtn.onclick = function() {
    // In modalità intrattenimento (PC spento) non c'è chat da aprire: init.js
    // riscrive comunque questa pagina col suo cartello, ma se il click arriva
    // prima non deve partire una POST che il server rifiuta.
    if (window.chatAvailable === false) return;
    if (typeof window._launchTeam === 'function') window._launchTeam('overseer');
  };
}
