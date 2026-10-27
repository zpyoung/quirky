# GitHub hosting implementation contracts

Status: Draft for required joint Codex adversarial review. Logic: [logic.md](logic.md).

## Architecture

Implements [conceptual model](logic.md#conceptual-model) with new `plugins/quirky.hosting/`, following `plugins/quirky.git/main.ts:10-14` and public `PluginContext` in `packages/protocol/src/plugins.ts:49-80`. The static manifest declares methods, CLI commands and events. `main.ts` assembles independent operation tables over one environment. No daemon-kernel GitHub code, direct imports of another plugin or extra service process.

Internal modules: `src/runtime.ts` owns execution/auth/budget; `src/env.ts` owns selection/identity/configuration/invalidation; `src/refresh.ts` owns branch refresh/cache/scheduling; `src/pr.ts` owns PR lookup/create/stack/merge/state; `src/details.ts` owns checks/comments/files/review mutations; `src/work-items.ts` owns issues/search/Projects. Focused helper files may be added inside each declared task scope. Tests live under the same plugin and use daemon API, isolated gh executable fixtures, real temp git repositories and fresh QUIRKY_HOME.

## Code references

Implements [data flow](logic.md#data-flow). Existing anchors are absolute under `/Users/zpyoung/orca/workspaces/quirky/build-lane-11/`:
- `packages/protocol/src/plugins.ts:49-80`: PluginContext.provide/call/emit/openStore/error.
- `packages/daemon/src/plugins/dispatch.ts:111-135,181-212`: schemas, destructive confirmation and plugin invocation. No bypass for plugin callers.
- `plugins/quirky.git/src/daemon/env.ts:38-50`: resolve registered Git worktrees via quirky.worktree/resolve and forward only authenticated caller cwd/worktreeId.
- `plugins/quirky.git/main.ts:10-14`: table registration with formatContributionId.
- `plugins/quirky.git/quirky-plugin.json:12-27`: static method parameter conventions; its cli-command section supplies generated commands.
- `packages/daemon/src/plugins/discover.ts`: directory-driven built-in discovery; no hardcoded hosting registration needed.
- `packages/cli/src/plugin-commands.ts`: generated CLI route; do not add hosting to the kernel CLI switch.
- `plugins/quirky.worktree/src/daemon/set.ts` and `plugins/quirky.repo/src/settings.ts`: existing baseRef/defaultBase owners, unchanged.
- `docs/loop/decisions/m2-source-control-core.md:D20`: baseRef > project defaultBase > detected default drives PR base; no duplicate stored PR-base preference.

## Contracts & interfaces

Implements [locked decisions](logic.md#decisions-locked).

`CONTRACT:`
```ts
type Handler = (params: Record<string, any>, caller: PluginCaller) => unknown;
type Identity = { host: string; owner: string; repo: string };
type Scope = { worktree: Worktree; origin: Identity; repository: Identity; binding?: { host: string; user: string } };
type RunOptions = { idempotent?: boolean; timeoutMs?: number; maxBytes?: number; input?: string; ambient?: boolean; signal?: AbortSignal };
type HostingEnv = {
  context: PluginContext;
  resolve(params: Record<string, any>, caller: PluginCaller): Promise<Scope>;
  run(scope: Scope, args: string[], options?: RunOptions): Promise<string>;
  json<T = any>(scope: Scope, args: string[], options?: RunOptions): Promise<T>;
  rest<T = any>(scope: Scope, path: string, method?: string, fields?: Record<string, unknown>, options?: RunOptions): Promise<T>;
  graphql<T = any>(scope: Scope, query: string, variables?: Record<string, unknown>, options?: RunOptions): Promise<T>;
  git(scope: Scope, args: string[]): Promise<string>;
  changed(scope: Scope, data?: Record<string, unknown>): void;
  invalid(reason: string, message: string): Error;
  cache<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T>;
};
```

Tables are `runtimeMethods(env)`, `prMethods(env)`, `detailMethods(env)`, `workItemMethods(env)`, `refreshMethods(env, prHandlers)`, returning Record<string, Handler>. Factories `createEnv(context): HostingEnv` and optional `dispose()` lifecycle cleanup. Runtime setup may add a dispose member without changing consumer signatures. All REST paths are relative to the resolved repository's host, never full arbitrary URLs; helper `repos/<owner>/<repo>/...` is built from validated identity. GraphQL variables are arguments, not string interpolation of input. `rest` serializes fields to JSON on stdin and explicitly supplies method, including GET; graphql reads query or mutation to choose retryability. Normalized errors have fixed safe message and `data.reason`, optionally retryDisabledUntil and nextAutoRetryAt. Avoid logs of token-bearing argv/stdout/env.

Method ownership and fixed API names:
- Runtime: `repository`, `diagnoseAuth`, `viewer`, `rateLimit`, `accounts`, `configure`, `configuration`.
- PR: `forBranch`, `review`, `creationEligibility`, `create`, `createStacked`, `merge`, `autoMerge`, `updateReview`, `reviewers`.
- Detail: `checks`, `checkDetails`, `rerunChecks`, `comments`, `reviewComment`, `reaction`, `resolveThread`, `fileViewed`, `files`, `fileContents`.
- Work items: `listWorkItems`, `countWorkItems`, `workItem`, `workItemDetails`, `createIssue`, `updateIssue`, `issueComment`, `labels`, `assignees`, `projects`, `projectRef`, `projectViews`, `projectTable`, `projectField`, `projectItemMutation`.
- Refresh: `refresh`, `enqueueRefresh`, `visibleRefreshCandidates`, `refreshState`.

Every method taking repository context accepts optional worktree selector and honors registered-worktree validation; `configure` persists `{issueSourcePreference:'auto'|'origin'|'upstream', account:{host,user}|null}` in plugin-owned store keyed by worktree.repoId, not tokens. Origin resolution is mandatory for head identity. `prRepo` if supplied is `{host,owner,repo}` and must match origin/upstream. Issue preference selects issue repository with fallback marker; PR candidate resolution still prefers upstream and origin. `repository` returns all resolved candidate identities and origin/head identity.

PR `merge` requires positive number, expectedHead (40/64 hex), method squash/merge/rebase and action direct/queue; no actor-dependent behavior. Declare destructive in manifest. The handler refreshes GitHub state, rejects a mismatched head before mutation, validates review/merge/rules/stack metadata, and executes a single protected provider action. Queue/stack async polls at 1 s, up to 180 attempts, with bounded whole-operation deadline. Outcome is `{state:'merged'|'enqueued'|'pending', number, head, operationId?}`. Unknown completion reports pending with operationId only if GitHub returned it; otherwise safe unknown-completion error. Auto-merge is a separate action, not an alternate sitter merge implementation.

`updateReview` action enum edit/close/reopen/ready with optional title/body. `reviewers` action add/remove with nonempty logins. `reviewComment` action inline/reply with current head, file/line/range or reply id. Thread/reaction/file IDs are validated against the selected PR before mutation, preventing arbitrary cross-repo GraphQL IDs. `projectItemMutation` action enum editIssue/editReview/addComment/updateComment/deleteComment/updateIssueType; no arbitrary GraphQL or arbitrary HTTP escape hatch is exposed.

## Data models / schemas

Implements [API/CLI](logic.md#api-and-cli) and [acceptance](logic.md#behavior-and-acceptance-scenarios). Each method declares parameter/result JSON schemas and a generated CLI command `hosting <kebab-case name>`. Required identity inputs are positive integer number and validated selectors, never freeform remote endpoints. Result schemas describe operation-specific payloads; arbitrary upstream objects only occur as documented extensible detail properties.

`SCHEMA:`
```ts
type Lookup = {kind:'found'; review:Review; fetchedAt:number} | {kind:'no-review'; fetchedAt:number} | {kind:'unavailable'; reason:string; message:string; fetchedAt:number; retryDisabledUntil?:number};
type Review = {provider:'github'; number:number; url:string; title:string; body:string; state:'open'|'draft'|'closed'|'merged'; headRefName:string; baseRefName:string; headRefOid:string; baseRefOid:string; mergeable:'MERGEABLE'|'CONFLICTING'|'UNKNOWN'; checksStatus:'neutral'|'pending'|'success'|'failure'; reviewDecision:string; mergeStateStatus:string; autoMergeRequest:unknown; stack:unknown; mergeMethods:unknown};
type Page = {items:unknown[]; page:number; limit:number; totalCount:number|null; hasNextPage:boolean; truncated:boolean; partialFailures?:unknown[]};
type Detail = {files?:unknown[]; checks?:unknown[]; comments?:unknown[]; participants?:unknown[]; timeline?:unknown[]; partialFailures:string[]; filesUnavailable?:boolean; truncated?:boolean};
```

Bounds: query 8192 UTF-8 bytes; search offset+limit<=1000; PR files/timeline<=300; project table<=500; comments/thread source<=100; failed logs<=5, 100-line tail + failure context; raw files<=8 MiB with NUL binary detection; general output<=10 MiB, logs<=64 MiB. Reject invalid params before upstream mutation. Unknown provider states remain unknown, never inferred success. Lists and Projects use the feature doc's cursor/pagination semantics and expose cap/partial failures.

## DO-NOT-CHANGE fences

Implements [scope](logic.md#scope-and-non-goals).
- `docs/loop/LOOP.md`, `scripts/build-loop/`, shared queue/index: protected loop control; never edit.
- External research directory: read-only source requirements, not implementation output.
- Kernel dispatcher confirmations (`packages/daemon/src/plugins/dispatch.ts:181-195`): public safety invariant; hosting uses it, does not bypass it.
- Worktree/repo base ownership and existing selectors: existing consumers depend on them; call public methods instead of changing IDs or adding parallel registry state.
- No direct imports of daemon internals or sibling plugin implementations: overrides/disables must remain effective.

## Always / Ask / Never

Implements [locked decisions](logic.md#decisions-locked). Always pin trusted host/repo, use bounded processes/caches, invalidate generations before publishing mutation success, and keep failure distinct from absence. Resolve build-only ambiguities with existing patterns, recording choices in the decision log. If an actual locked decision makes the contracts impossible, block with evidence under LOOP.md; never ask a human in this unattended run. Never use real ~/.quirky/.claude/.codex or shared gh state in tests, expose tokens, use shell interpolation of user values, silently truncate successful results, replay mutations, admin-bypass merge, or delete a checked-out branch.

## Cross-cutting

Implements [data flow](logic.md#data-flow). One plugin-owned store holds account selection and issue preference; no migration of existing user state needed. Token caches remain memory-only, scoped by host/account and env execution hash. Four active processes, bounded queue/caches and teardown cancellation bound resources. Process-group handling is macOS-tested; Linux/Windows gaps get explicit deferred-platform decisions. Emit `quirky.hosting/changed` and `quirky.hosting/refresh` with repository/worktree identity, safe reason/outcome and monotonic sequence; callers never need stderr. Deactivation clears timers and terminates owned children; disabling methods prevents future registry calls.

## Testing strategy

Implements every [acceptance scenario](logic.md#behavior-and-acceptance-scenarios). Each module owns focused `test/<cluster>.test.ts` daemon API tests, using real isolated gh fixtures rather than overriding its own methods. Add a shared fixture helper under `test/helpers.ts` and dedicated CLI smoke coverage in `test/cli.test.ts`. Run tests only after implementation wave barrier; parent owns all checks. First stage API regression tests and observe missing-method failure before implementation, then run targeted changed files and all acceptance scenarios. Full gates: `bun run test`, `bun test scripts`, `bun run typecheck`; runtime smoke: fresh-home daemon + actual generated hosting CLI exercised against isolated fixture state, including safe refusal then confirmed head-guarded merge. No UI/native scenario exists in this API item. Final review uses verified Gemini cross-family reviewer after catch-up merge; one fix batch per LOOP.md.

## Non-goals

As [logic scope](logic.md#scope-and-non-goals): no provider other than GitHub, no hosting page/settings UI, no sitter engine, no worktree-from-PR implementation, no token store, no SSH execution relay, no WSL/native checks. One API seam is tested with client and plugin callers now; M6 migrates its new sitter by calling it.
