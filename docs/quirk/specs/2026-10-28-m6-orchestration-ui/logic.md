# Orchestration skill and UI

## Status & amendments
Status: Implemented; daemon/CLI acceptance and actual isolated-browser smoke verified. Formal guarded UI campaign remains partial/blocked due documented driver limits, not relabelled as passed; decision log D13–D14 records review and UI evidence boundaries. One combined specification with technical decisions replaces separate tech.md under LOOP night mode. The authoritative queue owns the landing verdict.

**Amendments:** 2026-10-28 — initial full queue-item specification.

2026-10-28 — source-coverage correction during integration: valid context-only Dispatches also have navigable assigned terminals. Add one shared daemon taskTerminal target proof instead of requiring a supervised Worker or duplicating custody logic in renderers. This expands AC6 to the source's “any task ID” behavior.
2026-10-30 — AC9 now requires the floating setup card to avoid the live draggable trigger and measured status-bar region, with reachable actions in constrained viewports.

## Purpose and conceptual model
People install the version-matched orchestration skill, choose a nesting policy, and inspect/focus supervised workers without becoming the scheduler. Agents coordinate through the existing durable Run/Task/Dispatch/mailbox CLI. The daemon owns policy, worker identity/custody and focus state; the renderer displays evidence and invokes declared methods/commands.

## Scope and non-goals
In scope: source sections Install the orchestration skill; Change how deep workers may nest; Ask an agent to coordinate; Click a task ID, take over a worker terminal; UI. Include settings setup/coverage/examples/generated skill, task terminal links and nested sidebar worker rows. Existing worker takeover must remain end-to-end correct.

Non-goals: new scheduler, DAG board or mailbox GUI; federation transport; automatic idle-pointer recovery; retired commands; phone app; visible structured-agent chat tabs; Explore feature-wall animation (the app has no such wall in this slice). Structured workers remain background agents; terminal destinations must not be fabricated for them. Floating setup affordance may reuse the existing terminal/workspace UI but must lead to the same settings/setup implementation, not a second installer.

## Data flow
Settings reads detected executable agents and compares installed orchestration skill content with the current version. Explicit Install/Update writes supported private targets atomically; Re-check reads actual files again. Copy command exposes a real declared CLI operation. Examples are copyable prompts invoking /orchestration. A separate persisted operator policy feeds the single core cap getter used by both dispatch admission and preamble. Fleet snapshots supply stable task labels, lineage, live evidence and custody. The sidebar joins exact session IDs and renders worker rows under coordinator/workspace; task links resolve the latest Dispatch then focus only its actual terminal. Physical typing continues through the exact-incarnation input-origin custody guard before bytes reach a worker.

## Key decisions & rationale
Recommended: extend the lazy orchestration plugin and existing Settings/terminal/worktree renderer patterns. A standalone dashboard adds a second UI model; renderer-local policy cannot enforce admission; both are rejected. Reuse current worker takeover rather than add another reporting RPC. Dedicated operator policy avoids exposing the cap through ordinary worker-writable settings. Shared-token full-trust clients are not a security sandbox; session/paired-caller refusals are honest policy guards.

## Decisions Locked
- **Layout/density:** Orchestration settings titled “Orchestration”, subtitle “Coordinate multiple coding agents through Quirky.” Skill panel, coverage footer, depth control, then five example cards. Existing theme/control conventions; compact nested rows, maximum one extra visual indent even for deeper workers.
- **Loading/empty:** visibly checking during status requests; no detected agents explains installing CLIs and rechecking. No workers adds no empty agent clutter. No dispatch/session yields visible navigation refusal, never a new unrelated terminal.
- **Errors/recovery:** Install failure shows error and Retry; stale content offers Update; Re-check rereads files; clipboard failure is visible. Unsupported skill targets are labelled explicitly, never Ready by executable detection alone. Partial install stays partial, preserving per-agent errors and retry.
- **Install/conflicts:** no automatic real-home writes; explicit install/update may replace the generated orchestration skill only, never unrelated skill directories. Current content comparison determines freshness. Command generation is version-matched to running plugin content, not a remote moving install script. Generic live-catalog quirky skill remains unchanged.
- **Depth:** minimum/default1; invalid noninteger/below1 persisted values normalize1. Dedicated explicit operator API is scriptable and rejects authenticated session/worker callers and paired clients; generic setting.set cannot change policy. Pane hides/refuses change where unavailable. Admission and preamble share one getter; creating another Run never resets depth. Policy does not retroactively kill active workers.
- **Links/identity:** match bounded task_ tokens (maximum128, no touching [A-Za-z0-9_-]); plain click offers “Open task terminal”, command-click opens directly on macOS (Ctrl elsewhere), tooltip explains both. Resolve latest Dispatch on activation, re-prove session/workspace exists, do not use title as identity. Unavailable remote destination returns honest capability error until public federation navigation exists.
- **Rows/custody:** prefer displayName then taskTitle only for the current exact assignment. Render under coordinator, preserve orphan workers in their actual workspace, flatten deeper lineage, avoid retry/reused-terminal duplicates and cycles. Stale live evidence cannot masquerade as current activity. Show user-owned/retained state; release remains daemon-authorized only.
- **Scriptability/platform:** every visible action uses declared API/CLI or daemon UI commands and reports observable state. macOS verification with private homes only; Linux/Windows path/modifier/input verification is deferred platform work, not a portability claim.

## Behavior, scenarios and acceptance criteria
Every scenario has daemon API/CLI acceptance; UI scenarios also get actual web dogfood. Each process-starting test uses fresh temporary QUIRKY_HOME/HOME and stops owned process trees.

### AC1 — Discover, install and recheck the skill
Before: private profile, detected supported agentsA/B, no skill. Open Settings→Orchestration: checking resolves Missing chips and actual install command. Invoke Install through UI/API/CLI. After: only intended orchestration skill files exist; status Ready for A/B based on exact current content; Re-check confirms. No agent executable means explanatory no-CLIs state, not false “all ready”. CLI works without an Experimental toggle.

### AC2 — Update, partial failure and retry
Before: A has previous generated content, B's target is unwritable/invalid. Status marks A stale and B error/missing. Update installs current A, reports B failure and exposes Retry without claiming all-ready. Restore B's valid target and retry. After: both actual files match generated content; unrelated sibling files remain unchanged. Concurrent install/recheck cannot present an older response as newer success.

### AC3 — Copy command and five usage examples
Before: settings visible. Open “Prefer your own terminal?” / Copy command dialog titled “Install orchestration skill”. Copy command gives visible success or failure; Done closes it. The command actually installs via declared orchestration CLI in private home. Show Hand off an active task, Hand off to another worktree, Run a phased workflow, Run independent work in parallel, Split a large change into smaller PRs. Each copy yields its real prompt including /orchestration, not a broken Orca executable reference.

### AC4 — Generated skill teaches the real protocol
Before: current plugin catalog. skillShow/generated installation yields valid name:orchestration metadata and supervised-work trigger. It distinguishes plain unsupervised handoff; teaches status/runtime check, run creation, independent fanout before waiting, task deps, resumable check/ack, ask/reply, exactly one worker_done, validation and explicit retain/release/reuse, three-empty-wait inventory, uncertainty-safe cleanup, retry and no reclaimable workers before coordinator ends. Commands use actual Quirky schemas, not retired scheduler or unsupported flags. Installed and shown bytes agree; generic quirky skill still lists declared commands dynamically.

### AC5 — Persist and enforce nested depth
Before: fresh policy1, coordinator depth0. Operator changes policy2; restart daemon and read2. A depth1 worker may now dispatch depth2, depth2 worker cannot create depth3, even after creating another Run. Preamble subdispatch instructions reflect same cap. Lowering policy changes future admission only. Fraction, NaN-like input,0/negative fail or normalize as appropriate (request invalid→refuse, invalid persisted→1). Ordinary setting.set and authenticated worker/session policySet refuse, including a spoofed UI role on a session-attested connection. Operator CLI/API works; paired UI does not expose mutable control.

Upgrade boundary: an existing canonical core/worker/service store gains the policy migration only after its already-applied service migrations. Existing Heimdall-owned Run/Task data and ownership remain unchanged; default1, persisted2 and corrupt-value normalization survive real plugin reopenings. Service coordinator identity is not operator policy authority.

### AC6 — Task-ID links focus exact latest worker
Before: terminal prints valid taskID amid punctuation, wrapped/wide text, plus invalid adjacent/overlong tokens. Only valid IDs link. Plain click opens actions; “Open task terminal” resolves latest Dispatch and selects actual terminal/workspace; modifier-click does so directly. Tooltip names ID and modifier. Retry resolves newest attempt rather than old tab. Missing/no dispatch, released/reused identity, structured-only or unavailable remote terminal explains refusal without focus corruption or terminal creation. API/CLI navigation equivalent produces same daemon focus.
Context-only Dispatch with a live exact assigned terminal also opens successfully. No Worker row is required. A later assignment of the same terminal invalidates the old task target even if that later assignment has settled; focusing an obsolete task must not silently show a newer task.

### AC7 — Nested sidebar workers and meaningful labels
Before: visible workspace coordinatorC, workersW1/W2 and nestedW3, including another-workspace child and orphan coordinator. Fleet projects stable title/displayName plus exact coordinator/creator sessions. Sidebar places workers under coordinator, deeper workers at one extra visual level; orphan workers remain inspectable in their actual workspace. Labels favor displayName/title while assignment matches; reused terminal never keeps old task title. New retry hides obsolete session duplicates; stale activity explicitly unknown/stale, not working. Click row focuses exact current terminal through public view/command route. Removing/releasing a worker removes its live row without hiding archived history APIs.

### AC8 — Physical takeover is visible and preserves terminal
Before: owned active worker terminal. Programmatic preamble/terminal query response leaves owned. Type physical input; exact custody becomes user_owned/retained/user_takeover and row reports it. Settle via authorized worker report, invoke release from coordinator CLI: retained/processAction:none, same tab/process still accepts visible input. Late old-incarnation takeover cannot mark replacement, and no second renderer takeover mechanism bypasses existing guard.

### AC9 — Setup affordance and lifecycle cleanup
Before: uninstalled skill in floating workspace. Setup affordance opens the same setup content; Dismiss persists; actual installed detection suppresses it rather than mere Install click. The card stays clear of the live draggable toggle and measured status-bar region, within viewport bounds after trigger movement or resize; in short viewports, constrain it to the largest safe space and keep Enable and Dismiss reachable by scrolling. Disabling orchestration removes its UI contributions/subscriptions, leaves generic worktree/terminal UI usable, and no polling/timers/processes leak. Re-enable rechecks actual skill/policy/fleet and does not use stale success. Read-only paired windows never offer mutable depth. Native-only OS clipboard/window integration is recorded pending if web cannot verify it.

The compact setup card places Dismiss and Enable below its description. Both buttons remain fully inside the card at desktop and narrow viewport widths.

## Recorded Orca defects / negative acceptance
- Source stale “Settings→Experimental required” documentation is not copied: AC1/4 use orchestration with no toggle.
- Worker opaque terminal name observed in source is not reused as meaningful primary label: AC7 preserves actual task title (worker dependency already fixed creation title).
- Source unverified attention badges/mobile/federation host internals are not claimed as proof. AC6 refuses unavailable remote navigation, and AC7 uses actual attention data only.
- Skill Install/Update/Copy/Recheck was unexercised in source: AC1–3 require real isolated writes and visible outcomes, not text/snapshot-only assurance.

## Industry Insights
No external research swarm under authoritative night mode. Grounding: canonical orchestration.md, roadmap/architecture locked rules, existing generic skill generation/settings/worker input-origin patterns, workers D18 and exact custody contracts. No external validation claim.

## Deferred Ideas
Federation and phone UI are other queue items, not implemented or mocked here. No voluntarily deferred in-scope local flow. Platform verification is deferred in decisionD7. Any later unreachable flow needs a decision and the single dependent follow-up before landing.

## Glossary
- Skill coverage: detected CLI plus an inspected current orchestration skill target, not mere executable presence.
- Operator policy: persisted cap distinct from worker-editable ordinary settings.
- Assignment: exact current Dispatch/session identity, not Task name.
- Custody: owned/user_owned/transferred/released state independent of Task outcome.
- Snapshot: bounded fleet result, not ongoing live truth.

## Technical specification

### Architecture and code references
Reuse plugins/quirky.orchestration/main.ts and src/core.ts; workers/fleet.ts and worker-contracts.ts; current same-store migrations; declared schema-generated CLI. Plugin owns new src/ui-contracts.ts (shared immutable contracts), src/setup.ts (policy/skill methods), src/skill.ts (version-matched instructions/target inspection), src/ui.tsx and src/window/OrchestrationSettings.tsx. Main registers real setup methods and UI manifest declares rich settings section; no generic mutable depth setting.

Terminal task providers live alongside plugins/quirky.terminal/src/window/pane/link-provider.ts, links.ts and TerminalPaneView.tsx; reuse readLogicalLine cell mapping and existing selection/modifier policy. Public taskTerminal({taskId}) returns {taskId,dispatchId,sessionId,worktreeId} after latest-assignment/incarnation/custody proof; renderer invokes the existing daemon-owned terminal view route. The same endpoint serves sidebar rows and CLI for supervised and context-only Dispatches. Avoid private cross-plugin imports.

Worktree sidebar rows live in plugins/quirky.worktree/src/Tree.tsx with a focused OrchestrationRows component/hook using public workerList pagination and public session/run data. Extend makeFleetRow in orchestration workers/fleet.ts; public WorkerFleetRow now includes taskTitle,displayName,coordinatorSessionId,parentSessionId. Main manifest/schema owner integrates these fields. No lifecycle/input-origin rewrite.

### Contracts and schemas
Shared setup types in src/ui-contracts.ts: OrchestrationSkillStatus contains state missing/stale/ready/partial/error, agents with id,label,state ready/missing/stale/unsupported/error,path/detail, installCommand and text. OrchestrationPolicy contains nestedWorkerMaxDepth:number and canChange:boolean. skillStatus and skillShow read current generated bytes/agent targets; skillInstall accepts optional explicit agent IDs and returns real status after writes. policyShow reads effective policy/caller eligibility; policySet accepts only nestedWorkerMaxDepth, validates integer>=1 and persists after caller guard; it never accepts authority in params.

WorkerFleetRow additive fields are required strings taskTitle/displayName, nullable coordinatorSessionId/parentSessionId, and currentAssignment:boolean; existing projection fields unchanged. Fleet implementation derives labels/lineage from stored Task/Run/Dispatch and assignment confidence from exact observation/resource/session/incarnation consistency, not titles or liveness. False confidence preserves an uncertain inspectable row with current session label or “Worker assignment unverified”, never the obsolete task label and never inferred exit. Stale-but-exact evidence keeps the task label and marks activity stale. All snapshots clone these fields. Existing callers/tests constructing rows must be migrated, never supplied fake production defaults.

### Task scopes and acceptance commands
One wave, three disjoint components; cap3 does not bind. No task needs another's implementation; shared types/spec committed first. Orchestrator owns final integration/docs, schema reconciliation and verification. No mid-flight build/lint/formatting; implementers write owned tests but parent runs verification after barrier.

Parent-owned serialized integration adds src/navigation.ts and test/navigation-acceptance.test.ts; T1 wires taskTerminal in main/manifest/CLI, while T2/T3 consume its committed return contract. Public targetIdentity and the same-store dispatch/resource records prove current assignment without exposing credentials. Acceptance: bun test plugins/quirky.orchestration/test/navigation-acceptance.test.ts. T1 additionally owns focused src/skill-targets.ts for primary-source native skill target mapping.

Failed-land recovery additionally owns test/setup-migration.test.ts for actual prior-store→new-plugin API activation, plus necessary consumer fixture repairs in worktree window-tree/github-composer and worker acceptance-control. Main composes core, worker, canonical service migrations, then policyMigration; never insert new policy SQL into an already-applied version. Acceptance: bun test plugins/quirky.orchestration/test/setup-migration.test.ts.

**T1 setup/policy/skill:** scope plugins/quirky.orchestration/{main.ts,cli.ts,quirky-plugin.json,src/core.ts,src/store.ts,src/setup.ts,src/skill.ts,src/ui.tsx,src/window/OrchestrationSettings.tsx,src/window/setup-state.ts,test/setup.test.ts,test/setup-ui.test.ts,test/setup-acceptance.test.ts}. May add focused setup helper files within src/window and test/setup-* only after telling orchestrator. Own all manifest wiring including shared fleet fields; UI build declaration follows existing dist/ui.js. Tests reuse existing fixture helpers/public daemon startup. Acceptance: bun test plugins/quirky.orchestration/test/setup.test.ts plugins/quirky.orchestration/test/setup-ui.test.ts plugins/quirky.orchestration/test/setup-acceptance.test.ts. Covers AC1–5/9 plus real CLI install/coverage/policy restart/worker denial/depth admission; generated skill review after creation.

**T2 task links:** scope plugins/quirky.terminal/src/window/pane/{TerminalPaneView.tsx,link-provider.ts,links.ts,task-links.ts}, plugins/quirky.terminal/test/window/{link-provider.test.ts,pane-links.test.ts,task-links.test.ts}. No terminal input-origin changes. Acceptance: bun test plugins/quirky.terminal/test/window/link-provider.test.ts plugins/quirky.terminal/test/window/pane-links.test.ts plugins/quirky.terminal/test/window/task-links.test.ts. AC6 token/cell/range/action/latest-dispatch/refusal; real daemon smoke and dogfood after integration.

**T3 sidebar/projection:** scope plugins/quirky.worktree/src/{Tree.tsx,OrchestrationRows.tsx,useOrchestrationRows.ts}, plugins/quirky.worktree/test/orchestration-rows.test.ts, plugins/quirky.orchestration/src/workers/fleet.ts, plugins/quirky.orchestration/test/workers/output-fleet.test.ts and output-fleet-support.ts. No manifest (T1 owns). Acceptance: bun test plugins/quirky.worktree/test/orchestration-rows.test.ts plugins/quirky.orchestration/test/workers/output-fleet.test.ts. AC7/8 current labels, nested/cross-workspace/orphan/retry/retained/stale state, bounded refresh/event cleanup. Existing public custody guard is unchanged, exercised in integration.

### DO-NOT-CHANGE fences
Protected loop/scripts/queue/index; other lanes' owned specs/decisions; core lifecycle/receipt/authority/CAS; worker custody origin guard; background-only structured model; generic live-catalog skill generator; real user home configurations. These preserve queue safety, exact process authority, public conventions and test isolation.

### Always / Ask / Never
Always use public cross-plugin API, exact session evidence, bounded paged fleet, disposable subscriptions and private homes. Autonomously resolve repo-provided ambiguity and record decisions. Never infer authority from role/title/params; never claim full-trust shared-token sandbox, remote routing, installed coverage or clipboard success without evidence; never stop/release on stale/missing evidence.

### Cross-cutting and verification
Policy storage defaults safely and survives restart; no retroactive stop on lower cap. Skill operations atomically replace only explicitly selected known skill files and report partial errors. UI stale async requests cannot overwrite later state. Disable removes all listeners/timers. Run affected remote suite for orchestration, worktree, terminal and consumer directories, bun test scripts, bun run typecheck, bun run build; one final Gemini review and blocking fix batch. UI dogfood on private daemon URL via using-apps-like-a-user --surface web --owner yours --unattended. Stop daemon/browser/owned providers and delete private temporary homes after proof; native-only scenarios use pending handoff, never false visual PASS.

Self-review: AC1–9 cover every named local source flow and negative defect. Every action has API/CLI equivalent. Stable types, manifest ownership and disjoint scopes prevent concurrent hub edits. No placeholder implementation, separate orchestration database, duplicated takeover path or unsupported remote success is permitted.
