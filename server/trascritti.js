'use strict';
// =============================================================================
// server/trascritti.js — l'archivio dei trascritti COMPLETI.
//
// Perché esiste: Claude Code cancella da solo ogni trascritto vero
// (~/.claude/projects/<cartella>/<id>.jsonl, con ogni passo, comando ed esito)
// dopo 30 giorni (cleanupPeriodDays). Il cestino della Machine tiene per sempre
// solo la copia leggera (messaggi, nomi degli strumenti, token). Il 03/11 581
// sessioni su 915 avevano già perso il trascritto vero.
//
// Cosa fa:
//   archivia  — copia OGNI trascritto (sessioni, aiutanti `claude -p`, subagenti)
//               in ~/.local/share/the-151-machine/trascritti/<cartella>/<id>.jsonl.zst. Senza
//               perdite: niente tolto (immagini comprese), zstd, e la copia vale
//               solo se, decompressa, è IDENTICA byte per byte alla sorgente letta.
//               Scritta come .part e rinominata solo dopo la prova (un troncato
//               col nome buono non nasce mai). Rifatta quando la sorgente cambia.
//   raccolta  — quando uno studio ha «raccolto» una sessione: scrive la copia
//               leggera (trascritti/leggere/<id>.txt, resta per sempre), annota
//               nel giornale raccolte.jsonl (il testimone, PRIMA di togliere),
//               poi toglie la copia completa. Il giornale impedisce che il giro
//               successivo la ricopi; se la sessione riprende e la sorgente cambia,
//               la parte nuova torna completa.
//   stato     — quante copie, quanto pesano.
//
// Il server la chiama in un processo a parte (CPU e memoria fuori dal server):
// all'avvio, ogni 6 ore, e alla cancellazione di una sessione (solo quella).
// Leggere una copia: zstdcat <file>.jsonl.zst (o zlib.zstdDecompressSync).
// =============================================================================

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { spawn } = require('child_process');

// L'archivio NON sta in ~/.151machine: quella cartella finisce nel backup
// notturno (tools/backup-state.sh), e i trascritti contengono dati sensibili
// nelle uscite dei comandi (controllo /hack del 03/11). Resta fuori da ogni
// backup finché il proprietario non decide come proteggerlo.
function percorsiDiBase(home = os.homedir()) {
  return {
    sorgente: path.join(home, '.claude', 'projects'),
    archivio: path.join(home, '.local', 'share', 'the-151-machine', 'trascritti'),
  };
}

// Import opzionale mai muto: senza zstd in Node non si archivia, e lo si dice.
function zstdDisponibile() {
  return typeof zlib.zstdCompressSync === 'function' && typeof zlib.zstdDecompressSync === 'function';
}

// Ogni .jsonl sotto la sorgente, a qualsiasi profondità (subagents/ compresi).
function elencaSorgenti(sorgente) {
  const out = [];
  const giro = (dir) => {
    let voci;
    try { voci = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const v of voci) {
      const p = path.join(dir, v.name);
      if (v.isDirectory()) giro(p);
      else if (v.isFile() && v.name.endsWith('.jsonl')) out.push(p);
    }
  };
  giro(sorgente);
  return out;
}

function idDa(p) { return path.basename(p, '.jsonl'); }

function leggiRaccolte(archivio) {
  const mappa = new Map(); // rel -> ultima voce
  let testo = '';
  try { testo = fs.readFileSync(path.join(archivio, 'raccolte.jsonl'), 'utf-8'); } catch { return mappa; }
  for (const riga of testo.split('\n')) {
    if (!riga.trim()) continue;
    try { const v = JSON.parse(riga); if (v && v.rel) mappa.set(v.rel, v); } catch { /* riga rotta: si salta */ }
  }
  return mappa;
}

// Una copia completa, provata. Ritorna 'nuova' | 'rifatta' | 'uguale' | 'raccolta'.
function archiviaFile(src, { sorgente, archivio, raccolte, livello = 3 }) {
  const rel = path.relative(sorgente, src);
  const dest = path.join(archivio, rel + '.zst');
  const st = fs.statSync(src);
  const r = raccolte && raccolte.get(rel);
  // Gli orari della copia hanno il millesimo, la sorgente il nanosecondo: 1 ms di tolleranza.
  if (r && st.mtimeMs < r.mtimeMs + 1) return 'raccolta';
  let esisteva = false;
  try {
    const d = fs.statSync(dest);
    esisteva = true;
    // La copia porta l'orario della sorgente letta: uguale = niente di nuovo.
    if (Math.abs(d.mtimeMs - st.mtimeMs) < 1) return 'uguale';
  } catch { /* nessuna copia ancora */ }

  // L'orario è quello di PRIMA della lettura: se la sessione scrive mentre leggo,
  // la sorgente risulta più nuova della copia e il giro dopo la rifà intera.
  const mtimeLetto = st.mtimeMs;
  const dati = fs.readFileSync(src);
  const compresso = zlib.zstdCompressSync(dati, {
    params: { [zlib.constants.ZSTD_c_compressionLevel]: livello, [zlib.constants.ZSTD_c_checksumFlag]: 1 },
  });
  // Senza perdite, provato: decompresso deve essere identico a ciò che è stato letto.
  if (!zlib.zstdDecompressSync(compresso).equals(dati)) throw new Error(`copia non identica: ${rel}`);

  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const part = `${dest}.${process.pid}.part`;
  try {
    fs.writeFileSync(part, compresso);
    if (fs.statSync(part).size !== compresso.length) throw new Error(`scrittura corta: ${rel}`);
    const t = new Date(mtimeLetto);
    fs.utimesSync(part, t, t);
    fs.renameSync(part, dest);
  } catch (e) {
    try { fs.unlinkSync(part); } catch { /* già via */ }
    throw e;
  }
  return esisteva ? 'rifatta' : 'nuova';
}

// soloId: archivia solo i file di quella sessione (<id>.jsonl e <id>/**).
function archivia({ sorgente, archivio, soloId = null, livello = 3 } = {}) {
  const base = percorsiDiBase();
  sorgente = sorgente || base.sorgente;
  archivio = archivio || base.archivio;
  if (!zstdDisponibile()) throw new Error('zstd non c\'è in questo Node: archivio dei trascritti FERMO');
  const raccolte = leggiRaccolte(archivio);
  const conto = { nuova: 0, rifatta: 0, uguale: 0, raccolta: 0, errori: [] };
  for (const src of elencaSorgenti(sorgente)) {
    if (soloId) {
      const rel = path.relative(sorgente, src).split(path.sep);
      if (idDa(src) !== soloId && !rel.includes(soloId)) continue;
    }
    try { conto[archiviaFile(src, { sorgente, archivio, raccolte, livello })]++; }
    catch (e) { conto.errori.push(`${path.relative(sorgente, src)}: ${e.message}`); }
  }
  return conto;
}

// --- La copia leggera: messaggi, nomi degli strumenti, token -----------------
function testoDi(contenuto) {
  if (typeof contenuto === 'string') return contenuto;
  if (!Array.isArray(contenuto)) return '';
  return contenuto.filter(b => b && b.type === 'text').map(b => b.text).join('\n');
}

function copiaLeggera(righeJsonl, id) {
  const L = [];
  const token = { entrata: 0, uscita: 0, cache_letta: 0, cache_creata: 0 };
  const visti = new Set();
  let primo = null, ultimo = null, titolo = null;
  for (const riga of righeJsonl.split('\n')) {
    if (!riga.trim()) continue;
    let v; try { v = JSON.parse(riga); } catch { continue; }
    if (v.timestamp) { primo = primo || v.timestamp; ultimo = v.timestamp; }
    if (v.type === 'summary' && v.summary) titolo = titolo || v.summary;
    const m = v.message;
    if (!m) continue;
    if (v.type === 'user' && m.role === 'user') {
      const t = testoDi(m.content);
      if (t.trim()) { L.push('', '[USER]', t); }
    } else if (v.type === 'assistant') {
      const t = testoDi(m.content);
      if (t.trim()) { L.push('', '[CLAUDE]', t); }
      const strumenti = Array.isArray(m.content) ? m.content.filter(b => b && b.type === 'tool_use').map(b => b.name) : [];
      if (strumenti.length) L.push(`(tools used: ${strumenti.join(', ')})`);
      // Una risposta arriva su più righe con lo stesso id: i token si contano una volta.
      if (m.usage && !visti.has(m.id)) {
        visti.add(m.id);
        token.entrata += m.usage.input_tokens || 0;
        token.uscita += m.usage.output_tokens || 0;
        token.cache_letta += m.usage.cache_read_input_tokens || 0;
        token.cache_creata += m.usage.cache_creation_input_tokens || 0;
      }
    }
  }
  const testa = [
    `Session:  ${id}`,
    titolo ? `Title:    ${titolo}` : null,
    `From:     ${primo || '?'}`,
    `To:       ${ultimo || '?'}`,
    `Tokens:   input ${token.entrata} · output ${token.uscita} · cache read ${token.cache_letta} · cache created ${token.cache_creata}`,
    'Light copy: the full transcript was harvested by a study and removed.',
    '='.repeat(64),
  ].filter(Boolean);
  return testa.concat(L, ['']).join('\n');
}

function scriviAtomico(dest, dati) {
  const tmp = `${dest}.${process.pid}.tmp`;
  try { fs.writeFileSync(tmp, dati); fs.renameSync(tmp, dest); }
  catch (e) { try { fs.unlinkSync(tmp); } catch { /* già via */ } throw e; }
}

// Uno studio ha raccolto la sessione `id`: torna alla copia leggera.
function raccolta(id, { sorgente, archivio, studio = null } = {}) {
  const base = percorsiDiBase();
  sorgente = sorgente || base.sorgente;
  archivio = archivio || base.archivio;
  if (!/^[A-Za-z0-9_-]+$/.test(String(id))) throw new Error(`id non valido: ${id}`);
  // Le copie complete di questa sessione: <id>.jsonl.zst e tutto sotto <id>/.
  const copie = [];
  const giro = (dir) => {
    let voci; try { voci = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const v of voci) {
      const p = path.join(dir, v.name);
      if (v.isDirectory()) { if (v.name !== 'leggere') giro(p); }
      else if (v.name.endsWith('.jsonl.zst')) {
        const rel = path.relative(archivio, p).slice(0, -4); // senza .zst
        const pezzi = rel.split(path.sep);
        if (path.basename(rel, '.jsonl') === id || pezzi.includes(id)) copie.push({ p, rel });
      }
    }
  };
  giro(archivio);
  if (!copie.length) return { id, tolte: 0, leggera: null };

  // 1. La copia leggera, dal trascritto principale (non dai subagenti).
  const principale = copie.find(c => path.basename(c.rel, '.jsonl') === id) || copie[0];
  const testo = zlib.zstdDecompressSync(fs.readFileSync(principale.p)).toString('utf-8');
  const dirLeggere = path.join(archivio, 'leggere');
  fs.mkdirSync(dirLeggere, { recursive: true });
  const leggera = path.join(dirLeggere, `${id}.txt`);
  scriviAtomico(leggera, copiaLeggera(testo, id));

  // 2. Il testimone PRIMA di togliere: una riga per copia nel giornale.
  const quando = new Date().toISOString();
  const giornale = path.join(archivio, 'raccolte.jsonl');
  const righe = copie.map(c => {
    const buf = fs.readFileSync(c.p);
    return JSON.stringify({
      rel: c.rel, id, quando, studio,
      mtimeMs: fs.statSync(c.p).mtimeMs,
      byte: buf.length,
      sha256: crypto.createHash('sha256').update(buf).digest('hex'),
    });
  });
  fs.appendFileSync(giornale, righe.join('\n') + '\n');
  const scritte = leggiRaccolte(archivio);
  for (const c of copie) if (!scritte.has(c.rel)) throw new Error(`giornale non scritto per ${c.rel}: non tolgo niente`);

  // 3. Solo ora si toglie la copia completa.
  for (const c of copie) fs.unlinkSync(c.p);
  return { id, tolte: copie.length, leggera };
}

function stato({ archivio } = {}) {
  archivio = archivio || percorsiDiBase().archivio;
  let n = 0, byte = 0, leggere = 0;
  const giro = (dir) => {
    let voci; try { voci = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const v of voci) {
      const p = path.join(dir, v.name);
      if (v.isDirectory()) giro(p);
      else if (v.name.endsWith('.jsonl.zst')) { n++; byte += fs.statSync(p).size; }
      else if (v.name.endsWith('.txt') && path.basename(dir) === 'leggere') leggere++;
    }
  };
  giro(archivio);
  return { complete: n, byte, leggere, raccolte: leggiRaccolte(archivio).size };
}

// Dal server: in un processo a parte, staccato, a bassa priorità. Mai bloccante.
function archiviaInSottofondo(soloId = null) {
  try {
    const args = [__filename, 'archivia'];
    if (soloId) args.push('--id', String(soloId));
    const logPath = path.join(percorsiDiBase().archivio, 'archivia.log');
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    const fd = fs.openSync(logPath, 'a');
    const figlio = spawn('nice', ['-n', '15', process.execPath, ...args], { stdio: ['ignore', fd, fd], detached: true });
    figlio.on('error', (e) => { try { fs.appendFileSync(logPath, `[${new Date().toISOString()}] avvio fallito: ${e.message}\n`); } catch {} });
    figlio.unref();
    fs.closeSync(fd);
  } catch (e) { console.error('[TRASCRITTI] archivio non avviato:', e.message); }
}

module.exports = { archivia, archiviaFile, raccolta, stato, copiaLeggera, archiviaInSottofondo, zstdDisponibile, percorsiDiBase };

// --- CLI ---------------------------------------------------------------------
//   node server/trascritti.js archivia [--id <id>]
//   node server/trascritti.js raccolta <id> [<id> …] [--studio <nome>]
//   node server/trascritti.js stato
if (require.main === module) {
  const [cmd, ...resto] = process.argv.slice(2);
  const opz = (nome) => { const i = resto.indexOf(nome); return i >= 0 ? resto[i + 1] : null; };
  const t0 = Date.now();
  try {
    if (cmd === 'archivia') {
      const c = archivia({ soloId: opz('--id') });
      console.log(`[${new Date().toISOString()}] archivia${opz('--id') ? ' ' + opz('--id') : ''}: nuove ${c.nuova} · rifatte ${c.rifatta} · uguali ${c.uguale} · raccolte ${c.raccolta} · errori ${c.errori.length} · ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      for (const e of c.errori) console.log('  ERRORE ' + e);
      process.exit(c.errori.length ? 1 : 0);
    } else if (cmd === 'raccolta') {
      const studio = opz('--studio');
      const ids = resto.filter((a, i) => !a.startsWith('--') && resto[i - 1] !== '--studio');
      if (!ids.length) { console.error('uso: raccolta <id> [<id> …] [--studio <nome>]'); process.exit(2); }
      for (const id of ids) {
        const r = raccolta(id, { studio });
        console.log(`${id}: ${r.tolte ? `tolte ${r.tolte} copie complete, leggera in ${r.leggera}` : 'nessuna copia completa (già raccolta o mai archiviata)'}`);
      }
    } else if (cmd === 'stato') {
      const s = stato();
      console.log(`complete ${s.complete} (${(s.byte / 1e6).toFixed(1)} MB) · leggere ${s.leggere} · voci nel giornale ${s.raccolte}`);
    } else {
      console.error('uso: node server/trascritti.js archivia [--id <id>] | raccolta <id>… [--studio <nome>] | stato');
      process.exit(2);
    }
  } catch (e) { console.error('ERRORE: ' + e.message); process.exit(1); }
}
