# Terminal-domain completion

## Status & amendments
Approved autonomously under authoritative LOOP.md. 2026-10-28: initial design. Build-first/end-phase testing policy applies; write acceptance tests, run only typecheck plus the required isolated changed-path smoke. No suite, formal review, or dogfood campaign starts here.

## Goal and conceptual model
Close the outstanding terminal-domain obligations inventoried in the parent [terminal sweep](../2026-10-28-m7-sweep-terminal/logic.md# audit-inventory-all-nine-source-docs). Preserve its inventory as the exhaustive requirement set: old non-goals are not exemptions. The daemon remains authoritative, plugins consume only public cross-plugin APIs, and presentation never grants process or orchestration authority.

Three independent vertical implementation components start now: Ask presentation and delayed attention; Activity Dashboard and agent-session continuity; stock worktree presentation and lifecycle controls. Every other inventory row is reconciled below and remains explicitly outstanding until implemented by its named owner or the single permitted unbuilt-flow successor. This is not a declaration of terminal parity completion.

## Decisions locked
- API/CLI: namespace new methods in the owning built-in plugin and declare supported flat schemas. UI controls use the same methods or registered scriptable window commands. Reject unavailable exact targets; never substitute a local session/host.
- Visual/error state: disclose hidden counts and provide recovery controls. Reading completed Activity must not hide it as idle. Never display raw permission JSON when a readable detail exists.
- Ask lifecycle: pending badge excludes queued and resolved asks; resolution shows the terminal envelope summary for four seconds, without delaying durable resolution or next-ask promotion. An ask for the currently focused session may reveal Questions without changing terminal focus; respect a subsequent user sidebar choice. Previews are untrusted and sandboxed, without executable code, external resources or navigation. Unfocused surfaced asks escalate after three uninterrupted unattended minutes; focus/resolution cancels, and rehydration does not silently lose escalation.
- Authority/data: reuse current ask store, Activity projection, provider-session capture/resume resolver, worktree store and safe removal service. No duplicate status machine, second launch resolver, or private cross-plugin import.
- Liveness: absent/unknown evidence is not proof of a dead process. Sleep/cleanup cannot destroy unproven running work. Recheck state at destructive commit, not only preview time. Preserve descendants/history and normal archive, dirty, locked and branch-preservation rules.
- Platform: macOS only. Native-only permission/click/dismiss, signed helper/TCC and folder-picker prerequisites require supported public shell capabilities and real signed packaging; do not emulate success with a browser dialog or private FFI.
- Exclusions: GitLab, Bitbucket, Gitea/Forgejo, Azure DevOps, Objective runner and PR sitter remain excluded. Other remote/tracker flows are not excluded by that ruling.

## Alternatives
1. Chosen: extend existing owners with independent vertical flows, preserve an exhaustive disposition ledger and use LOOP's one successor only for genuinely unbuilt flows. Existing public boundaries and safety invariants remain intact.
2. A parallel replacement ask/status/worktree authority: rejected; divergence and unsafe reconciliation.
3. Treat inherited omissions or tool-blocked visual reports as passing: rejected; neither implementation nor verification evidence.

## Acceptance scenarios
Each component writes deterministic consumer-behavior coverage before implementation; tests are not executed in this build phase.

### Q1: Rich, inert option previews
Before: select/multiselect option contains Markdown or HTML, including hostile links, scripts, handlers and embeds. Walkthrough: Show preview. After: supported rich text renders inside an empty-sandbox frame with restrictive CSP; no script, form, network load, parent navigation or executable URL is possible. Hide preview removes it. The question answer/free-text path remains usable.

### Q2: Resolution flash and focused-session attention
Before: two asks queue for one live session; another session is focused. Walkthrough: answer/cancel/timeout the first through API, then observe the Questions panel. After: its actual terminal summary remains for four seconds; the new surfaced ask and pending badge are truthful, drafts/epoch/watermarks remain sound. A newly surfaced ask on the focused session reveals Questions; an unfocused ask never steals terminal focus. Explicit user panel choices are not overwritten by later refreshes.

### Q3: Delayed unattended escalation
Before: surfaced pending ask for an unattended session. Walkthrough: advance three minutes; separately focus the session, resolve it, or replace the head before expiry. After: only an uninterrupted still-pending unattended head produces one notification via the existing notification policy; cancelled timers do not notify. No immediate banner at registration. Restart and reconnect reconcile pending asks; all timers stop on shutdown.

### D1: Dashboard columns, detail and total
Before: waiting/working/done/idle retained Activity threads, including an acknowledged completion. Walkthrough: enable/open Dashboard and filter it. After: Needs you, Working and Done contain the correct cards; acknowledged completion remains Done. Hidden idle has an explicit count/reveal action, and total includes it rather than falsely reporting zero. Card navigation uses exact public session navigation. Readable permission details remain readable.

### D2: Dashboard filters and scriptability
Before: threads across projects, workspace statuses and GitHub review states. Walkthrough: use text/project/workspace-status/review filters and Clear all; reopen using public command input/API. After: identical filtered result and readable view state; unavailable optional review data is explicit, not invented. Dashboard toggle/settings/sidebar entry share declared contribution IDs. Native pop-out requires a supported public window API; otherwise it remains a named unbuilt prerequisite, not a fake tab.

### S1: Pane Fork and cold agent resume
Before: an agent pane with valid captured provider ID and catalog-supported fork/resume; separately a cold restored session. Walkthrough: invoke pane Fork or explicit resume through registered command/public API. After: fork starts a distinct exact provider conversation through the existing resolver; cold resume preserves recorded provider, model/options and cwd. Unsupported/missing/stale identity refuses before creating a session. Plain shells do not offer Fork. Warm attachment must not start a second agent; no blind input into a live agent.

### W1: Stock worktree presentation
Before: projects/worktrees with different status, activity, pinned and origin metadata. Walkthrough: change stock grouping/sort/card/property/filter options through UI and public API, restart, clear filters. After: state persists, stable order/grouping reflects the chosen values, pinned and nested groups are not lost, counts/reveal controls expose hidden rows. Existing sidebar-extras activity/review preferences retain their authority.

### W2: Sleep and wake descendants
Before: workspace with descendants and live or unavailable session evidence. Walkthrough: preview/sleep/wake using UI and API. After: only the explicitly selected subtree is affected; unsafe or unprovable process state refuses. Wake restores visibility/navigation without creating a replacement live process or deleting retained history. Sleep metadata survives restart.

### W3: Cleanup preview, ignore/restore and safe bulk delete
Before: stale clean and dirty/locked/pinned/main/live/unknown candidates. Walkthrough: inspect preview/blockers; ignore then restore one; explicitly confirm selected eligible bulk deletion. After: blockers are actionable and ignored entries remain recoverable. Each removal rechecks canonical safety and retains archive/branch semantics. Stale preview cannot authorize removal after new dirty/live state; one failure does not falsely mark other results successful.

## Exhaustive disposition ledger
All rows below refer to the parent inventory, which retains source evidence and original defects.

| Family | Disposition in this item |
|---|---|
| Ask six types, durable queue/defaults/drafts/waits/suppression | Retain current behavior; Q1-Q3 extend presentation/escalation. Native/orchestration handoff, exact-session liveness/unavailable and four-wait cap require further composition unless component evidence proves shipped; retain as unbuilt successor obligations. |
| CLI installed-command/status/reveal/profile shims and saved/one-off paired-runtime selection | Unbuilt flow; successor must integrate packaging and existing mobile pairing without local fallback. Core parser/local transport/open remain unchanged. |
| Activity/Dashboard/pop-out/filters/hidden-idle | D1-D2; pop-out only when public shell capability exists, otherwise explicit successor prerequisite. Parent Activity/recipe tool-blocked reports remain not-passed. |
| Status transcript polling/retry, Claude statusLine, private OSC9999 and remote relay/hooks | Unbuilt composition; successor owns exact public producers, identity and remote generation fencing. Existing hook/OSC7501/rules authority remains. |
| Model discovery/retirement/stale choices/host capability gates | Unbuilt flow; authoritative nonempty probes only may retire a model; no destructive action from failed/empty probes. Existing opaque IDs and launch provenance remain. |
| Hosting/review/branch/conversation AI recipes | Unbuilt composition; reuse existing recipe storage and canonical resolver. Parent shipped Git recipes are retained, not duplicated. |
| Issue-derived unsubmitted prompt, pane Fork and cold resume | S1 implements continuity; source-issue draft composition remains unbuilt unless component confirms an actual public path. No paid-provider or cold-reboot proof inferred. |
| Terminal browser/editor/Markdown/mobile/handoff/dock composition, hidden parking/render extras/key remapping | Reconcile existing owners. Dock unfinished-flow item is already done; no duplicate. Missing distinct composition remains unbuilt. Hidden parking must preserve architecture's visible-only mounted view invariant. |
| Worktree stock controls/sleep/cleanup | W1-W3; do not duplicate sidebar-extras' 17 existing scenarios. Any unstarted distinct controls remain in the single successor with exact names. |
| Worktree external visibility/inbox, keyboard/history/Open-in, references/custom status/board/project identity | Unbuilt distinct flows unless current worktree component implements them; shared sidebar projection remains authoritative. Tracker links are not excluded. |
| Worktree sparse/pool/keep-main/behind/host/issue split/environment/default-tabs/model/shared paths | Unbuilt distinct create flows; retain .worktreeinclude/sharedDirectories, do not pretend warning-only hook keys execute. |
| Native notifications permission/click/dismiss, signed host/admission/upgrade, native folder picker | Capability/packaging prerequisite ledger; no private patches or simulated native completion. Typed paths and current daemon remain supported. |
| Automation remote/raw arguments | Existing owner m5-automations-dispatch-remote-and-args and its UI successor; no duplicate item. |
| Sidebar-extras 17-flow follow-up | Existing m2-sidebar-extras-followup; no duplicate item. Stock W1-W3 remain distinct. |
| Linux/Windows/WSL-specific installation/native/hooks/launch | Deferred: platform, not macOS acceptance. |

## Industry insights
No external research swarm under LOOP. Evidence: nine source feature docs, parent inventory/decisions, locked architecture/roadmap, and current repository mapping. Source mapping is not runtime proof.

## Glossary
Surfaced ask: pending FIFO head, excluding queued asks. Dashboard total: retained matching thread count including disclosed hidden idle. Sleep: reversible workspace lifecycle operation, never permission to kill unverified work. Cleanup preview: current evidence report, never a durable deletion authorization.

## Technical contracts and ownership
Parent commits contracts before dispatch. Three disjoint components, no semantic dependencies, maximum three implementers:
- Q: plugins/quirky.ask and plugins/quirky.notifications, tests and package-local manifest/docs included. Existing Ask types are wire authority; a presentation-only terminal summary retention must not change persisted queue semantics. Notification policy owns all delivery timers.
- D/S: plugins/quirky.agent-status, plugins/quirky.terminal, plugins/quirky.agents and plugins/quirky.session, only for Dashboard and public Fork/cold-resume composition. Dashboard types live in agent-status; all cross-plugin calls use strings/public types, never source imports. No kernel/process authority rewrites.
- W: plugins/quirky.worktree only; sidebar-extras is consumed via public methods, not edited. Worktree lifecycle metadata stays in plugin-owned append-only migrations, no global protocol Worktree field expansion required. Runtime controls use public session/agent/UI evidence. Removal reuses canonical remove implementation and confirmation contract.
Parent owns spec/decision log/notes, final docs index, cross-component typecheck, required isolated smoke, the single catch-up and queue land. No protected loop files/shared queue edits. Untracked .serena remains untouched. End-phase suites/reviews/UI campaign are not started here.
