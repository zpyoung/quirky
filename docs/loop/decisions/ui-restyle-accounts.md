# ui-restyle-accounts decisions

## D1: Restyle all existing contributions without changing feature authority
- **Question:** Brainstorming purpose, consumer, scope and successful outcome?
- **Options:** recolor only; replace feature state; shared presentation across Accounts and Vault
- **Chose:** All existing Accounts settings/status/accessory/overlay and Vault history/search-settings interiors, preserving public IDs, stores, APIs and actions.
- **Why:** Approved scope forbids new features/behavior changes; omission of secondary surfaces would leave inconsistent presentation.
- **Evidence:** docs/quirk/specs/2026-10-28-ui-redesign/logic.md:23-59,117-119,185,194-202; MapRestyle source survey
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** A shared control cannot preserve a required behavior.
- **Source:** locked by docs/quirk/specs/2026-10-28-ui-redesign/logic.md

## D2: Inherit graphite hierarchy, density and host placement
- **Question:** Visual layout, density, theme, grouping and interaction gray areas?
- **Options:** local plugin toolkit; duplicate shell frames; existing shared controls/tokens and host slots
- **Chose:** Public @quirky/ui controls, semantic dark/light tokens and comfortable density; Accounts retains status/settings/accessory/overlay contributions; Vault remains right-bottom. Existing host chrome stays host-owned.
- **Why:** Goldens and existing projection establish these decisions. CSS-only recoloring keeps divergent controls; inventing tool registrations changes behavior.
- **Evidence:** approved parent spec:89-119; packages/daemon/src/plugins/tool-layout.ts; packages/ui/src/design-system/contracts.ts; ui-shell-slots D3,D5,D6
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** Existing contribution cannot be reached through the shell.
- **Source:** locked by docs/quirk/specs/2026-10-28-ui-redesign/logic.md

## D3: Preserve truthful loading, empty/error, busy and secret-state semantics
- **Question:** Loading/empty/error state and interaction-style gray areas?
- **Options:** simplify away edge states; retain existing transitions while changing controls
- **Chose:** Preserve safe provider/credential/transcript content, retry and cancellation, account/reset-generation fences, busy/disabled guards, search consent, virtualization, keyboard/focus and persisted preferences. Shared empty/error presentation must not imply success.
- **Why:** Existing consumer behavior is the invariant. Dynamic quota percentages and virtualizer measurements are data, not new design constants.
- **Evidence:** plugins/quirky.accounts/src/window/{AccountsSettings,Usage,model}.tsx/.ts; plugins/quirky.vault/src/window/{HistoryPanel,SearchSettings}.tsx; item combined spec scenarios1–6
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** Actual changed-surface smoke exposes a shared-control semantics mismatch.
- **Source:** assumed — autonomous

## D4: Enforce both plugins without exceptions or private styles
- **Question:** CSS ownership, duplicate styling and enforcement gray areas?
- **Options:** exemptions/baselines; retain local injectors; shared controls and centrally linted layout styles
- **Chose:** Remove both local CSS modules/injectors, use shared controls and token-only accounts.css/vault.css for necessary layout, opt both IDs into canonical ui-lint-plugins.json without deleting existing IDs.
- **Why:** Approved system prohibits raw colors/pixels and plugin CSS; central styles cannot be a verbatim legacy-CSS relocation.
- **Evidence:** scripts/ui-lint.ts; scripts/ui-lint-plugins.json; ui-tokens-and-components D2–D4,D10; combined spec technical contracts
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** Canonical scanner rejects legitimate measured feature data.
- **Source:** locked by docs/quirk/specs/2026-10-28-ui-redesign/logic.md

## D5: Execute two disjoint implementers under build-first
- **Question:** Autonomous approval, spec/research/review/test and implementation preflight?
- **Options:** normal research/review/suites; authoritative build-first contracts-first wave
- **Chose:** One combined self-reviewed specification, existing shared signatures recorded and committed before two OpenAI task implementers in external component worktrees; parent integration owner. No reviewer probed/dispatched because review rounds are prohibited. No human asks, companion offer, research swarms, suites/full dogfood/golden-model scoring; parent runs typecheck/lint and minimum genuine renderer smoke required by coding contract.
- **Why:** Current LOOP build-first and claimed title apply. Public shared contracts require no new schema/type signatures. Existing unrelated .serena remains untouched. LSP reports no configured servers.
- **Evidence:** git show build/roadmap:docs/loop/LOOP.md; canonical wait title; xd://lsp status; combined spec technical contracts
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** Authoritative policy changes.
- **Source:** locked by docs/loop/LOOP.md

## D6: Bound platform and fixture claims
- **Question:** Native/platform coverage and credential safety?
- **Options:** infer all platforms/native behavior; macOS isolated renderer proof only
- **Chose:** macOS only; portable shared web APIs where inexpensive. Runtime fixture uses fresh isolated homes, synthetic sources and owned Chromium/CDP; no real provider login, clipboard/native notifications or history mutations. Existing provider Keychain isolation must be reused, not assumed from HOME alone. Linux/Windows and actual native chrome remain unverified.
- **Why:** LOOP locks platform and state safety; prior fixture evidence identifies Keychain as outside HOME isolation.
- **Evidence:** LOOP platform/state rules; MapRestyle warning; prior lane accounts evidence fixture/support.ts
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** Supported platforms expand or fixture access reaches real state.
- **Source:** deferred: platform

## Progress
Design and source survey complete. Combined logic/technical spec and unchanged shared contracts recorded; next commit spec/contracts, create two disjoint worktrees and dispatch Accounts/Vault implementers. No checks/runtime/review/test suites run yet. Scratch /tmp/quirky-l11-restyle.V894JJ; no owned services yet. No flows intentionally deferred and no follow-up item planned.
