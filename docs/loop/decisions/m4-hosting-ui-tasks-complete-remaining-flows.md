# m4-hosting-ui-tasks-complete-remaining-flows decisions

## D1: Retain the full original scenario catalog and implement missing public joins
- **Question:** which remaining flows are absent rather than simply unexercised?
- **Options:** rewrite Tasks; treat all untested flows as absent; preserve existing surfaces and close concrete integration gaps.
- **Chose:** preserve SC01–SC25 as authoritative, reuse Tasks/issue/Projects/settings implementations and add targeted behavior/coverage for canonical workspace consent/delivery, source-qualified PR navigation and uncertain stale-write boundaries.
- **Why:** current source has real public methods/UI for the whole catalog. Independent read-only maps distinguish implementation from acceptance; prior D22 did not claim exhaustive acceptance.
- **Evidence:** original Tasks logic.md SC01–SC25; m4-hosting-ui-tasks D17/D19/D22/D23; TasksMap and WorkspaceReadinessMap source maps; src/list/workspace.ts239–329 and src/review-navigation.ts1–8.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** a source-defined flow lacks an actual owner or runtime operation.
- **Source:** locked by docs/quirk/specs/2026-10-27-m4-hosting-ui-tasks/logic.md

## D2: Resolve standard gray areas without a human and defer campaigns to the end phase
- **Question:** how do brainstorming/spec/implementation questions and verification apply to this unattended item?
- **Options:** wait for a person; invent research/review work; apply current build-first protocol and recorded defaults.
- **Chose:** Visual layout/density/loading/errors/interaction; API response/errors/auth/pagination; CLI output/flags/recovery; Integration sync/conflict/mapping; Data persistence/ownership. Preserve source layout, accurate loading/empty/unavailable/stale states, shared CLI/API, exact source, reversible writes, durable preferences and session drafts. One combined logic spec, autonomous self-review, no asks/visual/adhd/research swarm/separate spec review. Write behavioral tests, do not run suites or exhaustive dogfood/review campaigns before end phase. Final typecheck is the landing gate. A disposable changed-path smoke supplies required runtime evidence without claiming exhaustive acceptance.
- **Why:** canonical LOOP.md explicitly supersedes older item/spec campaign timing. Existing native scenarios retain their latest QA statuses (currently blocked by tooling/fixture prerequisites); no test/review follow-up item may be added.
- **Evidence:** git show build/roadmap:docs/loop/LOOP.md, Build first/test at end and Answering a skill's questions; source hosting-ui.md sections1–4,6–8,12.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** m7-test-triage is claimed or loop policy changes.
- **Source:** locked by docs/loop/LOOP.md

## D3: Keep one creator, independent pinned hook consent and canonical readiness
- **Question:** how should sourced creation and agent delivery be completed?
- **Options:** plain-create fallback; duplicate launch/readiness runner; integrate existing owning public methods.
- **Chose:** exact item URL to worktree/create, independent setup/issue command run/skip and content pins, retained approvals across the other hook's refusal. Select default through agents/pick(forAgentTab:true); session/agents own readiness and exactly-once paste. Return real agent session/pending/setup/issue-command/warnings and observed promptDelivery; pending/unconfirmed/failure is not delivered. Post-create warnings retain the created/link state, not a retryable creation failure.
- **Why:** canonical create and session delivery already exist. Tasks currently drops the issue consent kind/hash and launch outcomes; a second owner would bypass locked trust/readiness semantics.
- **Evidence:** m4-worktrees-create-from-github D7/D16/D19; quirky.worktree create.ts663–670,750–806; quirky.agents delivery.ts25–57; quirky.tasks workspace.ts239–329; WorkspaceComposer.tsx155–190.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** canonical creation or session delivery contracts change.
- **Source:** locked by docs/loop/decisions/m4-worktrees-create-from-github.md

## D4: Commit contracts then use three disjoint OpenAI implementation components
- **Question:** which decomposition preserves independent ownership and the omp model pairing?
- **Options:** one broad worker; overlapping list/project work; three disjoint components with parent integration.
- **Chose:** IMPLEMENTER=task, AUTHOR_FAMILY=openai; review skipped under build-first policy (no unperformed Opus/Gemini probe or review claimed). Three external temporary worktrees: workspace/composer+manifest+new workspace tests; list/issue/env/ui/review-navigation helper+their tests; Projects+its tests. Parent owns shared contracts, docs, smoke and integration. Cap3, one wave, no semantic edges; width cap does not bind. Workers do not commit or run checks. Inherited untracked .serena remains untouched and excluded.
- **Why:** existing vertical modules provide disjoint scopes. Shared source/outcome and helper signatures are committed before dispatch; no need to add a new lifecycle or schema dialect. No language servers are configured, confirmed through xd://lsp status.
- **Evidence:** committed shared contracts and spec; two scout maps; actual LSP status; initial git status only untracked .serena.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** a required change crosses scopes; parent replans before accepting it.
- **Source:** locked by docs/loop/LOOP.md; assumed — autonomous (decomposition)

## D5: Carry explicit PR source identity into Reviews
- **Question:** how to avoid navigating same-number PRs from the wrong remote?
- **Options:** worktree+number only; import Reviews internals; public Reviews open with validated prRepo.
- **Chose:** extend the Tasks helper input with optional URL/host/owner/repo, resolve the exact PR identity, reject mismatches, and pass prRepo to quirky.reviews/open. List/check/Project consumers forward their complete ItemTarget. Preserve canonical confirmation and queue outcomes in row actions.
- **Why:** Reviews already declares prRepo; Tasks currently discards its resolved target identity.
- **Evidence:** quirky.tasks src/review-navigation.ts1–8, list/useReviewNavigation.ts24, projects/ProjectsSurface.tsx744; quirky.reviews src/contracts.ts8.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** Reviews open contract changes.
- **Source:** locked by docs/loop/decisions/m4-hosting-ui-reviews.md D3/D5

## D6: Restrict runtime proof to isolated macOS state
- **Question:** where may new tests and smoke run?
- **Options:** real forge/user credentials; fresh owned HOME/QUIRKY_HOME and stateful upstream/agent fixtures.
- **Chose:** disposable local repositories, fixture executables, isolated homes and owned process teardown. Preserve original native handoff; Linux/Windows shell/keyboard/clipboard/process behaviors remain unverified on those platforms.
- **Why:** automated work must not touch real ~/.quirky, ~/.claude or ~/.codex; web/API evidence does not establish native OS effects.
- **Evidence:** LOOP.md Hard rules/Platforms; original Tasks native handoff and D6.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** supported execution platforms expand.
- **Source:** deferred: platform

## D7: Reproduce the two integration losses through the actual daemon
- **Question:** are missing source/consent fields merely an inferred code defect?
- **Options:** trust static inspection; observe the existing public paths with isolated state.
- **Chose:** disposable API probes before integrating workers. All three PR tabs lost the explicit upstream PR12 source in both Reviews state and ui.state. The setup refusal retained script text but omitted trustKind and trustHash, so the Tasks composer could not bind one-time approval. Both scopes cleaned in finally; no suite or broad campaign ran.
- **Why:** actual daemon output establishes the changed-path baseline and distinguishes fixture activation problems from product behavior.
- **Evidence:** /tmp/quirky-lane10-tasks-navigation-smoke.ts emitted TASKS_PR_SOURCE_BASELINE_OBSERVED after adding the real quirky.git dependency; /tmp/quirky-lane10-tasks-consent-smoke.ts emitted TASKS_CONSENT_BASELINE_OBSERVED with actual creator refusal and missing kind/hash. Its synthetic remote background refresh warned; final source fixtures must isolate Git transport.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** post-integration smoke cannot preserve those fields through the same paths.
- **Source:** assumed — autonomous (observed runtime evidence)

## D8: Keep ownership at the daemon and reject speculative publication retries
- **Question:** how should component integration close races without duplicating operations?
- **Options:** renderer reselect/republish compensation; request ownership in the canonical state owner.
- **Chose:** Project method-factory select generations and per-view query ownership before async provider reads; source/view/write-scoped renderer overlays and field-local rollback. Removed a renderer reselect compensation. Removed a proposed generic navigation republish loop and its mocked publication-array test: the real kernel ui.view.open changes layout synchronously. Preserve the actual mode-change detail reset.
- **Why:** scripts need the same ordering guarantees as the window; a renderer repair cannot protect daemon state, and a delayed response is not a second kernel side effect.
- **Evidence:** src/projects/methods.ts projectView and projectMethods; packages/daemon/src/methods.ts ui.view.open and plugins/layout.ts openView; component HEAD47fbcd68 scope audit; component commits a47ab379/f8e9bf3c/c684da7d.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** a public API race can replace the newest selected view or query.
- **Source:** assumed — autonomous

## D9: Repair observed integration defects at their actual boundary
- **Question:** what did the required typecheck and changed-path smoke expose?
- **Options:** weaken contracts/assertions; change provider policy; repair the demonstrated caller/fixture defects.
- **Chose:** declare the DOM test dependency, import missing React functions, fix fixture lexical host/base references, and remove an incidental delivery-enum assertion. Omit Tasks' issueCommand inherit when calling worktree/create, whose enum only accepts run/skip. Use scripts.setup in the fixture's real YAML. Capture the original real-agent cleanup before extending the E2E object; the previous wrapper called itself and left its owner alive until timeout. Forward the retained composer prompt when submission omits a replacement. Use generated alias property flags, not unsupported --params, in the CLI fixture.
- **Why:** these were actual type errors or isolated runtime failures. The canonical creator, consent guard, CLI parser and process-scope guardian were not the broken owners.
- **Evidence:** first typecheck16 diagnostics/5 files then full typecheck exit0; actual invalid issueCommand enum; setup fixture incorrectly challenged issue first; readiness marker followed by180s timeout then8.73s clean exit after cleanup fix; retained composer baseline delivery:null then physical-paste smoke success; generated alias reported unknown flag --params. All permanent tests remain unrun.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** the end-phase behavioral suite exposes another integration boundary.
- **Source:** assumed — autonomous (observed typecheck/runtime evidence)

## D10: Migrate the newly merged mobile consent caller rather than relax content pins
- **Question:** what changes after the single roadmap catch-up adds a mobile Tasks composer?
- **Options:** weaken hash approval for old callers; leave mobile broken; migrate its UI and parameter admission together.
- **Chose:** keep daemon guards unchanged; migrate mobile setup/issue-command run/skip, displayed hashes and independent retained pins, plus the exact shared mobile parameter allowlist. This is a clean caller cutover for an incoming runtime consumer, not a new mobile feature.
- **Why:** static plugin validation identified the mobile caller still sending trustSetup without a hash and labelling every challenge as setup; its allowlist would reject the new fields even after UI migration.
- **Evidence:** ValidateTasksPlugin targeted report; apps/mobile/src/panels/files-tasks/index.tsx submitWorkspace and consent footer; packages/protocol/src/mobile.ts PANEL_METHOD_PARAMS; all12 incoming decision logs read by IncomingTasksDecisions, with no locked-policy conflict.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** another runtime caller bypasses or cannot express the canonical consent tuple.
- **Source:** assumed — autonomous (required merged-caller migration)

## D11: Record exercised proof separately from the end-phase catalog
- **Question:** which outcomes are actually verified in this iteration?
- **Options:** claim SC01–SC25 accepted; treat typecheck as runtime evidence; name each exercised path and preserve the unrun catalog.
- **Chose:** actual API/CLI smoke verifies exact upstream PR identity in all3 Reviews tabs; independent setup/issue approvals and both executed marker files; fork PR head/branch/push remote; default Goose selected automatically with no bytes before ready and one physical paste after ready; retained composer context delivered without resupply; stale same-view Project query cannot replace the newer durable query. Narrow headless web smoke verifies displayed setup/issue hashes and sequential approval, visible post-create warning, Project table/board/roadmap transitions and move/clear readback. Both web services exit0 and tabs close. No permanent suite, full SC01–SC25 campaign, cross-family review round, native OS or other-platform acceptance is claimed.
- **Why:** the current build-first protocol moves those campaigns to the end phase; concrete required smoke is narrower evidence, not a replacement claim.
- **Evidence:** TASKS_PR_SOURCE_SMOKE_OK; TASKS_INDEPENDENT_CONSENT_SMOKE_OK; TASKS_EXACT_FORK_CHECKOUT_SMOKE_OK; TASKS_DEFAULT_AGENT_READY_ONCE_SMOKE_OK plus TASKS_AGENT_SCOPE_CLEANED; TASKS_RETAINED_COMPOSER_CONTEXT_SMOKE_OK; TASKS_PROJECT_QUERY_OWNERSHIP_SMOKE_OK. Web screenshots omp-sshots-15b7f03a26fe1ff9,15b7f042c27e1ffa,15b7f068267e1ffb,15b7f1a4cbfb8b70,15b7f1a4fc3b8b71,15b7f1bd4bbb8b72.webp. Project service final public table retains PVTI_7's cleared Status.
- **Reversibility:** easy
- **Confidence:** high for the named paths only
- **Revisit if:** end-phase acceptance contradicts these observations.
- **Source:** locked by docs/loop/LOOP.md (campaign timing); assumed — autonomous (recorded evidence)

## D12: Close the merged mobile seam through a real paired client
- **Question:** does the migrated phone composer satisfy the protected daemon contract end to end?
- **Options:** trust payload inspection; execute its actual rendered controls through the encrypted paired client.
- **Chose:** compile the actual FilesTasksPanel in an owned local smoke host, route its calls through MobileTestClient pairing to the real daemon, and drive setup then issue-command Run once. The UI shows both script/hash identities and retains the setup pin during the issue challenge. Both scripts write their expected marker files in one linked issue workspace; the page records navigation to that exact workspace. Static validator closure confirms no remaining reported contract mismatch; final full typecheck passes, including mobile.
- **Why:** allowlist admission, consent enforcement, actual execution and displayed controls must agree. A local source-panel host does not establish the native phone shell or OS actions.
- **Evidence:** TASKS_MOBILE_PAIRED_CONSENT_SMOKE_OK with worktree wt_4295308be504 and issue4 link; service tasks-lane10-mobile-smoke-v2 exit0 and browser tab closed; mobile screenshots omp-sshots-15b7f9033132185c,15b7f94a0cb2185d,15b7f94d3572185e.webp; ValidateTasksPlugin exact-finding closure; final bun run typecheck exit0/23.48seconds. The initial smoke fixture's attempted plugin.install of a reserved built-in was rejected; bootstrapping it through extraBuiltins fixed the harness without changing installation policy.
- **Reversibility:** easy
- **Confidence:** high for the paired consent flow; native shell remains outside this proof
- **Revisit if:** the end-phase mobile UI or paired-client regression fails.
- **Source:** assumed — autonomous (observed paired API and rendered-surface evidence)

## Progress
Ready for normal land. All components and the newly merged mobile caller are implemented; their scopes were audited, temporary component worktrees removed, and all workers returned. The single roadmap catch-up is integrated and all incoming decisions were read. Final bun run typecheck passes; named desktop/API/CLI/real-PTY, Project and paired mobile smoke paths pass; all owned browser tabs and services closed. No permanent suites, full SC01–SC25 campaign, cross-family review round, native OS or other-platform acceptance is claimed. No unbuilt flow/follow-up was added. Commit the final integration/docs, detach and run the exact queue.ts land for this item; only the controller owns integration marking.
