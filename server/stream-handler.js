'use strict';

const path = require('path');
const fs = require('fs');
// Hook point: return true when an external Stop hook discarded the last reply
// (the reply is then folded into a grey line). No such hook ships here.
const eRifatta = () => false;

// [2026-10-09] Cosa è «per il proprietario» (mai nella tendina dei passaggi): un posto
// solo, condiviso con la chat — public/js/per-utente.js.
const { perNico, ripiega } = require('../public/js/per-utente.js');

module.exports = function createStreamHandler({ manager, sendToSession, broadcastSessionStatus, getPluginManager }) {

  function trackTool(toolName, toolsUsed, sid) {
    if (!toolsUsed.includes(toolName)) {
      toolsUsed.push(toolName);
      manager.addStreamTool(sid, toolName);
    }
  }

  // Restart ATTRIBUTION: if a session fires a command that will bounce the
  // server, stamp it as the culprit NOW (at tool_use) — the restart kills the
  // tool before tool_done, so this is our only chance. The boot banner then
  // names the session. Flag-gated (RESTART_MEMORY), fire-and-forget, never
  // throws into the turn. Inert for every non-restart tool call.
  // Command-position only: see isRestartCommand (bottom of this file).
  // [12/11/2026 ] La sessione chiama la skill «wrap»: la Machine se lo segna.
  function noteWrap(sid, toolName, input) {
    try {
      const sk = input && String(input.skill || input.command || '').replace(/^\//, '').trim();
      if (toolName === 'Skill' && sk === 'wrap' && typeof manager.markWrapped === 'function') manager.markWrapped(sid);
    } catch (_) { /* mai nel flusso della risposta */ }
  }

  function maybeRecordRestartCulprit(sid, toolName, input) {
    if (!process.env.RESTART_MEMORY) return;
    if (toolName !== 'Bash') return;
    try {
      const cmd = input && typeof input.command === 'string' ? input.command : '';
      if (!cmd || !isRestartCommand(cmd)) return;
      const sess = manager.sessions.get(sid);
      const title = (sess && sess.title) || null;
      const ri = require('./restart-intent');
      ri.recordCulprit({ sessionId: sid, title, command: cmd });
      // ARM the post-deploy verify here too — this is the chokepoint for the
      // OTHER restart class (a session running deploy.sh/pm2 as a Bash tool,
      // which never touches the in-process restart() funnel). Same arm primitive
      // as restart-control, so on boot the boot loop fires the verify regardless
      // of which kind of restart bounced us. Keyed to this session id.
      ri.armPostDeployVerify({ sessionId: sid, intent: cmd });
    } catch { /* never break a turn over attribution */ }
  }

  const staleRetryCount = new Map();
  const modeRetryCount = new Map();

  // Classifier-fallback flipped 'auto' → 'bypassPermissions' mid-turn: the
  // permission classifier was down, THIS turn was frozen on it, and the warm SDK
  // query was respawned to pick up the new mode (sdk-engine.evictForModeChange).
  // If we let 'close' finalize normally the message renders TRUNCATED — half the
  // answer, no <options>/UI-question tail — and the owner has to re-type. Instead we
  // RE-RUN the exact same turn: it now runs unblocked in bypass and completes.
  // Mirrors handleStaleSession, but does NOT clear the claude session id — this
  // RESUMES (context intact), it isn't a fresh session. The bypass sentinel is
  // already written before the flip, so the respawned query starts in bypass.
  function handleModeChangeRetry(sid) {
    const retries = (modeRetryCount.get(sid) || 0) + 1;
    modeRetryCount.set(sid, retries);

    if (retries > 2) {
      console.error('[CLASSIFIER-FALLBACK] mode-change retry limit exceeded for', sid.slice(0, 8), '— giving up');
      modeRetryCount.delete(sid);
      manager.finishMessage(sid, '');
      sendToSession(sid, { type: 'error', message: 'The classifier was down; could not finish the reply after the bypass. Try again.' });
      broadcastSessionStatus(sid, 'idle');
      return;
    }

    console.log('[CLASSIFIER-FALLBACK] classifier down — re-running frozen turn in bypass for', sid.slice(0, 8), `(attempt ${retries})`);
    manager.clearStream(sid); // discard the truncated partial; the retry replaces it
    const session = manager.sessions.get(sid);
    if (!session) return;
    session.process = null;
    session.status = 'idle';
    const lastMsg = session.history[session.history.length - 1];
    if (!lastMsg || lastMsg.role !== 'user') return; // nothing to re-run
    const retryText = lastMsg.content;
    const retryAttachments = lastMsg.attachments || [];
    session.history.pop();
    try {
      const retryResult = manager.sendMessage(sid, retryText, retryAttachments);
      sendToSession(sid, { type: 'status', status: 'thinking', detail: 'Classifier down — bypass on, finishing the reply…' });
      spawnStreamHandler(retryResult.process, sid);
    } catch (err) {
      modeRetryCount.delete(sid);
      manager.finishMessage(sid, '');
      sendToSession(sid, { type: 'error', message: 'Retry failed: ' + err.message });
    }
  }

  function handleStaleSession(sid) {
    const retries = (staleRetryCount.get(sid) || 0) + 1;
    staleRetryCount.set(sid, retries);

    if (retries > 2) {
      console.error('[SESSION] Stale session retry limit exceeded for', sid.slice(0, 8), '— giving up');
      staleRetryCount.delete(sid);
      manager.finishMessage(sid, '');
      sendToSession(sid, { type: 'error', message: 'Session could not be reconnected after multiple retries. Please send a new message.' });
      return;
    }

    console.log('[SESSION] Stale CLI session for', sid.slice(0, 8), `— clearing and retrying (attempt ${retries})`);
    manager.clearClaudeSessionId(sid);
    manager.clearStream(sid);
    const session = manager.sessions.get(sid);
    if (!session) return;
    session.process = null;
    session.status = 'idle';
    const lastMsg = session.history[session.history.length - 1];
    if (!lastMsg || lastMsg.role !== 'user') return;
    const retryText = lastMsg.content;
    const retryAttachments = lastMsg.attachments || [];
    session.history.pop();
    try {
      const retryResult = manager.sendMessage(sid, retryText, retryAttachments);
      sendToSession(sid, { type: 'status', status: 'thinking', detail: 'Reconnecting session...' });
      spawnStreamHandler(retryResult.process, sid);
    } catch (err) {
      staleRetryCount.delete(sid);
      manager.finishMessage(sid, '');
      sendToSession(sid, { type: 'error', message: 'Retry failed: ' + err.message });
    }
  }

  function spawnStreamHandler(proc, sid) {
    let fullResponse = '';
    let allStreamedText = '';
    let textSep = false;               // nuovo blocco di testo: stacco prima del suo primo delta
    // [2026-10-01] SOLO LA RISPOSTA FINALE (il proprietario: «muri di testo, non so cosa
    // sto guardando»). Il testo di un turno si spezza a ogni uso di strumento:
    // i pezzi PRIMA dell'ultimo strumento sono il modello che parla da solo
    // («controllo X…», «ora leggo Y…») → vanno in `steps`, ripiegati. Il pezzo
    // DOPO l'ultimo strumento è la risposta. Il testo dei sotto-agenti
    // (parent_tool_use_id) non entra mai nella risposta della sessione.
    const textSegs = [];
    let curSeg = '';
    let thinkingText = '';
    let buffer = '';
    const toolsUsed = [];
    // Maps a tool_use id -> tool name, so a tool_result (which carries only the
    // id, not the name) can be matched back to its tool for the `tool_done`
    // event. Lets the client correlate start->done by stable id instead of by
    // name (name-matching breaks when the same tool runs twice in a turn).
    const toolNamesById = new Map();
    // Restart-journal (flag-gated by RESTART_MEMORY): remembers each tool's
    // input by id so the durable journal record written at tool_done carries
    // both input + result. Inert when the flag is off.
    const toolInputById = new Map();
    let chunkCount = 0;
    let finished = false;
    // RISPOSTA RIFATTA da un controllo di fine turno (hook Stop esterno, eRifatta).
    // `lastMsg` = il testo dell'ultimo messaggio di primo livello (l'SDK lo manda
    // a pezzi con lo stesso id). Se è finito senza strumenti, quando il turno
    // RIPARTE (messaggio sintetico «Stop hook feedback» o nuovo message_start) si
    // chiede al registro se è stato scartato: sì ⇒ il testo va in `discarded`,
    // il client lo chiude in una riga grigia e il seguito diventa la risposta.
    // Il flusso non si ferma mai: il controllo è una lettura sola, a fine messaggio.
    let lastMsg = { id: null, text: '', tool: false };
    let redoPending = false;
    const discarded = [];
    function checkRedo(claudeSid) {
      if (!redoPending) return;
      redoPending = false;
      const sess = manager.sessions && manager.sessions.get(sid);
      const csid = claudeSid || (sess && sess.claudeSessionId) || null;
      if (!eRifatta(csid, lastMsg.text)) return;
      const scartato = curSeg.trim() || lastMsg.text.trim();
      curSeg = '';
      fullResponse = '';
      allStreamedText = '';
      textSep = false;
      discarded.push(scartato);
      try { if (typeof manager.markStreamRedo === 'function') manager.markStreamRedo(sid, scartato); } catch {}
      console.log('[REGOLE] risposta rifatta ' + sid.slice(0, 8) + ' — scartati ' + scartato.length + ' caratteri');
      sendToSession(sid, { type: 'redo', discarded: scartato });
    }
    manager.startStream(sid);

    const memTimer = setInterval(() => {
      const rss = Math.round(process.memoryUsage().rss / 1024 / 1024);
      if (rss < 768) return; // [12/10/2026] solo quando pesa: prima una riga ogni 30 s per sessione
      const bufLen = Math.round(buffer.length / 1024);
      console.log(`[MEM] Session ${sid.slice(0, 8)}: ${rss}MB RSS, buffer ${bufLen}KB, ${chunkCount} chunks`);
    }, 30000);

    function handleStreamData(chunk) {
      chunkCount++;
      try {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop();

        if (buffer.length > 10 * 1024 * 1024) {
          console.error(`[STREAM] Buffer overflow for ${sid.slice(0, 8)}: ${Math.round(buffer.length / 1024 / 1024)}MB — truncating`);
          buffer = '';
        }

        const pluginManager = getPluginManager();

        for (const line of lines) {
          if (!line.trim()) continue;
          let parsed;
          try { parsed = JSON.parse(line); } catch { continue; }

          if (parsed.type === 'rate_limit_event' || parsed.type === 'system') {
            if (parsed.type === 'system' && parsed.subtype === 'init') {
              if (parsed.session_id) manager.setClaudeSessionId(sid, parsed.session_id);
              const modelName = parsed.model || 'claude';
              // FAMIGLIE (2026-08-16): the init line carries the model the
              // process ACTUALLY runs (family alias already resolved by the
              // CLI/SDK) — stamp it as the session's display model so chip
              // and card show the precise name. The pin is never touched.
              try { manager.noteRunningModel(sid, parsed.model); } catch {}
              console.log(`[INIT] Session ${sid.slice(0, 8)}: model=${modelName}`);
              sendToSession(sid, { type: 'status', status: 'thinking', detail: `Model: ${modelName}` });
              sendToSession(sid, { type: 'model_info', model: modelName, sessionId: sid });
              if (pluginManager) pluginManager.emit('onModelInit', sid, modelName);
            }
            continue;
          }

          if (parsed.type === 'stream_event') {
            const evt = parsed.event;
            if (!parsed.parent_tool_use_id && evt?.type === 'message_start') checkRedo(parsed.session_id);
            // Il flusso dei sotto-agenti non è la voce della sessione.
            if (parsed.parent_tool_use_id && evt?.type === 'content_block_delta') continue;
            if (evt?.type === 'content_block_start' && evt.content_block?.type === 'tool_use') {
              const toolName = evt.content_block.name || 'unknown';
              const tuid = evt.content_block.id || '';
              if (tuid) toolNamesById.set(tuid, toolName);
              sendToSession(sid, { type: 'tool_start', tool: toolName, toolUseId: tuid });
              trackTool(toolName, toolsUsed, sid);
            }
            // Un nuovo pezzo di testo dopo uno strumento: senza separatore il telefono
            // incollava «…il telefono.Prova rossa…» (telefono di prova 15/11). Lo stacco va col primo delta.
            if (!parsed.parent_tool_use_id && evt?.type === 'content_block_start' && evt.content_block?.type === 'text' && allStreamedText) {
              textSep = true;
            }
            if (evt?.type === 'content_block_start' && evt.content_block?.type === 'thinking') {
              sendToSession(sid, { type: 'thinking_start' });
            }
            if (evt?.type === 'content_block_delta') {
              const delta = evt.delta;
              if (delta?.type === 'thinking_delta' && delta.thinking) {
                thinkingText += delta.thinking;
                sendToSession(sid, { type: 'thinking', content: delta.thinking });
              }
              if (delta?.type === 'text_delta' && delta.text) {
                let piece = delta.text;
                if (textSep) {
                  textSep = false;
                  if (!/\n\s*$/.test(allStreamedText) && !/^\s*\n/.test(piece)) piece = '\n\n' + piece;
                }
                allStreamedText += piece;
                manager.appendStreamText(sid, piece);
                sendToSession(sid, { type: 'delta', content: piece });
              }
            }
            continue;
          }

          if (parsed.type === 'assistant' && parsed.message?.usage) {
            if (pluginManager) pluginManager.emit('onContextUsage', sid, parsed.message.usage);
          }

          if (parsed.type === 'assistant' && parsed.message?.content && !parsed.parent_tool_use_id) {
            const mid = parsed.message.id || null;
            if (!mid || mid !== lastMsg.id) lastMsg = { id: mid, text: '', tool: false };
            for (const b of (Array.isArray(parsed.message.content) ? parsed.message.content : [])) {
              if (b.type === 'text' && b.text) lastMsg.text += b.text;
              else if (b.type === 'tool_use') lastMsg.tool = true;
            }
            redoPending = !lastMsg.tool && !!lastMsg.text.trim();
            for (const b of (Array.isArray(parsed.message.content) ? parsed.message.content : [])) {
              if (b.type === 'text' && b.text) curSeg += (curSeg ? '\n\n' : '') + b.text;
              else if (b.type === 'tool_use' && curSeg.trim()) { textSegs.push(curSeg.trim()); curSeg = ''; }
            }
          }

          if (parsed.type === 'assistant' && parsed.message?.content) {
            const blocks = Array.isArray(parsed.message.content) ? parsed.message.content : [];
            const text = parsed.parent_tool_use_id ? '' : blocks.filter(b => b.type === 'text').map(b => b.text).join('');
            if (text) {
              fullResponse += (fullResponse ? '\n\n' : '') + text;
              if (!allStreamedText) sendToSession(sid, { type: 'delta', content: text });
            }
            for (const block of blocks) {
              if (block.type === 'tool_use') {
                const toolName = block.name || 'unknown';
                if (block.id) toolNamesById.set(block.id, toolName);
                if (block.id) toolInputById.set(block.id, block.input || {});
                sendToSession(sid, { type: 'tool_use', tool: toolName, toolUseId: block.id || '', input: block.input || {} });
                trackTool(toolName, toolsUsed, sid);
                maybeRecordRestartCulprit(sid, toolName, block.input);
                if (!parsed.parent_tool_use_id) noteWrap(sid, toolName, block.input);
              }
            }
          } else if (parsed.type === 'user' && parsed.message?.content) {
            // Messaggio utente senza tool_result = il turno riparte da solo
            // (es. «Stop hook feedback»): è il momento di chiedere al registro.
            const _uc = parsed.message.content;
            if (!parsed.parent_tool_use_id && !(Array.isArray(_uc) && _uc.some((b) => b && b.type === 'tool_result'))) {
              checkRedo(parsed.session_id);
            }
            // Tool results come back as a `user` message whose content holds
            // `tool_result` blocks (each carries only the tool_use_id, not the
            // tool name — we resolve it from toolNamesById). This is the
            // done-side of a tool run for BOTH engines (SDK + legacy CLI
            // stream-json); the top-level `tool_result` branch below never
            // fired for either, so without this no `tool_done` was emitted.
            const ublocks = Array.isArray(parsed.message.content) ? parsed.message.content : [];
            for (const block of ublocks) {
              if (block.type !== 'tool_result') continue;
              const tuid = block.tool_use_id || '';
              const toolName = toolNamesById.get(tuid) || 'unknown';
              let output = '';
              const c = block.content;
              if (typeof c === 'string') {
                output = c;
              } else if (Array.isArray(c)) {
                output = c.map(p => (typeof p === 'string' ? p : (p && p.type === 'text' ? p.text : ''))).filter(Boolean).join('\n');
              } else if (c != null) {
                output = JSON.stringify(c);
              }
              if (output.length > 2000) output = output.slice(0, 2000) + '\n... (truncated)';
              sendToSession(sid, { type: 'tool_done', tool: toolName, toolUseId: tuid, output: output, isError: !!block.is_error });
              trackTool(toolName, toolsUsed, sid);
              // Durable restart-journal write (flag-gated, fire-and-forget).
              if (process.env.RESTART_MEMORY) {
                const _in = toolInputById.get(tuid);
                const _err = !!block.is_error;
                setImmediate(() => { try { require('./restart-journal').recordAction(sid, { tool: toolName, input: _in, result: output, isError: _err }); } catch {} });
              }
            }
          } else if (parsed.type === 'tool_result') {
            const toolName = parsed.tool_name || parsed.name || 'unknown';
            let output = '';
            if (parsed.output) {
              output = typeof parsed.output === 'string' ? parsed.output : JSON.stringify(parsed.output);
            } else if (parsed.content) {
              output = typeof parsed.content === 'string' ? parsed.content : JSON.stringify(parsed.content);
            }
            if (output.length > 2000) output = output.slice(0, 2000) + '\n... (truncated)';
            sendToSession(sid, { type: 'tool_done', tool: toolName, toolUseId: parsed.tool_use_id || '', output: output, isError: !!parsed.is_error });
            trackTool(toolName, toolsUsed, sid);
            // Durable restart-journal write (flag-gated, fire-and-forget).
            if (process.env.RESTART_MEMORY) {
              const _in = toolInputById.get(parsed.tool_use_id || '');
              const _err = !!parsed.is_error;
              setImmediate(() => { try { require('./restart-journal').recordAction(sid, { tool: toolName, input: _in, result: output, isError: _err }); } catch {} });
            }
          } else if (parsed.type === 'tool_use') {
            const toolName = parsed.tool_name || parsed.name || 'unknown';
            sendToSession(sid, { type: 'tool_use', tool: toolName, input: parsed.input || parsed.tool_input || {} });
            trackTool(toolName, toolsUsed, sid);
            maybeRecordRestartCulprit(sid, toolName, parsed.input || parsed.tool_input);
            noteWrap(sid, toolName, parsed.input || parsed.tool_input);
          } else if (parsed.type === 'result') {
            // Step 1 spending brake: accumulate this turn's genuinely-NEW token
            // spend. We count ONLY uncached input (the new user msg + tool
            // results) + generated output. We DELIBERATELY exclude
            // cache_read_input_tokens AND cache_creation_input_tokens: both
            // re-process the SAME growing transcript on every turn, so summing
            // them into a lifetime total made `tokensUsed` balloon ~quadratically
            // with conversation length — a normal long chat tripped the 10M cap
            // around turn ~38 and got bricked mid-conversation ("This chat has
            // reached its usage limit"). New input+output still trips on a real
            // runaway (endless tool loop / unbounded output) = the intended backstop.
            if (parsed.usage) {
              const u = parsed.usage;
              const turnTokens = (u.input_tokens || 0) + (u.output_tokens || 0);
              manager.addTokensUsed(sid, turnTokens);
            }
            if (parsed.is_error && parsed.errors?.some(e => /no conversation found|--resume requires a valid session/i.test(e))) {
              handleStaleSession(sid);
              return;
            }
            if (parsed.result) {
              if (!fullResponse || parsed.result.length > fullResponse.length) {
                fullResponse = parsed.result;
              }
            } else if (!fullResponse) {
              fullResponse = allStreamedText;
            }
            if (parsed.duration_ms) {
              sendToSession(sid, {
                type: 'status',
                status: 'complete',
                detail: `${parsed.num_turns || 1} turn(s), ${(parsed.duration_ms / 1000).toFixed(1)}s`,
              });
            }
          }
        }
      } catch (err) {
        console.error(`[STREAM] Error processing chunk for ${sid.slice(0, 8)}:`, err.message, err.stack);
        try {
          const errLog = path.join(__dirname, 'logs', 'crash.log');
          fs.mkdirSync(path.dirname(errLog), { recursive: true });
          fs.appendFileSync(errLog, `[${new Date().toISOString()}] STREAM ERROR (${sid.slice(0, 8)}): ${err.message}\n${err.stack}\n\n`);
        } catch {}
      }
    }

    proc.stdout.on('data', handleStreamData);
    proc.stderr.on('data', handleStreamData);

    proc.stdout.on('error', (err) => console.error(`[PIPE] stdout error for ${sid.slice(0, 8)}:`, err.message));
    proc.stderr.on('error', (err) => console.error(`[PIPE] stderr error for ${sid.slice(0, 8)}:`, err.message));

    // Risposta finale + passaggi ripiegati. null = nessun testo strutturato
    // visto (motore vecchio / solo flusso): si resta sul comportamento di prima.
    // [2026-10-09] il proprietario: «tutto ciò che la sessione scrive per me (domande,
    // prompt da incollare, istruzioni) sta fuori dalla tendina, sempre». Caso
    // vero, alle 9:16: una risposta intera col prompt da incollare
    // è finita in «▶ Passaggi» perché il turno è ripartito da solo (avviso di
    // un agente in background) e dopo è arrivato altro testo. Nella tendina va
    // solo il parlare-da-solo breve; un pezzo «per il proprietario» resta nella risposta,
    // nell'ordine in cui è stato scritto.
    function splitFinal() {
      const segs = textSegs.slice();
      let fin = curSeg.trim();
      if (!fin && segs.length) fin = segs.pop();
      if (!fin) return null;
      const r = ripiega(fin, segs);
      return { final: r.content, steps: r.steps };
    }

    proc.on('close', (code) => {
      clearInterval(memTimer);
      if (proc._userKilled || finished) {
        if (proc._userKilled) console.log('[CLI] User-killed process closed for session', sid.slice(0, 8), '— skipping done');
        staleRetryCount.delete(sid);
        modeRetryCount.delete(sid);
        return;
      }
      finished = true;
      // Classifier-fallback flipped to bypass mid-turn and aborted THIS frozen turn
      // to respawn it. Do NOT finalize the truncated partial — re-run the turn so it
      // completes (answer + its <options>/UI-question tail) in the new bypass mode.
      if (proc._modeChangeRetry) {
        handleModeChangeRetry(sid);
        return;
      }
      if (code !== 0 && code !== null) {
        console.log('[CLI] Process exited with code', code, 'for session', sid.slice(0, 8));
      }
      if (!fullResponse) fullResponse = allStreamedText || '';

      if (code !== 0 && code !== null && !fullResponse && chunkCount === 0) {
        console.error('[CLI] Crash: code', code, 'with zero output for', sid.slice(0, 8));
        // Observatory: a genuinely failed turn (crashed, zero output).
        try { require('./event-log').logEvent('turn_error', { session: sid, kind: 'crash', code }); } catch {}
        manager.finishMessage(sid, '');
        sendToSession(sid, { type: 'error', message: `Claude failed to respond (exit code ${code}). Please try again.` });
        broadcastSessionStatus(sid, 'idle');
        const pluginManager = getPluginManager();
        if (pluginManager) pluginManager.emit('onResponseComplete', sid);
        return;
      }

      staleRetryCount.delete(sid);
      modeRetryCount.delete(sid);
      const split = splitFinal();
      let steps = [];
      if (split) { fullResponse = split.final; steps = split.steps; }
      manager.finishMessage(sid, fullResponse, toolsUsed, thinkingText, steps, discarded);
      const doneSession = manager.sessions.get(sid);
      if (doneSession) {
        doneSession._lastResponseComplete = Date.now();
        doneSession.status = 'idle';
      }
      // Truncation repro instrumentation (b_653a85d4): the authoritative length
      // of the finished turn. Compare with the client's [DONE-LEN] console line.
      console.log('[STREAM] done ' + sid.slice(0, 8) + ' len=' + (fullResponse || '').length);
      const doneMsg = { type: 'done', fullResponse, steps, finalOnly: !!split };
      if (discarded.length) doneMsg.discarded = discarded.slice();
      sendToSession(sid, doneMsg);
      broadcastSessionStatus(sid, 'idle');
      // Turn finished cleanly → no amnesia risk → drop this session's journal.
      // GUARD: do NOT clear during a server shutdown. On SIGTERM/deploy the CLI
      // child is killed and this 'close' fires WITHOUT _userKilled set — clearing
      // here would wipe the exact evidence the resumed turn needs. The global is
      // set in gracefulShutdown()/plannedShutdown() before any child is killed.
      if (process.env.RESTART_MEMORY && !global.__151_shutting_down) {
        try { require('./restart-journal').clearSession(sid); } catch {}
      }
      const pluginManager = getPluginManager();
      if (pluginManager) pluginManager.emit('onResponseComplete', sid);
    });

    proc.on('error', (err) => {
      clearInterval(memTimer);
      if (proc._userKilled || finished) return;
      finished = true;
      console.error('[CLI] Process error for session', sid.slice(0, 8), ':', err.message);
      // ALWAYS clean up session state, even for suppressed/noisy errors.
      // The 'close' event that follows is short-circuited by `finished`, so if
      // we returned here without finishMessage the session.process would never
      // be nulled and the session would stay "busy"/in-progress forever
      // (relay hiccups on Pi-served sessions were stuck "in corso" all day).
      if (!fullResponse) fullResponse = allStreamedText || '';
      manager.finishMessage(sid, fullResponse, toolsUsed, thinkingText);
      const doneSession = manager.sessions.get(sid);
      if (doneSession) {
        doneSession._lastResponseComplete = Date.now();
        doneSession.status = 'idle';
      }
      broadcastSessionStatus(sid, 'idle');
      const pluginManager = getPluginManager();
      if (pluginManager) pluginManager.emit('onResponseComplete', sid);
      // Suppress only the noisy user-facing error toast for auto-stop / relay
      // hiccups (abort / socket hang up / ECONNRESET). The state cleanup above
      // still runs; emit 'done' so the client also clears its in-progress UI.
      if (/abort|socket hang up|ECONNRESET/i.test(err.message)) {
        sendToSession(sid, { type: 'done', fullResponse });
        return;
      }
      // Observatory: a real (non-noise) process error surfaced to the user.
      try { require('./event-log').logEvent('turn_error', { session: sid, kind: 'proc_error', message: (err.message || '').slice(0, 160) }); } catch {}
      sendToSession(sid, { type: 'error', message: err.message });
    });
  }

  return { spawnStreamHandler };
};

// Per la prova (tests/tendina-per-utente.test.js).
module.exports.perNico = perNico;

// [12/10/2026] Un comando ESEGUE un riavvio/consegna? Solo in posizione di
// comando: inizio, dopo ; && || | & o a capo, oppure come script di
// bash/sh/source/. (anche dentro `bash -c '…'`). Mai quando la stessa parola è
// l'argomento di chi LEGGE (grep 'pm2 restart', rg /api/deploy,
// sed -n 1p tools/deploy.sh, git log -- tools/deploy.sh…): prima la regex
// scattava anche lì e dava la colpa del riavvio alla sessione che leggeva.
// Prova: tests/restart-cmd.test.js.
const PM2_RESTART_VERBS = new Set(['restart', 'reload', 'start', 'kill', 'resurrect']);
const DEPLOY_SCRIPT_RE = /(?:^|\/)(?:deploy(?:-pi)?\.sh|land-launcher[\w.-]*)$/i;

// Spezza in segmenti di comando, ciascuno una lista di parole, rispettando
// virgolette e backslash. Gli operatori dentro le virgolette non spezzano.
function shellSegments(cmd) {
  const segs = [];
  let words = [];
  let cur = '';
  let has = false;
  let q = null;
  const endWord = () => { if (has) words.push(cur); cur = ''; has = false; };
  const endSeg = () => { endWord(); if (words.length) segs.push(words); words = []; };
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (q) {
      if (c === q) { q = null; continue; }
      if (c === '\\' && q === '"' && i + 1 < cmd.length) { cur += cmd[++i]; continue; }
      cur += c;
      continue;
    }
    if (c === "'" || c === '"') { q = c; has = true; continue; }
    if (c === '\\' && i + 1 < cmd.length) { cur += cmd[++i]; has = true; continue; }
    if (c === ';' || c === '&' || c === '|' || c === '\n' || c === '(' || c === ')') { endSeg(); continue; }
    if (/\s/.test(c)) { endWord(); continue; }
    cur += c; has = true;
  }
  endSeg();
  return segs;
}

const PREFIX_WORDS = new Set(['sudo', 'nohup', 'time', 'exec', 'env', 'command', 'nice', 'npx', 'then', 'do', 'else', '!', '{']);

function isRestartCommand(cmd, depth) {
  if (typeof cmd !== 'string' || !cmd) return false;
  depth = depth || 0;
  for (const seg of shellSegments(cmd)) {
    let i = 0;
    // Salta assegnazioni d'ambiente (FOO=1 cmd) e prefissi che lanciano il resto.
    while (i < seg.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(seg[i]) || PREFIX_WORDS.has(seg[i]))) i++;
    const w = seg[i];
    if (!w) continue;
    const base = w.replace(/^.*\//, '');
    if (DEPLOY_SCRIPT_RE.test(w)) return true;                          // ./tools/deploy.sh
    if (base === 'pm2') {
      const verb = seg.slice(i + 1).find((x) => !x.startsWith('-'));
      if (verb && PM2_RESTART_VERBS.has(verb.toLowerCase())) return true;
      continue;
    }
    if (base === 'bash' || base === 'sh' || base === 'zsh' || base === 'source' || base === '.') {
      const rest = seg.slice(i + 1);
      const ci = rest.indexOf('-c');
      if (ci !== -1 && rest[ci + 1] && depth < 3) {
        if (isRestartCommand(rest[ci + 1], depth + 1)) return true;
        continue;
      }
      const script = rest.find((x) => !x.startsWith('-'));
      if (script && DEPLOY_SCRIPT_RE.test(script)) return true;
      continue;
    }
    if (base === 'curl' || base === 'wget' || base === 'http') {
      if (seg.slice(i + 1).some((x) => /\/api\/deploy\b/i.test(x))) return true;
      continue;
    }
  }
  return false;
}
module.exports.isRestartCommand = isRestartCommand;
