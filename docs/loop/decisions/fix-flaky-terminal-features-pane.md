# fix-flaky-terminal-features-pane decisions

## D1: SC-38 raced the pane's replay input gate, not shell startup
- **Question:** which timing assumption explains the macOS-only pane suite's intermittent failure without generating CPU load?
- **Options:** stress the Mac until a flake recurs; infer a timeout increase from the flake timestamps; recover a real failure and control the suspected asynchronous boundary.
- **Chose:** recover the archived suite output, trace the gate, and hold one real xterm replay parse barrier in a throwaway probe over the actual headless window, daemon and PTY.
- **Why:** `flakes.log` records timestamps and paths only. Archived session `01a17fad-4589-702d-a3e2-1437211e238e` records SC-38 timing out after 30000ms waiting for `the paths at the prompt`, while the other four cases passed; all five passed on the runner's isolated retry. The mounted report and `focusTerminal()`'s 20ms sleep do not establish replay completion. `writeReplay()` mutes input until the parser callback; `sendInput()` refuses input while muted. SC-38 alone dropped immediately after focus, whereas the other cases first waited for terminal output or round trips.
- **Evidence:** `plugins/quirky.terminal/test/e2e-ui/features-pane.test.ts` SC-38; `features-support.ts` `firstPane` consumers, `focusTerminal`, `waitForScreen`; `src/window/pane/TerminalPaneView.tsx` `sendInput`, `onDrop`, attach; `src/window/pane/replayGate.ts:23-30`; `src/window/pane/kittyGraphics.ts:263-304`. Controlled probe exit0/21.43s: held replay, prevented drop, zero writes, prompt condition false; released replay plus parsed shell marker, same drop produced exactly `'/tmp/a b.txt' /tmp/c.txt`, prompt matched, temporary home removed. No stress load or historical suite rerun.
- **Reversibility:** easy (test synchronization only)
- **Confidence:** high for the reproduced race; the timestamp-only flake log cannot establish that every historical failure had this cause
- **Revisit if:** a later SC-38 failure reports a different boundary after the parsed-marker wait
- **Source:** assumed — autonomous, from logged failure and deterministic boundary evidence

## D2: Synchronize SC-38 on real shell output parsed by its own xterm
- **Question:** fix the test's readiness assumption or change product input queuing during replay?
- **Options:** extend the focus sleep/deadline; queue human input during replay; wait for a shell-computed sentinel in the same pane before dropping.
- **Chose:** run `:` through the real daemon/PTY harness, extract its shell-computed completion marker, and wait for that marker in the window's xterm before dispatching the drop. Preserve the real prompt echo, escaped-path and no-Enter assertions. Remove the unrelated fixed 300ms post-drop sleep: delivery is already observed, and exact emitted bytes establish that no newline was sent.
- **Why:** shell readiness predates window attachment. A host-only marker wait is insufficient; the window buffer must have parsed the marker too. Reuse the existing marker convention used in SC-34 and `E2eHarness.run`. Keep the product's replay query-reply suppression intact rather than introduce a new input policy to accommodate an unrealistically early synthetic event.
- **Evidence:** `plugins/quirky.terminal/test/e2e-support.ts` `run`, `screen`; `plugins/quirky.terminal/test/e2e-ui/features-pane.test.ts` SC-34 and SC-38; feature doc `term-ui.md` file drop behavior. Throwaway controlled-boundary probe used the same marker sequence successfully.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** attachment/replay scheduling stops preserving marker parse order or the scenario needs to cover intentional input during replay
- **Source:** assumed — autonomous

## D3: Keep verification scoped and macOS-only under build-first rules
- **Question:** which checks are allowed before landing this fix item while feature construction remains active?
- **Options:** run the pane suite repeatedly or generate CPU contention; run all affected tests despite build-first; preserve the acceptance test and run only typecheck plus a narrow real-path scheduling probe required by the coding contract.
- **Chose:** no permanent suite runs, review rounds, dogfood campaign or stress workload. Use a single real window/daemon/PTY at a time with a fresh temporary QUIRKY_HOME and guaranteed cleanup, then run `bun run typecheck`; queue landing owns its merge-result gate.
- **Why:** authoritative `build/roadmap:docs/loop/LOOP.md` says write tests but do not run suites until `m7-test-triage`, typecheck is the gate, and an in-progress item lands at its next step. Higher-priority coding instructions require an exercised real path before completion. The probe controls callback scheduling, not host load.
- **Evidence:** authoritative LOOP `Build first, test at the end`; current item title; observed probe cleanup `homeRemoved:true`. LSP status reports no configured servers. Read-only scout traced the same readiness boundary; no implementer or review process remains running.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** the queue enters the end phase and assigns actual suite failures
- **Source:** locked by docs/loop/LOOP.md; assumed — autonomous for focused smoke design

## Progress

Root cause identified from historical output and reproduced through a deterministic real replay barrier. SC-38 now waits for a shell-computed marker in the actual pane before its drop. Product behavior and timeout budgets are unchanged. Initial probe failed module resolution only, cleaned its home, then the corrected probe exercised both boundary states successfully. Pending: single roadmap catch-up and incoming decision read, fresh post-edit real-path smoke and typecheck, commit, detach, canonical queue land, scratch cleanup. No permanent suite/review/dogfood pass is claimed.
