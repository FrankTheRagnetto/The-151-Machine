'use strict';
// Le novità dopo una consegna.
//
// Prima /api/changelog mostrava i titoli dei commit: gergo, numeri delle prove,
// fino a 10 righe lunghe. Adesso la finestra mostra SOLO le righe scritte per
// il proprietario dentro il corpo del commit:
//
//     Novità: The update window is short now; tap anywhere to close it.
//
// Un commit senza quella riga non compare. Nessuna riga = nessuna finestra.
//
// Il limite alto è il commit SERVITO (HEAD all'avvio del server), non l'HEAD
// del disco: un commit non ancora consegnato non è una novità sul telefono.
// Il limite basso lo porta il client (`?since=`): ogni apparecchio ricorda
// l'ultima versione vista, quindi PC e telefono vedono le novità tutti e due e
// una GET (rotta pubblica) non cambia niente sul server.

const { execFile, execFileSync } = require('child_process');

const MAX_RIGHE = 3;
const MAX_CARATTERI = 100;
const RIGA_RE = /^\s*novit[àa]\s*:\s*(.+?)\s*$/i;
const HASH_RE = /^[0-9a-f]{7,40}$/;

function estraiNovita(corpo) {
  const righe = [];
  for (const riga of String(corpo || '').split('\n')) {
    const m = RIGA_RE.exec(riga);
    if (!m) continue;
    let testo = m[1];
    if (testo.length > MAX_CARATTERI) testo = testo.slice(0, MAX_CARATTERI - 1).trimEnd() + '…';
    righe.push(testo);
  }
  return righe;
}

function headAllAvvio(repoDir) {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir, encoding: 'utf-8', timeout: 5000 }).trim();
  } catch (e) {
    return null;
  }
}

function creaRotta(repoDir, head) {
  return function novita(req, res) {
    if (!head) return res.json({ head: null, changes: [] });
    const since = String((req.query && req.query.since) || '');
    // Primo giro di questo apparecchio: impara dove siamo, non mostra niente.
    if (!HASH_RE.test(since) || head.startsWith(since)) return res.json({ head, changes: [] });
    execFile('git', ['log', '--format=%B%x1e', '-50', since + '..' + head], {
      cwd: repoDir, encoding: 'utf-8', timeout: 5000,
    }, (err, stdout) => {
      if (err) return res.json({ head, changes: [] });
      const tutte = [];
      // git log va dal più nuovo al più vecchio: la finestra vuole lo stesso ordine.
      for (const corpo of stdout.split('\x1e')) tutte.push(...estraiNovita(corpo));
      const changes = tutte.slice(0, MAX_RIGHE);
      res.json({ head, changes, more: Math.max(0, tutte.length - changes.length) });
    });
  };
}

module.exports = { estraiNovita, headAllAvvio, creaRotta, MAX_RIGHE };
