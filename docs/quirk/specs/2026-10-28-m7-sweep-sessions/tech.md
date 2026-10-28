# Session extras sweep technical specification

Status: Reviewed autonomously after combined spec review; implementation not yet started.
Logic: [scope and scenarios](logic.md#behavior-and-acceptance-matrix).

## Architecture
For [data flow](logic.md#data-flow), preserve existing Bun daemon built-ins and React UI contribution ownership. All paths below are relative to `/Users/zpyoung/orca/workspaces/quirky/build-lane-3/`; isolated component paths substitute their own worktree root. No private cross-plugin imports or kernel contract changes are planned.

- `plugins/quirky.accounts/src/window/Usage.tsx:388-488`, `StatusBarUsage`: measures actual hidden rendered chips, renders visible prefix and suffix, reports projection through existing public report hook.
- `plugins/quirky.accounts/src/window/styles.ts:39-44`: root/measurement/chips gap and overflow containment.
- `plugins/quirky.accounts/src/window/AccountsSettings.tsx:28-49`, `LoginLinkNotice`: copy/open/cancel pending provider login.
- `plugins/quirky.accounts/src/window/model.ts`, `AccountsUiStore`: current pending-login parsing, validated URLs and effect/error handling. Add a method only if needed to fit its existing effect convention.
- `plugins/quirky.terminal/src/layout/service.ts:1179-1184`: public `openExternal`, already used by other built-ins. It is a consumer contract, not an Accounts-owned file.
- Existing Vault `src/actions.ts`, `src/window/HistoryPanel.tsx` and `test/{actions-parity,window-parity}.test.ts` already own source actions/archived handoff. Existing dock `test/defects.e2e.test.ts`, `test/support.ts` and session-info `test/api.test.ts` supply real-daemon fixture conventions. No speculative code changes in those plugins.

## Contracts and interfaces
Supports [locked decisions](logic.md#decisions-locked).

CONTRACT: Public opener `quirky.terminal/openExternal` accepts `{target:string,reveal?:boolean}` and returns `{ok:true}` on accepted system-handler invocation, or throws. It allows http/https/mailto and absolute paths, but Accounts must pass only its already-validated provider authorize URL. A successful invocation is not proof a real OAuth login completed; UI must not claim login completion.

CONTRACT: Pending login retains `{id,provider,accountId,status,url,error,result}` with provider `claude|codex`, status `pending|complete|error|cancelled`, url `string|null`. The existing model parser enforces allowed authorization domains and protocol. Opening must use the captured rendered URL, never a caller-provided arbitrary URL, and preserve account selection, pending login and cancellation. Failure must produce visible feedback through existing toast/error convention. Do not add a new system opener or expose auth secrets.

CONTRACT: Usage fitting uses the actual space available to `.usage-chips`, exact rendered chip widths, actual inter-chip column gap, and actual rendered overflow button width including its own layout border/padding. Choose the largest fitting visible prefix. For N visible prefix chips plus a suffix button, include N gaps; for all chips include max(0,N-1) gaps. For no fitting provider show the suffix button, and preserve refresh/Usage controls. Avoid quadratic prefix rescanning. Hidden measurement is inert, excluded from accessibility/interaction and cannot enlarge the document scrollable area. An observer cleanup/remount must not retain stale measurements or loop on its own visibleCount changes. Wide recovery and preference changes remeasure.

## Data models and schemas
Supports [A1–A5](logic.md#behavior-and-acceptance-matrix). No durable schema migration or public shape change. Existing Accounts preferences retain `mode:compact|detailed`, `direction:used|remaining`, `density:normal|icons`, `visibleProviders:string[]`, `hidden:boolean`. Existing public report retains `visibleProviders` and `collapsedProviders` in original order. Runtime fixture metadata is an external0600 JSON object naming owned `home,userHome,url,token,workspace,session` plus created source IDs/paths; never commit it or print token into user chat.

## Component ownership and acceptance
Supports [execution contract](logic.md#execution-contract).

### A: Accounts responsive suffix and sign-in opening
One isolated worktree, one task, no semantic dependencies. Allowed source files: `plugins/quirky.accounts/src/window/Usage.tsx`, `styles.ts`, `AccountsSettings.tsx`, `model.ts`, optional new `usage-fit.ts` in that same window directory. Allowed test files: `plugins/quirky.accounts/test/sweep-ui.test.tsx`, `sweep-fit.test.ts`. Tests must expose consumer-visible fit boundary transitions and literal captured login URL/error behavior; no source-text/CSS-string pins or copied constants. A pure numeric fit helper test is useful only for the gap/button-width boundary invariant; actual browser measurement proves layout containment. Parent executes `bun test plugins/quirky.accounts/test/sweep-fit.test.ts plugins/quirky.accounts/test/sweep-ui.test.tsx` if both are authored, otherwise the exact created file(s), followed by affected suite.

### B: External isolated real-runtime scene and probes
No repository edits. Own `/tmp/quirky-session-sweep.2Whr6x/runtime/**` only. Prepare real daemon+PTY fixture using built-in UI dist assets and owned fake provider executables/native-format transcripts. Prepare scripts that drive public API and generated CLI for all five owners, and a long-lived scene for parent guarded web use. Every runtime has fresh QUIRKY_HOME/HOME/provider/XDG dirs, fake keychain where required, and deterministic no-network provider fixtures. Close clients/daemon/PTY/children in finally; explicit signal cleanup for the long-lived scene. Reuse existing acceptance harnesses/data shapes rather than inventing successful responses. Parent runs literal scripts from their documented runtime commands after both agents return. No test/build/lint/typecheck/check/formatter mid-flight, no provider network or model calls. Return exact commands, metadata fields, safety/cleanup mechanics and any uncovered scenarios; no passing claims.

Parent owns specs/decisions/docs/native handoff, final command execution, actual browser campaign, exact scope/HEAD audit, commits, merge and landing. No task owns main source edits while implementers run. Scope expansion must be explicit before the edit.

## DO-NOT-CHANGE fences
Supports [scope](logic.md#scope-and-non-goals).
- Accounts login/profile/usage/reset/restart daemon state and schemas are fenced: the fixes are presentation/system-browser invocation, not new credential or account authority.
- Public terminal opener and kernel/UI protocol are fenced: existing API already supplies the required behavior.
- All unrelated plugin source is fenced until a concrete failure names a new scoped repair. Historical completed Vault/Dock failures do not justify edits.
- `docs/loop/queue.json`, `DECISIONS.md`, LOOP.md and `scripts/build-loop/**` are protected; controller only for shared data.
- Inherited `.serena/` and real provider homes are untouched. No node_modules deletion or global configuration changes.

## Always / Ask / Never
Always absolute edit paths in component worktrees; existing public API and native source semantics; exact safe URL captured from validated projection; all worker processes and tests isolated. Ask parent (not user) before changing scope or signatures. Never commit or run checks mid-flight; never touch user state, launch a real provider/model, add authentication fallback, widen mobile grants, add native chat/dictation, or suppress a failing check.

## Cross-cutting
Supports [defect obligations](logic.md#orca-defects-and-regression-obligations). No migration, new telemetry, retries or abstraction. Preserve component baseline HEAD and content snapshots; parent audits every source/test path plus main after all workers return. Original .serena remains untracked metadata, not staged. Native-only failures receive pending owner scenarios without erasing historical reports. Opening tests log the public opener effect in an owned profile rather than launch a real external auth URL. Failures remain distinct from absence or successful login.

## Testing strategy
Supports the complete [acceptance matrix](logic.md#behavior-and-acceptance-matrix). Map inherited test/API/CLI scenarios and drive actual changed paths with isolated smoke scripts. Normal end-phase sweep applies; no build-first test suppression. Required commands:

COMMAND: `bun scripts/suite.ts plugins/quirky.accounts plugins/quirky.vault plugins/quirky.handoff plugins/quirky.session-info plugins/quirky.terminal-dock plugins/quirky.terminal plugins/quirky.session plugins/quirky.agents packages/ui`

COMMAND: `bun test scripts`

COMMAND: `bun run typecheck`

COMMAND: `bun run build`

Built-web guarded campaign covers A1/A3 initial repairs plus each feature's controls/state/actions and all stopped completion goals. Native-only scenarios go in `docs/loop/native/m7-sweep-sessions.json` pending with owned fixtures. If an actual UI failure occurs, fix the root and rerun that failed path; do not count partial/unobserved goals as passes. Final review uses one cross-family discovery round and one accepted-fix batch per LOOP; queue land owns the authoritative integration gate. Catch up once immediately before land and read imported decisions.

## Non-goals
See [logic exclusions](logic.md#scope-and-non-goals). No plugin restyle/new shell; new UI redesign items retain ownership. This item repairs existing behavior, preserving original visuals until those owners cut over. No verification-only queue follow-up.
