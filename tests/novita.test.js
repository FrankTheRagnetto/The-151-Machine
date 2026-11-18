#!/usr/bin/env node
'use strict';
// La finestra delle novità dopo una consegna («un muro di
// testo tecnico», ha dovuto chiudere e riaprire l'app).
// Prova, su un repo git finto in /tmp (nessun dato del proprietario):
//  A. solo le righe «Novità: …» arrivano; i titoli dei commit no;
//  B. il limite alto è il commit SERVITO, non l'HEAD del disco;
//  C. primo giro di un apparecchio: impara, non mostra niente;
//  D. al massimo 3 righe, il resto contato;
//  E. il client ha UN solo punto che mostra la finestra, e ogni tocco la chiude.
// Rossa sulla versione di prima (server/novita.js non esisteva, la rotta
// mandava i titoli dei commit).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
let falliti = 0;
function ok(cond, msg) {
  console.log((cond ? '  ✓ ' : '  ✗ ') + msg);
  if (!cond) falliti++;
}

const novita = require(path.join(ROOT, 'server', 'novita.js'));

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'novita-test-'));
const git = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf-8',
  env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();
function commit(msg) {
  fs.appendFileSync(path.join(dir, 'f.txt'), msg + '\n');
  git('add', 'f.txt');
  git('commit', '-q', '-m', msg);
  return git('rev-parse', 'HEAD');
}

function chiama(handler, since) {
  return new Promise((resolve) => {
    handler({ query: { since } }, { json: resolve });
  });
}

(async () => {
  try {
    git('init', '-q');
    const base = commit('Inizio');
    commit('Gate verde 41/41, refactor di ws.js (12 call site)\n\nNovità: Messages load faster.');
    commit('Pulizia interna senza niente di visibile, prova nuova tests/x.test.js');
    const servito = commit('Tasti più grandi\n\nNovità: Bigger buttons in the chat.\nnovita: The keyboard no longer hides the text.');
    commit('Commit sul disco non ancora consegnato\n\nNovità: NON DEVE COMPARIRE');

    const rotta = novita.creaRotta(dir, servito);

    console.log('A. solo le righe per l\'utente');
    const r = await chiama(rotta, base.slice(0, 7));
    ok(r.head === servito, 'head = commit servito');
    ok(JSON.stringify(r.changes) === JSON.stringify(['Bigger buttons in the chat.', 'The keyboard no longer hides the text.', 'Messages load faster.']),
      'tre righe semplici, dalla più nuova: ' + JSON.stringify(r.changes));
    ok(!r.changes.some((c) => /Gate|41\/41|tests\/|refactor/.test(c)), 'niente titoli di commit, niente gergo');

    console.log('B. limite = commit servito');
    ok(!r.changes.includes('NON DEVE COMPARIRE'), 'il commit non consegnato non compare');

    console.log('C. primo giro e giro già visto');
    ok((await chiama(rotta, '')).changes.length === 0, 'senza since: niente finestra');
    ok((await chiama(rotta, 'rm -rf /')).changes.length === 0, 'since strano: niente finestra');
    ok((await chiama(rotta, servito)).changes.length === 0, 'già visto: niente finestra');

    console.log('D. al massimo 3 righe');
    for (let i = 0; i < 4; i++) commit('x' + i + '\n\nNovità: riga ' + i);
    const testa = git('rev-parse', 'HEAD');
    const r2 = await chiama(novita.creaRotta(dir, testa), servito);
    ok(r2.changes.length === 3 && r2.more === 2, '3 mostrate, 2 contate (' + r2.changes.length + ', more=' + r2.more + ')');
    ok(novita.estraiNovita('Novità: ' + 'a'.repeat(300))[0].length <= 100, 'riga lunga tagliata');

    console.log('E. il client');
    const ws = fs.readFileSync(path.join(ROOT, 'public/js/ws.js'), 'utf-8');
    const init = fs.readFileSync(path.join(ROOT, 'public/js/init.js'), 'utf-8');
    const fetches = (ws + init).match(/\/api\/changelog/g) || [];
    ok(fetches.length === 1, 'un solo punto chiede le novità (' + fetches.length + ')');
    ok(/popup\.onclick\s*=\s*chiudi/.test(ws), 'ogni tocco sulla finestra la chiude');
    const css = fs.readFileSync(path.join(ROOT, 'public/css/main.css'), 'utf-8');
    const card = /\.changelog-card\s*\{[^}]*\}/.exec(css);
    ok(card && /max-height/.test(card[0]) && /overflow-y:\s*auto/.test(card[0]), 'la scheda non esce dallo schermo');
  } catch (e) {
    console.log('  ✗ eccezione: ' + (e && e.stack || e));
    falliti++;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log(falliti ? `ROSSO: ${falliti} falliti` : 'VERDE');
  process.exit(falliti ? 1 : 0);
})();
