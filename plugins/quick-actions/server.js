const path = require('path');
const fs = require('fs');

module.exports = {
  activate(api) {
    const configPath = path.join(api.pluginDir, 'config.json');

    return {
      registerRoutes(router) {
        router.get('/config', (req, res) => {
          try {
            const raw = fs.readFileSync(configPath, 'utf8');
            res.json(JSON.parse(raw));
          } catch (e) {
            console.error('[quick-actions] Failed to read config.json:', e.message);
            res.json({ actions: [] });
          }
        });

        // [2026-09-22] Tolto il ramo `action === 'deploy'`, che inoltrava a
        // POST /api/deploy sulla porta 3170 — cioe' faceva RIPARTIRE la
        // Machine. Nessuna voce di config.json lo raggiungeva (le tre attive
        // sono attach-file, wrap e copy-chat, tutte di tipo "special" e
        // gestite dentro client.js) e nessun client chiama mai /trigger: era
        // una porta viva sul riavvio che non sorvegliava nessuno. In questa
        // casa i riavvii sono solo del proprietario. La rotta resta come guscio:
        // qualunque azione le arrivi, risponde 400.
        router.post('/trigger', (req, res) => {
          const { action } = req.body || {};
          res.status(400).json({ error: 'Unknown action: ' + action });
        });
      }
    };
  }
};
