/* The 151 Machine — Init: startup, session restore */

// [2026-09-10] ZERO SESSIONI È UNO STATO, NON UN GUASTO — il proprietario: «quando cancello
// tutte le sessioni me ne viene creata in automatico una nuova. Se cancello anche
// quella ne viene creata un'altra vuota. Vorrei che non succedesse più.»
//
// Prima, questa funzione apriva un Overseer OGNI volta che la lista arrivava
// vuota — e siccome init() gira a ogni ricaricamento della pagina, cancellare
// tutto e ricaricare rifaceva nascere una sessione all'infinito. Il ciclo che
// non finiva più.
//
// Resta viva UNA sola nascita automatica, quella che il proprietario ha chiamato «giusta»:
// la PRIMISSIMA apertura della Macchina su questo dispositivo, quando non c'è
// mai stato niente e una schermata vuota sarebbe solo un muro senza porta. Da
// lì in poi zero vuol dire zero: si mostra il cartello e si apre a mano.
//
// Il segno è per DISPOSITIVO e a senso unico (si mette, non si toglie mai):
// markMachineSeen() lo scrive alla fine di ogni init() riuscito, quindi basta
// un avvio — con o senza sessioni — perché la Macchina smetta per sempre di
// considerarsi "nuova" qui sopra.
var EVER_BOOTED_KEY = '151-terminal-ever-booted';

// Fallback PRUDENTE: se localStorage non è leggibile (private mode, storage
// negato) rispondiamo "sì, l'ho già vista". Sbagliare da questo lato costa una
// schermata vuota su un dispositivo nuovo — un click; sbagliare dall'altro
// rimetterebbe in piedi esattamente il ciclo che stiamo togliendo, perché un
// segno che non si può scrivere non si può nemmeno rileggere.
function machineSeenBefore() {
  try { return !!localStorage.getItem(EVER_BOOTED_KEY); } catch (e) { return true; }
}
function markMachineSeen() {
  try { localStorage.setItem(EVER_BOOTED_KEY, '1'); } catch (e) {}
}

function ensureLiveSession() {
  // Già stato qui: il vuoto è una scelta, si rispetta.
  if (machineSeenBefore()) { showEmptyState(); return; }
  if (window.chatAvailable !== false && typeof window._launchTeam === 'function') {
    window._launchTeam('overseer');
  } else {
    showEmptyState();
  }
}

// --- Init ---
async function init() {
  // I permessi Android li chiede MainActivity.requestNeededPermissions() (Java):
  // il ponte JS «AndroidPermissions» non è mai esistito, tolto 12/10.
  // Check CLI/chat availability (entertainment-only mode when no chat)
  try {
    var healthRes = await fetch(getServerUrl() + '/api/health', { cache: 'no-store' });
    var healthData = await healthRes.json();
    window.cliAvailable = healthData.cliAvailable !== false;
    window.chatAvailable = healthData.chatAvailable !== false;
  } catch(e) { window.cliAvailable = true; window.chatAvailable = true; }

  // [2026-10-07] Senza PC l'app resta LA STESSA: niente più schermata
  // «Entertainment Mode». Le sessioni si leggono dalla copia del telefono
  // (loadSessions ripiega su 151-sessions-cache quando /api risponde 503
  // offline), il compositore lo spegne il grigio della modalità OFFLINE.
  if (!window.chatAvailable) {
    var newBtn = document.getElementById('all-teams-btn');
    if (newBtn) newBtn.style.display = 'none';
  }

  try {
    // Check for restart-state (page was reloaded due to new server code)
    var restartState = null;
    try {
      var raw = sessionStorage.getItem('151-restart-state');
      if (raw) {
        restartState = JSON.parse(raw);
        sessionStorage.removeItem('151-restart-state');
      }
    } catch(e) {}

    await loadSessions();
    if (window.chatAvailable) await loadCommands();
    // Le squadre di chi usa l'app (GET /api/squadre): si uniscono e la lista si ridisegna.
    if (typeof window.loadSquadre === 'function') window.loadSquadre();
    requestNotificationPermission();
    loadClientPlugins();

    // Determine which session to restore
    var targetId = null;
    if (restartState && restartState.sessionId) {
      targetId = restartState.sessionId;
      console.log('[INIT] Restoring from restart state:', targetId);
    } else {
      targetId = localStorage.getItem('151-terminal-session');
      console.log('[INIT] Restoring from localStorage:', targetId);
    }

    if (targetId) {
      var target = sessions.find(function(s) { return s.id === targetId; });
      if (target) {
        switchSession(target.id);
      } else if (sessions.length > 0) {
        console.warn('[INIT] Saved session not found, using first');
        switchSession(sessions[0].id);
      } else {
        ensureLiveSession();
      }
    } else if (sessions.length > 0) {
      switchSession(sessions[0].id);
    } else {
      ensureLiveSession();
    }

    // Da qui in poi questo dispositivo ha VISTO la Macchina: la nascita
    // automatica di cortesia (ensureLiveSession) non si ripeterà mai più, e un
    // ricaricamento a zero sessioni resterà sul cartello del vuoto. Scritto
    // DOPO la decisione qui sopra, così il primissimo avvio la ottiene ancora.
    markMachineSeen();

    // Restore draft — restart state takes priority, then per-session draft
    if (restartState && restartState.draftText) {
      messageInput.value = restartState.draftText;
    } else if (activeSessionId) {
      messageInput.value = loadDraft(activeSessionId);
    }
    // M9 Vettore 6: re-populate the compose attachment bar from the persisted
    // draft refs so an upload-on-add attachment survives a reload/restart.
    if (activeSessionId && typeof window._rehydrateDraftAttachments === 'function') {
      window._rehydrateDraftAttachments(activeSessionId);
    }
    // No autoResize() call needed here any more: sessions.js now owns a `value`
    // setter on #message-input that sizes the box on EVERY assignment, so the
    // draft restore above is already correct. The explicit call that used to sit
    // here was a per-call-site patch for a problem that had twelve call sites.
    sendBtn.classList.toggle('has-text', !!messageInput.value.trim());
    if (restartState && restartState.scrollTop) {
      setTimeout(function() { messagesEl.scrollTop = restartState.scrollTop; }, 200);
    }
    // Animated restart landing — TV-on + changelog popup
    var pendingRestart = null;
    try {
      pendingRestart = sessionStorage.getItem('151-restart-pending');
      sessionStorage.removeItem('151-restart-pending');
    } catch(e) {}
    // Guard: skip landing TV-on if a TV-on already played (exitRestartMode or a prior init pass) within 5s.
    var _landedKey = '151-restart-landed-at';
    var _lastLand = 0;
    try { _lastLand = parseInt(sessionStorage.getItem(_landedKey) || '0', 10); } catch(e) {}
    if (pendingRestart && _lastLand && (Date.now() - _lastLand) < 5000) {
      pendingRestart = null; // already animated recently — don't re-play
    }
    if (pendingRestart) {
      try { sessionStorage.setItem(_landedKey, String(Date.now())); } catch(e) {}
      // Page just reloaded after a deploy. Play TV-on animation with changelog.
      var overlay = document.getElementById('restart-overlay');
      var mainApp = document.getElementById('app');

      // Start with app hidden behind restart overlay
      overlay.classList.add('show', 'restarting');
      mainApp.classList.add('restart-hidden');

      // Brief pause so user sees the "restarting" screen, then animate back
      setTimeout(function() {
        mainApp.classList.remove('restart-hidden');
        mainApp.style.opacity = '0';
        requestAnimationFrame(function() {
          overlay.classList.add('tv-on');
          mainApp.style.transition = 'opacity 0.6s ease';
          mainApp.style.opacity = '1';
        });

        setTimeout(function() {
          overlay.classList.remove('show', 'restarting', 'tv-off', 'tv-on');
          mainApp.style.transition = '';
          mainApp.style.opacity = '';

          // Novità dopo la consegna (window.showWhatsNew in js/ws.js).
          if (window.showWhatsNew) window.showWhatsNew();

          ensureInputVisible();
        }, 700);
      }, 400);
    } else if (window.showWhatsNew) {
      // App aperta dopo una consegna avvenuta mentre era chiusa: le novità
      // arrivano lo stesso (ogni apparecchio ricorda l'ultima versione vista).
      setTimeout(window.showWhatsNew, 1500);
    }
  } catch(e) {
    console.error('[INIT] Error during startup:', e);
  }
  // Safety net — runs ALWAYS, even after return paths
  ensureInputVisible();
  dismissBootOverlay();
}

function dismissBootOverlay() {
  var boot = document.getElementById('boot-overlay');
  if (!boot || boot.classList.contains('boot-done')) return;
  boot.classList.add('boot-ready');
  setTimeout(function() { boot.classList.add('boot-done'); }, 850);
}

function ensureInputVisible() {
  setTimeout(function() {
    if (activeSessionId && !document.getElementById('app').classList.contains('view-session')) {
      console.warn('[SAFETY] Forcing view-session class');
      setViewState('session');
    }
    // Force input area into view after restart/reconnect
    var ia = document.getElementById('input-area');
    if (ia && ia.offsetParent !== null) {
      ia.scrollIntoView({ block: 'end', behavior: 'instant' });
      window.scrollTo(0, 0);
    }
  }, 500);
}

// Startup: if no server URL, ask for one. If a server URL exists, validate the
// token; without a token, take one from the server (no password since
// 12/11/2026 — only the PC and the owner's Tailscale get through).
if (!serverUrl) {
  // No server configured — the address goes in first («Configure server»).
  var _errNoServer = document.getElementById('login-error');
  if (_errNoServer) _errNoServer.textContent = 'Configure the server first';
  var _btnNoServer = document.getElementById('login-btn');
  if (_btnNoServer) _btnNoServer.disabled = true;
  dismissBootOverlay();
} else if (authToken) {
  // Have token — find best server, then validate.
  // Boot policy (native/WebView-safe): a present token is TRUSTED at boot. The
  // password/login overlay is shown ONLY on an explicit 401 (token actually
  // rejected by the server). A network timeout or any non-401 server hiccup must
  // NOT bounce a phone with a valid token back to the password page — that
  // fragile 6s probe was the cause of the restart login loop / triple prompt.
  // [12/11/2026] Nessuna impronta: con un gettone si entra diretti.

  // Proceed into the app using the token we already hold. Explicitly hide the
  // login overlay so it never flashes behind the app.
  var _bootWithToken = function() {
    var lo = document.getElementById('login-overlay');
    if (lo) lo.classList.add('hidden');
    init();
  };

  // [2026-09-22] UN CRONOMETRO SOLO PER DUE COSE DI PESO DIVERSO.
  //
  // C'era un unico `abort()` a 6000ms su TUTTA la richiesta: connessione,
  // intestazioni E scaricamento del corpo. Ma il corpo di /api/sessions e' la
  // lista completa con la STORIA INTERA di ogni sessione (server/session-
  // manager.js _serialize include `history`): misurata 313 KB il 27/08, ~95 KB
  // il 22/09, e comunque SENZA TETTO — cresce con le conversazioni. Su rete
  // mobile lenta 6s per un corpo del genere e' un fallimento annunciato, e il
  // fallimento non e' gratis: l'abort butta via i byte gia' scaricati, quindi
  // `window.__bootSessions` resta vuoto e loadSessions() riscarica la stessa
  // roba da capo. Il cronometro corto RADDOPPIAVA il traffico che il lavoro
  // prestazioni del 27/08 aveva dimezzato, proprio sulla rete piu' lenta.
  //
  // I due tempi servono a cose diverse e per questo sono due:
  //  · BOOT_HEADERS_MS — «c'e' qualcuno?». La risposta che conta all'avvio e'
  //    lo STATO (401 si' / 401 no) e lo stato arriva con le intestazioni. Se
  //    non arrivano, il server non c'e' e l'avvio non deve aspettare oltre.
  //    8s e non 6: findBestServer ha appena pagato fino a 4s di sola prova,
  //    e questa e' la stessa strada (radio da Doze, MagicDNS, TCP) con in piu'
  //    l'autenticazione. Sei secondi tagliavano proprio i risvegli lenti.
  //  · BOOT_BODY_MS — «scarica con calma». Parte SOLO dopo che il server ha
  //    gia' risposto: qui non stiamo piu' aspettando un morto, stiamo leggendo
  //    da uno vivo, e tagliargli la parola serve solo a farci riscaricare tutto.
  //
  // In tutti e due i casi di fallimento non cambia nulla di sostanziale:
  // `_bootWithToken()` avvia comunque l'app (un token presente e' fidato, si
  // cade sulla password SOLO con un 401 esplicito) e loadSessions() ricarica
  // per conto suo.
  // [2026-10-07] 8 s → 5 s, appena sopra la prova di raggiungibilità (4 s; la
  // sentinella tests/riconnessione-telefono.test.js vieta di scendere sotto:
  // i risvegli lenti del telefono). Oltre non serviva: aspettare 8 s lasciava
  // l'app sullo splash quando il PC era appena sparito (prova del proprietario,
  // Mullvad), e se il server tace loadSessions() mostra subito la copia del
  // telefono e sostituisce i dati veri quando arrivano.
  var BOOT_HEADERS_MS = 5000;
  var BOOT_BODY_MS = 25000;

  findBestServer().then(function() {
    var bootAbort = new AbortController();
    var bootFetchTimer = setTimeout(function() { bootAbort.abort(); }, BOOT_HEADERS_MS);
    fetch(getServerUrl() + '/api/sessions', {
      cache: 'no-store',
      headers: { 'Authorization': 'Bearer ' + authToken },
      signal: bootAbort.signal
    })
      .then(function(res) {
        // Le intestazioni sono arrivate: il server esiste. Da qui in poi il
        // cronometro corto non ha piu' niente da sorvegliare, e al suo posto
        // subentra quello lungo per il corpo.
        clearTimeout(bootFetchTimer);
        bootFetchTimer = setTimeout(function() { bootAbort.abort(); }, BOOT_BODY_MS);
        if (res.status === 401) {
          // Explicit auth failure — token genuinely invalid. Drop it and take a
          // new one from the server (no password since 12/11/2026).
          clearTimeout(bootFetchTimer); // niente corpo da leggere: il cronometro lungo non serve
          authToken = null;
          localStorage.removeItem('151-terminal-token');
          if (window.svuotaCopieLocali) window.svuotaCopieLocali(); // 401: le chat copiate se ne vanno col gettone
          dismissBootOverlay();
          if (window.doLogin) window.doLogin();
        } else {
          // res.ok OR a transient non-401 server error (5xx, etc.): trust the
          // token and boot. Never flash the password page on a server hiccup.
          //
          //, GIRO PRESTAZIONI: this probe already paid for the
          // whole session list (MEASURED 313 KB) and used to discard it, so the
          // loadSessions() that init() fires moments later downloaded the exact
          // same bytes a second time. Park the body for it instead. Booting is
          // NOT made to wait on the parse: _bootWithToken() is called from both
          // arms, so a malformed body costs one extra fetch, never a hang.
          res.json()
            .then(function(list) {
              if (Array.isArray(list)) window.__bootSessions = { at: Date.now(), data: list };
            })
            .catch(function() { /* not JSON — loadSessions() just fetches normally */ })
            .then(function() {
              clearTimeout(bootFetchTimer); // corpo finito (o fallito): cronometro spento
              _bootWithToken();
            });
        }
      })
      .catch(function() {
        clearTimeout(bootFetchTimer);
        // Timeout / server unreachable (typical on a phone's slow radio right
        // after restart). Token is present and not proven invalid — boot
        // offline-tolerant instead of bouncing to the password page.
        // [2026-10-07] Il server ha appena taciuto per BOOT_HEADERS_MS:
        // loadSessions() mostra subito la copia del telefono, senza altra attesa.
        window.__serverLento = true;
        _bootWithToken();
      });
  });
} else {
  // Have server but no token — take one (no password since 12/11/2026).
  // If the server refuses (not on Tailscale) the overlay says so, with Retry.
  dismissBootOverlay();
  if (window.doLogin) window.doLogin();
}
