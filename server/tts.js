/**
 * TTS Routes — Microsoft Edge TTS via msedge-tts.
 *
 * Exposes:
 *   POST /api/tts  { text, lang? }  -> audio/mpeg (mp3) bytes
 *
 * Voices:
 *   English  -> en-GB-RyanNeural  (rate +8%)
 *   Italian  -> it-IT-DiegoNeural (rate +8%)
 *
 * Language detection: if `lang` is not supplied, a heuristic checks for
 * Italian-specific accented characters and stopwords; falls back to English.
 *
 * Caching: sha1(voice|text) -> .cache/tts/<hash>.mp3. Identical requests
 * serve from disk, skipping synthesis entirely.
 *
 * Auth: gated by caller-supplied requireAuth (JWT Bearer).
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { MsEdgeTTS, OUTPUT_FORMAT } = require('msedge-tts');

const REPO_ROOT = path.join(__dirname, '..');
const CACHE_DIR = path.join(REPO_ROOT, '.cache', 'tts');

const VOICES = {
  en: 'en-GB-RyanNeural',
  it: 'it-IT-DiegoNeural',
};

const RATE = '+8%';
const MAX_TEXT_LEN = 2000;
const MAX_RETRIES = 4;
const RETRY_DELAY_MS = 600;
try { fs.mkdirSync(CACHE_DIR, { recursive: true }); } catch (_) {}

async function freshInstance(voice) {
  const tts = new MsEdgeTTS();
  await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3);
  return tts;
}

function detectLang(text) {
  if (/[àèéìòóù]/i.test(text)) return 'it';
  if (/\b(che|sono|perché|però|anche|questo|questa|quello|quella|gli|della|delle|degli|sulla|nella|come|molto|quando|dove|cosa|essere|fare|ciao|grazie|allora|quindi|ecco|invece|oppure)\b/i.test(text)) return 'it';
  return 'en';
}

function resolveLang(lang, text) {
  if (lang) {
    const key = lang.toString().slice(0, 2).toLowerCase();
    return VOICES[key] ? key : 'en';
  }
  return detectLang(text);
}

function cacheKey(voice, text) {
  return crypto.createHash('sha1').update(`${voice}|${text}`).digest('hex');
}

async function synthesiseOnce(voice, text) {
  const tts = await freshInstance(voice);
  const { audioStream } = tts.toStream(text, { rate: RATE });
  return new Promise((resolve, reject) => {
    const chunks = [];
    audioStream.on('data', (chunk) => chunks.push(chunk));
    audioStream.on('end', () => { tts.close(); resolve(Buffer.concat(chunks)); });
    audioStream.on('error', (err) => { tts.close(); reject(err); });
  });
}

async function synthesise(voice, text) {
  let lastErr;
  for (let i = 0; i < MAX_RETRIES; i++) {
    try {
      return await synthesiseOnce(voice, text);
    } catch (err) {
      lastErr = err;
      if (i < MAX_RETRIES - 1) await new Promise(r => setTimeout(r, RETRY_DELAY_MS * (i + 1)));
    }
  }
  throw lastErr;
}

function createTTSRouter({ requireAuth }) {
  const router = express.Router();
  const gate = requireAuth || ((_req, _res, next) => next());

  router.post('/api/tts', gate, async (req, res) => {
    const { text, lang } = req.body || {};

    if (!text || typeof text !== 'string' || !text.trim()) {
      return res.status(400).json({ error: 'text (non-empty string) is required' });
    }
    if (text.length > MAX_TEXT_LEN) {
      return res.status(413).json({ error: `text too long (max ${MAX_TEXT_LEN} chars)` });
    }

    const langKey = resolveLang(lang, text);
    const voice = VOICES[langKey];
    const cleanText = text.trim();

    const hash = cacheKey(voice, cleanText);
    const cachePath = path.join(CACHE_DIR, `${hash}.mp3`);

    try {
      if (fs.existsSync(cachePath)) {
        const mp3 = fs.readFileSync(cachePath);
        if (mp3.length > 0) {
          res.set('Content-Type', 'audio/mpeg');
          res.set('Content-Length', mp3.length);
          res.set('X-TTS-Voice', voice);
          res.set('X-TTS-Cache', 'hit');
          return res.send(mp3);
        }
      }
    } catch (_) { /* fall through to synthesis */ }

    try {
      const mp3 = await synthesise(voice, cleanText);

      if (!mp3.length) {
        return res.status(500).json({ error: 'Edge TTS produced no audio' });
      }

      try { fs.writeFile(cachePath, mp3, () => {}); } catch (_) {}

      res.set('Content-Type', 'audio/mpeg');
      res.set('Content-Length', mp3.length);
      res.set('X-TTS-Voice', voice);
      res.set('X-TTS-Cache', 'miss');
      return res.send(mp3);
    } catch (err) {
      console.error('[tts] Edge TTS error:', err.message);
      return res.status(500).json({ error: `Edge TTS failed: ${err.message}` });
    }
  });

  return router;
}

module.exports = { createTTSRouter };
