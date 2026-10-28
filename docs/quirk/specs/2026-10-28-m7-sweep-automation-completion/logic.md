# Automation completion: provenance and phone loop summaries

## Status & amendments
Status: approved autonomously under unattended LOOP; single combined logic/technical specification. 2026-10-28 initial specification. Self-review: every inherited missing-flow group has either acceptance scenarios below or the single remote-ledger prerequisite deferral. No human gate or external research swarm.

## Purpose and scope
Make automation-created workspaces identifiable after automation history disappears, navigate from the desktop sidebar to the exact definition/run, persist the hide preference, and compose compact daemon loop summaries into the landed Expo client's workspace list. Consumers: people in the desktop sidebar and phone, and public API/CLI clients inspecting the same state.

The core ships independently of unavailable SSH ledger routing. Existing remote automation execution and UI owners remain unchanged. No new triggers, raw agent arguments, background terminals, native-chat replacement, Objective runner, PR sitter, GitLab/Bitbucket/Gitea/Azure support, or native notification work.

## Conceptual model and data flow
Creation provenance belongs to the workspace's filesystem instance, not its name, branch, generic API creator, or the current automation list. Only a live new-per-run dispatch may authorize it. IDs and name/title snapshots are committed with workspace creation before setup or agent launch. Renaming/deleting the automation or pruning history never removes this attribution. Ordinary API/CLI workspaces and existing-workspace runs remain unattributed. Recreating a removed path is a new instance, not inherited provenance.

Sidebar badges read durable provenance; availability checks are separate transient evidence. A deleted definition, missing run history, loading request, failed check and available target are distinct. Navigation uses exact stored IDs, never display names or the latest run. Filtering uses attribution, not an `auto-` name heuristic. Phone loop labels use only the existing read-only compact summaries, never full loop history or terminal inference.

## Key decisions & rationale
Recommended: extend existing workspace metadata, existing sidebar preference/report mechanisms, existing automation navigation, and the actual phone bridge and allowlist. Rejected: a second attribution store (breaks workspace-instance lifecycle); infer creator from name/createdBy (false positives and lost history); full loop snapshots on phones (unnecessary prompt/output exposure); fabricated host generations or local SSH path reads (unsafe authority).

## Decisions Locked
- Visual/layout: retain existing card and workspace-row layouts; add a Created by automation badge and a compact Automation detail section; labels and navigation are accessible.
- Visual/density: show recorded automation name/run title, not prompt/output; display phone loop count/cap/state/reason in compact and detailed rows.
- Loading/errors: show Checking automation availability... while reading; Automation no longer available. only on confirmed missing definition; Run history no longer available. only on missing run; Automation availability could not be checked. for read failures. Disabled/missing plugins are unavailable, never proof of deletion. Stale in-flight responses cannot replace newer selection/record state.
- Interaction: explicit Open automation/Open run actions route through public API to the existing page. No workspace activation or session adoption as a side effect of attribution reads.
- Data: persist IDs, immutable creation name/title snapshots, project ID and currently supported local host identity. Never persist dispatch capabilities in worktree metadata. Old workspaces default to no provenance; no heuristic historical backfill.
- API/auth: single-use opaque dispatch capability bound to automation/run/repository and live dispatching state; claimed through a public method before filesystem side effects. Arbitrary caller-supplied snapshots are never trusted. Malformed, stale, replayed or cross-repository requests fail before creation. Existing creator enum retains its surface meaning.
- Persistence: Hide automation-created is off by default; saved per current desktop preference scope and phone workspace preference scope, survives remount/restart. Automation-generated primary rows follow the existing except-default-branch preference precedence.
- Phone integration: compact summaries are read-only and admitted in both native page bridge policy and daemon mobile policy. No loops mutation/list/get/history access is added. Disconnect or failed summary refresh invalidates cached labels to unverifiable; reconnect/empty successful reads replace them. Unknown/disabled loop plugin does not block ordinary workspace loading.
- Priority: phone summaries choose needs-you, then running, then paused; deterministic newest updatedAt then stable ID. Use completed iteration counts, optional maxIterations, and human cap reason labels. No terminal-layout reads are needed on the phone; attachment is not asserted.
- Constraints/platform: retain structured-only background execution/public plugin boundaries and all explicit user exclusions. macOS build only; physical phone/native rendering is not claimed by host typecheck.

## Behavior & acceptance scenarios
### A1: Durable authenticated creation
Before: a local new-per-run automation Audit and run `r1` titled Audit run 1. Trigger through daemon API. After: the created workspace carries automation/run IDs, name/title snapshots, project/local host and createdBy api. Restart its store and rename/delete definition/history: snapshots remain. Existing-workspace runs and an ordinary API-created workspace receive no provenance. A fresh workspace at a removed path has no old provenance. Malformed/replayed/cross-repo capabilities create no workspace. Setup failure after durable creation leaves attribution visible.

### A2: Sidebar attribution and exact navigation
Before: workspace from A1, alongside ordinary API workspace. Only the attributed row shows Created by automation. Expanding its Automation details shows snapshots and loading/available states. Open automation routes to Audit; Open run routes to r1 even when newer runs exist. Definition deletion disables definition navigation and states Automation no longer available.; separately pruned run history disables run navigation with Run history no longer available. Failed reads say availability could not be checked, not deleted. Plugin disable and delayed reads cannot navigate to stale targets. Public JSON exposes the provenance and navigation/availability state rather than a hidden-only UI action.

### A3: Persisted filtering
Before: attributed and ordinary API/CLI/manual workspaces are visible. Enable Hide automation-created using sidebar public view/preferences API or its visible checkbox. After: only attributed workspaces are filtered; saved reload preserves the choice; disabling restores them. Existing pinned/search/default-branch semantics remain consistent with other filters. Phone workspace options enable the formerly unavailable automation filter using the same metadata, persist it and count it as active. No prefix or createdBy-api guess is allowed.

### A4: Actual phone loop labels
Before: real Expo workspace page bridge receives two unfinished loops for workspace A and a paused capped loop for B via quirky.loops/summaries. A shows needs-you according to priority; B shows Loop 2/2 · paused: iteration cap reached. Uncapped running loops show Loop 3 · running. Labels appear in compact and detailed modes and sanitized reports. Ending/removing loops clears labels after refresh; disconnect/failure marks cached summaries unverifiable and successful reconnect restores them. No full history/prompt/cwd/output reads and no loop mutations are allowed. The summary method remains read-only through strict parameter validation and daemon mobile admission.

### A5: Preserve defect boundaries
Write consumer regressions for forged attribution, stale availability, deleted versus unavailable history, filter false positives and stale phone loop summaries. Existing timezone/DST/invalid-schedule isolation, loop background focus/cost custody, and ledger scroll/eager reconciliation regressions remain unchanged; no re-pin of incidental wording tests.

## Deferred Ideas
SSH-host ledger ownership/routing/import/evidence and selected-runtime availability require public host registration/incarnation lookup, remote repo/workspace identity and generation-fenced filesystem/execution. Current Repo/Worktree paths and ledger filesystem operations are local; `base.host` is only metadata. One follow-up will retain this entire unbuilt flow; it must block if claimed without the prerequisite. No remote automation owner is duplicated and no remote path is dereferenced locally.

## Industry Insights
Research sources are automations.md entry points/workspace provenance/deletion, fork-loops.md mobile labels, ledger.md SSH/import/evidence, roadmap parity/plugin boundaries and earlier decision logs. Read-only source mapping reconciled sb-mobile-app as landed, panels/prerequisites as concurrent, and remote automation dispatch as blocked. No external research campaign or unobserved runtime claim.

## Glossary
Provenance: durable creator identity and immutable display snapshots. Capability: opaque single-use authorization for one live dispatch creation. Availability: current read evidence, not attribution. Summary: prompt/output-free projection of unfinished loops.

## Technical decisions and shared contracts
- Public protocol exports WorktreeAutomationProvenance `{kind:'created-by-automation',automationId,automationName,runId,runTitle,projectId,hostId:'local'}` and WorktreeAutomationProvenanceRequest `{automationId,runId,dispatchToken}`. Worktree has optional nullable automationProvenance, matching existing optional metadata evolution.
- quirky.worktree/create accepts automationProvenanceRequest. The daemon validates it through quirky.automations/claimWorkspaceProvenance with the request fields plus resolved repoId. The method returns WorktreeAutomationProvenance and consumes the capability; it verifies current dispatching run, no assigned workspace, matching definition and captured repo. Dispatch issues capability immediately around creation, revokes on settlement/failure, and passes it only on new-per-run creation. Worktree persists validated snapshots in an append-only SQLite migration and returns them through existing list/show; folder/group unsupported combinations fail before side effects.
- Backend component owns plugins/quirky.automations daemon implementation/manifest/tests and plugins/quirky.worktree daemon creation/storage/tests/manifest. All caller changes stay together. Public schema objects must use the existing supported schema dialect, not nullable unions.
- Sidebar component owns worktree UI/report/card detail, existing sidebar-extras filter preferences/public JSON, and automation window navigation if existing methods need exact-ID handling. No backend persistence edits. Use existing public calls; no private cross-plugin imports.
- Mobile component owns apps/mobile workspace page/storage/bridge report+RPC policies/tests and quirky.mobile literal authorization schemas/tests. Consume only quirky.loops/summaries. Provenance filter consumes the committed public type. Keep bridge and daemon policy in agreement and preserve concurrent panel route grants at final integration.
- Contracts/spec are committed before <=3 disjoint implementers. Workers do not run tests/build/lint/typecheck/formatters or commit. Write acceptance tests before implementation, with process tests on fresh temporary QUIRKY_HOME and awaited cleanup. Parent owns the required final typecheck and narrowly scoped runtime evidence; no broad suite/review/dogfood campaign until m7-test-triage. UI tests are written but physical/native clearance remains unclaimed.
- Verification commands: bun run typecheck. Focused acceptance files will be recorded in the decision log; end phase executes their suites. Public API smoke uses a temporary daemon/home and always tears them down. Final catch-up merges build/roadmap once, reads newly landed decisions, preserves concurrent owners and lands only through authoritative queue.ts.
