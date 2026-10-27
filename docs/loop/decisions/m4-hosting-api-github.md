# m4-hosting-api-github decisions

## D1: Take the complete GitHub API slice, not its UI or other providers
- **Question:** what does the queue title cover (brainstorming scope)?
- **Options:** PR lookup and merge only; all GitHub flows in hosting-api.md; every provider.
- **Chose:** all GitHub flows: identity/auth/account binding, branch/number lookup and refresh, creation and stacks, details/checks/comments/files, PR actions, issues/work items and Projects v2. No feature UI; hosting-ui is a separate item. Other providers, Bitbucket connection and worktree creation from PR are separate queue items. The later sitter calls the same merge method as people.
- **Why:** roadmap parity covers every in-scope flow; the title explicitly selects GitHub and a shared merge path.
- **Evidence:** docs/roadmap.md:190-199; hosting-api.md sections What the user can do and Capability matrix; docs/loop/LOOP.md:87-88.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** the queue assigns a GitHub API flow elsewhere.
- **Source:** locked by docs/roadmap.md

## D2: Resolve questions autonomously and keep markdown specs
- **Question:** how to conduct skill approval, visual/adhd offers, and selected gray areas unattended?
- **Options:** ask a person; accept recommended defaults with an audit trail.
- **Chose:** no human questions or orca ask; skip visual/adhd offers; markdown logic and tech specs; self-review design sections and replace approval with the required Codex adversarial spec pass. Select API response/error/auth/rate-limit/pagination, CLI output/flags/errors, Integration auth/retry/conflict/data-mapping and Data idempotency.
- **Why:** LOOP.md supplies the headless protocol and preauthorizes research.
- **Evidence:** docs/loop/LOOP.md:175-200.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** interactive review resumes after this loop.
- **Source:** locked by docs/loop/LOOP.md

## D3: Use OpenAI task implementers and Gemini review after Opus fails preflight
- **Question:** which reachable cross-family pair meets the omp lane rule?
- **Options:** OpenAI task + Opus; OpenAI task + Gemini; same-family fallback.
- **Chose:** IMPLEMENTER=task; AUTHOR_FAMILY=openai; REVIEWER_ALIAS=gemini, high thinking; Codex remains the mandated spec reviewer. Width cap 4. Tech spec required by LOOP.md and subsystem/file-count complexity.
- **Why:** pi-watch --check opus exited 5: no authed/shipping model. The all-alias probe also found Sonnet unavailable; Gemini and Flash available. Actual no-tool prompts returned REVIEW_READY for Gemini and Codex. Bun 1.4.0 is available. Build command bun run build; full suite bun run test; additional gates bun test scripts and bun run typecheck.
- **Evidence:** observed pi-watch preflight 2026-10-27; package.json scripts; docs/loop/LOOP.md:99-105.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** reviewer dispatch fails and the documented ladder must be used.
- **Source:** locked by docs/loop/LOOP.md

## D4: Keep one plugin owner with focused internal modules
- **Question:** which architecture wins the brainstorm option comparison?
- **Options:** one hosting owner with an internal gh adapter; facade plus separate provider plugin; port Orca's full transitive dependency tree.
- **Chose:** quirky.hosting owns the complete GitHub slice, split internally by transport, PR lifecycle, review details and work items/Projects. Research recommending a smaller surface does not reduce D1's locked complete GitHub coverage.
- **Why:** schema dispatch and public context.call already provide the replacement seam; a provider plugin adds dependency activation without a second provider in this item. Orca's Electron/runtime coupling is not portable.
- **Evidence:** HostingSurvey and HostingOptions research; packages/protocol/src/plugins.ts:49-80; packages/daemon/src/plugins/dispatch.ts:160-177; https://cli.github.com/manual/gh_api.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** another provider needs an externally replaceable provider registration contract.
- **Source:** assumed — autonomous

## D5: Resolve identity from registered worktrees and local authenticated host inventory
- **Question:** what can callers select; how are forks, aliases, enterprise hosts and issue preference handled (API authentication and Integration data-mapping)?
- **Options:** trust supplied owner/repo/host; ambient gh discovery; explicit remote identities with local host trust.
- **Chose:** worktree selector through quirky.worktree/resolve; no arbitrary path execution; origin head and upstream/origin candidates; exact two-segment supported remote forms; SSH alias expansion; GHES only from local inventory. Explicit prRepo must match configured remotes. Persist issueSourcePreference with a fallback marker when upstream disappears.
- **Why:** GH_HOST/GH_REPO or an untrusted remote must not redirect authenticated calls; forks require distinct head owner and target owner.
- **Evidence:** hosting-api.md:174-183,194,306,422; https://docs.github.com/en/get-started/git-basics/about-remote-repositories.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** connection-backed repository execution is added by its owning item.
- **Source:** locked by hosting-api.md

## D6: Keep gh as auth boundary with fail-closed per-repo binding
- **Question:** token storage, ambient login, binding availability and binding host mismatch (auth-method)?
- **Options:** new HTTP/token store; ambient gh only; gh plus selected existing keyring login.
- **Chose:** gh plus repo binding. Tokens only in scoped memory and bound child env; never persist, return or log them. Missing keyring capability/login or mismatched host fails closed. Projects use explicit ambient gh as documented.
- **Why:** parity includes account selection; silent ambient fallback would act as the wrong user.
- **Evidence:** hosting-api.md:165-172,423; https://cli.github.com/manual/gh_auth_token.
- **Reversibility:** hard
- **Confidence:** high
- **Revisit if:** gh changes account/token capability or Projects account behavior.
- **Source:** locked by hosting-api.md

## D7: Use typed safe outcomes, generated CLI and bounded pages
- **Question:** response-format, error-responses, flags, output, versioning and pagination?
- **Options:** raw gh stdout/stderr; typed records with classified errors; separate CLI wrappers.
- **Chose:** typed records/outcomes and safe data.reason, schema-generated hosting commands, existing JSON and exit conventions. Found/no-review/unavailable are separate. Bound pages/search/files/projects match feature limits and expose truncation/partial availability. Never infer empty success from failed reads.
- **Why:** CLI and UI consume the same daemon contract, including errors and partial data.
- **Evidence:** docs/loop/decisions/m0-scripting.md D5/D12-D15; hosting-api.md:119,307-308,324-336,419.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** M7's API freeze requires refinements.
- **Source:** locked by docs/roadmap.md; assumed — autonomous (concrete method vocabulary)

## D8: Bound subprocesses, scope rate limits per account and never replay mutations
- **Question:** retry-policy, rate-limiting, timeouts, concurrency, idempotency and stale responses?
- **Options:** unbounded processes; gh's defaults only; shared bounded runner and generation caches.
- **Chose:** four active children, deadline/output caps, descendant termination, three transient idempotent-read attempts only; no mutation replay. Honor Retry-After, circuit gates/budget snapshots, bounded caches and coalescing. Key budgets by account as well as host, correcting Orca's documented cross-account bleed. Invalidate generations before emitting success.
- **Why:** hangs, duplicate PR creation and stale reads are consumer-visible correctness defects, not optimizations.
- **Evidence:** hosting-api.md:140-163,414-419,424; https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** fixture or real workload exposes a scope missing from cache keys.
- **Source:** locked by hosting-api.md; assumed — autonomous (account-scoped defect correction)

## D9: Share one head-guarded destructive merge seam before the sitter exists
- **Question:** how do M4's people and M6's sitter share merge now; which endpoint and result states (conflict-resolution)?
- **Options:** actor-specific gh versus REST; one method with capability-specific protected execution; force one new async endpoint on every GHES version.
- **Chose:** one quirky.hosting/merge with destructive confirmation for clients and plugins, expectedHead and method/action. Fresh safety metadata, no admin bypass or branch deletion. Compatible ordinary PRs use head-matched gh; stacks/queue use explicit supported provider action and bounded polling; queued is not merged. Test a plugin caller now, not a fake sitter feature.
- **Why:** no sitter plugin exists yet; M6 must call this seam. New async GitHub.com support cannot establish GHES compatibility.
- **Evidence:** HostingSurvey; hosting-api.md:272-286,406; https://cli.github.com/manual/gh_pr_merge; https://docs.github.com/en/rest/pulls/pulls#merge-a-pull-request-asynchronously.
- **Reversibility:** hard
- **Confidence:** high
- **Revisit if:** a supported GHES rejects head-matched merge or queue capability metadata.
- **Source:** locked by docs/roadmap.md

## D10: Recheck creation eligibility and preserve the existing PR base owner
- **Question:** creation ordering, templates, duplicate recovery, base choice and idempotency?
- **Options:** create directly from input; recheck shared eligibility and probe uncertain completion.
- **Chose:** documented blocker order, base from explicit input then worktree baseRef then project defaultBase then detected default, templates/body file and optional draft. Timeout/duplicate/unknown output probes once; exactly one matching PR resolves uncertainty. Never retry create.
- **Why:** creation must not bypass git state or silently duplicate work; M2 D20 already fixes the base owner.
- **Evidence:** hosting-api.md:288-299,381-383; docs/loop/decisions/m2-source-control-core.md D20.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** upstream fork base needs additional explicit context.
- **Source:** locked by hosting-api.md; locked by docs/loop/decisions/m2-source-control-core.md

## D11: Preserve detail mutations, Projects and refresh as full API flows
- **Question:** what happens with legacy statuses, partial details, thread IDs, Projects layouts and background refresh?
- **Options:** optimistic no-op/empty results; explicit errors and partial records with documented pacing.
- **Chose:** status-only rerun returns actionable error; confirm mutations and invalidate; validate selected-resource IDs; enumerate issue/PR/Projects actions rather than expose arbitrary remote API. Keep refresh pacing/backoff/events and generation checks. No renderer UI in this item.
- **Why:** API parity includes every GitHub flow; raw arbitrary API forwarding would not implement their policies and silent errors reproduce Orca's status-only rerun defect.
- **Evidence:** hosting-api.md:209-251,253-270,301-322,453.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** a feature-doc action lacks an API scenario.
- **Source:** locked by hosting-api.md

## D12: Verify macOS subprocess behavior without claiming other platforms
- **Question:** platform support and actual UI/native goals?
- **Options:** implement speculative WSL paths; macOS implementation with recorded portability boundary.
- **Chose:** macOS only build/test; use portable APIs where cheap. No UI/native goals because this layer explicitly has no UI. Linux process-group behavior and Windows/WSL transport, descendant termination and auth-host routing need their platform work.
- **Why:** locked platform policy; exposing a UI to test an API would add scope.
- **Evidence:** docs/loop/LOOP.md:48-49,124-137; hosting-api.md:3,11,420.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** Linux or Windows becomes a supported build target.
- **Source:** deferred: platform

## D13: Accept both joint-spec review findings and grow the public connection lifecycle hook
- **Question:** how to resolve Codex F1 HIGH (visibility ownership) and F2 MEDIUM (partial mutations)?
- **Options:** caller-supplied reporter IDs or binary streams; authenticated connection identity plus a transport-neutral close callback. Invalidate only overall successes or each confirmed upstream step.
- **Chose:** per-connection sets/generations with union aggregation and disconnect cleanup; add public CallerConnection.onClose for socket and WebSocket. Each confirmed mutation step invalidates; aggregate failures publish partial change with completed steps, not full success.
- **Why:** the current openStream rejects Unix sockets, so binary-stream cleanup would break the generated CLI. Public API growth is allowed; no confirmation bypass or private plugin import is needed. Both reviewers upheld both findings; deterministic gate NEEDS_FIXES, 1 HIGH, 1 MEDIUM, no suppressed/advisory findings.
- **Evidence:** /tmp/hosting-lane11-spec-gate.json and manifest; packages/daemon/src/plugins/streams.ts:12; public API reference sweep found CallerConnection only in plugins.ts/dispatch.ts and terminal callers; xd://lsp references returned No language server found.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** disconnect tests show another connection can lose its candidates.
- **Source:** assumed — autonomous

## D14: Build four disjoint components and integrate before checking
- **Question:** how to partition complete API coverage without shared-file races?
- **Options:** one monolithic worker; four operation-owned components with explicit shared contracts.
- **Chose:** runtime/env/auth/manifest/main/shared fixture/public lifecycle; PR lifecycle/refresh; checks/comments/files; issues/Projects. One worktree per component outside the repository, four dispatches, all forked from the spec commit. Parent owns integration and all checks after the wave barrier; workers never commit or run build/tests/lint. No semantic dependency edges: the reviewed HostingEnv and test helper signatures are fixed before dispatch.
- **Why:** source scopes are disjoint; main assembles all known table exports only after integration. Running checks on incomplete sibling branches would test missing integration, not the feature. Test files belong to their behavior owner; no unrelated files may change.
- **Evidence:** tech.md Contracts & interfaces; four ownership lists in the implementation dispatch; package.json workspace globs.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** a scope needs changes owned by another component; route through parent before editing.
- **Source:** assumed — autonomous

## Progress
Step 4 done: logic and tech specs authored and jointly reviewed with Codex promote/refute. F1/F2 accepted and specified. Next: commit refinements, stage missing-method behavior proof, dispatch four isolated implementation components, integrate at barrier, and run all acceptance/gates before final review.
