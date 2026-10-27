# Notifications: unread markers, cooldown, banner text, sounds, tray dot

## Status & amendments

**Status:** Approved (headless build loop; decisions in [m1-notifications.md](../../../loop/decisions/m1-notifications.md)). Tech spec: requested.

**Amendments:** none yet.

## Conceptual model

Quirky v1 shows a toast and a native banner every time an agent finishes or needs input, with one
on/off switch. Orca ([notifications.md](../../../../research/orca-features/notifications.md)) treats
attention as state: when an agent finishes, a terminal rings its bell or a program asks for
attention, the session and its workspace get an amber "unread" marker unless the person is already
looking at them, and only then is a banner considered. The banner passes a master switch, a switch
per source, a focus check and a 5-second cooldown per workspace, and plays the chosen sound. The
menu bar icon gets a dot while the window is hidden, and the dock badge counts unread workspaces.
This item brings Quirky to that, and adds the OSC 9, OSC 99 and OSC 777 notifications that terminal
programs already send (roadmap M1).

**One policy, in a plugin.** A new built-in plugin, `quirky.notifications`, is the only thing that
decides attention and delivery. The plugins that know something happened report it as an event:
agent status when a row settles, structured sessions when a turn ends, terminals when a bell rings
or a program sends a notification, asks when a question surfaces. None of them shows a notification
itself any more. Turning `quirky.notifications` off turns notifications off (D5).

**Unread is state, written first.** An event on a session the person isn't viewing marks the
session (its tab shows an amber bell) and, unless its worktree is open in front of them, the
worktree (its card shows the bell and a bold name). Marks are written before any switch is
consulted, so a disabled, suppressed or throttled banner still leaves them (D9). The markers live on
the session and worktree records, and their own plugins draw them (D35, D36).

**Viewing means attended.** A session is viewed when a window is focused, the person has used its
mouse or keyboard in the last 3 minutes, and its worktree view shows the session. Viewing clears the
session's marker and its worktree's. If the person hasn't touched the window for 3 minutes, events
mark unread even on the visible tab, and the next touch clears what is on screen (D10).

**Delivery is gated, then rendered elsewhere.** A banner passes Enable Notifications, its source's
switch, Suppress While Focused and the cooldown, in that order, and the result names the gate that
stopped it (D13). A delivered banner becomes one `notify` event; the desktop shell shows it and
plays the sound, the window shows a toast, and with no desktop client connected `quirkyd` shows it
itself (D18, D19). The shell also lights the tray dot and shows the dock badge, which the daemon
computes as unread worktrees plus pending asks (D24, D25).

## Data flow

1. **An event arrives.** One of: `quirky.agent-status/settled` (a live row reached done, waiting or
   blocked), `quirky.structured/settled`, `quirky.terminal/bell`, `quirky.terminal/notification`
   (the PTY host saw an OSC 9, 99 or 777 notification), a scripted `quirky notifications send`, an
   ask that surfaced, or the test button.
2. **Attention.** For agent, structured, bell and program events, the plugin works out whether the
   session is viewed (D10) and, if not, sets the session's unread reason and, unless the worktree is
   viewed, the worktree's unread flag. Asks and tests skip this.
3. **Tray.** For the same sources it emits an attention event; the shell lights the dot if its
   window is hidden, minimized or closed.
4. **Gates.** Enable Notifications, then the source's switch, then Suppress While Focused, then the
   cooldown. The first that fails stops the banner and is the result.
5. **Delivery.** The plugin builds the banner text (D16) and calls `notify` with the title, body,
   session, worktree, an action that opens the session, and the sound to play. The shell shows the
   banner (silent when a sound file is chosen) and plays the file with the chosen volume. The window
   shows a toast. With no desktop client, `quirkyd` shows the banner through the OS notifier and
   plays the sound.
6. **Badge.** Any change to a worktree's unread flag, a session's unread reason, or the pending asks
   recomputes the badge; the plugin emits it, and the shell sets the dock label.
7. **Reading.** A change in window focus, presence, the open view or the sessions it shows makes the
   plugin re-check what is viewed and clear markers that are now on screen. Mark Read on a worktree
   clears it and all its sessions' markers.

The PTY host parses the three OSC forms (D28); the bytes still reach the terminal and its history.

## Key decisions and rationale

- **Listening plugin, not a dispatch method** (D5, D40): producers emit events, so turning the
  feature off needs no fallback in each producer, and every source passes the same gates. That
  fixes Orca's side channels that skipped focus, cooldown and switches.
- **Daemon policy, shell rendering** (D40): the daemon knows layout, focus and every record, keeps
  working with the window closed, and answers the CLI. The shell keeps only what needs the OS: the
  banner, the sound, the dot, the badge label.
- **Markers on records** (D35): the session tab and the worktree card are drawn by quirky.session
  and quirky.worktree, which read their own records; `quirky session` and `quirky wt` show them.
- **Presence from the window** (D10, D11): only the window sees the person's input; the kernel
  carries it with window focus and tells plugins when either changes.
- **Generated sounds** (D19): the nine names are kept, the files are tones the repo generates, and
  afplay plays them after delivery only.
- **A settings view** (D21): Orca's page needs a conditional slider, a custom path, preview and a
  test button, which the generic dialog can't draw.

## Behavior and scenarios

The API and CLI scenarios run against a daemon on a temporary `QUIRKY_HOME` and `HOME`. "A window
is attended" means a test client connected as a window has reported focus and input within the last
3 minutes; "the view shows S" means the window opened `view:quirky.session/worktree` with worktree W
and session S and reported S as visible. Hooks are posted through the hook shim as in m1-agent-status.
"Delivered" means one `notify` event went out; the result of `send` and `test` names the gate. Times
are relative to the first event.

### Unread markers

1. **SC-1: an agent finishing in a background worktree marks its session and worktree** (API)
   - **Given** worktrees A and B; a window attended with the view on A's shell; a claude session S in B
   - **When** S's hooks post UserPromptSubmit then Stop with last message "All green"
   - **Then** `quirky session get S` shows unread `agent`; `quirky wt show B` shows unread yes;
     `quirky notifications status` shows badge 1, B among unread worktrees, S with reason agent; A
     and its shell are unmarked
   - **Data before:** **Session S**: claude, working, not unread; **Worktree B**: not unread; **Badge**: 0
   - **Walkthrough:**
     1. S's hook posts Stop; agent status emits settled done
     2. The plugin finds S not viewed and B not viewed
     3. It marks S `agent` and B unread, then the badge becomes 1
   - **Data after:** **Session S**: ✓ unread agent; **Worktree B**: ✓ unread; **Badge**: ✓ 1

2. **SC-2: finishing in the session on screen marks nothing** (API)
   - **Given** a window attended with the view on worktree B showing session S
   - **When** S's hooks post Stop
   - **Then** S and B stay unmarked, the badge stays 0, and no notify event goes out (Suppress
     While Focused, D15)

3. **SC-3: a background tab of the open worktree is marked, the worktree is not** (API)
   - **Given** a window attended with the view on B showing session S1; a second claude session S2 in B
   - **When** S2's hooks post Stop
   - **Then** S2 shows unread `agent`; B stays unmarked; the badge stays 0; no notify event (the
     worktree is open in the focused window)

4. **SC-4: an away person still gets the marker, and the next touch clears it** (API)
   - **Given** a window focused with the view on B showing S, whose last input was 181 s ago
   - **When** S's hooks post Stop, and then the window reports input
   - **Then** after Stop, S shows unread `agent` and B unread (the person was away); after the input,
     both are cleared and the badge returns to 0
   - **Data before:** **Window**: focused, last input 181 s ago*; **Session S**: working
   - **Walkthrough:**
     1. Stop arrives; S is on screen but the person is away, so S and B are marked; badge 1
     2. The window reports input; the plugin re-checks; S is viewed now
     3. S's marker and B's marker clear; badge 0
   - **Data after:** **Session S**: ✓ not unread; **Worktree B**: ✓ not unread; **Badge**: ✓ 0

5. **SC-5: focusing the window clears what it shows, and only that** (API)
   - **Given** sessions S1 and S2 in B, both unread `agent`, B unread; a window not focused with the
     view on B showing S1
   - **When** the window reports focus and input
   - **Then** S1's marker and B's marker clear; S2 stays unread `agent`; the badge drops by one

6. **SC-6: opening a worktree from the sidebar clears it and its shown session** (API)
   - **Given** B unread, S1 and S2 in B both unread; a window attended with the view on worktree A
   - **When** the window opens B's view showing S1
   - **Then** B and S1 are cleared; S2 keeps its marker

7. **SC-7: Mark Read clears the worktree and all its sessions; Mark Unread marks only the worktree** (CLI)
   - **Given** B unread with S1 and S2 unread
   - **When** `quirky wt set B --read`, then `quirky wt set B --unread`
   - **Then** after `--read`, B, S1 and S2 are all cleared and the badge drops by one; after
     `--unread`, B is unread, S1 and S2 stay cleared, and the badge rises by one

8. **SC-8: markers are written even when notifications are off** (API)
   - **Given** Enable Notifications off; S in a background worktree B
   - **When** S's hooks post Stop
   - **Then** S and B are marked and the badge is 1; no notify event goes out; an attention event
     for S does go out

9. **SC-9: presence never reported never clears a marker** (API)
   - **Given** S unread; a window focused with the view on S that has never reported input
   - **When** the window reports focus again
   - **Then** S stays unread

10. **SC-10: closing a session drops its marker from the count** (CLI)
    - **Given** S unread in B, B unread
    - **When** `quirky session close S`
    - **Then** `quirky notifications status` no longer lists S; B stays unread (the worktree mark is
      the person's to clear)

### Delivery gates

11. **SC-11: the gates run in order and the result names the first that fails** (CLI)
    - **Given** a background worktree B with session S; no window attended
    - **When** `quirky notifications send --session S --title T --body x` with, in turn: Enable
      Notifications off; Terminal Notifications off; Suppress While Focused on and a window focused
      on B; a second send within 5 s of a delivered one; nothing in the way
    - **Then** the results read `disabled`, `source-disabled`, `suppressed-focus`, `cooldown` and
      `delivered`; only the last sends a notify event
    - **Details: Gate table:**

      | Gate | Fails when | Result |
      |---|---|---|
      | Enable Notifications | off | disabled |
      | Source switch | Agent Task Complete off (agents, structured); Terminal Bell off (bells); Terminal Notifications off (programs, `send`) | source-disabled |
      | Suppress While Focused | on, and the source's worktree is open in a focused window | suppressed-focus |
      | Cooldown | a banner was delivered for the same worktree in the last 5 s | cooldown |
      | none | | delivered |

12. **SC-12: the cooldown is per worktree and shared by every source** (API)
    - **Given** Terminal Bell on; sessions S1 and S2 in worktree B; S3 in worktree C; no window
    - **When** S1 rings a bell; 1 s later S2's agent finishes; 2 s later S3's agent finishes; 6 s
      after the bell S2's agent finishes again
    - **Then** the bell is delivered, S2's first finish is `cooldown` (silent, no sound), S3's is
      delivered, and S2's second finish is delivered; all four leave their markers

13. **SC-13: the test notification skips the cooldown** (CLI)
    - **When** `quirky notifications test` twice within a second
    - **Then** both results are `delivered`, each with title "Quirky notifications are on" and body
      "This is a test notification from Quirky."

14. **SC-14: with Suppress While Focused off, the open worktree still gets a banner** (API)
    - **Given** Suppress While Focused off; a window attended on B showing S1; S2 in B
    - **When** S2's hooks post Stop
    - **Then** the banner is delivered

15. **SC-15: work done while Agent Task Complete was off is never reported later** (API, Orca defect)
    - **Given** Agent Task Complete off; S in a background worktree
    - **When** S's agent finishes, then Agent Task Complete is turned on, then 10 s pass
    - **Then** no notify event goes out for that finish; S is marked unread

16. **SC-16: boundaries and replays raise nothing** (API)
    - **When** a claude SessionStart (a boundary done) arrives, and a spooled Stop is replayed after
      a daemon restart
    - **Then** neither marks unread nor sends a notify event

17. **SC-17: a still-working agent is never announced as finished** (API, Orca defect)
    - **Given** a claude session whose lead posts Stop while a subagent it started is still working
    - **When** the lead's Stop arrives, then the subagent's SubagentStop arrives
    - **Then** nothing is marked or announced at the lead's Stop (the row is still working); at the
      SubagentStop the row is done and one banner "… - Claude finished" goes out

18. **SC-18: every source goes through the same gates** (API, Orca defect)
    - **Given** Suppress While Focused on and a window attended on worktree B
    - **When** an agent in B finishes, a structured session in B finishes, an ask from a session in B
      surfaces, and a program in B sends OSC 777
    - **Then** none is delivered; each result is `suppressed-focus`

### Banner text

19. **SC-19: an agent's banner names the place, the agent and the status** (API)
    - **Given** repo "quirky", worktree "fix-tests", a claude session
    - **When** its hooks post Stop with last message "All green.\n\nRan 412 tests."
    - **Then** the banner title is "quirky / fix-tests - Claude finished" and the body
      "All green. Ran 412 tests."
    - **Details: Status words:**

      | Row | Status word |
      |---|---|
      | waiting or blocked | needs input |
      | done, outcome failure | failed |
      | done, outcome cancellation, or interrupted | stopped |
      | done, success or no outcome | finished |

20. **SC-20: the body falls back from message to tool to a sentence** (API)
    - **When** a codex session waits on a permission with tool Bash and input `npm test` and no
      message; then a claude session finishes with no message and no tool
    - **Then** the first body is "Using Bash: npm test" and its title ends "Codex needs input"; the
      second body is "Claude finished."
    - **Details: Body order:** last assistant message (180 characters); `Using <tool>: <input>`;
      `Using <tool>`; `Tool input: <input>`; `<Agent> <status>.`

21. **SC-21: long text is cut with an ellipsis, never through a character** (API)
    - **When** a session in a worktree with a 100-character name finishes with a 300-character last
      message ending in emoji
    - **Then** the title's context is 80 characters ending in "…", the body is 180 characters ending
      in "…", and neither ends in half of a surrogate pair

22. **SC-22: a bell's banner** (API)
    - **Given** Terminal Bell on; repo "quirky", worktree "fix-tests"
    - **When** a background session there prints BEL
    - **Then** after 250 ms the banner reads "Bell in fix-tests" / "quirky · Attention requested"

23. **SC-23: a structured session's banner** (API)
    - **When** a structured codex session in "fix-tests" ends its turn with message "Done."
    - **Then** the banner reads "quirky / fix-tests - Codex finished" / "Done."

24. **SC-24: a folder workspace has no repo in its title** (API)
    - **When** an agent finishes in folder workspace "notes"
    - **Then** the title is "notes - Claude finished"

25. **SC-25: asks keep their text, skip the source switches and leave no marker** (API)
    - **Given** Agent Task Complete and Terminal Notifications off
    - **When** an ask titled "Deploy?" with question "Ship to prod?" surfaces from a background session
    - **Then** a banner "Deploy?" / "Ship to prod?" is delivered; no session or worktree is marked;
      no attention event goes out; with Enable Notifications off the result is `disabled`

### Bells

26. **SC-26: a bell marks unread whatever Terminal Bell says** (API)
    - **Given** Terminal Bell off; a background session S
    - **When** S prints BEL
    - **Then** S shows unread `bell` and its worktree unread; the banner result is `source-disabled`

27. **SC-27: a completion within 250 ms replaces the bell's banner** (API)
    - **Given** Terminal Bell on; a background claude session S
    - **When** S prints BEL and its hooks post Stop 100 ms later
    - **Then** one banner goes out, the "… - Claude finished" one; S shows unread `agent`

28. **SC-28: a bell on screen does nothing** (API)
    - **Given** a window attended on S
    - **When** S prints BEL
    - **Then** nothing is marked and no banner is delivered

### Program notifications (OSC)

29. **SC-29: OSC 777 notify** (API)
    - **Given** a background shell session S in worktree "fix-tests"
    - **When** S prints `ESC ] 777 ; notify ; Build ; done in 4s BEL`
    - **Then** a `quirky.terminal/notification` event carries title "Build" and body "done in 4s";
      S shows unread `notification`; the banner reads "fix-tests: Build" / "done in 4s"; the
      terminal's history still holds the sequence

30. **SC-30: OSC 9 text is a notification, ConEmu's subcommands are not** (API)
    - **When** S prints `ESC ] 9 ; Tests passed ST`, then `ESC ] 9 ; 4 ; 1 ; 50 ST`, then `ESC ] 9 ; 9 ; /tmp ST`
    - **Then** only the first is a notification, with no title and body "Tests passed"; its banner
      reads "Notification in fix-tests" / "Tests passed"

31. **SC-31: OSC 99 title and body, in chunks and in base64** (API)
    - **When** S prints `OSC 99 ; i=1:d=0 ; Build ST`, `OSC 99 ; i=1:p=body ; ok ST`; then
      `OSC 99 ; e=1:p=body ; aGVsbG8= ST`; then `OSC 99 ; p=icon ; x ST` and `OSC 99 ; i=2:p=? ; ST`
    - **Then** the first two make one notification titled "Build" with body "ok"; the third is one
      with body "hello"; the icon and query sequences make none and nothing is written back
    - **Data before:** **Chunk store**: empty
    - **Walkthrough:**
      1. `i=1:d=0` title "Build" is held; more is coming
      2. `i=1:p=body` (d defaults to done) adds body "ok" and completes it
      3. `e=1:p=body` decodes to "hello" and completes at once
      4. `p=icon` and `p=?` are ignored
    - **Data after:** **Notifications**: ✓ "Build" / "ok"; ✓ (no title) / "hello"; ✗ none for icon or query

32. **SC-32: OSC 99's occasion is honoured** (API)
    - **Given** a window attended on worktree B showing S
    - **When** S prints `OSC 99 ; o=unfocused ; Hi ST`, then the window loses focus and S prints it
      again; and S prints `OSC 99 ; o=invisible ; Hey ST` while viewed
    - **Then** the first and the `o=invisible` one are dropped before any marker; the second
      `o=unfocused` one marks S and is considered for a banner

33. **SC-33: notification text is cleaned** (API)
    - **When** S prints OSC 777 notify whose title holds an ESC byte, a C1 control and a tab, and
      whose body is 400 characters
    - **Then** the title has no control characters and its whitespace is single spaces; the body is
      cut to 256 characters ending in "…"

34. **SC-34: Quirky's own shell-ready marker is unchanged** (API)
    - **When** a shell starts in a session
    - **Then** `777;quirky-shell-ready` releases the ready barrier as before and raises no notification

35. **SC-35: Terminal Notifications off still marks** (API)
    - **Given** Terminal Notifications off
    - **When** a background session prints OSC 777 notify
    - **Then** the session is marked `notification`; the banner result is `source-disabled`

36. **SC-36: scripts can send a notification** (CLI)
    - **When** `quirky notifications send --worktree fix-tests --title Deploy --body "staging is up" --json`
    - **Then** it prints `{"delivered":true,"reason":"delivered"}`, the banner reads
      "fix-tests: Deploy" / "staging is up", and the worktree is marked unread (no session is named,
      so no session is marked)

### Sounds

37. **SC-37: a delivered banner carries the chosen sound** (API)
    - **Given** Notification Sound Bong at volume 60
    - **When** a background agent finishes
    - **Then** the notify event asks for the Bong file at volume 60 and a silent banner; with System
      Default it names no file and a banner with the system sound

38. **SC-38: no banner, no sound** (API)
    - **When** a finish is throttled by the cooldown or suppressed by focus
    - **Then** no notify event, so nothing plays; with no desktop client connected, `quirkyd` plays
      nothing either

39. **SC-39: with no desktop client the daemon shows and plays it** (API)
    - **Given** no desktop client connected; sound Ding at 100
    - **When** a background agent finishes
    - **Then** `quirkyd` runs the OS notifier with the banner text and plays the Ding file at full volume

40. **SC-40: a custom file must be a readable audio file** (CLI)
    - **When** `quirky notifications preview --path <file>` with, in turn, a relative path, a
      missing file, `/System/Library/Sounds/Glass.aiff`, an 11 MiB `.wav`, and a 1 KiB `.wav`
    - **Then** the first four play nothing and print "must be an absolute path", "does not exist",
      "must be .ogg, .mp3, .wav, .m4a, .aac or .flac" and "is over 10 MiB"; the last plays. The
      settings view runs the same check before it saves a custom path and shows the reason under the
      field. A stored custom path that later goes bad leaves banners delivered but silent, and
      `quirky notifications status` reports the sound problem with its reason.

41. **SC-41: preview plays a sound now** (CLI)
    - **When** `quirky notifications preview --sound sonar --volume 40`
    - **Then** the Sonar file plays at volume 40 (in the shell, or in `quirkyd` with no desktop
      client); no banner, no marker

### Badge and tray

42. **SC-42: the badge counts unread worktrees plus pending asks** (CLI)
    - **Given** worktrees B and C unread, two pending asks, three unread sessions in B
    - **When** `quirky notifications status --json`
    - **Then** badge 4 and label "4"; with 0 the label is empty, and with 120 it is "99+"
    - **Data before:** **Worktree B**: unread; **Worktree C**: unread; **Asks**: 2 pending; **Sessions**: 3 unread in B
    - **Walkthrough:**
      1. Unread worktrees: 2
      2. Pending asks: 2
      3. Unread sessions don't add to the count
    - **Data after:** **Badge**: ✓ 4, label "4"

43. **SC-43: the attention event goes out whatever the switches say, for attention sources only** (API)
    - **Given** Enable Notifications off
    - **When** a background agent finishes, a bell rings, a program notifies, an ask surfaces and the
      test runs
    - **Then** three `quirky.notifications/attention` events go out (agent, bell, program); none for
      the ask or the test

44. **SC-44: the shell lights the dot only while its window is hidden, and focus clears it** (shell unit)
    - **When** an attention event arrives while the window is visible and focused; then while it is
      minimized; then the window is focused
    - **Then** no dot; the dot; no dot

45. **SC-45: the shell's tray menu and the menu bar switch** (shell unit)
    - **Then** the menu reads Show Quirky, separator, Settings…, separator, Quit Quirky; Settings…
      shows the window and opens the Notifications view; Show Menu Bar Icon off hides the tray item
      and on shows it; quitting sets the dock badge to empty

### The window

These run in the web UI against a daemon on a temporary home.

46. **SC-46: the markers on the tab and the card** (UI)
    - **Given** worktrees A and B, the person on A, a claude session S in B
    - **When** S's hooks post Stop
    - **Then** B's card shows an amber bell where its status dot was, labelled "Unread", and its name
      is bold; opening B shows S's tab with an amber bell labelled "Unread agent completion" until
      the tab is shown, after which the card and tab return to their status glyphs
    - **Screen states:**

      | Moment | B's card | S's tab |
      |---|---|---|
      | after Stop, on A | amber bell "Unread", bold name | not visible |
      | after opening B on S | status dot, normal name | status dot |

47. **SC-47: Settings > Notifications at its defaults** (UI)
    - **When** the person runs "Open notification settings"
    - **Then** the view titled "Notifications" with subtitle "Native desktop notifications for agent
      activity and terminal events." shows, in order: Enable Notifications (on), Agent Task Complete
      (on), Terminal Bell (off), Terminal Notifications (on), Notification Sound (System Default, no
      volume slider), Suppress While Focused (on), Show Menu Bar Icon (on), and a Send Test
      Notification button; each with its description from D8

48. **SC-48: the sound controls** (UI)
    - **When** the person picks Bong, then Choose Custom File and enters a `.wav` path, then picks Bong again
    - **Then** picking Bong shows a volume slider at 100% and previews it; the custom path shows
      "Custom: <path>" under the select; picking Bong again hides the Custom line (Orca defect)

49. **SC-49: turning notifications off dims what depends on it** (UI)
    - **When** the person turns off Enable Notifications
    - **Then** Agent Task Complete, Terminal Bell, Terminal Notifications, the sound select and
      slider, Suppress While Focused and Send Test Notification are dimmed and disabled; Show Menu
      Bar Icon is not

50. **SC-50: Send Test Notification always answers** (UI, Orca defect)
    - **When** the person clicks Send Test Notification; and, separately, `quirky notifications test`
      runs with Enable Notifications off
    - **Then** the click toasts "Test notification requested" with "If no macOS banner appeared, turn
      on Allow notifications for Quirky in System Settings."; the CLI prints `disabled`. Every result
      the button can get produces exactly one toast, from the table below.
    - **Details: Test toasts:**

      | Result | Toast |
      |---|---|
      | delivered | "Test notification requested" / "If no macOS banner appeared, turn on Allow notifications for Quirky in System Settings." |
      | disabled | "Notifications are disabled" |
      | anything else | "Test notification was not delivered" |

### Migration and scripting

51. **SC-51: an old "off" carries over** (API)
    - **Given** a home whose `quirky.agent-status/notifications` setting is false (or v1's
      `notifications: false`)
    - **When** the daemon starts with this item's plugins
    - **Then** Agent Task Complete is off, Enable Notifications is on, and agent-status declares no
      `notifications` setting

52. **SC-52: the status command** (CLI)
    - **When** `quirky notifications status --json`
    - **Then** it prints the badge, the unread worktrees (ID and name), the unread sessions (ID,
      worktree and reason) and the pending ask count; `quirky api --json` lists `status`, `send`,
      `test` and `preview` with their schemas

### Native-only

These need the real window and go to `docs/loop/native/m1-notifications.json`: a delivered banner
appears with the right title and body (SC-19); the chosen sound plays and System Default uses the
system sound (SC-37); the amber dot shows on the menu bar icon while the window is minimized and
goes when it is restored (SC-44); the tray menu items and Settings… (SC-45); Show Menu Bar Icon
removes and restores the icon; the dock badge shows the count and empties on quit (SC-42, SC-45).

## Scope and non-goals

In scope: the `quirky.notifications` plugin with its settings, settings view, methods, CLI group and
events; unread markers on sessions and worktrees with auto-read and presence; the gates, cooldown
and banner text; sounds with generated files, custom files, volume and preview; the tray dot, tray
menu and Show Menu Bar Icon; the dock badge; OSC 9, 99 and 777 in the PTY host; agent-status,
structured, terminal and ask reporting through events; the settings migration.

Non-goals (D4):

- **Phone push and paired devices**, and the **Machines** mutes.
- **Notify About Hidden Workspaces**: Quirky has no sidebar Filters menu yet.
- **The macOS permission card**, delivery probe, startup registration and Open System Settings (D23).
- **Onboarding's notification step**.
- **Minimize to Tray on Close** and every Windows and Linux behaviour (D38).
- **The 3-minute pending-ask escalation** (m2-ask-parity D2).
- **The floating terminal's badge count and dot**: m1-term-ui builds the floating workspace.
- **Pane markers** and `experimentalTerminalAttention`.
- **Removing banners when read** (D27) and **clicking a banner to focus the pane** (D26).
- **Answering kitty's OSC 99 query** and its close, alive, icon and button payloads (D28).
- **Check for Updates…** in the tray menu.

## Decisions Locked

**Scope and architecture**
- Roadmap bullets, the OSC sequences, flows 1 to 5 and the dock badge; phone, machines, hidden mutes, permission card and Windows out (D4).
- `quirky.notifications` listens to producers' events and is the only notifier (D5, D40); producers emit settled and notification events (D6).
- The old switch becomes Agent Task Complete and carries its value (D7).

**Unread**
- Markers on the session (reason) and worktree, written first and whatever the switches say (D9, D35).
- Viewed means focused, present within 180 s and shown; unknown presence never clears (D10).
- The kernel carries input activity and broadcasts window changes (D11); the view reports visible sessions (D12).
- Amber bell on tab and card, bold name (D36).

**Delivery**
- Orca's gate order and result reasons (D13); 5 s cooldown per worktree, shared, test exempt (D14).
- Suppress While Focused is worktree plus window focus (D15).
- Only delivered banners send `notify`, so toasts follow (D18).

**Text and sources**
- Orca's banner builder (D16) and status words (D17).
- Bells mark at once and their banner yields to a completion within 250 ms (D30).
- Every live settle notifies; a working agent never does (D31); structured sessions share the policy (D32).
- Asks keep their text and pass only the master switch, focus and cooldown (D33).
- OSC 9, 99 and 777 parsed in the PTY host (D28); program banners are titled with the worktree (D29).

**Sounds, tray and dock**
- Generated tones, afplay after delivery, daemon plays with no shell (D19); typed custom path (D20).
- Amber tray dot while hidden, menu gains Settings…, Show Menu Bar Icon (D24).
- Badge = unread worktrees + pending asks, computed by the daemon (D25).

**Surface**
- A Notifications settings view (D21); the test always toasts (D22).
- `quirky notifications status|send|test|preview` (D34).

## Industry Insights

- OSC 9 collides with ConEmu's `9;4` progress and `9;9` cwd; Ghostty and Corta treat a payload that
  parses as a ConEmu subcommand as that subcommand and anything else as text; foot drops OSC 9 for
  this reason. (https://ghostty.org/docs/vt/osc/conemu, https://github.com/noah-qin/Corta/issues/409)
- kitty's OSC 99: `ESC ] 99 ; metadata ; payload ST`, colon-separated keys, `p=title|body|…`
  (default title), `e=1` base64, `d=0` more chunks follow under the same `i`, `o=always|unfocused|invisible`,
  2048 bytes per payload before encoding; unknown keys are ignored. cmux's own OSC 99 example uses
  `;` between keys and is not kitty-compatible. (https://sw.kovidgoyal.net/kitty/desktop-notifications/,
  https://cmux.com/docs/notifications)
- OSC 777 `notify;title;body` has no escaping, so text must be cleaned; stripping CSI and OSC alone
  leaves stray ESC bytes. (https://github.com/kristoferlund/ratcn/issues/40, https://github.com/ikaruscareer/SafeAI/pull/203)
- Record state before any throttle: Ghostty's per-app rate limit drops notifications before cmux
  records them; markers and hooks should never be rate-limited, only banners and sounds.
  (https://github.com/manaflow-ai/cmux/issues/17333)
- Cooldown keys that leave out the status can hide an earlier "blocked" behind a later "done"
  (herdr-terminal-notifier); Orca's per-workspace key accepts that for banners because the marker
  stays. (https://github.com/dot/herdr-terminal-notifier)
- Program notices should show under the terminal's own identity, never as a system-looking alert.
  (https://github.com/noah-qin/Corta/issues/409)
- `osascript display notification` is attributed to Script Editor, its click opens Script Editor,
  and it exits 0 even when nothing shows. (https://github.com/anthropics/claude-code/issues/41511,
  https://github.com/scotthawes/opencode-model-monitor/issues/31)
- afplay blocks until done, so spawn it without waiting; its sound plays through Focus and Do Not
  Disturb. (https://github.com/NousResearch/hermes-agent/issues/52652, https://github.com/justrach/harness/issues/518)
- A coloured dot inside a macOS template image turns monochrome; it needs a non-template image.
  (https://github.com/Zeitgleich/TeamCraft/issues/632, https://www.electronjs.org/docs/latest/api/tray)
- Electrobun has no dock badge API (open request); macOS shows a badge only with notification
  permission and "Badge app icon" on. (https://github.com/blackboardsh/electrobun/issues/392,
  https://developer.chrome.com/blog/notification-attribution-macos)
- Daemon-owned policy with thin clients works when one authority decides and clients only render;
  local-operator's daemon never infers a read from focus alone. Clients that notify on their own
  bypass the policy (Matrix MSC3890). (https://github.com/damianvtran/local-operator/pull/2939,
  https://github.com/matrix-org/matrix-spec-proposals/pull/3890)
- Core-enforced throttles (GNOME, Android) drop silently and leave stale state; coalesce or record
  before throttling. (https://gitlab.gnome.org/GNOME/gnome-shell/-/raw/main/js/ui/messageTray.js,
  https://github.com/marmot-protocol/whitenoise-android/issues/2628)

## Deferred Ideas

- A burst digest ("3 agents finished in fix-tests") instead of dropping throttled banners (cmux RFC #20891).
- A native file picker for the custom sound, reachable from the window (D20).
- Answering OSC 99's capability query (D28).
- `[tech-spec]` the method and event names for window input activity and window changes (D11).
- `[tech-spec]` how each generated tone is shaped and how the WAV files are built and checked.
- `[tech-spec]` the tray images (template and attention, light and dark) and how the menu bar appearance is read.
- `[tech-spec]` how the plugin tells its own worktree writes from a person's Mark Read (SC-7).

## Glossary

- **Marker:** the unread state on a session (with a reason: agent, bell or notification) or on a worktree.
- **Viewed:** a window is focused, its person used it within 180 s, and its worktree view shows the session (or, for a worktree, its view is open).
- **Attended window:** a focused window with input in the last 180 s.
- **Source:** what raised an event: agent (hooks, titles, OSC 7501, structured sessions), bell, program (OSC 9/99/777 and `send`), ask, test.
- **Gate:** one check a banner must pass: master switch, source switch, focus, cooldown.
- **Attention event:** `quirky.notifications/attention`, which the shell turns into the tray dot.
- **Settled:** an agent row or structured session reaching done, waiting or blocked from a live event.
- **Badge:** the dock count, unread worktrees plus pending asks.
