# m4-hosting-ui-tasks decisions

## D1: Build all three assigned GitHub surfaces together
- **Question:** which exclusions in the composite queue title apply?
- **Options:** Tasks list only; all three parts with union scope; entire hosting UI.
- **Chose:** all three parts together: Tasks source/list/inline edits/workspace/settings, issue detail/new issue/composer, and Projects v2 picker/table/board/roadmap. PR detail, GitLab tasks, Checks sidebar and PR creation remain separate items. PR rows can open the public hosting review target without claiming an unimplemented PR detail page.
- **Why:** the title explicitly says each part's exclusions do not remove another part's inclusion.
- **Evidence:** queue.ts wait lane6 item m4-hosting-ui-tasks; hosting-ui.md sections1–4,6–8,12; docs/roadmap.md M4.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** the queue explicitly reallocates a flow.
- **Source:** locked by docs/roadmap.md

## D2: Apply unattended night-mode approvals and standard gray areas
- **Question:** how to resolve brainstorming's visual companion, research, questions and approval gates?
- **Options:** wait for a person; apply recorded recommended defaults under LOOP.md.
- **Chose:** no asks; no visual/adhd offer; no external research swarm; one markdown logic spec with a final technical-decisions section; self-review against every source flow. Select Visual layout/density/loading/empty/error/interaction; API errors/auth/pagination; Integration sync/conflicts/data mapping; Data persistence/idempotency. Resolve each against the source and existing conventions.
- **Why:** LOOP.md night mode and unattended instructions override the skill's interactive procedure.
- **Evidence:** docs/loop/LOOP.md Night mode and Answering a skill's questions.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** the loop returns to attended operation.
- **Source:** locked by docs/loop/LOOP.md

## D3: Prefer one built-in Tasks plugin over a shell-owned feature or Orca port
- **Question:** which candidate architecture preserves plugin parity and maintainability?
- **Options:** add Tasks directly to the shell; one built-in Tasks plugin on the public hosting API; port Orca's Electron/store hook chain.
- **Chose:** one built-in Tasks plugin, focused feature modules, public hosting/repo/worktree/agent/UI calls, schema-generated namespaced CLI. No direct gh calls from the renderer and no private daemon imports.
- **Why:** the existing hosting dependency owns upstream policy/auth; the shell is a registry host, not a second hosting implementation. Porting the original forty-stage store chain retains unrelated remote-runtime coupling.
- **Evidence:** docs/architecture.md Decisions; docs/roadmap.md scripting rules; hosting-ui.md Processes and layers; m4-hosting-api-github D4/D7/D9/D17/D19.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** the public registry cannot express a required surface; grow its public contract instead.
- **Source:** assumed — autonomous

## D4: Use OpenAI implementers with Gemini cross-family review
- **Question:** which reachable reviewer satisfies the omp lane pairing?
- **Options:** task+Opus; task+Gemini; same-family fallback.
- **Chose:** IMPLEMENTER=task, AUTHOR_FAMILY=openai, REVIEWER_ALIAS=gemini, high thinking. At most three implementation components. One final review round with one blocking-fix batch under night mode.
- **Why:** actual pi-watch --check found Opus/Sonnet unavailable (no authed model), Gemini available as google/gemini-3.1-pro-preview:high. Bun1.4.0 available. Commands: bun run build; bun scripts/suite.ts for changed directories; bun test scripts; bun run typecheck. Whole suite belongs to normal queue.ts land.
- **Evidence:** observed preflight bg_2 exit5,7/12 ready; LOOP.md Model pairing and Night mode.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** the selected reviewer fails actual dispatch; use the documented ladder and record it.
- **Source:** locked by docs/loop/LOOP.md

## D5: Keep source-specified behavior rather than ambiguous Orca defects
- **Question:** what should uncertain states, optimistic writes and source UX discrepancies do?
- **Options:** reproduce observed omissions; explicit deterministic states preserving data.
- **Chose:** always show the provider context chip; missing/auth-unavailable source shows a blocking notice, not false empty success. Preserve stale rows with refresh errors, optimistic rollback and generation ownership. Distinguish no-checks/loading/unavailable; don't advertise a destructive merge until confirmation and the shared server guard authorize it. Sticky-all repos include later additions, explicit deep-link selection wins, issue-source changes never affect PR targets. Projects remain on ambient auth per the hosting contract.
- **Why:** these settle source gray areas without changing upstream policy or carrying listed UI defects into Quirky.
- **Evidence:** hosting-ui.md sections1–3, Edge cases and failure behaviour; m4-hosting-api-github D6/D9/D17/D19/D38.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** acceptance evidence contradicts the documented flow.
- **Source:** locked by hosting-ui.md

## D6: Verify only isolated macOS state and hand off real OS effects
- **Question:** how to exercise writes, clipboard, external links and Start work unattended?
- **Options:** mutate real forge/user state; disposable daemon/home/repository and stateful gh fixture.
- **Chose:** real daemon API and generated CLI against stateful isolated upstream fixtures; web UI via the prescribed headless user workflow, no foreground. Never alter real GitHub data or auth. Native clipboard/external browser effects get pending scenario handoffs rather than fictitious web proof. Linux/Windows keyboard, shell, clipboard and process integration require later platform validation.
- **Why:** loop tests must never touch real state, and browser proof cannot establish native OS behavior.
- **Evidence:** LOOP.md Hard rules and Verify; docs/architecture.md platform/stack decisions.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** supported test environments or native verification become available.
- **Source:** deferred: platform

## D7: Isolate three slices behind committed public feature contracts
- **Question:** how should the implementation be divided after the code map?
- **Options:** extend the provider plugin with UI state; a separate feature plugin on the provider API; shell integration.
- **Chose:** `quirky.tasks` owns the Tasks feature, persistent item/workspace associations, state/navigation and three surface modules. `quirky.hosting` stays the provider policy owner. Committed contracts039c50a precede three disjoint worktrees for list/issue/Projects; parent owns shared activation/schema/env/UI composition. Each slice owns its API tests and reusable stateful upstream fixture. No shared source-file writers.
- **Why:** hosting has complete provider reads/mutations but no UI; worktree metadata has no hosted-item link field. A feature-owned association uses public APIs without changing another feature's data model.
- **Evidence:** HostingMap exact paths; plugins/quirky.tasks/src/contracts.ts; hosting manifest; worktree/set schema.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** workspace integration gains a shared provider-neutral linkage contract.
- **Source:** assumed — autonomous

## D8: Make every navigation action read back from the daemon
- **Question:** who owns selection/page/detail/dialog state, and what survives restart?
- **Options:** renderer-only state; persist everything; daemon session navigation plus durable preferences.
- **Chose:** daemon session navigation and issue draft; durable source/repo/preset/sidebar preferences, project pins/recent/view and item/workspace associations. UI commands route through the same public methods as the CLI. Navigation updates include their exact projection in the active layout input. Closing restores the prior view, context changes reset page/scroll, explicit direct page overrides remain valid.
- **Why:** locked scripting parity requires observable state, while the source explicitly keeps issue drafts session-only.
- **Evidence:** docs/roadmap.md scripting requirements; hosting-ui.md Store state and Create an issue; src/contracts.ts; state.test.ts expected missing-method failure before implementation.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** window-specific navigation needs concurrent independent sessions.
- **Source:** locked by docs/roadmap.md; locked by hosting-ui.md

## D9: Retain bounded provider identity and mutation ownership across UI surfaces
- **Question:** which caching, pagination and optimistic-write behaviors are essential rather than implementation detail?
- **Options:** re-read everything after every edit; renderer-only optimistic state; bounded source-qualified retained projections.
- **Chose:** exact host/repo/kind/number identities, direct numbered requests, source limits and capped totals, stale rows with explicit errors, older-request rejection, reversible optimistic rollback and bounded search-lag adoption. Expected-head merge is always the existing shared destructive provider seam; queue acceptance is never merged success. Draft/restricted Project items remain read-only.
- **Why:** the original recorded stale index and incomplete metadata risks must not become false UI outcomes.
- **Evidence:** hosting-ui.md sections2–3,8 and Edge cases; m4-hosting-api-github D7/D8/D9/D13/D42.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** a stateful fixture proves that a newer confirmed mutation can be overwritten.
- **Source:** locked by hosting-ui.md

## D10: Separate core contracts from the final verification barrier
- **Question:** should implementers test incomplete sibling contracts or run competing full checks?
- **Options:** each worker builds the whole tree; parent integration barrier and scoped final checks.
- **Chose:** implementers write consumer-visible API/CLI regression tests but skip all mid-flight checks under orchestration policy. Parent observed core RED (three unknown Tasks method failures), then integrates all source/schema contributions before acceptance/smoke. Reuse the existing isolated hosting fixture with an additive test-only extraBuiltins option rather than duplicate process lifecycle machinery.
- **Why:** independent worker trees intentionally lack parent activation/helper code until integration; those failures would test missing assembly, not their behavior. All final owned processes must settle before yielding.
- **Evidence:** actual bg_3 output0pass3fail, unknown quirky.tasks/open/preferences; test/helpers.ts; LOOP.md Night mode/Hard rules; dispatched ownership contracts.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** a component needs a meaningful isolated executable before integration.
- **Source:** assumed — autonomous

## D11: Grow a project-authorized detail read instead of narrowing preview parity
- **Question:** how can an issue from a Project outside registered repos show real comments and timeline?
- **Options:** show an incomplete preview; bypass configured-remote validation; add a membership-authorized public Project detail route.
- **Chose:** public `quirky.hosting/projectItemDetails` and generated `hosting project-item-details`. Reuse the existing bounded loader after Project membership/content identity validation; retain ambient/trusted-host flags on all child reads. Ordinary configured-reference reads remain restricted.
- **Why:** the existing Project API could write comments but had no corresponding foreign-repository detail read. That missing public capability is reachable in this milestone and must be implemented, not silently deferred.
- **Evidence:** item-details.ts parseReference; project-mutations.ts projectItemContext; project-ref.ts projectGraphql/projectRest. Actual regression RED unknown-method then GREEN2pass0fail10assertions, including comment write/readback, membership and host refusal.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** the provider changes Project membership or content URL semantics.
- **Source:** locked by hosting-ui.md; assumed — autonomous (method name)

## D12: Match the real image-URL action without inventing binary uploads
- **Question:** does the documented “Paste, drop, or click to add files” footer establish an authenticated upload flow?
- **Options:** invent a binary upload backend; copy the misleading footer; verify the original action and label it accurately.
- **Chose:** actual URL-image insertion with Write/Preview and bounded HTTP(S) validation. The source footer's click only opens the URL picker; there is no upload/file-handler extension. Binary drops report the need for an image URL without losing text. Corrected the overbroad SC13 inference and its amendment before issue integration.
- **Why:** building an unsupported upload mechanism would add a feature not implemented by the source; claiming success or preserving misleading copy would reproduce a defect.
- **Evidence:** original Orca `src/renderer/src/components/github/GitHubMarkdownComposer.tsx:349–360`; `use-image-input.ts:31–72`; `components/editor/rich-markdown-extensions.ts:74–278` contains Image rendering and no upload handler; hosting-ui.md section4 describes the footer label.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** an actual documented authenticated attachment flow is assigned.
- **Source:** locked by hosting-ui.md; assumed — autonomous (clarified source behavior)

## D13: Supply real iteration metadata before rendering iteration boards and roadmaps
- **Question:** can the current public Project table supply the iteration fields required by the source?
- **Options:** invent dates/options in the UI; display them as unavailable; repair the provider read projection.
- **Chose:** query actual iteration configuration and item values; preserve completed-then-active option order, IDs, names and real date/duration fields. Normalize to the already agreed field options and row value contracts. Reuse readable query selections for fields/grouping/sort rather than add another set of repeated fragments.
- **Why:** the source supports iteration grouping/movement/placement. The current API omitted the fragment and then classified legitimate iteration rows as schema drift.
- **Evidence:** Project worker seam report; original project-view-query-fragments.ts:15–22,65 and field-normalization.ts:46–71,138–149. Actual API regression failed schema_drift before repair and passed afterward, including moving a card to Sprint two and reading its new interval.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** provider iteration configuration or dates change shape.
- **Source:** locked by hosting-ui.md

## D14: Expose native View switches through the public setting declaration
- **Question:** how can the source's Show Tasks Button View menu item remain a plugin feature?
- **Options:** hardcode Tasks in the shell; omit the native entry; generic optional boolean-setting menu metadata.
- **Chose:** public `SettingDeclaration.menu?: 'view'`, schema/manifest validation, and a native shell projection over effective setting.list values. Each click re-reads the setting before toggling; plugin disable removes it; setting events refresh checkmarks. Tasks opts in declaratively. Standard app/Edit/Window roles remain. Actual macOS rendering is a pending native handoff.
- **Why:** no native application-menu extension existed. The source requires the restore path, and growing a public API is preferable to a built-in-only exception or an unimplemented flow.
- **Evidence:** protocol UI_KINDS and ui-kinds.ts allowed fields; Electrobun ApplicationMenu SDK; real-daemon regression RED no setting then GREEN1pass8assertions covering script mutation, fresh click, disable and re-enable. LSP references unavailable; text reference sweep found protocol/daemon spread/value-check consumers, all consistent with an optional field.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** menus need command groups beyond boolean View switches.
- **Source:** locked by hosting-ui.md; assumed — autonomous (public metadata shape)

## D15: Keep the public schema subset and runtime bounds consistent
- **Question:** how should slice-authored full JSON Schema descriptors fit Quirky's declared subset?
- **Options:** grow an unrelated schema engine; expose invalid declarations; retain runtime checks and describe unsupported bounds.
- **Chose:** canonical manifest assembly with generated CLI aliases; preserve supported types/properties/enums/ranges, document handler-enforced string/collection bounds, and represent typed maps with allowed additionalProperties:true plus their runtime contract.
- **Why:** the first integrated check had37 failures because Tasks was invalid. A real registry diagnostic identified exactly four typed additionalProperties declarations, not missing implementations.
- **Evidence:** bg27; owned registry diagnostic; protocol/src/schema.ts; subsequent actual API registration and header smoke.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** the public schema language gains typed maps or nullable unions.
- **Source:** locked by docs/roadmap.md; assumed — autonomous (assembly)

## D16: Ask only for the irreversible merge and forward its approved intent
- **Question:** why did ordinary row status edits and opening the workspace composer require confirmation?
- **Options:** pass unconditional yes from every UI action; keep an extra prompt; conditional describe and one canonical guarded merge.
- **Chose:** reversible row actions return null from rowConfirmation; workspace start/resume/link/unlink have no destructive declaration. Merge descriptions bind repo, method, number and head; UI sends yes only after its explicit confirm. The protected row handler forwards that approved intent to the existing hosting merge seam, which still fresh-checks head/policy. Removed the unusable hand-written confirmation marker.
- **Why:** the dispatcher reserves and strips yes/confirmation before invoking handlers. The old marker could never reach the handler and nested merge calls had no inherited consent.
- **Evidence:** dispatch.ts:120–131,181–196; actual ConfirmationRequired failures on reversible operations; real header/CLI smoke7 assertions with no creation and exact link state.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** dispatcher nested-confirmation semantics change.
- **Source:** locked by docs/roadmap.md; assumed — autonomous (conditional describe)

## D17: Consume canonical creation and agent-selection APIs
- **Question:** which public APIs implement sourced creation, auto agent choice and setup decisions?
- **Options:** plain creation plus a link; infer auto selection from catalog flags; use each owning feature's public operation.
- **Chose:** worktree/create receives the exact HTTPS item URL as github; never fall back to plain creation. agents/pick with forAgentTab:true selects the default; listing still validates explicit choices. Ask setup policy matters only when hooks.setup.text exists. Project prompts use real line breaks.
- **Why:** plain creation can check out the wrong PR branch; isDefault does not resolve the auto setting; a missing setup hook needs no choice.
- **Evidence:** lane2 canonical contract and branch2e2d617e; public agents/pick and repo/show schemas; LaunchApiMap exact comparison.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** the owning APIs change their declared source or selection contracts.
- **Source:** locked by hosting-ui.md; assumed — autonomous (public API integration)

## D18: Preserve actual participant and timestamp data instead of empty or fresh-looking fallbacks
- **Question:** how can row reviewers and the dependent review surfaces read existing provider state?
- **Options:** empty placeholders; extra per-row subprocesses; retain fields in existing reads.
- **Chose:** existing gh reads select reviewRequests/reviews/assignees and delta counts. Review and refresh retain actual bounded participant state, nullable unknowns, and provider updatedAt; fetchedAt is never a timestamp substitute. PR details expose the same snapshots. Fixed the shared type predicate to preserve its validated record intersection.
- **Why:** missing read projections cannot be repaired with successful mutation calls or fabricated empty lists.
- **Evidence:** 0a17328c; actual participant/delta regressions; timestamp red then2pass14assertions; user-reported shared type diagnostics fixed without weakening behavior.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** provider field shapes or collection bounds change.
- **Source:** locked by hosting-ui.md; assumed — autonomous (nullable unknown representation)

## D19: Share feature boundaries with the review and worktree lanes
- **Question:** how should the parallel M4 surfaces compose without private shell imports or duplicate owners?
- **Options:** duplicate PR UI and create logic; import private feature internals; public RPC and explicit UI-library exports.
- **Chose:** known PR navigation calls reviews/open through the shared hook; Reviews owns its page/Checks/create and canonical conversation mutations. Markdown has public workspace package exports. Generic settings-view metadata came from lane5's focused71f73d6, integrated asf6f60de5; Tasks declares its own public settings view. A global composer overlay serves both Tasks and PR headers.
- **Why:** these are real cross-feature seams, not permission to add feature-specific shell code. The source creation runtime remains lane2-owned and must arrive through its normal landing.
- **Evidence:** accepted lane terminal coordination; source checkpoint0a17328c; f6f60de5; actual public workspace Start/link/CLI smoke; pending native handoff.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** a feature's public route or package export changes.
- **Source:** locked by user lane coordination; assumed — autonomous (UI-library subpaths)

## Progress
All three components were audited, committed and merged; temporary component worktrees removed. Canonical runtime/manifest and default harness are assembled. Shared hosting read tests passed48/0, forced Project refresh1/0, Markdown consumer smoke5assertions and actual Start/link/generated CLI smoke7assertions. This is not a full green claim: the first complete typecheck found59 diagnostics; two parent/shared type fixes are applied and slice repairs are next. Remaining work: finish type/runtime integration, incorporate canonical sourced creation after lane2 lands, final scoped gates/build, cross-family review and one fix batch, visible web goals, evidence/docs, then normal queue land.
