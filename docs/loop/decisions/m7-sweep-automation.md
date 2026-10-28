# m7-sweep-automation decisions

## D1: Audit all three documents; preserve explicit exclusions
- **Question:** What is the parity boundary during brainstorming scope selection?
- **Options:** Reimplement all features; audit remaining flows against shipped features and queue owners.
- **Chose:** Audit automations.md, fork-loops.md and ledger.md completely, fixing confirmed bounded gaps and queuing larger work once.
- **Why:** The claimed item's title explicitly permits follow-ups for large gaps; no flow may silently disappear.
- **Evidence:** docs/loop/queue.json item m7-sweep-automation; docs/roadmap.md:27-28,43-53,259-266.
- **Reversibility:** easy (follow-up items remain explicit)
- **Confidence:** high
- **Revisit if:** A flow lacks either shipped evidence or a named queue owner.
- **Source:** locked by docs/roadmap.md

## D2: Resolve unattended workflow questions locally
- **Question:** Who approves design, defaults and scope choices in brainstorming/spec/execution skills?
- **Options:** Ask a human; use documented behavior and recommended safe defaults.
- **Chose:** Use standard gray areas, self-review markdown specs and record each consequential answer; no human questions or visual companion.
- **Why:** The unattended loop forbids questions. The feature documents, roadmap and prior decisions are the research sources; code mapping uses read-only scouts, not external research swarms.
- **Evidence:** docs/loop/LOOP.md, authoritative build/roadmap version read at claim.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** A safe choice conflicts with a locked decision (block rather than override).
- **Source:** locked by docs/loop/LOOP.md

## D3: Keep structured background execution and public plugin boundaries
- **Question:** Should parity reproduce Orca's hidden terminal background execution?
- **Options:** Copy terminal implementation; preserve structured execution with equivalent observable controls.
- **Chose:** Preserve structured sessions for background agents, existing public plugin API and generated namespaced CLI methods.
- **Why:** Architecture explicitly locks structured background agents and plugins on the third-party API; terminal compatibility cannot override it.
- **Evidence:** docs/architecture.md:145-178,290-324; docs/roadmap.md:19-40.
- **Reversibility:** hard (cross-feature runtime contracts)
- **Confidence:** high
- **Revisit if:** User changes the architecture decision.
- **Source:** locked by docs/architecture.md

## D4: Preserve existing follow-up ownership
- **Question:** Should this sweep duplicate previously queued gaps?
- **Options:** Add duplicate work; retain owners and record only newly uncovered obligations.
- **Chose:** Existing m5-automations-dispatch-remote-and-args owns remote execution/generations/pin/re-adoption/raw args; m5-automations-ui-remote-authorities owns remote UI and OpenClaw; m5-loops-ui-visible-stop-close-review owns prior visible Stop/Close/setup verdict and review.
- **Why:** Canonical queue status and queue records show these as todo; no evidence they are complete.
- **Evidence:** docs/loop/queue.json named records, read 2026-10-28T10:17Z.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** Another lane lands one of those owners during this item.
- **Source:** assumed — autonomous

## D5: Use OpenAI task implementers and verified Gemini reviewer fallback
- **Question:** Which cross-family pairing is reachable for the omp execution workflow?
- **Options:** omp task + Opus; omp task + Gemini; same-family review.
- **Chose:** IMPLEMENTER=omp task, AUTHOR_FAMILY=openai, REVIEWER_ALIAS=gemini. Required spec review uses codex as the loop specifies.
- **Why:** pi-watch --check on /tmp returned no authed/shipping Opus or Sonnet model; Gemini resolved google/gemini-3.1-pro-preview:high. Cross-family fallback is explicitly allowed.
- **Evidence:** pi-watch --check, 2026-10-28T10:16Z; exit5 because Anthropic aliases unavailable; codex, terra, gemini, flash resolved.
- **Reversibility:** medium (review independence record)
- **Confidence:** high
- **Revisit if:** Gemini dispatch fails (record actual failure and use verified fallback ladder).
- **Source:** assumed — autonomous

## D6: Leave inherited Serena state untouched
- **Question:** How should the execution preflight handle inherited untracked .serena/?
- **Options:** Commit unrelated state; stash/delete it; exclude it from explicit commits and worker scopes.
- **Chose:** Preserve .serena/ unchanged; all implementers use isolated scoped worktrees and explicit staged paths.
- **Why:** It predates the iteration, as the previous notes and initial git status establish. Removing or committing it would modify user state.
- **Evidence:** .orca/loops/omp-until-done-154f6a6c/notes.md:14; initial git status --short --branch.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** The user explicitly assigns ownership of that directory.
- **Source:** assumed — autonomous

## D7: Apply normal two-spec workflow after the night-mode deadline
- **Question:** Does the one-spec night-mode override still apply?
- **Options:** Use its shortcut indefinitely; apply normal steps after its stated 04:00 deadline.
- **Chose:** Write logic.md and tech.md, combined spec review, one final review round and accepted-finding fix batch; scoped gates before canonical land.
- **Why:** Observed clock is 2026-10-28T10:16:20Z, after 04:00 local even in this macOS workspace. The deadline-qualified override has elapsed.
- **Evidence:** date -u output 2026-10-28T10:16:20Z; docs/loop/LOOP.md Night mode heading.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** Authoritative LOOP.md changes its deadline or override.
- **Source:** assumed — autonomous

## D8: Fix menu dismissal and sidebar loop presentation in three disjoint slices
- **Question:** Which local gaps should the parity sweep build now?
- **Options:** documentation-only inventory; rewrite feature engines; extend the existing surfaces and compact read API.
- **Chose:** automation menu Escape/Refresh dismissal; a compact loop summaries API/CLI; a shared worktree sidebar projection with loop glyph, priority and JSON state.
- **Why:** The recorded visible menu failure and current Tree/status inputs establish real gaps. Existing loop list loads iteration histories and queues, which a small indicator must not retain.
- **Evidence:** docs/loop/BLOCKERS.md:391-394; plugins/quirky.automations/src/list/AutomationsPage.tsx:1055-1075,1120-1158; plugins/quirky.worktree/src/Tree.tsx:49-70; plugins/quirky.loops/src/store.ts:273-283; scout matrices.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** focused consumer regressions establish that a public seam cannot carry the behavior.
- **Source:** assumed — autonomous

## D9: Retain larger newly discovered flows in one completion item
- **Question:** How should the sweep handle omitted provenance/mobile/remote-ledger flows?
- **Options:** silently exclude them using old M5 non-goals; add empty scaffolds; queue explicit complete vertical flows.
- **Chose:** one m7-sweep-automation-completion follow-up owns durable automation workspace provenance/badge/Open automation/Open run/deleted-record states/Hide automation-created, actual mobile loop-label composition after sb-mobile-app, and remote-host ledger routing/import/evidence after public host APIs.
- **Why:** Worktree has generic createdBy only; dispatch passes api without automation identity; sidebar filters have no generated-workspace rule. Ledger resolves local catalogs and local filesystem paths, with no remote host contract. Mobile client remains on another in-progress item and is absent on this landed baseline. These need cross-cutting contracts, not labels pretending to work.
- **Evidence:** packages/protocol/src/model.ts:5-97; plugins/quirky.automations/dispatch.ts:787-800; plugins/quirky.worktree/src/Tree.tsx:49-75; plugins/quirky.sidebar-extras/src/daemon/state.ts; plugins/quirky.ledger/src/daemon/owners.ts; canonical sb-mobile-app queue record.
- **Reversibility:** medium
- **Confidence:** high for source omissions; remote prerequisite design remains open.
- **Revisit if:** another lane lands a complete owner before this item's final catch-up.
- **Source:** deferred: automation workspace provenance, mobile loop projection and remote ledger ownership

## D10: Model attachment as presentation evidence, not a new durable loop state
- **Question:** How can the sidebar show detached/unverifiable without inventing loop runtime states?
- **Options:** add persisted detached state; infer attachment from session existence; inspect the public hosted layout.
- **Chose:** summaries return durable running/needs-you/paused state. Shared sidebar checks each distinct worktree's public terminal workspace once per refresh without ensure; exact loop hosted-view identity proves attachment, successful absence proves detached, failed/malformed reads are unknown/unverifiable. Needs-you outranks uncertainty; across candidates use documented priority then updatedAt and stable id.
- **Why:** Structured sessions intentionally exist without terminal adoption. LoopSnapshot has no detached field; the existing loop UI already validates hosted viewId/key/input/close ownership. A failed read cannot prove detachment.
- **Evidence:** plugins/quirky.loops/src/ui.tsx:83-119; plugins/quirky.loops/src/types.ts:83-112; plugins/quirky.terminal/src/layout/service.ts:508-515; fork-loops.md Where to find it.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** a public read-only targeted attachment API replaces workspace inspection.
- **Source:** assumed — autonomous

## D11: Preserve current native owners and distinguish historical blockers
- **Question:** Does historical blocker prose negate canonical done status, and can source tests prove native presentation?
- **Options:** treat every blocker entry as current; use canonical status and preserve separate native evidence.
- **Chose:** m5-ledger and all M5 dependencies are done as canonical queue says. Historical blocker entries remain immutable history. Native loop banners/focus and Automations View-menu toggle remain pending in their existing native scenario files; this web sweep neither duplicates nor marks them passed.
- **Why:** Ledger scout initially misread a historical block and corrected it against canonical queue. UI source/policy tests cannot establish system-banner appearance or native focus.
- **Evidence:** docs/loop/queue.json m5-ledger status done; docs/loop/native/m5-loops-core.json; docs/loop/native/m5-automations-ui.json; notifications/test/loops.test.ts.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** the nightly native runner records actual results.
- **Source:** assumed — autonomous

## D12: Stage regression tests before production with parent-owned execution
- **Question:** How should SDD preserve red/green proof while implementers skip midflight checks?
- **Options:** let workers compete running suites; write production before proof; stage tests then run them centrally.
- **Chose:** three isolated test-writing tasks, each with exact file ownership, no checks/commits; parent runs red proof, then three disjoint implementation tasks use the committed technical contracts. Parent audits scope/HEAD and runs focused checks after all workers return. Width3, no implementation successor wave or checkpoint review.
- **Why:** Developer tool policy requires all workers to skip midflight checks; staged tests still prove the consumer failure before source changes. Provider, sidebar and menu components have disjoint files.
- **Evidence:** tech.md Testing strategy and contracts; process preflight pi-watch --check; no configured language servers.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** a scope overlap or true semantic prerequisite appears.
- **Source:** assumed — autonomous

## D13: Accept specification finding F1 and make stale evidence override cached urgency
- **Question:** Does a cached needs-you loop remain needs-you after a failed summary read?
- **Options:** preserve urgency despite stale evidence; label all stale summaries unverifiable.
- **Chose:** stale/disconnected summaries override every cached state to unverifiable. Fresh needs-you outranks only unknown attachment evidence.
- **Why:** The two spec paragraphs genuinely diverged. A stale needs-you label is not fresh proof that the agent still needs input. The amended logic and technical contract now distinguish summary freshness from attachment uncertainty.
- **Evidence:** scratch spec/gate.json F1 MEDIUM/HIGH; Codex promote and fresh-context refute both upheld it; no suppressed/advisory findings. Mechanical prose prepass could not run checks on the git-range profile; it is not a test pass. Review alias codex/OpenAI, standard depth, reduced independence as required by LOOP's spec reviewer choice.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** a consumer regression proves stale labels must preserve an explicit stronger interaction state.
- **Source:** assumed — autonomous

## D14: Document nullable summary scalars without extending the kernel schema language
- **Question:** How can required nullable cap/reason fields fit the supported manifest schema subset?
- **Options:** add union/nullable syntax to the kernel; description-only schemas for the two scalar-or-null fields.
- **Chose:** strict item object/required fields and supported types elsewhere; pauseReason/maxIterations description-only schemas explicitly document scalar-or-null, with typed store construction and validated sidebar consumption.
- **Why:** Schema.type accepts only one string; anyOf/type arrays/nullable are rejected. Broad schema growth is unnecessary for a read-only projection and risks unrelated plugin admission.
- **Evidence:** packages/protocol/src/schema.ts:1-15,47-74; tech.md Data models/schemas.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** the public schema dialect gains native nullable scalars.
- **Source:** assumed — autonomous

## D15: Correct test readiness and process custody without weakening behavior
- **Question:** What did centrally executed staged regressions prove?
- **Options:** accept worker claims; rerun until pass; trace and repair each concrete fixture defect.
- **Chose:** preserve the four observed menu failures and compact summary assertions. Menu red7tests3pass4fail became green7pass0fail59assertions after the bounded source fix. Summary fixture now waits for actual send, and its new outer watchdog covers its unchanged inner deadlines. The remaining running-loop assertion exposed a test's global onStop releasing the wrong session's held turn; repair ownership, not expected state.
- **Why:** Initial running publication precedes prompt delivery. Separate capped loops legitimately stop their own fresh sessions, which must not release another held provider turn. Missing method/CLI red was independently observed after readiness repair.
- **Evidence:** parent bg3/bg4 readiness/framework failures; bg7 actual unknown-method red; bg6 menu remains-open failures; bg9 menu7/0; bg11 summary2pass1fail with actual running row paused/agent-blocked after fixture release; bg12 repaired lifecycle1pass0fail30assertions.
- **Reversibility:** easy
- **Confidence:** high for observed boundaries; final owning summary rerun remains pending.
- **Revisit if:** session-scoped fixture release still changes the running loop before its explicit stop.
- **Source:** assumed — autonomous

## D16: Wait for the loaded catalog and use an existing focus sentinel in integration
- **Question:** Why did the new sidebar regressions fail after implementation?
- **Options:** relax the stale-response/focus expectations; correct the producer and fixture boundaries.
- **Chose:** sidebar hydration begins only after useTree's initial catalog load, including a legitimate empty catalog, avoiding a second early summary read that bypassed a held stale response. The API fixture creates an inert existing settings-view sentinel before recording active-tab baseline; adding the first tab to an empty group is not treated as a focus regression.
- **Why:** Rendered green initially4/5 exposed an actual extra initial refresh. The integration fixture failed before loop-report assertions because an empty group's first hosted tab necessarily becomes active. Neither justifies changing session adoption or weakening the tested focus invariant.
- **Evidence:** bg14 original missing-projection red5/5; bg15 activeTab null/tab-2 fixture witness; bg17 stale-initial loading/available mismatch; bg18 corrected rendered5pass0fail57assertions. Worker scope/HEAD audit showed only six assigned Worktree source paths and two tests.
- **Reversibility:** easy
- **Confidence:** high for traced boundaries; integrated API receipt remains required.
- **Revisit if:** loaded-catalog gating misses reconnect or later catalog changes.
- **Source:** assumed — autonomous

## D17: Compose the provider before the sidebar's real API acceptance
- **Question:** How should disjoint source components exercise a true runtime API dependency?
- **Options:** fake the summary response in the daemon test; merge the accepted provider into the sidebar test worktree.
- **Chose:** keep source scopes disjoint and rendered red/green independent; after all workers return, parent commits accepted provider, merges that branch into the sidebar worktree, then runs its real daemon/window acceptance before committing the sidebar component.
- **Why:** The sidebar's real window must call the actual summary method. A test-only mock would not prove integration. Source implementation needs only the already-committed contract; the provider dependency is a runtime acceptance prerequisite.
- **Evidence:** run-journal.json component scopes; loop-status-api.test.ts public create/hosted view/stop path; all worker HEADs ccc62ee6 at wave barrier.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** scopes overlap or provider composition changes existing methods.
- **Source:** assumed — autonomous

## Progress
All implementation/test workers returned and full wave scope/HEAD audit passed; no cross-component source writes or worker commits. Menu accepted component066bc6c4, green7/0/59. Compact provider final whole-file gate running bg19 after lifecycle1/0/30 and separate params/CLI passes; next commit provider and merge it into sidebar worktree for actual API acceptance. Sidebar rendered gate is5/0/57 after catalog-ready repair, API fixture sentinel corrected. Root still has parent-owned spec/decision clarifications only; no source merge/catch-up/build/web service yet. Next: finish integrated API check, commit/merge three components, catch up roadmap/read incoming decisions, required affected/scripts/types/build, built visible smoke, three-lens deep Gemini final round plus one fix batch, staged single completion follow-up, canonical land.
