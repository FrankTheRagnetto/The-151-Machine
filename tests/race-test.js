#!/usr/bin/env node
'use strict';

// =============================================================================
// LA CORSA DELLA SOSTITUZIONE DI SESSIONE
// (nato 2026-08-28 · in quarantena dal 28/08 · RIPARATO il 22/09/2026)
//
// LA PROPRIETA' DIFESA — una sola, e viva:
//   quando una sessione viene SOSTITUITA (kill + ri-spawn con lo STESSO
//   sessionId), l'uscita del vecchio figlio NON deve contaminare la sessione
//   nuova. Il vecchio figlio muore in modo asincrono: se il suo 'exit' arriva
//   dopo che il record nuovo e' gia' nella mappa, chiude il processo nuovo e
//   l'utente vede la risposta troncata a meta'.
//
// La proprieta' e' difesa su DUE lati, e tutti e due esistono ancora oggi:
//   · lato daemon  — server/session-host/index.js, doSpawn() stacca gli
//                    ascoltatori del vecchio proc prima di sostituire il record;
//   · lato client  — server/session-host-client.js, _dispatch() ignora un
//                    'exit' che arriva su un proc senza pid (spawn non ancora
//                    confermato: quell'uscita e' del giro precedente).
// Il daemon 151-session-host e' in produzione su questa macchina (pm2, TCP
// 127.0.0.1:3172) e il server principale gira con USE_SESSION_HOST=1: la
// proprieta' non e' archeologia.
//
// PERCHE' ERA ROTTO, E COSA E' CAMBIATO
// La versione del 28/08 aveva una meta' "integration" che si collegava a
// \\.\pipe\151-session-host, una named pipe di WINDOWS: dopo la migrazione a
// Linux quella meta' non poteva piu' connettersi. Il trasporto di oggi e' TCP
// su 127.0.0.1:3172 (SESSION_HOST_FORCE_TCP=1 su ENTRAMBE le app in
// ecosystem.linux.config.js). La meta' morta e' stata sostituita dalla parte B
// qui sotto, che prova il CONTRATTO di trasporto di oggi.
//
// Sono state tolte anche due vecchie prove "unit" che costruivano un
// EventEmitter nudo, gli toglievano gli ascoltatori e verificavano che non
// emettesse piu' nulla: provavano EventEmitter di Node, non questa casa.
// Verde finto: meglio niente.
//
// QUESTA PROVA E' PURA: nessun server vivo, nessuna rete, nessun processo
// figlio, nessun token. Non tocca il daemon del proprietario e non gli spawna dentro
// nulla (era l'altro difetto della meta' "integration": scriveva in produzione).
//
// Uso:  node tests/race-test.js
// =============================================================================

const fs = require('fs');
const net = require('net');
const path = require('path');
const { randomUUID } = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const DAEMON_SRC = path.join(ROOT, 'server', 'session-host', 'index.js');

let verdi = 0;
const rotti = [];
function prova(nome, cond, dettaglio) {
  if (cond) { verdi++; console.log(`  ok   ${nome}`); }
  else {
    rotti.push(nome + (dettaglio ? ` — ${dettaglio}` : ''));
    console.log(`  NO   ${nome}${dettaglio ? ` — ${dettaglio}` : ''}`);
  }
}

// Codice VERO del client: non una simulazione.
const { SessionHostClient, RemoteProc, PIPE_PATH, TCP_FALLBACK_HOST, TCP_FALLBACK_PORT } =
  require('../server/session-host-client');

// ---------------------------------------------------------------------------
// A) IL GUASTO, SUL CODICE VERO DEL CLIENT
// Si guida SessionHostClient._dispatch() esattamente come lo guida il socket:
// gli si passano i messaggi che il daemon manda sul filo. Nessun mock.
// ---------------------------------------------------------------------------
function parteA() {
  console.log('\nA) la corsa, sul codice vero di server/session-host-client.js');
  const client = new SessionHostClient();
  try {
    const sid = 'race-' + randomUUID().slice(0, 8);

    // Un proc appena creato: lo spawn non e' ancora stato confermato, pid null.
    const proc = new RemoteProc(client, sid, 'ignore');
    client.procs.set(sid, proc);

    let chiusure = 0;
    proc.on('close', () => { chiusure++; });

    // L'uscita STANTIA del figlio precedente arriva ora, prima dell'ack.
    client._dispatch({ type: 'exit', sessionId: sid, code: null, signal: 'SIGTERM' });

    prova('un exit stantio (proc senza pid) non chiude il proc nuovo', chiusure === 0);
    prova('il proc resta nella mappa dopo l\'exit stantio ignorato', client.procs.has(sid));

    // Arriva l'ack dello spawn: da qui in poi le uscite sono sue.
    proc.pid = 12345;
    client._dispatch({ type: 'exit', sessionId: sid, code: 0, signal: null });

    prova('l\'exit vero (proc con pid) chiude il proc', proc._closed === true);
    prova('e il proc esce dalla mappa', !client.procs.has(sid));
    prova('il \'close\' e\' arrivato una volta sola', chiusure === 1, `chiusure=${chiusure}`);

    // ---- la sostituzione vera e propria -----------------------------------
    // Stesso sessionId, proc nuovo che prende il posto del vecchio nella mappa:
    // l'uscita tardiva del VECCHIO non deve chiudere il NUOVO.
    const sid2 = 'race-' + randomUUID().slice(0, 8);
    const vecchio = new RemoteProc(client, sid2, 'ignore');
    vecchio.pid = 111;
    client.procs.set(sid2, vecchio);

    const nuovo = new RemoteProc(client, sid2, 'ignore'); // pid ancora null
    client.procs.set(sid2, nuovo);                        // sostituzione

    let nuovoChiuso = false;
    nuovo.on('close', () => { nuovoChiuso = true; });

    // Il vecchio figlio muore adesso, in ritardo.
    client._dispatch({ type: 'exit', sessionId: sid2, code: null, signal: 'SIGTERM' });

    prova('l\'uscita tardiva del vecchio figlio non chiude la sessione nuova', !nuovoChiuso);
    prova('la sessione nuova e\' ancora nella mappa', client.procs.get(sid2) === nuovo);

    // E quando il nuovo esce davvero, esce.
    nuovo.pid = 222;
    client._dispatch({ type: 'exit', sessionId: sid2, code: 0, signal: null });
    prova('la sessione nuova si chiude sulla SUA uscita', nuovoChiuso === true);

    // Un secondo exit sullo stesso proc non deve emettere un secondo 'close'.
    let doppioni = 0;
    const sid3 = 'race-' + randomUUID().slice(0, 8);
    const p3 = new RemoteProc(client, sid3, 'ignore');
    p3.pid = 333;
    p3.on('close', () => { doppioni++; });
    client.procs.set(sid3, p3);
    client._dispatch({ type: 'exit', sessionId: sid3, code: 0, signal: null });
    p3._emitClose(0, null); // ripetuto a mano: _closed deve reggere
    prova('_emitClose e\' idempotente (un solo \'close\' per proc)', doppioni === 1, `close=${doppioni}`);
  } finally {
    client.shutdown();
  }
}

// ---------------------------------------------------------------------------
// B) IL TRASPORTO DI OGGI — TCP 127.0.0.1:3172
// Questa parte SOSTITUISCE la vecchia meta' "integration" sulla named pipe.
// Non bussa al daemon vivo del proprietario: prova il CONTRATTO, cioe' che le due meta'
// del sistema (daemon e client) puntino allo stesso posto e che la casa accenda
// entrambe col flag giusto. Se qualcuno sposta la porta da un lato solo, o
// perde SESSION_HOST_FORCE_TCP da un'app, le sessioni muoiono tutte: e' la
// rottura esatta che la migrazione a Linux ha gia' prodotto una volta.
// ---------------------------------------------------------------------------
async function parteB() {
  console.log('\nB) il trasporto di oggi: TCP 127.0.0.1:3172 (non piu\' la named pipe)');

  const daemon = require('../server/session-host/index.js'); // solo costanti: main() non parte

  prova('daemon e client concordano sull\'host', daemon.TCP_FALLBACK_HOST === TCP_FALLBACK_HOST,
    `daemon=${daemon.TCP_FALLBACK_HOST} client=${TCP_FALLBACK_HOST}`);
  prova('daemon e client concordano sulla porta', daemon.TCP_FALLBACK_PORT === TCP_FALLBACK_PORT,
    `daemon=${daemon.TCP_FALLBACK_PORT} client=${TCP_FALLBACK_PORT}`);
  prova('la porta e\' 3172 ed e\' un numero', TCP_FALLBACK_PORT === 3172);
  prova('l\'host e\' il solo loopback', TCP_FALLBACK_HOST === '127.0.0.1');

  // Le due app devono essere accese col flag, altrimenti il daemon apre un
  // socket unix con un nome windowsiano e il client bussa a un percorso che
  // non esiste. Si legge la configurazione vera, non una copia a mano.
  const apps = require('../ecosystem.linux.config.js').apps;
  const trova = (nome) => apps.find((a) => a.name === nome);
  const host = trova('151-session-host');
  const machine = trova('151-machine');

  prova('ecosystem.linux dichiara 151-session-host', Boolean(host));
  prova('ecosystem.linux dichiara 151-machine', Boolean(machine));
  prova('151-session-host accende il TCP (SESSION_HOST_FORCE_TCP=1)',
    Boolean(host) && host.env && host.env.SESSION_HOST_FORCE_TCP === '1');
  prova('151-machine accende il TCP (SESSION_HOST_FORCE_TCP=1)',
    Boolean(machine) && machine.env && machine.env.SESSION_HOST_FORCE_TCP === '1');
  prova('151-machine usa davvero il session-host (USE_SESSION_HOST=1)',
    Boolean(machine) && machine.env && machine.env.USE_SESSION_HOST === '1');

  // Il client vero legge il flag nel costruttore: si prova quel ramo.
  const prima = process.env.SESSION_HOST_FORCE_TCP;
  try {
    process.env.SESSION_HOST_FORCE_TCP = '1';
    const conFlag = new SessionHostClient();
    prova('col flag il client vero sceglie il TCP', conFlag._forceTcp === true);
    conFlag.shutdown();

    delete process.env.SESSION_HOST_FORCE_TCP;
    const senzaFlag = new SessionHostClient();
    prova('senza flag il client ripiegherebbe sulla named pipe', senzaFlag._forceTcp === false);
    senzaFlag.shutdown();
  } finally {
    if (prima === undefined) delete process.env.SESSION_HOST_FORCE_TCP;
    else process.env.SESSION_HOST_FORCE_TCP = prima;
  }

  // E la named pipe, su questo sistema, NON si puo' comporre: e' il motivo per
  // cui il flag non e' facoltativo. Prova di comportamento, non di opinione.
  const esito = await provaDial(PIPE_PATH);
  prova('la named pipe di Windows non e\' componibile su questo sistema',
    esito.connesso === false, `esito=${JSON.stringify(esito)}`);
  console.log(`       (${PIPE_PATH} -> ${esito.code})`);
}

// Compone un indirizzo e riferisce se si e' connesso. Non lascia timer appesi.
function provaDial(indirizzo, msTimeout = 2000) {
  return new Promise((resolve) => {
    let finito = false;
    let timer = null;
    const s = net.createConnection(indirizzo);
    const fine = (esito) => {
      if (finito) return;
      finito = true;
      if (timer) clearTimeout(timer);
      try { s.destroy(); } catch { /* gia' morto */ }
      resolve(esito);
    };
    s.once('connect', () => fine({ connesso: true, code: null }));
    s.once('error', (err) => fine({ connesso: false, code: err.code || err.message }));
    timer = setTimeout(() => fine({ connesso: false, code: 'TIMEOUT' }), msTimeout);
  });
}

// ---------------------------------------------------------------------------
// C) IL LATO DAEMON — presidio TESTUALE, e lo dice
// doSpawn() non e' esportata e il daemon non si puo' accendere in isolamento
// dentro una prova: la porta 3172 e' una costante (la prenderebbe al daemon
// vivo) e la cartella dei buffer e' condivisa con lui (server/session-host/
// buffer-persistence.js:66, cartella dedotta dalla radice del repo, non dalla
// cwd), quindi un daemon di prova all'avvio farebbe cleanupOld() sui buffer
// VERI del proprietario. Percio' qui NON si prova il comportamento: si sorveglia che la
// riga che regge la proprieta' sia ancora al suo posto e nell'ordine giusto.
// E' un presidio contro la cancellazione, non una dimostrazione. Cosa servirebbe
// per trasformarlo in una prova vera e' scritto nel rapporto.
// ---------------------------------------------------------------------------
function parteC() {
  console.log('\nC) il lato daemon (presidio testuale su server/session-host/index.js)');
  const src = fs.readFileSync(DAEMON_SRC, 'utf8');

  const inizio = src.indexOf('function doSpawn(');
  prova('doSpawn() esiste ancora nel daemon', inizio >= 0);
  if (inizio < 0) return;

  // Corpo di doSpawn: fino alla dichiarazione di prima colonna successiva.
  const resto = src.slice(inizio + 1);
  const fine = resto.search(/\nfunction \w+\(/);
  const corpo = fine >= 0 ? resto.slice(0, fine) : resto;

  const iStacca = corpo.indexOf('existing.proc.removeAllListeners()');
  const iCancella = corpo.indexOf('sessions.delete(sessionId)');

  prova('doSpawn stacca gli ascoltatori del vecchio proc', iStacca >= 0);
  prova('doSpawn cancella il vecchio record di sessione', iCancella >= 0);
  prova('e li stacca PRIMA di cancellare il record (l\'ordine e\' la proprieta\')',
    iStacca >= 0 && iCancella >= 0 && iStacca < iCancella,
    `stacca@${iStacca} cancella@${iCancella}`);
}

// ---------------------------------------------------------------------------

async function run() {
  console.log('== LA CORSA DELLA SOSTITUZIONE DI SESSIONE ==');
  parteA();
  await parteB();
  parteC();

  console.log('\n════════════════════════════════════════════');
  console.log(`VERDI ${verdi}   ROSSI ${rotti.length}`);
  if (rotti.length) {
    console.log('\nROTTI:');
    for (const r of rotti) console.log('  · ' + r);
  }
  console.log('════════════════════════════════════════════');
  process.exit(rotti.length ? 1 : 0);
}

run().catch((err) => {
  console.error('Errore fatale:', err);
  process.exit(1);
});
