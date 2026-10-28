# Automation-domain parity sweep

## Status & amendments

Status: autonomous design approved under LOOP.md; technical specification required because the sidebar change crosses plugin boundaries. Specification review precedes implementation.

Amendments: 2026-10-28 — initial specification.

## Purpose

Close confirmed local parity gaps without replacing the shipped automation, loop or ledger engines. Account for every flow group in automations.md, fork-loops.md and ledger.md: implemented evidence, this item's acceptance criteria, or a named remaining-work owner. Completion of this sweep does not mean all deferred parity work is complete.

Reader: implementers and roadmap reviewers — Decision: distinguish behavior built here from larger gaps still owned by the queue.

## Scope

Two vertical slices ship here: dismiss automation row menus without performing an action, and show loop status on worktree cards with inspectable state. Existing feature behavior and tests remain intact. Read-only inventory is not a fresh full-feature UI verification campaign.

## Conceptual model

Definitions, runs, loops and ledger entries remain daemon-owned records. An automation menu is transient window state: closing it must not mutate a definition or navigate. A worktree's loop indicator is a compact projection of its unfinished loops, not another loop store or a terminal-status guess. One shared sidebar subscription feeds every card and its JSON report. Ended loops yield to the ordinary session glyph; unread worktrees retain their unread bell.

## Key decisions & rationale

Choose targeted extension of current plugins. A wholesale port of Orca would violate structured background execution and erase verified ownership guards. A documentation-only sweep would leave two demonstrated consumer gaps unfixed. Fetching all recent iteration output merely to draw a sidebar icon is rejected; the public loop projection must not load history, prompts, queue bodies or output tails.

## Decisions Locked

- Behavior: native and OpenClaw row menus dismiss on Escape and explicit list refresh; Escape returns focus to the menu trigger. It consumes only that menu interaction and does not open a detail, execute an action, or change list filters.
- Presentation: unfinished loops replace the normal session glyph, not the unread bell. Needs-you outranks unverifiable, then running, paused, and detached presentation. Deterministic ties choose the newest update, then stable loop ID.
- Information density: tooltip and accessible name show `Loop N/MAX · state`, or `Loop N · state` without a cap. N is completed iterations, matching daemon counters. Paused labels include the reason. The corresponding visible selection is exposed in the sidebar's JSON state.
- Error state: a disconnected or failed loop read never reports cached running evidence as currently verified. Cached unfinished indicators become unverifiable; absent/disabled loop plugin restores ordinary glyphs. Empty successful reads remove obsolete loop indicators.
- Integration: structured background sessions, no automatic terminal adoption or focus changes, no private cross-plugin imports, no hidden fallback to local/terminal execution.
- Data: snapshots and typed public method schemas remain authoritative; compact projections read only needed persistent fields. No schema migration is needed for a read-only projection.
- Platform: macOS acceptance only. Existing pending native banner/focus/menu scenarios remain native-owned, not counted as web passes.

## Behavior & scenarios

### S1: Dismiss a native automation menu

Before: a paused saved automation is visible; list selection and filters are unchanged. Open its actions, focus a menu item and press Escape. After: the menu is absent, the trigger is focused and collapsed, the list remains open, the definition remains paused, and no run/edit/delete request was submitted. Reopening proves dismissal did not disable the trigger. Explicit Refresh likewise closes it while refreshing data.

### S2: Dismiss an external automation menu

Before: a local OpenClaw fixture job is visible. Open its actions and press Escape. After: the external menu is absent and its trigger focused; no external command was executed. Refresh also closes it. Escape inside a delete confirmation remains owned by that confirmation; it must not revive the row menu or bypass its confirmation.

### S3: Show the most urgent loop on each worktree

Before: workspace A has running and needs-you loops; workspace B has a paused capped loop. After initial sidebar hydration, A shows the needs-you loop and B shows `Loop 2/2 · paused: cap-iterations`. Changing A's highest-priority loop to ended reveals its remaining running loop. Ending all A loops restores its ordinary agent/session glyph. A loop in B never changes A's indicator. An unread workspace retains its bell while JSON still distinguishes the loop projection from the actually drawn glyph.

### S4: Preserve uncertainty and lifecycle ownership

Before: the sidebar has successfully loaded unfinished loop summaries. On connection loss or failed refresh, those indicators become unverifiable. A later successful refresh restores verified state; disabling the loop plugin clears the projection and prevents a delayed older response from restoring it. Re-enabling and reconnecting hydrate again. A stale initial read cannot overwrite a newer changed event. Loading this feature never starts a provider, creates a shell/tab, adopts a background session or changes active workspace/tab.

### S5: Expose the projection through the public API and CLI

Before: two unfinished loops and one ended loop exist. The public summaries method and generated/custom CLI return only unfinished loop identity, workspace, state/reason, iteration counter/cap and minimal presentation evidence. No prompts, output, notes, queue contents, cwd or recent attempts are returned. A real daemon/window consumer shows the same chosen loop ID/count/status as its JSON report. The existing list/get/history APIs retain their contracts.

### S6: Keep the reported Orca defects closed

Existing regressions remain the acceptance evidence for timezone and DST scheduling, invalid-cron isolation, bounded OpenClaw discovery, loop focus non-adoption, unknown-cost caps, and the ledger's pinned detail footer/eager owner reconciliation. This item neither re-pins old incidental wording nor removes those tests. New sidebar/menu changes must not regress those consumer behaviors.

## Complete flow inventory

Each row covers the named feature-document sections and their edge cases; existing tests are evidence of the shipped paths, not claims of new UI runs in this item.

| Document / flow group | Current evidence or owner |
| --- | --- |
| Automations definitions, CRUD, schedule presets/RRULE/cron, timezone/DST, next/latest occurrence, grace, pause/resume catch-up | quirky.automations schedule/service/store tests; native-cli.test.ts; core D2–D5,D9–D11 |
| Scheduled/manual triggers, disabled Run Now, precheck bypass, no manual-only/event triggers | service/dispatch/cli tests and native-cli.test.ts; no new trigger types required |
| Run claim/dedupe, per-definition lanes, definition/target recheck, restart reconciliation, output/usage, retention and paging | target/dispatch/store/API/native CLI tests; structured session identity and durable run state retained |
| Existing/new-per-run workspace, trusted setup, reuse, model/effort launch snapshots | dispatch/editor/native CLI tests; dispatch D1,D6–D8,D15–D18 |
| Raw extra arguments; SSH/runtime generation fencing, pin/re-pin/re-adoption, host execution | existing m5-automations-dispatch-remote-and-args; unavailable is not implemented parity |
| Editor two panes, defaults, validation, four templates, save/edit/delete/confirmation preference | editor/list-api/ui-state tests; prior visible campaigns in automations-ui D20–D21 |
| List search, filters/pills, sorting, keyboard navigation, row actions, truthful host/loading/error/empty states | list-model/list-ui tests; S1–S2 repair row-menu dismissal |
| Detail overview/runs, history, dashboard cards/filter/search, run output/rerun/open workspace | list-model/list-ui/list-api/native CLI tests; prior visible output/navigation proof D18,D20–D21 |
| Local OpenClaw discovery/mapping/bounded file/action validation/confirmation | external tests; prior UI actions D20; S2 |
| Remote Host editor/moves/list/history/OpenClaw | existing m5-automations-ui-remote-authorities, after public remote prerequisite |
| Sidebar shortcut hide, settings reentry and preference | src/ui.tsx and ui-state/list-api tests; native app-menu scenario remains pending in native/m5-automations-ui.json |
| Automation-created workspace badge, Open automation/Open run/deleted-record states, Hide automation-created | confirmed missing durable provenance and sidebar/filter wiring; single new sweep-completion follow-up |
| Loops lifecycle/create/list/show/edit/pause/resume/stop/steer/history, defaults/strict flags | loops API/CLI/engine/store tests; structured execution and native CLI evidence in core decisions |
| Loop notes/log/private exclude, persistence/read-only rollback, restart pause, crash retry, approvals/human custody | engine/store/API tests; core D6,D8,D13,D15,D20 |
| Markers/check/evaluator/protected paths/checkpoints/no-progress/time/count/cost/reset evidence/precedence | decision/evidence/safety-api tests; no assistant-claim-only completion |
| Queue identity/mutation/claim/retry/repeat/exhaustion; interval anchors/skipped ticks/edits; ask-before-next | queue/pacing/presets API/CLI/runtime tests |
| Setup defaults/validation/queue editor, rail/history/output/steer/edit/resume and view APIs | setup/rail/ui-api/ui-form-api tests; previous visible observe/adjust/queue evidence |
| Loop visible Stop/Close choices, tool-limited setup verdict, prior final review | existing m5-loops-ui-visible-stop-close-review; not duplicated by this item's bounded review |
| Worktree loop glyph/count/state/multi-loop priority | S3–S5; confirmed absent in current Tree.tsx/status.ts |
| Mobile loop label/worktree summary integration | mobile client still in progress in sb-mobile-app; newly inventoried loop-summary composition retained explicitly by the single sweep-completion follow-up, reconcile landed mobile owner first |
| Loop notifications and native focus | notifications/test/loops.test.ts proves policy; native/m5-loops-core.json retains pending actual system banner/focus scenarios |
| Ledger five types, validation/locations, selectors/project/group/folder scope, duplicate hints | ledger.test.ts and import-cli.test.ts; all live-catalog targeting retained |
| Ledger list/show/filter/search/sort, revision history/edit/state/revert, actors/reviewed policy and concurrent conflicts | ledger.test.ts/import-cli.test.ts/window.test.ts |
| Ledger review/evidence/triage, approval/bulk confirmation/deletes/settings | ledger.test.ts/window.test.ts; exact immutable revision snapshots and containment guards |
| Ledger imports five formats, partial errors/exit1, idempotent anchors/conflicts/tombstones/equivalence | import-cli.test.ts and evidence-paths.test.ts |
| Ledger retained owners/detach/eager reattach/explicit attach/chooser/page/panel/menus/staleness/settings | ledger.test.ts/window.test.ts; m5-ledger canonically done despite historical blocker prose |
| Ledger clipped footer and delayed reattachment defects | separate scroll body/pinned footer in styles.ts/LedgerDetail.tsx; prior built browser1280×720 D19; eager owner reconciliation API tests; exact1452×1050 unverified |
| Ledger SSH-host workspace import/evidence and cross-runtime ownership routing | public Repo/Worktree has no remote-host contract; single sweep-completion follow-up after real public host routing, no local-path fallback |

## Verification

New behavioral regression tests drive the rendered components and real daemon/window APIs. A built web run uses fresh HOME/QUIRKY_HOME, seeded disabled automation and controlled loop provider fixture. Exercise S1–S4 through visible UI, not API actions during goals. Public summaries and unchanged ledger lifecycle run through real daemon API/CLI. Run affected suites for Automations, Loops, Worktree and direct importers, `bun test scripts`, and `bun run typecheck`; canonical queue land owns the full merged suite. Stop every owned process and delete temporary homes.

## Non-goals

No GitLab, Bitbucket, Gitea/Forgejo, Azure DevOps, Objective runner or PR sitter. No speculative event/webhook/file-watch triggers, manual-only schedules, background PTYs, remote impersonation or platform claims. Larger provenance/mobile/remote-ledger work is retained, not declared complete. Existing native-only handoffs and previously queued remote/UI work keep their owners.

## Industry Insights

This loop uses the feature docs, roadmap and binding decision logs as its research, as LOOP.md requires. No external research campaign was run. Relevant established patterns are current shared sidebar hydration/generation fencing and daemon-owned read-only projections.

## Deferred Ideas

One new m7-sweep-automation-completion item will enumerate durable automation workspace provenance/badge/navigation/filter, actual mobile loop-summary integration after the mobile client lands, and remote-host ledger routing/import/evidence after public host APIs exist. Existing remote automation, loop visible-review and native acceptance owners remain separate. No other confirmed gap is silently excluded.

## Glossary

- Unfinished loop: running, needs-you or paused; completed/stopped are ended.
- Projection: bounded state needed to draw an indicator; not iteration evidence or another persistent owner.
- Detached presentation: a loop continues without its hosted loop view; not an execution-state transition.
- Confirmed gap: absent behavior supported by the relevant creation contract and consumer code, or an observed failure; not merely an unexercised test.
