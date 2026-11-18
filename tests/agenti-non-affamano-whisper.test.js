'use strict';
// [08/11/2026] — «per la prima volta da mesi un vocale non si è trascritto»
//. Causa misurata: alle 13:10:00 la sessione Manga (e47f2467)
// lancia un OCR con 16 tesseract in parallelo (load average 66 su 16 core),
// tutti a nice 0 come whisper-stt, che gira SOLO su CPU (WHISPER_FORCE_CPU).
// whisper: un vocale di 45 s da ~2 s a 390 s (13:10:48→13:17:18); quello di
// 6:56 delle 13:44 ancora in corso dopo 8 minuti; il telefono ha mollato
// («CONSEGNA PERSA» 13:52:24). Cura: il CLI di ogni sessione nasce con
// `nice -n 10`, e così tutto ciò che lancia (Bash, aiutanti, tesseract…):
// il lavoro degli agenti non può più affamare la voce del proprietario.
// Prova: (A) il motore passa all'SDK un modo di avviare il CLI; (B) quel modo
// avvia con nice 10, e un nipote lanciato dal processo lo eredita (misurato
// in /proc); (C) l'errore del CLI arriva ancora nel registro.
const assert = require('assert');
const fs = require('fs');
const eng = require('../server/sdk-engine');

let ok = 0; const falliti = [];
function check(c, l) { if (c) { ok++; console.log('  ok  ' + l); } else { falliti.push(l); console.log('  NO  ' + l); } }
function fine() {
  if (falliti.length) { console.error(`agenti-non-affamano-whisper: ${falliti.length} FALLITI, ${ok} OK`); process.exit(1); }
  console.log(`agenti-non-affamano-whisper: ${ok} controlli OK`);
}
const niceDi = (pid) => {
  const st = fs.readFileSync('/proc/' + pid + '/stat', 'utf8');
  return parseInt(st.slice(st.lastIndexOf(')') + 2).split(' ')[16], 10); // campo 19: nice
};

(async () => {
  // (A) SdkSession._start dà all'SDK spawnClaudeCodeProcess -------------------
  let opzioni = null;
  if (typeof eng._setSdkPerProva === 'function') {
    eng._setSdkPerProva({ query: ({ options }) => { opzioni = options; return { [Symbol.asyncIterator]: async function* () {} }; } });
    const finta = { sessionId: 'wwwwwwww-test', cwd: '/tmp', model: null, appendSystemPrompt: null,
      _aborter: new AbortController(), _input: { gen: null }, _consume() {}, _teardown() {} };
    await eng.SdkSession.prototype._start.call(finta, null);
  }
  check(!!opzioni && typeof opzioni.spawnClaudeCodeProcess === 'function',
    '(A) il motore avvia il CLI da sé (spawnClaudeCodeProcess), non col default a nice 0');

  // (B) nice 10 sul CLI e sui suoi figli -------------------------------------
  const avvia = eng.spawnAgente;
  check(typeof avvia === 'function', '(B) spawnAgente esiste');
  if (typeof avvia !== 'function') return fine();
  const righe = [];
  const ac = new AbortController();
  // Il «CLI» finto: stampa il suo pid, lancia un nipote che stampa il suo, scrive su stderr.
  const figlio = avvia({ command: 'bash', args: ['-c', 'echo $$; sh -c \'echo $$; sleep 1\'; echo ERRORE-DI-PROVA >&2'],
    cwd: '/tmp', env: process.env, signal: ac.signal }, (t) => righe.push(t));
  let out = '';
  figlio.stdout.on('data', (d) => { out += d; });
  await new Promise((r) => setTimeout(r, 400));
  const pids = out.trim().split('\n').map(Number).filter(Boolean);
  check(pids.length === 2, '(B) CLI e nipote partiti: ' + JSON.stringify(pids));
  const niceProprio = niceDi(process.pid);
  // il kernel ferma nice a 19: un cancello lanciato da una sessione (già a nice 10) vede 19, non 20 (10/11)
  const atteso = Math.min(19, niceProprio + 10);
  if (pids.length === 2) {
    check(niceDi(pids[0]) === atteso, '(B) il CLI gira a nice +10 (' + niceDi(pids[0]) + ')');
    check(niceDi(pids[1]) === atteso, '(B) il lavoro che lancia (nipote) eredita nice +10 (' + niceDi(pids[1]) + ')');
  }
  await new Promise((r) => figlio.once('exit', r));
  check(righe.join('').includes('ERRORE-DI-PROVA'), '(C) lo stderr del CLI arriva al registro');
  check(figlio.stdin && typeof figlio.kill === 'function', '(C) ha stdin e kill come vuole l\'SDK');
  fine();
})().catch((e) => { console.error(e); process.exit(1); });
