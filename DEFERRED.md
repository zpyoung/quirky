<!-- schema-version: 1 -->
<!-- DEFERRED.md SCHEMA (append only)
Entry format:
## DEFER-[N]: [Task title]
- **Deferred**: [date]
- **Session context**: [what triggered this]
- **Why deferred**: [out of scope / blocked on / requires decision]
- **Estimated effort**: [S/M/L]
- **Priority**: [P1/P2/P3/P4]
- **Proposed owner**: [Claude / name / unassigned]

Required fields: title, why_deferred, priority.
-->

# DEFERRED

Tasks surfaced during sessions but explicitly out of scope for the current work.

Reviewed every sprint planning. Use `/quirk:artifacts:defer` to append.

## DEFER-1: Terminal-dock focus: visibility-resume refocus ignores docked composer

- **Deferred**: 2026-08-14
- **Why deferred**: focusActivePane (pane-helpers.ts), called from terminal-visibility-resume.ts (x3) and use-terminal-pane-lifecycle.ts (x1) on tab/window visibility resume, does not check terminal-dock's docked-composer-owns-focus rule. Fixing it requires threading tabId/paneKey through ResumeTerminalVisibilityArgs and HideTerminalVisibilityArgs, which none of those call sites currently carry -- a refactor whose blast radius (multiple signatures in a file with its own large regression suite) was disproportionate to the T10 task budget. The 3 more clearly-scoped focus call sites in TerminalPane.tsx (mobile-restore x2, middle-click paste x1) were guarded instead.
- **Estimated effort**: M
- **Priority**: P3
- **Proposed owner**: terminal-dock feature owner

## DEFER-2: terminal-dock-pane-state.ts (localStorage) left unwired; unified-tab record used as sole source of truth

- **Status**: RESOLVED 2026-08-20 — superseded by the client-local fallback wiring. The module now has ten production importers and four live roles: resolved fallback plus write-through (use-terminal-dock-local-fallback.ts), the agent latch surviving renderer remounts (terminal-pane-dock-agent-latch.ts), the provisional-to-host tab-id rekey at handoff (web-session-tabs-sync.ts), and teardown/prune eviction. `removeTerminalDockPaneKeys`, recorded below as having zero callers, has two. Do not delete the module: old hosts silently drop the unknown dock field, so it is what keeps dock state across a reconnect.
- **Deferred**: 2026-08-14
- **Why deferred**: terminal-dock-pane-state.ts exposes readTerminalDockPaneState/writeTerminalDockPaneState/removeTerminalDockPaneKeys (localStorage-backed, no synced-settings write) but T10 wires the dock exclusively off the unified tab's terminalDockByPaneKey record + setTabTerminalDockState/pruneTerminalDockPaneKeys (store-backed, host-mirrored), per the task's explicit contract wording. removeTerminalDockPaneKeys therefore still has zero callers after T10, same as before. If the localStorage module was meant to be the primary/fallback source (its own module comment claims the settings-write-avoidance rationale), a follow-up should either wire it in or delete it as dead code -- worth a design decision, not a T10-scope call.
- **Estimated effort**: S
- **Priority**: P3
- **Proposed owner**: terminal-dock feature owner

## DEFER-3: Session-option surface is rebuilt per host render, so a commit can land on an orphaned record

- **Deferred**: 2026-08-18
- **Session context**: fixing the dock composer's effort pill reverting to the value Claude's startup frame last painted
- **Why deferred**: `useNativeChatSessionOptions` memoizes the whole surface on its inputs, so any dep change (canSend/passthrough flip, pty swap) builds a new surface with a new record while an in-flight `setOption` still holds the old one. The commit then writes only the orphan (and the shared scope cache), leaving the rendered snapshot stale until the next rebuild. Stabilizing the dock's screen reader plus the report gate closes the path that made this fire on every render; the remaining window needs the hook to keep one surface per scope and feed it changed inputs instead of rebuilding — a larger refactor than this fix warranted.
- **Estimated effort**: M
- **Priority**: P3
- **Proposed owner**: terminal-dock feature owner

## DEFER-4: NativeChatComposer.tsx and native-chat-runtime-send.ts stay large seams instead of Tier-2 forked copies

- **Deferred**: 2026-08-20
- **Session context**: restructuring the branch onto the fork-ownership manifest introduced by origin/main
- **Why deferred**: both files are rewritten rather than extended by the fork (+184/-345 and +174/-249 against v1.4.184), which AGENTS.md tiers as a forked copy behind an import-swap seam. Doing that pulls the closure they reach into the fork directory too — composer state, types, attachments, send lifecycle, interactive send, picker dispatch and state, typed insertion, pending, the two card components — roughly twenty modules whose upstream changes would then have to be replayed by hand at every sync. Both are declared registration seams with recorded residual budgets instead, which is how origin/main already treats comparable diffs (WorktreeList.tsx at +184/-26). Revisit if upstream's composer stops moving, or if the fork's composer diverges far enough that the replay cost is paid anyway.
- **Estimated effort**: L
- **Priority**: P3
- **Proposed owner**: agent-composer feature owner

## DEFER-5: Local panes show "No terminal session" instead of "Connecting…" during the deferred-attach window

- **Deferred**: 2026-08-23
- **Session context**: fixing the dock composer stuck on "No terminal session" while the pane above was live
- **Why deferred**: connectPanePty defers spawn/attach a frame past mount (pty-connection.ts:9330-9331), so the dock's first render legitimately reads a null pty id. resolveTerminalDockDisabledReason has a 'connecting' phase for exactly this, but only the remote transport emits onRecoveryStateChange (remote-runtime-pty-transport.ts:439) — the local IPC transport never does, so a local pane falls through to the null branch and reads "No terminal session" for that window. Correct copy needs a connecting signal from the local transport, which means a new seam in pty-transport.ts (zero divergence from upstream today) or synthesizing the phase in fork code from mount-vs-bind timing. The stuck-state bug this session fixed is closed either way; this is only wrong wording during a sub-second window.
- **Estimated effort**: M
- **Priority**: P3
- **Proposed owner**: terminal-dock feature owner

## DEFER-6: Evaluate whether focused handoffs open transcript references

- **Deferred**: 2026-08-24
- **Session context**: implementing customizable session handoffs with focused context as the default
- **Why deferred**: Quirky has no cross-platform signal that a receiving agent opened the referenced transcript. The approved design excludes runtime instrumentation and requires a periodic live-agent evaluation with a synthetic transcript fact instead of a CI check.
- **Estimated effort**: M
- **Priority**: P2
- **Proposed owner**: session-handoff feature owner

## DEFER-7: Branch-age filter from git committerdate

- **Deferred**: 2026-09-09
- **Session context**: designing the sidebar workspace activity window (recency filtering)
- **Why deferred**: the activity clock the filter uses is Quirky-side (`lastActivityAt`/`lastVisitedAt`); a branch's real commit recency is captured nowhere. `repo-base-ref-search.ts:36-42` builds a `for-each-ref --sort=-committerdate` argv but its `--format` only captures refname, so the date is used for git's own sort order and discarded. Adding it means a new capture plus a sidecar cache, because `user-data-path.ts:29` records that anything refreshed on a poll cycle must not live in `quirky-data.json` — that is why `githubCache` was moved out. It is also N/A for folder workspaces and unreachable on a disconnected SSH host, where `docs/reference/ssh-execution-boundary.md` requires the verdict be `unverifiable` rather than stale. Revisit once someone wants "this branch hasn't moved in 90 days" as distinct from "I haven't worked here in 90 days".
- **Estimated effort**: M
- **Priority**: P3
- **Proposed owner**: workspace-activity-window feature owner

## DEFER-8: Dirty/uncommitted-changes filter needs a sidebar-wide git status sweep

- **Deferred**: 2026-09-09
- **Session context**: designing the sidebar workspace activity window (recency filtering)
- **Why deferred**: `gitStatusByWorktree` (`editor-git-slice.ts:27`) is populated lazily and keyed off `activeWorktreeId` — every reader is active-workspace-scoped (`use-worktree-context.ts:42`, `use-checks-panel-controller-state.tsx:65`), so there is no sidebar-wide dirty signal to filter on. `fork-dirty-branch-indicator` does not supply one either; it is a right-sidebar source-control icon override. PR/CI state is the counter-example that already works this way (`refresh-sweep-actions.ts:70` sweeps every worktree, prioritized by `lastActivityAt`), so that sweep is the pattern to copy — but it costs real IPC per workspace and a round trip per remote workspace on SSH hosts.
- **Estimated effort**: L
- **Priority**: P3
- **Proposed owner**: workspace-activity-window feature owner

## DEFER-9: Fold the activity-window hidden count into a single visibility pass

- **Deferred**: 2026-09-10
- **Why deferred**: computeActivityVisibility (src/renderer/src/components/sidebar/fork-workspace-activity-window/compute-activity-visibility.ts:16) runs computeVisibleWorktrees twice on every recompute — once filtered, once with the activity context stripped — purely to derive the hidden count, including the sort and lineage-ancestor injection both times, on a path that also re-keys on agentStatusEpoch. Folding the count into one pass changes ancestor-reinjection semantics, so it is not a mechanical refactor and was out of scope for the review-fix pass. Found during /code-review high --fix on branch zpyoung/project-filters (reviewer finding 10).
- **Estimated effort**: M
- **Priority**: P3

## DEFER-10: 60 upstream files carry undeclared ledger edits that the next sync reverts

- **Deferred**: 2026-09-12
- **Session context**: fixing the failing checks on PR #55 (typed project and group ledgers)
- **Why deferred**: the `fork ownership guard` does not block a fork edit to an upstream-owned file, so PR #55 is green with 60 upstream files modified but declared in neither `seams` nor `exceptions` in `config/fork-ownership.json`. Per `AGENTS.md`, an undeclared edit is reset to the upstream tag at the next sync and silently reverted — `src/shared/top-level-view.ts` (the `'ledger'` member of `TopLevelView`), `src/main/runtime/rpc/core.ts`, `src/renderer/src/store/types.ts`, and `src/shared/keybindings/definitions-core-1.ts` are representative. Declaring them means ~60 new seam entries with verbatim `lines` plus a `residuals` budget each, which is a large change unrelated to the failing checks and has its own seam-integrity failure modes. Regenerate the list with `git diff --name-only --diff-filter=M <base> HEAD`, intersected with `git ls-tree -r --name-only <upstream tag>`, minus the declared seam and exception paths.
- **Estimated effort**: L
- **Priority**: P2
- **Proposed owner**: project-ledger feature owner

## DEFER-11: AskUserQuestion suppression does not reach SSH-remote Claude launches

- **Deferred**: 2026-09-11
- **Session context**: wiring tech.md C6 so the suppression gate actually feeds launch composition
- **Why deferred**: the verdict is a version read of the binary the launch will run, and for a remote launch that binary lives on the far host. Main can only run fixed relay RPCs there (`mux.request('preflight.detectAgents', …)`), so probing `claude --version` needs a new method — a wire-compatibility change that has to be capability-negotiated per `docs/reference/remote-wire-compatibility.md`, because an older host silently drops what it does not know. A remote launch therefore resolves to `'pending'`: no flags injected, no captured command stripped, byte-identical to today. The gate already keys SSH hosts by provider identity (`AskGateHostKey`), so the remaining work is the probe channel plus threading the explicit verdict at the launch sites that know their connection id.
- **Estimated effort**: M
- **Priority**: P3
- **Proposed owner**: ask-question-tool feature owner
