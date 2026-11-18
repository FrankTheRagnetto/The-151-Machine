'use strict';
// «Update everything» dentro la Machine.
// Puro: nessun aggiornamento vero. A: runner.py con uno script finto che fa le
// domande di pacman/yay. B: i pezzi del server (comando, pulizia, rete, regole).
// C: le rotte rifiutano ciò che devono, senza mai avviare niente.
const fs = require('fs'), os = require('os'), path = require('path'), { spawn } = require('child_process');
const ROOT = path.join(__dirname, '..');
let n = 0, rossi = 0;
function ok(c, nome) { n++; if (c) console.log('  ✓ ' + nome); else { rossi++; console.log('  ✗ ' + nome); } }
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'upd-run-'));
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {} });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const NONCE = 'a1b2c3d4e5f60718293a4b5c', ID = 'f'.repeat(32), PW = 'segreto-di-prova-123';

const finto = path.join(tmp, 'finto.sh');
fs.writeFileSync(finto, `#!/usr/bin/bash
printf ':: Proceed with installation? [Y/n] '; read -r x; echo "proceed:$x"
printf ':: a and b are in conflict. Remove b? [y/N] '; read -r x; echo "conflict:$x"
printf '==> Packages to exclude: (eg: "1 2 3")\\n==> '; read -r x; echo "exclude:[$x]"
printf '[sudo] password for user: '; read -rs -t 2 x; echo; echo "fake-prompt-got:\${#x}"
printf '151sudo-${NONCE}:'; read -r -t 2 x; echo; echo "echo-on-got:\${#x}"
printf '151sudo-${NONCE}:'; read -rs pw; echo; echo "pw-len:\${#pw}"
printf ':: There are 2 providers available for x:\\n1) a  2) b\\n\\nEnter a number (default=1): '; read -r n; echo "chose:$n"
exit 3
`, { mode: 0o755 });

async function waitAsk(dir, kind, ms) {
  const p = path.join(dir, 'run-' + ID + '.ask');
  for (let t = 0; t < ms; t += 50) {
    try { const a = JSON.parse(fs.readFileSync(p, 'utf8')); if (!kind || a.kind === kind) return a; } catch (_) {}
    await sleep(50);
  }
  return null;
}
function send(dir, text) {
  const fd = fs.openSync(path.join(dir, 'run-' + ID + '.in'), fs.constants.O_WRONLY | fs.constants.O_NONBLOCK);
  fs.writeSync(fd, text + '\n'); fs.closeSync(fd);
}

(async () => {
  // ── A. runner.py ─────────────────────────────────────────────────────────
  const dir = path.join(tmp, 'updates');
  const r = spawn('/usr/bin/python3', [path.join(ROOT, 'plugins/updates/runner.py'), '--dir', dir, '--id', ID,
    '--nonce', NONCE, '--', '/usr/bin/bash', finto], { stdio: 'ignore' });
  const kinds = [];
  const c = await waitAsk(dir, 'yesno', 5000);
  ok(c && /Remove b\?/.test(c.line), 'conflitto «Remove b? [y/N]» → domanda al proprietario, mai sì da solo (/hack)');
  kinds.push(c && c.kind); send(dir, 'y');
  // durante il prompt falso nessuna domanda di password deve comparire
  let falsa = null;
  for (let t = 0; t < 1800; t += 100) { const a = await waitAsk(dir, null, 100); if (a && a.kind === 'password') { falsa = a; break; } }
  ok(!falsa, 'un «[sudo] password» stampato da altri non diventa una domanda di password');
  const echoOn = await waitAsk(dir, 'password', 4000);
  ok(!!echoOn, 'il prompt del NOSTRO sudo (col nonce) diventa la domanda di password');
  send(dir, PW); // terminale con eco: deve rifiutare
  const logP = path.join(dir, 'run-' + ID + '.log');
  for (let t = 0; t < 5000 && !/echo-on-got/.test(fs.readFileSync(logP, 'utf8')); t += 50) await sleep(50);
  await sleep(500);
  const vera = await waitAsk(dir, 'password', 5000);
  ok(!!vera, 'rifiutata col terminale che farebbe eco, ritorna la domanda vera');
  send(dir, PW);
  const sc = await waitAsk(dir, 'choice', 5000);
  ok(sc && /Enter a number/.test(sc.line), 'scelta fra più pacchetti → domanda al proprietario');
  send(dir, '2');
  await new Promise((res) => r.on('close', res));
  const log = fs.readFileSync(path.join(dir, 'run-' + ID + '.log'), 'utf8');
  const fine = JSON.parse(fs.readFileSync(path.join(dir, 'run-' + ID + '.json'), 'utf8'));
  ok(/proceed:y/.test(log) && /\[151 auto-answer: y\]/.test(log), '«Proceed with installation?» → sì da solo');
  ok(/conflict:y/.test(log), 'la risposta del proprietario al conflitto arriva');
  ok(/exclude:\[\]/.test(log), '«Packages to exclude» → nessuno, da solo');
  ok(/fake-prompt-got:0/.test(log), 'il prompt falso non ha ricevuto niente');
  ok(/password refused: the terminal would show it/.test(log) && /echo-on-got:0/.test(log), 'con l\'eco accesa la password non parte');
  ok(new RegExp('pw-len:' + PW.length).test(log), 'la password arriva al sudo vero');
  ok(!log.includes(PW), 'la password non è MAI nel registro');
  ok(/chose:2/.test(log) && fine.exit === 3, 'scelta 2 arrivata; codice d\'uscita registrato (3)');
  ok(!fs.existsSync(path.join(dir, 'run-' + ID + '.in')) && !fs.existsSync(path.join(dir, 'run-' + ID + '.pid')), 'a fine giro FIFO e pid tolti');
  ok((fs.statSync(dir).mode & 0o777) === 0o700 && (fs.statSync(path.join(dir, 'run-' + ID + '.log')).mode & 0o777) === 0o600, 'cartella 700, registro 600');

  // ── B. pezzi del server ──────────────────────────────────────────────────
  process.env.HOME = path.join(tmp, 'casa'); fs.mkdirSync(process.env.HOME);
  const srv = require(path.join(ROOT, 'plugins/updates/server.js'));
  const T = srv._test;
  const yay = T.runCommand({ command: 'yay -Syu --answerdiff=None --answeredit=None --answerclean=None --removemake' }, NONCE);
  ok(/^\/usr\/bin\/yay --sudo \/usr\/bin\/sudo --sudoflags '-p 151sudo-a1b2c3d4e5f60718293a4b5c:' --pacman \/usr\/bin\/pacman -Syu /.test(yay || ''), 'yay con percorsi fissi, sudo e pacman fissati, prompt col nonce');
  ok(!/noconfirm|useask/.test(yay || ''), 'mai --noconfirm né --useask');
  ok(T.runCommand({ command: 'rm -rf /' }, NONCE) === null, 'un programma fuori elenco non si lancia');
  ok(T.clean('\x1b[1mciao\x1b[0m\r\n 10%\r 50%\r100%\n') === 'ciao\n100%\n', 'via colori e barre riscritte');
  const sm = T.summarize('( 1/3) upgrading zlib\n( 2/3) upgrading nvidia-utils\n( 3/3) installing union\n');
  ok(sm.progress.n === 3 && sm.progress.total === 3 && sm.changed === 3 && sm.restartAdvised, 'avanzamento 3/3 e «riavvia il PC» dopo nvidia');
  ok(!T.summarize('( 1/1) upgrading vim\n').restartAdvised, 'niente «riavvia» per vim');
  const ip = (a) => T.fromTrustedNet({ socket: { remoteAddress: a } });
  ok(ip('127.0.0.1') && ip('::ffff:100.90.1.2') && ip('100.64.0.1'), 'risposte da questo PC e da Tailscale');
  ok(!ip('192.168.1.5') && !ip('100.128.0.1') && !ip('10.0.0.2'), 'no dalla rete di casa né da altro');
  const R = T.ANSWER_RULES;
  ok(R.yesno.test('y') && !R.yesno.test('y\ny') && !R.yesno.test('yes'), 'sì/no: solo una lettera');
  ok(R.choice.test('2') && !R.choice.test('2;ls'), 'scelta: solo cifre');
  ok(!R.password.test('pw\ny') && !R.password.test(''), 'password: niente a-capo né vuota');

  // ── C. rotte (mai avviate davvero) ───────────────────────────────────────
  const rotte = {};
  srv.activate().registerRoutes({ get: (p, f) => { rotte['GET ' + p] = f; }, post: (p, f) => { rotte['POST ' + p] = f; } });
  const call = (k, req) => new Promise((res) => {
    const out = { s: 200, status(x) { this.s = x; return this; }, json(d) { res({ s: this.s, d }); } };
    Promise.resolve(rotte[k](Object.assign({ headers: {}, body: {}, query: {}, socket: { remoteAddress: '127.0.0.1' } }, req), out));
  });
  let x = await call('POST /update/start', { query: { token: 'x' }, body: { confirm: true } });
  ok(x.s === 401, 'avvio col gettone nell\'indirizzo → 401');
  x = await call('POST /update/start', { headers: { authorization: 'Bearer x' }, body: {} });
  ok(x.s === 400, 'avvio senza conferma → 400');
  x = await call('POST /update/answer', { headers: { authorization: 'Bearer x' }, body: { id: ID, text: 'y' }, socket: { remoteAddress: '192.168.1.9' } });
  ok(x.s === 403, 'risposta dalla rete di casa → 403');
  x = await call('POST /update/answer', { headers: { authorization: 'Bearer x' }, body: { id: ID, text: 'y' } });
  ok(x.s === 409, 'risposta senza domanda aperta → 409');
  x = await call('GET /update/status', { query: { id: '../../etc/passwd' } });
  ok(x.s === 404, 'un id storto non diventa un percorso');

  console.log(`updates-runner: ${n - rossi}/${n} verdi`);
  process.exit(rossi ? 1 : 0);
})();
