# Terminal-domain completion

## Status & amendments
Approved autonomously under authoritative LOOP.md. 2026-10-28: initial design. Build-first/end-phase testing policy applies; write acceptance tests, run only typecheck plus the required isolated changed-path smoke. No suite, formal review, or dogfood campaign starts here.

**Amendments:** 2026-10-28 — S1 distinguishes stale Quirky session/pane identity (refuse before spawn) from an externally deleted, syntactically valid provider conversation (no public existence probe; the provider CLI reports its real failure). No invented probe or fallback is permitted. Ask's four-wait gate uses existing Conflict/-32009 plus structured `data.reason=runtime_busy`; the unavailable envelope and caller-preserving orchestration bridge remain unbuilt API migrations.

2026-10-28 source correction: worktrees.md142 defines Sleep as closing active panels, not stopping a process. W2 therefore permits live sessions, retains their processes and history, and unmounts exact selected workspace views. Process-liveness blockers apply to destructive cleanup, not reversible sleeping. Sleeping rows remain listed by default and selecting one wakes it.

## Goal and conceptual model
Close the outstanding terminal-domain obligations inventoried in the parent [terminal sweep](../2026-10-28-m7-sweep-terminal/logic.md#audit-inventory-all-nine-source-docs). Preserve its inventory as the exhaustive requirement set: old non-goals are not exemptions. The daemon remains authoritative, plugins consume only public cross-plugin APIs, and presentation never grants process or orchestration authority.

Three independent vertical implementation components start now: Ask presentation and delayed attention; Activity Dashboard and agent-session continuity; stock worktree presentation and lifecycle controls. Every other inventory row is reconciled below and remains explicitly outstanding until implemented by its named owner or the single permitted unbuilt-flow successor. This is not a declaration of terminal parity completion.

## Decisions locked
- API/CLI: namespace new methods in the owning built-in plugin and declare supported flat schemas. UI controls use the same methods or registered scriptable window commands. Reject unavailable exact targets; never substitute a local session/host.
- Visual/error state: disclose hidden counts and provide recovery controls. Reading completed Activity must not hide it as idle. Never display raw permission JSON when a readable detail exists.
- Ask lifecycle: pending badge excludes queued and resolved asks; resolution shows the terminal envelope summary for four seconds, without delaying durable resolution or next-ask promotion. An ask for the currently focused session may reveal Questions without changing terminal focus; respect a subsequent user sidebar choice. Previews are untrusted and sandboxed, without executable code, external resources or navigation. Unfocused surfaced asks escalate after three uninterrupted unattended minutes; focus/resolution cancels, and rehydration does not silently lose escalation.
- Authority/data: reuse current ask store, Activity projection, provider-session capture/resume resolver, worktree store and safe removal service. No duplicate status machine, second launch resolver, or private cross-plugin import.
- Liveness: absent/unknown evidence is not proof of a dead process. Cleanup cannot destroy unproven running work; recheck state at destructive commit, not only preview time. Sleep only closes exact workspace views and preserves every process, dirty buffer and retained history. Preserve descendants and normal archive, dirty, locked and branch-preservation rules.
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
Before: an agent pane with valid captured provider ID and catalog-supported fork/resume; separately a cold restored session. Walkthrough: invoke pane Fork or explicit resume through registered command/public API. After: fork starts a distinct exact provider conversation through the existing resolver; cold resume preserves recorded provider, model/options and cwd. Unsupported or missing identity and a stale Quirky session/pane target refuse before creating a session. A syntactically valid but externally deleted provider conversation cannot be preflighted with the current public API; its provider failure remains visible, without replacement or guessed success. Plain shells do not offer Fork. Warm attachment must not start a second agent; no blind input into a live agent.

### S2: Issue-derived unsubmitted startup draft
Before: direct GitHub issue creation selects an agent with no explicit startup prompt. Walkthrough: create through worktree/create, CLI or creation dialog. After: the exact issue URL becomes the startup draft and submitPrompt is false. Explicit submit/draft choice overrides; generic user prompt creates retain the existing submitted default. UI exposes the same choice, both CLI flags cannot be selected together, and raw issue text cannot bypass native provider readiness.

### W1: Stock worktree presentation
Before: projects/worktrees with different status, activity, pinned and origin metadata. Walkthrough: change stock grouping/sort/card/property/filter options through UI and public API, restart, clear filters. After: state persists, stable order/grouping reflects the chosen values, pinned and nested groups are not lost, counts/reveal controls expose hidden rows. Existing sidebar-extras activity/review preferences retain their authority.

### W2: Sleep and wake descendants
Before: workspace with descendants and live sessions. Walkthrough: preview/sleep/wake using UI and API. After: only the explicitly selected subtree's active panels close/unmount, its rows remain listed with sleeping state, and all PTYs/agents, dirty buffers and retained history survive unchanged. Selecting a sleeping row wakes and opens it without creating a replacement live process. Sleep metadata survives restart. Unavailable exact view routing refuses or is disclosed as a missing capability; it must not silently close an unrelated workspace/window.

### W3: Cleanup preview, ignore/restore and safe bulk delete
Before: stale clean and dirty/locked/pinned/main/live/unknown candidates. Walkthrough: inspect preview/blockers; ignore then restore one; explicitly confirm selected eligible bulk deletion. After: blockers are actionable and ignored entries remain recoverable. Each removal rechecks canonical safety and retains archive/branch semantics. Stale preview cannot authorize removal after new dirty/live state; one failure does not falsely mark other results successful.

## Exhaustive disposition ledger
All rows below refer to the parent inventory, which retains source evidence and original defects.

| Family | Disposition in this item |
|---|---|
| Ask six types, durable queue/defaults/drafts/waits/suppression | Retain current behavior; Q1-Q3 extend presentation/escalation, and the four-wait gate sheds via typed Conflict/runtime_busy with bounded CLI retry. Native/orchestration caller-preserving handoff and exact-session liveness/unavailable remain unbuilt protocol/authority migrations; no forged identity or terminal-status substitution. |
| CLI installed-command/status/reveal/profile shims and saved/one-off paired-runtime selection | Retain daemon-generated in-session quirky shim, profile QUIRKY_HOME environment and shell wrappers. External installed-command manager/status/reveal and standalone profile-bound launchers plus saved/one-off paired-runtime selection remain unbuilt; reuse existing mobile pairing, never local fallback. |
| Activity/Dashboard/pop-out/filters/hidden-idle | D1-D2 implement in-window Dashboard/query/CLI, columns, project/workspace-status/review/text filters and truthful totals. Pop-out lacks a public Quirky window route despite native BrowserWindow existing. Parent recipe and Activity tool-blocked campaigns remain unpassed end-phase evidence obligations, not new verification queue items. |
| Status transcript polling/retry, Claude statusLine, private OSC9999 and remote relay/hooks | Retain shipped quirky.session-info per-launch Claude statusline/telemetry with consented custom chaining. Codex/Muse transcript polling/retry, private OSC9999 and remote relay/hooks remain unbuilt composition. Existing hook/OSC7501/rules authority remains. |
| Model discovery/retirement/stale choices/host capability gates | Unbuilt flow; authoritative nonempty probes only may retire a model; no destructive action from failed/empty probes. Existing opaque IDs and launch provenance remain. |
| Hosting/review/branch/conversation AI recipes | Unbuilt composition; reuse existing recipe storage and canonical resolver. Parent shipped Git recipes are retained, not duplicated. |
| Issue-derived unsubmitted prompt, pane Fork and cold resume | S1 implements continuity; W owns S2 via worktree/create({github,agent,submitPrompt?}) and the existing public session/create draft capability. No paid-provider or cold-reboot proof inferred. |
| Terminal browser/editor/Markdown/mobile/handoff/dock composition, hidden parking/render extras/key remapping | Reconcile existing owners. Dock unfinished-flow item is already done; no duplicate. Missing distinct composition remains unbuilt. Hidden parking must preserve architecture's visible-only mounted view invariant. |
| Worktree stock controls/sleep/cleanup | Implement project/status/none grouping, recent/name/manual sort and sibling reorder, compact/branch/comment/sleep properties, disclosed hidden sleeping rows, exact subtree panel sleep/wake and safe cleanup preview/ignore/restore/confirmed canonical removal. PR grouping, agent-activity sort, project-order controls, remaining card/property/origin/default-branch/detached/other-client/host filters remain unbuilt. Cleanup has 30-day idle-clean evidence; 7-day archived candidates need archive metadata; generic volatile-context and remote-disconnection classification need public evidence. Sleep refuses ambiguous multi-window view closure until a public per-window layout/close route exists. |
| Worktree external visibility/inbox, keyboard/history/Open-in, references/custom status/board/project identity | Distinct external show-hide policy/inbox, back-forward/keyboard/Open-in, manual reference link/unlink, custom-status board, icons/avatar/tracker defaults and available-host controls remain unbuilt. Existing sidebar-extras projection and GitHub source-linked create remain authoritative; tracker links are not excluded. |
| Worktree sparse/pool/keep-main/behind/host/issue split/environment/default-tabs/model/shared paths | Unbuilt distinct create flows; retain .worktreeinclude/sharedDirectories, do not pretend warning-only hook keys execute. |
| Native notifications permission/click/dismiss, signed host/admission/upgrade, native folder picker | Native utility exposes void showNotification but no permission/click/dismiss hooks. Signed host launchd/TCC/admission/upgrade lifecycle remains unbuilt packaging. Public SDK folder dialog exists; Quirky public bridge is unbuilt. No private patches or simulated native completion. Typed paths/current daemon remain supported; new Q2/Q3 native-only scenarios are pending. |
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
