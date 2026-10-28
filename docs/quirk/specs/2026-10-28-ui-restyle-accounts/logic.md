# Accounts and Vault graphite restyle

**Status:** Approved parent design applied autonomously under LOOP.md, 2026-10-28. One combined logic/technical specification under build-first.

## Purpose and conceptual model

Apply the approved [desktop redesign](../2026-10-28-ui-redesign/logic.md) to every desktop contribution owned by `quirky.accounts` and `quirky.vault`. Host placement and feature authority remain unchanged: Accounts exposes its existing status item, settings view, session accessory and switch overlay; Vault exposes its existing right-bottom tool and search settings contribution/view. A tool is host-framed; do not duplicate shell chrome or create a new global launcher.

## Data flow

Existing plugin stores read and mutate the same public daemon APIs. Rendering consumes those snapshots and dispatches the same actions. Shared UI components supply controls and accessibility behavior; canonical design tokens supply all presentation values. No credential, transcript, selected account, layout or search-state migration occurs.

## Key decisions and rationale

Use the public `@quirky/ui` components and tokenized shared presentation. CSS-only recoloring would preserve divergent controls; replacing stores or adding new APIs would risk behavior changes. Preserve every existing action and state rather than reduce content to fit a mockup. The goldens specify hierarchy/palette/density, not Accounts/Vault domain content. Layout, density, loading, empty/error and interaction gray areas all inherit the approved design and existing behavior.

## Behavior and acceptance scenarios

1. **Account management.** Given existing managed/system-default accounts, open Accounts and change provider sections. Account identity, active/needs-sign-in badges, Add/Select/Remove/reauthentication, login-link copy/open/cancel, Codex configuration warnings and Claude running-session policy remain available. Before: system-default selected; walkthrough: open Claude then Appearance then return; after: same persisted account authority, shared controls and readable current state.
2. **Usage.** Given configured or unconfigured providers, open the status-bar Usage popover, provider details and session accessory. Meter values/direction, source/age, inactive-account usage, stale-session restart/keep/ask/always/never behavior, reset-credit acknowledgement, unknown-outcome retry and busy/error/disabled states remain intact. Before: existing quota snapshot; walkthrough: expand details and close; after: unchanged quota/account authority, graphite presentation.
3. **Account settings.** Given appearance and meter credentials sections, edit existing display preferences through shared form rows. Secret inputs remain masked; no stored secret is revealed. Before: existing preferences; walkthrough: change Used/Remaining and restore it; after: same public preference persistence contract.
4. **Vault history.** Given real indexed history or no sessions, open Vault in its canonical right-bottom slot. Search/scope/host/sort/group/filter controls, virtualization, expanded transcript/evidence, selected rows, context actions, resume/export/copy/delete and load-more remain reachable. Before: local history; walkthrough: search and clear, open view options; after: the same search/selection authority and a truthful populated/empty/error state.
5. **Vault settings.** Given existing search status/preferences/consent, open Search settings as a section or view. Enable/disable/reindex, scope/retention/advanced settings and errors retain their semantics and use shared controls. Before: unchanged consent; walkthrough: inspect without enabling indexing; after: no implicit consent or history mutation.
6. **Theme and narrow panels.** Given dark or light appearance, all named contributions use the same graphite semantic tokens, readable wrapping and shared control density, with no document-wide horizontal overflow. Before: dark; walkthrough: select light through existing theme API; after: light render without restart or content loss.
7. **Enforcement.** Given either plugin introducing raw colors/pixel styles/private CSS, canonical UI lint rejects it. Both plugin IDs join the existing enforced registry without deleting other opt-ins or adding exclusions.

Existing behavioral acceptance tests remain the consumer-visible regression authority. Add a permanent test only for a plausible behavior boundary introduced by shared-control composition, not copied props, source text, CSS spelling or incidental defaults.

## Scope and non-goals

All Accounts/Vault desktop panels/views/settings/status/accessory/overlay interiors are in scope. No new features, provider integrations, API/schema/store changes, shortcuts, phone UI, shell redesign, native window chrome, credential reads from real homes, or search-consent changes. No flow is intentionally left unbuilt.

## Decisions locked

- All choices are autonomous; no human questions, companion offer or research swarm.
- Shared component/token reuse only; no scanner bypasses or per-plugin stylesheet injection.
- Existing shell contribution IDs, slots and API behavior remain stable.
- Build-first: one specification/contracts commit, two disjoint implementers, parent integration, typecheck gate. No suites, formal review rounds, full dogfood or golden-model scoring campaign; only narrow actual changed-renderer smoke required by the coding contract. Do not claim screenshot-review approval.

## Industry insights

Reuse the approved parent design's cited Linear/VS Code/Obsidian component-system evidence and landed `ui-tokens-and-components`, `ui-shell-slots` and `ui-screenshot-review` decisions. No external research under build-first.

## Deferred ideas

None. Golden-model/full feature acceptance and native/platform evidence are existing end-phase obligations, not new unbuilt flows or follow-up queue items.

## Glossary

- **Shared presentation:** centrally linted public UI controls and semantic layout styles; no plugin-local CSS source.
- **Authority:** existing daemon account/preferences/history/search state, unchanged by this item.

## Technical decisions and contracts

### Shared contracts (committed before implementers)

Reuse `packages/ui/src/design-system/contracts.ts`: Button/IconButton/TextField/Badge/StatusDot/ListRow/SectionHeader/Tabs/Menu/Dialog/EmptyState/FormRow/ToolPanelFrame/InlineAgentCard. Import only public `@quirky/ui` exports. `Button` preserves native button props and accepts an optional React19 `ref` to the real button (also inherited by IconButton); `TextField` preserves input props with a required label. Dialog owns focus/trap/Escape; its optional `onClose` is the dismissal capability. Without it, no close control is shown and Escape/backdrop cannot dismiss. Existing callers supplying `onClose` keep their behavior. Required-choice switch dialogs omit it; busy reset confirmations omit it while submitting. Existing standard HTML content structures may remain where no special shared control applies, styled only by canonical shared classes/tokens.

No new feature API, protocol type or schema is required. The additive shared button-ref/dismissal contracts preserve existing feature focus and required-choice semantics. Feature-specific geometry that the kit does not express belongs in two centrally linted shared layout files, `packages/ui/src/design-system/accounts.css` and `vault.css`, not private plugin CSS. Use `--ui-*` semantic tokens and existing approved size steps; avoid copying legacy literal styles or introducing arbitrary compatibility primitives. Parent alone integrates these shared files in the shared stylesheet.

### Ownership and invariants

- Accounts component owns `plugins/quirky.accounts/src/ui.tsx`, `src/window/{AccountsSettings,Usage}.tsx`, obsolete `src/window/styles.ts`, and new shared `accounts.css`. Existing store/model/report logic is read-only. Preserve public reporting, generation/timer fences, scope/reset envelopes and native credential/history invariants.
- Vault component owns `plugins/quirky.vault/src/window/{HistoryPanel,SearchSettings,evidence}.tsx`, obsolete `src/window/styles.ts`, and new shared `vault.css`. Existing `model.ts`, backend/scanner/search/service/types and public command routing are read-only. Preserve virtualizer measurement/data offsets, keyboard/focus, safe menu mounting and event routing.
- Parent owns `scripts/ui-lint-plugins.json`, shared stylesheet imports, item docs, smoke driver and integration corrections. Two workers have disjoint files and no semantic dependency; one wave, width two. Worker edits use absolute assigned-worktree prefixes. Workers run no checks/formatters and do not commit.
- A third, later test-only implementer owns affected Accounts/Vault UI regression selectors and one shared required-choice Dialog behavioral regression. Shared dialogs use `aria-labelledby`, so locate them through their accessible heading, not obsolete private CSS classes. Parent alone owns shared component contracts/implementation. No tests/checks run in the worker.
- Existing inherited `.serena/` is unrelated and remains untouched. Use private scratch/runtime homes; no real accounts/providers/native auth.

### Acceptance commands and evidence

Parent runs `bun run typecheck` (includes canonical UI lint) and `bun packages/ui/build.ts`. For required runtime proof, launch actual built UI and daemon on a fresh isolated HOME/QUIRKY_HOME and inspect Accounts provider navigation/preferences plus Vault tool/search/options/settings in both appearances using an exclusively owned Chromium profile/CDP; save exact screenshots/results and stop all owned processes. This is not a suite or independent golden-review claim.

Catch up once via `git merge build/roadmap`, read incoming decisions, rerun typecheck, commit, detach and canonical absolute `queue.ts land ui-restyle-accounts`. Failed-land retries follow LOOP.md.

## Status & amendments

2026-10-28: self-reviewed for parent scope, all contribution coverage, unchanged behavior, disjoint source ownership, truthful verification limits and no placeholder contracts.

2026-10-28 amendment: Compiler evidence required explicit button ref typing; source integration showed required-choice/busy dialogs must not expose an inert close button. Add the two minimal shared contracts above and migrate behavioral UI test selectors to real labeled controls/dialogs, with a third test-only implementer. Actual renderer smoke found a status-item-relative popup width and offscreen measurement overflow; fix those at the shared layout owner rather than weakening assertions.
