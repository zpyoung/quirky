# m1-notifications decisions

## D1: Classify the item as Visual, API, CLI and Integration work, and run research phases A and B
- **Question:** brainstorming's domain detection and research swarm (brainstorming, checklist 2 and 7)
- **Options:** one domain with a small swarm; every domain the item touches, with phases A and B; phases A, B and C
- **Chose:** Visual (markers, settings page), API and CLI (methods, events, the command group) and Integration (terminal sequences, the OS shell). Phase A ran two web agents (patterns, pitfalls) and three code-mapping agents; phase B ran one agent per approach. Phase C was skipped.
- **Why:** the feature spans the PTY host, four plugins, the window and the shell. Phase C is for a novel approach; the chosen one (D40) reuses patterns earlier items already proved (a plugin that listens to other plugins' events and writes through their methods, m1-agent-status D3).
- **Evidence:** research results recorded in the logic spec's Industry Insights
- **Reversibility:** easy
- **Confidence:** high
- **Source:** assumed — autonomous

## D2: Skip the visual companion and the adhd offer; use the standard gray-area set
- **Question:** brainstorming's companion and adhd offers
- **Options:** offer them; skip them
- **Chose:** skip both
- **Why:** LOOP.md "Answering a skill's questions" says to skip both in a headless run
- **Evidence:** docs/loop/LOOP.md
- **Reversibility:** easy
- **Confidence:** high
- **Source:** locked by docs/loop/LOOP.md

## D3: Select every gray area that matters
- **Question:** which gray areas to resolve (brainstorming, gray areas step 1)
- **Options:** the three or four most relevant; every one that changes what a person, script or agent sees
- **Chose:** scope; the unread model and what "viewed" means; delivery gates, cooldown and focus suppression; banner text; sounds; tray and dock; terminal sequences (BEL, OSC 9, 99, 777); the settings surface; the scripting surface; error and empty states. Each is settled by the decisions below.
- **Why:** LOOP.md asks for every area that matters when no human is present
- **Evidence:** docs/loop/LOOP.md "Gray areas"
- **Reversibility:** easy
- **Confidence:** high
- **Source:** locked by docs/loop/LOOP.md

## D4: In scope are the roadmap's five bullets, the OSC sequences, flows 1 to 5 of the doc and the dock badge; phone, machines, hidden-workspace mutes, the permission card and Windows are out
- **Question:** which of notifications.md's flows and controls this item owns
- **Options:** only the five title bullets; every flow and control in the doc; the bullets, the OSC sequences the roadmap adds, and every flow that works on one Mac without a phone, SSH host or sidebar filter
- **Chose:** the third. In: unread markers on sessions and worktrees with auto-read and Mark Read/Unread, the 5 s cooldown, banner text, sounds (built-in, custom file, volume, preview), the tray dot and menu, Show Menu Bar Icon, the dock badge, Settings > Notifications with Send Test Notification (flow 1), the agent-finished banner (flow 2), clear unread (flow 3), mark unread (flow 4), the tray menu (flow 5), BEL and OSC 9/99/777 notifications. Out, as non-goals: phone fan-out and paired devices, the Machines mutes (no remote hosts yet), Notify About Hidden Workspaces (Quirky has no sidebar Filters menu yet; m2-sidebar-extras and m4-sidebar-review-filters bring it), the macOS permission card, probe and startup registration (D23), onboarding's notification step (no onboarding exists), Minimize to Tray on Close (Windows only), the 3-minute pending-ask escalation (m2-ask-parity D2), the floating terminal's badge count (m1-term-ui builds the floating workspace), pane-level markers and `experimentalTerminalAttention`, dismissing banners on read (D27) and clicking a banner to focus the pane (D26).
- **Why:** roadmap M1 "Notifications" names the five bullets and the three OSC sequences; LOOP.md says a slice item names the doc's other flows as non-goals. Each excluded control depends on a feature Quirky doesn't have yet or on a native API Electrobun lacks.
- **Evidence:** docs/roadmap.md M1; notifications.md "What the user can do", "Dependencies on other features"; docs/loop/queue.json
- **Reversibility:** easy
- **Confidence:** medium
- **Revisit if:** the M1 exit test needs a hidden-workspace mute or a clickable banner
- **Source:** assumed — autonomous

## D5: A new built-in plugin, `quirky.notifications`, owns the policy; other plugins only report events
- **Question:** where the decision "does this event deserve attention, and is it delivered" lives (brainstorming, conceptual model)
- **Options:** keep each producer calling `context.notify` and add gates in each; a new plugin that producers call through a `dispatch` method; a new plugin that listens to the producers' events and is the only caller of `context.notify`
- **Chose:** the third. `quirky.agent-status`, `quirky.structured`, `quirky.ask` and `quirky.terminal` stop calling `context.notify` and emit events; `quirky.notifications` subscribes, writes the unread markers, applies the gates and calls `context.notify` once per delivered banner. Turning the plugin off (a distro, or `--disable-plugins`) turns notifications off.
- **Why:** one policy for every source fixes Orca's defect where loops and watchers bypassed the delivery service (D37). Producers that call a method would need a fallback when the plugin is off, written three times, since plugins share no code. Events also keep the producers free of a dependency on notifications. roadmap "Features are plugins".
- **Evidence:** notifications.md "Events that notify" (other callers bypass the service); plugins/quirky.agent-status/src/service.ts:465-483; plugins/quirky.structured/main.ts:62-78; plugins/quirky.ask/main.ts:26-32
- **Reversibility:** medium
- **Confidence:** high
- **Source:** supersedes m0-core D12

## D6: Producers emit settled and notification events; boundaries and replays still emit nothing
- **Question:** what each producer reports
- **Options:** let notifications infer transitions from `quirky.session/changed`; explicit events from each producer
- **Chose:** `quirky.agent-status/settled` when a row settles (done, waiting or blocked) from a live event, with the agent, state, outcome, prompt, tool, tool input and last message; `quirky.structured/settled` the same for structured sessions; `quirky.terminal/notification` for an OSC notification next to the existing `quirky.terminal/bell`; `quirky.ask/created` and `quirky.ask/surfaced` as they are. Boundary rows and spool replays emit no `settled`.
- **Why:** the session summary lacks the last message and tool the banner needs (notifications.md "Banner text"); the producer is the one place that knows a transition was live. m1-agent-status D27 still holds.
- **Evidence:** plugins/quirky.agent-status/src/apply.ts:262-264; packages/protocol/src/model.ts:177-188; docs/loop/decisions/m1-agent-status.md D27
- **Reversibility:** medium
- **Confidence:** high
- **Source:** assumed — autonomous

## D7: The old "Notify when agents finish" switch becomes Agent Task Complete, and its value carries over
- **Question:** what happens to `setting:quirky.agent-status/notifications`
- **Options:** keep it beside the new settings; remove it and lose the stored value; remove it and carry an off value into the new switch
- **Chose:** the third: agent-status drops the setting, and a stored `false` there (or v1's `notifications: false`) turns Agent Task Complete off the first time the notifications plugin starts. `quirky.structured` reads the new switch.
- **Why:** two switches for one thing confuse; a user who turned notifications off must not get them back after an upgrade
- **Evidence:** docs/loop/decisions/m0-core.md D13; packages/daemon/src/v1-settings.ts:28-31; plugins/quirky.structured/main.ts:23
- **Reversibility:** medium
- **Confidence:** high
- **Source:** supersedes m0-core D13

## D8: Orca's notification settings, labels and defaults, plus Terminal Notifications and Show Menu Bar Icon
- **Question:** the settings and their defaults (gray area "settings surface")
- **Options:** Orca's set; Orca's set plus a switch for OSC notifications
- **Chose:** Enable Notifications (on), Agent Task Complete (on, described "A coding agent finishes or needs input."), Terminal Bell (off), Terminal Notifications (on, "A terminal program sends a notification (OSC 9, 99 or 777)."), Notification Sound (System Default; Two Tone, Bong, Thump, Blip, Sonar, Blop, Ding, Clack, Beep, or a custom file), custom file path (none), volume (100, 0 to 100 in steps of 5), Suppress While Focused (on), and Show Menu Bar Icon (on). Orca's other descriptions are kept word for word, with "Quirky" for "Orca".
- **Why:** the doc's table is the requirement. Orca's Agent Task Complete also covers "needs input" while its description says only "finishes", which the doc calls out; the description now says both. The roadmap adds OSC notifications, and cmux shows them by default; they need their own switch since a program's notifications are neither a bell nor an agent.
- **Evidence:** notifications.md "Notification settings", "Events that notify"; research: https://cmux.com/docs/notifications
- **Reversibility:** easy
- **Confidence:** high
- **Source:** locked by research/orca-features/notifications.md

## D9: Unread is a marker on the session and on its worktree, written before delivery and whatever the switches say
- **Question:** the unread model (gray area "unread")
- **Options:** worktree only; worktree plus session (tab); worktree, tab and pane
- **Chose:** worktree plus session. An agent completion, needs-input, bell or program notification on a session the person isn't viewing marks the session (reason agent, bell or notification, the latest wins) and, unless the worktree is being viewed, the worktree. Marks are written before any gate, so a disabled, suppressed or throttled banner still leaves them. Asks and the test button mark nothing. Mark Unread on a worktree marks only the worktree.
- **Why:** notifications.md "unread is state, not a side effect of the banner". A Quirky session is one terminal, Orca's tab. Pane markers need splits (m1-term-ui) and sit behind an experimental setting in Orca. Asks have no attention markers (m2-ask-parity D2).
- **Evidence:** notifications.md "Unread state", "What a BEL does"; docs/loop/decisions/m2-ask-parity.md D2
- **Reversibility:** medium
- **Confidence:** medium
- **Revisit if:** m1-term-ui's tabs hold several sessions and a per-tab marker reads better than per-session
- **Source:** locked by research/orca-features/notifications.md

## D10: Viewing means a focused window whose person is present and whose view shows the session
- **Question:** when a session or worktree counts as viewed, and when markers clear
- **Options:** the window is focused; the window is focused and shows it; Orca's rule with presence
- **Chose:** Orca's rule. A session is viewed when a window is focused, the person used the mouse or keyboard in it within the last 180 seconds, and its worktree view shows that session. A worktree is viewed under the same conditions when its view is open. When a session becomes viewed its marker clears, and the worktree's marker clears too. Marks on the worktree's other sessions stay until each is viewed. Mark Read on the worktree, and opening it from its sidebar card (which m1-worktrees already makes clear the worktree's mark), clear it and all its sessions, as Orca's pass saw ("Opening the workspace cleared all of that at once"). Presence never seen counts as away, so it never clears a marker.
- **Why:** notifications.md flow 3 and "What an agent-completion event does" point 5; "Unknown presence never clears unread". Phase B research (local-operator #2939) warns against inferring reads from a focused window alone.
- **Evidence:** notifications.md lines 62, 128, 264; research: https://github.com/damianvtran/local-operator/pull/2939
- **Reversibility:** medium
- **Confidence:** medium
- **Source:** locked by research/orca-features/notifications.md

## D11: The window reports input activity, and focus and presence changes reach plugins as an event
- **Question:** plugin API growth for D10 (roadmap "If it needs something the API lacks, the API grows")
- **Options:** the notifications plugin's window module listens for input; the kernel window host reports activity next to focus, and the kernel broadcasts window changes
- **Chose:** the kernel. The window already reports focus with `ui.window.focused`; it also reports input activity, throttled, and `ui.state` gives each window's last input time. A window focus or presence change broadcasts a kernel event so a plugin can re-check what is viewed. The tech spec fixes the method and event names.
- **Why:** focus is already the kernel's (packages/ui/src/shell.ts:8-22, packages/daemon/src/plugins/layout.ts:165-173), presence belongs with it, and today a focus change broadcasts nothing, so nothing could clear a marker when the person comes back
- **Evidence:** packages/daemon/src/plugins/layout.ts:165-173, 289
- **Reversibility:** medium
- **Confidence:** high
- **Source:** assumed — autonomous

## D12: The worktree view reports which sessions it shows; until it does, the active session counts
- **Question:** how the notifications plugin learns what a person can see, given m1-term-ui is replacing the worktree view with pane trees and a floating workspace
- **Options:** read `layout.view.input.session`; a `visibleSessions` list in the view's report, falling back to the layout input
- **Chose:** the second. quirky.session's view adds `visibleSessions` (its one active tab). When m1-term-ui lands, its view reports every pane of every visible tab and the open floating panel the same way; this item's catch-up merge adds it if m1-term-ui hasn't.
- **Why:** a split shows several sessions at once, and only the view knows which; the report is how the window tells the daemon what it shows (m1-term-ui D36)
- **Evidence:** plugins/quirky.session/src/window/model.ts:95-114; build/m1-term-ui docs/loop/decisions/m1-term-ui.md D7, D25, D36
- **Reversibility:** easy
- **Confidence:** medium
- **Source:** assumed — autonomous

## D13: Gates run in Orca's order and the result says which one stopped the banner
- **Question:** the delivery decision (gray area "delivery")
- **Options:** Orca's order with its reasons; a simpler on/off
- **Chose:** unread first, tray attention next, then: Enable Notifications off is `disabled`; the source's switch off is `source-disabled`; Suppress While Focused with the source's worktree open in the focused window is `suppressed-focus`; within the cooldown is `cooldown`; otherwise `delivered`. Orca's `host-muted`, `not-supported`, `not-displayed` and `blocked-by-system` have no producer in Quirky (D4, D23) and are left out.
- **Why:** notifications.md "Main: notifications:dispatch delivery order". Every reason is visible to scripts through `send` and `test` (D34).
- **Evidence:** notifications.md lines 141-155
- **Reversibility:** easy
- **Confidence:** high
- **Source:** locked by research/orca-features/notifications.md

## D14: The cooldown is 5 seconds per worktree, shared by every source, 50 keys, test exempt
- **Question:** cooldown key, window and scope
- **Options:** per session and source (herdr's `(pane, status)`); Orca's per workspace
- **Chose:** Orca's: key is the worktree (or `global` when an event has none), 5000 ms, at most 50 keys with the oldest dropped, in memory; the test notification skips it; only banners and their sounds are throttled, never markers.
- **Why:** the doc fixes it; the roadmap says OSC notifications follow the same cooldown as hook ones. Research (cmux #17333) shows the harm of throttling before state is recorded, which writing markers first avoids.
- **Evidence:** notifications.md line 151, "Burst dedupe"; research: https://github.com/manaflow-ai/cmux/issues/17333
- **Reversibility:** easy
- **Confidence:** high
- **Source:** locked by research/orca-features/notifications.md

## D15: Suppress While Focused looks at the worktree and window focus, not presence
- **Question:** what "already visible" means for the banner gate
- **Options:** the session is viewed (D10); the worktree is the open view and a window is focused
- **Chose:** the second, as Orca's `isActiveWorktree && window.isFocused()` does
- **Why:** the doc's gate; a person who stepped away from a focused window still gets the marker (D10) but no banner, which matches Orca
- **Evidence:** notifications.md line 150
- **Reversibility:** easy
- **Confidence:** high
- **Source:** locked by research/orca-features/notifications.md

## D16: Banner text follows Orca's builder, with Quirky's names
- **Question:** banner title and body (gray area "banner text")
- **Options:** keep v1's `<worktree>` / `<session> finished`; Orca's builder
- **Chose:** Orca's. Agent: title `<repo> / <worktree> - <Agent> <status>`, context cut to 80 characters and the agent name to 40; body the last assistant message (180 characters), else `Using <tool>: <input>`, `Using <tool>`, `Tool input: <input>`, else `<Agent> <status>.`. Bell: `Bell in <worktree>` / `<repo> · Attention requested`. Test: `Quirky notifications are on` / `This is a test notification from Quirky.`. Whitespace collapses; cuts end with an ellipsis and never split a surrogate pair. A folder workspace (no repo) uses `<worktree>` alone as context. The agent name is the agents catalog's display name. Asks keep their current text (D33).
- **Why:** the doc's "Banner text" is the requirement
- **Evidence:** notifications.md lines 174-185
- **Reversibility:** easy
- **Confidence:** high
- **Source:** locked by research/orca-features/notifications.md

## D17: Status words: needs input, failed, stopped, finished
- **Question:** mapping Quirky's row state and outcome to the banner's status word
- **Options:** Orca's mapping applied to Quirky's outcomes
- **Chose:** waiting or blocked is "needs input"; done with outcome failure is "failed"; done with outcome cancellation, or interrupted, is "stopped"; done with success or no outcome is "finished". A row that is still working never produces a banner at all.
- **Why:** Quirky's outcomes are `success | cancellation | failure` plus an `interrupted` flag set by Esc and Ctrl+C inference (m1-agent-status D18), which is the user stopping the turn, Orca's "stopped" family
- **Evidence:** notifications.md line 182; plugins/quirky.agent-status/src/types.ts:34-74
- **Reversibility:** easy
- **Confidence:** medium
- **Revisit if:** Orca's `interruption` turns out to mean the user stopped it rather than a crash
- **Source:** assumed — autonomous

## D18: A notify event, and so a toast, goes out only for a delivered banner
- **Question:** the webview turns every `notify` event into a toast; what happens to toasts under the new gates
- **Options:** toast every event; toast only delivered ones
- **Chose:** only delivered ones. `context.notify` is called once per delivered banner, and the webview's toast and the shell's banner both come from it.
- **Why:** a suppressed-focus event is one the person is already looking at, and a throttled one is a duplicate; the marker carries the rest. Enable Notifications off silences toasts too, which is what a person who turned notifications off expects.
- **Evidence:** packages/ui/src/lib/state.ts:54-61; packages/daemon/src/notify.ts:38-55
- **Reversibility:** easy
- **Confidence:** medium
- **Source:** assumed — autonomous

## D19: Built-in sounds are short tones generated in the repo, played by afplay after delivery
- **Question:** where the nine built-in sounds come from and what plays them
- **Options:** copy Orca's mp3 files; map the names to macOS system sounds; synthesize each name as a short WAV checked into the repo; play in the webview with an audio element; play in the shell with afplay
- **Chose:** nine WAV files generated by a script in the repo (each a distinct tone shape matching its name), played with `afplay -v` by the desktop shell when it shows a banner, or by `quirkyd` itself when no desktop client is connected. System Default plays the OS banner's own sound and no file. A sound plays only with a delivered banner.
- **Why:** Orca's sound files have no licence I can check, and system sounds don't have these names. The webview isn't loaded while the window is closed, and the shell already owns banners. afplay sounds bypass Focus mode, the same as Orca's renderer audio (research: harness #518). notifications.md: "sound is tied to the banner decision, not to the event".
- **Evidence:** notifications.md "Sounds"; research: https://github.com/justrach/harness/issues/518, https://github.com/NousResearch/hermes-agent/issues/52652 (spawn without waiting)
- **Reversibility:** easy
- **Confidence:** medium
- **Source:** assumed — autonomous

## D20: A custom sound is a typed path, checked by the daemon; the Custom line shows only while it is selected
- **Question:** how "Choose Custom File" works in a webview with no file path access
- **Options:** a native open panel from the shell; a path field the daemon validates
- **Chose:** the path field. Choose Custom File reveals a path input; the daemon accepts an absolute path to an existing `.ogg .mp3 .wav .m4a .aac .flac` file of at most 10 MiB and refuses anything else with a reason. `Custom: <path>` shows under the select only while the custom sound is selected.
- **Why:** the web UI pass can drive a field but not a native panel, and the shell has no channel to the settings page. Orca leaves the Custom line on screen after switching back to a built-in sound (notifications.md "Verified in the app" 2), which this fixes.
- **Evidence:** notifications.md line 42, 284
- **Reversibility:** easy
- **Confidence:** medium
- **Revisit if:** a native picker becomes reachable from the window
- **Source:** assumed — autonomous

## D21: Settings > Notifications is a view of the notifications plugin; the generic Settings dialog shows the same settings
- **Question:** where the settings page lives, given the generic dialog can't hide the slider, preview a sound or run a test
- **Options:** declared settings only; a view contribution like m1-providers' Agents view
- **Chose:** a `view:quirky.notifications/settings` view titled "Notifications", opened by the palette command "Open notification settings" and the tray's Settings item, with Orca's subtitle, order, dimming and Send Test Notification button. The settings are also declared, so `quirky setting` and the generic dialog read and write the same values.
- **Why:** the doc's page needs conditional controls and a button (notifications.md "Notification settings"); m1-providers set the precedent
- **Evidence:** docs/loop/decisions/m1-providers.md (the Agents view); packages/ui/src/components/SettingsDialog.tsx:66-139
- **Reversibility:** easy
- **Confidence:** high
- **Source:** assumed — autonomous

## D22: Send Test Notification always answers with a toast
- **Question:** the test flow's feedback
- **Options:** Orca's toasts, which in the app gave no feedback when blocked; a toast for every result
- **Chose:** delivered toasts "Test notification requested" with "If no macOS banner appeared, turn on Allow notifications for Quirky in System Settings."; disabled toasts "Notifications are disabled"; any other result toasts "Test notification was not delivered". The banner reads as D16.
- **Why:** notifications.md flow 1; the doc's pass got no toast at all when macOS blocked the app, an Orca defect (D37). Quirky has no permission helper (D23), so a delivered request is all it can confirm.
- **Evidence:** notifications.md lines 54-60, 294
- **Reversibility:** easy
- **Confidence:** high
- **Source:** locked by research/orca-features/notifications.md

## D23: No permission card, probe or startup registration
- **Question:** macOS permission handling
- **Options:** port Orca's Swift helper and card; leave it out
- **Chose:** leave it out, as a non-goal
- **Why:** it needs a signed native helper and the system notification center, and Electrobun 2.0.4's `showNotification` reports nothing back. The test toast's hint covers the blocked case.
- **Evidence:** notifications.md "macOS permission handling"; Electrobun 2.0.4 core/Utils.ts showNotification
- **Reversibility:** easy
- **Confidence:** medium
- **Revisit if:** users miss banners because macOS blocks Quirky silently
- **Source:** deferred: platform

## D24: The tray shows an amber dot while the window is hidden and something wants attention; its menu gains Settings
- **Question:** tray behaviour (gray area "tray and dock")
- **Options:** Orca's dot and menu; v1's text tray unchanged
- **Chose:** an agent completion, bell or program notification arriving while the window is hidden, minimized or closed lights an amber dot on the menu bar icon, whatever the switches say; asks and tests don't. Showing or focusing the window clears it. The menu is Show Quirky, separator, Settings…, separator, Quit Quirky; Settings… shows the window and opens the Notifications view. Check for Updates is left out (no updater). Show Menu Bar Icon off removes the tray item; on brings it back. Windows behaviour is deferred.
- **Why:** notifications.md "Tray menu", "Tray attention dot". The tray needs an image for the dot; a coloured dot needs a non-template image (research: TeamCraft #632).
- **Evidence:** notifications.md lines 66-81, 207-215; apps/desktop/src/bun/index.ts:76-89; research: https://github.com/Zeitgleich/TeamCraft/issues/632
- **Reversibility:** easy
- **Confidence:** medium
- **Source:** locked by research/orca-features/notifications.md

## D25: The dock badge counts unread worktrees plus pending asks, and the daemon computes it
- **Question:** what the dock badge counts
- **Options:** v1's waiting sessions plus pending asks; Orca's unread workspaces; unread worktrees plus pending asks
- **Chose:** unread worktrees plus pending asks, empty at 0, the number up to 99, `99+` above. `quirky notifications status` returns it, and the shell shows what the daemon says. Quitting the app clears it.
- **Why:** Orca counts unread workspaces, and m2-ask-parity D16 keeps every pending ask in the badge. A waiting session in a worktree the person isn't viewing now marks it unread, so v1's count is covered. Computing it in the daemon makes it scriptable and gives one source of truth (Phase B research).
- **Evidence:** notifications.md "Badge count rules"; docs/loop/decisions/m2-ask-parity.md D16; apps/desktop/src/bun/events.ts:15-17
- **Reversibility:** easy
- **Confidence:** medium
- **Source:** supersedes m2-ask-parity D16

## D26: Clicking a banner only brings Quirky forward; the toast still opens the session
- **Question:** banner click (notifications.md flow 2)
- **Options:** native click routing; leave it to the OS
- **Chose:** leave it. Electrobun 2.0.4's `showNotification` has no click callback, so a click activates the app; the in-app toast's click opens the session as today.
- **Why:** no API to bind; writing a notification center delegate through FFI is a native project of its own
- **Evidence:** ~/.hutch/releases/electrobun/2.0.4 core/Utils.ts showNotification
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** Electrobun adds notification click events
- **Source:** deferred: platform

## D27: Reading a marker doesn't remove the OS banner
- **Question:** Orca's dismiss-on-read
- **Options:** remove banners on read; leave them
- **Chose:** leave them, as a non-goal
- **Why:** Electrobun returns no handle and has no remove call
- **Evidence:** notifications.md "Dismiss and announced registry"
- **Reversibility:** easy
- **Confidence:** high
- **Source:** deferred: platform

## D28: The PTY host recognises OSC 9, OSC 99 and OSC 777 notifications
- **Question:** parsing the three sequences (gray area "terminal sequences")
- **Options:** parse in the window; parse in the PTY host's scanner, as OSC 7501 is (m1-agent-status D22)
- **Chose:** the scanner, as a new `notification` fact. OSC 9 with text is a notification unless it parses as a ConEmu subcommand (a number, alone or followed by `;`), which is ignored. OSC 777 `notify;<title>;<body>` is a notification, with the body taking the rest; other 777 payloads are ignored and Quirky's own `quirky-shell-ready` marker is unchanged. OSC 99 handles kitty's `p=title` and `p=body` (default title), `e=1` base64, `d=0` chunks joined by `i`, and the `o` occasion; other payload types (close, icon, alive, buttons, the `?` query) are ignored and nothing is sent back. Text loses control characters and escape bytes, collapses whitespace and is cut to 256 characters per field. The bytes still pass through to the terminal and history.
- **Why:** hidden panes are unmounted, so only the host sees every byte (m1-term-daemon D16). Research: Ghostty and Corta disambiguate OSC 9 from ConEmu's 9;4 progress; kitty's spec defines the keys; OSC 777 has no escaping; residual ESC bytes must go.
- **Evidence:** packages/pty-host/src/scanner.ts:193-229; research: https://ghostty.org/docs/vt/osc/conemu, https://sw.kovidgoyal.net/kitty/desktop-notifications/, https://github.com/noah-qin/Corta/issues/409, https://github.com/ikaruscareer/SafeAI/pull/203
- **Reversibility:** medium
- **Confidence:** high
- **Source:** assumed — autonomous

## D29: A program's banner is titled with its worktree, so it can't pose as Quirky
- **Question:** banner text for OSC notifications
- **Options:** the program's title as is; prefixed with the worktree
- **Chose:** title `<worktree>: <title>`, or `Notification in <worktree>` when the program gave none; body the program's body, empty when it sent none. An OSC 99 `o=unfocused` notification is dropped while a window is focused, and `o=invisible` while its session is viewed.
- **Why:** research (Corta #409) shows program notices under the terminal's own title, never as a system-looking alert; kitty defines the occasion key
- **Evidence:** research: https://github.com/noah-qin/Corta/issues/409, https://sw.kovidgoyal.net/kitty/desktop-notifications/
- **Reversibility:** easy
- **Confidence:** medium
- **Source:** assumed — autonomous

## D30: A bell marks unread at once; its banner waits 250 ms and yields to a completion
- **Question:** BEL behaviour
- **Options:** Orca's
- **Chose:** Orca's: a BEL on a session the person isn't viewing marks it unread at once, whatever Terminal Bell says. Its banner is held 250 ms and dropped if a completion for the same session is announced in that time; the cooldown is the last guard.
- **Why:** notifications.md "What a BEL does"
- **Evidence:** notifications.md lines 131-139
- **Reversibility:** easy
- **Confidence:** high
- **Source:** locked by research/orca-features/notifications.md

## D31: Every live settle notifies, including those from titles and OSC 7501, and a working agent is never announced
- **Question:** which agent transitions raise attention
- **Options:** hook transitions only (today); every live transition to done, waiting or blocked that agent-status commits
- **Chose:** every live transition. agent-status already ignores a title or OSC 7501 report while a fresh hook row exists, so a title-driven done can't race a hook. A row whose own state is done while children or background work keep it working stays working, and announces nothing until it is done.
- **Why:** notifications.md lists title-idle detection among the sources of `agent-task-complete`; the doc records the "still-working agent announced as finished" bug (#4375) as fixed in Orca, so Quirky tests for it (D37)
- **Evidence:** notifications.md lines 109, 182; plugins/quirky.agent-status/src/service.ts:289-307
- **Reversibility:** easy
- **Confidence:** medium
- **Source:** locked by research/orca-features/notifications.md

## D32: Structured sessions notify through the same policy
- **Question:** quirky.structured's done and waiting notifications
- **Options:** leave them calling `context.notify`; route them through the notifications plugin
- **Chose:** route them: `quirky.structured/settled` with the agent, state and last message, which the plugin treats as Agent Task Complete with the same markers and banner text
- **Why:** one policy for every source (D5); Orca's structured lane shares the policy and delivery tail
- **Evidence:** notifications.md line 98; plugins/quirky.structured/main.ts:62-78
- **Reversibility:** easy
- **Confidence:** high
- **Source:** locked by research/orca-features/notifications.md

## D33: Asks keep their text and go through Enable Notifications, Suppress While Focused and the cooldown
- **Question:** the ask notification under the new policy
- **Options:** leave asks bypassing everything; Orca's `pending-ask` rules
- **Chose:** Orca's rules: only Enable Notifications of the switches applies, then focus suppression and the shared cooldown; no marker and no tray dot. The title stays `ask.spec.title` or "Question" and the body the first question, as m2-ask-parity built.
- **Why:** notifications.md "Events that notify" (pending-ask ignores the per-source switches; shared cooldown). The 3-minute escalation stays out (m2-ask-parity D2); the text is m2-ask-parity's.
- **Evidence:** notifications.md line 111; plugins/quirky.ask/main.ts:26-32
- **Reversibility:** easy
- **Confidence:** medium
- **Source:** locked by research/orca-features/notifications.md

## D34: The CLI group is `quirky notifications` with status, send, test and preview
- **Question:** the scripting surface (roadmap "Every built-in plugin exposes its own namespaced API methods and CLI command group")
- **Options:** status only; status plus a way to raise and test notifications and preview sounds
- **Chose:** `status` (badge, unread worktrees, unread sessions with reasons, pending asks), `send --title --body [--session|--worktree]` (raises a program notification through the same policy, like `cmux notify`, and prints the result reason), `test` (the settings button) and `preview [--sound] [--path] [--volume]` (plays a sound, or says why a custom file can't play). Settings go through `quirky setting`; worktree read and unread stay on `quirky wt set --read|--unread`. The settings view's actions all map to these.
- **Why:** every UI command needs an API equivalent (roadmap "When a milestone is done"); agents need to read what the dock shows
- **Evidence:** docs/roadmap.md "Everything is scriptable"; plugins/quirky.worktree/cli.ts:76-97
- **Reversibility:** easy
- **Confidence:** high
- **Source:** locked by docs/roadmap.md

## D35: The session record carries its unread reason; the worktree keeps its `unread` flag
- **Question:** where markers are stored
- **Options:** the notifications plugin's own store; the session and worktree records, written through their plugins' methods
- **Chose:** the records. quirky.session gains `unread` (agent, bell, notification or none) and a method to set it; the worktree keeps `unread`. The notifications plugin is the only automatic writer; each record's plugin draws its own marker.
- **Why:** m1-agent-status D3's pattern (a summary on the session through a public method); the tab and card are drawn by the plugins that own them, and `quirky session` and `quirky wt` already show their records
- **Evidence:** docs/loop/decisions/m1-agent-status.md D3; plugins/quirky.worktree/src/daemon/set.ts:50
- **Reversibility:** medium
- **Confidence:** medium
- **Source:** assumed — autonomous

## D36: Markers look like Orca's: an amber bell on the tab and in place of the card's dot, and a bold name
- **Question:** the visible markers
- **Options:** keep m1-worktrees' small accent dot; Orca's bell
- **Chose:** Orca's. The session tab's leading glyph becomes a filled amber bell labelled "Unread agent completion", "Unread bell" or "Unread notification"; the worktree card's status dot becomes the same bell labelled "Unread" and its name turns bold. The accent dot goes.
- **Why:** notifications.md "Unread state" and "What a BEL does"; the doc's screenshots show it. Orca names only the agent label; the other two follow it.
- **Evidence:** notifications.md lines 133, 198; plugins/quirky.worktree/src/Tree.tsx:53-59
- **Reversibility:** easy
- **Confidence:** medium
- **Source:** locked by research/orca-features/notifications.md

## D37: The Orca defects this item tests against
- **Question:** which Orca defects the doc records (LOOP.md step 4 "Defects")
- **Options:** the doc's recorded defects
- **Chose:** (1) side channels that bypass the gates (Orca's loops and watchers ignore focus, cooldown and switches): every Quirky source goes through one policy; (2) the test button gave no feedback while macOS blocked banners: every result toasts; (3) the Custom path line stays after switching back to a built-in sound; (4) a still-working agent announced as finished (#4375); (5) re-enabling Agent Task Complete reports work done while it was off.
- **Why:** each is named in notifications.md as observed or fixed behaviour
- **Evidence:** notifications.md lines 114, 182, 259, 284, 294
- **Reversibility:** easy
- **Confidence:** medium
- **Source:** locked by research/orca-features/notifications.md

## D38: Platform work deferred
- **Question:** what needs Linux or Windows work later
- **Options:** n/a
- **Chose:** afplay playback and the osascript fallback (macOS commands), the tray image and dot, the dock badge's AppKit call, Minimize to Tray on Close and the first-close notice (Windows), the Windows tray's left-click and menu, Linux's missing tray, and the menu bar appearance check for the dot's glyph colour
- **Why:** LOOP.md "Platforms"
- **Evidence:** notifications.md "Open questions" (Linux); apps/desktop/src/bun/dock.ts
- **Reversibility:** easy
- **Confidence:** high
- **Source:** deferred: platform

## D39: Electrobun gives silent banners and window state, but no badge, sound or click
- **Question:** what the shell can do with Electrobun 2.0.4 (feasibility)
- **Options:** n/a
- **Chose:** banners with `showNotification({title, body, silent})`; the tray with `setImage`, `setTitle`, `setMenu` and `setVisible`; window `isVisible`, `isMinimized` and `focus`/`blur` events; the dock badge through the existing AppKit call; sounds through afplay. Whether the tray has a tooltip is checked in the tech spec; Orca's "activity waiting" tooltip is dropped if not.
- **Why:** code map of ~/.hutch/releases/electrobun/2.0.4/macos-arm64/api/sdks/main and apps/desktop/src/bun/dock.ts:26-44
- **Evidence:** research: https://github.com/blackboardsh/electrobun/issues/392 (no badge API)
- **Reversibility:** easy
- **Confidence:** medium
- **Source:** assumed — autonomous

## D40: Approach: a daemon policy plugin that listens to producers, with markers on their records and the shell rendering
- **Question:** brainstorming's 2–3 approaches
- **Options:** (A) `quirky.notifications` in the daemon decides attention and delivery from producers' events, writes markers through public methods, and the shell only renders banners, sounds, the dot and the badge; (B) the desktop shell decides, as Orca's renderer and main do; (C) gates, cooldown and switches built into the kernel's `notify`
- **Chose:** A
- **Why:** B is lost when the window is closed, invisible to the CLI, and would be repeated for the web and phone clients; it also breaks "layout and focus live in the daemon". C puts a feature in the kernel, against "features are plugins", and a distro couldn't replace it. Phase B research: daemon-owned policy with thin clients (local-operator #2939, Matrix counts) works when one authority decides and clients only render; the main risk is clients notifying on their own, which D18 prevents by notifying only through the plugin. Core-enforced throttles (GNOME, Android) cause silent drops; A writes markers before any throttle.
- **Evidence:** research: https://github.com/damianvtran/local-operator/pull/2939, https://patrick.cloke.us/posts/2023/05/08/matrix-push-rules-notifications/, https://github.com/marmot-protocol/whitenoise-android/issues/2628, https://www.deskifier.com/blog/electron-notifications-windows
- **Reversibility:** hard
- **Confidence:** high
- **Source:** assumed — autonomous

## D41: Design sections self-reviewed and accepted without a pause
- **Question:** brainstorming's per-section approval
- **Options:** n/a
- **Chose:** each section (model, data flow, decisions, scenarios, scope) was checked against the doc and the locked decisions and accepted
- **Why:** LOOP.md says not to wait after presenting a design section
- **Evidence:** docs/loop/LOOP.md
- **Reversibility:** easy
- **Confidence:** high
- **Source:** locked by docs/loop/LOOP.md

## D42: The tray's dot is an amber dot image beside the "Q", not a dot drawn into a glyph
- **Question:** how to draw Orca's dot with Electrobun's tray (tech spec, shell)
- **Options:** composite a dot into a template glyph per appearance, as Orca does; keep the text "Q" and add a non-template amber dot image while attention is on
- **Chose:** the second. The tray is recreated with the dot image (`template: false`) when attention starts and without it when it ends.
- **Why:** Electrobun's `setImage` has no template switch and no way to clear the image, the app ships no tray glyph, and a non-template glyph would need the menu bar's appearance; the text title follows the menu bar by itself. The amber dot keeps Orca's colour and white ring.
- **Evidence:** ~/.hutch/releases/electrobun/2.0.4/macos-arm64/api/sdks/main/core/Tray.ts; notifications.md "Tray attention dot"; research: https://github.com/Zeitgleich/TeamCraft/issues/632
- **Reversibility:** easy
- **Confidence:** medium
- **Revisit if:** Quirky gets a menu bar glyph
- **Source:** assumed — autonomous

## D43: Every decision is an event, and two environment variables make time and sound testable
- **Question:** how tests see a suppressed or throttled banner, and avoid real sounds and 3-minute waits (tech spec)
- **Options:** inspect internals; a `decided` event plus test hooks
- **Chose:** `quirky.notifications/decided` reports every decision's result; `QUIRKY_SOUND_PLAYER` replaces afplay (in the plugin and the shell) and `QUIRKY_DESKTOP_AWAY_MS` shortens the presence window. Every test sets the player.
- **Why:** SC-26 and SC-35 assert a result for an event no CLI call returns; tests must not play sounds on the machine; SC-4 needs presence to lapse
- **Evidence:** logic.md SC-4, SC-26, SC-35
- **Reversibility:** easy
- **Confidence:** high
- **Source:** assumed — autonomous

## D44: The Codex adversarial review of both specs replaces the separate tech-spec reviewer
- **Question:** the tech-spec rubric's reviewer step
- **Options:** run both; run the adversarial review over both specs
- **Chose:** the adversarial review, which LOOP.md asks for and which covers pointer precision and fidelity to the locked decisions
- **Why:** LOOP.md step 4 replaces the user's spec review with one adversarial pass over both specs together
- **Evidence:** docs/loop/LOOP.md step 4
- **Reversibility:** easy
- **Confidence:** high
- **Source:** locked by docs/loop/LOOP.md

## D45: Opening a worktree from its card counts as Mark Read
- **Question:** tech spec, Mark Read detection: the card's `open()` clears `unread` through the same `set` call as Mark Read
- **Options:** add a reason to `set`; stop `open()` clearing; treat both as Mark Read
- **Chose:** treat both as Mark Read, so opening from the card clears the worktree and all its sessions; the logic spec's SC-6 says so
- **Why:** Orca's pass saw exactly that ("Opening the workspace cleared all of that at once; the tab strip showed no bell afterwards"); keeping `open()` keeps m1-worktrees' behaviour when the notifications plugin is off
- **Evidence:** notifications.md line 133; plugins/quirky.worktree/src/Tree.tsx:40-43
- **Reversibility:** easy
- **Confidence:** medium
- **Source:** locked by research/orca-features/notifications.md

## D46: Spec review: fix all four Codex findings; the two refuted ones stay as written
- **Question:** what to do with the adversarial review of both specs (LOOP.md step 4)
- **Options:** fix each confirmed finding; record why not
- **Chose:** one `quirk:adversarial-review` run over `d56dd7c..134914d` restricted to the spec directory with `--diff-file`, profile spec-design, depth deep, reviewer codex gpt-6.1-sol (independence full), criteria = roadmap bullets, milestone rules, LOOP.md steps 4 and 6 and the feature doc verbatim. Gate NEEDS_FIXES with 4 MEDIUM, 2 suppressed, none contested. Fixed: (SR1) Mark Read cleared sessions only on a true-to-false worktree change, so sessions under an already-read worktree could never be cleared; `quirky.worktree/changed` now carries `unread` when `set` asked for it and N clears on any `unread: false` that isn't its own; (SR2) report changes broadcast nothing, so a newly visible session could stay unread; the kernel now delivers `ui.report.changed` to plugins; (SR3) the test's own `notify` made a toast beside the view's acknowledgment; `notify` gains `toast: false`, used by the test; (SR4) OSC 99 chunks had no aggregate bound; each pending id's fields are capped at 4096 characters. Refuted and left: SR5 (badge counts asks, which D25 decides) and SR6 (on-screen bell with Suppress While Focused off). The pre-pass's unresolved references name planned files, plugin event IDs and SDK paths outside the repo, and its missing headings are not in the writing-specs rubrics; rejected, as m1-agent-status D43 did.
- **Why:** LOOP.md: fix every confirmed finding or record why not
- **Evidence:** review bundle in the session scratchpad (sr1/SR-gate.json, sr1/SR-manifest.json); logic.md amendments
- **Reversibility:** easy
- **Confidence:** high
- **Source:** locked by docs/loop/LOOP.md

## D47: Build with Claude subagents implementing and Codex reviewing, in three waves
- **Question:** subagent-driven development's preflight pairing and wave shape (LOOP.md step 5)
- **Options:** `claude-task + codex`; another cross-family pair if Codex is unreachable
- **Chose:** `claude-task + codex` (Codex gpt-6.1-sol verified reachable by the spec review's `select-model`). W1: six disjoint components (K kernel, P OSC fact, R producers, M markers, S sound files, T pure text/cooldown/sound modules); W2: the notifications plugin core, the desktop shell, the settings view; W3: e2e CLI and UI scenario tests. Full gate `bun run test && bun test scripts && bun run typecheck`, run in the background because it takes ~15 minutes.
- **Why:** LOOP.md names the pairing; the tech spec's units split by file so W1 needs no serialisation
- **Evidence:** docs/loop/LOOP.md step 5; tech.md "Build waves"
- **Reversibility:** easy
- **Confidence:** high
- **Source:** locked by docs/loop/LOOP.md

## D48: W1 landed as six components; two one-line test fixes outside their scopes were applied by the orchestrator
- **Question:** wave 1's results and the choices its implementers made where the contract was open
- **Options:** accept; send back
- **Chose:** accept all six (merged at a889dca). K and P each stopped BLOCKED on one test outside scope that pinned an old shape (`packages/cli/test/kernel-commands.test.ts` building a `UiWindowInfo`; `plugins/quirky.terminal/test/terminal.test.ts` listing the terminal events); no other component touched either file, so the orchestrator widened those scopes and made the one-line fixes. Recorded choices: K adds `DaemonOptions.desktopAwayMs` and an injectable clock, passes the threshold with `layout.setAwayMs` after the runtime starts, and keeps `sound.file` untyped in the schema (the schema subset has no unions); P needs no PTY protocol bump (facts are forwarded opaquely), cuts to 255 characters plus "…", and lets the last `o=` of an OSC 99 id win; R emits title-driven `settled` only for an existing row, leaves inferred interrupts silent, and drops the v1 notifications import (the daemon's v1 import still writes the old setting ID, which N migrates); M uses the theme's `--amber` token for the bells, a masked inline SVG per plugin, and description-only schemas for the nullable `unread`; S's tones are 0.09 to 0.58 s at a peak of 20000; T cuts with `n-1` units plus "…" and moves a re-reserved cooldown key to newest.
- **Why:** every component's acceptance passed in its tree; each choice fits the contract
- **Evidence:** sdd journal in the session scratchpad; merges 435e685..a889dca
- **Reversibility:** easy
- **Confidence:** high
- **Source:** assumed — autonomous

## D49: W2 starts while the W1 gate finishes; its two failures belong to W2
- **Question:** the W1 gate shows `plugins/test/imports.test.ts` SC-24 failing (the new `plugins/quirky.notifications/` has no `package.json` yet) and `packages/ui/test/exit.e2e.test.ts` SC-31 failing (the ask no longer announces itself until the notifications plugin exists)
- **Options:** fix them with a scoped wave-gate fixer; let W2's plugin task own them
- **Chose:** W2's plugin task, whose scope adds `package.json` and whose acceptance now runs both tests
- **Why:** both failures are the planned gap between W1 removing the producers' notify calls and W2 adding the plugin; a separate fixer would write a stub the plugin task replaces
- **Evidence:** sdd/gate-w1.log in the session scratchpad
- **Reversibility:** easy
- **Confidence:** high
- **Source:** assumed — autonomous

## D50: The W1 gate's 65 `EBADF` failures are the suite's descriptor exhaustion, not a regression
- **Question:** the W1 full gate ended 4948 pass, 67 fail; 65 of the failures are `EBADF: bad file descriptor, posix_spawn` in `plugins/quirky.agents` tests, all in one stretch of the run
- **Options:** treat as a regression; treat as the known single-process descriptor leak
- **Chose:** the known leak: `bun test plugins/quirky.agents` alone passes 869/869 on the same tree. m1-term-ui D51 measured it: under `bun test`, every dynamic import from a new path keeps about four descriptors, and in-process harness daemons importing plugins from fresh temp directories add up. This item's notifications rig starts its daemons from the repo's fixed `plugins/` directory (its implementer measured 249 descriptors before and 242 after its suite). The two other failures are D49's.
- **Why:** an isolated rerun is the evidence; the fix that matters for landing is keeping this item's harnesses off fresh plugin paths, which m1-term-ui's landing also reduces
- **Evidence:** sdd/gate-w1.log in the session scratchpad; build/m1-term-ui docs/loop/decisions/m1-term-ui.md D51
- **Reversibility:** easy
- **Confidence:** medium
- **Revisit if:** the post-W2 gate fails with EBADF again; then this item's harnesses (agent-status's `builtinDir()` makes a fresh directory per start) need the shared-directory treatment
- **Source:** assumed — autonomous

## D51: W2 landed as two components; the W1 checkpoint ran over W1 alone
- **Question:** W2's results, and the W1 checkpoint review
- **Options:** n/a
- **Chose:** accept N (plugin core: policy, methods, CLI, migration, `PluginContext.storedSettingValue`) and D (shell), merged at 25319b9. Recorded choices: N adds a test-only `QUIRKY_NOTIFICATION_COOLDOWN_MS`, cuts `send` text to 256, retries the migration until `setting.set` succeeds, passes the full environment to the player, and leaves SC-16's spooled-replay case and SC-18's structured source to unit level; D samples window visibility at each attention event, plays nothing for a `sound` event with no file, clamps afplay's volume to 0..1, and resolves the dot image through `trayDotPath`. One N run used the real `HOME` before its rig set a temporary one; the agent-status installer's guard skipped writing, and `~/.codex/hooks.json`, `~/.gemini/settings.json` and `~/.cursor/hooks.json` are unchanged since 01:34 with no Quirky entries. The W1 checkpoint (C, S, X at standard over `d325202..a889dca` without docs; pre-pass typecheck plus the new modules' tests, both green) found 7, collapsing to 4 defects: OSC/title settles bypassed the child fold and boundary rule (C1 HIGH, C2); OSC 99 accepted malformed base64 padding (C3, S1, X1); a window drop cleared reports without `ui.report.changed` (S2); an empty custom path had an off-contract reason (S3). All accepted; four fixers dispatched.
- **Why:** each finding was reproduced by the refute stage and contradicts the contract it cites
- **Evidence:** cp1/{C,S,X}-gate.json in the session scratchpad
- **Reversibility:** easy
- **Confidence:** high
- **Source:** assumed — autonomous

## D52: W3 landed; the settings view ran in the main tree after its worktree was reclaimed
- **Question:** W3's results and how they were gated
- **Options:** n/a
- **Chose:** accept V (Settings > Notifications view, its manifest entries, and the React dependencies it needed, a scope widening the orchestrator granted because no other task touched `package.json` or `bun.lock`) and E (27 end-to-end tests in `plugins/quirky.notifications/test/e2e/` on daemon subprocesses with temp homes, a sound recorder and a fake `osascript`). V's original worktree had been removed by the time it was resumed, so it worked in this lane's main tree; its diff stayed inside its scope and was committed as 4fc241f, but the post-W2 gate that was running in that tree saw a mix, so the gate is rerun after the W2 checkpoint fixes. Recorded choices: V copies labels into `src/window/copy.ts` with a test against the manifest, uses a disabled dashes option as the separator, and adds a "Change" button for a stored custom file; E runs terminal scenarios through `quirky terminal send` on a plain shell session (the terminal harness can't take the sound recorder), never shortens the cooldown, and seeds SC-51's old setting by rewinding a live home with `bun:sqlite`.
- **Why:** both tasks' acceptance passed; the main-tree incident changed no file outside V's scope
- **Evidence:** commits 4fc241f, 48bfbfe
- **Reversibility:** easy
- **Confidence:** high
- **Source:** assumed — autonomous

## D53: W2 checkpoint: accept all five findings, which collapse to three defects
- **Question:** the W2 checkpoint (C, S, X at standard over `ee9d1d9..9eafe3a` without docs)
- **Options:** fix; reject
- **Chose:** fix all: (1) a `notify` without `sound` (an invalid custom file) made an audible desktop banner (C1, S1 HIGH, X1); (2) after an OSC 7501 done took over while a child ran, the child's completion never settled, because the OSC path stored an unfolded `done` (C2); (3) a never-answering lookup in another plugin stalled the notifications queue forever (X2). Three fixers dispatched.
- **Why:** each was reproduced by the refute stage
- **Evidence:** cp2/{C,S,X}-gate.json in the session scratchpad
- **Reversibility:** easy
- **Confidence:** high
- **Source:** assumed — autonomous

## D54: Catching up with m1-term-ui moves the unread bell into the terminal workspace and widens what counts as visible
- **Question:** LOOP.md step 5's catch-up merge brought m1-term-ui, whose `quirky.terminal` view overrides `view:quirky.session/worktree` with tab groups, pane trees and a floating workspace overlay
- **Options:** keep the bell only in quirky.session's simple strip; carry it into the terminal strip and read the terminal view's visibility
- **Chose:** carry it, as the tech spec's "Catch-up obligations" planned: the terminal tab strip shows the bell when any session in a tab is unread, the terminal view's report and the floating overlay's report give `visibleSessions`, and the notifications plugin treats sessions in the open floating panel as viewed. Two merge conflicts were mechanical (`packages/ui/src/plugins/host.ts` kept both the activity constant and m1-term-ui's key type; the terminal event list gained `notification`), plus one `UiWindowInfo` literal in a new m1-term-ui CLI test.
- **Why:** m1-term-ui D6 routes every caller of the view ID to the terminal workspace, so a bell only in the fallback strip would never be seen; D36 makes the view's report the place the window says what it shows. Orca counts the open floating panel as viewed (notifications.md "What an agent-completion event does" point 5).
- **Evidence:** docs/loop/decisions/m1-term-ui.md D6, D25, D36, D52; merge 9fcea51
- **Reversibility:** easy
- **Confidence:** high
- **Source:** assumed — autonomous

## D55: The suite is over the descriptor limit after the catch-up; this item moves the remaining harnesses to shared plugin directories
- **Question:** the post-catch-up gate failed 175 tests with `EBADF` (descriptor exhaustion, docs/loop/BLOCKERS.md "m1-term-ui: the single-process test suite is close to running out of file descriptors"); this item can't land a red gate
- **Options:** change how the suite runs (protected: `scripts/build-loop/`, and land runs the root script); block the item for a person; reduce the leak in the other harnesses as m1-term-ui D51 did for its own
- **Chose:** reduce the leak: a test-only task memoises each harness's built-in plugin directory per process, measured per file, with the full suite as its acceptance
- **Why:** the BLOCKERS entry names this as one of the two fixes, and the only one that stays inside a build item's allowed paths; every test keeps a fresh home
- **Evidence:** sdd/gate-cu.log in the session scratchpad (6218 pass, 177 fail, 322 EBADF lines)
- **Reversibility:** easy
- **Confidence:** medium
- **Revisit if:** the leak returns as tests grow; then a person should split the suite into processes
- **Source:** supersedes m1-term-ui D51

## D56: Final Round 1: accept five of six findings; SC-33's ESC case is amended instead
- **Question:** Final Round 1 (C, S, X at deep over the item's non-test source diff against build/roadmap at 66a6f5a; pre-pass typecheck plus the notifications, desktop, terminal window and OSC tests, all green; reviewer codex gpt-6.1-sol, independence full)
- **Options:** fix each; reject with a reason
- **Chose:** six MEDIUM findings, none contested, one suppressed. Accepted: floating sessions never auto-cleared outside a worktree view (C1); slow banner preparation shortened the cooldown (C2); a completion during the bell hold could miss superseding it (C3); a timed-out own write later read as Mark Read (X1); a stalled filesystem in the custom-sound check blocked the queue (X2). One fixer owns all five (same two files). Rejected S1 (an OSC 777 title with an ESC byte makes no notification): the scanner treats ESC as the start of ST or as aborting the sequence, as every terminal does, so an ESC can't be in a payload; the spec's SC-33 asked for the impossible, and is amended (logic.md amendments) rather than the parser.
- **Why:** each accepted finding was reproduced; S1's expected behaviour contradicts how OSC sequences end (ECMA-48 string terminator)
- **Evidence:** fr1/{C,S,X}-gate.json in the session scratchpad; packages/pty-host/src/scanner.ts OSC state
- **Reversibility:** easy
- **Confidence:** high
- **Source:** assumed — autonomous

## Progress
W1–W3 and both checkpoint fix batches merged; caught up with build/roadmap (m1-term-ui) at 9fcea51. In flight: the term-ui obligations task (bell in the terminal strip, `visibleSessions` from the terminal view and floating overlay) and the descriptor task (shared harness directories, window-presence fake). Next: merge both, full gate green, Final Round 1 (C, S, X deep over d325202..HEAD without docs), its fix batch, gate, the like-a-user web pass (SC-6, SC-46 to SC-50), docs/loop/native/m1-notifications.json, land. Briefs and run journal: session scratchpad sdd/; review drivers cp1/run_cp.py.
