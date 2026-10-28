# Automations UI and external OpenClaw jobs

## Status & amendments
Status: Approved autonomously under LOOP night mode; combined logic and technical spec.

2026-10-27: initial design. No human review gate in this unattended loop.

## Purpose and conceptual model
An automation is a durable scheduled structured-agent definition, not a terminal task. The existing quirky.automations service owns definitions and runs. This item adds a scriptable human surface, not a second scheduler. A captured definition identifies its owning run host; a failed host/history read must never become an empty or successful result. OpenClaw jobs remain external records: their own CLI controls them, and deleting them never deletes native automation history.

## Scope and non-goals
The full union of m5-automations-ui parts: create/edit/delete and four templates; list/search/filter/sort/detail; manual queue, pause/resume, run dashboard/details/rerun/open workspace; external OpenClaw bounded discovery/mapping/actions. Include sidebar/settings entry, page return navigation, deletion preference, accessible keyboard behavior. Core/dispatch implementation, scheduler changes, additional external providers, webhooks/event triggers, terminal raw argument launches, and OS notification banners are not added here. Native menu visibility is handed off for native verification. Remote hosts are offered only when a public authority contract exists; unsupported authority must be explicitly shown, never impersonated as local.

## Data flow
The webview reads daemon-owned navigation/draft state, reads authoritative definitions/run history and project/agent catalogs, then sends namespaced commands. Successful commands emit changes; mounted views reread state, preserving retained drafts on rejected saves. Definition editing rereads current data and sends changed fields only, especially schedule fields. Setup trust is settled before save, failing closed to skip. Run now and rerun queue a manual run through the existing API; statuses come from stored evidence, not an optimistic completed badge. External discovery reads the selected authority's jobs file with bounds and executes a fixed argv command, never a shell interpolation.

## Decisions locked / key rationale
- Layout: table list, two-pane editor (prompt/name left; settings right), stack at narrow width. Alternative card-only page rejected: loses scanable columns/sort.
- Information density: documented fields/labels, semantic tables and labelled native controls. No new design system.
- Loading/error: independent native/external/history errors with retry; never call unreachable/unloaded data empty. Alternative swallowing failed reads rejected.
- Interaction/state: daemon owns page, selections, filters, sort and editor draft. Renderer owns transient busy/focus only. API/CLI equivalents for all durable and navigational actions.
- Targets: project/workspace/host choices from public APIs, preserve captured host and refuse drift rather than silently choosing another.
- Structured agents: Claude/Codex only, models/options from quirky.agents/options. Raw extra arguments disabled with explicit explanation because structured runner refuses them. Agent switch clears launch overrides.
- Schedule: existing preset builder and public inspector; explicit IANA timezone honored; no manual-only cadence. Legacy unsupported schedule must be repaired before save.
- External jobs: OpenClaw only, validated id, fixed argv, bounded file/JSON/job count and command duration; no real user state in tests.

## Behavior and acceptance scenarios
Each scenario is an API/CLI acceptance plus a web goal where visible. Example before/action/after defines the expected transition.

### SC1 Entry and return navigation
Before: workspace view active. Open Automations via sidebar or API; heading and list appear; close restores prior view. Hide sidebar shortcut through context menu/settings; page remains reachable from Settings. Sidebar visibility and ask-before-delete preferences are scriptable and settings-persisted. Native View-menu toggle uses existing public boolean menu metadata.

### SC2 Empty state and templates
Before: successful empty native/external reads. See honest empty text plus four template cards and Add new. Selecting each card opens a populated editor. Defaults: Weekday repo audit weekdays09:00/grace720; Release readiness review Thursday14:00/grace1440; Daily change review daily16:30/grace180; Hourly maintenance check minute15/grace30. Header template picker resets launch overrides and fills the template, without changing selected target unexpectedly.

### SC3 Editor default and target selection
Before: registered project/main workspace and enabled structured agents. New Automation opens a two-pane dialog. Defaults: default agent, Worktree/main, Fresh, weekdays09:00, grace720, precheck timeout60, no precheck. Host identifies scheduling authority; empty project list disables save with guidance. Project changes refresh workspaces/hooks and invalidate stale async facts. Worktree/new-run toggles show workspace or base-branch choice; New run forces Fresh, Reuse forces Worktree. Unavailable saved agent remains visible during edit but cannot be newly selected for create.

### SC4 Model/options and unsupported arguments
Before: selected agent with catalog. Model default inherits Settings; selecting model exposes select/boolean options. Agent switch clears model/options. Raw extra agent arguments appear disabled with structured-session explanation, never silently discarded or persisted. Saved unsupported values remain visible with a repair/clear path rather than fake catalog choices.

### SC5 Schedule, grace, precheck, setup
Before: editor retained draft. Hourly minute, daily/weekdays time, weekly day/time and custom five-field cron can be selected. Cron chips echo five fields, status states validity; impossible dates and oversized input rejected by existing validation. Explicit timezone retained. Grace includes0,30,60,180,720,1440,2880. Precheck has30,60,120,300,600second timeout and optional command. New-run project with setup exposes run/skip decision following project policy. Setup trust decline or inspection failure changes to skip before save; never promise a later unattended trust prompt.

### SC6 Validation and save
Before: invalid/blank prompt, missing target, unavailable workspace, invalid schedule or agent. Save reports specific error/toast and preserves dialog draft. Blank name is accepted as Untitled automation. Valid create persists enabled record and emits saved toast; repeated pending save does not duplicate. Edit rereads owner/current record, exposes same fields, disabled Save until changed; only changed fields submitted, no dtstart reset on unrelated edit. Save failure leaves editor open. Host move requires available destination and captured-owner validation; unsupported host authority is explicitly unavailable.

### SC7 Browse, filter, sort, keyboard
Before: multiple definitions with distinct names/projects/prompts/agents/run states. Search matches those texts; oversized query warns and leaves list unfiltered rather than expensive filtering. ArrowUp/Down selects and Enter opens. Host/status/last-run/agent filters have removable pills and clear-all; searchable agent list has no-match state. Name ascending default, last-run descending default; repeated header toggles. Cells include schedule/project/host/next/last/status/agent usage; missing usage is unavailable, never fabricated zero spend. Row actions and right-click share current capability checks.

### SC8 Honest failures and host state
Before: a host/native list or run history request rejects. Show error/unavailable/loading with retry/reconnect/update guidance as capabilities allow, preserving available rows. Do not show 'no automations' or 'no runs' for failed reads. Native data and external-manager availability independent. Failed reads cannot enable owner-unsafe mutations.

### SC9 Detail navigation and overview
Before: selected definition. Row opens breadcrumb/name/status/project-workspace detail, Overview/Runs tabs, Run Now/Edit/Pause/Delete controls. Escape returns to list and ArrowLeft/Right switches tabs. Overview includes schedule, timezone-aware next/paused, host, base branch or workspace, session mode, optional source, grace, precheck, agent/extra args when supported, last run, spend/tokens/coverage, collapsible prompt. SSH host note explains reachability/skips when applicable.

### SC10 Run now and pause/resume
Before: paused definition with valid target. Run Now still queues manual run through canonical API, with toast and truthful stored status. Availability refusal shows the exact reason. Pause/resume updates only enabled, preserving nextRunAt and schedule anchor. Stale captured owner cannot act on newly moved/replaced authority.

### SC11 Delete confirmation and preference
Before: definition with history and existing workspace. Delete dialog names automation and history, explains workspace survives, shows workspace-mode summary and Don't ask again. Cancel changes nothing. Confirm calls destructive API with explicit authorization, removes definition/history but not workspace; selected detail returns to list. Don't ask again persists preference and shows toast/Open Settings. CLI retains explicit --yes/kernel confirmation contract.

### SC12 Run history and paging
Before: runs including folded refusals, active/completed and more than one page. Detail Runs tab shows run/workspace/spend/tokens/status, folded occurrence count/latest date, keyboard selection and open. Loads more via stable cursor without duplicates; bounds mounted rows for large histories. Empty only after successful read. Failed history read is explicitly unavailable and not a failed automation.

### SC13 Runs dashboard
Before: known statuses/timestamps including future scheduledFor. Runs opens dashboard and resets host filter. Search and host/status filters distinguish successful/failed/in-progress/skipped; four24h/7d counters use scheduledFor and exclude future records. Counts use available history only with partial warning; table has name/title/time/trigger/host/status, incremental paging and honest loading/empty state.

### SC14 Run details and rerun
Before: saved output/precheck/error/usage evidence. Click run: breadcrumb/context/status and Markdown body using output first, precheck stderr/stdout next, error next, usage message next, fallback text last. Plain text remains escaped. Truncation says Latest saved output. Rerun only dispatch_failed/skipped_unavailable/skipped_needs_interactive_auth; queues manual run, pending at least800ms. View run/Open workspace appears only for extant structured session/workspace and navigates through public UI methods; missing data does not fabricate links.

### SC15 OpenClaw discovery/mapping
Before: isolated home jobs.json root object with jobs array. Discover OpenClaw CLI availability with5s bound; if neither CLI nor jobs nor read error, manager absent. Jobs without CLI produce unavailable/canManage:false warning; malformed/oversized file explicitly unavailable. Bound8MiB,10000jobs, depth128/structural token budget. Map id/name or120char prompt preview/id fallback, at/every/cron@timezone, enabled/state/running, next/last times/status/error/count and newest-first runs. Native records never mixed into external persistence.

### SC16 OpenClaw actions and guard
Before: discovered manageable local job with valid captured authority. Pause/resume/run/delete call only openclaw cron disable/enable/run/rm <id>,30s timeout, sanitized argv and bounded output. IDs match ^[A-Za-z0-9][A-Za-z0-9._:-]*$ before spawning. Unknown provider/host/action/unsafe id rejected; stale owner refused. Delete confirms. Success invalidates discovery and toasts; command failures remain visible, never optimistic successful status. SSH unsupported capability explicitly refused rather than executing locally.

### SC17 Safety and defect regressions
All process tests fresh HOME+QUIRKY_HOME and owned cleanup. Prove failed read never empty, absent usage never zero-success, raw args never accepted, custom cron field/impossible-date boundaries, timezone and DST strict-next preservation (existing core regression retained), no schedule reset on name-only edit, removed workspace refusal, untrusted setup fail-closed, unsafe OpenClaw IDs cannot execute and bounded input errors visible.

## Industry insights
No external research swarm: LOOP night-mode substitutes feature doc, roadmap and binding earlier decisions. Existing core D2 fixes ignored timezone/DST fall-back defect; existing plugin UI patterns provide public methods, settings metadata, report callbacks and delayed nested-root disposal.

## Deferred ideas
None added beyond assigned scope. Dispatch runtime is a separately owned queue item, not duplicated. Unsupported remote execution authority and structured raw arguments are explicit capability limits; any unreachable assigned flow must be recorded and queued before landing, not silently counted as passing.

## Glossary
Authority: daemon/host that owns a definition or external job. Draft: daemon-session retained editor values. Manual run: user/API queued occurrence of a scheduled definition, even paused. External manager: OpenClaw CLI/jobs-file provider, not native scheduler.

## Technical decisions and implementation contracts
Architecture: extend built-in plugins/quirky.automations using public PluginContext/UiPluginContext only. Shared src/ui-contracts.ts contains daemon state/environment and component interfaces. Existing types/service/store unchanged unless dispatch integration requires its authoritative changes. No extra runtime dependency on Tasks private code.

One implementer owns src/editor/** and test/editor*.test.ts, provides editorMethods(env) and AutomationEditor(props), including public editorData/openEditor/patchDraft/saveEditor/cancelEditor methods. Another owns src/list/** and test/list*.test.ts, exports AutomationsPage(props), including list/detail/dashboard/run surfaces and external rows; reads canonical data and shared daemon navigation. Third owns src/external/** and test/external*.test.ts, provides externalMethods(context) with externalList and externalAction; separate contributions.json describes exact new schemas/CLI metadata. Parent owns state.ts/ui.tsx/style, main/manifest/package registration, shared contracts, final API acceptance and docs.

Shared component props: UiPluginContext, AutomationUiState, refresh():Promise<void>, notify(message,kind?):void. Daemon state: revision, navigation(page/list/detail/runs/run; selected automation/run/tab; query/host/status/lastRun/agent/sort/direction; runQuery/runStatus), editor(null or {id,original,draft,creationKey}), visible error. Draft uses native definition input fields, not arbitrary JSON. Environment provides context, service, read/update/navigate. All component method names live under quirky.automations/. uiState/uiNavigate/open/close are parent registered; patch changes atomic and validated.

Contributions supplied as per-slice JSON are integrated into one manifest; every new method gets API schema and CLI alias. Temporary contribution fragments removed after integration. Public UI state navigation and draft transitions tested through real daemon harness; smoke browser uses fresh temporary home and controlled executable fixtures; no tests modify real ~/.openclaw or launch real agent. Parent final commands: bun scripts/suite.ts plugins/quirky.automations plus affected consumers; bun test scripts; bun run typecheck; bun run build and one unattended web dogfood, then cross-family final review with one blocking fix batch. Core and scripts whole-suite verification belongs to queue land.
