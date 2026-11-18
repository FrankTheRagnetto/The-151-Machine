# The 151 Machine

A self-hosted command center for Claude Code: your own PC runs the sessions, and you follow, start and answer them from a phone or a browser. Nothing goes through a third-party server.

Part of The 151 Universe family of apps.

## What it does
- **Sessions** – start Claude Code sessions (through the Claude Agent SDK) on your PC, watch them stream, reply, stop background work, pick the model.
- **Phone** – an Android app (Capacitor, `app/`) that loads the page served by your PC over your private network (Tailscale); a browser works too.
- **Dictation** – optional speech-to-text on the PC (`whisper-service/`, faster-whisper, local only).
- **Plugins** – small extras in `plugins/` (quick actions, notifications, code blocks, super agents, updates…).
- **Your teams** – teams and super agents are yours to choose: copy `docs/squadre.example.json` to `~/.151machine/squadre.json` (or point the `MACHINE_SQUADRE` environment variable at your own file) and edit it; without that file the app shows only «New Session».

## Run
Requirements: Node 20+, Claude Code installed and signed in on the PC, Tailscale to reach it from the phone. Python 3 + faster-whisper only for dictation.

```
npm install
npm start          # http://127.0.0.1:3170 — the first visit from the PC itself sets the password
```

`ecosystem.linux.config.js` runs the server, the session host and dictation under pm2. The server answers only on loopback and on your Tailscale network.

## Tests
`npm run test:pure` runs every test that needs no server; `npm run test:instance` starts a throwaway copy of the server on a free port (empty home, made-up secrets) and runs the whole suite against it.

Code comments are in Italian.

## License
MIT (see `LICENSE`); see also `ACCEPTABLE_USE.md`. Dependencies are fetched by npm under their own licenses.

A personal project, shared as is: no support, but issues are welcome.
