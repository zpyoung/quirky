# Vault search tip technical spec

Status: Reviewed with sibling logic spec; autonomous approval under LOOP.md. Logic: [logic.md](logic.md).

## Architecture
Implements [ownership/data flow](logic.md#conceptual-model-and-data-flow). Use existing Vault PluginStore vault_state schema (main.ts:7-18), VaultService local policy queue, declared method/CLI contributions, and VaultWindowModel subscriptions. No new dependency, process, protocol field, plugin or general registry.

## Code references
All paths below are relative to the worktree root /Users/zpyoung/orca/workspaces/quirky/build-lane-8.
- plugins/quirky.vault/src/types.ts: shared JSON contracts; add SearchTipState.
- plugins/quirky.vault/quirky-plugin.json: contributes.method and cli-command; declare getSearchTip and search-tip.
- plugins/quirky.vault/src/service.ts: methods table, changeLocalPolicy, existing vault_state storage and policyQueue. Implement canonical read and post-success write inside serialized local operation.
- plugins/quirky.vault/cli.ts: named command dispatch and public result formatting; add search-tip using public API only.
- plugins/quirky.vault/src/window/model.ts: VaultSnapshot, emptySnapshot, retryView, subscribe callback, setSearchEnabled. Read tip state on initialization and committed event. Follow existing stopped guard and do not persist locally.
- plugins/quirky.vault/src/window/HistoryPanel.tsx: SearchDisclosure and its local off-state callsite. Consume tip state in existing full-disclosure card, retaining data-vault-enable-search selector.
- plugins/quirky.vault/test/consent.test.ts and test/support/harness.ts: private real-daemon source fixture/API path. New tip-specific tests may reuse VaultRig.
- plugins/quirky.vault/test/window.test.ts: existing real daemon/UI harness with deterministic source data and state predicates.

## Contracts and interfaces
Implements [locked behavior](logic.md#decisions-locked).

CONTRACT: SearchTipState is { id: 'agent-session-search'; seen: boolean }. Public quirky.vault/getSearchTip takes an empty object and returns SearchTipState; it is readOnly. CLI command quirky vault search-tip has no arguments and outputs that object with --json, meaningful id/seen text otherwise. Existing enable method/result contracts remain unchanged.

CONTRACT: quirky.vault/searchTipChanged event data is SearchTipState, emitted only after a committed unseen-to-seen transition. Rendering on a second client refreshes from committed data, not optimistic click state.

A missing/invalid stored value reads unseen. Store a version-independent key searchTip:agent-session-search in vault_state with JSON true, using existing SQL parameterization. No schema migration is required. Tip reads must not call worker.request. Mark only after applySearchPolicy succeeds and readLocalStatus confirms enabled. Put mark inside the same policyQueue operation; any bookkeeping write failure is included in enable rollback, not swallowed. Preserve previous seen state; no public arbitrary marking/reset path is added. Do not infer seen during startup from search-enabled, since an attempted enable is not confirmed success.

## Data models and schemas
Implements [A1–A5](logic.md#behavior-and-acceptance-criteria).
The single new public object has required id and seen; id is the one literal documented tip ID. Manifest schemas and TypeScript agree. UI snapshot adds searchTip: SearchTipState | null, with null for unknown/loading/unavailable. No search result/status shape changes. No renderer localStorage or new setting.

## DO-NOT-CHANGE fences
Implements [scope and non-goals](logic.md#scope-and-non-goals).
- Worker/parser/search implementation and source roots: no tip read may start content indexing; no new worker operation is required.
- main.ts vault_state table definition: reuse existing table rather than add a competing owner.
- Existing authorization, confirmation and remote transport rules: shared authenticated-user model remains locked.
- Existing full privacy disclosure and ordinary off-state consent availability: seen must never grant permission or suppress future consent.
- docs/loop/queue.json, DECISIONS.md, LOOP.md and scripts/build-loop: controller-owned/protected; no source edits.

## Always / Ask / Never
Always validate confirmed local status before marking, propagate persistence failure, use public APIs between components, keep daemon/window state coherent, and clean private test process scopes. Resolve implementation ambiguity autonomously and record it in the decision log. Never ask a person, reuse Mobile onboarding, create a generic tip registry, silently drop a failed mark, or write real user state.

## Cross-cutting
Implements [failure and persistence decisions](logic.md#decisions-locked). Privacy: search consent remains the only index gate. Migration: missing tip record is unseen, not guessed from older enabled policy; consumers show ordinary consent while state unavailable. A future global owner must migrate this record. Rollback: rejected enable restores disabled policy as existing code requires; no seen write before confirmed worker status. Unrelated untracked tooling artifacts remain untouched. macOS verification only; no new platform-specific code.

## Testing strategy
Implements [A1–A5](logic.md#behavior-and-acceptance-criteria).
Use real API/CLI and temporary source/home fixtures for unseen/no DB, successful local enable/search, plugin reload/daemon restart persistence, disable/clear retention, rejected invalid/settings-or-worker enable, and registered remote-only enable isolation. UI test drives the existing disclosure with an active query and checks canonical seen state, real query results and ordinary consent after disable. A focused actual built-web run must exercise unseen promotion -> opt-in -> result -> disable -> ordinary disclosure; it is not proof of unrelated Vault flows.

Commands: bun test plugins/quirky.vault/test/search-tip.test.ts; bun test plugins/quirky.vault/test/window.test.ts --test-name-pattern 'SC-07'; final affected gate bun scripts/suite.ts plugins/quirky.vault; bun test scripts; bun run typecheck; bun run build. Existing importer surface is unchanged; full merged suite belongs to queue.ts land.

## Non-goals
See [logic scope](logic.md#scope-and-non-goals). No tip dismissal/reset API, new generic feature-tip system, full Vault parity campaign, source-parser/index change or native-only UI scenario is introduced.
