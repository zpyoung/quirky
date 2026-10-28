# Terminal parity sweep

## Status & amendments
Status: Approved autonomously under canonical LOOP.md unattended/night-mode rules. One logic spec with final technical section; separate tech/spec review skipped by that rule.

**Amendments:** 2026-10-28 — initial source/test inventory and bounded delivery contract; inventory is not runtime proof. The required recipe effort-only flow uncovered a shared API prerequisite: catalog-declared generic options now accept no explicit model, with explicit snapshot provenance and no fabricated model. This narrowly supersedes m1-launch-settings D9's blanket API model prerequisite; existing CLI flag policy remains. Parent owns the shared cutover below.

2026-10-28 clarification: recipe model/effort picks must not persist provider model settings. Existing workspace-trust preparation may still write its normal trust entry; this item must not disable or change that behavior to satisfy a configuration sentinel test.

## Goal and conceptual model
Audit all nine terminal-domain feature documents, close self-contained missing behavior, and give every remaining obligation an explicit owner. A prior item's non-goal is not a sweep exemption. Quirky's public plugin APIs replace Orca's private IPC; observable flows, not IPC spelling, are parity requirements.

Ship three bounded slices: durable Activity threads; structured Source Control recipe launch choices; truthful, idempotent CLI desktop opening. Reuse existing status normalization, agent catalogs, argument resolver, source-control recipes and daemon client identities. No second agent launcher or status state machine.

## Decisions locked
- Scope: all nine docs listed by m7-sweep-terminal. Explicit exclusions: GitLab, Bitbucket, Gitea/Forgejo, Azure DevOps, Objective runner, PR sitter. These exclusions do not excuse other remote/runtime flows.
- API/CLI: schema-declared public plugin methods and generated or explicit command groups; existing Quirky usage/runtime exit codes remain 2/1. No Orca compatibility aliases.
- Data: Activity acknowledgment belongs to a turn, survives restart, and must not acknowledge a later concurrent turn. Clearing completed removes feed entries, not sessions, agent status or transcripts; a subsequent turn reappears.
- Visual: Activity shows status groups in attention-first order, text and unread filters, child-agent expansion and navigation. Filter state is scriptable/readable through view input. Viewing/clicking a thread acknowledges its current turn.
- Recipe precedence: raw CLI arguments win over structured picks, which win over configured defaults. Use the existing agent resolver. One effective singleton flag; no invented catalog defaults for omitted choices. Changing provider clears incompatible choices.
- Safety: no blind Codex update-dialog paste, no global provider settings writes for recipe choices, no fallback from a requested remote owner to local execution.
- Platforms: macOS implementation; Linux/Windows-specific native installation, hooks and launch behavior remain deferred: platform. Remote test infrastructure does not imply platform acceptance.

## Alternatives and rationale
1. **Recommended and chosen:** use existing plugins, add bounded missing vertical flows, and name larger gaps in one follow-up. Preserves existing invariants and gives consumers working additions.
2. Rebuild Orca's internal IPC/daemon protocols: rejected; conflicts with the plugin-kernel and single-history architecture without improving observable parity.
3. Declare every old non-goal out of scope: rejected; the sweep explicitly owns them. Unfinished flows stay visible below and in the dependent follow-up.

## Acceptance scenarios

### A1: Activity status groups, search and children
Before: two terminal agents have real status rows: one waiting with a child, one working. Walkthrough: query/open Activity, group by status, filter by prompt/provider/workspace text, expand the waiting row. After: waiting precedes working; matching threads and child identity/state are visible, nonmatching threads are absent. Empty/filter-empty states are explicit. API/CLI query returns the same filtered thread data as the view.

### A2: Turn-scoped acknowledgment and restart
Before: a new turn is unread. Walkthrough: view/click its thread, or invoke acknowledge/all; restart the daemon. After: that turn remains read; a new turn becomes unread. A delayed acknowledge carrying an old turn token cannot consume the newer turn. Unread-only hides read rows; Mark all read does not change agent status or terminate work.

### A3: Clear completed and navigate
Before: one completed and one active thread. Walkthrough: Clear completed; query again; start a new turn in the completed session. After: active work remains, completion disappears only from Activity, underlying session/transcript/status remain, new turn returns. Click a retained live thread: select its exact workspace/session through the public UI API; unavailable destination reports an error instead of opening a different session. Preserve completed retention across restart; terminal exit does not silently discard feed history.

### R1: Save/inherit/reset recipe launch choices
Before: a global recipe has Claude model/effort, repository has no launch override. Walkthrough: read effective recipe; set repo launchOptions; clear it; restart. After: effective source reflects repo/global/default correctly and restart preserves choices. Clearing choices does not erase args/template. Agent changes clear incompatible choices; malformed values fail before persistence or launch.

### R2: One-shot generation and terminal fixes use the same resolver
Before: saved model/effort plus conflicting raw args and configured defaults. Walkthrough: generate a commit message and launch a fix through public Git API/CLI using owned external-provider stand-ins. After: actual launched argv contains exactly one model/effort value with raw-args > picks > defaults precedence. Effort without an explicit model works where the catalog supports it. Invalid pick creates no process/session. Generated text/fix prompt remain correct. Recipe choices do not persist model or effort into provider configuration; existing configured workspace-trust behavior is unchanged.

### R3: Settings and one-off launch choices
Before: configured recipe. Walkthrough: choose model/effort in Source Control AI settings and Customize launch; change agent; inspect raw override messaging; save a one-off recipe. After: effective pick is visible and persisted when requested, raw-shadowed fields say Set by CLI arguments and cannot falsely promise an effective different choice; changing agent resets incompatible picks. Unknown permitted model IDs remain editable, unsupported choices fail explicitly.

### C1: CLI open is truthful and idempotent
Before: a daemon has a usable connected desktop window. Walkthrough: quirky open --json. After: return current readiness without spawning another opener. Before: no desktop. Walkthrough: invoke open; successful launcher invocation alone is not readiness. After: success only after an actual desktop/window connection becomes available within the bounded wait; opener failure or absent desktop is an explicit runtime error. Mere CLI/web observer clients must not count as desktop readiness. Preserve macOS-only launcher behavior. No tests start the user's real app.

## Audit inventory: all nine source docs
Evidence is existing implementation/test source, not execution in this sweep. "Retained" means the documented flow has an implementation and behavioral tests; final verification below names only what this item actually runs. "Completion owner" means unfinished parity, not a pass.

|Document and flow family|Evidence / disposition|
|---|---|
|ask: six types, schema limits/defaults/credential refusal, typed answers/summary, free text, draft debounce/restart and timeout fallback|Retained: plugins/quirky.ask/src/core and test/core; test/asks.test.ts and test/ui.test.ts. Plugin-authored credential wording exemption remains prior D7.|
|ask: register/wait/chunk/cancel/reconnect, persisted deadlines and queue expiry|Retained: plugins/quirky.ask/cli.ts, asks.ts; test/cli.test.ts and asks.test.ts. Quirky wait-to-terminal default remains prior D11.|
|ask: queued second card and stale-sequence Orca defect|Retained: asks.ts fresh promotion seq; test/asks.test.ts SC15 and UI watermark cases.|
|ask: Claude AskUserQuestion suppression/version gate/fail-open|Retained: suppression.ts; suppression.e2e.test.ts and core/claude-flags.test.ts.|
|ask: rich previews, 4-second collapsed summary, autofocus/attention, three-minute escalation|Plain-text preview toggle exists; rich sandboxed rendering and result-flash/autofocus/attention remain completion obligations. Notifications currently sends surfaced ask immediately, not the documented delayed unattended flow.|
|ask: orchestration handoff, native question bridges, detached/session liveness, unavailable and four-wait cap|Completion owner: dependent sweep follow-up. Assess current orchestration/native-approval APIs before adding a second bridge. No attached window is required by Quirky; preserve that architecture while specifying equivalent lifecycle outcomes.|
|ask: phone answering|Orca source itself marks no observed phone surface; no parity claim. Mobile composition remains follow-up assessment, not fabricated upstream behavior.|
|cli: parsing, help/groups/flags/--, JSON/human/error/usage results, suggestions, request-id retry, confirmations, generated catalog and skill|Retained: packages/cli/src and test/args, cli.e2e, api, generated, request-ids, confirm, json-reason, skill.|
|cli: local daemon socket/token, status, safe-mode/restart and profile home|Retained: packages/cli/src/link.ts and daemon commands; daemon/protocol tests. Transport differs intentionally from Orca metadata spelling.|
|cli: open already running/readiness|C1 in this item.|
|cli: macOS installed shell command/status/reveal and per-instance shell shims; remote saved/one-off runtime selectors and pairing|Completion owner: dependent sweep follow-up. Audit existing packaging/mobile pairing and session env injection first; no claim that different architecture removes these consumer flows.|
|cli: Windows PATH/WSL/Linux command naming and install behavior|Deferred: platform.|
|cli: Orca command inventory|Feature commands are owned by their Quirky plugins; excluded/dropped features are not recreated solely to match Orca's static count. Check API/CLI discovery for shipped plugins.|
|agent-status: dot labels/state machine, lead/child ownership, readable permission detail, capture, freshness, OSC/title fallback, process/interrupt/question inference|Retained: plugins/quirky.agent-status/src/service.ts/model.ts and normalize; agent-status, capture, fallbacks, explain and e2e tests. Helper-overwrite and JSON-detail defects have regression evidence.|
|agent-status: hook install/remove/status/settings/startup skips and failures|Retained: hooks.ts and hooks/e2e/hooks-cli tests; no real provider home mutation during verification.|
|agent-status: Activity grouping/filter/children/unread/acknowledge/clear/navigation|A1-A3 in this item; explicitly fulfills m1-agent-status D1 sweep assignment.|
|agent-status: experimental Dashboard/pop-out/filters and completed-hidden-idle zero-total defect|Completion owner: dependent sweep follow-up; must include defect regression, not present a missing board as passing.|
|agent-status: transcript-based Codex/Muse polling/retry, Claude statusLine, private OSC9999, remote relay/install|Completion owner: dependent sweep follow-up assessment; OSC7501/explain/rules are already implemented. Windows/WSL remains deferred: platform.|
|launch-settings: catalog/options, opaque model IDs, ceilings, boolean/composed options, terminal picks/resume, raw precedence and snapshot agreement|Retained: quirky.agents/core/resolve, selection/extras tests and e2e/launch-settings; no duplicate-flag, ignored-effort-without-model or snapshot disagreement accepted.|
|launch-settings: automation model/effort, immutable run settings snapshot|Retained: quirky.automations/dispatch.ts and native-cli/dispatch tests. Automation UI is owned by the concurrent m5 UI item; inspect its eventual shipped editor/details/Runs proof before declaring complete.|
|launch-settings: automation raw arguments/remote host execution|Already-owned m5-automations-dispatch-remote-and-args; preserve structured-only refusal until binding conflict is resolved, do not add duplicate follow-up.|
|launch-settings: source-control recipe structured selections and raw-shadow messaging|R1-R3 in this item for currently shipped actions. Additional hosting/review/branch/conversation recipes require follow-up composition with owning plugins.|
|launch-settings: model discovery/retirement and stale-model UI, paired-host capability gating|Completion owner: dependent sweep follow-up. No destructive retirement from empty/nonauthoritative probes.|
|providers: 45 catalogs/override/disable, detection/refresh/default/enabled, permissions, settings command/args/env, trust presets|Retained: quirky.agents catalog/detect/permissions/settings/trust and e2e/ui tests.|
|providers: prompt argv/flag/interactive/long/draft, ready/paste/submit and Codex update-menu refusal|Retained: prompt/delivery/ready tests; unresolved update menu returns not-delivered without input. Later dismissal after deadline is a remaining delivery/retry UX assessment, not permission to blind paste.|
|providers: provider session capture/resume/fork/history/copy/logs/deletion|Retained: quirky.agents resume tests, quirky.session-info HistoryView and UI/e2e tests. Pane-context Fork entry and full source issue-to-agent unsubmitted draft proof remain follow-up.|
|providers: cold-restore agent resume, remote/WSL and platform launch differences|Completion owner: dependent sweep follow-up; Windows/WSL deferred: platform.|
|term-daemon: shell-ready, warm attach/checkpoint/cold restore, history paging/corruption/rotation/memory, bells/OSC facts, sessions panel/kill/kill-all/restart|Retained: pty-host/session.ts, history; terminal/e2e and pty-host restore/manager/memory tests.|
|term-daemon: masked nonzero exit and OOM defects|Retained: terminal/e2e macOS exit3/signal scenarios and bounded-memory regression.|
|term-daemon: two sockets, duplicate emulator/scrollback, legacy protocol versions|Architectural replacements: Quirky one-socket framed protocol, screen-only emulator, one disk history. Not extra user flows to recreate.|
|term-daemon: macOS launchd/TCC packaged helper, admission and upgrade lifecycle|Completion owner: follow-up/native feasibility; signed helper behavior unverified. Linux systemd and Windows ConPTY/named-pipe remain deferred: platform.|
|term-ui: tabs/groups/splits/focus/expand/reorder/pin/color/rename/reopen/close, persistence/restart/crash, exit overlays|Retained: terminal/layout service/tree and e2e tabs/panes/persistence plus e2e-ui/workspace tests.|
|term-ui: search, Enter/Cmd+G stepping defect, links/copy/select/paste/drop/key translations/settings|Retained: terminal/e2e-ui/features-search/links/pane/keys/settings. Native IME/physical input remains native proof, not inferred from synthetic tests.|
|term-ui: quick commands, floating workspace and geometry|Retained: features-quick-commands/floating and e2e/floating.|
|term-ui: browser/Markdown/mobile tabs, editor destinations, handoff/dock, hidden view parking, image/ligature/theme extras, shortcut remapping|Later owners implement portions; remaining composition/proof and absent extras are completion obligations. No assumption M1's exclusion means still missing; audit current owners before implementing.|
|worktrees: projects/git/folders/nested groups/create/clone/remove, metadata/status/pin/unread/parents/groups|Retained: worktree project/folder/metadata/window-tree/window-projects tests.|
|worktrees: named/generated creation, branches/base fallback/collision, trust/setup/agent/create-more/carried files|Retained: daemon/create.ts; create/setup/carry/window-create tests.|
|worktrees: GitHub issue/PR/selected ref creation|Retained: github-create tests. Explicitly excluded other hosting providers are not reopened.|
|worktrees: deletion dirty/locked/orphan/descendant/archive/branch/folder/restart safety and six Orca defects|Retained: daemon/remove.ts, delete/setup/window-create/folder/create regressions.|
|worktrees: sparse presets/prepared pool/keep-main/behind toast/host runs/issue-command split/environment recipes/default tabs/model effort/per-project shared paths|Completion owner: dependent sweep follow-up. YAML sharedDirectories and .worktreeinclude already work; quirky.repo/hooks explicitly warns that defaultTabs/environmentRecipes are unsupported.|
|worktrees: standard group/sort/project order/card layout/properties/options and origin/default-branch/detached/other-client visibility filters|Activity/review filters already exist in sidebar-extras; m2-sidebar-extras D14 leaves stock controls and sleep for M7. Missing standard options remain completion obligations, not covered by the activity/review subset.|
|worktrees: cleanup preview/blockers/ignore/restore/bulk deletion; sleep/descendant sleep/wake|Completion owner: dependent sweep follow-up; reuse safe removal and retain history, never infer dirty/agent safety from idle alone.|
|worktrees: external hidden-source inbox/show-hide defaults/per-project visibility; back/forward/keyboard navigation and Open-in; manual Add reference/link/unlink; custom statuses/board; project icons/avatar/tracker defaults/available hosts|External registration detection and GitHub source-linked creation already exist. UpdateDialog currently edits displayName/comment only; no manual reference editor. Remaining controls and composition are completion obligations. Jira/tracker links are not silently excluded by the user's unrelated hosting-provider exclusions.|
|worktrees: native folder picker|Typed path supported. Actual picker requires public shell capability; native follow-up, not a fabricated implementation.|
|cross-owner composition|Existing m2-sidebar-extras-followup owns its previously deferred 17-flow completion; do not duplicate it. The sweep completion owns the distinct stock options/sleep/cleanup and missing capabilities above, and must reconcile overlaps before implementation.|

## Non-goals and deferred ideas
Larger gaps named in the audit are not implemented by this bounded landing. They are grouped into one dependent completion item added exactly once immediately before landing. Already-owned automation raw-args/remote work and terminal-dock completion are referenced, not duplicated. Native-only scenarios are separately handed to the nightly run when a runnable behavior exists; unsupported native APIs remain explicit prerequisites. No broad parity-complete claim.

## Industry insights
External research swarm intentionally skipped under canonical LOOP night-mode rule. Evidence consists of the nine source docs, roadmap/architecture decisions and existing repository implementations/tests. No external facts asserted.

## Glossary
Activity thread: retained latest status snapshot per terminal session and turn, distinct from the live dot. Acknowledgment: read receipt tied to the observed turn. Recipe launch choices: optional model and optionValues resolved through the public agents catalog. Desktop readiness: a real connected desktop shell/window, not successful OS launcher exit or any arbitrary client.

## Technical contracts and ownership

### Component A: Activity
Scope: plugins/quirky.agent-status only. Existing status rows/normalizers/setStatus ownership remain unchanged. New activity state uses plugin-owned append-only store migrations; retains completed/exited snapshots independently from live status row cleanup. Store a stable turn token, acknowledgment and cleared-turn marker. A later turn resurrects its thread; ordinary evidence updates do not create duplicate turns or clear read receipts.

Public methods: quirky.agent-status/activity({worktree?,text?,unreadOnly?}) -> {threads: ActivityThread[]}; acknowledge({session?,turn?,all?}) -> {acknowledged:number}; clearCompleted({worktree?}) -> {cleared:number}. Explicit old-turn acknowledgment never acknowledges a replacement turn. New schema-declared window commands openActivity and openActivityThread route through public UI state and exact session/workspace identity. Existing CLI group gains activity, acknowledge, clear-completed (or generated schema equivalents); filters/group choice are readable view input. Attention-first order: waiting, blocked, permission, failed, unconfirmed, working, monitoring, interrupted, unverifiable, done, idle. Tie: newest turn then session ID. No Dashboard/pop-out implementation.

### Component R: Source Control choices
Scope: plugins/quirky.git, plus quirky.agents generation implementation/schema only if needed. RecipeLaunchOptions = {model?:string,optionValues?:Record<string,string|boolean>}. EffectiveRecipe adds launchOptions and sources.launchOptions; StoredRecipe adds nullable launchOptions with repo/global/default inheritance as one provider-specific value. Append schema migration; old records mean null. Public aiRecipe/setAiRecipe/aiFix/generateCommitMessage schemas accept/read structured choices; clearing at a scope is explicit null. UI and save-back paths use the same shape. Use quirky.agents/options and resolveLaunch, not private imports. Apply selections to real one-shot generation and terminal newTab; raw args continue winning. Custom command without catalog must not advertise unsupported picks. New tests drive public Git/agents APIs and CLI with isolated homes/provider stand-ins; do not test call forwarding as a substitute for argv behavior.

Parent-owned prerequisite: quirky.agents core ValidSelection.model is string|null; validateSelection accepts no-model options only from generic unlistedOptions. resolveLaunch emits/persists only actual picks and preserves configured/native model. Raw model does not shadow a generic option-only pick; raw effort still supersedes effort. Parent owns core type/validation/resolver and direct consumer tests, plus public session/terminal option descriptions; recipe worker owns generation/schema integration. No invented default model, extra-args provenance conversion, second resolver or compatibility alias.

### Component C: CLI open
Scope: packages/cli and its tests. Reuse current daemon status/client readiness information; if insufficient, request a scoped public prerequisite before widening scope. Do not treat web or CLI role as native desktop. Bound wait to 15 seconds; opener is injected in tests and never runs the real user's app. Check already-ready first and do not launch again. Report launcher failure and readiness timeout distinctly with existing runtime-error JSON conventions. Keep status/open output coherent and document exact readiness evidence; do not invent GUI attachment state.

### Verification
Workers do not run checks mid-flight; parent runs regression red cases before implementation and all checks after wave barrier. Affected suites via bun scripts/suite.ts; scripts and typecheck once after integration, actual daemon/CLI smoke plus built-web Activity and recipe scenarios with temporary homes. One final cross-family review round, one accepted-blocker fix batch and any required fix verification. Canonical catch-up once just before landing; read incoming relevant decisions. No whole-suite invocation here; queue.ts land owns it.
