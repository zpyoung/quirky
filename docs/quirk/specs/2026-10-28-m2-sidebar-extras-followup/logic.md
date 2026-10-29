# Sidebar extras parity completion

## Purpose

Complete the seventeen acceptance scenarios in [the original logic spec](../2026-10-27-m2-sidebar-extras/logic.md#behavior--scenarios), including its recorded blur defect and deferred aging, runtime freshness, corrupt-preference and guarded-web checks. This is an end-phase parity item, not a redesign.

## Conceptual model and data flow

Repository/group and worktree plugins remain canonical owners. Sidebar extras reads their public APIs and runtime facts, stores client-local presentation preferences, and projects visibility. Worktree UI consumes this projection and writes guarded canonical membership. Activity-item contributions display active-worktree dirty status independently of the open panel. No presentation action changes Git ownership, paths or terminal execution.

## Key decisions & rationale

Extend the existing implementation rather than replace it. A new projection/store or sidebar would duplicate working behavior. Verification-only documentation would leave concrete gaps: drag currently ignores grouping mode and membership menus ignore owning-repository kind. Repair those boundaries, reuse existing tests, and add regressions only for consumer-visible gaps. Use explicit rolling-window labels, not calendar-sounding Today/Week/Month. Preserve the original technical contract's absent-optional-provider and non-main unknown-liveness semantics rather than treating an audit hypothesis as a confirmed bug.

## Decisions Locked

- **Visibility/error:** failed available runtime providers cannot prove sleeping; report unknown and retain unselected non-main rows under the existing technical contract. Optional MethodNotFound sources contribute no fact; they are distinct from failed enabled providers. Main-workspace retention follows the default-branch exception. Fresh positive runtime evidence may prove liveness even if another provider fails. Stale agent display or retained layout alone cannot prove liveness.
- **Organization/interaction:** loose membership requires both a Git worktree and a Git owning repository. Folder-owned rows use project actions. Membership drag is permitted only in Project grouping; manual sibling reorder remains independent. Same-group drops are no-ops and current hit geometry decides the target.
- **Activity/data:** rolling inclusive cutoffs, selected-workspace retention, a quiet-list reevaluation within sixty seconds, positive-safe-integer custom days, strict corrupt-preference hydration, separate session-lived departures and persistent client-local preferences remain unchanged contracts.
- **Visual:** labels are All, Live only, Past 24 hours, Past 7 days, Past 30 days, Custom. Custom accepts Enter and blur. Dirty status and separators preserve their existing public contribution/settings contracts.
- **Scope:** review filters, stock sidebar redesign, cross-host transport and OS-native behavior remain with their existing owners. Existing review/automation filters must continue composing; do not remove them. The approved 2026-10-28 UI redesign governs host placement if its shell changes land; preserve public contribution behavior, not the obsolete top-tab-row layout.
- **Execution:** autonomous answers under LOOP.md; no human asks. Triage is claimed, so normal tests, guarded web verification and bounded review apply. Use OpenAI omp implementers and Gemini review after actual Opus reachability failure.

## Behavior & scenarios

The original SC-01 through SC-17 are incorporated without narrowing. The examples and outcomes remain in the original spec; this table names the completion evidence required here.

| Criterion | Completion evidence |
|---|---|
| SC-01 create one group | Cancel/create web dialog plus canonical guarded create API; only selected worktree moves. |
| SC-02 move/remove | Menu and API moves, project move independent of membership, omission preserves membership and restart preserves it. |
| SC-03 lineage/placeholders | Group parent, retain child, return parent, then divert all rows; nesting restores and empty owning project remains. |
| SC-04 drag | Project join/current-group no-op/own-project leave; header wins overlap; unrelated repo and non-Project grouping cannot mutate membership. |
| SC-05 group lifecycle | Ellipsis rename/collapse/delete with retained-ledger preview; cancel preserves state; subtree deletion releases worktrees without deleting Git state. |
| SC-06 guards | Folder workspaces and Git-shaped rows owned by folder projects never offer/attempt membership; missing group falls back, parent cycles normalize. |
| SC-07 async identity | Delayed create cannot overwrite replacement filesystem identity, including zero birthtime, or concurrent membership. |
| SC-08 controls | All six labelled choices, one non-All badge, Custom default30, clear resets All. |
| SC-10 liveness | Fresh terminal/structured/agent/runtime facts retain rows; stale facts do not; failed enabled providers retain unknown non-main rows; optional absent providers contribute no fact; folder bypass and default exception compose. |
| SC-09 aging | Inclusive boundary, creation/repo/visit/departure fallback, selected retention; quiet time advances without store event and row ages out within60s. |
| SC-11 validation | Invalid0/negative/fraction/text/unsafe values on Enter and blur preserve prior custom days; valid3 commits; malformed/invalid stored data hydrates safely. |
| SC-12 recovery | Activity-only hidden count includes Git/folder rows, remains reachable when empty and clears only activity filtering. |
| SC-13 client state | A→B departure does not invert visit order; restart clears exits not preferences; clients isolated; legacy hide/show restores remembered week/custom. |
| SC-14 dirty | Active only, separate staged+unstaged rows, untracked, cap floor, excluded lazy submodule rows, clean/missing status clear decoration. |
| SC-15 races | Closed-panel refresh; selection change rejects stale response; no-active clears; contribution disable/unmount cancels timers. |
| SC-16 separators | Persisted Appearance toggle, first/nested/sticky/host exceptions, unchanged geometry and drop targeting. |
| SC-17 scripting | Real public API/CLI and mounted contributions; disable/override does not break core operations; JSON readback matches visible behavior. |

## Recorded defects

The observed Orca Tab/blur discrepancy is fixed by validating/committing on blur, not copied. Folder silent-revert, asynchronous replacement/regroup, and group-cycle hazards remain invariant regressions, not claims of reproduced Orca failures. Missing source verification for drag, old rows, restart and client isolation is not permission to omit them.

## Scope & non-goals

All seventeen scenarios and the predecessor's nonblocking parity findings are in scope. No new provider transport, mobile UI, native window behavior, screenshot-review system, generic observability or retry framework. Use existing runtime public facts; do not fabricate browser or remote liveness. No compatibility shims or private cross-plugin imports.

## Industry Insights

Reuse original grounded research: [React derived state](https://react.dev/learn/you-might-not-need-an-effect), [Git worktree ownership](https://git-scm.com/docs/git-worktree), and [viewport hit testing](https://developer.mozilla.org/en-US/docs/Web/API/Document/elementFromPoint). This continuation adds no new architectural approach requiring an external research swarm.

## Deferred Ideas

None. Existing separately owned review-filter/remote/native/redesign work is not duplicated here.

## Glossary

- Unknown liveness: available evidence cannot prove live or sleeping; preserve visibility and report unavailable source.
- Loose membership: presentation-only projectGroupId, distinct from repo ownership and folder groupId.
- Guarded web: real built daemon UI driven through the unattended web user workflow, with separate API evidence for unrepresentable race/clock conditions.

## Status & amendments

Status: implementation and affected-package verification complete. All seventeen original scenarios retain their API/CLI and renderer coverage; guarded reports and the quiet-clock observation limit are recorded in the decision log (D22/D34). The operator waived the extra final-review pass in D39 and directed immediate canonical landing after the affected tests.

**Amendments:** 2026-10-28 — initial continuation; approved redesign placement takes precedence over old header-placement details, without removing public activity behavior.
