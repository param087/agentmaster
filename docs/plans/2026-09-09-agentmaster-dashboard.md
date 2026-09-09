# Agent Master Dashboard Implementation Plan

> **For the implementing agent:** Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** A localhost web dashboard that spawns, mirrors, monitors, and notifies on every CLI agent harness (opencode, Claude Code, Gemini CLI, Codex, Qwen, PI) running on this laptop.

**Architecture:** A single long-lived Node process owns `node-pty` child processes. Raw PTY bytes stream over WebSocket to xterm.js in the browser, giving full keystroke fidelity (arrow keys, `⇧Tab`, `/model`, Ctrl-C). In parallel the server feeds those bytes into a headless xterm buffer, matches the *rendered screen* against per-harness YAML rules, and emits status transitions that drive the sidebar, attention queue, and desktop notifications. There is no per-harness protocol: everything harness-specific lives in `harnesses.yaml`.

**Tech Stack:** Node 24 · TypeScript · Express · `ws` · `node-pty` · `@xterm/headless` · better-sqlite3 · Vite · React 19 · Tailwind 4 · xterm.js · Vitest

**Locked decisions:**
- localhost only (`127.0.0.1:7180`), no auth, no Tailscale, no mobile/PWA
- sessions are killed on server restart
- fully fresh project in `agentmaster1`
- desktop Notification API, no service worker / VAPID

---

## Repository layout

```
agentmaster1/
├── package.json                # npm workspaces: server, web
├── harnesses.yaml              # harness registry (user-editable, hot-reloaded)
├── docs/plans/
├── server/
│   └── src/
│       ├── index.ts            # express + ws bootstrap
│       ├── bus.ts              # typed EventEmitter
│       ├── config/{schema.ts,harnesses.ts}
│       ├── session/{manager.ts,session.ts,ring-buffer.ts}
│       ├── status/{screen-model.ts,engine.ts,types.ts}
│       ├── db/{index.ts,migrations/}
│       ├── ws/{terminal.ts,events.ts}
│       └── routes/{sessions.ts,harnesses.ts,fs.ts}
└── web/
    └── src/
        ├── components/{app-shell,sidebar,attention-queue,session-row,
        │               status-dot,harness-icon,terminal-view,quick-actions,
        │               new-session-dialog,folder-picker,settings-dialog}.tsx
        ├── hooks/{use-events,use-terminal,use-notifications}.ts
        └── lib/{api.ts,types.ts}
```

---

## Shared types

`server/src/status/types.ts`, mirrored verbatim in `web/src/lib/types.ts`:

```ts
export type SessionStatus =
  | 'starting' | 'busy' | 'waiting_input' | 'idle' | 'exited' | 'error';

export type WaitKind = 'permission' | 'question' | 'menu' | 'unknown';

export interface QuickAction { label: string; keys: string; }

export interface Session {
  id: string;
  harnessId: string;
  harnessName: string;
  cwd: string;
  title: string;
  status: SessionStatus;
  waitKind?: WaitKind;
  actions?: QuickAction[];
  pid?: number;
  exitCode?: number;
  createdAt: number;
  statusChangedAt: number;
  busySince?: number;
}

export type ServerEvent =
  | { t: 'snapshot'; sessions: Session[] }
  | { t: 'session:created'; session: Session }
  | { t: 'session:updated'; session: Session }
  | { t: 'session:removed'; id: string }
  | { t: 'notify'; id: string; kind: 'waiting' | 'finished' | 'exited' | 'error';
      title: string; body: string };
```

---

## Task 1: Scaffold the monorepo

**Files:** `package.json`, `server/package.json`, `server/tsconfig.json`, `web/`, `.gitignore`

1. `git init`.
2. Root `package.json` with npm workspaces `["server","web"]`, scripts `dev`, `test`, `typecheck`.
3. Server deps: `express ws node-pty @xterm/headless better-sqlite3 yaml zod nanoid`. Dev: `typescript tsx vitest @types/express @types/ws @types/node @types/better-sqlite3`.
4. Web: Vite react-ts template, plus `tailwindcss@4 @tailwindcss/vite @xterm/xterm @xterm/addon-fit @xterm/addon-webgl lucide-react clsx tailwind-merge`.
5. Vite proxies `/api` and `/ws` (with `ws: true`) to `http://127.0.0.1:7180`.
6. **Verify `node -e "require('node-pty')"` loads.** The native build is the one thing that can block everything downstream.
7. Commit: `chore: scaffold server and web workspaces`

## Task 2: Harness registry

**Files:** `harnesses.yaml`, `server/src/config/schema.ts`, `server/src/config/harnesses.ts`, `server/test/harnesses.test.ts`

TDD. Test first: parsing a harness with detection rules yields compiled `RegExp`s and quick actions; an invalid regex throws with the harness id in the message.

`parseHarnesses(yamlText)` → validate with zod → compile each `match` to `RegExp` → apply `defaults` (`idle_ms: 2500`, `finished_after_busy_ms: 20000`). `loadHarnesses()` reads from disk and `fs.watch`es for hot reload, keeping the previous config on parse error.

Ship `harnesses.yaml` with opencode, claude-code, gemini-cli, codex, qwen-code, pi. Non-opencode regexes are first-draft guesses replaced in Task 6.

Commit: `feat: harness registry with validated detection rules`

## Task 3: Ring buffer

**Files:** `server/src/session/ring-buffer.ts`, `server/test/ring-buffer.test.ts`

TDD. Preallocated `Buffer` + write cursor. Drops oldest bytes past capacity; `read()` returns ordered contents. Commit: `feat: ring buffer for pty scrollback`

## Task 4: ScreenModel

**Files:** `server/src/status/screen-model.ts`, `server/test/screen-model.test.ts`

Wraps `@xterm/headless` `Terminal`. `write()` returns a promise resolving in xterm's write callback. `text()` joins `buffer.active` via `translateToString(true)`. `tail(n)` trims trailing blank lines and returns the last `n`.

Critical test: after `"Thinking..."` then `"\r\x1b[KDo you want to proceed?"`, `text()` contains the prompt and **not** `Thinking...`. This is what makes detection possible at all.

Commit: `feat: headless screen model for status detection`

## Task 5: StatusEngine

**Files:** `server/src/status/engine.ts`, `server/test/engine.test.ts`

State machine, timers injectable so tests use `vi.useFakeTimers()`.

- `onData(bytes)` → feed ScreenModel → set `busy` (emit only on change) → reset idle timer
- idle timer fires → test `tail(30)` against each `waiting_input` rule in order; first hit → `waiting_input` with that rule's `kind`/`actions`; else `idle` with `finished = busySince && now - busySince > finishedAfterBusyMs`
- `onExit(code)` → `exited`, or `error` when `code !== 0`

Commit: `feat: status engine state machine`

## Task 6: Fixture-verified detection

**Files:** `server/scripts/record-fixture.ts`, `server/test/fixtures/*.cast`, `server/test/detection.test.ts`

`record-fixture.ts` spawns a harness in a PTY, mirrors it to the real terminal, and appends every chunk to `test/fixtures/<name>.cast` as newline-delimited base64.

`detection.test.ts` replays each fixture through ScreenModel + StatusEngine and asserts the terminal status and wait kind. Synthetic fixtures are committed now; real captures are recorded later by the user and the regexes in `harnesses.yaml` corrected until green.

Commit: `test: fixture-verified detection`

## Task 7: SQLite

**Files:** `server/src/db/index.ts`, `server/src/db/migrations/001_init.sql`

`sessions(id, harness_id, cwd, title, created_at, exited_at, exit_code)` and `events(id, session_id, at, status, wait_kind)` with an index on `(session_id, at)`. Migration runner keyed on `user_version`. DB at `~/.agentmaster/db.sqlite`. On boot, mark any session lacking `exited_at` as exited — enforcing kill-on-restart in the record as well as in reality.

Commit: `feat: sqlite persistence and migrations`

## Task 8: SessionManager

**Files:** `server/src/session/session.ts`, `server/src/session/manager.ts`, `server/src/bus.ts`, `server/test/manager.test.ts`

`Session` owns a pty (`cols:120, rows:32`, `env: {...process.env, TERM:'xterm-256color', FORCE_COLOR:'1'}`), a `RingBuffer(2MB)`, a `StatusEngine`, and a `Set<WebSocket>` of viewers. `pty.onData` fans out three ways: broadcast to viewers, push to ring buffer, feed the engine. `kill()` sends SIGTERM then SIGKILL after 3s.

`SessionManager`: `create/get/list/kill/remove` over a `Map<id, Session>`, re-emitting status changes on the typed bus. `process.on('exit')` kills all sessions.

Tests use a fake harness (`bash -c 'echo hi; sleep 5'`).

Commit: `feat: session manager with pty lifecycle`

## Task 9: HTTP + WebSocket layer

**Files:** `server/src/index.ts`, `server/src/routes/*.ts`, `server/src/ws/*.ts`

REST: `GET /api/harnesses`, `GET/POST /api/sessions`, `DELETE /api/sessions/:id`, `POST /api/sessions/:id/remove`, `GET /api/fs/ls?path=`.

`/ws/events` — send `{t:'snapshot'}` on connect, then forward bus events; 30s heartbeat.
`/ws/term/:id` — send `ringBuffer.read()` as one binary frame on connect, register as viewer, forward client binary frames into `session.write()`; deregister on close; close 4004 on unknown id.

Bind `127.0.0.1:7180` only.

Commit: `feat: rest api and websocket transport`

## Task 10: Terminal view

**Files:** `web/src/hooks/use-terminal.ts`, `web/src/components/terminal-view.tsx`

`Terminal({cols:120, rows:32, convertEol:false, scrollback:5000})` + WebGL addon. Binary WebSocket to `/ws/term/:id`: `onmessage → term.write(new Uint8Array(data))`, `term.onData(d => ws.send(encoder.encode(d)))`.

**Do not call `fit()`** — the PTY is fixed at 120×32. Scale the canvas with `transform: scale(containerWidth / terminalWidth)` and `transform-origin: top left` instead, so multiple viewers never fight over PTY size.

Dispose the terminal and close the socket on unmount.

Commit: `feat: live terminal view with xterm.js`

## Task 11: Sidebar, attention queue, session creation

**Files:** `web/src/hooks/use-events.ts`, `components/{sidebar,attention-queue,session-row,status-dot,harness-icon,new-session-dialog,folder-picker,app-shell}.tsx`

`useEvents()` — one WebSocket to `/ws/events`, reducer over `ServerEvent`, exponential-backoff reconnect, returns `{sessions, connected}`.

`AttentionQueue` — `sessions.filter(s => s.status === 'waiting_input')` sorted by `statusChangedAt` ascending, rendered only when non-empty.

`NewSessionDialog` — harness select + folder picker over `/api/fs/ls` → `POST /api/sessions`.

`AppShell` — 280px sidebar; main pane header shows harness · cwd · elapsed with kill/restart.

Commit: `feat: sidebar, attention queue, session creation`

## Task 12: Quick actions

**Files:** `web/src/components/quick-actions.tsx`

When `status === 'waiting_input' && actions?.length`, render a button row beneath the terminal. Clicking sends `action.keys` down the terminal WebSocket — byte-identical to typing it, no special path.

Commit: `feat: quick action buttons for blocked sessions`

## Task 13: Desktop notifications

**Files:** `web/src/hooks/use-notifications.ts`, `components/settings-dialog.tsx`

Request permission behind an explicit button. On a `notify` event, if permission is granted and either the tab is hidden or the event targets a non-active session, fire `new Notification(title, {body, tag: sessionId})` — `tag` collapses repeats per session. `onclick` → `window.focus()` + route to that session. Server-side 30s cooldown per `(sessionId, kind)`; per-harness and per-kind mutes in `localStorage`.

Commit: `feat: desktop notifications for session events`

## Task 14: Polish and verification

**Files:** `README.md`

Empty states, disconnected banner, `⌘K` session switcher, `⌘N` new session. README covering setup, `harnesses.yaml` format, adding a harness, recording a fixture.

Run `npm run typecheck && npm test`.

Commit: `feat: polish and documentation`

---

## Risks

| Risk | Mitigation |
|---|---|
| `node-pty` native build fails | Verified in Task 1 before anything depends on it |
| Detection regexes wrong for real CLIs | Task 6 replaces guesses with fixture-verified rules |
| xterm.js leaks across session switches | Explicit `dispose()` in `useTerminal` cleanup |
| TUIs misbehave at fixed 120×32 | Escape hatch: "resize to my viewport" button, deferred unless it bites |
