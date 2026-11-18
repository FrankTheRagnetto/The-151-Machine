/**
 * Attachment auto-transcription helper.
 *
 * Public API:
 *   transcribeAttachment(absPath, mime) -> Promise<{ok, text?, error?}>
 *   readCachedTranscript(absPath) -> string | null
 *
 * Flow:
 *   - audio/* → POST the file directly to whisper-stt /transcribe (localhost:3172)
 *   - video/* → ffmpeg extract mono 16kHz wav to sibling file, then POST
 *   - other   → skip
 *
 * Writes the transcript to `<absPath>.transcript.txt` for later retrieval by
 * session-manager at send-time. Fully async — callers must not await it in
 * the request path; fire-and-forget is fine.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const http = require('http');

const WHISPER_HTTP_HOST = '127.0.0.1';
// Linux PC-peer: session-host daemon owns 3172 (TCP IPC), so whisper's HTTP
// transcribe endpoint moves to WHISPER_HTTP_PORT (3173 set in ecosystem).
const WHISPER_HTTP_PORT = parseInt(process.env.WHISPER_HTTP_PORT, 10) || 3172;
const MAX_TRANSCRIBE_BYTES = 50 * 1024 * 1024; // 50 MB — skip anything larger

function transcriptPath(absPath) {
  return `${absPath}.transcript.txt`;
}

function readCachedTranscript(absPath) {
  try {
    const tp = transcriptPath(absPath);
    if (!fs.existsSync(tp)) return null;
    const txt = fs.readFileSync(tp, 'utf-8');
    return txt.trim() || null;
  } catch {
    return null;
  }
}

function isAudio(mime) { return typeof mime === 'string' && mime.toLowerCase().startsWith('audio/'); }
function isVideo(mime) { return typeof mime === 'string' && mime.toLowerCase().startsWith('video/'); }

// Simple multipart/form-data builder (enough for single file field).
function buildMultipart(filePath) {
  const boundary = '----151mach' + Date.now().toString(16);
  const filename = path.basename(filePath);
  const data = fs.readFileSync(filePath);
  const head = Buffer.from(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
    `Content-Type: application/octet-stream\r\n\r\n`,
    'utf-8'
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf-8');
  const body = Buffer.concat([head, data, tail]);
  return { body, boundary };
}

function postToWhisper(filePath, language) {
  return new Promise((resolve, reject) => {
    const { body, boundary } = buildMultipart(filePath);
    const lang = language && language !== 'auto' ? `?language=${encodeURIComponent(language)}` : '';
    const req = http.request({
      host: WHISPER_HTTP_HOST,
      port: WHISPER_HTTP_PORT,
      path: `/transcribe${lang}`,
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length,
      },
      // Live dictation now flows through this path (server/index.js
      // /api/dictation/transcribe). the owner dictates up to ~1h in one clip; whisper
      // on CPU can take many minutes on a long clip, so the socket timeout must be
      // generous or a long clip is killed mid-transcription. Env-tunable.
      timeout: parseInt(process.env.WHISPER_HTTP_TIMEOUT_MS, 10) || 60 * 60 * 1000,
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf-8');
        try {
          const json = JSON.parse(raw);
          if (res.statusCode >= 400) return reject(new Error(json.error || `whisper ${res.statusCode}`));
          resolve(json);
        } catch (e) {
          reject(new Error(`invalid whisper response (${res.statusCode}): ${raw.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('whisper timeout')); });
    req.write(body);
    req.end();
  });
}

function extractAudioWithFfmpeg(videoPath) {
  return new Promise((resolve, reject) => {
    const wavPath = `${videoPath}.extracted.wav`;
    const proc = spawn('ffmpeg', [
      '-hide_banner', '-loglevel', 'error',
      '-y',
      '-i', videoPath,
      '-vn',
      '-ac', '1',
      '-ar', '16000',
      '-f', 'wav',
      wavPath,
    ]);
    let stderr = '';
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve(wavPath);
      else reject(new Error(`ffmpeg rc=${code}: ${stderr.slice(0, 300)}`));
    });
  });
}

async function transcribeAttachment(absPath, mime) {
  try {
    if (!absPath || !fs.existsSync(absPath)) return { ok: false, error: 'file missing' };
    const stat = fs.statSync(absPath);
    if (stat.size > MAX_TRANSCRIBE_BYTES) {
      console.log(`[attach-srv] skip transcribe (too large): ${absPath} size=${stat.size}`);
      return { ok: false, error: 'file too large' };
    }

    let feedPath = null;
    let cleanupPath = null;

    if (isAudio(mime)) {
      feedPath = absPath;
    } else if (isVideo(mime)) {
      console.log(`[attach-srv] extracting audio from video: ${absPath}`);
      feedPath = await extractAudioWithFfmpeg(absPath);
      cleanupPath = feedPath;
    } else {
      return { ok: false, error: 'unsupported mime' };
    }

    console.log(`[attach-srv] transcribing ${feedPath}`);
    const res = await postToWhisper(feedPath);
    const text = (res && typeof res.text === 'string') ? res.text.trim() : '';
    console.log(`[attach-srv] transcript len=${text.length}`);

    if (text) {
      try {
        fs.writeFileSync(transcriptPath(absPath), text, 'utf-8');
      } catch (e) {
        console.warn('[attach-srv] failed writing transcript:', e.message);
      }
    }

    if (cleanupPath) {
      try { fs.unlinkSync(cleanupPath); } catch {}
    }

    return { ok: true, text };
  } catch (e) {
    console.warn('[attach-srv] transcribe failed:', e.message);
    return { ok: false, error: e.message };
  }
}

// Lean one-shot transcription of an already-saved audio file, for the live
// dictation HTTP path (/api/dictation/transcribe). Unlike transcribeAttachment
// it writes NO .transcript.txt sidecar and needs no mime — whisper sniffs the
// container from the bytes. One file in → one whisper pass → text out. No chunking.
async function transcribeAudioFile(absPath, language) {
  try {
    if (!absPath || !fs.existsSync(absPath)) return { ok: false, error: 'file missing' };
    const res = await postToWhisper(absPath, language || 'auto');
    const text = (res && typeof res.text === 'string') ? res.text.trim() : '';
    return { ok: true, text };
  } catch (e) {
    console.warn('[dictation-srv] transcribe failed:', e.message);
    return { ok: false, error: e.message };
  }
}

module.exports = { transcribeAttachment, transcribeAudioFile, readCachedTranscript, transcriptPath };
