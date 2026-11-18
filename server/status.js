/**
 * Status Routes — top bar data feeds
 *
 * Exposes lightweight, async-only endpoints for the client top bar:
 *   GET /api/status/claude-cli-usage  → percentuali 5h / 7d lette dalla CLI
 *
 * All routes gated by the caller-supplied auth middleware.
 *
 * [2026-10-16] Tolte GET /api/status/raspberry, /api/status/server e
 * /api/status/ram con le pillole «pi» e «pc» della barra (il proprietario: il Raspberry
 * si stacca). Erano i loro soli lettori; con loro esce la cache di `pm2 jlist`.
 */

const express = require('express');
const { getClaudeCliUsage } = require('./claude-cli-usage');

// [2026-10-12] CLAUDE_BIN_PATH e LAPTOP_BASE tolti: servivano solo alla Machine
// sul Pi (senza CLI) per chiedere al PC i limiti della CLI. Il Pi non ha più la
// Machine.

// [2026-09-10] DAILY_LOG_DIR + todayStamp() tolti insieme alla rotta
// GET /api/status/daily-log: la cartella cercata era `C--Users-The-151-User`,
// cioè il percorso del PC Windows dismesso a maggio. Su Linux non è mai
// esistita, quindi la rotta rispondeva `exists:false` da quattro mesi — e
// nessuna pagina la chiamava comunque (l'indicatore sole+X della topbar era
// già stato ritirato, public/js/topbar.js:7).

// [2026-09-22, secondo giro di potatura] Tolto TUTTO il contatore di token:
// le costanti CONTEXT_WINDOW / USAGE_CEILING_TOKENS / USAGE_WINDOW_MS, il
// deposito server/.usage-log.jsonl (USAGE_LOG_PATH, _usageHWM, _hwmSeeded) e
// le cinque funzioni che ci giravano intorno — recordUsageDelta(),
// readUsageLog(), getUsageForWindow(), pruneUsageLog(), estimateTokens() —
// piu' isActive(). Erano ~100 righe il cui unico lettore erano le due rotte
// GET /api/status/usage e /api/status/usage-detail, tolte qui sotto nello
// stesso atto insieme al blocco «usage» della topbar che le chiamava. Il
// conteggio che il proprietario vede oggi e' un altro dato: lo porta
// GET /api/status/claude-cli-usage, letto dalla CLI, che non passa di qui.
// Il file .usage-log.jsonl resta dov'e' (runtime, gia' fuori da git,
// .gitignore:80): nessuno lo scrive e nessuno lo legge piu'.

// --- Router factory ---
function createStatusRouter({ requireAuth }) {
  const router = express.Router();
  const gate = requireAuth || ((_req, _res, next) => next());

  // [2026-09-22] Tolte le rotte 1 e 2, GET /api/status/sessions e
  // GET /api/status/context/:id. Nessun client le chiamava: la pastiglia del
  // contesto e' sparita dalla barra il 2026-08-16 e il conteggio sessioni non
  // e' mai stato letto. Verificato su public/, plugins/, app/ e tests/.

  // [2026-09-22, secondo giro] Tolte anche le rotte 3 e 3b, GET
  // /api/status/usage e GET /api/status/usage-detail. Le serviva SOLO il
  // blocco «usage» della topbar, tolto stamattina (public/js/topbar.js:488).
  // Ricercate in tutto il repo — public/, plugins/, server/, tools/, tests/ e
  // app/ — nessun chiamante. L'unica traccia restante e' dentro
  // app/android/app/src/main/assets/public/, che NON e' sorgente: e' la copia
  // che `cap sync` fa di public/ (fuori da git, app/android/.gitignore:96) e
  // per giunta inerte, perche' capacitor.config.json punta `server.url` al
  // :3170 — il telefono carica le pagine dal server, non dal pacchetto.
  // Con loro se ne va il contatore di token: vedi la nota in testa al file.
  // `manager` non serve piu' a questo router (lo leggeva solo
  // recordUsageDelta) ed e' uscito dalla firma qui sopra.

  // 6b. Claude Code CLI usage — 5h "session limit" and 7d "weekly limit"
  //     percentages as shown by the CLI's `/usage` command. Read from response
  //     headers of /api/oauth/usage (zero token cost). The PC fetches it
  //     directly (it has the claude binary + credentials). [2026-10-12] The
  //     Pi path (proxy to the laptop) is gone with the Machine on the Pi.
  router.get('/api/status/claude-cli-usage', gate, async (_req, res) => {
    try {
      const data = await getClaudeCliUsage();
      return res.json(data);
    } catch (e) {
      return res.json({ error: 'fetch-failed', detail: e && e.message });
    }
  });

  // [2026-09-22] Tolta la rotta 7, GET /api/widget-status. Era pubblica, SENZA
  // autenticazione, e serviva a un widget da schermata iniziale che non e' mai
  // arrivato: l'unico widget dell'APK (MachineWidget.java, tolto del tutto
  // il 14/10/2026 con la 1.22) non faceva nessuna chiamata HTTP,
  // e nel repo non la chiama nessun altro. Tolta anche la sua esenzione
  // d'autenticazione in server/index.js.

  return router;
}

module.exports = { createStatusRouter };
