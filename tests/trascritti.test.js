'use strict';
// — l'archivio dei trascritti completi (server/trascritti.js).
// Prova, su dati inventati al volo in una cartella usa-e-getta:
//   A. la copia è SENZA PERDITE: decompressa è identica byte per byte, immagini comprese;
//   B. una sorgente invariata non si ricopia; una cambiata sì;
//   C. gli aiutanti (subagents/) entrano, e --id prende solo quella sessione;
//   D. raccolta: copia leggera scritta (messaggi, nomi strumenti, token contati
//      una volta), giornale scritto, copia completa tolta;
//   E. dopo la raccolta il giro non la ricopia; se la sessione riprende, sì;
//   F. la cancellazione dal cestino avvia la copia (cablaggio in session-manager);
//   G. dal server parte davvero un processo a parte che archivia (casa finta).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { spawnSync } = require('child_process');
const T = require('../server/trascritti');

let ok = 0;
const prova = (nome, fn) => { fn(); ok++; console.log('  ✓ ' + nome); };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trascritti-'));
try {
  const sorgente = path.join(tmp, 'projects');
  const archivio = path.join(tmp, 'trascritti');
  const cart = path.join(sorgente, '-home-x');
  fs.mkdirSync(path.join(cart, 'sess-a', 'subagents'), { recursive: true });

  const immagine = crypto64(30000);
  const righe = [
    { type: 'user', timestamp: '2026-11-01T10:00:00Z', message: { role: 'user', content: 'ciao, guarda questa foto' } },
    { type: 'assistant', timestamp: '2026-11-01T10:00:05Z', message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'La guardo.' }], usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200 } } },
    { type: 'assistant', timestamp: '2026-11-01T10:00:06Z', message: { id: 'm1', role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls -la /segreto' } }], usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200 } } },
    { type: 'user', timestamp: '2026-11-01T10:00:07Z', message: { role: 'user', content: [{ type: 'tool_result', content: [{ type: 'text', text: 'ESITO-DEL-COMANDO' }, { type: 'image', source: { type: 'base64', data: immagine } }] }] } },
    { type: 'assistant', timestamp: '2026-11-01T10:00:09Z', message: { id: 'm2', role: 'assistant', content: [{ type: 'text', text: 'Fatto il controllo.' }], usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 } } },
  ].map(r => JSON.stringify(r)).join('\n') + '\n';
  const srcA = path.join(cart, 'sess-a.jsonl');
  const subA = path.join(cart, 'sess-a', 'subagents', 'agent-1.jsonl');
  const srcB = path.join(cart, 'sess-b.jsonl');
  fs.writeFileSync(srcA, righe);
  fs.writeFileSync(subA, '{"type":"user","message":{"role":"user","content":"aiutante"}}\n');
  fs.writeFileSync(srcB, '{"type":"user","message":{"role":"user","content":"altra"}}\n');
  const zA = path.join(archivio, '-home-x', 'sess-a.jsonl.zst');
  const zSub = path.join(archivio, '-home-x', 'sess-a', 'subagents', 'agent-1.jsonl.zst');
  const zB = path.join(archivio, '-home-x', 'sess-b.jsonl.zst');

  prova('C. --id archivia solo quella sessione (con i suoi aiutanti)', () => {
    const c = T.archivia({ sorgente, archivio, soloId: 'sess-a' });
    assert.strictEqual(c.nuova, 2, JSON.stringify(c));
    assert.ok(fs.existsSync(zA) && fs.existsSync(zSub) && !fs.existsSync(zB));
  });

  prova('A. senza perdite: identica byte per byte, immagine compresa', () => {
    const giu = zlib.zstdDecompressSync(fs.readFileSync(zA));
    assert.ok(giu.equals(fs.readFileSync(srcA)));
    assert.ok(giu.toString().includes(immagine) && giu.toString().includes('ESITO-DEL-COMANDO'));
    assert.ok(fs.readdirSync(path.dirname(zA)).every(f => !f.endsWith('.part')), 'nessun .part lasciato');
  });

  prova('B. invariata non si ricopia, cambiata sì', () => {
    let c = T.archivia({ sorgente, archivio });
    assert.deepStrictEqual([c.nuova, c.rifatta, c.uguale], [1, 0, 2], JSON.stringify(c));
    fs.appendFileSync(srcB, '{"type":"user","message":{"role":"user","content":"ancora"}}\n');
    const futuro = new Date(Date.now() + 5000); fs.utimesSync(srcB, futuro, futuro);
    c = T.archivia({ sorgente, archivio });
    assert.deepStrictEqual([c.nuova, c.rifatta, c.uguale], [0, 1, 2], JSON.stringify(c));
    assert.ok(zlib.zstdDecompressSync(fs.readFileSync(zB)).equals(fs.readFileSync(srcB)));
  });

  prova('D. raccolta: leggera scritta, giornale scritto, completa tolta', () => {
    const r = T.raccolta('sess-a', { sorgente, archivio, studio: 'prova' });
    assert.strictEqual(r.tolte, 2);
    assert.ok(!fs.existsSync(zA) && !fs.existsSync(zSub) && fs.existsSync(zB));
    const leggera = fs.readFileSync(path.join(archivio, 'leggere', 'sess-a.txt'), 'utf-8');
    assert.ok(leggera.includes('ciao, guarda questa foto') && leggera.includes('Fatto il controllo.'));
    assert.ok(leggera.includes('(tools used: Bash)'));
    assert.ok(!leggera.includes('ESITO-DEL-COMANDO') && !leggera.includes(immagine.slice(0, 50)), 'la leggera non porta esiti né immagini');
    assert.ok(leggera.includes('input 11 · output 7 · cache read 1003 · cache created 204'), 'token contati una volta per risposta: ' + leggera.split('\n')[4]);
    const giornale = fs.readFileSync(path.join(archivio, 'raccolte.jsonl'), 'utf-8').trim().split('\n').map(JSON.parse);
    assert.strictEqual(giornale.length, 2);
    assert.ok(giornale.every(g => g.id === 'sess-a' && g.studio === 'prova' && /^[0-9a-f]{64}$/.test(g.sha256)));
    assert.strictEqual(T.stato({ archivio }).leggere, 1);
  });

  prova('E. raccolta non si ricopia; se la sessione riprende torna completa', () => {
    let c = T.archivia({ sorgente, archivio });
    assert.strictEqual(c.raccolta, 2, JSON.stringify(c));
    assert.ok(!fs.existsSync(zA));
    fs.appendFileSync(srcA, '{"type":"user","message":{"role":"user","content":"ripresa"}}\n');
    const futuro = new Date(Date.now() + 10000); fs.utimesSync(srcA, futuro, futuro);
    c = T.archivia({ sorgente, archivio });
    assert.strictEqual(c.nuova, 1, JSON.stringify(c));
    assert.ok(zlib.zstdDecompressSync(fs.readFileSync(zA)).equals(fs.readFileSync(srcA)));
  });

  prova('D2. id strano rifiutato, nessuna copia → niente tolto', () => {
    assert.throws(() => T.raccolta('../x', { sorgente, archivio }));
    assert.strictEqual(T.raccolta('mai-vista', { sorgente, archivio }).tolte, 0);
  });

  prova('F. cancellare una sessione avvia la copia completa del suo trascritto', () => {
    const sm = fs.readFileSync(path.join(__dirname, '..', 'server', 'session-manager.js'), 'utf-8');
    const corpo = sm.slice(sm.indexOf('  trashAndClose(id) {'), sm.indexOf('  _renderTranscript(s) {'));
    assert.ok(/archiviaInSottofondo\(session\.claudeSessionId\)/.test(corpo), 'trashAndClose deve chiamare archiviaInSottofondo');
    assert.ok(corpo.indexOf('_writeTrash(session)') < corpo.indexOf('archiviaInSottofondo'), 'dopo la copia leggera');
    const idx = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf-8');
    assert.ok(/archiviaInSottofondo\(\), 6 \* 60 \* 60 \* 1000\)/.test(idx), 'giro ogni 6 ore');
  });

  prova('G. dal server parte un processo a parte che archivia davvero', () => {
    const casa = path.join(tmp, 'casa');
    const cartCasa = path.join(casa, '.claude', 'projects', '-home-y');
    fs.mkdirSync(cartCasa, { recursive: true });
    fs.writeFileSync(path.join(cartCasa, 'sess-z.jsonl'), righe);
    const mod = path.join(__dirname, '..', 'server', 'trascritti.js');
    const r = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(mod)}).archiviaInSottofondo('sess-z')`], { env: { ...process.env, HOME: casa } });
    assert.strictEqual(r.status, 0, String(r.stderr));
    const arch = path.join(casa, '.local', 'share', 'the-151-machine', 'trascritti');
    const dest = path.join(arch, '-home-y', 'sess-z.jsonl.zst');
    const log = path.join(arch, 'archivia.log');
    assert.ok(!arch.includes('.151machine'), 'mai dentro la cartella che va in chiaro su Hetzner');
    const fine = Date.now() + 15000;
    while (Date.now() < fine && !(fs.existsSync(log) && /nuove 1/.test(fs.readFileSync(log, 'utf-8')))) spawnSync('sleep', ['0.2']);
    assert.ok(fs.existsSync(dest), 'copia nata dal processo a parte: ' + (fs.existsSync(log) ? fs.readFileSync(log, 'utf-8') : 'nessun log'));
    assert.ok(zlib.zstdDecompressSync(fs.readFileSync(dest)).equals(Buffer.from(righe)));
  });

  console.log(`trascritti: ${ok}/8 verdi`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

function crypto64(n) { return require('crypto').randomBytes(n).toString('base64'); }
