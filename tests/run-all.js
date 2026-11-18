#!/usr/bin/env node
'use strict';

// =============================================================================
// ENTRY POINT CANONICO DEI TEST — the-151-machine
// (P1 anti-regressione, 2026-08-28. Prima: package.json:11 lanciava SOLO
//  tests/smoke.js, 1 file su 20. "Quale runner" era una scelta di sessione:
//  ogni "N/N verdi" valeva quanto la scelta di chi lo scriveva.)
//
// REGOLA: questo file NON ha una lista di test. Scopre da solo OGNI file in
// tests/ (esclusi se stesso e i non-eseguibili). Un test nuovo entra nella
// suite da solo, senza che nessuno se ne ricordi.
//
// Uso:  npm test            → tutto
//       node tests/run-all.js --pure   → solo i puri (nessun server vivo)
//       node tests/run-all.js --list   → censimento, non esegue nulla
//
// Uscita: 0 solo se OGNI test non-in-quarantena è verde.
// =============================================================================

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TESTS_DIR = __dirname;
const BASE = process.env.TEST_HOST || 'http://127.0.0.1:3170';

// File in tests/ che NON sono test.
const NOT_A_TEST = new Set(['run-all.js']);

// ---------------------------------------------------------------------------
// LIVE — hanno bisogno di un server ACCESO su TEST_HOST.
// Non è una scorciatoia: se il server è spento questi FALLISCONO (rosso), non
// vengono saltati. Provano il SERVITO — e COSA sia il servito dipende dal
// bersaglio: la 3170 è il processo del proprietario (codice del suo ultimo avvio, non il
// diff), mentre il cancello dal 12/09/2026 li punta a un'istanza usa-e-getta
// accesa sul working tree, dove il servito È il diff (tools/gate-istanza.sh).
// ---------------------------------------------------------------------------
const LIVE = new Set(['smoke.js']);

// ---------------------------------------------------------------------------
// QUARANTENA — test rotti per un motivo NOTO e scritto qui, con la data.
// Girano lo stesso (così si vede il giorno che tornano verdi) ma non bloccano
// il commit. Aggiungere una voce qui è un atto esplicito e visibile: la lista
// viene stampata a ogni giro, in grande. Non è un "skip" silenzioso.
//
// LA QUARANTENA HA UNA SCADENZA (P5 del 12/09/2026).
// Fino a oggi aveva una DATA D'INIZIO e nient'altro: race-test.js era in
// quarantena dal 28/08 e il 12/09 era ancora rossa, cioè la quarantena era
// diventata una cancellazione con un'altra parola. Un riparo che non scade da
// solo non è un riparo — quindi la regola è:
//
//   · ogni voce porta MOTIVO, `dal` e `scadenza`. Senza scadenza non esiste.
//   · alla scadenza la RICHIUSURA è AUTOMATICA: il test torna BLOCCANTE da
//     solo, senza che nessuno debba ricordarsene. Nessun umano nel ciclo.
//   · una `scadenza` assente o illeggibile vale SCADUTA, non "per sempre":
//     un registro che non si capisce non protegge.
//   · prorogare è un atto visibile — si cambia una data in un file tracciato,
//     e la riga finisce nel diff che il proprietario legge.
// ---------------------------------------------------------------------------
const QUARANTINE = {
  // Vuota dal 12/10/2026. L'ultima voce, race-test.js (dal 28/08, scadenza
  // 30/09), è uscita: il 22/09 il test è stato riscritto come prova PURA sul
  // trasporto TCP di oggi (68bfc7d, 25 controlli verdi) e non ha più niente da
  // cui essere riparato. Ogni voce nuova: chiave = nome del file del test,
  // valore = { dal, scadenza, motivo } (tutti e tre obbligatori).
};

// Scaduta ⇒ il riparo non vale più e il test è bloccante come tutti gli altri.
// Si confronta con la FINE del giorno di scadenza: «scadenza 2026-09-30»
// significa che il 30 settembre il riparo c'è ancora, il 1 ottobre no.
function quarantenaScaduta(voce) {
  if (!voce || !voce.scadenza) return true;
  const t = Date.parse(String(voce.scadenza) + 'T23:59:59');
  if (Number.isNaN(t)) return true;
  return Date.now() > t;
}

// Il riparo vale SOLO se la voce esiste ED è ancora in corso.
function inQuarantena(file) {
  const v = QUARANTINE[file];
  return Boolean(v) && !quarantenaScaduta(v);
}

function giorniAllaScadenza(voce) {
  const t = Date.parse(String(voce.scadenza) + 'T23:59:59');
  if (Number.isNaN(t)) return null;
  return Math.ceil((t - Date.now()) / 86400000);
}

// Timeout per test (ms). Generoso ma finito: un test che pende non deve
// bloccare il cancello per sempre.
const TIMEOUT_MS = Number(process.env.TEST_TIMEOUT_MS || 120000);

// ---------------------------------------------------------------------------

function discover() {
  return fs.readdirSync(TESTS_DIR)
    .filter((f) => !NOT_A_TEST.has(f))
    .filter((f) => /\.(js|sh)$/.test(f))
    .filter((f) => fs.statSync(path.join(TESTS_DIR, f)).isFile())
    .sort();
}

function runOne(file) {
  const full = path.join(TESTS_DIR, file);
  const isShell = file.endsWith('.sh');
  const cmd = isShell ? 'bash' : process.execPath;
  const started = Date.now();
  const res = spawnSync(cmd, [full], {
    cwd: ROOT,
    timeout: TIMEOUT_MS,
    encoding: 'utf8',
    env: { ...process.env, TEST_HOST: BASE },
    maxBuffer: 32 * 1024 * 1024,
  });
  return {
    file,
    ms: Date.now() - started,
    code: res.status,
    timedOut: res.error && res.error.code === 'ETIMEDOUT',
    stdout: res.stdout || '',
    stderr: res.stderr || '',
    spawnError: res.error && res.error.code !== 'ETIMEDOUT' ? res.error.message : null,
  };
}

function lastLines(s, n) {
  return s.split('\n').filter((l) => l.trim()).slice(-n).map((l) => '        ' + l).join('\n');
}

function main() {
  const args = process.argv.slice(2);
  const onlyPure = args.includes('--pure');
  const listOnly = args.includes('--list');

  const files = discover();

  if (listOnly) {
    console.log(`CENSIMENTO — ${files.length} file in tests/\n`);
    for (const f of files) {
      const kind = inQuarantena(f) ? 'QUARANTENA'
        : QUARANTINE[f] ? 'QUAR-SCADUTA'
        : LIVE.has(f) ? 'LIVE' : 'PURO';
      console.log(`  ${kind.padEnd(11)} ${f}`);
    }
    return 0;
  }

  const toRun = onlyPure ? files.filter((f) => !LIVE.has(f)) : files;

  console.log('════════════════════════════════════════════════════════════');
  console.log(`SUITE COMPLETA — ${toRun.length}/${files.length} file`);
  console.log(`server di prova: ${BASE}${onlyPure ? '  (modo --pure: i LIVE sono esclusi)' : ''}`);
  // Questa nota NON è una frase fissa: dal 12/09/2026 il cancello punta i test
  // a un'istanza usa-e-getta accesa sul working tree (porta effimera data dal
  // kernel, tools/gate-istanza.sh), e dire «provano il codice vivo, non il diff»
  // sarebbe una bugia — esattamente quella che il C6 ha chiuso.
  // Il bersaglio si guarda e si dice com'è: la 3170 è il processo del proprietario (serve
  // il codice del suo ultimo avvio), qualunque altra porta è una copia del diff.
  const bersaglioVivo = /:3170(\/|$)/.test(BASE);
  console.log(bersaglioVivo
    ? 'nota: bersaglio = la Machine VIVA → i test LIVE provano il codice del suo ultimo avvio, NON il diff.'
    : 'nota: bersaglio = istanza usa-e-getta su porta effimera → i test LIVE provano IL TUO DIFF.');
  console.log('════════════════════════════════════════════════════════════\n');

  const results = [];
  for (const f of toRun) {
    const quarantined = inQuarantena(f);
    const tag = quarantined ? 'QUAR'
      : QUARANTINE[f] ? 'SCAD'
      : LIVE.has(f) ? 'LIVE' : 'PURO';
    process.stdout.write(`  [${tag}] ${f} … `);
    const r = runOne(f);
    r.quarantined = quarantined;
    r.ok = r.code === 0;
    results.push(r);
    const secs = (r.ms / 1000).toFixed(1);
    if (r.ok) console.log(`OK (${secs}s)`);
    else if (quarantined) console.log(`rosso ma IN QUARANTENA (${secs}s)`);
    else console.log(`FALLITO exit=${r.timedOut ? 'TIMEOUT' : r.code} (${secs}s)`);
  }

  const hardFails = results.filter((r) => !r.ok && !r.quarantined);
  const quarFails = results.filter((r) => !r.ok && r.quarantined);
  const passed = results.filter((r) => r.ok);

  if (hardFails.length) {
    console.log('\n──────── DETTAGLIO DEI FALLIMENTI ────────');
    for (const r of hardFails) {
      console.log(`\n  ✗ ${r.file}  (exit=${r.timedOut ? 'TIMEOUT' : r.code})`);
      if (r.spawnError) console.log(`        errore di lancio: ${r.spawnError}`);
      const out = lastLines(r.stdout + '\n' + r.stderr, 12);
      if (out) console.log(out);
    }
  }

  if (Object.keys(QUARANTINE).length) {
    console.log('\n──────── QUARANTENA (dichiarata, CON SCADENZA) ────────');
    for (const [f, voce] of Object.entries(QUARANTINE)) {
      const r = results.find((x) => x.file === f);
      const scaduta = quarantenaScaduta(voce);
      const gg = giorniAllaScadenza(voce);
      const state = !r ? 'non eseguito'
        : r.ok ? '★ ORA PASSA — togliere dalla quarantena'
        : scaduta ? '🛑 ancora rosso E QUARANTENA SCADUTA → ora BLOCCA'
        : 'ancora rosso (riparato dalla quarantena)';
      console.log(`\n  • ${f} — ${state}`);
      console.log(`    dal ${voce.dal || '?'} · scadenza ${voce.scadenza || 'ASSENTE'}` +
        (scaduta
          ? '  ⇒ SCADUTA: il riparo non vale più. Ripara il test, oppure proroga'
          : `  ⇒ ancora ${gg} giorn${gg === 1 ? 'o' : 'i'}`));
      if (scaduta) {
        console.log('    la data in tests/run-all.js con un motivo nuovo — e la proroga');
        console.log('    la vede chi legge il diff, perché è una riga nel diff.');
      }
      console.log(`    ${voce.motivo || '(motivo assente — difetto del registro)'}`);
    }
  }

  console.log('\n════════════════════════════════════════════════════════════');
  console.log(`VERDI ${passed.length}   ROSSI ${hardFails.length}   QUARANTENA-ROSSI ${quarFails.length}   TOTALE ${results.length}`);
  console.log('════════════════════════════════════════════════════════════');

  return hardFails.length ? 1 : 0;
}

process.exit(main());
