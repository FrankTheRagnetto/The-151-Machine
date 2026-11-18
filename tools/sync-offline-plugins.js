#!/usr/bin/env node
// Syncs plugin client.js files + manifest into public/ for offline APK use.
// Run before `npx cap sync` when building the APK, AND again with `--android`
// AFTER it.
//
// [2026-10-07] PERCHÉ DUE VOLTE. `npx cap sync` copia public/ dentro l'APK e
// poi CANCELLA assets/public/plugins (@capacitor/cli dist/cordova.js:146: è la
// cartella dei suoi plugin Cordova). Le copie offline dei plugin non sono mai
// arrivate sul telefono. `--android` le rimette dopo il sync, e
// Controllo prima di consegnare: `unzip -l <apk> | grep assets/public/plugins/code-blocks`.

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PLUGINS_DIR = path.join(ROOT, 'plugins');
const PUBLIC_DIR = path.join(ROOT, 'public');
const OUT_DIR = path.join(PUBLIC_DIR, 'plugins');
const MANIFEST_PATH = path.join(PUBLIC_DIR, 'offline-plugins.json');
const REGISTRY_PATH = path.join(PLUGINS_DIR, '_registry.json');

let registry = {};
try { registry = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf-8')); } catch {}

const dirs = fs.readdirSync(PLUGINS_DIR).filter(d => {
  if (d.startsWith('_') || d.startsWith('.')) return false;
  return fs.statSync(path.join(PLUGINS_DIR, d)).isDirectory();
});

const offlinePlugins = [];
let copied = 0;

for (const dir of dirs) {
  const manifestPath = path.join(PLUGINS_DIR, dir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) continue;

  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')); } catch { continue; }

  const id = manifest.id;
  const isNative = manifest.type === 'native';
  const enabled = registry[id]?.enabled !== undefined ? registry[id].enabled : isNative;
  const hasClient = !!manifest.client;

  // Disabled plugins (_registry.json enabled:false) must NOT ship in the offline
  // bundle: they'd render dangling tiles in the APK's Apps panel with no live
  // backend (2026-08-11). Skip both the manifest entry and the client.js copy.
  if (!enabled) continue;

  offlinePlugins.push({
    id,
    name: manifest.name,
    version: manifest.version || '1.0.0',
    description: manifest.description || '',
    type: manifest.type || 'community',
    category: manifest.category || 'utility',
    icon: manifest.icon || null,
    enabled,
    hasClient,
  });

  if (hasClient) {
    const src = path.join(PLUGINS_DIR, dir, manifest.client);
    if (fs.existsSync(src)) {
      const dest = path.join(OUT_DIR, id);
      fs.mkdirSync(dest, { recursive: true });
      fs.copyFileSync(src, path.join(dest, 'client.js'));
      copied++;
    }
  }
}

fs.writeFileSync(MANIFEST_PATH, JSON.stringify(offlinePlugins, null, 2));
console.log(`[sync-offline] ${offlinePlugins.length} plugins, ${copied} client.js files copied to public/plugins/`);

if (process.argv.includes('--android')) {
  const ANDROID_PUBLIC = path.join(ROOT, 'app', 'android', 'app', 'src', 'main', 'assets', 'public');
  if (!fs.existsSync(ANDROID_PUBLIC)) {
    console.error('[sync-offline] --android: ' + ANDROID_PUBLIC + ' non esiste — prima `npx cap sync android`');
    process.exit(1);
  }
  const dest = path.join(ANDROID_PUBLIC, 'plugins');
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  // [2026-10-12] Solo gli id elencati in offline-plugins.json, non l'intera
  // public/plugins: lì restano cartelle di plugin tolti (portali, entertainment…)
  // che nessuno cancella, e finivano dentro l'APK.
  const elencati = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf-8')).map((p) => p.id);
  let messi = 0;
  for (const id of elencati) {
    const src = path.join(OUT_DIR, id);
    if (!fs.existsSync(src)) continue; // plugin senza client.js: niente da copiare
    fs.cpSync(src, path.join(dest, id), { recursive: true });
    messi++;
  }
  fs.copyFileSync(MANIFEST_PATH, path.join(ANDROID_PUBLIC, 'offline-plugins.json'));
  console.log(`[sync-offline] --android: ${messi} plugin copiati in ${path.relative(ROOT, dest)} (solo quelli di offline-plugins.json)`);
}
