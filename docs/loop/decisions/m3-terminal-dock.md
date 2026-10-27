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

## Progress
Resumed step 3 under D10. Prior context/option research remains recorded in D6/D7/D9. Current scouts are refreshing backend and window implementation anchors after the integration merge. Next: finish gray-area decisions, author logic.md and tech.md, run Codex spec review, implement through omp task subagents with Gemini review (Opus remains unavailable), verify and land. No implementation is claimed yet.
