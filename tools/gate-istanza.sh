#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# L'ISTANZA USA-E-GETTA DEL CANCELLO — prova il WORKING TREE, non il processo vivo
# (P4 del verdetto C6. Strada scelta il 12/09/2026: la
#  stessa medicina del «libretto di nascita» scelta per i portali la mattina.)
#
# IL GUASTO CHE CHIUDE
# Fino a oggi i passi 2/7 e 3/7 bussavano a http://127.0.0.1:3170 — la Machine
# VIVA. Ma il processo vivo ha caricato il codice server al SUO avvio
# (serverHash in /api/health), e riavviare è vietato a tutti tranne
# il proprietario (legge 4). Quindi, ogni volta che il diff toccava codice servito, il
# cancello provava il codice VECCHIO e lo diceva come un avviso al passo 5/7:
# «⚠ lo smoke qui sopra ha provato il codice VECCHIO, non il tuo diff».
# Un cancello che misura la cosa sbagliata e poi se ne scusa non è un cancello.
#
# LA CURA
# Il cancello accende una copia di scarto DEL WORKING TREE, su una porta
# effimera, prova QUELLA, e la uccide. Niente più «provato il codice vecchio»:
# il bersaglio è il diff, sempre, per costruzione.
#
# PERCHÉ UNA COPIA IN /tmp E NON `PORT=x node server/index.js` SUL POSTO
# Perché l'avvio del server NON è innocuo, e questa è la parte che va letta
# prima di toccare questo file:
#   · server/index.js:115 → STORE_PATH = <repo>/server/sessions.json. Avviato
#     sul posto, l'istanza LEGGE le sessioni vive del proprietario e ne RIPRENDE quelle
#     interrotte: `manager.getPendingResumes()` → `manager.sendMessage()` →
#     processi Claude CLI spawnati per davvero (server/index.js:2690+). Una
#     copia in /tmp non ha sessions.json ⇒ zero sessioni ⇒ zero spawn.
#   · restart-intent vive in <repo>/system/ (server/restart-intent.js:50-55) e
#     l'avvio lo CONSUMA (readAndConsumeIntent). Sul posto, l'istanza si
#     mangerebbe il cartello di riavvio che l'interfaccia del proprietario deve mostrare.
#     Nella copia, `system/` è suo.
#   · tutti gli altri depositi (eventi, memoria, cestino, bozze) stanno sotto
#     os.homedir(). os.homedir() guarda $HOME ⇒ basta dare all'istanza una casa
#     finta dentro la copia e non sfiora niente di reale.
# La copia NON è un «modo leggero» del server: è lo STESSO server, lo stesso
# avvio, le stesse rotte. È l'ambiente intorno a lui che è di scarto. Così non
# esiste nessun ramo «if (prova)» dentro server/index.js che possa divergere
# dalla realtà — la lezione del revisore su ogni harness che finge.
#
# L'ISTANZA MUORE SEMPRE (condizione del proprietario, 12/09). Tre rinforzi indipendenti:
#   1. il `trap` di gate.sh su EXIT INT TERM HUP chiama gate_istanza_spegni;
#   2. l'istanza nasce con un `--guardia` che la uccide se il cancello muore di
#      SIGKILL (niente trap può girare, ma la guardia vede il padre sparire);
#   3. la porta è effimera e chiesta al kernel: anche un orfano impossibile non
#      occuperebbe mai la 3170 del proprietario.
#
# Uso (sorgentato da tools/gate.sh):
#   . tools/gate-istanza.sh
#   gate_istanza_accendi   → $GATE_ISTANZA_BASE pronta, 0 = accesa
#   gate_istanza_spegni    → morta e ripulita (idempotente)
# Prova: tests/gate-istanza.test.js
# ─────────────────────────────────────────────────────────────────────────────

GATE_ISTANZA_DIR=""
GATE_ISTANZA_PID=""
GATE_ISTANZA_GUARDIA_PID=""
GATE_ISTANZA_BASE=""
GATE_ISTANZA_PORTA=""
GATE_ISTANZA_LOG=""

# ── una porta libera, chiesta al kernel ──────────────────────────────────────
# Non si «sceglie» una porta alta sperando che sia libera: si fa assegnare la 0
# dal kernel, si legge quale ha dato e si chiude. Resta una finestra di corsa di
# millisecondi, e se qualcuno ci si infila in mezzo l'istanza non parte e il
# cancello va rosso — non prende la porta di nessun altro.
gate_istanza_porta_libera() {
  node -e '
    const net = require("net");
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => process.stdout.write(String(p))); });
  ' 2>/dev/null
}

# ── spegnimento ──────────────────────────────────────────────────────────────
# Idempotente e muto: viene chiamato dal trap, quindi gira anche quando non è
# mai stato accesso niente, e gira DUE volte se il cancello esce dopo averlo
# già chiamato a mano.
gate_istanza_spegni() {
  if [ -n "$GATE_ISTANZA_GUARDIA_PID" ]; then
    kill "$GATE_ISTANZA_GUARDIA_PID" 2>/dev/null || true
    GATE_ISTANZA_GUARDIA_PID=""
  fi
  if [ -n "$GATE_ISTANZA_PID" ]; then
    # SIGTERM: il server ha uno spegnimento gentile (gracefulShutdown) e nella
    # copia non ha niente da salvare, quindi è immediato. Poi SIGKILL se insiste.
    kill -TERM "$GATE_ISTANZA_PID" 2>/dev/null || true
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      kill -0 "$GATE_ISTANZA_PID" 2>/dev/null || break
      sleep 0.2
    done
    kill -KILL "$GATE_ISTANZA_PID" 2>/dev/null || true
    # I figli: il server è il capo del suo gruppo di processi solo se l'abbiamo
    # avviato con setsid, e l'abbiamo fatto — quindi si uccide il GRUPPO, così
    # niente nipote sopravvive al nonno.
    kill -KILL -- "-$GATE_ISTANZA_PID" 2>/dev/null || true
    GATE_ISTANZA_PID=""
  fi
  if [ -n "$GATE_ISTANZA_DIR" ] && [ -d "$GATE_ISTANZA_DIR" ]; then
    # Paranoia prima di un rm -rf: solo dentro /tmp e solo col nostro prefisso.
    case "$GATE_ISTANZA_DIR" in
      /tmp/gate-istanza-*) rm -rf "$GATE_ISTANZA_DIR" ;;
      *) echo "⚠ rifiuto di cancellare «$GATE_ISTANZA_DIR»: non è una copia di scarto" >&2 ;;
    esac
    GATE_ISTANZA_DIR=""
  fi
  GATE_ISTANZA_BASE=""
}

# ── accensione ───────────────────────────────────────────────────────────────
gate_istanza_accendi() {
  local ROOT
  ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || { echo "🛑 non sono in un repo git"; return 1; }

  GATE_ISTANZA_DIR="$(mktemp -d /tmp/gate-istanza-XXXXXXXX)" || { echo "🛑 mktemp -d fallito"; return 1; }
  chmod 700 "$GATE_ISTANZA_DIR"
  GATE_ISTANZA_LOG="$GATE_ISTANZA_DIR/avvio.log"

  # ── (a) LA COPIA: esattamente il working tree che git vede ─────────────────
  # Tracciati + non tracciati-non-ignorati = la stessa materia di cui è fatto
  # `git diff HEAD` più i file nuovi. I file cancellati nel working tree si
  # saltano (il test -e), altrimenti tar va in errore su tutto il resto.
  local lista="$GATE_ISTANZA_DIR/.lista"
  { git -C "$ROOT" ls-files -z; git -C "$ROOT" ls-files -z --others --exclude-standard; } \
    | ( cd "$ROOT" && while IFS= read -r -d '' f; do [ -e "$f" ] && printf '%s\0' "$f"; done ) \
    | sort -zu > "$lista"
  if ! tar -C "$ROOT" -c --null -T "$lista" -f - 2>/dev/null | tar -x -C "$GATE_ISTANZA_DIR" -f - 2>/dev/null; then
    echo "🛑 copia del working tree fallita"; return 1
  fi
  rm -f "$lista"

  # ── (b) QUELLO CHE GIT NON VEDE MA IL SERVER GLI SERVE ────────────────────
  # node_modules: un link, non una copia (296 MB; copiarli costerebbe più di
  # tutto il cancello). Il server non ci scrive mai dentro.
  ln -s "$ROOT/node_modules" "$GATE_ISTANZA_DIR/node_modules"
  # .env: ignorato da git ma è la fonte di JWT_SECRET e PASSWORD_HASH, cioè
  # dell'intera prova di autenticazione. Copiato con permessi stretti, dentro
  # una cartella 700, e muore con lei.
  if [ -f "$ROOT/.env" ]; then
    install -m 600 "$ROOT/.env" "$GATE_ISTANZA_DIR/.env"
  else
    # clone nuovo senza .env: un segreto usa-e-getta, solo per l'istanza
    # (anche una password a caso: un server «non configurato» rifarebbe il segreto al primo setup)
    ( umask 077; node -e 'const c=require("crypto"),s=c.randomBytes(16).toString("hex");console.log("JWT_SECRET="+c.randomBytes(32).toString("hex"));console.log("PASSWORD_HASH="+s+":"+c.scryptSync(c.randomBytes(16).toString("hex"),s,64).toString("hex"))' > "$GATE_ISTANZA_DIR/.env" )
  fi
  # Il registro delle mattonelle: ignorato da git (lo riscrive il server a
  # runtime) ma senza di lui /api/plugins non ha niente da dire.
  if [ -f "$ROOT/plugins/_registry.json" ]; then
    cp "$ROOT/plugins/_registry.json" "$GATE_ISTANZA_DIR/plugins/_registry.json"
  fi

  # ── (c) [2026-10-12] La copia della cassaforte dei portali non serve più: i portali
  # sono usciti dalla Machine, l'istanza non entra in nessun portale.

  # ── (d) LA CASA FINTA ─────────────────────────────────────────────────────
  # os.homedir() legge $HOME: una casa finta dentro la copia sposta in un colpo
  # eventi, memoria, cestino, bozze, partials, journal — tutti i depositi sotto
  # ~/.151machine. Le skill e i comandi di ~/.claude si collegano in SOLA
  # LETTURA (il server li elenca in /api/commands).
  local CASA="$GATE_ISTANZA_DIR/casa"
  mkdir -p "$CASA/.151machine"
  [ -d "$HOME/.claude/commands" ] && ln -s "$HOME/.claude" "$CASA/.claude"
  # ~/.local/bin/claude: il server lo cerca sotto $HOME (server/index.js:142).
  # Senza il collegamento l'istanza direbbe `cliAvailable: false` e sarebbe meno
  # fedele del vivo per un motivo che non c'entra col diff. In sola lettura.
  [ -d "$HOME/.local" ] && ln -s "$HOME/.local" "$CASA/.local"
  # [2026-10-20] La chiave del session-host (dal 17/10, server/session-host-key.js):
  # l'istanza bussa al session-host VIVO, e nella casa finta si creava una chiave
  # nuova ⇒ il daemon la chiudeva fuori e il 2/7 moriva sempre in 15 s. Il
  # collegamento alla chiave vera la fa entrare come prima del 17/10; il file
  # esiste già, quindi loadOrCreateKey lo legge e non lo riscrive. Mai stampato.
  [ -f "$HOME/.151machine/session-host.key" ] && \
    ln -s "$HOME/.151machine/session-host.key" "$CASA/.151machine/session-host.key"

  # ── (e) LA PORTA ──────────────────────────────────────────────────────────
  GATE_ISTANZA_PORTA="$(gate_istanza_porta_libera)"
  if [ -z "$GATE_ISTANZA_PORTA" ]; then echo "🛑 nessuna porta libera dal kernel"; return 1; fi
  GATE_ISTANZA_BASE="http://127.0.0.1:$GATE_ISTANZA_PORTA"

  # ── (f) L'AVVIO ───────────────────────────────────────────────────────────
  # setsid: l'istanza è capo del suo gruppo di processi, così lo spegnimento
  # uccide il gruppo intero e non resta nessun nipote.
  # RELAY_SECRET vuoto: senza lasciapassare l'istanza non bussa a nessuno
  # (nacque per l'adozione unica di Playlist Doctor, plugin tolto il 27/10/2026:
  # il Dottore ora sta in MUSIC di 151 Entertainment), quindi l'istanza di scarto non esce mai verso il vecchio Pi
  # (dotenv non sovrascrive una variabile già impostata, nemmeno se vale
  # stringa vuota — quindi questo vince su .env). [2026-10-16] PEER_URL tolto:
  # non lo legge più nessuno.
  # ⚠ MAI stampare queste variabili: .env è dentro (legge 3).
  # JWT_SECRET/PASSWORD_HASH tolti dall'ambiente: se chi lancia li ha (una sessione dentro la Machine),
  # vincerebbero sul .env dell'istanza.
  (
    cd "$GATE_ISTANZA_DIR" || exit 1
    HOME="$CASA" \
    PORT="$GATE_ISTANZA_PORTA" \
    RELAY_SECRET= \
    USE_SESSION_HOST= \
    ATTACHMENTS_DIR="$CASA/.151machine/attachments" \
    env -u JWT_SECRET -u PASSWORD_HASH setsid node server/index.js > "$GATE_ISTANZA_LOG" 2>&1 &
    echo $! > "$GATE_ISTANZA_DIR/.pid"
  )
  GATE_ISTANZA_PID="$(cat "$GATE_ISTANZA_DIR/.pid" 2>/dev/null)"
  if [ -z "$GATE_ISTANZA_PID" ]; then echo "🛑 l'istanza non è partita (nessun pid)"; return 1; fi

  # ── (g) LA GUARDIA ────────────────────────────────────────────────────────
  # Il trap copre EXIT/INT/TERM/HUP. Non copre SIGKILL sul cancello: in quel
  # caso nessun trap gira e l'istanza resterebbe orfana. La guardia è un
  # processo separato che NON dipende dal cancello per morire: controlla se il
  # padre esiste ancora, e quando sparisce uccide l'istanza e la copia.
  local MIO_PID=$$
  setsid bash -c '
    while kill -0 '"$MIO_PID"' 2>/dev/null; do sleep 1; done
    kill -KILL -- -'"$GATE_ISTANZA_PID"' 2>/dev/null
    kill -KILL '"$GATE_ISTANZA_PID"' 2>/dev/null
    case "'"$GATE_ISTANZA_DIR"'" in /tmp/gate-istanza-*) rm -rf "'"$GATE_ISTANZA_DIR"'" ;; esac
  ' >/dev/null 2>&1 &
  GATE_ISTANZA_GUARDIA_PID=$!

  # ── (h) L'ATTESA ──────────────────────────────────────────────────────────
  # Si aspetta che /api/health risponda, non un numero di secondi a caso.
  local i=0
  while [ "$i" -lt 300 ]; do
    if [ -n "$(curl -s -m 2 -o /dev/null -w '%{http_code}' "$GATE_ISTANZA_BASE/api/health" 2>/dev/null | grep -x 200)" ]; then
      return 0
    fi
    if ! kill -0 "$GATE_ISTANZA_PID" 2>/dev/null; then
      echo "🛑 l'istanza è morta durante l'avvio. Ultime righe:"
      tail -15 "$GATE_ISTANZA_LOG" 2>/dev/null | sed 's/^/     /'
      return 1
    fi
    sleep 0.2
    i=$((i + 1))
  done
  echo "🛑 l'istanza non ha risposto su /api/health entro 60s. Ultime righe:"
  tail -15 "$GATE_ISTANZA_LOG" 2>/dev/null | sed 's/^/     /'
  return 1
}

# ── LA PROVA CHE DENTRO L'ISTANZA C'È IL TUO LAVORO ──────────────────────────
# Senza questa, «l'istanza prova il working tree» è una promessa. Un errore
# nella lista dei file (un `--exclude-standard` di troppo, un file nuovo dentro
# una cartella ignorata) farebbe nascere un'istanza SENZA il diff, e il cancello
# tornerebbe a provare il codice sbagliato — stesso guasto di prima, nuovo
# vestito. Quindi ogni file del diff si confronta BYTE PER BYTE con la copia.
#
# Si è scelto questo invece dell'uguaglianza dei codeHash, che sarebbe stata più
# elegante e FALSA: il codeHash mette dentro anche file che git ignora e che la
# copia non ha (server/mcp-configs/*.json, server/config.json, i .json di stato
# di playlist-doctor), quindi i due numeri non possono combaciare e pretenderlo
# avrebbe prodotto un rosso perenne da ignorare — la peggiore specie di allarme.
gate_istanza_prova_il_diff() {
  local ROOT n=0 rotti=0 f
  ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || return 1
  [ -n "$GATE_ISTANZA_DIR" ] && [ -d "$GATE_ISTANZA_DIR" ] || { echo "🛑 nessuna copia da controllare"; return 1; }
  while IFS= read -r f; do
    [ -z "$f" ] && continue
    n=$((n + 1))
    if [ -e "$ROOT/$f" ]; then
      if ! cmp -s "$ROOT/$f" "$GATE_ISTANZA_DIR/$f" 2>/dev/null; then
        echo "🛑 «$f» NON è arrivato nell'istanza (assente o diverso)"; rotti=1
      fi
    elif [ -e "$GATE_ISTANZA_DIR/$f" ]; then
      # Cancellato nel working tree ma presente nella copia: l'istanza sta
      # girando con un file che tu hai tolto.
      echo "🛑 «$f» l'hai cancellato, ma nell'istanza c'è ancora"; rotti=1
    fi
  done < <( { git -C "$ROOT" --no-pager diff HEAD --name-only; git -C "$ROOT" ls-files --others --exclude-standard; } 2>/dev/null | sort -u )
  [ "$rotti" = "0" ] || return 1
  if [ "$n" = "0" ]; then
    echo "· nessun file nel diff: l'istanza è il working tree, che oggi è HEAD"
  else
    echo "✓ tutti i $n file del tuo lavoro sono DENTRO l'istanza (confronto byte per byte)"
  fi
  return 0
}
