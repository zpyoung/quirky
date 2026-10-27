# Agent status for scripts: explain, detection rules as data, a guarded send, waits and session names

## Status & amendments

**Status:** Approved (headless build loop; decisions in [m1-agent-status-scripting.md](../../../loop/decisions/m1-agent-status-scripting.md)). Tech spec: requested.

**Amendments:**
- 2026-10-27, Codex spec review (D27-D31): a rule file's blocked rules are tried before its
  working and idle rules, so an approval can't hide behind an earlier working rule (D28); rules
  and wait patterns run with a time limit, and a pattern that runs too long has its rule source
  ignored (D29); send writes each Enter itself and checks for an approval just before it, so a
  delayed or retried Enter never lands on an approval prompt (D30); the start check watches from
  the first Enter, so a turn that starts and ends inside the submit delay still counts (D31). New
  scenarios SC-38 to SC-41; SC-4 (c), SC-7 and SC-31 corrected; send prints the state it reached;
  output waits say what happens when the session exits.
- 2026-10-27, build (D34): a done row never goes stale, so an agent that finished long ago still
  reads idle.

## Conceptual model

Loops, automations, orchestration and people's own scripts drive agents through Quirky. Today they
can read a status row (`quirky agent-status get`) and type raw text (`quirky terminal send`), and
neither is safe to build on: a row can't say why it holds its state, and raw typing goes into
whatever the agent shows, including an approval prompt, where a stray Enter approves a tool call.

This item gives scripts five things, all in the built-in `quirky.agent-status` plugin except names,
which live on the session in `quirky.session`:

- **A script state** for every session, one of `working`, `blocked`, `idle`, `unknown` or
  `exited`. It is what send and the waits act on. It comes from the session's status row, which
  hooks drive, and from the session's **detection rules**, which read the screen.
- **Explain**, which names the source and rule behind a session's state, so "why does this say
  idle?" has an answer.
- **Detection rules** stored as data, one JSON file per agent. Quirky ships some, a plugin can ship
  more, and a user can override any of them by dropping a file in `$QUIRKY_HOME/agent-rules/`.
  Quirky never downloads rules.
- **A guarded send** that types a prompt only when the agent isn't blocked, then checks that the
  agent started working.
- **Waits**: until a session reaches a script state, and until its text matches a pattern.
- **Session names**, unique among running sessions, usable wherever these commands take a session.

The status dot and everything else m1-agent-status built are unchanged; the rules never move the
dot (D2).

## Data flow

A hook, title, OSC 7501 report or typed key changes a session's status row as before. Each change
now also records on the row the evidence that decided it: its source, the rule (for a hook, the
event and the state it mapped to), and when (D10).

When a script asks for a session's script state (explain, send, a wait), the plugin reads the row
and, if a rule file applies to the session's agent, the session's rendered screen and title, and
runs the rules. The precedence below combines them. Rule files are found per agent in a fixed
order of sources and read again when they change.

Send checks the script state, types the prompt as a bracketed paste, and after the agent's submit
delay checks again before it writes Enter (and before any retried Enter). From the first Enter it
watches the script state for up to 5 seconds. Waits re-check the script state
or the rendered text as events and output arrive, in calls of at most 60 seconds that the CLI
repeats.

Names are stored on the session record. Every session parameter of `quirky.session` and of this
item's methods accepts a name or an ID.

## Key decisions and rationale

- **Rules feed scripts, not the dot** (D2). A wrong rule would otherwise show on every dot, and
  re-reading every agent's screen after each output burst costs more than the dot gains.
- **Hooks decide working and idle; the screen can always add blocked** (D4). Several agents' hooks
  can't report an approval, and typing into one is the mistake send exists to prevent.
- **One file per agent, blocked rules first, then the first matching rule; whole-file overrides**
  (D5, D6, D28). File order is the ranking within each group, and nothing merges, so a reader of
  one file knows what will happen.
- **Patterns run on a time limit** (D29). A regex that runs too long is treated as broken, never
  allowed to stall the daemon.
- **Send refuses only blocked** (D12) and reports a stall after 5 seconds (D13), following herdr's
  prompt guard. Agents queue input typed mid-turn.
- **Waits use the script states and long-poll** (D16, D18), as `quirky ask wait` does.
- **Names can't look like IDs** (D20), so no selector syntax is needed.

## Behavior and scenarios

Scenarios run against a daemon started on a temporary `QUIRKY_HOME` with a temporary `HOME`, using
the `quirky` CLI or the daemon API as each says. "Posts X" means the session's hook shim sends
event X. A fake agent is a test program that draws a given screen and title and posts given hooks.

### The script state

Each session's script state is decided in this order. The first line that applies wins.

| Situation | Script state | Source named by explain |
|---|---|---|
| The session's process has exited | exited | the session |
| The session's rule file has a blocked rule that matches now | blocked (its kind) | the screen rule |
| The row is fresh and its last evidence is a hook or a spool replay | working, blocked (waiting or blocked row) or idle (done row) | the hook event |
| The session's rule file has a working or idle rule that matches now | working or idle | the screen rule |
| The row is fresh and its last evidence is a title, an OSC 7501 report or an inference | as for a hook row | that evidence |
| Otherwise | unknown | what is missing |

A row is fresh while its evidence is under 30 minutes old and it isn't restored unconfirmed; a
done row is always fresh, because a finished turn never decays (as on the dot). A done row is idle
whatever its outcome (done, failed or interrupted). A blocked row or rule names a
kind: approval, or question.

### Explain

1. **SC-1: explain names the hook event behind a blocked Claude session** (CLI)
   - **Given** a claude session whose hooks posted UserPromptSubmit ("fix the tests") at 0 s and
     PermissionRequest Bash (`npm test`) at 4 s
   - **When** a script runs `quirky agent-status explain <session>` at 10 s, and again with `--json`
   - **Then** the text says the session is blocked waiting for approval, because the claude hook
     event PermissionRequest at 4 s (6 s ago) mapped to waiting, with the detail `Bash: npm test`,
     and that no screen rule matched in the claude rule file it names. The JSON holds the same
     facts as fields: the script state and kind, the display state, the deciding source, event,
     rule and time, the row's freshness and the screen verdict.
   - **Data before:** **Row**: claude, waiting since 4 s, last evidence hook PermissionRequest at 4 s
   - **Walkthrough:**
     1. The script runs explain at 10 s
     2. No blocked rule in the built-in claude rules matches the screen
     3. The row is fresh and hook-sourced, so the hook decides
   - **Data after:** **Explanation**: ✓ blocked, kind approval; ✓ because hook PermissionRequest → waiting at 4 s; ✓ screen: no rule matched (claude, built-in)

2. **SC-2: explain shows the fold that keeps a finished lead working** (API)
   - **Given** a claude row whose lead posted Stop at 20 s while one subagent it started is still
     running
   - **When** a script calls `quirky.agent-status/explain` for the session
   - **Then** the script state is working, and the explanation says the lead's own state is done
     since 20 s and one agent child is still running, which keeps the row working.

3. **SC-3: explain says a silent row is no longer trusted** (API)
   - **Given** a codex row that went working at 0 s and has had no evidence since, and no codex
     rule matches the screen
   - **When** explain runs at 34 minutes
   - **Then** the script state is unknown, the display is "No recent update", and the explanation
     says the last evidence (the hook event UserPromptSubmit) is 34 minutes old, past the 30 minute
     limit.

4. **SC-4: explain names title, OSC 7501 and inferred evidence** (API)
   - **Given** three sessions: (a) one with no hooks whose title became `✋ gemini` (read as needs
     attention), (b) one with no hooks whose program reported OSC 7501 state `blocked` kind
     `permission`, (c) a claude session whose hooks made it working, where the person then pressed
     Ctrl+C and no hook followed within the settle time
   - **When** explain runs for each
   - **Then** (a) names the title text and that it read as needs-attention, giving blocked; (b)
     names the OSC 7501 state and kind, giving blocked; (c) names the interrupt inferred from
     Ctrl+C, giving idle.

5. **SC-5: explain with no row, an exited session and an unknown one** (CLI)
   - **When** explain runs for (a) a running cursor session with no row whose screen matches
     nothing, (b) a session whose process exited, (c) `nosuch`
   - **Then** (a) says no hook, title or OSC 7501 report has arrived, names the cursor rule file and
     that none of its rules matched, and gives unknown; (b) gives exited with the exit code; (c)
     fails with `not-found` and exit code 1.

6. **SC-6: a screen approval menu outranks a working hook row** (API)
   - **Given** a cursor session whose hooks posted preToolUse (working) at 0 s, and whose screen
     then shows Cursor's "Run this command?" menu with its key choices on the last lines
   - **When** explain runs
   - **Then** the script state is blocked, kind approval, and the explanation names the cursor
     rule `approval-menu` as deciding it over the working hook row, which it also shows.

### Detection rules

7. **SC-7: a rule file is ordered rules over the title or the screen** (API)
   - **Given** a rule file for agent `fake` with, in order: `approval` (blocked, approval; screen,
     last 6 lines; all of: contains "allow this?", regex `\(y/n\)\s*$`), `busy` (working; screen;
     regex `esc to interrupt`), `ready` (idle; title; regex `^✳`; quiet 1000 ms)
   - **When** the fake agent shows, in turn: (a) a screen with "Allow this? (y/n)" on its last line
     and "esc to interrupt" above it; (b) "esc to interrupt" only; (c) title `✳ fake` and a screen
     holding only `>`, unchanged for 2 s; (d) title `✳ fake` with the screen changing every 200 ms
     and never showing "esc to interrupt"; (e) "allow this?" ten lines above the bottom and
     nothing else; (f) the same file reordered so `busy` comes first, with screen (a)
   - **Then** the verdicts are (a) blocked approval by `approval`; (b) working by `busy`; (c) idle
     by `ready`; (d) no verdict, since the screen never stays quiet for 1000 ms; (e) no verdict,
     because `approval` reads only the last 6 lines; (f) still blocked approval by `approval`,
     because blocked rules are tried before the others whatever their place in the file.

8. **SC-8: built-in rules catch what hooks can't** (API)
   - **Given** sessions of (a) cursor showing its command approval menu, (b) codex showing its
     "Implement this plan?" menu with "No, stay in Plan mode" and its key row last, (c) claude with
     title `✳ Claude Code` and a quiet screen, (d) gemini with title `✋ gemini`
   - **When** a script reads each one's script state with no hook row
   - **Then** (a) blocked, approval; (b) blocked, question; (c) idle; (d) blocked, approval. Built-in
     files exist for claude, codex, cursor, gemini, opencode, opencode2, pi, omp, prime-agent,
     cline, antigravity and hermes, and each has a fixture screen test for every rule.

9. **SC-9: a user file overrides the whole set without a restart** (CLI)
   - **Given** a running daemon and a codex session showing a screen that the built-in codex
     rules read as idle
   - **When** the user writes `$QUIRKY_HOME/agent-rules/codex.json` with one rule, `held` (blocked,
     question; screen; contains "custom marker"), and the screen shows "custom marker"
   - **Then** the next explain names rule `held` from the user file and its path, and no built-in
     codex rule is consulted any more (the idle screen alone now gives no rule verdict). Deleting
     the file brings the built-in rules back on the next read.

10. **SC-10: an invalid user file is ignored with a warning** (CLI)
    - **When** the user's `codex.json` is (a) not JSON, (b) missing `rules`, (c) has a rule with
        the regex `(a+)+$`, (d) has a rule with a backreference `(x)\1`, (e) has a state `asleep`
    - **Then** each time the built-in codex rules apply, and `quirky agent-status rules list`
        shows codex's user file as ignored with the reason (for (c), a repeated group that can
        match in more than one way). Explain shows the same warning.

11. **SC-11: a plugin ships rules, and the user still wins** (API)
    - **Given** an installed plugin whose manifest contributes `agent-rules` entry `aider` with one
      working rule, and no built-in aider file
    - **When** an aider session's screen matches it, and then the user adds
      `$QUIRKY_HOME/agent-rules/aider.json`
    - **Then** the first verdict names the plugin as the rule source; after the user file appears,
      the user file is the source.

12. **SC-12: rules list and show** (CLI)
    - **When** a script runs `quirky agent-status rules list` and `quirky agent-status rules show
      cursor`
    - **Then** list prints one line per agent with rules: the agent, where its effective rules come
      from (user, plugin name, or built-in), the file path or contribution, the rule count, and any
      ignored source with its reason; `--json` gives the same as fields. Show prints the effective
      rules for cursor and their origin.

13. **SC-13: rules are never downloaded (Orca defect)** (API)
    - **Given** a daemon whose network access for the plugin is observed
    - **When** rules are listed, read for a session, overridden and reloaded
    - **Then** no network connection is opened; every rule comes from a local file or a manifest.
      Orca updates its rules from a server.

### Send

14. **SC-14: send types a prompt into an idle agent and waits for it to start** (CLI)
    - **Given** a fake claude session whose row is done (idle)
    - **When** a script runs `quirky agent-status send <session> "fix the tests"`, and the agent
      posts UserPromptSubmit 1 s after it receives Enter
    - **Then** the session receives the text as one bracketed paste and, after the claude entry's
      submit delay, Enter as a separate write; send exits 0 and prints `<session>: working`.
    - **Data before:** **Row**: claude, done; **Screen**: no blocked rule matches
    - **Walkthrough:**
      1. The script runs send at 0 s; the state is idle, so typing is allowed
      2. The paste `fix the tests` is written at 0 s
      3. After the submit delay* the state is checked again, still not blocked, and Enter is written
      4. The agent posts UserPromptSubmit 1 s after Enter → row working
    - **Data after:** **Send result**: ✓ working; **Session input**: ✓ one paste then one Enter

15. **SC-15: send refuses an agent waiting for approval and types nothing** (CLI)
    - **Given** a claude row waiting on PermissionRequest Bash (`rm -rf build`)
    - **When** a script runs send
    - **Then** send fails with reason `agent-blocked`, a message that the agent is waiting for
      approval of `Bash: rm -rf build`, and exit code 1, and nothing is written to the session.

16. **SC-16: send refuses an approval menu the hooks didn't report** (API)
    - **Given** the cursor session of SC-6: hooks say working, the screen shows the approval menu
    - **When** a script calls `quirky.agent-status/send`
    - **Then** it fails with `agent-blocked` naming the cursor rule, and nothing is written.

17. **SC-17: a question is refused the same way** (API)
    - **Given** a claude row waiting on AskUserQuestion ("Which branch?")
    - **When** send runs
    - **Then** it fails with `agent-blocked`, the message says the agent is waiting for an answer to
      "Which branch?", and nothing is written.

18. **SC-18: a prompt that never starts fails as stalled** (CLI)
    - **Given** an idle fake claude session that posts no hook and whose screen matches no working
      rule
    - **When** send runs, and again with `--start-timeout-ms 2000`
    - **Then** the prompt is typed, and after 5 s (then 2 s) send fails with reason
      `prompt-stalled` and a message that the text was typed and the agent may still pick it up.

19. **SC-19: a working agent gets the prompt** (API)
    - **Given** a codex row working since 0 s
    - **When** send runs at 10 s
    - **Then** the prompt is typed and send returns working at once.

20. **SC-20: a start that blocks counts as started** (API)
    - **Given** an idle claude session that posts PermissionRequest 1 s after the prompt's Enter
    - **When** send runs
    - **Then** send succeeds and reports blocked (kind approval); the CLI prints
      `<session>: blocked (approval)`.

21. **SC-21: send refuses shells and exited sessions** (CLI)
    - **When** send targets (a) a plain shell session with no agent and no row, (b) an exited
      agent session, (c) `nosuch`
    - **Then** (a) fails with `not-an-agent`; (b) with `session-exited`; (c) with `not-found`;
      nothing is written in any case.

22. **SC-22: sends to one session take turns** (API)
    - **Given** an idle claude session that posts UserPromptSubmit after each Enter
    - **When** two sends ("first", "second") start at the same moment
    - **Then** the session's input holds the whole of one paste and its Enter before any of the
      other's bytes, and both succeed.

23. **SC-23: a multi-line prompt is one prompt** (API)
    - **When** send types "line one\nline two" into an idle claude session
    - **Then** the session receives one bracketed paste holding both lines and one Enter after it.

24. **SC-24: a nested helper's hooks don't count as a start (Orca defect)** (API)
    - **Given** an idle claude session whose own agent posts nothing after the prompt, while a
      helper Claude process in the same session (a different provider session ID, as the memsearch
      helper in the doc) posts UserPromptSubmit
    - **When** send runs
    - **Then** send fails with `prompt-stalled`, and explain's deciding evidence is still the lead's
      last event, not the helper's. In Orca a helper's events overwrote the row.

### Waits

25. **SC-25: wait until the agent finishes** (CLI)
    - **Given** a claude session that send started working
    - **When** a script runs `quirky agent-status wait <session>` and the agent posts Stop at 30 s
    - **Then** the wait exits 0 at 30 s and prints idle; with no `--until` it waits for idle or
      blocked.

26. **SC-26: a state already reached returns at once** (CLI)
    - **When** `wait --until idle` runs on an idle session, and `wait --until working,blocked` on a
      blocked one
    - **Then** both return at once with that state.

27. **SC-27: a timeout exits 1 with the last state** (CLI)
    - **When** `wait --until idle --timeout-ms 3000` runs on a working session that stays working,
      and separately a wait of 150 s that the agent ends at 130 s
    - **Then** the first prints a timeout result with state working and exits 1 at 3 s; the second
      spans several method calls and exits 0 at 130 s.

28. **SC-28: an exited session ends a wait** (CLI)
    - **When** a session waited on with the default `--until` exits, and separately one waited on
      with `--until exited`
    - **Then** the first fails with `session-exited` and exit 1; the second exits 0 with exited.

29. **SC-29: a hookless agent's wait follows its screen rules** (API)
    - **Given** a cline session with no hook row, its screen busy, then showing cline's empty
      composer and staying quiet
    - **When** `wait --until idle` runs
    - **Then** it returns idle once the composer has shown quietly for the rule's quiet time, naming
      the cline rule.

30. **SC-30: wait for output that matches a pattern** (CLI)
    - **Given** a session whose screen already shows `build: 3 tests`
    - **When** a script runs (a) `wait --output 'tests'`, (b) `wait --output 'All (\d+) passed'`
      before the session prints `All 12 passed`, (c) `wait --output 'all 12' --ignore-case`, (d) a
      pattern that only matches a line the terminal wrapped across two rows
    - **Then** (a) returns at once with the line `build: 3 tests`; (b) returns when the line appears,
      printing the line and the group `12`; (c) matches regardless of case; (d) matches, because a
      wrapped line is read as one line.

31. **SC-31: output waits read recent scrollback and reject bad patterns** (CLI)
    - **When** (a) the matching line has scrolled 150 lines above the screen, (b) it scrolled 250
      lines above, with `--lines 300`, (c) the pattern is `([a-z`, (d) the pattern is `(a+)+$`,
      (e) nothing matches before `--timeout-ms 2000`, (f) the session prints the matching line
      and exits at once, (g) the session exits without ever printing a match
    - **Then** (a) and (b) match; (c) and (d) are usage errors naming the problem, exit 2, checked
      before the daemon is called (the method itself fails with `invalid-params`); (e) prints a
      timeout result naming the pattern and exits 1; (f) matches, because the exited session's
      last text is read before its exit counts; (g) fails with `session-exited` and exit 1.

### Safety under timing

38. **SC-38: an approval that appears before Enter stops the Enter** (API)
    - **Given** an idle fake cursor session, and a test that makes the screen show Cursor's
      approval menu right after the paste arrives
    - **When** send runs
    - **Then** no Enter is written; send fails with `agent-blocked` and a message that the text was
      pasted but not submitted because the agent is now waiting for approval.

39. **SC-39: a retried Enter is never written into an approval** (API)
    - **Given** an idle session of an agent whose entry retries Enter after 1200 ms, which starts
      working on the first Enter and shows an approval menu 300 ms later
    - **When** send runs
    - **Then** exactly one Enter is written, and send succeeds reporting blocked (kind approval).

40. **SC-40: a turn that starts and ends inside the submit window still counts** (API)
    - **Given** an idle claude session that posts UserPromptSubmit 10 ms after Enter and Stop
      20 ms after that
    - **When** send runs
    - **Then** send succeeds and reports idle, the state the agent reached; it does not fail with
      `prompt-stalled`.

41. **SC-41: a pattern that runs too long is cut off** (CLI)
    - **When** (a) a user rule file holds a regex that passes the shape checks but takes longer than
      the time limit on the session's screen (for example `a+a+a+a+$` over a long run of `a`
      followed by `!`), (b) a script waits with `--output` for the same pattern over that text
    - **Then** (a) the daemon keeps answering other calls, and the rule file is ignored with the
      reason that a pattern ran too long, shown by `rules list` and explain; (b) fails with
      `invalid-params` naming the pattern as too slow.

### Session names

32. **SC-32: a named session is addressed by its name** (CLI)
    - **When** a script runs `quirky session new --agent claude --name reviewer`, then
      `quirky agent-status explain reviewer`, `send reviewer "..."`, `wait reviewer`,
      `quirky session get reviewer` and `quirky session close reviewer`
    - **Then** each acts on the new session; `session list` and `session get` show its name.

33. **SC-33: naming and clearing a running session** (CLI)
    - **When** a script runs `quirky session name <id> Builder`, then `quirky session name <id>
      --clear`
    - **Then** the session is named `builder` (names are lowercase), then has no name.

34. **SC-34: names that are refused** (CLI)
    - **When** the name is (a) empty, (b) 65 characters, (c) `has space`, (d) `-lead`, (e)
      `s_reviewer`, (f) `build/1`
    - **Then** each fails with `invalid-params` and the rule it broke; the session keeps its name.

35. **SC-35: a running session's name can't be taken; an exited one's can** (CLI)
    - **Given** session A named `reviewer` and running
    - **When** a script names session B `Reviewer`; then A exits and the script names B `reviewer`
      again
    - **Then** the first fails with `name-taken` naming A; the second succeeds, B is `reviewer`,
      and A has no name.
    - **Data before:** **Session A**: running, name reviewer; **Session B**: running, no name
    - **Walkthrough:**
      1. Name B `Reviewer` → ✗ name-taken (A is running)
      2. A exits
      3. Name B `reviewer` → the name moves from A to B
    - **Data after:** **Session A**: exited, ✓ no name; **Session B**: ✓ name reviewer

36. **SC-36: an exited session keeps its name until it moves** (CLI)
    - **Given** session A named `reviewer` that has exited, and no other session with that name
    - **When** a script runs `quirky agent-status explain reviewer`
    - **Then** it explains A as exited.

37. **SC-37: names survive a daemon restart** (CLI)
    - **When** the daemon restarts with a named session stored
    - **Then** `quirky session get <name>` finds it.

## Scope and non-goals

In scope: the script state, explain, rule files and their three sources, `rules list` and `rules
show`, the guarded send, both waits, session names, and the CLI command groups for each:
`quirky agent-status explain|send|wait|rules list|rules show` and `quirky session name` plus
`--name` on `quirky session new`.

Non-goals:
- The status dot, the Activity view, the Agent Dashboard and notifications: rules never change
  them (D2). The Activity view and dashboard are left to m7-parity-sweep (m1-agent-status D1).
- Downloading or auto-updating rules (D7).
- Names in the window (tab titles, the session switcher) and in `quirky terminal` commands (D22).
- Orca's composer readiness and `terminal wait --for tui-idle` as such; the waits here replace
  them for scripts.
- Orca's code predicates in rule files (D5) and its anchors, strengths and holds.
- Remote hosts and Windows: rule paths and the CLI are macOS-tested only.

## Decisions Locked

- **Scope:** D1, D25
- **Approach:** D2
- **Output format:** D3, D10, D11
- **Error recovery:** D4, D12, D15, D19
- **Input format:** D5, D17
- **Conflict resolution:** D6, D7, D8, D9
- **Progress reporting:** D13
- **Data mapping:** D14
- **Flag design:** D16, D20
- **Exit codes:** D18
- **Duplicate handling:** D21, D22
- **Defects:** D23
- **Spec review amendments:** D27 (rulings), D28 (blocked rules first), D29 (time limit), D30
  (send owns Enter), D31 (start watched from the first Enter)

## Industry Insights

- herdr reads agent state from screen rules per agent, with a local override that always wins and
  an invalid override ignored with a warning; `agent explain` names the matched rule; its prompt
  guard refuses a blocked agent (`agent_blocked`) and reports `agent_prompt_stalled` when nothing
  starts within 5 s; `pane wait-output` checks existing text first; timeouts exit 1 and usage
  errors 2 ([agents](https://herdr.dev/docs/agents/), [CLI reference](https://herdr.dev/docs/cli-reference/),
  [SKILL.md](https://raw.githubusercontent.com/herdrdev/herdr/master/skills/herdr/SKILL.md)).
- Orca keeps hooks for state and uses screen rules to veto or lift blocked on the send path, biased
  toward blocked; a false idle while a spinner animated is an open Orca bug, and fixture replay
  caught every broken rule in a mutation check ([codex.json](https://github.com/stablyai/orca/blob/main/src/main/runtime/agent-state-rules/codex.json),
  [PR #33485](https://github.com/stablyai/orca/pull/33485), [issue #14561](https://github.com/stablyai/orca/issues/14561),
  [PR #26493](https://github.com/stablyai/orca/pull/26493)).
- Text and Enter sent in one burst leave long prompts unsubmitted in Claude Code and Codex; a
  separate Enter after the input settles works ([macf #1442](https://github.com/groundnuty/macf/issues/1442),
  [Codeman #628](https://github.com/Ark0N/Codeman/pull/628)).
- Escape sequences split across reads, so regexes over raw chunks miss; wrapped lines split matches
  unless joined (tmux `capture-pane -J`) ([crystl.dev](https://crystl.dev/guides/tmux-for-ai-agents/)).
- Length caps don't stop catastrophic backtracking; Orca rejects backreferences, lookbehind and
  repeated variable groups at load ([Orca pattern safety](https://github.com/stablyai/orca/blob/main/src/main/runtime/agent-state-rules/agent-state-rule-pattern-safety.ts),
  [regular-expressions.info](https://www.regular-expressions.info/redos.html)).
- Merged rule catalogs make order-dependent bugs; a memoized classifier that ignored reloads made
  Orca's live updates silently fail ([neopi #249](https://github.com/PsychedelicShayna/neopi/issues/249),
  [Orca PR #24387](https://github.com/stablyai/orca/pull/24387)).
- Server-fetched rules drew trust complaints ([herdr #677](https://github.com/ogulcancelik/herdr/issues/677)).

## Deferred Ideas

- [tech-spec] How the screen is read with wrapped lines joined: the PTY host's `read` returns rows.
- [tech-spec] Whether send reuses `quirky.agents/deliver` (which waits for a startup ready signal)
  or the agent entry's submit settings directly.
- [tech-spec] How waits learn of new output and row changes without polling every session.
- [tech-spec] Where `because` lives in the stored row and how older rows without it read.
- A live dot for hookless agents from screen rules (D2's revisit).
- Names in tab titles and in `quirky terminal` (D22's revisit).

## Glossary

- **Script state:** what send and the waits act on: working, blocked (with a kind), idle, unknown
  or exited.
- **Row:** a session's agent status record from m1-agent-status, driven by hooks, titles, OSC 7501
  reports and typed keys.
- **Fresh row:** a row whose evidence is under 30 minutes old and that isn't restored unconfirmed.
- **Rule file:** one agent's ordered detection rules, from a user file, a plugin's `agent-rules`
  contribution, or the built-in file.
- **Verdict:** the state the first matching rule gives, or none.
- **Because:** the evidence recorded on a row when it last changed state: source, rule and time.
- **Quiet:** a screen that hasn't changed for a rule's `quietMs`.
