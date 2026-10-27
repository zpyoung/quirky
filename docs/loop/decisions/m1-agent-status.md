# m1-agent-status decisions

## D1: This item covers the dot, the hooks, provider capture and the fallbacks; the Activity view and the Agent Dashboard are out
- **Question:** which of agent-status.md's flows this item owns (brainstorming, scope check)
- **Options:** every flow in the doc; the roadmap's five bullets plus the flows they need (read a dot, toggle hooks, stop with Esc or Ctrl+C); only the roadmap bullets with no UI
- **Chose:** the roadmap's five bullets plus flows 1, 4 and 5 of the doc. Flows 2 and 3 (Activity view, Mark all read, Clear completed) and the experimental Agent Dashboard are non-goals, left to m7-parity-sweep. Unread state belongs to m1-notifications.
- **Why:** the item title and roadmap M1 name only the state machine, installers, provider capture, title/OSC fallback and OSC 7501. LOOP.md says a slice item names the doc's other flows as non-goals. A dot nobody can read and a hooks switch nobody can flip would leave the bullets unusable, so flows 1, 4 and 5 come along.
- **Evidence:** docs/roadmap.md M1 "Agent status"; agent-status.md "What the user can do"; docs/loop/queue.json (no other item names the Activity view; m7-parity-sweep takes "every remaining flow")
- **Reversibility:** easy
- **Confidence:** medium
- **Revisit if:** the M1 exit test ("a full day of agent work runs in Quirky") needs the Activity view
- **Source:** assumed — autonomous

## D2: The status row is keyed by Quirky session, and the session ID from the hook's environment is the pane identity
- **Question:** what Orca's pane key becomes in Quirky (brainstorming, conceptual model)
- **Options:** a pane key like Orca's; the Quirky session ID
- **Chose:** one row per session, found by `QUIRKY_SESSION_ID`, which every session PTY already carries and the hook shim already sends.
- **Why:** a Quirky session is one PTY, the unit Orca's pane key names. Launch-token fencing and tab-prefix teardown have nothing to do because session IDs are never reused.
- **Evidence:** packages/daemon/src/launch.ts:86-90; packages/daemon/src/server.ts:33-55
- **Reversibility:** hard
- **Confidence:** high
- **Source:** assumed — autonomous

## D3: `quirky.agent-status` owns the status row; `quirky.session` keeps a coarse status plus a summary for the UI
- **Question:** where the full state lives and how the window learns it (brainstorming, data flow)
- **Options:** widen `SessionStatus` to every state; keep the row in agent-status and push a summary onto the session through a public method; make the session window call agent-status directly
- **Chose:** agent-status keeps the full row in its own store. It sets the coarse `Session.status` as today (working; waiting for waiting and blocked; done) and passes a small `agentStatus` summary through `quirky.session/setStatus`, which the session record carries for the window.
- **Why:** m0-core D5 gives agent-status the hooks and status, and setStatus is the one status writer. Widening `SessionStatus` would ripple through every client and the dock badge. A summary on the session keeps the tab and worktree dots in the plugins that draw them, with only public methods between them.
- **Evidence:** docs/loop/decisions/m0-core.md D5; plugins/quirky.session/src/sessions.ts:307-318; apps/desktop/src/bun/events.ts:16
- **Reversibility:** medium
- **Confidence:** medium
- **Revisit if:** another consumer needs fields beyond the summary often enough that it calls agent-status anyway
- **Source:** assumed — autonomous

## D4: Orca's four states, its derived display states and its labels are kept as they are
- **Question:** the state vocabulary (brainstorming, gray area "state model")
- **Options:** Orca's `working | waiting | blocked | done` with monitoring, outcomes and freshness-derived states; a smaller set
- **Chose:** Orca's. The display states are working, monitoring, blocked, waiting, permission, interrupted, failed, done, idle, unverifiable and unconfirmed, with Orca's tooltip labels ("Working", "Monitoring background tasks", "Blocked", "Waiting for input", "Needs attention", "Interrupted", "Failed", "Done", "Idle", "No recent update", "Couldn't confirm").
- **Why:** the doc's state vocabulary is the requirement, and the roadmap asks for "the full state machine"
- **Evidence:** agent-status.md "What the user can do" 1, "Normalization and the state machine"
- **Reversibility:** hard
- **Confidence:** high
- **Source:** locked by docs/roadmap.md

## D5: Every hook source in the doc gets a normalizer with Orca's event mapping
- **Question:** which agents' hook events are understood (brainstorming, scope)
- **Options:** Claude and Codex only; the 28 sources plus OpenClaude
- **Chose:** all 28 source IDs in the doc plus `openclaude` as its own source, each mapped exactly as the doc's "Exact hook-to-state mapping" says. qwen-code reuses the Claude rules under its own agent name.
- **Why:** the doc is the requirement. Orca posts OpenClaude as `claude` and can't tell them apart (an open question in the doc); a separate source ID removes the guess.
- **Evidence:** agent-status.md "Exact hook-to-state mapping", "Open questions"
- **Reversibility:** easy
- **Confidence:** high
- **Source:** locked by research/orca-features/agent-status.md

## D6: Hooks are installed into each agent's own config, automatically while the switch is on, except Claude
- **Question:** where installers write, and when (brainstorming, gray area "installer surface"; approaches A/B/C)
- **Options:** (A) Orca's model: write each agent's global config at start for detected agents, remove when the switch goes off; (B) per-launch overlays only (flags or env pointing at Quirky-owned files); (C) only an explicit command, never automatic
- **Chose:** A, with Claude kept on its per-launch `--settings` file. `quirky agent-status hooks setup [agent]` is the one rerunnable command per agent the roadmap asks for; it also runs at plugin start for every detected, enabled agent while the "Agent status hooks" switch is on. Start never removes.
- **Why:** most of the 23 CLIs have no per-launch config (B covers a handful), and hooks must also fire for an agent typed by hand in a Quirky shell. C would leave a fresh install with no status. The hook command exits at once outside a Quirky session, so a global hook costs a non-Quirky run nothing. Claude stays per-launch because v1.md says the user's own `~/.claude` is never edited and M0 kept v1's behaviour.
- **Evidence:** agent-status.md "How each agent reports", "Edge cases" (hooks turned off); v1.md "Claude"; research: claude-code-toolkit #192, aiur #6505 (merge per entry, remove only own entries)
- **Reversibility:** medium
- **Confidence:** medium
- **Revisit if:** a user objects to Quirky editing global agent configs, or a Claude typed by hand in a shell needs status
- **Source:** locked by research/orca-features/agent-status.md

## D7: Codex hooks go into `~/.codex/hooks.json` and the user approves them once in Codex
- **Question:** how Codex's per-hash hook trust is handled (brainstorming, installer surface)
- **Options:** write approval hashes into `config.toml` as Orca does; pass `--dangerously-bypass-hook-trust`; install and let Codex ask the user once through its `/hooks` review
- **Chose:** install and leave approval to Codex; `hooks setup codex` prints that Codex will ask to review the hooks once. The per-launch `notify` hook stays, so a turn's end is reported even before approval.
- **Why:** Orca's hash flow is unverified in the doc and Codex's hash format is undocumented; the bypass flag would also skip trust for project hooks the user never saw.
- **Evidence:** agent-status.md "How each agent reports" (codex row, "[UNVERIFIED: exact approval flow]"); Codex hooks docs (learn.chatgpt.com/docs/hooks, "Trust")
- **Reversibility:** easy
- **Confidence:** medium
- **Revisit if:** Codex documents its hook hash, or users find the review step confusing
- **Source:** assumed — autonomous

## D8: Installers merge only their own entries, keep the file byte-identical on a rerun, and never write a file they can't parse
- **Question:** installer safety rules (brainstorming, gray area "error handling")
- **Options:** overwrite the hooks block; merge per entry keyed by Quirky's command
- **Chose:** merge per entry: Quirky's entries are found by the Quirky hook command they run, other keys and other tools' hooks are kept, a second run changes nothing and reports no files, and a file that fails to parse is left alone with status `error` and the parse message. Writes are atomic. The command prints every file it changed.
- **Why:** Orca preserves unrelated keys and refuses unparseable configs; the research shows install-once copies, remove-by-event and EOL churn as the common installer bugs
- **Evidence:** agent-status.md "Edge cases" (user edits an agent config); research: claude-code-toolkit #192, code-conductor #96, aiur #6505
- **Reversibility:** easy
- **Confidence:** high
- **Source:** locked by research/orca-features/agent-status.md

## D9: Claude's settings file lists only the events the installed Claude knows
- **Question:** how to avoid an older Claude discarding the whole settings file (brainstorming, edge cases)
- **Options:** always write every event; gate each event on the Claude version, treating an unknown version as the oldest tolerated
- **Chose:** gate on the version Claude reports (`claude --version`, read once per binary path and cached), using Orca's first-version table; an unresolved version gets the events of 1.0.64.
- **Why:** the doc records that older Claudes drop the whole file on an unknown event
- **Evidence:** agent-status.md "Edge cases" (Claude version too old); Orca src/main/claude/claude-hook-event-versions.ts
- **Reversibility:** easy
- **Confidence:** high
- **Source:** locked by research/orca-features/agent-status.md

## D10: The hook shim answers each agent the way that agent needs, spools when the daemon is down, and never blocks
- **Question:** what `quirky-hook` prints and does on failure (brainstorming, edge cases)
- **Options:** keep v1's silent post-and-exit; Orca's behaviour (print a permissive answer, spool on failure, exit 0)
- **Chose:** Orca's: print `{}` for Claude-style agents, Cursor's permissive per-event answer, and `{"decision":"ask"}` for Antigravity's PreToolUse; exit at once outside a Quirky session or when `CLAUDE_JOB_DIR` is set; post with a short timeout; on failure append the payload to a spool file for the session, except tool events; the plugin replays the spool when it next starts. Installed hook entries carry a short timeout where the agent's format has one.
- **Why:** the doc lists each of these as edge-case behaviour; the research shows a listener with no timeout stalling an agent for 600 s
- **Evidence:** agent-status.md "Wire protocol" (hook script, spool), "Edge cases"; research: vibe-island #265
- **Reversibility:** easy
- **Confidence:** high
- **Source:** locked by research/orca-features/agent-status.md

## D11: A different provider session in a live row is a nested agent and is ignored, which fixes Orca's helper-overwrite defect
- **Question:** how to stop a helper Claude (spawned by another hook) from taking over the row (brainstorming, defects)
- **Options:** Orca's rule (only a different agent kind is foreign); also treat a different provider session ID of the same agent as foreign unless the session's lead has ended, the event starts a new session in place (clear or resume), or the row is stale
- **Chose:** the second. The first provider session seen becomes the lead. Events from another provider session are ignored while the lead's row is fresh and its process has not ended, except a SessionStart with source `clear` or `resume`.
- **Why:** the doc observed a memsearch helper's Claude retitle and flip a finished row to Working; Orca's kind-only rule can't catch a same-kind helper
- **Evidence:** agent-status.md "Verified in the app" (helper processes), "Edge cases" (nested CLIs)
- **Reversibility:** medium
- **Confidence:** medium
- **Revisit if:** a real agent changes its session ID mid-run without a SessionStart
- **Source:** assumed — autonomous

## D12: The provider session ID and transcript path are captured from hooks into `quirky.session/setProviderSession`
- **Question:** how capture works (brainstorming, provider capture)
- **Options:** capture in agent-status and store on the session; a separate table
- **Chose:** agent-status reads the ID and transcript path per source as Orca's `extractAgentProviderSession` does and calls `setProviderSession` when they change, only for the lead (D11). Sources Orca captures nothing for (amp, command-code, hermes) capture nothing.
- **Why:** m1-providers D26 built the setter for this item; resume reads the session record
- **Evidence:** docs/loop/decisions/m1-providers.md D26; Orca src/shared/agent-session-resume.ts:196-289
- **Reversibility:** easy
- **Confidence:** high
- **Source:** locked by docs/loop/decisions/m1-providers.md

## D13: Cold-restore resume stays out
- **Question:** m1-providers D27 asked to revisit cold-restore resume once provider sessions are captured
- **Options:** resume a lost agent session's provider session on restore; keep restore opening a shell
- **Chose:** keep it out. With capture in place, `quirky session resume <id>` works on a lost session by hand.
- **Why:** restore is m1-term-daemon's flow (its D7: the agent becomes `shell`), and changing it isn't in this item's bullets
- **Evidence:** docs/loop/decisions/m1-providers.md D27; docs/loop/decisions/m1-term-daemon.md D7
- **Reversibility:** easy
- **Confidence:** medium
- **Revisit if:** the M1 exit test loses agent sessions to reboots
- **Source:** supersedes m1-providers D27

## D14: The fold keeps a finished lead `working` while children or background work live
- **Question:** how subagents and background work affect the row (brainstorming, state model)
- **Options:** ignore children; Orca's fold
- **Chose:** Orca's fold: a lead waiting or blocked wins; else a child waiting on a human makes the row waiting; else a live lead state wins; a done lead with live agent children stays working, with only shells or crons it is working in monitoring mode, else done. A cancel is the lead's outcome only. Children come from SubagentStart/SubagentStop and `agent_id` events (Claude, qwen-code, Codex), and Grok's background tasks from its payload.
- **Why:** the doc names the fold as one of the two ideas that matter most
- **Evidence:** agent-status.md intro, "The fold"
- **Reversibility:** medium
- **Confidence:** high
- **Source:** locked by research/orca-features/agent-status.md

## D15: Codex rollout polling, the Muse session log and prompt text read from transcripts are left out
- **Question:** Orca's file-reading follow-ups (Codex rollouts every 1 s, Muse's log, Antigravity/Command Code/jcode prompts from transcripts, the assistant-message retry)
- **Options:** port them; leave them out
- **Chose:** leave them out. Codex children come from its Subagent hooks only; a Muse question shows as working; those agents' rows have no prompt text.
- **Why:** each one reads another program's private file format, and none changes the four states except Muse's question. Their hooks carry the state.
- **Evidence:** agent-status.md "Exact hook-to-state mapping" (codex, muse, antigravity, command-code, jcode), "Server-side application" step 9
- **Reversibility:** easy
- **Confidence:** medium
- **Revisit if:** Codex children or Muse questions show wrong states in daily use
- **Source:** assumed — autonomous

## D16: Freshness follows Orca: a silent live row decays on the reader's clock, never to done
- **Question:** what silence does (brainstorming, gray area "freshness")
- **Options:** Orca's 30-minute rule; a shorter grace that settles to done
- **Chose:** Orca's: a non-done row with no evidence for 30 minutes shows `unverifiable` ("No recent update") while the session runs and `idle` when it doesn't; it is never moved to done by time. The decay is computed when read; the stored row is unchanged.
- **Why:** the doc states it; cmux and agent-orchestrator settled to idle after a grace and then mis-showed long turns
- **Evidence:** agent-status.md "Freshness"; research: agent-orchestrator #6172, cmux #20564
- **Reversibility:** easy
- **Confidence:** high
- **Source:** locked by research/orca-features/agent-status.md

## D17: Rows survive a daemon restart and come back unconfirmed
- **Question:** persistence (brainstorming, data)
- **Options:** memory only; persist and hydrate as Orca does
- **Chose:** persist rows in the plugin store; on start drop rows older than 7 days and rows of removed sessions, and mark every non-done row `restoredUnconfirmed` ("Couldn't confirm") until a live event arrives.
- **Why:** Quirky's daemon restarts while the PTY host keeps agents running, which is the case the doc's hydration handles
- **Evidence:** agent-status.md "Persistence", "Hydration"; docs/architecture.md "Processes"
- **Reversibility:** easy
- **Confidence:** high
- **Source:** locked by research/orca-features/agent-status.md

## D18: Esc and Ctrl+C are read from session input to infer an interrupt, with Orca's guards
- **Question:** how a turn cancelled without a hook ends (brainstorming, inference)
- **Options:** no inference; infer from input written to the session
- **Chose:** infer. The kernel tells plugins about input written to a session (a new public PTY API); 500 ms after a lone Esc or Ctrl+C, a row still working with the same prompt and times becomes done with `interrupted` and outcome cancellation. Orca's per-agent rules apply (Ctrl+C ignored for codex and droid; Esc not evidence for claude, codex, omp, pi or prime-agent; opencode, opencode2 and copilot need two Escapes).
- **Why:** the doc's flow 5; the research confirms Claude sends no Stop on Esc
- **Evidence:** agent-status.md "Inference when a hook is missing"; research: agent-orchestrator #6131, cmux #20564
- **Reversibility:** easy
- **Confidence:** medium
- **Revisit if:** typing in the window lags from the input fan-out
- **Source:** locked by research/orca-features/agent-status.md

## D19: A Claude question answered in the terminal clears waiting
- **Question:** Orca's question-answered inference
- **Options:** port it; leave it
- **Chose:** port it: when a Claude row is waiting on AskUserQuestion and Enter is written to the session, the row returns to working (or the stashed state).
- **Why:** listed in the doc's inference section; it uses the same input fact as D18
- **Evidence:** agent-status.md "Inference when a hook is missing"
- **Reversibility:** easy
- **Confidence:** medium
- **Source:** locked by research/orca-features/agent-status.md

## D20: Process presence comes from the hook's parent process, probed while a row is live
- **Question:** how an agent that exits without SessionEnd stops showing working (brainstorming, edge cases; m1-term-daemon D22 deferred foreground process tracking here)
- **Options:** Orca's process-identity probe; foreground process group tracking in the PTY host; nothing
- **Chose:** the hook shim sends its parent PID; agent-status probes a live row's PID on a schedule, and when the agent is gone the row is reconciled as the doc's SessionEnd rule does. Session exit also ends the row. Foreground process tracking for close confirmation stays with m1-term-ui.
- **Why:** SessionEnd is unreliable (crash, print mode), and a Claude run inside a shell session outlives no PTY exit. Status needs only "is the agent alive", not the foreground group.
- **Evidence:** agent-status.md "Process lifetime"; docs/loop/decisions/m1-term-daemon.md D22; research: claude-code #79702, agent-manager.dev
- **Reversibility:** easy
- **Confidence:** medium
- **Revisit if:** m1-term-ui needs a foreground-process API anyway
- **Source:** assumed — autonomous

## D21: Terminal titles fill in only for sessions with no fresh hook row
- **Question:** title fallback precedence (brainstorming, gray area "fallback precedence")
- **Options:** titles always; titles only where hooks are silent
- **Chose:** Orca's: a title change classified as working, permission or idle sets a title-sourced row only when the session has no fresh hook row; working maps to working, permission to the "Needs attention" state, idle to done. Classification ports Orca's documented glyph and keyword rules.
- **Why:** the doc's precedence; hooks are authoritative
- **Evidence:** agent-status.md "Other status producers" (terminal titles); docs/loop/decisions/m1-term-daemon.md D16 (title events)
- **Reversibility:** easy
- **Confidence:** medium
- **Source:** locked by research/orca-features/agent-status.md

## D22: OSC 7501 is parsed in the PTY host, answered there, and yields to hooks for 2 minutes
- **Question:** where OSC 7501 is read and how it ranks (brainstorming, fallback precedence)
- **Options:** a plugin subscribes to raw bytes for every session; the host scanner emits a fact and answers the probe
- **Chose:** the host's scanner, which already sees every byte of every session, parses OSC 7501 reports into a new fact and replies to the `?` probe with the states and kinds it accepts. Agent-status keeps records per session, and the root record drives the row only when hooks are off, not installed, or silent for 2 minutes on a state the program has left. Progress and message ride along as a facet that never decides state.
- **Why:** subscribing every session to raw bytes would keep a decoder per session in the daemon; the scanner already parses OSC split-safely. Precedence is the doc's.
- **Evidence:** agent-status.md "Other status producers" (OSC 7501); Program Status Protocol rev 0.4 (superlogical.com/rex/docs/build/program-status); docs/loop/decisions/m1-term-daemon.md D16
- **Reversibility:** medium
- **Confidence:** medium
- **Source:** locked by docs/roadmap.md

## D23: OSC 9999 and the agent-state-rules engine are not built
- **Question:** Orca's other status producers
- **Options:** port them; leave them
- **Chose:** leave them. OSC 9999 is Orca's private sequence that only Orca's own integrations emit; the rules engine feeds `terminal wait` and composer readiness, not the dot.
- **Why:** OSC 7501 is the public protocol the roadmap names; the rules engine belongs to orchestration's waits
- **Evidence:** agent-status.md "Other status producers"
- **Reversibility:** easy
- **Confidence:** medium
- **Revisit if:** m6-orchestration needs `tui-idle` waits
- **Source:** assumed — autonomous

## D24: Plugin-type integrations are written as files for Amp, Hermes, the OpenCode family and the Pi family
- **Question:** agents with no hook file (installer surface)
- **Options:** title and OSC only; write their plugin or extension files as Orca does
- **Chose:** write them: Amp's TypeScript plugin, Hermes's Python plugin (enabled in its config), the OpenCode-family JS plugin and the Pi-family extension, each posting the doc's events to the Quirky hook endpoint. Paths follow Orca; the global default config dirs are used rather than per-launch overlays.
- **Why:** parity; the doc lists these as how those agents report
- **Evidence:** agent-status.md "How each agent reports" (amp, hermes, opencode, mimo-code, pi rows)
- **Reversibility:** easy
- **Confidence:** medium
- **Revisit if:** an agent's plugin API differs from what Orca's source assumes
- **Source:** locked by research/orca-features/agent-status.md

## D25: Hook installation reports Orca's skip reasons
- **Question:** what `hooks status` and `hooks setup` say for agents they skip
- **Options:** silent skip; Orca's reasons
- **Chose:** per agent: `installed`, `not-installed`, `agent_disabled`, `cli_not_found`, `hooks_disabled` or `error` with a message, and the files each install wrote.
- **Why:** the doc lists these reasons; cmux's setup also prints a summary for skipped agents
- **Evidence:** agent-status.md "How each agent reports"; cmux README "hooks setup"
- **Reversibility:** easy
- **Confidence:** high
- **Source:** locked by research/orca-features/agent-status.md

## D26: The "Agent status hooks" switch keeps Orca's copy, with Quirky's name
- **Question:** the setting's text and default
- **Options:** Orca's copy verbatim; Orca's copy with "Quirky"
- **Chose:** title "Agent status hooks", description "Shows working, waiting, and done states in Quirky. Turn off to remove Quirky-managed hooks and stop reinstalling them.", default on. Off runs every remover; on installs for detected agents.
- **Why:** parity, with the product name changed
- **Evidence:** agent-status.md "Where to find it" (Settings > Agents)
- **Reversibility:** easy
- **Confidence:** high
- **Source:** locked by research/orca-features/agent-status.md

## D27: Notifications ignore session boundaries and replays
- **Question:** which transitions notify (the plugin already notifies on done and waiting)
- **Options:** every done or waiting; skip `sessionBoundary` rows and spool replays
- **Chose:** skip them; blocked notifies like waiting. Cooldown, unread and sounds stay with m1-notifications.
- **Why:** the doc says completion consumers ignore boundary rows and replays
- **Evidence:** agent-status.md "Transition summary", "Dependencies on other features"
- **Reversibility:** easy
- **Confidence:** high
- **Source:** locked by research/orca-features/agent-status.md

## D28: The waiting detail is readable text, never a raw payload
- **Question:** the doc's dashboard defect (a permission card showing `{"approval":...}`)
- **Options:** show the stored tool input as is; render `<tool>: <input summary>`
- **Chose:** the row's detail is `<tool name>: <tool input summary>` (or the question text), capped as Orca caps; a test shows no JSON object text in it.
- **Why:** the defect is recorded in the doc; the tooltip and `get` carry the same detail
- **Evidence:** agent-status.md "Verified in the app" (Dashboard, surprise 2)
- **Reversibility:** easy
- **Confidence:** high
- **Source:** locked by docs/roadmap.md

## D29: Remote hosts, Windows hook launchers and Claude's statusLine are out
- **Question:** the doc's remaining mechanisms
- **Options:** include; leave out
- **Chose:** leave out SSH/WSL relays (no remote feature yet), the Windows `.cmd`/exe launchers and `%APPDATA%` paths, and Claude's statusLine telemetry (session-info).
- **Why:** other items own them; macOS only for now
- **Evidence:** agent-status.md "Remote hosts", "Edge cases" (Windows); docs/loop/LOOP.md "Platforms"
- **Reversibility:** easy
- **Confidence:** high
- **Source:** deferred: platform

## D30: The plugin exposes `list`, `get`, `hooks status`, `hooks setup` and `hooks remove`
- **Question:** the CLI command group (gray area "CLI output and flags")
- **Options:** generated commands only; hand-written `hooks` commands that print changed files
- **Chose:** methods `list` (gains the state fields), `get {session}`, `hooksStatus`, `hooksSetup {agent?}`, `hooksRemove {agent?}`; CLI `quirky agent-status list|get|hooks status|hooks setup [agent]|hooks remove [agent]`. Setup and remove print one line per changed file and a summary per agent, and exit 0 when an agent is merely skipped. Remove is not confirmed through an ask, since setup restores it.
- **Why:** every built-in exposes its methods and a CLI group (roadmap); cmux's command shape
- **Evidence:** docs/roadmap.md "What the order rests on" (scriptable); cmux README
- **Reversibility:** easy
- **Confidence:** medium
- **Source:** assumed — autonomous

## D31: The dashboard's "0 total" defect gets no test in this item
- **Question:** LOOP.md asks for a test per recorded Orca defect; one defect lives in the Agent Dashboard
- **Options:** build enough of the dashboard to test it; record it against the flow that owns it
- **Chose:** record it. The helper-overwrite defect (SC-13) and the raw-payload detail (SC-32) are tested here; the dashboard's hidden idle bucket is tested with the dashboard.
- **Why:** the defect is in a non-goal flow (D1); a test needs the board it describes
- **Evidence:** agent-status.md "Verified in the app" (Dashboard, surprise 1)
- **Reversibility:** easy
- **Confidence:** medium
- **Revisit if:** m7-parity-sweep builds the dashboard
- **Source:** assumed — autonomous

## D32: Installed hook commands check the shim exists first
- **Question:** what a global hook does after Quirky is removed (raised by option-validation research)
- **Options:** run the shim path directly; guard it so a missing shim exits 0
- **Chose:** guard it. Each installed command runs the shim only if it is executable, else exits 0 with no output.
- **Why:** Orca and Kosmos users were left with hooks calling a missing command after uninstalling
- **Evidence:** research: orca #28667, kosmos #5998
- **Reversibility:** easy
- **Confidence:** high
- **Source:** assumed — autonomous

## D33: Approach A (global installers) over per-launch overlays or a manual-only command
- **Question:** brainstorming's "propose 2-3 approaches" step
- **Options:** (A) Orca's global installers, automatic while the switch is on; (B) per-launch overlays only; (C) explicit command only
- **Chose:** A, as D6 details.
- **Why:** option research found no per-launch hook switch for most CLIs (OpenCode, Gemini and Codex merge layers but Gemini and the rest have no documented per-run hook file); hooks typed-by-hand agents need; C leaves a fresh install without status. A's known costs (other tools overwriting the file, uninstall leftovers, Codex trust) are covered by reinstall at start, D32 and D7.
- **Evidence:** research: opencode.ai/docs/config, claude-code #11392, orca #16771, codex #21615
- **Reversibility:** medium
- **Confidence:** medium
- **Source:** assumed — autonomous

## Progress
Step 4: logic spec written (docs/quirk/specs/2026-10-26-m1-agent-status/logic.md). Next: commit it, write tech.md, then one adversarial review of both with Codex.
