# Terminal host daemon: snapshots, cold restore, paged history, bell and OSC 133, shell-ready barrier, exit codes

## Status & amendments

**Status:** Approved (headless build loop; decisions in [m1-term-daemon.md](../../../loop/decisions/m1-term-daemon.md)). Tech spec: requested.

**Amendments:**
- 2026-10-26, spec review (Codex adversarial review, D33): history pages are contiguous and sized by `lines` rather than trimmed to it (SC-11); SC-12 states the two-segment retention range; an ended session's pane shows its final screen read only, even after a host restart (new SC-42).
- 2026-10-26, tech-spec authoring: methods follow the plugins' camelCase naming (`killAll`, `restartHost`) and the finished-command event is `commandFinished`; CLI words stay `kill-all` and `restart-host` ([D29](../../../loop/decisions/m1-term-daemon.md)). SC-38: a protocol 1 host's session is not restorable, since that host kept no restorable history.

## Conceptual model

`quirky-pty` already owns every PTY and outlives `quirkyd` and the window
([architecture.md](../../../architecture.md#processes)). Today it keeps a 1 MiB raw tail, a 200-row
emulator and a raw log that a new host wipes, so a returning pane gets bytes rather than a screen,
a host crash loses every terminal, and nothing past the tail can be read back. This item makes the
host the keeper of terminal state that [the architecture](../../../architecture.md#terminal-history)
describes, and adds the Orca behaviours of [term-daemon.md](../../../../research/orca-features/term-daemon.md)
that M1 needs.

Each session in the host has four things:

1. **The process**, with an exit status recorded the way a shell's `$?` reads it
   ([D11](../../../loop/decisions/m1-term-daemon.md)).
2. **The screen**: an emulator holding only the visible screen and its modes, no scrollback. Any
   client can get an exact **snapshot** of it ([D5](../../../loop/decisions/m1-term-daemon.md),
   [D8](../../../loop/decisions/m1-term-daemon.md), [D20](../../../loop/decisions/m1-term-daemon.md)).
3. **The history**: an append-only log on disk of everything the session printed, with its resizes,
   and a **checkpoint** of the screen written every few seconds while output changes. Older output is
   read back a page at a time by replaying part of the log
   ([D7](../../../loop/decisions/m1-term-daemon.md), [D18](../../../loop/decisions/m1-term-daemon.md),
   [D24](../../../loop/decisions/m1-term-daemon.md)).
4. **What the shell is doing**: whether its first prompt is ready (the **shell-ready barrier** holds
   input until it is), and the bells, finished commands, titles and working directory it reports
   through escape sequences ([D15](../../../loop/decisions/m1-term-daemon.md),
   [D16](../../../loop/decisions/m1-term-daemon.md)).

Because the history and checkpoint are on disk, a session survives three kinds of restart
differently:

| What restarted | The process | What a returning pane sees |
|---|---|---|
| The window, or `quirkyd` | keeps running | its screen and recent history, exactly as they were (**reattach**) |
| The host (crash, `restart-host`, reboot) | is gone | after a **restore**, a new shell in the old directory with the old screen and history above its prompt (**cold restore**) |
| Nothing; the session was killed or exited | is gone | its final screen and history, read only, even after the host restarted |

A session whose host went away is **restorable**. It stays exited until someone opens its pane or
runs `quirky session restore`, which starts the user's shell in its place under the same session id
([D10](../../../loop/decisions/m1-term-daemon.md)).

People reach the host's management flows through a **Terminal Sessions** panel, Quirky's version of
Orca's Settings → Terminal → Manage Sessions: list, kill one, kill all, restart the host
([D3](../../../loop/decisions/m1-term-daemon.md), [D14](../../../loop/decisions/m1-term-daemon.md)).
Agents reach the same flows, and everything else here, through `quirky.terminal` methods and the
`quirky terminal` command group.

## Data flow

**Output.** The shell writes to its PTY. The host takes each chunk and, in order: removes the
shell-ready marker if it is there (and marks the shell ready), appends the chunk to the session's
log, keeps it in the 256 KiB hot tail, feeds it to the screen emulator, scans it for bells and
OSC sequences, and sends it to every subscribed client. Scanning keeps its state between chunks,
so a sequence split across two reads is still seen once. Each fact found becomes a host event that
`quirkyd`'s `quirky.terminal` plugin republishes as a plugin event. The session is now dirty; within
five seconds the host writes a checkpoint of the screen and the log position it covers.

**Input.** A client's keystrokes go to the host. While the shell is `pending`, they wait in a queue;
when the marker arrives, or 15 seconds pass, the queue goes to the PTY in order and later input goes
straight through. Input for an exited session is refused.

**Attach.** A pane calls `quirky.terminal/attach` with its size and how many history lines it keeps.
The plugin resizes the session, then asks the host for a subscription. The host answers with the
history lines rendered from the log, followed by the screen snapshot, as one block the pane writes
into a fresh terminal, and with the output position that block ends at. Live output after that
position follows on the pane's stream. The pane's existing input gate keeps the emulator's answers to
queries inside that block from reaching the shell.

**History.** `quirky.terminal/history` asks the host for lines before a cursor. The host reads back
through the log from that point until it has enough lines, replays that stretch through a scratch
emulator of the session's size, and returns the rendered rows and a cursor for the next page.

**Host gone.** When `quirkyd` reconnects to a host that doesn't know a session it has on record, it
asks the host what is on disk. A session with history that never ended cleanly is marked exited,
cause `host-lost`, restorable. `restart-host` does the same with cause `host-restart`.

**Restore.** `quirky session restore` (or an attach to a restorable session) asks the host to create
the session again with restore on. The host rebuilds the screen from the checkpoint plus the log
written after it, starts the user's shell in the last known directory at the last known size, puts
the old screen above the new prompt, and keeps appending to the same log. The session's record
goes back to `running`, with agent `shell`.

## Key decisions

- **The host is the only keeper of terminal state.** History is on disk, the screen is in one
  emulator with no scrollback, and the per-session memory cost is the screen plus a 256 KiB tail
  ([D20](../../../loop/decisions/m1-term-daemon.md), [D24](../../../loop/decisions/m1-term-daemon.md)).
- **One replay block on attach.** The pane keeps writing one `replay`, now built from history plus an
  exact snapshot, so v1's pane works unchanged and m1-term-ui can page further
  ([D5](../../../loop/decisions/m1-term-daemon.md), [D6](../../../loop/decisions/m1-term-daemon.md)).
- **Restore is lazy and explicit.** Nothing respawns by itself; opening the pane or `quirky session
  restore` does, and typing into a lost session is refused rather than sent to a new shell
  ([D9](../../../loop/decisions/m1-term-daemon.md), [D10](../../../loop/decisions/m1-term-daemon.md)).
- **Exit codes read like `$?`.** A normal exit gives its status; a signal gives 128+n and names the
  signal; a host loss gives no code. Each ended session says why it ended
  ([D11](../../../loop/decisions/m1-term-daemon.md)).
- **Facts come from the host.** Bells, command finishes, titles and cwd changes are events from the
  host's scan, so a hidden pane misses nothing ([D16](../../../loop/decisions/m1-term-daemon.md)).
- **Irreversible host actions confirm.** Kill, kill all and restart host ask unless `--yes`
  ([D12](../../../loop/decisions/m1-term-daemon.md), [D13](../../../loop/decisions/m1-term-daemon.md)).
- **History degrades instead of failing.** Damaged files fall back step by step, and a disk error
  stops history for one session, never the terminal ([D19](../../../loop/decisions/m1-term-daemon.md)).
- **The PTY protocol is version 2**, with an older host retired and a newer one refused
  ([D17](../../../loop/decisions/m1-term-daemon.md)).

## Behavior & scenarios

Every scenario runs against a fresh temporary `QUIRKY_HOME` with a real `quirkyd`, the real
`quirky-pty` and the built-in plugins, and is driven through the `quirky` CLI or the daemon API as
it says. Panes are the UI's terminal view. Shells are `/bin/zsh` unless a scenario says `/bin/bash`;
neither reads the user's own startup files in tests. Fixtures are illustrative.

Most scenarios use repo **api** at `/tmp/w/api` with worktrees **main** (at `/tmp/w/api`) and
**fix-login** (at `/tmp/w/worktrees/api/fix-login`), and a shell session **s1** in **main**.

### Opening a terminal and the shell-ready barrier

1. **SC-1: a new shell session is ready at its first prompt** (CLI)
   - **Given** worktree **main**
   - **When** the agent runs `quirky session new --worktree main` and then `quirky terminal sessions`
   - **Then** the session's shell runs in `/tmp/w/api`, its row shows state `running` and shell state `ready` once the prompt is drawn, and `quirky terminal snapshot` shows the prompt
   - **Data before:** **Sessions**: none
   - **Walkthrough:**
     1. The agent creates **s1**; its shell starts with state `pending`
     2. The shell draws its first prompt and reports ready
   - **Data after:** **s1**: ✓ running; shell state `ready`; cwd `/tmp/w/api`

2. **SC-2: input sent before the prompt waits for it** (CLI)
   - **Given** a zsh session whose startup takes 2 seconds* before the first prompt
   - **When** the agent runs `quirky terminal send s1 'echo one' --enter` and `quirky terminal send s1 'echo two' --enter` right after creating it
   - **Then** nothing reaches the shell until the prompt is ready, then both lines run once each, in order, and the output shows `one` before `two`
   - **Data before:** **s1**: shell state `pending`
   - **Walkthrough:**
     1. The agent sends `echo one⏎` and `echo two⏎`; both are held
     2. The prompt appears; the held input is delivered in order
   - **Data after:** **s1**: ✓ shell state `ready`; ✓ output has `one` then `two`, each once

3. **SC-3: the ready marker never shows** (API)
   - **Given** a zsh session and a bash session that have reached their prompt
   - **When** a client reads `quirky.terminal/snapshot`, `quirky.terminal/history` and the attach replay
   - **Then** none of them contains the ready marker, and neither does the log on disk

4. **SC-4: a shell that never reports ready gets its input after 15 seconds** (API)
   - **Given** a zsh session whose startup files block for 20 seconds* before the prompt
   - **When** the agent sends `echo late⏎` at once
   - **Then** the shell state becomes `timed_out` 15 seconds after the start, the held input is delivered then, and once the shell reads it `late` is printed

5. **SC-5: agent sessions and unwrapped shells have no barrier** (API)
   - **Given** a session started for an agent command, and a shell session on `/bin/sh`
   - **When** a client writes to each right after it starts
   - **Then** both show shell state `unsupported` and the input goes to the process at once

### Reattach and snapshots

6. **SC-6: restarting `quirkyd` keeps running commands and repaints the pane** (CLI, UI)
   - **Given** **s1** has printed `marker-1` to `marker-50` and is running `sleep 7777`, and a pane is open on it
   - **When** `quirkyd` is stopped and started again, and the pane is opened again
   - **Then** `sleep` has the same pid, the pane shows the earlier lines and the `sleep` command line exactly where they were, `quirky terminal sessions` still lists **s1** as running, and Ctrl+C in the pane ends that same `sleep` with a fresh prompt
   - **Data before:** **s1**: running; `sleep 7777` pid 4242*
   - **Walkthrough:**
     1. `quirkyd` stops; the host and **s1** keep running
     2. `quirkyd` starts and reconnects; the pane attaches and writes the replay
     3. The person presses Ctrl+C in the pane
   - **Data after:** **s1**: ✓ still running; ✓ `sleep` pid 4242* ended by SIGINT; ✓ new prompt

7. **SC-7: attach restores a full-screen program's frame and modes** (API)
   - **Given** a session running a program that switched to the alternate screen, turned on bracketed paste and mouse reporting, and drew a frame with colours
   - **When** a client attaches with the session's size
   - **Then** the replay, written into a fresh terminal of that size, shows the same frame, colours and cursor position as the host's screen, in the alternate screen, with bracketed paste and mouse reporting on; `snapshot.modes` reports the same

8. **SC-8: the attach replay is recent history, then the screen, with a cursor for more** (API)
   - **Given** **s1** has printed 5,000 numbered lines in a 80x24 terminal
   - **When** a client attaches with `historyLines` 2,000
   - **Then** the replay holds the 2,000 lines above the screen and then the screen, so the fresh terminal shows lines up to 5,000 with 2,000 lines of scrollback; `historyCursor` is set because older lines exist; without `historyLines` the default is 2,000
   - **Data before:** **s1** history: lines 1 to 5,000*
   - **Walkthrough:**
     1. The client attaches with `historyLines` 2,000
   - **Data after:** **Replay**: ✓ about 2,000 history lines, then the 24-row screen ending at line 5,000; **historyCursor**: ✓ set

9. **SC-9: no output is lost or repeated between the replay and the live stream** (API)
   - **Given** **s1** printing a numbered line every 5 ms*
   - **When** a client attaches while it prints, then reads its stream for one second
   - **Then** the numbers in the replay followed by the stream run without a gap or a repeat

10. **SC-10: a snapshot reports the screen as JSON** (CLI)
    - **Given** **s1** after `cd /tmp/w/api/src`, a command that set the title to `build`, and `printf '\e[?2004h'`
    - **When** the agent runs `quirky terminal snapshot s1 --json`
    - **Then** it returns the screen as ANSI, the size, the cursor position, the modes (bracketed paste on, alternate screen off), cwd `/tmp/w/api/src`, title `build`, shell state `ready` and the output position
    - **Data before:** **s1**: cwd `/tmp/w/api`
    - **Walkthrough:**
      1. The agent runs the three commands, then the snapshot command
    - **Data after:** **Output**: ✓ `cwd: /tmp/w/api/src`; ✓ `title: build`; ✓ `modes.bracketedPaste: true`; ✓ `shellState: ready`

### Paged history

11. **SC-11: history pages back to the oldest output** (CLI)
    - **Given** **s1** has printed lines `h-1` to `h-1000`
    - **When** the agent runs `quirky terminal history s1 --lines 300`, then repeats it with `--before` set to each returned cursor
    - **Then** each page prints about 300 lines (more when long lines wrap) oldest first, ending exactly where the previous page began; together the pages hold every line once, in order; the last page starts with the session's first output and has no next cursor; `--ansi` returns the same rows with their colours
    - **Data before:** **s1** history: `h-1` to `h-1000`
    - **Walkthrough:**
      1. Page 1 returns the lines ending at the screen's top, with cursor **c1**
      2. The agent asks for 300 lines before **c1**, and so on
    - **Data after:** **Pages**: ✓ together `h-1` to `h-1000` once each; ✓ the last cursor is null

12. **SC-12: a long session keeps its newest 32 MiB** (API)
    - **Given** **s1** has printed 40 MiB of numbered lines
    - **When** a client pages history to the end
    - **Then** the oldest page starts at a whole line no older than the newest 32 MiB and no newer than the newest 16 MiB (two 16 MiB segments are kept, so how much survives depends on where the current segment is; at 40 MiB it is about the newest 24 MiB), every later line is present once, and the session's log on disk never holds more than 32 MiB of output plus one record

13. **SC-13: `read` returns the screen plus history lines** (CLI)
    - **Given** **s1** has printed `r-1` to `r-500`
    - **When** the agent runs `quirky terminal read s1 --lines 100`
    - **Then** it prints the 100 lines above the screen followed by the screen, as text, as v1 did

14. **SC-14: output that redraws in place reads back as it looked** (API)
    - **Given** **s1** ran a progress bar that rewrote one line with carriage returns, then printed `done`
    - **When** a client reads history over that stretch
    - **Then** the history shows the bar's final state once, not every intermediate redraw

### Checkpoints and cold restore

15. **SC-15: a busy session is checkpointed, an idle one costs nothing** (API)
    - **Given** **s1** printing output and **s2** sitting at its prompt
    - **When** six seconds pass
    - **Then** **s1** has a checkpoint at most five seconds old covering its output, and **s2**'s checkpoint did not change after its first prompt

16. **SC-16: a lost host leaves its sessions restorable** (CLI)
    - **Given** **s1** running, after `cd /tmp/w/api/src` and printing `before-crash`
    - **When** the host process is killed with SIGKILL and the agent runs `quirky session list --json`
    - **Then** **s1** is `exited` with cause `host-lost`, no exit code, and `restorable: true`; `quirky terminal history s1` still prints `before-crash`
    - **Data before:** **s1**: running
    - **Walkthrough:**
      1. The host dies; `quirkyd` reconnects to a new host
      2. The new host reports **s1**'s history on disk as not ended
    - **Data after:** **s1**: ✓ exited; ✓ cause `host-lost`; ✓ exit code none; ✓ restorable

17. **SC-17: opening a lost session's pane restores it** (UI, API)
    - **Given** **s1** restorable as in SC-16
    - **When** the person opens **s1**'s pane
    - **Then** the pane shows `before-crash` and the old screen above a new prompt, the new shell's cwd is `/tmp/w/api/src`, the terminal has **s1**'s last size, the attach result says `restored: true`, the session is `running` with agent `shell`, and history pages back through output from before and after the restore
    - **Data before:** **s1**: exited, restorable; last cwd `/tmp/w/api/src`; size 100x30*
    - **Walkthrough:**
      1. The pane attaches; the plugin restores **s1** first
      2. The host rebuilds the old screen and starts zsh in `/tmp/w/api/src` at 100x30*
    - **Data after:** **s1**: ✓ running; ✓ agent `shell`; ✓ restored; **Pane**: ✓ old output above a new prompt

18. **SC-18: `quirky session restore` restores without a pane, once** (CLI)
    - **Given** **s1** restorable, **s2** running, and **s3** ended by `exit 0`
    - **When** the agent runs `quirky session restore` on each
    - **Then** **s1** is restored as in SC-17; **s2** is returned unchanged; **s3** fails with a conflict saying it ended normally and can't be restored; running the command on **s1** again returns it unchanged

19. **SC-19: a reboot leaves sessions restorable** (CLI)
    - **Given** **s1** and **s2** running, with output
    - **When** the host and `quirkyd` are both killed with SIGKILL, and `quirkyd` is started again
    - **Then** both sessions are `exited`, cause `host-lost`, restorable, and each restores as in SC-18 with its own screen and history

20. **SC-20: damaged history restores what it can** (API)
    - **Given** four restorable sessions: one with a torn last log record, one with an unreadable checkpoint, one with an unreadable log, one with both unreadable
    - **When** each is restored
    - **Then** the first restores everything before the torn record; the second rebuilds its screen from the log; the third restores the checkpoint's screen and history it covered; the fourth starts a fresh shell under the note `[history could not be read]`; all four end `running`

21. **SC-21: restored output never types into the new shell** (API)
    - **Given** a restorable session whose history contains terminal queries (cursor position, device attributes and colour queries)
    - **When** it is restored and a client attaches
    - **Then** the new shell receives no input until the client types, and its first command line holds only what was typed

22. **SC-22: writing to an ended session is refused with a reason** (CLI)
    - **Given** **s1** restorable and **s3** ended by `exit 0`
    - **When** the agent runs `quirky terminal send s1 'ls' --enter` and the same for **s3**
    - **Then** both fail with a conflict and exit code 1; **s1**'s message says it ended when the terminal host stopped and to run `quirky session restore s1`; **s3**'s says it has exited; `quirky terminal read` and `history` still work on both

### Kill, kill all and restart host

23. **SC-23: kill one force-quits a session and keeps its output** (CLI)
    - **Given** **s1** running `sleep 7777` in the background of its shell
    - **When** the agent runs `quirky terminal kill s1`, answers the ask, then runs it again with `--yes` on **s2**
    - **Then** the first asks "Kill this session?" with "Force-quits s1. Any unsaved work in that pane is lost. This can't be undone." before doing anything; once answered yes, the shell and its `sleep` are gone, **s1** is `exited` with cause `killed`, exit code 137 and signal SIGKILL, not restorable, and its history still reads; `--yes` on **s2** does the same without asking

24. **SC-24: kill all reports what it killed and leaves the host up** (CLI)
    - **Given** three running sessions
    - **When** the agent runs `quirky terminal kill-all --yes --json`
    - **Then** it returns `killedCount` 3, `remainingCount` 0 and the three ids; all three are `exited`, cause `killed`; the host's pid is unchanged and a new session starts normally; with no live sessions it returns `killedCount` 0

25. **SC-25: restart host ends every session as restorable and starts a new host** (CLI)
    - **Given** **s1** and **s2** running
    - **When** the agent runs `quirky terminal restart-host`, then answers the ask "Restart the terminal service?" ("Open terminals and agents will restart.")
    - **Then** both sessions are `exited` with cause `host-restart` and restorable, the host has a new pid, and each restores as in SC-18

26. **SC-26: the Terminal Sessions panel lists live sessions** (UI)
    - **Given** **s1** in worktree **main** of **api** and **s2** in worktree **fix-login**, both running, and one exited session
    - **When** the person runs the command "Terminal: Manage Sessions"
    - **Then** the panel opens with the header "Sessions (2)", a row per live session with a green dot, its workspace label (`w/api` and `api/fix-login`), its session id and a kill button, and Refresh, Kill all sessions and Restart terminal host buttons; clicking **s2**'s row opens **s2**'s view; `quirky ui state` reports the same rows
    - **Screen states:**

      | Element | Shown |
      |---|---|
      | Header | ✓ "Sessions (2)" with Refresh, Kill all sessions, Restart terminal host |
      | Row s1 | ✓ green dot; `w/api`; `s1`; kill button |
      | Row s2 | ✓ green dot; `api/fix-login`; `s2`; kill button |
      | Exited session | ✗ not listed |

27. **SC-27: killing a session from the panel confirms first** (UI)
    - **Given** the panel open with **s1** and **s2**
    - **When** the person clicks **s1**'s kill button, then confirms
    - **Then** a dialog "Kill this session?" with the Orca text and a "Kill session" button appears; cancelling leaves **s1** running; confirming removes **s1**'s row and the header reads "Sessions (1)"

28. **SC-28: restarting from the panel empties it, and an open pane restores** (UI)
    - **Given** the panel open with **s1**, and **s1**'s pane visible
    - **When** the person clicks Restart terminal host and confirms "Restart the terminal service?"
    - **Then** the panel shows "Sessions (0)" and "No sessions." until a pane restores; **s1**'s pane shows its old output above a new prompt in the same directory, and the panel then lists **s1** again

29. **SC-29: kill all is disabled with nothing to kill** (UI)
    - **Given** no live sessions
    - **When** the person opens the panel
    - **Then** it reads "Sessions (0)" and "No sessions.", and Kill all sessions is disabled

### Bells and OSC 133

30. **SC-30: a bell is reported with no pane open** (API)
    - **Given** **s1** with no pane attached and a client subscribed to events
    - **When** **s1** prints a BEL, and later sets its title with an OSC sequence that ends in BEL
    - **Then** exactly one `quirky.terminal/bell` event arrives, for the first; the title sequence gives a `quirky.terminal/title` event and no bell

31. **SC-31: a finished command reports its exit code** (API)
    - **Given** a zsh session and a bash session at their prompts, and a subscribed client
    - **When** each runs `true`, then `false`, then `sh -c 'exit 7'`
    - **Then** each session gives three `quirky.terminal/commandFinished` events with exit codes 0, 1 and 7, in order

32. **SC-32: sequences split across reads are seen once** (API)
    - **Given** a session whose program writes a BEL, an OSC 133;D;4 and an OSC 7 one byte at a time with pauses between the bytes
    - **When** the output arrives in many small reads
    - **Then** exactly one bell, one commandFinished (exit code 4) and one cwd event arrive, and nothing is reported for the partial pieces

33. **SC-33: title and cwd changes are reported once per change** (API)
    - **Given** **s1** and a subscribed client
    - **When** **s1** sets its title to `a`, sets it to `a` again, then to `b`, and changes directory twice
    - **Then** the client gets `title` events for `a` and `b` only and two `cwd` events with the new directories

### Exit codes

34. **SC-34: `exit 3` in an interactive shell records 3** (CLI; Orca defect)
    - **Given** a zsh session and a bash session at their prompts
    - **When** the agent sends `exit 3` to each
    - **Then** both are `exited` with exit code 3, no signal, cause `exited`, and `quirky session list --json` shows that
    - **Data before:** **s1** (zsh), **s4** (bash): running
    - **Walkthrough:**
      1. The agent runs `quirky terminal send s1 'exit 3' --enter`, and the same for **s4**
    - **Data after:** **s1**: ✓ exit code 3; ✓ cause `exited`; **s4**: ✓ exit code 3; ✓ cause `exited`

35. **SC-35: an agent command's exit status comes through its login shell** (API)
    - **Given** an agent session whose command is a script that exits 5
    - **When** the script exits
    - **Then** the session is `exited` with exit code 5

36. **SC-36: a signal death reports 128 plus the signal** (API)
    - **Given** a session whose process is killed with SIGTERM from outside Quirky
    - **When** it dies
    - **Then** it is `exited` with exit code 143, signal `SIGTERM`, cause `exited`

### Memory

37. **SC-37: many busy sessions don't grow the host without bound** (API; Orca defect)
    - **Given** a host with 40 sessions
    - **When** each prints 4 MiB of output
    - **Then** the host's resident memory grows by less than 1.5 MiB per session plus 40 MiB in total, and every session's history still reads back its newest lines

### Versions

38. **SC-38: an older host is retired, a newer one refused** (API)
    - **Given** a home where a host speaking protocol 1 is running with one session
    - **When** `quirkyd` starts
    - **Then** it shuts that host down, starts a protocol 2 host, and the old session is `exited` with cause `host-restart` and not restorable (a protocol 1 host kept no restorable history); with a host speaking protocol 3 instead, `quirkyd` leaves it running and fails to connect with an error naming versions 2 and 3

### Lifecycle and the plugin

39. **SC-39: closing a session deletes its history** (CLI)
    - **Given** **s1** exited, with history
    - **When** the agent runs `quirky session close s1`
    - **Then** its history directory is gone, and `quirky terminal history s1` fails with not found

40. **SC-40: every terminal host flow is scriptable** (CLI)
    - **Given** a running daemon
    - **When** the agent runs `quirky api --json`
    - **Then** it lists `quirky.terminal/snapshot`, `history`, `sessions`, `kill`, `killAll`, `restartHost` and `quirky.session/restore` with their argument schemas, the `terminal` group has `snapshot`, `history`, `sessions`, `kill`, `kill-all` and `restart-host` commands, `session` has `restore`, and the events `bell`, `commandFinished`, `title` and `cwd` are declared
    - **Data after:** **quirky api --json**: ✓ the seven methods with schemas; ✓ the four events

41. **SC-42: an ended session's pane shows its final screen, read only** (UI, API)
    - **Given** **s3** ended by `exit 0` after printing `bye`, and then the host was restarted
    - **When** the person opens **s3**'s pane (or a client attaches to it)
    - **Then** the pane shows **s3**'s history and final screen including `bye`, the attach result says `live: false`, no shell is started, and typing in the pane sends nothing

42. **SC-41: the feature uses only the public plugin API** (API)
    - **Given** the built-in plugins
    - **When** the plugin fence test runs
    - **Then** `quirky.terminal` and `quirky.session` import nothing from the daemon's private modules; what they need from the host comes through `context.pty`

## Scope & non-goals

In scope: term-daemon.md flows 1 to 7 (open, quit and relaunch, crash and reboot recovery, kill one,
kill all, restart, and the fixed live scrollback), the roadmap's snapshot, checkpoints, cold
restore, paged history, bell and OSC 133, shell-ready barrier and exit codes, and the two Orca
defects in D21.

Non-goals ([D22](../../../loop/decisions/m1-term-daemon.md)):

- The macOS launchd helper, code-signed host copy and TCC attribution notices.
- Linux systemd scopes and memory limits, Windows named pipes and ConPTY, a fish wrapper
  ([D23](../../../loop/decisions/m1-term-daemon.md), deferred: platform).
- The spawn gate, automatic-work pause and the host-wide terminal cap.
- Legacy and newer-protocol adapters beyond D17's retire-or-refuse.
- Orca's control/stream socket pair and its binary-v1 framing; Quirky's host already frames binary
  on one socket.
- Background stream thinning, `dataGap` and delegated scanning; Quirky's host always scans.
- Foreground process tracking and close confirmation (m1-agent-status, m1-term-ui).
- Chunked history-seed upload; the host restores from its own files.
- Answering colour queries from the host, and the daemon's NDJSON diagnostic log.
- Resuming an agent's conversation on restore (m1-providers); a restore opens a shell.
- Pane-side paging, split panes and the pane's exit overlay (m1-term-ui).

## Decisions Locked

- **Scope:** one item; Manage Sessions is a panel — D3
- **API response-format:** attach returns history then screen as one replay, plus offset, history cursor, size, restored and shell state — D5; `snapshot` returns JSON — D8
- **API pagination:** opaque cursor, 200 lines default, 10,000 cap, text or ANSI — D7; attach depth from the pane's scrollback setting, 2,000 default — D6
- **API error-responses:** writes to exited or restorable sessions fail with a conflict naming the reason — D9
- **API versioning:** protocol 2; older host retired, newer refused — D17 — assumed — fast-tracked
- **CLI flags and exit codes:** `--yes` skips confirmation; conflicts exit 1 — D12, D13
- **Data idempotency:** restore is lazy, keeps the id, and is a no-op on a running session — D10
- **Data error-handling:** stepwise fallback; disk errors stop one session's history — D19
- **Data retention:** 16 MiB x 2 log segments, checkpoints every 5 s while dirty, deleted on close — D18
- **Exit codes:** status, 128+n with the signal name, cause and restorable — D11
- **Barrier:** zsh and bash shells, 15 s — D15 — assumed — fast-tracked
- **Facts:** bell, command-finished, title, cwd events from the host — D16
- **Memory:** no scrollback in memory, 256 KiB tail — D20
- **Approach:** history rendered on read from the log — D24; serialize addon pinned — D25

## Industry Insights

- Snapshot through a headless emulator's serializer, written into a terminal of the same size, but
  pin versions: SerializeAddon has open cursor and scroll-region bugs
  ([#6165](https://github.com/xtermjs/xterm.js/issues/6165),
  [#6233](https://github.com/xtermjs/xterm.js/issues/6233),
  [#6234](https://github.com/xtermjs/xterm.js/issues/6234)).
- Restore must re-arm modes (alternate screen, mouse, bracketed paste); a raw byte replay or a
  reset sequence alone brings back the wrong ones
  ([shpool-vterm #10](https://github.com/shell-pool/shpool-vterm/pull/10),
  [sshbox #265](https://github.com/triasbrata/sshbox/pull/265)).
- Replays must carry resizes in order, or redraws stack up misaligned
  ([Archestra #9660](https://github.com/archestra-ai/archestra/pull/9660)).
- Never let replayed queries reach the shell: replies to DA1, DSR and OSC 10/11 read as keystrokes
  ([Claude Code report](https://claudeissues.com/issue/91530-bug-claude-resume-exits-at-startup-under-tmux-probe-replies-read-as-input)).
- Shell integration sources the user's rc first and registers hooks after; OSC 133 A/B/C/D is the
  portable core ([VS Code](https://code.visualstudio.com/docs/terminal/shell-integration),
  [iTerm2](https://iterm2.com/documentation-escape-codes.html)).
- Buffer input until the prompt mark with a timeout, since a failed injection never sends one.
- Write checkpoints to a temp file, fsync, then rename
  ([atomic replace](https://users.rust-lang.org/t/how-to-write-replace-files-atomically/42821/13)).
- Bound per-session memory by bytes, not by a deep in-memory grid; Zed's pty-host RFC and Orca's own
  OOM comment both point there ([Zed #50584](https://github.com/zed-industries/zed/discussions/50584)).
- Cold restore restores text and a fresh shell, never the old process; Zellij's resurrection works
  the same way ([Zellij 0.39](https://zellij.dev/news/session-resurrection-ui-components/)).
- Measured here: `@xterm/headless` 5.5 parses about 120 MB/s, so replaying a page of log is cheap.

## Deferred Ideas

- `[tech-spec]` How the host maps a history cursor to log positions across rotated segments.
- `[tech-spec]` Whether the checkpoint timer should prefer a moment right after a prompt mark (research: mid-sequence snapshots break).
- `[tech-spec]` How the plugin learns that a host speaks an older protocol (the hello error text or a version field).
- Agent resume on restore (m1-providers).
- Bell and command-finished notifications, cooldowns and badges (m1-notifications).

## Glossary

- **Session:** a terminal or structured session record in `quirky.session`; here always a terminal one.
- **Host:** `quirky-pty`, the detached process that owns PTYs and their history.
- **Snapshot:** the visible screen and its modes, serialized so writing it into a fresh terminal of the same size reproduces it.
- **History:** everything a session printed, kept in its log on disk and read back a page at a time.
- **Checkpoint:** a snapshot saved to disk together with the log position it covers.
- **Replay:** the block an attach returns: history lines then the snapshot.
- **Output position (offset):** the count of output bytes a session has produced; a replay ends at one, and the live stream continues from it.
- **History cursor:** an opaque token naming where the next older history page ends.
- **Reattach:** attaching to a session whose process is still running.
- **Cold restore:** starting a new shell for a session whose process is gone, with its old screen and history above the prompt.
- **Restorable:** a session that ended because its host stopped, with history on disk.
- **Shell-ready barrier:** holding input until the shell's first prompt, or 15 seconds.
- **Shell state:** `pending`, `ready`, `timed_out` or `unsupported`.
- **Exit cause:** `exited`, `killed`, `host-restart` or `host-lost`.
- **Hot tail:** the last 256 KiB of a session's output kept in memory, for catching up a client after a reconnect.
