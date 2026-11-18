'use strict';
// Comandi nella chat («can we make it so I can run normal
// commands in chat too? Always have to write run?»).
//
// Un messaggio che comincia con «!» non va a Claude: il PC lo esegue subito
// (bash -lc, nella cartella della sessione), l'uscita compare nella chat come
// messaggio «PC», e Claude risponde da solo subito dopo (,
// scelta A: «Always reply after a ! command»), senza nessuna bolla «tu»; se
// Claude sta già lavorando, l'uscita gli arriva in testa al suo prossimo turno.
// Se il comando chiede sudo, il guscio di tools/sudo-telefono
// apre la casella della password (SUDO_TELEFONO=1).
// Il motore è quello del vecchio plugin Terminal (tolto lo stesso giorno):
// un comando alla volta per sessione, timeout che uccide tutto il gruppo,
// uscita tagliata a 200 KB, nessuna tastiera (stdin chiuso: nano/htop no).
// Prova: tests/comando-chat.test.js
const { spawn } = require('child_process');
const os = require('os');
const crypto = require('crypto');

const MAX_OUT = 200 * 1024;
const TIMEOUT_S = 600;          // pacman -Syu ci sta; la casella di sudo aspetta 120 s
const MAX_CMD = 4000;
const PER_CLAUDE = 8000;        // quanta uscita vede Claude (la coda, che dice com'è finita)
// Il turno che parte da solo dopo il comando.
const RISVEGLIO = 'The user just ran the command above themselves with «!». Reply to them now about its result in plain words; if it was a step you asked them for, carry on with the work.';

function eComando(testo) {
  return typeof testo === 'string' && /^!\s*\S/.test(testo) && !/^!!/.test(testo);
}

function runCommand(cmd, { cwd, env, timeoutS = TIMEOUT_S } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    let out = '';
    let cut = false;
    let timedOut = false;
    const child = spawn('bash', ['-lc', cmd], {
      cwd: cwd || os.homedir(), env: env || process.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const add = (buf) => {
      if (out.length >= MAX_OUT) { cut = true; return; }
      out += buf.toString('utf8');
      if (out.length > MAX_OUT) { out = out.slice(0, MAX_OUT); cut = true; }
    };
    child.stdout.on('data', add);
    child.stderr.on('data', add);
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid, 'SIGTERM'); } catch (_) {}
      setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch (_) {} }, 3000).unref();
    }, timeoutS * 1000);
    const end = (code, signal, error) => {
      clearTimeout(timer);
      resolve({ code: code === null || code === undefined ? null : code, signal: signal || null,
        timedOut, cut, ms: Date.now() - started, out: error ? (out + error) : out });
    };
    child.on('error', (e) => end(null, null, `\n[PC] could not start: ${e.message}`));
    child.on('close', (code, signal) => end(code, signal));
  });
}

// Il messaggio «PC» nella chat: comando, esito, uscita in un blocco di codice
// con una recinzione più lunga di ogni fila di ` nell'uscita.
function formatta(cmd, r) {
  const sec = (r.ms / 1000).toFixed(r.ms < 10000 ? 1 : 0);
  const esito = r.timedOut ? `stopped after ${Math.round(r.ms / 1000)} s`
    : (r.code === 0 ? 'done' : (r.code === null ? 'stopped' : `exit ${r.code}`));
  const testo = (r.out || '').replace(/\s+$/, '') || '(no output)';
  const lunga = Math.max(3, ...((testo.match(/`+/g) || []).map((x) => x.length + 1)));
  const rec = '`'.repeat(lunga);
  return `**$ ${cmd.replace(/[*_`]/g, (c) => '\\' + c)}** · ${esito} · ${sec} s` +
    (r.cut ? ' · output cut at 200 KB' : '') + `\n\n${rec}text\n${testo}\n${rec}`;
}

function perClaude(cmd, r) {
  let o = (r.out || '').replace(/\s+$/, '');
  if (o.length > PER_CLAUDE) o = '[…cut…]\n' + o.slice(-PER_CLAUDE);
  const esito = r.timedOut ? 'stopped by timeout' : `exit ${r.code === null ? '?' : r.code}`;
  return `[The user ran this command themselves with «!» in the chat (not you), for context:\n$ ${cmd}\n(${esito})\n${o || '(no output)'}\n]`;
}

function createComandoChat({ manager, sendToSession, run = runCommand, risveglia = null }) {
  const occupate = new Set();

  async function esegui({ ws, sessionId, testo, nonce }) {
    const cmd = testo.replace(/^!\s*/, '').trim();
    const manda = (o) => { try { ws.send(JSON.stringify(o)); } catch (_) {} };
    const s = manager.sessions.get(sessionId);
    if (!s) return manda({ type: 'error', message: 'Session not found' });
    if (cmd.length > MAX_CMD) return manda({ type: 'error', message: 'Command too long' });
    if (occupate.has(sessionId)) return manda({ type: 'error', message: 'A command is still running in this chat' });

    const userEntry = { role: 'user', content: testo, timestamp: Date.now() };
    if (nonce) userEntry.nonce = nonce;
    s.history.push(userEntry);
    s.lastActivity = new Date(); // una Date come ovunque: _serializeAll chiama .toISOString()
    manager.saveSync();
    manda({ type: 'ack', nonce: nonce || null }); // : l'outbox toglie QUESTO messaggio
    sendToSession(sessionId, { type: 'user_message', content: testo, attachments: [], nonce: nonce || null,
      timestamp: userEntry.timestamp }, { exclude: ws });

    const id = crypto.randomBytes(6).toString('hex');
    occupate.add(sessionId);
    sendToSession(sessionId, { type: 'comando_via', id, cmd });
    console.log(`[COMANDO] ${sessionId.slice(0, 8)} via (${cmd.length} caratteri)`);
    let r;
    try {
      const env = Object.assign({}, process.env, { SUDO_TELEFONO: '1' });
      if (s.claudeSessionId) env.CLAUDE_CODE_SESSION_ID = s.claudeSessionId;
      r = await run(cmd, { cwd: s.workingDirectory || os.homedir(), env });
    } finally { occupate.delete(sessionId); }

    const content = formatta(cmd, r);
    const entry = { role: 'comando', content, timestamp: Date.now(), code: r.code };
    s.history.push(entry);
    if (!Array.isArray(s._comandiPerClaude)) s._comandiPerClaude = [];
    s._comandiPerClaude.push(perClaude(cmd, r));
    if (s._comandiPerClaude.length > 5) s._comandiPerClaude.shift();
    manager.saveSync();
    sendToSession(sessionId, { type: 'comando_esito', id, content, code: r.code, timestamp: entry.timestamp });
    console.log(`[COMANDO] ${sessionId.slice(0, 8)} fine: ${r.timedOut ? 'timeout' : 'exit ' + r.code} in ${r.ms} ms`);
    // Claude risponde da solo: chi chiama decide se è libero.
    if (typeof risveglia === 'function') {
      try { risveglia(sessionId, RISVEGLIO); } catch (e) { console.error('[COMANDO] Claude non è partito:', e && e.message); }
    }
  }

  return { esegui, _occupate: occupate };
}

// Per session-manager.sendMessage: i comandi del proprietario in testa al prossimo prompt.
function prendiPerClaude(session) {
  if (!session || !Array.isArray(session._comandiPerClaude) || !session._comandiPerClaude.length) return '';
  const t = session._comandiPerClaude.join('\n\n');
  session._comandiPerClaude = [];
  return t;
}

module.exports = { createComandoChat, eComando, runCommand, formatta, perClaude, prendiPerClaude, RISVEGLIO };
