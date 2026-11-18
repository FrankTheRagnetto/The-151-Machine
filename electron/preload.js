'use strict';
const { contextBridge, ipcRenderer } = require('electron');

// Seed the owner token into localStorage BEFORE the page's own scripts run, so
// the desktop window lands authenticated. Same key the web/phone path uses
// (public/js/auth.js -> '151-terminal-token'). Token is passed from main.js via
// webPreferences.additionalArguments.
try {
  const arg = (process.argv || []).find((a) => a.startsWith('--owner-token='));
  if (arg) {
    const token = arg.slice('--owner-token='.length);
    if (token) window.localStorage.setItem('151-terminal-token', token);
  }
} catch (_) { /* non-fatal: fall back to the normal login screen */ }

// Minimal native bridge (harvested from machine-core): the renderer can ask the
// shell for a native folder picker. Nothing else is exposed.
contextBridge.exposeInMainWorld('machineCore', {
  pickFolder: () => ipcRenderer.invoke('pick-folder'),
  // Prompt-free OS clipboard read (quick-actions Paste). The Electron `clipboard`
  // module isn't available in a sandboxed preload, so it lives in main.js
  // behind this IPC handle.
  readClipboard: () => ipcRenderer.invoke('read-clipboard'),
  // Hand an app URI (e.g. spotify:track:…) to the OS default handler, so a
  // desktop app opens instead of a browser tab. Scheme allow-listed in main.js.
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
});
