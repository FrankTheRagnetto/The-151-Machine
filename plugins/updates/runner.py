#!/usr/bin/env python3
"""The 151 Machine — Updates runner.

Lancia UN comando (quello che costruisce plugins/updates/server.js, mai testo
del client) dentro un terminale finto, staccato dal server: un riavvio della
Machine non può interrompere pacman a metà (--daemon: doppio fork, il runner
passa a init e pm2, che uccide l'albero dei figli del server, non lo trova).

  runner.py [--daemon] [--max-seconds N] --dir <cartella> --id <32 hex> --nonce <hex> -- <comando...>

Lo usa anche plugins/backup/server.js (il disco dell'intrattenimento): stessa
password chiesta al proprietario, stesso terminale staccato, tetto di tempo più lungo.

Nella cartella (700, mai un collegamento, di questo utente) scrive, tutti 600:
  run-<id>.log   quello che il comando stampa (MAI quello che scrive il proprietario)
  run-<id>.ask   la domanda che aspetta il proprietario: JSON {kind, line, ctx}
  run-<id>.pid   il pid del runner mentre gira
  run-<id>.json  alla fine: {exit, ended}
e legge le risposte da run-<id>.in (FIFO), una per riga.

Risponde da solo SOLO a domande di routine (AUTO). Non risponde mai alla
password, alla scelta fra più pacchetti, a «togliere un pacchetto?» né a
domande che non conosce: quelle vanno in .ask e aspettano il proprietario (/hack 16/10).
La password si scrive al terminale solo se la chiede il NOSTRO sudo (il prompt
porta il nonce di questo giro) e solo se il terminale non fa eco: un prompt
finto stampato da una build non la riceve, e non finisce mai nel log.
Prova: tests/updates-runner.test.js
"""
import argparse
import errno
import json
import os
import pty
import re
import select
import signal
import stat
import sys
import termios
import time

MAX_SECONDS = 3 * 3600          # tetto di sicurezza: dopo 3 ore si ferma
QUIET_S = 0.35                  # una domanda si guarda quando l'output tace

# Regex ancorate sull'ultima riga ancora aperta (senza a-capo). Solo routine.
AUTO = [
    (re.compile(r'^:: Proceed with installation\?\s*\[Y/n\]\s*$', re.I), 'y'),
    (re.compile(r'^:: Replace \S+ with \S+\?\s*\[Y/n\]\s*$', re.I), 'y'),
    (re.compile(r'^:: Import\??\s*\[Y/n\]\s*$', re.I), 'y'),                     # chiavi PGP dell'AUR
    (re.compile(r'^Do you want to proceed with these changes.*\[Y/n\]:?\s*$', re.I), 'y'),  # flatpak
]
EXCLUDE = re.compile(r'Packages to exclude', re.I)    # yay: poi la riga è solo «==> »
YAY_PROMPT = re.compile(r'^==>\s*$')
CHOICE = re.compile(r'Enter a number \(default=\d+\):\s*$', re.I)
YESNO = re.compile(r'\[[yY]/[nN]\]:?\s*$')

ANSI = re.compile(r'\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[()][0-9A-B]|\x1b[=>]')
CTRL = re.compile(r'[\x00-\x1f\x7f]')


def cartella_sicura(d):
    os.makedirs(d, mode=0o700, exist_ok=True)
    st = os.lstat(d)
    if not stat.S_ISDIR(st.st_mode) or st.st_uid != os.getuid():
        raise SystemExit('runner: %s non è una cartella mia' % d)
    os.chmod(d, 0o700)


def apri(path, flags, mode=0o600):
    return os.open(path, flags | os.O_NOFOLLOW, mode)


def scrivi_json(path, obj):
    tmp = '%s.%d.tmp' % (path, os.getpid())
    fd = apri(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC)
    with os.fdopen(fd, 'w') as f:
        json.dump(obj, f)
    os.replace(tmp, path)


def togli(path):
    try:
        os.unlink(path)
    except FileNotFoundError:
        pass


def ultima_riga(tail):
    t = ANSI.sub('', tail).replace('\r\n', '\n')
    return t.split('\n')[-1].split('\r')[-1]


def contesto(tail, n=14):
    t = ANSI.sub('', tail).replace('\r\n', '\n')
    return '\n'.join(r.split('\r')[-1] for r in t.split('\n')[-n:])


def eco_spenta(fd):
    try:
        return not (termios.tcgetattr(fd)[3] & termios.ECHO)
    except termios.error:
        return False


def risposta_valida(kind, text):
    if CTRL.search(text) or len(text) > 256:
        return False
    if kind == 'yesno':
        return text in ('y', 'n', 'Y', 'N')
    if kind == 'choice':
        return re.fullmatch(r'\d{1,3}', text) is not None
    if kind == 'text':
        return True
    return kind == 'password' and len(text) > 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--dir', required=True)
    ap.add_argument('--id', required=True)
    ap.add_argument('--nonce', required=True)
    ap.add_argument('--daemon', action='store_true')
    ap.add_argument('--max-seconds', type=int, default=MAX_SECONDS)
    ap.add_argument('cmd', nargs=argparse.REMAINDER)
    a = ap.parse_args()
    cmd = a.cmd[1:] if a.cmd and a.cmd[0] == '--' else a.cmd
    if not cmd or not re.fullmatch(r'[a-f0-9]{32}', a.id) or not re.fullmatch(r'[a-f0-9]{16,64}', a.nonce):
        print('runner: argomenti non validi', file=sys.stderr)
        return 2

    cartella_sicura(a.dir)
    base = os.path.join(a.dir, 'run-' + a.id)
    log_p, ask_p, end_p, in_p, pid_p = (base + e for e in ('.log', '.ask', '.json', '.in', '.pid'))
    # Il prompt del NOSTRO sudo (server.js gli passa «-p 151sudo-<nonce>:»).
    pw_prompt = re.compile(r'^151sudo-%s:\s*$' % re.escape(a.nonce))

    if a.daemon:
        if os.fork() > 0:
            os._exit(0)
        os.setsid()
        if os.fork() > 0:
            os._exit(0)
        nul = os.open(os.devnull, os.O_RDWR)
        for f in (0, 1, 2):
            os.dup2(nul, f)

    with os.fdopen(apri(pid_p, os.O_WRONLY | os.O_CREAT | os.O_TRUNC), 'w') as f:
        f.write(str(os.getpid()))
    if not os.path.exists(in_p):
        os.mkfifo(in_p, 0o600)
    st = os.lstat(in_p)
    if not stat.S_ISFIFO(st.st_mode) or st.st_uid != os.getuid():
        raise SystemExit('runner: la FIFO non è mia')
    # O_RDWR: la FIFO non arriva mai a «fine» quando il server chiude la sua parte.
    fifo = apri(in_p, os.O_RDWR | os.O_NONBLOCK)

    # Ambiente pulito (/hack): niente LD_*, PATH fisso, niente shell di login.
    home = os.path.expanduser('~')
    env = {
        'HOME': home, 'USER': os.environ.get('USER', ''), 'LOGNAME': os.environ.get('LOGNAME', ''),
        'PATH': '/usr/bin:/bin:%s/.local/bin' % home,
        'LC_ALL': 'C.UTF-8', 'LANG': 'C.UTF-8', 'TERM': 'dumb', 'COLUMNS': '120',
        'XDG_RUNTIME_DIR': os.environ.get('XDG_RUNTIME_DIR', '/run/user/%d' % os.getuid()),
    }
    pid, fd = pty.fork()
    if pid == 0:
        try:
            os.chdir(home)
            os.execve(cmd[0], cmd, env)
        except Exception as e:  # noqa: BLE001
            os.write(2, ('runner: could not start: %s\n' % e).encode())
            os._exit(127)

    log = apri(log_p, os.O_WRONLY | os.O_CREAT | os.O_APPEND)
    tail = ''
    last_out = time.time()
    answered_at = -1
    total = 0
    asking = None
    started = time.time()
    in_buf = b''

    def scrivi_log(testo):
        os.write(log, testo.encode())

    def chiedi(kind, riga):
        nonlocal asking
        asking = kind
        scrivi_json(ask_p, {'kind': kind, 'line': riga.strip(), 'ctx': contesto(tail)})

    def chiudi_domanda():
        nonlocal asking
        asking = None
        togli(ask_p)

    while True:
        if time.time() - started > a.max_seconds:
            try:
                os.killpg(pid, signal.SIGTERM)
            except OSError:
                pass
        try:
            r, _, _ = select.select([fd, fifo], [], [], 0.1)
        except InterruptedError:
            continue
        if fd in r:
            try:
                data = os.read(fd, 65536)
            except OSError as e:
                if e.errno != errno.EIO:
                    raise
                data = b''
            if not data:
                break
            os.write(log, data)
            total += len(data)
            tail = (tail + data.decode('utf-8', 'replace'))[-6000:]
            last_out = time.time()
            if asking:
                chiudi_domanda()
        if fifo in r:
            try:
                in_buf += os.read(fifo, 4096)
            except BlockingIOError:
                pass
            while b'\n' in in_buf:
                riga, in_buf = in_buf.split(b'\n', 1)
                testo = riga.decode('utf-8', 'replace')
                if not asking or not risposta_valida(asking, testo):
                    scrivi_log('\n[151] answer refused: no matching question\n')
                    continue
                if asking == 'password' and not eco_spenta(fd):
                    scrivi_log('\n[151] password refused: the terminal would show it\n')
                    continue
                os.write(fd, riga + b'\n')        # al terminale, mai nel log
                answered_at = total
                chiudi_domanda()
        if total != answered_at and time.time() - last_out > QUIET_S and not asking:
            riga = ultima_riga(tail)
            fatto = False
            for rx, risposta in AUTO:
                if rx.search(riga):
                    scrivi_log('\n[151 auto-answer: %s]\n' % risposta)
                    os.write(fd, (risposta + '\n').encode())
                    fatto = True
                    break
            if not fatto and YAY_PROMPT.match(riga) and EXCLUDE.search(contesto(tail, 4)):
                scrivi_log('\n[151 auto-answer: none excluded]\n')
                os.write(fd, b'\n')
                fatto = True
            if not fatto:
                if pw_prompt.match(riga):
                    chiedi('password', 'Password of the PC')
                elif CHOICE.search(riga):
                    chiedi('choice', riga)
                elif YESNO.search(riga):
                    chiedi('yesno', riga)
                elif YAY_PROMPT.match(riga):
                    chiedi('text', riga)
            answered_at = total

    _, status = os.waitpid(pid, 0)
    togli(ask_p)
    os.close(log)
    scrivi_json(end_p, {'exit': os.waitstatus_to_exitcode(status), 'ended': time.time()})
    try:
        os.close(fifo)
    except OSError:
        pass
    togli(in_p)
    togli(pid_p)
    return 0


if __name__ == '__main__':
    sys.exit(main())
