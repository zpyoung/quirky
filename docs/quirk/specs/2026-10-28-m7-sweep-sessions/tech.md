# Session extras sweep technical specification

Status: Local repairs and canonical owner cutovers implemented. One bounded cross-family review completed: C/X PASS; S retains a policy-rejected test-mirror restoration finding, recorded without relabeling its NEEDS_FIXES gate. Final post-review checks remain required. Visual/native limits remain explicit in the decision log.
Logic: [scope and scenarios](logic.md#behavior-and-acceptance-matrix).

## Architecture
For [data flow](logic.md#data-flow), preserve existing Bun daemon built-ins and React UI contribution ownership. All paths below are relative to `/Users/zpyoung/orca/workspaces/quirky/build-lane-3/`; isolated component paths substitute their own worktree root. No private cross-plugin imports or kernel contract changes are planned.

- `plugins/quirky.accounts/src/window/Usage.tsx:388-488`, `StatusBarUsage`: measures actual hidden rendered chips, renders visible prefix and suffix, reports projection through existing public report hook.
- `plugins/quirky.accounts/src/window/styles.ts:39-44`: root/measurement/chips gap and overflow containment.
- `plugins/quirky.accounts/src/window/AccountsSettings.tsx:28-49`, `LoginLinkNotice`: copy/open/cancel pending provider login.
- `plugins/quirky.accounts/src/window/model.ts`, `AccountsUiStore`: current pending-login parsing, validated URLs and effect/error handling. Add a method only if needed to fit its existing effect convention.
- `plugins/quirky.terminal/src/layout/service.ts:1179-1184`: public `openExternal`, already used by other built-ins. It is a consumer contract, not an Accounts-owned file.
- Existing Vault `plugins/quirky.vault/src/actions.ts`, `plugins/quirky.vault/src/window/HistoryPanel.tsx`, `plugins/quirky.vault/test/actions-parity.test.ts` and `plugins/quirky.vault/test/window-parity.test.ts` already own source actions/archived handoff. Existing `plugins/quirky.terminal-dock/test/defects.e2e.test.ts`, `plugins/quirky.terminal-dock/test/support.ts` and `plugins/quirky.session-info/test/api.test.ts` supply real-daemon fixture conventions. No speculative code changes in those plugins.

## Contracts and interfaces
Supports [locked decisions](logic.md#decisions-locked).

CONTRACT: Public opener `quirky.terminal/openExternal` accepts `{target:string,reveal?:boolean}` and returns `{ok:true}` on accepted system-handler invocation, or throws. It allows http/https/mailto and absolute paths, but Accounts must pass only its already-validated provider authorize URL. A successful invocation is not proof a real OAuth login completed; UI must not claim login completion.

CONTRACT: Pending login retains `{id,provider,accountId,status,url,error,result}` with provider `claude|codex`, status `pending|complete|error|cancelled`, url `string|null`. The existing model parser enforces allowed authorization domains and protocol. Opening must use the captured rendered URL, never a caller-provided arbitrary URL, and preserve account selection, pending login and cancellation. Failure must produce visible feedback through existing toast/error convention. Do not add a new system opener or expose auth secrets.

CONTRACT: Usage fitting uses the actual space available to `.usage-chips`, exact rendered chip widths, actual inter-chip column gap, and actual rendered overflow button width including its own layout border/padding. Choose the largest fitting visible prefix. For N visible prefix chips plus a suffix button, include N gaps; for all chips include max(0,N-1) gaps. For no fitting provider show the suffix button, and preserve refresh/Usage controls. Avoid quadratic prefix rescanning. Hidden measurement is inert, excluded from accessibility/interaction and cannot enlarge the document scrollable area. An observer cleanup/remount must not retain stale measurements or loop on its own visibleCount changes. Wide recovery and preference changes remeasure.

Below the first-provider boundary, reserve the suffix button's own minimum width rather than clipping it in a shrinking flex child. Verify220px and larger allocations; the Usage trigger remains an independently reachable way to read every provider even when none fits individually. OS-handler success after spawn remains a native observation; visible error feedback covers a rejected public opener invocation, not eventual OAuth outcome.

## Data models and schemas
Supports [A1–A5](logic.md#behavior-and-acceptance-matrix). No durable schema migration or public shape change. Existing Accounts preferences retain `mode:compact|detailed`, `direction:used|remaining`, `density:normal|icons`, `visibleProviders:string[]`, `hidden:boolean`. Existing public report retains `visibleProviders` and `collapsedProviders` in original order. Runtime fixture metadata is an external0600 JSON object naming owned `home,userHome,url,token,workspace,session` plus created source IDs/paths; never commit it or print token into user chat.

## Component ownership and acceptance
Supports [execution contract](logic.md#execution-contract).

### A: Accounts responsive suffix and sign-in opening
One isolated worktree, one task, no semantic dependencies. Allowed source files: `plugins/quirky.accounts/src/window/Usage.tsx`, `plugins/quirky.accounts/src/window/styles.ts`, `plugins/quirky.accounts/src/window/AccountsSettings.tsx`, `plugins/quirky.accounts/src/window/model.ts`, and optional new `plugins/quirky.accounts/src/window/usage-fit.ts`. New regression targets: `plugins/quirky.accounts/test/sweep-ui.test.tsx` and `plugins/quirky.accounts/test/sweep-fit.test.ts`. Tests expose fit boundary transitions and captured login URL/error behavior, never source-text/CSS-string pins or copied constants. A numeric fit test covers gap/button-width invariants; actual browser measurement proves layout containment. Under the operator's later policy, parent runs `bun scripts/suite.ts plugins/quirky.accounts/test/sweep-fit.test.ts plugins/quirky.accounts/test/sweep-ui.test.tsx`, followed by affected suites.

### B: External isolated real-runtime scene and probes
No repository edits. Own `/tmp/quirky-session-sweep.2Whr6x/runtime/**` only. Prepare real daemon+PTY fixture using built-in UI dist assets and owned fake provider executables/native-format transcripts. Prepare scripts that drive public API and generated CLI for all five owners, and a long-lived scene for parent guarded web use. Every runtime has fresh QUIRKY_HOME/HOME/provider/XDG dirs, fake keychain where required, and deterministic no-network provider fixtures. Close clients/daemon/PTY/children in finally; explicit signal cleanup for the long-lived scene. Reuse existing acceptance harnesses/data shapes rather than inventing successful responses. Parent runs literal scripts from their documented runtime commands after both agents return. No test/build/lint/typecheck/check/formatter mid-flight, no provider network or model calls. Return exact commands, metadata fields, safety/cleanup mechanics and any uncovered scenarios; no passing claims.

Parent owns specs/decisions/docs/native handoff, final command execution, actual browser campaign, exact scope/HEAD audit, commits, merge and landing. No task owns main source edits while implementers run. Scope expansion must be explicit before the edit.

## DO-NOT-CHANGE fences
Supports [scope](logic.md#scope-and-non-goals).
- Accounts login/profile/usage/reset/restart daemon state and schemas are fenced: the fixes are presentation/system-browser invocation, not new credential or account authority.
- Public terminal opener and kernel/UI protocol are fenced: existing API already supplies the required behavior.
- All unrelated plugin source is fenced until a concrete failure names a new scoped repair. Historical completed Vault/Dock failures do not justify edits.
- `docs/loop/queue.json`, `docs/loop/DECISIONS.md`, `docs/loop/LOOP.md` and `scripts/build-loop/**` are protected; controller only for shared data.
- Inherited `.serena/` and real provider homes are untouched. No node_modules deletion or global configuration changes.

## Always / Ask / Never
Always absolute edit paths in component worktrees; existing public API and native source semantics; exact safe URL captured from validated projection; all worker processes and tests isolated. Ask parent (not user) before changing scope or signatures. Never commit or run checks mid-flight; never touch user state, launch a real provider/model, add authentication fallback, widen mobile grants, add native chat/dictation, or suppress a failing check.

## Cross-cutting
Supports [defect obligations](logic.md#orca-defects-and-regression-obligations). No migration, new telemetry, retries or abstraction. Preserve component baseline HEAD and content snapshots; parent audits every source/test path plus main after all workers return. Original .serena remains untracked metadata, not staged. Native-only failures receive pending owner scenarios without erasing historical reports. Opening tests log the public opener effect in an owned profile rather than launch a real external auth URL. Failures remain distinct from absence or successful login.

## Testing strategy
Supports the complete [acceptance matrix](logic.md#behavior-and-acceptance-matrix). Map inherited test/API/CLI scenarios and drive actual changed paths with isolated smoke scripts. Normal end-phase sweep applies; no build-first test suppression. Required commands:

COMMAND: `bun scripts/suite.ts plugins/quirky.accounts plugins/quirky.vault plugins/quirky.handoff plugins/quirky.session-info plugins/quirky.terminal-dock plugins/quirky.terminal plugins/quirky.session plugins/quirky.structured plugins/quirky.agents packages/ui`

COMMAND: `bun scripts/suite.ts scripts`

COMMAND: `bun run typecheck`

COMMAND: `bun run build`

Built-web guarded campaign covers A1/A3 initial repairs plus each feature's controls/state/actions and all stopped completion goals. Native-only scenarios go in the new `docs/loop/native/m7-sweep-sessions.json` pending with owned fixtures. Fix actual UI failures at their root and rerun failed paths; no partial/unobserved pass claims. Catch up once before the final review, read every imported decision log and rerun affected checks against that merged source. Then one cross-family discovery round and one accepted-fix batch per LOOP, followed by build/tests and queue-controlled landing; no unreviewed discretionary catch-up after review.

Public-contract evidence is behavioral, not a copied manifest inventory: generated Agents CLI resolves through the actual daemon; Session CLI restores/resumes and validates launch flags against committed provider/cwd state; cold restore checks actual launch env/argv, identity and refusal/no-spawn/history boundaries; Handoff retains required-input validation and real daemon contribution loading. The new Accounts generated-CLI lifecycle case and independent plugin validator cover the fixed stable command IDs. Do not restore source/catalog/default/mock-forwarding snapshots merely to satisfy review S1; retain its formal gate and caller disposition in BLOCKERS and decisions.

## Non-goals
See [logic exclusions](logic.md#scope-and-non-goals). No plugin restyle/new shell; new UI redesign items retain ownership. This item repairs existing behavior, preserving original visuals until those owners cut over. No verification-only queue follow-up.

## Observed end-phase repair scopes
Supports the dated [logic amendments](logic.md#status--amendments), not a broader redesign.

- Accounts CLI repair owns `plugins/quirky.accounts/cli.ts`, direct command-key consumer in `plugins/quirky.accounts/test/accounts-api.test.ts`, and new `plugins/quirky.accounts/test/sweep-cli.test.ts`. Existing stable manifest IDs and public words are unchanged. Match all13 kebab-case IDs with implementation keys; no camelCase aliases.
- Discovery diagnostic owns `plugins/quirky.agents/src/service.ts` only for the proven direct-process executable resolution root. `plugins/quirky.agents/src/detect.ts:106-134` distinguishes `locate().path` from `resolveExecutable()`, which deliberately returns null for on-login-PATH commands because shell launches need no override. Direct model probes need the located path for both cases. Preserve current provider-account environment and nonempty snapshot contracts. Existing provider discovery/API tests supply the regression; unknown login-timeout cause does not justify a speculative timeout/retry change.
- Vault sweep repair owns the actual failure paths in `plugins/quirky.vault/src/**` and `plugins/quirky.vault/test/**`, plus removal of the incidental catalog-list pin in `plugins/quirky.handoff/test/service-drafts.test.ts`. Fix only traced SC08 error/retry, SC15/16 paging, real-host contribution and Gemini setup/readiness failures; preserve every meaningful scope, redaction, source-preservation and generation assertion.
- Canonical `fix-test-ask-1028` remains lane12-owned. Consume its existing public-list exact-ID envelope fix at the single integration catch-up. No duplicate read endpoint, connection weakening, borrowed client or confirmation bypass is permitted here.
- Provider catalog repair owns `plugins/quirky.agents/src/core/entry.ts` only to apply the existing HTTP(S) link validator to optional homepage/install fields; invalid contributions remain rejected, with no schema expansion. Current provider-protocol fixtures use the exact supported provider IDs, and catalog/source/default mirrors are removed rather than replaced.
- Affected consumer fixtures in Accounts, Vault, Handoff, Session and Terminal retain real declared owner dependencies, isolated existing directories/transcripts and producer-bound lifecycle evidence. Nonterminal death is never inferred from absence in the PTY listing. Shell script fixtures use an explicit shell when multiple commands must survive the launcher's leading exec; async identity updates are awaited after workspace admission releases.
- Darwin-only terminal artifact/grant and Simulator acceptance remains unchanged and is routed through scripts/test-on-macos.txt. Do not weaken unsupported-platform refusal to make remote Linux runs pass. Paired-owner Accounts/Vault/Handoff composition remains the exact prerequisite-bound implementation successor in the logic spec, not a test-forwarder substitute.
- After the canonical Session fix lands, replace the eight overlapping Session source/fixture files verbatim from `f9ac6868`, not with competing repairs or unrelated restyle files. Preserve startup-only structured finalization from positive daemon-owner loss, provider-ID/cwd retention, live structured lease survival during ordinary PTY reconnect and lazy activation in the same lifetime. Include Structured consumer acceptance in the final affected gate; no custom Session/kernel/Structured implementation is introduced by this cutover.

## Verification policy amendment
The operator requires every subsequent test, including single cases and scripts, through `bun scripts/suite.ts`. Only the explicit macOS list and packaged native-app checks run locally. The completed guarded run and supplementary browser measurements retain their exact limited evidence; all local browsers and runtime processes were closed afterward. The remaining visual goals are not converted into API/mounted passes; see the item's recorded tool/policy-limit evidence. The actual five-owner daemon/PTY/CLI smoke was adapted temporarily to the remote runner, passed, and its four adapter files were archived and removed before final gates.
