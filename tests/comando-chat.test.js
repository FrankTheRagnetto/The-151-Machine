// «!comando» nella chat: il PC lo esegue, l'uscita compare
// come messaggio «PC», Claude risponde da solo subito dopo (,
// scelta A; se è occupato la vede al turno dopo). Sostituisce il plugin
// Terminal (tolto lo stesso giorno): le sue prove del motore sono qui.
//   A. il motore: uscita+stderr, codice, timeout che ferma tutto, taglio a 200 KB
//   B. cosa è un comando (!ls sì; «!», «!!», testo normale no)
//   C. il giro sul server: storia (tu + PC), ack, eco agli altri schermi,
//      «running» e esito, cartella della sessione, SUDO_TELEFONO=1, uno alla volta
//   D. Claude lo vede UNA volta, in testa al prossimo prompt
//   F. Claude risponde da solo dopo il comando (risveglia), senza bolla «tu»,
//      e il telefono aperto mostra subito il «sta pensando»
//   E. i fili: ws-handler intercetta PRIMA della coda/stop; input.js non ferma
//      Claude; ws.js disegna; chat.js scrive «PC»; Terminal fuori dal pannello
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const cc = require('../server/comando-chat');

const ROOT = path.join(__dirname, '..');
const leggi = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let n = 0, rossi = 0;
async function t(nome, fn) {
  n++;
  try { await fn(); console.log('  ✓ ' + nome); }
  catch (e) { rossi++; console.log('  ✗ ' + nome + '\n    ' + (e && e.message)); }
}

(async () => {
  await t('A1 uscita (anche stderr) e codice 0; codice 3 resta 3', async () => {
    const r = await cc.runCommand('echo ciao; echo err >&2', { cwd: os.tmpdir() });
    assert.strictEqual(r.code, 0); assert.ok(/ciao/.test(r.out) && /err/.test(r.out));
    assert.strictEqual((await cc.runCommand('exit 3')).code, 3);
  });
  await t('A2 timeout: si ferma entro il limite, figli compresi', async () => {
    const t0 = Date.now();
    const r = await cc.runCommand('sleep 30; echo mai', { timeoutS: 1 });
    assert.ok(r.timedOut && Date.now() - t0 < 6000 && !/mai/.test(r.out));
  });
  await t('A3 uscita tagliata a 200 KB; nessuna tastiera (stdin chiuso: cat finisce subito)', async () => {
    const r = await cc.runCommand('head -c 400000 /dev/zero | tr "\\0" x');
    assert.ok(r.cut && r.out.length <= 200 * 1024);
    const c = await cc.runCommand('cat', { timeoutS: 5 });
    assert.ok(!c.timedOut && c.code === 0, 'un programma che aspetta la tastiera non resta appeso');
  });

  await t('B è un comando: «!ls» e «! ls» sì; «!», «!!», «ciao», «hey!» no', () => {
    assert.ok(cc.eComando('!ls ~/Downloads') && cc.eComando('! ls'));
    for (const x of ['!', '!!', '!! ls', 'ciao', 'hey!', '', null]) assert.ok(!cc.eComando(x), String(x));
  });

  function finto() {
    const s = { id: 'sess-1', history: [], workingDirectory: '/tmp', claudeSessionId: 'cid-9' };
    const manager = { sessions: new Map([['sess-1', s]]), saveSync() { this.salvate = (this.salvate || 0) + 1; } };
    const mandati = [], aWs = [];
    const ws = { send: (x) => aWs.push(JSON.parse(x)) };
    const sendToSession = (sid, data, opt) => mandati.push({ sid, data, opt });
    return { s, manager, mandati, aWs, ws, sendToSession };
  }

  await t('C1 il giro: storia «tu» + «PC», ack, eco agli altri, running → esito, cartella e sudo della sessione', async () => {
    const f = finto();
    let visto = null;
    const chat = cc.createComandoChat({ manager: f.manager, sendToSession: f.sendToSession,
      run: async (cmd, o) => { visto = { cmd, o }; return { code: 0, out: 'file1\nfile2\n', ms: 12, timedOut: false, cut: false }; } });
    await chat.esegui({ ws: f.ws, sessionId: 'sess-1', testo: '!ls ~/Downloads', nonce: 'n1' });
    assert.strictEqual(visto.cmd, 'ls ~/Downloads');
    assert.strictEqual(visto.o.cwd, '/tmp', 'nella cartella della sessione');
    assert.strictEqual(visto.o.env.SUDO_TELEFONO, '1', 'sudo apre la casella');
    assert.strictEqual(visto.o.env.CLAUDE_CODE_SESSION_ID, 'cid-9', 'la casella dice quale sessione');
    assert.deepStrictEqual(f.s.history.map((h) => h.role), ['user', 'comando']);
    assert.strictEqual(f.s.history[0].content, '!ls ~/Downloads'); assert.strictEqual(f.s.history[0].nonce, 'n1');
    assert.ok(/file1\nfile2/.test(f.s.history[1].content) && /\$ ls ~\/Downloads/.test(f.s.history[1].content));
    assert.ok(f.aWs.some((x) => x.type === 'ack'));
    const tipi = f.mandati.map((m) => m.data.type);
    assert.deepStrictEqual(tipi, ['user_message', 'comando_via', 'comando_esito']);
    assert.strictEqual(f.mandati[0].opt.exclude, f.ws, 'l\'eco non torna a chi l\'ha scritto');
    assert.strictEqual(f.mandati[1].data.id, f.mandati[2].data.id);
    assert.ok(f.manager.salvate >= 2, 'salvato su disco');
  });

  await t('C2 un comando alla volta per chat; vietato troppo lungo', async () => {
    const f = finto();
    let sblocca;
    const chat = cc.createComandoChat({ manager: f.manager, sendToSession: f.sendToSession,
      run: () => new Promise((r) => { sblocca = () => r({ code: 0, out: '', ms: 1 }); }) });
    const primo = chat.esegui({ ws: f.ws, sessionId: 'sess-1', testo: '!sleep 1' });
    await chat.esegui({ ws: f.ws, sessionId: 'sess-1', testo: '!ls' });
    assert.ok(f.aWs.some((x) => x.type === 'error' && /still running/.test(x.message)));
    sblocca(); await primo;
    await chat.esegui({ ws: f.ws, sessionId: 'sess-1', testo: '!' + 'x'.repeat(5000) });
    assert.ok(f.aWs.some((x) => x.type === 'error' && /too long/.test(x.message)));
  });

  await t('D Claude vede il comando UNA volta, in testa al prossimo prompt (coda dell\'uscita, max 8000)', async () => {
    const f = finto();
    const chat = cc.createComandoChat({ manager: f.manager, sendToSession: f.sendToSession,
      run: async () => ({ code: 2, out: 'a'.repeat(20000) + 'FINE', ms: 5 }) });
    await chat.esegui({ ws: f.ws, sessionId: 'sess-1', testo: '!make' });
    const p = cc.prendiPerClaude(f.s);
    assert.ok(/The user ran this command themselves/.test(p) && /\$ make/.test(p) && /exit 2/.test(p) && /FINE/.test(p));
    assert.ok(p.length < 8500, 'tagliato per Claude');
    assert.strictEqual(cc.prendiPerClaude(f.s), '', 'una volta sola');
    const sm = leggi('server/session-manager.js');
    const iAll = sm.indexOf('prompt = `${header}\\n\\n${text}`;'), iCmd = sm.indexOf('prendiPerClaude(session)');
    assert.ok(iAll > 0 && iCmd > iAll, 'in testa DOPO gli allegati (che riscrivono il prompt)');
  });

  await t('D2 il messaggio «PC»: recinzione più lunga dei ` nell\'uscita; esito leggibile', () => {
    const m = cc.formatta('echo', { code: 0, out: 'a ```` b', ms: 300 });
    assert.ok(/`{5}text\n/.test(m) && /done/.test(m));
    assert.ok(/exit 1/.test(cc.formatta('false', { code: 1, out: '', ms: 1 })));
    assert.ok(/stopped after/.test(cc.formatta('x', { code: null, out: '', ms: 9000, timedOut: true })));
  });

  await t('E i fili: server, client, pannello', () => {
    const wsh = leggi('server/ws-handler.js');
    // Dal 10/11 coda e stop di Claude stanno in consegnaMessaggio, che
    // handleMessage chiama: il comando va intercettato PRIMA di quella chiamata.
    const iHm = wsh.indexOf('function handleMessage(');
    const iCmd = wsh.indexOf('eComando(msg.content)', iHm), iCons = wsh.indexOf('consegnaMessaggio(currentSessionId', iHm);
    const corpoCons = wsh.slice(wsh.indexOf('function consegnaMessaggio('), iHm);
    assert.ok(iHm > 0 && iCmd > iHm && iCons > iCmd, 'il comando passa PRIMA della coda e dello stop di Claude');
    assert.ok(/queueWaitingMessage\(/.test(corpoCons) && /stopMessage\(/.test(corpoCons), 'coda e stop vivono nella consegna');
    const inp = leggi('public/js/input.js');
    const iBr = inp.indexOf("/^!\\s*\\S/.test(text)"), iStr = inp.indexOf('if (streaming) {');
    assert.ok(iBr > 0 && iBr < iStr, 'un «!» non interrompe Claude mentre lavora');
    const br = inp.slice(iBr, inp.indexOf('return;\n  }', iBr));
    assert.ok(!/showThinkingState|setStreamingState/.test(br), 'niente «thinking» per un comando');
    assert.ok(/comando_via[\s\S]{0,40}comando_esito/.test(leggi('public/js/ws.js')));
    assert.ok(/role === 'comando' \? 'PC'/.test(leggi('public/js/chat.js')));
    assert.ok(!/pluginId: 'terminal'/.test(leggi('public/js/ui.js')), 'Terminal fuori dal pannello');
    assert.ok(!fs.existsSync(path.join(ROOT, 'plugins/terminal')), 'plugin Terminal tolto');
    assert.ok(/SUDO_TELEFONO:-}" = "1"/.test(leggi('tools/sudo-telefono/sudo')), 'il guscio di sudo riconosce i comandi della chat');
  });

  await t('F1 finito il comando, Claude parte da solo: risveglia UNA volta, dopo l\'esito, col testo RISVEGLIO', async () => {
    const f = finto();
    const sveglie = [];
    const chat = cc.createComandoChat({ manager: f.manager, sendToSession: f.sendToSession,
      run: async () => ({ code: 0, out: 'ok', ms: 1 }),
      risveglia: (sid, testo) => sveglie.push({ sid, testo, dopo: f.mandati.map((m) => m.data.type) }) });
    await chat.esegui({ ws: f.ws, sessionId: 'sess-1', testo: '!ls' });
    assert.strictEqual(sveglie.length, 1);
    assert.strictEqual(sveglie[0].sid, 'sess-1');
    assert.strictEqual(sveglie[0].testo, cc.RISVEGLIO);
    assert.ok(/Reply to them now/.test(cc.RISVEGLIO));
    assert.ok(sveglie[0].dopo.includes('comando_esito'), 'Claude parte DOPO che l\'esito è in chat');
    assert.ok(cc.prendiPerClaude(f.s).length > 0, 'l\'uscita è pronta per il prompt di Claude');
  });

  await t('F2 un risveglia che esplode non rompe il comando: esito mandato, esegui non lancia', async () => {
    const f = finto();
    const chat = cc.createComandoChat({ manager: f.manager, sendToSession: f.sendToSession,
      run: async () => ({ code: 0, out: 'ok', ms: 1 }),
      risveglia: () => { throw new Error('boom'); } });
    const err = console.error; console.error = () => {};
    try { await chat.esegui({ ws: f.ws, sessionId: 'sess-1', testo: '!ls' }); } finally { console.error = err; }
    assert.ok(f.mandati.some((m) => m.data.type === 'comando_esito'));
    assert.deepStrictEqual(f.s.history.map((h) => h.role), ['user', 'comando']);
  });

  await t('F3 il filo: ws-handler passa risveglia, rispetta il lavoro in corso, nessuna bolla «tu»', () => {
    const wsh = leggi('server/ws-handler.js');
    const i = wsh.indexOf('risveglia:'), iCrea = wsh.indexOf('createComandoChat({');
    assert.ok(i > iCrea && iCrea > 0, 'ws-handler passa risveglia a createComandoChat');
    const corpo = wsh.slice(i, wsh.indexOf('\n    },', i));
    const iBusy = corpo.indexOf('isSessionBusy(sid)) return'), iSend = corpo.indexOf('manager.sendMessage(');
    assert.ok(iBusy > 0 && iSend > iBusy, 'Claude occupato: non si interrompe, niente secondo turno');
    assert.ok(/sendMessage\(sid, testo, \[\], \{ skipUserAppend: true \}\)/.test(corpo), 'nessuna bolla «tu»');
    assert.ok(/broadcastSessionStatus\(sid, 'busy'\)/.test(corpo) && /spawnStreamHandler\(result\.process, sid\)/.test(corpo));
  });

  await t('F4 il telefono aperto mostra subito il «sta pensando» quando Claude parte da solo', () => {
    const wsj = leggi('public/js/ws.js');
    const iH = wsj.indexOf("msg.type === 'session_status_changed'");
    const corpo = wsj.slice(iH, wsj.indexOf("msg.type === 'session_read'", iH));
    const iIf = corpo.indexOf("msg.status === 'busy' && msg.sessionId === window.activeSessionId && !window.streaming");
    assert.ok(iH > 0 && iIf > 0, 'busy per la chat aperta, solo se non sta già scorrendo');
    const ramo = corpo.slice(iIf, corpo.indexOf('}', iIf));
    assert.ok(/setStreamingState\(true\)/.test(ramo) && /showThinkingState\(\)/.test(ramo), 'tasto rosso + bolla «sta pensando»');
    assert.ok(/skipUserAppend[\s\S]{0,400}«!comando» auto-reply/.test(leggi('server/session-manager.js')), 'il commento di skipUserAppend dice il vero');
  });

  // [08/11/2026] : comando-chat scriveva lastActivity = Date.now() (un
  // numero) e _serializeAll chiama .toISOString(): ogni saveSync falliva
  // («Sync save error: s.lastActivity?.toISOString is not a function»,
  // pm2-error.log 12:06:19 e 12:56:00) e sessions.json restava senza il comando
  // finché un altro turno non rimetteva una Date. Prova col SessionManager vero.
  await t('G il comando si salva davvero su disco (SessionManager vero, nessun «Sync save error»)', async () => {
    process.env.EVENTS_LOG = '0'; // i dati del proprietario fuori dalle prove: niente righe nel registro eventi
    const { SessionManager } = require('../server/session-manager');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'k4vq-'));
    const store = path.join(dir, 'sessions.json');
    const m = new SessionManager(store);
    const s = m.create({ title: 'prova', workingDirectory: dir });
    const errori = [];
    const err = console.error; console.error = (...a) => errori.push(a.join(' '));
    try {
      const chat = cc.createComandoChat({ manager: m, sendToSession: () => {},
        run: async () => ({ code: 0, out: 'file1', ms: 1 }) });
      await chat.esegui({ ws: { send() {} }, sessionId: s.id, testo: '!ls' });
      console.error = err;
      assert.ok(!errori.some((e) => /save error/i.test(e)), 'nessun errore di salvataggio: ' + errori.join(' | '));
      const scritto = JSON.parse(fs.readFileSync(store, 'utf8')).find((x) => x.id === s.id);
      assert.deepStrictEqual(scritto.history.map((h) => h.role), ['user', 'comando'], 'il comando è su disco');
      assert.ok(m.sessions.get(s.id).lastActivity instanceof Date, 'lastActivity resta una Date');
    } finally { console.error = err; fs.rmSync(dir, { recursive: true, force: true }); }
  });

  console.log(rossi ? `comando-chat: ${rossi}/${n} ROSSI` : `comando-chat: ${n}/${n} verdi`);
  process.exit(rossi ? 1 : 0);
})();
