'use strict';
// [17/10/2026] La chiave del session-host (controllo di sicurezza /hack,
// punto 1). Vive in ~/.151machine/session-host.key, permessi 600: la legge
// solo l'utente del proprietario. Nasce da sola la prima volta che uno dei due lati
// (session-host o Machine) la cerca; nessuno la stampa mai.
// Il primo messaggio di ogni collegamento al session-host è
// {type:'hello', key}; chi non la manda giusta viene chiuso.
// Prova: tests/session-host-chiave.test.js.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

function keyPath() {
  return path.join(os.homedir(), '.151machine', 'session-host.key');
}

// Legge la chiave; se non c'è la crea (atomica: file temporaneo + link, così
// due processi che nascono insieme finiscono con la STESSA chiave).
function loadOrCreateKey() {
  const p = keyPath();
  try {
    const k = fs.readFileSync(p, 'utf8').trim();
    if (k) return k;
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, crypto.randomBytes(32).toString('hex') + '\n', { mode: 0o600 });
  try { fs.linkSync(tmp, p); }
  catch (e) { if (e.code !== 'EEXIST') { try { fs.unlinkSync(tmp); } catch {} throw e; } }
  try { fs.unlinkSync(tmp); } catch {}
  try { fs.chmodSync(p, 0o600); } catch {}
  return fs.readFileSync(p, 'utf8').trim();
}

// Confronto a tempo costante (sha256 di entrambe: lunghezze uguali sempre).
function keyMatches(given, key) {
  if (typeof given !== 'string' || typeof key !== 'string' || !key) return false;
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(key).digest();
  return crypto.timingSafeEqual(a, b);
}

module.exports = { keyPath, loadOrCreateKey, keyMatches };
