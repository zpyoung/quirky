# ui-screenshot-review decisions

## D1: Deliver the approved capture-and-review command, not a restyle
- **Question:** What belongs to this item (brainstorming scope and essential coverage)?
- **Options:** restyle current surfaces too; provide the reusable capture/review gate only
- **Chose:** The reusable command only; current mismatches must produce failures, not relaxed references.
- **Why:** The approved rollout separates this command from shell and plugin-area restyles.
- **Evidence:** docs/quirk/specs/2026-10-28-ui-redesign/logic.md:166-190
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** The approved rollout changes.
- **Source:** locked by docs/quirk/specs/2026-10-28-ui-redesign/logic.md

## D2: Capture the real daemon-served desktop renderer through Chromium
- **Question:** Which capture mechanism gives repeatable app pixels without foreground/native permissions (brainstorming integration and visual gray areas)?
- **Options:** foreground native-window automation; Chromium driving the actual daemon-served UI; render mocked component stories
- **Chose:** Start the real daemon and real UI bundle in an isolated home, seed real Git repositories/worktrees through public APIs, and capture the complete renderer viewport in Chromium. Do not claim OS-window chrome or native-only browser pixels.
- **Why:** The desktop window loads this same daemon URL; LOOP.md prescribes the web surface for unattended UI verification. Mock stories would not cover real plugin mounting. Native-only unavailable contributions must fail explicitly rather than be skipped.
- **Evidence:** apps/desktop/src/bun/page.ts; packages/daemon/src/main.ts; docs/loop/LOOP.md step 6; packages/ui/src/plugins/PluginSlot.tsx
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** The desktop renderer diverges from the daemon-served UI.
- **Source:** assumed — autonomous

## D3: Discover contribution coverage dynamically and fail closed
- **Question:** What does every tool/view mean before the six-slot shell lands (brainstorming completeness, empty/error states)?
- **Options:** maintain a fixed plugin list; discover daemon contributions; silently skip surfaces without fixtures
- **Chose:** Discover panels, views, sidebar sections, activity/status items, overlays and settings sections from the live public UI model, plus host shell/settings/palette captures. Capture both themes for each selected target; an unavailable mount, missing fixture, unsupported contribution, or missing image is a reported failure. Optional exact ID/plugin filters support area-restyle runs and are marked as partial scope, never full coverage.
- **Why:** Existing UI contributions are the authoritative registry until the shell-slot owner maps them to tools. A fixed list would omit new plugins.
- **Evidence:** packages/protocol/src/ui.ts:154-188; approved redesign glossary and rollout
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** The public contribution model introduces a new tool kind.
- **Source:** assumed — autonomous

## D4: Use a separate cross-family vision reviewer and a per-image 85/100 floor
- **Question:** Which reviewer, score and failure policy should the unattended command use (brainstorming CLI output, exit codes and integration)?
- **Options:** pixel diffs; same-session self-score; separate vision-model process with strict rubric
- **Chose:** Default pi-watch gemini, explicit author-family metadata, strict structured scores for palette, typography, spacing, shared-component consistency and hierarchy; mean score must reach configurable threshold (default 85) for every image. Missing/malformed model output or an unavailable reviewer fails as infrastructure error, never passes. Store resolved reviewer identity, image digests, rationale and evidence paths in JSON.
- **Why:** Goldens are combined conceptual screens, not per-plugin pixel baselines. A separate vision reviewer can compare styling across content differences. Per-image gating prevents a high average hiding a broken view.
- **Evidence:** Approved spec:174,190,220,243; pi-watch --check opus failed (0/8); pi-watch --check resolved gemini to google/gemini-3.1-pro-preview:high and OpenAI aliases, but no Anthropic alias.
- **Reversibility:** easy
- **Confidence:** medium
- **Revisit if:** Repeated review evidence demonstrates a miscalibrated threshold or rubric.
- **Source:** assumed — autonomous

## D5: Isolate app state and own all launched processes
- **Question:** How should fixture setup, failure recovery and cleanup behave (brainstorming CLI errors/integration safety)?
- **Options:** use developer workspace/home; disposable real fixtures and owned-process scope
- **Chose:** A short fresh temporary root, separate HOME/QUIRKY_HOME/provider/XDG config homes, cleared inherited Git/runtime pointers, real local Git fixtures, and cleanup of owned daemon/PTY/browser processes on success, failure and signals. Persistent output contains screenshots/reports, not credentials or runtime homes. No native notification/hook setup or real provider account interaction.
- **Why:** LOOP.md forbids touching real state; earlier desktop/editor items established the same isolation requirement.
- **Evidence:** scripts/test-support/process-scope.ts; docs/loop/decisions/m2-editor-build-unbuilt-flows.md; docs/loop/decisions/fix-desktop-startup-imports.md
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** A launched child can escape tracked ownership.
- **Source:** locked by docs/loop/LOOP.md

## D6: Build-first changes the execution gates, not the delivered command
- **Question:** Which process and backend pairing apply (brainstorming fast-track, specification and implementation preflight)?
- **Options:** full research/spec-review/test campaign; one combined logic/tech spec, contracts first and at most three implementers
- **Chose:** One spec with final tech section; omp OpenAI task implementers, gemini cross-family reviewer selected after opus probe failed. No formal review rounds or test-suite execution in build-first. Author behavioral tests; run typecheck and narrowly exercise the new command for required runtime proof. No human questions, companion offer or research swarms.
- **Why:** The authoritative LOOP.md build-first override requires these gates; approved parent spec already establishes the visual intent and goldens.
- **Evidence:** git show build/roadmap:docs/loop/LOOP.md; pi-watch --check outputs
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** m7-test-triage starts before the item lands.
- **Source:** locked by docs/loop/LOOP.md

## D7: Use portable browser/Git APIs; native platform coverage remains macOS
- **Question:** What platform work is included (tech feasibility)?
- **Options:** certify all desktop platforms now; macOS execution with portable APIs where inexpensive
- **Chose:** Build/run on macOS only. Chromium executable installation and process-ownership behavior on Linux/Windows require separate validation; no cross-platform success claim.
- **Why:** Platforms are locked in LOOP.md.
- **Evidence:** docs/loop/LOOP.md What is already decided
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** Linux or Windows becomes a supported build/test target.
- **Source:** deferred: platform

## D8: Developer visual QA does not add an app screenshot API
- **Question:** Does screenshot tooling conflict with the locked agent-access rule saying there are no screenshots of Quirky itself?
- **Options:** add a public screenshot daemon method; keep the explicitly approved redesign gate outside the product
- **Chose:** A repository developer command only. App agents still inspect public JSON UI state; no screenshot RPC, plugin contribution, shipped CLI group or runtime browser dependency is added.
- **Why:** The locked roadmap rule describes agent access in the product. The later approved redesign explicitly requests external screenshot-based restyle sign-off. Keeping QA outside the app satisfies both contexts without changing product capabilities.
- **Evidence:** docs/roadmap.md:31-38; docs/quirk/specs/2026-10-28-ui-redesign/logic.md:166-190; docs/loop/decisions/m0-ui-api.md D8,D25
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** Screenshot capture is proposed as a public runtime API.
- **Source:** locked by docs/roadmap.md

## D9: Supply an isolated public theme fixture only for a missing appearance
- **Question:** How can capture both themes before the parallel token/theme items land?
- **Options:** recolor screenshots or inject CSS; omit light; register a genuine theme-only fixture in the temporary app home
- **Chose:** Query real themes first and prefer matching built-in themes. Only when an appearance is absent, load a theme-only installed fixture in the disposable home and select it through public `theme.set`. Verify RPC selection and actual renderer color variables/computed appearance before capture; record selected IDs and reference digests separately.
- **Why:** The live starting repository has only default dark. A public theme fixture exercises real theme behavior without production theme changes, CSS injection or falsifying light coverage.
- **Evidence:** packages/protocol/src/ui.ts DEFAULT_THEME; CaptureRuntime live theme/declaration survey; docs/quirk/specs/2026-10-28-ui-redesign/logic.md token table
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** Built-in dark and light graphite themes are both available.
- **Source:** assumed — autonomous

## D10: Review genuine empty states instead of rejecting every empty-state component
- **Question:** Should a correctly mounted tool with no items fail capture merely for using the shared empty-state component?
- **Options:** reject every `.empty` node; capture legitimate empty states while rejecting missing required inputs and unfinished mounts
- **Chose:** Capture and review legitimate empty states. Missing required editor/native/session inputs remain explicit failures.
- **Why:** The approved parent spec explicitly requires a designed empty Changes state. A CSS-class refusal would reject real UI rather than measure it.
- **Evidence:** docs/quirk/specs/2026-10-28-ui-redesign/logic.md scenario 6; scripts/ui-review/capture.ts inspectSurface
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** A missing required fixture is being misreported as a valid empty-state capture.
- **Source:** locked by docs/quirk/specs/2026-10-28-ui-redesign/logic.md

## D11: Wait for settled visible content and honor browser shutdown ownership
- **Question:** What did the actual command smoke reveal about capture readiness and cleanup?
- **Options:** ignore loading/cleanup failures; fix the asynchronous boundaries without relaxing coverage
- **Chose:** Wait while visible leaf elements still say Loading, even when title/header content is already visible. Close the owned browser server before disconnecting its client and permit the library's own 30-second shutdown budget inside a bounded 35-second wait; keep process-scope cleanup authoritative.
- **Why:** The first editor run captured Loading document; the next exposed Loading under a Source control title, showing that visible child/header content was not readiness. Two initial runs hit the arbitrary 2-second browser-server cutoff; reversing order alone did not fix it. An instrumented isolated browser closed in 566ms, and a full app run in 1443ms, demonstrating timing variability rather than a proven disconnect-order-only cause. The library itself allows 30 seconds and then terminates its process.
- **Evidence:** /tmp/quirky-ui6-cPQCfG/tool-view-capture/capture-manifest.json; tool-view-ready screenshots; browser-close-smoke.ts output; shell-capture-measured command output; installed Playwright core browserProcess.close implementation
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** Captures contain unfinished content or owned browser processes outlive the command.
- **Source:** assumed — autonomous

## D12: Parse the observed reviewer identity header including its alias suffix
- **Question:** Why did real successful model reviews initially become infrastructure errors?
- **Options:** trust the model's claimed identity; parse pi-watch's actual resolved identity on stderr
- **Chose:** Parse `▶ resolved google/gemini-3.1-pro-preview:high (alias gemini)` including the optional alias suffix; record model ID without thinking level. Keep the separate preflight identity and same-family refusal before any review prompt.
- **Why:** The model read both PNGs and returned valid scores, but the first parser rejected the real wrapper's suffix. Authenticated output now produces score failures at threshold85, not missing-identity errors.
- **Evidence:** shell-model-review/reviewer/*.log.txt and *.response.txt; shell-model-resolved/review-report.json; authored regression fixture in scripts/ui-review/review.test.ts
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** pi-watch changes its machine-consumed resolved header format.
- **Source:** assumed — autonomous

## D13: The CLI, not Playwright, owns interruption and final evidence
- **Question:** Why was the final result file absent after interrupting the real runtime?
- **Options:** accept an exit130 without final evidence; disable Playwright's process-level signal handling and use the CLI's abort/cleanup path
- **Chose:** Launch Chromium with handleSIGINT, handleSIGTERM and handleSIGHUP disabled. Existing CLI signal handlers abort the operation, await process-scope cleanup, persist diagnostics and return130/143.
- **Why:** Playwright's default SIGINT handler calls processExit(130) after its own browsers close, racing the app's fixture/daemon cleanup and final result. The corrected actual interrupt scenario returned130 with status error and preserved progress/error/result JSON.
- **Evidence:** installed Playwright core sigintHandler; /tmp/quirky-ui6-cPQCfG/signal-capture-owned/ui-review-result.json; signal-smoke.ts output
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** A dependency installs another process-exiting signal handler.
- **Source:** assumed — autonomous

## Verification observed before catch-up

- `bun run ui:review -- --help` exited0 without starting the app.
- Initial root typecheck exposed5diagnostics across4new files: missing output path field, missing dirname import, missing fixture contribution kinds, and one TypeScript return path. Corrected all; full root/mobile/desktop typecheck subsequently exited0 (70.05s).
- Actual default-build host-shell run built the UI and captured both themes but exposed the shutdown cutoff. After correcting lifecycle ownership/budget, host-shell capture-only exited0 (8.96s), with2same-theme1340x600PNGs and public fixture repository/2worktrees visible. No styled-pass claim.
- Actual settled editor-document + Source control capture-only exited0 (65.92s),4PNGs across2themes. Images observed: actual fixture source buffer and actual Git changed/untracked rows, no Loading placeholder. No native-window assertion.
- Actual independent Google Gemini3.1Pro review read both image files per stderr tool receipts, recorded resolved model/family, and scored shell dark12/light34 against unchanged goldens. Default85 returned failed/exit1 (48.84s), as expected for the old UI. Same-family google-author review refused at preflight/exit2 without scoring (6.60s).
- Complete capture+independent-review control with an explicit threshold0 exited0 (121.87s). This is only success-path proof, not approval of current styling; default85 remains unchanged.
- Actual SIGINT after daemon/Git fixtures were ready initially exposed premature library exit; after the signal fix, throwaway interrupt driver exited0 and observed command130, error result and persisted progress (5.39s).
- No permanent tests/suites, formal branch-review rounds, full-inventory dogfood campaign or native run executed under build-first. Tests authored in5new test files; final post-merge typecheck remains next.

## Progress
Three disjoint implementers integrated after final HEAD/scope barrier: capture f4141b15, reviewer6f487299, CLI40c8bf87. Their worktrees were removed immediately after merge. Parent fixes and documentation ready to commit; one build/roadmap catch-up merge, incoming-decision read, final typecheck and canonical land remain. All smoke/model jobs and agents have returned.
