'use strict';

// CODE_HASH — a CONTENT-STABLE identifier of the deployed code.
//
// Why this exists: serverState.BUILD_HASH is intentionally random per boot — it
// is the "did the restart land?" signal that tools/deploy.sh polls. But because
// it changes on every restart, the client used to do a full page reload on EVERY
// server restart even when nothing changed. CODE_HASH is stable across restarts
// of identical code and IDENTICAL on PC and Pi (same deployed file), so the
// client only reloads on a REAL code change.
//
// Resolution order (REORDERED 2026-08-16 — restart/deploy round, punto 2):
//   1. LIVE CONTENT HASH — computed at boot from the actual source bytes on
//      disk (same file set + algorithm as tools/deploy.sh "Stamp code hash",
//      byte-identical output). This is the root-cause fix for "?v= stayed
//      a86178d319e5 after a restart with new CSS": the old primary source was
//      server/build-hash.txt, which ONLY tools/deploy.sh rewrote — so any
//      `pm2 restart` served fresh files under a stale ?v= and clients kept
//      cached JS/CSS forever. Hashing the real bytes takes ~30 ms for the
//      ~190 source files and can never go stale. PC and Pi run this same code
//      on the same synced files → identical hash → no spurious phone reloads.
//   2. server/build-hash.txt — written by tools/deploy.sh on each deploy and
//      synced to the Pi. Now a fallback for a broken live compute.
//   3. git short SHA — fallback for a bare boot with no deploy file.
//   4. random — last resort. Self-heals on first deploy.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const HASH_FILE = path.join(__dirname, 'build-hash.txt');
const REPO_ROOT = path.join(__dirname, '..');

// ── Live content hash ────────────────────────────────────────────────────────
// EXACT replica of tools/deploy.sh step 3.5 so both producers agree:
//   find server public/js public/css plugins -type f
//     ( -name '*.js' -o -name '*.css' -o -name '*.html' -o -name '*.json' )
//     ! -name build-hash.txt  ! runtime-state names  ! node_modules/.cache/...
//     -print0 | sort -z | xargs -0 sha256sum | sha256sum | cut -c1-12
// Replication notes:
//   - paths are repo-relative with the same prefixes find prints ("server/…")
//   - sort -z is a bytewise sort → Buffer.compare on the path strings
//   - sha256sum lines are "<hex><SP><SP><path>\n"; the final hash is the sha256
//     of that concatenation, first 12 hex chars
// Parity is locked by tests/build-hash-parity.test.js (bash vs node).

// public/plugins NON c'è (29/09/2026): sono COPIE di plugins/<id>/client.js che il
// server rifà da solo (plugin-loader syncClientFiles, anche nell'hot reload DOPO
// il timbro del deploy). Contarle faceva il falso rosso «Code equality» a ogni
// deploy che toccava un client di plugin. L'originale in plugins/ è già contato.
const CONTENT_ROOTS = ['server', 'public/js', 'public/css', 'plugins'];
const CONTENT_EXTS = new Set(['.js', '.css', '.html', '.json']);
// PER-MACHINE RUNTIME STATE — must never enter the code hash (2026-08-21).
// These are .json files living under plugins/, so CONTENT_EXTS would otherwise
// swallow them. Each box writes its own copy, so a file present on ONE machine
// shifts that machine's hash and the deploy's PC↔Pi equality gate fails with
// "PC and Pi are serving DIFFERENT code" even though every line of code matches.
// That is not hypothetical: on 2026-08-21 six of the last ten deploys were
// rejected by that gate, and the whole divergence was four Pi-only files —
// .scorta-anomalie.json, .scorta-chain-log-musica.json, .scorta-chain-status.json
// and .spotify-tokens.json. They were already excluded from deploy-pi.sh and
// .gitignore; the exclusion was simply missing HERE, which is the only place
// that decides whether the two machines agree.
const EXCLUDED_NAMES = new Set([
  'build-hash.txt', 'sessions.json', '.state.json', '.storage-state.json',
  '.csv-baseline.json', '.csv-decisions.json', '.sync-status.json', '.download.lock',
  // Playlist Doctor per-machine state (see comment above).
  '.spotify-tokens.json', '.chain.json', '.download-result.json', '.analisi.json',
  '.hetzner-copy.json',
]);
// Glob-shaped exclusions — mirrors `find ! -name '.scorta-*.json'` in the bash
// pipeline. The Pi keeps one .scorta-<topic>.json per cached answer from the
// laptop, so the names are open-ended and an exact-name Set cannot cover them.
const EXCLUDED_PATTERNS = [/^\.scorta-.*\.json$/];
const EXCLUDED_DIRS = new Set(['node_modules', '.cache', '.venv', 'venv', '__pycache__', '.git']);

function collectContentFiles(rootAbs, rootRel, out) {
  let entries;
  try { entries = fs.readdirSync(rootAbs, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const abs = path.join(rootAbs, e.name);
    const rel = rootRel + '/' + e.name;
    if (e.isDirectory()) {
      if (EXCLUDED_DIRS.has(e.name)) continue;
      collectContentFiles(abs, rel, out);
    } else if (e.isFile()) {
      if (EXCLUDED_NAMES.has(e.name)) continue;
      if (EXCLUDED_PATTERNS.some((re) => re.test(e.name))) continue;
      // Case-sensitive like find -name '*.js' (a hypothetical X.JS is excluded there too).
      if (!CONTENT_EXTS.has(path.extname(e.name))) continue;
      out.push({ abs, rel });
    }
  }
}

// [08/11/2026] SERVER_HASH — l'impronta del codice che Node CARICA all'avvio:
// server/ e la parte server dei plugin (i client.js no: li rifà l'hot reload).
// CODE_HASH segue i byte sul disco ogni 5 s (refreshCodeHash in index.js, per
// la cache), quindi non può dire se un server/*.js nuovo gira davvero: il
// passo 6/7 del cancello diceva «disco == vivo» con il server fermo alle 13:23
// e la cura solo sul disco. index.js la calcola UNA volta, all'avvio, e
// /api/health la espone come serverHash. Prova: tests/consegna-server.test.js
const SERVER_ROOTS = ['server', 'plugins'];
const SERVER_EXTS = new Set(['.js', '.json']);
// Stato che il server RISCRIVE da sé all'avvio (fuori da git): contarlo darebbe
// «da riavviare» subito dopo ogni riavvio. Misurato su un'istanza appena accesa.
const SERVER_RUNTIME = new Set(['config.json', '_registry.json']);
const SERVER_RUNTIME_DIRS = ['server/logs/', 'server/attachments/'];
function isServerFile(f) {
  const nome = path.basename(f.rel);
  return SERVER_EXTS.has(path.extname(f.rel)) && nome !== 'client.js'
    && !SERVER_RUNTIME.has(nome) && !SERVER_RUNTIME_DIRS.some((d) => f.rel.startsWith(d));
}

function computeServerHash(repoRoot) {
  return computeContentHash(repoRoot || REPO_ROOT, SERVER_ROOTS, isServerFile);
}

function computeContentHash(repoRoot, roots, filtro) {
  try {
    const base = repoRoot || REPO_ROOT;
    let files = [];
    for (const root of (roots || CONTENT_ROOTS)) {
      collectContentFiles(path.join(base, root), root, files);
    }
    if (filtro) files = files.filter(filtro);
    if (!files.length) return null;
    // Bytewise path order — mirrors `sort -z` (LC_ALL-independent).
    files.sort((a, b) => Buffer.compare(Buffer.from(a.rel), Buffer.from(b.rel)));
    const outer = crypto.createHash('sha256');
    for (const f of files) {
      const h = crypto.createHash('sha256').update(fs.readFileSync(f.abs)).digest('hex');
      outer.update(h + '  ' + f.rel + '\n');
    }
    return outer.digest('hex').slice(0, 12);
  } catch (err) {
    console.error('[build-hash] live content hash failed:', err.message);
    return null;
  }
}

function fromFile() {
  try {
    const v = fs.readFileSync(HASH_FILE, 'utf8').trim();
    if (v) return v;
  } catch { /* missing — fall through */ }
  return null;
}

function fromGit() {
  try {
    const sha = execFileSync('git', ['rev-parse', '--short=10', 'HEAD'], {
      cwd: REPO_ROOT,
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3000,
    }).toString().trim();
    if (sha) return sha;
  } catch { /* not a repo / git missing — fall through */ }
  return null;
}

function computeCodeHash() {
  return computeContentHash() || fromFile() || fromGit() || ('boot-' + crypto.randomBytes(4).toString('hex'));
}

module.exports = { computeCodeHash, computeContentHash, computeServerHash, HASH_FILE };
