# Until-done loops: engine, completion and safety

## Purpose
Run a repeated task as a durable daemon-owned background agent, with independently verified completion and bounded safety holds. Consumers are the `quirky loop` CLI and public `quirky.loops/*` methods; closing a client must not stop a loop.

## Scope and non-goals
Both parts of m5-loops-core are included: engine/lifecycle plus checks, evaluator, markers, evidence, protected paths, no-progress, checkpoints, caps, reset resume and notifications. Until-done only. Queue/interval presets, loop setup/rail/sidebar/mobile UI, tab binding/reveal/detach controls and remote-host execution are non-goals of this item, not partially implemented options. Unknown presets fail validation. Native banner rendering remains the existing notifications plugin's responsibility.

## Conceptual model and data flow
A loop owns immutable identity/workspace/provider and editable configuration, a structured session binding, durable steer notes and iteration attempts. The daemon starts one driver per running loop. A driver creates or reuses a structured conversation, waits for external user input to be quiet and for the agent to be idle, atomically sends one iteration prompt, observes turn status and approval asks, gathers evidence and applies a pure ordered decision. Snapshots and finished attempts survive restart. Restart always pauses active loops and closes unfinished attempts as interrupted; it never silently resumes them.

Background execution uses native Claude/Codex structured runners, not terminals, as required by docs/architecture.md:145-178. Session ID replaces Orca's tab/pane/PTY identity. No UI navigation is performed. Fresh replaces the provider conversation after each finished iteration and retries crashes in a new conversation; continue reuses its live conversation. Restart resume of continue uses the existing provider-native resume API, never pretends a fresh conversation is continued.

## Key decisions & rationale
1. Recommended: a built-in `quirky.loops` plugin calling existing public worktree, structured, checks and notifications APIs. Rejected: a kernel loop scheduler (feature would not be replaceable); CLI-owned subprocess loop (dies with client).
2. Completion is never an assistant's claim alone. Configured checks/evaluator must all pass on evidence from that exact configuration. Completion retains documented precedence before protected-path and marker pauses; unsafe checkpoint writes are still prohibited.
3. External messages to a bound structured conversation count as user input. A guarded public send validates both idle state and the observed journal sequence immediately before delivery, refusing races without consuming steer notes. Unrelated UI activity does not block a background loop.
4. Missing measurable cost is unknown, not zero. A configured cost cap pauses with `usage-unavailable` after an unmeasurable settled turn. Provider-native raw result/rate-limit evidence is retained through journal messages; reset waits use explicit timestamps, never guessed times.
5. Every loop notification uses the existing notifications policy. No direct kernel notifier bypass. Focus suppression, cooldown and disabled switches continue to apply.

## Decisions Locked
- API: namespaced methods, existing daemon auth/error envelopes, complete JSON snapshots; invalid transitions conflict, absent identities not-found, invalid settings invalid-params. Newest-updated list first; last50 attempts in snapshots, history method for details.
- CLI: `loop` alias for plugin `quirky.loops`; required agent and prompt, worktree defaults current; no default cap, fresh session default, no-progress/checkpoints/ask-before-next/reset resume false. Text and JSON surfaces use existing CLI conventions. Edit changes only specified fields, replaces supplied config sections after merging current section defaults, rejects empty edits and set/remove conflicts.
- Lifecycle: pause/stop after-iteration never interrupt; stop now aborts checks/evaluation and stops the owned structured session. Ended loops cannot resume or edit. Repeated pause is a no-op. Resume only paused, clears held evidence and optionally raises the iteration cap.
- Safety: explicit line markers parsed only from the current turn's assistant output; echoed prompt and old journal entries are not marker evidence. A marker reason is bounded500characters. No-progress requires3settled comparable attempts with no changed tree and identical check results/output, or matching check evidence for nongit folders; missing all evidence never counts as no-progress.
- Data: SQLite plugin store with atomic updates and restart recovery; notes/log files under `.quirky/loops/<slug>/`. Install private git info/exclude before loop activation; never change `.gitignore`, user index, refs or stash for snapshots. Bounds: output16384characters, checks4000each, recent50, ended retention200attempts.
- Integration: approvals become needs-you, never auto-answered; after resolution observation continues. Host uncertainty holds and excludes active time; positive process exit crashes. Retry exactly once per iteration number with a new attempt/session. No-busy-edge fallback120seconds remains guarded by user idle and no pending approval.
- Platform: macOS acceptance only; portable Node/Bun APIs where practical. Linux verification and Windows process-tree termination/git path handling require separate acceptance.

## Behavior and acceptance scenarios
All listed flows are exercised through daemon plugin API or CLI; pure tests additionally target decision precedence and evidence boundaries.

| ID | Before and action | Expected after / concrete example |
| --- | --- | --- |
| L01 | Managed git workspace, no loops; CLI create with prompt and check | Running snapshot, private notes file, independently owned structured session; list/show survive the create client exiting. Example check `test -f result.txt` completes only after the agent creates it. |
| L02 | Missing/unsupported agent, blank prompt, invalid cap/check timeout or queue/interval preset | Invalid-params before starting a provider process or durable running row. Folder workspace is accepted without git snapshots/checkpoints. |
| L03 | Two live loops in same worktree | Both allowed; second snapshot includes `worktree-has-running-loop` warning. No foreground tab/focus mutation. |
| L04 | Fresh policy, two failed checks then iteration cap | Distinct structured session IDs and preamble per session, iteration headers1of2 and2of2, previous check's last40lines carried; paused cap-iterations after2settled turns. Continue uses same ID. |
| L05 | External user message arrives within20seconds or races the guarded send | No loop bytes over the external turn; wait for user quiet and idle, re-read journal sequence on conflict, retain steer notes. Loop's own message does not cause an extra20second hold. |
| L06 | Agent busy then done; approval ask appears midturn | Busy-to-idle settles only current turn; pending approval enters needs-you and emits notification, no automated answer; answering via existing ask API resumes observation. No busy edge settles only after120seconds of eligible waiting. |
| L07 | First native session exits while working; retry also exits | Attempts `(n,1)` and `(n,2)`, fresh retry, paused crashed after second; no successful iteration count from failed attempts. Unreachable evidence never masquerades as positive exit. |
| L08 | Pause/stop called during turn | Pause and deferred stop finish that turn; stop-now interrupts owned runner, cancels checks/evaluator and records stopped attempt without incrementing completed count. Paused stop is immediate; ended action conflicts. |
| L09 | Cap-paused loop, steer `use banana`, edit prompt/check, resume add1 | Durable note delivered once on actual next send, maxIterations grows from max(cap,completed)+1; new config applies next turn, stale old pass cannot complete. Missing edits conflict/invalid-params. |
| L10 | Restart daemon during running/needs-you attempt | Snapshot paused interrupted-by-restart; open attempt interrupted. Explicit resume reuses iteration number with next attempt; continue reconnects native identity through structured/resume, fresh starts new. History remains. |
| L11 | Current assistant prints LOOP_DONE, with absent check/evaluator | Does not complete; configured cap may pause. BLOCKED/DECIDE pause with bounded reason. ANSI/prefix stripped; embedded prose, prompt echo, tool text and previous turn markers ignored. |
| L12 | Check every-iteration or on-claim, evaluator or both | Exit0only without timeout/abort/error passes. On-claim requires current LOOP_DONE; every-iteration does not. Evaluator requires parsed met; with both all must pass. Failed checks feed next prompt; shell timeout kills descendants and preserves bounded tails. |
| L13 | Evaluator condition with hostile quoted evidence, missing binary, nonzero exit or malformed output | Condition/evidence delimited with random nonce; read-only/tool-disabled invocation in temporary directory,120second bound,256KiB output bound, failure returns not-met never completion. Availability validated at create/edit when done changes. |
| L14 | Files staged/unstaged/untracked/binary/deleted/renamed before/after turn | Private-index snapshots measure current worktree including untracked; real index/refs/stash unchanged. Numstat reports paths and +/- counts; unavailable diff is null, not empty. |
| L15 | Protected glob `secret/**`, trailing directory or brace/class glob touched | Pause protected-path and record exact paths unless verified completion already wins; unmeasurable git diff fails closed. Checkpoint never runs on hit/unmeasured/aborted. |
| L16 | Checkpoint enabled; agent changes owned file, unrelated pre-staged file exists | Commit only iteration-changed paths with loop name/iteration message, preserve unrelated staged content. Notes directory never committed. Folder workspace does not try git. |
| L17 | Three unchanged settled turns with identical failed check output | Pause no-progress; changed tree/check output resets comparison. Unmeasured folder without check output never triggers; measured unchanged git trees may trigger with no-check signature. |
| L18 | Count/time/cost cap reached between turns | No in-flight interruption, pause cap reason; active time excludes paused/needs-you/user-idle/unverifiable holds. Measurable cumulative session cost uses delta, unknown cost pauses usage-unavailable under cap. |
| L19 | Explicit provider usage-limit evidence with/without known reset | With resumeAtLimitReset and known reset, hold until reset+60seconds then resume automatically; otherwise paused usage-limit with timestamp/provider detail. Never infer a reset from prose or charge tokens as USD. |
| L20 | Loop completes, safety-pauses, hits cap or needs approval | Notifications policy receives Loop completed/paused/reached its cap/needs you, correct loop name/detail and stable key; disabled/focused/cooldown gates prevent bypass. User/restart pauses are silent. |
| L21 | Notes already edited, many finished attempts, driver/log failure | Notes never overwritten; bounded output/history and ended200retention; log failure nonfatal; persistence/driver failure safely pauses crashed rather than silently vanishing. |

## Orca defects and non-regressions
- Background loop creation/fresh relaunch must not change active tab/focus (fork-loops.md observed focus jump): L03/L04, proved by no UI API calls and API integration focus snapshot.
- Cost n/a is never displayed/accounted as zero, and cannot defeat max-cost: L18.
- Loop/watch notification bypass identified by earlier notifications decisions remains fixed: L20.
- A self-reported LOOP_DONE is not completion evidence: L11/L12.

## Industry Insights
Night-mode inputs are the feature doc, roadmap and earlier decision logs, not external research swarms. `m5-structured-runner` D7/D8 bind shared check execution and cancellation; `m1-notifications` D5/D37 bind all-source delivery gates; architecture background-native requirement replaces Orca's pane mechanics.

## Deferred Ideas
None added. Queue/interval/UI are separate queued slices, not new deferrals of this item.

## Glossary
Attempt: one send/observation cycle for iteration n, retrying with increasing attempt number. Settled: current native turn finished, not merely an old idle status. Evidence: bounded current-turn output, tree delta, independent checks/evaluator and usage. Hold: temporarily no prompt/active-time accrual; not terminal stop.

## Technical decisions and implementation contracts
- New plugin under `plugins/quirky.loops/`; `src/types.ts` committed first defines shared config, snapshots, attempts, evidence and decision/gather inputs. One service/driver owner, one evidence/decision owner, one CLI/API/integration owner; no overlapping implementer file writes.
- Service owns `src/service.ts`, `src/store.ts`, `src/driver.ts`, `src/prompt.ts`, related tests. It imports `EvidenceEngine` from `src/evidence.ts`, `decideNext` from `src/decision.ts`. Public lifecycle method names match the contract types. All inter-plugin operations use PluginContext.call/subscribe; no internal feature imports.
- Evidence owns `src/evidence.ts`, `src/decision.ts`, supporting `src/diff.ts`, `src/evaluator.ts`, related tests. `EvidenceEngine.snapshot(cwd)`, `validate(agent,config,cwd)`, `gather(input)`, `cancel(loopId)`, `shutdown()`; `decideNext(input)` pure. Checks through quirky.checks/run/cancel at timeout300default.
- Integration owner: main/cli/manifest/package, registry metadata/build packaging if discovery needs it, README and integration tests; atomic guarded structured/send additive fields requireIdle/expectedAfterSeq, original caller behavior unchanged. Notification event handling is added in quirky.notifications through existing policy.
- Shared declarations are signatures and data only, not placeholder runtime implementations. Driver polls existing public session/journal/ask state at1second with event wakeups; tests may inject clock/timing at service constructor, never change shipped default semantics.
- Public store API adds optional `openStore(migrations, {newerVersion:'read-only'})`; newer schemas reopen with a native read-only SQLite handle, expose `store.readOnly`, skip recovery/pruning and refuse mutations. Default schema downgrade refusal remains unchanged. This avoids a loop-specific SQLite ownership convention.
- Structured journal queries add optional SQL-bound `limit`1..1000 and `tail`; results remain ascending after `afterSeq`, with tail selecting newest entries. Existing callers without these options remain unchanged. Native provider rate-limit events retain explicit usage/reset evidence in journal data.
- Permanent tests use existing isolated daemon harness, scripted provider protocol and temp git workspaces. No real agent credentials/home modifications. Exact final commands: `bun scripts/suite.ts packages/daemon packages/protocol plugins/quirky.loops plugins/quirky.structured plugins/quirky.notifications`, `bun test scripts`, `bun run typecheck`. `queue.ts land` owns full-suite integration gate. Native-only banner appearance and OS focus are handed to `docs/loop/native/m5-loops-core.json`; no webview UI scenario is introduced.

## Status & amendments
Status: autonomously accepted after self-review under authoritative LOOP night mode. Single combined spec, no tech.md/separate spec-review. Every in-scope feature flow has L01-L21 acceptance. No human questions. **Amendments:** 2026-10-27: D13 adds opt-in read-only schema access for the explicit newer-database requirement; D14 bounds journal reads and exposes native rate-limit evidence. Native-only rendering/focus is handed to the nightly run.
