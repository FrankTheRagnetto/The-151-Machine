'use strict';
/**
 * The 151 Machine — Plugin SDK  ("the front desk")
 * ===================================================================
 *
 * THE single, documented definition of what a plugin's `server.js` is handed
 * and allowed to use. Before this file the contract was an anonymous object
 * literal buried in plugin-loader._createPluginAPI — so any reshuffle of the
 * session manager or the WS layer could silently break the (14) code plugins
 * with nothing to check against. This is the stable surface they talk to; the
 * machine's internals can move around freely behind it as long as this holds.
 *
 * It is deliberately NON-ENFORCING: it does not sandbox plugins or block the
 * direct `require('../../server/<engine>')` a plugin uses to reach its OWN
 * paired engine (auto-memory↔memory-engine, auto-skills↔skill-writer,
 * coordinator↔coordinator) — that is legitimate sibling coupling. It formalises
 * and documents the COMMON surface every plugin receives, and gives it a
 * version so future changes are a deliberate, visible decision.
 *
 * -------------------------------------------------------------------
 * The plugin contract
 * -------------------------------------------------------------------
 * A plugin folder = manifest.json + optional server.js + optional client files.
 *
 * server.js may export:
 *   activate(api) -> instance          // boot hook; receives the api below.
 *                                       // Return value (or the module itself)
 *                                       // becomes the plugin "instance".
 * The instance may expose:
 *   registerRoutes(router)             // Express router mounted at
 *                                       //   /api/plugins/<id>/
 *   <hookName>(...args)                // one fn per name in manifest.hooks,
 *                                       //   fired via PluginManager.emit()
 *   onSettingsChange(settings)         // called after settings are updated
 *   deactivate()                       // called when the plugin is toggled off
 *
 * -------------------------------------------------------------------
 * The `api` object (what activate(api) receives) — the OFFICIAL surface
 * -------------------------------------------------------------------
 *   getSettings()                 -> object   resolved settings for THIS plugin
 *                                              (manifest defaults + saved values)
 *   updateSettings(patch)         -> void     persist a settings patch for THIS
 *                                              plugin (fires onSettingsChange)
 *   sendToSession(sessionId, msg) -> void     push a WebSocket message to one
 *                                              session (may be undefined very
 *                                              early in boot — guard it)
 *   getPlugin(id)                 -> instance|undefined   another loaded
 *                                              plugin's instance, for cross-talk
 *   pluginDir                     -> string   absolute path to this plugin's
 *                                              own folder (for reading bundled
 *                                              assets / writing plugin state)
 *   manager                       -> SessionManager   the live session manager.
 *                                              Powerful — treat as read-mostly;
 *                                              prefer narrow helpers over poking
 *                                              its internals.
 *   wss                           -> WebSocketServer   the raw ws server (may be
 *                                              undefined early in boot — guard).
 *   sdkVersion                    -> number   this contract's version
 *                                              (PLUGIN_SDK_VERSION).
 *
 * Adding a field here is backward-compatible (plugins ignore unknown keys).
 * REMOVING or RENAMING a field is a breaking change to every plugin — bump
 * PLUGIN_SDK_VERSION and grep plugins/ for users first.
 */

// Contract version. Bump on any breaking change to the api surface above.
const PLUGIN_SDK_VERSION = 1;

/**
 * Build the api object handed to a plugin's activate(). The loader passes in
 * the already-bound capabilities; this is the ONE place that assembles the
 * shape, so the surface is defined in exactly one named location.
 *
 * @param {object} deps
 * @param {string}   deps.pluginId
 * @param {Function} deps.getSettings     () => resolved settings for this plugin
 * @param {Function} deps.updateSettings  (patch) => persist settings
 * @param {object}   deps.sessionManager  the live SessionManager
 * @param {Function} deps.getPlugin       (id) => instance | undefined
 * @param {string}   deps.pluginDir       absolute path to this plugin's folder
 * @param {Function} deps.sendToSession   (sessionId, msg) => void
 * @param {object}   deps.wss             the WebSocket server
 * @returns {object} the frozen-shape api object
 */
function buildPluginAPI(deps) {
  const {
    getSettings,
    updateSettings,
    sessionManager,
    getPlugin,
    pluginDir,
    sendToSession,
    wss,
  } = deps || {};

  return {
    getSettings,
    updateSettings,
    manager: sessionManager,
    getPlugin,
    pluginDir,
    sendToSession,
    wss,
    sdkVersion: PLUGIN_SDK_VERSION,
  };
}

module.exports = { buildPluginAPI, PLUGIN_SDK_VERSION };
