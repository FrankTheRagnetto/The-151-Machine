/* The 151 Machine — il pezzo dei bottoni A/B (2026-10-09).
 *
 * Una risposta può finire con un blocco <options><option>…</option></options>:
 * la chat lo toglie dal testo e ne fa dei bottoni. Prima lo toglieva con una
 * regex cieca su TUTTO il testo, anche dentro un blocco di codice o in mezzo a
 * una frase: oggi (09/10) ha mangiato un pezzo di un prompt e,
 * peggio, tutto il report del Machine da «Se una risposta nominasse» in giù
 * (una citazione in mezzo al testo + il vero blocco in fondo = sparito tutto
 * quello che stava fra i due, anche dal tasto Copia).
 *
 * Regola del proprietario: si toglie e diventa bottoni SOLO il vero pezzo finale —
 * su righe sue, fuori dai blocchi di codice, fatto solo di <option>. Citato
 * dentro un blocco di codice o in mezzo al testo resta visibile così com'è,
 * anche nel tasto Copia. Un pezzo aperto e mai chiuso non nasconde niente.
 *
 * Prova: tests/pezzo-bottoni.test.js
 */
(function (root) {
  'use strict';

  // Il vero pezzo: comincia a inizio riga, finisce a fine riga, dentro solo
  // <option>…</option> e spazi. [^<]* impedisce che un'apertura orfana più su
  // si mangi il testo fino alla chiusura del pezzo vero.
  var VERO = /^[ \t]*<options>((?:\s*<option>[^<]*<\/option>)+)\s*<\/options>[ \t]*$/gm;
  var FENCE = /^ {0,3}(\x60{3,}|~{3,})/; // \x60 = accento grave

  // Intervalli [inizio, fine) dei blocchi di codice recintati (tre accenti gravi o tre tilde).
  function recinti(src) {
    var out = [], pos = 0, aperto = null, start = 0;
    var righe = src.split('\n');
    for (var i = 0; i < righe.length; i++) {
      var m = FENCE.exec(righe[i]);
      if (m) {
        if (!aperto) { aperto = m[1].charAt(0); start = pos; }
        else if (m[1].charAt(0) === aperto) { out.push([start, pos + righe[i].length]); aperto = null; }
      }
      pos += righe[i].length + 1;
    }
    if (aperto) out.push([start, src.length]); // recinto mai chiuso: codice fino in fondo
    return out;
  }
  function dentro(r, a, b) {
    for (var i = 0; i < r.length; i++) if (a >= r[i][0] && b <= r[i][1]) return true;
    return false;
  }

  // → { body, options }: body = testo senza il vero pezzo (se c'è), options =
  // le etichette dei bottoni. Senza vero pezzo il testo torna identico.
  function separa(text, opts) {
    var src = text == null ? '' : String(text);
    var r = recinti(src), last = null, m;
    VERO.lastIndex = 0;
    while ((m = VERO.exec(src)) !== null) {
      if (!dentro(r, m.index, m.index + m[0].length)) last = { a: m.index, b: m.index + m[0].length, inner: m[1] };
    }
    var body = src, options = [];
    if (last) {
      var re = /<option>([^<]*)<\/option>/g, o;
      while ((o = re.exec(last.inner)) !== null) { var v = o[1].trim(); if (v) options.push(v); }
      body = src.slice(0, last.a) + src.slice(last.b);
    } else if (opts && opts.inDiretta) {
      // Mentre arriva: un pezzo finale aperto in fondo (fuori dal codice) non
      // si mostra a metà — fra un attimo diventa bottoni. Solo in diretta.
      var aperta = /(^|\n)[ \t]*<options>(?:\s*<option>[^<]*(?:<\/option>)?)*\s*$/.exec(src);
      if (aperta && !dentro(r, aperta.index, src.length)) body = src.slice(0, aperta.index);
    }
    return { body: body.trim(), options: options };
  }

  // Le citazioni rimaste (fuori dal codice) si mostrano così come sono:
  // senza questo, DOMPurify toglierebbe i segni lasciando solo il dentro.
  // Dentro il codice non serve (marked le scappa da sé) e non si tocca.
  function mostraCitazioni(text) {
    var src = text == null ? '' : String(text);
    if (src.indexOf('<option') === -1 && src.indexOf('</option') === -1) return src;
    var r = recinti(src), out = '', pos = 0;
    var righe = src.split('\n');
    for (var i = 0; i < righe.length; i++) {
      var riga = righe[i];
      if (dentro(r, pos, pos + riga.length)) out += riga;
      else {
        // fuori dal recinto: salta i pezzi di codice in riga (fra accenti gravi)
        out += riga.split(/(\x60+[^\x60]*\x60+)/).map(function (p) {
          return /^\x60/.test(p) ? p : p.replace(/<(\/?)(options?)>/g, '&lt;$1$2&gt;');
        }).join('');
      }
      if (i < righe.length - 1) out += '\n';
      pos += riga.length + 1;
    }
    return out;
  }

  var api = { separa: separa, mostraCitazioni: mostraCitazioni };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.PezzoBottoni = api;
})(typeof window !== 'undefined' ? window : null);
