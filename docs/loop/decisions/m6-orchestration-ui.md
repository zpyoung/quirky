# m6-orchestration-ui decisions

## D1: Build the complete skill and local orchestration UI slice
- **Question:** brainstorming purpose, consumers, primary flow, success, scope and constraints
- **Options:** settings only; terminal UI only; complete queue title
- **Chose:** skill installation/update/retry/copy/recheck and detected-agent coverage; five usage examples and generated agent instructions; persisted nested depth; task-ID terminal navigation; nested worker rows and user takeover reporting.
- **Why:** users need setup/discovery and honest runtime visibility; each is expressly named in the item. Coordination remains agent-driven CLI/API, not a new task-board product.
- **Evidence:** orchestration.md sections1–3,10,UI; queue wait --lane2 m6-orchestration-ui; docs/roadmap.md:43–53,216–228
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** queue scope changes
- **Source:** locked by docs/loop/queue.json

## D2: Apply unattended night mode with one combined spec
- **Question:** brainstorming research, gray areas, approval and execution process
- **Options:** wait for human approval; elect documented defaults autonomously
- **Chose:** Visual/CLI/API/Integration domains; resolve layout/density, empty/loading/error states, interaction, install conflicts/idempotency, output, settings authority and data mapping. No visual companion, adhd, external research swarm or human asks. Write one logic.md with final technical section and self-review; commit contracts before at most three implementers.
- **Why:** authoritative LOOP night mode is active at00:43 CDT and explicitly replaces these interactive gates.
- **Evidence:** git show build/roadmap:docs/loop/LOOP.md Night mode, Answering a skill's questions
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** loop workflow changes
- **Source:** locked by docs/loop/LOOP.md

## D3: Extend existing plugin and renderer conventions
- **Question:** architecture alternatives, layout, density and integration ownership
- **Options:** extend built-in orchestration/settings/terminal/sidebar public seams; build standalone dashboard; duplicate worker runtime state in UI
- **Chose:** existing settings shell and plugin-owned orchestration pane; existing skill install engine; public runtime projections and terminal focus commands; compact nested worker rows. Renderer never decides settlement or destructive cleanup.
- **Why:** locked plugin architecture and daemon-owned focus prohibit a second authority model. Existing workers already own exact input-origin custody and meaningful titles; reuse them.
- **Evidence:** docs/architecture.md:312–324; orchestration.md UI; m6-orchestration-workers D5,D18,D23,D25
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** existing public seams cannot express the feature
- **Source:** assumed — autonomous

## D4: Keep depth policy separate from ordinary worker-writable settings
- **Question:** persisted depth normalization, authorization, paired clients and scriptability
- **Options:** ordinary mutable setting; separate explicit operator policy API using the single enforced core getter; unscriptable renderer-local value
- **Chose:** default1, integer minimum1; invalid persisted values normalize to1. Explicit operator policy changes persist and affect both admission and preamble through the same core getter. Ordinary settings writes and authenticated worker/session callers cannot raise the cap. Paired clients do not show the control. Provide an operator CLI/API rather than renderer-only state.
- **Why:** source excludes the key from worker settings RPC while the locked roadmap requires scripting parity. Full-trust shared-token agents are not sandboxed: do not claim protection against a malicious actor impersonating a separate operator connection.
- **Evidence:** orchestration.md section2 and nesting depth; docs/roadmap.md:31–41; m6-orchestration-workers D18 explicitly allows this item's authorized persisted policy; packages/daemon/src/plugins/dispatch.ts:230–244
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** the kernel provides stronger desktop provenance or access-control architecture changes
- **Source:** assumed — autonomous

## D5: Preserve uncertainty, identity and terminal ownership
- **Question:** missing dispatch, stale labels, nested lineage and takeover races
- **Options:** infer worker identity from title; use exact current dispatch/session provenance
- **Chose:** task links resolve latest dispatch and exact local session, report missing/unsupported destination honestly without launching terminals. Rows prefer displayName then taskTitle only for current assignment, flatten deeper nesting at one visible indent, preserve all workers when coordinator absent. Human typing uses existing input-origin custody path; no programmatic writes report takeover.
- **Why:** task titles and old IDs cannot confer live assignment or release authority. Background structured workers do not become visible chat terminals.
- **Evidence:** orchestration.md sections10,UI,Stop release and retry boundaries; docs/architecture.md structured sessions; m6-orchestration-workers AC14
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** public remote navigation capability lands
- **Source:** locked by research/orca-features/orchestration.md

## D6: Use OpenAI implementers and reachable Gemini review
- **Question:** SDD immutable backend pairing, environment and scope isolation
- **Options:** omp tasks plus Opus; omp tasks plus verified cross-family fallback
- **Chose:** IMPLEMENTER=omp-task, AUTHOR_FAMILY=openai, REVIEWER_ALIAS=gemini; maximum three disjoint implementation worktrees. Preserve unrelated untracked metadata; clean feature dispatch trees only. No language servers are configured; use existing semantic tools where available.
- **Why:** pi-watch check found no authenticated Opus/Sonnet model; Gemini resolves google/gemini-3.1-pro-preview:high. Codex and Terra are same-family alternatives, not preferred reviewers.
- **Evidence:** iteration5 pi-watch --check from/tmp; xd://lsp status returned no language servers configured
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** actual Gemini review fails
- **Source:** assumed — autonomous

## D7: Verify macOS with private homes and no real agent configuration writes
- **Question:** platform scope, installer smoke and UI verification safety
- **Options:** test real home installs; private HOME/QUIRKY_HOME and agent fixtures
- **Chose:** every process test/smoke uses temporary homes and cleans owned processes. Installation writes only private detected-agent targets. Run affected suite, scripts/typecheck and one real web dogfood campaign; native-only clipboard/window behavior is handed off if added. Linux/Windows installation/path/modifier/input verification is deferred platform work.
- **Why:** locked macOS scope and test isolation; source's install flow was not exercised, so Quirky must actually verify it rather than copy its claim.
- **Evidence:** LOOP Hard rules and Verify; orchestration.md Verified in the app; docs/roadmap.md platform policy
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** another platform is authorized
- **Source:** deferred: platform

## D8: Resolve navigation in one public daemon operation, including context-only Dispatches
- **Question:** implementation review found renderer navigation required a supervised Worker although the source makes every assigned Task navigable
- **Options:** leave context-only work unnavigable; duplicate process/custody proof in each renderer; one read-only taskTerminal method
- **Chose:** taskTerminal({taskId}) returns exact task/dispatch/session/worktree IDs using the latest dispatch, public targetIdentity and same-store assignment/resource evidence. Both links and sidebar consume it; CLI exposes task-terminal. Structured, replaced/reused/released or absent terminals refuse honestly. Context-only live assignments do not require Worker rows.
- **Why:** source coverage includes low-level assigned tasks, and the daemon already owns exact authority/custody. Renderer copies create inconsistent checks and cannot inspect context-only incarnation proof.
- **Evidence:** orchestration.md section10; src/runs.ts dispatchShow; src/navigation.ts and test/navigation-acceptance.test.ts
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** federation provides an actual remote navigation destination
- **Source:** locked by research/orca-features/orchestration.md

## D9: Separate current-assignment confidence from worker liveness
- **Question:** stable task labels could survive into a replacement process when only resource owner IDs were checked
- **Options:** trust old labels; hide all unverifiable workers; project exact assignment confidence independently
- **Chose:** required fleet currentAssignment boolean derives exact observation and resource/session/incarnation consistency. False confidence keeps inspectable uncertainty but uses actual session title/agent or explicit unverified label, never the obsolete task title. Stale-but-exact identity retains task label with stale activity.
- **Why:** source restricts task display labels to the same live assignment and says absence is never proof. Hiding uncertainty is as misleading as calling it dead.
- **Evidence:** orchestration.md UI and safe-failure rule; src/worker-contracts.ts currentAssignment, workers/fleet.ts and worktree OrchestrationRows.tsx
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** provider-neutral prompt lineage gives stronger exact assignment evidence
- **Source:** assumed — autonomous

## D10: Repair observed fixture boundaries without weakening product assertions
- **Question:** focused and affected gates exposed incomplete test contexts, wrong fixture precedence, shared skill targets, DOM initialization order and an IPC publication race
- **Options:** suppress failures or loosen assertions; repair each producer/fixture boundary
- **Chose:** declare React UI dependencies; initialize the tested React DOM module after isolated DOM globals; wrap input changes in act; locate controls by accessible name; preserve fixture override precedence; isolate agent search to private executable directories; model a partial failure with an actual blocked target; publish worker fixture replies by same-directory atomic rename. Keep typed policy, navigation, custody and file-content assertions unchanged. Remove wording/schema-wiring tests rather than pin new incidental text.
- **Why:** the observed empty JSON came from opening the reply file before the writer populated it, not a production timeout. Shared Claude/Codex targets and login PATH differences made the original fixture assumptions invalid. Broader retries, deadline increases and production exception suppression would hide those causes.
- **Evidence:** focused gates74/15 then87/5; typecheck55 then6 diagnostics; affected remote suite177/183 with2macOS passes; corrected six-file suite6/6 without flaky retries; scripts68/0/568; final isolated setup UI14/0/89; worker acceptance-control.ts atomic publication
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** test fixtures change their explicit file/DOM/process contracts
- **Source:** assumed — autonomous

## D11: Preserve sidebar workspace layout and isolate actual UI proof
- **Question:** actual built web UI hid the workspace name when worker rows consumed the same nowrap flex row
- **Options:** accept screenshot clipping; put workers in an unrelated sidebar; let the existing card wrap its full-basis worker block
- **Chose:** flexWrap:wrap on the worktree card; keep its existing main-row controls and full-width nested worker block. Verify visually in the existing formal web campaign. Use a private profile with optional editor disabled through public plugin control, retaining the dependency's recorded default-profile editor activation limit.
- **Why:** worker rows belong below their workspace/coordinator and must not displace the workspace's name or badges. Neither fake DOM tests nor an editor-disabled proof certifies the whole default app profile.
- **Evidence:** formal run20261028T064737-a890 obs1.png and findingF1; packages/ui styles.css worktree display:flex; Tree.tsx; workers D29
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** worktree card layout or editor activation changes
- **Source:** assumed — autonomous

## D12: Keep catch-up and review provenance explicit
- **Question:** incoming roadmap changes and component audit exceptions must not silently widen this item's review claims
- **Options:** review unrelated incoming code as this item's work; freeze a feature-only baseline and record integration ownership
- **Chose:** sole catch-up fe99ed38, review baseline its roadmap parentf939c86c59b822506842e054ad35598f916a7a86. Read incoming editor-drop/presets/browser logs; no conflict, and structured/worker logs were unchanged. Scope the sidebar regression extension to window-tree/github-composer fixtures and the observed worker reply harness repair. A link fixer mistakenly wrote its two-line test repair in the parent: transfer that exact patch back into its assigned component, restore parent baseline, then commit/integrate the component only after the barrier. Archive generated Serena metadata before removing all three owned worktrees.
- **Why:** shared integration changes have their own owners; isolating their commits preserves review scope. The audit found and corrected a real cross-tree write rather than treating the worker report as evidence of isolation.
- **Evidence:** incoming-decision scout; source/component scope and HEAD checks; link test snapshotsE0B1/B391 and moved patch; metadata archives under private iteration directory
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** integration introduces a conflicting locked decision or another write-scope violation
- **Source:** assumed — autonomous

## D13: Accept the bounded three-lens review without overstating full-context coverage
- **Question:** final review findings, exclusions and protocol limits
- **Options:** report the machine verdict alone; preserve actual dispatch and coverage qualifications
- **Chose:** one deep final round, C/S/X promote processes concurrent and fresh refute processes concurrent, all actual Gemini3.1Pro high. All three gates PASS with zero findings/blockers/advisories/contests/suppressions; no fix batch or tiebreak required. Preserve raw prompts/responses, model traces, shared resolve/prepass and manifests. Scope is35 code/test paths; bun.lock26lines excluded by hygiene and author reasoning/documents withheld. S/X made no surrounding-file tool calls; C used read-only shell searches beyond the stated reproduction-only convention, so outside-diff consumer coverage is unverified rather than certified.
- **Why:** empty JSON arrays are actual successful review responses, not missing output. A machine PASS cannot establish coverage absent from its traces. The live prepass ran only the isolated setup UI check14/0/89; broader gates were staged as parent-observed facts, not fabricated reused checks.
- **Evidence:** private review round-result.json, C/S/X gate.json and manifest.json, evidence-report.json, controller-observations.md; frozen rangef939c86c..aeca4cc4
- **Reversibility:** easy
- **Confidence:** medium
- **Revisit if:** a demonstrated defect or wider context inspection contradicts a cleared claim
- **Source:** assumed — autonomous

## D14: Keep guarded dogfood limits separate from actual isolated-browser proof
- **Question:** the guarded campaign could not target quoted prompt-copy references, reload its browser chrome, or type into xterm's opacity-hidden input
- **Options:** claim a formal pass; change application behavior to satisfy driver quirks; retain the partial report and separately exercise the real surface with an owned browser
- **Chose:** retain formal run20261028T064737-a890/report.md unchanged: setup/workers partial, policy/task-link/takeover blocked, zero formal goal passes. Record the tool-specific STALE/NO_EFFECT/NOT_VISIBLE limits. Direct inspection found obs55 already says “Nested worker depth set to 2”; a fresh settings mount later displayed2, so the report's unverified persistence does not establish a broken Save operation. Separately use a uniquely owned Chrome profile and CDP endpoint: visibly confirm corrected main/worker layout, physical HUMAN_UI_5 echo and user-owned/retained custody, task-link hover and popover, navigation from the second worker back to the first existing tab with the tab count still3, persisted policy2, and real “Copied prompt” feedback.
- **Why:** this proves changed behavior without converting tool limitations into a fabricated guarded PASS. An initial shared managed tab worker failed; another convenience browser handle switched to a foreign private test target, so no further interaction or kill was issued against it. A fresh uniquely bound process eliminated that ambiguity.
- **Evidence:** formal report and obs1/55/63; actual screenshots omp-sshots-15b7a625635ddc97.webp,15b7a635945ddc98.webp,15b7a682bb1ddc9d.webp,15b7a692d15ddc9f.webp,15b7a6b8621ddca1.webp,15b7a6d61e1ddca3.webp; private CDP process28034/profileWGTSaT
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** the guarded driver gains reliable quoted-reference, browser-reload and terminal-input support
- **Source:** assumed — autonomous

## D15: Compose canonical service migrations and routing before retrying the land
- **Question:** the first canonical land rejected conflicts after new Heimdall, automation and browser-profile work landed
- **Options:** discard either feature; reorder existing store history; preserve both contracts and append our never-landed policy migration last
- **Chose:** required recovery merge63b8c9a5 after land failure578s. Read all three incoming decision logs. Preserve distinct kernel-plugin service coordination and exact worker authority; service identity does not authorize policySet. Compose store migrations core→worker→already-canonical service→new policy, preserve service registration/binding, use creatorDepth(caller) with one persisted-cap read, retain atomic fixture reply publication, and combine task-link handling with canonical browser URL/file routing and modifiers. Preserve both README sections.
- **Why:** an already-landed service migration occupies a historical store version; inserting policy before it would replay or skip the wrong SQL. Header/import conflicts are not permission to drop a feature or weaken worker/operator boundaries.
- **Evidence:** first land conflict output; incoming m5-automations-dispatch D31, m6-heimdall-core D6/D8 and sa-browser-profiles-settings D23; main.ts migration composition; setup-migration.test.ts real prior-store activation
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** a new canonical migration or authority change conflicts with this append-only composition
- **Source:** assumed — autonomous

## Verification before the first landing attempt
- Source snapshot: aeca4cc496328a6029c123510245941a6a836caa, unchanged by the later documentation/evidence updates.
- Affected runner:183 remote files initially177pass/6fail, plus2macOS files passed. The exact6 repaired files then passed6/6 without flaky retries; no all-green initial-run claim.
- `bun test scripts`:68pass,0fail,568assertions. Its deliberately failing nested verifier fixtures are part of that passing outer suite.
- Final `bun run typecheck`:exit0. Final `bun run build`:exit0,21pluginUI modules and28bundledplugins; missing macOS icon-source warnings remain explicit.
- Real smoke service exited0 after actual worker CLI completion and retained release: policy2, three Ready skill entries based on real private files, physical custodyuser_owned/retained/user_takeover, release state retained/processAction:none, same PTY alive after release. The service then cleaned its private daemon, PTY host, providers and temporary homes.
- Owned uniquely bound CDP tab was closed and Chrome service stopped; the guarded browser session was explicitly closed after its partial report. No browser kill or further input was sent to the unexpectedly foreign convenience target.
- Raw guarded report is `.quirk/using-apps-like-a-user/runs/20261028T064737-a890/report.md`; actual supplemental proof/receipts/screenshots are in `.quirk/build-loop/m6-orchestration-ui/`. Final review raw artifacts are preserved there as `final-review.tgz`.
- No native-only product scenario was added or claimed; no new native verification file is needed. D7 retains Linux/Windows verification as explicit platform work.

## Post-conflict integration verification
- `setup-migration.test.ts` seeds the actual prior canonical core/worker/service store, activates the new plugin through daemon API, proves Heimdall-owned Run/Task data preserved, default policy1, operator policy2 surviving restart, and corrupt depth normalized persistently to1. Removed the SQL-text mock. A duplicate test helper was corrected after typecheck reported it; no assertion was suppressed.
- Focused merged boundary checks:43pass,0fail,230assertions across6files. Final affected suite:202remote files and4macOS files, all passed without flaky retries. `bun test scripts`:68pass,0fail,572assertions.
- Post-merge `bun run typecheck` and packaged `bun run build` exited0;21pluginUI modules and29plugins. The same missing macOS icon-source warnings remain explicit.
- Fresh actual daemon/CLI smoke established exact taskTerminal target, operator policy2 and denial of an attested worker's attempt to raise it to3. A separately owned CDP process exercised the newly built worker row, real terminal typing, task hover/action and existing-tab destination; physical custody was visibly user-owned/retained.
- The actual provider CLI then reported completion; coordinator release returned retained/processAction:none and the same PTY remained alive. `integration-smoke-result.json` records passed:true. Private runtime service exited0 and cleaned daemon/PTy/providers/home; owned CDP tab and Chrome process were closed. Screenshots15b7af2e513274e6/15b7af6b2c7274e9/15b7af7d9b7274ea are preserved in the private evidence directory.
- This is post-merge runtime/build/test verification, not a second model-review round or a relabelled formal guarded campaign.

## Progress
Iteration5 is ready to retry canonical landing after merge63b8c9a5: canonical-store upgrade and all merged boundaries verified,202remote+4macOS files green, scripts68/0/572, post-merge typecheck/package build and actual retained-release UI/CLI smoke passed. All agents and owned verification services finished. No local feature flow is voluntarily deferred; guarded-driver and model-review coverage qualifications remain explicit. Next: commit regression/evidence updates, detach, invoke canonical queue.ts land m6-orchestration-ui and wait for the full-merge verdict. Do not claim landed until the queue confirms it.
