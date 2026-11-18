/* The 151 Machine — la casella della password di sudo.
 * Una sessione lancia `sudo` sul PC → il server manda {type:'sudo_chiede'} a
 * ogni schermo → qui la casella. La password va SOLO in POST
 * /api/sudo/rispondi (col gettone) e il campo si svuota subito: non resta
 * nella pagina, non va nel WebSocket, non va a Claude.
 * {type:'sudo_chiuso'} (risposta da un altro schermo, scaduta, annullata)
 * la toglie. Server: server/sudo-telefono.js · Prova: tests/sudo-telefono.test.js
 */
(function () {
  'use strict';
  var aperta = null;          // { id, comando }
  var ultima = null;          // { comando, alle } l'ultima risposta mandata

  function el(tag, cls, testo) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (testo != null) e.textContent = testo;
    return e;
  }
  function togli() {
    var v = document.getElementById('sudo-casella');
    if (v && v.parentNode) v.parentNode.removeChild(v);
    aperta = null;
  }

  function manda(corpo) {
    var h = { 'Content-Type': 'application/json' };
    if (window.authToken) h['Authorization'] = 'Bearer ' + window.authToken;
    var base = typeof window.getServerUrl === 'function' ? (window.getServerUrl() || '') : '';
    return fetch(base + '/api/sudo/rispondi', { method: 'POST', headers: h, body: JSON.stringify(corpo), cache: 'no-store' });
  }

  function mostra(msg) {
    togli();
    aperta = { id: msg.id, comando: msg.comando || '' };
    // Stessa richiesta tornata subito dopo una risposta = password sbagliata.
    var dinuovo = ultima && ultima.comando === aperta.comando && Date.now() - ultima.alle < 15000;

    var velo = el('div', 'sudo-velo'); velo.id = 'sudo-casella';
    var c = el('form', 'sudo-carta');
    c.setAttribute('autocomplete', 'off');
    c.appendChild(el('div', 'sudo-titolo', dinuovo ? 'Wrong password, try again' : 'Password needed'));
    c.appendChild(el('div', 'sudo-sotto', (msg.titolo ? msg.titolo : 'A session') + ' wants to run, as administrator:'));
    c.appendChild(el('code', 'sudo-comando', aperta.comando || 'sudo'));
    var campo = el('input', 'sudo-campo');
    campo.type = 'password';
    campo.setAttribute('autocomplete', 'off');
    campo.setAttribute('autocapitalize', 'off');
    campo.setAttribute('autocorrect', 'off');
    campo.setAttribute('spellcheck', 'false');
    campo.setAttribute('enterkeyhint', 'send');
    campo.setAttribute('aria-label', 'Your PC password');
    campo.placeholder = 'Your PC password';
    c.appendChild(campo);
    var riga = el('div', 'sudo-bottoni');
    var no = el('button', 'sudo-no', 'Cancel'); no.type = 'button';
    var si = el('button', 'sudo-si', 'Run'); si.type = 'submit';
    riga.appendChild(no); riga.appendChild(si);
    c.appendChild(riga);
    var stato = el('div', 'sudo-stato'); c.appendChild(stato);
    velo.appendChild(c);
    document.body.appendChild(velo);
    setTimeout(function () { try { campo.focus(); } catch (e) {} }, 50);

    var id = aperta.id, comando = aperta.comando;
    function finisci(corpo) {
      si.disabled = no.disabled = true;
      stato.textContent = corpo.annulla ? 'Cancelling…' : 'Sending…';
      manda(corpo).then(function (r) {
        if (r.ok || r.status === 404) { togli(); return; }
        si.disabled = no.disabled = false;
        stato.textContent = 'Not sent (' + r.status + '). Try again.';
      }).catch(function () {
        si.disabled = no.disabled = false;
        stato.textContent = 'PC not reachable. Try again.';
      });
    }
    c.addEventListener('submit', function (e) {
      e.preventDefault();
      var pw = campo.value;
      campo.value = '';                       // non resta nella pagina
      if (!pw) { stato.textContent = 'Type the password first.'; return; }
      ultima = { comando: comando, alle: Date.now() };
      finisci({ id: id, password: pw });
      pw = null;
    });
    no.addEventListener('click', function () { campo.value = ''; ultima = null; finisci({ id: id, annulla: true }); });
  }

  window.sudoTelefono = function (msg) {
    if (!msg || !msg.id) return;
    if (msg.type === 'sudo_chiede') mostra(msg);
    else if (msg.type === 'sudo_chiuso' && aperta && aperta.id === msg.id) togli();
  };
})();
