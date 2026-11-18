"""
151 Machine — Whisper STT Service
Standalone faster-whisper WebSocket service, loopback-only (127.0.0.1:3171).

Protocol (per-connection):
  Client -> server (JSON text frame):
    {"type": "start", "sessionId": "...", "language": "auto"|"it"|"en", "format": "webm"|"pcm16"}
  Client -> server (binary frames): audio chunks
    - If format=="webm": webm/opus container fragments (MediaRecorder output)
    - If format=="pcm16": raw 16kHz mono int16 little-endian PCM samples
  Client -> server (JSON): {"type": "stop"}

  Server -> client (JSON text):
    {"type": "ready"}                              # after "start" accepted
    {"type": "partial", "text": "...", "isFinal": false}
    {"type": "final",   "text": "...", "isFinal": true}
    {"type": "error",   "message": "..."}
"""
import asyncio
import io
import json
import logging
import os
import re
import signal
import socket
import subprocess
import sys
import tempfile
import time
from typing import Optional, Set

import numpy as np
import websockets
from websockets.server import WebSocketServerProtocol
from aiohttp import web

# --- Unicode-safe Windows console
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

LOG_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "logs")
os.makedirs(LOG_DIR, exist_ok=True)
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[
        logging.StreamHandler(sys.stdout),
        logging.FileHandler(os.path.join(LOG_DIR, "whisper-service.log"), encoding="utf-8"),
    ],
)
log = logging.getLogger("whisper-stt")

# [12/11/2026, /hack] Solo loopback: era "0.0.0.0" e whisper rispondeva anche
# al Wi-Fi di casa (3171 WS, 3173 HTTP). L'unico cliente è la Machine stessa
# (server/transcribe.js, 127.0.0.1) e il watchdog (tools/whisper-watchdog.sh,
# 127.0.0.1). Prova: tests/solo-tailnet.test.js, parte E.
HOST = "127.0.0.1"
# Porta WS. Override via env solo per poter alzare un'ISTANZA DI PROVA accanto a
# quella viva senza rubarle la porta (il default resta 3171: nessun cambio live).
PORT = int(os.environ.get("WHISPER_WS_PORT", "3171"))
# Idem per il pidfile: due istanze non devono calpestarsi il pid.
PIDFILE = os.environ.get("WHISPER_PIDFILE") or os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "whisper-stt.pid")


def _kill_stale_instance():
    """Kill any previous whisper instance — by pidfile AND by port scan."""
    my_pid = os.getpid()

    pids_to_kill = set()

    # Method 1: pidfile
    if os.path.exists(PIDFILE):
        try:
            old_pid = int(open(PIDFILE).read().strip())
            if old_pid != my_pid:
                pids_to_kill.add(old_pid)
        except Exception:
            pass

    # Method 2: find any process listening on our ports (catches orphans pidfile missed)
    if sys.platform == "win32":
        try:
            out = subprocess.check_output(
                ["netstat", "-ano"], text=True, timeout=5,
                creationflags=0x08000000,  # CREATE_NO_WINDOW
            )
            for line in out.splitlines():
                for port in (PORT, HTTP_PORT):
                    if f":{port}" in line and "LISTENING" in line:
                        parts = line.split()
                        try:
                            pid = int(parts[-1])
                            if pid != my_pid and pid > 0:
                                pids_to_kill.add(pid)
                        except (ValueError, IndexError):
                            pass
        except Exception as e:
            log.debug("port scan failed: %s", e)

    for pid in pids_to_kill:
        try:
            import psutil
            proc = psutil.Process(pid)
            if "python" in proc.name().lower():
                log.warning("killing stale whisper instance PID %d", pid)
                proc.kill()
                proc.wait(timeout=10)
        except ImportError:
            import ctypes
            try:
                PROCESS_TERMINATE = 1
                handle = ctypes.windll.kernel32.OpenProcess(PROCESS_TERMINATE, False, pid)
                if handle:
                    ctypes.windll.kernel32.TerminateProcess(handle, 1)
                    ctypes.windll.kernel32.CloseHandle(handle)
                    log.warning("killed stale PID %d via kernel32", pid)
            except Exception:
                pass
        except Exception as e:
            log.debug("stale pid cleanup for %d: %s", pid, e)

    if pids_to_kill:
        time.sleep(1)


def _write_pidfile():
    with open(PIDFILE, "w") as f:
        f.write(str(os.getpid()))


def _remove_pidfile():
    try:
        os.unlink(PIDFILE)
    except Exception:
        pass
SAMPLE_RATE = 16000
# Trigger transcription every N seconds of buffered audio.
TRIGGER_INTERVAL_SEC = 2.0
# Keep this many seconds of trailing audio in the rolling buffer after commit.
ROLLING_CONTEXT_SEC = 10.0
# When a stable prefix survives this many consecutive passes, commit it as "final".
STABLE_PASSES_TO_COMMIT = 2


# =====================================================================
# DETTATURA MISTA IT/EN (2026-08-22)
# Chi detta parla italiano con dentro termini inglesi di dominio. La lingua NON va
# mai forzata (language resta auto): l'initial_prompt non forza una lingua, dà
# solo al decoder un contesto in cui italiano e inglese tecnico convivono e in
# cui i nomi propri ricorrenti esistono già.
# Misurato su 9 min di parlato reale (3 slice da 180s), punteggio = termini di
# dominio corretti meno storpiature:
#   small  senza prompt (config live oggi)  -16
#   small  con prompt                        -8
#   medium senza prompt                      +2
#   medium con prompt                        +5
#   large-v3 senza prompt                   +17  ma 3067MB di picco (sopra il
#                                                guardiano 3G) e 0.74x realtime
# Le parole ricorrenti le sceglie chi usa l'app: «dictationWords» del file delle
# squadre (~/.151machine/squadre.json, o env MACHINE_SQUADRE; vedi
# server/squadre.js). File assente o rotto = nessuna parola (fail-open).
# =====================================================================
def _dictation_words() -> str:
    p = os.environ.get("MACHINE_SQUADRE") or os.path.join(
        os.path.expanduser("~"), ".151machine", "squadre.json")
    try:
        with open(p, encoding="utf-8") as f:
            d = json.load(f)
        w = d.get("dictationWords") if isinstance(d, dict) else None
        return w.strip()[:2000] if isinstance(w, str) else ""
    except Exception:
        return ""


_DICTATION_WORDS = _dictation_words()
DICTATION_PROMPT = os.environ.get("WHISPER_PROMPT") or (
    "Sto dettando appunti di lavoro in italiano, con dentro parole inglesi tecniche."
    + (" Termini ricorrenti: " + _DICTATION_WORDS + "." if _DICTATION_WORDS else "")
)
# SPENTO di default, e il motivo è misurato, non teorico: l'initial_prompt alza
# sì i termini di dominio, ma sbilancia la PRIMA finestra di decodifica e si
# mangia l'inizio del clip — su slice_240 il testo è passato da 2054 a 1668
# caratteri, e "due livello d'altezza esatto così hai una larghezza" è diventato
# "C'è una larghezza". Perdere le prime parole di una dettatura è peggio del
# guadagno. In più è il prompt a far comparire il boilerplate "Sottotitoli
# creati dalla comunità Amara.org" sulla coda di silenzio.
# Resta a un flag di distanza: WHISPER_USE_PROMPT=1.
USE_PROMPT = os.environ.get("WHISPER_USE_PROMPT", "0") == "1"

# Whisper, su coda di silenzio, sputa boilerplate da sottotitoli che NON è mai
# stato detto ("Sottotitoli creati dalla comunità Amara.org", "Iscriviti al
# canale"...). È esattamente la categoria "cose mai dette" segnalata dal proprietario.
# Verificato: nessun parametro di faster-whisper lo elimina
# (hallucination_silence_threshold, no_speech_threshold, log_prob_threshold
# testati tutti -> allucinazione ancora presente). Si toglie a valle, che è
# deterministico e a costo zero.
_BOILERPLATE_PATTERNS = [
    # la coda opzionale \.(org|com|…) serve perché il boilerplate finisce spesso
    # in un dominio ("…comunità Amara.org") e il punto chiuderebbe il match prima.
    r"sottotitoli\s+(?:e\s+revisione\s+)?(?:creati|a\s+cura)\b[^!?\n]*?(?:\.(?:org|com|net|it)\b|(?=[.!?\n])|$)",
    r"sottotitoli\s+e\s+revisione\b[^!?\n]*?(?:\.(?:org|com|net|it)\b|(?=[.!?\n])|$)",
    r"amara\.org[^.!?\n]*",
    r"iscriviti\s+al\s+canale[^.!?\n]*",
    r"grazie\s+per\s+(?:aver\s+guardato|la\s+visione)[^.!?\n]*",
    r"sottotitoli\s+di\s+[^.!?\n]*",
    r"www\.[a-z0-9.-]+\.(?:org|com|it)\b",
    r"thanks?\s+for\s+watching[^.!?\n]*",
    r"subtitles?\s+by\s+[^.!?\n]*",
    r"please\s+subscribe[^.!?\n]*",
]
_BOILERPLATE_RE = re.compile("|".join(_BOILERPLATE_PATTERNS), re.IGNORECASE)


def scrub_hallucinations(text: str):
    """Toglie il boilerplate da sottotitoli. Ritorna (testo_pulito, n_tolti)."""
    if not text:
        return text, 0
    cleaned, n = _BOILERPLATE_RE.subn("", text)
    if n:
        cleaned = re.sub(r"\s{2,}", " ", cleaned)
        cleaned = re.sub(r"(?:\s*[.,;:!?]\s*)+$", "", cleaned).strip()
    return cleaned.strip(), n


# =====================================================================
# Model loader with CUDA -> CPU fallback
# =====================================================================
def load_model():
    from faster_whisper import WhisperModel

    # Linux PC-peer (EndeavourOS): no ctranslate2-CUDA stack, so skip the cuda
    # attempts entirely (they would each download a multi-GB model just to fail).
    # WHISPER_FORCE_CPU=1 -> load WHISPER_MODEL (default "base") on CPU directly.
    if os.environ.get("WHISPER_FORCE_CPU") == "1":
        name = os.environ.get("WHISPER_MODEL", "base")
        log.info("WHISPER_FORCE_CPU set — loading %s / int8 on CPU", name)
        m = WhisperModel(name, device="cpu", compute_type="int8")
        # WARM-UP PASS (2026-07-17): run one throwaway inference at startup so the
        # CTranslate2 pipeline (thread pool, weight paging, first-run allocations)
        # is initialised BEFORE the first real dictation. Without this the very
        # first transcription after a (re)start is markedly slower — the "cold"
        # case attempt-1 used to lose. The CUDA branch below already warms up; the
        # CPU branch (the one this box actually uses) never did.
        try:
            t0 = time.time()
            _ = list(m.transcribe(np.zeros(SAMPLE_RATE, dtype=np.float32),
                                  language="en", task="transcribe")[0])
            log.info("CPU model warmed up (%s/int8) in %.1fs", name, time.time() - t0)
        except Exception as e:
            log.warning("CPU warm-up pass failed (non-fatal): %s", e)
        log.info("CPU model ready (%s/int8)", name)
        return m, name, "cpu"

    # Try medium first (better at mixed-language EN/IT), fall back to small, then CPU base.
    try:
        log.info("Attempting CUDA load: medium / float16 (~3GB VRAM)")
        m = WhisperModel("medium", device="cuda", compute_type="float16")
        _ = list(m.transcribe(np.zeros(SAMPLE_RATE, dtype=np.float32), language="en", task="transcribe")[0])
        log.info("CUDA model ready (medium/float16)")
        return m, "medium", "cuda"
    except Exception as e_med:
        log.warning("CUDA medium load failed (%s) — trying small", e_med)
        try:
            m = WhisperModel("small", device="cuda", compute_type="float16")
            _ = list(m.transcribe(np.zeros(SAMPLE_RATE, dtype=np.float32), language="en", task="transcribe")[0])
            log.info("CUDA model ready (small/float16)")
            return m, "small", "cuda"
        except Exception as e:
            log.error("=" * 60)
            log.error("CUDA LOAD FAILED — falling back to CPU. Reason: %s", e)
            log.error("=" * 60)
            m = WhisperModel("base", device="cpu", compute_type="int8")
            log.info("CPU model ready (base/int8)")
            return m, "base", "cpu"


MODEL = None
MODEL_NAME = None
MODEL_DEVICE = None

# Shutdown signalling
SHUTDOWN_EVENT: Optional[asyncio.Event] = None
CONNECTED_WS: "Set[WebSocketServerProtocol]" = set()


# =====================================================================
# Audio decoding
# =====================================================================
def decode_container_to_pcm(blob: bytes, fmt_hint: str = "") -> np.ndarray:
    """Decode any audio container (webm/opus, aac/adts, m4a/mp4, ogg) to 16k mono float32.

    Strategy: write to a temp file (so ffmpeg can seek, required for mp4/m4a moov atom)
    and invoke ffmpeg with an explicit demuxer hint when we have one (aac/webm/ogg).
    This is far more reliable than piping via stdin, especially for AAC ADTS produced
    by Capacitor VoiceRecorder on Android."""
    if not blob:
        return np.zeros(0, dtype=np.float32)

    # Pick an extension/demuxer hint.
    fmt = (fmt_hint or "").lower()
    if fmt in ("aac",):
        suffix = ".aac"; demuxer = "aac"
    elif fmt in ("m4a", "mp4"):
        suffix = ".m4a"; demuxer = None  # let ffmpeg autodetect mp4
    elif fmt in ("ogg",):
        suffix = ".ogg"; demuxer = "ogg"
    elif fmt in ("webm",):
        suffix = ".webm"; demuxer = "webm"
    else:
        # Sniff: ADTS sync word 0xFFF?, EBML (webm) 0x1A45DFA3, OggS, or ftyp (mp4).
        head = blob[:16]
        if len(head) >= 4 and head[:4] == b"OggS":
            suffix = ".ogg"; demuxer = "ogg"
        elif len(head) >= 4 and head[0] == 0x1A and head[1] == 0x45 and head[2] == 0xDF and head[3] == 0xA3:
            suffix = ".webm"; demuxer = "webm"
        elif len(head) >= 8 and head[4:8] == b"ftyp":
            suffix = ".m4a"; demuxer = None
        elif len(head) >= 2 and head[0] == 0xFF and (head[1] & 0xF0) == 0xF0:
            suffix = ".aac"; demuxer = "aac"
        else:
            suffix = ".bin"; demuxer = None

    tmp_path = None
    try:
        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as f:
            f.write(blob)
            tmp_path = f.name

        cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error"]
        if demuxer:
            cmd += ["-f", demuxer]
        cmd += [
            "-i", tmp_path,
            "-ac", "1", "-ar", str(SAMPLE_RATE),
            "-f", "s16le", "pipe:1",
        ]
        proc = subprocess.run(cmd, capture_output=True, timeout=30)
        if proc.returncode != 0:
            log.warning("ffmpeg decode rc=%s fmt_hint=%s suffix=%s err=%s",
                        proc.returncode, fmt_hint, suffix, proc.stderr[:300])
            # Retry with pure autodetect (no -f) as last resort.
            if demuxer:
                cmd2 = ["ffmpeg", "-hide_banner", "-loglevel", "error",
                        "-i", tmp_path,
                        "-ac", "1", "-ar", str(SAMPLE_RATE),
                        "-f", "s16le", "pipe:1"]
                proc2 = subprocess.run(cmd2, capture_output=True, timeout=30)
                if proc2.returncode == 0:
                    pcm = np.frombuffer(proc2.stdout, dtype=np.int16).astype(np.float32) / 32768.0
                    log.info("ffmpeg autodetect fallback decoded %d samples", pcm.shape[0])
                    return pcm
                log.warning("ffmpeg autodetect fallback rc=%s err=%s",
                            proc2.returncode, proc2.stderr[:300])
            return np.zeros(0, dtype=np.float32)
        pcm = np.frombuffer(proc.stdout, dtype=np.int16).astype(np.float32) / 32768.0
        return pcm
    except Exception as e:
        log.warning("ffmpeg decode error: %s", e)
        return np.zeros(0, dtype=np.float32)
    finally:
        if tmp_path:
            try: os.unlink(tmp_path)
            except Exception: pass


# Back-compat shim
def decode_webm_to_pcm(webm_bytes: bytes) -> np.ndarray:
    return decode_container_to_pcm(webm_bytes, "")


def pcm16_bytes_to_float32(buf: bytes) -> np.ndarray:
    if not buf:
        return np.zeros(0, dtype=np.float32)
    return np.frombuffer(buf, dtype=np.int16).astype(np.float32) / 32768.0


# =====================================================================
# Per-connection session
# =====================================================================
class DictationSession:
    def __init__(self, session_id: str, language: str, fmt: str):
        self.session_id = session_id
        self.language = None if language == "auto" else language
        self.fmt = fmt  # "webm" or "pcm16"
        self.raw_chunks: list[bytes] = []  # accumulated container/pcm bytes (webm reassembled fully each pass)
        self.audio_f32: np.ndarray = np.zeros(0, dtype=np.float32)  # working buffer for whisper
        self.committed_text: str = ""
        self.last_partial_text: str = ""
        self.stable_candidate: str = ""
        self.stable_passes: int = 0
        self.last_trigger_ts: float = 0.0
        self.total_samples_committed: int = 0
        self.last_pass_samples: int = -1  # audio length at last completed pass
        self.last_pass_text: str = ""
        self.lock = asyncio.Lock()

    def append_audio(self, data: bytes):
        self.raw_chunks.append(data)

    def rebuild_audio(self):
        """Rebuild the float32 working buffer from raw chunks."""
        if self.fmt == "pcm16":
            joined = b"".join(self.raw_chunks)
            self.audio_f32 = pcm16_bytes_to_float32(joined)
        else:
            # container: must decode the whole accumulated blob each pass to stay valid.
            joined = b"".join(self.raw_chunks)
            self.audio_f32 = decode_container_to_pcm(joined, self.fmt)

    def trim_rolling(self):
        """Drop committed audio older than ROLLING_CONTEXT_SEC to bound memory."""
        if self.fmt != "pcm16":
            # webm: can't trim mid-stream without corrupting container; rebuild will handle eventually.
            return
        keep_samples = int(ROLLING_CONTEXT_SEC * SAMPLE_RATE)
        if self.audio_f32.shape[0] > keep_samples + self.total_samples_committed:
            # Only trim raw_chunks if we have excess; implemented lazily — skip for v1.
            pass


async def transcribe(session: DictationSession) -> tuple[str, Optional[str]]:
    """Run whisper on the current buffer. Returns (full_text, detected_language)."""
    if session.audio_f32.shape[0] < SAMPLE_RATE // 2:
        return "", None
    loop = asyncio.get_event_loop()

    def _run():
        # task="transcribe" (explicit): keep original language per segment, never translate.
        # language=None when "auto": let whisper detect per input; avoids forcing IT on EN speech.
        # condition_on_previous_text=False: prevents prior-text bias locking into one language
        # (critical for EN/IT code-switching — otherwise model sticks to whatever it saw first).
        segments, info = MODEL.transcribe(
            session.audio_f32,
            language=session.language,
            task="transcribe",
            vad_filter=True,
            vad_parameters=dict(min_silence_duration_ms=500),
            condition_on_previous_text=False,
            beam_size=5,
        )
        text = "".join(seg.text for seg in segments).strip()
        return text, info.language

    return await loop.run_in_executor(None, _run)


async def handler(ws: WebSocketServerProtocol):
    session: Optional[DictationSession] = None
    peer = ws.remote_address
    log.info("conn open from %s", peer)
    CONNECTED_WS.add(ws)
    try:
        async for msg in ws:
            if isinstance(msg, (bytes, bytearray)):
                if session is None:
                    continue  # audio before start — drop silently
                session.append_audio(bytes(msg))
                now = time.monotonic()
                if now - session.last_trigger_ts >= TRIGGER_INTERVAL_SEC:
                    session.last_trigger_ts = now
                    asyncio.create_task(run_pass(ws, session, final=False))
                continue

            # Text frame — JSON control
            try:
                obj = json.loads(msg)
            except Exception:
                continue
            t = obj.get("type")

            if t == "start":
                language = obj.get("language", "auto") or "auto"
                fmt = obj.get("format", "webm")
                if fmt not in ("webm", "pcm16", "aac", "m4a", "mp4", "ogg"):
                    fmt = "webm"
                session = DictationSession(
                    session_id=str(obj.get("sessionId", "unknown")),
                    language=language,
                    fmt=fmt,
                )
                log.info("start sid=%s lang=%s fmt=%s", session.session_id, language, fmt)
                await ws.send(json.dumps({"type": "ready"}))

            elif t == "stop":
                if session is not None:
                    await run_pass(ws, session, final=True)
                break

            else:
                # Unknown control — ignore
                pass
    except websockets.ConnectionClosed:
        pass
    except Exception as e:
        log.exception("handler error: %s", e)
        try:
            await ws.send(json.dumps({"type": "error", "message": str(e)}))
        except Exception:
            pass
    finally:
        CONNECTED_WS.discard(ws)
        log.info("conn close from %s", peer)


async def run_pass(ws: WebSocketServerProtocol, session: DictationSession, final: bool):
    if session.lock.locked() and not final:
        # A pass is already running and this is just a partial trigger — skip.
        return
    # For final passes we always wait for the lock so the final result is guaranteed.
    async with session.lock:
        session.rebuild_audio()
        cur_samples = session.audio_f32.shape[0]
        if final:
            log.info("DIAG final-pass sid=%s samples=%d (%.1fs) fmt=%s",
                     session.session_id, cur_samples, cur_samples / float(SAMPLE_RATE), session.fmt)
        # Dedupe: if audio hasn't grown since last pass, reuse that text.
        # Saves a full whisper re-run on the native single-blob path where a
        # partial just transcribed the entire audio and the final arrives on
        # the same buffer. Critical for long (>20s) recordings.
        if cur_samples == session.last_pass_samples and session.last_pass_samples >= 0:
            if final:
                log.info("DIAG final-text(dedupe) sid=%s textlen=%d text=%r",
                         session.session_id, len(session.last_pass_text or ""), (session.last_pass_text or "")[:60])
                try:
                    await ws.send(json.dumps({
                        "type": "final",
                        "text": session.last_pass_text,
                        "isFinal": True,
                    }))
                except Exception:
                    pass
            return
        try:
            text, _lang = await transcribe(session)
        except Exception as e:
            log.warning("transcribe error: %s", e)
            try:
                await ws.send(json.dumps({"type": "error", "message": f"transcribe: {e}"}))
            except Exception:
                pass
            return

        session.last_pass_samples = cur_samples
        session.last_pass_text = text

        if not text and not final:
            return

        if final:
            log.info("DIAG final-text sid=%s textlen=%d text=%r",
                     session.session_id, len(text or ""), (text or "")[:60])
            payload = {"type": "final", "text": text, "isFinal": True}
            try:
                await ws.send(json.dumps(payload))
            except Exception:
                pass
            return

        # Stability heuristic: if text starts-with the previous candidate and grew, bump counter.
        if text and session.stable_candidate and text.startswith(session.stable_candidate):
            session.stable_passes += 1
        else:
            session.stable_passes = 1
            session.stable_candidate = text

        # Emit partial every pass
        if text != session.last_partial_text:
            session.last_partial_text = text
            try:
                await ws.send(json.dumps({"type": "partial", "text": text, "isFinal": False}))
            except Exception:
                pass


def _make_reusable_socket(host: str, port: int) -> socket.socket:
    """Bind a TCP socket for the WS server.

    On Windows: do NOT use SO_REUSEADDR (it allows multiple processes to bind
    the same port, causing random connection routing). Instead, we rely on
    _kill_stale_instance() to free the port before we bind.
    On Linux: use SO_REUSEADDR as normal for fast restart after TIME_WAIT."""
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    if sys.platform != "win32":
        try:
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        except Exception as e:
            log.warning("SO_REUSEADDR set failed: %s", e)
    s.bind((host, port))
    s.setblocking(False)
    return s


async def _graceful_shutdown(server):
    log.info("shutdown: closing server + %d clients", len(CONNECTED_WS))
    # Stop accepting new connections
    try:
        server.close()
    except Exception:
        pass
    # Close all currently connected clients (code 1001 = going away)
    closers = []
    for ws in list(CONNECTED_WS):
        try:
            closers.append(asyncio.create_task(ws.close(code=1001, reason="server shutdown")))
        except Exception:
            pass
    if closers:
        try:
            await asyncio.wait(closers, timeout=2.0)
        except Exception:
            pass
    try:
        await asyncio.wait_for(server.wait_closed(), timeout=5.0)
    except Exception as e:
        log.warning("wait_closed timed out: %s", e)
    log.info("shutdown complete")


# =====================================================================
# One-shot HTTP transcription endpoint (for attachments)
# =====================================================================
# 3172 default kept for Windows; on the Linux PC-peer the session-host daemon
# squats 127.0.0.1:3172 (SESSION_HOST_FORCE_TCP), so WHISPER_HTTP_PORT=3173.
HTTP_PORT = int(os.environ.get("WHISPER_HTTP_PORT", "3172"))


async def http_transcribe(request: web.Request) -> web.Response:
    """POST /transcribe — multipart field "file" (audio or wav). Returns {text, language}.

    Used by the 151 Machine server to auto-transcribe attachment uploads. Synchronous
    from the caller's perspective: blob in, transcript out.
    """
    try:
        reader = await request.multipart()
        blob = b""
        fname = ""
        language = request.query.get("language", "auto") or "auto"
        while True:
            part = await reader.next()
            if part is None:
                break
            if part.name == "file":
                fname = part.filename or ""
                while True:
                    chunk = await part.read_chunk(1 << 20)
                    if not chunk:
                        break
                    blob += chunk
            elif part.name == "language":
                language = (await part.text()).strip() or "auto"
        if not blob:
            return web.json_response({"error": "no file"}, status=400)

        log.info("[http] /transcribe file=%s bytes=%d lang=%s", fname, len(blob), language)
        # Decode via ffmpeg (handles wav/mp3/m4a/webm/ogg/aac via autodetect).
        pcm = decode_container_to_pcm(blob, "")
        if pcm.shape[0] < SAMPLE_RATE // 4:
            return web.json_response({"text": "", "language": None, "warning": "audio too short"})

        lang_arg = None if language == "auto" else language
        loop = asyncio.get_event_loop()

        # Live dictation now flows through this HTTP endpoint. beam_size=1 was a
        # speed shortcut for background attachment transcription, but it's less
        # accurate on IT / EN-IT code-switching than the live WS path (beam 5).
        # Keep parity with the WS path so moving dictation here doesn't regress
        # accuracy; env-tunable if speed ever needs to win.
        http_beam = int(os.environ.get("WHISPER_HTTP_BEAM", "5"))

        def _run():
            segments, info = MODEL.transcribe(
                pcm,
                language=lang_arg,          # None = auto: la lingua NON si forza mai
                task="transcribe",
                vad_filter=True,
                vad_parameters=dict(min_silence_duration_ms=500),
                condition_on_previous_text=False,
                beam_size=http_beam,
                initial_prompt=DICTATION_PROMPT if USE_PROMPT else None,
            )
            text = "".join(seg.text for seg in segments).strip()
            text, scrubbed = scrub_hallucinations(text)
            return text, info.language, scrubbed

        text, detected, scrubbed = await loop.run_in_executor(None, _run)
        log.info("[http] /transcribe done len=%d lang=%s prompt=%s scrubbed=%d",
                 len(text), detected, USE_PROMPT, scrubbed)
        return web.json_response({"text": text, "language": detected})
    except Exception as e:
        log.exception("/transcribe error: %s", e)
        return web.json_response({"error": str(e)}, status=500)


async def start_http_server() -> web.AppRunner:
    app = web.Application(client_max_size=200 * 1024 * 1024)
    app.router.add_post("/transcribe", http_transcribe)
    app.router.add_get("/health", lambda r: web.json_response({"ok": True, "model": MODEL_NAME, "device": MODEL_DEVICE}))
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, HOST, HTTP_PORT)
    await site.start()
    log.info("http one-shot endpoint ready on %s:%d", HOST, HTTP_PORT)
    return runner


async def main():
    global MODEL, MODEL_NAME, MODEL_DEVICE, SHUTDOWN_EVENT
    _kill_stale_instance()
    _write_pidfile()
    MODEL, MODEL_NAME, MODEL_DEVICE = load_model()

    SHUTDOWN_EVENT = asyncio.Event()
    loop = asyncio.get_running_loop()

    def _request_shutdown(signame: str):
        log.info("received %s — requesting shutdown", signame)
        if SHUTDOWN_EVENT and not SHUTDOWN_EVENT.is_set():
            SHUTDOWN_EVENT.set()

    # SIGINT/SIGTERM handlers. On Windows add_signal_handler is unsupported
    # for the asyncio loop, so fall back to signal.signal() there.
    if sys.platform == "win32":
        for sig in (signal.SIGINT, signal.SIGTERM, getattr(signal, "SIGBREAK", signal.SIGINT)):
            try:
                signal.signal(sig, lambda s, f: loop.call_soon_threadsafe(_request_shutdown, str(s)))
            except Exception as e:
                log.warning("signal(%s) install failed: %s", sig, e)
    else:
        for sig in (signal.SIGINT, signal.SIGTERM):
            try:
                loop.add_signal_handler(sig, _request_shutdown, sig.name)
            except Exception as e:
                log.warning("add_signal_handler(%s) failed: %s", sig, e)

    log.info("binding loopback %s:%d (SO_REUSEADDR)", HOST, PORT)
    sock = _make_reusable_socket(HOST, PORT)

    http_runner = None
    try:
        http_runner = await start_http_server()
    except Exception as e:
        log.warning("http server start failed: %s", e)

    async with websockets.serve(
        handler,
        sock=sock,
        max_size=100 * 1024 * 1024,
        ping_interval=20,
        ping_timeout=120,
    ) as server:
        log.info("whisper-stt ready (model=%s device=%s)", MODEL_NAME, MODEL_DEVICE)
        await SHUTDOWN_EVENT.wait()
        await _graceful_shutdown(server)
        if http_runner is not None:
            try:
                await http_runner.cleanup()
            except Exception:
                pass


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        log.info("interrupted — exiting")
    finally:
        _remove_pidfile()
