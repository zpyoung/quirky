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
- **Chose:** Orca's rule. A session is viewed when a window is focused, the person used the mouse or keyboard in it within the last 180 seconds, and its worktree view shows that session. A worktree is viewed under the same conditions when its view is open. When a session becomes viewed its marker clears, and the worktree's marker clears too. Marks on the worktree's other sessions stay until each is viewed. Mark Read on the worktree clears it and all its sessions. Presence never seen counts as away, so it never clears a marker.
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

## Progress
Brainstorming done (D1–D41). Next: write logic.md and tech.md under docs/quirk/specs/2026-10-27-m1-notifications/, commit, run the Codex spec review.
