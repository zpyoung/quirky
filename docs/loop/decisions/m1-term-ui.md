# m1-term-ui decisions

## D1: Classify the item as Visual, API, CLI and Data design, and run every research phase
- **Question:** which domains the gray-area catalog draws from, and whether the research swarms run (quirk:brainstorming, checklist step 2)
- **Options:** one domain; several; skip research
- **Chose:** Visual (tab strip, panes, dividers, menus, search box, floating panel), API (the layout and quick-command methods agents call), CLI (the `terminal` command group), Data (the persisted layout and quick commands). Phase A ran two web-research agents (split-pane architecture patterns; xterm.js pitfalls) and two Explore agents (the current pane and tab code; the public plugin API). Phase B ran one agent per architectural option (daemon-owned layout; one plugin overriding another's view).
- **Why:** the item's consumers are a person at the window and an agent driving the same layout through the CLI. No earlier item researched pane layout.
- **Evidence:** docs/loop/queue.json m1-term-ui; docs/roadmap.md M1 "Terminal panes"
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

## D3: Keep m1-term-ui as one item, built in waves, resumed across iterations if needed
- **Question:** brainstorming's scope check: the doc covers tabs, splits, tab groups, search, links, paste, zoom, quick commands, the floating workspace, keybindings and settings
- **Options:** one spec pair for all of it; split into a core item and an extras item through `queue.ts add`
- **Chose:** one spec pair, built in dependency waves. If the session runs long, the Progress section names the next wave and the lane's next iteration resumes.
- **Why:** LOOP.md adds only `fix-` items, the queue's title for this item lists every flow, and m3-terminal-dock depends on this item as a whole. The pieces share one layout model, so splitting would force a second spec over the same model.
- **Evidence:** docs/loop/LOOP.md "Fix items"; docs/loop/queue.json m1-term-ui title and m3-terminal-dock deps
- **Reversibility:** easy
- **Confidence:** medium
- **Revisit if:** the build cannot finish within two iterations
- **Source:** assumed — autonomous

## D4: Select every gray area that matters
- **Question:** which gray areas to drill into (brainstorming Step 1)
- **Options:** three or four catalog areas; every area that bears on this item
- **Chose:** Visual layout-style, empty-state, error-state, interaction-style; API response-format, error-responses, versioning; CLI output-format, flag-design, exit-codes; Data error-handling, idempotency
- **Why:** LOOP.md says to select every area that matters when no human is present
- **Evidence:** docs/loop/LOOP.md "Gray areas"
- **Reversibility:** easy
- **Confidence:** high
- **Source:** locked by docs/loop/LOOP.md

## D5: In scope are every term-ui flow on macOS; out of scope are the flows whose features Quirky doesn't have yet
- **Question:** which of the doc's flows this item covers (scope check, non-goals)
- **Options:** everything in the doc; the flows that need only terminals, with the rest named as non-goals
- **Chose:** in scope: tabs (create, name, rename, close, close confirmations, reopen, reorder, move, colour, pin, the tab menu, recent switcher, next/previous, select by index), panes (split right/down, resize, equalize, drag to move, expand, focus next/previous, close, title, clear, reset, zoom, selection, copy, paste, file drop, links), search, tab groups, quick commands, the floating workspace, the terminal-pane and tab keybindings with the shortcut policy, the terminal settings listed in D27, exit behaviour and layout persistence. Out of scope, named in the spec's non-goals: browser, markdown and mobile-emulator tabs and their `+` menu rows (sa-browser-ui, m2-editor); "Open file" link actions that need the editor (m2-editor); Fork Agent Session…, Copy Context and the composer dock (m3-handoff, m3-terminal-dock); agent attention icons and the bell on tabs (m1-agent-status, m1-notifications); SSH and remote-runtime overlays (Quirky has no SSH provider); the newer-daemon banner and sleeping overlays (Quirky's daemon has no version hold or deferred spawns); hidden-view parking (Quirky unmounts hidden panes by rule); the Windows and Linux shell, ConPTY and WebGL-policy settings (deferred: platform, D42); inline images, ligatures, Ghostty import and Orca's terminal theme catalogue (D28); the status-bar toggle location (Quirky has no status bar, D25); user remapping of shortcuts (D31).
- **Why:** LOOP.md makes each in-scope flow an acceptance criterion; flows that need a feature another item builds belong to that item.
- **Evidence:** term-ui.md "What the user can do", "Dependencies on other features"; docs/loop/queue.json
- **Reversibility:** easy
- **Confidence:** high
- **Source:** locked by docs/loop/LOOP.md

## D6: `quirky.terminal` owns the feature, and replaces the session view by overriding its ID
- **Question:** which built-in plugin ships terminal panes, given the pane and tab strip live in `quirky.session` today and many callers open `view:quirky.session/worktree`
- **Options:** grow `quirky.session`'s view in place; a new `quirky.tabs` plugin; `quirky.terminal` declares an override of `view:quirky.session/worktree` and of the session tab commands, with its own window code
- **Chose:** `quirky.terminal` (the terminals plugin, CLI group `terminal`, alias `term`). Its manifest overrides `view:quirky.session/worktree` and the commands `new-shell`, `close-session` and `select-tab*`, so every existing caller (sidebar, notifications, agent tabs, Sessions panel, `quirky ui open-view`) lands in the new workspace. `quirky.session` keeps its simple view, which is what a set of plugins without `quirky.terminal` gets (its own tests use it), and keeps sessions, their records and the structured view. The registry has no per-contribution way to drop one override and keep the original (disabling an ID removes every declaration of it), so a distro can't switch back to the simple view while keeping terminals; a further plugin can still override the view again.
- **Why:** overriding by ID is the registry's designed mechanism (roadmap "Overrides"), the view ID is referenced from 15+ files across five plugins, and the feature doc is "Terminal panes", which matches the terminals plugin. A new plugin would add a third owner for terminal UI. Growing `quirky.session` would put the feature's methods in the wrong command group. Phase B research: a Backstage override adds a sibling that takes precedence rather than changing the original, and JupyterLab #7776 shows two lookups for one view diverging, so every caller must resolve the view through the registry, and a test must cover the case where the override is disabled.
- **Evidence:** https://backstage.io/docs/frontend-system/architecture/extension-overrides/, https://github.com/jupyterlab/jupyterlab/issues/7776; packages/daemon/src/plugins/registry.ts:177,284; plugins/quirky.session/quirky-plugin.json; m0-core D21 ("Tab groups and splits are M1's term-ui work")
- **Reversibility:** medium
- **Confidence:** medium
- **Revisit if:** keeping two worktree-view implementations costs more than retiring the fallback
- **Source:** assumed — autonomous

## D7: Layout lives in the daemon; the window renders it and changes it only through methods
- **Question:** who owns tabs, groups, pane trees, focus and sizes
- **Options:** the window owns them and saves a snapshot (Orca); the daemon owns them and the window calls a method for every change
- **Chose:** the daemon. `quirky.terminal` keeps one workspace per worktree (and one for the floating workspace) in its plugin store. Every change, from a click, a key or the CLI, is a method call; the daemon emits `quirky.terminal/layout` with the workspace's new revision and the window re-renders. Divider drags and floating-panel drags change sizes locally and send one call when the drag ends.
- **Why:** roadmap "Layout and focus live in the daemon, and agents read what the window shows as JSON". It also removes Orca's defect class where the renderer's 150 ms debounce could orphan a pane's PTY binding (term-ui.md "Layout persistence"). Phase B research: tmux and WezTerm keep layout in the server so it outlives clients; zellij's resize reports suggest previewing a drag locally and committing once on mouse-up; zellij #5684 shows a bad saved layout breaking attach, so restore must be non-fatal.
- **Evidence:** docs/roadmap.md "Everything is scriptable"; term-ui.md "Layout persistence"; research: https://wezterm.org/multiplexing.html, https://github.com/zellij-org/zellij/issues/5684
- **Reversibility:** hard
- **Confidence:** high
- **Source:** locked by docs/roadmap.md

## D8: Tab groups and pane trees are binary trees with ratios, like Orca
- **Question:** the shape of a split layout
- **Options:** binary split nodes with a ratio (Orca); n-ary rows with weights (VS Code, Wave)
- **Chose:** binary. A split node is `{kind: 'split', direction: 'right'|'down', ratio, first, second}`; a pane leaf is `{kind: 'pane', pane}`. A new split gives the new pane half of the old pane's space. Ratios are stored rounded to three decimals.
- **Why:** Orca's observable behaviour is binary (splitting the right of two panes gives 50/25/25; double-click on a divider resets the two panes next to it). Equalize can still give same-axis neighbours equal shares by weighting by leaf count, which is what Orca does.
- **Evidence:** term-ui.md "Panes and splits" 1-3, "PaneManager"; research: VS Code gridview.ts, Wave layoutTree.ts
- **Reversibility:** medium
- **Confidence:** high
- **Source:** locked by term-ui.md

## D9: Every tab, group and pane has a stable short ID; a pane is bound to one session
- **Question:** identity, and how agents find their own pane
- **Options:** Orca's `tabId:leafId` key exported in env; IDs in the layout plus lookup by session
- **Chose:** IDs `tab-<n>`, `grp-<n>`, `pane-<n>` unique per daemon store. A pane holds `session`. `quirky terminal pane [--session ID]` finds a pane from `$QUIRKY_SESSION_ID`, so no new environment variables are added.
- **Why:** launch hooks may not set `QUIRKY_*` variables (plugins.ts reserved names), and the session ID is already in every shell's environment.
- **Evidence:** packages/protocol/src/plugins.ts:264-269; term-ui.md "Identity"
- **Reversibility:** medium
- **Confidence:** high
- **Source:** assumed — autonomous

## D10: Every session gets a pane; sessions created elsewhere open in a new tab
- **Question:** what happens when a session starts through `quirky session new`, an agent tab command or an automation, and when a session is closed elsewhere
- **Options:** only sessions the terminal plugin creates get tabs; every session of a worktree is adopted into a new tab in that worktree's active group
- **Chose:** every terminal or structured session of a worktree that no pane holds gets a new tab in the active group of that worktree's workspace. A session that disappears (`quirky session close`) removes its pane, an empty tab closes, and an empty group other than the last is removed.
- **Why:** v1 shows every session as a tab (exit test "v1 behaves as it does today"), and Orca ties each PTY to a tab. Agents launched by `quirky.agents/new-agent-tab` must keep landing in a tab.
- **Evidence:** plugins/quirky.session/src/window/model.ts; packages/ui/test/exit.e2e.test.ts SC-35
- **Reversibility:** medium
- **Confidence:** high
- **Source:** assumed — autonomous

## D11: Tab titles: a custom title, else the live title, else `Terminal N`
- **Question:** naming new tabs and which title shows
- **Options:** keep session titles ("Shell 2"); Orca's `Terminal N` with the lowest free ordinal and a custom title that beats live titles
- **Chose:** a new shell tab is `Terminal N` with the lowest free N in its workspace; an agent tab takes its session's title. The tab shows its custom title if set, else the shell's live OSC title, else its default title. A quick-command tab's default title is the command's label.
- **Why:** term-ui.md "Open, close and reorder tabs" 1 and 3, and "A custom title wins over live titles".
- **Evidence:** term-ui.md lines 48-52, 133
- **Reversibility:** easy
- **Confidence:** high
- **Source:** locked by term-ui.md

## D12: Closing a pane or tab ends its sessions; a running command or agent asks first
- **Question:** what close does to the session, and the running-process confirmation for people and for the CLI
- **Options:** close only the view and keep the session; close ends the session; confirm always, never, or only when a child process runs
- **Chose:** closing a pane closes its session. When the shell has a running child process (or the session is an agent), the window shows Orca's "Stop running command?" / "Stop this agent?" dialog with "Don't ask again for running terminals"; the CLI and API ask through `quirky ask` unless the call passes `--yes`. Closing an idle shell never asks. A pinned tab asks "Close pinned tab?" in the window unless its setting is off. A second close request within 350 ms of a dialog closing is ignored.
- **Why:** term-ui.md "Open, close and reorder tabs" 4-5; roadmap "Actions that can't be undone ... ask through quirky ask unless the call passes --yes". Killing a running command can't be undone; closing an idle prompt loses nothing that reopening doesn't restore.
- **Evidence:** term-ui.md lines 53-56; docs/roadmap.md "Agent access"
- **Reversibility:** medium
- **Confidence:** medium
- **Revisit if:** asking only for running commands surprises agents that expect every close to confirm
- **Source:** locked by term-ui.md

## D13: Reopen closed tab starts a fresh shell with the old tab's directory, title, colour and agent kind
- **Question:** what `Mod+Shift+T` restores, how many, and what an exited tab does
- **Options:** restore the old session; start fresh
- **Chose:** fresh, as Orca: the last closed tab of that workspace comes back as a new shell in its start directory with its custom title and colour, never the old output. Ten per workspace are kept, in the store. Tabs that went away because their shell exited are not offered. With nothing to reopen, the window shows a toast "No closed tab to reopen" (the Orca defect in D41).
- **Why:** term-ui.md "Open, close and reorder tabs" 6
- **Evidence:** term-ui.md lines 57-59
- **Reversibility:** easy
- **Confidence:** high
- **Source:** locked by term-ui.md

## D14: Exit 0 closes the pane, a non-zero exit keeps it with an overlay
- **Question:** what the pane does when its process ends
- **Options:** keep v1's "exited (code N)" bar on every exit; Orca's intended behaviour
- **Chose:** Orca's intended behaviour, decided in the daemon so it holds with no window open. Exit 0 closes the pane (and the tab when it was the last pane), except a lone pane nobody typed into, which stays so a failing startup stays visible. A non-zero exit keeps the pane with the overlay "Terminal exited / The shell process ended with exit code N. Its output is preserved." and Close and Restart buttons; Restart starts a fresh shell in the same pane and cwd. A session lost with the host stays and cold-restores (m1-term-daemon D10).
- **Why:** term-ui.md "Process exit behaviour". Orca's overlay never showed on macOS because exit codes were masked; m1-term-daemon D11 fixed the codes, so the overlay is reachable here.
- **Evidence:** term-ui.md lines 375-380, 437; m1-term-daemon D11
- **Reversibility:** easy
- **Confidence:** high
- **Source:** locked by term-ui.md

## D15: Splits start in the source pane's directory as a shell
- **Question:** what a new split pane runs and where
- **Options:** the worktree root; the source pane's last OSC 7 cwd, else its start cwd
- **Chose:** a shell in the source pane's cwd (from the PTY host's `cwd` fact), else the source session's start cwd, else the worktree root. Sessions gain an optional start `cwd`.
- **Why:** term-ui.md "Panes and splits" 1. Quirky's PTY host already records OSC 7 cwd (m1-term-daemon), so no 1000 ms lookup is needed.
- **Evidence:** term-ui.md line 70; plugins/quirky.terminal/src/terminal.ts factEvent
- **Reversibility:** easy
- **Confidence:** high
- **Source:** locked by term-ui.md

## D16: Pane sizes, focus, expand and titles follow Orca's rules
- **Question:** the observable pane rules
- **Options:** Orca's; simpler ones
- **Chose:** minimum pane size 50 px (or half the pair when smaller); double-click a divider resets its pair to equal; Equalize Pane Sizes gives same-axis neighbours equal shares; `Mod+Shift+Enter` expands the active pane and collapses it again, needs 2+ panes, and shows a collapse icon on the tab; moving focus collapses first; `Mod+]`/`Mod+[` wrap; pane titles show in the pane header and persist; dragging a pane by its header onto another pane's edge moves it there (needs 2+ panes, 5 px threshold), onto another tab moves it into that tab; the last pane of a tab can't be moved out. Only the active pane shows its header controls.
- **Why:** term-ui.md "Panes and splits" 3-8 and "Edge cases"
- **Evidence:** term-ui.md lines 74-87, 393-394
- **Reversibility:** easy
- **Confidence:** high
- **Source:** locked by term-ui.md

## D17: Tab groups: drop zones, Move Tab to Split, 0.15–0.85 dividers, and closing a group keeps its tabs
- **Question:** tab group behaviour, including the unverified "close split pane"
- **Options:** close the group's tabs with it; merge its tabs into the neighbouring group
- **Chose:** a workspace is a tree of groups, each with its own tab strip, `+`, quick-command button, active tab and MRU. Dropping a tab on a group body picks centre (middle 80%, merge) or left/right/up/down by Orca's zone rule; dropping on a strip moves it there. "Move Tab to Split" Right/Left/Down/Up does the same. Group dividers clamp between 0.15 and 0.85. A group's last tab closing removes the group, unless it is the only one. "Close split pane" moves the group's tabs into its sibling and removes the group.
- **Why:** term-ui.md "Tab groups" 1-4. Orca's "Close split pane" result is unverified; merging can't lose a running command, and closing tabs stays one more action away.
- **Evidence:** term-ui.md lines 111-118
- **Reversibility:** easy
- **Confidence:** medium
- **Revisit if:** Orca's close-split-pane is checked and closes the tabs
- **Source:** assumed — autonomous

## D18: The tab menu and pane menu follow Orca's order minus the agent rows
- **Question:** the contents of the context menus
- **Options:** Orca's full menus; Orca's minus items whose features are out of scope
- **Chose:** tab menu: Move Tab to Split (Right, Left, Down, Up), Split Terminal (Right, Down), Pin Tab / Unpin Tab, Copy Tab ID, Close (⌘W), Close Others, Close All Tabs To The Right (disabled on the last tab), Close All Tabs To The Left, Change Title (⌘R), Tab Color (none + nine swatches), and Close Split Pane when the group is split. Close Others and Close To The Right/Left skip pinned tabs. Pane menu: Copy (⌘C), Select All (⌘A), Paste (⌘V), Quick Commands ▸, separator, Split Terminal Right (⌘D), Split Terminal Down (⌘⇧D), Equalize Pane Sizes and Expand/Collapse Pane (only with 2+ panes), separator, Set Title…, Clear Pane Title (when titled), Copy Terminal ID, Copy Pane ID, Close Pane (⌘W, only with 2+ panes), separator, Clear Screen, Reset Terminal. Right-click opens it; Ctrl-click when right-click-to-paste is on.
- **Why:** term-ui.md "Where to find it"; agent rows are out of scope (D5). Skipping pinned tabs in bulk closes is what pinning is for.
- **Evidence:** term-ui.md lines 17-25
- **Reversibility:** easy
- **Confidence:** high
- **Source:** locked by term-ui.md

## D19: Tab colours are Orca's ten, shown as a dot; pinned tabs sort first
- **Question:** colour and pin presentation
- **Options:** tinted labels; a dot; pinned tabs in place or first
- **Chose:** colours None, Blue `#3b82f6`, Purple `#a855f7`, Pink `#ec4899`, Red `#ef4444`, Orange `#f97316`, Yellow `#eab308`, Green `#22c55e`, Teal `#14b8a6`, Gray `#9ca3af`, drawn as a dot before the close button. A pinned tab shows a pin glyph instead of its close button and stays left of unpinned tabs in its group.
- **Why:** term-ui.md "Open, close and reorder tabs" 8 and "Verified" 3. Where pinned tabs sit isn't in the doc; leftmost is what browsers and VS Code do.
- **Evidence:** term-ui.md line 61
- **Reversibility:** easy
- **Confidence:** medium
- **Source:** assumed — autonomous

## D20: Search is the xterm search addon with Orca's box, counts, keys and colours
- **Question:** search behaviour and how an agent drives it
- **Options:** window-only; window search plus a UI command and report
- **Chose:** `Mod+F` opens the box in the active pane (again focuses it); incremental search with Case sensitive, Regex, Previous, Next and Close; Enter/Shift+Enter and `Mod+G`/`Mod+Shift+G` step and wrap; status `0/0` (empty), "No results", `n/total` or `total+`; Escape closes and clears highlights; colours `#5c4a00`, `#c4580e`, border `#ffcf6b`; a query over 1,000 characters is refused; a highlight error is caught so the pane stays up. The commands `quirky.terminal/search`, `search-next`, `search-previous` and `search-close` take args (`query`, `regex`, `caseSensitive`), and the view's report carries the active pane's search state, so `quirky ui run` drives it and `quirky ui state` reads `n/total`. Search covers the pane's scrollback only, as in Orca.
- **Why:** term-ui.md "Search"; roadmap "Every UI command, including ones that only change the view, is an API command routed to the open window".
- **Evidence:** term-ui.md lines 99-109, 384; research: nodeterm #1312 (decoration crash)
- **Reversibility:** easy
- **Confidence:** high
- **Source:** locked by term-ui.md

## D21: Links: URLs, file paths, OSC 8 and PR links, with Orca's click rules; files open with the default app until the editor lands
- **Question:** link detection and what each click does
- **Options:** Orca's full set; URLs only
- **Chose:** URLs, OSC 8 hyperlinks and absolute or cwd-relative file paths (with `:line[:col]`) are underlined on hover with a hint at the pane's bottom-left. Plain click shows the link popover (URL: Open, Copy Link; file: Open with Default App, Reveal in Finder, Copy Path) when "Terminal URL clicks" is Actions, opens when it is Open, and does nothing when it is Leave to terminal. `Mod`-click opens directly; `Shift+Mod`-click opens the other destination (for a URL, copy; for a file, Finder). Middle click follows its own setting (default Open). `Alt` and other modifiers are ignored. URLs open in the system browser through a new daemon method. A link provider that throws is caught.
- **Why:** term-ui.md "Panes and splits" 12. Orca's in-app browser and editor destinations belong to sa-browser-ui and m2-editor (D5).
- **Evidence:** term-ui.md lines 91-95, 396
- **Reversibility:** easy
- **Confidence:** medium
- **Revisit if:** m2-editor lands and file links should open in the editor
- **Source:** locked by term-ui.md

## D22: Paste is chunked like Orca's, and dropped files type shell-escaped paths
- **Question:** paste limits and file drop
- **Options:** xterm's default paste; Orca's limits
- **Chose:** `Mod+V` pastes, bracketed when the program asked for it; up to 64 KiB goes in one write, more in 16 KiB chunks in order, refused over 16 MiB with a toast, and given up after 30 s. Dropping files or `file://` URLs on a pane types their shell-escaped paths, space-separated, at the cursor.
- **Why:** term-ui.md "Panes and splits" 13-14; research: xterm #6259 (large pastes stick in the textarea), so the pane takes over paste itself.
- **Evidence:** term-ui.md lines 96-97
- **Reversibility:** easy
- **Confidence:** high
- **Source:** locked by term-ui.md

## D23: Quick commands live in the terminal plugin's store, with Orca's limits, and are managed in a panel
- **Question:** storage, scope and where quick commands are edited
- **Options:** a setting (settings are scalars); the plugin store with methods
- **Chose:** the store, with methods and `quirky terminal quick-command list|add|update|remove|run`. Fields: label (≤80), kind `terminal` or `agent`, agent (agent kind only, agents whose prompt delivery isn't stdin-after-start), command (≤4000), appendEnter (default true, terminal kind only), scope `global` or a repo. At most 40. IDs are derived from the label and deduplicated with `-2`, `-3`. Incomplete rows are kept. Orca's Settings page becomes a "Quick Commands" panel with its empty state, search, scope filter and the Add/Edit dialog, because Quirky's settings dialog is generic and panels are the code-backed slot plugins use (m1-term-daemon D3).
- **Why:** term-ui.md "Quick commands" 1-2, 7
- **Evidence:** term-ui.md lines 122-140; m1-term-daemon D3
- **Reversibility:** medium
- **Confidence:** high
- **Source:** locked by term-ui.md

## D24: Running a quick command follows Orca's two paths
- **Question:** what running a quick command does from the tab strip and from the pane menu
- **Options:** one path; Orca's two
- **Chose:** the tab-strip button runs the group's most recent command (else the first repo command, else the first global one) in a new tab titled with its label; multi-line commands are flattened with `; `; the command is written once the shell is ready (the PTY host's barrier) and always ends with Enter. The pane menu writes the command into the current pane, adding Enter only when appendEnter is on ("Insert" hint otherwise). Agent commands always open a new agent tab with the command as its prompt. The button is hidden in the floating workspace; with no commands it reads "Command" and opens the Add dialog.
- **Why:** term-ui.md "Quick commands" 3-6
- **Evidence:** term-ui.md lines 130-139
- **Reversibility:** easy
- **Confidence:** high
- **Source:** locked by term-ui.md

## D25: The floating workspace is a full-window overlay with its own tab groups, state kept in the daemon
- **Question:** how the floating workspace is placed and where its geometry lives
- **Options:** Orca's localStorage keys; the daemon
- **Chose:** a panel over the window with the same strip and tab groups, bound to the synthetic workspace `floating`, whose shells start in the "Terminal Directory" setting (default `~`). Default 920×560, minimum 420×280, 24 px from the right and 84 px from the bottom, maximized with a 12 px margin; drag the title bar to move, edges to resize; Restore/Maximize and Minimize buttons. Open, maximized and bounds persist in the daemon, so they survive a relaunch and `quirky terminal floating` reads and sets them. Saved bounds off screen are pulled back into the window. The floating button is draggable and remembers where it was; its menu has Hide Floating Workspace. `Mod+Alt+A` toggles, `Mod+Alt+Shift+A` opens maximized. Empty state rows: New Terminal (⌘T) and Minimize (⌘W). Inside the panel `Mod+T`, `Mod+W` and tab digits act on the floating workspace. The status-bar location is left out because Quirky has no status bar.
- **Why:** term-ui.md "Floating terminal"; layout lives in the daemon (D7)
- **Evidence:** term-ui.md lines 142-160, 407
- **Reversibility:** medium
- **Confidence:** high
- **Source:** locked by term-ui.md

## D26: Keybindings: Orca's macOS defaults for terminal panes and tabs, with a shortcut policy
- **Question:** which keys bind what, and who wins inside a terminal
- **Options:** Orca's table; a subset
- **Chose:** Orca's macOS defaults for every in-scope action: ⌘C, ⌘A, ⌘V, ⌘F, ⌘G/⌘⇧G, ⌘K, ⌘], ⌘[, ⌘⇧Enter, ⌘W, ⌘D, ⌘⇧D, ⌘T, ⌘R, ⌘⇧T, ⌘⌥]/⌘⌥[, ⌘⇧]/⌘⇧[, Ctrl+Tab, Ctrl+PageDown/PageUp, Ctrl+1…9, ⌘⌥A, ⌘⌥⇧A, ⌘=/⌘-/⌘0; Equalize, Set Title, Clear Pane Title and Toggle Quick Commands have no key. ⌘1…9 keep selecting tabs as in v1. Terminal-scope keys (copy, select all, paste, search, clear, pane focus, split, expand, close pane, zoom) act only while a terminal pane has focus, so ⌘C still copies in text fields. Setting "Shortcuts in Terminal": App first (default) keeps every app shortcut live in a terminal; Terminal first gives the terminal every key except terminal-scope actions. Orca's byte translations (Shift+Enter, Ctrl+Backspace, Alt+Backspace, Cmd+Backspace/Delete/Left/Right/Up/Down, Alt+Left/Right) are applied.
- **Why:** term-ui.md "Key bindings"; v1's ⌘1…9 are part of "v1 behaves as it does today"
- **Evidence:** term-ui.md lines 162-215; plugins/quirky.session/quirky-plugin.json keybindings
- **Reversibility:** medium
- **Confidence:** high
- **Source:** locked by term-ui.md

## D27: Terminal settings: the ones that change the pane on macOS, with Orca's defaults except scrollback
- **Question:** which of Orca's settings Quirky gets
- **Options:** all of them; those that change the pane on macOS
- **Chose:** Font Family (`SF Mono`), Font Size (14, 10–24), Font Weight (500) and Bold Font Weight (700), Line Height (1, 1–3), Cursor Shape (block), Blinking Cursor (on), Scrollback (kept at 2,000, 500–10,000), Word Separators, Option as Alt (auto/both/left/right/off), JIS Yen to Backslash (off), Copy on Select (off), Trim Gutter on Copy (on), Allow TUI Clipboard Writes (on), Right-click to Paste (off), Focus Follows Mouse (off), Scroll Speed and Fast Scroll Speed (1.15, 5), GPU Acceleration (auto/on/off), Minimum Contrast (1, 1–21), Inactive Pane Opacity (0.9), Divider Thickness (3, 1–32), Horizontal and Vertical Padding (4), Background Opacity (1), Terminal URL clicks and Middle click (actions, open), Confirm before closing running terminals (on), Confirm before closing pinned tabs (on), Ctrl+Tab order (mru/sequential), Shortcuts in Terminal (app-first), Enable Floating Workspace (on), Terminal Directory (`~`). All apply live to open panes.
- **Why:** term-ui.md "Settings". The scrollback default and range are locked by architecture.md ("scrollback capped at 2,000 lines (setting range 500 to 10,000)"), which beats Orca's 5,000.
- **Evidence:** term-ui.md lines 217-265; docs/architecture.md "UI"
- **Reversibility:** easy
- **Confidence:** high
- **Source:** locked by docs/architecture.md

## D28: Terminal colours come from Quirky's themes; inline images, ligatures and Ghostty import are left out
- **Question:** Orca's terminal theme catalogue, colour overrides and the image and ligature addons
- **Options:** port them; use Quirky's theme tokens
- **Chose:** the pane keeps reading its colours from the active Quirky theme (m0-ui-api). Inline images, ligatures, Ghostty import, custom terminal themes and colour overrides are non-goals.
- **Why:** Quirky's themes are the plugin API's colour mechanism; two theme systems would conflict. The image and ligature addons cost memory per pane against a 6–8 MB budget.
- **Evidence:** docs/architecture.md "Memory budget"; plugins/quirky.session/src/window/terminalTheme.ts
- **Reversibility:** easy
- **Confidence:** medium
- **Revisit if:** the parity sweep counts terminal themes as a flow
- **Source:** assumed — autonomous

## D29: Zoom is per pane and not saved
- **Question:** font zoom
- **Options:** global; per pane
- **Chose:** with a pane focused, `Mod+=`, `Mod+-`, `Mod+0` change that pane's font size by 1 px within 8–32, reset to the Font Size setting, and aren't saved. The view's report carries each visible pane's font size.
- **Why:** term-ui.md "Panes and splits" 10
- **Evidence:** term-ui.md line 89
- **Reversibility:** easy
- **Confidence:** high
- **Source:** locked by term-ui.md

## D30: Clear and Reset reach the PTY host
- **Question:** what `Mod+K` and Reset Terminal do to the host's copy
- **Options:** clear only the window; clear the host's screen and history too
- **Chose:** Clear Screen clears the pane and the host's screen and history for that session, so a reattach doesn't bring the text back. Reset Terminal resets mouse, bracketed paste, application cursor and similar modes in the pane and in the host's screen model, keeping the text.
- **Why:** term-ui.md "Panes and splits" 9 (`pty.clearBuffer` so the daemon's copy goes too)
- **Evidence:** term-ui.md line 88
- **Reversibility:** easy
- **Confidence:** high
- **Source:** locked by term-ui.md

## D31: User remapping of shortcuts is left to a later item
- **Question:** Orca's Settings → Shortcuts remapping, which the doc lists among its places
- **Options:** build user keybinding overrides in the kernel here; leave them out
- **Chose:** leave them out. Distro keybindings (m0-core) remain the way to rebind. The shortcut policy (D26) is in.
- **Why:** remapping is an app-wide settings feature covering every plugin's bindings, not a terminal-pane flow; the doc's term-ui verification never exercised it (Verified 18).
- **Evidence:** term-ui.md lines 40, 443; packages/daemon/src/plugins/distro.ts keybindings
- **Reversibility:** easy
- **Confidence:** medium
- **Revisit if:** m7-parity-sweep finds no item owns shortcut remapping
- **Source:** assumed — autonomous

## D32: The `+` menu keeps v1's rows under Orca's labels, with a search box over rows and open tabs
- **Question:** the new-tab menu's contents
- **Options:** Orca's full menu; Orca's rows that exist in Quirky
- **Chose:** a search box ("Search open tabs and agents…") filtering the rows and the workspace's open tabs, then New Terminal (⌘T), then the agent rows Quirky already lists, then Agent settings…. Browser, Markdown and Mobile Emulator rows are left out (D5).
- **Why:** term-ui.md "Where to find it"; the agent rows already exist (plugins/quirky.session/src/window/NewSessionMenu.tsx)
- **Evidence:** term-ui.md line 11
- **Reversibility:** easy
- **Confidence:** high
- **Source:** locked by term-ui.md

## D33: The CLI: one `quirky terminal` group with tab, pane, group, quick-command and floating subcommands
- **Question:** flag design and output format for the new commands
- **Options:** many top-level groups; nested words under `terminal`
- **Chose:** `quirky terminal layout [--worktree W] [--json]`, `tab new|close|rename|color|pin|unpin|move|activate|reopen|list`, `pane split|close|focus|title|expand|collapse|equalize|resize|move|clear|reset|get`, `group split|close|resize`, `quick-command list|add|update|remove|run`, `floating show|hide|toggle|maximize|restore|state|bounds`, plus `open-link`. Selectors: a tab, pane or group ID, or a session ID where a pane is meant; the default worktree is the caller's, the default pane the caller's `$QUIRKY_SESSION_ID`. Human output prints a tree (`group grp-1 ▸ tab tab-2 "Build" ● ▸ pane pane-3 [session s-…]`); `--json` prints the method result.
- **Why:** follows the m0-scripting command style (one group per plugin, words under it) and m1-term-daemon's session defaults
- **Evidence:** plugins/quirky.terminal/quirky-plugin.json cli-command entries; m0-scripting D-decisions on generated commands
- **Reversibility:** medium
- **Confidence:** medium
- **Source:** assumed — autonomous

## D34: Layout responses carry a revision; a stale revision is refused
- **Question:** versioning and error responses for layout calls
- **Options:** last write wins; an optional `revision` precondition
- **Chose:** every workspace has a `revision` that each change bumps; every mutating call returns the new workspace; a call that passes `revision` and doesn't match fails with a conflict naming the current revision. The window passes it for drag-end resizes and moves, so a drag that raced an agent's change doesn't clobber it. Unknown IDs fail with not-found naming the ID; impossible moves (the last pane out of its tab, a group divider outside 0.15–0.85, a split of a pane in another workspace) fail with invalid-params.
- **Why:** two clients (a window and an agent) change one layout; Phase B research: an untargeted tmux `resize-window` acted on the wrong window (hatter #71), so every call names its target by stable ID and a revision catches races.
- **Evidence:** docs/roadmap.md "Everything is scriptable"
- **Reversibility:** medium
- **Confidence:** medium
- **Source:** assumed — autonomous

## D35: Layout persists in the plugin store, survives window and daemon restarts, and repairs itself
- **Question:** persistence and error handling for the stored layout
- **Options:** rebuild from sessions on every start; persist the whole layout
- **Chose:** persist. On start each workspace is reconciled with the session list: panes whose session is gone are removed, sessions without a pane get a tab (D10), empty groups collapse, a missing active ID falls back to the first. A stored row that fails to parse is replaced by a layout rebuilt from the sessions, with a log line. Restarting the daemon keeps the layout and the panes cold-restore (m1-term-daemon D10).
- **Why:** term-ui.md "Verified" 20 (layout, titles, colours and the floating panel survive a relaunch); a damaged row must not leave a worktree without tabs.
- **Evidence:** term-ui.md line 445
- **Reversibility:** medium
- **Confidence:** high
- **Source:** locked by term-ui.md

## D36: The view's report is the workspace plus what only the window knows
- **Question:** what `quirky ui state` shows for the worktree view
- **Options:** keep the v1 report; the full layout plus window-only state
- **Chose:** the report keeps v1's `worktree`, `tabs` and `active` fields (tabs now carry `tab`, `pane` and `group` as well) and adds `layout` (the workspace's groups, tabs and pane trees with revision), `focusedPane`, and per visible pane `{pane, cols, rows, fontSize, search: {query, current, total} | null, exitOverlay}`. The floating overlay reports its own state the same way.
- **Why:** roadmap "agents read what the window shows as JSON"; keeping v1's fields keeps existing callers working.
- **Evidence:** plugins/quirky.session/src/window/model.ts:7-11; packages/ui/test/exit.e2e.test.ts SC-35
- **Reversibility:** medium
- **Confidence:** high
- **Source:** assumed — autonomous

## D37: Only visible panes are mounted, and only they get WebGL
- **Question:** what the window keeps for hidden tabs and how many WebGL contexts it uses
- **Options:** keep hidden panes mounted (Orca's parking); unmount them
- **Chose:** only the active tab of each visible group mounts its panes (and the floating panel's when open). Hidden tabs unmount and reattach from the host's snapshot when shown. WebGL is used for mounted panes up to 12 at once, after which further panes use the DOM renderer; a pane that loses its context three times in a minute stays on the DOM renderer. While a divider or the floating panel is dragged, panes refit locally and the PTY gets one resize at the end.
- **Why:** docs/architecture.md "Only visible views are mounted"; research: Chromium keeps about 16 WebGL contexts per page (xterm #6068, termdeck #208), and unthrottled resizes during a sash drag freeze the renderer (vscode #340786).
- **Evidence:** docs/architecture.md "UI", "Memory budget"; term-ui.md "Rendering", "Resize and fit"
- **Reversibility:** easy
- **Confidence:** high
- **Source:** locked by docs/architecture.md

## D38: The overlay slot and keybinding `when` clauses are the plugin API growth this item needs
- **Question:** what the public plugin API lacks for these flows (roadmap "If it needs something the API lacks, the API grows in the same milestone")
- **Options:** work around in the plugin; grow the API
- **Chose:** grow it with: a UI slot kind for a full-window overlay (the floating workspace); keybinding `when` expressions over context keys a plugin sets from its window code (terminal focus, floating focus), with the shortcut policy honoured by the host; a way for a view to mount another plugin's declared view into an element it owns (the structured session view inside a pane); conditional confirmation for destructive methods (D12); optional start `cwd` and the synthetic floating workspace for sessions. The tech spec settles the exact shape of each.
- **Why:** the seven UI slot kinds have no overlay (ui.ts:4), keybindings have no `when` (m0-ui-api D14 names this item as the revisit trigger), and the import fence stops one plugin's window code importing another's.
- **Evidence:** packages/protocol/src/ui.ts:4; docs/loop/decisions/m0-ui-api.md D14; plugins/test/imports.test.ts SC-24
- **Reversibility:** medium
- **Confidence:** medium
- **Source:** supersedes m0-ui-api D14

## D39: Approach: extend `quirky.terminal` with a daemon layout service and a new window module, keep `quirky.session`'s view as the fallback
- **Question:** brainstorming's 2–3 approaches
- **Options:** (1) `quirky.terminal` owns a daemon-side layout service and a new workspace view that overrides the session view (recommended); (2) grow `quirky.session`'s view in place with a window-owned layout saved through a session method; (3) a new generic `quirky.tabs` plugin for every future tab type
- **Chose:** (1)
- **Why:** (1) keeps layout in the daemon (D7) and the feature in one plugin (D6) without touching the files lanes 2 and 3 are changing in `quirky.session`. (2) keeps layout in the window, against the roadmap. (3) builds a tab-type registry for editor and browser tabs no item needs yet; when m2-editor lands it can add a tab content kind to (1).
- **Evidence:** D6, D7; docs/loop/queue.json (lanes 2 and 3 hold m1-agent-status and m1-worktrees)
- **Reversibility:** medium
- **Confidence:** medium
- **Source:** assumed — autonomous

## D40: Design sections self-reviewed and accepted without a pause
- **Question:** brainstorming's "present design section, get approval" steps and the essential-coverage check
- **Options:** wait for a person; self-review and go on
- **Chose:** self-review each section (model, data flow, scenarios, scope, glossary) against the feature doc and locked decisions, and continue. The six essentials (purpose, consumer, success criteria, scope, constraints, failure behaviour) are covered by D5–D37.
- **Why:** LOOP.md "Don't wait after presenting a design section. Self-review it, record it, and go on." and the fast-track for stated defaults.
- **Evidence:** docs/loop/LOOP.md "Answering a skill's questions"
- **Reversibility:** easy
- **Confidence:** high
- **Source:** locked by docs/loop/LOOP.md

## D41: The Orca defects this item tests against
- **Question:** which Orca defects the doc records, each needing a test that Quirky doesn't have it
- **Options:** —
- **Chose:** (a) on macOS `exit 3` closed the pane with no "Terminal exited" overlay because the exit code was recorded as 0; (b) an unproductive `Cmd+Shift+T` after a shell exit showed only "Terminal shortcut handled", a toast that doesn't say why nothing happened; (c) `Cmd+G` and Enter sent with focus in the search box didn't move the counter (recorded as unverified; tested anyway); (d) a pane's PTY binding was saved by the renderer's debounce, so a crash right after a split could orphan the pane's session (Orca fixed this by persisting in main; the test checks a split survives an immediate window kill).
- **Why:** LOOP.md step 4 "Defects"
- **Evidence:** term-ui.md lines 57-59, 107, 298, 437
- **Reversibility:** easy
- **Confidence:** high
- **Source:** locked by docs/loop/LOOP.md

## D42: Platform work deferred
- **Question:** places that will need Linux or Windows work
- **Options:** —
- **Chose:** Ctrl-based bindings for Linux and Windows (Orca's second column), the Windows shell settings, Right-click to Paste's Windows default, "Reveal in Finder" (`open -R`), opening URLs and files (`open`), and the GPU auto-policy's Linux denials are macOS-only here.
- **Why:** LOOP.md "Platforms: build and test on macOS only ... Log every place that will need Linux or Windows work"
- **Evidence:** term-ui.md "Key bindings" table, "Rendering"
- **Reversibility:** easy
- **Confidence:** high
- **Source:** deferred: platform

## D43: Spec review: accept 17 of 18 findings and fix them in the specs
- **Question:** the one `quirk:adversarial-review` pass over both specs (LOOP.md step 4), run with Codex as reviewer at deep depth
- **Options:** accept and fix; dismiss with a recorded reason
- **Chose:** fixed: F1 the view's `session` input focuses its pane (SC-76); F2 one serial queue for every layout change, so a session created inside `newTab`/`splitPane` is bound before its `changed` event is reconciled; F3/F6 a binding whose `when` matches beats one with none, and the model lists bindings in registry precedence; `mod+w` gets a terminal-scope `close-pane` binding beside the session's; F5 a bound chord yielded under Terminal first still has its webview default prevented; F7 SC-70 tests the override chain, D6 states the registry limit; F8 panes render in one flat layer keyed by pane ID and are positioned from the tree, so no reshape remounts an xterm; F9 the host's `clear` writes the cleared screen to every subscriber in order; F10 the daemon accepts any ratio strictly between 0 and 1 and the window enforces the pixel minimum; F11 closeGroup's destination is the sibling side's first group; F12 Restart only for ended panes; F13 an overlay's `shown` comes from its report; F14 every (UI) scenario also has its CLI/API path, with window commands for copy, paste, select all and menus; F15 agent scenarios use fake agent CLIs; F16 `group resize` takes a group and sets its share; F17 WebGL contexts are released with `WEBGL_lose_context` before the counter drops; F18 a split tab's live title is its active pane's. Dismissed: F4 (refuted by the reviewer's own second stage; the search box handles Enter and ⌘G itself, which the tech spec now says).
- **Why:** each accepted finding names a contract an implementer couldn't build without asking or a scenario that couldn't pass as written. The tiebreak stage failed to return a judgment for F15, so the run's gate didn't complete; the contested findings (F2, F6, F15, F17) were judged here against the code.
- **Evidence:** scratchpad sr1/merged.json; packages/daemon/src/plugins/registry.ts:185 (`applyDisabledIds`); packages/ui/src/plugins/host.ts:246
- **Reversibility:** easy
- **Confidence:** high
- **Source:** assumed — autonomous

## Progress
Brainstorming done (D1–D42). Next: write docs/quirk/specs/2026-10-26-m1-term-ui/logic.md.
