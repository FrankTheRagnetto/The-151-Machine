/* The 151 Machine — Service Worker (shell + topbar only)
 *
 * Scope: make the app BOOT and show last-known chips when the server
 * is unreachable. That's it. No feature-specific offline.
 *
 * HARD RULES (do not relax without reading memory/feedback_sw_network_first.md):
 *  - NETWORK-FIRST always. Cache is ONLY used as a fallback when the network
 *    errors out. Never serve stale HTML/JS/CSS when online.
 *  - /api/*, /ws, /plugins/* are BYPASSED entirely — the SW never caches them
 *    and never interferes with their requests.
 *  - Only same-origin GETs on the shell allowlist are ever cached.
 *  - Cross-origin, POST/PUT/DELETE: passthrough, no SW involvement.
 *
 * Kill switches:
 *  - In the page: localStorage['151-sw-enabled'] = '0' -> index.html unregisters
 *    this SW and wipes caches (old behaviour preserved as escape hatch).
 */

// Build tag — injected by the server at serve-time via string replacement.
// When BUILD_HASH changes (on deploy), the browser detects sw.js changed
// and triggers install → activate → old caches pruned automatically.
const CACHE_NAME = 'the151machine-shell-__BUILD_HASH__';

// Shell allowlist — exact paths we proactively pre-cache on install.
// Each entry was verified to exist in public/ before being listed. If any
// of these 404s the install should NOT break — addAll is all-or-nothing, so
// we add them individually and swallow errors.
const SHELL_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icon.svg',
  '/css/main.css',
  '/purify.min.js',
  '/marked.min.js',
  // battito.js: prerequisito duro di topbar.js (e di dictation.js). Se il guscio
  // si apre offline senza di lui la barra di stato resta ferma, quindi sta nella
  // lista esattamente come i moduli che lo usano.
  '/js/battito.js',
  '/js/per-utente.js',
  '/js/core.js',
  '/js/pezzo-bottoni.js',
  '/js/chat.js',
  '/js/ws.js',
  '/js/sessions.js',
  '/js/input.js',
  '/js/auth.js',
  '/js/ui.js',
  '/js/init.js',
  '/js/topbar.js',
];

// Bypass patterns — if any of these match, the SW MUST defer entirely
// to the browser's default network handling. No caching, no fallback.
const BYPASS_PATHS = ['/api/', '/ws', '/plugins/'];

function isShellRequest(url) {
  // Same-origin only.
  if (url.origin !== self.location.origin) return false;
  // Strip query string (server appends ?v=BUILD_HASH, but the asset content
  // for the same pathname is identical — matching by path is safer).
  const path = url.pathname;
  if (SHELL_ASSETS.includes(path)) return true;
  // Treat bare "/" the same as "/index.html".
  if (path === '/' || path === '/index.html') return true;
  return false;
}

function shouldBypass(url) {
  if (url.origin !== self.location.origin) return true;
  return BYPASS_PATHS.some((p) => url.pathname === p || url.pathname.startsWith(p));
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      // Add each asset individually so a single 404 doesn't abort install.
      await Promise.all(
        SHELL_ASSETS.map(async (path) => {
          try {
            const res = await fetch(path, { cache: 'no-store' });
            if (res && res.ok) await cache.put(path, res.clone());
          } catch (e) {
            // Missing shell asset — skip, don't fail install.
            // eslint-disable-next-line no-console
            console.warn('[sw] shell precache skipped:', path, e && e.message);
          }
        })
      );
      // Activate immediately on first install so the page gets offline
      // support on the very next reload.
      self.skipWaiting();
    })
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Prune any cache not matching the current version.
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      );
      await self.clients.claim();
    })()
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;

  // Rule 1: non-GET — never touch.
  if (req.method !== 'GET') return;

  let url;
  try { url = new URL(req.url); } catch (e) { return; }

  // Rule 2: /api, /ws, /plugins — always bypass.
  if (shouldBypass(url)) return;

  // Rule 3: cross-origin GETs — bypass (fonts, CDNs, etc.).
  if (url.origin !== self.location.origin) return;

  // Rule 4: only handle shell allowlist. Anything else (downloads/, etc.)
  // falls through to default browser handling.
  if (!isShellRequest(url)) return;

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      try {
        // Network-first. Use the original request so credentials/headers flow.
        const res = await fetch(req);
        // Only cache 2xx OK responses. Opaque/redirect responses are skipped.
        if (res && res.ok && res.type === 'basic') {
          // Use pathname as the cache key so ?v=BUILD_HASH variants all
          // map to the same entry (latest wins).
          cache.put(url.pathname, res.clone()).catch(() => {});
        }
        return res;
      } catch (err) {
        // Network failure — fall back to cached shell.
        const cached = (await cache.match(url.pathname)) || (await cache.match('/'));
        if (cached) return cached;
        // Give up — let the browser show its native error.
        throw err;
      }
    })()
  );
});
