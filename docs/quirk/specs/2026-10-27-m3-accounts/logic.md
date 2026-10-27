# Accounts, usage and rate limits

## Status & amendments

Status: Design accepted by unattended defaults under LOOP.md; tech spec required (plugin/UI/launch subsystem boundary). Combined Codex promote/refute review completed; confirmed contract findings corrected before implementation.

**Amendments:** 2026-10-27 — clarified custom-home precedence, queued-restart supersession, credential configuration, shared session-info statusline ownership and reset-credit authorization scope after spec review. Implementation coverage review made Gemini OAuth opt-in and retained Codex settings/config warnings explicit (AC18), and required actual prior conversation data—not merely a repeated provider ID—for cross-account resume. No feature-flow scope removed.

**Operator landing scope:** 2026-10-27 — the operator authorized landing proven core account/usage flows within one hour, fixing blocking findings only. Extended UI/native acceptance is explicitly carried by dependent queue item `m3-accounts-remaining-flows` and `docs/loop/BLOCKERS.md`; these observations are not claimed complete. Core built-UI Hide/restore, Claude add/select/restart and Usage popover/refresh passed, and real daemon/PTY Claude/Codex A→B resumes verified prior transcript contents. The broad affected-package run timed out; typecheck and 48 core tests passed. The landing command owns whole-suite integration verification.

## Conceptual model

Quirky observes subscription allowances without sending prompts or changing provider logins. The Usage status bar and popover show each configured provider's last authoritative quota snapshot, its reset times and any refresh failure. A missing reading is never zero usage.

Claude and Codex additionally support managed accounts. Each login owns a private provider home. System default remains the user's existing CLI environment. Selecting a managed account changes future launches; it does not copy credentials over System default, log another account out, or pretend an already-running process changed accounts. The daemon is authoritative for accounts, selection, pending sign-ins, stale sessions and usage; every UI action is scriptable.

## Scope and non-goals

This item ships macOS-local read-only meters for Claude, Codex, Gemini, Antigravity, OpenCode Go, Kimi, MiniMax, Grok, Cursor and ZCode, plus managed Claude/Codex add, cancel, reauthenticate, select, remove, next-launch routing and running-session restart flows. It includes the settings and status-bar preferences needed by those flows and Codex reset-credit redemption where offered.

Windows/WSL setup and keychain alternatives are deferred platform work. Remote-host accounts belong to the hosting scope; no local account state may be mislabeled as remote state. Other providers' account switchers, managed OpenCode/Devin profiles and Antigravity account capture are not part of the specifically named Claude/Codex switching slice. Transcript-based usage analytics is a separate feature; this item must not manufacture a history view or a dead link to one.

## Data flow

Provider adapters inspect existing local credentials or provider-owned CLI protocols and produce normalized snapshots. Refresh runs once per provider/account at a time; failures preserve eligible last-known values and annotate their age and reason. The UI renders daemon snapshots/events, never credentials or account-directory paths.

Account mutations serialize. Official unmodified CLI sign-in runs in a newly owned private home or the saved account's existing home. Successful Claude addition saves without selection; successful Codex addition saves and selects. Pending login cancellation removes only never-saved owned homes. Selection commits atomically with the next-launch routing pointer and publishes state before requesting usage refresh. Required account preparation is a separate public provider operation before process spawn, not a best-effort launch hook. Existing launch hooks retain their no-veto/failure-skip behavior.

## Key decisions & rationale

Use native CLI login and isolated homes, Codex stdio App Server quota reads, provider-specific observed read-only endpoints, and Claude live statusline readings. Direct HTTP OAuth reimplementation would duplicate provider authentication; manually imported snapshots would not satisfy live refresh or add-account parity. Undocumented quota protocols remain version-sensitive and report unavailable/error rather than fabricated data.

Default Claude configuration/auth files are never rewritten. Shared conversation history is distinct from configuration: managed homes may link existing default history and preserve managed conversations for cross-account resume, but setup must not overwrite existing default files. Codex managed homes mirror configuration/resources without changing the default login. Ownership markers, canonical containment and no-symlink traversal guard destructive operations.

## Decisions locked

- **Scope:** all ten meters, only Claude/Codex switchers; macOS-local first; no provider switching implied by a read-only row.
- **Account identity:** System default is inherited; managed identity is private; custom CLI-home overrides remain explicit user intent. Account changes affect future CLI invocations in existing Quirky shell terminals as well as new agent launches.
- **Launch safety:** missing/broken selected Claude profile refuses agent launch. Indeterminate Codex ownership/readability refuses launch without deselecting. Required provider preparation does not modify the locked launch-hook failure contract.
- **Presentation:** Compact and Used are defaults; Detailed and Remaining are durable preferences. Urgency always derives from consumed percentage (60% warning, 80% danger), independent of percentage direction.
- **Freshness:** 15-minute poll interval, focused/visible-window gating; 5-minute focus debounce; manual Refresh bypasses normal debounce; background polling respects Retry-After. Last-good values survive errors for 30 minutes, or 24 hours after rate limiting. A late response cannot overwrite a newly selected account's reading.
- **Errors:** signed-out/unavailable, authentication expired, delegated credential refresh, keychain unavailable, network/server/parse failure and HTTP 429 stay distinguishable. No meter refresh rotates Claude/Grok/Cursor credentials or performs model work.
- **Secrets:** tokens, callback secrets and full local paths never enter UI reports/events, logs or persistent quota snapshots. Login links are explicit trusted authorize URLs, not arbitrary output URLs.
- **Mutation safety:** add/reauth/select/remove serialize; a newer user mutation supersedes pending login. Removal requires confirmation unless API/CLI passes yes. Never delete an unowned/symlink-replaced home or silently erase an account after transient I/O failure.
- **Running sessions:** Claude defaults to Ask, with Always restart/Never restart policies. Busy Claude sessions wait for idle before resume. Codex panes retain old account and show Keep old account/Restart choices. Restarts retain provider conversation ID and working directory; failure remains visible rather than claiming the switch applied.

## Behavior and acceptance scenarios

Every scenario is driven through `quirky accounts` or daemon methods, with UI scenarios also exercised in the web surface. Provider fixtures may replace external CLI/network boundaries; they must not touch real credentials or claim real-provider authentication was exercised.

### AC1: Discover and read usage

Before: fresh isolated home, no provider sign-ins. Open Usage: Configure usage tracking appears, with Hide from status bar. After hiding and restarting, it stays hidden. With a signed-in provider fixture, Refresh produces that provider's chip; unavailable data is not 0%.

### AC2: Compact, detailed and direction

Before: Claude 5h 39%, weekly 26%, model-specific weekly 0%; Codex weekly 1%. Compact shows the most-consumed window and reset duration. Detailed shows all windows/buckets and bars. Switch Used to Remaining: 39 becomes 61, 26 becomes 74, and 1 becomes 99, while urgency remains based on consumption. Preferences survive restart.

### AC3: Popover, drill-in and layout

Before: multiple providers at different pressure. Open Usage: worst consumed first, refresh, Compact/Detailed, provider drill-ins and Manage Accounts work. Inactive account bars load on expansion (60-second debounce, sequential Codex probes). Narrow width collapses trailing chips into +N with meaningful tooltip; icon-only density has distinct provider badges. Toggle a provider's visibility through status-bar context menu/Appearance settings and verify durable state.

### AC4: Snapshot failures and retry boundaries

Before: authoritative 75% reading. A network failure within 30 minutes leaves 75% marked stale with Network issue; after expiry it shows error without old quota. A 429 honors numeric and HTTP-date Retry-After and retains data up to 24 hours. Manual refresh bypasses ordinary debounce; automatic refresh cannot hammer the endpoint. Fetching retains previous data; stale account responses cannot cross the selection boundary.

### AC5: Provider-specific usage and credentials

Before: fixture sign-ins for all ten providers. Refresh maps each provider's real source windows/buckets, reset timestamps, balances and plan metadata; each source's unsupported plan/missing credential/auth failure is honest. Grok reads GROK_HOME auth and never refreshes expired tokens. Cursor prefers live Keychain, CLI then IDE credentials; fallback errors do not hide a working later source. Claude scoped Keychain never falls back to another managed account's token. API-key Codex/Claude billing is not misrepresented as subscription quota. Credential source and age are visible without secret values.

### AC6: Add Claude

Before: System default selected. Start Add Account: private home, official CLI browser sign-in, busy and Cancel. Finish fixture sign-in: saved account email/organization appears, default remains selected. Copy sign-in link instead captures only trusted local-callback Claude authorize URLs. Duplicate same identity/organization is refused without orphaning a home. Default configuration/auth remains byte-identical.

### AC7: Add Codex

Before: System default selected. Add runs official Codex login in private CODEX_HOME, exposes trusted link Copy/Open and Cancel. Success saves and selects the account. A non-openai top-level model_provider refuses OAuth addition without modifying default config/auth. Auth storage is explicitly isolated rather than relying on shared keyring state.

### AC8: Cancel, failed and overlapping sign-ins

Before: pending login. Cancel/superseding mutation terminates its process and removes only a never-saved owned home. A completed Codex auth write cannot be rolled back by a racing cancel. Reauthentication failure preserves the saved account and home. Two concurrent adds/selections never lose persistent state. Shutdown terminates owned login/probe processes.

### AC9: Reauthenticate and select

Before: saved signed-out account. It is visibly Needs sign-in and cannot be selected. Reauthenticate restores identity without removing history; selection persists across daemon restart. Claude System default label has grammatical runtime copy (not “your current this device Claude login”). Both Settings and Usage switchers expose identical selection and Manage Accounts paths.

### AC10: Next-launch routing and safety

Before: account A selected and shell already open. Select B, launch next Claude/Codex from that shell and through session create/resume: B's private home is used; existing processes remain A. Select System default: inherited custom/default home restored. Explicit non-injected user home overrides in per-agent launch config or inside the shell win; record the actual custom identity, not B. A missing selected Claude home fails before spawn. An unreadable Codex home preserves selection and refuses launch; an untrusted marker/path is never followed or deleted. Symlink replacement cannot target real user homes.

Conversation availability is part of preparation: a Codex resume into another home must safely bridge the captured local rollout before starting the CLI. Missing, mismatched or untrusted source data fails actionably rather than opening an empty chat. Claude accounts and System default share the same history even when the first managed profile predates the default history directories; creating another account later cannot strand the first account's conversations.

### AC11: Claude running-session policy

Before: running Claude A with captured provider conversation ID. Select B with Ask: Switched to B identifies affected sessions and choices. Keep as is leaves process A. Restart continues same conversation in B; busy session waits for idle. If C is selected before idle, the B-authorized intention is invalidated and choices recomputed under the current policy, never silently retargeted. Don't ask again selects Always restart. Never restart changes only future launches. A failed restart preserves a visible actionable old-session state.

### AC12: Codex stale-session chip

Before: running Codex A. Select B: pane shows Account switched, current old identity, Keep old account and Restart; Usage drill-in reports stale-session count. Keeping does not relabel A as B. Restart resumes same provider conversation/cwd under B and removes the old stale indicator. The new session/tab receives focus through scriptable UI state.

The prior conversation's persisted contents are available in the selected home before the resumed provider starts. Tests and real-daemon fixture smoke must read that prior content under the new home; identical ID/argv/session-record assertions alone do not establish continuation.

### AC13: Remove accounts

Before: saved selected account with history. Without yes, removal requests explicit provider-specific destructive confirmation. Cancel preserves everything. Confirm removes only its owned private state/keychain credential, clears active pointer to System default and evicts usage caches. Codex warns that history/MCP logins are deleted. Transient removal failure keeps the account available for retry; a running profile cannot be silently destroyed.

### AC14: Live Claude usage

Before: selected A, a Claude session supplies statusline 5h/7d windows through the session-info-owned authenticated feed. Accounts consumes that same payload rather than installing another statusLine or erasing custom-command consent/output. Ingest only when config directory matches active account; deduplicate repeated readings and prefer fresh live data over automatic OAuth polling. An A reading arriving after selection B never contaminates B. Disabling the feed producer stops live readings and leaves normal quota polling. No global settings write.

### AC15: Codex balances and reset credits

Before: Codex quota includes credits and reset credits with expiry. Drill-in displays them. Reset now confirms unless skip-confirm preference/yes applies, then uses one idempotent redemption bound to the displayed account and offer revisions. Confirm A, select B, submit: reject without spending either account's credit. Repeating request ID cannot consume twice or migrate to B. Failure leaves original credit state visible and retry outcome explicit. A reading at quota saturation shows balance/unlimited metadata, not invented remaining allowance.

### AC16: Scriptability and plugin replacement

Before: built-in enabled. API catalog exposes schema-declared accounts methods/CLI group for every action, preferences, visible Usage/switcher state and pending restarts. Events mirror state without secrets. Disable/override the plugin: no hard-coded account UI remains; status-bar slots use the same public API for third parties. Disabled accounts do not impose managed launch routing.


### AC17: Configure provider meter credentials

Before: MiniMax/OpenCode Go/ZCode have no usable credential. Set the supported masked credential through UI or CLI stdin/file, then refresh: configured/readable state and authoritative quota appear, never the credential value. Clear the credential: later refresh stops using it and falls back only to a documented native source. Events, logs, preferences, usage snapshots and API responses remain secret-free. Invalid provider/credential-kind/base-URL combinations reject without saving.

### AC18: Retain Codex settings when synchronization fails

Before: a managed Codex profile last synchronized valid default settings. Change the source config and prepare/select the account: valid settings mirror into the private home with file-based credentials enforced, even when the original default config never existed. If the source becomes missing, empty, unreadable, invalid, or cannot be copied, retain the last good private settings and show an actionable Codex warning in Accounts. Never silently inject a non-OpenAI model provider into an OAuth managed account. Default config/auth stays unchanged; warnings expose neither credentials nor full private paths.

## Orca defects and corrections

- Incorrect local-runtime copy (“your current this device Claude login”) is corrected and covered by AC9.
- Missing Codex duplicate-account detection is hardened: repeated identical provider/workspace identity is rejected without selecting or deleting the existing account (AC7/AC8).
- Poll interval is consistently 15 minutes, not an RPC comment claiming five minutes (AC4).
- Inventory language never promises Cursor/Grok switching (AC5).
- The doc's blanket “default home never written” claim is narrowed to default config/auth; history sharing cannot overwrite existing data (AC6/AC10).

## Industry insights

- [Claude authentication](https://code.claude.com/docs/en/authentication) documents per-directory accounts; Console keyless sign-ins are not universally isolated. Reject unsupported identity modes rather than promise separation.
- [Claude statusline](https://code.claude.com/docs/en/statusline) exposes live five-hour and seven-day windows; it is not a cross-account polling API.
- [Codex App Server](https://learn.chatgpt.com/docs/app-server) documents account/rateLimits/read and update notifications over stdio. Tool sandbox read-only does not mean auth refresh is write-free; no claims of zero provider-owned credential writes.
- [Codex authentication](https://learn.chatgpt.com/docs/auth) distinguishes file/keyring storage. Managed accounts need explicit file storage. Private WHAM/OAuth quota endpoints are version-sensitive and must fail honestly.
- [Claude credential policy](https://code.claude.com/docs/en/legal-and-compliance) distinguishes direct authentication in unmodified Claude Code from a product collecting/proxying credentials. Quirky invokes the unmodified binary; no custom OAuth broker or token-collection UI is added.

## Deferred ideas

Windows/WSL adapters and native browser-launch/dialog checks are logged as platform/native handoffs. Full-text transcript usage analytics and non-Claude/Codex account switchers remain outside this item. No unrelated retry/telemetry framework is introduced.

## Glossary

Managed home: private provider state directory owned by Quirky. System default: inherited provider configuration, without managed routing. Snapshot: authoritative provider quota reading, not a token-cost estimate. Stale session: live process launched on an account other than the current selection. Required account preparation: public plugin method whose rejection prevents spawn, distinct from best-effort launch hooks.
