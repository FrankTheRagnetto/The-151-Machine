/* The 151 Machine — battito.js
 *
 * IL POSTO SOLO dove si scrive un timer periodico che bussa al server.
 * Nato il 2026-09-22 per chiudere un ciclo, non per aggiungere un'astrazione.
 *
 * LA STORIA, perché senza quella questo file sembra burocrazia:
 * il 16/08/2026 un lavoro sulla batteria ha tolto il ping del WebSocket mentre
 * lo schermo è spento — apposta: svegliare la radio ogni 15s tutta la notte, con
 * l'audiolibro acceso, è ciò che teneva il telefono caldo. Quella riparazione ha
 * toccato `ws.js` e basta. Nessuno ha guardato `topbar.js`, che è rimasto lì a
 * bussare a QUATTRO rotte ogni 5 secondi (~48 richieste al minuto) per sempre,
 * anche a schermo spento, anche di notte. Due meccaniche diverse per la stessa
 * cosa: una curata, l'altra no, e nessuno che se ne accorgesse.
 *
 * Quindi: una meccanica sola. Chi vuole un giro periodico che parla col server
 * lo chiede QUI, e dorme col telefono senza doverselo ricordare.
 *
 * COME SI ALLINEA A ws.js (di proposito, non per caso):
 * gli eventi di risveglio sono gli STESSI che usa ws.js (:1777-1808) —
 * `visibilitychange`, `pageshow`, `focus`, `online`, e il `resume` /
 * `appStateChange` di Capacitor. Se un giorno quella lista cambia lì, cambiarla
 * anche qui: sono la stessa decisione scritta due volte perché i due moduli non
 * si toccano (ws.js è oro operativo, non lo si importa da qui).
 *
 * DIFFERENZA con ws.js, voluta: ws.js tiene il suo `setInterval` acceso e
 * ritorna subito quando `document.hidden` (il ping è agganciato al ciclo di vita
 * del socket, non della pagina). Qui invece il timer si SPEGNE davvero e si
 * riarma al ritorno: su Android la WebView congela i timer in pausa, MA NON
 * mentre suona l'audio (MainActivity.onPause salta pauseTimers con audioActive)
 * — ed è esattamente la notte del proprietario, audiolibro acceso. Un timer che non
 * esiste è meglio di un timer che si sveglia per decidere di non fare niente.
 * La guardia `nascosto()` resta comunque DENTRO il giro: cintura e bretelle,
 * nel caso un evento di sonno non arrivi.
 *
 * USO:
 *   var b = window.Battito.ogni('topbar-poll', 5000, pollAll);
 *   b.ferma();      // smette per sempre
 *   b.subito();     // un giro adesso, fuori cadenza (se la pagina è visibile)
 *
 * OPZIONI (tutte facoltative):
 *   subitoAllAvvio  (default true)  un giro appena registrato
 *   subitoAlRitorno (default true)  un giro appena si torna visibili, per non
 *                                   mostrare dati stantii mentre si aspetta il
 *                                   primo tick della cadenza
 *
 * QUANDO **NON** USARE QUESTO MODULO: quando il giro deve girare DAVVERO anche
 * a schermo spento. Esistono casi legittimi (il battito che dice al server «sto
 * dettando, non riavviare» deve continuare col telefono in tasca). In quel caso
 * si lascia il `setInterval` dov'è e lo si DICHIARA nella lista delle eccezioni
 * di tests/timer-a-schermo-spento.test.js, col motivo. Una decisione scritta,
 * non uno strappo silenzioso.
 */
(function () {
  'use strict';

  var battiti = [];

  function nascosto() {
    try {
      return typeof document !== 'undefined' && document.hidden === true;
    } catch (e) {
      return false; // se non si può sapere, si lavora: meglio bussare che morire
    }
  }

  function spegni(b) {
    if (b._id != null) {
      clearInterval(b._id);
      b._id = null;
    }
  }

  function giro(b) {
    b.giri++;
    b.ultimoGiro = Date.now();
    try {
      b.fn();
    } catch (e) {
      // Un giro che esplode non deve portarsi via la cadenza: la barra di stato
      // degrada a «—», non sparisce (stessa promessa di topbar.js).
      b.errori++;
      try { console.warn('[BATTITO] ' + b.nome + ' ha sbagliato un giro:', e); } catch (_) {}
    }
  }

  function arma(b) {
    if (b._morto || b._id != null) return;
    b._id = setInterval(function () {
      // Bretelle: se un evento di sonno non è mai arrivato (WebView strane,
      // Capacitor che non registra i listener), il primo tick a schermo spento
      // si spegne da solo invece di bussare.
      if (nascosto()) { spegni(b); return; }
      giro(b);
    }, b.ms);
  }

  // Tutti a dormire. Nessuna richiesta parte finché non si torna visibili.
  function addormenta() {
    for (var i = 0; i < battiti.length; i++) spegni(battiti[i]);
  }

  // Tutti in piedi. Chi era spento riparte E fa subito un giro, così al ritorno
  // il proprietario non guarda per cinque secondi dei numeri di mezz'ora fa.
  // Nota: chi era GIÀ acceso non viene toccato — è ciò che rende innocuo
  // chiamare questa funzione su `focus`, che su PC scatta di continuo.
  function risveglia() {
    if (nascosto()) return;
    for (var i = 0; i < battiti.length; i++) {
      var b = battiti[i];
      if (b._morto) continue;
      var eraSpento = (b._id == null);
      arma(b);
      if (eraSpento && b.subitoAlRitorno) giro(b);
    }
  }

  function ogni(nome, ms, fn, opzioni) {
    if (typeof fn !== 'function') throw new Error('Battito.ogni: serve una funzione');
    if (!(ms > 0)) throw new Error('Battito.ogni: serve una cadenza in ms > 0');
    var o = opzioni || {};
    var b = {
      nome: String(nome || 'senza-nome'),
      ms: ms,
      fn: fn,
      subitoAlRitorno: o.subitoAlRitorno !== false,
      giri: 0,
      errori: 0,
      ultimoGiro: null,
      _id: null,
      _morto: false,
    };
    battiti.push(b);

    // A schermo acceso si parte subito; a schermo spento non si parte affatto e
    // ci penserà il risveglio. Registrare un battito mentre la pagina è nascosta
    // NON deve produrre una richiesta.
    if (!nascosto()) {
      arma(b);
      if (o.subitoAllAvvio !== false) giro(b);
    }

    return {
      nome: b.nome,
      ms: b.ms,
      ferma: function () { b._morto = true; spegni(b); },
      subito: function () { if (!b._morto && !nascosto()) giro(b); },
      stato: function () {
        return { nome: b.nome, ms: b.ms, acceso: b._id != null, giri: b.giri, errori: b.errori, ultimoGiro: b.ultimoGiro };
      },
    };
  }

  // --- Cablaggio: gli stessi eventi di ws.js:1777-1808 -----------------------
  try {
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) addormenta();
      else risveglia();
    });
  } catch (e) {}
  try {
    // `pageshow` copre il ritorno dalla bfcache, `focus` il rientro su PC,
    // `online` il momento vero in cui la rete torna (sul telefono la radio si
    // sveglia spesso DOPO l'app: vedi la nota in ws.js:1798-1802).
    window.addEventListener('pageshow', risveglia);
    window.addEventListener('focus', risveglia);
    window.addEventListener('online', risveglia);
  } catch (e) {}
  if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App) {
    try {
      window.Capacitor.Plugins.App.addListener('appStateChange', function (state) {
        if (state && state.isActive) risveglia();
        else addormenta();
      });
      window.Capacitor.Plugins.App.addListener('resume', risveglia);
      window.Capacitor.Plugins.App.addListener('pause', addormenta);
    } catch (e) {}
  }

  window.Battito = {
    ogni: ogni,
    risveglia: risveglia,
    addormenta: addormenta,
    // Per la diagnosi dalla console del telefono: `Battito.elenco()` dice chi
    // sta bussando, ogni quanto, e quando ha bussato l'ultima volta.
    elenco: function () {
      return battiti.map(function (b) {
        return { nome: b.nome, ms: b.ms, acceso: b._id != null, giri: b.giri, errori: b.errori, ultimoGiro: b.ultimoGiro };
      });
    },
  };
})();
