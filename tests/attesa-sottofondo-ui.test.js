#!/usr/bin/env node
'use strict';

/**
 * attesa-sottofondo-ui.test.js — la card della lista Sessions.
 *
 * Storia del giorno: due sessioni restavano «working» per ore per un lavoro in
 * sottofondo che non finiva; poi la card ha imparato a dire WAITING. Dopo il
 * collaudo del proprietario dal telefono:
 *   - «o working, oppure waiting e basta» (niente conteggio, niente comando);
 *   - nome ed etichetta nello stesso blu pulsante, anche selezionata; finita
 *     torna al suo colore;
 *   - NIENTE tasto stop sulla card («non l'ho mai chiesto; se voglio fermarla
 *     la apro e premo il tasto rosso»): il tasto rosso della chat ferma anche
 *     i lavori in sottofondo, e c'è anche a turno chiuso se la sessione aspetta;
 *   - riga 1 solo il nome; riga 2 a sinistra WORKING/WAITING (o reply ready, o
 *     l'inizio dell'ultimo messaggio), a destra la pastiglia del modello.
 *
 * LE LEGGI:
 *   A. Riga 1: solo il nome. Riga 2: stato o anteprima a sinistra, modello a destra.
 *   B. Lavora → «working»; aspetta (waiting, o turno chiuso con lavori vivi) →
 *      «waiting». Nessun comando, nessun tasto sulla card.
 *   B2. [29/10/2026, il proprietario, sostituisce «niente conteggio» del 17/10] Il numero
 *      sì: aiutanti vivi → «waiting for N» (anche mentre il modello scrive);
 *      fermati → «· K stopped» accanto, o da solo «K stopped» (non pulsa).
 *   C. «reply ready» e anteprima come prima, sempre in riga 2.
 *   D. Il tasto della card non esiste più (JS, CSS, ws.js).
 *   E. session_background aggiorna la sessione; se è quella aperta e aspetta,
 *      il tasto rosso della chat si vede anche a turno chiuso.
 *   F. ws.js passa session_background a applyBackgroundUpdate.
 *   G. Lo stesso blu pulsante (is-live), finita torna al suo colore.
 *   H. Il tasto rosso manda stop con source:'button' (ferma anche i lavori);
 *      scrivere durante il lavoro manda lo stop semplice (i lavori continuano).
 *
 * Run: node tests/attesa-sottofondo-ui.test.js  (raccolto da `npm test`).
 * Esecuzione vera del codice di sessions.js in una sandbox vm, con un DOM finto
 * minimo. Nessun server, nessun browser, nessuna rete.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const rd = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name); }
}

const src = rd('public/js/sessions.js');
const wsSrc = rd('public/js/ws.js');

function estrai(da, a) {
  const i = src.indexOf(da);
  if (i < 0) return null;
  const j = src.indexOf(a, i);
  if (j < 0) return null;
  return src.slice(i, j + a.length);
}

const sezione = estrai('// ── LAVORI IN SOTTOFONDO (inizio)', '// ── LAVORI IN SOTTOFONDO (fine) ──');
const builder = estrai('function buildSessionItemHtml', '\n}\n');
const prettify = estrai('function prettifyModelId', '\n}\n');

ok(!!sezione, 'sessions.js ha la sezione «LAVORI IN SOTTOFONDO»');
ok(!!builder && !!prettify, 'sessions.js ha buildSessionItemHtml');

function sandbox() {
  const inviati = [];
  const toast = [];
  let render = 0;
  const win = {
    sessions: [],
    activeSessionId: null,
    awaitingSessions: new Set(),
    openedSessions: new Set(),
    ws: { readyState: 1, send(m) { inviati.push(m); } },
    showToast(t, k) { toast.push([t, k]); },
    renderSessionList() { render++; },
  };
  const ctx = {
    window: win,
    Date, JSON, Math, String, Number, Array, Object, Set,
    setTimeout() { return 0; }, clearTimeout() {},
    escapeHtml(s) { return s ? String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;') : ''; },
    getTeamIcon() { return ''; },
    WebSocket: { OPEN: 1 },
  };
  vm.createContext(ctx);
  vm.runInContext((prettify || '') + '\n' + (sezione || '') + '\n' + (builder || ''), ctx);
  return { ctx, win, inviati, toast, get render() { return render; } };
}

function testo(html) { return html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim(); }

if (!builder || !prettify) {
  console.log(`\nattesa-sottofondo-ui: ${pass} verdi, ${fail} rossi (manca il codice da provare)`);
  process.exit(1);
}

// Ogni blocco gira da solo: se il codice manca o lancia, è UN rosso con la
// causa, e i blocchi dopo girano lo stesso (il rosso «prima» dice cosa manca).
function blocco(nome, fn) {
  try { fn(); } catch (e) { fail++; console.log('  FAIL ' + nome + ' — lancia: ' + e.message); }
}

// ---------- A/B/C: il rendering della card ----------
blocco('A/B/C', () => {
  const sb = sandbox();
  const b = (s) => sb.ctx.buildSessionItemHtml(s, false);
  const riga1 = (html) => { const m = html.match(/<div class="session-header">([\s\S]*?)<\/div>/); return m ? m[1] : ''; };
  const riga2 = (html) => { const i = html.indexOf('<div class="session-sub">'); return i < 0 ? '' : html.slice(i); };

  const lavora = b({ id: 's1', title: 'Un nome di sessione abbastanza lungo', status: 'busy', model: 'claude-opus-5-5', backgroundTasks: 0 });
  ok(/session-title/.test(riga1(lavora)) && !/session-model-pill/.test(riga1(lavora)), 'A. riga 1: solo il nome (la pastiglia non c\'è più)');
  ok(/<div class="session-sub">/.test(lavora), 'A. c\'è la riga 2 (session-sub)');
  const r2 = riga2(lavora);
  ok(r2.indexOf('>working<') >= 0 && r2.indexOf('session-model-pill') > r2.indexOf('>working<'), 'A. riga 2: «working» a sinistra, pastiglia del modello a destra');
  ok(/session-model-pill[^>]*>Opus 5\.5</.test(r2), 'A. la pastiglia dice il modello («Opus 5.5»)');
  ok(!/session-bg-stop/.test(lavora), 'A. busy → nessun tasto sulla card');

  const lavoraConBg = b({ id: 's1b', title: 'A', status: 'busy', backgroundTasks: 1, backgroundWaiting: false });
  ok(/is-waiting">waiting for 1</.test(lavoraConBg), 'B2. busy con 1 aiutante vivo → «waiting for 1» (il numero resta mentre il modello scrive)');

  const uno = b({ id: 's2', title: 'B', status: 'busy', backgroundTasks: 1, backgroundWaiting: true,
    backgroundTaskList: [{ id: 't1', description: 'while true; do sleep 5; done', type: 'local_bash' }] });
  ok(!/>working</.test(uno) && /is-waiting">waiting for 1</.test(riga2(uno)), 'B. waiting → «waiting for 1» in riga 2');
  ok(!/on 1 task|background task/i.test(testo(uno)) && uno.indexOf('while true') < 0, 'B. waiting → niente comando');
  ok(!/session-bg-stop|<button[^>]*stop/i.test(uno), 'B. waiting → NESSUN tasto stop sulla card');
  ok(/session-model-pill/.test(riga2(uno)), 'B. waiting → pastiglia del modello in riga 2');

  const chiuso = b({ id: 's4', title: 'D', status: 'idle', backgroundTasks: 1 });
  ok(/>waiting for 1</.test(chiuso) && !/>working</.test(chiuso), 'B. turno chiuso con 1 lavoro vivo → «waiting for 1»');
  const tre = b({ id: 's4b', title: 'D3', status: 'busy', backgroundTasks: 2, backgroundWaiting: true, backgroundStopped: 1 });
  ok(/is-waiting">waiting for 2 · 1 stopped</.test(tre), 'B2. 2 vivi + 1 fermato → «waiting for 2 · 1 stopped»');
  const morti = b({ id: 's4c', title: 'D4', status: 'idle', backgroundTasks: 0, backgroundStopped: 2 });
  ok(/is-stopped">2 stopped</.test(morti) && !/is-live/.test(morti), 'B2. nessuno vivo, 2 fermati → «2 stopped», fermo (non is-live)');
  const lavoraMorti = b({ id: 's4d', title: 'D5', status: 'busy', backgroundTasks: 0, backgroundStopped: 1 });
  ok(/is-busy">working · 1 stopped</.test(lavoraMorti), 'B2. lavora, 1 fermato → «working · 1 stopped»');
  sb.win.awaitingSessions.add('s4e');
  const prontaMorti = b({ id: 's4e', title: 'D6', status: 'idle', backgroundTasks: 0, backgroundStopped: 1 });
  ok(/reply ready · 1 stopped</.test(prontaMorti), 'B2. risposta pronta, 1 fermato → «reply ready · 1 stopped»');

  sb.win.awaitingSessions.add('s7');
  const pronta = b({ id: 's7', title: 'G', status: 'idle', backgroundTasks: 0 });
  ok(/>reply ready</.test(riga2(pronta)) && /session-model-pill/.test(riga2(pronta)), 'C. «reply ready» in riga 2, pastiglia accanto');

  sb.win.openedSessions.add('s8');
  const ferma = b({ id: 's8', title: 'H', status: 'idle', backgroundTasks: 0, lastMessage: 'Ho finito il lavoro sul backup del disco' });
  const r2f = riga2(ferma);
  ok(/session-preview[^>]*>Ho finito il lavoro/.test(r2f) && r2f.indexOf('session-model-pill') > r2f.indexOf('session-preview'), 'C. ferma → inizio dell\'ultimo messaggio a sinistra, pastiglia a destra');
  const esc = b({ id: 's6', title: 'F', status: 'idle', backgroundTasks: 1 });
  ok(!/undefined|null/.test(esc), 'C. niente «undefined/null»');
});

// ---------- D: il tasto della card non c'è più ----------
blocco('D', () => {
  const css = rd('public/css/main.css');
  ok(!/session-bg-stop/.test(src), 'D. sessions.js: niente tasto stop sulla card');
  ok(!/session-bg-stop/.test(css), 'D. main.css: niente stile del tasto della card');
  ok(!/stop_background|background_stopped/.test(src + wsSrc), 'D. client: niente messaggi stop_background/background_stopped');
  ok(!/stop_background/.test(rd('server/ws-handler.js')), 'D. server: niente gestore stop_background (la via è il tasto rosso)');
});

// ---------- E: gli eventi del server + il tasto rosso a turno chiuso ----------
blocco('E', () => {
  const sb = sandbox();
  const w = sb.win;
  const rosso = { style: { display: 'none' } };
  w.stopBtn = rosso; w.streaming = false;
  w.sessions = [{ id: 'sZ', title: 'Z', status: 'idle', backgroundTasks: 0 }, { id: 'sA', title: 'A', status: 'idle', backgroundTasks: 0 }];
  w.activeSessionId = 'sZ';
  sb.ctx.window.applyBackgroundUpdate({ type: 'session_background', sessionId: 'sZ', backgroundTasks: 2, waiting: false, tasks: [] });
  const s = w.sessions[0];
  ok(s.backgroundTasks === 2 && s.backgroundWaiting === false && Array.isArray(s.backgroundTaskList), 'E. session_background → backgroundTasks/backgroundWaiting/backgroundTaskList');
  sb.ctx.window.applyBackgroundUpdate({ type: 'session_background', sessionId: 'sZ', backgroundTasks: 2, waiting: false, tasks: [], backgroundStopped: 3 });
  ok(s.backgroundStopped === 3, 'E. session_background → backgroundStopped (B2)');
  ok(sb.render >= 1, 'E. la lista si ridisegna');
  ok(rosso.style.display === 'flex', 'E. sessione aperta che aspetta a turno chiuso → il tasto rosso si vede');
  ok(typeof w.activeHasBackground === 'function' && w.activeHasBackground() === true, 'E. activeHasBackground: sì');
  sb.ctx.window.applyBackgroundUpdate({ type: 'session_background', sessionId: 'sZ', backgroundTasks: 0, waiting: false, tasks: [] });
  ok(rosso.style.display === 'none', 'E. lavori finiti → il tasto rosso sparisce');
  sb.ctx.window.applyBackgroundUpdate({ type: 'session_background', sessionId: 'sA', backgroundTasks: 1, waiting: false, tasks: [] });
  ok(rosso.style.display === 'none', 'E. lavori di un\'ALTRA sessione → il tasto rosso di questa non compare');
  w.streaming = true; rosso.style.display = 'flex';
  sb.ctx.window.applyBackgroundUpdate({ type: 'session_background', sessionId: 'sZ', backgroundTasks: 0, waiting: false, tasks: [] });
  ok(rosso.style.display === 'flex', 'E. mentre la risposta scorre il tasto rosso resta (non lo tocca)');
});

// ---------- F: i fili ----------
blocco('F', () => {
  const i = wsSrc.indexOf("msg.type === 'session_background'");
  const blocco = i < 0 ? '' : wsSrc.slice(i, i + 600);
  ok(/applyBackgroundUpdate\(msg\)/.test(blocco), 'F. ws.js: session_background → applyBackgroundUpdate(msg)');
});

// ---------- G: lo stesso blu pulsante ----------
// «Una sessione che lavora o aspetta mostra WORKING o WAITING col nome e
// l'etichetta nello stesso blu pulsante, per tutte (anche la scheda speciale
// e i super agenti); cliccata resta blu e pulsa (nome non bianco, card non viola);
// finita torna al suo colore.»
blocco('G', () => {
  const sb = sandbox();
  const cls = (html) => (html.match(/class="(session-item(?:\s[^"]*)?)"/) || [])[1] || '';
  const viva = (html) => /\bis-live\b/.test(cls(html));
  const lavora = { id: 'g1', title: 'A', status: 'busy', backgroundTasks: 0 };
  const aspetta = { id: 'g2', title: 'B', status: 'busy', backgroundTasks: 1, backgroundWaiting: true };
  const chiusoConLavoro = { id: 'g3', title: 'C', status: 'idle', backgroundTasks: 1 };
  ok(viva(sb.ctx.buildSessionItemHtml(lavora, false)), 'G. working → card is-live');
  ok(viva(sb.ctx.buildSessionItemHtml(aspetta, false)), 'G. waiting → card is-live');
  ok(viva(sb.ctx.buildSessionItemHtml(chiusoConLavoro, false)), 'G. turno chiuso con lavoro vivo (waiting) → is-live');
  ok(viva(sb.ctx.buildSessionItemHtml(lavora, true)), 'G. scheda speciale che lavora → is-live (blu, non il suo colore)');
  ok(viva(sb.ctx.buildSessionItemHtml(Object.assign({}, lavora, { team: 'writer' }), false)), 'G. super agente che lavora → is-live');
  ok(viva(sb.ctx.buildSessionItemHtml(Object.assign({}, aspetta, { team: 'reviewer' }), false)), 'G. super agente che aspetta → is-live');
  sb.win.activeSessionId = 'g1';
  const sel = sb.ctx.buildSessionItemHtml(lavora, false);
  ok(viva(sel) && /\bactive\b/.test(cls(sel)), 'G. selezionata e al lavoro → active E is-live (resta blu)');
  sb.win.activeSessionId = 'g2';
  ok(viva(sb.ctx.buildSessionItemHtml(aspetta, true)), 'G. scheda speciale selezionata che aspetta → is-live');
  sb.win.activeSessionId = null;
  sb.win.awaitingSessions.add('g4');
  const finita = sb.ctx.buildSessionItemHtml({ id: 'g4', title: 'D', status: 'idle', backgroundTasks: 0 }, true);
  ok(!viva(finita) && /\bawaiting\b/.test(cls(finita)) && /\bspecial\b/.test(cls(finita)), 'G. finita (reply ready) → niente is-live, torna special/awaiting');
  const ferma = sb.ctx.buildSessionItemHtml({ id: 'g5', title: 'E', status: 'idle', backgroundTasks: 0 }, false);
  ok(!viva(ferma), 'G. ferma → niente is-live');

  // Il CSS: un blocco solo, sopra le regole di squadra e di selezione (#session-list).
  const css = rd('public/css/main.css');
  const regola = (sel) => { const i = css.indexOf(sel + ' {'); return i < 0 ? '' : css.slice(i, css.indexOf('}', i)); };
  const card = regola('#session-list .session-item.is-live');
  ok(/--pulse-rgb:\s*var\(--cyan-rgb\)/.test(card) && /--bleed-rgb:\s*var\(--cyan-rgb\)/.test(card), 'G. CSS: card viva → pulsazione e selezione nel blu (non oro, non viola)');
  // [29/10/2026 BATTERIA, il proprietario: «colore fisso»] acceso fisso, niente pulsazione (tests/animazioni-ferme.test.js).
  ok(/border-left-color:\s*rgb\(var\(--pulse-rgb\)\)/.test(card) && !/animation/.test(card), 'G. CSS: card viva → bordo blu acceso fisso');
  const titolo = regola('#session-list .session-item.is-live .session-title');
  ok(/color:\s*rgb\(var\(--cyan-rgb\)\)/.test(titolo) && !/animation/.test(titolo), 'G. CSS: nome nel blu acceso fisso (anche selezionata: niente bianco)');
  const attesa = regola('.session-status-label.is-waiting');
  ok(/--cyan-rgb/.test(attesa) && !/orange/.test(attesa) && regola('.session-status-label.is-busy').split('{')[1] === attesa.split('{')[1], 'G. CSS: WAITING nello stesso blu acceso di WORKING (niente ambra)');
  ok(!/\.session-item\.bg-waiting\s*\{[^}]*orange/.test(css), 'G. CSS: niente più bordo ambra per l\'attesa');
  ok(/\.session-item\.special\.awaiting\s+\.session-status-label\.is-awaiting\s*\{[^}]*--agent-special/.test(css), 'G. CSS: «reply ready» della scheda speciale nel suo colore');
  ok(/'\.awaiting \.session-status-label\.is-awaiting\{background:' \+ c/.test(rd('public/js/sessions.js')), 'G. «reply ready» di ogni super agente nel suo colore (regole generate, sessions.js)');
});

// ---------- H: il tasto rosso della chat ----------
blocco('H', () => {
  const inp = rd('public/js/input.js');
  const core = rd('public/js/core.js');
  const onclick = inp.slice(inp.indexOf('stopBtn.onclick = function'), inp.indexOf('stopBtn.onclick = function') + 3000);
  ok(/ws\.send\(JSON\.stringify\(\{ type: 'stop', source: 'button' \}\)\)/.test(onclick), 'H. il tasto rosso manda {type:"stop", source:"button"} (ferma anche i lavori)');
  const interj = inp.slice(0, inp.indexOf('stopBtn.onclick = function'));
  ok(/ws\.send\(JSON\.stringify\(\{ type: 'stop' \}\)\)/.test(interj) && !/source: 'button'/.test(interj), 'H. scrivere durante il lavoro manda lo stop semplice (i lavori continuano)');
  // setStreamingState(false) non spegne il tasto rosso se la sessione aperta aspetta
  const i = core.indexOf('function setStreamingState');
  const fn = core.slice(i, core.indexOf('\n}\n', i) + 3);
  const btn = { style: { display: 'flex' } };
  const win = { activeHasBackground: () => true };
  const ctx = { window: win, stopBtn: btn, requestWakeLock() {}, releaseWakeLock() {}, setTimeout() {} };
  vm.createContext(ctx); vm.runInContext(fn, ctx);
  ctx.setStreamingState(false);
  ok(btn.style.display === 'flex', 'H. fine della risposta con lavori vivi → il tasto rosso resta');
  win.activeHasBackground = () => false;
  ctx.setStreamingState(false);
  ok(btn.style.display === 'none', 'H. fine della risposta senza lavori → il tasto rosso sparisce come prima');
});

console.log(`\nattesa-sottofondo-ui: ${pass} verdi, ${fail} rossi`);
process.exit(fail ? 1 : 0);
