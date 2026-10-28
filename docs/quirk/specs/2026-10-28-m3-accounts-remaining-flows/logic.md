# Accounts remaining user flows

## Status & amendments
Status: Approved autonomous defaults under authoritative LOOP.md; one combined logic/technical specification under night-mode rules. Self-reviewed against accounts.md and the original AC1–AC18. No user gate in this unattended lane.

**Amendments:** 2026-10-28 — initial completion specification; no original acceptance removed.

**Night-cutoff amendment:** 2026-10-28,02:54CDT — authoritative LOOP.md requires stopping new flows at90minutes. This branch lands the verified authority/reload/modal/pane repairs, public cancellation/policy regressions and real Codex A→B→remove-A→C content proof. Complete remaining user acceptance moves as one dependent item, `m3-accounts-complete-user-acceptance-20261028`, registered before landing. The criteria below remain the acceptance contract for that work; neither existing API coverage nor the two partial guarded-web reports establish a full UI/native pass. The unfinished list is recorded in the item's decision log/BLOCKERS entry.

## Conceptual model
Complete the deferred Accounts user-surface flows on the existing built-in plugin. Account selection changes future launches; a running process keeps its true account until a conversation-preserving restart. Usage is provider quota, never inferred model consumption. Durable preferences and exact account/offer/restart authority survive their intended lifetime. Rendering or preference edits must not authorize spending against another account.

## Scope and non-goals
The queue title and m3-accounts BLOCKERS list are the acceptance boundary. All ten provider drill-ins, managed Claude/Codex lifecycle and restart choices, masked MiniMax/OpenCode Go/ZCode credentials, reset confirmation and retained settings warnings are included. Native clipboard/browser/Keychain and OS focus are handed off as pending scenarios, as LOOP permits; web/API substitutes never claim native completion. Narrow +N/tooltip/badge-only exhaustive layout and the prior broad-suite hang have a separate queue item m3-accounts-overflow-verification; do not duplicate that item's campaign. Windows/WSL, remote scopes, other providers' managed switchers and transcript usage analytics retain their original exclusions.

## Data flow
Use existing schema-declared quirky.accounts methods, daemon-owned plugin store and public session/terminal APIs. The renderer selects accounts, requests login status and shows provider snapshots. Only isolated native CLI/network fixtures replace external provider boundaries during acceptance; daemon, transport, PTY, account routing and UI remain real. Account-dependent requests carry captured revision/scope; superseding selection fences old requests. Login cancellation cleans only owned incomplete homes. No credential or full private path is reported.

## Key decisions & rationale
Extend and verify the current implementation (recommended), rather than rewrite the plugin or make a test-only alternate renderer. Rewriting would discard established ownership/history/reset safety; component-only mocks cannot prove public flows. Preserve native official CLI login and provider-source protocols. Resolve visual/information-density questions with existing compact/detailed controls and consumed urgency; durable settings are daemon-owned. Errors remain actionable and secret-free. Authentication and destructive confirmation follow existing public dispatcher authorization; UI gets no privileged bypass. Completion evidence names exact exercised surfaces.

## Decisions locked
- Layout/information density: existing Usage status bar, drill-in and AI Provider Accounts settings, Compact/Used defaults, durable Detailed/Remaining/provider visibility.
- Loading/errors: retain last-good state according to existing policy; missing is not zero; inactive refresh is sequential/debounced and scoped.
- Interaction: Claude Ask/Keep/Always/Never and Codex Keep/Restart preserve real old identity until successful resume. Busy Claude waits for idle; later account selection invalidates earlier restart intent rather than retargeting it silently.
- Authentication: native login links remain allowlisted; cancel and failed reauth cannot erase saved history; needs-sign-in accounts cannot be selected.
- Data/idempotency: reset request IDs remain bound to displayed account/offer; retries cannot spend twice or migrate. Saving a display or confirmation preference must not invalidate a still-current account choice.
- Secrets: password inputs mask credential values and clear on success; only configured/readable metadata returns. Read-only providers never mutate their sign-in.
- All choices are autonomous recommendations or locked feature requirements; no human questions, no research swarm, no real user-state operations.

## Behavior and acceptance scenarios
Each scenario uses daemon/API acceptance and visible web actions for its UI portion. Existing tests are reused where they already cover a consumer-visible invariant; new permanent tests target uncovered transitions, not wiring or copied payloads.

### AC1: Durable presentation
Before: isolated daemon with Claude 5h 25%, weekly 10%, Codex 20%. Choose Detailed, Remaining and hide one provider in Appearance or context menu. After: detailed bars/remaining numbers agree; consumed urgency does not reverse. Restart the same private daemon and reload: preferences and hidden provider remain. Restore Compact/Used as a second valid transition.

### AC2: Complete provider details and inactive usage
Before: synthetic credentials/snapshots for all ten providers, with Claude/Codex inactive managed accounts. Open each visible roster provider: windows, reset time, plan/balance where supplied, state/age/source and Manage Accounts paths are visible. Expand account choices: inactive readings appear under their own account, opening again within debounce does not refetch. Refresh has observable authoritative change; no cross-selection contamination.

### AC3: Native login link lifecycle and reauthentication
Before: no managed accounts. Claude copy-link variant and Codex Add show pending state, trusted link and Cancel. Cancel removes only the incomplete owned folder. Complete Claude add: saved but not selected; complete Codex add: saved and selected. Invalidate a run-owned saved login: Needs sign-in and selection refusal appear. Reauthenticate in the same owned home; retained conversation/history remains and account becomes selectable. Failed reauth preserves the account. Native clipboard/system-browser delivery stays pending native-only; web validates visible link controls and cancellation.

### AC4: Claude restart choices
Before: live synthetic Claude A with recorded conversation/cwd. Select B under Ask: dialog identifies A→B. Keep leaves A alive; Restart resumes same prior contents in B. Don't ask again persists Always and applies the chosen action at the still-current selection. Always queues busy A until idle; Never affects only next launches. Select C before idle: B intent is invalidated; under Ask/Never it never restarts into C without fresh authorization. Failures show actionable old-session state. Display/confirmation preference edits cannot fabricate selection changes or silently lose queued work.

### AC5: Codex Keep/Restart and native conversation chain
Before: live Codex A has actual rollout content. Select B: pane chip and usage drill-in show true old A and new B, with Keep old account/Restart. Keep retains A without relabeling. Restart reads prior rollout bytes from B before provider continuation and focuses the resumed pane via public terminal state. Remove A after B owns a safe copy/link-independent continuation locator; select C and restart B: C reads the accumulated contents even though A is gone. No metadata-only conversation proof. OS keyboard/window focus is pending native handoff.

### AC6: Destructive removal
Before: selected run-owned saved account. Remove opens provider-specific warning; Codex names history/MCP loss, Claude distinguishes shared history. Cancel preserves selection, account and home. Confirm removes only owned state, falls back to System default and updates future launches. A running-account refusal stays visible and preserves retryable state. No real user account removal.

### AC7: Masked meter credentials and read-only sources
Before: MiniMax/OpenCode Go/ZCode unconfigured. Enter synthetic API key in masked field, Set: field clears, Configured/Readable and authoritative quota appear. Clear returns Not configured and no further use of that saved key. Exercise all three providers; cookie fields are masked too. Grok/Cursor detail/settings explain source and read-only login; failures expose neither token nor full private path.

### AC8: Scoped reset-credit confirmation
Before: verified Codex credit offer. Reset opens confirmation; Cancel sends no redemption. Confirm binds to displayed account+offer and one durable request ID. Don't ask again persists and does not itself stale the offer. Repeat/unknown-failure retry reuses identity without double spending. Change account or offer between opening and confirmation: refusal, no provider redemption. Stale refusal must be visible and never report successful spend.

### AC9: Retained Codex settings warning
Before: managed Codex home synchronized valid default config. Remove/empty/deny reading source (owned fixture only), prepare/select: last-good private config remains byte-identical and Accounts displays secret-free retained settings warning. Restore source: successful sync clears warning. No source auth/config mutation by Quirky.

### AC10: Launch-home provenance and original defects
Resolve prior unconfirmed S1 against real public hook/prepare behavior: explicit user home wins, but an injected hook-managed home is not silently treated as user intent. Verify whichever behavior is established with a daemon regression; do not change best-effort launch-hook semantics. Preserve corrected System default copy, Codex duplicate refusal, 15-minute polling and honest Cursor/Grok read-only language.

### AC11: Native handoffs
Record exact pending synthetic-only native clipboard/browser, Keychain-denial and window/pane focus scenarios under docs/loop/native/m3-accounts-remaining-flows.json. Web controls/API scope proof is separate from native observations, not a fabricated pass.

## Technical decisions
### Architecture and contracts
Reuse committed plugins/quirky.accounts/src/types.ts, usage/types.ts and quirky-plugin.json; the existing public method signatures are the shared contract before implementers begin. No speculative API growth. AccountState carries preferences, revision, staleSessions and warnings; reset expectedScope carries accountId/accountRevision/offerRevision; keep/restart use selectionRevision. If source investigation proves revision semantics wrong, correct the existing authority boundary and all affected consumers rather than add aliases or weaken stale-selection guards.

### Ownership and implementation wave
At most three independent components: (1) renderer controls/state plus focused UI regressions; (2) daemon account/restart authority and launch provenance plus API regressions; (3) real private daemon/PTY fixture and missing flow acceptance/smoke support. Shared schemas/types remain unchanged unless integrator first commits a needed contract amendment. Integrator owns spec/decision log, actual guarded web pass, final checks and queue landing. No component edits protected loop files, default homes, siblings' files or agent/context metadata. Implementers skip checks/build/lint/formatters mid-flight; integrator runs checks once at wave barrier.

### Verification and cleanup
Use existing isolated test harnesses for API transitions; real daemon and provider fixture processes for runtime conversation proof, plus built web UI for each visible scenario. Run bun scripts/suite.ts for affected directories, bun test scripts and bun run typecheck; bun run build for UI. One cross-family final adversarial round after green checks; fix blocking findings. Catch up build/roadmap once before landing and read incoming decision logs. Canonical queue land owns full-suite merge verification. Stop every owned browser/daemon/PTY/provider and archive evidence before deleting owned temporary worktrees/directories; preserve unrelated .serena metadata.

## Industry insights
No research swarm under LOOP night rules. Existing source-backed requirements and m3-accounts D4/D24 remain binding: official CLI authentication, Codex app-server quota and actual native conversation contents establish behavior, not account labels or repeated IDs. Source: external accounts.md sections Switching state machine, Edge cases and Codex accounts; original logic.md AC1–AC18.

## Deferred ideas
None added. Existing platform/non-slice exclusions and the separate narrow-layout verification queue item are unchanged. Native-only scenarios follow the required pending handoff, not a new implementation deferral.

## Glossary
Selection revision: authority token used to fence account-dependent actions. Offer: quota/reset snapshot bound to account and revision. Kept session: process intentionally retaining its real old account. Managed home: ownership-proven private native provider state. System default: inherited CLI environment. Native continuation: resumed provider reads actual prior conversation bytes in its destination home.
