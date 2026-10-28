# m4-hosting-api-github-parity decisions

## D1: Finish exactly the predecessor's two deferred flows and their existing consumer
- **Question:** what is in scope after claiming this follow-up?
- **Options:** API-only with the temporary UI block retained; both API gaps plus the affected existing Tasks caller; broader hosting audit.
- **Chose:** both gaps and remove the existing Tasks Project-owner restrictions, with one UI scenario. No new UI or other providers.
- **Why:** parent D38 names these exact gaps; retaining the consumer restriction would leave a dead temporary boundary after cutover.
- **Evidence:** docs/loop/decisions/m4-hosting-api-github.md D38; plugins/quirky.tasks/src/projects/ProjectsSurface.tsx:627-675; hosting-api.md:301-322.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** authenticated GitHub capabilities differ from the content-owner model.
- **Source:** locked by docs/loop/decisions/m4-hosting-api-github.md

## D2: Resolve all design questions autonomously and use one combined spec
- **Question:** how to run brainstorming/spec gates with nobody watching?
- **Options:** ask a person; skip decisions; self-answer standard API/CLI/integration gray areas and record them.
- **Chose:** self-answer authentication, response/error format, pagination, rate limiting, CLI flags/output/exit codes, data mapping and retry policy below; skip visual/adhd offers and research swarms; combined logic.md with technical decisions and self-review.
- **Why:** canonical LOOP explicitly overrides interactive gates and night-mode asks for one spec/contracts first.
- **Evidence:** canonical docs/loop/LOOP.md read by git show build/roadmap:docs/loop/LOOP.md, Night mode and Answering a skill's questions.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** the operator changes the unattended workflow.
- **Source:** locked by docs/loop/LOOP.md

## D3: Content repository ownership determines issue-type capability
- **Question:** whose types apply to a user-owned Project, personal repositories and missing capabilities (data-mapping/auth-method)?
- **Options:** keep the Project-owner guard; blindly query organization by login; authenticate the content repository's owner type and use its organization catalog.
- **Chose:** authenticated repository owner metadata determines Organization versus User; organization catalog regardless of Project owner, proven personal owner yields no choices and not_found for requested type. Errors/malformed data remain errors.
- **Why:** Projects can contain foreign organization issues; personal repositories cannot supply organization issue types. Empty results must not hide failed discovery.
- **Evidence:** parent D17/D38; plugins/quirky.hosting/src/project-mutations.ts:39-49,248-286; hosting-api.md:314-322.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** GitHub adds issue types for personal repositories.
- **Source:** locked by docs/loop/decisions/m4-hosting-api-github.md

## D4: Preserve all existing public contracts and safety checks
- **Question:** change methods/versioning/flags, discovery output, mutation consent or identity rules?
- **Options:** new issue-type endpoints/batch flags; existing schemas and generated commands.
- **Chose:** existing projectItemMutation/updateIssueType, Tasks projectEdit/issueType and listWorkItems/countWorkItems signatures. Omitted type selector is no-write discovery; enabled type by ID or case-insensitive name updates once. Keep public API ownership, ambient Projects auth, trusted host/item association and bound ordinary search. Safe classified data.reason, existing JSON/exit codes, no new confirmation for reversible type edits.
- **Why:** every required input/result is already declared; no new protocol or storage migration is needed.
- **Evidence:** quirky.hosting/quirky-plugin.json projectItemMutation; parent D6/D7/D17/D18; docs/architecture.md:312-324.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** API consumers need a distinct read-only discovery contribution.
- **Source:** locked by docs/quirk/specs/2026-10-27-m4-hosting-api-github/tech.md

## D5: Use one hosting-local coordinator over the existing runner
- **Question:** what architecture and rate/retry semantics implement batching?
- **Options:** independent queries; global daemon batching; per-HostingEnv search coordinator.
- **Chose:** per-env aliased search/count batches, scoped via env.cacheKey; only env.graphql spawns and accounts reported batch cost. Max10 aliases/12000 serialized query characters, individually oversized valid query isolated under existing runner limits. Preserve four slots and idempotent read fallback/retry policy; no mutation replay.
- **Why:** independent queries miss the deferred behavior; global infrastructure adds needless API and account-boundary risk.
- **Evidence:** hosting-api.md:304; env.ts HostingEnv; runtime-runner.ts existing GraphQL cost policy; parent D37.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** a second plugin requires the same batching contract.
- **Source:** assumed — autonomous

## D6: Bounded page/cursor reuse preserves freshness and failure isolation
- **Question:** pagination, cache mode, errors, rate limits and empties?
- **Options:** persist cursors; unbounded process maps; bounded short-lived generation-scoped memory.
- **Chose:** response <=120s/512entries/16MiB; cursors <=120s/1024entries/1MiB. Exact duplicates coalesce, noCache bypasses settled data, mutation/disposal clears data and late generations cannot publish. Preserve <=8192-byte query and <=1000 results. Alias-local errors affect only that alias; global failures preserve existing per-source fallback/errors. Reject malformed/nonadvancing cursors rather than report duplicate complete rows.
- **Why:** memory bounds and identity/freshness are load-bearing while changing pagination. workItemPage numbered REST, empty recent issues and PR list transport remain unchanged.
- **Evidence:** hosting-api.md:303-305,418-424; env.ts:99-114,236-288; parent GH08/GH11.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** measured provider behavior requires different safe cursor lifetime.
- **Source:** locked by hosting-api.md

## D7: Use native omp implementers with Gemini review because Opus is unavailable
- **Question:** cross-family model pairing and environment readiness at execution preflight?
- **Options:** native omp tasks plus Opus; native omp tasks plus available Gemini; reduced-independence OpenAI reviewer.
- **Chose:** IMPLEMENTER=omp-task; AUTHOR_FAMILY=openai; REVIEWER_ALIAS=gemini. pi-watch --check resolved google/gemini-3.1-pro-preview:high; Opus and Sonnet had no authed/shipping model. Bun1.4.0 is available. LSP references for listWorkItems returned no language server, so scoped text/symbol inspection is the fallback.
- **Why:** canonical omp pairing says use next cross-family pair when Opus is unreachable. No auth/environment changes are authorized.
- **Evidence:** actual preflight pi-watch --check output (7/12 ready, exit5); bun --version1.4.0; xd://lsp references response.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** actual Gemini dispatch fails; follow the recorded fallback ladder rather than invent a review.
- **Source:** assumed — autonomous

## D8: Run one wave of three disjoint vertical components
- **Question:** execution decomposition, inherited dirty state and contract ownership?
- **Options:** shared-tree concurrent edits; serialized everything; separate worktrees with disjoint source/tests.
- **Chose:** search coordinator+new dedicated test; issue-type backend+work-items test; Tasks guard cutover+projects tests/fixture. No semantic edges; one wave width3, cap3 not binding, native task async barrier. Existing public signatures and internal env contracts are committed in the combined spec before implementers. Main owns documentation and smokes. No worker commits or mid-flight checks; parent observes regression then final passes after edits.
- **Why:** scopes do not intersect and no new shared API is necessary. Parent maintains integration ownership. Inherited .serena untracked directory is preserved via path-limited stash lane6-inherited-serena-iteration5; no user content deleted.
- **Evidence:** HostingParityMap scout; spec Technical decisions and contracts; initial git status; successful path-limited stash.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** implementation reveals an unavoidable shared source change; replan before editing outside scope.
- **Source:** assumed — autonomous

## D9: Verify public API, actual CLI and one web user scenario
- **Question:** required acceptance and check commands, native coverage and test-state isolation?
- **Options:** unit-only proof; public daemon+CLI regression and guarded web flow.
- **Chose:** all P/S/C/U acceptance rows in the combined spec. Parent runs owning files then affected suite, scripts and typecheck; queue land owns whole suite. U01 uses build and fresh-home web-only yours/unattended dogfood. No new native scenario. Every spawned process uses temporary QUIRKY_HOME and is terminated; never shared gh state.
- **Why:** milestone rules require scriptable flows, and consumer cutover must work on the actual surface.
- **Evidence:** docs/roadmap.md:43-53; LOOP Verify; package.json:10-15; combined spec acceptance table.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** external tooling blocks a scenario; preserve report and distinguish tool limit from app failure.
- **Source:** locked by docs/loop/LOOP.md

## D10: Retain the macOS-only support boundary
- **Question:** does this item claim Linux or Windows subprocess verification?
- **Options:** claim portable behavior from types; retain existing platform deferral.
- **Chose:** no new platform-specific primitives; macOS runtime verification only. Linux/Windows gh process-tree, runtime path and execution environment checks remain pending under predecessor D12.
- **Why:** portable TypeScript maps do not prove OS process behavior.
- **Evidence:** docs/roadmap.md Platforms; parent D12; docs/loop/LOOP.md Platforms.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** Linux/Windows becomes a supported build target.
- **Source:** deferred: platform

## Progress

Scope and self-reviewed combined spec complete. Commit the unchanged public contracts/spec and decision log, then create three component worktrees and dispatch the one implementation wave. Scratch /tmp/quirky-lane6-parity-tekogA. No implementation or behavioral check run yet; no review clearance claimed.
