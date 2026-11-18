/**
 * Claude Code CLI Usage Tracker
 *
 * Surfaces the Anthropic-side rate-limit utilization that the `claude` CLI's
 * `/usage` command shows — but as a passive API endpoint, so the top bar can
 * display it without the owner having to drop into the terminal.
 *
 * Endpoint: GET https://api.anthropic.com/api/oauth/usage (auth via the OAuth
 * bearer token the Claude CLI maintains at ~/.claude/.credentials.json — same
 * subscription, no separate login). The endpoint returns no-cost metadata; it
 * does NOT consume any model tokens.
 *
 * Response body shape (verified live 2026-05-26):
 *   {
 *     "five_hour":  { "utilization": <0-100>, "resets_at": "<ISO 8601>" },
 *     "seven_day":  { "utilization": <0-100>, "resets_at": "<ISO 8601>" },
 *     "seven_day_opus":   { "utilization": ..., "resets_at": ... } | null,
 *     "seven_day_sonnet": { ... },
 *     "extra_usage": { ... credit-balance fields ... },
 *     ...
 *   }
 *
 * In-process cache for CACHE_MS so the top bar can poll aggressively without
 * hammering Anthropic. Without a claude binary the function returns an error.
 */

const fs = require('fs');
const https = require('https');
const path = require('path');

const HOME = process.env.HOME || require('os').homedir();
const CREDS_PATH = path.join(HOME, '.claude', '.credentials.json');
const CLAUDE_BIN = path.join(HOME, '.local', 'bin', 'claude');
const API_HOST = 'api.anthropic.com';
const API_PATH = '/api/oauth/usage';
const CACHE_MS = 60 * 1000; // 1 minute — headers don't change second-by-second
// When a fresh upstream fetch fails (rate limit, timeout, network blip), keep
// serving the LAST-KNOWN-GOOD body for up to STALE_OK_MS so the top-bar pill
// doesn't flicker out on transient errors. The Anthropic /api/oauth/usage
// endpoint is occasionally slow/erroring; with 5s client polling that would
// otherwise pop the pill off the bar repeatedly.
const STALE_OK_MS = 15 * 60 * 1000; // 15 minutes

let _cache = { fetchedAt: 0, data: null, error: null };
let _inflight = null;

function readBearer() {
  try {
    const raw = fs.readFileSync(CREDS_PATH, 'utf8');
    const creds = JSON.parse(raw);
    // Known shapes — claude CLI's current credential schema and a few fallbacks
    const oauth = creds.claudeAiOauth || creds.oauth || creds;
    const token = oauth.accessToken || oauth.access_token || creds.accessToken;
    if (typeof token !== 'string' || !token) return null;
    return token;
  } catch (e) {
    return null;
  }
}

function parseNum(v) {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Parse an ISO 8601 timestamp into unix seconds (matches the CLI's internal
// `resets_at` convention). Returns null on anything non-parseable.
function parseResetIso(s) {
  if (typeof s !== 'string' || !s) return null;
  const ms = Date.parse(s);
  if (!Number.isFinite(ms)) return null;
  return Math.round(ms / 1000);
}

function fetchUsageOnce() {
  return new Promise((resolve) => {
    const token = readBearer();
    if (!token) return resolve({ error: 'no-oauth-token' });
    const req = https.request({
      host: API_HOST,
      port: 443,
      path: API_PATH,
      method: 'GET',
      timeout: 6000,
      headers: {
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json',
        'User-Agent': 'the-151-machine/claude-usage-probe',
        'Accept': 'application/json',
      },
    }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        if (res.statusCode === 401 || res.statusCode === 403) {
          return resolve({ error: 'auth-failed', status: res.statusCode });
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return resolve({ error: 'http-' + res.statusCode });
        }
        let parsed;
        try { parsed = JSON.parse(body); }
        catch (e) { return resolve({ error: 'bad-body' }); }
        const fh = parsed.five_hour || null;
        const sd = parsed.seven_day || null;
        const session_pct = fh ? parseNum(fh.utilization) : null;
        const weekly_pct  = sd ? parseNum(sd.utilization) : null;
        const session_resets_at = fh ? parseResetIso(fh.resets_at) : null;
        const weekly_resets_at  = sd ? parseResetIso(sd.resets_at) : null;
        if (session_pct == null && weekly_pct == null) {
          return resolve({ error: 'no-fields' });
        }
        resolve({
          session_pct,
          weekly_pct,
          session_resets_at,
          weekly_resets_at,
        });
      });
    });
    req.on('error', (e) => resolve({ error: 'fetch-error', detail: e && e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ error: 'timeout' }); });
    req.end();
  });
}

async function getClaudeCliUsage() {
  // No claude CLI / no credentials on this box → say so, never throw.
  if (!fs.existsSync(CLAUDE_BIN)) {
    return { error: 'no-cli-on-host' };
  }
  const now = Date.now();
  if (_cache.data && (now - _cache.fetchedAt) < CACHE_MS) {
    return { ..._cache.data, fetched_at: _cache.fetchedAt, cached: true };
  }
  if (_inflight) return _inflight;
  _inflight = (async () => {
    const out = await fetchUsageOnce();
    if (!out.error) {
      _cache = { fetchedAt: Date.now(), data: out, error: null };
      _inflight = null;
      return { ...out, fetched_at: _cache.fetchedAt, cached: false };
    }
    // Fresh fetch failed. If we have a recent last-known-good (≤ STALE_OK_MS),
    // serve it instead of surfacing the error — prevents the top-bar pill from
    // flickering off on transient upstream blips. Only after the staleness
    // window expires do we surface the error and let the chip hide.
    _inflight = null;
    if (_cache.data && (now - _cache.fetchedAt) < STALE_OK_MS) {
      return {
        ..._cache.data,
        fetched_at: _cache.fetchedAt,
        cached: true,
        stale: true,
        error_recent: out.error,
      };
    }
    return { error: out.error, detail: out.detail || null, fetched_at: now };
  })();
  return _inflight;
}

module.exports = { getClaudeCliUsage, _internal: { fetchUsageOnce, readBearer } };
