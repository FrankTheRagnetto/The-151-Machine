'use strict';
// [17/10/2026] Le origini di cui la Machine si fida per il CORS: un elenco
// ESATTO (controllo di sicurezza /hack, punto 2). Prima bastava che il nome
// cominciasse con «http://10.», «http://100.» o «http://192.168.»: anche
// «http://10.sito-cattivo.com» passava. Adesso entrano solo:
//   - l'app della Machine sul telefono (Capacitor) e il PC su localhost;
//   - gli indirizzi VERI di questa macchina (rete di casa, Tailscale) con la
//     sua porta — letti dalle schede di rete all'avvio.
// La pagina aperta dal proprietario parla con la sua stessa origine: per lei il CORS
// non serve, l'elenco riguarda solo chi chiama da un'ALTRA origine.
// Prova: tests/origini-esatte.test.js.
const os = require('os');

const FISSE = ['capacitor://localhost', 'http://localhost', 'https://localhost'];

// altriHost (12/11/2026, correzione /hack B): i nomi e gli IP Tailscale del PC
// (server/solo-tailnet.js) — l'app Android carica da
// http://my-pc.example.ts.net:3170 e quella è la sua origine.
function buildAllowedOrigins(port, interfaces = os.networkInterfaces(), altriHost = []) {
  const set = new Set(FISSE);
  set.add(`http://localhost:${port}`);
  for (const h of altriHost || []) {
    if (!h) continue;
    set.add(String(h).includes(':') ? `http://[${h}]:${port}` : `http://${h}:${port}`);
  }
  for (const lista of Object.values(interfaces || {})) {
    for (const i of lista || []) {
      if (i && i.family === 'IPv4' && i.address) set.add(`http://${i.address}:${port}`);
    }
  }
  return set;
}

function isAllowedOrigin(origin, set) {
  return typeof origin === 'string' && !!set && set.has(origin);
}

module.exports = { buildAllowedOrigins, isAllowedOrigin };
