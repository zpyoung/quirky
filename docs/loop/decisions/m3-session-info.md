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

## D14: Explicitly own missing integration primitives and scope corrections
- **Question:** Implementation exposed missing exact-pane focus and resumed-session placement APIs, and one unapproved registration edit.
- **Options:** Private DOM/workspace access; duplicate session spawn; public terminal primitives and explicit integration ownership.
- **Chose:** Public terminal focus-pane command and idempotent openSession/open-session primitive. Session-info consumes them. Launch worker restored its out-of-scope agents/main.ts change; the parent owns the one-line settingsOverlay registration. Other necessary scope additions were approved before edits and recorded in scratch scope-amendments.md. Generated Serena project scaffolds were removed, never landed.
- **Why:** Existing resume creates a PTY record but not a terminal leaf; opening a view alone cannot show it. Exact focus/bottom was absent. Public operations preserve scriptability and avoid a duplicate process.
- **Evidence:** Original worker API surveys; /tmp/quirky-session-info.TBh9Q4/integration-corrections.md; wave-1-audit.json; tech.md Authoritative terminal workspace focus.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** Terminal layout gains a broader session placement contract.
- **Source:** assumed — autonomous

## D15: Validate linked components in a combined acceptance tree before committing
- **Question:** Backend/UI tests need the new peer APIs, absent from isolated component trees.
- **Options:** Pretend each isolated component passes; commit unchecked pieces; assemble audited changes for combined acceptance.
- **Chose:** All original worker HEADs remained fixed and scope audits passed. Applied their audited diffs into /tmp/quirky-session-info.TBh9Q4/acceptance, then added the explicit registration and workspace lock update. Parent runs acceptance there, and only that tested combined tree is eligible for commit/merge. Preserved source trees are audit artifacts, not delivery trees.
- **Why:** Fixed interfaces allow parallel authorship, but do not make linked runtime tests independent. This corrects D13's overly broad claim about independent acceptance without weakening the pre-commit gate.
- **Evidence:** wave-1-audit.json; gate-fix-before.json and gate-fix-audit.json; package workspace linking required force-frozen install after lockfile-only update.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** Future work can provide independently runnable vertical slices.
- **Source:** supersedes m3-session-info D13

## D16: Repair root causes found by the first combined gate
- **Question:** The first typecheck/API run and thirty targeted files exposed integration defects.
- **Options:** Suppress failures; correct the source and retain behavioral acceptance.
- **Chose:** Restore session insertion before hooks, missing imports/predicates and fixture declarations, sound nullable UI boundaries, valid public schemas, and actual throttle/focus behavior. Remove incidental escaped-source/mock-forwarding assertions rather than pin new implementation text.
- **Why:** Session creation was universally failing; terminal's unsupported nullable type arrays invalidated its manifest and transitively session-info. The failures are real gates, not reasons to reduce scope.
- **Evidence:** /tmp/quirky-session-info.TBh9Q4/narrow-1/checks.json (21 files pass, nine fail); actual plugin.list probe reports three focusContext schema errors; compiler artifacts 50 and 58.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** Required acceptance still fails; investigate before further changes.
- **Source:** assumed — autonomous

## D17: Preserve the launch-settings allowlist and report per-launch hook evidence
- **Question:** Public acceptance exposed unsupported test inputs and the lack of Claude in the global hook-installation status list.
- **Options:** Expand the locked extras allowlist or fabricate a global Claude installation; exercise configured arguments and project actual session hook evidence.
- **Chose:** User --settings enters through the existing configured agent argument/replay-record path, with shell quoting, not through restricted extraArgs. Claude hook health comes from public session-specific status evidence; observed hooks may be reported Installed, absent evidence must be labeled waiting/skipped rather than falsely healthy. Independent MCP parse errors do not remove valid hook evidence.
- **Why:** m1-launch-settings D14 intentionally permits only model/effort/add-dir extras. Claude hooks are per-launch, so the config-file installer list cannot establish their health. No locked rule needs changing.
- **Evidence:** docs/loop/decisions/m1-launch-settings.md D14; plugins/quirky.agent-status/src/hooks.ts:18-20,50-62; narrow-2 public API failure log.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** Agent-status exposes a direct per-launch health API.
- **Source:** locked by docs/loop/decisions/m1-launch-settings.md

## D18: Use the registered terminal root and a shared cross-process throttle clock
- **Question:** Mounted acceptance and the statusline subprocess test exposed assumptions hidden by isolated tests.
- **Options:** Guess a terminal-plugin view ID/use process-relative clock; use the actual registry and a shared observation clock.
- **Chose:** Main inspection accepts the registered view:quirky.session/worktree root; missing/nonterminal roots are empty. Floating inspection depends on actual floating focus plus enabled/open overlay, independently of the underlying root. Statusline throttling compares wall-clock receipt time with the atomic shared stamp file's modification time across runner processes.
- **Why:** There is no view:quirky.terminal/workspace contribution. A namespace-prefix guard hid valid mounted agents. Process-relative hrtime values did not establish the interval across the tested Bun subprocesses; the shared file clock passed the under/over-15-second boundary tests.
- **Evidence:** narrow-4 public API and mounted e2e logs; narrow-2 statusline-runner pass; actual contribution registry and terminal e2e-ui support.ts WORKTREE_VIEW.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** Clock adjustments need stronger monotonic coordination or the shell adds another registered terminal root.
- **Source:** assumed — autonomous

## D19: Honor the merged process-ownership rules and review only this item's delta
- **Question:** Roadmap catch-up brought six binding decision logs, process guardians and separately reviewed feature commits.
- **Options:** Ignore new constraints/review inherited work as this feature; read all logs, migrate ownership and pin the merged integration baseline.
- **Chose:** Read fix-sc31-first-shell-race, fix-test-process-leaks, m1-notifications, m2-sidebar-extras, m2-source-control-core and m3-terminal-dock in full through two scout reviews. No behavioral conflict found. The new standalone runner test now allocates a guardian-owned fresh home, propagates scope env, tracks its detached child and awaits cleanup; allocated home and its quoted-path fixture are removed even after owner death. Product PTY persistence stays unchanged.
- **Why:** Crash-safe disposable process ownership is now binding. Parallel authorship did not waive newer integration decisions.
- **Evidence:** Merged integration tip 8c348238967449d44c6dfd4cd07092032f91d780; post-merge build exit 0, runner subprocess file nine tests pass and typecheck exit 0. Build also emitted an icon.iconset-not-found warning; no session-info build failure occurred.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** A newer integration merge brings additional decisions.
- **Source:** locked by docs/loop/decisions/fix-test-process-leaks.md

## D20: Pin the final review baseline to the merged integration tip
- **Question:** RUN_BASE precedes independently landed features now inherited through required catch-up.
- **Options:** Review thousands of inherited lines as this item; review this item's complete delta against the merged integration parent while retaining full-tree gates/context.
- **Chose:** Keep RUN_BASE immutable at 74fe2893700a55fef6a4e6fd5f1c46bf512834dc; final REVIEW_BASE is 8c348238967449d44c6dfd4cd07092032f91d780. The first final campaign uses REVIEW_BASE..HEAD, all SC-1–35 criteria, full-tree build/tests and live-file seam inspection. No session-info change is excluded; inherited items retain their own reviews.
- **Why:** This is the actual feature diff after catch-up, not a reduction of the acceptance contract. The review campaign has not started, so its baseline is fixed before Round 1.
- **Evidence:** Catch-up merge 5af64a0a61ea905ee37f5aacaf1c81442f053c05 has the tested item and integration tip as ancestry; final-review runner accepts an explicit target.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** Another catch-up occurs before the first final review; pin that integration parent instead.
- **Source:** assumed — autonomous

## Progress
Tested implementation merged, then caught up with build/roadmap at 8c348238967449d44c6dfd4cd07092032f91d780. All six new logs read; process-ownership test adoption passes. Build/typecheck pass after catch-up. Real web dogfood is running on isolated fixture service sessionInfoDogfood6d; final full gates/review/landing remain pending. Never end while the fixture or dogfood worker is live.
