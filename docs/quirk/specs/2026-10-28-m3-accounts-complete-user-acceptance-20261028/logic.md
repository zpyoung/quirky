# Accounts completion acceptance

## Status & amendments
Status: Approved autonomous recommended defaults under authoritative LOOP.md. Combined logic and technical specification; existing API contracts committed before implementers. End phase is active: canonical status reports m7-test-triage claimed.

**Amendments:** 2026-10-28 — initial specification. Prior requirements and evidence are preserved, not reclassified as a full pass.

**Amendments:** 2026-10-28 — operator A5 contract finding: public `consumeResetCredit` must return its advertised `{ outcome, state }` envelope for fresh completion and durable replay. Both fields are required; `outcome` is `reset | nothingToReset | noCredit | alreadyRedeemed`, and `state` is the current `UsageState` snapshot. The internal usage engine may keep its scalar outcome contract. Migrate the public handler, desktop consumer and all public-boundary fixtures/assertions together; do not accept legacy scalar public replies or add aliases. This does not change reset authority, ledger identity, provider-attempt errors or refresh policy.

## Conceptual model and data flow
Complete the existing built-in Accounts plugin, not an alternate implementation. Selection changes future launches; a live process retains its true account until native conversation-preserving restart. Public daemon API and CLI remain the authority. The renderer projects account, usage, login and configuration-warning snapshots and uses captured selection/offer authority for actions. Tests replace external provider/credential boundaries only; real homes, credentials, browser sessions and Keychain services are forbidden.

## Scope and non-goals
All remaining flows in m3-accounts-remaining-flows D9 and BLOCKERS are included. Existing original AC1–18 and preceding completion AC1–11 remain binding. Windows/WSL, remote host account switching, managed switchers other than Claude/Codex and usage analytics are unchanged exclusions. Constrained overflow/badge geometry belongs to its separate item. Native browser/clipboard/Keychain and OS focus retain pending synthetic-only handoffs; web or component results cannot close those native observations.

## Key decisions & rationale
Recommended: extend the existing model/service, reuse isolated native CLI/provider fixtures and run the actual built web surface. Rewriting discards ownership/history safety. Mounted tests alone cannot prove user acceptance. Use existing layout, information density, auth protocols, confirmations, secret-free errors, freshness and idempotency rules. No new retry policy, privileged UI bypass or account-state abstraction.

## Decisions locked
- Presentation: Compact/Used defaults, consumed urgency, durable Detailed/Remaining and visibility preferences.
- Login: cancel failure must retain an observable active login; stale status responses cannot resurrect a successfully cancelled/superseded login. Claude saves without selecting; Codex saves and selects. Reauth preserves history.
- Running sessions: only terminal sessions are eligible for terminal restart controls. Structured/background sessions retain their recorded identity and are never relabeled as the newly selected account. Existing restart endpoint terminal-only validation stays intact.
- Reset: captured account/offer and durable request ID; stale requests never redeem; unknown outcomes retry the same identity.
- Secrets: masked inputs, clear on success, metadata-only readback and generic errors; Cursor/Grok remain read-only.
- Isolation: fresh HOME/QUIRKY_HOME, owned processes and synthetic external endpoints/CLIs. No human asks, native foreground control or real OAuth.

## Behavior and acceptance scenarios
### AC1: Persist presentation through a same-home daemon restart
Before: synthetic Claude25% and Codex20%. Through visible controls select Detailed/Remaining and hide a provider. After restarting the same private daemon, reload and observe the same settings and provider visibility. Restore Compact/Used and visibility through UI; restart and observe the second state too. Urgency continues to represent consumed quota.

### AC2: Ten drill-ins and inactive refresh
Open Claude, Codex, Gemini, Antigravity, OpenCode Go, Kimi, MiniMax, Grok, Cursor and ZCode details. Each displays its supplied windows, reset/plan/balance and state/source truthfully. Claude/Codex switchers display inactive account usage under the right identity; immediate reopen is debounced, forced refresh changes the visible authoritative values. No cross-selection contamination.

### AC3: Login, cancellation failure and reauth
Claude copy-link and Codex Add expose pending link/Cancel. Cancel deletes only unfinished owned state. A cancellation-RPC rejection leaves error feedback and resumes status polling so later completion becomes visible. Successful cancel/supersession fences old responses and timers. Complete Claude add without selecting and Codex add with selection. Missing owned credentials produce Needs sign-in and selection refusal. Successful and failed reauth preserve saved account/history. Native clipboard/browser dispatch remains a pending handoff.

### AC4: Claude policy and supersession
With live A and actual prior conversation bytes, switch to B under Ask and Restart; resumed B reads those bytes. Keep leaves A alive. Always queues busy A until idle; Never changes future launches only. Switch again before idle: stale B intent is invalidated, not silently retargeted. Under Ask a fresh choice is needed. Opt-out persistence and successful-response/account-event race regressions remain intact.

### AC5: Codex pane Keep and keyboard continuation
With live Codex A, select B. Keep old account retains A and its actual identity. Restart resumes and focuses B. Prove real daemon/PTY A→B→remove-A→C with accumulated prior contents read in C after A's home disappears. Ordinary visible terminal keyboard input should reach the resumed provider; driver visibility restrictions are reported, never bypassed. Real OS/window focus remains native-only.

### AC6: Removal and fallback
For both providers, inspect provider-specific warning. Cancel preserves account/home/selection. Confirm removes the run-owned account and selects System default for future launches. Claude warns shared history remains; Codex warns native history/MCP loss. Existing running-process safety/refusal stays honest and retryable.

### AC7: Credentials and secret-free errors
For MiniMax, OpenCode Go and ZCode, configure synthetic keys through masked fields, observe configured/readable quota, clear and observe unconfigured state. Mask cookies as applicable. Failed provider requests never expose token or full private path. Cursor/Grok expose source/read-only language without login mutation.

### AC8: Reset conflict/failure/retry
Open a synthetic Codex offer and cancel with no consume. Capture then change account or offer before confirm: visible refusal and no consume. An unknown provider outcome retains retry identity; retry/replay cannot spend twice. Opt-out preference does not invalidate the displayed offer. No real reset credit is used.

### AC9: Retained settings warning and recovery
Synchronize a run-owned valid Codex source config. Remove/empty/unreadable source: private last-good bytes remain and warning appears in Accounts. Restore valid source: sync succeeds and warning clears. Errors contain no secret/private source path.

### AC10: Terminal eligibility and prior evidence
Given terminal and background/structured sessions bound to A, select B. Terminal restart controls count only eligible terminals. Background/structured identity stays A; the terminal restart endpoint refuses such requests without stopping the runner. Preserve actual C-leg content proof, authority/preference fence, full-account reload promotion and committed-action/C1 regressions. Prior review independence limitations remain historical facts, not retroactive clearance.

### AC11: Native handoffs
Keep the existing pending synthetic-only browser/clipboard, Keychain denial, window visibility and real pane keyboard-focus scenarios. Name exact web/API observations separately. No native pass is inferred.

## Technical decisions
### Architecture and shared contracts
Reuse plugins/quirky.accounts/src/types.ts, usage/types.ts and quirky-plugin.json unchanged. Existing AccountState revision/staleSessions/preferences/configWarnings and login begin/status/cancel methods are the committed contract. No exported signature/schema migration is required. Selection/offer fences must not be weakened. model.ts cancellation owns login generation/timer recovery; service.ts readStaleSessions projects terminal restart candidates only. restarts.ts retains terminal-only execution validation and truthful account_sessions records remain stored.

### Implementation ownership
One wave, maximum3 isolated implementers, no semantic dependency edges after this contract commit: renderer model and its regression tests; service stale-session projection plus public API acceptance; isolated runtime fixture/smoke support and missing acceptance matrices in separately owned files. Parent owns spec, decisions, actual guarded web scenarios, integration and landing. No concurrent file writes, no worker commits, no protected-loop edits. Implementers skip build/lint/test/formatters mid-flight; parent verifies after the barrier.

### Verification
Use existing isolated daemon API harnesses and real daemon/PTY fixture CLIs. Run targeted regressions/affected suites, scripts, typecheck and build; exercise each reachable built-web scenario with guarded likeuser actions. One cross-family final review round and one accepted-finding fix batch; preserve limitations and any genuinely unclosed finding. Merge build/roadmap once just before landing and read incoming decisions; canonical queue owns landing. Every owned process/browser/home is stopped and scratch cleaned after evidence is retained.

## Industry insights
No external research swarm: LOOP specifies feature docs, roadmap and prior decisions as research. Native account identity and accumulated transcript content, not ID/env echoes, establish continuation. Sources: external accounts.md, original m3-accounts D24 and m3-accounts-remaining-flows D5–D19.

## Deferred ideas
None added. Named native-only handoffs and existing platform/non-slice exclusions remain explicit.

## Glossary
Selection revision: account-action authority fence. Offer: account-bound reset snapshot. Managed home: ownership-proven private provider state. Kept session: process intentionally retaining its old identity. Native continuation: provider reads prior conversation bytes at the destination home.
