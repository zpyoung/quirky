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

## Progress
Claimed and branched; source and binding GitHub dependency decisions read. Read-only map pending. Next: finalize complete logic acceptance matrix and shared contracts, commit, then dispatch three disjoint implementation components.
