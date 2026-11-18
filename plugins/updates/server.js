'use strict';
/**
 * The 151 Machine — Updates plugin (server)
 * ===================================================================
 * It answers one question per channel — "what is old?" — and hands back the
 * exact command to paste in a terminal. No sudoers rules, no stored password,
 * no restart buttons. ONE exception since 16/10/2026 (il proprietario, reviewed by
 * /hack): «Update everything» runs those same commands for him in a
 * pseudo-terminal (runner.py) and asks HIM for sudo's password and the real
 * choices — see the block above startUpdate().
 *
 * ── Why there are TWO machines here ────────────────────────────────
 * [2026-08-17] The first version answered only for the box that happened
 * to SERVE the request. From the phone the app is served by the Pi, so
 * the owner read "Arch — not installed" and 3 npm packages: true answers about
 * the WRONG machine, with nothing on screen saying which. The fix is not
 * to merge the two, it is to name them: every payload now carries the
 * identity of the machine it describes, and the panel shows one block per
 * machine. A command belongs to exactly one machine, always.
 *
 * [2026-10-16] The Pi is unplugged: the hardware check that told the
 * Pi from the PC is gone, and so are the two Pi-only channels (apt and the
 * Raspberry Pi firmware). History: git log -- plugins/updates/server.js.
 *
 * ── [2026-10-12] Only THIS machine ─────────────────────────────────
 * Until today the panel also asked the other machine (the Machine on the
 * Pi) for its block, over the peer-relay contract (x-relay-secret +
 * x-151-relay-hop, route /peer). The Machine no longer runs on the Pi
 *, so that half is gone: the panel shows the machine that
 * serves it, named. History: git log -- plugins/updates/server.js.
 *
 * ── The rule about commands — noise vs real choices ────────────────
 * Silence the NOISE, always let a REAL choice through.
 *
 *   Arch (yay). Noise, silenced forever:
 *     · "show the code diff?"            → --answerdiff=None
 *     · "edit the build instructions?"   → --answeredit=None
 *     · "rebuild from a clean checkout?" → --answerclean=None
 *     · "remove the build dependencies?" → --removemake
 *   A REAL choice that must reach the owner:
 *     · ":: There are N providers available for X:" — which provider to
 *       install. This already bit us once (a prisma package where the
 *       English variant had to be chosen by hand; a muted run would have
 *       silently taken provider #1, possibly Korean).
 *   So: NEVER --noconfirm (answers EVERY prompt, provider included) and
 *   NEVER --useask (hands conflict/provider resolution to pacman's --ask).
 *   Verified on yay v13.0.1 via `yay -P --currentconfig`: our four flags
 *   move answerdiff/answeredit/answerclean to "None" and removemake to
 *   "yes", and leave `useask: false` untouched.
 *
 * ── Detection is dynamic ───────────────────────────────────────────
 * Channels are probed at request time on whichever box is answering. A
 * tool that is not installed is reported "absent" and never shown as
 * actionable, so the same code keeps working if a channel appears or
 * disappears tomorrow.
 */

const { execFile, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

// These probes hit the network (AUR RPC, npm registry). Generous ceiling;
// everything runs in parallel.
const EXEC_TIMEOUT_MS = 120000;
const MAX_BUFFER = 8 * 1024 * 1024;

function run(cmd, args) {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      {
        timeout: EXEC_TIMEOUT_MS,
        maxBuffer: MAX_BUFFER,
        // LC_ALL=C keeps the parsers immune to locale-translated output.
        env: Object.assign({}, process.env, { LC_ALL: 'C' }),
      },
      (err, stdout, stderr) => {
        resolve({
          code: err && typeof err.code === 'number' ? err.code : err ? -1 : 0,
          stdout: stdout || '',
          stderr: stderr || '',
          timedOut: !!(err && err.killed),
        });
      }
    );
  });
}

function has(bin) {
  return run('/bin/sh', ['-c', 'command -v ' + bin + ' >/dev/null 2>&1']).then((r) => r.code === 0);
}

// "name 1.2-3 -> 1.2-4 [extra]" → { name, from, to }
function parseArrowLines(text) {
  const out = [];
  for (const raw of String(text).split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/^(\S+)\s+(\S+)\s+->\s+(\S+)/);
    if (m) out.push({ name: m[1], from: m[2], to: m[3] });
  }
  return out;
}

// ── Machine identity ────────────────────────────────────────────────
// One machine since 2026-10-16: the Computer. Hostname and OS stay live.
function detectMachine() {
  let pretty = '';
  try {
    const m = fs.readFileSync('/etc/os-release', 'utf-8').match(/^PRETTY_NAME="?([^"\n]+)"?/m);
    if (m) pretty = m[1];
  } catch {}

  return {
    role: 'computer',
    label: 'Computer',
    hostname: os.hostname(),
    os: pretty || os.platform() + ' ' + os.release(),
  };
}

// ── The upgrade commands ────────────────────────────────────────────
// Arch: repo and AUR are ONE transaction. A partial upgrade (-Sy pkg, or AUR
// without the repos) is the classic way to break an Arch box, so this is always
// a full -Syu and is never split per channel.
const ARCH_CMD =
  'yay -Syu --answerdiff=None --answeredit=None --answerclean=None --removemake';
const CHANNELS = [
  {
    id: 'arch',
    name: 'Arch — system + AUR',
    bin: 'yay',
    command: ARCH_CMD,
    short: 'The operating system: official repositories + AUR packages.',
    what:
      'Everything from the official repositories (core, extra, multilib, ' +
      'endeavouros) plus the packages built from the AUR. The most important ' +
      'channel: kernel, drivers, libraries, browsers.',
    does:
      'Syncs the lists and updates EVERYTHING in one transaction. On Arch ' +
      'a partial update breaks the system, so repos and AUR always go ' +
      'together, never apart.',
    silences:
      'Only the questions with a fixed answer: viewing code diffs ' +
      '(--answerdiff=None), editing build files ' +
      '(--answeredit=None), clean rebuilds (--answerclean=None), removing ' +
      'build dependencies (--removemake). It does NOT use --noconfirm or ' +
      '--useask: the final confirm and above all the provider choice ' +
      '("There are N providers available for X") still reach you.',
    async probe() {
      // Repo side: `checkupdates` builds its OWN temporary database, so it is
      // fresh AND safe — it never touches /var/lib/pacman/sync, so it can never
      // leave the box in a partial-upgrade state.
      // AUR side: `yay -Qua` queries the AUR RPC directly for foreign packages,
      // so it is fresh even when the local sync db is days old.
      const hasCheck = await has('checkupdates');
      const [repo, aur] = await Promise.all([
        hasCheck ? run('checkupdates', []) : Promise.resolve(null),
        run('yay', ['-Qua']),
      ]);

      const repoItems = repo ? parseArrowLines(repo.stdout) : [];
      const aurItems = parseArrowLines(aur.stdout);
      const notes = [];
      if (!hasCheck) {
        notes.push(
          'pacman-contrib is not installed: the official repositories cannot be ' +
            'checked without touching the system database. Showing the AUR only.'
        );
      }
      if (repo && repo.timedOut) notes.push('The repository check timed out.');
      if (aur.timedOut) notes.push('The AUR check timed out.');

      return {
        items: repoItems
          .map((i) => Object.assign({ group: 'repo' }, i))
          .concat(aurItems.map((i) => Object.assign({ group: 'AUR' }, i))),
        notes,
        detail: repoItems.length + ' from the official repositories, ' + aurItems.length + ' from the AUR',
      };
    },
  },

  {
    id: 'flatpak',
    name: 'Flatpak',
    bin: 'flatpak',
    command: 'flatpak update',
    short: 'Apps packaged with Flatpak, separate from the system.',
    what:
      'Apps installed from remotes like Flathub. They live apart from the ' +
      'system and update on their own.',
    does:
      'Updates all installed Flatpak apps, user and system ' +
      '(for system apps you will be asked for the password).',
    silences: 'Nothing: the command asks for one overall confirm. No noise.',
    async probe() {
      // An installed flatpak binary means nothing on its own: this PC has
      // Flathub configured but ZERO apps. Tell "no apps" from "no updates".
      const [apps, upd] = await Promise.all([
        run('flatpak', ['list', '--app', '--columns=application']),
        run('flatpak', ['remote-ls', '--updates', '--columns=application,version']),
      ]);
      const installed = apps.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
      if (!installed.length) {
        return {
          items: [],
          empty: true,
          emptyReason:
            'Flatpak is installed and Flathub is set up, but there are no ' +
            'Flatpak apps on this machine: nothing to update.',
          notes: [],
        };
      }
      const items = upd.stdout
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean)
        .map((line) => {
          const parts = line.split(/\s+/);
          return { name: parts[0], from: null, to: parts[1] || null };
        });
      return { items, notes: upd.timedOut ? ['The Flatpak check timed out.'] : [] };
    },
  },

  {
    id: 'npm',
    name: 'npm — global packages',
    bin: 'npm',
    command: 'npm update -g',
    short: 'Global Node programs. pm2 is here, it keeps the Machine alive.',
    what:
      'Node programs installed globally, available as commands everywhere. ' +
      'pm2 is here too, the supervisor that keeps The 151 Machine alive.',
    does: 'Updates the global npm packages to the latest compatible version.',
    silences:
      'Nothing: npm asks no questions. WARNING: if pm2 is in the list, after ' +
      'the update run "pm2 update", because the daemon already in memory stays ' +
      'on the old version.',
    async probe() {
      // `npm outdated` exits 1 when it FINDS outdated packages — a success, not
      // a failure. Parse stdout, ignore the exit code.
      const r = await run('npm', ['outdated', '-g', '--depth=0', '--json']);
      let parsed = {};
      try {
        parsed = JSON.parse(r.stdout.trim() || '{}');
      } catch {
        return { items: [], notes: ['Could not read the npm reply.'] };
      }
      const items = Object.keys(parsed).map((name) => ({
        name,
        from: parsed[name].current || null,
        to: parsed[name].latest || parsed[name].wanted || null,
      }));
      return { items, notes: r.timedOut ? ['The npm check timed out.'] : [] };
    },
  },

  {
    id: 'uv',
    name: 'uv — Python tools',
    bin: 'uv',
    command: 'uv tool upgrade --all',
    short: 'Isolated Python tools installed with uv (the MCP servers).',
    what:
      'Python tools installed with uv, each in its own isolated environment. ' +
      'The MCP servers live here (jcodemunch, notebooklm).',
    does: 'Updates every tool installed with uv to the latest version.',
    silences:
      'Nothing: uv asks no questions. If you update an MCP server, restart the ' +
      'sessions that use it.',
    async probe() {
      const r = await run('uv', ['tool', 'list', '--outdated']);
      const items = [];
      for (const raw of r.stdout.split('\n')) {
        // "jcodemunch-mcp v1.108.20 [latest: 1.108.282]"
        const m = raw.trim().match(/^(\S+)\s+v?(\S+)\s+\[latest:\s*([^\]]+)\]/);
        if (m) items.push({ name: m[1], from: m[2], to: m[3].trim() });
      }
      return { items, notes: r.timedOut ? ['The uv check timed out.'] : [] };
    },
  },
];

// The last /check, so «Update everything» starts from what il proprietario just saw
// instead of re-probing for two minutes. Older than 15 minutes → probe again.
let _lastCheck = null;
const CHECK_FRESH_MS = 15 * 60 * 1000;

async function collect() {
  const machine = detectMachine();

  const results = await Promise.all(
    CHANNELS.map(async (ch) => {
      const base = {
        id: ch.id,
        name: ch.name,
        command: ch.command,
        short: ch.short,
        what: ch.what,
        does: ch.does,
        silences: ch.silences,
      };
      if (!(await has(ch.bin))) {
        return Object.assign(base, {
          state: 'absent',
          items: [],
          count: 0,
          reason: '`' + ch.bin + '` is not installed on this machine.',
        });
      }
      try {
        const out = await ch.probe();
        if (out.empty) {
          return Object.assign(base, {
            state: 'empty',
            items: [],
            count: 0,
            reason: out.emptyReason || null,
            notes: out.notes || [],
          });
        }
        return Object.assign(base, {
          state: out.items.length ? 'outdated' : 'current',
          items: out.items,
          count: out.items.length,
          detail: out.detail || null,
          notes: out.notes || [],
        });
      } catch (e) {
        return Object.assign(base, {
          state: 'error',
          items: [],
          count: 0,
          reason: (e && e.message) || String(e),
        });
      }
    })
  );

  // "Everything at once": only the channels with real work, chained with && in
  // declaration order (system first). Never mixes machines — this is built from
  // THIS machine's channels only.
  const actionable = results.filter((c) => c.state === 'outdated');

  const out = {
    machine,
    generatedAt: new Date().toISOString(),
    channels: results,
    totalUpdates: actionable.reduce((n, c) => n + c.count, 0),
    allInOne: actionable.length ? actionable.map((c) => c.command).join(' && ') : null,
    allInOneChannels: actionable.map((c) => c.name),
  };
  _lastCheck = { at: Date.now(), result: out };
  return out;
}

// ── «Update everything» ──────────────────────────
// The ONE exception to «installs nothing»: the owner asked for it («se serve la
// password dovrei poterla inserire da dentro la machine», «così clicco solo su
// update»), reviewed by /hack the same day. What it may run is ONLY the
// commands of the outdated channels above, rebuilt here with absolute paths
// (runCommand) — never text from the client. It runs in runner.py: a
// pseudo-terminal detached from this server (a Machine restart cannot stop
// pacman halfway), clean environment, routine questions answered by itself;
// sudo's password, the choice between providers, «remove a package?» and
// anything unknown go to the owner. His answers reach the terminal and nowhere else.
const RUN_DIR = path.join(os.homedir(), '.151machine', 'updates');
const RUNNER = path.join(__dirname, 'runner.py');
const KEEP_RUNS = 5;
const ID_RE = /^[a-f0-9]{32}$/;
const ANSI_RE = /\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1b[()][0-9A-B]|\x1b[=>]/g;
// Packages after which a restart of the PC is the honest advice.
const RESTART_RE = /(?:upgrading|installing) (linux(?:-lts|-zen|-hardened)?|nvidia[\w-]*|systemd|mesa|plasma-workspace|kwin|glibc)\b/;
// Fixed binaries per channel (/hack: no PATH lookups for what may reach sudo).
const BIN = {
  yay: '/usr/bin/yay', flatpak: '/usr/bin/flatpak', npm: '/usr/bin/npm',
  uv: [path.join(os.homedir(), '.local', 'bin', 'uv'), '/usr/bin/uv'],
};

function binOf(name) {
  const b = BIN[name];
  if (!b) return null;
  const list = Array.isArray(b) ? b : [b];
  return list.find((p) => { try { fs.accessSync(p, fs.constants.X_OK); return true; } catch (_) { return false; } }) || null;
}

// The command a channel runs from the button: its own command, first word
// swapped for the fixed binary; for yay also sudo, pacman and sudo's prompt
// (with this run's nonce: only OUR sudo's prompt may receive the password).
function runCommand(ch, nonce) {
  const parts = ch.command.split(' ');
  const bin = binOf(parts[0]);
  if (!bin) return null;
  if (parts[0] === 'yay') {
    return [bin, '--sudo', '/usr/bin/sudo', '--sudoflags', "'-p 151sudo-" + nonce + ":'",
      '--pacman', '/usr/bin/pacman'].concat(parts.slice(1)).join(' ');
  }
  return [bin].concat(parts.slice(1)).join(' ');
}

function runFile(id, ext) { return path.join(RUN_DIR, 'run-' + id + '.' + ext); }
function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, { encoding: 'utf8', flag: fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW })); }
  catch (_) { return null; }
}

// RUN_DIR must be a real directory of ours, 700 — never a symlink.
function safeDir() {
  fs.mkdirSync(RUN_DIR, { recursive: true, mode: 0o700 });
  const st = fs.lstatSync(RUN_DIR);
  if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== process.getuid()) throw new Error('Unsafe updates folder');
  if ((st.mode & 0o777) !== 0o700) fs.chmodSync(RUN_DIR, 0o700);
}

function listRuns() {
  try {
    return fs.readdirSync(RUN_DIR)
      .map((f) => (f.match(/^run-([a-f0-9]{32})\.log$/) || [])[1]).filter(Boolean)
      .map((id) => ({ id, t: fs.statSync(runFile(id, 'log')).mtimeMs }))
      .sort((a, b) => a.t - b.t).map((x) => x.id);
  } catch (_) { return []; }
}

// The lock: the pid the runner wrote, alive AND still our runner for this id
// (pids get reused).
function runnerAlive(id) {
  let pid = 0;
  try { pid = parseInt(fs.readFileSync(runFile(id, 'pid'), 'utf8'), 10) || 0; } catch (_) {}
  if (!pid) return null;
  try {
    const cl = fs.readFileSync('/proc/' + pid + '/cmdline', 'utf8');
    return cl.includes('runner.py') && cl.includes(id);
  } catch (_) { return false; }
}

function runState(id) {
  const end = readJson(runFile(id, 'json'));
  if (end) return { running: false, exit: end.exit };
  const a = runnerAlive(id);
  if (a) return { running: true, exit: null };
  // No pid yet: just started (the runner needs a moment to fork).
  const meta = readJson(runFile(id, 'meta'));
  if (a === null && meta && Date.now() - meta.startedAt < 8000) return { running: true, exit: null };
  return { running: false, exit: null, lost: true };
}

function currentRun() {
  const ids = listRuns();
  const last = ids[ids.length - 1];
  return last ? Object.assign({ id: last, meta: readJson(runFile(last, 'meta')) }, runState(last)) : null;
}

function prune() {
  const ids = listRuns();
  for (const id of ids.slice(0, Math.max(0, ids.length - KEEP_RUNS))) {
    for (const ext of ['log', 'json', 'ask', 'pid', 'meta']) { try { fs.unlinkSync(runFile(id, ext)); } catch (_) {} }
  }
}

// Terminal output → plain lines: colours out, a line rewritten with \r keeps
// only its last version (progress bars), runs of blank lines squeezed.
function clean(text) {
  return String(text).replace(ANSI_RE, '').replace(/\r\n/g, '\n').split('\n')
    .map((l) => l.split('\r').filter((x) => x.length).pop() || '')
    .join('\n').replace(/\n{3,}/g, '\n\n');
}

function summarize(log) {
  let progress = null;
  const re = /\(\s*(\d+)\/(\d+)\)\s+(upgrading|installing|reinstalling|removing)\s+(\S+)/g;
  let m;
  while ((m = re.exec(log))) progress = { n: +m[1], total: +m[2], what: m[3], pkg: m[4] };
  const changed = (log.match(/\(\s*\d+\/\d+\)\s+(?:upgrading|installing|reinstalling)\s/g) || []).length;
  return { progress, changed, restartAdvised: RESTART_RE.test(log) };
}

// Who may type into the terminal: this PC or a device on the Tailscale net.
// The socket address, never a forwarded header.
function fromTrustedNet(req) {
  const a = String((req.socket && req.socket.remoteAddress) || '').replace(/^::ffff:/, '');
  if (a === '127.0.0.1' || a === '::1') return true;
  const m = a.match(/^100\.(\d+)\.\d+\.\d+$/);
  return !!(m && +m[1] >= 64 && +m[1] <= 127);
}

async function startUpdate(from) {
  safeDir();
  const cur = currentRun();
  if (cur && cur.running) return { status: 409, body: { error: 'An update is already running', id: cur.id } };
  const fresh = _lastCheck && Date.now() - _lastCheck.at < CHECK_FRESH_MS ? _lastCheck.result : await collect();
  const outdated = fresh.channels.filter((c) => c.state === 'outdated');
  if (!outdated.length) return { status: 400, body: { error: 'Nothing to update' } };
  const nonce = crypto.randomBytes(12).toString('hex');
  const cmds = outdated.map((c) => runCommand(CHANNELS.find((x) => x.id === c.id), nonce));
  if (cmds.some((c) => !c)) return { status: 500, body: { error: 'A channel program is missing' } };
  const id = crypto.randomBytes(16).toString('hex');
  const meta = { startedAt: Date.now(), from, channels: outdated.map((c) => c.name), totalUpdates: fresh.totalUpdates };
  fs.writeFileSync(runFile(id, 'meta'), JSON.stringify(meta), { mode: 0o600, flag: 'wx' });
  fs.writeFileSync(runFile(id, 'log'), '', { mode: 0o600, flag: 'wx' });
  const child = spawn('/usr/bin/python3', [RUNNER, '--daemon', '--dir', RUN_DIR, '--id', id, '--nonce', nonce,
    '--', '/usr/bin/bash', '-c', cmds.join(' && ')], { cwd: os.homedir(), detached: true, stdio: 'ignore' });
  child.on('error', (e) => { try { fs.appendFileSync(runFile(id, 'log'), '\n[151] could not start: ' + e.message + '\n'); } catch (_) {} });
  child.unref();
  _lastCheck = null; // after an update the old count is a lie
  prune();
  return { status: 200, body: { id, channels: meta.channels, totalUpdates: meta.totalUpdates } };
}

function statusOf(id, since) {
  if (!ID_RE.test(id || '') || !fs.existsSync(runFile(id, 'log'))) return null;
  let raw = '';
  try { raw = fs.readFileSync(runFile(id, 'log'), 'utf8'); } catch (_) {}
  const from = Math.max(0, Math.min(raw.length, since | 0));
  const st = runState(id);
  const ask = st.running ? readJson(runFile(id, 'ask')) : null;
  return Object.assign({ id, size: raw.length, chunk: clean(raw.slice(from)), ask, meta: readJson(runFile(id, 'meta')) },
    st, summarize(raw));
}

const ANSWER_RULES = {
  yesno: /^[yYnN]$/, choice: /^\d{1,3}$/, text: /^[^\x00-\x1f\x7f]{0,256}$/, password: /^[^\x00-\x1f\x7f]{1,256}$/,
};

function answer(id, text) {
  if (!ID_RE.test(id || '')) return { status: 400, body: { error: 'Bad id' } };
  const st = runState(id);
  const ask = st.running ? readJson(runFile(id, 'ask')) : null;
  // Only an open question can be answered, and only with its kind of answer:
  // nothing is typed into a terminal that did not ask for it.
  if (!ask) return { status: 409, body: { error: 'No question is waiting' } };
  const rule = ANSWER_RULES[ask.kind];
  if (typeof text !== 'string' || !rule || !rule.test(text)) return { status: 400, body: { error: 'Bad answer' } };
  let fd;
  try {
    // NONBLOCK: a dead runner gives ENXIO at once instead of freezing the server.
    fd = fs.openSync(runFile(id, 'in'), fs.constants.O_WRONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW);
    fs.writeSync(fd, text + '\n');
  } catch (e) {
    return { status: 409, body: { error: 'The update is not listening' } };
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch (_) {}
  }
  return { status: 200, body: { ok: true } };
}

module.exports = {
  // For tests/updates-runner.test.js (pure: no real update ever runs there).
  _test: { runCommand, clean, summarize, fromTrustedNet, ANSWER_RULES },
  activate() {
    return {
      registerRoutes(router) {
        // Strictly local.
        router.get('/check', async (_req, res) => {
          try { res.json(await collect()); }
          catch (e) { res.status(500).json({ error: (e && e.message) || String(e) }); }
        });

        // Who am I — cheap, so the panel can name the block before the slow
        // probes finish.
        router.get('/whoami', (_req, res) => res.json(detectMachine()));

        // «Update everything» — see the block above startUpdate().
        // Header login only (/hack): a token in the address bar never starts
        // an update or types into it.
        const headerOnly = (req, res) => {
          if (/^Bearer /.test(req.headers.authorization || '')) return true;
          res.status(401).json({ error: 'Login header required' });
          return false;
        };
        router.post('/update/start', async (req, res) => {
          if (!headerOnly(req, res)) return;
          if (!req.body || req.body.confirm !== true) return res.status(400).json({ error: 'Confirm required' });
          const from = String((req.socket && req.socket.remoteAddress) || '').replace(/^::ffff:/, '');
          try { const r = await startUpdate(from); res.status(r.status).json(r.body); }
          catch (e) { res.status(500).json({ error: (e && e.message) || String(e) }); }
        });
        router.get('/update/current', (_req, res) => res.json({ run: currentRun() }));
        router.get('/update/status', (req, res) => {
          const st = statusOf(String(req.query.id || ''), parseInt(req.query.since, 10) || 0);
          if (!st) return res.status(404).json({ error: 'No such update' });
          res.json(st);
        });
        // The answer (sudo's password included) goes to the terminal only:
        // never logged, never stored, never sent back.
        router.post('/update/answer', (req, res) => {
          if (!headerOnly(req, res)) return;
          if (!fromTrustedNet(req)) return res.status(403).json({ error: 'Answers only from this PC or the Tailscale network' });
          const b = req.body || {};
          const r = answer(String(b.id || ''), b.text);
          res.status(r.status).json(r.body);
        });
      },
    };
  },
};
