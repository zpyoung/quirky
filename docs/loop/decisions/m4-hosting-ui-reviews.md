# m4-hosting-ui-reviews decisions

## D1: Build the composite review scope, not only the sidebar
- **Question:** what does the queue's three-part title include?
- **Options:** sidebar only; all three parts; all hosting UI.
- **Chose:** right-sidebar Checks, full PR detail, and review creation/hosting settings together. Tasks/issue/Projects are the neighboring dependency; PR sitter and provider APIs remain their owners.
- **Why:** the composite title expressly unions all three parts and excludes only flows absent from every part.
- **Evidence:** queue wait lane5 m4-hosting-ui-reviews; hosting-ui.md sections5,10,11 and non-task12; docs/roadmap.md M4.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** the queue explicitly reallocates a flow.
- **Source:** locked by docs/roadmap.md

## D2: Resolve design questions unattended with one self-reviewed logic spec
- **Question:** how to run brainstorming and specifications without a person?
- **Options:** ask and wait; use recommended defaults under the autonomous night protocol.
- **Chose:** no asks, no visual/adhd offer, no research swarm; one markdown logic spec with final technical contracts. Select Visual layout/density/loading/errors/interaction, API errors/auth/response, CLI flags/output/errors, Integration conflict/data mapping, Data persistence/ownership. Resolve every selected question against feature docs and existing public conventions.
- **Why:** canonical LOOP night mode overrides the interactive gates and separate tech/spec-review stages.
- **Evidence:** git show build/roadmap:docs/loop/LOOP.md; sections Night mode and Answering a skill's questions.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** operation becomes attended.
- **Source:** locked by docs/loop/LOOP.md

## D3: Keep the review feature independently replaceable and share hosting policy
- **Question:** where do the PR page, Checks and creation/settings live?
- **Options:** expand the shell; concurrently modify the Tasks plugin; separate quirky.reviews plugin over public hosting/worktree/git/UI APIs.
- **Chose:** separate quirky.reviews plugin, no private sibling imports or renderer gh invocation. Public open method takes worktree, number and optional conversation/checks/files tab; view ID view:quirky.reviews/review. Tasks keeps its navigation state and routes PR detail to this method. A public close method restores prior view.
- **Why:** separate ownership avoids concurrent writes with the pending Tasks item while preserving one canonical provider, merge, auth and confirmation seam.
- **Evidence:** m4-hosting-ui-tasks D1/D3; committed plugins/quirky.tasks/src/contracts.ts; accepted coordination receipt5828f059-4097-45e7-9918-72b39662c3a2.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** public registry routing cannot express a documented flow; grow it rather than import private implementations.
- **Source:** assumed — autonomous

## D4: Use OpenAI task implementers and Gemini cross-family review
- **Question:** which reachable pairing satisfies an omp lane?
- **Options:** task+Opus; task+Gemini; same-family fallback.
- **Chose:** IMPLEMENTER=task, AUTHOR_FAMILY=openai, REVIEWER_ALIAS=gemini, high thinking. At most three implementation components; one final review round and blocking fix batch.
- **Why:** actual pi-watch --check found Opus/Sonnet unavailable and Gemini google/gemini-3.1-pro-preview:high available. Bun1.4.0 available. Build bun run build; affected directories bun scripts/suite.ts; scripts bun test scripts; typecheck bun run typecheck. Whole suite belongs to queue land.
- **Evidence:** preflight exit5 with7/12 aliases ready; separate bun --version1.4.0; LSP status no language servers configured.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** actual selected reviewer dispatch fails; use the documented fallback ladder.
- **Source:** locked by docs/loop/LOOP.md

## D5: Preserve data ownership and show failures rather than false success
- **Question:** how do missing metadata, stale reads, optimistic writes and provider failures appear?
- **Options:** reproduce Orca's silent/no-check defaults; distinguish loading, unavailable, empty and authoritative state.
- **Chose:** preserve stale data plus visible refresh error, generation/context ownership, optimistic reversible updates with rollback, confirmed comments retained over lagging reads, and explicit unsupported status-only rerun error. Never interpret unknown checks or missing merge metadata as permission to merge; destructive merge uses fresh expectedHead and kernel confirmation.
- **Why:** these are consumer-visible correctness requirements and fix recorded source defects without inventing another provider policy.
- **Evidence:** hosting-ui.md sections5,10, Edge cases, Verified in the app; m4-hosting-api-github D9/D17/D19/D38/D42.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** an acceptance flow contradicts the source or canonical API.
- **Source:** locked by hosting-ui.md

## D6: Verify isolated macOS workflows and hand off OS effects
- **Question:** how to test hosting writes and native links/clipboard unattended?
- **Options:** real user forge/auth state; disposable daemon/home/repo and stateful gh fixture.
- **Chose:** fresh HOME/QUIRKY_HOME and owned process scope for API/CLI and web proof; never real hosting mutations or credentials. Native clipboard, external-browser routing, modifier behavior and focus go to pending native scenarios. Linux/Windows keyboard, shell/auth and link routing need their platform verification.
- **Why:** headless web proof does not establish OS effects and the loop forbids real-state tests.
- **Evidence:** LOOP Hard rules/Verify; hosting-ui.md sections5,10–12.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** those platforms or real native verification become available.
- **Source:** deferred: platform

## Progress
Claimed item, created build/m4-hosting-ui-reviews, merged pending Tasks contracts at b4ac583. Hosting API is already present on the integration-derived feature base (queue done); absent deleted aggregate API branch is not a blocker. Tasks is pending and early dependency rules apply. Read-only public seam mapping pending. Next: write full logic acceptance/contracts, commit shared interfaces, dispatch at most three disjoint vertical implementers.
