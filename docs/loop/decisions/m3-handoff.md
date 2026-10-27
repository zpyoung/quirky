# m3-handoff decisions

## D1: Classify the item as Visual, API, CLI and Integration work, and run research phases A and B
- **Question:** brainstorming's domain detection and research swarm (brainstorming, checklist 2 and 7)
- **Options:** one domain with a small swarm; every domain the item touches, with phases A and B; phases A, B and C
- **Chose:** Visual (the dialog, toasts, badges, settings page), API and CLI (the handoff methods and command group) and Integration (launching a second agent and pasting into its terminal). Phase A ran two web agents (patterns, pitfalls) and four code-mapping agents (launch and delivery, agent status and storage, worktree and git, UI plugin surfaces). Phase B ran one agent per approach in D5. Phase C was skipped.
- **Why:** the feature crosses six existing plugins and the shell. Phase C is for a novel approach; the chosen one reuses the pattern earlier items proved (a plugin that owns its policy in the daemon and drives other plugins through their public methods, m1-notifications D5).
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
- **Chose:** scope and entry points; the destination (worktree, new worktree, agent, relationship); brief content and composition; transcript reachability; a busy source; editing the preview; the secret scan; the cost readout; start, delivery and resend; lineage and badges; templates and preferences; drafts; the scripting surface; error and empty states. Each is settled by the decisions below.
- **Why:** LOOP.md asks for every area that matters when no human is present
- **Evidence:** docs/loop/LOOP.md "Answering a skill's questions"
- **Reversibility:** easy
- **Confidence:** high
- **Source:** locked by docs/loop/LOOP.md

## D4: In scope is every flow of handoff.md that works on one Mac with a terminal session; native chat, SSH and runtime hosts, the AI Vault row entry and the dashboard are out
- **Question:** which of handoff.md's flows and entry points this item owns
- **Options:** every flow and entry point in the doc; every flow minus the entry points whose host feature is dropped or not built yet
- **Chose:** the second. In: the terminal pane menu entry, the whole dialog (destination, content, notes, preview editing, busy source, secret scan, cost readout, start, delivery outcomes and resend), drafts, lineage with badges on session tabs and a working jump, the Settings "Session handoff" template page, and handing off a session that has no live terminal (an ended session or an archived transcript) through the API. Out, as non-goals: the native chat entry (native chat is dropped, BRIEF.md "Dropped"), SSH and runtime-environment hosts and the "different execution host" warning (dropped, BRIEF.md; same exclusion as m2-source-control-core and m1-worktrees), the AI Vault row entry and the Vault lineage line (m3-vault builds Vault rows and calls this item's methods, D7), the dashboard agent rows (Quirky has no dashboard), the es/fr/ja/ko/zh catalogs (Quirky ships English only, as every earlier item).
- **Why:** roadmap "Parity" covers every flow of a kept feature; session handoff is on BRIEF.md's kept list. The excluded entry points live inside features that are dropped (native chat, SSH) or that a later queue item builds (the Vault). Unlike m3-terminal-dock's block, no handoff flow needs a dropped capability: every flow is reachable from the terminal pane entry and the API.
- **Evidence:** handoff.md "Where to find it"; BRIEF.md "Features to keep"; docs/roadmap.md "What the order rests on"; docs/loop/BLOCKERS.md "m3-terminal-dock: blocked"
- **Reversibility:** easy
- **Confidence:** medium
- **Revisit if:** a reviewer reads the Vault row entry as a handoff flow that must ship before m3-vault
- **Source:** assumed — autonomous

## D5: A new built-in plugin, `quirky.handoff`, owns composition, launch and lineage in the daemon; the window is a thin view
- **Question:** where the logic lives (brainstorming, approaches)
- **Options:** A, a new plugin whose daemon side composes the brief, probes the transcript, launches, delivers and stores lineage, with a window dialog that calls those methods; B, Orca's shape, composition and launch in the window with only lineage in the daemon; C, add handoff methods to `quirky.session`
- **Chose:** A
- **Why:** roadmap "Everything is scriptable" needs an agent to hand off with no window open, which B can't do without writing the logic twice. C breaks "features are plugins" (a distro can't turn handoff off without losing sessions). Phase B research: shipping daemon-plus-thin-UI apps report the CLI as a second consumer of the same API rather than a second implementation, and renderer-owned state is the usual source of multi-window inconsistencies.
- **Evidence:** docs/roadmap.md "Features are plugins", "Everything is scriptable"; logic spec Industry Insights
- **Reversibility:** hard
- **Confidence:** high
- **Source:** assumed — autonomous

## D6: A source is a session; a live source is the agent running in a terminal session
- **Question:** what Orca's "pane key" maps to
- **Options:** the terminal layout's pane id; the session id
- **Chose:** the session id. Quirky's panes hold exactly one session, agent status and provider session ids are keyed by session, and a session outlives its pane (an ended session keeps its history). Lineage, drafts and the retained brief are keyed by session id.
- **Why:** plugins/quirky.terminal/src/layout/types.ts:28-41 (a pane leaf names one session); plugins/quirky.agent-status/src/store.ts:5-8 (rows keyed by session)
- **Evidence:** as above
- **Reversibility:** medium
- **Confidence:** high
- **Source:** assumed — autonomous

## D7: A source can also be an archived session given by agent, provider session id and transcript path
- **Question:** how a session with no Quirky terminal (Orca's Vault rows) is handed off before the Vault exists
- **Options:** only live or ended Quirky sessions; also an archived source passed as `{agent, providerSessionId, transcriptPath, title, worktree}`
- **Chose:** both. An archived source is accepted by every method that takes a source; it has no live pane, so "Wait for idle" and recapture are unavailable and the dialog says "This source has no live pane. Idle waiting and live scrollback recapture are unavailable." It is eligible only with a transcript path or a non-empty prompt or last message, mirroring Orca's Vault rule. m3-vault adds the row entry and the lineage line on top of these methods.
- **Why:** handoff.md "Transcript probe" and "Edge cases" describe the no-live-pane flow; building it now makes those flows testable and leaves m3-vault only UI work
- **Evidence:** handoff.md "Edge cases and failure behaviour" (Vault eligibility, OpenCode)
- **Reversibility:** easy
- **Confidence:** medium
- **Source:** assumed — autonomous

## D8: The pane menu shows "Hand Off to Another Agent" only on panes whose session runs a catalog agent, right below Quick Commands
- **Question:** entry visibility and placement
- **Options:** every pane; agent panes only
- **Chose:** agent panes only (session agent is not `shell`), placed directly below "Quick Commands ▸" and above the separator, with Orca's label. A plain shell pane doesn't show it.
- **Why:** handoff.md "Where to find it" and "Verified in the app" 1; m1-term-ui D18 fixes the rest of the menu's order
- **Evidence:** handoff.md lines 13, 242; docs/loop/decisions/m1-term-ui.md D18
- **Reversibility:** easy
- **Confidence:** high
- **Source:** locked by handoff.md

## D9: The pane menu gains a public contribution point other plugins use
- **Question:** how `quirky.handoff` adds a row to `quirky.terminal`'s private pane menu
- **Options:** hard-code the row in quirky.terminal; a public menu contribution kind declared in the manifest, with a placement and a condition, that quirky.terminal reads
- **Chose:** a public contribution. A plugin declares a menu item for the menu `quirky.terminal/pane` with a title, the command it runs, and a condition on the pane (here: the pane runs an agent). The terminal lists contributed items in its menu and its report, and runs the command with the pane's session.
- **Why:** roadmap "Each feature ships as a built-in plugin, using only the public plugin API. If it needs something the API lacks, the API grows"; hard-coding would make quirky.terminal depend on handoff
- **Evidence:** plugins/quirky.terminal/src/window/workspace/controller.ts:850-885 (rows are hard-coded today); packages/protocol/src/ui.ts:4 (no menu kind)
- **Reversibility:** medium
- **Confidence:** high
- **Source:** locked by docs/roadmap.md

## D10: No context, no dialog
- **Question:** what happens when the source has nothing to continue from
- **Options:** open the dialog anyway; refuse with Orca's toast
- **Chose:** when a live source has no transcript path and its terminal history is empty after stripping escapes, the entry shows the toast "No session context is available to continue in a new session." and opens nothing; the API returns error reason `no-context`.
- **Why:** handoff.md "Hand a session off" 1
- **Evidence:** handoff.md line 27
- **Reversibility:** easy
- **Confidence:** high
- **Source:** locked by handoff.md

## D11: Orca's labels and messages are kept word for word, with "Orca" read as "Quirky" in the brief
- **Question:** the dialog's, toasts' and brief's wording
- **Options:** new wording; Orca's wording
- **Chose:** Orca's wording from handoff.md for every label, hint, warning and toast. In the brief text, the product name is Quirky ("Continue work from the prior Quirky session.", "Latest Quirky status hints", "## Locked Quirky handoff notice").
- **Why:** parity; the brief names the product the reader is running
- **Evidence:** handoff.md throughout
- **Reversibility:** easy
- **Confidence:** high
- **Source:** locked by handoff.md

## D12: The worktree list is the source repo's worktrees plus folder workspaces that contain it, defaulting to the source's worktree
- **Question:** destination candidates
- **Options:** every worktree; Orca's repo-scoped list
- **Chose:** Orca's: every worktree of the source's repo, plus folder workspaces whose path equals or contains the source repo's path, each row showing name and path, searchable with "Search worktrees…" and "No matching worktrees.". The default is the source's worktree. A source in a folder workspace lists that folder only.
- **Why:** handoff.md "Destination group"
- **Evidence:** handoff.md line 37; plugins/quirky.worktree/quirky-plugin.json list (`repo` selector, `kind`)
- **Reversibility:** easy
- **Confidence:** high
- **Source:** locked by handoff.md

## D13: "Create a new worktree" creates it at Start through `quirky.worktree/create`, only for git sources
- **Question:** inline worktree creation
- **Options:** create on toggle; create at Start
- **Chose:** at Start, with the name (placeholder `handoff-follow-up`) and optional base branch (placeholder "Current branch"; blank means the source worktree's current branch). The toggle is shown only when the source repo is a git repo. Start is disabled while the name is blank. Creation runs the same path as any create (setup follows the repo's setting). A creation failure shows its message in the strip and keeps every field; a later failure leaves the new worktree selected.
- **Why:** handoff.md "Destination group" and "Edge cases"
- **Evidence:** handoff.md lines 38, 218; plugins/quirky.worktree/src/daemon/create.ts:216-230
- **Reversibility:** easy
- **Confidence:** high
- **Source:** locked by handoff.md

## D14: The base branch blank means the source worktree's current branch, not the repo's default
- **Question:** what an empty "Base branch (optional)" means, since `worktree.create` defaults to the project's base
- **Options:** pass nothing (project base); pass the source worktree's branch
- **Chose:** pass the source worktree's branch (or its HEAD commit when detached)
- **Why:** the placeholder says "Current branch"; a follow-up session usually continues the source's work
- **Evidence:** handoff.md line 38
- **Reversibility:** easy
- **Confidence:** medium
- **Revisit if:** Orca's code passes `undefined` and users expect the default branch
- **Source:** assumed — autonomous

## D15: The agent list is the installed, enabled catalog agents; default order is draft, last used, source, default agent, first
- **Question:** agent choices and the default
- **Options:** every catalog agent; installed and enabled ones
- **Chose:** installed and enabled agents from `quirky.agents/list`, with "Detecting Agents on the target host…" while the list loads, "Could not detect Agents on the target host." on failure and "No enabled Agents were detected on the target host." when empty. The default is a restored draft's agent, then the last agent used for a successful handoff, then the source's agent, then the `default-agent` setting, then the first listed. Switching the target keeps the choice when the agent is still listed.
- **Why:** handoff.md "Destination group" agent order; Quirky has one host, so detection is one list
- **Evidence:** handoff.md lines 39, 42; plugins/quirky.agents/quirky-plugin.json `default-agent`
- **Reversibility:** easy
- **Confidence:** high
- **Source:** locked by handoff.md

## D16: Relationship is Continues, Reviews or Branches from, recorded and shown, acting on nothing
- **Question:** relationship
- **Options:** as Orca
- **Chose:** as Orca; default Continues
- **Why:** handoff.md line 40
- **Evidence:** handoff.md
- **Reversibility:** easy
- **Confidence:** high
- **Source:** locked by handoff.md

## D17: Session context is Focused by default; Full only when the transcript is usable; never remembered
- **Question:** context mode
- **Options:** as Orca
- **Chose:** "Focused handoff (Recommended)" with the hint "Carries status hints and reads older transcript details only when needed.", or "Full session transcript". Full is disabled unless the probe says usable, with Orca's two reasons. Each open starts Focused.
- **Why:** handoff.md "Content group"
- **Evidence:** handoff.md line 46
- **Reversibility:** easy
- **Confidence:** high
- **Source:** locked by handoff.md

## D18: Include toggles are repo state (on), diff bodies (off, needs repo state, capped at 12,000), open editor tabs (on); remembered after a successful start
- **Question:** include toggles
- **Options:** as Orca
- **Chose:** as Orca, labels "Git status and changed file paths", "Diff bodies" with "Opt-in and capped at 12,000 characters.", "Open editor tabs"
- **Why:** handoff.md "Content group" and "Settings and defaults"
- **Evidence:** handoff.md lines 47, 79-86
- **Reversibility:** easy
- **Confidence:** high
- **Source:** locked by handoff.md

## D19: Open editor tabs come from the editor plugin when it is running; without it the block is left out
- **Question:** where "Open editor tabs" reads from, since `quirky.editor` (m2-editor) has not landed
- **Options:** drop the toggle until the editor lands; read `quirky.editor/state` when the editor plugin is active and leave the block out otherwise; build a tab registry in handoff
- **Chose:** read the editor plugin's public state for the source worktree when that plugin answers, listing open document paths relative to the worktree. When the method is missing or fails, the block is empty and skipped, and the toggle stays. Catch-up with m2-editor (LOOP.md step 5) aligns the call with the landed method shape.
- **Why:** the feature doc's flow includes the toggle; the editor is being built by another lane right now (build/m2-editor tech.md lists `state` with `tabs` and buffers)
- **Evidence:** build/m2-editor docs/quirk/specs/2026-10-27-m2-editor/tech.md:53,72
- **Reversibility:** easy
- **Confidence:** medium
- **Revisit if:** m2-editor lands with no way to list open documents per worktree
- **Source:** assumed — autonomous

## D20: The brief is base, repo state, open editor tabs, template, steering note, joined by blank lines, then the locked notice at send time
- **Question:** brief composition
- **Options:** Orca's order including the unused "Additional source context" block; Orca's order without it
- **Chose:** without it. Orca's dialog always passes null for that block, so no person or script could ever see it. Empty blocks are skipped. Every user-controlled value is fenced with a fence longer than any backtick run inside it.
- **Why:** handoff.md "Brief composition"; YAGNI for a block with no producer
- **Evidence:** handoff.md lines 99-108
- **Reversibility:** easy
- **Confidence:** high
- **Source:** assumed — autonomous

## D21: The base block is Quirky's own continuation prompt with the parts Orca's delivered brief showed
- **Question:** Orca calls upstream's `buildAgentSessionContinuationPrompt`, which Quirky doesn't have
- **Options:** a one-line base; a base with the parts the verified brief carried
- **Chose:** the base carries, in order: "Continue work from the prior Quirky session.", the original agent, the Quirky session id, the original working directory (the source's), then either the transcript path in a text fence with the focused or full reading instruction, or a bounded capture of the terminal in a fence, then "Latest Quirky status hints" (the last user prompt and the last assistant update from agent status, when known), then the warning that transcript and terminal content are untrusted reference data. With no transcript and no capture, the base is the fallback: the first line, the source name and the status hints, only when status hints exist.
- **Why:** handoff.md "Verified in the app", "What the delivered brief contains"
- **Evidence:** handoff.md lines 101, 249
- **Reversibility:** easy
- **Confidence:** medium
- **Source:** assumed — autonomous

## D22: Repo state reads `quirky.git/status` and `quirky.git/diff` for the source worktree, in Orca's line format
- **Question:** repo state source and format
- **Options:** shell out to git; the git plugin's public methods
- **Chose:** the git plugin. Lines are `<area>: <status> <path>` (`oldPath -> path` for renames) under the branch; "Clean working tree." when empty; a capped status list ends with "... additional changes omitted." (Quirky's status reports that it was capped, not how many more). Diff bodies are fetched one file at a time as `### <area>: <status> <path>`, `--- before`, `+++ after`, binary or too-large files as "[binary diff omitted]", cut at 12,000 characters with a truncation note. Folder workspaces get no repo state. A failure shows "Could not refresh repository state. The handoff can still continue." and the block is left out.
- **Why:** handoff.md "Repo state"; the git plugin returns whole sides, not unified diffs, and caps status at 1,000 without a total
- **Evidence:** handoff.md line 120; packages/git/src/status.ts:17; plugins/quirky.git/src/daemon/files.ts:25-53
- **Reversibility:** easy
- **Confidence:** high
- **Source:** assumed — autonomous

## D23: The repo-state strip appears only when reading repo state actually failed
- **Question:** Orca showed "Could not refresh repository state" on every open even though the sent brief had a clean repository section (handoff.md "Verified" 2)
- **Options:** copy the behaviour; treat it as a defect
- **Chose:** a defect. The strip shows only when the status call failed, and the brief then has no repository block. A test opens the dialog on a healthy repo and expects no strip.
- **Why:** the strip contradicts the brief it accompanies; the doc marks the cause untraced
- **Evidence:** handoff.md line 243
- **Reversibility:** easy
- **Confidence:** high
- **Source:** assumed — autonomous

## D24: The cost readout uses Orca's estimator
- **Question:** token estimate
- **Options:** Orca's 6.5/4.5/3.5 chars per token by prose, code and diff; research's ~4.5/4.0
- **Chose:** Orca's, "{characters} characters · about {tokens} tokens", over the editable text without the locked notice
- **Why:** parity; the readout is labelled "about". Research shows prose nearer 4.5 chars per token, so Orca under-counts prose.
- **Evidence:** handoff.md line 116; logic spec Industry Insights
- **Reversibility:** easy
- **Confidence:** medium
- **Revisit if:** the readout misleads people choosing between focused and full
- **Source:** locked by handoff.md

## D25: The transcript probe checks local files only: reported path, session id, earlier paths, then a Claude project scan
- **Question:** transcript reachability without SSH or runtime hosts
- **Options:** trust the reported path; Orca's candidate chain on the local disk
- **Chose:** Orca's chain on the local disk. Candidates, best first: the path agent status reported; the agent's transcript found by provider session id under its session root; up to 5 earlier paths this session reported (kept for up to 256 sessions, because Claude reports a new id before it writes the file); for Claude only, the newest `.jsonl` in the workspace's project folder not claimed by another session, withheld as ambiguous when the two newest were written within 5 minutes. Each candidate must be a `.jsonl` inside the agent's session root (Claude `~/.claude/projects`, Codex `~/.codex/sessions`, honouring `CLAUDE_CONFIG_DIR` and `CODEX_HOME`); outside it is unverifiable. Verdicts: usable, unverifiable (refused, or a stat error other than not-found, or any thrown error), unreachable (a path was reported but nothing exists), none (nothing reported and nothing found).
- **Why:** handoff.md "Transcript probe"; Quirky has one host, so Orca's runtime and host-change short-circuits never apply. The Vault's accept rule doesn't exist yet, so the root plus extension rule stands in for it.
- **Evidence:** handoff.md lines 143-160; plugins/quirky.agent-status/src/capture.ts:77-85
- **Reversibility:** medium
- **Confidence:** medium
- **Revisit if:** m3-vault defines a stricter accept rule; the probe should then use it
- **Source:** assumed — autonomous

## D26: Session roots are home-relative paths; Windows roots are not handled
- **Question:** transcript roots across platforms
- **Options:** macOS and Linux paths only; add Windows profile paths
- **Chose:** home-relative paths, which serve macOS and Linux
- **Why:** LOOP.md platform rule
- **Evidence:** docs/loop/LOOP.md "Platforms"
- **Reversibility:** easy
- **Confidence:** high
- **Source:** deferred: platform

## D27: A bounded capture is the source terminal's last 800 history lines, escapes stripped, last 36,000 characters
- **Question:** what travels when the transcript can't
- **Options:** as Orca
- **Chose:** as Orca, prefixed "[Earlier terminal output omitted: N characters]" when cut. It is used when the transcript is not usable and the source has terminal history (an ended session still has history).
- **Why:** handoff.md "Transcript vs capture"
- **Evidence:** handoff.md line 112; plugins/quirky.terminal/src/terminal.ts:184 (`history`)
- **Reversibility:** easy
- **Confidence:** high
- **Source:** locked by handoff.md

## D28: The busy strip appears while the source's agent status is working; "Wait for idle" recaptures on idle and never starts by itself
- **Question:** busy source
- **Options:** as Orca
- **Chose:** as Orca: "The source Agent is working. Capture now or wait for newer context." with "Wait for idle" and "Capture anyway"; waiting reads "Waiting for the source session to go idle. You can still start now."; on idle the dialog recaptures and recomposes (or adds a stale reason when detached). No busy strip for a source with no agent status row or no live terminal.
- **Why:** handoff.md "Source is busy"
- **Evidence:** handoff.md lines 62-69
- **Reversibility:** easy
- **Confidence:** high
- **Source:** locked by handoff.md

## D29: Editing the preview detaches it; regenerate reattaches; changes while detached only mark it stale
- **Question:** preview editing
- **Options:** as Orca
- **Chose:** as Orca, with the notice and stale text from handoff.md; the locked notice sits below the editor, read-only, labelled "Locked safety note · always appended last".
- **Why:** handoff.md "Edit the brief"
- **Evidence:** handoff.md lines 55-60
- **Reversibility:** easy
- **Confidence:** high
- **Source:** locked by handoff.md

## D30: The preview editor is CodeMirror 6, plain text, line numbers, word wrap
- **Question:** Orca uses Monaco
- **Options:** Monaco; CodeMirror 6; a textarea
- **Chose:** CodeMirror 6, with secret hits as red marks whose hover text is "Potential secret: <excerpt>"
- **Why:** architecture.md "Editor: CodeMirror 6 instead of Monaco"; a textarea can't mark ranges
- **Evidence:** docs/architecture.md Decisions
- **Reversibility:** easy
- **Confidence:** high
- **Source:** locked by docs/architecture.md

## D31: The secret scan runs on every preview, never blocks, and the host warning never shows
- **Question:** Orca scans only when the target is on a different execution host, which can't happen in Quirky
- **Options:** never scan (the flow can't be reached); scan when the target agent differs from the source agent; scan every preview
- **Chose:** scan every preview with Orca's six rules, the banner "{count} potential secrets found. Review the inline preview markers before starting.", the inline markers and the line under the editor. Hits never block Start. "The brief will be sent to a different execution host." never shows.
- **Why:** leaving the scan unreachable drops a doc flow; a brief always leaves for an agent provider, so the risk the scan names exists on one host too. Hits never block, so the cost of false positives (research: regex scanners run near 46% precision) is a banner.
- **Evidence:** handoff.md "Secret scan"; logic spec Industry Insights
- **Reversibility:** easy
- **Confidence:** medium
- **Revisit if:** the banner fires often enough on ordinary briefs to be ignored
- **Source:** assumed — autonomous

## D32: Start is disabled under Orca's conditions
- **Question:** when Start is disabled
- **Options:** as Orca
- **Chose:** while a start is running, agents are loading, no agent is selected, no target resolves, the brief has no context, the probe is loading, repo state is included and loading, or "Create a new worktree" is on with a blank name. The button reads "Starting…" while it runs.
- **Why:** handoff.md line 33
- **Evidence:** handoff.md
- **Reversibility:** easy
- **Confidence:** high
- **Source:** locked by handoff.md

## D33: An attached preview is recomposed at Start and refused if the source changed
- **Question:** what body Start sends
- **Options:** as Orca
- **Chose:** attached: the daemon recomposes from a fresh capture; if the text differs from what the caller showed, nothing launches and the error "The source session changed. The preview was refreshed — review it, then start again." returns with the fresh text. Detached: the edited text is sent verbatim.
- **Why:** handoff.md "Starting and delivery" 2
- **Evidence:** handoff.md line 167
- **Reversibility:** easy
- **Confidence:** high
- **Source:** locked by handoff.md

## D34: The new session opens as a tab in the source's tab group when the target is the source's worktree, else in the target's active group
- **Question:** where the new tab lands
- **Options:** always the target's active group; the source's group
- **Chose:** the source's group when source and target share a worktree; otherwise the active group of the target worktree's workspace, since a tab group belongs to one workspace in Quirky. The new tab doesn't take focus from the source.
- **Why:** handoff.md "Starting and delivery" 6 (source's tab group); plugins/quirky.terminal/src/layout/types.ts (groups live in a workspace keyed by worktree)
- **Evidence:** as above
- **Reversibility:** easy
- **Confidence:** medium
- **Source:** assumed — autonomous

## D35: The brief is pasted after the agent's input is ready through `quirky.agents/deliver`, not passed on the command line
- **Question:** delivery mechanism
- **Options:** pass the brief as the launch prompt (argv for most agents); launch with no prompt, then the ready-gated bracketed paste plus Enter
- **Chose:** the paste. The agent starts with no prompt, then `deliver` waits for the agent's ready signal, pastes and submits.
- **Why:** parity with Orca's `submit-after-ready`; the delivery result gives the evidence the outcome needs (D36), and a resend uses the same path. Research found the 64-byte paste trap and late-paste duplicates in naive paste code; `deliver` already sends Enter as a separate write after a settle delay.
- **Evidence:** handoff.md line 171; plugins/quirky.agents/src/delivery.ts:45; docs/loop/decisions/m1-providers.md D21, D40
- **Reversibility:** medium
- **Confidence:** high
- **Source:** locked by handoff.md

## D36: The delivery outcome is delivered, not delivered or unobservable, with Orca's toasts and one automatic retry
- **Question:** delivery outcome and resend
- **Options:** as Orca
- **Chose:** delivered when `deliver` reports a paste after the ready signal, or the child's agent status turns working after launch; not delivered only on positive idle evidence (`deliver` reports not delivered and the child's agent status row is settled or absent while its hooks are installed); otherwise unobservable. Not delivered resends once automatically. Toasts: "The handoff brief was sent."; "The initial delivery failed, then Quirky resent the brief."; persistent "Brief delivery and the automatic retry failed." with "Resend brief"; persistent "Brief delivery could not be confirmed." with "Resend is manual because the target Agent does not expose delivery evidence." and "Resend brief", which asks "The brief may already have arrived. Sending again can create a duplicate turn." with "Send again" and "Cancel". Dismissing the toast discards the retained brief; a closed child drops it.
- **Why:** handoff.md "Starting and delivery" and the verified unobservable toast
- **Evidence:** handoff.md lines 177-186, 248
- **Reversibility:** easy
- **Confidence:** medium
- **Source:** locked by handoff.md

## D37: Toasts gain a kind, persistence and action buttons in the shell
- **Question:** the shell's toasts are info or error, auto-dismiss after 6 s, and have no actions
- **Options:** draw handoff's own toast stack; grow the shell toast
- **Chose:** grow the shell toast: kinds success and warning, a persistent flag, and action buttons that run a command with arguments; reachable from window plugins and daemon notify events, and listed in `ui.state` so a script can see and press them.
- **Why:** roadmap "API grows in the same milestone"; one toast stack for every plugin
- **Evidence:** packages/ui/src/lib/state.ts:10-17; packages/ui/src/plugins/host.ts:793
- **Reversibility:** medium
- **Confidence:** high
- **Source:** locked by docs/roadmap.md

## D38: Lineage is one record per handoff in the plugin's store, capped at 500
- **Question:** lineage storage
- **Options:** fields on the session record; one record per handoff with both ends
- **Chose:** one record `{id, createdAt, relationship, parent, child}` where each end is `{session, agent, providerSessionId, transcriptPath, worktreeId, title}` and the child also has its tab id. Oldest records drop past 500; bad rows are skipped on read. The child's provider session id is filled in once its agent status reports one, and never overwritten.
- **Why:** handoff.md "Lineage storage"; phase B research: per-link records hold a typed relationship and survive either end's deletion, where a parent field covers one relationship only
- **Evidence:** handoff.md lines 188-206
- **Reversibility:** medium
- **Confidence:** high
- **Source:** locked by handoff.md

## D39: A lineage write failure never fails the handoff
- **Question:** a store error after the tab opened
- **Options:** as Orca
- **Chose:** swallowed; the start result still succeeds
- **Why:** handoff.md "Edge cases"
- **Evidence:** handoff.md line 219
- **Reversibility:** easy
- **Confidence:** high
- **Source:** locked by handoff.md

## D40: Badges show on session tabs through a generic session badge, and the jump focuses the other end
- **Question:** where lineage shows, since Quirky has no agent rows on worktree cards and no dashboard
- **Options:** handoff draws into other plugins' views; a generic badge on the session record that the tab strips render
- **Chose:** a generic badge: a plugin sets a labelled badge with a tooltip and a command on a session, and the terminal tab strip and the session tabs draw it. Handoff sets "Handed off · <relationship>" on the source and "From handoff · <relationship>" on the child, each running `quirky.handoff/jump`. The jump focuses the other end's pane; with no live pane it says "No live pane is available.", and when the other end's worktree is gone it says "worktree removed".
- **Why:** handoff.md "Where lineage shows up"; the notifications precedent writes data that the owning plugin draws (m1-notifications D35)
- **Evidence:** plugins/quirky.notifications/src/service.ts:345-366; handoff.md line 208
- **Reversibility:** medium
- **Confidence:** medium
- **Source:** assumed — autonomous

## D41: The badge's jump must work
- **Question:** Orca's click on the source badge's arrow did nothing (handoff.md "Verified" 9)
- **Options:** copy; treat as a defect
- **Chose:** a defect; a test runs the jump from each end and expects the other end focused
- **Why:** the button exists to move there
- **Evidence:** handoff.md line 250
- **Reversibility:** easy
- **Confidence:** high
- **Source:** assumed — autonomous

## D42: Three built-in templates with Quirky-written bodies; Orca's catalog limits and normalization
- **Question:** template contents and rules
- **Options:** as Orca, with bodies written here because the doc gives only names
- **Chose:** "Continue implementation", "Review what was done", "Debug the failure" (ids `continue-implementation`, `review-completed-work`, `debug-failure`) with short bodies that use `{{gitStatus}}` and `{{changedPaths}}`. Names cut to 80, bodies to 8,000, at most 24, empty dropped, duplicate ids dropped, missing ids numbered. An absent catalog means built-ins; an empty one means none; reset clears back to absent. The first edit of an untouched catalog seeds it from the built-ins. A duplicate name only warns.
- **Why:** handoff.md "Template management", "Template storage and normalization"
- **Evidence:** handoff.md lines 51, 73, 212
- **Reversibility:** easy
- **Confidence:** medium
- **Source:** locked by handoff.md

## D43: "New Template" in the dialog saves the steering note
- **Question:** the dialog's template creation
- **Options:** as Orca
- **Chose:** as Orca: name up to 80, note non-empty and at most 8,000, fewer than 24 templates; with no template selected, the new one becomes selected and the note clears
- **Why:** handoff.md "Notes group"
- **Evidence:** handoff.md line 53
- **Reversibility:** easy
- **Confidence:** high
- **Source:** locked by handoff.md

## D44: The Session handoff page is a view opened by a command and listed in Settings
- **Question:** where template management lives
- **Options:** scalar settings; a view like Notifications'
- **Chose:** a view titled "Session handoff" with the subtitle "Create reusable instructions for continuing work in a new Agent session.", the list, "{count} of {limit} templates", "Add template", per-row edit and remove, and "Reset to defaults" (disabled until customised). Delete and reset confirm with "Delete “{name}”?" and "Reset handoff templates?". The editor has "Name", "Instructions" with a "0 / 8,000" counter and the variables hint.
- **Why:** handoff.md "Template management"; m1-notifications built its settings page the same way
- **Evidence:** plugins/quirky.notifications/src/ui.tsx:8-23
- **Reversibility:** easy
- **Confidence:** high
- **Source:** locked by handoff.md

## D45: Last agent, include toggles and last template live in the plugin store, written after a successful start
- **Question:** where preferences live
- **Options:** declared settings; the plugin store
- **Chose:** the plugin store; they are remembered choices, not settings a person edits. Written best-effort after a successful start; a last template that no longer exists reads as none.
- **Why:** handoff.md "Settings and defaults"; the Settings dialog would otherwise list internal state
- **Evidence:** handoff.md lines 79-86
- **Reversibility:** easy
- **Confidence:** high
- **Source:** assumed — autonomous

## D46: Drafts live in the daemon's memory, keyed by source, and Cancel and Escape both keep one
- **Question:** draft preservation
- **Options:** window memory (lost on reload, as Orca); daemon memory; the store
- **Chose:** daemon memory: closing without starting keeps the note, toggles, template, agent, target, relationship and, if detached, the edited text and stale reasons. Reopening restores them; a restored target is used only if it still resolves. A successful start clears the draft. Drafts vanish when the daemon restarts.
- **Why:** handoff.md "Edge cases" draft preservation; the daemon outlives a window reload, which keeps more than Orca does at no cost
- **Evidence:** handoff.md line 216
- **Reversibility:** easy
- **Confidence:** high
- **Source:** assumed — autonomous

## D47: Escape keeps the draft
- **Question:** Orca's Escape lost the note in one try (handoff.md "Verified" 11)
- **Options:** copy; treat as a defect
- **Chose:** a defect; a test closes with Escape and expects the note back
- **Why:** the doc says Escape and Cancel keep a draft
- **Evidence:** handoff.md lines 31, 252
- **Reversibility:** easy
- **Confidence:** high
- **Source:** assumed — autonomous

## D48: The scripting surface is the `quirky.handoff` methods and the `quirky handoff` command group
- **Question:** what scripts and agents can do
- **Options:** start only; every step the dialog takes
- **Chose:** methods to prepare (the dialog's open state and no-context check), preview (compose with warnings, cost and secrets), probe the transcript, start, resend, discard a retained brief, list lineage, jump, and list and change templates. The CLI group `handoff` has `preview`, `start`, `resend`, `lineage`, `jump` and `templates` (list, add, edit, rm, reset). The dialog and settings page are also driven by UI commands with reports, so `quirky ui state` shows what the window shows.
- **Why:** roadmap "Everything is scriptable"
- **Evidence:** docs/roadmap.md
- **Reversibility:** medium
- **Confidence:** high
- **Source:** locked by docs/roadmap.md

## D49: The source keeps running and is never written to
- **Question:** what happens to the source
- **Options:** as Orca
- **Chose:** the source session is only read (history, status, transcript). Nothing is typed into it.
- **Why:** handoff.md dialog description "The source stays running."
- **Evidence:** handoff.md line 9
- **Reversibility:** easy
- **Confidence:** high
- **Source:** locked by handoff.md

## D50: No native-only scenarios
- **Question:** which scenarios only the real window can show
- **Options:** list some; none
- **Chose:** none. The dialog, toasts, badges and settings page are webview content.
- **Why:** LOOP.md step 6 names window frame, menu bar, tray, banners, OS dialogs and focus; handoff uses none
- **Evidence:** docs/loop/LOOP.md step 6
- **Reversibility:** easy
- **Confidence:** high
- **Source:** assumed — autonomous

## D51: Spec review: fix all four Codex findings
- **Question:** what to do with the adversarial review of both specs (LOOP.md step 4)
- **Options:** fix each confirmed finding; record why not
- **Chose:** one `quirk:adversarial-review` run over `fa7e487..057438f` restricted to the spec directory with `--diff-file`, profile spec-design, depth deep, reviewer codex gpt-6.1-sol (independence full), criteria = roadmap "What the order rests on" and "When a milestone is done", LOOP.md steps 4 and 6, BRIEF.md's dropped list and handoff.md verbatim. Gate NEEDS_FIXES with 1 HIGH and 3 MEDIUM, 1 suppressed, none contested. Fixed: (SR1) a detached preview had no daemon call to analyze edited text, so `preview` takes `body` and returns secrets and cost for it; (SR2) a start failing after the worktree was created had no contract, so the error carries `worktreeCreated` and the dialog selects it with create mode off; (SR3) cancelling the resend confirmation could dismiss the persistent toast, so the action keeps it open and a successful resend replaces it by key; (SR4) badges and jumps were undefined for a session in several handoffs, so badges are keyed per lineage record and `jump` takes an optional lineage. The pre-pass could not run on a range (spec-design checks single files); a single-file pre-pass over logic.md reported only planned paths, example commands and secret-rule fragments, plus headings the writing-specs rubric doesn't require, rejected as m1-notifications D46 did.
- **Why:** LOOP.md: fix every confirmed finding or record why not
- **Evidence:** review bundle in the session scratchpad (sr1/SR-gate.json, sr1/SR-manifest.json); logic.md amendments
- **Reversibility:** easy
- **Confidence:** high
- **Source:** locked by docs/loop/LOOP.md

## D52: Build pairing is claude-task implementers with a codex reviewer
- **Question:** subagent-driven-development preflight backend pairing
- **Options:** claude-task + codex; claude-task + gemini; pi-codex + opus
- **Chose:** claude-task + codex (Sonnet implementers through Agent, reviews through pi-watch codex gpt-6.1-sol); codex and gemini both passed `pi-watch --check`. FULL_SUITE_CMD is `bun run test && bun test scripts && bun run typecheck`; the tree was clean on build/m3-handoff.
- **Why:** LOOP.md step 5 names this pair for a Claude Code lane
- **Evidence:** docs/loop/LOOP.md step 5
- **Reversibility:** easy
- **Confidence:** high
- **Source:** locked by docs/loop/LOOP.md

## D53: Wave 1 widened two tasks' scope to fixtures and a report model the contracts forced
- **Question:** K and M made `UiState.toasts` and `UiModel.menuItems` required, which broke typed fixtures outside their scope; B's tab report lives in `model.ts`, outside its scope
- **Options:** make the new fields optional (contradicts the contract); widen the scope to the exact files
- **Chose:** widen. The orchestrator added `toasts: []` to eight `UiState` fixtures (packages/cli/test/kernel-commands.test.ts, plugins/quirky.notifications/test/lookups, policy, unit), `menuItems: []` to packages/cli/test/fixtures/fake-daemon.ts and `menu-item` to the kinds list in packages/protocol/test/ui.test.ts; B's worker was given plugins/quirky.terminal/src/window/workspace/model.ts. No other component owned those files, so the partition stayed disjoint.
- **Why:** the contracts name the fields required; the edits are mechanical
- **Evidence:** session run journal
- **Reversibility:** easy
- **Confidence:** high
- **Source:** assumed — autonomous

## D54: Wave 1 choices the specs left open
- **Question:** small calls the implementers made
- **Options:** as listed
- **Chose:** a non-plugin caller of `setBadge` (the CLI) gets its client role as key prefix; a badge without a command is a plain chip that lets the tab click through; `newTab {activate:false}` into an empty group still gives that group an active tab (layout repair); an ambiguous Claude project scan returns verdict none with reason `ambiguous`, two files exactly 300,000 ms apart count as ambiguous, provider ids outside `[A-Za-z0-9._-]` are never looked up, a session-id lookup with several matches takes the newest; the `diff-truncated` warning reads "Some repository state was cut and will not travel in full."; diff bodies are plain `--- before`/`+++ after` text; a clean tree's changed-paths line reads "No repository changes were reported."; template substitution is single pass; clicking a toast body dismisses it (running `onDismiss`), except a persistent toast with no view to open, which ignores body clicks
- **Why:** each keeps Orca's observable behavior where the doc gives one and is the least surprising otherwise
- **Evidence:** plugins/quirky.handoff/src/core, src/daemon/probe.ts, packages/ui/src/components/Toasts.tsx
- **Reversibility:** easy
- **Confidence:** medium
- **Source:** assumed — autonomous

## D55: Wave 1 gate: host.test.ts failed on the remote runner and passes alone
- **Question:** the wave 1 full suite failed `packages/pty-host/test/host.test.ts` (alternate-screen read, kill process group timeout) twice on the remote host and `plugins/quirky.worktree/test/window-projects.test.ts` SC-10 once
- **Options:** treat as a regression; establish a flake by isolated reproduction
- **Chose:** pre-existing on the remote Linux host, not this item: wave 1 changed nothing in packages/pty-host or quirky.worktree; both files pass alone on this Mac (32/32, 18/18); on the untouched build/roadmap commit fa7e487 the remote run fails window-projects SC-10 again and host.test.ts fails 'reports alt when the alternate screen is active', and on this branch host.test.ts passed one of two remote runs alone. Checkpoint pre-passes use `bun run typecheck` and `bun test scripts` as ground truth, and the full suite is judged by its other 420 files.
- **Why:** SDD step 7 accepts a flake only with an isolated reproduction; iteration 4 saw the same pty-host files flake under the remote runner
- **Evidence:** session scratchpad gate1-test.log
- **Reversibility:** easy
- **Confidence:** medium
- **Revisit if:** host.test.ts fails on build/roadmap's own gate
- **Source:** assumed — autonomous

## D56: Wave 1 checkpoint: fix setBadge's envelope and the focused-window toast list; wave 2 started alongside
- **Question:** the wave 1 checkpoint review (SDD step 8) and whether wave 2 waits for it
- **Options:** fix each accepted finding; start wave 2 only after the fixes, or alongside with a narrowed scope
- **Chose:** three lenses (C, S, X) over `67a4224..166fb23`, depth standard, codex gpt-6.1-sol, pre-pass checks `bun run typecheck` and `bun test scripts` (D55). X passed; C and S both found `quirky.session/setBadge` returning a bare Session instead of `{session}` (C1/S1, accepted) and C found `ui.state.toasts` falling back to a background window when the focused one had never reported (C3, accepted). One fixer closed both; acceptance green. Wave 2's H1 was dispatched while the checkpoint ran, with the core and probe files removed from its scope so a fix there could not collide.
- **Why:** LOOP.md: fix every confirmed finding; the parallel start only overlapped on files the checkpoint could not touch
- **Evidence:** session scratchpad cp1/*-gate.json
- **Reversibility:** easy
- **Confidence:** high
- **Source:** assumed — autonomous

## D57: Wave 2 choices the specs left open
- **Question:** calls the daemon-service implementers made
- **Options:** as listed
- **Chose:** `prepare` takes one capture and later `preview` calls reuse it until `recapture` (the CLI always recaptures); `invalid-target` only for an explicit non-candidate worktree, a blank create name or a create on a non-git source, so an archived source with no worktree can preview; an archived source with no known worktree lists every workspace and can't create one; `quirky.editor/state` is read as `{documents: (string|{path})[]}` until m2-editor lands (D19); the secrets banner keeps Orca's "{count} potential secrets found." for every count; error kinds: `no-context` conflict, `no-brief` and `no-lineage` not-found, `invalid-target` invalid-params, every error with `data.reason`; delivery toasts carry the sentence as title and the second line as detail, kinds delivered success, resent warning, retry-failed error, unobservable warning; jump checks the worktree before the pane, so a gone child in a removed worktree reports "worktree removed"; pruning keeps the newest 500 valid records; SC-9 is amended because `quirky.worktree/create` suffixes a taken name instead of failing.
- **Why:** each keeps the logic spec's observable behavior; SC-9's example contradicted the worktree plugin
- **Evidence:** plugins/quirky.handoff/src/daemon; plugins/quirky.worktree/src/daemon/create.ts
- **Reversibility:** easy
- **Confidence:** medium
- **Source:** assumed — autonomous

## D58: Wave 2 checkpoint: six defects fixed
- **Question:** the wave 2 checkpoint review (SDD step 8)
- **Options:** fix each accepted finding
- **Chose:** three lenses over `bac2aea..d664cce`, depth standard, codex. Accepted all eight findings (six defects): Start without `--agent` lacked D15's first-agent fallback (C1/S1); a detached preview took `contextAvailable` from the discarded composition (C2/S2); delivery could miss a working event during its first status read, and a turn that started and ended before `deliver` returned read as unobservable (C3/X2); Start composed before creating the worktree (S3); a discard during the first delivery didn't stop the automatic retry (X1). One fixer closed them with a regression test each. The wave 2 suite had only the pre-existing remote SC-10 failure (D55); features-floating SC-55 failed once and passed alone.
- **Why:** LOOP.md: fix every confirmed finding
- **Evidence:** session scratchpad cp2/*-gate.json, gate2-test.log
- **Reversibility:** easy
- **Confidence:** high
- **Source:** assumed — autonomous

## D59: Wave 3 window choices
- **Question:** calls the window implementer made where the spec was silent
- **Options:** as listed
- **Chose:** the `set` command's field names are `worktree`, `create`, `createName`, `createBase`, `agent`, `relationship`, `context`, `repoState`, `diffBodies`, `openEditorTabs`, `template`, `templateName`, `note`; the report's `disabled` lists `start:<reason>` and `control:<name>` entries; the dialog opens only after `prepare` answers, so "Detecting Agents on the target host…" is unit-tested but never seen in the window; edit and remove show on every settings row; Escape (capture phase) first closes an open worktree list and does nothing while a start runs; `template-add`/`template-edit` take optional `name`, `body`, `save` so a script can save without typing; the preview editor has no undo history (only `@codemirror/state` and `@codemirror/view` were briefed), left for the final review.
- **Why:** each keeps the logic spec's observable behavior scriptable
- **Evidence:** plugins/quirky.handoff/src/window
- **Reversibility:** easy
- **Confidence:** medium
- **Source:** assumed — autonomous

## D60: Catch-up with build/roadmap merged cleanly and conflicts with no decision
- **Question:** LOOP.md step 5 catch-up before the final review
- **Options:** merge and reconcile
- **Chose:** merged build/roadmap at e7155ed (m2-source-control-notes-ai, fix-test-process-leaks, fix-sc31-first-shell-race, m2-sidebar-extras block) with no conflicts. `quirky.terminal/newTab` gained `extraArgs` alongside this item's `activate` and ids; both stand. Read the four decision logs: m2-source-control-notes-ai D26 (its diff and failure prompts aren't scanned for secrets) governs those prompts only, so handoff keeps D31; its D23 opens AI Fix tabs with the same ready-gated delivery this item uses; fix-test-process-leaks D4/D5/D11 scope test subprocesses and add an owned CLI launch that the UI pass uses.
- **Why:** LOOP.md "What is already decided": later decisions bind; none contradicts this item
- **Evidence:** docs/loop/decisions/m2-source-control-notes-ai.md, fix-test-process-leaks.md
- **Reversibility:** easy
- **Confidence:** high
- **Source:** assumed — autonomous

## D61: Final Round 1: four MEDIUM findings, all fixed in one batch
- **Question:** LOOP.md step 5's single final review round and fix batch
- **Options:** fix each accepted finding; append unclosed ones to BLOCKERS.md
- **Chose:** three lenses (C, S, X), depth deep, codex gpt-6.1-sol, over the item's non-test source diff against build/roadmap e7155ed (`--diff-file`, 60 files), criteria = logic.md and tech.md verbatim, pre-pass `bun run typecheck` and `bun test scripts`. Each lens NEEDS_FIXES, one MEDIUM finding apiece except X with two; none contested. Accepted and fixed, each with a regression test: (C2) editing the selected template left an attached preview unchanged and a detached one unmarked; (S2) a blank detached preview left Start enabled until the debounced analysis, and the daemon accepted a blank body; (X1) a failed draft save on Cancel or Escape closed the dialog and lost the edited text; (X3) a thrown `deliver` counted as positive non-delivery and could trigger a duplicate automatic resend. Nothing goes to BLOCKERS.md.
- **Why:** LOOP.md step 5
- **Evidence:** session scratchpad fr1/*-gate.json
- **Reversibility:** easy
- **Confidence:** high
- **Source:** locked by docs/loop/LOOP.md

## D62: The terminal's ui-model test checks only its own overlays
- **Question:** after the catch-up, `plugins/quirky.terminal/test/ui-model.test.ts` asserted that the whole built-in model has exactly one overlay, which the handoff dialog overlay breaks
- **Options:** narrow the assertion to the terminal's overlays, as the panels line above it already does; drop the handoff overlay
- **Chose:** narrow it (wave-gate test fix, SDD step 7)
- **Why:** the test is about the terminal plugin's declarations
- **Evidence:** plugins/quirky.terminal/test/ui-model.test.ts:100
- **Reversibility:** easy
- **Confidence:** high
- **Source:** assumed — autonomous


## D63: Complete the UI pass with a guarded continuation for draft scenarios
- **Question:** how to close LOOP.md step 6 after the first run exhausted SC-58's goal budget before SC-58/59 were complete
- **Options:** leave the draft scenarios incomplete; close the first run and continue the remaining goals in a fresh guarded run while retaining evidence and limitation-based partials
- **Chose:** close the first run and continue SC-58/59 in a fresh unattended web run. SC-58 and SC-59 pass in the continuation; earlier pass/partial outcomes remain in the first report, and its SC-58/59 partials are superseded by the continuation evidence without altering that report.
- **Why:** LOOP.md step 6 permits only tool-caused partials; it does not permit waiving app failures. SC-40 remains partial because the guarded driver offers no hover action to verify its tooltip. SC-50 remains partial because the supplied fake Codex fixture left its update screen before the slow headless action could dismiss it and did not expose the readiness signal; the UI showed “Brief delivery and the automatic retry failed,” so this is not an app-failure exemption.
- **Evidence:** first run reports: `.quirk/using-apps-like-a-user/runs/20261027T162430-b06b/report.md` and `.quirk/using-apps-like-a-user/runs/20261027T162430-b06b/report.json`; continuation reports: `.quirk/using-apps-like-a-user/runs/20261027T170628-054d/report.md` and `.quirk/using-apps-like-a-user/runs/20261027T170628-054d/report.json`. SC-58 restoration/isolation: continuation obs-15, obs-24 and obs-29; SC-59 focused Escape and restoration: obs-9–12. SC-40 tooltip limitation: first-run finding F3/obs-57. SC-50 fixture limitation and failed retry: first-run obs-69, obs-74–78.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** a driver with a guarded hover action or a Codex fixture that keeps its update menu open and exposes readiness becomes available
- **Source:** locked by docs/loop/LOOP.md

Cleanup: `m3-handoff-ui-daemon` stopped; `ps -p 10340,10398` returned no processes. Removed only the owned temporary fixture `/tmp/m3-handoff-ui.hzKLDo` and home `/var/folders/x5/07kj5yld16l9wd5p_v01h20c0000gp/T/quirky-test-home-WfNYyn`; absence checks succeeded. No product files changed.

## D64: Reconcile the resumed item with the latest integration decisions
- **Question:** whether decisions landed during this item's UI verification change handoff's contract
- **Options:** leave the earlier catch-up as sufficient; merge current `build/roadmap` and read every newly arrived decision log
- **Chose:** merged current `build/roadmap` cleanly and reviewed `m5-structured-runner.md`, `fix-ask-regex-budget-20261027.md`, and `sa-browser-agent.md`. No handoff contract changes are required. The structured runner's no-retry policy applies to native structured turns, and the browser plugin's no-implicit-retry policy applies to mutating browser operations; neither supersedes D36's single retry after positively identified non-delivery of a terminal handoff.
- **Why:** LOOP.md step 5 binds later decisions. Shared session launch now also carries structured-resume state, but handoff still creates a new terminal session through the public agent/session APIs. The regex fix preserves matching semantics and changes no handoff method.
- **Evidence:** the three named decision logs; clean `git merge build/roadmap`; post-merge `bun run build` exit 0
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** structured-session handoff is added to this item's scope
- **Source:** locked by docs/loop/LOOP.md

## D65: Do not classify a modal-blocked tab click as a broken lineage tab
- **Question:** whether continuation report F1's Codex-tab `NO_EFFECT` is an app defect
- **Options:** call the tab broken; inspect the screenshot's foreground modal before classifying it
- **Chose:** expected modal shielding, not a broken tab. The continuation's obs-4 shows the duplicate-turn confirmation open over the Codex pane and its background dimmed. The lineage jumps themselves passed SC-54 in the first run.
- **Why:** a background tab must not bypass an active confirmation; a driver's no-effect result alone does not establish a defect.
- **Evidence:** `.quirk/using-apps-like-a-user/runs/20261027T170628-054d/obs-4.png`; first-run SC-54 obs-82–83
- **Reversibility:** easy
- **Confidence:** high
- **Source:** assumed — autonomous

## D66: Correct the fake Codex fixture and prove SC-50 instead of waiving it
- **Question:** whether D63's fixture-caused SC-50 partial is an immutable tool limitation or repairable setup
- **Options:** retain the partial; construct a faithful fake composer that keeps its update screen open until a UI keypress and emits the normal readiness and working signals
- **Chose:** repair setup and rerun SC-50 in a fresh isolated owned daemon. SC-50 passes: the first attempt reports unconfirmed delivery; a UI Enter dismisses the update screen; Resend opens the duplicate-turn confirmation; Cancel preserves the toast; Send again delivers 865 characters and replaces it with “The handoff brief was sent.”
- **Why:** an incorrect fixture is actionable and cannot stand in for verification. This evidence supersedes D63's SC-50 partial. SC-40 alone retains its tooltip-only partial because the guarded driver has no hover action; marker/count/cost updates are visibly verified.
- **Evidence:** `.quirk/using-apps-like-a-user/runs/20261027T173817-02ae/report.md` and `report.json`, obs-8, obs-10–12, obs-14. Two superseded setup reports (`20261027T172345-3f31`, `20261027T172811-c428`) remain partial rather than being rewritten.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** the real Codex composer readiness contract changes
- **Source:** supersedes m3-handoff D63

Cleanup: the corrected run ended with no kept-open windows or cleanup errors. Its owned fixture, repository and home were removed; wrapper, daemon and PTY-host absence was checked. No product files changed.

## D67: Wait for the required remote suite without an arbitrary outer deadline
- **Question:** how to handle a post-catch-up suite invocation terminated by its external 3,600-second command deadline before the remote result
- **Options:** call the timeout a test failure or waive the suite; rerun the required command without an outer deadline and investigate the shared host
- **Chose:** rerun `bun run test` with no external command deadline. A read-only remote snapshot showed load averages 23.70 / 25.02 / 24.09, seven concurrent suite workers and an active land-priority marker. The retry was actively starting files. This proves contention, not a particular hung test or lane-owned orphan; no remote process was killed.
- **Why:** LOOP.md requires the remote suite result, not a deadline-based substitute. The timed-out invocation only reported the two macOS-only files passing, so it provides no remote pass/fail evidence.
- **Evidence:** timeout output from the first post-catch-up run; `scripts/suite.ts:174-195,223-245`; read-only remote snapshot identified the active retry as worker 1230277 under `runs/1793125040845-92034`
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** the suite reports a concrete failure or a safely attributable owned orphan is established
- **Source:** assumed — autonomous

## D68: Use the operator's night-mode verification gate before landing
- **Question:** how to proceed after the operator stopped the overloaded shared-host whole-suite run after more than two hours
- **Options:** start another whole-suite run; follow the operator's affected-package gate and let `queue.ts land` run the whole suite
- **Chose:** affected packages only: `bun scripts/suite.ts packages/cli packages/daemon packages/protocol packages/ui plugins/quirky.handoff plugins/quirky.notifications plugins/quirky.session plugins/quirky.terminal`, plus `bun test scripts` and `bun run typecheck`. These are handoff's implementation and consumer-test packages. No more pre-land whole-suite invocations.
- **Why:** the operator explicitly superseded the earlier full-suite gate for night mode and said the stopped run's failure is not a test result. Its shutdown output includes remote-directory removal and forced termination, so it is inconclusive and is not counted as a feature failure or pass.
- **Evidence:** operator message in this iteration; stopped command exit 137 after 8,243 seconds; affected-package inventory from this item's changes
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** the operator changes the night-mode gate
- **Source:** supersedes m3-handoff D67

## D69: Rerun the unchanged affected-package gate on the replacement test host
- **Question:** how to handle the operator stopping the affected-package run on the old host at load 35
- **Options:** use the stopped run's output; rerun the identical command on the operator-provided replacement host
- **Chose:** rerun the exact D68 affected-package command, unchanged. The operator said routing now targets an idle 16-core host.
- **Why:** the operator explicitly said the old-host result was not meaningful and instructed this rerun. No product change or test exclusion is involved.
- **Evidence:** operator message in this iteration; identical affected-package command invocation
- **Reversibility:** easy
- **Confidence:** high
- **Source:** assumed — autonomous

## D70: Investigate the provider-startup timeout without inventing a fix
- **Question:** whether the first replacement-host run's structured-resume timeout justifies changing provider startup or the test deadline
- **Options:** increase the deadline or change provider code speculatively; investigate the actual failing boundary and retain the existing behavior unless a cause is demonstrated
- **Chose:** investigate. The timeout was the initial provider-ID wait at `plugins/quirky.session/test/resume.test.ts:460`, before the test reaches its daemon-restart assertions. The unchanged file passed locally (23 tests), on the actual replacement host when run alone, and in the subsequent affected-package run. Failure-only diagnostics were temporarily added, produced no payload on the passing isolated remote run, and were removed. No production or permanent test change was made.
- **Why:** both providers' startup also passed standalone Linux arm64/amd64 daemon smokes with the existing fixture. Inspection found the generated Codex fixture is CommonJS and compatible with the host's Node 18 syntax; no Node-module-format defect was established. The initial timeout's cause remains undetermined, so neither a fix claim nor a speculative timeout increase is warranted.
- **Evidence:** initial replacement-host suite's first and isolated failure; local `bun test plugins/quirky.session/test/resume.test.ts` 23/23; replacement-host single-file suite `ok:true`; final affected-package suite `ok:true`
- **Reversibility:** easy
- **Confidence:** high for observed outcomes; low for an unestablished cause
- **Revisit if:** this exact initial provider-ID timeout recurs with diagnostic evidence
- **Source:** assumed — autonomous

## D71: The operator's night-mode gate passes with one explicitly reported suite flake
- **Question:** whether the item meets the operator's pre-land verification gate after completing UI verification
- **Options:** claim every first attempt passed; report the runner's actual result and leave the integration-wide gate to land
- **Chose:** the affected-package suite exits 0 for 242 remote files plus 2 macOS-only files. Its first pass had one terminal divider-sizing failure in `workspace-panes.test.ts`; the runner's isolated rerun passed all 11 tests and reported it in `flaky`. Scripts pass 49 tests, typecheck exits 0, and the post-catch-up UI/desktop build exits 0. Eleven selected UI scenarios pass; SC-40 has only the guarded hover-tool limitation documented in D63/D66.
- **Why:** this preserves the observed evidence rather than concealing a rerun. The operator explicitly assigned the whole-suite integration gate to `queue.ts land`.
- **Evidence:** affected-package `suite-result {"ok":true,"flaky":["plugins/quirky.terminal/test/e2e-ui/workspace-panes.test.ts"]}`; `bun test scripts && bun run typecheck` exit 0; `bun run build` exit 0; UI reports linked by D63 and D66
- **Reversibility:** easy
- **Confidence:** high
- **Source:** locked by docs/loop/LOOP.md

## D72: Remove a transient landing candidate captured by catch-up
- **Question:** why the landing retry sees M5 native-runner/checks source in the handoff branch but not in current integration
- **Options:** ship that source under the handoff item; drop the whole catch-up; remove only the accidentally captured candidate while retaining handoff and current integration
- **Chose:** the last option. Read-only ancestry/tree investigation established catch-up `b9eb60e` merged transient roadmap candidate `38a4f23` (the M5 structured-runner landing merge), which is not an ancestor of current `build/roadmap`. The M5 decision log says its source remains blocked, not landed. Reconcile the current merge, then reverse only that candidate's contribution, preserving the current M5 decision history and handoff's independent source.
- **Why:** one item must not accidentally ship another lane's blocked source. Reverting the entire catch-up would also discard legitimate integration changes, so that is rejected.
- **Evidence:** catch-up parents `fdaea04` and `38a4f23`; `38a4f23` first-parent diff lists 39 candidate paths; incoming `m5-structured-runner.md` D34/Progress; current roadmap lacks native Codex/checks implementation
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** M5 lands through its own queue item
- **Source:** locked by docs/loop/LOOP.md

## D73: Incoming evidence identifies the missing provider-fixture prerequisite
- **Question:** whether D70's undetermined initial provider-ID timeout now has independent environment evidence
- **Options:** retain only the local observations; incorporate the other lane's direct failing interpreter probe and host provisioning record
- **Chose:** incorporate incoming `m5-structured-runner.md` D33. That lane reproduced the fixture shebang failing with exit 127 because Node was absent on the replacement host, installed Node, and then passed the unchanged affected suite. Our later `/usr/bin/node` v18.19.1 check and passing isolated/final runs occurred after that provisioning.
- **Why:** this explains the environment repair without pretending this lane changed or fixed provider code. It also removes the apparent contradiction between the first failures and later passing diagnostics.
- **Evidence:** incoming M5 D33 and its resumed verification; this lane's SSH Node-version check and D70 results
- **Reversibility:** easy
- **Confidence:** high for the independently reproduced missing prerequisite
- **Source:** supersedes m3-handoff D70

## D74: Preserve the shipped name migration and append handoff badges after it
- **Question:** how to resolve the failed landing's independent session-name and handoff-badge additions
- **Options:** select one side; put both columns in the same existing migration; preserve integration's seventh `name` migration and add badges as the eighth
- **Chose:** preserve both session fields and use separate ordered migrations, name first and badges next. The existing migration regression now constructs the shipped named-session schema explicitly and verifies the upgrade preserves its name and permits persisted badge writes.
- **Why:** an existing store already at version 7 must still receive the new badges column; changing that old migration would skip the upgrade. The throwaway runtime smoke against pre-resolution `c4bc792` fails with `SQLiteError: no such column: badges`; the reconciled implementation preserves `name: reviewer` and persists the badge. Both the permanent test and smoke exercise session records, not source text.
- **Evidence:** `plugins/quirky.session/src/records.ts`, `test/badges.test.ts`; failing-before/passing-after migration smoke exit 0 and cleanup confirmed. LSP reported no available server; known-symbol lookup found `sessionMigrations` consumers in plugin activation and memory-store fixture.
- **Reversibility:** medium
- **Confidence:** high
- **Source:** locked by docs/loop/decisions/m1-agent-status-scripting.md

## D75: Review the new reconciliation with the available cross-family fallback
- **Question:** how to review this omp continuation's new merge resolution without repeating the already completed full-feature review
- **Options:** use the required Opus reviewer; fall back to the next available different-family reviewer; skip review
- **Chose:** Opus preflight reported no authenticated/shipping model, while Gemini resolved to `google/gemini-3.1-pro-preview:high`. Ran one read-only scoped review of the current-integration diff, session records and migration regression after removing the captured candidate. Reviewer returned `STATUS: PASS`, finding no merge/migration, naming/badge preservation, or unlanded-M5 leakage defect.
- **Why:** LOOP.md requires cross-family review for omp implementation and permits fallback when Opus is unreachable. The previous feature-wide final review remains complete; this pass covers only newly required reconciliation.
- **Evidence:** `pi-watch --check opus` exit 5; `pi-watch --check gemini` exit 0; `pi-watch --alias gemini --tools read,grep,find,ls --require-trailer STATUS ...` exit 0 / `STATUS: PASS`. Review's temporary diff directory was removed.
- **Reversibility:** easy
- **Confidence:** high
- **Source:** locked by docs/loop/LOOP.md

Candidate cleanup: reversed only `38a4f23`'s contribution, retaining the incoming complete M5 decision record and current integration. The checks plugin, native Codex runner, M5 structured-resume/ask-owner integrations, accidental M5 specs/docs claims and lockfile entry were removed. Handoff/session naming/status APIs remain. No active revert sequence or conflict remains.

## D76: Reconciled source passes the final affected-consumer gate
- **Question:** whether the candidate removal and shipped-schema migration resolution preserve handoff and the current integration contracts
- **Options:** rely on the earlier candidate-containing result; verify the reconciled source and leave whole-repo verification to queue landing
- **Chose:** the affected-consumer suite covering CLI, daemon, protocol, UI, handoff, notifications, session, terminal, ask, agents and structured plugins exits 0 for 297 remote files plus 2 macOS-only files. Shell-path and terminal divider-sizing files initially failed under parallel load, then passed the runner's isolated reruns; both remain explicitly reported as flaky. Scripts pass 62 tests, typecheck exits 0, and the UI/desktop packaged build exits 0 with 11 bundled plugins.
- **Why:** this exercises both the handoff consumers and the source restored by removal, rather than relying on verification of an unlanded candidate. The migration also has the failing-before/passing-after smoke in D74 and the independent scoped review in D75.
- **Evidence:** final affected suite `suite-result {"ok":true,"flaky":["packages/daemon/test/shell-path.test.ts","plugins/quirky.terminal/test/e2e-ui/workspace-panes.test.ts"]}`; `bun test scripts && bun run typecheck && bun run build` exit 0
- **Reversibility:** easy
- **Confidence:** high
- **Source:** locked by docs/loop/LOOP.md

## D77: Preserve landed account/hosting additions while reconciling handoff
- **Question:** how to resolve the second landing's conflicts with newly landed Accounts and Hosting
- **Options:** take either feature's side; preserve independent contributions and shared helpers
- **Chose:** union `status-bar`/`statusBars` with `menu-item`/`menuItems` in public kinds, schemas and validation; preserve both account-preparation and badge helpers in sessions; retain handoff and hosting lockfile entries. Removed the obsolete copied-constant/overlay assertions instead of re-pinning incidental lists. Read incoming account, hosting and worktree-flake decision logs.
- **Why:** these are additive public contracts, not competing implementations. Required account preparation remains before spawn; handoff still uses ready-gated delivery. Incoming integration history contains finish commits for the landed items, unlike the earlier transient M5 candidate.
- **Evidence:** merge `1e95ddb`; incoming `m3-accounts.md`, `m4-hosting-api-github.md`, `fix-flaky-quirky-worktree-window-projects.md`; scoped Gemini task-level review `STATUS: PASS`; pre-provenance-patch affected suite 293 remote files plus 2 macOS-only files passes
- **Reversibility:** easy
- **Confidence:** high
- **Source:** locked by docs/loop/decisions/m3-accounts.md

## D78: Use recorded source-home provenance without weakening transcript validation
- **Question:** how handoff can validate a source launched under the newly landed Accounts plugin's managed or custom provider home
- **Options:** accept arbitrary reported paths; use the daemon home regardless of the source; read the existing account-session provenance through a new public query
- **Chose:** declare `quirky.accounts/sessionHome({session}) -> {provider, home}` and `quirky accounts session-home --session <id>` as a read-only lookup of the recorded effective source home, not current selection or a new preparation. A missing record returns null fields. Handoff uses a matching provider's absolute recorded home for the existing probe; missing Accounts/no record keeps the existing daemon-root behavior. Extension, realpath and subtree checks remain intact.
- **Why:** [INFERENCE before regression] managed Codex histories and explicit custom homes are physically outside the daemon's native root; only managed Claude normally links history back. Accounts already records the source home privately, while `Session.launch.env` precedes account preparation and cannot establish the final root. A public query preserves the plugin boundary and avoids recomputing account identity or mutating transcripts.
- **Evidence:** `plugins/quirky.accounts/src/profiles.ts:233-300`, `src/service.ts:399-472,982-1006`; `plugins/quirky.handoff/src/daemon/service.ts:244-260`, `probe.ts:37-75`; contract commit `eb9366c`
- **Reversibility:** easy
- **Confidence:** high for the inspected data flow; runtime regression proof pending
- **Source:** supersedes m3-handoff D25 (recorded source-home selection only; candidate order and containment remain)

## D79: Preserve local script-gate failures as failures while diagnosing host pressure
- **Question:** whether the local script-gate timeouts justify changing assertions or test budgets
- **Options:** weaken the gate; attribute all errors to code without evidence; retain the failure and retry the unchanged gate in isolation
- **Chose:** retain the failure, record the environment snapshot, and run the unchanged `bun test scripts` separately. No protected script, assertion or timeout changes.
- **Why:** the failed run timed out across unrelated guardian and temporary-repository fixtures; subsequent ENOENT errors occurred after timed-out fixture cleanup. A snapshot measured Mac load averages 254.01 / 260.08 / 164.92 and 97% disk use. This proves substantial pressure, not the exact cause of every failure.
- **Evidence:** first post-additive-merge `bun test scripts` 48 pass/14 fail; `uptime`, `df -h .`, process-pressure snapshot; all scripts had passed 62 tests before this merge
- **Reversibility:** easy
- **Confidence:** high for recorded failures and environment; cause not yet established
- **Source:** assumed — autonomous

## D80: Prove and fix the recorded-home gap through public daemon consumers
- **Question:** whether the inspected account-home mismatch is observable, and whether the public-query fix preserves the trust boundary
- **Options:** keep the daemon-root assumption; weaken containment; implement the committed query and select only the recorded source root
- **Chose:** the public-query fix. Before implementation, the accounts regression fails with the unprovided method and three handoff regressions fail with `unverifiable/path-outside-known-roots` instead of usable for custom Claude, custom Codex and explicitly unset Codex. After implementation, all 34 account/handoff test files pass with no flakes.
- **Why:** the accounts service returns stored source provenance without preparing, switching or authenticating anything. Handoff overrides only a matching provider's root; missing method/no record preserves baseline behavior, operational lookup errors propagate, and malformed provenance cannot broaden trust. The managed-source regression also preserves the original home after selection changes.
- **Evidence:** RED two-file remote run; GREEN `bun scripts/suite.ts plugins/quirky.handoff plugins/quirky.accounts` (`ok:true`, 34 files); public RPC/CLI and daemon probe regressions; standalone daemon/API/CLI-module smoke prints “M3 session-home, CLI, stored-root probe, safe recovery, and outsider guard passed.”
- **Reversibility:** easy
- **Confidence:** high
- **Source:** supersedes m3-handoff D78 (runtime proof and completed implementation)

## D81: Reject the review's null-home finding against the recorded-home contract
- **Question:** whether the scoped Gemini review's sole finding—that an explicitly unset source must return `home:null`—describes a reachable valid result
- **Options:** accept null homes with a non-null provider; retain the effective-home contract after checking the producer
- **Chose:** retain the contract. `AccountsService.prepare` resolves an explicit null override with `unsetHome(provider)`, saves that absolute home through `saveSessionIdentity`, and returns a null environment patch only to clear the launched child's variable. `sessionHome` returns the saved absolute home; both fields are null only when no record exists.
- **Why:** the reviewer conflated the launch environment patch with persisted effective-home provenance. The explicit-unset daemon regression passes. Accepting a provider with a null home would instead weaken malformed-result handling; it is correctly unverifiable. No accepted blocking finding remains from this scoped review.
- **Evidence:** `plugins/quirky.accounts/src/service.ts:208-214,410-425,991`; `src/types.ts` account-session `home:string`; GREEN explicit-unset case; scoped Gemini output `STATUS: NEEDS_FIXES` with this single rejected finding
- **Reversibility:** easy
- **Confidence:** high
- **Source:** assumed — autonomous

## D82: Preserve the probe's safe candidate recovery and finish the runtime proof
- **Question:** whether reporting an outsider path must forbid recovery of a separately verified transcript for the same source
- **Options:** alter the existing probe chain; correct the throwaway smoke's assumption and retain the documented candidate order
- **Chose:** retain the chain. The first smoke recovered the legitimate in-root file by provider session ID rather than using the outsider. The corrected smoke verifies that safe recovery, then uses another source with no valid fallback and verifies outsider refusal. No production change was needed for this smoke correction.
- **Why:** D25 explicitly permits session-ID/history fallback after an unusable reported path. Rejecting a legitimate verified fallback would be a regression, not a security improvement.
- **Evidence:** first smoke's `candidate:session-id` and original valid path; corrected smoke exit 0; fresh typecheck exit 0 and packaged UI/desktop build exit 0 with 13 plugins; unchanged isolated script gate 62 pass/0 fail
- **Reversibility:** easy
- **Confidence:** high
- **Source:** locked by docs/quirk/specs/2026-10-27-m3-handoff/tech.md

Documentation: amended logic SC-25 and the dated amendment log first, then documented the public provenance query and root-selection contract in its sibling tech spec. Removed the throwaway smoke script after its cleanup completed. The read-only manifest metadata matches existing Accounts query conventions.

## Progress
The account/hosting catch-up is reconciled and committed (`1e95ddb`); both UI contribution kinds and session helper sets remain. The recorded-home compatibility fix is implemented after RED proof and passes all 34 account/handoff files, with managed/custom/unset roots, immutable source-home selection and containment covered (D80). Its scoped review's sole null-home finding is rejected with producer/runtime evidence (D81). Standalone API/CLI-module/probe smoke passes, including safe recovery and outsider refusal; temporary resources/script are removed (D82). Earlier additive affected suite passes 293 remote plus 2 macOS-only files; isolated scripts 62 pass; final typecheck and packaged build pass. Specs are amended; eleven handoff UI goals pass with only SC-40's documented hover-tool limitation. Next: commit this completed integration fix, detach and retry `queue.ts land m3-handoff`; no further feature flows or pre-land whole-suite run. Do not start another item.
