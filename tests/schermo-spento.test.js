// Il telefono in tasca non riceve i pezzi della risposta (10/11/2026, batteria ).
// Prima sendToSession mandava ogni delta/thinking/tool_* anche al socket di un
// telefono con lo schermo spento (ws.isHidden): centinaia di risvegli della radio
// per una risposta lunga. Ora gli arrivano solo done/error (e ciò che non è un
// pezzo), il resto torna col replay di get_stream_state.
//
// Cosa si prova qui, senza server e senza telefono:
//   A. Il modulo vero (server/schermo-spento.js) col registro vero
//      (server/stream-log.js, cartella di scarto) e un client che rifà il gate
//      di public/js/ws.js (_noteSeq a ogni messaggio, _alreadyApplied sui delta):
//      schermo spento → zero pezzi; al ritorno il testo è INTERO, anche se un
//      pezzo nuovo arriva fra «visibility false» e get_stream_state.
//   B. done a schermo spento: arriva (notifica e risposta intera), chiude il sospeso.
//   C. Sicurezza: tornato visibile senza get_stream_state → liberato dopo 10 s.
//   D. Senza DETACHED_RUNS (niente registro) non si trattiene niente.
//   E. Il cablaggio: sendToSession salta i trattenuti e non li mette in coda;
//      ws-handler libera PRIMA del replay e segna il ritorno.
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const scarto = fs.mkdtempSync(path.join(os.tmpdir(), 'schermo-spento-'));
process.env.DETACHED_STREAM_LOG_DIR = scarto; // mai la cartella vera del proprietario
process.env.DETACHED_RUNS = '1';
const streamLog = require(path.join(ROOT, 'server/stream-log'));
const schermo = require(path.join(ROOT, 'server/schermo-spento'));

let n = 0, rossi = 0;
function t(nome, fn) {
  n++;
  try { fn(); console.log('  ✓ ' + nome); }
  catch (e) { rossi++; console.log('  ✗ ' + nome + '\n    ' + (e && e.message)); }
}

// Il client: lo stesso gate di public/js/ws.js (righe _noteSeq / _alreadyApplied / done).
function cliente() {
  return {
    visto: 0, applicato: 0, testo: '', finale: null, arrivati: [],
    ricevi(raw) {
      const m = JSON.parse(raw);
      this.arrivati.push(m.type);
      this._uno(m);
    },
    _uno(m) {
      if (m.type === 'replay') { m.events.forEach((e) => this._uno(e)); if (typeof m.seq === 'number') this.visto = Math.max(this.visto, m.seq); return; }
      if (typeof m._seq === 'number') this.visto = Math.max(this.visto, m._seq);
      if (m.type === 'delta') {
        if (this.applicato >= m._seq) return;
        this.testo += m.content;
        this.applicato = m._seq;
      }
      if (m.type === 'done') { this.finale = m.fullResponse; if (typeof m._seq === 'number') this.applicato = Math.max(this.applicato, m._seq); }
    },
  };
}

// Il server: sendToSession com'è in server/index.js (registro, poi giro dei socket).
function server(sid) {
  const c = cliente();
  const sock = { isHidden: false, send: (p) => c.ricevi(p) };
  const coda = [];
  return {
    c, sock, coda,
    manda(data) {
      data = Object.assign({ sessionId: sid }, data);
      streamLog.record(sid, data);
      let consegnati = 0, trattenuti = 0;
      for (const s of [sock]) {
        if (schermo.trattieni(s, sid, data)) { trattenuti++; continue; }
        s.send(JSON.stringify(data)); consegnati++;
      }
      if (consegnati === 0 && trattenuti === 0) coda.push(data);
    },
    visibilita(nascosto) { sock.isHidden = nascosto; if (!nascosto) schermo.tornatoVisibile(sock); },
    getStreamState() {
      schermo.libera(sock, sid);
      const r = streamLog.replaySince(sid, c.visto, null);
      sock.send(JSON.stringify({ type: 'replay', sessionId: sid, events: r.events, seq: r.seq }));
    },
  };
}

console.log('schermo-spento — il telefono in tasca non riceve i pezzi della risposta');

t('A. schermo spento: zero pezzi; al ritorno (con un pezzo in mezzo) il testo è intero', () => {
  const sid = 'sess-a'; streamLog.startTurn(sid);
  const s = server(sid);
  s.manda({ type: 'delta', content: 'Uno ' });
  s.manda({ type: 'delta', content: 'due ' });
  s.visibilita(true);
  const primaDiSpegnere = s.c.arrivati.length;
  s.manda({ type: 'thinking', content: '…' });
  s.manda({ type: 'delta', content: 'tre ' });
  s.manda({ type: 'status', status: 'thinking', detail: 'Model: x' });
  s.manda({ type: 'tool_start', tool: 'Bash' });
  s.manda({ type: 'tool_use', tool: 'Bash', input: {} });
  s.manda({ type: 'tool_done', tool: 'Bash' });
  s.manda({ type: 'model_info', model: 'x' });
  s.manda({ type: 'delta', content: 'quattro ' });
  assert.deepStrictEqual(s.c.arrivati.slice(primaDiSpegnere), [], 'IL GUASTO: al telefono in tasca arrivavano ' + (s.c.arrivati.length - primaDiSpegnere) + ' pezzi');
  assert.deepStrictEqual(s.coda, [], 'i trattenuti non finiscono nella coda «nessun socket»');
  // Ritorno: visibility false, poi (wsOnResume) get_stream_state. In mezzo, un pezzo nuovo.
  s.visibilita(false);
  s.manda({ type: 'delta', content: 'cinque ' });
  s.getStreamState();
  s.manda({ type: 'delta', content: 'sei' });
  assert.strictEqual(s.c.testo, 'Uno due tre quattro cinque sei', 'testo perso o doppio: «' + s.c.testo + '»');
});

t('B. done a schermo spento: arriva intero (notifica, risposta), chiude il sospeso', () => {
  const sid = 'sess-b'; streamLog.startTurn(sid);
  const s = server(sid);
  s.manda({ type: 'delta', content: 'Ciao ' });
  s.visibilita(true);
  s.manda({ type: 'delta', content: 'Anna' });
  s.manda({ type: 'done', fullResponse: 'Ciao Anna', steps: [] });
  assert.deepStrictEqual(s.c.arrivati, ['delta', 'done']);
  assert.strictEqual(s.c.finale, 'Ciao Anna');
  assert.ok(!(s.sock._151Sospesi && s.sock._151Sospesi.has(sid)), 'dopo il done niente sospeso');
  s.manda({ type: 'error', message: 'x' });
  assert.strictEqual(s.c.arrivati[s.c.arrivati.length - 1], 'error', 'error arriva sempre');
  // Ciò che non è un pezzo passa (es. user_message, comando_esito).
  s.manda({ type: 'user_message', content: 'eco' });
  assert.strictEqual(s.c.arrivati[s.c.arrivati.length - 1], 'user_message');
});

t('C. tornato visibile senza get_stream_state: liberato dopo LIBERA_DOPO_MS', () => {
  const sock = { isHidden: true };
  const dati = (seq) => ({ type: 'delta', _seq: seq, content: 'x' });
  assert.strictEqual(schermo.trattieni(sock, 's', dati(1), 1000), true);
  sock.isHidden = false; schermo.tornatoVisibile(sock, 2000);
  assert.strictEqual(schermo.trattieni(sock, 's', dati(2), 2000 + 5000), true, 'in attesa di get_stream_state');
  assert.strictEqual(schermo.trattieni(sock, 's', dati(3), 2000 + schermo.LIBERA_DOPO_MS + 1), false, 'liberato');
  assert.strictEqual(schermo.trattieni(sock, 's', dati(4), 2000 + schermo.LIBERA_DOPO_MS + 2), false);
});

t('D. senza DETACHED_RUNS (niente registro, niente replay) non si trattiene niente', () => {
  delete process.env.DETACHED_RUNS;
  try {
    assert.strictEqual(schermo.trattieni({ isHidden: true }, 's', { type: 'delta', _seq: 1 }), false);
  } finally { process.env.DETACHED_RUNS = '1'; }
  assert.strictEqual(schermo.trattieni({ isHidden: true }, 's', { type: 'delta' }), false, 'senza _seq non è nel registro');
  assert.strictEqual(schermo.trattieni({ isHidden: false }, 's', { type: 'delta', _seq: 1 }), false, 'schermo acceso: tutto');
});

t('E. cablaggio: sendToSession, coda, visibility, get_stream_state', () => {
  const idx = fs.readFileSync(path.join(ROOT, 'server/index.js'), 'utf8');
  const corpo = (idx.match(/function sendToSession\([\s\S]*?\n\}/) || [''])[0];
  assert.ok(/for \(const sock of sockets\) \{\s*if \(options\.exclude[^\n]*\n[\s\S]{0,400}if \(schermoSpento\.trattieni\(sock, sessionId, data\)\) \{ trattenuti\+\+; continue; \}\s*try \{\s*sock\.send\(payload\)/.test(corpo), 'il giro di consegna salta i trattenuti');
  assert.ok(/delivered === 0 && trattenuti === 0 && !options\.exclude/.test(corpo), 'un trattenuto non va nella coda');
  assert.ok(corpo.indexOf('streamLog.record(sessionId, data)') < corpo.indexOf('schermoSpento.trattieni'), 'il pezzo è registrato prima di trattenerlo');
  const ws = fs.readFileSync(path.join(ROOT, 'server/ws-handler.js'), 'utf8');
  const gss = (ws.match(/get_stream_state: \(ws, msg\) => \{[\s\S]*?\n {6}\},/) || [''])[0];
  assert.ok(gss.indexOf('schermoSpento.libera(ws, sid)') > 0 && gss.indexOf('schermoSpento.libera(ws, sid)') < gss.indexOf('replaySince'), 'libera PRIMA del replay');
  assert.ok(/ws\.isHidden = hidden;[\s\S]{0,300}if \(!hidden\) schermoSpento\.tornatoVisibile\(ws\);/.test(ws), 'visibility segna il ritorno');
  // Tutti i tipi registrati tranne i terminali: un tipo nuovo nel registro va deciso qui.
  const registrati = [...streamLog.LOGGABLE].filter((x) => x !== 'done' && x !== 'error').sort();
  assert.deepStrictEqual([...schermo.SOLO_A_SCHERMO].sort(), registrati,
    'SOLO_A_SCHERMO deve essere LOGGABLE meno done/error: un tipo registrato che arrivasse al telefono nascosto alzerebbe il suo lastSeq e il replay salterebbe i pezzi trattenuti');
});

try { fs.rmSync(scarto, { recursive: true, force: true }); } catch (e) {}
console.log(`\n${n - rossi}/${n} verdi`);
process.exit(rossi ? 1 : 0);
