/* The 151 Machine — cosa è «per il proprietario» e quindi non va mai nella tendina
 * «▶ Passaggi» (2026-10-09). Un posto solo, usato dal server (risposte nuove,
 * server/stream-handler.js) e dalla chat (risposte GIÀ salvate divise, in
 * cronologia e nella copia del telefono: core.js e ws.js).
 *
 * il proprietario: «tutto ciò che la sessione scrive per me (domande, prompt da
 * incollare, istruzioni) deve stare fuori dalla tendina, sempre». Caso vero:
 * 09/10 ore 9:16 — risposta col prompt da incollare finita nei
 * Passaggi. Il collaudo delle 9:47 ha mostrato che la sola regola del server
 * non bastava: quella risposta era già salvata divisa in cronologia.
 *
 * Per il proprietario = blocco di codice (un prompt), domanda, elenco, bottoni A/B, firma
 * della squadra in testa («☀️ Writer 117 —») o testo lungo. Nel dubbio resta
 * visibile. Nella tendina resta il parlare-da-solo breve: «Controllo il server.»
 *
 * Prove: tests/tendina-per-utente.test.js
 */
(function (root) {
  'use strict';

  var LUNGO = 400;
  var FIRMA = /^\p{Extended_Pictographic}[^\n]{0,40}\s—\s/u;

  function perNico(seg) {
    var t = String(seg == null ? '' : seg).trim();
    if (!t) return false;
    if (t.length > LUNGO) return true;
    if (/\x60\x60\x60|~~~/.test(t)) return true;
    if (/\?(\s|$)/.test(t)) return true;
    if (/^[ \t]*(?:[-*•]|\d{1,2}[.)]|[A-Z]\))\s+\S/m.test(t)) return true;
    if (t.indexOf('<' + 'options>') !== -1) return true;
    if (FIRMA.test(t)) return true;
    return false;
  }

  // Risposta + passaggi → i passaggi «per il proprietario» tornano nella risposta, prima
  // di lei e nell'ordine in cui sono stati scritti; nella tendina resta il resto.
  // Idempotente: su una risposta già sistemata non cambia niente.
  function ripiega(content, steps) {
    var testo = content == null ? '' : String(content);
    if (!Array.isArray(steps) || !steps.length) return { content: testo, steps: steps || [] };
    var fuori = [], dentro = [];
    for (var i = 0; i < steps.length; i++) (perNico(steps[i]) ? fuori : dentro).push(steps[i]);
    if (!fuori.length) return { content: testo, steps: dentro };
    var pezzi = fuori.map(function (s) { return String(s).trim(); });
    if (testo.trim()) pezzi.push(testo.trim());
    return { content: pezzi.join('\n\n---\n\n'), steps: dentro };
  }

  var api = { perNico: perNico, ripiega: ripiega };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.PerNico = api;
})(typeof window !== 'undefined' ? window : null);
