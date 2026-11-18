'use strict';
/**
 * The 151 Machine — Electron desktop shell.
 *
 * ADDITIVE packaging, NOT a rewrite. The same server code runs whether launched
 * headless (`node server/index.js` under PM2) or as this desktop app. The only
 * job here is to put a native window onto the local server.
 *
 * Port/instance safety (the whole point):
 *   - The Machine is usually ALREADY running under PM2 on its port. We must NOT
 *     boot a second server (that would EADDRINUSE; the server's boot handler
 *     would then process.exit and take this app down with it).
 *   - So on launch we PROBE /api/health first:
 *       responding  -> ATTACH the window to the existing server (PM2/phone/
 *                       Tailscale all keep running; closing the app leaves them up)
 *       not running -> BOOT the server in-process, exactly like the headless start
 *                       (closing the app tears it down, same as Ctrl-C on a manual run)
 *   - Single-instance lock so two app windows can't fight.
 *
 * Auth: this is the owner's own box, so we mint an owner JWT with the SAME algorithm
 * the server uses (HS256 over JWT_SECRET, {role:'owner'}) and seed it into the
 * page's localStorage in preload — landing the window authenticated. The web/
 * phone token=password login path is untouched.
 */
const { app, BrowserWindow, clipboard, dialog, ipcMain, shell } = require('electron');
const path = require('path');
const http = require('http');
const fs = require('fs');
const crypto = require('crypto');

const REPO = path.join(__dirname, '..');

// Fixed identity so the desktop/taskbar matches our .desktop StartupWMClass and
// shows the right icon (default would be the generic "electron").
app.setName('the-151-machine');

// --- read .env for PORT + JWT_SECRET (no dotenv side effects on our own env) ---
function readEnv() {
  const out = {};
  try {
    const txt = fs.readFileSync(path.join(REPO, '.env'), 'utf-8');
    for (const line of txt.split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch {}
  return out;
}
const ENV = readEnv();
const PORT = process.env.PORT || ENV.PORT || '3170';
const JWT_SECRET = process.env.JWT_SECRET || ENV.JWT_SECRET || '';
const BASE_URL = `http://127.0.0.1:${PORT}`;

// --- mint an owner token byte-identical to server createToken({role:'owner'}) ---
function mintOwnerToken() {
  if (!JWT_SECRET) return null;
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify({
    role: 'owner', iat: Date.now(), exp: Date.now() + 14 * 24 * 60 * 60 * 1000,
  })).toString('base64url');
  const sig = crypto.createHmac('sha256', JWT_SECRET).update(header + '.' + body).digest('base64url');
  return header + '.' + body + '.' + sig;
}

// --- is a server already answering on the port? (attach vs boot decision) ---
function probeHealth(timeout = 1200) {
  return new Promise((resolve) => {
    const req = http.get(`${BASE_URL}/api/health`, { timeout }, (res) => {
      res.resume();
      resolve(true);                              // something is listening -> attach
    });
    req.on('error', () => resolve(false));        // ECONNREFUSED -> port free -> boot
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

// --- wait until /api/health answers (used only after we boot in-process) ---
async function waitForHealth(maxMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    if (await probeHealth(800)) return true;
    await new Promise((r) => setTimeout(r, 350));
  }
  return false;
}

let win;
let mode = 'attached';   // 'attached' (PM2 was up) | 'booted' (we started it)

async function ensureServer() {
  if (await probeHealth()) { mode = 'attached'; return; }
  // Port is free -> boot the real server in-process, exactly like `node server/index.js`.
  process.env.PORT = String(PORT);
  require(path.join(REPO, 'server', 'index.js'));
  mode = 'booted';
  await waitForHealth();
}

function createWindow() {
  const token = mintOwnerToken();
  win = new BrowserWindow({
    width: 1280, height: 860, minWidth: 900, minHeight: 600,
    backgroundColor: '#0e1116',
    title: 'The 151 Machine',
    icon: path.join(REPO, 'public', 'icon-512.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      additionalArguments: token ? [`--owner-token=${token}`] : [],
    },
  });
  win.removeMenu();

  // Keep the app window ON the Machine. External links (anything not our local
  // server) open in the system browser, not inside the app.
  const isLocal = (u) => { try { return new URL(u).origin === BASE_URL; } catch { return false; } };
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!isLocal(url)) { shell.openExternal(url); return { action: 'deny' }; }
    return { action: 'allow' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!isLocal(url)) { e.preventDefault(); shell.openExternal(url); }
  });

  win.loadURL(BASE_URL);
  if (process.env.MACHINE_DEV) win.webContents.openDevTools({ mode: 'detach' });
}

// Native clipboard read for the quick-actions Paste button. Chromium's
// navigator.clipboard.readText shows a confirmation "Paste" bubble in Electron;
// the OS clipboard via the main process has no prompt — one click, like the
// Capacitor bridge on the phone. Exposed as machineCore.readClipboard in preload.
ipcMain.handle('read-clipboard', () => clipboard.readText());

// Open a URL with the OS default handler. The renderer needs this for app URIs
// like spotify:track:… — an https link would only ever reach the web player,
// while the scheme URI launches the installed desktop app. Scheme allow-list:
// the renderer cannot push arbitrary commands at the shell through here.
ipcMain.handle('open-external', (_e, url) => {
  const u = String(url || '');
  if (!/^(https?|spotify):/i.test(u)) return false;
  shell.openExternal(u);
  return true;
});

// Native folder picker, exposed to the renderer via preload (harvested from
// machine-core; harmless if the current frontend doesn't call it yet).
ipcMain.handle('pick-folder', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });
  app.whenReady().then(async () => {
    await ensureServer();
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on('window-all-closed', () => {
  // ATTACHED  -> we only quit the shell; PM2 keeps serving phone/Tailscale.
  // BOOTED    -> quitting ends our process, tearing down the server we started
  //              (same as closing a manual `node server/index.js`).
  if (process.platform !== 'darwin') app.quit();
});
