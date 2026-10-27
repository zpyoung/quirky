# m3-session-info decisions

## D1: Build the local session inspection flows, not adjacent agent extras
- **Question:** Purpose, consumers, success, scope and primary behavior (brainstorming essential coverage).
- **Options:** Session inspection; expand into accounts/vault/remote hosting.
- **Chose:** Focused terminal-session inspection, all eight feature-doc flows, transcript actions, and session-history resume/copy actions assigned here by m1-providers D35. Account switching, vault indexing/search, remote transports and native chat remain their owning items.
- **Why:** The queue names one feature; the roadmap locks parity and scriptability.
- **Evidence:** docs/roadmap.md:171-184; external session-info.md “What the user can do”; docs/loop/decisions/m1-providers.md D35.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** A named flow cannot be expressed with public APIs.
- **Source:** locked by docs/roadmap.md

## D2: Use the existing right-column panel slot without a shortcut
- **Question:** Visual layout, density and responsive behavior (brainstorming).
- **Options:** Existing panel; introduce a second activity-bar system; standalone page.
- **Chose:** Session Info panel, compact labeled rows, scrollable content, native accordion buttons; existing shell controls panel placement. No keyboard shortcut.
- **Why:** Existing public panel slots and m0-ui-api D10 already fix placement. A new shell convention is unnecessary.
- **Evidence:** packages/protocol/src/ui.ts:71-81,156-178; docs/loop/decisions/m0-ui-api.md D10; external session-info.md “Where to find it”.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** The public shell gains activity-bar placement.
- **Source:** locked by docs/loop/decisions/m0-ui-api.md

## D3: Keep view state in the daemon and default only Live activity open
- **Question:** Accordion interaction, persistence, storage failure, and multiple clients (brainstorming).
- **Options:** Browser localStorage; plugin store and public section methods.
- **Chose:** Store the open-section set in the plugin namespace, defaulting to Live activity; allow multiple sections and validate section names. Expose reads and updates through API/CLI. Follow authoritative terminal focus, not last inspected session.
- **Why:** Quirky explicitly owns focus/layout in the daemon and exposes view state to scripts; persistence must survive a window restart.
- **Evidence:** docs/roadmap.md:31-38; external session-info.md flow 2; packages/protocol/src/plugins.ts:64-65.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** Per-window accordion state becomes required.
- **Source:** locked by docs/roadmap.md

## D4: Show missing, waiting, refreshing, stale and error states honestly
- **Question:** Visual loading/empty/error states and API response format (brainstorming).
- **Options:** Zero-fill missing numbers; omit unsupported sections and label waiting/stale values.
- **Chose:** Empty focused shell means “No agent session”; neutral providers show Identity and Live activity plus inspectable MCP. Claude has waiting Usage/Context until data arrives; errors retain last good usage with bounded error detail and Retry. Preserve absent fields in partial telemetry.
- **Why:** Missing provider data is not zero usage; the doc records indefinitely waiting usage despite completed turns as a defect to prevent.
- **Evidence:** external session-info.md “Edge cases” and “Verified in the app”; https://code.claude.com/docs/en/statusline.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** Provider telemetry schemas change.
- **Source:** locked by external session-info.md

## D5: Statusline consent changes only future launch overlays
- **Question:** Custom-statusline consent, opt-out, drift, removal, and settings precedence (brainstorming).
- **Options:** Rewrite global settings as Orca does; per-launch --settings overlay with preserved custom command.
- **Chose:** Never write ~/.claude. With no custom statusline, add telemetry per launch; with a custom command, require explicit consent before chaining it in a per-launch overlay. Preserve original statusLine fields and stdin/stdout behavior. Explain that enable/disable applies on the next launch. Re-read custom settings at launch so edits are not lost; no global install/uninstall files exist to restore.
- **Why:** The roadmap explicitly changes Orca's global-install mechanism. This is implementing that locked adaptation, not overriding a locked decision. Runtime cannot retroactively replace a running agent's startup settings.
- **Evidence:** docs/roadmap.md:173-174; external session-info.md flows 7-8; https://code.claude.com/docs/en/settings-reference.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** Claude exposes a supported in-session statusLine update API.
- **Source:** locked by docs/roadmap.md

## D6: Correlate every rich value to the active provider session
- **Question:** Session replacement, concurrent scans, plan limits, bounded memory (brainstorming).
- **Options:** Cache by pane only; guard by Quirky session and provider session ID.
- **Chose:** Reject late ticks, reset on provider replacement, cancel stale scan generations, cap telemetry at 256 sessions, clear closed/removed sessions. Show plan windows only from the same accepted session payload; do not borrow a global account snapshot. Transcript fallback context is explicitly estimated at 200,000 tokens.
- **Why:** Prevent cross-session/account leaks and preserve the external contract without depending on a later accounts item.
- **Evidence:** external session-info.md “Session guard”, “Plan windows correlation”, “Pane cap”; https://opentelemetry.io/docs/specs/otel/logs/data-model/.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** Accounts introduces a public live-observation correlation contract.
- **Source:** assumed — autonomous

## D7: Keep feature ownership in a new built-in plugin
- **Question:** Brainstorming candidate approaches and API/CLI scope.
- **Options:** Built-in plugin snapshot; core-owned aggregate; UI-only transcript scanner.
- **Chose:** quirky.session-info owns public methods, events, bounded transient telemetry, store-backed UI preferences, launch contribution and UI. Reuse public session, agent-status, terminal and UI methods; no private cross-plugin service imports.
- **Why:** Core ownership violates feature-as-plugin; UI ownership violates authoritative daemon state and API/CLI parity. Optional provider fields keep unsupported providers honest.
- **Evidence:** docs/roadmap.md:19-38,47-53; packages/protocol/src/plugins.ts:48-78; https://backstage.io/docs/frontend-system/architecture/extension-overrides; https://www.w3.org/WAI/ARIA/apg/patterns/accordion/.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** Public API cannot support a required flow.
- **Source:** locked by docs/roadmap.md

## D8: Use schema-generated session-info commands and explicit failures
- **Question:** CLI output/flags, API errors, authentication and versioning (brainstorming).
- **Options:** Private UI endpoints; schema-declared namespaced API and CLI group.
- **Chose:** Public session-info get/state/sections/inspect/telemetry/history/transcript actions and UI command contributions, existing CLI JSON/output/error conventions, existing daemon token and hook token. Missing sessions fail with not-found, invalid inputs with invalid-params. No new auth or retry policy.
- **Why:** Existing API is unstable until M7 and already supplies schemas, transport and auth.
- **Evidence:** docs/roadmap.md:29-38,70-77; packages/daemon/src/server.ts:49-70.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** Public catalog cannot describe a required command.
- **Source:** locked by docs/roadmap.md

## D9: macOS local execution is the supported transport
- **Question:** Remote/WSL behavior and native reveal verification.
- **Options:** Build remote transports now; honor existing local-only execution and hand native scenarios off.
- **Chose:** Local inspection only where the session represents local execution; never fabricate remote telemetry. Record Linux/Windows hook runner and native reveal testing as platform work. Native Finder and OS clipboard outcome checks go to the nightly native scenario handoff.
- **Why:** Platform constraint is macOS-only and remote hosting does not yet exist; feature-doc locality gates remain invariant.
- **Evidence:** docs/loop/LOOP.md:48-49,133-137; docs/loop/decisions/m1-agent-status.md D29; external session-info.md “Remote or WSL pane”.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** Remote sessions or another platform ships.
- **Source:** deferred: platform

## D10: Use omp task implementers and Gemini cross-family review
- **Question:** SDD preflight model pairing and unavailable preferred reviewer.
- **Options:** omp + opus; omp + gemini; same-family fallback.
- **Chose:** IMPLEMENTER=omp-task, AUTHOR_FAMILY=openai, REVIEWER_ALIAS=gemini. Codex reviews both specs as LOOP.md explicitly requires. RUN_BASE=74fe2893700a55fef6a4e6fd5f1c46bf512834dc. Scratch journal /tmp/quirky-session-info.TBh9Q4. Width cap 4.
- **Why:** pi-watch --check reported opus/sonnet unavailable, gemini reachable; cross-family fallback is required before same-family review. Bun 1.4.0 and web doctor are available.
- **Evidence:** Preflight 2026-10-27: codex=openai-codex/gpt-6.1-sol; gemini=google/gemini-3.1-pro-preview; opus had 0/8 authed combinations. package.json:11-15.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** Selected reviewer dispatch fails.
- **Source:** assumed — autonomous

## D11: Use markdown specs and unattended design approval
- **Question:** Skill offers, remaining questions, design presentation and approval.
- **Options:** Interactive human review; LOOP.md autonomous defaults.
- **Chose:** Standard gray-area catalog, all relevant Visual/API/CLI/Integration questions resolved above; skip visual companion and ADHD offers. Markdown logic and tech specs. Self-review design sections, then Codex adversarial spec review before code. No human asks.
- **Why:** LOOP.md supplies explicit authority for unattended answers and replaces human spec review.
- **Evidence:** docs/loop/LOOP.md:175-199.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** A locked conflict is discovered; block rather than override.
- **Source:** locked by docs/loop/LOOP.md

## D12: Accept the specification review's three implementation gaps
- **Question:** Codex spec review F1/F2 and supplemental source-confirmed A1.
- **Options:** Accept and repair contracts; dismiss as implementation details.
- **Chose:** Accept F1 (HIGH): add public terminal focusContext state/event and real main/floating focus producers. Accept F2 (MEDIUM): resolve user --settings JSON/files on create/resume, include them in consent inspection, and emit one effective argument. Accept A1 (MEDIUM): add session-info/resumeCommand; the presumed session/resumeCommand API does not exist.
- **Why:** Each gap can change consumer-visible focus, command execution or settings preservation. Logic amendments and technical contracts now include all three.
- **Evidence:** /tmp/quirky-session-info.TBh9Q4/spec-review/report.md; confirmed-findings.json; raw gate.json. Fresh promote/refute review completed with Codex; reduced same-family independence explicitly recorded. Raw gate includes 19 non-behavioral prepass diagnostics; their per-ID dismissals are recorded in prepass-assessment.json (planned artifacts, RPC shorthand, range parsing and heading heuristics). Existing anchors/backlinks were separately resolved.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** Public-contract tests expose a different precedence/focus rule.
- **Source:** assumed — autonomous

## D13: One wave with four disjoint implementation components
- **Question:** SDD decomposition, dependency audit and work scope.
- **Options:** Serial horizontal waves; four contract-driven concurrent slices.
- **Chose:** Launch/settings composition; terminal focus primitive; session-info daemon/API/CLI/types; session-info UI/tests. No semantic dependency requires earlier implementation output because the public contracts are fixed in tech.md. Main orchestrator owns specs/docs and integration. Width 4; no overflow, no checkpoint because there is no successor wave. Workers never commit or run checks mid-flight; orchestrator audits scopes then runs acceptance after all return.
- **Why:** Different write scopes permit concurrency without shared file edits. New UI module auto-build discovery needs no shell hub edit.
- **Evidence:** packages/ui/build.ts:37-51; tech.md Contracts & interfaces. Pre-implementation isolated CLI smoke returned usage code 2, unknown command session-info get, proving the public feature is missing.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** A declared scope proves incomplete; stop and re-plan that component.
- **Source:** assumed — autonomous

## Progress
Step 4 complete: both specs written, self-reviewed, Codex adversarial review completed and accepted findings fixed. Next: commit specs, implement the four scoped components, audit/merge, catch up with build/roadmap, run gates, final three-lens Gemini review and one fix batch, UI dogfood, land.
