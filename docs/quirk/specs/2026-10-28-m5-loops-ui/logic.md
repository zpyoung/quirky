# Loop setup, rail and tab lifecycle

## Status & amendments
Status: Approved autonomously under LOOP.md; technical spec requested by the execution complexity gate (UI/plugin/tab-host boundary and more than three files).

**Amendments:** 2026-10-28: initial specification. 2026-10-28: clarify settled output ownership after browser proof: fresh-session cleanup intentionally removes the live session and journal, so settled fresh/ended views show labelled saved iteration output from the loop's durable evidence. Live journal errors remain visible; no session-deletion or cleanup contract changes. No human decision requested.

## Purpose and conceptual model
A person starts a daemon-owned background loop from the workspace tab strip, watches its native structured session and evidence, and adjusts its next iteration without owning the worker lifetime. The loop's durable API snapshot is authoritative. A hosted loop tab is a view, not a PTY or an interactive chat. Closing a view does not implicitly stop execution.

Consumers: desktop/web users, and agents driving identical declared commands through the API/CLI. Success means every scenario below works through declared daemon or window APIs and in the visible web surface. Workspace/tab focus and view state remain daemon-readable.

## Scope and non-goals
Both queue parts are included: New loop dialog and plus-menu entry; full rail/header/controls, queue editor, iteration list/detail, and close-running-loop dialog with detach. Core scheduling, queue policy, checks/evaluators, CLI lifecycle semantics and native structured runtime are supplied by m5-loops-core and m5-loops-presets, not reimplemented here. Sidebar glyph/mobile labels/native notification delivery, new shortcuts, terminal loop agents and interactive chat are not added by this item.

## Key decisions & rationale
Use a quirky.loops UI module and the existing public hosted-view tab API. Grow the generic public tab-plus menu slot rather than hard-code a loops dependency into the terminal plugin. Render the bounded structured journal read-only beside the rail; do not mount the interactive structured input view. Alternatives rejected: a global panel disconnected from its workspace (loses tab/close parity); hidden PTY workers (violates architecture); direct shell DOM access (violates public plugin boundary).

Output follows loop lifetime: running/needs-you and continued paused conversations use the public structured journal; a settled fresh or ended loop uses its published iteration output tail, labelled as saved output. This preserves actual output after normal native-session cleanup without retaining live children, altering destructive close semantics, or masking errors for a live conversation.

## Decisions locked
- Layout/information density: setup has a name/prompt left pane and settings right pane, maximum width1080px, fits smaller windows. Loop journal and rail are side-by-side at host width720px or more, stacked below it when narrow.
- Loading/empty state: valid visible loading, no-agents, unavailable-loop and empty history states. Advanced starts collapsed each setup opening; edit starts collapsed. Do not silently choose an unavailable agent or pretend a failed load is an empty success.
- Interaction: controls call the same public lifecycle APIs; all UI-only opening, editing draft state, selecting iteration and close choices have declared commands. Save is disabled for unchanged/invalid edits; pending requests disable duplicate submissions.
- Errors: preserve form/draft and current tab on failure, show the server message; failed create reports “Could not start the loop.” Failed close reports “Could not update the loop, so the tab stays open.” Missing loop capability hides the menu and does not break other tabs.
- Defaults/validation/labels follow fork-loops.md, except product naming is Quirky and the loop output surface is structured per architecture. Cost is never fabricated from tokens; show only measurable readings, or configured cost cap with unavailable text.
- Session and focus: fresh/continue reflect native structured session policy. A successful start opens its hosted loop tab in the background; neither later native relaunches nor snapshot refresh steals focus. Cancel/Keep running never closes a session. Stop loop explicitly calls stop-now before removing the tab.

## Behavior & scenarios
Each scenario's walkthrough is its acceptance flow; resulting UI state and daemon state must agree.

### U01: Discover setup and cancel
Before: workspace selected with active tab A. Open tab-bar plus, after agent settings choose “Loop…”. New loop dialog opens for that workspace/group with empty prompt/name, Until done, Fresh, max10, no-progress on and Advanced collapsed. Empty prompt shows “Enter a prompt to start the loop.” and disabled Start loop. Cancel closes only the dialog; A and running sessions are unchanged. Reopen resets Advanced collapsed. No new keyboard shortcut or workspace context-menu entry.

### U02: Presets, defaults and queue draft
Before: empty setup. Agent selector contains installed/enabled native-supported agents, configured default first; first selected automatically. Choose interval: Run every30minutes, Counted from End of the last iteration, Continue. Change to Queue: Continue; empty queue shows “Add at least one prompt to the queue.” Add ONE and TWO, edit TWO, move above ONE, remove ONE; remaining edited body becomes the first queue item. Blank edited body shows “Queue prompts cannot be blank.” Start-over checkbox controls repeatQueue. Preset changes reset Session to the new default, not unrelated caps/check settings.

### U03: Advanced fields and numeric boundaries
Before: setup prompt exists. Expand Advanced: check command, evaluator condition, optional active-minutes/cost caps, protected-path lines, no-progress, checkpoint commits, ask-before-next and resume-at-reset. Only entering check reveals timeout300 and run-when every-iteration/on-claim. Iterations/interval/minutes must be whole numbers>=1 when set; optional empty caps mean no limit. Timeout1..600 and positive finite cost; exact errors “Enter a whole number of at least 1.”, “Enter 1 to 600 seconds.”, “Enter an amount above 0.” Disable Start/Save while invalid. Folder workspace hides checkpoint commits; setup cost only local Claude/Codex, edit cost only existing measurement/cap. Hidden stale settings must not produce unsupported behavior.

### U04: Create, warning, failure and focus defect regression
Before: active tab A. With another running/needs-you loop in the same workspace show “This workspace already has a running loop. A second loop edits the same files at the same time.” Allowed second loop. Start valid Until-done, interval and queue configurations through public create. Name is explicit trimmed input, else first prompt line cut48chars, else preset label. On success dialog closes, snapshot updates and one background hosted tab appears without switching A. The first iteration executes natively. On failure preserve draft, display error and no fake success tab. Later fresh session replacement keeps A active (regression for documented Orca focus jump).

### U05: Observe durable loop state
Before: hosted loop tab selected. Header shows name, state pill Running/Needs you/Paused/Completed/Stopped, or Unverifiable for unreachable host; preset and agent; running phase text, status strip and n/max progress (uncapped count when no cap), last check and optional time/cost meters. All listed pause reasons map to feature-doc text, including cap/no-progress/protected-path/blocked/decision/crash/usage/restart/unverifiable/ask/queue exhausted. Details show pauseDetail, pending blocked/decision, next scheduled time, skipped ticks and warnings. No unknown cost is rendered as $0. Transcript shows the current session journal without a send composer. Event/reconnect refreshes cannot overwrite newer state or change tab focus.

After the fresh loop pauses at its cap and its session is removed, reopening the loop still shows the genuine saved output of the matching finished iteration. It does not issue a journal read for a removed live session. This saved-output projection is distinct from a live journal and makes no claim about current child-process liveness.

### U06: Pause and resume cap
Before: running loop. Pause requests after-iteration hold, not interruption. At cap pause show “+ [5] iterations” and accessible “Iterations to add”. Change to1 and Resume: cap rises by1 and next attempt runs. Invalid zero/fraction does not call API. Resume only paused; ended loops show history but no lifecycle controls. Request failures retain visible state and show reason.

### U07: Stop and steer
Before: active loop. Stop opens “Stop the loop”: After this iteration / Now / Cancel. Cancel changes nothing; after-iteration/now pass the correct mode, terminal Stopped removes controls without erasing history. Steer opens “Guidance for the next iteration”, nonblank Send queues one note and closes without success toast; Cancel changes nothing. Server failure preserves note. Real next iteration prompt includes sent note once.

### U08: Edit configuration
Before: paused/running loop. Edit displays current name/prompt or queue repeat, pacing, session, caps and Advanced. Save disabled unchanged. Change prompt, pacing/session/check/limits/protected paths/toggles, Save updates next-iteration configuration through partial edit; omitted nested sections are preserved, explicitly cleared sections remove only requested settings. Cancel discards draft. Queue prompt cannot be set via repeat editor; agent/workspace/preset are not mutable. Server failure retains draft. Saving an edit is exercised, not only opening it.

### U09: Live queue editor
Before: queue ONE(in-flight), TWO(pending), THREE(done). In-flight row shows “In progress” and no edit/move/remove controls. Pending/done rows permit move up/down, edit Save/Cancel and remove; add “Describe the next task” appends nonblank item. Moving THREE above TWO preserves identities and dense order; editing its body changes actual next delivered task. API races that make a row in-flight fail safely and refresh authoritative rows without losing unrelated draft. Done items keep controls.

### U10: Iteration history and detail
Before: completed attempts with pass/fail/no-check and evaluator evidence. List every retained finished attempt with #n (attempt disambiguation), check badge, measured +added/-removed and duration. Click opens “Iteration N”, outcome/duration/cost/changes/check output/errors/evaluator verdict+reason/output tail. Missing diff/cost/check remain unavailable, not zero/pass; empty check output has no fabricated output. Back closes detail without touching loop. Read older retained history through iterations API, not just snapshot50.

### U11: Close live tab, detach and failure
Before: running or needs-you loop hosted tab. User close opens “Close a running loop?” and names loop. Cancel retains tab/session. Keep running closes tab but leaves loop/child alive and discoverable, future fresh iterations still execute. Reopen through declared command restores view. Stop loop calls stop(now), closes only after success; error keeps tab and shows exact close error. Paused/ended close does not prompt/stop. Bulk/lifecycle closes do not open this dialog and do not stop loops. Public daemon close guard must not allow a script to bypass running-loop choice unintentionally; explicit detach/stop API flow authorizes tab removal.

### U12: Scriptability, lifecycle and responsive rendering
Before: connected daemon/window. CLI/API can open setup, read draft/validation/fields, change draft/queue, start/cancel, open loop, select iteration and choose all rail forms and close choices. ui.state reports visible dialog/rail/detail/close state and workspace tab layout truth. Disable plugin removes menu/overlay/view implementations safely; loop core owns worker cleanup. At widths below720px rail stacks; wider rail sits beside read-only journal. Reconnect rehydrates and old async responses/unmount cannot mutate active UI.

## Industry insights
No external research swarm: LOOP.md names feature doc, roadmap and existing decisions as research. Existing hosted view closeMethod and closeCommand contracts supply the loop-neutral lifetime mechanism; core D2/D19 require native structured background execution and focus preservation.

## Deferred ideas
None. All scoped UI flows above are required; runtime/core/presets responsibilities remain in their dependency items rather than being silently deferred here.

## Glossary
Loop: daemon-owned repeat/interval/queue execution. Hosted tab: workspace view with no session ownership. Rail: loop status/control/history beside or below output. Detach: remove the view binding without stopping execution. Attempt: retry of an iteration number, distinct history identity.
