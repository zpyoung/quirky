# m3-terminal-dock decisions

## D1: Build the dock as an opt-in built-in plugin with its own composer
- **Question:** purpose, consumers, primary flow and ownership (brainstorming essential coverage)
- **Options:** reuse native chat; independent dock plugin using public APIs; hard-code a dock into the terminal kernel
- **Chose:** independent built-in plugin and independent composer, usable through the UI and schema-generated CLI/API; keep the terminal visible above it.
- **Why:** native chat was dropped; every feature must use the public plugin API and expose methods and commands.
- **Evidence:** docs/roadmap.md:175-177; docs/roadmap.md:19-40; terminal-dock.md “What the user can do”
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** the public pane-extension contract cannot express the feature
- **Source:** locked by docs/roadmap.md

## D2: Run unattended brainstorming and select every relevant gray area
- **Question:** visual companion, divergent discovery, gray-area selection and human approval (brainstorming workflow)
- **Options:** ask a person; apply LOOP.md autonomous defaults
- **Chose:** skip visual companion and adhd offer; select Visual layout-style, interaction-style, empty-state, error-state; API response-format/error-responses; CLI flag-design/output-format; Data error-handling/idempotency; Integration conflict-resolution/retry-policy/data-mapping. Record recommended answers without asks. Run context and option research.
- **Why:** nobody watches the lane; asking would block it permanently.
- **Evidence:** docs/loop/LOOP.md:175-200
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** the loop becomes supervised
- **Source:** locked by docs/loop/LOOP.md

## D3: Preserve macOS parity and do not reproduce the three observed Orca defects
- **Question:** success criteria, hard constraints and scope (brainstorming essential coverage)
- **Options:** basic textarea only; full in-scope terminal-dock flows minus documented defects
- **Chose:** require the feature document's supported-agent opt-in, auto/manual docking, composer editing/pickers/attachments/history, question cards, gutter geometry, passthrough, focus, state persistence and safe send paths. No false Codex delivery warning after positive evidence; no mobile-driver notice caused by local passthrough; no global Claude settings writes from effort controls. This records the parity obligation, not an approved reduced design; D8 identifies the unresolved dropped-dependency scope.
- **Why:** the roadmap requires feature parity without Orca defects and explicitly prohibits the effort side effect.
- **Evidence:** terminal-dock.md:17-25,100-111,131-137; docs/roadmap.md:27-28,175-177
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** prerequisite research demonstrates a locked feasibility conflict
- **Source:** locked by docs/roadmap.md

## D4: Bind omp OpenAI implementers to Gemini review after Opus proved unavailable
- **Question:** cross-family backend preflight (subagent-driven-development)
- **Options:** omp + opus; omp + gemini; same-family fallback
- **Chose:** IMPLEMENTER=omp task, AUTHOR_FAMILY=openai, REVIEWER_ALIAS=gemini. Opus was probed and unavailable; the next cross-family alias Gemini resolved and its actual read-only scope review exited 0. Spec review would still use Codex as LOOP.md requires. No implementation or final branch review was started.
- **Why:** `pi-watch --check opus` exited 5, no authed/shipping model. `pi-watch --check` resolved codex, terra, gemini and flash; Anthropic and Grok aliases did not resolve.
- **Evidence:** lane iteration 2 tool outputs; docs/loop/LOOP.md:99-106
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** a later actual Gemini dispatch fails
- **Source:** assumed — autonomous

## D5: Linux and Windows execution remain deferred
- **Question:** platform coverage (brainstorming hard constraints)
- **Options:** implement and test all platforms; macOS only and record other-platform work
- **Chose:** build/test on macOS; retain portable geometry, keyboard and PTY contracts where inexpensive. Windows ConPTY verification, key encodings and Linux/window-manager focus need later platform checks.
- **Why:** loop platform scope is locked.
- **Evidence:** docs/loop/LOOP.md:48-49; terminal-dock.md:85,110
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** Linux or Windows enters the supported build matrix
- **Source:** deferred: platform

## D6: Claude session-only picker controls avoid the global-settings defect
- **Question:** can the runtime effort/model picker satisfy roadmap M3 without editing global settings?
- **Options:** send `/effort <level>`; restart with launch flags; navigate the documented picker and confirm with `s`
- **Chose:** if implementation proceeds, use the session-only picker action and fail safely if the expected picker is not observable; never send a direct persistent effort/model command.
- **Why:** authoritative Claude documentation says Enter or a named `/effort` saves defaults, while `s` applies only to the current session (v2.1.257+). The installed CLI is 2.1.311 according to the scout's non-interactive version probe. An isolated `claude --help` invocation exited 0 and confirms `--effort` is a launch flag, not an in-place control API.
- **Evidence:** https://code.claude.com/docs/en/model-config#adjust-effort-level; https://code.claude.com/docs/en/model-config#setting-your-model; terminal-dock.md:134; docs/roadmap.md:175-177; isolated CLI help output in iteration 2
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** a supported Claude version lacks the session-only action
- **Source:** locked by docs/roadmap.md

## D7: Missing pane and send APIs alone are not reasons to block
- **Question:** do existing public API gaps prevent implementation (technical feasibility research)?
- **Options:** treat every missing API as a blocker; grow the API within this milestone; import private terminal/kernel internals
- **Chose:** API growth is allowed. A dock can be an embedded view via public `mountView`; the terminal plugin would own the host slot, focus and resize lifecycle. The daemon can own dock state and serialized sends. Acknowledged writes, attachment acquisition and transcript parsing require real implementation, not fake success or a private import.
- **Why:** the roadmap explicitly permits API growth and requires public-only built-ins. Existing cross-plugin structured-view embedding proves the placement pattern.
- **Evidence:** packages/protocol/src/ui.ts:225-231; plugins/quirky.terminal/src/window/workspace/PaneLayer.tsx:70-88; packages/protocol/src/plugins.ts:80-105; packages/daemon/src/plugins/pty-api.ts:118-123; docs/roadmap.md:29-30
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** a required capability cannot be implemented without violating a locked boundary
- **Source:** assumed — autonomous

## D8: Do not silently narrow parity or resurrect explicitly dropped subsystems
- **Question:** whether documented dock-local microphone, skill-selection and quarantine protections can be omitted under BRIEF's dropped-feature boundary
- **Options:** omit those documented behaviors; recreate the dropped capabilities under dock ownership; formally block for an exact scope ruling
- **Chose:** formally block before approving specifications. SSH/WSL implementation and telemetry may be non-goals; they are not the narrow blocking issue. Do not treat the standalone skill-catalog drop as permission to delete the dock-local picker.
- **Why:** Gemini's actual scope review recommended blocking. An independent OpenAI reviewer refined the ruling: earlier terminal-scope precedent and separation from user flows authorize remote/telemetry exclusions, but no binding exception authorizes omitting the microphone, dock-local skills or quarantine safety behavior. The complete dock queue item is not declared a narrower slice. Neither a reduced implementation nor resurrection of dropped capabilities is silently authorized.
- **Evidence:** BRIEF.md:67-69; terminal-dock.md:21,65-71,85,115-121; docs/roadmap.md:27-28,175-177; docs/loop/LOOP.md:40-49,87-96,195-197; docs/loop/decisions/m1-term-ui.md D5; Gemini scope review exited 0 and DockScopeReview completed in iteration 2
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** a source-authorized scope interpretation resolves the conflict
- **Source:** assumed — autonomous

## D9: Prefer daemon-authoritative state and a per-PTY send queue if scope is resolved
- **Question:** which implementation option best preserves fixed geometry, scriptability and safe multi-client sending (brainstorming option validation)?
- **Options:** renderer-owned state and mirrored sends; daemon-owned pane state plus embedded view and per-PTY queue; put all dock behavior into the terminal kernel
- **Chose:** recommended, not yet approved: daemon-owned revisioned dock state and serialized send lifecycle; terminal-plugin-owned pane host/focus/resize geometry; independently contributed composer view through `mountView`. Keep transient draft cursor/picker state local and bounded. Never auto-resend an uncertain prompt.
- **Why:** renderer queues cannot serialize another client's PTY writes; canonical renderer geometry conflicts with daemon-owned layout. Mount/row/drag edges, not text changes, should drive terminal resizes. Neither terminal write return nor transport acceptance proves TUI consumption; cancellation cannot retract bytes already written.
- **Evidence:** docs/roadmap.md:35-38; packages/protocol/src/ui.ts:225-231; packages/daemon/src/plugins/pty-api.ts:118-123; https://xtermjs.org/docs/api/terminal/classes/terminal/; https://invisible-island.net/xterm/ctlseqs/ctlseqs.html; https://www.gnu.org/software/bash/manual/html_node/Commands-For-Killing.html; DockPatterns, DockPitfalls, DockServerOption and DockRendererOption research in iteration 2
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** a public terminal-addon contract requires a different composition boundary
- **Source:** assumed — autonomous

## D10: Resume under the explicit dock-local scope ruling
- **Question:** whether D8 still blocks after the item was requeued
- **Options:** preserve the obsolete block; follow the user's recorded scope ruling
- **Chose:** exclude dictation and input-quarantine refusal; include slash commands and dock-local skill selection, without a standalone skills catalog. D8 is resolved by this binding ruling.
- **Why:** the integration branch records the user's 2026-10-27 ruling in BLOCKERS.md and amendments in roadmap M3. Merged build/roadmap before further design.
- **Evidence:** docs/roadmap.md:175-181; docs/loop/BLOCKERS.md m3-terminal-dock ruling
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** the scope source is amended again
- **Source:** supersedes m3-terminal-dock D8; locked by docs/roadmap.md

## D11: Adopt daemon authority and terminal-owned embedding
- **Question:** choose and approve conceptual model/data flow after D10 unblocked design
- **Options:** renderer-owned mirrored state; daemon-owned state with embedded view; terminal-kernel feature
- **Chose:** D9's daemon state, per-PTY serialized send and terminal-plugin-owned host. Self-review accepts logic.md's conceptual model, data flow, behavior and non-goals without a human pause.
- **Why:** only daemon authority serializes clients; public mountView supports independently replaceable UI.
- **Evidence:** packages/protocol/src/ui.ts:238-242; plugins/quirky.terminal/src/window/workspace/PaneLayer.tsx:70-88; logic.md
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** review finds an unexpressible host lifecycle
- **Source:** assumed — autonomous

## D12: Lock feature-document geometry, lifecycle and focus defaults
- **Question:** layout-style/interaction-style gray areas: placement, rows, drag, narrow panes, focus, mounting, passthrough, shortcuts and menu
- **Options:** content-growing composer; fixed feature-document gutter and thresholds
- **Chose:** 80+20*rows gutter, 3..15/default5 rows, 20 px drag steps/6 px handle; unmount below gutter+60/remount at gutter+100, frozen during drag; pane-scoped focus; shortcuts from terminal or composer; passthrough only while mounted, auto-exit on working-to-idle hooks/unmount/exit. Default-off/default-on auto-open; remember manual close, not exit. Kill switch hides/cancels without cleanup writes.
- **Why:** explicit feature flows, not implementation preferences.
- **Evidence:** terminal-dock.md:7-25,34-48,61,100-110; logic.md SC-01..SC-08
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** smoke shows threshold/focus regressions
- **Source:** locked by terminal-dock.md

## D13: Preserve editing through errors and expose every action as an API
- **Question:** empty/error states, API response/errors, CLI flags/output and conflict/retry gray areas
- **Options:** renderer-only edits and generic errors; shared schema methods with revisions and explicit states
- **Chose:** existing kernel JSON/text/error conventions; revision-checked drafts and independent pane mutations; visible picker loading/empty/error states without draft loss; same daemon actions for CLI/API/window; no automatic retry of accepted input. Cursor/picker highlight remains local.
- **Why:** roadmap requires scriptability; repeated sends duplicate agent work.
- **Evidence:** docs/roadmap.md:31-38; terminal-dock.md:65-85,108-109; logic.md SC-09..SC-13,SC-17..SC-23
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** transport needs a different stale-draft conflict representation
- **Source:** assumed — autonomous

## D14: Use bounded canonical persistence instead of competing stores
- **Question:** Data error-handling/idempotency and Integration sync-direction/data-mapping: authority, restart, corruption, caps, pruning, uploads
- **Options:** reproduce three Orca copies; daemon-owned records and revisioned UI projections
- **Chose:** daemon store, independent record validation, unsafe-key rejection, 64/tab retired-first pruning, 128 inactive scopes with mounted pinning, history 200 entries/200000 characters without consecutive duplicates. Retain pane identity on rehome/reconnect; prune real close. Acquire browser files under QUIRKY_HOME through public method, never fake browser paths.
- **Why:** architecture has one state owner; feature requires bounded caches and recoverable drafts.
- **Evidence:** terminal-dock.md:50-61,89-94; docs/architecture.md:61-82; logic.md SC-12,SC-13,SC-22
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** actual legacy Quirky dock data needs migration
- **Source:** assumed — autonomous

## D15: Use real provider evidence and refuse unsafe live controls
- **Question:** option sources, stale questions, delivery evidence and three Orca defects
- **Options:** transport acceptance as confirmation; actual provider/screen/status evidence with safe session-only actions
- **Chose:** actual question/permission parsing and agent-aware TUI answers; no normal sends while request active; session-only controls with unknown/unconfirmed feedback; Claude picker s action only when observable. Matching positive delivery evidence wins over stale recognizer. Unknown never auto-resends. Local passthrough is not mobile ownership. No global writes.
- **Why:** avoids all three feature-doc defects without fabricated confirmation.
- **Evidence:** terminal-dock.md:21-22,75-85,131-134; D6; logic.md SC-14..SC-21
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** provider changes invalidate observable session-only actions
- **Source:** locked by docs/roadmap.md; assumed — autonomous (evidence precedence)

## D16: Reuse prior research and refresh exact implementation anchors
- **Question:** repeated research and backend pairing after recovery
- **Options:** repeat every prior swarm; retain documented findings and refresh changed code
- **Chose:** retain completed patterns/pitfalls/three-option research in D6/D7/D9. Fresh backend/window and receipt/provider scouts map current source. Upstream adapter research confirms real formats/navigation. Fresh pi-watch check confirms OpenAI implementers + Gemini reviewer; Opus/Sonnet unavailable. Codex reviews combined specs as required.
- **Why:** ruling resolves the sole scope block without changing architecture; merge changed anchors.
- **Evidence:** DockBackendMap, DockWindowMap, DockReceiptMap, DockAdapterMap and DockUpstreamAdapters transcripts; pi-watch check; D4/D9
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** actual review dispatch fails
- **Source:** assumed — autonomous

## D17: Amend all seven substantive Codex specification findings
- **Question:** the required combined adversarial review of logic.md and tech.md
- **Options:** accept, reject or record each finding
- **Chose:** accept F1..F7: migrate palette chord (D18); require revision on empty clears; expose caller-known/discoverable queued IDs; specify concrete existing status and per-provider transcript sources; discriminate zero/possible write acceptance; persist recovery-only snapshots without replay; bound draft plus snapshots/separators together. Amend both specs before implementation.
- **Why:** each identifies materially divergent behavior or lost user input. The 34 deterministic reference reports are mostly planned new files, contribution IDs, package names and illustrative paths, not stale source. Corrected the one shortened existing harness path and the UI build discovery anchor; reject the remaining reference reports on those stated grounds.
- **Evidence:** /tmp/quirky-dock-lane9.HXFO4d/spec-review/gate.json and manifest.json; original target 2e990ab^..2e990ab, restricted to specs. NEEDS_FIXES: 3 HIGH, 38 MEDIUM including 34 reference reports; one suppressed, no advisory/limitation/question. Codex promote/refute high effort; Gemini tiebreak upheld F4. Same-family Codex independence reduced as required by LOOP.md's mandated spec reviewer.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** runtime reveals a missing data path or source mismatch
- **Source:** assumed — autonomous

## D18: Complete D30's anticipated palette contribution migration
- **Question:** F1 found exact dock Mod+Shift+P collides with kernel reservation; does API growth permit a legal cutover?
- **Options:** bypass reservation in capture; change dock chord; dual-dispatch; migrate palette command and binding into an overridable contribution
- **Chose:** migration. Add public setPalette capability and daemon layout/API; built-in quirky.palette declares its unconditional command/binding. Remove hard-coded interception/reservation and obsolete warnings. Normal conditional precedence gives the focused mounted dock passthrough and gives other contexts the palette, one action per press.
- **Why:** independent DockChordRuling found D30 explicitly anticipates overridable-contribution migration, and locked roadmap permits public API growth. Preserve m0-core D24's shell renderer. This completes the promised migration rather than adding a kernel-reservation exception.
- **Evidence:** docs/loop/decisions/m0-ui-api.md:301-305; m0-core D24; docs/roadmap.md:25-29; DockChordRuling transcript; tech.md Canonical dock service palette cutover
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** another binding needs a precedence rule not supplied by existing conditional dispatch
- **Source:** assumed — autonomous; completes m0-ui-api D30 transition, preserves m0-core D24

## D19: Baseline suite passes with two runner-confirmed load flakes
- **Question:** clean baseline before implementation and whether web validator is available
- **Options:** run tests here; use the prescribed remote runner
- **Chose:** bun run test through remote suite: exit 0 in 439.95s, 404/406 remote files passed first pass, all three macOS files passed; host alternate-screen read and terminal floating UI passed runner reruns alone. Typecheck exit 0. Web doctor ready with playwright-cli 0.1.22. No feature verification claimed.
- **Why:** establishes actual baseline without competing local full-suite execution. Existing per-file remote parallelism is retained; no config changes for a slow suite.
- **Evidence:** baseline bg_1 output, suite-result ok=true with two flaky paths; current typecheck and doctor outputs
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** a later gate repeats a failure outside load conditions
- **Source:** assumed — autonomous

## Progress
Step 4 complete: both specs authored, combined Codex adversarial pass completed, confirmed findings amended, design approved autonomously (D17/D18). Step 5 next: commit reviewed specs, set up six disjoint component worktrees (receipt, palette cutover, dock backend, provider/pickers/attachments, composer, terminal host), dispatch omp implementers, audit and run checks once after the wave, merge build/roadmap before final Gemini reviews, then smoke/API/UI verification and land. All research/review jobs have returned; no implementation yet.
