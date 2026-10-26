# m1-term-daemon decisions

## D1: Classify the item as API, CLI and Data design, and run every research phase
- **Question:** which domains the gray-area catalog draws from, and whether the research swarms run (quirk:brainstorming, checklist step 2)
- **Options:** one domain; several; skip research
- **Chose:** API (the PTY host protocol and the `quirky.terminal` methods agents call), CLI (the `terminal` command group and session listing), Data (the on-disk history, checkpoints and their recovery). Phase A ran two web-research agents (persistent PTY host patterns; pitfalls and post-mortems) and an Explore agent over the session and terminal plumbing.
- **Why:** the item's consumers are the daemon's plugins, agents at a shell and the terminal pane; the person sees it only through restored screens and the Manage Sessions list. No earlier item researched terminal persistence.
- **Evidence:** docs/loop/queue.json m1-term-daemon; docs/roadmap.md M1
- **Reversibility:** easy
- **Confidence:** high
- **Source:** assumed — autonomous

## D2: Skip the visual companion and the adhd offer, use the standard gray-area set
- **Question:** brainstorming's visual companion offer and its Step 0 adhd offer
- **Options:** run them; skip them
- **Chose:** skip both
- **Why:** LOOP.md says to skip the parts that assume a person is there
- **Evidence:** docs/loop/LOOP.md "Skip the parts that assume a person is there"
- **Reversibility:** easy
- **Confidence:** high
- **Source:** locked by docs/loop/LOOP.md

## D3: Keep m1-term-daemon as one item, and put the Manage Sessions flows in it as a panel
- **Question:** brainstorming's scope check, and whether the doc's Manage Sessions flows (kill one, kill all, restart) belong to this item or to m1-term-ui
- **Options:** one spec covering the host features only; one spec covering the host features plus the Manage Sessions flows; split into two items
- **Chose:** one spec pair with both. Manage Sessions becomes a `quirky.terminal` panel, "Terminal Sessions", because Quirky has no plugin-contributed settings section and panels are the code-backed slot plugins already use.
- **Why:** LOOP.md makes each in-scope flow of the item's doc an acceptance criterion, and term-daemon.md lists kill one, kill all and restart as flows 4 to 6. term-ui.md points Manage Sessions back at the daemon doc ("Management channels ... belong to Settings → Terminal → Manage Sessions; see the daemon doc").
- **Evidence:** term-daemon.md "What the user can do" 1-7; term-ui.md line 373; packages/protocol/src/ui.ts:4 (UI kinds, no settings section)
- **Reversibility:** easy
- **Confidence:** high
- **Source:** locked by docs/loop/LOOP.md

## D4: Select every gray area that matters: response shape, errors, versioning, paging, CLI output and flags, exit codes, recovery, retention
- **Question:** which gray areas to drill into (brainstorming Step 1)
- **Options:** the catalog's API, CLI and Data areas, three or four of them; all that bear on this item
- **Chose:** API response-format, error-responses, versioning, pagination; CLI output-format, flag-design, exit-codes; Data error-handling, idempotency, retention
- **Why:** LOOP.md says to select every area that matters when no human is present. Each one changes what an agent or the pane sees.
- **Evidence:** docs/loop/LOOP.md "Gray areas"
- **Reversibility:** easy
- **Confidence:** high
- **Source:** locked by docs/loop/LOOP.md

## D5: Attach returns one ready-to-write replay: recent history rows followed by an exact screen snapshot
- **Question:** what `quirky.terminal/attach` returns now that the host has a screen snapshot (response-format)
- **Options:** keep the raw 1 MiB tail replay; return separate snapshot and history fields the pane assembles; return one base64 `replay` that is the history rows then the snapshot, plus structured fields beside it
- **Chose:** the third. `replay` keeps its name and meaning ("write this into a fresh terminal of this size"), now built from the last N history lines and the live screen's serialized state (colors, cursor, alternate screen, bracketed paste, mouse and cursor-key modes). Beside it: `offset`, `historyCursor` (null when nothing older exists), `cols`, `rows`, `restored` and `shellState`.
- **Why:** the pane already writes `replay` behind its input gate (TerminalPane.tsx:86, replayGate.ts), so v1 keeps working with one changed input, and m1-term-ui can page further with `historyCursor`. A raw tail can start mid-escape and loses modes set before it (shpool-vterm #10, sshbox #265).
- **Evidence:** plugins/quirky.terminal/src/terminal.ts:254; research: https://github.com/shell-pool/shpool-vterm/pull/10, https://github.com/triasbrata/sshbox/pull/265
- **Reversibility:** medium
- **Confidence:** high
- **Source:** assumed — autonomous

## D6: Attach history depth is the pane's scrollback setting, 2,000 lines by default
- **Question:** how many history lines the attach replay carries
- **Options:** fixed 2,000; the caller's `historyLines`, defaulting to 2,000, capped at 10,000
- **Chose:** the caller's `historyLines` (the pane passes its scrollback setting), default 2,000, cap 10,000 to match the setting's maximum
- **Why:** architecture.md "Terminal history" says the pane gets the last N lines (2,000 by default) and the renderer never holds more than its window
- **Evidence:** docs/architecture.md "Terminal history"; plugins/quirky.terminal/quirky-plugin.json setting `scrollback` (500..10000)
- **Reversibility:** easy
- **Confidence:** high
- **Source:** locked by docs/architecture.md

## D7: History pages with an opaque cursor, as text by default and ANSI on request
- **Question:** the paged-history contract (pagination, output-format)
- **Options:** line numbers; byte offsets; an opaque cursor; text only; ANSI only; both
- **Chose:** `quirky.terminal/history {session, lines?, before?, format?}` returns `{lines, cursor}`. `lines` defaults to 200 and is capped at 10,000; a page never splits a line, so it may hold a few more rows than asked when long lines wrap. `cursor` is opaque and null at the oldest retained output. `format` is `text` (default, rows with trailing spaces trimmed) or `ansi` (rows with their colors). CLI: `quirky terminal history [session] --lines N --before CURSOR --ansi`, printing rows oldest first, and the next cursor on stderr when one exists.
- **Why:** agents read text; panes need colors. An opaque cursor lets the host change its storage without breaking callers, and the API stays unstable until M7 anyway.
- **Evidence:** docs/architecture.md "Terminal history" ("Scrolling past N pages in more from the log on request"); docs/roadmap.md "Plugin API growth"
- **Reversibility:** medium
- **Confidence:** medium
- **Revisit if:** m1-term-ui needs row-exact paging for its scrollbar
- **Source:** assumed — autonomous

## D8: `quirky.terminal/snapshot` returns the screen as structured JSON for agents and tests
- **Question:** how a non-pane client reads the screen state (response-format)
- **Options:** only `read` (text); a new `snapshot` method with ANSI plus modes, cwd, title, shell state and offset
- **Chose:** add `snapshot {session}` returning `{ansi, cols, rows, cursor: {x, y}, modes: {alternateScreen, bracketedPaste, mouseTracking, applicationCursor}, cwd, title, shellState, offset}`. `read` keeps its shape, and its `lines` of scrollback now come from history instead of a 200-row in-memory scrollback.
- **Why:** roadmap "agents read what the window shows as JSON"; an exact snapshot is what attach serves, so exposing it costs one method and makes the snapshot testable through the API
- **Evidence:** docs/roadmap.md "Everything is scriptable"; packages/pty-host/src/session.ts:231-244
- **Reversibility:** easy
- **Confidence:** high
- **Source:** assumed — autonomous

## D9: Errors: writing to an ended session fails, and a restorable session says how to restore it
- **Question:** error-responses for terminal calls on sessions that ended or were lost
- **Options:** ignore writes silently (today); fail with a conflict; restore on write
- **Chose:** `write` and `send` to an exited session fail with a conflict error "session <id> has exited"; to a restorable one, "session <id> ended when the terminal host stopped; run quirky session restore <id>". `read`, `snapshot` and `history` keep working on ended and restorable sessions, from disk.
- **Why:** a silent drop hides failures from agents (today `SessionManager.write` ignores them, session.ts:162-165). Restoring on write would type an agent's text into a brand-new shell it never saw.
- **Evidence:** term-daemon.md "Write to a dead session" (Orca returns SessionNotFound and an exit event); packages/pty-host/src/session.ts:162
- **Reversibility:** easy
- **Confidence:** high
- **Source:** assumed — autonomous

## D10: Cold restore starts a shell, lazily on attach or on an explicit restore
- **Question:** what cold restore runs and what triggers it (idempotency)
- **Options:** restore every lost session when the daemon starts; restore on first attach or `quirky session restore`; restore on any call
- **Chose:** a session lost with its host stays `exited` and `restorable`. Attaching to it (opening its pane) or `quirky session restore <id>` starts the user's interactive shell in the session's last known cwd (from OSC 7, else its start cwd) at its last size, with the old screen and history above the new prompt and the history file continuing. The session keeps its id; its agent becomes `shell`. Restoring a session that is already running returns it unchanged; restoring one that ended normally fails with a conflict.
- **Why:** term-daemon.md flow 3 and the restart flow: Orca restores into a new shell in the recovered cwd, and panes respawn lazily ("the other workspace's panes respawned when it was opened"). Eager restore would spawn every lost shell at once, which Orca needs a spawn gate to pace. Resuming an agent conversation belongs to m1-providers.
- **Evidence:** term-daemon.md "Reattach and cold restore" and flow 6; docs/loop/queue.json m1-providers
- **Reversibility:** medium
- **Confidence:** medium
- **Revisit if:** m1-providers wants a restored agent session to resume its agent instead of opening a shell
- **Source:** locked by term-daemon.md

## D11: Exit codes are the process's own status; a signal death reports 128+n and names the signal
- **Question:** the exit-code contract (exit-codes), and the Orca defect where `exit 3` was recorded as 0
- **Options:** exit status only, null for signals (today); Orca's synthetic -1; shell convention 128+n plus the signal name
- **Chose:** `exitCode` is the exit status for a normal exit and 128+n for a signal death, with `exitSignal` naming the signal; a session lost with its host has `exitCode` null. Sessions gain `exitCause`: `exited`, `killed` (by Quirky), `host-restart` or `host-lost`, and `restorable`.
- **Why:** matches what `$?` shows in a shell, so a script comparing codes gets the number it expects; a separate cause tells a crash from a kill. Bun's PTY spawn reports `exit 3` as 3 and SIGTERM as signalCode SIGTERM with exitCode null (checked on this machine, Bun 1.4.0), so the current code records null for every signal death.
- **Evidence:** term-daemon.md "Verified in the app" ("Exit codes are masked on macOS"); packages/pty-host/src/session.ts:89
- **Reversibility:** medium
- **Confidence:** high
- **Source:** assumed — autonomous

## D12: Kill one and kill all force-quit immediately and confirm unless `--yes`
- **Question:** the kill flows' API and confirmation (flag-design, exit-codes)
- **Options:** graceful signal then force after 5 s; immediate SIGKILL of the process group; confirm or not
- **Chose:** `quirky.terminal/kill {session}` and `quirky.terminal/kill-all {}` are destructive methods that confirm through an ask unless `yes`. Both SIGKILL the session's process group at once. The session stays as `exited` with cause `killed` and its output kept, not restorable. `kill-all` waits up to 6.5 s and returns `{killedCount, remainingCount, killedSessionIds}`. CLI: `quirky terminal kill <session> [--yes]`, `quirky terminal kill-all [--yes]`.
- **Why:** Manage Sessions' kill is `immediate: true` ("Force-quits {session id}"), and kill-all polls up to 65 x 100 ms. The roadmap makes irreversible actions confirm through `quirky ask` unless `--yes`.
- **Evidence:** term-daemon.md flows 4 and 5; docs/roadmap.md "Agent access"; m0-core D20
- **Reversibility:** easy
- **Confidence:** high
- **Source:** locked by term-daemon.md

## D13: Restart host ends every session as restorable and starts a fresh host
- **Question:** the restart flow's behavior
- **Options:** restart without killing sessions; kill all, restart the host, keep histories restorable
- **Chose:** `quirky.terminal/restart-host {}` (destructive, confirms unless `yes`) ends every session with cause `host-restart`, keeps their history restorable, stops the host process, starts a new one and returns `{pid}`. Open panes reattach and cold-restore. CLI: `quirky terminal restart-host [--yes]`.
- **Why:** term-daemon.md flow 6: "Every session is killed ... History is not marked ended, so panes cold-restore", and the confirm text "Open terminals and agents will restart."
- **Evidence:** term-daemon.md "Manual restart"
- **Reversibility:** easy
- **Confidence:** high
- **Source:** locked by term-daemon.md

## D14: The Terminal Sessions panel mirrors Orca's Manage Sessions
- **Question:** what the person sees for flows 4 to 6
- **Options:** CLI only; a panel with Orca's table and buttons
- **Chose:** panel "Terminal Sessions" listing live host sessions: a status dot, the workspace label (last two cwd segments), the session id, and a per-row kill button. The header shows "Sessions (n)" with Refresh, Kill all sessions (disabled with none) and Restart terminal host. Empty state "No sessions." Clicking a row opens that session. Kill and restart confirm with Orca's dialog text. A command "Terminal: Manage Sessions" opens the panel. `quirky terminal sessions` lists the same rows.
- **Why:** parity with Orca's flows; every UI command needs an API equivalent (roadmap)
- **Evidence:** term-daemon.md "Where to find it"; img/term-daemon/02-manage-sessions.png
- **Reversibility:** easy
- **Confidence:** high
- **Source:** locked by term-daemon.md

## D15: The shell-ready barrier holds input for wrapped zsh and bash shells until the first prompt, 15 s at most
- **Question:** which sessions get the barrier, what is observable, and the timeout
- **Options:** no barrier; barrier for every session; barrier only where Quirky's wrapper can emit a ready marker
- **Chose:** shell sessions on zsh or bash (the shells Quirky already wraps) start `pending`; input written before the first prompt is held in order and delivered when the wrapper's ready marker arrives (`ready`) or after 15 s (`timed_out`). Agent sessions and other shells are `unsupported` and get input at once. The marker never appears in output. `shellState` shows in `snapshot`, `attach` and `quirky terminal sessions`.
- **Why:** term-daemon.md "Shell-ready barrier" (15 s, marker stripped, queued stdin). Quirky has no fish wrapper today (launch.ts writes zsh and bash only) and fish isn't installed on the build machine, so fish stays `unsupported`.
- **Evidence:** packages/daemon/src/launch.ts:22-50,192-201
- **Reversibility:** easy
- **Confidence:** high
- **Source:** locked by term-daemon.md

## D16: The host reports bells, command finishes, titles and cwd as `quirky.terminal` events, whether or not a pane is open
- **Question:** what "Bell and OSC 133" delivers, and to whom
- **Options:** scan in the pane (Orca's renderer); scan in the host and emit events
- **Chose:** the host scans every session's output, split-safely across chunks, and `quirky.terminal` emits `bell {sessionId}`, `command-finished {sessionId, exitCode}` (OSC 133;D), `title {sessionId, title}` (OSC 0/2, on change) and `cwd {sessionId, cwd}` (OSC 7, on change). A BEL that ends an OSC string is not a bell. The zsh and bash wrappers emit OSC 133 A/B/C/D and OSC 7. `quirky.terminal` activates at startup so no event is missed.
- **Why:** architecture.md unmounts hidden panes, so only the host sees every byte; agent-status and notifications (later M1 items) consume these facts (term-daemon.md "Dependencies"). Ghostty fixed an OSC parser that aborted mid-sequence, so split-chunk input gets a byte-at-a-time test.
- **Evidence:** docs/architecture.md "Terminal history"; term-daemon.md event `transientFact`; research: Ghostty osc.zig
- **Reversibility:** medium
- **Confidence:** high
- **Source:** assumed — autonomous

## D17: The PTY protocol goes to 2; an older host is retired on upgrade, a newer one is refused
- **Question:** versioning between quirkyd and quirky-pty
- **Options:** keep exact match and replace any mismatched host; per-version socket names side by side; retire older, refuse newer
- **Chose:** `PTY_PROTOCOL_VERSION` becomes 2 and the hello stays an exact match. When quirkyd meets a host that rejects its hello as an older version, it says hello at that version, sends `shutdown` and starts its own host; those sessions end as `host-restart`. A newer host is left running and quirkyd fails to connect with an error naming both versions.
- **Why:** term-daemon.md asks for "one explicit protocol number and a refusal on mismatch". No released Quirky has a v1 host, so a one-time retire costs only dev sessions, while side-by-side hosts would orphan shells nobody can see.
- **Evidence:** term-daemon.md "Protocol versioning"; packages/pty-host/src/server.ts:144-151
- **Reversibility:** medium
- **Confidence:** medium
- **Revisit if:** a release ships and later protocol bumps need a real adoption path
- **Source:** assumed — autonomous

## D18: History lives until the session is closed, capped at two 16 MiB log segments, checkpointed every 5 s while output changes
- **Question:** retention and checkpoint cadence
- **Options:** Orca's 5 MiB log plus checkpoint; architecture's 16 MiB x 2 segments; age-based pruning
- **Chose:** the architecture's numbers: log rotates at 16 MiB and keeps two segments; a checkpoint (screen plus log position) is written at most every 5 s while the session has new output, and once more when it ends or the host stops; history is deleted when the session is closed (`quirky session close`), as today. No age pruning.
- **Why:** docs/architecture.md fixes the log size and "every few seconds while the session is dirty"; Orca also has no age pruning
- **Evidence:** docs/architecture.md "Terminal history"; term-daemon.md "Retention"
- **Reversibility:** easy
- **Confidence:** high
- **Source:** locked by docs/architecture.md

## D19: Damaged history degrades step by step and never blocks the terminal
- **Question:** error-handling for corrupt or missing checkpoint and log files
- **Options:** fail the restore; degrade
- **Chose:** a torn last log record is dropped and the rest replayed; an unreadable checkpoint means replaying the log alone; an unreadable log means the checkpoint alone; with neither, the session restores as a fresh shell with a one-line note that its history could not be read. A disk error stops history for that session only and is logged; the terminal keeps running. Checkpoints are written to a temp file, fsynced and renamed.
- **Why:** term-daemon.md "History problems" (stepwise fallback, disk errors disable one session's history); research: fsync before rename avoids zero-length files after a crash
- **Evidence:** term-daemon.md "Edge cases"; https://users.rust-lang.org/t/how-to-write-replace-files-atomically/42821/13
- **Reversibility:** easy
- **Confidence:** high
- **Source:** locked by term-daemon.md

## D20: The host keeps no scrollback in memory: a screen-only emulator and a 256 KiB tail per session
- **Question:** per-session memory (the Orca OOM report)
- **Options:** keep 200-row emulator scrollback and a 1 MiB tail (today); architecture's screen-only emulator and 256 KiB hot tail
- **Chose:** the architecture's: emulator scrollback 0, hot tail 256 KiB, everything older read from disk
- **Why:** architecture.md "Per session ... well under 1 MB"; Orca's own comment records a host with 100+ terminals OOM-killed at full depth
- **Evidence:** docs/architecture.md "Terminal history" and "Memory budget"; term-daemon.md "Scrollback model"
- **Reversibility:** easy
- **Confidence:** high
- **Source:** locked by docs/architecture.md

## D21: Two Orca defects get tests: masked exit codes, and unbounded per-session scrollback memory
- **Question:** which recorded Orca defects need a "Quirky doesn't have it" test
- **Options:** only the doc's "Verified in the app" defect; also the OOM the doc's scrollback model records
- **Chose:** both: `exit 3` in an interactive zsh or bash session (and in a `-l -c` agent launch) records 3; and a host with many sessions producing heavy output stays inside a memory bound
- **Why:** LOOP.md requires a test per recorded defect; the doc records both
- **Evidence:** term-daemon.md "Verified in the app" (exit codes) and "Scrollback model" (OOM)
- **Reversibility:** easy
- **Confidence:** high
- **Source:** locked by docs/loop/LOOP.md

## D22: Out of scope: launchd and TCC, Linux scopes, Windows, spawn admission, legacy adapters, two-socket framing, background thinning, foreground process tracking, seed chunking
- **Question:** which of the doc's mechanisms are non-goals (scope boundary)
- **Options:** port them; leave them out and name them
- **Chose:** leave out: the macOS launchd helper and TCC attribution (Quirky's host isn't a signed helper yet), Linux systemd scopes and Windows (`deferred: platform`), the spawn gate and host terminal cap, legacy and newer-protocol adapters, the control/stream socket split and binary-v1 framing (Quirky already frames binary on one socket), background stream thinning and `transientFact` delegation (facts are always scanned in the host instead), foreground process tracking (m1-agent-status), chunked history-seed upload (the host restores from its own files, so no seed crosses the socket), colour-query replies and the daemon log's NDJSON events
- **Why:** each is either another platform, solves a problem Quirky's design doesn't have, or belongs to a later item
- **Evidence:** term-daemon.md sections named; docs/architecture.md "Processes"
- **Reversibility:** easy
- **Confidence:** medium
- **Source:** assumed — autonomous

## D23: Linux and Windows work is deferred
- **Question:** platform scope (LOOP.md platforms rule)
- **Options:** build portable now; macOS only and log the gaps
- **Chose:** macOS only. Gaps: Linux per-terminal systemd scopes, Windows named pipe and ConPTY, fish's wrapper, and process-group signalling on Windows.
- **Why:** LOOP.md "build and test on macOS only"
- **Evidence:** term-daemon.md "Linux per-terminal scopes", "Windows"
- **Reversibility:** medium
- **Confidence:** high
- **Source:** deferred: platform

## D24: History is rendered on read by replaying a bounded window of the log, not stored as rows
- **Question:** the approach for snapshots and paged history (brainstorming step 8, three candidates validated by Phase B research)
- **Options:** (A) a screen-only live emulator, a framed raw log and checkpoints, with history pages rendered on demand by replaying a window of the log through a scratch emulator; (B) a live emulator that exports each row as it scrolls off into a rendered-rows file; (C) no emulator, replaying raw bytes from the last redraw point
- **Chose:** A
- **Why:** it is the architecture's design and keeps one copy of history on disk. Replay is cheap: `@xterm/headless` 5.5 parsed 18.2 MB in 148 ms here (about 120 MB/s), so a 2 MiB page renders in about 20 ms and the whole 32 MiB log in under half a second. B needs a "row left the screen" signal xterm.js doesn't give: `onScroll` fired 100 times inside the alternate screen and for scroll-region scrolls in a local test, and SerializeAddon row ranges have open bugs (#6230, #6233). C loses modes set before the redraw point (shpool-vterm #10, sshbox #265, mulmoterminal #2992), and the architecture keeps it only as the Go fallback. Research also says to record resizes in the log so a replay reflows correctly (Archestra #9660), which A's framed log does.
- **Evidence:** docs/architecture.md "Terminal history"; local measurements in the session scratchpad (sertest/speed.ts, sertest/scroll.ts); https://github.com/archestra-ai/archestra/pull/9660; https://github.com/xtermjs/xterm.js/issues/6230
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** paging deep history in a 32 MiB log is visibly slow in m1-term-ui
- **Source:** locked by docs/architecture.md

## D25: Pin @xterm/headless 5.5.0 and add @xterm/addon-serialize 0.13.0, and test the snapshot's known weak spots
- **Question:** a hard constraint from research: SerializeAddon has open bugs (cursor one column left on a full row #6165, scroll region written after the cursor #6233, mid-sequence snapshot #6234, alt buffer after a column shrink #6228)
- **Options:** ignore; write our own serializer; use the addon pinned and cover the weak spots with tests and small fixes
- **Chose:** use the addon pinned at 0.13.0 (installed and checked against headless 5.5.0 on this machine), position the cursor absolutely after the serialized screen, and give the tech spec a test per weak spot
- **Why:** Orca uses the same addon and works around the same cursor issue with absolute positioning (term-daemon.md "Snapshot format")
- **Evidence:** term-daemon.md "Snapshot format"; https://github.com/xtermjs/xterm.js/issues/6165
- **Reversibility:** easy
- **Confidence:** medium
- **Source:** assumed — autonomous

## D26: Skip Phase C deep research
- **Question:** brainstorming's optional deep validation of the chosen approach
- **Options:** run a deep-research agent; skip
- **Chose:** skip
- **Why:** the approach is the architecture's, Phase B covered its failure modes, and local measurements answered the open performance question
- **Evidence:** D24
- **Reversibility:** easy
- **Confidence:** medium
- **Source:** assumed — autonomous

## D27: All six essentials are covered; fast-track the remaining defaults
- **Question:** brainstorming's essential-coverage gate and the fast-track
- **Options:** ask more; fast-track
- **Chose:** fast-track. Purpose, consumers, success criteria, hard constraints, scope and primary behavior all come from the roadmap, term-daemon.md, architecture.md and the code. Remaining defaults: the checkpoint cadence (D18), history page size 200 (D7), kill-all wait 6.5 s (D12), barrier timeout 15 s (D15), the panel's labels (D14).
- **Why:** LOOP.md treats the user as having elected to accept stated defaults
- **Evidence:** docs/loop/LOOP.md "Answering a skill's questions"
- **Reversibility:** easy
- **Confidence:** high
- **Source:** locked by docs/loop/LOOP.md

## D28: The design sections pass self-review without changes to the decisions above
- **Question:** brainstorming step 9 asks for approval after each design section
- **Options:** wait for approval; self-review and go on
- **Chose:** self-reviewed the conceptual model, data flow, scenarios, scope and glossary against term-daemon.md, architecture.md and D3 to D27, then wrote the logic spec
- **Why:** LOOP.md "Don't wait after presenting a design section. Self-review it, record it, and go on."
- **Evidence:** docs/quirk/specs/2026-10-26-m1-term-daemon/logic.md
- **Reversibility:** easy
- **Confidence:** high
- **Source:** locked by docs/loop/LOOP.md

## D29: Methods and events follow the plugins' camelCase naming; CLI words keep hyphens
- **Question:** the tech-spec survey found the built-ins name methods in camelCase (`setStatus`, `describeRemove`) while the logic spec used `kill-all`, `restart-host` and `command-finished`
- **Options:** keep hyphenated ids; camelCase ids with hyphenated CLI words
- **Chose:** methods `killAll` and `restartHost`, event `commandFinished`; CLI words `kill-all` and `restart-host` through `cli-command` entries. Logic spec amended.
- **Why:** one naming style across the plugin API; CLI words are independent of method ids (`cli-command.words`)
- **Evidence:** plugins/quirky.session/quirky-plugin.json (`setStatus`); plugins/quirky.worktree/quirky-plugin.json:132 (`describeRemove`); packages/daemon/src/plugins/kinds.ts:16-22
- **Reversibility:** easy
- **Confidence:** high
- **Source:** assumed — autonomous

## D30: The panel confirms in the window and calls with `yes`; CLI and agents confirm through the kernel's ask
- **Question:** how the Terminal Sessions panel's kill and restart buttons confirm (D12, D13 make the methods destructive)
- **Options:** let the call raise an ask card; show the panel's own dialog then pass `yes: true`
- **Chose:** the panel's own dialog with Orca's text, then `yes: true`
- **Why:** that is how the worktree panel does it (`plugins/quirky.worktree/src/actions.ts:52-79`), and the window doesn't handle ConfirmationRequired, so an ask card would leave the button looking dead
- **Evidence:** packages/daemon/src/plugins/dispatch.ts:188-193; packages/daemon/src/plugins/confirm.ts:96-114
- **Reversibility:** easy
- **Confidence:** high
- **Source:** assumed — autonomous

## D31: Tech-spec mechanisms: the host renders history windows through a scratch emulator, composes the attach replay by overlaying the live snapshot, and the wrappers report through hooks
- **Question:** the tech spec's riskiest calls
- **Options:** as written in tech.md; alternatives in D24
- **Chose:** a framed segment log with absolute output positions; a cursor that is an output position; the attach replay built by rendering the log window, clearing the scratch screen, writing the live snapshot and serializing with scrollback; zsh `add-zsh-hook` and a bash `PROMPT_COMMAND` plus `DEBUG` trap for OSC 133 and the ready marker
- **Why:** each was prototyped on this machine before writing the spec: the composed replay reproduced scrollback and screen exactly in a fresh terminal; zsh 5.9 and bash 3.2.57 reported `true`, `false` and `exit 7` as 0, 1, 7 with nothing for an empty line, and `exit 3` came through as 3
- **Evidence:** scratchpad sertest/compose.ts, zt.ts, bt.ts (session scratchpad); docs/quirk/specs/2026-10-26-m1-term-daemon/tech.md
- **Reversibility:** medium
- **Confidence:** medium
- **Revisit if:** a user's own `DEBUG` trap or prompt framework breaks the bash integration
- **Source:** assumed — autonomous

## Progress
Step 3 (brainstorm) in progress on `build/m1-term-daemon`.
