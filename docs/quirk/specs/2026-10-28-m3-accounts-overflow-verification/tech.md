# Accounts responsive verification technical specification

Status: approved unattended. [Logic](logic.md). Tier fires: browser UI plus daemon/public projection plus test-process lifecycle.

## Architecture
[Logic behavior](logic.md#behavior--scenarios). React `StatusBarUsage` in `plugins/quirky.accounts/src/window/Usage.tsx` measures the footer and hidden chip copies through ResizeObserver; `styles.ts` owns flex geometry. `AccountsUiStore` projects declared daemon preferences and UI commands. Built UI is served by an isolated real daemon, using existing Accounts fixture provider adapters rather than real credentials. `scripts/suite.ts` dispatches tests to the configured remote host with local macOS exceptions and process-scope cleanup.

## Code references
- `plugins/quirky.accounts/src/window/Usage.tsx:338-438`: `StatusBarUsage({ store, report })`, measured visible/collapsed suffix and native title; `StatusChip` in the same file owns badge content.
- `plugins/quirky.accounts/src/window/styles.ts:39-51,83`: flex/statusbar/popover sizing.
- `plugins/quirky.accounts/test/support/index.ts:237-314`: `startAccounts(options)` and `cleanupAll()` own temporary home, fixture fetch/native binaries and daemon lifecycle.
- `plugins/quirky.accounts/test/ui.test.tsx`: mounted UI conventions; existing daemon API acceptance in `acceptance-api.test.ts` covers preference persistence.
- `scripts/suite.ts:51-94,176-201,244-271,298-375`: child/stream cleanup, per-file workers, shared slots, remote invocation and profile export. These are diagnostic anchors, not a planned runner redesign.

## Contracts & interfaces
[Logic AC1–AC3](logic.md#behavior--scenarios). Preserve existing public methods and schemas. `StatusBarUsage` reports `presentation`, `availableProviders`, `visibleProviders`, `collapsedProviders`, and `ui.popoverOpen`. Rendered chip set and count must agree with that projection after resize settles. Width accounting includes actual chip spacing and the overflow control; fit must not be inferred solely from element widths if their CSS gaps consume space. Keep pure consumer-visible regression tests only if a defect is reproduced. No source-text or copied wiring assertions.

## Data models / schemas
[Logic conceptual model](logic.md#purpose-and-conceptual-model). Existing preferences only: `density: normal | icons`, `mode: compact | detailed`, `direction: used | remaining`; do not introduce new fields. Fixture snapshots use existing provider IDs, status, accountId, session/weekly windows, usedPercent, windowMinutes, resetsAt. All setup tokens/logins are synthetic.

## DO-NOT-CHANGE fences
[Logic scope](logic.md#scope-and-non-goals). `docs/loop/LOOP.md`, `scripts/build-loop/**`, shared queue/DECISIONS index and external research are protected. No edits to default user homes, credentials or foreign `.serena`. Prior decision logs/evidence stay intact. No weakening suite selection, tests, assertions or deadlines. No forceful changes to production process persistence to make tests exit.

## Always / Ask / Never
[Logic locked decisions](logic.md#decisions-locked). Always reproduce a newly observed defect before implementation, reuse current public APIs and owned process scopes, record decisions autonomously. Ask no human; block only under the loop's documented core feasibility rule. Never turn a driver limitation into an app pass, bypass UI interactions with APIs after setup, or classify the old timeout as a test verdict.

## Cross-cutting
[Logic isolation](logic.md#decisions-locked). One scratch service owns all runtime resources; cleanup awaits stop and deletes only owned temporary homes. Logs/screenshots remain ignored, with durable exact summaries in the item decision log. No data migration or public contract cutover is expected; a code change must update all affected callers if an actual defect requires one.

## Testing strategy
[Logic AC4](logic.md#ac4-bounded-affected-package-result-and-diagnosis). Recover exact old arguments before choosing affected selection; if absent, document conservative reconstruction from the original source changes and consumers. Use `QUIRKY_TEST_PROFILE=1 bun scripts/suite.ts <affected directories>` under an external bound, retaining every selected test. Required `bun test scripts`, `bun run typecheck`, `bun run build`. Exercise AC1–AC3 through owned web browser and guarded web/yours/unattended campaign; inspect actual title, geometry and public UI state. A mounted geometry mock alone is insufficient.

## Non-goals
[Logic scope](logic.md#scope-and-non-goals). No provider protocol, OAuth, session restart, remote host or native frame behavior changes. No speculative runner hardening.
