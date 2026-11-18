'use strict';
// [2026-10-09] Il pezzo dei bottoni A/B si toglie (e diventa bottoni) solo
// quando è il VERO pezzo finale: su righe sue, fuori dal codice. Citato nel
// codice o nel testo resta visibile, anche nel tasto Copia; un pezzo aperto e
// mai chiuso non nasconde niente. Casi veri di oggi in
// tests/fixtures/esempi. Prova PURA (niente server).
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const P = require('../public/js/pezzo-bottoni.js');
const mk = (() => { const m = require('../public/marked.min.js'); return m.marked || m; })();
mk.use({ breaks: true, gfm: true });
let ok = 0;
const check = (c, l) => { assert.ok(c, l); ok++; };
const F = (n) => fs.readFileSync(path.join(__dirname, 'fixtures', 'esempi', n), 'utf8');
const APRE = '<' + 'options>', CHIUDE = '</' + 'options>';
const opt = (t) => '<option>' + t + '</option>';
const html = (t) => mk.parse(P.mostraCitazioni(t));

// (1) Il prompt delle 9:25: il pezzo è citato dentro un blocco di
// codice. Oggi la chat lo toglieva e a me è arrivato «il pezzo con ), oppure».
{
  const src = F('0925-prompt-citato.md');
  const r = P.separa(src);
  check(r.options.length === 0, '(1) niente bottoni da una citazione');
  check(r.body === src.trim(), '(1) il testo (quindi anche il tasto Copia) resta identico');
  check(r.body.includes('il pezzo con ' + APRE + '…' + CHIUDE + ')'), '(1) la citazione c\'è parola per parola');
  check(html(r.body).includes('il pezzo con &lt;options&gt;…&lt;/options&gt;)'), '(1) e si vede nel blocco di codice');
}
// (2) Il report del Machine delle 9:30: citazioni in mezzo al testo + il vero
// pezzo in fondo. Oggi spariva tutto da «Se una risposta nominasse» in giù.
{
  const src = F('0930-report-machine.md');
  const r = P.separa(src);
  check(r.options.length === 3 && r.options[0] === 'Ripara il filtro dei bottoni + tracciante', '(2) i tre bottoni veri: ' + JSON.stringify(r.options));
  check(r.body.includes('Se una risposta nominasse'), '(2) la frase tagliata c\'è');
  check(r.body.includes('**Riparazione che propongo') && r.body.includes('Sessioni: TIENI questa'), '(2) e tutto quello che veniva dopo');
  check(!r.body.includes(opt('Per ora niente')), '(2) il vero pezzo non resta nel testo');
  const h = html(r.body);
  check(h.includes('nominasse <code>&lt;options&gt;</code> all&#39;inizio'), '(2) la citazione inline si vede com\'è');
}
// (3) Il messaggio vero delle 9:23 coi bottoni A/B in fondo: funziona come prima.
{
  const src = F('0923-bottoni-veri.md');
  const r = P.separa(src);
  check(r.options.length === 2 && r.options[1] === 'B) Chiudi questo, passiamo al prossimo', '(3) due bottoni');
  check(!r.body.includes(APRE) && r.body.endsWith('le altre cose d\'aspetto.'), '(3) testo pulito, finisce dov\'era');
}
// (4) Il messaggio delle 7 scelte (9:22): nessun pezzo, testo identico.
{
  const src = F('0922-sette-scelte.md');
  const r = P.separa(src);
  check(r.body === src.trim() && r.options.length === 0, '(4) le 7 scelte intatte');
}
// (5) Un pezzo aperto e mai chiuso non fa sparire il resto.
{
  const src = 'Prima riga.\n' + APRE + '\nIn mezzo, importante.\n\nFine con la domanda: A o B?';
  const r = P.separa(src);
  check(r.body === src && r.options.length === 0, '(5) aperto e mai chiuso: testo identico');
  check(html(r.body).includes('In mezzo, importante.') && html(r.body).includes('&lt;options&gt;'), '(5) e si vede tutto');
}
// (6) Un'apertura orfana più su + il vero pezzo in fondo: sparisce solo il pezzo.
{
  const src = 'Il segno ' + APRE + ' si scrive così.\n\nTesto importante.\n\n' + APRE + opt('Sì') + opt('No') + CHIUDE;
  const r = P.separa(src);
  check(r.options.join('|') === 'Sì|No' && r.body.includes('Testo importante.') && r.body.includes('Il segno ' + APRE), '(6) l\'orfana non si mangia il testo');
}
// (7) Il pezzo dentro un blocco di codice IN FONDO: resta codice.
{
  const src = 'Esempio:\n```\n' + APRE + opt('A') + CHIUDE + '\n```';
  const r = P.separa(src);
  check(r.options.length === 0 && r.body === src, '(7) dentro il codice non è un pezzo vero');
}
// (8) Righe dopo il vero pezzo (succede: «Sessioni: …»): il pezzo si toglie, le righe restano.
{
  const src = 'Scegli.\n\n' + APRE + opt('A') + opt('B') + CHIUDE + '\n\nSessioni: TIENI questa.';
  const r = P.separa(src);
  check(r.options.length === 2 && r.body === 'Scegli.\n\n\n\nSessioni: TIENI questa.', '(8) ' + JSON.stringify(r.body));
}
// (9) In diretta: un pezzo finale ancora aperto non si mostra a metà…
{
  const r = P.separa('Scegli.\n\n' + APRE + '<option>A', { inDiretta: true });
  check(r.body === 'Scegli.', '(9) in diretta il pezzo a metà resta nascosto');
  // …ma solo in fondo, e mai dentro il codice.
  const r2 = P.separa('Codice:\n```\n' + APRE, { inDiretta: true });
  check(r2.body.endsWith(APRE), '(9) dentro un codice aperto non si taglia');
}
// (10) La chat usa davvero questo modulo, in tutti i punti, e lo carica prima.
{
  const chat = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'chat.js'), 'utf8');
  check(!/replace\(\/<options>/.test(chat), '(10) chat.js non ha più il taglio cieco');
  check((chat.match(/PezzoBottoni\.separa\(/g) || []).length >= 3, '(10) bolla, diretta, fine-diretta passano dal modulo');
  check(!/&lt;options&gt;/.test(chat.replace(/\/\/.*$/gm, '')), '(10) niente più pulizia che cancella le citazioni visibili');
  const idx = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  check(idx.indexOf('js/pezzo-bottoni.js') > -1 && idx.indexOf('js/pezzo-bottoni.js') < idx.indexOf('js/chat.js'), '(10) caricato prima di chat.js');
  const sw = fs.readFileSync(path.join(__dirname, '..', 'public', 'sw.js'), 'utf8');
  check(sw.includes("'/js/pezzo-bottoni.js'"), '(10) nel guscio offline');
}
console.log(`pezzo-bottoni: ${ok} controlli verdi`);
