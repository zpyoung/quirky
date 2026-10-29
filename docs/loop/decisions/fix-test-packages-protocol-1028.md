# fix-test-packages-protocol-1028 decisions

## D1: Repair the reported protocol assertions without repinning inventories
- **Question:** What should this fix item change, and who resolves ambiguity without a person?
- **Options:** repin the historical method/event/default snapshots; change production contracts to match snapshots; trace current consumers and remove incidental mirrors while preserving behavioral coverage
- **Chose:** trace current consumers and remove incidental mirrors while preserving behavioral coverage; decide autonomously
- **Why:** the assigned item explicitly requires deleting incidental wording/source/default/inventory assertions, not repinning them. Historical baseline failures are evidence, not a requirement to roll contracts back.
- **Evidence:** queue item fix-test-packages-protocol-1028; docs/loop/LOOP.md, Fix items and Answering a skill's questions
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** tracing establishes an actual consumer-visible contract defect
- **Source:** locked by docs/loop/LOOP.md

## D2: The four reported failures are stale snapshots, not broken public contracts
- **Question:** Why did the historical protocol cases fail?
- **Options:** revert production metadata and theme; repin expected lists and colors; delete stale assertions
- **Chose:** delete stale assertions without changing production
- **Why:** the canonical baseline reproduced all four failures. Read-only methods gained desktop capabilities/window listing and keybinding listing; connection methods and events gained desktop/keybinding support. DEFAULT_THEME is now the logical system-following choice, not a theme titled Quirky Dark with the old palette. Those differences match current definitions and consumers.
- **Evidence:** docs/loop/reports/m7-test-triage.json:1957-1979; packages/protocol/src/ui.ts:45-83; packages/daemon/src/plugins/dispatch.ts:141-178; canonical baseline `bun scripts/suite.ts packages/protocol`, exit 1, 11/13 files passed, four failures in two files, no flakes, 26.53 seconds
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** a consumer rejects current metadata or theme selection
- **Source:** assumed — autonomous

## D3: Remove adjacent source mirrors and keep validation and safety invariants
- **Question:** Which assertions should survive the repair?
- **Options:** delete only failing lines; repin adjacent source copies; remove the touched inventory/default mirrors while retaining independent invariants
- **Chose:** remove the pinned method/event inventories, default-theme snapshot, ordered token list, and notify required-property array equality; retain the existing dynamic destructive confirmation/override-parameter checks, connection-schema consistency, schema validity, event-data shape, and color grammar
- **Why:** literal source copies require synchronized edits without testing consumers. Dynamic schema consistency and destructive override declarations constrain valid dispatchable contracts without pinning the feature inventory. Existing daemon tests exercise parameter rejection, plugin-to-connection refusal, theme choices and persistence; UI appearance tests exercise actual color application. No new test duplicates those paths.
- **Evidence:** packages/protocol/test/kernel-schemas.test.ts; packages/protocol/test/ui.test.ts; packages/daemon/test/plugins/schema-dispatch.test.ts:177-210; packages/daemon/test/plugins/ui-api.test.ts:707-793; packages/ui/test/plugins/appearance.test.ts
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** removal exposes a consumer-visible failure not covered at its boundary
- **Source:** assumed — autonomous

## D4: Verify existing consumers without broadening the repair
- **Question:** What verification demonstrates this test-only change preserves public behavior?
- **Options:** protocol tests alone; change unrelated consumer tests; run protocol/scripts plus focused consumer files and an actual daemon/CLI smoke
- **Chose:** protocol/scripts and focused daemon/UI consumer files, full typecheck, and disposable real daemon/CLI smoke
- **Why:** only two protocol test files change; production, exported contracts, callers and plugin manifests remain unchanged. The smoke uses the standard harness's fixture PTY host, with no terminal sessions; the daemon dispatch, public API and CLI are real. A fresh private HOME/QUIRKY_HOME and finally cleanup isolate all state. No rendered UI or native behavior changes, so no UI dogfood or native handoff is claimed.
- **Evidence:** `bun scripts/suite.ts packages/protocol scripts packages/daemon/test/plugins/schema-dispatch.test.ts packages/daemon/test/plugins/api-describe.test.ts packages/daemon/test/plugins/ui-api.test.ts packages/ui/test/plugins/appearance.test.ts`: 29/29 remote files passed, no flakes, 37.02 seconds; `bun run typecheck`: frozen install, UI lint, root/mobile/prepared-desktop checks exited 0 in 35.10 seconds. Actual smoke prints CATALOG_METADATA_AND_CONNECTION_BOUNDARY_OK, REAL_CLI_THEME_SELECTION_AND_API_COLORS_OK, HOME_REMOVED true. Initial smoke incorrectly assumed the private destructive object's shape in the public catalog; corrected the disposable script to catalog.ts's destructive boolean and sibling confirm string, without touching production, then reran successfully.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** final integration rejects the change
- **Source:** assumed — autonomous

## D5: Use the available cross-family reviewer and close this repair
- **Question:** Which final reviewer is available on this omp lane, and does the patch have supported findings?
- **Options:** unavailable Opus; available Gemini; skip review
- **Chose:** Gemini through pi-watch with read/grep/find/ls only, after Opus failed its availability preflight
- **Why:** the reviewer resolved google/gemini-3.1-pro-preview:high, independently inspected the two changed test files and direct consumer tests, and returned no findings with STATUS: PASS, exit 0 in 90.36 seconds. It received the task requirements and neutral patch operations, not the author decision log or loop notes. This is one scoped review, not an exhaustive security or product audit; no accepted findings required a fix batch.
- **Evidence:** `pi-watch --check opus` unavailable; `pi-watch --check gemini` ready; final pi-watch review output retained with the loop evidence. All owned jobs and the scout have returned. The post-change canonical test gate, full typecheck and successful smoke are recorded in D4.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** integration or a behavioral consumer reveals a regression
- **Source:** assumed — autonomous

## Progress
Ready to land: two test files repaired, D1–D5 recorded, canonical focused suites/typecheck/public daemon+CLI smoke passed, one cross-family review passed without findings. Sole roadmap catchup was already up to date; no incoming decisions. No production/API/UI/native changes, follow-up items, or scope deferrals. Commit explicit paths, detach, land fix-test-packages-protocol-1028 through the canonical absolute queue.ts, retain the landing receipt, remove the archived disposable /tmp smoke source, then end this iteration without claiming another item.
