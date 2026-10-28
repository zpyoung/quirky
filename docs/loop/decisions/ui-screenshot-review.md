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

## Progress
Claimed ui-screenshot-review after eight busy responses (one earlier wait hit default300s deadline). Branch created from build/roadmap. Approved redesign spec read; one read-only code survey completed. Combined item spec/contracts next, then up to three disjoint implementers. No suites, formal reviews or dogfood campaign run.
