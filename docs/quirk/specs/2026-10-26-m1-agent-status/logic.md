# Agent status: the full state machine, hook installers, provider capture, title and OSC fallback

## Status & amendments

**Status:** Approved (headless build loop; decisions in [m1-agent-status.md](../../../loop/decisions/m1-agent-status.md)). Tech spec: requested.

**Amendments:**
- 2026-10-26, tech-spec authoring: the hooks switch is the Settings dialog's checkbox, whose
  description is hover text (SC-37); an OpenCode-family interrupt needs a second Esc in the same
  turn, not within 500 ms (SC-20).

## Conceptual model

Quirky v1 turns four Claude hook events and Codex's turn-end notify into a session's `working`,
`waiting` or `done`. Orca ([agent-status.md](../../../../research/orca-features/agent-status.md))
does much more: it hears every lifecycle event of 29 agent CLIs, keeps one status row per pane in a
provider-neutral vocabulary, folds subagents and background work into it, infers interrupts no hook
reports, falls back to terminal titles and OSC 7501 when hooks are silent, and shows the result as a
glyph with a tooltip. This item brings Quirky to that.

**One row per session.** A Quirky session is one PTY, and every session's environment already names
it (`QUIRKY_SESSION_ID`), so the session ID plays the part of Orca's pane key
([D2](../../../loop/decisions/m1-agent-status.md)). `quirky.agent-status` owns the row. The row
holds:

- the **state**: `working`, `waiting` (a human must answer a question or a permission), `blocked`
  (the agent asked for a human in its own words), or `done`;
- for `working`, whether it is only **monitoring** background shells;
- for `done`, the **outcome** (success, `cancellation` or `failure`), whether it was **interrupted**,
  and whether it is a **session boundary** (a new, resumed or cleared session landing idle);
- the turn's **prompt**, the current **tool and its input**, the last **assistant message**, the
  **question** an agent asked, the **model**, and the program's **progress and message** when it
  reports them;
- the **lead** provider session and live **children** (subagents, background tasks);
- **timing**: when the state started, when the latest evidence arrived, when the turn started;
- the **source** of the latest evidence: a hook, a spool replay, the terminal title, OSC 7501 or an
  inference.

**The window shows a display state.** The row's state, plus freshness, gives one of eleven display
states, each with Orca's glyph and label ([D4](../../../loop/decisions/m1-agent-status.md)):

| Display state | When | Label | Glyph |
|---|---|---|---|
| working | state working | Working | spinner |
| monitoring | working, only background shells or crons live | Monitoring background tasks | activity icon |
| waiting | state waiting | Waiting for input | amber question icon |
| permission | the title or OSC says it needs the user, no hook row | Needs attention | amber question icon |
| blocked | state blocked | Blocked | red dot |
| failed | done with outcome failure | Failed | red dot |
| interrupted | done, interrupted or outcome cancellation | Interrupted | muted dot |
| done | done otherwise | Done | green dot |
| unverifiable | live state, no evidence for 30 minutes, session running | No recent update | dashed amber circle |
| idle | live state, no evidence for 30 minutes, session not running | Idle | faint grey dot |
| unconfirmed | a live row restored after a daemon restart, no event since | Couldn't confirm | dashed amber circle |

A progress percentage the program reports replaces the spinner or question icon with a ring.

**The session keeps a coarse status.** `Session.status` stays as v1 has it, so clients that read only
it keep working: `working` for working and monitoring, `waiting` for waiting, blocked and
permission, `done` for done, failed and interrupted. Alongside it the session record now carries the
row's summary (display state, label, detail, progress, and the times freshness needs), set by
agent-status through `quirky.session/setStatus`. The tab and worktree dots draw from that summary
([D3](../../../loop/decisions/m1-agent-status.md)).

**Hooks are installed into each agent's own config.** For 22 agents Quirky edits the agent's global
hook config (or writes a plugin file the agent loads), merging only its own entries, the way Orca
and `cmux hooks setup` do. Claude keeps v1's per-launch `--settings` file, and Codex also keeps its
per-launch turn-end notify ([D6](../../../loop/decisions/m1-agent-status.md),
[D7](../../../loop/decisions/m1-agent-status.md)). Every hook runs `$QUIRKY_HOME/bin/quirky-hook`,
which does nothing outside a Quirky session.

**Fallbacks fill silence, never override.** Where an agent has no hook, or its hooks are off or
silent, two other producers set the row: the terminal title (spinner and idle glyphs), and OSC 7501,
the Program Status Protocol programs such as Claude, Codex, Grok and pi already emit. Hooks always
win while fresh ([D21](../../../loop/decisions/m1-agent-status.md),
[D22](../../../loop/decisions/m1-agent-status.md)).

## Data flow

**A hook fires.** The agent runs `quirky-hook <source>` with the event on stdin (Codex's notify: as
the last argument). The shim prints the answer that agent expects, then posts the payload, its parent
process ID and the session ID to the daemon's hook endpoint with a short timeout. If the daemon
can't be reached it appends the payload to a per-session spool file, unless it is a tool event, and
exits 0. Outside a Quirky session, or inside a backgrounded Claude job (`CLAUDE_JOB_DIR`), it exits
at once without posting ([D10](../../../loop/decisions/m1-agent-status.md)).

**The plugin normalizes it.** The daemon hands the payload to `quirky.agent-status` as today. The
plugin finds the event name, the provider session and the source's normalizer, which returns the
state the event implies, or nothing. Events for one session are handled one at a time, in arrival
order.

**Then it applies it, in order:**

1. **Identity.** An event from a different agent kind than the session's live row, or from a
   different provider session than the lead, is a nested agent and is ignored while the row is
   fresh and the lead's process lives. A SessionStart with source `clear` or `resume` moves the lead
   to its new provider session ([D11](../../../loop/decisions/m1-agent-status.md)).
2. **Provider capture.** A new lead ID or transcript path is stored on the session with
   `quirky.session/setProviderSession` ([D12](../../../loop/decisions/m1-agent-status.md)).
3. **Children.** Subagent and background-task events update the row's children and re-emit the
   lead's state through the fold ([D14](../../../loop/decisions/m1-agent-status.md)).
4. **Holds.** Claude's permission hold keeps `waiting` until the approved tool resumes, a new prompt
   arrives, or the owning child ends.
5. **Timing.** The state's start time changes only when the state changes; the evidence time always
   moves; a lead's new-turn event stamps the turn start.
6. **Write and announce.** The row is stored, the session's coarse status and summary are set, the
   plugin emits `quirky.agent-status/changed`, and a transition to done, waiting or blocked that is
   not a session boundary or a replay notifies ([D27](../../../loop/decisions/m1-agent-status.md)).

**Terminal facts arrive from the PTY host.** The host already reports titles. It now also parses
OSC 7501 reports into facts and answers the `?` probe itself. Agent-status keeps each session's
OSC 7501 records and lets the root record set the row when there is no fresh hook row, or when hooks
have said nothing for 2 minutes about a state the program has left. A title classified as working,
needs-attention or idle sets the row only when no fresh hook row exists.

**Input written to a session** is reported to plugins as a fact. Agent-status watches it for a lone
Esc or Ctrl+C (interrupt inference, [D18](../../../loop/decisions/m1-agent-status.md)) and for Enter
under a pending Claude question ([D19](../../../loop/decisions/m1-agent-status.md)).

**Over time.** A scheduled job probes the agent processes behind live rows; a gone process ends the
row ([D20](../../../loop/decisions/m1-agent-status.md)). Freshness is never written: whoever reads a
row computes its display state against the current time
([D16](../../../loop/decisions/m1-agent-status.md)). Rows are stored, and after a daemon restart live
ones come back unconfirmed ([D17](../../../loop/decisions/m1-agent-status.md)); the spool is replayed
before new hooks are applied.

**Installing.** `hooks setup` (and plugin start, while the switch is on) asks `quirky.agents` which
agents are detected and enabled, and runs each one's installer. An installer reads the agent's
config, adds Quirky's entries if missing, writes atomically only when something changed, and reports
the files it wrote. `hooks remove` (and turning the switch off) runs each remover, which deletes only
Quirky's entries.

## Key decisions and rationale

- **Status lives in its plugin; the session carries a summary.** Session status stays coarse so the
  dock badge and older clients are untouched (D3).
- **Orca's vocabulary, fold, freshness and inference rules are ported, not redesigned** (D4, D14,
  D16, D18). The doc's flows are the requirement.
- **Installers write global configs, except Claude's** (D6). Most CLIs can't be configured per
  launch, and hooks must fire for agents started by hand in a Quirky shell. v1 never edits
  `~/.claude`, and that holds.
- **Codex approval is left to Codex** (D7), since Orca's hash flow is unverified.
- **A nested same-kind agent can't take over a row** (D11). This fixes the helper-overwrite defect
  Orca shows.
- **OSC 7501 is parsed once, in the PTY host** (D22), next to the OSC parsing that already exists.
- **File-reading follow-ups are left out** (D15): Codex rollouts, Muse's log and transcript-read
  prompts.

## Behavior and scenarios

The hook-driven scenarios post hooks to a daemon started on a temporary `QUIRKY_HOME` with a
temporary `HOME`, then read the result with `quirky agent-status get <session>` (or the
`quirky.agent-status/get` method). "Posts X" means the shim sends that event for the session. Times
are relative to the first event.

### The state machine

1. **SC-1: a Claude turn moves through boundary, working, waiting and done** (API)
   - **Given** a claude session
   - **When** the session's hooks send SessionStart (source `startup`), UserPromptSubmit ("fix the
     tests"), PreToolUse Bash, PreToolUse Read, PermissionRequest Bash (`npm test`), PostToolUse Bash
     with the same tool use ID, Stop (last message "All green")
   - **Then** `get` shows, in turn: done with session boundary; working with prompt "fix the tests";
     working with tool Bash, then Read, with the state start time unchanged since the prompt;
     waiting with detail `Bash: npm test`; working; done with last message "All green". The session's
     coarse status reads done, waiting, working, done in step. The first done (a boundary) sends no
     notification; the waiting and the final done each send one.
   - **Data before:** **Session 1**: claude, no status row
   - **Walkthrough:**
     1. SessionStart startup at 0 s → **Row**: done, boundary
     2. UserPromptSubmit at 1 s → working, state since 1 s
     3. PreToolUse Bash at 2 s, Read at 3 s → working, state since 1 s, tool Read
     4. PermissionRequest Bash at 4 s → waiting since 4 s, detail `Bash: npm test`
     5. PostToolUse Bash (same tool use ID) at 9 s → working since 9 s
     6. Stop at 12 s → done since 12 s
   - **Data after:** **Row**: ✓ done, outcome success, last message "All green"; **Notifications**: ✓ "needs input" at 4 s; ✓ "finished" at 12 s; ✗ none at 0 s

2. **SC-2: Claude's permission hold** (API)
   - **Given** a claude row waiting on PermissionRequest Bash with tool use ID `t1`
   - **When** the hooks send (a) PostToolUse Read, (b) PreToolUse Bash with ID `t1` and the same
     input, (c) instead of (b), a UserPromptSubmit
   - **Then** (a) leaves the row waiting; (b) and (c) each move it to working

3. **SC-3: a Claude question waits and an answer typed in the terminal resumes it** (API)
   - **Given** a working claude row
   - **When** the hooks send PreToolUse AskUserQuestion ("Which branch?", options main and dev), then
     the person types `1` and Enter into the session
   - **Then** the row is waiting with the question text "Which branch?" as its detail and the
     question stored; after Enter it is working again

4. **SC-4: Claude failures and interrupts** (API)
   - **When** a working claude row gets (a) StopFailure, (b) Stop with `is_interrupt: true`
   - **Then** (a) is done with outcome failure, display "Failed"; (b) is done, interrupted, display
     "Interrupted"

5. **SC-5: the fold keeps a finished lead working while children live** (API)
   - **Given** a working claude row
   - **When** the hooks send SubagentStart (agent `a1`), then Stop for the lead, then PreToolUse
     AskUserQuestion carrying agent `a1`, then PostToolUse carrying agent `a1`, then SubagentStop
     (`a1`)
   - **Then** after the lead's Stop the row stays working with one live child; the child's question
     makes it waiting; the child's next tool event restores working; SubagentStop leaves it done.
     The lead's outcome is success throughout.

6. **SC-6: only background shells left reads as monitoring** (API)
   - **Given** a working grok row
   - **When** a stop arrives whose payload lists one running background task of type `shell`, and
     later a stop listing none
   - **Then** the first shows working in monitoring mode ("Monitoring background tasks"); the second
     shows done. A running task of type `subagent` shows plain working instead.

7. **SC-7: Codex** (API)
   - **Given** a codex session
   - **When** its hooks send (a) SessionStart, (b) PermissionRequest in a turn whose approvals are
     auto-reviewed, (c) PermissionRequest otherwise, (d) Interrupt, and separately (e) the notify
     call `agent-turn-complete`
   - **Then** (a) is working, not done; (b) stays working; (c) is waiting; (d) is done with outcome
     cancellation, display "Interrupted"; (e) is done

8. **SC-8: every other agent maps its events as Orca does** (API)
   - **Given** a session of each agent below
   - **When** its hooks send the sequence in the table
   - **Then** the row passes through the states shown; an event marked "no change" leaves the row as
     it was
   - **Details: Per-agent sequences**

     | Agent | Events in order | States |
     |---|---|---|
     | qoder, qoder-cn | SessionStart new, UserPromptSubmit, Notification permission_prompt, PostToolUse, Notification idle_prompt | done (boundary), working, waiting, working, done |
     | codebuddy | SessionStart, UserPromptSubmit, PreToolUse AskUserQuestion, Stop | no change, working, working, done |
     | qwen-code | UserPromptSubmit, PermissionRequest, Stop | working, waiting, done (agent shown as qwen-code) |
     | openclaude | UserPromptSubmit, PreToolUse AskUserQuestion, Stop | working, waiting, done |
     | gemini | BeforeAgent, BeforeTool, AfterAgent | working, working, done |
     | antigravity | PreInvocation, PreToolUse ask_permission, Stop with fullyIdle false, Stop, PostToolUse | working, waiting, working, done, no change |
     | amp | agent.start, tool.call, agent.end cancelled, tool.result | working, working, done interrupted, no change |
     | opencode, opencode2 | SessionStart, SessionBusy, PermissionRequest, SessionIdle | done (boundary), working, waiting, done |
     | mimo-code | SessionStart, SessionBusy, AskUserQuestion, SessionIdle | no change, working, waiting, done |
     | cursor | beforeSubmitPrompt, beforeShellExecution, stop with status aborted, afterAgentResponse | working, working, done interrupted, done |
     | pi | agent_start, tool_call AskUserQuestion, ui_prompt_start, ui_prompt_end not idle, agent_end | working, blocked, waiting, working, done |
     | omp | agent_start, tool_approval_requested, tool_execution_start, tool_approval_resolved, agent_end | working, blocked, blocked, working, done |
     | prime-agent | before_agent_start, agent_end | working, done |
     | droid | UserPromptSubmit, PreToolUse with riskLevel high, Notification "waiting for your input" | working, waiting, done |
     | command-code | PreToolUse, Stop | working, done |
     | grok | user_prompt_submit, pre_tool_use ask_user_question, stop_cancelled | working, waiting, done interrupted |
     | copilot | UserPromptSubmit, Notification permission_prompt, ErrorOccurred recoverable, ErrorOccurred not recoverable | working, blocked, working, done |
     | hermes | on_session_start, pre_llm_call, pre_approval_request, post_approval_response, post_llm_call | done (boundary), working, waiting, working, done |
     | devin | SessionStart, UserPromptSubmit, PermissionRequest, Stop with is_interrupt | no change, working, waiting, done interrupted |
     | kimi | UserPromptSubmit, PreToolUse AskUserQuestion, StopFailure | working, waiting, done failed |
     | muse | UserPromptSubmit, PermissionRequest, Notification permission_prompt, Stop | working, no change, waiting, done |
     | dsh | SessionStart, UserPromptSubmit, PreToolUse ask tool, Stop | done (boundary), working, waiting, done |
     | zcode | SessionStart startup, UserPromptSubmit, PermissionRequest, Stop | done (boundary), working, waiting, done |
     | jcode | session_start, turn_start, pre_tool request_permission, turn_end | no change, working, waiting, done |
     | kiro | agentSpawn, userPromptSubmit, preToolUse, stop | done, working, working, done |

9. **SC-9: repeated working events don't restart the clock** (API)
   - **When** a claude row receives UserPromptSubmit at 0 s and PreToolUse events at 5 s and 10 s
   - **Then** its state start time stays 0 s while its evidence time is 10 s

10. **SC-10: late events are dropped where Orca drops them** (API)
    - **When** (a) a grok row gets a stop for prompt `p1` after a new prompt `p2` started; (b) an amp
      row gets tool.call after agent.end for the same thread
    - **Then** (a) the row stays working; (b) the row stays done

11. **SC-11: a malformed hook changes nothing and never blocks** (API)
    - **When** hooks are posted with (a) a body that isn't JSON, (b) an unknown source, (c) a session
      that doesn't exist, (d) an event with no name
    - **Then** each request is answered at once, and no row or session changes

### Provider capture and identity

12. **SC-12: the provider session and transcript are captured** (CLI)
    - **Given** a claude session with no provider session
    - **When** its SessionStart hook carries session ID `abc` and transcript
      `/tmp/t/abc.jsonl`, and later a Stop carries the same
    - **Then** `quirky session get <session>` shows provider session `abc` with that transcript;
      `quirky session resume <session>` runs `claude … --resume abc`. An agent whose hooks carry no
      ID (amp, command-code, hermes) captures nothing; cursor captures `conversation_id`, opencode
      `sessionID`, antigravity `conversationId`, pi `session_id` with `session_file`.
    - **Data before:** **Session 1**: claude, provider session none
    - **Walkthrough:**
      1. SessionStart startup carries session `abc`*, transcript `/tmp/t/abc.jsonl`*
      2. agent-status stores it on Session 1
      3. Stop carries the same; nothing changes
    - **Data after:** **Session 1**: ✓ provider session `abc`, transcript `/tmp/t/abc.jsonl`; ✓ stored once

13. **SC-13: a helper agent inheriting the session can't take over the row** (API, Orca defect)
    - **Given** a claude row, lead `abc`, done with prompt "fix the tests", its process alive
    - **When** a helper Claude in the same session posts SessionStart (source `startup`, session
      `zzz`), UserPromptSubmit ("=== Transcript of a conversation…") and Stop
    - **Then** the row stays done with prompt "fix the tests", the provider session stays `abc`, and
      no notification is sent
    - **Data before:** **Row**: done, lead `abc`, prompt "fix the tests"; **Session 1**: provider session `abc`
    - **Walkthrough:**
      1. Helper SessionStart `zzz` arrives while lead `abc` lives → ignored as nested
      2. Helper UserPromptSubmit and Stop for `zzz` → ignored
    - **Data after:** **Row**: ✓ done, prompt "fix the tests"; **Session 1**: ✓ provider session `abc`; ✗ no Working flash; ✗ no notification

14. **SC-14: a cleared or new session in place moves the lead** (API)
    - **Given** a claude row with lead `abc`
    - **When** (a) SessionStart source `clear` with session `def` arrives; (b) separately, SessionEnd
      reason `prompt_input_exit` for `abc` arrives, then SessionStart `startup` with session `ghi`
    - **Then** (a) the lead and provider session become `def` and the row is a done boundary; (b) the
      SessionEnd ends the row (no row, coarse status back to running) and `ghi` becomes the new lead

15. **SC-15: a different agent nested in a fresh row is ignored** (API)
    - **Given** a working claude row
    - **When** gemini hooks post BeforeAgent for the same session
    - **Then** the row stays a working claude row; once the claude row is done and its process has
      exited, a gemini event takes the row

### Freshness, restart and process lifetime

16. **SC-16: silence decays the display, never the state** (API)
    - **Given** a working claude row whose last evidence was 31 minutes ago
    - **When** `get` is read (a) while the session runs, (b) after the session's process has exited
      without the row being ended
    - **Then** (a) display unverifiable, label "No recent update", detail "No update in 31m", state
      still working; (b) display idle. A done row never decays.

17. **SC-17: after a daemon restart live rows are unconfirmed** (API)
    - **Given** rows: working (evidence 10 minutes ago), done, and working with evidence 8 days ago
    - **When** the daemon restarts
    - **Then** the first shows "Couldn't confirm" until its next hook, which makes it fresh again; the
      done row is unchanged; the 8-day row is gone. Rows of removed sessions are gone.

18. **SC-18: a hook while the daemon is down is spooled and replayed** (API)
    - **Given** a working claude row and the daemon stopped
    - **When** the shim runs for PreToolUse Bash and then Stop, and the daemon starts again
    - **Then** the shim exits 0 both times within its timeout; PreToolUse is not spooled; after start
      the row is done from the replayed Stop, and no notification is sent for the replay

19. **SC-19: an agent that exits without saying so ends its row** (API)
    - **Given** a shell session in which a claude was run, its row working, its process ID known from
      the hooks
    - **When** that claude process is killed and the next presence probe runs
    - **Then** the row is ended and the session's coarse status is running; when a session's own
      process exits, its row ends with the session

### Inference from input

20. **SC-20: Esc and Ctrl+C infer an interrupt, per agent** (API)
    - **Given** a working row with prompt "long task"
    - **When** a lone key is written to the session and nothing else happens for 500 ms
    - **Then** the row becomes done, interrupted, outcome cancellation, display "Interrupted", in the
      cases marked yes, and stays working otherwise
    - **Details: Inference table**

      | Agent | Key | Interrupt inferred |
      |---|---|---|
      | claude | Ctrl+C | yes |
      | claude | Esc | no |
      | gemini | Esc | yes |
      | codex | Ctrl+C | no |
      | droid | Ctrl+C | no |
      | opencode | Esc once | no |
      | opencode | a second Esc in the same turn | yes |
      | any | Ctrl+C, then a hook that changes the row within 500 ms | no |
      | any | Ctrl+C on a row that is waiting, done, or restored unconfirmed | no |
      | claude | Ctrl+C while only a child is working | no |

### Fallbacks

21. **SC-21: terminal titles fill in where hooks are silent** (API)
    - **Given** a session with no hook row
    - **When** the program sets titles in turn: `⠋ Working on it`, `✋ gemini`, `✳ Claude Code`
    - **Then** the display reads working, then permission ("Needs attention"), then done. With a
      fresh hook row present, the same titles change nothing. A title without a status glyph or
      agent name (such as `~/src/app`) changes nothing.

22. **SC-22: OSC 7501 reports and the probe** (API)
    - **Given** a session with no hook row
    - **When** the program writes `OSC 7501 ; ?`, then reports in turn: `state=working:progress=40`
      with message "Indexing", `state=blocked:kind=permission`, `state=blocked:kind=auth`,
      `state=done`, `state=error`, and finally `state=clear`
    - **Then** the session receives the reply `OSC 7501 ; ?:states=idle,working,done,blocked,error:kinds=permission,question,auth ST`; the display reads working with progress 40 and message
      "Indexing", waiting, blocked, done, failed, and then no row. A report split across two output
      chunks is read the same. A report with a bad state, invalid base64 in `msg`, or longer than
      4096 bytes is ignored. A shell prompt mark (OSC 133 A) drops working and blocked records but
      keeps done and error ones.

23. **SC-23: hooks outrank OSC 7501 until they fall silent** (API)
    - **Given** a claude row working from a hook at 0 s
    - **When** Claude reports OSC 7501 `state=idle` at 10 s, and nothing else arrives
    - **Then** the row stays working until 2 minutes after the last hook, then reads done from the
      program's report. A hook at any time takes over again.

### Installers

24. **SC-24: setting up one agent's hooks is safe to rerun** (CLI)
    - **Given** a temporary `HOME` with `~/.gemini/settings.json` holding `{"theme":"dark"}` and a
      user hook for AfterAgent, and gemini installed
    - **When** the agent runs `quirky agent-status hooks setup gemini` twice, then
      `quirky agent-status hooks remove gemini`
    - **Then** the first run prints the settings path as changed and adds Quirky's BeforeAgent,
      AfterAgent, BeforeTool and AfterTool entries, keeping the theme and the user's hook; the second
      run prints no changed files and leaves the file byte for byte the same; remove prints the path
      and leaves exactly the original keys and the user's hook
    - **Data before:** **gemini settings**: theme dark; AfterAgent: user's `notify.sh`*
    - **Walkthrough:**
      1. setup → adds 4 Quirky entries; prints `~/.gemini/settings.json`
      2. setup again → nothing changes; prints no files
      3. remove → deletes Quirky's 4 entries; prints `~/.gemini/settings.json`
    - **Data after:** **gemini settings**: ✓ theme dark; ✓ AfterAgent: user's `notify.sh` only; ✗ no Quirky entries

25. **SC-25: every agent's installer writes its file and events** (CLI)
    - **Given** a temporary `HOME` with each agent detected
    - **When** the agent runs `quirky agent-status hooks setup` (all)
    - **Then** each agent's file below exists with Quirky's entries for exactly those events, each
      running the Quirky hook for that agent's source, guarded so that a missing shim (Quirky
      uninstalled) exits 0 quietly; a second run changes nothing; `hooks remove` removes every one,
      deleting files Quirky created and leaving files the user had
    - **Details: Installer targets**

      | Agent | File (under the temporary home) | Events |
      |---|---|---|
      | openclaude | `~/.openclaude/settings.json` | Claude's set minus SessionEnd |
      | qoder, qoder-cn | `~/.qoder/settings.json`, `~/.qoder-cn/settings.json` | SessionStart, SessionEnd, UserPromptSubmit, PreToolUse, PostToolUse, PostToolUseFailure, PermissionRequest, Stop, StopFailure, Notification, PostCompact |
      | qwen-code | `~/.qwen/settings.json` | qoder's set with SubagentStart, SubagentStop and without PostCompact |
      | codebuddy | `~/.codebuddy/settings.json` | qoder's set without PostCompact |
      | codex | `~/.codex/hooks.json` | SessionStart, UserPromptSubmit, PreToolUse, PermissionRequest, PostToolUse, SubagentStart, SubagentStop, Stop, Interrupt |
      | gemini | `~/.gemini/settings.json` | BeforeAgent, AfterAgent, BeforeTool, AfterTool |
      | antigravity | `~/.gemini/config/hooks.json` (bundle `quirky-status`) | PreInvocation, PostInvocation, Stop, PreToolUse, PostToolUse |
      | amp | `~/.config/amp/plugins/quirky-agent-status.ts` | session.start, agent.start, tool.call, tool.result, agent.end |
      | cursor | `~/.cursor/hooks.json` | beforeSubmitPrompt, stop, preToolUse, postToolUse, postToolUseFailure, beforeShellExecution, beforeMCPExecution, afterAgentResponse |
      | droid | `~/.factory/settings.json` | SessionStart, UserPromptSubmit, Stop, SubagentStop, PreToolUse, PostToolUse, PermissionRequest, Notification |
      | command-code | `~/.commandcode/settings.json` | PreToolUse, PostToolUse, Stop |
      | grok | `~/.grok/hooks/quirky-status.json` | SessionStart, UserPromptSubmit, Stop, StopCancelled, StopFailure, SessionEnd, PreToolUse, PostToolUse, PostToolUseFailure, Notification |
      | copilot | `~/.copilot/hooks/quirky.json` | SessionStart, SessionEnd, UserPromptSubmit, PreToolUse, PostToolUse, PostToolUseFailure, subagentStart, SubagentStop, PreCompact, Stop, ErrorOccurred, PermissionRequest, Notification |
      | hermes | `~/.hermes/plugins/quirky-status/` (enabled in `~/.hermes/config.yaml`) | on_session_start, pre_llm_call, post_llm_call, pre_tool_call, post_tool_call, pre_approval_request, post_approval_response, on_session_end, on_session_finalize, on_session_reset |
      | devin | `~/.config/devin/config.json` | SessionStart, UserPromptSubmit, Stop, PostCompaction, SessionEnd, PreToolUse, PostToolUse, PermissionRequest |
      | kimi | `~/.kimi-code/config.toml` (a marked block) | UserPromptSubmit, PreToolUse, PostToolUse, PostToolUseFailure, PermissionRequest, Stop, StopFailure |
      | muse | `~/.config/muse/settings.json` | SessionStart, SubagentStart, SessionEnd, Notification, UserPromptSubmit, PreToolUse, PostToolUse, PostToolUseFailure, PermissionRequest, Stop, StopFailure |
      | zcode | `~/.zcode/cli/config.json` | SessionStart, UserPromptSubmit, PreToolUse, PermissionRequest, PostToolUse, PostToolUseFailure, Stop |
      | dsh | `~/.dsh/cordis.patch.yml` | SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, Stop |
      | jcode | `~/.jcode/config.toml` | session_start, turn_start, pre_tool, post_tool, turn_end, session_end |
      | kiro | each `~/.kiro/agents/*.json` the user owns | agentSpawn, userPromptSubmit, preToolUse, postToolUse, stop |
      | opencode, opencode2, mimo-code | the agent's default config `plugins/` directory, `quirky-opencode-status.js` | the OpenCode-family events |
      | pi, omp, prime-agent | `~/.pi/agent/extensions/`, `~/.omp/agent/extensions/`, `~/.prime/agent/extensions/`, `quirky-agent-status.ts` | the Pi-family events |

      Agents that read a home directory from the environment (`GROK_HOME`, `COPILOT_HOME`,
      `HERMES_HOME`, `KIMI_CODE_HOME`, `XDG_CONFIG_HOME`, `DSH_HOME`, `JCODE_HOME`, `KIRO_HOME`)
      use it when the daemon's environment sets it.

26. **SC-26: what setup says about agents it skips, and a config it can't read** (CLI)
    - **Given** gemini detected but disabled in the agent settings, cursor not installed, droid
      installed with an unparseable `~/.factory/settings.json`
    - **When** the agent runs `quirky agent-status hooks setup` and `quirky agent-status hooks status`
    - **Then** gemini is `agent_disabled`, cursor `cli_not_found`, droid `error` with "Could not
      parse ~/.factory/settings.json" and the file untouched; the command exits 0. `hooks status`
      lists every agent with one of `installed`, `not-installed`, `agent_disabled`, `cli_not_found`,
      `hooks_disabled` or `error`.

27. **SC-27: the Agent status hooks switch** (CLI)
    - **Given** gemini and cursor detected, hooks installed for both
    - **When** the switch is turned off (`quirky setting set quirky.agent-status/hooks false`), the
      daemon restarts, then the switch is turned on
    - **Then** turning it off removes Quirky's entries for every agent and `hooks status` shows
      `hooks_disabled`; the restart installs nothing and removes nothing; turning it on installs for
      gemini and cursor. `hooks setup` while the switch is off refuses with "Agent status hooks are
      turned off".

28. **SC-28: Claude's settings file carries only the events its version knows** (CLI)
    - **When** claude sessions are launched with a fake claude reporting (a) `1.0.60`, (b) `2.1.300`,
      (c) no version
    - **Then** the `--settings` file given to (a) has PreToolUse, PostToolUse, Stop, SubagentStop
      and UserPromptSubmit only; (b) has the full set (SessionStart, UserPromptSubmit, Stop,
      StopFailure, SubagentStart, SubagentStop, TeammateIdle, PreToolUse, PostToolUse,
      PostToolUseFailure, PermissionRequest, PostCompact, SessionEnd); (c) has (a)'s events plus
      SessionStart, the set 1.0.64 knows. SessionEnd is written only from 2.1.261, as Orca does.
      `~/.claude` is never written. PreCompact is never registered.

29. **SC-29: Codex setup asks for Codex's review and keeps the notify hook** (CLI)
    - **When** the agent runs `quirky agent-status hooks setup codex` and then starts a codex session
    - **Then** the command prints `~/.codex/hooks.json` and the note "Codex asks you to review these
      hooks once (/hooks)"; the codex launch still carries the notify hook

30. **SC-30: the hook shim answers, stays quiet outside Quirky, and never blocks** (CLI)
    - **When** the shim runs (a) for claude PermissionRequest, (b) for cursor preToolUse and
      beforeSubmitPrompt, (c) for antigravity PreToolUse, (d) with no `QUIRKY_SESSION_ID`, (e) with
      `CLAUDE_JOB_DIR` set, (f) with the daemon's port closed
    - **Then** (a) prints `{}`; (b) prints `{"permission":"allow"}` and `{"continue":true}`; (c)
      prints `{"decision":"ask"}`; (d) and (e) post nothing; (f) exits 0 within 2 seconds. Every case
      exits 0.

31. **SC-31: plugin-type integrations post their events** (API)
    - **When** the generated OpenCode plugin, Pi extension, Amp plugin and Hermes plugin are loaded
      with a stand-in host inside a session and fire a busy/start event and an idle/end event
    - **Then** each posts to the hook endpoint and the session's row reads working, then done; loaded
      outside a session, each posts nothing

### Notifications and readable detail

32. **SC-32: the waiting detail is readable, never a raw payload** (API, Orca defect)
    - **When** a claude PermissionRequest arrives for Bash with input `{"command":"printf 'x' >> README.md"}`
    - **Then** the row's detail is `Bash: printf 'x' >> README.md`, and no detail of any row contains
      a JSON object

### Scripting surface

33. **SC-33: list and get** (CLI)
    - **Given** a working claude session and a shell session with no row
    - **When** the agent runs `quirky agent-status list --json` and `quirky agent-status get <id> --json`
    - **Then** `list` returns one entry with session ID, agent, state, display state, label, detail,
      state start and last evidence time; `get` returns the whole row, including children, outcome,
      source and progress; `get` for the shell session returns null

### The window

These run in the web UI against a daemon on a temporary home, with hooks posted from the test driver.

34. **SC-34: the tab dot shows the display state and its label** (UI)
    - **Given** a claude session open in a worktree
    - **When** its hooks move it through working, waiting, done, StopFailure and an interrupt
    - **Then** the session tab's glyph is in turn a spinner, an amber question icon, a green dot, a
      red dot and a muted dot, and hovering it reads "Working", "Waiting for input", "Done",
      "Failed", "Interrupted"

35. **SC-35: the worktree card shows its most urgent session** (UI)
    - **Given** a worktree with one session waiting and one working
    - **When** the person looks at the worktree list
    - **Then** the card's dot is the amber question icon; when the waiting one finishes it becomes the
      spinner; when both are done it is the green dot

36. **SC-36: progress replaces the spinner** (UI)
    - **When** a session with no hooks reports OSC 7501 `state=working:progress=60`
    - **Then** the session tab shows a ring at 60% where the spinner was

37. **SC-37: the hooks switch in Settings** (UI)
    - **When** the person opens Settings
    - **Then** an "Agent status hooks" checkbox shows, checked, and hovering it reads "Shows working,
      waiting, and done states in Quirky. Turn off to remove Quirky-managed hooks and stop
      reinstalling them." (Quirky's Settings dialog shows a setting's description as its hover
      text); unchecking it and saving makes `quirky agent-status hooks status` report
      `hooks_disabled`

## Scope and non-goals

In scope: the row, the fold and the display states; normalizers for the 28 sources plus OpenClaude;
installers and removers for 22 agents plus Claude's per-launch file; the hooks switch; provider
capture; spool and replay; freshness and restart hydration; interrupt and question inference;
process presence; terminal title and OSC 7501 fallbacks; the tab and worktree dots; the CLI group.

Non-goals:

- **The Activity view** (bell button, grouping by status, filters, unread-only, child agents), **Mark
  all read** and **Clear completed**: agent-status.md flows 2 and 3, left to m7-parity-sweep (D1).
- **The Agent Dashboard** and its Settings > Experimental entry, and its "0 total" defect, which
  needs the dashboard (D1, D31).
- **Unread markers, cooldown, sounds and the tray dot**: m1-notifications.
- **Claude's statusLine** telemetry: m3-session-info (D29).
- **SSH and WSL relays and remote installs**; **Windows** launchers and paths (D29).
- **OSC 9999** and the **agent-state-rules** engine (D23).
- **Codex rollout polling, Muse's session log, prompts read from transcripts**, and the Stop
  assistant-message retry (D15).
- **Cold-restore resume** (D13).
- **Foreground process tracking** and the "Stop this agent?" close confirmation: m1-term-ui (D20).
- **Writing Codex hook approval hashes** (D7).

## Decisions Locked

**Scope**
- Roadmap bullets plus the dot, the switch and interrupt inference; Activity view and Dashboard out (D1).

**State model**
- One row per Quirky session (D2); full row in agent-status, coarse status plus summary on the session (D3).
- Orca's four states, eleven display states and labels (D4); Orca's per-source mapping for 29 sources (D5).
- Orca's fold for children and background work (D14); file-reading follow-ups out (D15).
- Freshness decays the display after 30 minutes, never to done (D16); restart hydration marks live rows unconfirmed (D17).

**Installer surface**
- Global configs for 22 agents, automatic while the switch is on; Claude stays per-launch (D6).
- Codex: `hooks.json`, approval left to Codex, notify kept (D7).
- Merge only own entries, idempotent, never write an unparseable file (D8).
- Claude events gated on its version (D9); plugin files for Amp, Hermes, OpenCode family, Pi family (D24).
- Skip reasons as Orca names them (D25); the switch keeps Orca's copy (D26).
- CLI `list`, `get`, `hooks status|setup|remove` (D30).

**Identity, capture and evidence**
- A different provider session in a live row is a nested agent (D11).
- Provider session and transcript stored through `setProviderSession` (D12).
- Shim answers per agent, spools, never blocks (D10).
- Esc and Ctrl+C inference from session input (D18); Claude question answered by Enter (D19).
- Process presence from the hook's parent PID (D20).
- Titles fill in without a fresh hook row (D21); OSC 7501 parsed in the host, yields to hooks for 2 minutes (D22).

**Notifications and detail**
- No notification for boundaries or replays (D27); readable waiting detail (D28).

## Industry Insights

- The Program Status Protocol (OSC 7501, rev 0.4, 2026-10-10) reports `state`, `kind`, `progress`,
  `app`, base64 `title`/`msg` per record ID; each report replaces its record, `clear` removes a
  subtree, working and blocked records end at process exit or the next prompt, done and error
  outlive them; a supporting terminal answers `?`. ([Rex docs](https://www.superlogical.com/rex/docs/build/program-status), [Stackness](https://stackness.dev/blog/osc-7501-program-status-terminal-protocol-for-coding-agents), [cmux #18742](https://github.com/manaflow-ai/cmux/pull/18742))
- `cmux hooks setup` installs for agents it finds and prints a summary for the ones it skips.
  ([cmux README](https://github.com/manaflow-ai/cmux))
- Claude and Codex hook payloads carry `session_id` and `transcript_path`; Claude's transcript is
  written asynchronously, so the Stop payload's `last_assistant_message` is the reliable final text.
  ([Claude hooks](https://code.claude.com/docs/en/hooks), [Codex hooks](https://learn.chatgpt.com/docs/hooks))
- Codex skips a hook until the user trusts its hash in `/hooks`. ([Codex hooks](https://learn.chatgpt.com/docs/hooks))
- Claude's `--settings` hooks merge with the user's own; different commands for one event both run.
  ([claude-code #11392](https://github.com/anthropics/claude-code/issues/11392), [conclave #302](https://github.com/miclip/conclave/issues/302))
- Installer bugs that recur: install-once copies that never reconcile, removing by event instead of
  by own entry, line-ending churn breaking idempotency. ([claude-code-toolkit #192](https://github.com/ImperialAutomation/claude-code-toolkit/issues/192), [aiur #6505](https://github.com/aiur-team/aiur/issues/6505), [code-conductor #96](https://github.com/yeisonrestrepo/code-conductor/issues/96))
- One invalid entry or unknown event can make Claude discard every hook in a file.
  ([claude-code #75081](https://github.com/anthropics/claude-code/issues/75081), [cc-stretch #17](https://github.com/pro-vi/cc-stretch/issues/17))
- A hook with no timeout stalled an agent for 600 s when the listener hung.
  ([vibe-island #265](https://github.com/vibeislandapp/vibe-island/issues/265))
- Claude sends no Stop on Esc, and SessionEnd is skipped on crashes and print-mode exits, so status
  needs interrupt inference and a liveness check; settling to idle after a fixed quiet period
  mislabels long turns. ([agent-orchestrator #6131](https://github.com/OrchestratorInc/agent-orchestrator/issues/6131), [cmux #20564](https://github.com/manaflow-ai/cmux/pull/20564), [claude-code #79702](https://github.com/anthropics/claude-code/issues/79702))
- Late tool events racing a Stop left a sidebar stuck. ([cmux #15887](https://github.com/manaflow-ai/cmux/pull/15887))
- Inherited environments make nested agents report into the wrong pane.
  ([overcode #550](https://github.com/mkb23/overcode/issues/550))
- Uninstalling an app that wrote global hooks leaves them calling a missing command; another tool
  rewriting `~/.claude/settings.json` wholesale dropped Orca's hooks until restart.
  ([orca #28667](https://github.com/stablyai/orca/issues/28667), [orca #16771](https://github.com/stablyai/orca/issues/16771), [cmux agent-hooks.md](https://github.com/manaflow-ai/cmux/blob/main/docs/agent-hooks.md))
- Title glyphs drift between agent versions and freeze under multiplexers, so titles are a fallback,
  not a source of truth. ([herdr #3949](https://github.com/herdrdev/herdr/issues/3949), [zentty #122](https://github.com/dedene/zentty/issues/122))

## Deferred Ideas

- The Activity view, Mark all read, Clear completed and the Agent Dashboard (D1).
- Cold-restore resume (D13).
- Writing Codex approval hashes once Codex documents them (D7).
- `[tech-spec]` The exact Claude evidence for background shells and crons in the fold.
- `[tech-spec]` How tests control time for freshness and the 2-minute OSC 7501 window.
- `[tech-spec]` The input fact's shape and cost on the typing path.
- `[tech-spec]` Exact plugin and extension sources per agent, ported from Orca's installers.
- `[tech-spec]` Store schema for rows, children and OSC 7501 records.

## Glossary

- **Row:** one session's agent status, owned by `quirky.agent-status`.
- **State:** working, waiting, blocked or done.
- **Display state:** what the window draws: the state, adjusted by outcome, freshness and source.
- **Lead:** the agent the session belongs to, identified by its provider session; other agents in
  the session are nested.
- **Child:** a subagent or background task of the lead.
- **Fold:** combining the lead's state with its children's into the row's state.
- **Session boundary:** a done row from a new, resumed or cleared session landing idle.
- **Fresh:** a live row with evidence in the last 30 minutes that wasn't restored after a restart.
- **Source:** the agent ID a hook posts as (`claude`, `gemini`, …).
- **Shim:** `$QUIRKY_HOME/bin/quirky-hook`, the command every hook runs.
- **Spool:** the per-session file the shim appends to when the daemon can't be reached.
- **OSC 7501:** the Program Status Protocol escape sequence programs use to report their own status.
- **Provider session:** the agent CLI's own session ID, and sometimes its transcript path.
