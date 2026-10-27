# m4-worktrees-create-from-github decisions

## D1: Extend the existing worktree create owner through the public hosting API
- **Question:** which approach implements GitHub sources without a second lifecycle (brainstorming approach)?
- **Options:** extend quirky.worktree/create and call quirky.hosting; introduce a GitHub-worktree plugin with a second creator; port Orca's separate renderer/runtime implementations.
- **Chose:** extend the existing owner and one create path, with hosting owning authenticated GitHub reads.
- **Why:** m1-worktrees D5 locks one creator; roadmap requires built-in plugins on the public API. A second lifecycle duplicates hook trust, collision, setup and activation rules.
- **Evidence:** docs/loop/decisions/m1-worktrees.md D5; docs/roadmap.md:19-38; hosting-api.md Other GitHub plumbing.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** the public plugin API cannot express an authenticated read needed by creation.
- **Source:** locked by docs/loop/decisions/m1-worktrees.md

## D2: Resolve unattended design questions locally using night-mode protocol
- **Question:** how to conduct brainstorming, spec approvals and research in this unattended iteration?
- **Options:** ask a human; use the provided documents and record recommended defaults.
- **Chose:** no asks, visual companion or divergent-ideation offers; no external research swarms; one markdown logic spec with a final technical section and self-review. Domains: Integration, API, CLI, Visual, Data and Organization. Select naming, duplicate-handling, data-mapping, authentication, conflict-resolution, retries, flags/output, loading/empty/error/selection states and hook execution/trust as gray areas.
- **Why:** night mode explicitly supplies the research, skips separate tech/spec review, and replaces user approvals with recorded decisions.
- **Evidence:** docs/loop/LOOP.md Night mode and Answering a skill's questions; feature-doc worktrees.md section 2 and hosting-api.md Other GitHub plumbing.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** the unattended/night-mode instructions change.
- **Source:** locked by docs/loop/LOOP.md

## D3: Use OpenAI task implementation and Gemini review after Opus fails preflight
- **Question:** which verified model pairing satisfies omp lane review independence?
- **Options:** task + Opus; task + Gemini; same-family review fallback.
- **Chose:** IMPLEMENTER=task, AUTHOR_FAMILY=openai, REVIEWER_ALIAS=gemini, high thinking. Maximum three implementers; disjoint scopes in isolated worktrees. Main tree owns integration and the final checks.
- **Why:** pi-watch --check found Opus and Sonnet unavailable, Gemini and Flash available. Bun 1.4.0 is installed. Preserved inherited untracked .serena state in path-limited stash lane2-serena-tool-state rather than include it in feature commits.
- **Evidence:** observed all-alias preflight and stash output in this iteration; package.json scripts.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** Gemini dispatch fails and the documented fallback ladder is required.
- **Source:** locked by docs/loop/LOOP.md (pairing); assumed — autonomous (fallback and state preservation)

## D4: GitHub sources keep the existing lifecycle and fail visibly rather than become names
- **Question:** what do source interpretation, auth, failure and retry gray areas mean to consumers?
- **Options:** silently use unresolved input as a name; resolve explicit GitHub inputs authoritatively and surface errors.
- **Chose:** Smart #N and GitHub URLs resolve PRs/issues; GitHub tab lists mixed PRs/issues with distinct labels and explicit selected source/clear. Plain Smart text remains a name option. Failed explicit source resolution never creates a name-only workspace. Use hosting's bound-account/host checks and error semantics; no direct gh subprocess in UI or duplicated authenticated HTTP client; no additional retry layer. Keep existing setup trust/decision gates, naming collision policy, create-more reset and guarded activation.
- **Why:** source errors must not create the wrong checkout; hosting D5/D6/D7/D8 already own auth and failures.
- **Evidence:** worktrees.md:73-119; docs/loop/decisions/m4-hosting-api-github.md D5-D8; docs/loop/decisions/m1-worktrees.md D12/D21/D22/D30.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** a documented source flow needs different input interpretation.
- **Source:** locked by worktrees.md; locked by docs/loop/decisions/m4-hosting-api-github.md

## D5: Resolve a source freshly in hosting, not from consumer-supplied checkout data
- **Question:** how are repository/number, fork head, errors, pagination and stale selection resolved (API/Data/Integration)?
- **Options:** trust the composer tuple; chain cached workItem and review reads; expose one fresh hosting worktreeSource operation.
- **Chose:** fresh worktreeSource({worktree, reference}) with shared GitHubWorktreeSource type; #N follows existing candidate order, URLs must name a configured identity. Search remains listWorkItems with its existing bounded page contract. Deleted/malformed head repositories fail. No custom retry, token storage or ambient fallback. Query/project/tab changes invalidate stale UI results.
- **Why:** existing workItem carries head branch/OID but not fork identity; review omits clone URLs/maintainer permission. A fresh scoped REST pull read provides coherent source metadata without exposing arbitrary API calls.
- **Evidence:** Scout MapWorktreeGithub; hosting item-details.ts:59-179; pr-review.ts:39-59; hosting-api.md:385-387.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** the provider cannot return a usable head for a documented source.
- **Source:** assumed — autonomous (method); locked by docs/loop/decisions/m4-hosting-api-github.md D5-D8 (auth)

## D6: Separate the PR checkout head, compare base and push branch
- **Question:** naming, duplicate handling, branch conflicts, tracking and push destinations?
- **Options:** use title as branch; use head ref as both compare and push base; keep three distinct identities.
- **Chose:** PR title defaults display/folder/note; head branch name stays exact and matching unoccupied local branch can be reused without reset. Existing path suffixes remain. Compare base is PR base branch. Fetch refs/pull/N/head into a remote-URL-hashed refs/quirky/pull path with a 60-second bound and compare exact authenticated OID. Configure real head tracking and pushRemote, reuse matching configured remote or create scheme-matched pr-owner-repo; never overwrite a conflicting remote or fall back on stale fetched state. Preserve maintainerCanModify but do not infer that false forbids the actual fork owner.
- **Why:** synthetic pull refs are readable from the base repository but are not push destinations; same-number PRs on repointed remotes cannot share a ref. Existing m1-worktrees branch preservation is binding.
- **Evidence:** hosting-api.md:387; worktrees.md observed result PR #3; m1-worktrees D12/D13/D16; packages/git/src/remote.ts:40-74.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** GitHub's transport or owner semantics change.
- **Source:** locked by hosting-api.md; assumed — autonomous (Quirky ref prefix and explicit head-change refusal)

## D7: Grow the existing hook trust boundary to issue commands
- **Question:** issue command meaning, script source/trust, substitution, setup concurrency and failures?
- **Options:** leave unsupported; accept arbitrary executable text from consumers; support configured local/shared trusted templates.
- **Chose:** ProjectSettings.issueCommand and top-level YAML issueCommand, merged by commandSource; shared trust kind issue, explicit one-time trustIssueCommand or skip, no implicit approval from trustSetup. Interpolate only decimal {{issue}} and canonical {{artifact_url}}. Run for linked issues only in independent Issue #N terminal/split alongside setup; bounded daemon path if sessions disabled; return outcome and warning without rollback for post-create failure. Setup/issue trust must happen before branch/path creation.
- **Why:** item explicitly includes issue command; source confirms placeholders and separate command execution. This supersedes M1's temporary unsupported issueCommand ruling, not its shared-content trust policy.
- **Evidence:** worktrees.md:268-274; Orca composer-issue-command.ts:16-36 and new-workspace.ts:90-102; m1-worktrees D19/D22/D23.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** templates require additional escaping or new placeholders.
- **Source:** supersedes m1-worktrees D19 (issueCommand only); locked by docs/loop/decisions/m1-worktrees.md D22 (trust)

## D8: Commit contracts first and implement three isolated disjoint components
- **Question:** how to partition the plan and verify it without shared-file races?
- **Options:** one monolith; horizontal API/UI tasks with concurrent hub edits; precommitted contracts and operation-owned scopes.
- **Chose:** base 0503b42 commits combined spec, protocol model, source schema and create signature/schema; component worktrees /tmp/quirky-ghwt-hosting, /tmp/quirky-ghwt-runtime, /tmp/quirky-ghwt-ui. One wave, three components, width cap three (not binding), no semantic edges/checkpoint. Hosting owns hosting/**; runtime owns worktree daemon/main/CLI/manifest/runtime tests plus repo/**; UI owns worktree client/React/report/window tests. Parent integrates, owns docs and runs checks after barrier. Workers write behavioral tests before implementation and skip checks under higher-priority no-midflight rule.
- **Why:** shared types/signatures are fixed before dispatch; scopes do not intersect. Unchanged protocol model consumers remain compatible because new fields are optional/additive. Initial coherence sweep found issueCommand unsupported warnings only in repo hook/parser tests; assigned to runtime for clean cutover. No existing linked metadata consumers need migration.
- **Evidence:** task batch and model changes; xd://lsp references attempted and returned No language server found; grep linkedPR/linkedIssue/pushTarget/issueCommand in scoped plugins/protocol.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** an implementer needs a path outside its scope; parent replans first.
- **Source:** locked by docs/loop/LOOP.md (night-mode cap/contracts); assumed — autonomous (partition)

## D9: Verify macOS behavior in isolated homes and preserve the no-real-state invariant
- **Question:** platforms, checks, baseline smoke and UI/native verification?
- **Options:** speculative cross-platform shell work; macOS-only actual verification with isolated executable/Git fixtures.
- **Chose:** scoped remote suite, scripts, typecheck and build after integration; no pre-land whole suite. Guarded headless web dogfood only, no foreground/native scenarios added. Baseline daemon smoke of authenticated issue source failed as expected: RpcError -32009, quirky.hosting did not provide method:quirky.hosting/worktreeSource. Doctor confirms playwright-cli 0.1.22 ready. Temporary fixture home/processes cleaned by harness finally.
- **Why:** outputs establish missing behavior and available driver without touching real gh login or repositories. Linux/Windows shell, process termination and Git transport need platform-specific verification.
- **Evidence:** bun /tmp/quirky-ghwt-baseline.ts exit 1; guarded web doctor output ok true; docs/loop/LOOP.md platforms/tests/night-mode gates.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** Linux/Windows are admitted as test/build platforms.
- **Source:** deferred: platform

## D10: Preserve generated tool state and repair observed integration defects at their owners
- **Question:** how to handle scope audits, first acceptance failures and model/fixture errors?
- **Options:** discard generated state, weaken assertions, or preserve state and repair each root cause.
- **Chose:** every component HEAD remained 0503b42 and source paths matched its declared scope. Preserved tooling-only .serena files from runtime and parent in path-limited stashes; no source contamination. Integrated component commits 9d71892, 8a9fa2d and c578720, removing all three worktrees. A scoped runtime repair branch owns fixture/typing/qualified-host fixes; parent owns the one-line UI narrowing fix.
- **Why:** observed source tests failed on missing sameIdentity import; fixed import rather than provider validation. Removed an incidental subprocess-count assertion instead of re-pinning it. UI mount tests failed because React act's custom thenable was not a chainable Promise; an awaited async readiness function repaired the harness. Restored omitted base state, treated GHES work-item URLs authoritatively, and corrected never-type narrowing in the no-primary UI branch.
- **Evidence:** source acceptance 2 pass/3 fail then 4 pass/1 incidental count failure; composer/report acceptance now 29 pass/106 assertions; existing window-create 16 pass/75 assertions and ui 59 pass/263 assertions. Window run emitted teardown/unmount warnings; its exit was 0. Actual issue-source API smoke now emits SMOKE_OK with canonical issue link and null head/base.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** final scoped checks expose another boundary failure.
- **Source:** assumed — autonomous

## D11: Keep canonical remote identities visible while fixture network transfers stay local
- **Question:** what caused runtime fixture bootstrap and path/deadline failures?
- **Options:** weaken production identity checks or assertion paths; repair the isolated executable fixtures and their native process-test bounds.
- **Chose:** fixture-only Git shim captures real Git before PATH changes and rewrites only fetch/push/ls-remote transport to local bare repositories. Canonical URL inspection remains unchanged. Use canonical realpath for temporary root, isolated global Git author/email/signing configuration for seed clones, and finite native 60-second per-test bounds without changing application deadlines. Typed env/results, repointToSecond declaration and issue-to-issueCommand CLI result mapping are corrected. Extend exact-host matching to HTTPS ports, ssh.github.com and bounded dotless SSH-alias resolution; add consumer-visible GHES-port and SSH-alias checkout cases.
- **Why:** initial fixture passed literal quote characters to Git's URL subsection and failed all 16 cases with protocol '"file' unsupported. Removing quotes alone would make git remote get-url expand to local paths and break authenticated hosting identity. Process-heavy setup and API calls exceeded Bun's default 5 seconds (first real fork-create run completed in 8.63 seconds). Its only subsequent assertion mismatch was /var versus canonical /private/var, not an incorrect checkout.
- **Evidence:** runtime initial gate 0 pass/16 bootstrap failures; initial typecheck 10 diagnostics in 5 files; plugin-validator independently confirmed issue-kind CLI indexing defect; first isolated fork run artifact://52. No real GitHub transport or user Git config used.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** canonical identity differs between authenticated lookup and the actual network destination.
- **Source:** assumed — autonomous

## D12: Lowercase only automatically title-derived GitHub folder slugs
- **Question:** should source-title folders preserve letter case like explicitly typed names?
- **Options:** preserve title case everywhere; lowercase every worktree name; lowercase only the automatic GitHub source name.
- **Chose:** lowercase title before the existing sanitizer for default GitHub-derived folder/issue-branch names; retain the exact display title and default note. Explicit caller names retain M1's casing/sanitizer semantics.
- **Why:** the observed PR #3 result is reword-the-readme, while simply sanitizing its title produced Reword-the-README. Changing the global sanitizer would break the locked ordinary-name behavior.
- **Evidence:** worktrees.md:103-107 observed PR row; logic.md GHWT-1; first runtime case source inspection and fixture expectation correction.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** title-derived Unicode case normalization conflicts with a supported filesystem.
- **Source:** locked by worktrees.md (observed PR result); assumed — autonomous (limit change to automatic source names)

## Progress
All three components integrated; original worktrees removed. RepairGithubRuntime owns /tmp/quirky-ghwt-runtime-fix for observed fixture/typing/qualified-host fixes and lowercase source slug correction; parent UI narrowing edit is uncommitted. Full new runtime integration file is running after canonical fixture and native per-test deadline repairs. Next: finish acceptance, merge/remove repair tree, catch up once, run scoped suite/scripts/typecheck/build, packaged web dogfood, one cross-family review/fix, then land. No whole-suite run before queue.ts land.
