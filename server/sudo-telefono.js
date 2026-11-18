'use strict';
// Sudo dal telefono («I cannot run commands from here that
// require my sudo password. I'd like to insert it from the app»).
//
// Il giro, in quattro passi:
//   1. Una sessione lancia `sudo …` senza terminale. Il guscio
//      tools/sudo-telefono/sudo (in ~/.local/bin, primo nel PATH delle
//      sessioni) lo rilancia come `/usr/bin/sudo -A` con l'aiutante
//      tools/sudo-telefono/chiedi.js come SUDO_ASKPASS.
//   2. L'aiutante bussa a POST /api/sudo/chiedi e aspetta. Passa solo se
//      viene dal PC, non da una pagina web, e il padre di chi bussa è il
//      sudo vero (uid effettivo 0): vedi chiamanteVero qui sotto.
//   3. Ogni schermo collegato riceve {type:'sudo_chiede'} e mostra la casella
//      (public/js/sudo-telefono.js). il proprietario scrive la password o annulla:
//      POST /api/sudo/rispondi, con il gettone (JWT) come ogni rotta.
//   4. La password torna all'aiutante in risposta al passo 2, e da lì a sudo.
//
// Cosa NON fa, apposta: non salva la password, non la scrive in nessun log,
// non la manda via WebSocket (va solo nella risposta HTTP all'aiutante che
// l'ha chiesta), non la dà a Claude (l'aiutante la scrive a sudo, non alla
// sessione). Nessuno schermo collegato → «no» subito, sudo fallisce come prima.
// Prova: tests/sudo-telefono.test.js
const crypto = require('crypto');
const fs = require('fs');

// ─── Chi bussa? (/hack 07/11: «chiedi.js dà la password a chiunque lo lanci»)
// Solo il sudo VERO può avere la password: dalla porta d'origine del socket si
// trova il processo che ha aperto la connessione (/proc/net/tcp → inode →
// /proc/<pid>/fd), e suo padre deve essere `sudo` con uid EFFETTIVO 0 — un
// processo dell'utente non può averlo. Il comando mostrato lo legge il server
// da /proc/<padre>/cmdline: il corpo della richiesta non conta.
function inodeDelSocket(portaClient, portaServer) {
  const hex = (n) => n.toString(16).toUpperCase().padStart(4, '0');
  for (const f of ['/proc/net/tcp', '/proc/net/tcp6']) {
    let righe = [];
    try { righe = fs.readFileSync(f, 'utf8').split('\n').slice(1); } catch (_) { continue; }
    for (const r of righe) {
      const c = r.trim().split(/\s+/);
      if (c.length < 10) continue;
      if (c[1].endsWith(':' + hex(portaClient)) && c[2].endsWith(':' + hex(portaServer))) return c[9];
    }
  }
  return null;
}
function pidDelSocket(inode) {
  const cerca = `socket:[${inode}]`;
  for (const pid of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(pid)) continue;
    let fds = [];
    try { fds = fs.readdirSync(`/proc/${pid}/fd`); } catch (_) { continue; }
    for (const fd of fds) {
      try { if (fs.readlinkSync(`/proc/${pid}/fd/${fd}`) === cerca) return Number(pid); } catch (_) {}
    }
  }
  return null;
}
function chiamanteVero(req) {
  const s = req.socket || {};
  const inode = inodeDelSocket(s.remotePort, s.localPort);
  if (!inode) return { ok: false, perche: 'socket non trovato' };
  const pid = pidDelSocket(inode);
  if (!pid) return { ok: false, perche: 'processo non trovato' };
  let padre = 0;
  try { padre = Number(fs.readFileSync(`/proc/${pid}/stat`, 'utf8').replace(/^.*\)\s+/, '').split(' ')[1]); } catch (_) {}
  if (!padre) return { ok: false, perche: 'padre non trovato' };
  let stato = '';
  try { stato = fs.readFileSync(`/proc/${padre}/status`, 'utf8'); } catch (_) {}
  const nome = (stato.match(/^Name:\s*(.*)$/m) || [])[1];
  const uid = ((stato.match(/^Uid:\s*(.*)$/m) || [])[1] || '').split(/\s+/);
  if (nome !== 'sudo' || uid[1] !== '0') return { ok: false, perche: 'il padre non è sudo' };
  let comando = '';
  try {
    comando = fs.readFileSync(`/proc/${padre}/cmdline`, 'utf8').split('\0').filter(Boolean).join(' ')
      .replace(/^(\S*\/)?sudo\s+-A\s+/, 'sudo ');
  } catch (_) {}
  return { ok: true, comando: comando || 'sudo' };
}

// Una pagina web non deve poter bussare (DNS rebinding, /hack 07/11): niente
// Origin né Sec-Fetch-*, e Host esattamente 127.0.0.1/localhost:<porta>.
function daPagina(req) {
  const h = req.headers || {};
  if (h.origin || h['sec-fetch-site'] || h['sec-fetch-mode']) return true;
  const porta = req.socket && req.socket.localPort;
  return !(h.host === `127.0.0.1:${porta}` || h.host === `localhost:${porta}`);
}

const ATTESA_MS = 120000;     // poi sudo riceve «no»
const MAX_APERTE = 3;         // più richieste insieme = qualcosa non va
const MAX_COMANDO = 400;
const MAX_PASSWORD = 1024;

function createSudoTelefono({ getWss, isTokenValid, isLoopback, titoloDi = () => null, attesaMs = ATTESA_MS, chiamante = chiamanteVero }) {
  const aperte = new Map();   // id → { res, timer, mostra }

  function schermi() {
    const wss = getWss();
    const vivi = [];
    if (wss && wss.clients) wss.clients.forEach((c) => { if (c.readyState === 1) vivi.push(c); });
    return vivi;
  }
  function manda(obj, a) {
    const s = JSON.stringify(obj);
    for (const c of a || schermi()) { try { c.send(s); } catch (_) {} }
  }
  function chiudi(id, stato, corpo) {
    const p = aperte.get(id);
    if (!p) return false;
    aperte.delete(id);
    clearTimeout(p.timer);
    if (!p.res.headersSent) {
      p.res.set('Cache-Control', 'no-store');
      p.res.status(stato).json(corpo);
    }
    manda({ type: 'sudo_chiuso', id });
    return true;
  }

  function chiedi(req, res) {
    const ip = (req.socket && req.socket.remoteAddress) || '';
    if (!isLoopback(ip)) return res.status(403).json({ error: 'solo dal PC' });
    if (daPagina(req)) return res.status(403).json({ error: 'non da una pagina web' });
    let chi = { ok: false, perche: 'errore' };
    try { chi = chiamante(req); } catch (_) {}
    if (!chi.ok) {
      console.log(`[SUDO] rifiutata: ${chi.perche}`);
      return res.status(403).json({ error: 'solo il sudo vero' });
    }
    if (aperte.size >= MAX_APERTE) return res.status(429).json({ error: 'troppe richieste aperte' });
    const vivi = schermi();
    if (!vivi.length) return res.status(503).json({ error: 'nessuno schermo collegato' });

    const body = req.body || {};
    const comando = String(chi.comando || 'sudo').replace(/[\u0000-\u001f]+/g, ' ').trim().slice(0, MAX_COMANDO);
    const sessione = typeof body.sessione === 'string' ? body.sessione.slice(0, 80) : '';
    let titolo = null;
    try { titolo = titoloDi(sessione) || null; } catch (_) {}
    const id = crypto.randomBytes(12).toString('hex');
    const mostra = { type: 'sudo_chiede', id, comando, titolo, scade: Date.now() + attesaMs };
    const timer = setTimeout(() => chiudi(id, 408, { error: 'nessuna risposta' }), attesaMs);
    aperte.set(id, { res, timer, mostra });
    // sudo interrotto (Ctrl-C, sessione fermata): la casella sparisce.
    res.on('close', () => { if (!res.writableFinished) chiudi(id, 499, { error: 'abbandonata' }); });
    console.log(`[SUDO] richiesta ${id.slice(0, 6)} → ${vivi.length} schermo/i: ${comando.slice(0, 80)}`);
    manda(mostra, vivi);
  }

  function rispondi(req, res) {
    const auth = req.headers.authorization || '';
    if (!auth.startsWith('Bearer ') || !isTokenValid(auth.slice(7))) return res.status(401).json({ error: 'Unauthorized' });
    const body = req.body || {};
    const id = typeof body.id === 'string' ? body.id : '';
    if (!aperte.has(id)) return res.status(404).json({ error: 'richiesta già chiusa' });
    if (body.annulla === true) {
      chiudi(id, 403, { error: 'annullata' });
      console.log(`[SUDO] richiesta ${id.slice(0, 6)} annullata`);
      return res.json({ ok: true });
    }
    const password = typeof body.password === 'string' ? body.password : '';
    if (!password || password.length > MAX_PASSWORD || /[\r\n\u0000]/.test(password)) {
      return res.status(400).json({ error: 'password non valida' });
    }
    chiudi(id, 200, { password });
    console.log(`[SUDO] richiesta ${id.slice(0, 6)} risposta`);   // mai la password
    res.json({ ok: true });
  }

  // Schermo che si (ri)collega: rivede le richieste ancora aperte.
  function alCollegamento(ws) {
    setTimeout(() => {
      if (ws.readyState !== 1) return;
      for (const p of aperte.values()) manda(p.mostra, [ws]);
    }, 50);
  }

  return { chiedi, rispondi, alCollegamento, _aperte: aperte };
}

module.exports = { createSudoTelefono, chiamanteVero, ATTESA_MS };
