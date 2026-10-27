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

## D20: Build six disjoint components and validate their combined implementation before committing
- **Question:** execution decomposition, shared contracts and acceptance ownership
- **Options:** one broad worker; shared-file concurrent edits; six isolated components with frozen interfaces
- **Chose:** receipt, palette cutover, dock authority/send, provider/picker/attachments, composer, and terminal-host components; width cap six, no overlapping files or dependency demotions. Workers wrote tests but ran no checks or commits. The parent assembled audited source in a separate validation tree because the new plugin's modules must coexist for runtime checks.
- **Why:** this preserves single-file ownership without committing modules that were tested only against missing peer implementations.
- **Evidence:** scratch wave1.json, dispatch-snapshots.json, scopes.json, component-trees.json, barrier/fix audits; component commits 0b33e78,82c8deb,ba2cad6,372a044,b765926,18b2fa3
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** a new shared contract requires serial implementation
- **Source:** assumed — autonomous

## D21: Recover exact misplaced edits and preserve unattributed tooling state
- **Question:** the scope audit found wrong-worktree edits and unexpected metadata
- **Options:** ignore contamination; reset whole files; stop, attribute and move only the preserved edits
- **Chose:** stop the wave when relative edit headers changed thirteen main-lane tests/fakes. The worker identified its exact edits; the parent preserved a binary patch, checked forward application in its assigned tree and reverse application in main, then moved those hunks. Require absolute edit/write paths thereafter. Preserve unattributed .serena files in backend/layout trees and exclude them from explicit feature staging.
- **Why:** resetting files could discard user work. Tool metadata is not feature source and its provenance was not proved.
- **Evidence:** ownership-incident.md, palette-main-contamination.patch, external-artifacts.json; main diff returned empty and all component HEADs remained at their dispatch base
- **Reversibility:** easy
- **Confidence:** high for preserved source; metadata provenance unknown
- **Revisit if:** an actual out-of-scope source edit appears
- **Source:** assumed — autonomous

## D22: Repair observed failures at their source and keep verification claims bounded
- **Question:** initial acceptance found compiler and runtime failures, not a passing implementation
- **Options:** trust worker DONE reports; weaken tests; investigate and repair the demonstrated causes
- **Chose:** restore accidentally lost operation/record/pane fields; use the shell-ready fact instead of waiting for its stripped marker; fix actual React fixture events and dropped-file target; preserve pending remount focus and reuse the existing focused-controller registry for transient body focus after a menu closes. Correct fixture-only plain-sh readiness, floating selector, OS-focus and selection-count assumptions. Delete incidental wording/key-list pins.
- **Why:** missing history caused records to be rejected; missing pane context/session IDs broke real rendering. The focus failure was reproduced and traced through a throwaway actual-window diagnostic before changing its ownership guard.
- **Evidence:** acceptance-failures.md, fix1..fix8 audits/patches; targeted commands observed K12,Z4,B8,P38,U14,H5 passing at their accepted source versions; TypeScript clean after repairs. Actual CLI/PTY smoke observed PONG, observed-cleared, empty draft, rows7/manual-close across daemon restart and owned-home removal.
- **Reversibility:** medium
- **Confidence:** high for exercised paths, not whole-suite completion
- **Revisit if:** the integrated suite or actual web surface exposes another defect
- **Source:** assumed — autonomous

## D23: Route non-UI passthrough through its real window owner and publish valid state schemas
- **Question:** plugin validation found namespaced scripting and schema defects
- **Options:** allow CLI to fabricate UI reports; special-case only the CLI; route the whole canonical request through a declared window command
- **Chose:** add command:quirky.terminal-dock/set with the canonical set arguments. A non-UI passthrough mutation routes through ui.command.run before any mutation; the UI connection then passes the original mounted/focused/active-window checks. Preserve absolute true/false and composite mutation behavior. Declare populated nullable DockState/nested result and event objects, not closed empty objects.
- **Why:** CLI and direct API must drive the same window action. The repository's schema dialect rejects extra fields in a bare object schema even though the dispatcher does not currently validate results.
- **Evidence:** DockPluginValidation findings; 9c92187; CLI regression two tests/eighteen assertions passing in its own real-window test file; actual result/event schema regression passing; typecheck and packaged build passed in the contracts tree
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** window-targeted operations need a public explicit-window selector
- **Source:** assumed — autonomous

## D24: Keep default editor space and above-dock overlays without inventing selected models
- **Question:** early guarded web smoke found inaccessible default-height editing and misleading option display
- **Options:** increase the default gutter; leave the editor hidden behind chrome; compact fixed chrome and position overlays outside it
- **Chose:** retain five rows/180px, combine controls into one bounded footer, keep full reasons accessible without wrapping away editor space, and place picker/question overlays above the composer within pane bounds. Include reported native values in select options so the browser cannot display first-choice Fable when the actual model is claude-haiku-4-5. Match advertised Claude family aliases conservatively for capability lookup while retaining the raw reported identity.
- **Why:** enlarging the gutter would hide the defect and break locked geometry. Haiku's advertised options are empty; Sonnet/Fable/Opus advertise effort, so no effort is invented for Haiku.
- **Evidence:** web run 20261027T180029-52a7 obs-10/26 and findings F1-F3; owned API model snapshot and claude-catalog.json; 03dcb20,d8b54ff; UI sixteen tests and provider thirty-two tests passed separately, combined typecheck/build passed
- **Reversibility:** easy
- **Confidence:** high for source/unit evidence; real layout rerun still required
- **Revisit if:** the new web run finds editor or overlay clipping
- **Source:** locked by terminal-dock.md geometry/placement; assumed — autonomous (compact arrangement)

## D25: Recognize all catalog terminal agents, not only the eight transcript adapters
- **Question:** source investigation found a documented recognition flow missing from the first implementation
- **Options:** limit docks to managed transcript-agent launches; falsely change canonical session.agent; project recognized identity from public catalog/status/title evidence
- **Chose:** implement public-catalog support without a separate dock allow-list. Use known live hook/program identity, managed launch metadata, strict verified branded titles, then the requested-dock latch; keep canonical session ownership unchanged. Other terminal CLIs use the input/unobservable tier. Preserve manual-close, transient-loss, confirmed-exit/relaunch and disabled-write invariants.
- **Why:** the feature explicitly includes live-status/title recognition and any TuiAgent. Existing session metadata remains shell for manually started CLIs; title status classification alone supplies no agent identity.
- **Evidence:** DockRecognitionScout; terminal-dock.md:18-19,60; service.ts original supported/reconcile paths; public PluginPty title/facts/list and quirky.agents/list; isolated DockRecognitionImpl is implementing and testing this requirement
- **Reversibility:** medium
- **Confidence:** high for requirement/gap; implementation acceptance pending
- **Revisit if:** title evidence is ambiguous or a stale identity reopens an exited agent
- **Source:** locked by terminal-dock.md

## D26: Exercise the two delivery/settings defects through real daemon APIs and PTYs
- **Question:** direct bridge tests did not alone satisfy the roadmap's public-flow proof
- **Options:** rely only on module tests; add consumer-visible public API regressions
- **Chose:** actual private-HOME fake Codex consumes Enter, writes a matching rollout and displays PONG with stale composer evidence; the public send must not restore a duplicate. Actual private-HOME fake Claude's live picker treats persistent commands/default-saving Enter as a settings side effect, while s changes only its session; public options must confirm Low and preserve sentinel bytes/draft.
- **Why:** these tests catch the documented consumer-visible regressions across service serialization, provider observation and real child input, not just forwarding.
- **Evidence:** 90e1f83; defects.e2e.test.ts two tests/twenty-six assertions passed; full typecheck passed. An unnecessary Claude hooksRemove setup was removed because Claude hooks are per-launch, not in the file-installer registry.
- **Reversibility:** easy
- **Confidence:** high for the deterministic API/PTY paths
- **Revisit if:** provider wire formats or session-only actions change
- **Source:** locked by docs/roadmap.md acceptance

## D27: Bound and own verification without changing the shared runner
- **Question:** an outer timeout interrupted the first required full-suite attempt
- **Options:** call the incomplete run passing; kill shared host jobs; alter protected runner/config; preserve evidence and use an owned streaming wrapper
- **Chose:** record no suite outcome from the initial 3600-second outer timeout. Exact local command scan found no surviving matching runner; unrelated PIDs were not killed. A new external wrapper uses the landed ProcessScope guardian, streams logs from command start, retains SSH HOME, gives each command an explicit bounded lifetime and records actual exit/results. Keep the prescribed remote suite and its isolated-rerun policy unchanged.
- **Why:** captured-in-memory logs were lost when the outer process died. Read-only host probes showed four live other-run test holders with turnover, not stale locks or proof this item's tests failed.
- **Evidence:** gate-initial empty; DockGateTimeoutScout and targeted process fingerprints; run-owned-gate.ts, gate-owned logs/record; fix-test-process-leaks decisions
- **Reversibility:** easy
- **Confidence:** high for observed timeout/ownership facts; full-suite result pending
- **Revisit if:** a concrete failing file or owned-run deadline supplies new evidence
- **Source:** locked by docs/loop/LOOP.md test routing; assumed — autonomous (external ownership wrapper)

## D28: Preserve the browser chooser limitation and hand its OS dialog to native verification
- **Question:** the web driver's file chooser stopped later UI goals
- **Options:** bypass Attach with an API and claim a UI pass; repeat the known modal failure; record partial and verify remaining goals in a fresh owned scene
- **Chose:** preserve the guarded report and its attachment partial; do not call unperformed later goals passing. Close only the owned browser session after end reported cleanup failure. Add the run-created-file OS chooser/chip flow as pending native scenario and run remaining web goals without reopening that chooser.
- **Why:** browser_snapshot and Escape both returned that the tool does not handle the modal state. The app's native chooser was opened, but no chip was observed; this is not attachment success.
- **Evidence:** web run 20261027T180029-52a7 report, obs-54/F4; owned browser close succeeded; docs/loop/native/m3-terminal-dock.json; new seven-goal rerun in progress
- **Reversibility:** easy
- **Confidence:** high for tool limitation; native scenario remains pending
- **Revisit if:** the guarded driver gains file-chooser support or native verification finds an app defect
- **Source:** locked by docs/loop/LOOP.md native/tool-limitation handling

## D29: Record and contain the accidental default-profile diagnostic
- **Question:** one diagnostic CLI call omitted its temporary HOME binding
- **Options:** hide the mistake; reset unknown user files; attribute only owned processes and preserve profile data
- **Chose:** disclose the isolation failure. The read-only dock get returned not-found but autostarted the default ~/.quirky daemon from the unique contracts worktree at 2026-10-27T18:19:27.917Z. Verify PID/start/command fingerprints, gracefully stop only daemon10234 and its owned empty PTY host10238, and leave default profile data/logs in place because there is no before image. Bind every later diagnostic to explicit owned runtime metadata.
- **Why:** deleting or reverting unknown user data would compound the mistake. No mutating RPC was requested, but startup can initialize/migrate profile state; therefore do not claim the real home was untouched.
- **Evidence:** default-daemon-incident.json, default-host-incident.json and identity-checked SIGTERM results in scratch; host had zero child processes. Metadata-only checks show Claude settings and Codex config/hooks mtime/ctime predate the incident; no token/settings contents were printed, and no byte-identical baseline claim is made.
- **Reversibility:** medium for startup metadata; process lifetime contained
- **Confidence:** high for ownership/cleanup facts; previous profile contents unknown
- **Revisit if:** the operator finds an unexpected default-profile change requiring comparison with their own backup
- **Source:** assumed — autonomous (incident containment, not authorization to touch normal profiles)

## D30: Review the complete item diff against the caught-up integration baseline
- **Question:** fixed final-review scope after merging unrelated lane implementations
- **Options:** include unrelated imported features as this item's work; hide selected item files; review all item source/tests/callers relative to the caught-up roadmap
- **Chose:** fix the code-review campaign baseline before the first review to the caught-up roadmap merge-base; exclude docs and the generated lockfile explicitly, retain every item code/test/callsite change, and use three deep Gemini lenses with shared deterministic prepass. No review has started before the required green gate.
- **Why:** the original execution base predates incoming notes/AI and independent repairs; including their implementations would misattribute unrelated findings. This is not a re-scope after findings.
- **Evidence:** final-review-input.json and final-item.diff staging; initial caught-up baseline deae391c60ba3a66c64d1a92fe7ba9d94d95e049; incoming decision logs read for all six imported items
- **Reversibility:** easy before review; campaign scope stays fixed once dispatched
- **Confidence:** high
- **Revisit if:** another integration catch-up occurs before the review begins
- **Source:** assumed — autonomous

## D31: Accept catalog/manual recognition after actual daemon/PTy regression
- **Question:** whether the formerly managed-only support gate now satisfies the recognized-agent core flow
- **Options:** accept worker text; exercise the actual public methods and child input; retain the unsupported restriction
- **Chose:** accept ea31259 after the real recognition E2E passed two tests/twenty-two assertions and full typecheck passed. The generic disabled-Gemini case consumed PTY bytes; the manual Claude case preserved canonical shell identity, manual-close/draft latch, confirmed command-finished exit and fresh relaunch.
- **Why:** first execution exposed a duplicate local declaration; after the narrow rename, execution exposed missing Claude Code native-brand evidence. Fixed the shared title/app alias only when Claude exists in the effective catalog and corrected hook-versus-program/title provenance. Neither failing run was called passing.
- **Evidence:** recognition.e2e.test.ts; ea31259; parent command outputs; separate hook lead.ended/whole-PTY assertions are explicitly listed as unfinished in BLOCKERS.md
- **Reversibility:** medium
- **Confidence:** high for exercised public flows
- **Revisit if:** another native brand is ambiguous or a stale signal reopens an exited foreground agent
- **Source:** supersedes m3-terminal-dock D25 implementation-pending status

## D32: Preserve the second guarded web report and its incomplete flows
- **Question:** how to report actual browser results without replacing failed/unattempted actions with API evidence
- **Options:** call the report broadly passing; hide findings; preserve exact observed successes and open flows
- **Chose:** report default-five-row editing/current model/PONG, above-composer slash/file pickers, draft hide/show, independent split drafts, and qualitative short-pane hide/growth restoration as observed. Keep the report's option/card/focus failures, unmeasured geometry, incomplete shell-pane menu, unattempted Stop/final-settings goals and native acquisition limitations open.
- **Why:** visible Low safely refused; card buttons were occluded despite actual-terminal answering; Settings re-enable restored drafts but left focus null. These are not complete acceptance passes. The private settings sentinel remained unchanged. Closed only owned browser 20261027T190614-d4f8 and stopped the owned fixture.
- **Evidence:** .quirk/using-apps-like-a-user/runs/20261027T190614-d4f8/report.md and report.json; corresponding screenshots; privateSettingsSentinelUnchanged:true in parent diagnostic; BLOCKERS.md open review findings
- **Reversibility:** easy
- **Confidence:** high for recorded observations; no pass for unperformed goals
- **Revisit if:** the dependent completion item obtains new runtime evidence
- **Source:** assumed — autonomous (evidence reporting); operator-authorized deferred delivery in D33

## D33: Follow the operator's deadline and explicitly defer nonblocking flows
- **Question:** operator interjection requires this item to land within the next hour and limits fixes to blocking core-flow findings
- **Options:** continue the original full-flow/full-suite preflight; silently omit work; land the exercised core with explicit dependent completion work
- **Chose:** stop the owned superseded whole-suite preflight without claiming a result. Run bun test scripts, bun run typecheck and bun scripts/suite.ts over affected package/plugin directories; queue land runs the full suite. Catch up build/roadmap once before land. Record nonblocking findings in BLOCKERS.md and add fix-terminal-dock-unfinished-flows-20261027 depending on this item before landing. Full specs remain the follow-up acceptance contract, not a statement that unfinished UI flows passed.
- **Why:** this is explicit user approval to reduce this delivery slice, not an autonomous waiver. Safe sending, draft retention, public API/CLI ownership, default usable composer, picker and persisted/manual lifecycle core flows have direct runtime evidence. Deferred option/card/settings/interruption/acquisition/measurement flows and missing lifecycle-signal assertions are named individually in the dependent item.
- **Evidence:** operator message in this iteration; scratch follow-up.json; BLOCKERS.md; scoped gate and final review records to be appended from actual results
- **Reversibility:** medium
- **Confidence:** high for the instruction; final validation/landing still pending
- **Revisit if:** a finding blocks safe core sending, loses drafts or writes global settings
- **Source:** supersedes m3-terminal-dock D30 green-full-preflight sequencing and original all-flow delivery requirement, by explicit operator decision

## D34: Complete one final review round and preserve its transport and evidence limits
- **Question:** final review dispatches encountered oversized-prompt and response-schema failures
- **Options:** infer passes from failed/empty calls; drop code scope; recover the same full-scope chains and record every limit
- **Chose:** keep the campaign target deae391c60ba3a66c64d1a92fe7ba9d94d95e049..76ef0a32cc1e00ef3b876f942567a2095bac75d8 and complete three deep lenses. X Gemini PASS with zero findings; C Gemini PASS with one mechanically suppressed HIGH proposal C1; S Google Flash fallback PASS with zero findings. Both reviewer models are Google, independent of OpenAI implementation. No second discovery round and no confirmed core-blocking fix batch.
- **Why:** direct 881.6KB prompts failed with Maximum call stack size exceeded. Full unchanged file-backed prompts resolved transport; no artifact was omitted. S Gemini returned no JSON twice, so its same-chain recovery used reachable gemini-flash-latest. C's saved promote omitted stage: normalized only that provenance to promote, retained its original claim/evidence, then ran fresh refute and gate. C1 was dropped for a stale citation, not semantically disproved; record it open rather than apply an unproven native command change.
- **Evidence:** scratch final-X-transport/{gate,manifest}.json; final-C-transport-recovery/{normalized-findings,gate,manifest}.json and refute.raw; final-S-flash/{gate,manifest}.json. Initial failed artifacts retained. S metadata says medium while actual dispatch stderr says high; both facts retained. Shared prepass reused actual scripts49pass/223assertions and clean typecheck; affected remote tests run concurrently and are not represented as complete by this review.
- **Reversibility:** easy for an eventual evidence-backed option fix
- **Confidence:** high for actual review dispatch/gate facts; native C1 behavior unresolved
- **Revisit if:** a real native session proves the current opener cannot expose effort or a global write occurs
- **Source:** assumed — autonomous (same-round recovery); locked by operator D33 (nonblocking findings remain open)

## D35: Fix the confirmed fresh-plugin public-import blocker
- **Question:** the incoming structured-runner log described an integration typecheck failure when new plugins lacked generated local dependency links
- **Options:** depend on an install step the land does not run; add per-plugin/private import workarounds; map the two existing public exports to their canonical source entries
- **Chose:** add exactly @quirky/protocol and @quirky/protocol/node paths in root tsconfig, matching public package exports and m5-structured-runner D25. No wildcard/private alias, suppression, API change or runtime fallback.
- **Why:** a throwaway real TypeScript resolver smoke hid only the two new plugins' generated node_modules links. Before the fix all four public resolutions were null; afterward they resolved to the existing public index files. This is a blocking clean-integration prerequisite, not an optional feature.
- **Evidence:** packages/protocol/package.json:6-8; check-fresh-resolution.ts red/green output; full typecheck exit0; actual public daemon/PTy defects.e2e.test.ts rerun2pass/26assertions after mapping. The affected remote suite uses unchanged business code; the wrapper's final build will consume the mapping. No permanent source-text/wiring test was added.
- **Reversibility:** easy
- **Confidence:** high for exercised resolution and public runtime flows
- **Revisit if:** the package's public export entries change
- **Source:** locked by m5-structured-runner D25 public-entry contract; assumed — autonomous (observed blocker repair)

## D36: Register the explicit follow-up without bypassing the shared queue lock
- **Question:** the required follow-up transaction waited behind shared maintenance
- **Options:** edit shared queue/index or kill the owner; attribute the contention and retry the supported command
- **Chose:** leave PID61380 and its merge untouched. Retry queue.ts add with the same external JSON. The final attempt exited0, registering fix-terminal-dock-unfinished-flows-20261027 with dependency m3-terminal-dock before landing.
- **Why:** the first short outer attempt timed out; the next reported the shared lock held over30minutes. Exact process attribution showed queue.ts merge build-loop/faster-lands, not a dead lock. No other lane or operator process was signaled and no terminal draft was overwritten.
- **Evidence:** bg36 outer timeout; bg37 lock timeout; ps/lsof attribution; bg50 queue.ts add exit0 in11.43seconds; scratch follow-up.json names deferred flows/reasons
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** queue landing reports a dependency or item-state conflict
- **Source:** locked by operator D33 follow-up requirement; docs/loop/LOOP.md shared-file ownership

## D37: Rerun the exact affected suite on the operator's replacement host
- **Question:** operator stopped the run on the overloaded old host and declared its result meaningless
- **Options:** classify the interrupted output as a verdict; repeat the required command on the replacement host
- **Chose:** retain no suite verdict from the stopped old-host run (exit137). Rerun the exact affected-directory command through the unchanged runner on the newly configured16-core host, then run the packaged build. Reuse completed scripts/typecheck evidence rather than run another whole preflight.
- **Why:** the operator supplies the infrastructure observation. Source inspection also found one obsolete G1 test pinning the removed kernel-reserved Mod+Shift+P behavior; deleted that obsolete case rather than re-pin implementation details. The actual public-palette/shortcut behavior is covered by the migrated contract and existing keybinding/UI scenarios.
- **Evidence:** operator message; gate-core logs preserve the interrupted run, not a pass/fail suite judgment; plugin-host.test.ts removed only the obsolete kernel-reservation case; gate-new-host runs the same eight directory arguments
- **Reversibility:** easy
- **Confidence:** high for stopped-run/source-contract facts; new host result pending
- **Revisit if:** the replacement host reports a concrete failing core path
- **Source:** operator decision in this iteration; supersedes D27/D33 old-host pending-run status

## D38: Repair only the concrete replacement-host gate blockers
- **Question:** replacement-host run completed with four remote failing files and one macOS reset-case failure
- **Options:** label failures flakes without proof; weaken resize/reset invariants; repair fit scheduling and remove obsolete/incidental pins
- **Chose:** restore local xterm fitting during a divider drag while retaining suppressed PTY resize RPCs; synchronously fit and flush final geometry once on drag end with existing sent-size deduplication. Remove the obsolete reserved-P fixture from the meaningful distro-precedence test and delete the incidental CLI whole-output-copy test. Make reset wait for shell/rendered sentinels and assert retained user content/modes rather than exact equality against an asynchronously arriving normal prompt.
- **Why:** paused fit had incorrectly blocked both viewport fitting and the final observed update. Reset's mismatch was the ordinary shell prompt, not lost content. No arbitrary sleeps, timeout increases, ignored failures or replacement golden-output pin were introduced.
- **Evidence:** replacement run208remote/204initialpass/4fail plus SC-34 macOS failure; after fixes the exact four failed remote files and macOS features-pane file all passed, suite-result ok:true/flaky:[] (42.98seconds). Full typecheck and packaged build passed (42.60seconds),9 UI modules/12 plugins. Build retains optional icon/release-URL warnings. Complete208-file post-fix preflight is not claimed; queue land provides authoritative integration validation.
- **Reversibility:** easy
- **Confidence:** high for repaired runtime/test paths; focused built-web resize smoke is running
- **Revisit if:** final user-surface resize proof or land exposes a core regression
- **Source:** assumed — autonomous (observed gate blockers); operator D33 fixes-only scope

## D39: Perform the single final catch-up and preserve incoming status/PTY ownership
- **Question:** operator requires one integration catch-up immediately before landing
- **Options:** repeat discovery or rebase; merge build/roadmap once and check the actual shared seams
- **Chose:** one final merge after the repaired-path gates. Read the imported updated LOOP and complete m1-agent-status-scripting, m5-ledger and m5-structured-runner logs. Preserve script-rule-versus-status-dot separation, authenticated provenance, blocked-rule precedence, bounded killable matchers, public plugin calls and acknowledged-write certainty. No private cross-plugin imports or canonical session identity rewrite.
- **Why:** shared PTY/protocol files auto-merged; read-only seam inspection found no confirmed receipt conflict. Post-merge full typecheck exited0. M5 logs preserve their own blocked/partial outcomes and are not proof those products shipped. Imported night mode supersedes older full-preflight sequencing; do not edit its protected files.
- **Evidence:** final merge output; DockFinalCatchupContracts read all three logs and public writeAccepted chain; post-merge typecheck exit0 in54.19seconds; docs/loop/LOOP.md:56-83
- **Reversibility:** medium
- **Confidence:** high for checked type/receipt seams
- **Revisit if:** land reports a concrete merge-result regression
- **Source:** locked by imported decision logs and operator single-catch-up instruction

## D40: Keep the unfinished noncore flows explicit and independently runnable
- **Question:** which original flows remain outside this operator-approved core landing
- **Options:** imply full acceptance; delete original requirements; retain them with named dependent work
- **Chose:** keep the full23-scenario specs and registered dependent fix-terminal-dock-unfinished-flows-20261027. Its title names visible native Low completion; question-card collapse/answer/dismiss/refresh; feature-toggle focus/final settings; exact geometry thresholds; visible Stop/Escape with newer draft; attachment/paste/drop/native chooser; shell-pane menu proof; and direct hook-ended/whole-PTY lifecycle assertions, with each observed limit or missing proof. BLOCKERS.md retains C1 and exact report anchors.
- **Why:** the deadline explicitly authorizes these deferred flows. Native picker behavior is uncertain, card hit targets/focus need repairs, some goals were unattempted, and the chooser is a driver/native limitation. No unsupported native action or fabricated pass is substituted.
- **Evidence:** queue.ts add exit0 before landing; scratch follow-up.json; BLOCKERS.md open findings; pending native scenario; guarded reports20261027T180029-52a7 and20261027T190614-d4f8
- **Reversibility:** easy
- **Confidence:** high for the named gaps; no claim about unperformed outcomes
- **Revisit if:** the dependent item supplies actual repaired end-to-end evidence
- **Source:** deferred: native options, question cards, feature-toggle focus, exact geometry, interruption proof, acquisition and additional lifecycle signals — explicit operator decision

## D41: Observe actual PTY geometry and sending after the fit repair
- **Question:** verify changed user-facing resize behavior beyond passing tests
- **Options:** rely only on tests/CSS movement; inspect the built web surface and real child PTY dimensions
- **Chose:** guarded web/yours/unattended run20261027T213825-c337 against a fresh private two-agent scene. The private TUI executes stty size: visible output changed29rows/62columns to29/72 after the center-divider drag; right draft remained, then real PONG appeared. Parent independently read before/after/PONG screenshots. Preserve the helper's formal partial status: send probes returned NO_EFFECT and a follow-up observe reported unknown_goal; do not relabel its report passed.
- **Why:** the observed numeric change proves the child PTY—not just CSS—received final geometry. Separate drafts and subsequent sending survived. This closes the concrete fit regression's runtime proof without claiming exact drag counts/bounds or every deferred flow.
- **Evidence:** .quirk/using-apps-like-a-user/runs/20261027T213825-c337/{report.md,report.json}; obs-13.png,obs-16.png,obs-18.png. Browser closed by helper; parent stopped only the owned fixture. Private settings sentinel comparison returned true.
- **Reversibility:** easy
- **Confidence:** high for screenshot-observed geometry/draft/PONG; helper result remains partial
- **Revisit if:** the guarded driver gains reliable goal-observation reporting or an actual app regression appears
- **Source:** assumed — autonomous (runtime proof); locked by LOOP tool-limitation reporting

## Progress
Approved core and concrete gate repairs are verified; final review, registered dependent follow-up and the single final catch-up are complete. Scripts49pass/223assertions, full typecheck, packaged build and all five repaired-path files passed. Built-web screenshots show real PTY columns62→72, preserved other-pane draft and PONG; formal tool partial status is retained in D41. The caught-up packaged build passed in15.23seconds and the final private scene home was removed. Commit/detach and queue.ts land next for authoritative merge-result full-suite/scripts/types validation. Original full acceptance and a complete post-fix208-file preflight are not claimed; noncore gaps/C1 remain open.
