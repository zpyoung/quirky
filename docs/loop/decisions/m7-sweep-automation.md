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

## Progress
Claimed lane1 approximately2026-10-28T10:14Z; branch build/m7-sweep-automation. Full feature docs and binding architecture/roadmap read, three code scouts plus targeted projection-seam survey completed. Specs committed e8e24dec; combined Codex promote/refute review running via /tmp/quirky-automation-sweep.LlsERn/review.py (bg_2). Next: adjudicate spec findings, commit amendments/contracts, stage isolated regressions, centrally prove red then implement three disjoint slices. Inherited .serena/ untouched. No daemon or implementation started. Scratch is /tmp/quirky-automation-sweep.LlsERn; web doctor ready; lsp has no configured servers.
