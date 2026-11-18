'use strict';
// [08/11/2026] — «dopo un !comando la chat si rompe».
// Una bolla di Claude VUOTA, e la risposta vera subito dopo come turno a parte.
// Causa misurata (pm2-out.log 12:56:01 e 12:57:48, storia delle sessioni
// 2f5e629a ed e33f05f0 con `assistant ''`): il turno aperto si chiudeva sul
// PRIMO `result` che arrivava, anche quando quel result era di un ALTRO turno:
//   (1) sessione ripresa con un lavoro in sottofondo morto col processo di
//       prima: il CLI scrive task_notification «stopped» → init → result
//       VUOTO (num_turns 0, nessuna eco) PRIMA di rispondere al messaggio;
//   (2) messaggio scritto mentre Claude lavora: il server ferma il turno A e
//       manda B; il result interrotto di A arriva DOPO, quando B è già aperto.
// In tutti e due i casi B si chiudeva vuoto e la sua risposta nasceva come
// «turno spontaneo». Le sequenze qui sotto sono quelle VERE dell'SDK 0.3.283,
// registrate l'08/11 con due sonde (/tmp/k4vq-probe/probe.mjs, probe2.mjs).
// Prova PURA: niente SDK, niente disco.
const assert = require('assert');
const eng = require('../server/sdk-engine');
const { SdkSession, SdkTurnProc } = eng;

let ok = 0; const falliti = [];
// Non si ferma al primo errore: sul codice vecchio deve dire TUTTO quel che è rotto.
function check(cond, label) {
  if (cond) { ok++; console.log('  ok  ' + label); } else { falliti.push(label); console.log('  NO  ' + label); }
}

function fakeSession() {
  const pushed = [];
  return {
    sessionId: 'kkkkkkkk-test', dead: false, _evicting: false, activeTurn: null,
    lastActivity: 0, bgTasks: [], pushed,
    _input: { push(x) { pushed.push(x); } },
    _armIdleTimer() {}, _armFreezeWatch() {}, _clearFreezeWatch() {},
    onTurnEnd() {},
  };
}
const route = (s, m) => SdkSession.prototype._route.call(s, m);

function apri(s) {
  const turn = new SdkTurnProc(s);
  const lines = [];
  turn.stdout.on('data', (d) => lines.push(...String(d).split('\n').filter(Boolean).map((l) => JSON.parse(l))));
  SdkSession.prototype.pushTurn.call(s, turn, 'testo del proprietario');
  return { turn, lines };
}

let spontanei = 0;
eng.setUnsolicitedTurnHandler(() => { spontanei++; return true; });
eng.setBackgroundTasksHandler(() => {});

// (A) Il messaggio mandato porta la sua impronta (uuid) -----------------------
{
  const s = fakeSession();
  const { turn } = apri(s);
  const u = s.pushed[0] && s.pushed[0].uuid;
  check(typeof u === 'string' && u.length >= 32, '(A) il messaggio spinto nell\'SDK ha un uuid');
  check(turn._uuid === u, '(A) il turno ricorda il suo uuid');
}

// (B) Ripresa con un lavoro morto: il result vuoto senza eco non è del turno -
setTimeout(() => {
  const s = fakeSession();
  spontanei = 0;
  const { turn, lines } = apri(s);
  const U = turn._uuid;
  const seq = [
    { type: 'system', subtype: 'task_notification', task_id: 'b47gbsdzh', status: 'stopped' },
    { type: 'system', subtype: 'init', session_id: 'x', model: 'm' },
    { type: 'result', subtype: 'success', num_turns: 0, result: '', is_error: false },
  ];
  for (const m of seq) route(s, m);
  check(!turn._closed, '(B) il result vuoto del lavoro morto NON chiude il turno del proprietario');
  check(s.activeTurn === turn, '(B) il turno resta quello aperto');
  route(s, { type: 'system', subtype: 'init', session_id: 'x', model: 'm' });
  route(s, { type: 'stream_event', event: { type: 'message_start' }, user_message_uuid: U, user_message_uuids: [U] });
  route(s, { type: 'assistant', user_message_uuid: U, message: { content: [{ type: 'text', text: 'pong' }] } });
  route(s, { type: 'result', subtype: 'success', num_turns: 1, result: 'pong', user_message_uuid: U, user_message_uuids: [U] });
  check(turn._closed, '(B) il SUO result chiude il turno');
  check(spontanei === 0, '(B) nessun turno spontaneo: la risposta resta nella stessa bolla');
  setImmediate(() => {
    const results = lines.filter((l) => l.type === 'result');
    check(results.length === 1 && results[0].result === 'pong', '(B) al tubo arriva un result solo, quello con la risposta');
    parteC();
  });
}, 0);

// (C) Messaggio scritto mentre lavora: il result interrotto di A non chiude B -
function parteC() {
  const s = fakeSession();
  spontanei = 0;
  const a = apri(s);
  const UA = a.turn._uuid;
  route(s, { type: 'stream_event', event: { type: 'message_start' }, user_message_uuid: UA, user_message_uuids: [UA] });
  a.turn._userKilled = true; a.turn._finish(0); // ws-handler: «auto-stopping before injection»
  const b = apri(s);
  const UB = b.turn._uuid;
  check(UA !== UB, '(C) due messaggi, due uuid diversi');
  route(s, { type: 'result', subtype: 'error_during_execution', num_turns: 2, result: '', user_message_uuid: UA, user_message_uuids: [UA] });
  check(!b.turn._closed, '(C) il result di A interrotto NON chiude B');
  route(s, { type: 'system', subtype: 'init', session_id: 'x', model: 'm' });
  route(s, { type: 'stream_event', event: { type: 'message_start' }, user_message_uuid: UB, user_message_uuids: [UB] });
  route(s, { type: 'assistant', user_message_uuid: UB, message: { content: [{ type: 'text', text: 'pong' }] } });
  route(s, { type: 'result', subtype: 'success', num_turns: 1, result: 'pong', user_message_uuid: UB, user_message_uuids: [UB] });
  check(b.turn._closed, '(C) B si chiude sul suo result');
  check(spontanei === 0, '(C) nessun turno spontaneo dopo la fermata');
  parteD();
}

// (D) Quel che funzionava resta com'era ------------------------------------------
function parteD() {
  // Messaggi raggruppati dal CLI: il nostro uuid è DENTRO la lista → è nostro.
  {
    const s = fakeSession();
    const { turn } = apri(s);
    route(s, { type: 'result', subtype: 'success', num_turns: 1, result: 'x', user_message_uuid: 'altro', user_message_uuids: [turn._uuid, 'altro'] });
    check(turn._closed, '(D) uuid nella lista del gruppo → il result è del turno');
  }
  // Comando locale (/context): eco presente anche con num_turns 0 (sonda probe3).
  {
    const s = fakeSession();
    const { turn } = apri(s);
    route(s, { type: 'result', subtype: 'success', num_turns: 0, result: '## Context Usage', user_message_uuid: turn._uuid, user_message_uuids: [turn._uuid] });
    check(turn._closed, '(D) comando locale con eco → chiude');
  }
  // CLI vecchio senza eco: con contenuto il result chiude come sempre.
  {
    const s = fakeSession();
    const { turn } = apri(s);
    route(s, { type: 'assistant', message: { content: [{ type: 'text', text: 'ciao' }] } });
    route(s, { type: 'result', subtype: 'success', num_turns: 1, result: 'ciao' });
    check(turn._closed, '(D) senza eco ma con risposta → chiude');
  }
  // Errore senza eco (es. API giù): chiude, non resta appeso.
  {
    const s = fakeSession();
    const { turn } = apri(s);
    route(s, { type: 'result', subtype: 'success', is_error: true, num_turns: 0, result: 'API Error' });
    check(turn._closed, '(D) errore senza eco → chiude');
  }
  // Turno spontaneo (nessun uuid): il primo result lo chiude, come prima.
  {
    const s = fakeSession();
    const t = new SdkTurnProc(s); s.activeTurn = t;
    route(s, { type: 'result', subtype: 'success', num_turns: 0, result: '' });
    check(t._closed, '(D) turno senza uuid: il result chiude come prima');
  }
  if (falliti.length) {
    console.error(`sdk-risultato-altrui: ${falliti.length} FALLITI, ${ok} OK`);
    process.exit(1);
  }
  assert.ok(ok > 0);
  console.log(`sdk-risultato-altrui: ${ok} controlli OK`);
}
