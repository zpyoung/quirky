# GitHub hosting API

## Purpose

Expose the complete GitHub slice of hosting-api.md through a replaceable built-in plugin and the generated `quirky hosting` CLI. The window, agents and future sitter consume the same daemon methods; merging has exactly one authorization and execution path.

## Conceptual model

A registered Git worktree selects a repository. Its remotes establish explicit trusted GitHub identities `{host, owner, repo}`; origin identifies the head repository and upstream, when present, identifies the review/issue repository. Each operation uses an explicit identity, never ambient gh repository/host discovery. The user's gh installation owns authentication. A per-repo binding selects an already logged-in keyring account without persisting its token.

Reviews carry number, URL, title/body, state (open/draft/closed/merged), head/base branch and SHA, mergeability (MERGEABLE/CONFLICTING/UNKNOWN), checks (neutral/pending/success/failure), review decision, merge metadata and auto-merge/stack information. Missing reviews and failed lookups are distinct. Paginated lists report their limits and partial/unavailable data rather than inventing empty successful results.

## Data flow

A schema-validated method resolves the registered worktree through the public worktree API, reads git remotes, checks the host against local gh auth inventory, chooses the account, and admits a bounded gh process. Reads may share fresh results and in-flight work; mutations execute once and invalidate all affected cached reads before broadcasting a changed event. Refresh subscribers receive queued, in-flight, paused, skipped and outcome events. No UI is introduced by this API-only item.

## Key decisions & rationale

One hosting plugin is preferred over a facade plus provider plugin: the latter adds a dependency boundary without a second provider in this item. Internal provider-specific modules leave room for later providers without fixing a speculative public provider registry. Direct HTTP/Octokit is rejected: the locked transport is gh and the user already owns its authentication. A full Orca dependency-tree port is rejected; implement its complete observable GitHub behavior using small modules and existing Quirky conventions.

Use one SHA-guarded merge method for humans and automation. Refresh state and merge rules before execution; never bypass protections or delete a locally checked-out branch. Ordinary compatible PRs use the head-matched gh merge route; stacked PRs use its documented async route. This is provider/capability dispatch inside one operation, not caller dispatch. Explicit queue entry is returned as enqueued, never merged.

## Scope and non-goals

All GitHub portions of flows 1–7 in hosting-api.md are in scope, including account binding, rate limits, refresh pacing, stacked creation/merge, review detail/actions, issues/work items and Projects v2. Flow 8 is Bitbucket-only and excluded. Other providers, UI pages/settings cards, worktree creation from hosted items, SSH execution-host infrastructure, Windows/WSL routing, and Orca-specific star prompts are excluded. Local SSH clone remotes and aliases remain in scope. The API must not introduce connection-backed repository support that the registered-worktree API does not have.

## Decisions Locked

### Authentication and identity
- Every call pins github.com too; ambient GH_HOST/GH_REPO cannot redirect it. Recognize exact two-segment remotes in SCP, HTTP(S), ssh, git and git+ssh forms; normalize ssh.github.com and resolve local SSH aliases. Enterprise hosts are accepted only from the local gh auth inventory. Never probe an arbitrary remote host with credentials.
- API inputs select registered worktrees, not arbitrary filesystem paths. Pasted work-item references and explicit PR repository overrides must match configured remotes. Projects v2 is different: an item on a selected trusted project host may belong to another repository; its issue/PR/comment/type mutations use the repository supplied by GitHub's project item and the ambient login, without requiring that repository to be locally configured.
- Account binding is repo-scoped. Require host match and usable keyring login; strip ambient token variables only in the bound child. Binding failures never fall back to ambient auth. Quirky stores no token.

### API and CLI
- Plugin ID quirky.hosting; methods quirky.hosting/<name>; CLI group hosting with schema-derived kebab-case commands/flags, JSON support and existing exit codes.
- Existing result/error conventions remain: context errors plus safe classified `data.reason`. Lookup outcomes distinguish found, no-review and unavailable. Missing CLI, auth, permission, unavailable repo, network/server, rate limit and validation errors remain distinct; secrets and raw stderr never escape.
- Every confirmed upstream mutation step invalidates affected caches and emits changed, even when a later step makes the aggregate operation fail. A partial-change event marks `partial: true` and names the completed steps; no successful completion is invented. Merge and deletion of a project-item comment require the kernel's answered confirmation or yes. Other project edits remain non-destructive. Plugin callers receive the same rule.

### Transport, rate limits and refresh
- All GitHub traffic uses one bounded runner: four active processes maximum, bounded output, noninteractive env, default 30 s timeout, 60 s creation, descendant termination on deadline. Retry only idempotent transient reads, never replay create/merge/comments or GraphQL mutations.
- Rate gates are host/account-scoped so one bound account cannot poison another. Preserve Retry-After, budget snapshots, local circuit breaking, bounded caches and in-flight coalescing. Cache invalidation generations prevent old results repopulating mutation-invalidated state.
- Selected/open refreshes have the documented 60/120 s freshness; absence 15 minutes unless selected, merged settled no background refresh; background max 20 starts/5 min and 10 s spacing; active burst max 3/30 s; cooldown 10 s; post-push/manual-unknown follow-up 2.5 s. Back off repeated failures 60–900 s; manual cannot bypass Retry-After.
- Refresh visibility belongs to the authenticated client connection, not a caller-supplied window ID. Reports replace only that connection's candidate set; the queue uses the union across connections. Generations increase independently per connection and stale reports are ignored. Disconnect removes only that connection's candidates and budget. Reconnection starts a fresh owner/generation; one window cannot erase another's work.

### Creation, merge and partial data
- Recheck creation preflight at mutation time: detached, existing review, unsupported provider, default branch, dirty, no upstream, behind, auth, ahead, missing remote base. A failed lookup blocks creation.
- Create uses the selected template or supplied body, resolved base/head, title and optional draft. A timeout/duplicate/ambiguous response probes exactly once for an existing matching PR; zero/multiple matches are unknown completion, never success.
- Merge reads fresh head/protections/stack metadata, refuses unavailable or malformed safety data, required reviews, changes requested, conflicts and inappropriate direct merges on queue-required branches. Valid provider absence is not an error: an ordinary REST PR can omit stack, and a nullable review decision with no required approvals permits merging. Caller supplies expected head; a changed head fails without mutation. Never admin bypass or branch deletion. Auto-merge/queue and stacks remain explicit actions.
- Legacy statuses without runnable IDs produce an actionable rerun error. Missing file patches are not empty files. Partial detail has explicit unavailable/truncated flags. Input/output bounds follow the feature doc.

## Behavior and acceptance scenarios

Every numbered scenario is exercised against the daemon API or real quirky CLI with a fresh temporary home and isolated executable gh fixture; fixture state simulates upstream responses, not the daemon implementation. Tests kill their own processes and never touch shared gh configuration.

| ID | Data before and action | Required result / data after |
|---|---|---|
| GH01 | Registered repo with HTTPS/SCP/SSH-port/alias remote; resolve identity | Correct host/owner/repo; enterprise requires local authenticated inventory; non-GitHub remains unsupported |
| GH02 | Unregistered path or pasted foreign host/repo | Refused before any authenticated upstream call |
| GH03 | gh missing, logged out, inaccessible repo, network/server failure | Distinct safe reasons; failed lookup is unavailable, never no-review |
| GH04 | Two repo keyring bindings; ambient tokens set | Each child uses only selected account token; unavailable/mismatched binding fails closed; no token stored or returned |
| GH05 | Concurrent reads and repointed remote | At most four active gh processes; duplicate reads coalesce; fresh identity follows changed git config |
| GH06 | Child hangs or output exceeds cap | Bounded failure; descendants terminated; next request remains usable |
| GH07 | Transient read failure, then success; mutation timeout | Read retries at most three attempts; mutation exactly once, unknown completion reported |
| GH08 | Exhausted quota, reported GraphQL cost or Retry-After, two hosts/accounts | Reported spend contributes to the safe floor before another queued request starts; same scope pauses without spawn until reset; unrelated scope works; snapshot query remains available |
| GH09 | Branch in fork origin plus upstream PR | Match correct owner and head repo; linked number wins; tracked upstream supported; number detail carries checks/review/merge state |
| GH10 | Empty branch, no PR, merged reused branch, default branch | No-review only for definitive absence; implicit stale merged/default-branch PR hidden; explicit link remains available |
| GH11 | Concurrent cached lookup then mutation | Old in-flight response cannot repopulate cache; next lookup observes mutation; changed event emitted |
| GH12 | Two concurrent windows report visible/active candidates, stale generations, disconnect and reconnect; manual/post-push requests also run | Per-connection sets aggregate without overwriting; stale reports ignored; only departing owner's work removed; fresh reconnect generation accepted; priority/pacing/cooldown/backoff/events follow locked rules |
| GH13 | Each creation blocker in order, including failed lookup | Exact blocked reason/next action; create revalidates and cannot bypass it |
| GH14 | Pushed clean branch, title/body/template/draft | Exactly one create; returns number/URL and new lookup visible immediately |
| GH15 | Create duplicate, timeout or unparseable output | Exactly one matching open head/base PR accepted as existing; ambiguous matches return unknown completion |
| GH16 | GitHub.com parent/top-of-stack and new child, then failed registration | Create/register new or append existing stack; incompatible parent/host/unsupported API yields explicit error; successful create invalidates/publishes partial change even if registration fails; partial registration not reported complete |
| GH17 | PR checks include check runs, statuses, approval suite | Correct rollup; unknown/empty not failure; details include annotations/jobs/bounded failed log tails |
| GH18 | Rerun failed/all checks including status-only and partial batch failure | Deduplicate workflow/check-run targets; correct rerun action; status-only is actionable error; successful earlier reruns invalidate/publish partial change and error preserves partial-start count |
| GH19 | Conversation, reviews, threads including partial source failure | Sorted typed comments; thread resolved/outdated coordinates and reactions; partial failure explicitly reported |
| GH20 | Inline comment/range/reply, reaction, resolve/unresolve, viewed/unviewed | Mutations target explicit PR/head/file/thread IDs and return confirmed identity; invalidate read cache |
| GH21 | Up to/beyond 300 changed files; raw text/binary/large files | Structured files/viewed state and patch coordinates; explicit unavailable/truncated; raw contents at base/head SHA; binary/tooLarge distinguished |
| GH22 | Merge expected head with allowed squash/merge/rebase | Same destructive method via client and plugin; one head-guarded operation; no branch deletion/admin flags |
| GH23 | Head changed, required review, changes requested, conflicts, metadata unavailable | Refuse before merge; return safe actionable reason; no mutation |
| GH24 | Queue-required PR, stack merge, pending async merge | Explicit queue/stack path, bounded polling; enqueued distinct from merged; unsupported/timeout not invented success |
| GH25 | Auto-merge on/off; clean PR; stacked PR | Correct host-qualified action and expected head; stack rejected; already-mergeable error points to Merge |
| GH26 | Close/reopen/ready/title/body/reviewer add/remove | Provider state changes and shared invalidation; empty title/reviewer list refused |
| GH27 | Browse/list/count/search issues and PR work items | Preference upstream/origin with fallback marker; typed records, totals, stable pagination/query bounds and <=1000 search cap |
| GH28 | Issue get/create/update/comments/labels/assignees | PR-shaped issue endpoint not mistaken for issue; state/reason/duplicate and field edits work; oversize-body partial save returns warning |
| GH29 | Work item details, participants/timeline and pasted configured reference | Correct issue/PR details with bounded pagination and explicit partial availability; foreign repo refused |
| GH30 | Projects discovery/ref resolve/views/table across user/org | Host-pinned ambient account; partial org failures; URL validation; pagination/caps; table/board/roadmap supported, unsupported layouts explicit |
| GH31 | Typed project field set/clear and issue/PR/comment/type edits, including an item from a repository absent from local remotes | Correct field-specific mutation/readback on the trusted project host using ambient auth; reversible edits need no consent, comment deletion requires answered confirmation or yes; foreign-host substitution refused; capability fallback and distinct auth/scope/schema/too-large errors |
| GH32 | Generated hosting CLI and plugin disable/override | Same method behavior as API; schemas discoverable without activation; disabled methods disappear and consumers cannot bypass registry |

### Orca defect regressions

GH18 proves status-only rerun produces a visible API/CLI error, unlike the observed silent no-op (hosting-api.md:453). GH22–GH24 prove human and sitter share one merge path, correcting the observed split between gh pr merge and direct REST merge (hosting-api.md:406). GH08 isolates bound-account budgets rather than accepting Orca's cross-account breaker bleed (hosting-api.md:424). GH11 rejects stale invalidated results; GH03 does not conflate lookup failure with absence. Connection-backed SSH uncertainty is not represented as supported local execution.

## Industry Insights

Research recommends explicit gh host/repo selection and honoring secondary rate-limit Retry-After: https://cli.github.com/manual/gh_api and https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api . `gh pr merge --match-head-commit` provides optimistic head protection without admin bypass: https://cli.github.com/manual/gh_pr_merge . GitHub's async merge supports queue/stack results; GHES support must not be assumed: https://docs.github.com/en/rest/pulls/pulls#merge-a-pull-request-asynchronously . Checks and legacy statuses are separate resources: https://docs.github.com/en/rest/checks/runs and https://docs.github.com/en/rest/commits/statuses . Public plugin dispatch supports one replaceable owner without direct plugin imports (packages/protocol/src/plugins.ts and packages/daemon/src/plugins/dispatch.ts).

## Deferred Ideas

Other providers and feature UI belong to their queue items, not additional scope. Linux/Windows execution and WSL require separately verified process-tree handling; record platform gaps rather than pretending macOS validation covers them.

## Glossary

GHES: GitHub Enterprise Server. Head SHA: the exact reviewed commit whose merge is authorized. Binding: selected existing gh keyring login. Sitter: later background PR automation, a plugin client. Unavailable: lookup failed, not proof of no PR. Enqueued: accepted into a merge queue, not yet merged.

## Status & amendments

Status: Required joint Codex review completed; F1 HIGH and F2 MEDIUM accepted and resolved in the specifications before implementation. Tech spec required by LOOP.md and subsystem/file-count gate.

**Amendments:** 2026-10-27 — specify per-connection refresh ownership and partial-mutation invalidation after joint review. Clarify Projects cross-repository parity from original by-slug handlers. Correct provider-wire distinctions: valid omitted stack and nullable no-review decisions are not unavailable metadata; use supported branch-filter/create routes, including organization forks. Apply the existing irreversible-action consent rule to project-comment deletion without prompting for reversible project edits.
