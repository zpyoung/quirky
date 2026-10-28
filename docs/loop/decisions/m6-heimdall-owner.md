# m6-heimdall-owner decisions

## D1: Build only the optional owner slice
- **Question:** brainstorming purpose, consumer, scope and success
- **Options:** whole Heimdall feature; optional owner layer only
- **Chose:** owner config, typed deviations, report/intervention gates, silence and worker idle/stall detection; not judgment, fleet, concrete kinds or UI.
- **Why:** queue title explicitly names the owner layer; core and controls have independent owners.
- **Evidence:** queue wait lane12; external heimdall.md:219-224; logic.md AC1-8
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** source in-scope flow cannot be exposed through public methods
- **Source:** locked by docs/loop/queue.json

## D2: Resolve all skill questions autonomously with source-grounded defaults
- **Question:** brainstorming standard API/CLI/data/integration gray areas, format and approvals
- **Options:** human waits/research swarms; unattended night defaults
- **Chose:** API discriminated outcomes, explicit errors and exact report identity; generated CLI; natural-key dedupe, durable uncertainty and bounded UTF8 payloads; source thresholds and common intervention vocabulary. Claude only, optional model/effort. Separate owner capability default off plus native gates. One logic.md with final technical section, self-reviewed against owner flows; no research swarm/visual/adhd/human wait.
- **Why:** LOOP mandates unattended defaults and night-mode single spec. Questions about platform, errors, recovery, authentication, idempotency, missing evidence and scope are all resolved explicitly in logic.md Decisions locked.
- **Evidence:** current build/roadmap LOOP Night mode and Answering skills; external heimdall.md owner section; architecture Decisions
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** core authority contract conflicts
- **Source:** locked by docs/loop/LOOP.md

## D3: Use in-plugin owner modules and public cross-plugin calls
- **Question:** design alternatives and integration
- **Options:** owner modules in quirky.heimdall; separate private-state owner plugin; duplicated per-kind owners
- **Chose:** modules in existing built-in, public structured/orchestration calls, kind-owned translation hooks. Parent integrates runner gates and serialized controls; worker modules consume committed owner/contracts.ts.
- **Why:** core D3/D8/D10 require public namespaced kind hooks, service authority and synchronous fencing. Separate plugin would add a private state boundary.
- **Evidence:** m6-heimdall-core D3/D8/D10; owner contracts; OwnerSurface scout
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** public service API cannot observe or address an exact owned worker
- **Source:** locked by docs/loop/decisions/m6-heimdall-core.md

## D4: OpenAI implementers and Gemini cross-family fallback
- **Question:** SDD preflight reviewer pairing, checks, and decomposition
- **Options:** omp task+Opus; omp task+Gemini; reduced-independence OpenAI review
- **Chose:** IMPLEMENTER=omp-task, AUTHOR_FAMILY=openai, REVIEWER_ALIAS=gemini, verified google/gemini-3.1-pro-preview:high. One wave with two disjoint external worktrees (runtime, detection), cap3; parent integrates hubs. Workers skip builds/tests/lint/formatters mid-flight. Parent runs acceptance after barrier, affected suite/scripts/typecheck once before final review and queue land. No whole-suite baseline.
- **Why:** actual pi-watch --check reports no authed Opus/Sonnet; Gemini ready. Contracts first avoids implementation races.
- **Evidence:** alias preflight output artifact://7; committed owner/contracts.ts; LOOP Night mode
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** actual reviewer dispatch fails
- **Source:** assumed — autonomous

## D5: Preserve current landed structured runner while merging early core contracts
- **Question:** early dependency merge conflicts in stale m5 history
- **Options:** take stale dependency m5 versions; keep current roadmap m5 versions
- **Chose:** roadmap versions of m5 decision log, plugins README, structured runner and its two tests. Core contracts/spec/decisions merged at2769ff97. Sent core lane the owner integration request; no private worktree edits.
- **Why:** m5 already landed and its verified restoration must not be undone by older core ancestry.
- **Evidence:** merge conflict output and2769ff97; lane12 previous notes; core terminal send request e4a7ac0a-1198-45d6-9479-7c73eea55f39 input accepted (turn not attested)
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** core shows a specifically required conflicting change
- **Source:** assumed — autonomous

## D6: Limit platform verification to macOS
- **Question:** platform and process safety
- **Options:** claim portability from APIs; verify Mac and defer other OS checks
- **Chose:** portable TypeScript/Bun, macOS tests/smoke only. Linux/Windows lifecycle and file-opening verification deferred. Fresh HOME/QUIRKY_HOME, NODE_ENV=test and cleared provider-home overrides for all spawned smoke processes; owned processes always cleaned.
- **Why:** LOOP platform rule and prior real-home incident require explicit isolation.
- **Evidence:** LOOP Hard rules; m5-structured-runner D11; logic.md technical decisions
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** another platform is authorized
- **Source:** deferred: platform

## Progress
Claimed lane12 m6-heimdall-owner. Merged early core contracts; dependency wait in bg_1 still pending. Spec self-review complete and shared owner type contracts ready to commit before two implementation components. Core lane notified and reply requested at /tmp/quirky-lane12-owner-core-reply.md. Next: implement runtime/detection, integrate with core as its code arrives, test actual API/CLI, dependency ready/catch-up/review/land. No feature acceptance claimed yet.
