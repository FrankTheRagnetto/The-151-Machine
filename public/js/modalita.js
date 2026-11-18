/* The 151 Machine — Le modalità (2026-10-07, rifatte dopo la prova del proprietario;
 * dal 12/10/2026 sono due: PIENA e OFFLINE).
 *
 * UN'INTERFACCIA SOLA: è sempre la Machine di sempre. Niente pagine a parte,
 * niente scritte nuove in testata: in OFFLINE lo dice la riga «PC not
 * reachable» al posto della chat (casaOffline, qui sotto). [16/10/2026] La
 * pillola «pc» della barra in alto non c'è più.
 *
 *   PIENA    — chi serve la pagina (il PC) risponde: tutto funziona.
 *   OFFLINE  — chi serve la pagina non risponde. Sul telefono l'APK serve
 *              questa stessa app dalla copia che ha dentro, allo stesso
 *              indirizzo (OfflineBridge.java), quindi i dati del telefono ci
 *              sono tutti. Tutto in grigio, con una riga che lo dice. (Fino al
 *              12/10 restavano accesi Entertainment e i 4 siti della scuola: il
 *              primo è l'app 151 Entertainment, i secondi li ha tolti il proprietario.)
 *
 * Dall'app 1.19 (11/10, strada C) il telefono carica la pagina DAL PC
 * (server.url = my-pc:3170), non più dal Pi: per il telefono PIENA vuol
 * dire «il PC risponde» e OFFLINE «il PC non risponde».
 * [12/10/2026] La terza modalità, SOLO PI (pagina servita dal Pi senza PC: chat
 * in sola lettura, socket chiuso dal Pi con 4003), è tolta con la Machine sul
 * Pi. Storia: git log -- server/peer-relay.js.
 * I nomi piRaggiungibile e __retePiCambiata restano: li chiama il codice
 * nativo dell'APK 1.20 (OfflineBridge.java), e la sonda bussa a server.url.
 *
 * Il passaggio è automatico nei due sensi. Verità: il telefono
 * (window.AndroidRete, sonda nativa su server.url) e /api/health
 * (503 con `offline` = l'APK dice che server.url non risponde).
 *
 * Contratto per i plugin: window.modalitaAttuale() → 'piena'|'offline'|null
 * e l'evento window 'modalita' {detail:{modo}} a ogni cambio.
 *
 * Prova: tests/tre-modalita.test.js
 */
(function () {
  'use strict';

  var PIENA = 'piena', OFFLINE = 'offline';
  // Fuori da PIENA si chiede spesso: è l'unico modo di risalire in fretta.
  // [2026-10-07] piena 20 s → 5 s: era il ritardo più lungo nella prova di
  // il proprietario (la vecchia pillola «pc» restava verde). La domanda è locale e leggera.
  var OGNI = { piena: 5000, offline: 4000 };
  var TIMEOUT_MS = 4000;
  var FALLITE_PER_OFFLINE = 2;
  // [2026-11-07] il proprietario: «make it more patient». Sul telefono via Starlink la
  // strada verso il PC cambia ~1 volta al minuto con buchi di pochi secondi:
  // oltre alle 2 fallite serve questo silenzio, contato dalla PRIMA fallita
  // della fila. Stesso numero di PAZIENZA_MS in GiudiceRete.java (APK).
  var PAZIENZA_MS = 12000;
  // [2026-11-10 BATTERIA ] Se il socket della chat ha appena sentito il PC
  // (un pong ogni 15 s, ws.js), il PC c'è: la domanda a /api/health basta ogni
  // 30 s invece di ogni 5 (12 → 2 richieste al minuto a schermo acceso).
  // L'orologio batte ancora ogni OGNI ms ma senza rete: appena il socket tace
  // da SOCKET_VIVO_MS, o una domanda è fallita, si torna a chiedere ogni 5 s —
  // il «grigio dopo 2 mancate e 12 s» resta quello di prima.
  var OGNI_SOCKET_VIVO = 30000;
  var SOCKET_VIVO_MS = 20000;

  var stato = { modo: null, fallite: 0, primaFallita: 0, inCorso: false, timer: null, serverEPc: false, ultimaDomanda: 0 };
  function adesso() { return Date.now(); }

  function base() {
    try { return typeof window.getServerUrl === 'function' ? (window.getServerUrl() || '') : ''; }
    catch (e) { return ''; }
  }
  function rete() { return window.AndroidRete || null; }
  // La pagina l'ha servita il telefono (copia nell'APK) invece di server.url?
  function paginaDalTelefono() {
    try { return !!(rete() && rete().paginaDalTelefono()); } catch (e) { return false; }
  }
  function piSecondoIlTelefono() {
    try { return rete() ? rete().piRaggiungibile() : null; } catch (e) { return null; }
  }

  function annuncia() {
    document.documentElement.setAttribute('data-modalita', stato.modo);
    try { window.dispatchEvent(new CustomEvent('modalita', { detail: { modo: stato.modo } })); } catch (e) {}
  }

  // ─── OFFLINE: la casa — una riga che dice cosa succede ─────────────────
  // Messa dove di solito c'è la chat. Le chat salvate sul telefono restano
  // dietro, in grigio (archivio IndexedDB, vedi sessions.js).
  function casaOffline() {
    if (document.getElementById('casa-offline')) return;
    var msgs = document.getElementById('messages');
    if (!msgs) return;
    var casa = document.createElement('div');
    casa.id = 'casa-offline';
    casa.innerHTML = '<div class="casa-titolo">PC not reachable</div>' +
      '<div class="casa-sotto">What is on this phone is kept. The rest comes back by itself.</div>';
    var primo = document.getElementById('empty-state') || msgs;
    primo.parentNode.insertBefore(casa, primo);
  }

  function applica(nuovo, perche) {
    var vecchio = stato.modo;
    if (nuovo === vecchio) return;
    stato.modo = nuovo;
    try { console.log('[MODALITA] ' + (vecchio || '-') + ' → ' + nuovo + ' (' + perche + ')'); } catch (e) {}
    if (nuovo === OFFLINE) casaOffline();
    annuncia();

    // Mai chiusi fuori: se c'è la pagina della password (niente gettone
    // salvato), offline non si potrebbe entrare comunque — si toglie e resta
    // la riga della casa.
    if (nuovo === OFFLINE) {
      var lo = document.getElementById('login-overlay');
      if (lo && !lo.classList.contains('hidden') && paginaDalTelefono()) {
        // Senza gettone non si è entrati: le chat archiviate restano nascoste
        // (sono di chi ha fatto l'accesso).
        document.documentElement.setAttribute('data-senza-accesso', 'si');
        lo.classList.add('hidden');
      }
    }

    if (nuovo === PIENA && vecchio === OFFLINE) {
      // Chi serve la pagina è tornato. Se questa pagina è la copia del
      // telefono, si ricarica da server.url (codice e dati veri).
      if (paginaDalTelefono()) { location.reload(); return; }
    }
    if (nuovo === PIENA && vecchio === OFFLINE) {
      // Avviata senza PC (init.js ha nascosto chat e sessioni): ripartire da
      // capo è la via pulita per avere sessioni, comandi e socket.
      if (window.chatAvailable === false) { location.reload(); return; }
      if (typeof window.wsOnResume === 'function') window.wsOnResume();
    }
  }

  // ─── La domanda ────────────────────────────────────────────────────────
  function programma() {
    if (stato.timer) clearTimeout(stato.timer);
    if (document.hidden) { stato.timer = null; return; } // in tasca non si chiede
    stato.timer = setTimeout(function () { controlla('orologio'); }, OGNI[stato.modo || PIENA]);
  }

  // Il PC c'è e il socket lo sta dicendo: niente domanda finché non sono
  // passati OGNI_SOCKET_VIVO ms dall'ultima.
  function socketVivo() {
    try {
      var w = window.ws, r = window._wsLastRecv;
      return !!(w && w.readyState === 1 && typeof r === 'number' && r > 0 && adesso() - r < SOCKET_VIVO_MS);
    } catch (e) { return false; }
  }
  function puoiAspettare() {
    return stato.modo === PIENA && stato.fallite === 0 && socketVivo() &&
      adesso() - stato.ultimaDomanda < OGNI_SOCKET_VIVO;
  }

  function controlla(perche) {
    if (stato.inCorso) return;
    // Solo l'orologio aspetta: ritorno, rete cambiata, telefono chiedono sempre.
    if (perche === 'orologio' && puoiAspettare()) { programma(); return; }
    // Il telefono sa già che server.url non c'è: niente attesa di due timeout.
    if (piSecondoIlTelefono() === false) { applica(OFFLINE, perche + '/telefono'); programma(); return; }
    stato.inCorso = true;
    stato.ultimaDomanda = adesso();
    var ac = typeof AbortController === 'function' ? new AbortController() : null;
    var t = setTimeout(function () { if (ac) ac.abort(); }, TIMEOUT_MS);
    fetch(base() + '/api/health', { cache: 'no-store', signal: ac ? ac.signal : undefined })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (h) {
          if (h && h.offline) return { offline: true };
          if (!r.ok) throw new Error('HTTP ' + r.status);
          return h;
        });
      })
      .then(function (h) {
        if (h.offline) { stato.fallite = FALLITE_PER_OFFLINE; applica(OFFLINE, perche); return; }
        stato.fallite = 0;
        // Chi ci serve la pagina ha Claude: è il PC (browser del PC).
        stato.serverEPc = !!(h && h.cliAvailable === true);
        applica(PIENA, perche);
      })
      .catch(function () {
        if (stato.fallite === 0) stato.primaFallita = adesso();
        stato.fallite++;
        // [2026-10-07] «OFFLINE» vuol dire «chi serve la pagina non c'è» e
        // conta per il telefono (dal 11/10 la pagina gliela serve il PC, e se
        // tace c'è la copia dell'APK). Sul browser del PC un silenzio è il PC che si
        // riavvia (consegna): la Machine ha già il suo cartello di riavvio, e la
        // scritta «PC not reachable» sarebbe falsa (visto in prova).
        // Idem durante un riavvio annunciato (codice 4100) anche sul telefono.
        var inRiavvio = typeof window.isInRestartMode === 'function' && window.isInRestartMode();
        if (stato.serverEPc || inRiavvio) return;
        if (stato.fallite >= FALLITE_PER_OFFLINE &&
            adesso() - stato.primaFallita >= PAZIENZA_MS) applica(OFFLINE, perche);
      })
      .then(function () { clearTimeout(t); stato.inCorso = false; programma(); });
  }

  window.modalitaAttuale = function () { return stato.modo; };
  window.modalitaControlla = controlla;
  // Il telefono chiama qui quando la rete cambia (VPN, Tailscale, Wi-Fi).
  window.__retePiCambiata = function () { controlla('telefono'); };

  function svegliati() { if (!document.hidden) controlla('ritorno'); }
  document.addEventListener('visibilitychange', svegliati);
  window.addEventListener('online', svegliati);
  window.addEventListener('focus', svegliati);
  try {
    if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Network) {
      window.Capacitor.Plugins.Network.addListener('networkStatusChange', function () { svegliati(); });
    }
  } catch (e) {}

  function avvia() { controlla('avvio'); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', avvia);
  else avvia();
})();
