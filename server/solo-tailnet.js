'use strict';
// IL MURO D'INGRESSO: la Machine non chiede più la
// parola d'accesso. Risponde SOLO a chi arriva dal PC stesso (loopback) o dal
// Tailscale del proprietario (il tailnet ha solo apparecchi suoi), e a nessun altro:
// il Wi-Fi di casa, la LAN e il resto del mondo ricevono 403 (HTTP) o il
// socket chiuso (upgrade WebSocket).
//
// Si guarda SOLO l'indirizzo vero del socket (req.socket.remoteAddress). Mai le
// intestazioni X-Forwarded-*: davanti alla Machine non c'è nessun proxy
// (Tailscale serve/funnel spenti, niente 'trust proxy'), quindi quelle
// intestazioni le scrive chi chiama e valgono zero.
//
// Ammessi (correzioni /hack del 12/11 comprese):
//   · loopback      127.0.0.0/8, ::1, ::ffff:127.x.x.x — e solo se anche
//                   l'indirizzo LOCALE del socket è loopback;
//   · Tailscale v4  100.64.0.0/10, anche ::ffff:100.x; Tailscale v6
//                   fd7a:115c:a1e0::/48 — solo se l'indirizzo LOCALE è l'IP
//                   Tailscale del PC (un 100.x dal Wi-Fi/CGNAT non passa);
//   · e in più l'intestazione Host deve essere un nome del PC (localhost,
//     127.0.0.1, [::1], i suoi IP e nomi Tailscale): contro il DNS rebinding;
//   · su /api/login e sull'upgrade WS, Origin assente o nell'elenco esatto.
// Prova: tests/solo-tailnet.test.js

const net = require('net');

// 8 gruppi da 16 bit, o null. Gestisce «::», la coda IPv4 puntata e lo zone id.
function gruppiV6(s) {
  if (!net.isIPv6(s)) return null;
  let testo = s;
  let codaV4 = null;
  const m = testo.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (m) {
    if (!net.isIPv4(m[2])) return null;
    const o = m[2].split('.').map(Number);
    codaV4 = [(o[0] << 8) | o[1], (o[2] << 8) | o[3]];
    testo = m[1] + '0:0';
  }
  const doppio = testo.split('::');
  if (doppio.length > 2) return null;
  const parte = (x) => (x === '' ? [] : x.split(':'));
  const testa = parte(doppio[0]);
  const coda = doppio.length === 2 ? parte(doppio[1]) : [];
  const mancano = 8 - testa.length - coda.length;
  if (doppio.length === 1 && mancano !== 0) return null;
  if (mancano < 0) return null;
  const tutti = [...testa, ...new Array(doppio.length === 2 ? mancano : 0).fill('0'), ...coda].map((h) => parseInt(h, 16));
  if (tutti.length !== 8 || tutti.some((n) => !Number.isInteger(n) || n < 0 || n > 0xffff)) return null;
  if (codaV4) { tutti[6] = codaV4[0]; tutti[7] = codaV4[1]; }
  return tutti;
}

function v4Ammesso(a, b) {
  if (a === 127) return true;                       // loopback
  if (a === 100 && b >= 64 && b <= 127) return true; // Tailscale 100.64.0.0/10
  return false;
}

function pulisci(addr) {
  let s = String(addr == null ? '' : addr).trim().toLowerCase();
  const zona = s.indexOf('%');
  if (zona !== -1) s = s.slice(0, zona);
  return s;
}

// Forma unica di un indirizzo: IPv4 puntato (anche se arriva come ::ffff:a.b.c.d)
// oppure IPv6 a 8 gruppi pieni. null se non è un indirizzo.
function canon(addr) {
  const s = pulisci(addr);
  if (net.isIPv4(s)) return s;
  const g = gruppiV6(s);
  if (!g) return null;
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) {
    return [g[6] >> 8, g[6] & 0xff, g[7] >> 8, g[7] & 0xff].join('.');
  }
  return g.map((x) => x.toString(16)).join(':');
}

function eLoopback(addr) {
  const c = canon(addr);
  if (!c) return false;
  if (net.isIPv4(c)) return Number(c.split('.')[0]) === 127;
  return c === '0:0:0:0:0:0:0:1';
}

// L'indirizzo, da solo, cade negli intervalli ammessi? (puro, senza contesto)
function eAmmesso(addr) {
  const c = canon(addr);
  if (!c) return false;
  if (net.isIPv4(c)) {
    const o = c.split('.').map(Number);
    return v4Ammesso(o[0], o[1]);
  }
  if (c === '0:0:0:0:0:0:0:1') return true;
  const g = c.split(':').map((h) => parseInt(h, 16));
  return g[0] === 0xfd7a && g[1] === 0x115c && g[2] === 0xa1e0;
}

// ── CHI È IL PC SUL TAILSCALE (correzione /hack A e B, 12/11/2026) ─────────
// Posto UNICO della lista fissa. All'avvio si chiede a `tailscale status
// --json` e si UNISCE a questa (se tailscale tace, resta questa).
// Optional, from .env: MACHINE_TAILSCALE_IPS / MACHINE_TAILSCALE_NAMES
// (comma separated, e.g. «100.101.102.103» and «my-pc,my-pc.example.ts.net»).
// Empty is fine: `tailscale status --json` fills them in at startup.
const lista = (v) => String(v || '').split(',').map((x) => x.trim()).filter(Boolean);
const TAILSCALE_FISSO = {
  ip: lista(process.env.MACHINE_TAILSCALE_IPS),
  nomi: lista(process.env.MACHINE_TAILSCALE_NAMES).map((x) => x.toLowerCase()),
};

function leggiTailscale(esegui) {
  const ip = new Set(TAILSCALE_FISSO.ip);
  const nomi = new Set(TAILSCALE_FISSO.nomi);
  try {
    const run = esegui || ((cmd, args) => require('child_process').execFileSync(cmd, args, { timeout: 2000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
    const st = JSON.parse(run('tailscale', ['status', '--json']));
    const self = (st && st.Self) || {};
    for (const a of self.TailscaleIPs || []) if (canon(a)) ip.add(a);
    if (self.HostName) nomi.add(String(self.HostName).toLowerCase());
    if (self.DNSName) nomi.add(String(self.DNSName).toLowerCase().replace(/\.$/, ''));
  } catch { /* tailscale assente o muto: vale la lista fissa */ }
  return { ip: [...ip], nomi: [...nomi] };
}

// Il socket è ammesso? Contro il 100.x che arriva dal Wi-Fi (CGNAT, hotspot):
//   · da loopback solo se anche l'indirizzo LOCALE è loopback;
//   · da Tailscale solo se l'indirizzo LOCALE è l'IP Tailscale del PC, cioè se
//     la connessione è entrata davvero da tailscale0.
function socketAmmesso(remoto, locale, ipTailscale) {
  if (!eAmmesso(remoto)) return false;
  if (eLoopback(remoto)) return eLoopback(locale);
  const l = canon(locale);
  if (!l) return false;
  for (const a of ipTailscale || []) if (canon(a) === l) return true;
  return false;
}

// Host dell'intestazione (con o senza :porta, IPv6 tra parentesi) → forma unica.
function hostDi(intestazione) {
  let h = pulisci(intestazione);
  if (!h) return null;
  if (h.startsWith('[')) {
    const fine = h.indexOf(']');
    if (fine === -1) return null;
    const dentro = h.slice(1, fine);
    const resto = h.slice(fine + 1);
    if (resto && !/^:\d+$/.test(resto)) return null;
    return canon(dentro);
  }
  const pezzi = h.split(':');
  if (pezzi.length > 2) return null;
  if (pezzi.length === 2 && !/^\d+$/.test(pezzi[1])) return null;
  h = pezzi[0].replace(/\.$/, '');
  return canon(h) || h;
}

// Contro il DNS rebinding: una pagina di un sito cattivo che fa risolvere il
// suo nome a 127.0.0.1 arriva da loopback ma con Host «evil.example».
function creaHostAmmessi(ts) {
  const set = new Set();
  for (const h of ['localhost', '127.0.0.1', '::1', ...(ts.ip || []), ...(ts.nomi || [])]) {
    const c = hostDi(String(h).includes(':') && !String(h).startsWith('[') ? '[' + h + ']' : h);
    if (c) set.add(c);
  }
  return set;
}

// Il muro: un middleware Express per HTTP e un controllo per l'upgrade WS.
// Il log è UNA riga per indirizzo ogni `intervalloLogMs`, e la mappa ha un
// tetto: chi bussa a raffica non inonda il log né la memoria.
//   tailscale: { ip, nomi } del PC (leggiTailscale())
//   origini:   Set delle origini ammesse (server/cors-origins.js, ALLOWED_ORIGINS)
function creaMuro({ tailscale = TAILSCALE_FISSO, origini = new Set(), log = console.warn, intervalloLogMs = 10 * 60 * 1000, ora = Date.now } = {}) {
  const ipTs = tailscale.ip || [];
  const hostOk = creaHostAmmessi(tailscale);
  const ultimoLog = new Map();
  function annota(addr, motivo, percorso, tipo) {
    const t = ora();
    const k = String(addr);
    const prima = ultimoLog.get(k);
    if (prima !== undefined && t - prima < intervalloLogMs) return;
    if (ultimoLog.size >= 500) ultimoLog.clear();
    ultimoLog.set(k, t);
    try { log(`[muro] rifiutato ${tipo} da ${k} (${motivo}) → ${String(percorso || '').slice(0, 120)}`); } catch {}
  }

  function passa(req) {
    const sock = req.socket || {};
    if (!socketAmmesso(sock.remoteAddress, sock.localAddress, ipTs)) return 'indirizzo';
    const h = hostDi(req.headers && req.headers.host);
    if (!h || !hostOk.has(h)) return 'host';
    return null;
  }

  // Origin assente (curl, app native) oppure dentro l'elenco esatto.
  function origineAmmessa(req) {
    const o = req.headers && req.headers.origin;
    if (o === undefined) return true;
    return typeof o === 'string' && origini.has(o);
  }

  function http(req, res, next) {
    const no = passa(req);
    if (!no) return next();
    annota(req.socket && req.socket.remoteAddress, no === 'host' ? 'host ' + String(req.headers.host).slice(0, 60) : no, req.originalUrl || req.url, 'HTTP');
    res.statusCode = 403;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Connection', 'close');
    res.end('Not on your Tailscale\n');
  }

  // true = passa; false = socket già distrutto.
  function upgrade(req, socket) {
    let no = passa(req);
    if (!no && !origineAmmessa(req)) no = 'origin';
    if (!no) return true;
    annota(socket && socket.remoteAddress, no, req && req.url, 'WS');
    try { socket.destroy(); } catch {}
    return false;
  }

  // Per /api/login: stesso muro, più l'origine.
  function richiestaAmmessa(req) {
    return !passa(req) && origineAmmessa(req);
  }

  return { http, upgrade, richiestaAmmessa, origineAmmessa, hostAmmessi: hostOk };
}

module.exports = { eAmmesso, eLoopback, canon, socketAmmesso, hostDi, leggiTailscale, creaMuro, TAILSCALE_FISSO };
