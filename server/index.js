#!/usr/bin/env node
/**
 * 151 Terminal — PC Server
 *
 * Full WebSocket + REST server for Claude CLI sessions.
 * Ported from claude-mobile's battle-tested server.js with product-specific auth.
 *
 * Startup: npm start (or node server/index.js)
 * Config:  server/config.json (auto-created on first run)
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const express = require('express');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const multer = require('multer');
const { WebSocketServer } = require('ws');
const { SessionManager, TRASH_DIR } = require('./session-manager');
const { rotateIfLarge } = require('./log-rotate');
const { PluginManager, createPluginStaticGuard } = require('./plugin-loader');
const transcribe = require('./transcribe');
const restartIntent = require('./restart-intent');
const schermoSpento = require('./schermo-spento');
const restartControl = require('./restart-control');
const deploy = require('./deploy');
const { computeCodeHash, computeServerHash } = require('./build-hash');
// Il codice server caricato da QUESTO processo: si calcola una volta, all'avvio,
// e non segue mai il disco (vedi computeServerHash). Esposto in /api/health.
const SERVER_HASH = computeServerHash();
const createStreamHandler = require('./stream-handler');
const createAutoTitle = require('./auto-title');
const setupWsHandler = require('./ws-handler');
const { setupAllowed, isLoopback } = require('./setup-auth');
const { createNotifyHandler } = require('./notify');
const { createSudoTelefono } = require('./sudo-telefono');
// Detached-runs ordered replay log (Odysseus steal #4). Used only when
// DETACHED_RUNS is set; require is cheap + side-effect-free so it's safe always.
const streamLog = require('./stream-log');
// M9 Fase C · Vettore 6 — draft-pinned attachment registry. Used only when
// RESTART_MEMORY is set (mirrors the orphan sweep it cooperates with); require
// is cheap + side-effect-free so it's safe always.
const draftAttachments = require('./draft-attachments');

// Boot timestamp — sent to clients so they can detect server restarts
const SERVER_BOOT = Date.now();
let pluginManager;
let serverReady = false;

// Amnesia-fix Phase 4 (2026-04-18): banner for "who/why/when" of last restart.
// Populated once in startServer() via restart-intent.readAndConsumeIntent().
// null = no restart to report (fresh file consumed AND dismissed, or first boot).
let lastRestartBanner = null;

// Shared mutable state — passed to extracted modules so they can read/write
const serverState = {
  // Per-boot nonce. Changes on every restart/hot-reload — this is the
  // "did the restart land?" signal polled by tools/deploy.sh. Do NOT make
  // this stable or the deploy script can no longer confirm a restart.
  BUILD_HASH: crypto.randomBytes(4).toString('hex'),
  // Content-stable code identifier — same across restarts of identical code and
  // identical PC↔Pi. Drives client asset cache-busting (?v=) and TRACKS THE
  // BYTES ON DISK LIVE (see refreshCodeHash below), so a plugin `cp` can never
  // be served under a stale immutable ?v=.
  CODE_HASH: computeCodeHash(),
  // Identity of the code this box has DEPLOYED — the client's reload trigger.
  // Split off from CODE_HASH on 2026-08-27 (see refreshCodeHash + ws-handler).
  // Same value at boot; from then on only a deploy moves it. CODE_HASH must
  // follow the disk (caching correctness); the reload trigger must NOT, or every
  // file a working session saves force-reloads every open window and the phone.
  DEPLOY_HASH: null, // assigned right below — same boot value as CODE_HASH
  shutdownInProgress: false,
};
serverState.DEPLOY_HASH = serverState.CODE_HASH;
const SERVER_STARTED_AT = new Date().toISOString();

// Forward declarations — assigned in MODULE WIRING section after server/wss creation
let spawnStreamHandler, plannedShutdown;
let generateAutoTitleStage1, generateAutoTitleStage2;

// --- Path Constants ---
const CONFIG_PATH = path.join(__dirname, 'config.json');
const STORE_PATH = path.join(__dirname, 'sessions.json');
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
// Generic chat attachments.
// Stable per-box store under ~/.151machine/attachments (same family as the memory
// store / backlog) — OUTSIDE the repo so deploy/git never touch it, writable on
// PC and Pi without root. ATTACHMENTS_DIR env overrides. (Was
// '/mnt/entertainment/...' — a migration leftover pointing at a disk that isn't
// mounted on the PC, which broke phone-image attachments.)
const ATTACHMENTS_PREFERRED = process.env.ATTACHMENTS_DIR || path.join(os.homedir(), '.151machine', 'attachments');
const ATTACHMENTS_FALLBACK = path.join(__dirname, 'attachments');
function getAttachmentsDir() {
  try {
    fs.mkdirSync(ATTACHMENTS_PREFERRED, { recursive: true });
    return ATTACHMENTS_PREFERRED;
  } catch {
    fs.mkdirSync(ATTACHMENTS_FALLBACK, { recursive: true });
    return ATTACHMENTS_FALLBACK;
  }
}
const ATTACHMENTS_DIR = getAttachmentsDir();
const PLUGINS_DIR = path.join(__dirname, '..', 'plugins');
const COMMANDS_DIR = path.join(process.env.HOME, '.claude', 'commands');
const PORT = process.env.PORT || 3170;

// Claude binary — Node spawn can't find it via bash PATH
const CLAUDE_BIN = path.join(process.env.HOME, '.local', 'bin', 'claude');

// Atomic write: write to .tmp then rename, so a crash mid-write can't leave a
// half-written (corrupt) config.json behind.
function writeConfigAtomic(obj) {
  const tmp = CONFIG_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, CONFIG_PATH);
}

// --- Config Loading ---
function loadConfig() {
  let fileConfig = {};
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      fileConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    } catch (err) {
      // Corrupt/half-written config.json must NOT throw before handlers are set up
      // (would crash-loop under PM2). Fall back to defaults and warn loudly.
      console.warn(`[CONFIG] Failed to parse ${CONFIG_PATH} — using defaults: ${err.message}`);
      fileConfig = {};
    }
  }
  // Env vars override config.json for secrets
  const config = {
    deviceId: fileConfig.deviceId || crypto.randomBytes(8).toString('hex'),
    password: process.env.PASSWORD_HASH || fileConfig.password || '',
    jwtSecret: process.env.JWT_SECRET || fileConfig.jwtSecret || crypto.randomBytes(32).toString('hex'),
  };
  // Save deviceId to config.json if new (non-secret, just an identifier)
  if (!fileConfig.deviceId) {
    writeConfigAtomic({ deviceId: config.deviceId });
    console.log('[CONFIG] First run — config.json created (deviceId only)');
  }
  return config;
}

const config = loadConfig();

// --- Network IP Detection ---
function getNetworkIPs() {
  const interfaces = os.networkInterfaces();
  const ips = [];
  for (const [name, addrs] of Object.entries(interfaces)) {
    for (const addr of addrs) {
      if (addr.family === 'IPv4' && !addr.internal) {
        ips.push({ name, address: addr.address, tailscale: addr.address.startsWith('100.') });
      }
    }
  }
  return ips;
}

function getTailscaleIP() {
  return getNetworkIPs().find(ip => ip.tailscale)?.address || null;
}

function getLanIPs() {
  return getNetworkIPs().filter(ip => !ip.tailscale);
}

// --- Pairing ---
let pairingToken = crypto.randomBytes(16).toString('hex');

// [2026-09-22] Tolta regeneratePairingToken(): il suo unico chiamante era
// POST /api/pair, rimossa stamattina (vedi la nota piu' sotto). Il token si
// genera una volta all'avvio, qui sopra, e serve a POST /api/setup.

function showPairingQR() {
  let qrcode;
  try { qrcode = require('qrcode-terminal'); } catch { return; }

  const tailscaleIP = getTailscaleIP();
  const lanIPs = getLanIPs();
  const skip = /vEthernet|VMware|VirtualBox|Hyper-V|WSL/i;
  const preferredLan = lanIPs.find(i => !skip.test(i.name)) || lanIPs[0];

  // QR encodes pairing data — Tailscale IP (works anywhere) + LAN IP (fastest on same network)
  const pairingData = JSON.stringify({
    tailscale: tailscaleIP ? `${tailscaleIP}:${PORT}` : null,
    lan: preferredLan ? `${preferredLan.address}:${PORT}` : null,
    port: PORT,
    token: pairingToken,
  });

  console.log('\n\u2554\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2557');
  console.log('\u2551   The 151 Machine — Scan to pair        \u2551');
  console.log('\u2560\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2563');
  if (tailscaleIP) {
    console.log(`\u2551   Tailscale: ${tailscaleIP}:${PORT}`.padEnd(39) + '\u2551');
  }
  if (preferredLan) {
    console.log(`\u2551   LAN:       ${preferredLan.address}:${PORT}`.padEnd(39) + '\u2551');
  }
  for (const ip of lanIPs) {
    if (ip !== preferredLan) {
      console.log(`\u2551   LAN:       ${ip.address} (${ip.name})`.slice(0, 38).padEnd(39) + '\u2551');
    }
  }
  console.log('\u255a\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u255d\n');

  qrcode.generate(pairingData, { small: true }, (code) => {
    console.log(code);
  });
  if (tailscaleIP) {
    console.log(`[PAIR] Tailscale: http://${tailscaleIP}:${PORT} (works from anywhere)`);
  }
  if (preferredLan) {
    console.log(`[PAIR] LAN: http://${preferredLan.address}:${PORT} (same network only)`);
  }
  console.log('');
}

// --- JWT Auth ---
function createToken(payload) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify({ ...payload, iat: Date.now(), exp: Date.now() + 14 * 24 * 60 * 60 * 1000 })).toString('base64url');
  const sig = crypto.createHmac('sha256', config.jwtSecret).update(header + '.' + body).digest('base64url');
  return header + '.' + body + '.' + sig;
}

function verifyToken(token) {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const sig = crypto.createHmac('sha256', config.jwtSecret).update(parts[0] + '.' + parts[1]).digest('base64url');
  if (sig !== parts[2]) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    if (payload.exp && payload.exp < Date.now()) return null; // Token expired
    return payload;
  } catch { return null; }
}

function isTokenValid(token) {
  return verifyToken(token) !== null;
}

// Login rate limiting (5 attempts per minute per IP)
const loginAttempts = new Map();
const LOGIN_RATE_WINDOW = 60 * 1000;
const LOGIN_RATE_MAX = 5;

// Prune stale login attempts every hour
setInterval(() => {
  const now = Date.now();
  for (const [ip, timestamps] of loginAttempts) {
    const recent = timestamps.filter(t => now - t < LOGIN_RATE_WINDOW);
    if (recent.length === 0) loginAttempts.delete(ip);
    else loginAttempts.set(ip, recent);
  }
}, 60 * 60 * 1000);

// --- Session Manager ---
const manager = new SessionManager(STORE_PATH);
manager.load();
// M9 Fase B vector 4 (RESTART_MEMORY-gated): before deciding what to resume,
// ADOPT any orphan full-text partial left by a HARD crash (SIGKILL/power — no
// graceful flush ran) into its session's history, mirroring the graceful flush.
// Idempotent (skips a partial already in history) so a graceful restart is a
// no-op here. Inert + zero disk I/O when the flag is off ⇒ byte-identical.
if (process.env.RESTART_MEMORY) {
  try {
    const sp = require('./stream-partials');
    const adopted = sp.adoptOrphans(manager);
    if (adopted > 0) console.log(`[BOOT] Adopted ${adopted} orphan full-text partial(s) into history (M9 v4)`);
    sp.prune();
  } catch (e) { console.error('[BOOT] stream-partials adopt failed:', e.message); }
}
// M9 Fase B vector 3 (DETACHED_RUNS-gated): reload the last-turn stream-log
// snapshots from disk so a client reconnecting AFTER a restart replays the
// missed events (seq preserved, not reset to 0) instead of falling back to a
// full re-run. Inert + zero disk I/O when the flag is off ⇒ byte-identical.
if (process.env.DETACHED_RUNS) {
  try {
    const n = streamLog.loadFromDisk();
    if (n > 0) console.log(`[BOOT] Restored ${n} stream-log snapshot(s) from disk (M9 v3)`);
  } catch (e) { console.error('[BOOT] stream-log reload failed:', e.message); }
}
const resumeIds = manager.resumeInterrupted();
if (resumeIds.length > 0) {
  console.log(`[BOOT] ${resumeIds.length} interrupted session(s) to resume:`, resumeIds.map(id => id.slice(0, 8)));
}
// M9 · pezzo 4 (RESTART_MEMORY-gated, PC-only): sweep orphan/partial attachment
// files a mid-upload restart may have left in <attachments_dir>/<sid>/. Safe —
// deletes ONLY files no session history references (the client still holds the
// local blob and re-uploads on the next send). Inert + zero disk I/O when the
// flag is off ⇒ byte-identical. (Until 2026-10-12 it was also skipped on the Pi.)
if (process.env.RESTART_MEMORY && fs.existsSync(CLAUDE_BIN)) {
  try {
    const { sweepOrphans } = require('./attachment-cleanup');
    // Pass TRASH_DIR so an attachment referenced ONLY by a trashed (revivable)
    // session is treated as in-use and never swept — the sweep reads live
    // sessions + trash, so it can only ever delete a true orphan.
    // Pass draftPaths (M9 Fase C · Vettore 6) so an attachment uploaded-on-add
    // and still sitting in a client draft (never sent) is treated as in-use too —
    // the client persists only the ref, so it can't re-upload after a restart.
    const swept = sweepOrphans({
      manager,
      attachmentsDir: ATTACHMENTS_DIR,
      trashDir: TRASH_DIR,
      draftPaths: draftAttachments.all(),
    });
    if (swept.removed > 0) {
      console.log(`[BOOT] Swept ${swept.removed} orphan attachment file(s), ${(swept.bytes / 1024 / 1024).toFixed(1)} MB (M9 pezzo 4)`);
    }
  } catch (e) { console.error('[BOOT] attachment orphan sweep failed:', e.message); }
}

// --- Express App ---
const app = express();

// ─── IL MURO D'INGRESSO ────────────────────────────
// PRIMA di ogni altra cosa (gzip, CORS, file statici, rotte, plugin): si passa
// solo dal PC stesso (loopback) o dal Tailscale del proprietario. Tutti gli altri → 403.
// Guarda solo req.socket.remoteAddress, mai X-Forwarded-*. L'upgrade WS ha lo
// stesso muro più sotto (server.on('upgrade')). Vedi server/solo-tailnet.js.
// Correzioni /hack (12/11): anche l'indirizzo LOCALE del socket (Tailscale solo
// se entrato da tailscale0), l'intestazione Host (DNS rebinding) e, su
// /api/login e WS, l'Origin. IP e nomi Tailscale del PC: tailscale status
// all'avvio, unito alla lista fissa di server/solo-tailnet.js.
const { leggiTailscale, creaMuro } = require('./solo-tailnet');
const { buildAllowedOrigins, isAllowedOrigin } = require('./cors-origins');
const TAILSCALE_PC = leggiTailscale();
const ALLOWED_ORIGINS = buildAllowedOrigins(PORT, undefined, [...TAILSCALE_PC.ip, ...TAILSCALE_PC.nomi]);
const muro = creaMuro({ tailscale: TAILSCALE_PC, origini: ALLOWED_ORIGINS });
app.use(muro.http);
// Intestazioni di sicurezza (/hack 17/10 punto 13, 15/11): il browser non indovina il tipo
// di un file, non manda l'indirizzo della Machine ad altri siti, e nessun altro sito la
// mette in una cornice. Niente CSP: con i plugin e i mockup romperebbe pagine vere.
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  next();
});

// ─── gzip, app-wide GIRO PRESTAZIONI ─────────────────────
// MEASURED BEFORE this line existed: a single logged-in first load pulled
// 5,953 KB over 127 requests and exactly 3 of those responses arrived
// compressed — and all 3 came from third-party CDNs. Nothing this server sent
// was ever compressed, because no compression middleware existed at all.
// The payload is almost entirely text (JS 1.6 MB, CSS 217 KB, JSON 2.1 MB),
// i.e. the single most compressible thing there is: gzip -6 over the same set
// measures −72%. This is the biggest available win and it is app-wide, not
// entertainment-only, which is exactly why it goes here and not in the plugin.
//
// It must be the FIRST middleware: it works by wrapping res.write/res.end, so
// anything mounted before it would still answer uncompressed.
//
// The filter is deliberately conservative rather than clever:
//  - Range/partial responses are left alone. Video and audio streaming answers
//    206 with a Content-Range, and compressing a byte range would invalidate
//    the very byte offsets the client asked for. (In practice `compressible`
//    already rejects video/*, but this app also range-serves generically, and
//    a silent corruption in the media player is not a risk worth the KB.)
//  - `x-no-compression` gives any route a one-line opt-out if one is ever found
//    to need it, without having to come back and edit this filter.
// Chat streaming is NOT affected: it runs over the WebSocket, which is an HTTP
// upgrade and never passes through Express middleware. There is no SSE route in
// the codebase (verified: zero `text/event-stream` in server/ or plugins/), so
// there is no response here that must stay unbuffered.
const compression = require('compression');
app.use(compression({
  threshold: 1024,          // below ~1 KB the framing costs more than it saves
  filter: (req, res) => {
    if (req.headers['x-no-compression']) return false;
    if (req.headers.range) return false;
    if (res.getHeader('Content-Range')) return false;
    return compression.filter(req, res);
  },
}));

app.use(express.json({ limit: '100mb' }));

// CORS — restricted to an EXACT list of origins (17/10/2026, /hack punto 2:
// the old startsWith('http://10.') let «http://10.sito-cattivo.com» in).
// server/cors-origins.js: the phone app, localhost, and this machine's own
// addresses with its port. Interfaces read once at boot. [12/11/2026] L'elenco
// (ALLOWED_ORIGINS) nasce sopra, col muro, e comprende i nomi Tailscale del PC.
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && isAllowedOrigin(origin, ALLOWED_ORIGINS)) {
    res.header('Access-Control-Allow-Origin', origin);
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.header('Access-Control-Allow-Credentials', 'true');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Serve index.html with cache-busting query strings on all JS/CSS assets.
// Keyed on CODE_HASH (content-stable) — so ?v= only changes on a real code
// change, not on every restart (browsers cache assets across restarts).
let _cachedHtml = null;
let _cachedHtmlHash = null;

// ─── Keep CODE_HASH honest GIRO PRESTAZIONI ──────────────
// PRECONDITION for the immutable caching added further down. CODE_HASH was
// computed ONCE at boot (line 96) and refreshed only by a /deploy. That was
// harmless while every asset was sent `no-store` — a stale ?v= cost nothing
// because the browser re-fetched regardless. The moment assets become
// cacheable-for-a-year, a stale ?v= stops being harmless and becomes "the
// browser serves last week's JS forever".
//
// The gap is the documented hot path: a client.js edit goes live by a plain
// `cp` into public/plugins/, with no restart and no deploy. The bytes on disk
// change; serverState.CODE_HASH does not. So recompute it here, where the
// document that HANDS OUT the versioned URLs is built — that is the only moment
// the answer can still change anything. ~30 ms over ~190 files, throttled to
// once every 5 s, and index.html is requested once per page load, so the cost
// is invisible; getting it wrong is not.
//
// ⚠ SCOPE — narrowed 2026-08-27 the same evening, regression root-caused live.
// This may move CODE_HASH (asset URLs) and MUST NOT move DEPLOY_HASH (the
// client reload trigger, sent on every WS join by ws-handler.js). While the two
// were one value, any byte written under server/, public/ or plugins/ by a
// working session — no deploy, no restart — flipped the hash the sockets
// advertise, and public/js/ws.js ran its "code changed → reload" path on every
// open window and on the phone. Measured: 14 flips in ~2.5 h ("[build-hash]
// code changed on disk" in the PM2 log), and reproduced live end to end —
// writing ONE throwaway .json under plugins/ printed
// "[WS] Code hash changed: e020f1c6023b -> 622045a6f2ae — reloading" in an
// already-open browser and navigated it. Caching asks "are the bytes on disk
// the ones I cached?"; the reload trigger asks "did new code get DEPLOYED?".
// Two questions, two values.
const CODE_HASH_RECHECK_MS = 5000;
let _lastHashCheck = 0;
function refreshCodeHash() {
  const now = Date.now();
  if (now - _lastHashCheck < CODE_HASH_RECHECK_MS) return;
  _lastHashCheck = now;
  try {
    const fresh = computeCodeHash();
    if (fresh && fresh !== serverState.CODE_HASH) {
      console.log('[build-hash] code changed on disk:', serverState.CODE_HASH, '→', fresh);
      serverState.CODE_HASH = fresh;
    }
  } catch (_) { /* keep the boot value — never fail a page load over this */ }
}

function getIndexHtml() {
  refreshCodeHash();
  if (_cachedHtml && _cachedHtmlHash === serverState.CODE_HASH) return _cachedHtml;
  const htmlPath = path.join(PUBLIC_DIR, 'index.html');
  let html = fs.readFileSync(htmlPath, 'utf8');
  // [2026-09-10] Qui veniva iniettato js/tool-timeline.js + window.TIMELINE_UI.
  // Tolti insieme: il modulo era 319 righe che non sono MAI state collegate a
  // public/index.html, e le sei biforcazioni in ws.js che lo cercavano non
  // potevano trovarlo. Interruttore acceso su una lampadina smontata.
  html = html.replace(/(src|href)="((?:js\/|css\/|)[^"]+\.(?:js|css))"/g, `$1="$2?v=${serverState.CODE_HASH}"`);
  // Identity of the code THIS DOCUMENT was built from, plus the origin that
  // served it. The phone loads the page from one machine (the Pi) but its
  // WebSocket can point at another (a stale saved URL → the PC). The stale-code
  // reload must follow the PAGE, not the data channel: without this anchor the
  // client compared its socket-server's hash against a localStorage key shared
  // by both machines, so two different servers fought over one slot and the
  // phone reloaded in a loop that could never converge. ws.js reloads only when
  // the socket's origin matches the document's origin AND the hash moved.
  html = html.replace('</head>', `  <script>window.__CODE_HASH=${JSON.stringify(serverState.CODE_HASH)};</script>\n</head>`);
  // The reload anchor, kept SEPARATE from the cache-busting anchor above.
  // __CODE_HASH follows the bytes on disk (so a plugin `cp` re-fetches); this
  // one follows deploys only, and it is the one ws.js compares against the
  // socket's `deployHash`. See the SCOPE note on refreshCodeHash().
  html = html.replace('</head>', `  <script>window.__DEPLOY_HASH=${JSON.stringify(serverState.DEPLOY_HASH)};</script>\n</head>`);
  // [2026-09-10] Qui veniva iniettato window.LAUNCHER_ACTIONS per il plugin
  // launch-actions ("bottoni skill a un tocco"). Plugin e interruttore tolti
  // insieme: era la versione vecchia di quick-actions, spenta nel registro e
  // rimasta accesa nell'ecosystem. il proprietario: «io non so di cosa parli».
  // Detached runs + seq replay (Odysseus steal #4). Client UI/reconnect flag,
  // set in ecosystem.linux.config.js. Off =>
  // ws.js takes the legacy resume/queued_messages path, byte-identical to before.
  // Instant rollback: remove DETACHED_RUNS from the ecosystem file, then
  //   pm2 restart ecosystem.linux.config.js --only 151-machine
  const detachedFlag = process.env.DETACHED_RUNS ? 'true' : 'false';
  html = html.replace('</head>', `  <script>window.DETACHED_RUNS=${detachedFlag};</script>\n</head>`);
  _cachedHtml = html;
  _cachedHtmlHash = serverState.CODE_HASH;
  return html;
}
app.get(['/', '/index.html'], (req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.send(getIndexHtml());
});

// Service worker — inject CODE_HASH (content-stable) into the cache name so the
// SW only runs its update cycle on a real code change, not on every restart.
app.get('/sw.js', (req, res) => {
  const swPath = path.join(PUBLIC_DIR, 'sw.js');
  let content = fs.readFileSync(swPath, 'utf8');
  content = content.replace('__BUILD_HASH__', serverState.CODE_HASH);
  res.setHeader('Content-Type', 'application/javascript');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.send(content);
});

// ─── Static files — cacheable WHEN they are versioned ───────────────────────
//, GIRO PRESTAZIONI. The comment at the top of getIndexHtml()
// has always said the point of stamping `?v=<CODE_HASH>` on every JS/CSS URL is
// that "browsers cache assets across restarts" — but this handler then sent
// `no-store` on every single one of them, so nothing was ever cached and the
// stamp bought nothing. MEASURED: 51 of 127 responses on a first load were
// cacheable, and every one of those 51 came from somewhere else; of this
// server's own 119 responses, 4 were cacheable. Re-loading the page paid the
// full 5.9 MB again, every time.
//
// The rule is the one the ?v= stamp already implies: a URL that carries the
// build hash names an immutable byte sequence — a code change produces a
// different CODE_HASH, hence a different URL, hence a guaranteed re-fetch. So
// it is safe to cache it forever. A URL WITHOUT the stamp is not addressed by
// content and must keep revalidating, so it stays no-store exactly as before.
// index.html and sw.js are unversioned by nature and are handled above; they
// keep no-store, which is what makes the whole scheme safe: the document that
// hands out the versioned URLs is itself never stale.
//
// `immutable` matters as much as max-age here: without it a reload still fires
// a conditional request per asset (~30 round-trips on this app), which on the
// phone (over Tailscale) is most of the wait.
const IMMUTABLE_CACHE = 'public, max-age=31536000, immutable';
app.use((req, res, next) => {
  // Stash the verdict on res: express.static's setHeaders hook is given only
  // (res, path, stat) and must not have to re-parse the URL to agree with us.
  res.locals.__versioned = req.query && req.query.v === serverState.CODE_HASH;
  next();
});
// Il muro dei file plugin (2026-09-27, ): public/plugins/ risponde su
// /plugins PRIMA del loader, quindi il guardiano sta QUI, davanti a public/.
// Di un plugin esce solo il `client` dichiarato nel manifest; i moduli server
// (server.js e ciò che richiede) non escono mai. Vedi server/plugin-loader.js.
app.use('/plugins', createPluginStaticGuard(PLUGINS_DIR));
app.use(express.static(PUBLIC_DIR, {
  etag: false,
  lastModified: false,
  setHeaders: (res, filePath) => {
    res.setHeader('Cache-Control', res.locals.__versioned ? IMMUTABLE_CACHE : 'no-store, no-cache, must-revalidate');
  },
}));

// Generic chat attachments — POST /api/attachments. Stores under
// <attachments_dir>/<sessionId>/<timestamp>_<safename>. 500 MB cap.
const attachmentStorage = multer.diskStorage({
  destination: (req, _file, cb) => {
    const sid = (req.body && req.body.sessionId) || req.query.sessionId || 'unscoped';
    const safeSid = String(sid).replace(/[^a-zA-Z0-9_-]/g, '_');
    const baseDir = getAttachmentsDir();
    const dir = path.join(baseDir, safeSid);
    try {
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    } catch (e) {
      cb(e);
    }
  },
  filename: (_req, file, cb) => {
    const safe = file.originalname.replace(/[/\\<>:"|?*\x00-\x1f]/g, '_');
    cb(null, `${Date.now()}_${safe}`);
  },
});
// 500 MB cap — phone videos from paperclip flow routinely exceed 50 MB.
const attachmentUpload = multer({
  storage: attachmentStorage,
  limits: { fileSize: 500 * 1024 * 1024 },
});

// Live dictation clip upload — one recorded clip POSTed to /api/dictation/transcribe.
// Written to a temp dir and unlinked right after transcription; 200 MB cap easily
// covers ~1h of compressed voice. Kept separate from chat attachments so a dictation
// clip never lands in the persisted attachments store.
const dictationTmpDir = path.join(os.tmpdir(), '151-dictation');
try { fs.mkdirSync(dictationTmpDir, { recursive: true }); } catch (e) {}
const dictationUpload = multer({
  dest: dictationTmpDir,
  limits: { fileSize: 200 * 1024 * 1024 },
});

// Dictation recovery — the never-lose-audio guarantee, SERVER side. The client
// already retains its clip on failure (public/js/dictation.js), but on the phone
// the WebView can't save files (no storage permission wired) and dies on
// lock/app-swap. Two loss modes lived here: (1) whisper fails → the clip was
// unlinked in `finally`, so the only durable copy died with the request;
// (2) whisper succeeds after the caller vanished → the text was returned to
// nobody and dropped. Failed clips and transcript copies now land in this dir
// (durable, outside os.tmpdir()), pruned after 7 days.
const dictationRecoveryDir = path.join(os.homedir(), '.151machine', 'dictation-recovery');
try { fs.mkdirSync(dictationRecoveryDir, { recursive: true }); } catch (e) {}
const DICTATION_RECOVERY_TTL_MS = 7 * 24 * 60 * 60 * 1000;
function pruneDictationRecovery() {
  try {
    const now = Date.now();
    for (const f of fs.readdirSync(dictationRecoveryDir)) {
      const p = path.join(dictationRecoveryDir, f);
      try { if (now - fs.statSync(p).mtimeMs > DICTATION_RECOVERY_TTL_MS) fs.unlinkSync(p); } catch (e) {}
    }
  } catch (e) {}
}

// --- CONSEGNA RECUPERABILE (2026-08-22) ------------------------------------
// Il buco vero: whisper finiva SEMPRE (misurato: 2383 passaggi, 0 clip fallite)
// ma il testo tornava indietro in UNA sola risposta HTTP. Se quel socket moriva
// (telefono in standby, cambio rete, WebView congelata) il testo era prodotto e
// perso: rotella infinita lato client, testo solo su disco nel recupero.
// Ora ogni clip porta un clipId e il risultato viene depositato su disco con
// quella chiave, così il client può VENIRSELO A PRENDERE quando torna vivo.
function dictationResultPath(clipId) {
  return path.join(dictationRecoveryDir, 'result-' + clipId + '.json');
}
function isSafeClipId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{6,64}$/.test(id);
}
function readDictationResult(clipId) {
  if (!isSafeClipId(clipId)) return null;
  try {
    const raw = fs.readFileSync(dictationResultPath(clipId), 'utf-8');
    const j = JSON.parse(raw);
    return (j && typeof j.text === 'string') ? j : null;
  } catch (e) { return null; }
}
function writeDictationResult(clipId, text, extra) {
  if (!isSafeClipId(clipId)) return false;
  // Scrittura atomica: il telefono può chiedere il risultato nello stesso istante.
  const dest = dictationResultPath(clipId);
  const tmp = dest + '.' + process.pid + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(Object.assign({}, extra || {}, { clipId, text: text || '', at: Date.now() })), 'utf-8');
    fs.renameSync(tmp, dest);
    return true;
  } catch (e) { try { fs.unlinkSync(tmp); } catch (_) {} return false; }
}
// «Invia mentre registri»: la consegna nella sessione la fa il server.
// `consegnaDalServer` si collega quando nasce il gestore dei socket (più sotto);
// la usano la dettatura e il tasto di invio alla sessione speciale.
let consegnaDalServer = null;
const invioDettatura = require('./dettatura-invio').createInvioDettatura({
  trascrivi: (file, lingua) => transcribe.transcribeAudioFile(file, lingua),
  leggiRisultato: readDictationResult,
  scriviRisultato: writeDictationResult,
  consegna: (sid, testo, nonce) => (consegnaDalServer ? consegnaDalServer(sid, testo, nonce) : 'errore'),
  conservaClip: (file) => {
    try {
      const saved = path.join(dictationRecoveryDir, 'clip-' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + path.extname(file || ''));
      fs.renameSync(file, saved);
      return saved;
    } catch (e) { return null; }
  },
  rimuovi: (file) => { try { fs.unlinkSync(file); } catch (e) {} },
  prontezza: require('./restart-readiness'),
});

// =====================
// PUBLIC ROUTES
// =====================

// Health check — no auth required
// package.json letto una volta all'avvio (12/10/2026): prima a ogni GET /api/health.
const PKG_VERSION = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf-8')).version || '0.0.0'; }
  catch { return '0.0.0'; }
})();

app.get('/api/health', (req, res) => {
  if (!serverReady) {
    return res.json({ ok: false, status: 'starting' });
  }
  const version = PKG_VERSION;
  const cliAvailable = fs.existsSync(CLAUDE_BIN);
  // [2026-10-12] peerOnline / lastPollAgeMs and the x-peer-poll stamp are gone
  // with the Pi relay (server/peer-relay.js): the Machine runs on the PC only.
  res.json({
    ok: true,
    boot: SERVER_BOOT,
    sessions: manager.list().length,
    deviceId: config.deviceId,
    configured: !!config.password,
    version,
    cliAvailable,
    chatAvailable: cliAvailable,
    // Impronta dei byte su DISCO (ricalcolata ogni 5 s, refreshCodeHash): dice
    // quali pagine servirebbe adesso, NON che codice server gira.
    codeHash: serverState.CODE_HASH,
    // Impronta del codice server caricato all'AVVIO di questo processo: cambia
    // solo con un riavvio. Il passo 6/7 del cancello confronta questa.
    serverHash: SERVER_HASH,
  });
});

// Restart readiness — no auth, like /api/health (polled by tools/deploy.sh on
// PC and Pi before firing a deploy). Reports whether a client is mid-recording
// or a transcription is in flight (restart/deploy round 2026-08-16, punto 4).
// Exposes counts only — no content, nothing sensitive.
app.get('/api/restart-readiness', (_req, res) => {
  res.json(require('./restart-readiness').snapshot());
});

// Version endpoint — used by /deploy skill for verification
app.get('/api/version', (_req, res) => {
  let commitSha = 'unknown';
  try {
    commitSha = require('child_process')
      .execSync('git rev-parse HEAD', { cwd: path.join(__dirname, '..') })
      .toString().trim();
  } catch {}
  res.json({
    commit_sha: commitSha,
    build_hash: serverState.BUILD_HASH,
    started_at: SERVER_STARTED_AT,
  });
});

// Build hash — used by /deploy skill to verify hot reload took effect
app.get('/api/build-hash', (_req, res) => {
  res.json({ hash: serverState.BUILD_HASH });
});

// [2026-10-12] Tolta GET /api/restart-banner (e la sua POST /dismiss): nessun
// client la leggeva piu'. lastRestartBanner resta: serve alle note di ripresa
// delle sessioni e al log di avvio.

// QR pairing page (open in browser to scan from phone)
app.get('/pair', (req, res) => {
  const tailscaleIP = getTailscaleIP();
  const lanIPs = getLanIPs();
  const skip = /vEthernet|VMware|VirtualBox|Hyper-V|WSL/i;
  const preferredLan = lanIPs.find(i => !skip.test(i.name)) || lanIPs[0] || { address: 'localhost' };
  // Prefer Tailscale (works from anywhere), fall back to LAN
  const preferred = tailscaleIP || preferredLan.address;
  const pairData = JSON.stringify({
    t: '151t',
    h: preferred,
    p: parseInt(PORT),
    k: pairingToken,
    ts: tailscaleIP || null,
    lan: preferredLan.address,
  });

  res.send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>151 Machine \u2014 Pair</title>
<script src="https://cdn.jsdelivr.net/npm/qrcodejs@1.0.0/qrcode.min.js"></script>
<style>
  body { margin:0; min-height:100vh; display:flex; flex-direction:column; align-items:center; justify-content:center;
    background:#08061a; color:#e8e4f4; font-family:'DM Sans',system-ui,sans-serif; gap:24px; }
  h1 { font-size:24px; font-weight:700; background:linear-gradient(135deg,#a78bfa,#7dd3fc);
    -webkit-background-clip:text; -webkit-text-fill-color:transparent; }
  #qr { padding:16px; background:white; border-radius:16px; }
  .info { font-size:14px; color:#8a7eb5; text-align:center; line-height:1.6; }
  .addr { font-size:16px; color:#a78bfa; font-weight:600; }
</style></head><body>
  <h1>The 151 Machine</h1>
  <div id="qr"></div>
  <div class="info">
    <div class="addr">${preferred}:${PORT}</div>
    Open the app on your phone and scan this QR code
  </div>
  <script>new QRCode(document.getElementById('qr'), { text: ${JSON.stringify(pairData)}, width: 280, height: 280, colorDark: '#08061a', correctLevel: QRCode.CorrectLevel.M });</script>
</body></html>`);
});

// [2026-09-22] Tolta POST /api/pair, la convalida del codice QR. Nessuno la
// chiamava piu': la scansione del QR e' stata rimossa dal client (vedi
// public/js/auth.js:308-311, «With QR gone, saving a server URL here is the
// sole entry point») e l'APK non ha nessun lettore di QR. Restano vive la
// pagina GET /pair che disegna il codice e showPairingQR() all'avvio, perche'
// il token di accoppiamento serve ancora a POST /api/setup (setupAllowed).
// Con la rotta se n'e' andato anche regeneratePairingToken(), che era il suo
// unico chiamante (tolto nel secondo giro di potatura, stesso giorno).

// Setup — first-time password creation (requires pairing token from QR scan)
app.post('/api/setup', (req, res) => {
  if (config.password) return res.status(400).json({ error: 'Already configured' });
  const { password, pairingKey } = req.body;
  // Require pairing token from remote connections — localhost can setup directly
  const ip = req.ip || req.socket.remoteAddress || '';
  // Loopback ONLY — the tailnet (100.x) must present a valid pairing key.
  if (!setupAllowed(ip, pairingKey, pairingToken)) {
    return res.status(403).json({ error: 'Invalid pairing key — scan the QR code first' });
  }
  if (!password || password.length < 4) return res.status(400).json({ error: 'Password must be 4+ characters' });
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  config.password = salt + ':' + hash;
  // Rotate JWT secret on first setup — invalidates any pre-setup tokens
  config.jwtSecret = crypto.randomBytes(32).toString('hex');
  // Write secrets to .env, keep only deviceId in config.json
  const envPath = path.join(__dirname, '..', '.env');
  const envLines = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf-8').split('\n') : [];
  const envMap = {};
  envLines.forEach(line => {
    const match = line.match(/^([A-Z_]+)=(.*)$/);
    if (match) envMap[match[1]] = match[2];
  });
  envMap.JWT_SECRET = config.jwtSecret;
  envMap.PASSWORD_HASH = config.password;
  const newEnv = Object.entries(envMap).map(([k, v]) => `${k}=${v}`).join('\n') + '\n';
  // Atomic write (same tmp→rename pattern as writeConfigAtomic above): a crash
  // mid-write must never leave a half-written .env (JWT_SECRET / PASSWORD_HASH),
  // which would boot the server with an empty/broken secret.
  const envTmp = envPath + '.tmp';
  fs.writeFileSync(envTmp, newEnv);
  fs.renameSync(envTmp, envPath);
  writeConfigAtomic({ deviceId: config.deviceId });
  const token = createToken({ role: 'owner' });
  res.json({ token, deviceId: config.deviceId });
});

// Login — SENZA parola. Chi è arrivato fin qui ha
// passato il muro (PC o Tailscale del proprietario): il gettone gli si dà e basta.
// Il controllo si ripete qui, così la rotta resta chiusa anche se un giorno il
// muro venisse spostato. Il limitatore resta (5 al minuto per IP): un client
// sano chiede un gettone all'avvio, non a raffica.
app.post('/api/login', (req, res) => {
  if (!muro.richiestaAmmessa(req)) return res.status(403).json({ error: 'Not on your Tailscale' });

  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const attempts = (loginAttempts.get(ip) || []).filter(t => now - t < LOGIN_RATE_WINDOW);

  if (attempts.length >= LOGIN_RATE_MAX) {
    return res.status(429).json({ error: 'Too many attempts. Try again in a minute.' });
  }

  attempts.push(now);
  loginAttempts.set(ip, attempts);

  res.json({ token: createToken({ role: 'owner' }) });
});

// Novità dopo una consegna: solo le righe «Novità: …» scritte per il proprietario nel
// corpo dei commit, fino al commit servito.
// Prima: i titoli dei commit, letti dal disco e «consumati» dalla prima GET.
{
  const novita = require('./novita');
  const repoDir = path.join(__dirname, '..');
  app.get('/api/changelog', novita.creaRotta(repoDir, novita.headAllAvvio(repoDir)));
}

// --- Lab Review System — REMOVED 2026-08-20 ---
// The Lab app is gone: plugins/lab + public/plugins/lab (client), server/lab-store.js
// (archive) and the 4 /api/lab/reviews routes were deleted. The UI entry door had
// already been removed on 2026-08-16, so nothing consumed it. public/lab/ went too
// (2026-10-12: nothing loaded it, and it made the APK 12 MB heavier).
// requireAuth stays — it is used by the status router
// and the TTS router (see below). [2026-09-22] Il wiki router non c'e' piu':
// server/wiki.js e' stato cancellato stamattina.

// Auth helper — registered before the global /api middleware so routes mounted
// above it need an explicit check.
function requireAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ') || !isTokenValid(auth.slice(7))) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// [2026-10-16] The last proxied mount, /apps/raspberry/ (the Pi's dashboard),
// is gone with the «pi» button. With it went
// the iframe-only auth (requireAuthProxy, the _proxy_auth cookie, the Referer
// asset fallback of server/proxy-asset.js): nothing is proxied any more.
// History: git log -- server/raspberry-proxy.js server/proxy-asset.js

// Outbound notify — loopback trusted (backup scripts / notify-user skill curl
// without a JWT); remote callers need a Bearer token. See server/notify.js.
app.post('/api/notify', createNotifyHandler({ getWss: () => wss, isTokenValid, isLoopback }));

// Sudo dal telefono: l'aiutante di sudo chiede da loopback,
// il proprietario risponde col gettone. Montate qui, prima del muro /api: ognuna fa il
// suo controllo. Vedi server/sudo-telefono.js.
const sudoTelefono = createSudoTelefono({
  getWss: () => wss, isTokenValid, isLoopback,
  titoloDi: (cid) => {
    if (!cid) return null;
    // _serialize() non porta claudeSessionId: si guarda la mappa viva.
    const s = Array.from(manager.sessions.values()).find((x) => x && x.claudeSessionId === cid);
    return s ? s.title : null;
  },
});
app.post('/api/sudo/chiedi', sudoTelefono.chiedi);
app.post('/api/sudo/rispondi', sudoTelefono.rispondi);




// =====================
// AUTH MIDDLEWARE
// =====================

app.use('/api', (req, res, next) => {
  // Public endpoints
  // [2026-09-22] Sparite da questo elenco anche '/pair' e '/widget-status':
  // erano le esenzioni di POST /api/pair e GET /api/widget-status, tolte
  // nello stesso atto perche' nessun client le chiamava piu'.
  if (req.path === '/login' || req.path === '/health' ||
      req.path === '/setup' ||
      req.path === '/changelog' ||
      req.path === '/deploy' || req.path === '/commands' ||
      // 2026-08-16 (round #2): readiness must be reachable from
      // tools/deploy.sh WITHOUT a token, mirroring /health. It reports only
      // counts (ready/recording/transcribing) — no content, nothing sensitive.
      // Root cause of the "PC: ancora in corso (ready ready)" wedge: the Pi
      // was on old code without the app.get() at server/index.js:553, so its
      // /api/restart-readiness fell through to this middleware and got 401,
      // which readiness_of misparsed as busy. Belt-and-suspenders: allowlist
      // it here so future forgotten deploys still return json cleanly.
      // [2026-09-22] Tolte quattro esenzioni per rotte FANTASMA del plugin
      // playlist-doctor: /spotify/auth, /spotify/callback, /spotify/status e
      // /fetch-csvs. Il plugin spotify e' stato cancellato il 2026-07-07 e
      // nessuna di quelle rotte esiste piu' in plugins/playlist-doctor/server.js
      // (verificato: ci sono /spotify-meta, /fetch e /fetch-status, che sono
      // altre rotte e restano dietro l'autenticazione). Erano buchi
      // d'autenticazione aperti su indirizzi che non rispondono piu'.
      req.path === '/restart-readiness') return next();

  // [12/11/2026] Tolto «niente password = rifiuta ogni gettone»: la parola non
  // esiste più, l'accesso lo decide il muro e il gettone lo firma
  // JWT_SECRET come prima.

  // [2026-10-12] Tolta l'entrata con la chiave x-relay-secret: la usavano il
  // relay del Pi e l'ultima unione di Playlist Doctor, fatta alle 12:25 del 12/10.

  // Accept token as query param (for <audio>/<video> elements that can't send headers)
  const queryToken = req.query.token;
  if (queryToken && isTokenValid(queryToken)) return next();

  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ') || !isTokenValid(auth.slice(7))) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
});

// =====================
// MECHANICAL UTILITIES — system cleanup
// =====================
// These are PLAIN SHELL SCRIPTS (tools/*.sh), no AI, that keep working forever.
// The endpoint just runs the script and returns its text report for the phone to
// show. They are PC-canonical (yay + the vault live on the PC). Each runs
// ASYNC (execFile, 12/10/2026: prima execFileSync bloccava tutto il processo
// fino a 180 s) with a hard timeout and returns { ok, output }.
// (update-check tolto il 12/10/2026: nessun client lo chiamava più.)
{
  const MECH = {
    'system-cleanup': 'system-cleanup.sh',
  };
  const { execFile } = require('child_process');
  Object.keys(MECH).forEach((name) => {
    app.post('/api/' + name, (req, res) => {
      const script = path.join(__dirname, '..', 'tools', MECH[name]);
      if (!fs.existsSync(script)) {
        return res.status(404).json({ ok: false, error: MECH[name] + ' not found' });
      }
      execFile('bash', [script], {
        cwd: path.join(__dirname, '..'),
        env: process.env,
        timeout: 180000,
        maxBuffer: 8 * 1024 * 1024,
        encoding: 'utf8',
      }, (err, stdout, stderr) => {
        if (!err) return res.json({ ok: true, output: String(stdout) });
        // Non-zero exit still carries useful stdout — return what we got.
        const out = (stdout ? String(stdout) : '') + (stderr ? String(stderr) : '');
        return res.json({ ok: false, output: out || (err.message || 'error'), error: err.message });
      });
    });
  });
}

// =====================
// ECOSYSTEM RESTART — the single full deploy+restart of BOTH boxes
// =====================
// Fired by holding the reload button in the header (2026-08-20). Until now the
// full restart existed only as `tools/deploy.sh` typed in a terminal — it was
// unreachable from anywhere inside the app.
//
// Why it spawns the SCRIPT and not restartControl.restart(): restartControl
// bounces THIS process only. deploy.sh is the whole ecosystem — it syncs, hits
// /api/deploy on the PC, waits for the build hash to flip, then does the Pi leg.
//
// Why it can just fire-and-forget: deploy.sh re-launches itself DETACHED
// (setsid, see its step 0), so PM2 killing this process tree cannot kill the
// deploy before it verifies the restart. The child we spawn here is only the thin
// log-follower; the real work outlives it — and outlives us.
//
// --force is passed on purpose: the operator held the button, so a byte-identical
// re-push is a deliberate act, not the accidental zero-change bounce the guard
// in deploy.sh exists to refuse.
//
// PC-canonical: only the PC has the repo. (Until 2026-10-12 the Pi proxied this
// prefix to the PC; the Machine no longer runs on the Pi.)
{
  const DEPLOY_SCRIPT = path.join(__dirname, '..', 'tools', 'deploy.sh');
  const ECO_LOG_DIR = path.join(require('os').homedir(), '.151machine', 'deploy-logs');

  app.post('/api/ecosystem-restart', (req, res) => {
    if (!fs.existsSync(DEPLOY_SCRIPT)) {
      return res.status(404).json({ ok: false, error: 'tools/deploy.sh not found on this machine' });
    }
    // Do not stack a restart on top of one already running.
    if (deploy.isRestartLockHeld()) {
      let holder = '-';
      try { holder = fs.readFileSync(deploy.RESTART_LOCK_PATH, 'utf8').split('\n')[0]; } catch {}
      return res.status(409).json({ ok: false, running: true, error: 'A restart is already running', holder });
    }
    try {
      fs.mkdirSync(ECO_LOG_DIR, { recursive: true });
      const { spawn } = require('child_process');
      const child = spawn('bash', [DEPLOY_SCRIPT, '--force'], {
        cwd: path.join(__dirname, '..'),
        detached: true,
        stdio: 'ignore',   // deploy.sh writes its own log file in ECO_LOG_DIR
        env: process.env,
      });
      child.unref();
      console.log(`[ECO-RESTART] tools/deploy.sh --force launched (follower pid=${child.pid}); logs in ${ECO_LOG_DIR}`);
      return res.json({ ok: true, started: true, pid: child.pid, logDir: ECO_LOG_DIR });
    } catch (e) {
      console.error('[ECO-RESTART] launch failed:', e.message);
      return res.status(500).json({ ok: false, error: e.message });
    }
  });
}

// [2026-10-12] Tolta la porta dell'intrattenimento (/api/plugins/entertainment/*
// → 151 Entertainment): l'intrattenimento è uscito dalla Machine.
{
  // NOTE (aggiornata 2026-09-10). La catena degli allarmi è finita, per intero:
  //   · 2026-08-20 — via il PLUGIN alert-center (campanella + pannello);
  //   · 2026-08-21 — via il deposito server/alert-center.js (64 KB mai letti);
  //   · 2026-09-10 — via l'ultima valvola, server/alert-log.js, insieme ai suoi
  //     tre produttori (dead-man, classifier-fallback, observatory-health) e al
  //     cruscotto Osservatorio che li mostrava. Decisione di progetto: niente avvisi.
  // Non esiste più nessun motore di allarmi, nessun alerts.json, nessuna rotta
  // proxy /api/plugins/observatory. Chi ha qualcosa da dire lo scrive nel log
  // normale con un console.log e basta.
}

// [2026-10-12] PEER RELAY — /api/relay/sessions, /api/relay/chat, /api/relay/stop
// and /api/relay/upload are gone: their only callers were the Machine on the Pi
// (PeerProc in server/peer-relay.js) and the retired Father. The hidden/ephemeral
// guards below (session-manager load, maintenance janitors) stay: they still
// clean any leftover child already on disk. History: git log -- server/peer-relay.js

// =====================
// PROTECTED ROUTES
// =====================

// Client-side diagnostic beacon. Lets phone/browser code report what actually
// happened (e.g. TTS playback failures) to a file we can read server-side,
// without needing a remote console. Append-only JSONL, best-effort, ungated.
app.post('/api/client-log', (req, res) => {
  try {
    const dir = path.join(os.homedir(), '.151machine');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'client-log.jsonl');
    rotateIfLarge(file, 2 * 1024 * 1024); // cap ~2 MB, keep 1 generation (.1)
    const line = JSON.stringify({ at: new Date().toISOString(), ...(req.body || {}) }) + '\n';
    fs.appendFile(file, line, () => {});
  } catch (_) {}
  res.json({ ok: true });
});

// Status routes — top bar data feeds (sessions/context/usage/ram/server).
// Each route carries requireAuth internally so this is safe to mount here.
const { createStatusRouter } = require('./status');
// `manager` non viene piu' passato: il solo lettore era il contatore di token
// dietro /api/status/usage, tolto il 2026-09-22 (vedi server/status.js).
app.use(createStatusRouter({ requireAuth }));

// TTS routes — Edge TTS synthesis (POST /api/tts).
const { createTTSRouter } = require('./tts');
app.use(createTTSRouter({ requireAuth }));

// [2026-09-22] Tolto il montaggio del wiki offline (server/wiki.js, cancellato
// nello stesso atto): era un proxy su kiwix-serve, che su questa macchina non
// e' installato dalla migrazione a Linux. Nessun client chiamava /api/wiki/* o
// /wiki/* — verificato su tutto il repo, public/ e app/ compresi.



// --- Sessions CRUD ---

// [2026-10-12] The Pi-side proxies of /api/sessions and /api/trash to the PC
// (and the Pi's 503 pcOffline when the PC was gone) are removed with the Pi
// relay. Offline, the phone's own copy (OfflineBridge.java) answers /api with
// 503 {offline:true}, which public/js/core.js api() raises as 'offline'.

// List trashed sessions (metadata only).
app.get('/api/trash', (req, res) => {
  try { res.json(manager.listTrash()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// Read one trashed session's transcript (readable text).
app.get('/api/trash/:id', (req, res) => {
  const text = manager.getTrashTranscript(req.params.id);
  if (text == null) return res.status(404).json({ error: 'Not found' });
  res.json({ id: req.params.id, text });
});

// Revive a trashed session back into the live list.
app.post('/api/trash/:id/restore', (req, res) => {
  try { res.json(manager.restoreTrash(req.params.id)); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

// Permanently delete one trash entry (empty it).
app.delete('/api/trash/:id', (req, res) => {
  const ok = manager.purgeTrash(req.params.id);
  if (!ok) return res.status(404).json({ error: 'Not found' });
  // Permanent delete (empty-trash) is the ONLY safe moment to drop a session's
  // attachments. close()'s uploads/<id> cleanup (session-manager.js:149-152)
  // covers a DIFFERENT store; the real leak is ~/.151machine/attachments/<id>,
  // which lives on as long as the trash entry does. restoreTrash() calls
  // purgeTrash() WITHOUT this block, so a revived session keeps its images.
  try {
    const safeId = String(req.params.id).replace(/[^a-zA-Z0-9_-]/g, '_');
    const attDir = path.join(ATTACHMENTS_DIR, safeId);
    if (fs.existsSync(attDir)) fs.rmSync(attDir, { recursive: true, force: true });
  } catch (e) { console.warn('[TRASH] attachment purge failed:', e && e.message); }
  res.status(204).end();
});

// [2026-10-12] Tolte le cinque rotte /api/raccoon/* (findings, ack, delivered,
// received, rejected) col bottone «Raccoon findings» del cestino: Raccoon e' fuori
// dalla flotta dal 2026-08-15 e la sua skill e' in commands/_archive dal 03/10.
// Il file dei reperti (~/.151machine/fleet/raccoon-findings.json) resta sul disco.

// [2026-10-12] Tolta GET /api/fleet/roster: nessun chiamante (la pagina legge
// session.agentNumber). Il file roster.json resta di claim.py.

app.get('/api/sessions', (_req, res) => {
  res.json(manager.list());
});

app.post('/api/sessions', (req, res) => {
  const session = manager.create({
    title: req.body.title,
    workingDirectory: req.body.workingDirectory,
    permissionMode: req.body.permissionMode,
  });
  // Propagate the new session LIVE to every other connected client (PC browser +
  // phones via the Pi proxy) so the row appears without a reload — the create
  // counterpart of the delete broadcast. The creating device already added it
  // optimistically (sessions.js createSession), so the client handler dedupes.
  broadcastSessionCreated(session);
  res.status(201).json(session);
});

app.patch('/api/sessions/:id', (req, res) => {
  try {
    manager.rename(req.params.id, req.body.title);
    res.json(manager.get(req.params.id));
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

app.patch('/api/sessions/:id/team', (req, res) => {
  try {
    manager.setTeam(req.params.id, req.body.team);
    res.json({ ok: true });
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

// CHIP MODELLO (2026-08-16): the models offered by the topbar chip picker
// (Fable 5, Opus 5, Opus 4-8 + the current terminal default, deduped).
app.get('/api/models', (_req, res) => {
  const { listSelectableModels, resolveModelChain } = require('./model-fallback');
  res.json({ models: listSelectableModels(), default: resolveModelChain()[0] });
});

// Le squadre e i super agenti scelti da chi usa l'app (server/squadre.js).
// Senza file → {}: il client mostra solo «New Session».
app.get('/api/squadre', (_req, res) => {
  res.json(require('./squadre').leggi());
});

// CHIP MODELLO (2026-08-16): re-pin an open session's model (chip picker,
// applies to the OPEN session only — special agents included). Effective from the
// NEXT message; see manager.setModel for how it reaches the real process on
// both engines. Lives under /api/sessions so the Pi proxy gate above forwards
// phone taps to the PC (the box that actually spawns Claude).
app.patch('/api/sessions/:id/model', (req, res) => {
  const m = String((req.body && req.body.model) || '').trim();
  // Same shape guard as deploy-pi's model sync — model ids only, no junk.
  if (!/^[A-Za-z0-9._\[\]-]{1,80}$/.test(m)) {
    return res.status(400).json({ error: 'Invalid model id' });
  }
  try {
    const dto = manager.setModel(req.params.id, m);
    // Live-propagate so chip + card update instantly on every device. Ship the
    // RESOLVED display model (a family pin like 'fable' resolves in setModel),
    // so every client renders a real model name right away.
    broadcastSessionModelChanged(req.params.id, dto.model);
    res.json(dto);
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

// Clear a session's conversation state in-place (fresh Claude context, same session)
app.post('/api/sessions/:id/clear', (req, res) => {
  try {
    const id = req.params.id;
    const session = manager.get(id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    if (session.status === 'busy') {
      return res.status(409).json({ error: 'Session is busy, wait for it to finish' });
    }
    manager.clearClaudeSessionId(id);
    session.history = [];
    manager.save();
    sendToSession(id, { type: 'session_cleared', sessionId: id });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Una sessione nel cestino della Machine, e tutti gli schermi lo sanno subito.
// Used by the manual trash.
function eliminaSessione(id) {
  manager.trashAndClose(id);
  sessionSockets.delete(id);
  sessionMessageQueue.delete(id);
  sessionLastJoin.delete(id);
  // Propagate the deletion LIVE to every other connected client (PC browser +
  // phone, both on this wss).
  // Without this, a delete on one device only shows on the other after a reload.
  broadcastSessionDeleted(id);
}

app.delete('/api/sessions/:id', (req, res) => {
  try {
    // 15/11: una sessione di prova è sparita senza traccia mentre le arrivava un vocale;
    // da qui ogni cancellazione dice da quale apparecchio è partita.
    const s0 = manager.get(req.params.id);
    console.log('[SESSION] delete', String(req.params.id).slice(0, 8),
      '«' + String((s0 && s0.title) || '?').slice(0, 30) + '»',
      'messaggi=' + ((s0 && Array.isArray(s0.history)) ? s0.history.length : '?'),
      'da=' + String((req.socket && req.socket.remoteAddress) || '?').replace(/^::ffff:/, ''),
      'ua=' + String(req.headers['user-agent'] || '?').replace(/[^\x20-\x7e]/g, '').slice(0, 60));
    eliminaSessione(req.params.id);
    res.status(204).end();
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});


// Live dictation transcription over HTTP. This REPLACES sending the voice clip on
// the chat /ws socket: a chat-socket hiccup (phone→Pi→PC relay) used to break BOTH
// chat AND dictation and silently drop the audio. HTTP POST + client-side retry
// survives those hiccups. Whisper runs on the PC (127.0.0.1:WHISPER_HTTP_PORT).
// [2026-10-12] The Pi-side proxy of /api/dictation to the PC is gone with the relay.

// Ritiro del risultato già prodotto. Il client lo interroga in parallelo alla
// POST (e dopo un fallimento) — se la risposta della POST si è persa per strada,
// il testo si recupera da qui invece di restare sepolto nel recupero su disco.
app.get('/api/dictation/result/:clipId', (req, res) => {
  const clipId = req.params.clipId;
  if (!isSafeClipId(clipId)) return res.status(400).json({ error: 'bad clipId' });
  const r = readDictationResult(clipId);
  if (!r) return res.status(404).json({ status: 'pending' });
  console.log('[dictation] result fetched clipId=' + clipId + ' chars=' + (r.text || '').length);
  const out = { status: 'done', text: r.text || '' };
  if (r.esito) out.sent = (r.esito === 'mandato' || r.esito === 'in-attesa' || r.esito === 'doppione');
  return res.json(out);
});

app.post('/api/dictation/transcribe',
  (req, res, next) => {
    // A ~1h clip can take many minutes on CPU whisper — don't let Express kill it.
    try {
      if (req.setTimeout) req.setTimeout(65 * 60 * 1000);
      if (res.setTimeout) res.setTimeout(65 * 60 * 1000);
    } catch (e) {}
    next();
  },
  (req, res, next) => {
    dictationUpload.single('file')(req, res, (err) => {
      if (err) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return res.status(413).json({ error: 'Clip too large — max 200 MB' });
        }
        return res.status(400).json({ error: err.message || 'Upload failed' });
      }
      next();
    });
  },
  async (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: 'No audio provided (expected multipart field "file")' });
    }
    // «Invia mentre registri»: si risponde appena l'audio è qui (202) e il
    // server trascrive e manda da solo nella sessione `sendTo` — il telefono può
    // già essere chiuso. Senza clipId niente doppioni garantiti: si rifiuta.
    if (req.query.sendTo != null) {
      const clipId = isSafeClipId(req.query.clipId) ? req.query.clipId : null;
      const sid = String(req.query.sendTo || '');
      if (!clipId || !sid) {
        try { fs.unlinkSync(req.file.path); } catch (e) {}
        return res.status(400).json({ error: 'sendTo needs clipId' });
      }
      const prefisso = (req.body && typeof req.body.prefix === 'string') ? req.body.prefix.slice(0, 20000) : '';
      // multer salva senza estensione: la si rimette, così una clip conservata si riconosce.
      let file = req.file.path;
      const ext = path.extname((req.file && req.file.originalname) || '');
      if (ext) { try { fs.renameSync(file, file + ext); file = file + ext; } catch (e) {} }
      const r = invioDettatura.accetta({ clipId, sessionId: sid, prefisso, file, lingua: req.query.language || 'auto' });
      console.log('[dictation] invia clipId=' + clipId + ' bytes=' + (req.file.size || 0) + ' -> ' + r.stato);
      return res.status(202).json({ accepted: true, clipId, state: r.stato });
    }
    // Restart guard (punto 4): count this transcription as in-flight until the
    // response is done (success, error, or client gone) so a deploy/restart
    // waits for the text to be delivered. res 'close' fires in every outcome.
    const _readiness = require('./restart-readiness');
    _readiness.beginTranscribe();
    // Sonda di CONSEGNA — registrata QUI, non dopo la trascrizione. Se il socket
    // muore mentre whisper macina, 'close' scatta PRIMA che il codice arrivi in
    // fondo: un listener aggiunto dopo non verrebbe mai chiamato, cioè proprio
    // il caso rotto sparirebbe dal log. writableFinished distingue "risposta
    // scritta fino in fondo" da "client sparito a metà".
    const _probe = { chars: -1, clipId: null };
    res.once('close', () => {
      _readiness.endTranscribe();
      const delivered = res.writableFinished === true;
      console.log('[dictation] deliver clipId=' + (_probe.clipId || 'n/d') +
        ' ok=' + delivered + ' chars=' + _probe.chars +
        (delivered ? '' : ' — CONSEGNA PERSA, ritirabile=' + (_probe.clipId ? 'si' : 'NO')));
    });
    const absPath = req.file.path;
    const language = req.query.language || 'auto';
    const clipId = isSafeClipId(req.query.clipId) ? req.query.clipId : null;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    _probe.clipId = clipId;
    const t0 = Date.now();
    pruneDictationRecovery();

    // Idempotenza: se questo clipId è già stato trascritto (tipico del ritento
    // dopo una consegna persa) NON si rifà passare whisper — si restituisce il
    // testo già pronto. Prima costava una seconda trascrizione completa.
    if (clipId) {
      const cached = readDictationResult(clipId);
      if (cached) {
        try { fs.unlinkSync(absPath); } catch (e) {}
        console.log('[dictation] clipId=' + clipId + ' già trascritto — risposta dalla cache, chars=' + (cached.text || '').length);
        return res.json({ text: cached.text || '', cached: true });
      }
    }
    console.log('[dictation] start clipId=' + (clipId || 'n/d') + ' bytes=' + (req.file.size || 0) + ' lang=' + language);
    // Keep a failed clip instead of deleting it — rename into the recovery dir
    // so the dictation can be re-run even when the phone client kept nothing.
    function keepClip() {
      try {
        const ext = path.extname((req.file && req.file.originalname) || '') || '.webm';
        const saved = path.join(dictationRecoveryDir, 'clip-' + stamp + ext);
        fs.renameSync(absPath, saved);
        return saved;
      } catch (e) { return null; }
    }
    try {
      const r = await transcribe.transcribeAudioFile(absPath, language);
      if (!r.ok) {
        const saved = keepClip();
        console.warn('[dictation] transcribe failed clipId=' + (clipId || 'n/d') + ' (' + (r.error || '?') + ') — clip kept at ' + (saved || absPath));
        return res.status(502).json({ error: r.error || 'transcription failed', savedClip: saved });
      }
      // Success: write a recovery copy of the TEXT before answering — if the
      // caller died mid-wait (locked phone), the transcript is still on disk.
      try { fs.writeFileSync(path.join(dictationRecoveryDir, 'text-' + stamp + '.txt'), r.text || '', 'utf-8'); } catch (e) {}
      // …e, se il clip ha un id, deposita il risultato ritirabile: è questo che
      // trasforma una consegna persa in una consegna solo rimandata.
      if (clipId) writeDictationResult(clipId, r.text || '');
      try { fs.unlinkSync(absPath); } catch (e) {}
      const chars = (r.text || '').length;
      const ms = Date.now() - t0;
      console.log('[dictation] done clipId=' + (clipId || 'n/d') + ' chars=' + chars + ' ms=' + ms + ' retrievable=' + (clipId ? 'si' : 'NO'));
      _probe.chars = chars;
      return res.json({ text: r.text || '' });
    } catch (e) {
      const saved = keepClip();
      console.warn('[dictation] transcribe error (' + e.message + ') — clip kept at ' + (saved || absPath));
      return res.status(500).json({ error: e.message || 'transcription error', savedClip: saved });
    }
  }
);

// Generic chat attachment upload — paperclip flow from phone client.
// Auth: inherits global /api JWT middleware (mounted above at app.use('/api', ...)).
// Returns metadata so client can echo it back inside the chat message payload.
app.post('/api/attachments',
  (req, res, next) => {
    // Large mobile video uploads can take several minutes over cellular.
    // Extend socket timeout for this route so Express doesn't kill the stream.
    try {
      if (req.setTimeout) req.setTimeout(15 * 60 * 1000); // 15 min
      if (res.setTimeout) res.setTimeout(15 * 60 * 1000);
    } catch (e) {}
    next();
  },
  (req, res, next) => {
    attachmentUpload.single('file')(req, res, (err) => {
      if (err) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return res.status(413).json({ error: 'File too large — max 500 MB per attachment' });
        }
        return res.status(400).json({ error: err.message || 'Upload failed' });
      }
      next();
    });
  },
  (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: 'No file provided (expected multipart field "file")' });
    }
    const mime = req.file.mimetype || 'application/octet-stream';
    const absPath = req.file.path;
    const isAV = mime.toLowerCase().startsWith('audio/') || mime.toLowerCase().startsWith('video/');
    const transcriptStatus = isAV ? 'pending' : 'skipped';

    // Fire-and-forget async transcription. sendMessage re-checks for the
    // cached transcript file at send-time, so the client can submit the
    // chat message immediately without blocking on whisper.
    if (isAV) {
      setImmediate(() => {
        transcribe.transcribeAttachment(absPath, mime).catch((e) => {
          console.warn('[attach-srv] async transcribe error:', e.message);
        });
      });
    }

    // M9 Fase C · Vettore 6 (RESTART_MEMORY-gated): if this is an upload-on-add
    // (client attached a file but hasn't sent yet, ?draft=1), pin the stored path
    // so the boot orphan-sweep won't delete it before the draft is sent. The
    // client unpins on send/remove/clear via /api/attachments/unpin. Flag off ⇒
    // no pin (and no sweep either) ⇒ byte-identical. Runs on the PC (the Pi
    // proxies this route here), where the file + registry both live.
    if (process.env.RESTART_MEMORY && req.query.draft) {
      try {
        const sid = (req.body && req.body.sessionId) || req.query.sessionId || null;
        draftAttachments.pin(sid, [absPath]);
      } catch (e) { console.warn('[attach-srv] draft pin failed:', e.message); }
    }

    res.json({
      path: absPath,
      name: req.file.originalname,
      mime,
      size: req.file.size,
      transcriptStatus,
    });
  }
);

// M9 Fase C · Vettore 6: unpin draft-attached paths (client sent/removed/cleared
// them). Same /api/attachments proxy passthrough as the upload route (the Pi
// forwards it to the PC where the registry lives). Inert when RESTART_MEMORY is
// off. Best-effort: always 200 so the client fire-and-forget never surfaces an
// error to the owner.
app.post('/api/attachments/unpin', (req, res) => {
  if (process.env.RESTART_MEMORY) {
    try {
      const paths = (req.body && Array.isArray(req.body.paths)) ? req.body.paths : [];
      if (paths.length) draftAttachments.unpin(paths);
    } catch (e) { console.warn('[attach-srv] draft unpin failed:', e.message); }
  }
  res.json({ ok: true });
});

// Slash commands
app.get('/api/commands', (_req, res) => {
  try {
    const files = fs.readdirSync(COMMANDS_DIR).filter(f => f.endsWith('.md'));
    const commands = [];
    for (const f of files) {
      const name = f.replace('.md', '');
      let description = '';
      let hidden = false;
      try {
        const content = fs.readFileSync(path.join(COMMANDS_DIR, f), 'utf-8');
        const lines = content.split('\n');
        let inFrontmatter = false;
        let firstContent = '';
        for (const line of lines) {
          if (line.trim() === '---') { inFrontmatter = !inFrontmatter; continue; }
          if (inFrontmatter) {
            const lower = line.trim().toLowerCase();
            if (lower.startsWith('description:')) {
              description = line.trim().slice(12).trim().replace(/^["']|["']$/g, '');
            }
            if (lower === 'hidden: true') hidden = true;
            continue;
          }
          if (!firstContent && line.trim()) firstContent = line.trim().slice(0, 100);
        }
        if (!description) description = firstContent;
      } catch {}
      if (!hidden) commands.push({ name, description });
    }
    res.json(commands);
  } catch {
    res.json([]);
  }
});

const openSockets = new Set();

// =====================
// HTTP + WEBSOCKET SERVER
// =====================

const server = http.createServer(app);
// noServer: the upgrade handler below accepts only /ws. [2026-10-12] Until
// today it could also proxy the whole /ws to the PC when this box was the Pi
// (no CLI), or close it with 4003 «solo Pi»; both are gone with the Pi relay.
const wss = new WebSocketServer({ noServer: true, maxPayload: 100 * 1024 * 1024 }); // 100 MB — fits 10-min Native VoiceRecorder single-blob upload
// Expose wss on globalThis so in-process plugins can broadcast to all clients
// without a JWT-gated HTTP round-trip. (Originally added for lab_card_created;
// the Lab app is gone but the hook stays — it is a generic broadcast surface.)
globalThis.__151_wss = wss;
wss.on('connection', (ws) => sudoTelefono.alCollegamento(ws));

server.on('upgrade', (req, socket, head) => {
  // Il muro anche qui: l'upgrade non passa dai middleware di Express.
  if (!muro.upgrade(req, socket)) return;
  let pathname = '/';
  try { pathname = new URL(req.url, 'http://x').pathname; } catch {}
  if (pathname !== '/ws') { try { socket.destroy(); } catch {} return; }

  // Local — exact equivalent of the previous `{ server, path:'/ws' }` binding.
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

// Track all open sockets so we can destroy them on shutdown
server.on('connection', (socket) => {
  openSockets.add(socket);
  socket.on('close', () => openSockets.delete(socket));
});

function closeServersAndExit(exitCode, forceExitCode, forceDelayMs) {
  let exited = false;
  function exitNow(code, message) {
    if (exited) return;
    exited = true;
    if (message) console.log(message);
    process.exit(code);
  }

  try { wss.close(); } catch {}
  wss.clients.forEach((ws) => {
    try { ws.terminate(); } catch {}
  });

  try {
    server.close(() => {
      exitNow(exitCode, '[SHUTDOWN] Server closed cleanly');
    });
  } catch {
    exitNow(exitCode, '[SHUTDOWN] Server already closed');
    return;
  }

  for (const socket of openSockets) {
    try { socket.destroy(); } catch {}
  }
  openSockets.clear();

  setTimeout(() => {
    exitNow(forceExitCode, '[SHUTDOWN] Force exit after timeout');
  }, forceDelayMs);
}

function handleListenError(err) {
  if (err.code === 'EADDRINUSE') {
    // Non-destructive policy: DO NOT kill the blocking PID — that was
    // orphaning our own child CLI processes on fast restarts. Instead:
    //   1. Clean up OUR children so we don't orphan them on the way out.
    //   2. Exit non-zero and let PM2 retry per restart_delay / max_restarts.
    // PM2 is the retry layer now, not this inline loop.
    console.error(`[BOOT] Port ${PORT} in use (EADDRINUSE). Cleaning own children and exiting — PM2 will retry.`);
    try {
      restartIntent.writeIntent({
        actor: 'boot-eaddrinuse',
        reason: 'port conflict on boot',
        detail: `PORT=${PORT} already bound; exiting so PM2 retries`,
      });
    } catch {}
    const bail = (code) => {
      try { manager.saveSync(); }
      catch (e) { console.warn('[SHUTDOWN] session saveSync failed on bail:', e && e.message); }
      process.exit(code);
    };
    try {
      manager.killAllProcessesAsync(3000).then(() => bail(1)).catch(() => bail(1));
    } catch {
      bail(1);
    }
    // Hard safety net in case killAllProcessesAsync hangs
    setTimeout(() => bail(1), 5000);
  } else {
    console.error('[BOOT] Server error:', err.message);
    // Phase 6 amnesia-fix: attribute the exit so the next boot's banner
    // reports a real cause instead of synthesizing "unattributed restart".
    // writeIntent is sync (fs.writeFileSync under the hood) so it completes
    // before process.exit(1).
    try {
      restartIntent.writeIntent({
        actor: 'system',
        reason: 'listen error',
        detail: `non-EADDRINUSE: ${err.code || err.message}`,
      });
    } catch {}
    process.exit(1);
  }
}

server.on('error', handleListenError);

// Relay client (initialized after server starts)

// Track active WS connections per session (multi-device: phone + desktop can both subscribe)
const sessionSockets = new Map();      // sessionId -> Set<ws>
const sessionMessageQueue = new Map(); // sessionId -> Array of messages (full queue while disconnected)
// Phase 5a daemon replay: set of session IDs we've already replayed this
// main-server lifetime. Cleared per-session when the adopted RemoteProc
// emits 'close'. See server/session-host-replay.js for the full guard flow.
const globalReplayedSet = new Set();
const sessionLastJoin = new Map();     // sessionId -> timestamp (dedup rapid joins)
const globalProcessedNonces = new Set(); // "${sessionId}:${nonce}" — survives reconnects & cross-device resends

// [NONCE-PERSIST 2026-08-15] Durable reseed: rebuild the processed-nonce set
// from the nonces stamped on history user entries (session-manager sendMessage
// stamps them; _serializeAll persists history verbatim; manager.load() ran at
// line ~294, long before this). A client's redeliverPending fires the ORIGINAL
// nonce after a PC restart — without this reseed that nonce is unknown and the
// message RE-EXECUTES as a duplicate turn. With it, the dup is skipped + acked.
// History is the truth anchor: entry in history = message already accepted.
// Kept to the newest 2000 (same cap as the runtime FIFO trim in ws-handler.js),
// inserted oldest-first so the runtime trim keeps evicting the oldest.
try {
  const _seedNonces = [];
  for (const [_sid, _sess] of manager.sessions) {
    if (!_sess || !Array.isArray(_sess.history)) continue;
    for (const _entry of _sess.history) {
      if (_entry && _entry.role === 'user' && _entry.nonce) {
        _seedNonces.push({ key: _sid + ':' + _entry.nonce, ts: _entry.timestamp || 0 });
      }
    }
  }
  // [12/11/2026 ] Anche i messaggi in coda salvati (attesa): sono già
  // accettati, e il telefono ora li rimanda col loro nonce finché non ha l'ack.
  if (manager._waitingMessages instanceof Map) {
    for (const [_sid, _list] of manager._waitingMessages) {
      for (const _w of (Array.isArray(_list) ? _list : [])) {
        if (_w && _w.nonce) _seedNonces.push({ key: _sid + ':' + _w.nonce, ts: Date.now() });
      }
    }
  }
  _seedNonces.sort((a, b) => a.ts - b.ts);
  for (const _s of _seedNonces.slice(-2000)) globalProcessedNonces.add(_s.key);
  if (_seedNonces.length) {
    console.log('[NONCE-PERSIST] reseeded ' + Math.min(_seedNonces.length, 2000) + ' processed nonce(s) from history');
  }
} catch (err) {
  console.warn('[NONCE-PERSIST] reseed failed:', err.message);
}

function addSessionSocket(sessionId, ws) {
  let set = sessionSockets.get(sessionId);
  if (!set) { set = new Set(); sessionSockets.set(sessionId, set); }
  set.add(ws);
}

function removeSessionSocket(sessionId, ws) {
  const set = sessionSockets.get(sessionId);
  if (!set) return;
  set.delete(ws);
  if (set.size === 0) sessionSockets.delete(sessionId);
}

function getSessionSockets(sessionId) {
  const set = sessionSockets.get(sessionId);
  if (!set) return [];
  return Array.from(set).filter(ws => ws && ws.readyState === 1);
}

const SESSION_QUEUE_CAP = 5000;
const sessionQueueOverflowWarned = new Set();
function queueMessage(sessionId, data) {
  if (!sessionMessageQueue.has(sessionId)) {
    sessionMessageQueue.set(sessionId, []);
  }
  const queue = sessionMessageQueue.get(sessionId);
  // Cap queue to prevent memory issues; warn once per session on first overflow
  if (queue.length < SESSION_QUEUE_CAP) {
    queue.push(data);
  } else if (!sessionQueueOverflowWarned.has(sessionId)) {
    sessionQueueOverflowWarned.add(sessionId);
    console.warn(`[queueMessage] session ${sessionId} hit queue cap (${SESSION_QUEUE_CAP}) — dropping further messages until drained`);
  }
}

// Broadcast session status change to ALL connected clients (so sidebar updates everywhere)
function broadcastSessionStatus(sessionId, status, extra) {
  const session = manager.get(sessionId);
  const msg = JSON.stringify({
    type: 'session_status_changed',
    sessionId,
    status,
    title: session ? session.title : undefined,
    lastMessage: session ? session.lastMessage : undefined,
    ...extra,
  });
  wss.clients.forEach((client) => {
    if (client.readyState === 1) {
      try { client.send(msg); } catch {}
    }
  });
}

// Broadcast a session deletion to ALL connected clients so the row vanishes
// live on every device (no manual reload). Mirrors broadcastSessionStatus' fanout.
function broadcastSessionDeleted(sessionId) {
  const msg = JSON.stringify({ type: 'session_deleted', sessionId });
  wss.clients.forEach((client) => {
    if (client.readyState === 1) {
      try { client.send(msg); } catch {}
    }
  });
}

// CHIP MODELLO (2026-08-16): propagate a session's model re-pin LIVE to every
// client so the topbar chip and the session card update instantly on PC and
// phone (the Pi's upstream socket is in wss.clients, so proxied phones get it).
function broadcastSessionModelChanged(sessionId, model) {
  const msg = JSON.stringify({ type: 'session_model_changed', sessionId, model });
  wss.clients.forEach((client) => {
    if (client.readyState === 1) {
      try { client.send(msg); } catch {}
    }
  });
}

// Broadcast a NEW session to ALL connected clients so the row appears live on
// every device (no manual reload) — the create counterpart of the delete
// broadcast above. Carries the full serialized session so the receiving client
// can render the card without an extra fetch. Same fanout (wss.clients). Hidden/
// ephemeral children (left over from the old /api/relay/sessions) never reach this.
function broadcastSessionCreated(session) {
  if (!session || session.hidden || session.ephemeral) return;
  const msg = JSON.stringify({ type: 'session_created', session });
  wss.clients.forEach((client) => {
    if (client.readyState === 1) {
      try { client.send(msg); } catch {}
    }
  });
}

// Fix 2 (2026-07-21): the moment a fleet session is stamped with its agentType +
// monotonic agentNumber (session-manager _stampFleet), push it to ALL clients so
// the card renders its number/color instantly — no reload. Carries the stamped
// fields the client card needs (fleetDisplayName reads agentNumber directly).
manager.onFleetStamp = function (info) {
  if (!info || !info.sessionId) return;
  const msg = JSON.stringify({
    type: 'session_fleet_stamped',
    sessionId: info.sessionId,
    agentType: info.agentType,
    agentNumber: info.agentNumber,
    title: info.title,
  });
  wss.clients.forEach((client) => {
    if (client.readyState === 1) {
      try { client.send(msg); } catch {}
    }
  });
};

// Hoisted forward decl so permissions.init can reference sendToSession
// before its full definition is evaluated. (Function declarations hoist; this
// comment is just documentation for the reader.)
function sendToSession(sessionId, data, options = {}) {
  // options.exclude: a ws to skip (used when echoing user messages back to non-sender devices)
  // Detached-runs (flag DETACHED_RUNS): stamp `data._seq` + append to the ordered
  // replay log BEFORE serialising, so the LIVE payload carries the sequence number
  // AND a reconnecting client can replay exactly what it missed. Inert + no `_seq`
  // stamped when the flag is off → off-path byte-identical. Only stream events are
  // logged (see stream-log LOGGABLE); control frames pass straight through.
  // [2026-10-01] Ogni pezzo porta il nome della SUA sessione. il proprietario: «se passo
  // veloce da una sessione all'altra, la risposta di una appare nell'altra».
  // Il socket viene spostato di sessione al `join`, ma i pezzi già in volo
  // arrivano dopo, e il client li incollava nella bolla della sessione aperta
  // — senza poter sapere di chi fossero. Col nome sopra, il client li scarta.
  if (data && typeof data === 'object' && !Array.isArray(data) && data.sessionId == null) {
    data = Object.assign({ sessionId }, data);
  }
  if (process.env.DETACHED_RUNS) { try { streamLog.record(sessionId, data); } catch {} }
  const sockets = getSessionSockets(sessionId);
  if (sockets.length === 0) {
    // No subscribed clients — queue ALL message types
    queueMessage(sessionId, data);
    return;
  }
  const payload = JSON.stringify(data);
  // Flush queued messages to any subscriber once (first broadcast drains the queue)
  const queue = sessionMessageQueue.get(sessionId);
  if (queue && queue.length > 0) {
    const queuedPayload = JSON.stringify({ type: 'queued_messages', sessionId, messages: queue });
    for (const sock of sockets) {
      if (options.exclude && sock === options.exclude) continue;
      try { sock.send(queuedPayload); } catch {}
    }
    sessionMessageQueue.delete(sessionId);
  }
  let delivered = 0;
  let trattenuti = 0;
  for (const sock of sockets) {
    if (options.exclude && sock === options.exclude) continue;
    // [10/11/2026 BATTERIA ] Telefono con lo schermo spento: niente pezzi
    // della risposta (tornano col replay al ritorno). Il perché e le condizioni
    // che non perdono testo: server/schermo-spento.js.
    if (schermoSpento.trattieni(sock, sessionId, data)) { trattenuti++; continue; }
    try {
      sock.send(payload);
      delivered++;
    } catch (err) {
      console.error(`[WS] Send error for ${sessionId.slice(0, 8)}:`, err.message);
    }
  }
  if (delivered === 0 && trattenuti === 0 && !options.exclude) {
    // All sockets failed — queue for next reconnect (a piece held back on
    // purpose for a sleeping phone is in the stream log, not a failure)
    queueMessage(sessionId, data);
  }
}

// =====================
// MODULE WIRING
// =====================

({ spawnStreamHandler } = createStreamHandler({
  manager,
  sendToSession,
  broadcastSessionStatus,
  getPluginManager: () => pluginManager,
}));

// [2026-09-30] Turni spontanei del motore SDK (ordine del proprietario): un agente che
// chiude dicendo «ti avviso quando il lavoro in background finisce» ORA avvisa
// davvero. Il motore apre il turno, qui lo si attacca allo stesso tubo di un
// turno normale — busy, flusso, storia, idle → «risposta pronta» + notifica.
if (process.env.USE_SDK_ENGINE === '1') {
  const sdkEngine = require('./sdk-engine');
  sdkEngine.setUnsolicitedTurnHandler((sid, proc) => {
    if (!manager.adoptUnsolicitedTurn(sid, proc)) return false;
    broadcastSessionStatus(sid, 'busy');
    spawnStreamHandler(proc, sid);
    return true;
  });
  sdkEngine.setBackgroundTasksHandler((sid, count) => {
    // Tipo di messaggio a parte, apposta: un session_status_changed 'idle'
    // farebbe partire il toast «finished» e la notifica sul telefono.
    // [17/10/2026] Anche se il turno sta solo aspettando (waiting) e quali
    // lavori: la card dice «aspetta N lavori in sottofondo» col tasto per fermarli.
    let info = { count, waiting: false, tasks: [], stopped: 0 };
    try { info = sdkEngine.backgroundInfo(sid); } catch {}
    // [29/10/2026] + backgroundStopped: gli aiutanti fermati restano sulla card.
    const msg = JSON.stringify({ type: 'session_background', sessionId: sid, backgroundTasks: count,
      waiting: !!info.waiting, tasks: info.tasks || [], backgroundStopped: info.stopped || 0 });
    wss.clients.forEach((client) => {
      if (client.readyState === 1) { try { client.send(msg); } catch {} }
    });
  });
}

({ generateAutoTitleStage1, generateAutoTitleStage2 } = createAutoTitle({
  manager,
  wss,
  CLAUDE_BIN,
}));

const deployHandler = deploy.createDeployHandler({
  manager, wss, restartIntent, closeServersAndExit, serverState,
  getPluginManager: () => pluginManager,
});
// Register deploy.js's plannedShutdown as the mechanism behind the single
// in-process restart funnel (restart-control.restart). NOTHING else may call
// plannedShutdown directly — every intentional restart goes through restart().
plannedShutdown = deployHandler.plannedShutdown;
restartControl.registerShutdownImpl(deployHandler.plannedShutdown);
app.post('/api/deploy', deployHandler.deployRoute);

const _wsHandler = setupWsHandler(wss, {
  manager, isTokenValid, sendToSession, broadcastSessionStatus,
  addSessionSocket, removeSessionSocket,
  spawnStreamHandler, generateAutoTitleStage1, generateAutoTitleStage2,
  sessionMessageQueue, sessionLastJoin, globalProcessedNonces, globalReplayedSet,
  serverState, SERVER_BOOT,
});
consegnaDalServer = _wsHandler && _wsHandler.consegnaDalServer;


// =====================
// SERVER START + RESUME
// =====================

function startServer() {
  server.listen(PORT, '::', () => {
    console.log(`\n[151 Terminal] Server running on port ${PORT}`);
    console.log(`[151 Terminal] Device: ${config.deviceId}`);
    console.log(`[151 Terminal] Status: ${config.password ? 'configured' : 'first run \u2014 needs setup'}\n`);

    // Amnesia-fix Phase 4: consume any restart intent left by the triggering
    // agent, or synthesize "unknown actor" if the previous heartbeat shows a
    // surprise gap. Start the 30s heartbeat so the NEXT boot can detect a
    // surprise restart on OUR watch.
    // `culpritSessionId` (callback scope) names the session that FIRED this
    // restart so the resume loop below can refuse to auto-re-run its message —
    // the deterministic break for the bounce/amnesia loop.
    let culpritSessionId = null;
    let culpritCommand = null;
    try {
      lastRestartBanner = restartIntent.readAndConsumeIntent();
      if (!lastRestartBanner) {
        lastRestartBanner = restartIntent.detectUnexpectedRestart();
      }
      // Attribution: if a chat session fired the command that bounced us, name
      // it in the banner (stamped at tool_use by stream-handler). Robust to
      // however many times writeIntent ran during shutdown — the culprit file
      // is independent and only consumed here, on boot.
      if (lastRestartBanner) {
        try {
          const culprit = restartIntent.readAndConsumeCulprit();
          if (culprit) {
            culpritSessionId = culprit.sessionId || null;
            culpritCommand = culprit.command || null;
            if (culprit.title) {
              lastRestartBanner.sessionTitle = culprit.title;
              lastRestartBanner.sessionId = culprit.sessionId || null;
              lastRestartBanner.actor = culprit.title;
              const from = `session «${culprit.title}»`;
              lastRestartBanner.detail = lastRestartBanner.detail
                ? `${lastRestartBanner.detail} | ${from}`
                : from;
            }
          }
        } catch (e) { console.error('[BOOT] culprit merge failed:', e.message); }
      }
      if (lastRestartBanner) {
        console.log(`[BOOT] Restart banner: actor=${lastRestartBanner.actor} reason=${lastRestartBanner.reason}`);
      } else {
        console.log('[BOOT] No restart banner (clean boot or heartbeat fresh).');
      }
      // Observatory: stamp every boot so the holes view can flag repeated
      // restarts (the "catch the mole" signal). Fire-and-forget; only the PC
      // (source of truth) keeps the canonical log, but logging here is harmless
      // on either box.
      try {
        require('./event-log').logEvent('restart', {
          reason: (lastRestartBanner && lastRestartBanner.reason) || 'boot',
          actor: (lastRestartBanner && lastRestartBanner.actor) || 'system',
          expected: !!lastRestartBanner,
          culprit: culpritSessionId || null,
          // M9 soak ledger: how many live sessions this restart interrupted and
          // queued for auto-resume. A clean soak = every restart's to_resume was
          // recovered with no manual resume (cross-checked against the per-session
          // "[BOOT] Resumed" logs / "Failed to resume" markers).
          to_resume: (typeof resumeIds !== 'undefined' && resumeIds) ? resumeIds.length : 0,
        });
      } catch {}

      // Traccia scritta del riavvio, accanto al banner che l'interfaccia mostra
      // già da sé. [2026-08-21] era l'Alert Center; [2026-09-10] anche la valvola
      // alert-log è sparita ⇒ una riga di log, che è tutto ciò che questo posto
      // ha mai davvero prodotto.
      //
      // ⚠ Qui è caduto ANCHE il rilevatore di crash-loop, e non per svista: si
      // accendeva su `pushed.count >= 3`, cioè sul contatore in MEMORIA di
      // alert-log. Quel contatore nasce vuoto a ogni avvio del processo, e
      // questo blocco gira UNA volta sola, in avvio: count valeva sempre 1.
      // Il ramo non poteva scattare nemmeno in teoria — non è mai scattato.
      if (lastRestartBanner) {
        try {
          const unattributed = lastRestartBanner.actor === 'unknown'
            || /unattributed/i.test(lastRestartBanner.reason || '');
          const who = lastRestartBanner.sessionTitle
            ? `«${lastRestartBanner.sessionTitle}»`
            : (lastRestartBanner.actor || 'system');
          const bodyParts = [];
          if (lastRestartBanner.reason) bodyParts.push(lastRestartBanner.reason);
          bodyParts.push('attore: ' + who);
          if (lastRestartBanner.detail) bodyParts.push(lastRestartBanner.detail);
          // M9 · Obj 3: l'ESITO del recupero sta nella stessa riga — quante
          // sessioni sono riprese da sole. `resumeIds` è già calcolato al carico
          // del modulo (resumeInterrupted, ~riga 296); nessun ricalcolo.
          if (typeof resumeIds !== 'undefined' && resumeIds && resumeIds.length > 0) {
            const n = resumeIds.length;
            bodyParts.push(n === 1 ? 'recuperato · 1 sessione ripresa' : `recuperato · ${n} sessioni riprese`);
          }
          const title = unattributed ? 'Riavvio non atteso del server' : 'Server riavviato';
          const line = `[RESTART] ${title} — ${bodyParts.join(' · ')}`;
          if (unattributed) console.warn(line); else console.log(line);
        } catch (e) { console.error('[BOOT] restart log failed:', e.message); }
      }

      restartIntent.startHeartbeat();
    } catch (err) {
      console.error('[BOOT] restart-intent init failed:', err.message);
    }

    // RESTART_MEMORY: prune stale/excess per-session action journals on boot so
    // they never accumulate forever (inert when the flag is off).
    if (process.env.RESTART_MEMORY) {
      try { require('./restart-journal').prune(); } catch {}
    }

  // Resume interrupted sessions
  const pendingResumes = manager.getPendingResumes();
  for (const { id, text, attachments } of pendingResumes) {
    try {
      const session = manager.sessions.get(id);
      if (!session) continue;

      // AMNESIA-LOOP BREAKER (RESTART_MEMORY, deterministic). NEVER auto-resume
      // the session that FIRED this restart. Re-sending its last message would
      // re-run the deploy/pm2 command that bounced us → the server bounces again
      // → on each brief boot EVERY session is mute because nothing is stable.
      // That is the "all sessions go mute + the restarter forgets it restarted"
      // bug. Instead: keep the interrupted reply (marked), arm the one-shot
      // recovery note for the NEXT human-sent turn, and DO NOT re-send. The
      // command almost certainly completed (it restarted us); a human verifies.
      if (process.env.RESTART_MEMORY && culpritSessionId && id === culpritSessionId) {
        session.status = 'idle';
        session.process = null;
        const last = session.history[session.history.length - 1];
        if (last && last.partial) {
          try {
            const rj = require('./restart-journal');
            if (last.content && last.content.trim()) {
              rj.recordAction(id, { kind: 'partial_text', tool: 'assistant', result: last.content });
            }
          } catch {}
          last.content += '\n\n*[Interrupted by a server restart this session triggered — not auto-resumed, to avoid a restart loop. The command almost certainly completed; verify before re-running it.]*';
          last.partial = false;
        }
        session._restartNote = lastRestartBanner
          ? { at: lastRestartBanner.at, reason: lastRestartBanner.reason }
          : { at: new Date().toISOString(), reason: 'server restart (self-triggered)' };
        session._resumeAttempts = 0;
        manager.clearPendingResume(id);

        // AUTO POST-DEPLOY VERIFY. The breaker above refuses to re-send the
        // culprit's last message (it carried the deploy/pm2 command → re-sending
        // would bounce us again = the loop). But when the trigger was a DEPLOY,
        // leaving the session frozen until the owner types "I saw the restart, what's
        // up" is exactly the friction he hates. So instead of waiting, inject ONE
        // fresh, DISTINCT verification turn. It is loop-safe by construction: the
        // injected text contains NO deploy/pm2 command, so it cannot restart us;
        // and a one-shot disk marker (post-deploy-verify.json, 5-min freshness,
        // keyed by session id) guarantees that even a pathological re-restart
        // auto-verifies at most once before falling back to the passive note.
        try {
          // PRIMARY trigger: an explicitly-ARMED marker (written before the
          // restart by restart-control or the stream-handler chokepoint). It
          // carries the nonce + intent + the session id, so it fires precisely
          // and needs no guesswork. readArmedVerify auto-drops anything past the
          // 5-min freshness window (an arm-but-fail restart can't fire late).
          const armed = restartIntent.readArmedVerify();
          const armedForThis = !!(armed && armed.sessionId === id);

          // FALLBACK heuristic (kept for restarts that armed nothing — e.g. an
          // older build, or a path we haven't funneled yet). culpritCommand is
          // only recorded when stream-handler's isRestartCommand saw a command
          // that EXECUTES a restart; this regex then decides if it was a deploy
          // (pm2/ecosystem count too, so an env-flag file-restart is not missed).
          const isDeploy = /deploy(?:-pi)?\.sh|\/api\/deploy|land-launcher|pm2\s+(?:restart|reload|start|kill|resurrect)|ecosystem[.\w-]*\.config\.js/i.test(culpritCommand || '');

          if (armedForThis || isDeploy) {
            // SELF-DELETE the moment we fire. Once consumed it can never re-fire,
            // even across a pathological double-boot.
            restartIntent.clearArmedVerify();
            const intentStr = (armed && armed.intent) || culpritCommand || '';
            const intentLine = intentStr
              ? `What you triggered: ${String(intentStr).slice(0, 160)}.`
              : '';
            const verifyMsg = [
              '[Automatic post-deploy check — the server restart you just triggered has finished and the app is back up.]',
              intentLine,
              'Do NOT re-run the deploy or any pm2/restart command.',
              'Verify read-only that it landed: run `curl -s localhost:3170/api/health`, confirm the build hash changed, and spot-check that the specific change you just deployed is actually being served now.',
              'Then give the user ONE short line: restart went through + what you confirmed is live. If something looks wrong, say exactly what.',
            ].filter(Boolean).join(' ');
            session.status = 'idle';
            session.process = null;
            const vr = manager.sendMessage(id, verifyMsg, []);
            spawnStreamHandler(vr.process, id);
            console.log(`[BOOT] Auto post-deploy verify injected into ${id.slice(0, 8)} (armed=${armedForThis}, heuristic=${isDeploy}) — verifies itself, no human nudge`);
            continue;
          }
        } catch (e) {
          console.error('[BOOT] auto post-deploy verify failed:', e.message);
        }

        console.log(`[BOOT] Amnesia-loop breaker: skipped auto-resume of culprit ${id.slice(0, 8)} (it fired the restart) — recovery note armed for next turn`);
        continue;
      }

      // Crash-loop breaker
      session._resumeAttempts = (session._resumeAttempts || 0) + 1;
      if (session._resumeAttempts >= 3) {
        console.log(`[BOOT] Skipping auto-resume for ${id.slice(0, 8)} \u2014 ${session._resumeAttempts} consecutive interruptions (crash loop?)`);
        session.status = 'idle';
        session._resumeAttempts = 0;
        const last = session.history[session.history.length - 1];
        if (last && last.partial) {
          last.content += '\n\n*[Auto-resume stopped after repeated crashes \u2014 send a new message to retry]*';
          last.partial = false;
        }
        manager.clearPendingResume(id);
        continue;
      }

      // M9 vector 1 (decision A, RESTART_MEMORY-gated): a restart cut this reply
      // mid-stream. KEEP the partial visible + marked "interrupted, resuming",
      // then continue the turn so the rest streams BELOW it — instead of silently
      // popping the partial and re-running the whole turn from scratch (the old
      // behaviour, which made the streamed text vanish then re-appear = feels like
      // amnesia to the owner). Extends the keep+mark pattern already used on the culprit
      // path above and the no-claudeSessionId path (session-manager resumeInterrupted).
      // Flag OFF ⇒ this branch is skipped and the original pop+re-run runs below,
      // byte-identical.
      const m9Partial = session.history[session.history.length - 1];
      if (process.env.RESTART_MEMORY && m9Partial && m9Partial.partial) {
        try {
          const rj = require('./restart-journal');
          if (m9Partial.content && m9Partial.content.trim()) {
            rj.recordAction(id, { kind: 'partial_text', tool: 'assistant', result: m9Partial.content });
          }
        } catch {}
        session._restartNote = lastRestartBanner
          ? { at: lastRestartBanner.at, reason: lastRestartBanner.reason }
          : { at: new Date().toISOString(), reason: 'server restart' };
        const M9_MARK = '\n\n*[interrupted by a server restart, resuming…]*';
        if (!m9Partial.content.endsWith(M9_MARK)) m9Partial.content += M9_MARK;
        m9Partial.partial = false; // keep it — do NOT pop

        session.status = 'idle';
        session.process = null;
        manager.clearPendingResume(id);

        // Resume WITHOUT re-adding the user message (it's already in history, just
        // above the marked partial) so the continuation is a fresh assistant reply
        // rendered below the interrupted one — no duplicate user bubble.
        // : lo stesso testo, con la riga che dice al modello che non è un messaggio nuovo
        const r = manager.sendMessage(id, SessionManager.ripresaDopoRiavvio(text), attachments, { skipUserAppend: true });
        spawnStreamHandler(r.process, id);
        console.log(`[BOOT] Resumed ${id.slice(0, 8)} — kept+marked interrupted partial, continuing below (M9 v1)`);
        continue;
      }

      // Pop partial assistant response saved during shutdown
      const lastMsg = session.history[session.history.length - 1];
      if (lastMsg && lastMsg.partial) {
        // RESTART_MEMORY: before discarding the partial, preserve the evidence
        // (the started reply + tools) into the durable journal and flag this
        // session so the resumed turn's system prompt tells the model what it
        // had already done. Without this the resume re-runs blind ("amnesia").
        if (process.env.RESTART_MEMORY) {
          try {
            const rj = require('./restart-journal');
            if (lastMsg.content && lastMsg.content.trim()) {
              rj.recordAction(id, { kind: 'partial_text', tool: 'assistant', result: lastMsg.content });
            }
            session._restartNote = lastRestartBanner
              ? { at: lastRestartBanner.at, reason: lastRestartBanner.reason }
              : { at: new Date().toISOString(), reason: 'server restart' };
          } catch {}
        }
        session.history.pop();
      }
      // : il messaggio del proprietario resta in cronologia (niente doppia bolla, il nonce resta) e al
      // modello riparte con la riga che dice che non è nuovo — prima si toglieva e si rimandava nudo: un doppione
      session.status = 'idle';
      session.process = null;
      manager.clearPendingResume(id);

      const result = manager.sendMessage(id, SessionManager.ripresaDopoRiavvio(text), attachments, { skipUserAppend: true });
      spawnStreamHandler(result.process, id);
      console.log(`[BOOT] Resumed session ${id.slice(0, 8)}`);
    } catch (err) {
      console.error(`[BOOT] Failed to resume session ${id.slice(0, 8)}:`, err.message);
      const session = manager.sessions.get(id);
      if (session) {
        session.status = 'idle';
        manager.clearPendingResume(id);
      }
    }
  }

  // AUTO POST-DEPLOY VERIFY — IDLE-SESSION PASS (2026-06-29).
  // The resume loop above only injects a verify into a session that was
  // MID-TURN at the restart (it must appear in pendingResumes AND be the
  // recorded culprit). A session that armed a deploy, FINISHED its turn, then
  // went idle before the bounce is never iterated there — so its armed marker
  // sits unconsumed and the session stays silent (the live 59fb3dff symptom).
  // This pass closes that gap independently of the resume loop: read the armed
  // marker ONCE; if it points at a known, currently-idle session, inject
  // exactly one read-only verify turn so it self-reports unprompted.
  //   - readArmedVerify() already enforces the 5-min freshness window (a stale
  //     marker is dropped here, never fired blind).
  //   - If the loop above already fired + cleared the marker (culprit was
  //     mid-turn), readArmedVerify() returns null and this is a no-op — no
  //     double fire.
  //   - Only fires into an IDLE session (no live process); a session the loop
  //     just respawned has session.process set → skipped (already being driven).
  //   - RESTART_MEMORY-gated for parity with the in-loop path → flag-off is
  //     byte-identical to before.
  if (process.env.RESTART_MEMORY) {
    try {
      const armed = restartIntent.readArmedVerify();
      if (armed && armed.sessionId) {
        const session = manager.sessions.get(armed.sessionId);
        if (session && !session.process) {
          const intentStr = armed.intent || '';
          const intentLine = intentStr
            ? `What you triggered: ${String(intentStr).slice(0, 160)}.`
            : '';
          const verifyMsg = [
            '[Automatic post-deploy check — the server restart you just triggered has finished and the app is back up.]',
            intentLine,
            'Do NOT re-run the deploy or any pm2/restart command.',
            'Verify read-only that it landed: run `curl -s localhost:3170/api/health`, confirm the build hash changed, and spot-check that the specific change you just deployed is actually being served now.',
            'Then give the user ONE short line: restart went through + what you confirmed is live. If something looks wrong, say exactly what.',
          ].filter(Boolean).join(' ');
          // Self-delete the moment we commit to firing so a pathological
          // double-boot can never re-fire this same marker.
          restartIntent.clearArmedVerify();
          session.status = 'idle';
          session.process = null;
          const vr = manager.sendMessage(armed.sessionId, verifyMsg, []);
          spawnStreamHandler(vr.process, armed.sessionId);
          console.log(`[BOOT] Auto post-deploy verify injected into IDLE session ${armed.sessionId.slice(0, 8)} — self-reports, no human nudge`);
        }
      }
    } catch (e) {
      console.error('[BOOT] idle-session post-deploy verify failed:', e.message);
    }
  }

  // : i messaggi del proprietario rimasti in coda al riavvio (session-manager load) partono adesso nelle
  // sessioni ferme; in quelle riprese qui sopra partono a fine turno (deliverWaiting), come prima del riavvio
  try {
    for (const sid of manager.sessions.keys()) {
      const s = manager.sessions.get(sid);
      if (s && !s.process && manager.hasWaitingMessages(sid)) manager.deliverWaiting(sid);
    }
  } catch (e) {
    console.error('[BOOT] coda dei messaggi dopo il riavvio:', e.message);
  }

  // Load plugins
  pluginManager = new PluginManager(PLUGINS_DIR);
  pluginManager.loadAll(app, wss, manager, sendToSession);

  // [2026-10-12] The peer relay (server/peer-relay.js) no longer starts here:
  // the Machine runs on the PC only.

  // [2026-09-10, primo giro di sfoltimento — decisione di progetto] Qui partivano
  // tre catene che nessun occhio umano leggeva più. Tolte tutte e tre INSIEME
  // ai loro produttori, che è l'errore commesso ad agosto con l'Alert Center
  // (tolto il lettore, lasciati accesi i produttori):
  //   · observatory-health  — batteva ogni 5 min nel registro eventi; l'unico
  //     lettore di quegli eventi era la vista «holes» del cruscotto, che non
  //     c'è più. Produttore senza lettore ⇒ via.
  //   · dead-man            — sorvegliava 5 sentinelle e parlava all'alert-log,
  //     che scriveva su un log che il proprietario non apre. il proprietario ha scelto di NON essere
  //     avvisato (10/09): il guardiano si toglie, non si ricollega.
  //   · classifier-fallback — spento a mano dal 2026-08-04 (ENABLED=false) e
  //     senza un solo chiamante vivo: sdk-engine legge CLAUDE_PERMISSION_MODE
  //     direttamente. Era codice irraggiungibile.
  // HOLE ROUTER (la vecchia riga Observatory→Coordinator) era già sparito il
  // 2026-08-20 col Coordinator. Il registro eventi (~/.151machine/events/) RESTA
  // sul disco per legge 1 — ma da oggi nessuno lo legge più.

  serverReady = true;
  console.log('[BOOT] Server ready');

  showPairingQR();

  });
}

(async () => {
  try { await require('./session-host-gate').waitForDaemon({ timeoutMs: 15000 }); startServer(); }
  catch (err) {
    console.error('[BOOT] session-host gate failed:', err.message);
    // Phase 6 amnesia-fix: tell the next boot exactly why we bailed so the
    // banner reports "session-host unreachable" instead of "unattributed".
    // writeIntent is sync, completes before the exit.
    try {
      restartIntent.writeIntent({
        actor: 'system',
        reason: 'session-host unreachable',
        detail: `pipe-readiness gate timed out after 15s: ${err.message}`,
      });
    } catch {}
    process.exit(1);
  }
})();

// =====================
// GRACEFUL SHUTDOWN
// =====================

function gracefulShutdown() {
  if (serverState.shutdownInProgress) return;
  serverState.shutdownInProgress = true;
  global.__151_shutting_down = true; // restart-journal guard (see stream-handler clean-close)
  console.log('Shutting down (SIGTERM/SIGINT)...');
  // Phase 4: attribute SIGTERM/SIGINT restarts (likely pm2 restart or Ctrl-C).
  // Only write if no intent already exists — deploy/memory paths write first.
  try {
    if (!require('fs').existsSync(restartIntent.INTENT_PATH)) {
      restartIntent.writeIntent({
        actor: 'signal',
        reason: 'SIGTERM/SIGINT',
        detail: 'likely pm2 restart or manual kill',
      });
    }
  } catch {}
  // Send restart message BEFORE close — some WS proxies may eat close codes
  wss.clients.forEach((ws) => {
    try { ws.send(JSON.stringify({ type: 'server_restarting' })); } catch {}
  });
  // Then send close frames with code 4100
  setTimeout(() => {
    wss.clients.forEach((ws) => {
      try { ws.close(4100, 'Server shutting down'); } catch {}
    });
  }, 200);
  // Persist ALL active stream buffers to history before killing processes.
  // This is the anti-amnesia fix: without this, in-flight responses are lost.
  for (const [id, session] of manager.sessions) {
    const buf = manager.getStreamState(id);
    if (buf && buf.text) {
      session.history.push({
        role: 'assistant',
        content: buf.text,
        tools: buf.tools || [],
        partial: true,
      });
      session.lastMessage = buf.text.slice(0, 100);
      console.log(`[SHUTDOWN] Saved partial response for ${id.slice(0, 8)} (${buf.text.length} chars)`);
    }
    // Mark busy sessions as interrupted so they get auto-resumed on boot
    if (session.status === 'busy' || session.process) {
      session.status = 'interrupted';
      console.log(`[SHUTDOWN] Marked ${id.slice(0, 8)} as interrupted for auto-resume`);
    }
  }

  // Kill child processes async, wait for them, then exit
  setTimeout(() => {
    manager.killAllProcessesAsync(3000).then(() => {
      console.log('[SHUTDOWN] All child processes terminated');
      manager.saveSync();
      closeServersAndExit(0, 1, 2000);
    }).catch(() => {
      manager.saveSync();
      closeServersAndExit(0, 1, 1000);
    });
  }, 500);
}

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

// =====================
// CRASH HANDLERS
// =====================

// An uncaught exception used to ALWAYS tear the whole process down (exit → PM2
// restart), which killed every live session. But a large chunk of "uncaught"
// errors are ISOLATED to a single request/stream and leave the rest of the
// server perfectly healthy — most notably a client aborting a big upload
// mid-flight (EPIPE / ECONNRESET / "request aborted"), exactly what happened when
// the owner added a new series (a multi-GB episode ingest): the aborted upload socket
// threw, nothing was listening, and the CORE restarted. Those are recoverable —
// the server should shrug them off and keep running on its own, with no Claude
// and no restart. Only a genuinely fatal error still routes to a restart.
const RECOVERABLE_ERROR_CODES = new Set([
  'EPIPE', 'ECONNRESET', 'ECONNABORTED', 'ETIMEDOUT', 'ECANCELED',
  'ERR_STREAM_WRITE_AFTER_END', 'ERR_STREAM_PREMATURE_CLOSE',
  'ERR_STREAM_DESTROYED', 'ERR_HTTP_HEADERS_SENT', 'EPROTO',
]);
function isRecoverableCrash(err) {
  if (!err) return false;
  if (err.code && RECOVERABLE_ERROR_CODES.has(err.code)) return true;
  const m = (err.message || '').toLowerCase();
  return /econnreset|epipe|write after end|premature close|request aborted|aborted|socket hang up|headers already sent|stream destroyed/.test(m);
}

process.on('uncaughtException', (err) => {
  const ts = new Date().toISOString();
  // Recoverable, request-scoped error → log and SURVIVE. Never restart the core.
  if (isRecoverableCrash(err)) {
    console.error(`[UNCAUGHT-RECOVERABLE ${ts}] surviving:`, err.code || err.message);
    try {
      const errLog = path.join(__dirname, 'logs', 'crash.log');
      fs.mkdirSync(path.dirname(errLog), { recursive: true });
      fs.appendFileSync(errLog, `[${ts}] RECOVERED (no restart): ${err.code || ''} ${err.message}\n`);
    } catch {}
    return;
  }
  console.error(`[UNCAUGHT ${ts}]`, err.message, err.stack);
  try {
    const errLog = path.join(__dirname, 'logs', 'crash.log');
    fs.mkdirSync(path.dirname(errLog), { recursive: true });
    fs.appendFileSync(errLog, `[${ts}] UNCAUGHT: ${err.message}\n${err.stack}\n\n`);
  } catch {}
  try {
    restartIntent.writeIntent({
      actor: 'uncaught-exception',
      reason: 'crash',
      detail: (err.message || String(err)).slice(0, 200),
    });
  } catch {}
  setTimeout(() => process.exit(1), 1000);
});

process.on('unhandledRejection', (reason) => {
  const ts = new Date().toISOString();
  const msg = reason instanceof Error ? reason.message + '\n' + reason.stack : String(reason);
  console.error(`[UNHANDLED REJECTION ${ts}]`, msg);
  try {
    const errLog = path.join(__dirname, 'logs', 'crash.log');
    fs.mkdirSync(path.dirname(errLog), { recursive: true });
    fs.appendFileSync(errLog, `[${ts}] REJECTION: ${msg}\n\n`);
  } catch {}
});

// Memory watchdog — restart gracefully if RSS exceeds MEM_LIMIT_MB.
// Prevents OOM kills which lose session state.
//
// 2026-08-28: raised 512 → 1024. The old 512 was NOT a parachute, it was the
// cruising altitude: on the Pi it fired 11 times (RSS 513–533MB) because the
// process's normal working set sits right at that line. The Pi has 3796MB total
// / ~2790MB available, so 1024 is ~27% of available — still far from OOM, but
// roughly 2× the normal working set, so it only fires on a real leak.
// Ordering invariant (must hold on every box):
//   V8 heap cap (--max-old-space-size) < MEM_LIMIT_MB < PM2 max_memory_restart
// so V8 GCs hard first, then WE restart gracefully (state saved + verify armed),
// and PM2's hard kill stays the last-resort backstop.
const MEM_LIMIT_MB = Number(process.env.MEM_LIMIT_MB) || 1024;
setInterval(() => {
  const rss = process.memoryUsage().rss;
  const mb = Math.round(rss / 1024 / 1024);
  if (mb > MEM_LIMIT_MB) {
    if (deploy.isRestartLockHeld()) {
      console.log(`[MEM] RSS ${mb}MB over limit but restart already in flight — skipping`);
      return;
    }
    console.warn(`[MEM] RSS ${mb}MB exceeds ${MEM_LIMIT_MB}MB limit — graceful restart`);
    try {
      const errLog = path.join(__dirname, 'logs', 'crash.log');
      fs.mkdirSync(path.dirname(errLog), { recursive: true });
      fs.appendFileSync(errLog, `[${new Date().toISOString()}] MEM: ${mb}MB — triggering restart\n\n`);
    } catch {}
    // Through the single funnel. No triggering session → arm no-ops (nothing to
    // verify), but the restart still routes through restart-control like every
    // other intentional restart (restart-control writes the intent banner).
    restartControl.restart({
      actor: 'memory-watchdog',
      reason: 'Memory limit exceeded',
      detail: `RSS=${mb}MB over ${MEM_LIMIT_MB}MB`,
    });
  }
}, 60000);

// : full transcripts outlive Claude Code's 30-day cleanup — every one is
// copied (lossless, proven byte for byte) into ~/.local/share/the-151-machine/trascritti/ at boot
// and every 6 hours, in a separate low-priority process (server/trascritti.js).
require('./trascritti').archiviaInSottofondo();
setInterval(() => require('./trascritti').archiviaInSottofondo(), 6 * 60 * 60 * 1000);

// Periodic maintenance — runs every 6 hours
setInterval(() => {
  // TTS cache eviction: keep newest 100 files, delete older
  try {
    const ttsCacheDir = path.join(__dirname, '..', '.cache', 'tts');
    if (fs.existsSync(ttsCacheDir)) {
      const files = fs.readdirSync(ttsCacheDir)
        .filter(f => f.endsWith('.mp3'))
        .map(f => ({ name: f, mtime: fs.statSync(path.join(ttsCacheDir, f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime);
      if (files.length > 100) {
        const stale = files.slice(100);
        for (const f of stale) {
          try { fs.unlinkSync(path.join(ttsCacheDir, f.name)); } catch {}
        }
        console.log(`[MAINT] TTS cache: evicted ${stale.length} old files, kept ${Math.min(files.length, 100)}`);
      }
    }
  } catch (err) { console.error('[MAINT] TTS cache eviction failed:', err.message); }

  // Relay session cleanup: delete idle relay sessions older than 48h
  // (/api/relay/* is gone since 2026-10-12: this only sweeps leftovers on disk)
  try {
    const cutoff = Date.now() - 48 * 60 * 60 * 1000;
    let cleaned = 0;
    for (const session of manager.sessions.values()) {
      if (session.title === 'Relayed session' && !session.process &&
          session.lastActivity && session.lastActivity.getTime() < cutoff) {
        try { manager.close(session.id); cleaned++; } catch {}
      }
    }
    if (cleaned > 0) console.log(`[MAINT] Cleaned ${cleaned} stale relay session(s)`);
  } catch (err) { console.error('[MAINT] Relay cleanup failed:', err.message); }

  // Guardia 3b (2026-08-10): JANITOR figli ephemeral orfani. Se il Father crasha o va
  // in timeout SENZA restart, relay-job.sh non arriva alla DELETE finale → il figlio
  // ephemeral resta su disco (invisibile al client, ma sporca sessions.json). Qui
  // reappiamo ogni figlio ephemeral senza processo e idle da >30min. Soglia più
  // aggressiva del cleanup 48h sopra perché un figlio non ha ragione di sopravvivere
  // al proprio turno; il tracking interno del Father è già finito.
  try {
    const orphanCutoff = Date.now() - 30 * 60 * 1000;
    let reaped = 0;
    for (const session of manager.sessions.values()) {
      if (session.ephemeral && !session.process &&
          session.lastActivity && session.lastActivity.getTime() < orphanCutoff) {
        try { manager.close(session.id); reaped++; } catch {}
      }
    }
    if (reaped > 0) console.log(`[MAINT] Reaped ${reaped} orphan ephemeral child session(s)`);
  } catch (err) { console.error('[MAINT] Ephemeral janitor failed:', err.message); }
}, 6 * 60 * 60 * 1000);
