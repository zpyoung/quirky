# Terminal panes: tabs, splits, tab groups, search, links, quick commands, floating workspace and keybindings

## Status & amendments

**Status:** Approved (headless build loop; decisions in [m1-term-ui.md](../../../loop/decisions/m1-term-ui.md)). Tech spec: requested.

**Amendments:**
- 2026-10-26, spec review (Codex adversarial review, D43): the view's `session` input focuses that session's pane (new SC-76); a split tab's live title is its active pane's (SC-10); Terminal first never lets a bound chord reach the webview's own default (SC-61); Restart is only for an ended pane (SC-33); "Close Split Pane" moves tabs into the nearest group of the sibling side (SC-48); an overlay's `shown` comes from its report (SC-67); SC-70 now tests the override chain instead of a per-contribution disable the registry doesn't offer; every (UI) scenario also has its CLI/API path (Behavior intro); agent scenarios use fake agent CLIs (SC-53).

## Conceptual model

Today a worktree's main view is a strip of session tabs over one terminal pane, and the pane lives
in `quirky.session` ([m0-core D21](../../../loop/decisions/m0-core.md)). This item gives Quirky
Orca's terminal workspace ([term-ui.md](../../../../research/orca-features/term-ui.md)): tabs that
hold a tree of split panes, tab groups that split the tab area, search, links, paste, zoom, quick
commands and a floating workspace, with Orca's keys.

The feature ships in the built-in `quirky.terminal` plugin, which already owns terminal I/O
([D6](../../../loop/decisions/m1-term-ui.md)). It overrides the existing view
`view:quirky.session/worktree`, so every caller that opens a worktree lands in the new workspace,
and `quirky.session`'s simple view stays as the fallback when the override is disabled.

The **layout lives in the daemon** ([D7](../../../loop/decisions/m1-term-ui.md)). For each worktree,
and for the floating workspace, `quirky.terminal` keeps a **workspace**: a tree of **tab groups**,
each with ordered **tabs**, an active tab and a recently-used list, and each tab holding a tree of
**panes**. A pane shows one session. Every change, from a click, a key or the `quirky` CLI, is a
method call that returns the workspace's new **revision** and announces it; the window draws
whatever the daemon holds. What only the window knows (pane sizes in cells, zoom, search counts)
goes into the view's `ui state` report, so an agent reads everything a person sees as JSON.

```
worktree workspace (revision 7)
└─ split right 0.5
   ├─ group grp-1   tabs: [tab-1 "Terminal 1" ●blue] [tab-2 "Build"]   active tab-2
   │    tab-2 panes: split right 0.5
   │                 ├─ pane-2  session s-2
   │                 └─ split down 0.5
   │                     ├─ pane-3  session s-3   (active)
   │                     └─ pane-4  session s-4
   └─ group grp-2   tabs: [tab-3 "Hello"]
```

## Data flow

1. A person presses `⌘D` in pane-3. The window's key handler runs the command
   `quirky.terminal/split-right`, which calls `quirky.terminal/splitPane {pane: pane-3, direction:
   right}`.
2. The daemon reads pane-3's last known directory from the PTY host, starts a shell session there
   through `quirky.session`, adds pane-5 beside pane-3 at half its size, makes it active, saves the
   workspace in the plugin store and emits `quirky.terminal/layout` with the new revision.
3. Every window showing that worktree redraws from the workspace. The new pane attaches to its
   session with `quirky.terminal/attach`, exactly as panes do today, and writes the replay.
4. An agent running `quirky terminal pane split --direction right` takes the same path from step 2.
5. Sessions started anywhere else (`quirky session new`, an agent-tab command) are noticed by the
   plugin and get a new tab. A session that ends or is closed is removed from its pane by the same
   reconciliation, in the daemon, whether or not a window is open.
6. The view reports `{worktree, tabs, active, layout, focusedPane, panes: [...]}` after each change;
   `quirky ui state --json` returns it.

Drags are the exception to "every change is a call": while a person drags a divider or the
floating panel, the window moves things locally and refits the panes, and sends one call with the
final size when the drag ends ([D37](../../../loop/decisions/m1-term-ui.md)).

## Key decisions

One line each; the decision log holds the reasoning.

- `quirky.terminal` owns the feature and overrides the session view and its tab commands (D6, D39).
- Layout lives in the daemon, per worktree plus one floating workspace, with a revision (D7, D34).
- Binary split trees with ratios, Orca's sizing rules (D8, D16, D17).
- Every session gets a pane; closing a pane ends its session; running commands confirm (D10, D12).
- Exit 0 closes the pane, a non-zero exit keeps it with an overlay (D14).
- Orca's macOS keys, scoped to terminal focus, with a shortcut policy setting (D26).
- The plugin API grows an overlay slot, keybinding `when`, view embedding, conditional
  confirmation, and session start directories (D38).

## Behavior & scenarios

Every scenario runs against a fresh temporary `QUIRKY_HOME` with a real `quirkyd`, the real
`quirky-pty` and the built-in plugins. A scenario marked (CLI) or (API) is driven through the
`quirky` CLI or the daemon API; one marked (UI) is driven in the window (the headless test window,
and the web window for the like-a-user pass) and checked through `quirky ui state`. Shells are
`/bin/zsh` without the user's startup files. Fixtures are illustrative.

Every (UI) scenario's test also reaches the same outcome through the CLI or the daemon API: a
daemon method for layout changes, or a window command run with `quirky ui run` for view-only
actions (copy, paste, select all, search, zoom, opening a menu), with the result read back from
`quirky ui state`. Pointer-only gestures (drags, hover, clicks) are performed in the headless
window and checked the same way. Scenarios that start an agent use the fake agent CLIs of
`quirky.agents`' test harness on an isolated `PATH`, never a real agent.

Scenarios use repo **api** with worktree **main** at `/tmp/w/api`. "The view" is the worktree view
for **main**. Keys are macOS keys (`⌘` is Mod).

### The workspace and its layout

1. **SC-1: opening a worktree with no tabs creates one terminal** (CLI)
   - **Given** worktree **main** has no sessions
   - **When** the agent runs `quirky ui open-view view:quirky.session/worktree --input '{"worktree":"main"}'` and then `quirky terminal layout --worktree main --json`
   - **Then** the workspace has one group with one tab "Terminal 1" holding one pane on a new shell session in `/tmp/w/api`, and that pane is active
   - **Data before:** **Workspace main**: none
   - **Walkthrough:**
     1. The view opens and asks for the workspace
     2. The daemon finds no tabs and creates "Terminal 1" with pane-1 on shell session s-1*
   - **Data after:** **Workspace main**: ✓ revision 1*; group grp-1 → tab-1 "Terminal 1" → pane-1 (s-1*), active

2. **SC-2: `quirky terminal layout` prints the tree** (CLI)
   - **Given** the workspace drawn in the conceptual model
   - **When** the agent runs `quirky terminal layout --worktree main`
   - **Then** it prints one line per group, tab and pane, indented by depth, marking the active tab and pane, each tab's colour and title, and each pane's session; with `--json` it prints the workspace object with its revision
   - **Data before:** **Workspace main**: as in the conceptual model
   - **Walkthrough:**
     1. The agent runs the command
   - **Data after:** **Output** (illustrative):  
     `split right 0.5`  
     `  group grp-1 (active)`  
     `    tab tab-1 "Terminal 1" blue`  
     `    tab tab-2 "Build" (active)`  
     `      split right 0.5`  
     `        pane pane-2 s-2`  
     `        split down 0.5`  
     `          pane pane-3 s-3 (active)`  
     `          pane pane-4 s-4`  
     `  group grp-2`  
     `    tab tab-3 "Hello"`

3. **SC-3: the view reports what the window shows** (UI)
   - **Given** the view is open on the workspace above with pane-3 focused
   - **When** the agent runs `quirky ui state --json`
   - **Then** the view's report has v1's `worktree`, `tabs` and `active` fields (each tab now also naming its `tab`, `group` and `pane`), the `layout` with its revision, `focusedPane: pane-3`, and one entry per mounted pane with its cols, rows and font size

4. **SC-4: sessions started elsewhere open in a new tab** (CLI)
   - **Given** the view is open on **main** with one tab
   - **When** the agent runs `quirky session new --worktree main --agent shell`
   - **Then** a second tab "Terminal 2" appears in the active group holding the new session, the new tab is active, and the old tab is unchanged

5. **SC-5: a session closed elsewhere leaves its pane** (CLI)
   - **Given** tab "Build" holds pane-2, pane-3 and pane-4
   - **When** the agent runs `quirky session close <s-4's id>`
   - **Then** pane-4 is gone, pane-3 takes its space, and if pane-4 was active the first remaining pane becomes active; closing the session of a tab's only pane closes the tab

6. **SC-6: a stale revision is refused** (API)
   - **Given** the workspace is at revision 7
   - **When** a client calls `quirky.terminal/resizeSplit` with `revision: 6`
   - **Then** the call fails with a conflict naming the current revision 7, and nothing changes

7. **SC-7: bad targets fail with clear errors** (CLI)
   - **Given** the workspace above
   - **When** the agent runs `quirky terminal pane focus pane-99`, `quirky terminal pane move pane-1 --to-tab tab-2` on a tab's only pane, and `quirky terminal group resize grp-1 --ratio 0.9`
   - **Then** the first fails with not-found naming `pane-99`, the second with invalid-params "the last pane of a tab can't be moved out", the third with invalid-params "a group divider stays between 0.15 and 0.85"; each exits non-zero and the layout is unchanged

### Tabs

8. **SC-8: `⌘T` opens "Terminal N" with the lowest free number** (UI, CLI)
   - **Given** tabs "Terminal 1" and "Terminal 3" (Terminal 2 was closed)
   - **When** the person presses `⌘T`, or the agent runs `quirky terminal tab new`
   - **Then** a new tab "Terminal 2" opens at the end of the active group with a shell in the worktree root, and becomes active

9. **SC-9: renaming a tab** (UI, CLI)
   - **Given** tab "Terminal 2" is active
   - **When** (a) the person double-clicks its name (or presses `⌘R`, or picks Change Title), types "Build" and presses Enter; (b) presses Escape instead; (c) the agent runs `quirky terminal tab rename tab-2 Build`
   - **Then** (a) and (c) the tab reads "Build" and keeps that name when the shell sets a window title; (b) it reads "Terminal 2" again; an Enter that confirms an IME candidate doesn't commit

10. **SC-10: a tab's live title shows until it gets a custom one** (CLI)
    - **Given** tab "Terminal 1" with no custom title
    - **When** its shell prints `printf '\033]0;deploy\007'`
    - **Then** the tab reads "deploy"; after `quirky terminal tab rename tab-1 ""` clears a custom title the live title shows again; in a split tab the title follows the active pane's latest title

11. **SC-11: clicking a tab activates it and it is remembered** (UI)
    - **Given** tabs "Terminal 1" and "Build", "Build" active
    - **When** the person clicks "Terminal 1", switches to another worktree, and comes back
    - **Then** "Terminal 1" is active again, its panes attach and show their screens, and "Build"'s panes are not mounted while hidden
    - When the group's tabs do not fit, visible left/right scroll controls reveal hidden tabs without changing the active tab. Each control is disabled at its boundary; both disappear when the tabs fit again.

12. **SC-12: closing an idle tab ends its sessions without asking** (UI, CLI)
    - **Given** tab "Build" with two idle shells at their prompt
    - **When** the person middle-clicks the tab, presses `⌘W` with a single-pane tab active, or the agent runs `quirky terminal tab close tab-2`
    - **Then** the tab and its sessions are gone with no question, and the previously used tab of the group (by recent use, not position) becomes active

13. **SC-13: closing a tab running a command asks first** (UI)
    - **Given** tab "Terminal 1" whose shell is running `sleep 300`
    - **When** the person closes it
    - **Then** a dialog "Stop running command?" says "Closing this terminal will stop the command running inside it." with the tab name, Cancel and "Stop and Close", and a checkbox "Don't ask again for running terminals"; Cancel keeps it; "Stop and Close" ends `sleep` and closes the tab; with the box ticked the setting "Confirm before closing running terminals" turns off and the next close doesn't ask; an agent session says "Stop this agent?" with "Stop Agent"
    - **Screen states:**

      | Moment | What the person sees |
      |---|---|
      | After close | Dialog "Stop running command?", body "Closing this terminal will stop the command running inside it.", "Terminal 1", [ ] Don't ask again for running terminals, Cancel, Stop and Close |
      | After Stop and Close | Tab gone; the group's previous tab active |

14. **SC-14: the CLI asks before closing a running command unless `--yes`** (CLI)
    - **Given** tab "Terminal 1" running `sleep 300`
    - **When** the agent runs `quirky terminal tab close tab-1`, then `quirky terminal tab close tab-1 --yes`
    - **Then** the first opens a confirmation ask naming the tab and its running command and waits; answering no leaves the tab; the second closes it at once; `quirky terminal pane close` behaves the same

15. **SC-15: a double click can't confirm the next tab** (UI)
    - **Given** two tabs running commands, and the confirm dialog for the first
    - **When** the person clicks "Stop and Close" twice within 350 ms
    - **Then** the first tab closes and the second click doesn't close or confirm the second tab

16. **SC-16: closing a pinned tab asks unless turned off** (UI)
    - **Given** pinned tab "Logs"
    - **When** the person presses `⌘W` on it
    - **Then** a dialog "Close pinned tab?" with "Don't ask again for pinned tabs" appears; confirming closes it; with the box ticked the setting "Confirm before closing pinned tabs" turns off

17. **SC-17: reopening a closed tab starts it fresh** (UI, CLI)
    - **Given** tab "Build", coloured blue, in `/tmp/w/api/web`, that ran `echo reopen-me` and was closed with `⌘W`
    - **When** the person presses `⌘⇧T`, or the agent runs `quirky terminal tab reopen`
    - **Then** a tab "Build", blue, opens with a new shell in `/tmp/w/api/web` and an empty screen (no `reopen-me`); a tab that went away because its shell exited is never offered; up to ten closed tabs per workspace are remembered across a daemon restart
    - **Data before:** **Closed tabs of main**: "Build" blue, `/tmp/w/api/web`
    - **Walkthrough:**
      1. The person presses `⌘⇧T`
      2. The daemon takes the newest closed tab and starts a shell in its directory
    - **Data after:** **Tab "Build"**: ✓ blue; ✓ new session; ✓ empty screen. **Closed tabs of main**: none

18. **SC-18: reorder and move tabs by dragging** (UI, CLI)
    - **Given** group grp-1 with tabs A, B, C and group grp-2 with tab D
    - **When** the person drags C before A, drags B onto grp-2's strip, or the agent runs `quirky terminal tab move tab-B --group grp-2 --index 0`
    - **Then** grp-1 reads C, A and grp-2 reads B, D, and the moved tab becomes active in its new group

19. **SC-19: tab colours and pins** (UI, CLI)
    - **Given** tab "Build"
    - **When** the person picks Tab Color → Blue in its menu, then Pin Tab; or the agent runs `quirky terminal tab color tab-2 blue` and `quirky terminal tab pin tab-2`
    - **Then** a blue dot sits before the tab's close control, the pinned tab moves left of unpinned tabs and shows a pin instead of its close button; None removes the colour; `tab color` accepts only the ten names (none, blue, purple, pink, red, orange, yellow, green, teal, gray)

20. **SC-20: the tab menu** (UI)
    - **Given** a group with tabs A, B, C (B pinned), C active, right-clicked
    - **When** the person opens C's tab menu
    - **Then** it lists, in order: Move Tab to Split ▸ (Right, Left, Down, Up), Split Terminal ▸ (Right, Down), Pin Tab, Copy Tab ID, Close ⌘W, Close Others, Close All Tabs To The Right (disabled, C is last), Close All Tabs To The Left, Change Title ⌘R, Tab Color with ten swatches, and Close Split Pane only when the group area is split; Close Others and Close To The Left close A but not pinned B; Copy Tab ID copies `tab-3`

21. **SC-21: switching tabs from the keyboard** (UI, CLI)
    - **Given** tabs 1–4 in one group, used in the order 3, 1, 4
    - **When** the person presses Ctrl+Tab, Ctrl+PageDown, Ctrl+PageUp, `⌘⌥]`, `⌘⇧[`, Ctrl+2 or `⌘2`
    - **Then** Ctrl+Tab opens the "Switch tabs" list in recently-used order (4, 1, 3, 2) with 1 highlighted, each further Tab moves down, and releasing Ctrl activates the highlighted one; with the setting Ctrl+Tab order = sequential it lists by position; PageDown/PageUp and the bracket keys move to the next or previous tab, wrapping; Ctrl+2 and `⌘2` select the second tab; `quirky terminal tab activate --index 2` does the same

22. **SC-22: the `+` menu** (UI)
    - **Given** the view with tabs "Terminal 1" and "Build" and agents Claude and Codex installed
    - **When** the person clicks `+` and types "bu"
    - **Then** the menu shows the search box "Search open tabs and agents…", New Terminal ⌘T, the agent rows Quirky lists today and Agent settings…; typing "bu" leaves the open tab "Build" and no rows; Enter on it activates "Build"

### Panes and splits

23. **SC-23: splitting right and down** (UI, CLI)
    - **Given** tab "Build" with pane-2 active in `/tmp/w/api/web` (the shell ran `cd web`)
    - **When** the person presses `⌘D`, then `⌘⇧D` in the new pane; or the agent runs `quirky terminal pane split pane-2 --direction right`
    - **Then** pane-2 keeps the left half, a new pane on the right becomes active and its shell starts in `/tmp/w/api/web`; the second split gives a right column split top and bottom; each new pane gets half of the pane it split
    - **Data before:** **Tab "Build"**: pane-2 (cwd `/tmp/w/api/web`)
    - **Walkthrough:**
      1. `⌘D`: split right 0.5 → pane-2 | pane-3 (cwd `/tmp/w/api/web`)
      2. `⌘⇧D` in pane-3: pane-3 becomes split down 0.5 → pane-3 / pane-4
    - **Data after:** **Tab "Build"**: ✓ split right 0.5 (pane-2, split down 0.5 (pane-3, pane-4)); ✓ pane-4 active

24. **SC-24: resizing with a divider** (UI, CLI)
    - **Given** pane-2 | pane-3 at 0.5 in a 1000 px wide tab
    - **When** the person drags the divider 200 px left and lets go; then double-clicks it; or the agent runs `quirky terminal pane resize pane-2 --ratio 0.3`
    - **Then** the split is 0.3 after the drag, the panes refit while dragging but each shell gets one resize when the drag ends, a pane never gets narrower than 50 px (or half the pair when the pair is smaller), and the double-click returns the pair to 0.5

25. **SC-25: equalize** (UI, CLI)
    - **Given** three panes side by side made by splitting right twice (0.5, then 0.5 of the right half)
    - **When** the person picks Equalize Pane Sizes, or the agent runs `quirky terminal pane equalize --tab tab-2`
    - **Then** the three panes become a third of the width each
    - **Data before:** **Tab**: split right 0.5 (pane-2, split right 0.5 (pane-3, pane-4))
    - **Walkthrough:**
      1. Equalize weighs each side by its panes on the same axis: 1 and 2
    - **Data after:** **Tab**: ✓ split right 0.333 (pane-2, split right 0.5 (pane-3, pane-4))

26. **SC-26: moving a pane by its header** (UI, CLI)
    - **Given** tab "Build" with pane-2 | pane-3 and tab "Terminal 1" with pane-1
    - **When** the person drags pane-3's header handle more than 5 px over the top edge of pane-2, sees a half-pane preview there and drops; or drops it on tab "Terminal 1"; or the agent runs `quirky terminal pane move pane-3 --to-pane pane-2 --edge top`
    - **Then** pane-3 sits above pane-2 (split down), or moves into "Terminal 1" beside pane-1; its session keeps running with its screen intact; a tab with one pane offers no drag

27. **SC-27: expanding a pane** (UI, CLI)
    - **Given** three panes, pane-3 active
    - **When** the person presses `⌘⇧Enter`, then `⌘]`; or the agent runs `quirky terminal pane expand pane-3`
    - **Then** pane-3 fills the tab, the tab shows a collapse icon beside its colour dot, the other sessions keep running unmounted; `⌘]` collapses first and then focuses the next pane; pressing `⌘⇧Enter` again collapses; with one pane nothing happens; the expanded pane survives a restart

28. **SC-28: focusing the next and previous pane** (UI, CLI)
    - **Given** panes 2, 3, 4 in tree order, pane-4 active
    - **When** the person presses `⌘]`, then `⌘[` twice; or the agent runs `quirky terminal pane focus --next`
    - **Then** focus wraps to pane-2, then goes to pane-4 and pane-3; the active pane has full opacity and the others the "Inactive Pane Opacity" setting; the focused pane's xterm has keyboard focus

29. **SC-29: closing a pane** (UI, CLI)
    - **Given** pane-2 | (pane-3 / pane-4), pane-3 active
    - **When** the person presses `⌘W`, or the agent runs `quirky terminal pane close pane-3`
    - **Then** pane-3 and its session go, pane-4 takes the right column, and the first remaining pane becomes active; `⌘W` on a tab's only pane closes the tab (SC-12)

30. **SC-30: a pane title** (UI, CLI)
    - **Given** pane-3 in a split tab or an untitled lone-pane tab
    - **When** the person picks Set Title…, types "logs" in the "Pane title" field and presses Enter; or the agent runs `quirky terminal pane title pane-3 logs`
    - **Then** the pane header shows "logs" and the title survives a restart; Escape cancels; Clear Pane Title or `pane title pane-3 ""` removes it; a titled split pane's header shows "Remove title" where an untitled split pane shows close

31. **SC-31: pane headers and closing controls** (UI)
    - **Given** split and lone-pane tabs
    - **When** the person looks at their active panes
    - **Then** only the active split pane shows its header with its title if set, expand/collapse and close ("Close Pane" when untitled, "Remove title" when titled), and a drag handle when the tab has 2+ panes; an untitled lone pane has no empty header, a titled lone pane shows only its title/edit field, and lone tabs are closed from the tab strip

32. **SC-32: exit 0 closes the pane, except an untouched lone pane** (CLI)
    - **Given** (a) pane-3 in a split tab where the person typed `exit`; (b) a lone pane nobody typed into whose shell exits 0 at startup
    - **When** the shell exits with code 0
    - **Then** (a) pane-3 closes, and a tab's last pane closing closes the tab; (b) the pane stays showing its output with "Terminal exited" and Close and Restart

33. **SC-33: a non-zero exit keeps the pane with an overlay** (UI, CLI)
    - **Given** pane-3 whose shell runs `exit 3`
    - **When** the shell ends
    - **Then** pane-3 stays with its output and an overlay "Terminal exited" — "The shell process ended with exit code 3. Its output is preserved." — with Close and Restart; `quirky terminal layout --json` shows the pane with exit code 3; Restart (`quirky terminal pane restart pane-3`) starts a fresh shell in the same pane and directory; Close closes the pane; restarting a pane whose process is still running fails with conflict "pane pane-3 is still running"

34. **SC-34: clear and reset** (UI, CLI)
    - **Given** pane-3 has 500 lines of output and a program left mouse reporting on
    - **When** the person presses `⌘K` (Clear Screen), or the agent runs `quirky terminal pane clear pane-3`; then picks Reset Terminal (`quirky terminal pane reset pane-3`)
    - **Then** the pane and the host's screen and history for that session are empty except the prompt, and reopening the pane doesn't bring the lines back; Reset turns off mouse reporting, bracketed paste and similar modes in the pane and the host without touching the text

35. **SC-35: zoom per pane** (UI)
    - **Given** two panes and the Font Size setting at 14
    - **When** the person presses `⌘=` three times in pane-3, then `⌘0`, then `⌘-` twenty times
    - **Then** pane-3's font is 17 px while pane-2 stays 14, `⌘0` returns to 14, and it never goes below 8 or above 32; zoom isn't saved; the report shows each pane's font size

36. **SC-36: selecting and copying** (UI)
    - **Given** pane-3 shows `  alpha` and `  beta` indented two spaces
    - **When** the person drags across both lines and presses `⌘C`; double-clicks `alpha`; turns Copy on Select on and selects again
    - **Then** the clipboard holds `alpha⏎beta` (the shared leading gutter trimmed while "Trim Gutter on Copy" is on); double-click selects one word by the Word Separators setting; Option-drag selects even when the program has mouse reporting on; `⌘A` selects all; with Copy on Select the selection is copied without `⌘C`; `⌘C` with nothing selected in a terminal does nothing; in a text field `⌘C` still copies its text

37. **SC-37: pasting** (UI)
    - **Given** pane-3 at a prompt, and a program that turned bracketed paste on
    - **When** the person pastes 10 KiB*, then 200 KiB*, then 20 MiB* of text
    - **Then** 10 KiB arrives in one write; 200 KiB arrives complete and in order in 16 KiB writes; 20 MiB is refused with a toast "Paste is larger than 16 MiB"; text is wrapped in bracketed-paste markers only when the program asked for them; nothing pasted stays behind in the pane's hidden input

38. **SC-38: dropping files types their paths** (UI)
    - **Given** pane-3 at a prompt
    - **When** files `/tmp/w/api/a b.txt` and `/tmp/w/api/c.txt` are dropped on it
    - **Then** `'/tmp/w/api/a b.txt' /tmp/w/api/c.txt` is typed at the cursor without Enter

39. **SC-39: the pane menu** (UI)
    - **Given** a split tab, right-clicking pane-3
    - **When** the menu opens
    - **Then** it lists, in order: Copy ⌘C, Select All ⌘A, Paste ⌘V, Quick Commands ▸, separator, Split Terminal Right ⌘D, Split Terminal Down ⌘⇧D, Equalize Pane Sizes, Expand Pane ⌘⇧Enter (Collapse Pane when expanded), separator, Set Title…, Clear Pane Title (only when titled), Copy Terminal ID, Copy Pane ID, Close Pane ⌘W (red), separator, Clear Screen, Reset Terminal; in a single-pane tab Equalize, Expand and Close Pane are absent; with Right-click to Paste on, right-click pastes and Ctrl-click opens the menu; Copy Terminal ID copies the session ID

### Links

40. **SC-40: links are found and underlined** (UI)
    - **Given** pane-3 printed `https://example.com/x`, `src/app.ts:12:4` (cwd `/tmp/w/api`), and an OSC 8 link "docs" to `https://example.com/docs`
    - **When** the person hovers each
    - **Then** each is underlined with a hint at the pane's bottom-left naming its target (`/tmp/w/api/src/app.ts:12:4` for the path); text that isn't an existing path isn't a link; a line that makes a link finder throw doesn't break the pane

41. **SC-41: what each click does** (UI, CLI)
    - **Given** the URL and the file path from SC-40, and "Terminal URL clicks" = Actions
    - **When** the person clicks, `⌘`-clicks, `⇧⌘`-clicks, middle-clicks and `⌥`-clicks each
    - **Then**

      | Click | URL | File path |
      |---|---|---|
      | Click | popover: Open, Copy Link | popover: Open with Default App, Reveal in Finder, Copy Path |
      | `⌘`-click | opens in the system browser | opens with the default app |
      | `⇧⌘`-click | copies the link | reveals in Finder |
      | Middle click | "Middle click" setting (default: open) | same |
      | `⌥`-click and others | nothing | nothing |

      With the setting = Open a plain click opens; with Leave to terminal it does nothing. `quirky terminal open-link <url-or-path> [--reveal]` does what Open does, so an agent can check it

### Search

42. **SC-42: searching a pane** (UI)
    - **Given** pane-3 ran `seq 1 200`
    - **When** the person presses `⌘F`, types `19`, presses Enter twice, Shift+Enter three times, turns on Regex, types `^1.9$`, then presses Escape
    - **Then** the box shows `1/12` after typing, `2/12` and `3/12` after Enter, wraps from `1/12` to `12/12` going back, the active match is orange `#c4580e` with a `#ffcf6b` border and the others `#5c4a00`, scrollbar marks show where matches are; with Regex on, `^1.9$` reads `1/10` (109, 119 … 199); Escape closes the box and clears highlights; an empty box reads `0/0`, a miss "No results", more matches than xterm highlights `N+`; `⌘F` with the box open focuses its input

43. **SC-43: stepping through matches from the terminal** (UI)
    - **Given** the search box open on `19` at `1/12`, with focus back in the terminal
    - **When** the person presses `⌘G` twice and `⌘⇧G` once
    - **Then** the box reads `2/12`, `3/12`, then `2/12`; with the box closed or empty `⌘G` does nothing

44. **SC-44: an agent drives search** (CLI)
    - **Given** the view open with pane-3 active after `seq 1 200`
    - **When** the agent runs `quirky ui run command:quirky.terminal/search --args '{"query":"19"}'`, then `quirky ui run command:quirky.terminal/search-next`, then `quirky ui state --json`
    - **Then** the report shows pane-3's search as `{query: "19", current: 2, total: 12}`; `search-close` clears it; a query over 1,000 characters is refused with invalid-params

### Tab groups

45. **SC-45: Move Tab to Split** (UI, CLI)
    - **Given** one group with tabs "Terminal 1" and "Hello"
    - **When** the person picks Move Tab to Split → Right on "Hello", or the agent runs `quirky terminal tab move tab-3 --split right`
    - **Then** a second group to the right holds "Hello"; each group has its own strip, `+`, quick-command button and "…" pane-actions menu; Left, Down and Up place it on that side
    - **Data before:** **Workspace main**: grp-1 ["Terminal 1", "Hello"]
    - **Walkthrough:**
      1. The daemon makes a split right 0.5 of grp-1 and new grp-2, moves "Hello" into grp-2
    - **Data after:** **Workspace main**: ✓ split right 0.5 (grp-1 ["Terminal 1"], grp-2 ["Hello"]); ✓ grp-2 active

46. **SC-46: dropping a tab on a group body** (UI)
    - **Given** a 900 px wide, 600 px high group body and a tab being dragged
    - **When** the person drops it at the centre, within the left third outside the centre zone, within the right third, and in the middle third's top and bottom halves
    - **Then** the centre (the middle 80%) merges it into that group; outside it, left, right, top and bottom open a new group on that side; inside a group that is already split, the outer 20% at the left and right edges and 20% of the height open a new split there

47. **SC-47: group dividers clamp** (UI, CLI)
    - **Given** two groups side by side
    - **When** the person drags the divider to 5% of the width, or the agent runs `quirky terminal group resize grp-1 --ratio 0.1`
    - **Then** the drag stops at 0.15 and the CLI call fails (SC-7); 0.85 is the other limit

48. **SC-48: a group goes away with its last tab, and "Close Split Pane" keeps tabs** (UI, CLI)
    - **Given** grp-1 ["Terminal 1"] | grp-2 ["Hello", "Logs"]
    - **When** (a) the person closes "Terminal 1"; (b) instead picks Close Split Pane in grp-2's "…" menu, or the agent runs `quirky terminal group close grp-2`
    - **Then** (a) grp-1 is removed and grp-2 fills the area; (b) "Hello" and "Logs" move to the end of grp-1 and grp-2 is removed, with every session still running, and grp-2's active tab becomes grp-1's active tab; when the sibling side is itself split, the tabs go to its first group (leftmost, then topmost); the last group of a workspace is never removed

### Quick commands

49. **SC-49: the Quick Commands panel and adding a command** (UI, CLI)
    - **Given** no quick commands
    - **When** the person opens the Quick Commands panel, clicks Add Command, fills Label "Hello", Command `echo hello`, keeps Terminal, Append Enter on and Scope Project (preselected to **api**), and presses `⌘Enter`; or the agent runs `quirky terminal quick-command add --label Hello --command 'echo hello' --scope repo`
    - **Then** the empty panel read "No quick commands saved. Run them from the Quick Commands button in the tab bar, or right-click inside any terminal."; the dialog "Add Quick Command" shows "Saved items appear in the tab bar menu for one-click run.", disables Save until label and command are filled, limits Label to 80 and Command to 4,000 characters, and disables the Agent select for terminal commands; afterwards the panel lists "Hello", a "Project" badge, `echo hello` and an "Enter" hint; the panel's search box and "All commands" filter narrow the list

50. **SC-50: limits and normalization** (CLI)
    - **Given** 40 saved commands, one with id `hello`
    - **When** the agent adds a 41st, adds another "Hello", and adds one with an empty command
    - **Then** the 41st fails with invalid-params "at most 40 quick commands"; after removing one, the second "Hello" gets id `hello-2`; labels and commands are trimmed; a row with an empty command is kept (so a half-typed command isn't lost) but isn't offered to run

51. **SC-51: running from the tab strip** (UI, CLI)
    - **Given** global command "Hello" (`echo hello`, Append Enter on) and nothing run yet
    - **When** the person clicks the left half of the strip's quick-command button (it reads "Hello"), or the agent runs `quirky terminal quick-command run hello`
    - **Then** a new tab titled "Hello" opens, its prompt appears first and then `echo hello` runs once; the button now reads the group's most recent command; a multi-line command `cd web⏎npm test` runs as `cd web; npm test`; with no commands the button reads "Command" with the tooltip "Save a quick command for this repo" and opens the Add dialog; the chevron opens a menu with "Search quick commands...", per-row copy, edit and delete icons and "+ Command"

52. **SC-52: running from the pane menu** (UI, CLI)
    - **Given** commands "Hello" (Append Enter on) and "Draft" (`echo draft`, Append Enter off)
    - **When** the person picks Quick Commands ▸ Draft in pane-3's menu, or the agent runs `quirky terminal quick-command run draft --pane pane-3`
    - **Then** `echo draft` is typed at pane-3's prompt without running, and the submenu shows "Insert" beside Draft; picking Hello types and runs it; with no commands the submenu reads "No quick commands" and "Add Quick Command…"

53. **SC-53: agent prompt commands open an agent tab** (CLI)
    - **Given** command "Review" of kind agent for agent `claude` with prompt `review the diff`
    - **When** the agent runs `quirky terminal quick-command run review`
    - **Then** a new Claude tab opens with `review the diff` delivered as its first prompt; adding an agent command for an agent whose prompt is typed in after start is refused, and the Add dialog's Agent select doesn't offer one

54. **SC-54: scope** (CLI)
    - **Given** a global "Hello" and a project "Test" for repo **api**
    - **When** the agent runs `quirky terminal quick-command list --worktree main` and in a worktree of another repo
    - **Then** **main** lists both; the other repo lists only "Hello"; the strip's fallback order is the group's most recent, then the first repo command, then the first global one

### The floating workspace

55. **SC-55: opening the floating workspace** (UI, CLI)
    - **Given** the floating workspace has no tabs
    - **When** the person presses `⌘⌥A` (or clicks the floating button), then picks New Terminal; or the agent runs `quirky terminal floating show` and `quirky terminal tab new --workspace floating`
    - **Then** a 920×560 panel opens 24 px from the right and 84 px from the bottom with the empty state rows "New Terminal ⌘T" and "Minimize ⌘W"; New Terminal opens "Terminal 1" in `~`; its strip has no quick-command button; `quirky terminal floating state` reports `open: true, maximized: false` and the bounds

56. **SC-56: maximize, minimize, move and resize** (UI, CLI)
    - **Given** the floating panel open
    - **When** the person clicks Maximize, then Minimize, then `⌘⌥A`; drags the title bar and an edge; or the agent runs `quirky terminal floating maximize`
    - **Then** maximized it fills the window with a 12 px margin over the sidebar; minimized it hides and reopens maximized; dragging moves it, edges resize it, never below 420×280; `⌘⌥⇧A` opens it maximized; each change is stored once when the drag ends

57. **SC-57: the floating workspace survives a relaunch** (CLI)
    - **Given** the floating panel open and maximized with "Terminal 1" running
    - **When** the window and the daemon are restarted
    - **Then** the panel is open and maximized again with "Terminal 1" showing its screen; saved bounds that no longer fit the window are moved inside it

58. **SC-58: keys inside the floating panel** (UI)
    - **Given** the floating panel open with focus in its terminal, and the main view behind it
    - **When** the person presses `⌘T`, `⌘W`, and `⌘1`
    - **Then** `⌘T` opens a tab in the floating workspace, not the main view; `⌘W` closes the focused pane or tab there, and with no tabs left minimizes the panel; `⌘1` selects its first tab

59. **SC-59: the floating button** (UI)
    - **Given** the floating workspace enabled
    - **When** the person drags the floating button to another corner, right-clicks it and picks Hide Floating Workspace
    - **Then** the button stays where it was dropped after a relaunch; Hide turns the "Enable Floating Workspace" setting off, which removes the button and makes `⌘⌥A` do nothing until the setting is on again

### Keybindings

60. **SC-60: terminal keys act only in a terminal** (UI)
    - **Given** the view with pane-3 focused, and the Settings dialog's text field
    - **When** the person presses `⌘C`, `⌘A`, `⌘V`, `⌘F`, `⌘K`, `⌘D` in the pane and in the text field
    - **Then** in the pane each runs its terminal action; in the text field `⌘C`, `⌘A` and `⌘V` copy, select and paste the field's text, and the others do nothing to any pane

61. **SC-61: the shortcut policy** (UI)
    - **Given** pane-3 focused
    - **When** the setting "Shortcuts in Terminal" is App first and the person presses `⌘T`; then it is Terminal first and the person presses `⌘T`, `⌘⇧T` and `⌘D`
    - **Then** under App first `⌘T` opens a tab; under Terminal first `⌘T` and `⌘⇧T` run no app action and go to the terminal as keys (for `⌘` chords the shell receives nothing, as in any macOS terminal), while terminal actions (search, clear, select all, split, close pane) still work; in either mode a bound chord such as `⌘R` never reaches the webview's own default (reload)

62. **SC-62: byte translations** (UI)
    - **Given** pane-3 running `cat -v`
    - **When** the person presses Shift+Enter, Ctrl+Backspace, Alt+Backspace, `⌘⌫`, `⌘⌦`, `⌘←`, `⌘→`, Alt+← and Alt+→
    - **Then** the shell receives `ESC CR`, `^W`, `ESC DEL`, `^U`, `^K`, `^A`, `^E`, `ESC b` and `ESC f`; with kitty keyboard flags active Shift+Enter sends `ESC[13;2u`; `⌘↑` and `⌘↓` scroll to the top and bottom of the scrollback

63. **SC-63: every action has a command and a default key as listed** (CLI)
    - **Given** a fresh home
    - **When** the agent runs `quirky ui contributions --json`
    - **Then** every in-scope action of [D26](../../../loop/decisions/m1-term-ui.md) is a command, its default key is as listed there, terminal-scope keys carry a terminal-focus condition, and ⌘1…9 still select tabs

### Settings

64. **SC-64: terminal settings apply live** (UI, CLI)
    - **Given** two open panes
    - **When** the agent runs `quirky setting set quirky.terminal/font-size 16`, `cursor-style bar`, `line-height 1.2`, `inactive-pane-opacity 0.5`, `divider-thickness 6` and `scrollback 3000`
    - **Then** both panes redraw with the new values without reopening, the report shows font size 16, and values outside each setting's range are refused; every setting of [D27](../../../loop/decisions/m1-term-ui.md) appears in the Settings dialog under the terminal plugin with Orca's default

### Persistence

65. **SC-65: the layout survives a window and daemon restart** (CLI)
    - **Given** two groups, a three-pane tab with pane-3 titled "logs" and expanded, a blue pinned tab with a custom title, a 0.3 split, and `seq 1 50` output
    - **When** the window and `quirkyd` are restarted (the PTY host keeps running), and separately the PTY host is restarted
    - **Then** `quirky terminal layout --json` returns the same groups, tabs, titles, colours, pins, ratios, active and expanded IDs and pane titles; the panes show their output; after a host restart the panes cold-restore (old text above a fresh prompt)

66. **SC-66: a damaged saved layout is rebuilt** (CLI)
    - **Given** the stored workspace for **main** is unreadable and two sessions exist
    - **When** the daemon starts and the agent runs `quirky terminal layout --worktree main`
    - **Then** the workspace is rebuilt with one tab per session, a log line names the worktree, and nothing fails

### Plugin API growth

67. **SC-67: a plugin overlay slot** (UI, CLI)
    - **Given** a test plugin declaring an `overlay` contribution
    - **When** the window starts and the agent runs `quirky ui state --json`
    - **Then** the overlay is mounted over the whole window and listed in `slots` with `kind: overlay` and its report; `shown` is the report's `shown` value (true until it reports otherwise) while a window has it mounted, else false; disabling the plugin removes it

68. **SC-68: keybinding `when`** (UI, CLI)
    - **Given** a test plugin with bindings `mod+j` when `terminalFocus` and `mod+j` when `!terminalFocus` to two commands
    - **When** `mod+j` is pressed with a terminal focused and with the sidebar focused
    - **Then** each fires only its own command; `quirky ui contributions --json` shows both bindings active with their conditions; a `when` that doesn't parse makes the contribution invalid with a message

69. **SC-69: embedding another plugin's view** (UI)
    - **Given** a structured session in tab "Claude (background)"
    - **When** the tab is shown
    - **Then** its pane shows `quirky.session`'s structured view inside the pane, and switching away unmounts it

70. **SC-70: the worktree view stays replaceable** (CLI)
    - **Given** (a) the built-ins only; (b) a test plugin that depends on `quirky.terminal` and overrides `view:quirky.session/worktree` again; (c) `quirky.session` installed without `quirky.terminal` (its own test set)
    - **When** the agent opens the view and runs `quirky ui state --json` and `quirky ui contributions --json`
    - **Then** (a) the view is `quirky.terminal`'s workspace; (b) the test plugin's view wins, as the registry's override rule says; (c) `quirky.session`'s simple tabbed view still works; in every case callers keep opening `view:quirky.session/worktree`

76. **SC-76: opening the view with a session focuses its pane** (CLI)
    - **Given** the workspace from the conceptual model, with tab-1 active
    - **When** the agent (or a notification, or the Sessions panel) runs `quirky ui open-view view:quirky.session/worktree --input '{"worktree":"main","session":"<s-3>"}'`
    - **Then** grp-1 becomes the active group, tab-2 its active tab and pane-3 the active pane, and the report's `active` is s-3; a session that no pane shows is ignored and the workspace keeps its active pane

### Orca defects

71. **SC-71: `exit 3` shows its exit code (Orca: the code was recorded as 0 and the pane closed)** (CLI) — see SC-33; the test runs `exit 3` in a lone pane and in a split pane and checks both stay with exit code 3.

72. **SC-72: reopen with nothing to reopen says so (Orca: a bare "Terminal shortcut handled" toast)** (UI)
    - **Given** the only closed tab went away because its shell exited
    - **When** the person presses `⌘⇧T`
    - **Then** no tab opens and a toast reads "No closed tab to reopen"; `quirky terminal tab reopen` fails with not-found "no closed tab to reopen in main"

73. **SC-73: Enter and `⌘G` in the search box step (Orca: unverified, not stepping)** (UI) — the test focuses the box after typing `19`, presses Enter and `⌘G`, and checks `2/12` then `3/12`.

74. **SC-74: a split survives a crash right after it (Orca: the binding was saved by a renderer debounce)** (CLI)
    - **Given** the view open
    - **When** the agent runs `quirky terminal pane split pane-1 --direction right` and the window process is killed at once, then the daemon is killed and restarted
    - **Then** the layout has both panes bound to their sessions, and no session is left without a pane

### Memory

75. **SC-75: hidden tabs cost nothing in the window, and WebGL is capped** (UI)
    - **Given** eight tabs, two of them with two panes, and two groups showing one tab each
    - **When** the agent reads the report
    - **Then** only the visible tabs' panes are mounted (at most four xterm instances), at most 12 panes use WebGL at once, and the memory probe at the typical-day workload stays within [the budget](../../../architecture.md#memory-budget)

## Scope & non-goals

In scope: every flow above, on macOS.

Non-goals, each owned elsewhere or ruled out ([D5](../../../loop/decisions/m1-term-ui.md)):
- Browser, Markdown and Mobile Emulator tabs and their `+` menu rows (sa-browser-ui, m2-editor), and "Open file" / "Open in this group" link actions (m2-editor).
- Fork Agent Session…, Copy Context, Continue with Terminal Agent and the composer dock (m3-handoff, m3-terminal-dock).
- Agent attention icons and the unread bell on tabs (m1-agent-status, m1-notifications); tabs keep today's status dot.
- SSH and remote-runtime overlays, the newer-daemon banner, sleeping and restoring overlays, and hidden-view parking.
- Windows and Linux shells, ConPTY options and Linux GPU policy ([D42](../../../loop/decisions/m1-term-ui.md)).
- Inline images, ligatures, Ghostty import, Orca's terminal theme catalogue and colour overrides ([D28](../../../loop/decisions/m1-term-ui.md)).
- The floating toggle's status-bar location ([D25](../../../loop/decisions/m1-term-ui.md)).
- User remapping of shortcuts ([D31](../../../loop/decisions/m1-term-ui.md)).
- Searching beyond the pane's scrollback.

## Decisions Locked

**Visual**
- Workspace = tree of tab groups; tab = tree of panes; Orca's sizes, limits and zones (D8, D16, D17).
- Menus in Orca's order minus agent rows; colour dots; pinned tabs first (D18, D19).
- Empty states: one terminal per new workspace; floating empty state with two rows; quick-command panel empty text (SC-1, SC-55, SC-49).
- Error states: exit overlay for non-zero exits; toasts for refused pastes and nothing to reopen (D14, D22, D41).

**API**
- Every change is a method on `quirky.terminal` returning the workspace with a revision; stale revisions conflict (D7, D34).
- Errors: not-found names the ID, invalid-params names the rule, conflict names the revision (D34).
- The plugin API grows an overlay slot, keybinding `when`, view embedding, conditional confirmation and session start directories (D38).

**CLI**
- One `quirky terminal` group with `layout`, `tab`, `pane`, `group`, `quick-command`, `floating` and `open-link` (D33).
- Human output is an indented tree; `--json` prints the method result; non-zero exit on every error (D33, D34).
- Closing a running command asks unless `--yes` (D12).

**Data**
- Layout, closed tabs, quick commands and floating state persist in the plugin store; damaged rows are rebuilt from sessions (D23, D25, D35).
- Every session gets a pane; reconciliation runs in the daemon (D10).

## Industry Insights

- **N-ary versus binary trees.** VS Code's grid and Wave's layout use n-ary rows so three panes stay one row; Quirky stays binary to match Orca's observable sizing, and equalize weights by pane count (D8). [VS Code gridview.ts](https://github.com/microsoft/vscode/blob/main/src/vs/base/browser/ui/grid/gridview.ts), [Wave layoutTree.ts](https://github.com/wavetermdev/waveterm/blob/main/frontend/layout/lib/layoutTree.ts)
- **Don't remount an xterm when the tree changes shape.** A pane whose position in the tree changes should keep its terminal instance; recreating it loses modes and prompt marks. [wmux #346](https://github.com/amirlehmam/wmux/issues/346)
- **Focus after DOM moves.** Removing the focused element sends focus to `body`; refocus the successor pane explicitly. [cove #116](https://github.com/GhostFlying/cove/pull/116), [tarmac #162](https://github.com/pingeplin/tarmac/issues/162)
- **WebGL contexts are limited.** Chromium keeps about 16 per page and disposing the addon doesn't free one; give WebGL only to visible panes, capped at 12. [xterm #6068](https://github.com/xtermjs/xterm.js/issues/6068), [termdeck #208](https://github.com/kiril6/termdeck/pull/208)
- **Resize storms.** Unthrottled resizes during a sash drag freeze the renderer and spam SIGWINCH; refit locally and send the final size. [vscode #340786](https://github.com/microsoft/vscode/issues/340786), [zellij #4978](https://github.com/zellij-org/zellij/issues/4978)
- **Search decorations can throw.** A narrowing alt-screen resize makes addon-search pass a negative width; wrap search calls and pin matching addon versions. [nodeterm #1312](https://github.com/eneskirca/nodeterm/issues/1312), [hive #439](https://github.com/lucascaro/hive/issues/439)
- **Large pastes stick in xterm's textarea.** Intercept paste and chunk it. [xterm #6259](https://github.com/xtermjs/xterm.js/issues/6259)
- **Key handlers must allowlist.** Return `false` from `attachCustomKeyEventHandler` only for app shortcuts, or Shift+Enter and kitty-protocol keys break. [emdash #1411](https://github.com/generalaction/emdash/pull/1411), [superset #2970](https://github.com/superset-sh/superset/issues/2970)
- **Server-owned layout.** tmux and WezTerm keep layout in a process that outlives clients; a bad saved layout must not break attach. [WezTerm multiplexing](https://wezterm.org/multiplexing.html), [zellij #5684](https://github.com/zellij-org/zellij/issues/5684)
- **Overrides.** An override is a sibling that wins; route every lookup through the registry and test the disabled case. [Backstage overrides](https://backstage.io/docs/frontend-system/architecture/extension-overrides/), [JupyterLab #7776](https://github.com/jupyterlab/jupyterlab/issues/7776)

## Deferred Ideas

- A tab content kind for editor, browser and markdown tabs in the same strip (m2-editor, sa-browser-ui).
- Searching a session's full history from the daemon (`quirky terminal history` exists; a search over it would help agents).
- User remapping of shortcuts (D31).
- `[tech-spec]` How the window keeps an xterm instance alive across a tree reshape (move its DOM node or re-attach from the host).
- `[tech-spec]` The exact shape of `when` expressions, the overlay slot and view embedding.
- `[tech-spec]` How child processes are detected for the running-command confirmation.

## Glossary

- **Workspace:** the tab area of one worktree, or the floating workspace; a tree of tab groups with a revision.
- **Tab group:** one tab strip and its tabs; groups split the workspace side by side or stacked.
- **Tab:** one entry in a strip; holds a tree of panes.
- **Pane:** one terminal (or structured session) view inside a tab, bound to one session.
- **Split:** a node dividing its area between two children, right (side by side) or down (stacked), at a ratio.
- **Revision:** a number every workspace change increases; a caller can require it to match.
- **Floating workspace:** the workspace shown in the overlay panel, not tied to a repo, whose shells start in the Terminal Directory setting.
- **Quick command:** a saved command or agent prompt, global or for one repo.
- **Terminal scope:** keys that act only while a terminal pane has focus.
