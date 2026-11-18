/**
 * The 151 Machine — Plugin Loader
 *
 * Discovers, loads, and manages plugins from the /plugins directory.
 * Each plugin is a folder with a manifest.json + optional server.js and client.js.
 *
 * Plugin lifecycle:
 *   1. loadAll() — called at boot, reads manifests, loads server modules
 *   2. emit(hook, ctx) — fires a hook across all enabled plugins
 *   3. API routes under /api/plugins/ for listing, toggling, settings
 */

const path = require('path');
const fs = require('fs');
const express = require('express');
// The plugin "front desk": the single, documented definition of the surface
// every plugin's activate(api) receives. _createPluginAPI builds through it so
// the contract lives in one named place (see server/plugin-sdk.js).
const { buildPluginAPI } = require('./plugin-sdk');

// ─── IL MURO DEI FILE PLUGIN (2026-09-27, ) ─────────────────────────
// Prima: `/plugins` serviva l'INTERA cartella plugins/ via express.static con
// una lista NERA (server.js, _registry.json, config.json, .tokens.json, .env).
// Tutto il resto usciva senza login: i moduli server che server.js richiede
// (entertainment/book-facts.js, folders.js, bands.js; files/stream-gate.js,
// warm-schedule.js; i nove moduli di playlist-doctor), gli script .py, i JSON
// di stato, i README. Peggio: syncClientFiles() copiava OGNI .js tranne
// server.js dentro public/plugins/, e express.static(PUBLIC_DIR) — montato
// PRIMA del loader — li serviva anche da lì, dove la lista nera non arrivava.
// Adesso è una lista BIANCA: di un plugin esce SOLO il file che il suo
// manifest.json dichiara come `client`. Nient'altro, da nessuna delle due
// cartelle. Il browser ne carica solo quello (public/js/ui.js:42,55).
const PLUGIN_ID_RE = /^[a-z0-9][a-z0-9._-]*$/i;

// Il nome del file client che il plugin `id` dichiara, oppure null.
function declaredClientFile(pluginsDir, id) {
  if (!PLUGIN_ID_RE.test(id) || id.startsWith('_')) return null;
  try {
    const m = JSON.parse(fs.readFileSync(path.join(pluginsDir, id, 'manifest.json'), 'utf-8'));
    const c = m && typeof m.client === 'string' ? m.client : '';
    // solo un nome piatto, mai un percorso, mai il modulo server
    if (!c || c !== path.basename(c) || c.startsWith('.') || /^server\.js$/i.test(c)) return null;
    return c;
  } catch {
    return null;
  }
}

// Middleware da montare su '/plugins' (req.path = '/<id>/<file>'): lascia
// passare solo /<id>/<client dichiarato>, tutto il resto è 404 — anche il
// 403 di prima diceva «qui c'è qualcosa». Va montato PRIMA di
// express.static(PUBLIC_DIR), perché anche public/plugins/ risponde su /plugins.
function createPluginStaticGuard(pluginsDir) {
  return function pluginStaticGuard(req, res, next) {
    let rel;
    try { rel = decodeURIComponent(req.path || ''); } catch { return res.status(404).end(); }
    const m = /^\/([^/\\]+)\/([^/\\]+)$/.exec(rel);
    if (m) {
      const client = declaredClientFile(pluginsDir, m[1]);
      if (client && m[2] === client) return next();
    }
    return res.status(404).end();
  };
}

class PluginManager {
  constructor(pluginsDir) {
    this.pluginsDir = pluginsDir;
    this.plugins = new Map(); // id -> { manifest, instance, enabled }
    this.hooks = {};          // hookName -> [{ pluginId, fn }]
    this.registryPath = path.join(pluginsDir, '_registry.json');
  }

  // Read enable/disable + settings state
  readRegistry() {
    try {
      return JSON.parse(fs.readFileSync(this.registryPath, 'utf-8'));
    } catch {
      return {};
    }
  }

  saveRegistry(registry) {
    fs.writeFileSync(this.registryPath, JSON.stringify(registry, null, 2));
  }

  // Called once at boot — discovers and loads all plugins
  loadAll(app, wss, sessionManager, sendToSession) {
    this.wss = wss;
    this.sendToSession = sendToSession;
    if (!fs.existsSync(this.pluginsDir)) {
      fs.mkdirSync(this.pluginsDir, { recursive: true });
      return;
    }

    const registry = this.readRegistry();
    const dirs = fs.readdirSync(this.pluginsDir).filter(d => {
      if (d.startsWith('_') || d.startsWith('.')) return false;
      const stat = fs.statSync(path.join(this.pluginsDir, d));
      return stat.isDirectory();
    });

    // Sort by dependencies (simple: plugins with no deps first)
    const manifests = [];
    for (const dir of dirs) {
      const manifestPath = path.join(this.pluginsDir, dir, 'manifest.json');
      if (!fs.existsSync(manifestPath)) continue;
      try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
        manifests.push({ dir, manifest });
      } catch (e) {
        console.warn(`[PLUGIN] Bad manifest in ${dir}:`, e.message);
      }
    }

    const sorted = this._topoSort(manifests);

    for (const { dir, manifest } of sorted) {
      const id = manifest.id;
      const isNative = manifest.type === 'native';
      // Native plugins are enabled by default; community plugins need explicit enable
      const enabled = registry[id]?.enabled !== undefined
        ? registry[id].enabled
        : isNative;

      if (!enabled) {
        this.plugins.set(id, { manifest, instance: null, enabled: false });
        console.log(`[PLUGIN] Skipped (disabled): ${id}`);
        continue;
      }

      // Check dependencies
      const deps = manifest.dependencies || [];
      const missingDep = deps.find(dep => !this.plugins.get(dep)?.enabled);
      if (missingDep) {
        console.warn(`[PLUGIN] ${id} requires ${missingDep} — skipping`);
        this.plugins.set(id, { manifest, instance: null, enabled: false });
        continue;
      }

      // Load server module if it exists
      let instance = {};
      const serverFile = manifest.server || 'server.js';
      const serverPath = path.join(this.pluginsDir, dir, serverFile);
      if (fs.existsSync(serverPath)) {
        try {
          const mod = require(serverPath);
          const api = this._createPluginAPI(id, manifest, sessionManager);
          instance = typeof mod.activate === 'function' ? mod.activate(api) : mod;
        } catch (e) {
          console.error(`[PLUGIN] Failed to load ${id} server:`, e.message);
          this.plugins.set(id, { manifest, instance: null, enabled: false });
          continue;
        }
      }

      // Register hooks + routes inside the per-plugin guard: a plugin that throws
      // during hook wiring or registerRoutes must be skipped + logged, never allowed
      // to bubble up and take the whole server down (crash-loop under PM2).
      try {
        // Register hooks
        for (const hookName of manifest.hooks || []) {
          if (typeof instance[hookName] === 'function') {
            if (!this.hooks[hookName]) this.hooks[hookName] = [];
            this.hooks[hookName].push({ pluginId: id, fn: instance[hookName].bind(instance) });
          }
        }

        // Register Express routes under /api/plugins/<id>/
        if (typeof instance.registerRoutes === 'function') {
          const router = express.Router();
          instance.registerRoutes(router);
          app.use(`/api/plugins/${id}`, router);
        }
      } catch (e) {
        console.error(`[PLUGIN] Failed to register ${id} hooks/routes:`, e.message);
        this.plugins.set(id, { manifest, instance: null, enabled: false });
        continue;
      }

      this.plugins.set(id, { manifest, instance, enabled: true });
      console.log(`[PLUGIN] Loaded: ${id} v${manifest.version} (${manifest.type || 'community'})`);
    }

    // Serve plugin client files statically — SOLO il client dichiarato nel
    // manifest (lista bianca, vedi createPluginStaticGuard). Il guardiano è
    // montato anche in server/index.js prima di public/; qui ripete il muro per
    // chi arriva direttamente a questo express.static (plugin non ancora
    // sincronizzato in public/).
    app.use('/plugins', createPluginStaticGuard(this.pluginsDir), express.static(this.pluginsDir, {
      etag: false,
      dotfiles: 'deny',
      index: false,
      setHeaders: (res) => {
        res.setHeader('Cache-Control', 'no-store, no-cache');
      },
    }));

    // Plugin API routes
    this._registerAPIRoutes(app);

    // Sync plugin client files to public/ (browser loads from public/ first)
    this.syncClientFiles();

    console.log(`[PLUGIN] ${this.plugins.size} plugins discovered, ${[...this.plugins.values()].filter(p => p.enabled).length} enabled`);
  }

  syncClientFiles() {
    const publicPlugins = path.join(__dirname, '..', 'public', 'plugins');
    for (const [id, p] of this.plugins) {
      // A DISABLED plugin must not keep republishing its client.js into public/.
      // Without this filter "off" was never durable: the browser (and the Pi,
      // which receives public/ wholesale) kept getting the UI of a plugin the
      // registry said was off. Root of the 2026-08-20 alert-center resurrection.
      if (!p.enabled) continue;
      const srcDir = path.join(this.pluginsDir, id);
      const destDir = path.join(publicPlugins, id);
      try {
        // Lista bianca (2026-09-27): in public/ va SOLO il client dichiarato.
        // Prima si copiava ogni .js/.css/.html tranne server.js, cioè anche i
        // moduli server (book-facts.js, stream-gate.js, …) — e public/ li
        // serviva a chiunque, senza login.
        const client = declaredClientFile(this.pluginsDir, id);
        const files = client && fs.existsSync(path.join(srcDir, client)) ? [client] : [];
        // Spazza da public/<id>/ quello che una versione vecchia ci ha copiato
        // e che non è il client dichiarato. Solo dentro public/plugins/<id>/.
        if (fs.existsSync(destDir)) {
          for (const stale of fs.readdirSync(destDir)) {
            if (files.includes(stale)) continue;
            fs.rmSync(path.join(destDir, stale), { recursive: true, force: true });
            console.log(`[PLUGIN] Removed ${id}/${stale} from public/ (not the declared client)`);
          }
        }
        if (!files.length) continue;
        fs.mkdirSync(destDir, { recursive: true });
        for (const file of files) {
          const src = path.join(srcDir, file);
          const dest = path.join(destDir, file);
          const srcBuf = fs.readFileSync(src);
          const destBuf = fs.existsSync(dest) ? fs.readFileSync(dest) : null;
          if (!destBuf || !srcBuf.equals(destBuf)) {
            fs.writeFileSync(dest, srcBuf);
            console.log(`[PLUGIN] Synced ${id}/${file} → public/`);
          }
        }
      } catch (e) {
        console.warn(`[PLUGIN] sync ${id} failed:`, e.message);
      }
    }
  }

  // Fire a hook — all registered plugins run in order
  async emit(hookName, ...args) {
    const handlers = this.hooks[hookName] || [];
    for (const { fn } of handlers) {
      try {
        await fn(...args);
      } catch (e) {
        console.error(`[PLUGIN] Hook ${hookName} error:`, e.message);
      }
    }
  }

  // Get resolved settings for a plugin (saved values merged with defaults)
  getSettings(pluginId) {
    const plugin = this.plugins.get(pluginId);
    if (!plugin) return {};
    const schema = plugin.manifest.settings || {};
    const registry = this.readRegistry();
    const saved = registry[pluginId]?.settings || {};
    const result = {};
    for (const [key, def] of Object.entries(schema)) {
      result[key] = saved[key] !== undefined ? saved[key] : def.default;
    }
    return result;
  }

  // Update settings for a plugin
  updateSettings(pluginId, patch) {
    const registry = this.readRegistry();
    if (!registry[pluginId]) registry[pluginId] = {};
    if (!registry[pluginId].settings) registry[pluginId].settings = {};
    Object.assign(registry[pluginId].settings, patch);
    this.saveRegistry(registry);

    // Notify plugin instance
    const plugin = this.plugins.get(pluginId);
    if (plugin?.instance?.onSettingsChange) {
      plugin.instance.onSettingsChange(this.getSettings(pluginId));
    }
  }

  // List all plugins with their state
  list() {
    const registry = this.readRegistry();
    return [...this.plugins.entries()].map(([id, p]) => ({
      id,
      name: p.manifest.name,
      version: p.manifest.version,
      description: p.manifest.description,
      author: p.manifest.author,
      type: p.manifest.type || 'community',
      category: p.manifest.category || 'utility',
      icon: p.manifest.icon || null,
      order: p.manifest.order || null,
      enabled: p.enabled,
      hasClient: !!p.manifest.client,
      settings: p.manifest.settings || {},
      currentSettings: this.getSettings(id),
      dependencies: p.manifest.dependencies || [],
    }));
  }

  // Toggle a plugin on/off
  toggle(pluginId) {
    const plugin = this.plugins.get(pluginId);
    if (!plugin) return null;
    const registry = this.readRegistry();
    if (!registry[pluginId]) registry[pluginId] = {};
    const newState = !plugin.enabled;
    registry[pluginId].enabled = newState;
    plugin.enabled = newState;
    this.saveRegistry(registry);

    if (!newState && plugin.instance) {
      // Deactivate: call deactivate() if plugin supports it
      if (typeof plugin.instance.deactivate === 'function') {
        try { plugin.instance.deactivate(); } catch (e) {
          console.error(`[PLUGIN] Deactivate error for ${pluginId}:`, e.message);
        }
      }
      // Remove hooks registered by this plugin
      for (const [hookName, handlers] of Object.entries(this.hooks)) {
        this.hooks[hookName] = handlers.filter(h => h.pluginId !== pluginId);
      }
    }

    return { id: pluginId, enabled: newState, hasClient: !!plugin.manifest.client, needsRestart: !!(plugin.instance?.registerRoutes) };
  }

  // --- Private ---

  _createPluginAPI(pluginId, manifest, sessionManager) {
    // Shape is defined once in plugin-sdk.buildPluginAPI (the front desk).
    return buildPluginAPI({
      pluginId,
      getSettings: () => this.getSettings(pluginId),
      updateSettings: (patch) => this.updateSettings(pluginId, patch),
      sessionManager,
      getPlugin: (id) => this.plugins.get(id)?.instance,
      pluginDir: path.join(this.pluginsDir, pluginId),
      sendToSession: this.sendToSession,
      wss: this.wss,
    });
  }

  _topoSort(items) {
    const byId = new Map(items.map(i => [i.manifest.id, i]));
    const sorted = [];
    const visited = new Set();

    function visit(item) {
      if (visited.has(item.manifest.id)) return;
      visited.add(item.manifest.id);
      for (const dep of item.manifest.dependencies || []) {
        const depItem = byId.get(dep);
        if (depItem) visit(depItem);
      }
      sorted.push(item);
    }

    for (const item of items) visit(item);
    return sorted;
  }

  _registerAPIRoutes(app) {
    // List all plugins
    app.get('/api/plugins', (_req, res) => {
      res.json(this.list());
    });

    // Toggle a plugin
    app.post('/api/plugins/:id/toggle', (req, res) => {
      const result = this.toggle(req.params.id);
      if (!result) return res.status(404).json({ error: 'Plugin not found' });
      res.json(result);
    });

    // Get plugin settings
    app.get('/api/plugins/:id/settings', (req, res) => {
      const plugin = this.plugins.get(req.params.id);
      if (!plugin) return res.status(404).json({ error: 'Plugin not found' });
      res.json({
        schema: plugin.manifest.settings || {},
        values: this.getSettings(req.params.id),
      });
    });

    // Update plugin settings
    app.post('/api/plugins/:id/settings', (req, res) => {
      const plugin = this.plugins.get(req.params.id);
      if (!plugin) return res.status(404).json({ error: 'Plugin not found' });
      this.updateSettings(req.params.id, req.body);
      res.json({ ok: true, settings: this.getSettings(req.params.id) });
    });
  }
}

module.exports = { PluginManager, createPluginStaticGuard, declaredClientFile };
