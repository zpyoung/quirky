# GitHub hosting implementation contracts

Status: Joint Codex spec review completed; implementation acceptance files and the isolated real CLI smoke verified. Full integration gates and the final cross-family review remain. Logic: [logic.md](logic.md).

## Architecture

Implements [conceptual model](logic.md#conceptual-model) with new `plugins/quirky.hosting/`, following `plugins/quirky.git/main.ts:10-14` and public `PluginContext` in `packages/protocol/src/plugins.ts:49-80`. The static manifest declares methods, CLI commands and events. `main.ts` assembles independent operation tables over one environment. No daemon-kernel GitHub code, direct imports of another plugin or extra service process.

`src/runtime.ts` provides account/configuration methods; `src/runtime-runner.ts` owns process admission, authentication, retries and budgets. `src/env.ts` owns selection, identity and generation-safe caches, with parsing in `auth-inventory.ts` and `identity-remote.ts`. PR entrypoints compose `pr-review.ts`, `pr-create.ts` and `pr-mutations.ts`; `refresh.ts` owns connection-scoped scheduling. Detail entrypoints compose check, comment and file helpers; work-item entrypoints compose `item-*` and `project-*` helpers. Tests live under the plugin and use real daemon API/CLI calls, isolated gh executables, temporary git repositories and fresh QUIRKY_HOME.

## Code references

Implements [data flow](logic.md#data-flow). Existing anchors are absolute under `/Users/zpyoung/orca/workspaces/quirky/build-lane-11/`:
- `packages/protocol/src/plugins.ts:49-80`: PluginContext.provide/call/emit/openStore/error.
- `packages/daemon/src/plugins/dispatch.ts:111-135,181-212`: schemas, destructive confirmation and plugin invocation. No bypass for plugin callers.
- `plugins/quirky.git/src/daemon/env.ts:38-50`: resolve registered Git worktrees via quirky.worktree/resolve and forward only authenticated caller cwd/worktreeId.
- `plugins/quirky.git/main.ts:10-14`: table registration with formatContributionId.
- `plugins/quirky.git/quirky-plugin.json:12-27`: static method parameter convention. Hosting adds explicit cli-command contributions as supported by `packages/daemon/src/plugins/cli-catalog.ts:171-227`; the current Git manifest does not supply that section.
- `packages/daemon/src/plugins/discover.ts`: directory-driven built-in discovery; no hardcoded hosting registration needed.
- `packages/cli/src/plugin-commands.ts`: generated CLI route; do not add hosting to the kernel CLI switch.
- `plugins/quirky.worktree/src/daemon/set.ts` and `plugins/quirky.repo/src/settings.ts`: existing baseRef/defaultBase owners, unchanged.
- `docs/loop/decisions/m2-source-control-core.md:D20`: baseRef > project defaultBase > detected default drives PR base; no duplicate stored PR-base preference.
- `packages/protocol/src/plugins.ts:184-189`, `packages/daemon/src/plugins/dispatch.ts:216-229`, and `packages/daemon/src/plugins/streams.ts:11-43`: add public `CallerConnection.onClose(callback): () => void`, usable over both socket and WebSocket, without opening a binary stream. Existing openStream rejects Unix sockets, so it cannot implement CLI visibility cleanup. Reuse the kernel's per-connection closer registry with a removable callback; invoke once on disconnect or immediately if already closed. No confirmation changes.

## Contracts & interfaces

Implements [locked decisions](logic.md#decisions-locked).

`CONTRACT:`
```ts
type Handler = (params: Record<string, unknown>, caller: PluginCaller) => unknown;
type Identity = { host: string; owner: string; repo: string };
type IssueSourcePreference = 'auto' | 'origin' | 'upstream';
type HostingConfiguration = { issueSourcePreference: IssueSourcePreference; account: { host: string; user: string } | null };
type Scope = {
  worktree: Worktree; origin: Identity; repository: Identity;
  binding?: { host: string; user: string }; candidates: Identity[];
  issueRepository: Identity; issueSourcePreference: IssueSourcePreference;
  issueSourceFellBack: boolean;
};
type AuthAccount = { host: string; user: string; source: 'keyring' | 'env'; active: boolean; scopes: string[] };
type Budget = { limit: number; remaining: number; resetAt: number };
type RateLimitSnapshot = { core: Budget; search: Budget; graphql: Budget; fetchedAt: number };
type RunOptions = { idempotent?: boolean; timeoutMs?: number; maxBytes?: number; input?: string; ambient?: boolean; signal?: AbortSignal; projectHost?: string };
type HostingEnv = {
  context: PluginContext;
  resolve(params: Record<string, unknown>, caller: PluginCaller): Promise<Scope>;
  run(scope: Scope, args: string[], options?: RunOptions): Promise<string>;
  json(scope: Scope, args: string[], options?: RunOptions): Promise<unknown>;
  rest(scope: Scope, path: string, method?: string, fields?: Record<string, unknown>, options?: RunOptions): Promise<unknown>;
  graphql(scope: Scope, query: string, variables?: Record<string, unknown>, options?: RunOptions): Promise<unknown>;
  git(scope: Scope, args: string[]): Promise<string>;
  changed(scope: Scope, data?: Record<string, unknown>): void;
  invalidate(scope: Scope): void;
  invalid(reason: string, message: string): Error;
  cache<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T>;
  cacheKey(scope: Scope, key: string): string;
  authAccounts(scope: Scope, force?: boolean): Promise<AuthAccount[]>;
  validateBinding(scope: Scope, binding: { host: string; user: string }): Promise<void>;
  rateLimit(scope: Scope, force?: boolean): Promise<RateLimitSnapshot>;
  configuration(worktree: Worktree): HostingConfiguration;
  saveConfiguration(worktree: Worktree, config: HostingConfiguration): void;
  onDispose(callback: () => void): void;
  dispose(): Promise<void>;
};
```
All external JSON/RPC/configuration enters as unknown and is validated with existing JSON-schema support or narrow runtime record/field guards before use. No bare any or unchecked external-input assertions. Shared data guards may live in src/data.ts owned by the runtime component.

Tables are `runtimeMethods(env)`, `prMethods(env)`, `detailMethods(env)`, `workItemMethods(env)` and `refreshMethods(env, prHandlers)`, returning Record<string, Handler>. `createEnv(context)` returns the shared environment; `main.ts` awaits `dispose()` on deactivation, after registered refresh cleanup callbacks run. All REST paths are relative to the trusted host, never arbitrary URLs. Repository paths come from validated configured identities or authenticated Projects metadata under the explicit project-host rule below. GraphQL variables are arguments, not interpolated input. `rest` writes JSON fields to stdin with an explicit method; GraphQL retryability distinguishes query from mutation. Errors expose fixed safe copy and `data.reason`, with retry timing when applicable. Never log token-bearing argv, stdout or environment.

Method ownership and fixed API names:
- Runtime: `repository`, `diagnoseAuth`, `viewer`, `rateLimit`, `accounts`, `configure`, `configuration`.
- PR: `forBranch`, `review`, `creationEligibility`, `create`, `createStacked`, `merge`, `autoMerge`, `updateReview`, `reviewers`.
- Detail: `checks`, `checkDetails`, `rerunChecks`, `comments`, `reviewComment`, `reaction`, `resolveThread`, `fileViewed`, `files`, `fileContents`.
- Work items: `listWorkItems`, `countWorkItems`, `workItem`, `workItemDetails`, `createIssue`, `updateIssue`, `issueComment`, `labels`, `assignees`, `projects`, `projectRef`, `projectViews`, `projectTable`, `projectField`, `projectItemMutation`.
- Refresh: `refresh`, `enqueueRefresh`, `visibleRefreshCandidates`, `refreshState`.

Every method taking repository context accepts optional worktree selector and honors registered-worktree validation; `configure` persists `{issueSourcePreference:'auto'|'origin'|'upstream', account:{host,user}|null}` in plugin-owned store keyed by worktree.repoId, not tokens. Origin resolution is mandatory for head identity. `prRepo` if supplied is `{host,owner,repo}` and must match origin/upstream. Issue preference selects issue repository with fallback marker; PR candidate resolution still prefers upstream and origin. `repository` returns all resolved candidate identities and origin/head identity.

PR `merge` requires positive number, expectedHead (40/64 hex), method squash/merge/rebase and action direct/queue; no actor-dependent behavior. Declare destructive in manifest. The handler refreshes GitHub state, rejects a mismatched head before mutation, validates review/merge/rules/stack metadata, and executes a single protected provider action. Queue/stack async polls at 1 s, up to 180 attempts, with bounded whole-operation deadline. Outcome is `{state:'merged'|'enqueued'|'pending', number, head, operationId?}`. Unknown completion reports pending with operationId only if GitHub returned it; otherwise safe unknown-completion error. Auto-merge is a separate action, not an alternate sitter merge implementation.

`updateReview` action enum edit/close/reopen/ready with optional title/body. `reviewers` action add/remove with nonempty logins. `reviewComment` action inline/reply with current head, file/line/range or reply id. Thread/reaction/file IDs are validated against the selected PR before mutation, preventing arbitrary cross-repo GraphQL IDs. `projectItemMutation` action enum editIssue/editReview/addComment/updateComment/deleteComment/updateIssueType; no arbitrary GraphQL or arbitrary HTTP escape hatch is exposed.
Projects item content repositories are not restricted to local remotes. `projectItemContext` obtains owner/repo/number/kind from authenticated project metadata, validates exact syntactic slugs and the selected project host, and carries that identity through REST/GraphQL actions using ambient auth. Project/item association and comment-to-item association checks remain mandatory. Pasted `workItem` references and `prRepo` remain restricted to configured remotes. Add GH31 stateful readback coverage for an item in a different repository on the same trusted host, plus refusal of a substituted foreign host.
For Projects only, internal `RunOptions.projectHost` marks the authenticated project-host route; it is never a public method parameter. The runner requires ambient auth, exact equality with the target host, and either github.com or a host present in the local gh auth inventory before allowing a target repository outside configured remotes. Do not waive the ordinary remote guard merely because ambient auth is requested. Projects helpers set this option after project/item/URL validation; foreign-host substitution and untrusted GHES hosts fail before authenticated API calls. Discovery on an authenticated GHES host must not depend on a local remote for that host.

### Refresh ownership and partial mutations

Implements [refresh ownership](logic.md#transport-rate-limits-and-refresh) and [partial mutations](logic.md#api-and-cli). The four refresh methods declare `connection: true`; CLI commands invoke them through their real socket connection, and connected API clients use their actual connection. `forBranch` remains available to plugins, including the later sitter, without connection context. The public connection close hook above registers cleanup on either transport without binary streaming.

`SCHEMA:`
```ts
type RefreshCandidate = { worktree: string; branch?: string; number?: number; headOid?: string; active?: boolean };
type VisibilityReport = { generation: number; candidates: RefreshCandidate[] };
type RefreshRequest = { candidate: RefreshCandidate; reason: 'visible'|'active'|'post-push'|'manual'|'swr'; priority?: number };
type RefreshReportResult = { accepted: boolean; generation: number; candidates: number };
```

Validate nonnegative safe-integer generations and max 1000 candidates; resolve every candidate through the registered worktree API and reject mismatched identities. Ownership key is caller.connection.id; never accept an identity field from params. Store last generation and one candidate set per connection. A generation <= last accepted generation leaves state unchanged with accepted:false. Deduplicate normalized candidate keys and aggregate their owner sets; disconnect removes only that owner's visibility and its per-connection/per-host/account active burst history. An entry survives while another owner still reports it. Reconnection has a new connection ID and starts generation history empty. Register one onClose callback per owner, remove it and timers on plugin deactivate. Background budget is global per host/account; active budget is per connection plus host/account; cooldown and failure backoff are per normalized review key. Manual refresh still respects Retry-After.

`changed(scope, data)` synchronously advances the affected cache generation before emitting. Every confirmed upstream write calls it, including steps inside aggregate operations. Aggregate failure after at least one confirmed step emits data `{partial:true, completedSteps:string[]}` and returns an error containing those completed steps; creation followed by stack-registration failure additionally carries the created review number/URL. A timeout with unknown upstream completion conservatively invalidates cached reads but emits no fabricated confirmed mutation. GH11/GH12/GH16/GH18 tests exercise these transitions.

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
Client `page`/`limit` apply to `listWorkItems`, whose contract is `Page`. Files, labels, assignees, Projects discovery, work-item details and a project table are fixed-cap reads that follow upstream pages internally, matching the feature doc; do not advertise ignored client pagination flags or fictional page-result fields for them. Their schemas expose actual named collections, counts, truncation and partial failures. Document nullable results/coordinates precisely using descriptions and untyped nullable fields within the existing schema subset; no unsupported union keywords.

Refresh events expose `aliases` plus `worktreeId` and `repoId` for a resolved candidate. Validation-denied events may have null identity fields rather than invent registered IDs; those nullability conditions are declared. Preserve request sequence, reason, scheduling/skipped metadata and outcomes so a client can correlate multi-worktree refreshes without guessing.

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

Implements [data flow](logic.md#data-flow). One plugin-owned store holds account selection and issue preference; existing user data needs no migration. Tokens remain memory-only, scoped by host/account and execution environment. Four active processes, bounded caches/refresh queues and teardown cancellation control resources. Process-group handling is macOS-tested; Linux/Windows gaps have deferred-platform decisions. Changed events carry registered identity and mutation metadata. Refresh events additionally expose aliases, safe outcomes and monotonic sequence, with explicit null identities for unresolved denials. Deactivation clears owned timers/subscriptions and awaits child termination; disabled methods remain unreachable through the registry.

## Testing strategy

Implements every [acceptance scenario](logic.md#behavior-and-acceptance-scenarios). Each module owns focused `test/<cluster>.test.ts` daemon API tests, using real isolated gh fixtures rather than overriding its own methods. Add a shared fixture helper under `test/helpers.ts` and dedicated CLI smoke coverage in `test/cli.test.ts`. Run tests only after implementation wave barrier; parent owns all checks. First stage API regression tests and observe missing-method failure before implementation, then run targeted changed files and all acceptance scenarios. Full gates: `bun run test`, `bun test scripts`, `bun run typecheck`; runtime smoke: fresh-home daemon + actual generated hosting CLI exercised against isolated fixture state, including safe refusal then confirmed head-guarded merge. No UI/native scenario exists in this API item. Final review uses verified Gemini cross-family reviewer after catch-up merge; one fix batch per LOOP.md.

## Non-goals

As [logic scope](logic.md#scope-and-non-goals): no provider other than GitHub, no hosting page/settings UI, no sitter engine, no worktree-from-PR implementation, no token store, no SSH execution relay, no WSL/native checks. One API seam is tested with client and plugin callers now; M6 migrates its new sitter by calling it.
