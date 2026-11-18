/* The 151 Machine — schermo-spento.js (10/11/2026, batteria )
 *
 * Il telefono in tasca non riceve i pezzi della risposta.
 *
 * IL GUASTO: sendToSession mandava ogni pezzo (delta, thinking, tool_*) anche
 * al socket di un telefono che ha detto «schermo spento» (ws.isHidden, messaggio
 * `visibility` dell'app, server/ws-handler.js). Una risposta lunga = centinaia di
 * risvegli della radio con il telefono in tasca, per disegnare una bolla che
 * nessuno guarda.
 *
 * LA CURA: al socket nascosto arrivano solo i messaggi che servono a qualcosa
 * fuori dallo schermo — `done` (porta fullResponse e steps: la risposta intera,
 * e la notifica «risposta pronta» parte da lì), `error`, permessi, stato delle
 * sessioni (broadcastSessionStatus, che non passa di qui) e tutto ciò che non
 * è in SOLO_A_SCHERMO. I pezzi tenuti indietro sono nel registro dei pezzi
 * (server/stream-log.js, DETACHED_RUNS) e tornano col `replay` di
 * get_stream_state al ritorno.
 *
 * PERCHÉ NON SI PERDE TESTO — tre condizioni, tutte necessarie:
 *  1. Solo con DETACHED_RUNS acceso e solo pezzi con `_seq` numerico: cioè
 *     registrati, cioè ripetibili. Senza registro non si trattiene niente.
 *  2. Al socket nascosto non arriva NESSUN pezzo con `_seq` della sessione
 *     tranne quelli terminali. Il client tiene come lastSeq il più alto visto
 *     (window._noteSeq a ogni messaggio, public/js/ws.js): se gli arrivasse uno
 *     `status` col numero 40 dopo aver saltato i delta 1-39, al ritorno
 *     chiederebbe «dal 40» e i delta 1-39 sparirebbero. Per questo anche
 *     `status` e `model_info` (registrati anche loro) stanno in SOLO_A_SCHERMO.
 *  3. Al ritorno il socket resta «in sospeso» per quella sessione finché non
 *     chiede get_stream_state: un pezzo nuovo arrivato fra il «visibility
 *     false» e la richiesta avrebbe un numero più alto dei pezzi saltati, il
 *     client lo segnerebbe come applicato e scarterebbe il replay (gate di
 *     _alreadyApplied). Il client manda i due messaggi uno dietro l'altro
 *     (wsOnResume); se la richiesta non arriva entro LIBERA_DOPO_MS si libera
 *     comunque (la risposta finale arriva intera col `done`).
 *  Un `done`/`error` consegnato chiude il sospeso: la risposta è intera nel
 *  `done`, la storia dal server è la verità.
 *
 * Prova: tests/schermo-spento.test.js
 */
'use strict';

// Tutti i tipi registrati da stream-log (LOGGABLE) tranne i terminali.
const SOLO_A_SCHERMO = new Set([
  'delta', 'thinking', 'thinking_start',
  'tool_start', 'tool_use', 'tool_progress', 'tool_done',
  'status', 'model_info',
]);
const TERMINALI = new Set(['done', 'error']);
const LIBERA_DOPO_MS = 10000;

function attivo() { return !!process.env.DETACHED_RUNS; }

/** true = questo messaggio NON va a questo socket adesso (tornerà col replay). */
function trattieni(sock, sessionId, data, ora) {
  if (!attivo() || !sock || !data || typeof data !== 'object') return false;
  const sospesi = sock._151Sospesi;
  if (TERMINALI.has(data.type)) {
    if (sospesi) sospesi.delete(sessionId);
    return false;
  }
  if (typeof data._seq !== 'number' || !SOLO_A_SCHERMO.has(data.type)) return false;
  if (sock.isHidden) {
    if (!sospesi) sock._151Sospesi = new Set();
    sock._151Sospesi.add(sessionId);
    return true;
  }
  if (sospesi && sospesi.has(sessionId)) {
    const t = typeof ora === 'number' ? ora : Date.now();
    if (sock._151VisibileDa && t - sock._151VisibileDa > LIBERA_DOPO_MS) {
      sospesi.delete(sessionId);
      return false;
    }
    return true;
  }
  return false;
}

/** Dal gestore `visibility`: il socket è tornato visibile adesso. */
function tornatoVisibile(sock, ora) {
  if (sock) sock._151VisibileDa = typeof ora === 'number' ? ora : Date.now();
}

/** Da get_stream_state, PRIMA di mandare il replay: da qui in poi tutto dal vivo. */
function libera(sock, sessionId) {
  if (sock && sock._151Sospesi) sock._151Sospesi.delete(sessionId);
}

module.exports = { trattieni, tornatoVisibile, libera, SOLO_A_SCHERMO, LIBERA_DOPO_MS };
