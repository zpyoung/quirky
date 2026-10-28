# m5-loops-core decisions

## D1: Both engine and completion safety ship together
- **Question:** scope conflict between Part1 exclusions and Part2 inclusion; brainstorming purpose/consumer/success
- **Options:** engine only; union of both explicitly enumerated parts
- **Chose:** union, Until-done API/CLI with all completion/safety evidence. No queue/interval/UI. Consumers are CLI and public plugin API; success is unattended independently verified completion with safe holds.
- **Why:** the queue title explicitly says exclusions in one part do not exclude flows named in another.
- **Evidence:** authoritative queue wait lane2, m5-loops-core title; fork-loops.md RPC/iteration/completion sections; logic.md L01-L21
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** queue scope changes
- **Source:** locked by docs/loop/queue.json

## D2: Native structured sessions replace Orca panes without changing focus
- **Question:** integration data mapping/session lifecycle and observed Orca fresh-session focus jump
- **Options:** hidden PTY tabs; native structured session binding
- **Chose:** native Claude/Codex background conversations and public structured API. Session ID is loop binding. No tab creation, focus, detach/bind/open-tab API in core item. Continue reconnects through structured/resume after restart; cannot silently become fresh.
- **Why:** locked architecture names loops among structured-only background agents. No loop UI scenarios are added; UI slice will render these durable sessions.
- **Evidence:** docs/architecture.md:145-178; fork-loops.md Session policy and pane lifecycle; observed focus defect
- **Reversibility:** hard
- **Confidence:** high
- **Revisit if:** locked architecture changes
- **Source:** locked by docs/architecture.md

## D3: Use one combined spec and self-review without research swarms or human questions
- **Question:** brainstorming workflow, domain/gray-area selection, design acceptance and spec review
- **Options:** interactive approvals plus research; autonomous night-mode combined spec
- **Chose:** API/CLI/Data/Integration domains; all relevant response/error/auth, flags/output/exit/recovery, persistence/idempotency, input mapping/retry/approval gray areas. Skip companion/adhd/research swarms and separate tech/spec review. Essential coverage established: purpose, consumer, full scope, visible behavior, locked constraints and L01-L21 success criteria. Self-review each design section and examples; accept recorded defaults.
- **Why:** authoritative LOOP night mode and no-watching rules supersede interactive skill steps.
- **Evidence:** git show build/roadmap:docs/loop/LOOP.md Night mode and Answering a skill's questions; combined logic.md
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** autonomous mode ends
- **Source:** locked by docs/loop/LOOP.md

## D4: Plugin owns policy and durable state; public APIs own shared execution
- **Question:** brainstorming approaches and organization/naming boundaries
- **Options:** built-in feature plugin calling public methods; kernel scheduler; CLI-owned loop
- **Chose:** quirky.loops built-in with loop CLI alias, plugin SQLite store, daemon-owned drivers and events, public worktree/structured/checks/notifications calls. No imports of another plugin's private implementation. `.quirky/loops/<slug>` notes/log, private info/exclude, not `.orca` product naming.
- **Why:** feature replaceability and client-independent operation are locked; existing checks runner owns shell process lifetime.
- **Evidence:** docs/roadmap.md:13-53; m5-structured-runner D7/D8; PluginContext public API; LoopSeams survey
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** public seams cannot express required behavior
- **Source:** locked by docs/roadmap.md

## D5: Preserve API/CLI observable defaults and reject unsupported combinations
- **Question:** output format, flag design, authentication, errors, exit codes and duplicate handling
- **Options:** generic JSON-only CLI; existing plugin CLI text plus JSON convention
- **Chose:** create/list/show/pause/resume/stop/steer/edit and iterations public method, strict config validation, existing auth/RPC error envelopes; not-found missing, conflict invalid transitions, invalid-params invalid input. Fresh/no caps/no-progress off defaults. Partial edits preserve omitted settings; remove/set conflicts and no-op edits rejected. Current worktree default, provider/prompt required. Second live loop allowed with warning.
- **Why:** feature doc specifies these consumer behaviors; existing CLI plugin conventions avoid a second command framework.
- **Evidence:** fork-loops.md Start a loop from CLI, Observe and adjust, Config shape; m0-core D6/D9
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** parity UI needs additional snapshot fields
- **Source:** locked by research/orca-features/fork-loops.md

## D6: Idle and approval gates fail closed at the structured send boundary
- **Question:** integration retry-policy/data mapping; human message race and status uncertainty
- **Options:** check idle then unguarded send; serialized optional guard inside structured/send
- **Chose:** requireIdle plus expectedAfterSeq under per-session send serialization, checked after provider startup immediately before send. Loop observes external user journal messages and waits20seconds; own prompt attributable by sent text/active send. Pending approval enters needs-you, never answers; unknown connectivity holds; positive exit crashes and retries once fresh.
- **Why:** only the owning structured service can serialize consumer sends and veto a stale idle check before bytes. Window activity is not input to a background session.
- **Evidence:** fork-loops.md DeliverIterationPrompt, iteration observer; quirky.structured/main.ts send; LoopSeams distinction between UI activity and per-session input
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** structured API adds finer-grained edit activity reporting
- **Source:** assumed — autonomous

## D7: Ordered independent evidence decides, never assistant claims alone
- **Question:** completion response format, stale evidence and marker trust
- **Options:** LOOP_DONE completes; independently verify all configured signals
- **Chose:** pure documented precedence stop/pause/unverifiable, crash/restart, verified completion, protected paths, blocked/decide, caps, no-progress, usage, ask-next, idle/send. Completion requires exact matching done config. Parse current assistant output only; bounded marker reasons. Every/on-claim checks via shared runner, timeout300default, evaluator every turn fail-closed isolated read-only/tool-disabled native CLI with bounded output/timeout.
- **Why:** doc explicitly never trusts LOOP_DONE alone; stale passes must not complete newly edited conditions. Current journal turns eliminate prompt echo ambiguity.
- **Evidence:** fork-loops.md Evidence, Check-command mode, Evaluator mode, Stop conditions; m5-structured-runner D7/D8
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** authoritative feature contract changes precedence
- **Source:** locked by research/orca-features/fork-loops.md

## D8: Snapshot/checkpoint safety preserves user git state
- **Question:** data input/output/error handling, idempotency, protected paths and no-progress
- **Options:** inspect status only or use real index; private-index tree snapshots
- **Chose:** private temporary index includes staged/unstaged/untracked, cleans itself, never mutates real index/refs/stash. Null unmeasured diff is not no-change. Git protected-path config plus missing snapshots pauses fail-closed. Glob semantics include trailing directories/classes/braces. Checkpoints only measured current-iteration paths, no notes/protected hits/abort, preserving unrelated staged paths. Three comparable settled unchanged turns and identical check signatures/output trigger no-progress; no evidence never triggers.
- **Why:** input repository may be dirty; false empty diff defeats safety and user index belongs to the person.
- **Evidence:** fork-loops.md Evidence, No-progress rule, Folder workspaces
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** git behavior regression test shows index corruption
- **Source:** locked by research/orca-features/fork-loops.md

## D9: Unknown USD stays unknown and reset resume needs explicit provider evidence
- **Question:** cost accounting, performance modes, usage-limit reset and caps
- **Options:** treat tokens/missing usage as USD0; read provider-native evidence and fail closed
- **Chose:** measurable provider result cumulative USD delta only, unknown null; maxCost pauses usage-unavailable on unknown settled-turn cost. Explicit usage-limit and reset timestamps govern reset+60second hold; unknown reset pauses. Count/time/cost caps checked only between turns; active time excludes user/approval/unverifiable holds. No default cap.
- **Why:** observed Orca cost n/a must not make a safety budget unenforceable, and guessed reset times would resume without evidence.
- **Evidence:** fork-loops.md Cost, Iteration limits/caps, Stop conditions; structured raw message journal
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** provider exposes normalized cost on every turn
- **Source:** assumed — autonomous

## D10: Notification producers use central delivery policy
- **Question:** notifications and Orca bypass defect
- **Options:** context.notify directly; loop event consumed by existing notifications plugin
- **Chose:** explicit loop notification event and central policy treatment, with completed/paused/cap/needs-you labels and stable key; user/restart pauses silent. No auto-answer ask or notification bypass.
- **Why:** m1-notifications D5/D37 bind all producers to switches/focus/cooldown. Native banner appearance uses existing renderer; no new native API.
- **Evidence:** docs/loop/decisions/m1-notifications.md D5/D37; fork-loops.md Notifications
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** policy plugin changes its producer contract
- **Source:** locked by docs/loop/decisions/m1-notifications.md

## D11: Build one width-three wave with immutable shared contracts
- **Question:** SDD decomposition, file ownership, model pairing and preflight
- **Options:** serialize all; three disjoint components; six small cross-dependent tasks
- **Chose:** commit spec/types first; T1 service/store/driver/prompt; T2 evidence/decision/diff/evaluator; T3 API/CLI/manifest and guard/notifications integration. One width3wave, no successor/checkpoint. OpenAI omp task implementers high; Gemini final reviewer fallback, not opus. Each component own worktree, no commits/checks during implementation; parent audits HEAD/scope and executes checks after wave. Existing `.quirk/` evidence preserved unstaged.
- **Why:** names/signatures shared first avoid cross-editing; each unit remains substantial. pi-watch --check in/tmp resolved codex/terra/gemini/flash and no authenticated opus/sonnet. No configured language servers; symbolic reads unavailable through xd://lsp.
- **Evidence:** preflight bg_2 (7/12aliasesready); xd://lsp status; LoopSeams handoff; contracts src/types.ts
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** implementer scope conflicts arise
- **Source:** assumed — autonomous

## D12: macOS-only acceptance, isolated homes and no whole-suite competing run
- **Question:** platform, feasibility and test ownership
- **Options:** claim cross-platform support; macOS acceptance and explicit deferred verification
- **Chose:** macOS build/tests. POSIX evaluator group kill, Windows task-tree cleanup and Linux runtime/git behavior need later verification. Every process uses temporary HOME/QUIRKY_HOME/provider homes and is stopped. Required affected suite, scripts, typecheck once before final review; queue land owns full-suite result. No added UI means no browser dogfood; exercise actual daemon/CLI scenario instead.
- **Why:** locked platform/night-mode rules; previous structured runner documented real-home hook risk.
- **Evidence:** docs/roadmap.md Platforms; authoritative LOOP Night mode; m5-structured-runner D10/D11
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** Linux/Windows milestone starts
- **Source:** deferred: platform

## D13: Add explicit read-only schema access without permitting downgrades
- **Question:** feature persistence requires read access to a newer loop schema, while the shared store refuses newer versions
- **Options:** duplicate SQLite ownership in loops; weaken default migration safety; opt-in native read-only handle
- **Chose:** public `context.openStore(migrations, {newerVersion:'read-only'})` and optional `store.readOnly` flag. Default openStore still refuses newer versions. Opt-in reopens the existing file with SQLite readonly, runs no migrations or mutating journal PRAGMA, and refuses write/transaction methods before callbacks. Even SQL through get/all cannot mutate. Loop recovery/pruning is skipped on readonly stores and mutations fail.
- **Why:** m0-daemon-api D10's explicit revisit condition is release rollback without data loss. The new loop requirement needs history reads on rollback, not down migrations or writes. This works within its forward-only default and protects user data rather than creating a separate persistence convention.
- **Evidence:** packages/daemon/src/plugins/stores.ts newer-version refusal; stores.test.ts new regression failed before source change, then30pass/0fail/74assertions; fork-loops.md Persistence and newer-schema edge case; m0-daemon-api D10
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** a future schema removes columns required by old readers
- **Source:** supersedes m0-daemon-api D10 (explicit read-only opt-in only; default downgrade refusal unchanged)

## D14: Bound structured journal reads and expose native rate-limit evidence
- **Question:** driver restart/current cursor queries otherwise read unbounded session history, and reset events were not journaled
- **Options:** fetch all history and slice; add optional SQL-bounded paging and native event data
- **Chose:** structured/messages gains optional limit1..1000 and tail boolean, ascending results after afterSeq; tail selects newest limited messages. Defaults unchanged. Guard queries latest1. Native rate-limit events are journaled as provider evidence; consumers do not infer reset times or USD from prose/tokens.
- **Why:** background continue sessions may run indefinitely. API-bound selection keeps loop memory bounded and makes usage-reset safety reachable.
- **Evidence:** LoopSeams survey; LoopsEngine/LoopsEvidence integration messages; structured/messages/journal.list existing unbounded result
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** structured journal adds a normalized telemetry projection
- **Source:** assumed — autonomous

## D15: Structured execution owns creating-plugin cleanup after caller revocation
- **Question:** disabling loops revokes its public call capability before deactivate can stop its provider sessions
- **Options:** bypass revocation; leave native children alive; structured owner releases registered-plugin children on plugin changes
- **Chose:** retain kernel revocation order. Structured records creating registered plugin ownership in live session state and stops only that owner's sessions/asks when the owner is unavailable. User/kernel-created sessions are unaffected. Loop shutdown remains best-effort and daemon structured shutdown remains the final process owner.
- **Why:** m5-structured-runner D13/D19 already establish ownership cleanup rather than weakening revoked capabilities. A background loop must not keep editing after its owning plugin is disabled.
- **Evidence:** packages/daemon/src/plugins/runtime.ts revocation contract; structured-runner D13/D19; integration acceptance disable-loop scenario
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** plugin lifecycle gains a pre-revocation cleanup phase
- **Source:** locked by docs/loop/decisions/m5-structured-runner.md

- Persistence coherence inventory: all existing openStore callers in packages/plugins/apps/scripts were enumerated. Existing plugins and runtime/lifecycle/store API tests keep one-argument behavior unchanged; only loops opts in. Optional readOnly does not require fake store writers to add a field.

## D16: Retain core seams for the early presets dependent
- **Question:** lane5's early m5-loops-presets item has merged the committed core types and needs a stable engine integration point
- **Options:** implement presets in core; change the core contract speculatively; retain current core contracts and publish completed source
- **Chose:** retain shared types and until-done-only core scope. Lane5 owns additive queue/interval configuration, queue items, skipped ticks, queue mutation and decision payloads on its own branch. Publish audited complete engine/store/driver/service source after this wave, not partially written workers.
- **Why:** the priority user interjection explicitly assigns presets to lane5 and asks core to retain current contracts. Disjoint branch ownership avoids competing implementations.
- **Evidence:** current user interjection; shared contracts95383d97; agents notified
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** dependent integration identifies an incompatible seam
- **Source:** assumed — autonomous

## D17: Publish an audited source checkpoint while the combined gate is red
- **Question:** priority lane5 request to overlap dependent integration with core verification
- **Options:** hold source until all checks pass; publish explicitly unverified audited checkpoint
- **Chose:** publish the HEAD/scope-audited worker source checkpoint, with initial fixture/import/manifest admission failures disclosed. Keep the core item in progress; no landing or completion claim. Continue engine repairs and full affected verification on this branch; dependent lane merges later fixes before its gates.
- **Why:** lane5 explicitly requested a committed audited checkpoint and will not copy live worker trees. All original component workers returned and scope/HEAD audit passed at95383d97; checkpoint source is the frozen staged wave, not an in-flight worker copy.
- **Evidence:** /tmp/quirky-m5-loops-run.0VUATs/wave-audit.json; first integrated gate68pass27fail; plugin admission diagnostics identify invalid CLI positional names/descriptions
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** dependent lane needs a changed engine contract
- **Source:** assumed — autonomous

## D18: Apply the night-mode completion fast path after the repair gate
- **Question:** the item passed ninety minutes before final discovery/dogfood started
- **Options:** start a new cross-family review campaign; finish repairs and required checks, then land under the night-mode override
- **Chose:** finish the assigned flows and safety regressions, run the affected suite, scripts, typecheck and actual CLI/native-protocol smoke, then land. Do not start the prepared but unstarted final-review campaign or a webview dogfood pass. No review PASS is claimed.
- **Why:** authoritative LOOP night mode says to stop starting flows at ninety minutes and skip unstarted review/dogfood for overdue items once their own tests/typecheck pass. There is no new web UI surface; native-only focus/banner scenarios remain pending in the nightly handoff.
- **Evidence:** last recorded clock22:48after approximately21:15–21:20claim; /tmp/quirky-m5-loops-run.0VUATs/review.py was staged but never executed
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** a blocking defect remains after the required checks
- **Source:** locked by docs/loop/LOOP.md

## D19: Background structured sessions do not auto-adopt terminal panes
- **Question:** the full built-in set logged terminal layout repair for loop-owned structured sessions, despite the background-only contract
- **Options:** let reconciliation add/focus a terminal tab; keep structured sessions out of terminal auto-adoption
- **Chose:** terminal reconciliation adopts only terminal sessions. Explicitly existing panes remain governed by their existing bindings; structured background sessions never add a pane or change the active tab.
- **Why:** the failing regression showed activeTab changing from tab-3 to tab-102 on a background Codex session. That reproduces the observed Orca focus defect in the actual shared layout seam, not in the loop plugin's own calls.
- **Evidence:** layout-reconcile.test.ts new background-session regression failed before source change (artifact63); after source change26tests/0fail/80assertions. Native focus appearance remains pending in the nightly scenario.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** a future explicit structured-session viewer needs a separate opt-in view contract
- **Source:** locked by docs/architecture.md

## D20: Repair concrete integration races rather than slow or weaken the fixtures
- **Question:** the first integrated implementation exposed real lifetime/state defects and several malformed fixtures
- **Options:** extend waits/change synchronous runner scheduling; repair ownership, settlement and section semantics
- **Chose:** retain the adversarial synchronous fast-turn provider fixture. Fix persisted own-prompt attribution, deferred settled-edge observation, resume-versus-driver-cleanup, waiting-before-ask approval holds, active-time flushing, initial measured USD totals and Codex reset evidence retention. Public history excludes open attempts. Supplied edit sections replace whole; CLI preserves omitted nested settings by reading current config. Shutdown escapes pending RPC waits without leaving unhandled promises; late-created sessions retain cleanup ownership.
- **Why:** the same real daemon initially stayed working after its provider finished, then reached cap-iterations after the race repair. Native CLI smoke proved3iterations with distinct fresh sessions, claim-only non-completion, steer/edit/check/resume, unknown-cost pause, and actual app-server PID termination. These are runtime observations, not worker claims.
- **Evidence:** observe.ts before/after bg13/bg15; native smoke bg19 NATIVE_LOOP_CLI_SMOKE_PASS; integrated target gate104pass8fail before final repairs. Fixture fixes include missing brackets/imports/directories, real Git notification workspace, correct steering regex, and removal-or-exit process postconditions. External Git-filter cancellation waits for its actual readiness file; its own post-abort bound remains5seconds, with a15second outer fixture watchdog.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** the final required gate or actual native smoke fails
- **Source:** assumed — autonomous

## D21: Keep condition deadlines intact and wait for actual cleanup barriers
- **Question:** the final targeted gate had138passes and3failures: one assertion raced session cleanup and two notification tests hit the framework watchdog before their existing condition watchdog
- **Options:** weaken consumer assertions; wait for the actual close event and make the outer fixture budget cover its condition deadline
- **Chose:** the engine test waits on Runtime's session-removed event until every owned session closes, then retains the cleanup assertion. Notification per-condition watchdogs remain10seconds; outer fixture budgets include daemon/Git setup and teardown (15seconds,30for the two-loop case). No production timeout, polling, cooldown or notification assertion changes. Removed incidental preamble-wording assertions.
- **Why:** paused state publication is intentionally before asynchronous cleanup, so the observed state is not a resource-release barrier. The isolated notification completion passed in3.49seconds, while the loaded five-second outer guard tore down a still-valid10second condition wait. The repaired two-file gate passed24tests/0fail/97assertions in30.32seconds without unhandled errors.
- **Evidence:** bg21/artefact69; isolated completion bg24; repaired engine+notifications bg25/artefact73; native smoke bg23 passes3iterations and actual process termination; frozen tsc bg22 exit0
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** a condition itself times out or a cleanup barrier is never reached
- **Source:** assumed — autonomous

## Progress
Audited source checkpoint e0582785 published to early presets lane. All implementation/fix workers are now frozen; original worktrees removed, tool-only metadata preserved in named stashes. Source repairs and public safety acceptance tests are ready to commit. Targeted gate138pass/3fail was followed by the repaired engine/notification gate24pass/0fail; native real CLI smoke passes and TypeScript is clean. Next: commit repair tip and notify lane5, catch up once with build/roadmap, read incoming decisions, run required affected suite/scripts/typecheck, then authoritative queue land. No final model review was started; D18 records the night-mode skip. Native-only checks remain pending, not falsely passed.
