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

## D12: Keep the flat schema contract and distinguish recipe settings from trust preparation
- **Question:** Why did repaired recipe source methods still disappear, and what configuration mutation belongs to the recipe?
- **Options:** Expand the kernel schema dialect; suppress invalid-plugin diagnostics; use the established flat subset with authoritative runtime validation.
- **Chose:** Boolean additionalProperties only; nullable launchOptions inputs remain discoverable description-only properties, with complete object/null/domain validation in the recipe service. No type arrays or schema-valued maps. Recipe picks never persist model/effort settings; existing workspace-trust preparation is unchanged.
- **Why:** Actual standalone plugin.list reported whole-plugin invalidation for unsupported generate.optionValues and recipe.launchOptions schemas. Independent structural validation confirmed the rejection chain. The config sentinel then exposed only the normal trusted-project entry, so its fixture uses the supported trust-off setting to isolate recipe writes; no production trust path was removed.
- **Evidence:** Runtime diagnostic artifact57 and ValidateSweepPlugins report; repaired native/API run5pass plus isolated final raw-Codex case1pass/0fail/6assertions5.43sec; recipe UI50pass/0fail/172assertions.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** A field cannot be represented or validated using the existing public schema/runtime boundary.
- **Source:** assumed — autonomous

## D13: Exercise the composed product with owned external-provider stand-ins
- **Question:** What proves the changed paths beyond source and isolated tests?
- **Options:** Treat unit tests as runtime proof; launch real paid providers; run the actual daemon, CLI and PTY host against isolated native-protocol stand-ins.
- **Chose:** Full packaged build plus actual standalone daemon/CLI/PTY smoke in fresh HOME/QUIRKY_HOME. Synthetic native desktop client plus a failing open shim verifies ready short-circuit without opening the user's app. The built-web five-goal campaign uses the same owned fixture; native visibility/load-complete/physical focus remain pending.
- **Why:** This drives the public execution path while preserving the user's real homes and accounts. It does not assert live paid-provider or physical-window clearance.
- **Evidence:** Build exit0,21 plugin UI modules and28 packaged plugins. m7-terminal-smoke-lane7 printed SMOKE_PASS: Claude Opus/High argv and exact raw Haiku/Low precedence, Codex gpt-5.5/High native argv and prompt, invalid selection creates no session, Activity child/waiting/working/completed and stale-token refusal, real shell exit3, persisted recipe projection. Scratch smoke-observations.json. UI service still running pending campaign completion.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** A native provider differs from its declared protocol or the actual UI campaign finds a consumer failure.
- **Source:** assumed — autonomous

## D14: Route the new CLI regression to macOS and remove incidental wiring assertions
- **Question:** How will normal merged verification exercise the new macOS-only command rather than skip it remotely?
- **Options:** Leave all new open cases skipped on Linux; add them to the existing macOS test-routing list; change the protected runner.
- **Chose:** Add packages/cli/test/open.e2e.test.ts to scripts/test-on-macos.txt with its platform reason. Do not change scripts/build-loop or suite behavior. Remove source-text/method-copy/default-metadata tests from command-spec.test.ts rather than re-pin the open method list; actual spawned CLI tests retain readiness/timeout/error behavior.
- **Why:** The product deliberately refuses non-macOS open, so these cases need the existing local Mac lane. Source-string assertions and copies of command metadata do not establish consumer behavior.
- **Evidence:** scripts/suite.ts local-only selection; actual open command's platform guard; command-spec.test.ts removed kernel declaration/source/wiring block and v1-word table check; existing public CLI flow tests remain.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** Desktop opening gains another supported platform or command discovery behavior changes.
- **Source:** deferred: platform

## D15: Fix confirmed Activity UI defects and preserve the guarded campaign's limits
- **Question:** What did the actual built-web campaign prove, and what failed?
- **Options:** Treat all goals as passing; file our own defects as future work; fix the app findings and retain honest tool-limited outcomes.
- **Chose:** Fix F1 by omitting blank selectors from Activity view input; fix F2 with a bounded plugin-owned results scroller and spacing, not by hiding Accounts or changing global layout. The original report has3 Activity passes and2 recipe goals unset after driver failure; those2 are tool-blocked, never relabeled passes. Retry only the relevant visible repairs with a fresh guarded campaign if the driver is usable.
- **Why:** The visible filter alert and clipped Working row are real app findings. Subsequent act/observe/end commands timed out; the guard eventually emitted cleanup_failed because its final screenshot failed. It reported no kept-open windows and restored the frontmost app. The report remains unchanged.
- **Evidence:** .quirk/using-apps-like-a-user/runs/20261028T081739-fab2/report.json, report.md; F1 obs-6.png; F2 obs-17.png; inherited Codex/gpt-5.5/High dialog obs-33.png. Repair-focused root check24pass/0fail/125assertions6.25sec; repaired packaged build exit0. Original runtime STOP exited0 and printed SMOKE_CLEANED true.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** The fresh actual surface still shows the alert or inaccessible lower rows.
- **Source:** assumed — autonomous

## D16: Apply the expired-item landing rule without inventing model clearance
- **Question:** What final review remains after the long guarded-driver stall crossed the item's two-hour bound?
- **Options:** Pretend the READY probe was review; start an unrequested extra review delay; follow canonical LOOP's already-expired-item fast path after mandatory gates.
- **Chose:** No final model review will be started; land only after affected tests, scripts and typecheck pass. Gemini availability/READY and structural plugin validation are not code-review clearance. Preserve native and tool-limited UI evidence explicitly.
- **Why:** The item was claimed01:56CDT; guarded campaign08:17:39Z–09:33:39Z spent76minutes and stalled after28 actions. The canonical rule says an item already past2hours lands as soon as owned tests/typecheck pass and skips an unstarted review round. The4am target was missed; no on-time claim.
- **Evidence:** Canonical LOOP night-mode expired-item rule; actual date04:35:31CDT; guarded report start/end and command-timeout record. Review scripts are prepared but have not been dispatched.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** A later independent review finds a defect; do not interpret this choice as a review verdict.
- **Source:** locked by docs/loop/LOOP.md

## D17: Preserve incoming background, launch-snapshot and exact-navigation authority
- **Question:** Do the new canonical decisions conflict with our Activity and recipe contracts?
- **Options:** Replace shared contracts with private state; preserve the incoming public authority and migration order.
- **Chose:** Preserve background non-adoption, exact explicit session navigation without replacement shells, canonical Session.launchSettings provenance, owner/runtime fail-closed behavior, durable logical request-ID versus transport-ID semantics, and append-only session migration order(pointer9/background10). Activity remains a read projection; it never settles orchestration work or grants policy authority.
- **Why:** Read-only scouts consumed every incoming changed log through canonical3c0421b321a78b7f9f222521b0f789bc40e69341 and found no binding conflict. Our generic option-only API path preserves native option provenance rather than creating another launch table.
- **Evidence:** IncomingSweepDecisions reports: m5-automations-ui D1–D29; m6-heimdall-core D27/D30/D31; sa-browser-profiles-settings D9/D15/D17/D21/D24/D25; m6-orchestration-ui D3–D5/D8/D9/D12–D15. Source snapshots1d7ae078 and3c0421b3.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** Catch-up brings a new conflicting contract or a test demonstrates composed ownership drift.
- **Source:** locked by docs/loop/decisions

## D18: Register one complete remaining-parity owner
- **Question:** How are larger gaps and driver-limited proof carried forward without losing any audited flow?
- **Options:** Omit them; create many duplicate follow-ups; register one dependent completion item with an exhaustive title and the spec inventory.
- **Chose:** m7-sweep-terminal-completion, M7, all9 source docs, depends on this item. Its title names every remaining flow family plus guarded recipe proof and post-repair Activity visibility closure. Existing automation remote/raw-args, terminal-dock and sidebar-extras owners remain separate and must be reconciled, not duplicated.
- **Why:** The item title and night-mode rule explicitly permit larger work to be handed to one follow-up. Core Activity, recipe choices and truthful open are implemented; this is not a claim that the nine-doc backlog is empty.
- **Evidence:** Authoritative queue.ts add exited0. Direct canonical queue read confirms id=m7-sweep-terminal-completion,status=todo,deps=[m7-sweep-terminal]. A queue deps read timed out; it is not treated as registration failure or item blockage.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** A listed flow already has a later shipped owner or an excluded provider is accidentally reintroduced.
- **Source:** deferred: terminal remaining flows

## D19: Recover actual owned gate failures without re-pinning incidental defaults
- **Question:** What failed in the caught-up verification, and what repair establishes the consumer contract?
- **Options:** Re-pin full default objects/argv; waive the failing files; fix the compiler narrowing and keep behavioral assertions.
- **Chose:** Bind the following OneShotArg to a local before its string/includes check. Remove obsolete whole-default recipe snapshots and the incidental default-effort argv pin; preserve raw model uniqueness, max-turns/prompt placement and saved CLI recipe readback. Remove remaining pure Git settings/catalog wiring-copy tests; no production behavior is suppressed.
- **Why:** The initial affected run passed284/286remote files and3Mac files; the2 failures were additional output metadata and omitted unsupported default effort, while all new recipe scenarios passed. The sole compiler diagnostic was TS2339 on repeated indexed-access narrowing. Actual repair uses the existing typed branch rather than a cast.
- **Evidence:** affected.log, typecheck.log; recovery-affected.log:2/2remote files passed,flaky=[]; recovery-typecheck.log exit0; scripts.log:68pass/0fail/576assertions. Build gate exit0. All captured under /tmp/quirky-m7-sweep-terminal-lane7.KpyVcb before archival.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** An actual raw argument, prompt, source or persisted selection regression occurs; metadata copies are not a substitute for that proof.
- **Source:** assumed — autonomous

## D20: Keep the fresh guarded setup failure distinct from app behavior
- **Question:** Did a fresh guarded campaign visibly clear the Activity repairs or finish recipe edits?
- **Options:** Treat setup timeout as app failure; claim inferred visual success; record the actual tool boundary and preserve the proof obligation.
- **Chose:** Record tool-blocked, not pass. Fresh begin was bounded at40seconds and timed out before selecting a driver or creating an observation; end wrote its report with0actions and no kept-open windows. No post-repair visual closure or successful recipe save/reopen is claimed.
- **Why:** The repaired app's new isolated daemon/CLI/PTY smoke passed again, and focused UI/API checks plus build passed, but a guard that cannot initialize cannot exercise pixels. LOOP permits a tool-caused blocked/partial result when its report path and limits are recorded.
- **Evidence:** .quirk/using-apps-like-a-user/runs/20261028T100639-4329/report.json and report.md; run.json has empty driver,0observations,window.session=null. End exit4 cleanup_failed from final screenshot playwright_failed. Second owned runtime exited0 and printed SMOKE_CLEANED true.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** The driver initializes; completion owner must run the exact remaining UI goals and retained screenshot findings.
- **Source:** assumed — autonomous

## Progress
Ready for authoritative land. Components5e3b571d/68d3bc6e/90cfd95a integrated; shared option-only contract and safety guard integrated; owned worktrees removed. Canonical catch-up merged1074b516 at845716df after all incoming decisions were read; sole conflict in Mac test routing preserved both owners. Actual runtime smoke passed twice and both homes/processes are cleaned. Guarded UI has3Activity passes,2tool-blocked recipe goals and no post-repair visible closure; D15/D20 preserve exact reports. Affected verification284/286remote+3Mac followed by complete2-file clean recovery, scripts68pass, compiler recovery0 and packaged build0. One completion item registered and BLOCKERS appended. No final model review clearance(D16). Next: commit the scoped compiler/test/doc receipt, archive evidence, detach and queue.ts land m7-sweep-terminal; recover only failures the authoritative land names.
