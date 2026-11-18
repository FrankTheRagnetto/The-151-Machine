// PM2 ecosystem for Linux (optional — `npm start` is enough to try it out).
//
// Three apps:
//   151-session-host  keeps live Claude sessions alive across web-server restarts
//                     (TCP loopback IPC on 127.0.0.1:3172).
//   151-machine       the web server + API (PORT, default 3170).
//   whisper-stt       optional local speech-to-text (whisper-service/, needs its
//                     own Python venv; ws 3171 + http 3173, loopback only).
//
// Start order matters: the session host must be up BEFORE the web server.
//   pm2 start ecosystem.linux.config.js --only 151-session-host
//   pm2 start ecosystem.linux.config.js --only 151-machine
//   pm2 start ecosystem.linux.config.js --only whisper-stt     # optional
// tools/pm2-boot.sh does exactly this.
//
// Paths are derived from this file's location and the current user's HOME, so
// the repo can live anywhere. Secrets do NOT go here: they go in .env
// (see .env.example), which server/index.js loads with dotenv.

const os = require('os');
const path = require('path');

const REPO = __dirname;
const HOME = process.env.HOME || os.homedir();
const PATH = `${path.join(HOME, '.local', 'bin')}:/usr/local/bin:/usr/bin:/bin`;

module.exports = {
  apps: [
    {
      name: '151-session-host',
      script: 'server/session-host/index.js',
      cwd: REPO,
      watch: false,
      autorestart: true,
      max_restarts: 10,
      min_uptime: 10000,
      restart_delay: 3000,
      exp_backoff_restart_delay: 200,
      max_memory_restart: '300M',
      kill_timeout: 10000,
      graceful_timeout: 5000,
      env: {
        NODE_ENV: 'production',
        SESSION_HOST_FORCE_TCP: '1',
        HOME,
        PATH,
      },
      error_file: `${REPO}/logs/session-host-error.log`,
      out_file: `${REPO}/logs/session-host-out.log`,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs: true,
    },
    {
      name: '151-machine',
      script: 'server/index.js',
      cwd: REPO,
      watch: false,
      autorestart: true,
      max_restarts: 15,
      min_uptime: 5000,
      restart_delay: 5000,
      // Must stay ABOVE the in-process memory watchdog (MEM_LIMIT_MB, default
      // 1024 MB → graceful restart that saves state first); PM2 is the backstop.
      max_memory_restart: '1200M',
      kill_timeout: 10000,
      graceful_timeout: 5000,
      env: {
        NODE_ENV: 'production',
        PORT: 3170,
        // Sessions live in the session-host daemon above (survive restarts).
        USE_SESSION_HOST: '1',
        // Claude Agent SDK engine (server/sdk-engine.js): warm, persistent sessions.
        USE_SDK_ENGINE: '1',
        // Auto-memory (server/memory-engine.js + plugins/auto-memory). '' = off.
        MEMORY_AUTO: '1',
        // Auto-skills drafts + curator: off by default ('' = off; '0' would be ON,
        // the code checks the truthiness of the string).
        SKILLS_AUTO: '',
        SKILLS_CURATOR: '',
        // Per-session ordered event log: a reconnecting client replays only
        // what it missed (server/stream-log.js).
        DETACHED_RUNS: '1',
        // A session interrupted by a restart comes back knowing which tools it
        // already ran (server/restart-journal.js).
        RESTART_MEMORY: '1',
        SESSION_HOST_FORCE_TCP: '1',
        WHISPER_HTTP_PORT: '3173',
        HOME,
        PATH,
      },
      error_file: `${REPO}/logs/pm2-error.log`,
      out_file: `${REPO}/logs/pm2-out.log`,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs: true,
    },
    {
      name: 'whisper-stt',
      script: 'server.py',
      interpreter: `${REPO}/whisper-service/venv/bin/python3`,
      cwd: `${REPO}/whisper-service`,
      watch: false,
      autorestart: true,
      max_restarts: 5,
      min_uptime: 30000,
      restart_delay: 15000,
      exp_backoff_restart_delay: 2000,
      // 'medium' peaks near 2.8 GB on a 3-minute clip; keep the ceiling above it.
      max_memory_restart: '4G',
      kill_timeout: 15000,
      graceful_timeout: 10000,
      env: {
        HOME,
        PATH,
        WHISPER_FORCE_CPU: '1',
        // faster-whisper model: tiny / base / small / medium. 'small' is a good
        // speed/accuracy trade-off on CPU.
        WHISPER_MODEL: 'small',
        WHISPER_HTTP_PORT: '3173',
      },
      error_file: `${REPO}/logs/whisper-stt-error.log`,
      out_file: `${REPO}/logs/whisper-stt-out.log`,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs: true,
    },
  ],
};
