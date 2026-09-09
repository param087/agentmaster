# agentmaster

One dashboard for every AI CLI harness running on your laptop — opencode, Claude
Code, Gemini CLI, Codex, Qwen Code, PI, and anything you add later.

Agent CLIs run in terminals you stop watching. Past two of them you lose track:
a session blocks on a permission prompt and sits there for forty minutes because
nobody was looking at that tab. agentmaster mirrors every session into one
browser window, tells you which ones need you, and notifies you when they do.

## How it works

There is no protocol and no per-harness integration. Each harness is spawned in
a **pseudo-terminal**, so it believes a human is sitting at a real terminal —
`isatty()` is true, it renders its full colour TUI, and Ctrl-C arrives as a real
`SIGINT`. Raw bytes stream to xterm.js in the browser and back, unmodified. That
is why arrow-key menus, `⇧Tab` plan mode, `/model`, and Ctrl-C all work
identically for every harness.

In parallel, the same bytes feed a **headless terminal emulator** on the server.
Status detection regexes run against that *rendered screen*, not the byte
stream — harnesses repeatedly overwrite one line with `\r\x1b[K`, so "Thinking…"
stays in the stream forever while being visually erased. Matching the rendered
grid is the only way to see what you would see.

```
browser (xterm.js) ──ws /term/:id (binary)──┐
                                            ├── PtySession ── PTY ── harness
browser (sidebar)  ──ws /events   (JSON)────┘       │
                                                    ├─ ring buffer (2 MB replay)
                                                    └─ screen model → status engine
```

Everything harness-specific lives in `harnesses.yaml`. Adding a CLI is a config
entry. A CLI with *no* entry still gets a working terminal plus busy/idle/exited
from the generic idle timer.

## Requirements

- Node 22+ (developed on 24)
- Whichever harness CLIs you want to drive, on your `PATH`

## Setup

```bash
npm install
npm run dev
```

Open <http://localhost:5273>. The API runs on `127.0.0.1:7180` and Vite proxies
to it.

If `npm install` reports blocked install scripts, approve the native ones —
`node-pty` and `better-sqlite3` need to build:

```bash
npm approve-scripts node-pty better-sqlite3 esbuild
npm rebuild node-pty better-sqlite3
```

> `postinstall` runs `scripts/fix-pty-perms.mjs`, which restores the executable
> bit on node-pty's `spawn-helper`. Without it every spawn fails with an opaque
> `posix_spawnp failed`.

## Using it

- **+ New** — pick a harness and a folder; the session spawns and appears in the sidebar
- **Sidebar** — one dot per session:

| Colour | Status | Meaning |
|---|---|---|
| 🔵 blue (pulsing) | Working | producing output |
| 🟠 amber | Waiting for you | blocked on a menu or permission, **or** it finished its turn — the state that needs action |
| 🟢 green | Done | ran autonomously to completion (e.g. `claude -p`) and you haven't looked yet |
| ⚪ grey | Idle | alive and quiet |
| 🟣 violet | Killed | you pressed Kill |
| ⚫ dim grey | Exited | quit on its own |
| 🔴 red | Error | non-zero exit |

- **Needs attention** — amber sessions, longest-waiting first
- **Quick actions** — when a session is blocked, its harness's answer buttons appear under the terminal. They send keystrokes; a click is indistinguishable from typing.
- **Kill** stops the process but keeps the session listed, so its output stays readable. **Restart** re-runs the same harness in the same folder, reusing the session's slot and clearing the terminal. **Delete** forgets it for good, and **Clear** in the sidebar header forgets every stopped session at once.
- **Notifications** — fired when a session needs you, finishes, or crashes. Enable via the gear icon. Killing a session never notifies — you already know. Desktop notifications work while the tab is open in the background; **Web Push** (gear icon → Phone notifications) reaches you with the app closed.
- `⌘N` new session · `⌘K` cycle the attention queue (Ctrl+Shift on non-Mac, so readline's Ctrl-K/Ctrl-N still reach the harness)

### Amber vs green

Agent CLIs mostly **end their turn** rather than blocking on a prompt, so
"finished, your move" is the common case — and it is amber, because it needs
you either way. Turn-end detection is deliberately **regex-free**: you submitted
something, it produced output, it went quiet. That works for every harness,
including one with no rules at all.

Amber therefore has two flavours, carried in `waitKind`:

- `permission` / `menu` / `question` — a harness rule matched, so the CLI is
  *modally blocked*. It clears only when the harness moves on. **Looking at it
  does not clear it**; the menu is still on screen and the session is still
  stuck.
- `turn` — generic turn-end, no rule involved (`matchedRule` is unset). It is an
  unread marker, so it clears as soon as you actually look at the session.

Green is now only the autonomous case: a long busy stretch with no submit, such
as `claude -p "do X"` launched from `args`.

**Attached is not the same as looking.** A session left open in a background or
minimised tab does not count as seen — the browser sends an explicit focus
message, and only a *focused* viewer acknowledges anything.

**Sessions are killed when the server stops.** This is deliberate for v1: nothing
is persisted across a restart, and in development `tsx watch` restarts the server
on every code change, which is the usual reason sessions vanish unexpectedly.

Within a single run, a stopped session keeps its scrollback so you can read what
happened, and `Restart` brings it back. Its event history survives a restart too,
so the timeline reads as one continuous session rather than losing the earlier
run. Stopped sessions are never pruned automatically — silently deleting history
is worse than a long list — so use **Clear** when the list gets noisy.

## `harnesses.yaml`

```yaml
defaults:
  idle_ms: 2500                  # silence before evaluating status
  finished_after_busy_ms: 20000  # busy longer than this, then idle = "finished"

harnesses:
  - id: claude-code
    name: Claude Code
    command: claude
    args: []
    busy_marker: "esc to interrupt"     # on screen ⇒ still working despite silence
    waiting_input:
      - match: "Do you want to (proceed|make this edit)"
        kind: permission                # permission | question | menu | unknown
        actions:
          - { label: "Yes", keys: "1\r" }
          - { label: "No",  keys: "3\r" }
```

Hot-reloaded on save. A bad regex is logged and the previous config is kept.

Notes:
- Rules are tried in order; first match wins.
- JS `RegExp` has no inline `(?i)`; a leading `(?i)` is stripped and converted to the `i` flag.
- Rendered lines keep leading indentation, so tolerate it: `^\s*❯?\s*\d+\.`
- `keys` are sent verbatim — `"\r"` Enter, `"\u001b"` Esc, `"1\r"` menu choice.

### Adding a harness

Add an entry with `id`, `name`, `command`. That alone gives you a terminal,
busy/idle/exited, and generic turn-end detection. Add `waiting_input` rules to
also catch modal prompts (menus, permissions) and get quick-action buttons.

Harnesses we ship carry their official brand mark. Anything else gets a
monochrome two-letter badge automatically. To reuse an existing mark — say for a
fork or a renamed CLI — set `icon`:

```yaml
- id: my-claude-fork
  name: My Claude Fork
  command: myclaude
  icon: claude-code
```

Icons are monochrome on purpose: in the sidebar, colour means *status*, and a
brand palette beside the amber "needs you" dot would dilute the only signal that
asks you to act. Marks are vendored from [simple-icons](https://simple-icons.org)
(CC0-1.0); regenerate with `npm run icons:sync`.

## Verifying detection against a real CLI

`opencode` and `pi` rules are **verified** against fixtures captured from the
real CLIs (opencode 1.18.30, pi 0.85.1) and asserted in
`server/test/detection.test.ts`. Both auto-approve tool calls, so neither has a
permission prompt — their only modal blocked state is a selection widget.

`claude-code`, `gemini-cli`, `codex` and `qwen-code` are **unverified**
reconstructions that pass synthetic fixtures only. To verify one:

```bash
# unattended: drives the CLI through the running server
npx tsx server/scripts/capture.ts claude-code claude-permission \
  --cwd /tmp/x --send $'edit README.md\r' --wait 30000

# or interactively, driving it yourself in a real terminal
npx tsx server/scripts/record-fixture.ts claude-code claude-permission
```

Then add a row to the table in `server/test/detection.test.ts` and run
`npm test`. If it fails, fix the regex in `harnesses.yaml` — never the fixture.
**Every positive rule needs a matching negative fixture** proving it does not
fire on an idle screen; a false amber is worse than a miss, because it trains
you to ignore the one colour that means "act now".

There is also a live scenario matrix that drives real harnesses end to end
through the HTTP + WebSocket API:

```bash
npx tsx server/scripts/scenarios.ts
```

It asserts the whole journey — startup, done, acknowledgement, waiting, killed.
Close any dashboard tab first: an open tab watches the session and correctly
acknowledges `done` before the script can observe it.

## Notifications not arriving?

They are the whole point of the tool, and they fail silently by default because
the browser requires an explicit grant. In order:

1. **Is permission granted?** If not, the sidebar shows a struck-through bell and
   a banner you cannot dismiss. Click **Enable**. Chrome will not let the page
   ask twice, so if you previously clicked Block you must re-enable it via the
   padlock in the address bar → Site settings → Notifications.
2. **Send a test.** Gear icon → **Send test notification**. If that does not
   appear, the problem is the browser or the OS (check macOS Focus / Do Not
   Disturb), not agentmaster.
3. **Is the kind muted?** Gear icon shows a toggle per kind. Nothing is muted by
   default.
4. **Are you looking at that session?** Notifications are suppressed for the
   session currently on screen in a focused tab — you can already see it. A
   background or minimised tab still notifies.

Notifications only work while the dashboard tab is open. To be told with the app
closed — which is the only useful mode on a phone — turn on **Phone
notifications (push)** in the gear dialog.

## Push notifications on a phone

Push is delivered by the server through your browser's push service, so a
blocked session reaches you with agentmaster closed. Gear icon → **Phone
notifications** → **Enable on this device**, then **Send test push** to prove
delivery. The dialog shows how many devices the server is pushing to; if that
stays at 0, the phone did not register.

**On an iPhone there is one extra step, and it is mandatory.** Safari only
permits Web Push for sites added to the Home Screen (iOS 16.4+) — a normal tab
can never receive a push, whatever you allow. So:

1. Open agentmaster in Safari over **HTTPS** (the Tailscale hostname; a plain
   `http://` LAN address is not a secure context and has no push at all)
2. Tap **Share** → **Add to Home Screen**
3. Launch agentmaster **from the Home Screen icon**, not from Safari
4. Gear icon → **Enable on this device** → allow notifications

Settings detects the tab case and shows these steps instead of a button that
cannot work. Note that iOS forgets everything if you delete the Home Screen
icon: you have to enable push again after re-adding it.

## Commands

```bash
npm run dev         # api + web
npm run dev:server  # api only, 127.0.0.1:7180
npm run dev:web     # vite only, 5273
npm test            # server test suite
npm run typecheck   # server + web
npm run build       # production web bundle
```

## Layout

```
harnesses.yaml            harness registry + detection rules
server/src/
  session/                PtySession (pty + ring buffer + fan-out), SessionManager
  status/                 ScreenModel (headless xterm), StatusEngine (state machine)
  config/                 YAML parsing, validation, hot reload
  db/                     SQLite history
  ws/                     /ws/events (JSON), /ws/term/:id (binary)
  routes/                 REST
web/src/
  hooks/                  use-terminal, use-events, use-notifications, use-push
  components/             shell, sidebar, attention queue, terminal, quick actions
web/public/               PWA manifest, icons, push service worker
```

## Design notes

**The PTY is fixed at 120×32.** Multiple viewers resizing it would fight and
trigger a `SIGWINCH` storm that corrupts the TUI. The browser scales the canvas
down instead, never up.

**Notification policy lives on the server**, including a 30s per-(session, kind)
cooldown. The browser only applies your local mutes.

**The database is history, not state.** Sessions die with the server, so any row
left open on boot is marked exited.

## Not in v1

Remote access, auth, multi-user, session persistence across restarts, cost
tracking.

**The service worker deliberately caches nothing.** The app is a live mirror of
PTYs on a server it must be talking to, so there is no offline story worth
having — and a cached bundle outliving a server upgrade would give you an old
client speaking to a new API, which fails far more confusingly than "the server
is down".
