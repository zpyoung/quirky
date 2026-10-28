# m7-sweep-terminal decisions

## D1: Audit all nine docs; preserve explicit exclusions
- **Question:** What does the terminal parity sweep include?
- **Options:** Rebuild every original feature; audit shipped features and close bounded gaps; inspect only known blockers.
- **Chose:** Audit every flow and defect in ask.md, cli.md, agent-status.md, launch-settings.md, notifications.md, providers.md, term-daemon.md, term-ui.md and worktrees.md; implement bounded missing behavior and record larger gaps in one dependent follow-up.
- **Why:** The item explicitly requests every remaining flow, including omissions and deferrals, while permitting follow-up items for larger work. Do not claim an audit is runtime proof.
- **Evidence:** queue.ts wait --lane 7 returned m7-sweep-terminal; docs/roadmap.md:13-55; canonical docs/loop/LOOP.md night-mode rules.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** A flow cannot be assigned to shipped evidence, a fix or a named follow-up.
- **Source:** locked by docs/roadmap.md

## D2: Use unattended night-mode workflow and autonomous defaults
- **Question:** How are skill questions and breadth handled without a person?
- **Options:** Ask and wait; silently omit ambiguous flows; choose documented/recommended defaults and record them.
- **Chose:** No human prompts, no external research swarms, standard gray areas, markdown logic spec with final technical section, contracts before implementers, at most three implementers, one final review and one catch-up. Use source docs and prior decisions for observable behavior; fail closed on unsupported targets and permissions.
- **Why:** Canonical LOOP.md explicitly supplies the unattended and night-mode overrides. Audit scouts map repository evidence, not external research options.
- **Evidence:** Canonical git show build/roadmap:docs/loop/LOOP.md; claim at 2026-10-28 01:56 CDT.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** A locked decision conflicts with core requirements.
- **Source:** locked by docs/loop/LOOP.md

## D3: Use OpenAI implementers and reachable Gemini reviewer
- **Question:** Which cross-family implementation/review pair is available?
- **Options:** omp task + opus; omp task + sonnet; omp task + gemini; same-family fallback.
- **Chose:** IMPLEMENTER=omp-task, AUTHOR_FAMILY=openai, REVIEWER_ALIAS=gemini. Review has not yet run.
- **Why:** pi-watch --check resolved Gemini google/gemini-3.1-pro-preview:high; opus and sonnet have no authed/shipping models. Prefer reachable cross-family review to a knowingly unavailable backend.
- **Evidence:** Scratch /tmp/quirky-m7-sweep-terminal-lane7.KpyVcb; pi-watch --check output, exit5 because5 unavailable aliases; codex/terra/gemini/flash available.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** Actual review dispatch fails; availability is not review assurance.
- **Source:** assumed — autonomous

## D4: Preserve inherited untracked files without staging them
- **Question:** How should inherited dirt be handled?
- **Options:** Commit it; stash/remove it; leave unrelated untracked files untouched and use isolated component trees.
- **Chose:** Preserve .serena/, test.ts and test-migrated.test.ts unstaged. All implementation work uses separately scoped component worktrees.
- **Why:** Previous iteration identifies these as user/inherited state. No tracked edits existed on orientation. They must not enter the product diff or be destroyed.
- **Evidence:** Initial git status --short --branch; lane7 iteration7 notes.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** An inherited file blocks a required command.
- **Source:** assumed — autonomous

## D5: Close Activity, recipe choices and CLI open; preserve every larger gap
- **Question:** Which audited gaps are independent bounded vertical slices, and are old non-goals exempt?
- **Options:** Build the complete nine-doc backlog in one branch; declare old non-goals exempt; build three independent slices and register all larger gaps once.
- **Chose:** Activity threads/read receipts/clear/navigation; Source Control recipe model/options across UI and both actual execution paths; CLI open readiness/idempotence. Old item non-goals remain parity obligations. The logic spec inventories all nine docs and maps every larger omission to one completion follow-up or an existing explicit owner.
- **Why:** m1-agent-status D1 explicitly assigns Activity to this sweep. Recipes demonstrably lack launchOptions in storage and execution. CLI currently calls macOS open and returns success on launcher exit alone. These changes reuse existing public APIs and do not require the absent remote-host/native-notification capabilities.
- **Evidence:** Agent audits AuditAskCli, AuditProviderStatus, AuditTerminalTrees and corrections; plugins/quirky.git/src/daemon/ai-recipes.ts:14-24; packages/cli/src/main.ts:224-229; docs/loop/decisions/m1-agent-status.md D1/D31.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** CLI has no genuine native-desktop readiness evidence or a slice requires a new cross-component prerequisite.
- **Source:** assumed — autonomous

## D6: Preserve existing status and argument authority while adding projections
- **Question:** Data/idempotency/precedence and UI error-state gray areas.
- **Options:** Mutate live status for read/clear; persist independent turn-scoped Activity snapshots; build a second launch resolver.
- **Chose:** Separate retained Activity projection from live row state; read receipts fence on the observed turn, completed clear never deletes sessions/status/transcripts, a new turn resurfaces. Recipe launchOptions use public agent catalogs/resolution and raw > picks > configured precedence, with explicit null inheritance reset. Unknown/unsupported targets fail before launch. No catalog defaults are invented for missing picks.
- **Why:** Notifications and scripting already consume live status; feed cleanup must not change their state. One resolver prevents the source doc's duplicate-flag, ignored-effort and snapshot disagreement defects.
- **Evidence:** agent-status.md Activity flows; launch-settings.md launch precedence and defects; plugins/quirky.agents/src/core/resolve.ts; committed logic.md A1-A3/R1-R3.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** A consumer observes inconsistent effective flags or delayed acknowledgment consumes a newer turn.
- **Source:** assumed — autonomous

## D7: Tests-first workers do not execute mid-flight checks
- **Question:** How to reconcile TDD with the no-mid-flight-worker-check policy?
- **Options:** Let simultaneous implementers run broad suites; implement then add tests; tests-only first dispatch followed by parent-observed red and scoped implementation.
- **Chose:** Three isolated disjoint worktrees, each first writes regressions only and returns. Parent observes expected failures, then dispatches production implementation without mid-flight checks. Parent owns the final barrier, scope audit, checks and commits. Width3, one independent component per slice; no semantic dependency edges.
- **Why:** Gives failing-before evidence without competing test jobs or shared files. Shared data types and spec committed first at d65d0849.
- **Evidence:** Component roots under /tmp/quirky-m7-sweep-terminal-lane7.KpyVcb/{activity,recipes,open}; task contracts.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** A worker needs a prerequisite outside its declared scope; it must report before widening.
- **Source:** assumed — autonomous

## D8: Existing native desktop identity is the readiness evidence
- **Question:** Does C1 need a new daemon/native-window API?
- **Options:** Count any UI client; require a new window registry; use the existing desktop client identity.
- **Chose:** Native `desktop` role only. The shell constructs/loads its BrowserWindow before connecting with that role. The CLI must not treat ordinary `ui`/`cli` clients as native readiness. This proves an attached native shell/window, not visible pixels or completed web rendering; the nightly native handoff verifies the real surface.
- **Why:** The actual desktop startup ordering already exposes the needed bounded evidence without changing protocol/daemon authority.
- **Evidence:** apps/desktop/src/bun/index.ts:241-258; baseline actual daemon status listed only role cli and therefore is not desktop-ready.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** Desktop connection can outlive its window or a separate window becomes the bootstrap authority.
- **Source:** assumed — autonomous

## D9: Red regressions prove absent public Activity and recipe choices
- **Question:** What failed before implementation, and was it the intended behavior?
- **Options:** Infer missing behavior from source; exercise regressions against unchanged production.
- **Chose:** Parent ran Activity regressions: 0 pass/6 fail, missing Activity RPC/CLI, 5.89 seconds. Parent ran recipe/generator targeted regressions: 0 pass/5 fail, schema refuses launchOptions/model and effective source absent, 24.19 seconds. Neither result is a green claim. The first CLI red attempt instead found a missing PROTOCOL_VERSION test-fixture import; parent repaired that fixture before attempting a behavioral red.
- **Why:** Missing API and saved selection are observable gaps. Fixture errors cannot stand in for a production regression.
- **Evidence:** Parent tool outputs artifact://16, artifact://19, artifact://21; component trees. Baseline actual daemon/CLI version/catalog/status probe passed and removed its temporary home/processes in 12.16 seconds.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** A regression tests forwarding rather than actual public behavior or launch argv.
- **Source:** assumed — autonomous

## D10: Generic option-only API picks retain explicit provenance and the native model
- **Question:** R2 uncovered that terminal/session launch reaches validateSelection, which refuses all options without a model. Converting recipe effort into raw extra args would mislabel its snapshot.
- **Options:** Invent a model; relabel structured effort as raw arguments; add a recipe-only resolver; allow catalog-declared generic options through the single existing resolver.
- **Chose:** The existing API accepts a null-model validated selection only for generic unlistedOptions. It emits no model flag, model snapshot or structured model field, preserves the configured/native model and records the picked effort as explicit. Raw effort can supersede it; an unrelated raw model does not erase a generic effort pick. Unsupported/composed-only choices still refuse. Existing CLI flags that explicitly require model retain their policy.
- **Why:** launch-settings.md records effort-without-model being ignored by Source Control text actions as a defect. A fabricated model or raw-argument provenance would conceal the defect rather than fix it. This supersedes m1-launch-settings D9's blanket API model prerequisite for catalog-declared generic options only; its invalid-model/ceiling/type/CLI refusal rules remain.
- **Evidence:** plugins/quirky.agents/src/core/selection.ts:50-52 before fix; resolve.ts model emission; public session/newTab forwarding; new option-only tests failed 1pass/3fail on effort requires a model, then passed4/0/15 assertions. Combined selection/resolver/plan proof193pass/0fail/1544 assertions.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** A provider cannot honor its own catalog's generic option declaration or an API consumer sees invented model/provenance.
- **Source:** supersedes m1-launch-settings D9

## D11: Parent owns the shared option-only prerequisite and schema descriptions
- **Question:** Which files must change outside the original recipe component?
- **Options:** Let the recipe worker cross its scope; leave a misleading raw-args workaround; let the parent own the shared contract cutover.
- **Chose:** Parent owns agents/core/types.ts, selection.ts, resolve.ts and directly affected core/service/e2e tests; session/terminal manifest option descriptions. Recipe worker owns generation integration and agents manifest descriptions, as originally assigned. No concurrent writes share a file. Reference search enumerated every ValidSelection/selection.model/Needs model consumer; plan/service callers need no signature shim. The model-only tests made obsolete by the intentional API change are removed rather than re-pinned.
- **Why:** The required recipe behavior crosses a public prerequisite; the component may not silently expand or falsify provenance. No second API/resolver or compatibility alias.
- **Evidence:** D10; reference enumeration across plugins/packages; no configured LSP server. Parent observed the failing prerequisite before implementation.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** A further consumer assumes validated model is always nonnull.
- **Source:** assumed — autonomous

## Progress
Step5: all three implementation components returned initial code. CLI focused proof35pass/0fail/263assertions after a parent-found unbounded-RPC readiness repair; no real app launched. Activity API/CLI proof7pass, UI initially lacked package deps; dependencies declared. Parent-found async query stale-write race fixed; one race test had an invalid cleared-thread dereference and is corrected, rerun pending. Recipe worker is finishing UI plus actual effort-only launch regression; it no longer fabricates raw-arg provenance. Shared generic-option cutover193pass/0fail. No component committed/merged yet; wait for final recipe return and all checks before wave barrier. Scratch /tmp/quirky-m7-sweep-terminal-lane7.KpyVcb; notes hold exact commands. Actual smoke, web campaign, affected suites, catch-up/review and land remain.
