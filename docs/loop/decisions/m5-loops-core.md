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

## Progress
Design combined spec and shared type contracts written. Next commit contracts, create three isolated component worktrees, dispatch implementers against immutable types, audit results and integrate, then run required affected gate and actual API/CLI smoke. Dependency is ready; no pending merge required before implementation. Single focused scout completed; no research swarm. No source implementation yet.
