'use strict';
// [10/11/2026 ] Dettatura, «Invia mentre registri»: il vocale si
// trascrive e parte da solo nella sessione dove la presa è cominciata, anche
// se il proprietario è già uscito dalla sessione o ha chiuso l'app.
//
// Per questo la consegna vive QUI, sul server, e non sul telefono: il telefono
// carica l'audio, riceve «accettata» (202) e ha finito. Il resto — whisper, il
// messaggio nella sessione — succede anche a telefono spento.
//
// Una volta sola: ogni clip ha un id; il messaggio porta il nonce
// `dict-<clipId>`, lo stesso registro dei messaggi scritti (ricostruito dalla
// storia a ogni avvio del server). Un secondo caricamento della stessa clip
// (ritento, app riaperta che ricarica la copia salvata) non manda un doppione:
// clip in volo → si aspetta quella; clip già fatta → il nonce la ferma.
//
// Prova: tests/dettatura-invia.test.js.

function nonceDi(clipId) { return 'dict-' + clipId; }

// Testo già scritto nel campo + quello dettato, come se il proprietario l'avesse scritto.
function unisci(prefisso, testo) {
  const a = String(prefisso || '').trim();
  const b = String(testo || '').trim();
  if (a && b) return a + ' ' + b;
  return a || b;
}

function createInvioDettatura(deps) {
  const {
    trascrivi,         // async (file, lingua) => { ok, text, error }
    leggiRisultato,    // (clipId) => { text, ... } | null
    scriviRisultato,   // (clipId, text, extra) => bool
    consegna,          // (sessionId, contenuto, nonce) => 'mandato'|'in-attesa'|'doppione'|'sessione-sparita'|'errore'
    conservaClip,      // (file) => percorso salvato | null   (whisper fallito: l'audio resta)
    rimuovi,           // (file) => void
    prontezza,         // { beginTranscribe, endTranscribe } — un riavvio aspetta
    log = (...a) => console.log('[dictation]', ...a),
  } = deps;

  const inVolo = new Map(); // clipId → Promise del lavoro

  function manda(clipId, sessionId, prefisso, testo) {
    const contenuto = unisci(prefisso, testo);
    if (!contenuto) { log('invia clipId=' + clipId + ' testo vuoto: niente da mandare'); return 'vuoto'; }
    const esito = consegna(sessionId, contenuto, nonceDi(clipId));
    log('invia clipId=' + clipId + ' sessione=' + String(sessionId).slice(0, 8) + ' esito=' + esito + ' chars=' + contenuto.length);
    return esito;
  }

  // Ritorna subito; il lavoro (se c'è) continua da solo.
  //   { stato: 'accettata', fine }  → whisper parte adesso
  //   { stato: 'in-volo', fine }    → la stessa clip sta già girando
  //   { stato: 'fatta', esito }     → trascritta prima: si (ri)manda, il nonce ferma il doppione
  function accetta({ clipId, sessionId, prefisso, file, lingua }) {
    if (inVolo.has(clipId)) {
      rimuovi(file);
      return { stato: 'in-volo', fine: inVolo.get(clipId) };
    }
    const fatta = leggiRisultato(clipId);
    if (fatta) {
      rimuovi(file);
      const esito = manda(clipId, sessionId, fatta.prefisso != null ? fatta.prefisso : prefisso, fatta.text);
      return { stato: 'fatta', esito };
    }
    prontezza.beginTranscribe();
    const fine = (async () => {
      try {
        const r = await trascrivi(file, lingua || 'auto');
        if (!r || !r.ok) {
          const salvata = conservaClip(file);
          log('invia clipId=' + clipId + ' whisper fallito (' + ((r && r.error) || '?') + ') — clip in ' + (salvata || file));
          return 'whisper-fallito';
        }
        // Prima il messaggio, poi il risultato: se il server cade nel mezzo, il
        // telefono non vede «fatta» e ricarica la clip; il nonce ferma il doppione.
        const esito = manda(clipId, sessionId, prefisso, r.text || '');
        scriviRisultato(clipId, r.text || '', { sessionId, prefisso: prefisso || '', esito });
        rimuovi(file);
        return esito;
      } catch (e) {
        const salvata = conservaClip(file);
        log('invia clipId=' + clipId + ' errore (' + (e && e.message) + ') — clip in ' + (salvata || file));
        return 'errore';
      } finally {
        inVolo.delete(clipId);
        prontezza.endTranscribe();
      }
    })();
    inVolo.set(clipId, fine);
    return { stato: 'accettata', fine };
  }

  return { accetta, inVolo: (id) => inVolo.has(id) };
}

module.exports = { createInvioDettatura, unisci, nonceDi };
