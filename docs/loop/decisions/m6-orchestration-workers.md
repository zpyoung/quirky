# m6-orchestration-workers decisions

## D1: Preserve the complete combined worker scope
- **Question:** brainstorming purpose, consumers, primary behavior, acceptance and scope
- **Options:** start/done only; lifecycle/fleet only; both parts of the queue item
- **Chose:** both parts: worker admission/placement/launch/readiness/preamble/observations/receipts, terminal and background structured workers, report/heartbeat settlement, low-level dispatch/show, stop/abandon/exit/retry/retain/release/takeover/output/fleet.
- **Why:** the item explicitly makes each part's exclusions local to that part. Coordinators and workers consume the daemon API and generated CLI. Success requires source flow coverage and proof of safe resource ownership, not merely a launch stub.
- **Evidence:** queue.ts wait --lane 9, m6-orchestration-workers title; orchestration.md Starting a worker through Fleet projection, Low-level dispatch, The worker side, The injected preamble; docs/roadmap.md:43-53,216-228
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** queue scope is explicitly changed
- **Source:** locked by docs/loop/queue.json

## D2: Apply the current unattended night-mode workflow
- **Question:** brainstorming approval, gray areas, research and specification format
- **Options:** ask a person; autonomously resolve all relevant gray areas
- **Chose:** API/CLI/Data/Integration domains; select response/output, authentication/identity, flag/error/recovery, idempotency, placement/mode/data mapping and lifecycle conflict areas. Answer every question from source and locked decisions; no ask, visual companion, adhd, external research swarm or separate spec review. One markdown logic.md with a final technical section, self-reviewed against every in-scope source flow.
- **Why:** nobody watches the lane and the authoritative loop explicitly selects these defaults.
- **Evidence:** git show build/roadmap:docs/loop/LOOP.md Night mode and Answering a skill's questions; docs/roadmap.md When a milestone is done
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** loop workflow changes
- **Source:** locked by docs/loop/LOOP.md

## D3: Reuse the orchestration core rather than create a second authority store
- **Question:** architecture alternatives and durable lifecycle ownership
- **Options:** extend the lazy core plugin and its transactions; separate worker plugin/database; in-memory worker supervisor
- **Chose:** extend quirky.orchestration with focused worker modules and its existing core store/receipt/identity seams. Public session/agents/structured/worktree/terminal/status APIs own runtime effects; no private cross-plugin imports. Commit shared worker contracts before implementers.
- **Why:** task/report/worker/resource settlement must be atomic with core DAG/mailbox state. A second database creates split authority; memory loses recovery state. The feature is one public built-in plugin.
- **Evidence:** m6-orchestration-core D3-D12,D15,D28-D29 and src/contracts.ts, src/runtime-contracts.ts on build/m6-orchestration-core; docs/architecture.md:308-324
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** core contract cannot express required transactional settlement
- **Source:** locked by docs/loop/decisions/m6-orchestration-core.md

## D4: Treat absence and timeout as uncertainty, never destructive authority
- **Question:** errors, liveness, recovery and outcome precedence
- **Options:** fail or close on timeout/missing status; preserve unknown outcomes and require exact evidence
- **Chose:** start_unknown/stop_unknown/release_unknown or pending recovery on ambiguous effects; only exact incarnation and owned custody authorize close. worker_done can settle an unproven start but stale/wrong-process/stopping reports cannot settle current work. No heartbeat-based automatic stop or retry. No worktree/setup/coordinator/unrelated terminal deletion.
- **Why:** the source's central safety rule is absence is never proof.
- **Evidence:** orchestration.md:312-389,655-724; m6-orchestration-core D4,D6,D11
- **Reversibility:** hard
- **Confidence:** high
- **Revisit if:** new positive runtime evidence supports a transition
- **Source:** locked by research/orca-features/orchestration.md

## D5: Use stable Quirky sessions with independently attested incarnations
- **Question:** identity, aliases, process reuse and lifecycle authentication
- **Options:** copy Orca handles; trust client metadata; stable Quirky session plus kernel attestation
- **Chose:** stable session IDs and the prerequisite's kernel-verified launch/structured lease authority. User takeover is real user input only, not injected preamble/terminal replies. Custody is recorded at terminal creation and transferred on settled-terminal reuse.
- **Why:** stale IDs and remounted sessions are not authority. Metadata or provider conversation IDs alone cannot prove process ownership.
- **Evidence:** m6-orchestration-core D4,D15 and src/runtime-contracts.ts; orchestration.md Caller identity and authority, Terminal resource ownership
- **Reversibility:** hard
- **Confidence:** high
- **Revisit if:** public attestation contract changes
- **Source:** locked by docs/loop/decisions/m6-orchestration-core.md

## D6: Keep schema-generated namespaced CLI and explicit structured fallback receipts
- **Question:** response shape, output, flags, mode and exit codes
- **Options:** reproduce Orca envelopes; native Quirky RPC/schema-generated orchestration CLI
- **Chose:** native results and documented kebab-case verbs/flags normalized at the existing CLI adapter. worker-start exits nonzero unless ready; worker-stop nonzero on stop_unknown; release/retain nonzero on release_unknown. Terminal default follows Quirky launch settings; background structured worker when selected and supported, with requested/preferred/effective mode and explicit fallback reason. No visible chat-tab product, per locked background-only architecture.
- **Why:** one API/CLI convention avoids duplicate conventions and hides no unsupported mode or uncertain outcome.
- **Evidence:** m6-orchestration-core D5; docs/architecture.md:302-303; orchestration.md CLI reference, Worker modes
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** existing public launch settings expose a different documented mode choice
- **Source:** assumed — autonomous

## D7: Bound output and fleet pages without manufacturing liveness
- **Question:** output mapping, pagination, errors, stale data and next actions
- **Options:** unbounded live reads; bounded source-pinned output and snapshot fleet
- **Chose:** transcript auto-selection only with exact provider-session evidence; labelled terminal fallback, explicit fallback reasons, frozen output before release, opaque source-bound cursors. Fleet pages at most100 over a pinned snapshot, default caller Run scope, live/exited/unverifiable with documented evidence reasons. Literal nextAction argv never prescribes destructive action for unverifiable status.
- **Why:** output remains inspectable after close and concurrent fleet changes cannot silently skip rows or imply dead workers.
- **Evidence:** orchestration.md:374-389,703-706
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** a source change requires cursor migration
- **Source:** locked by research/orca-features/orchestration.md

## D8: Implement early against current dependency branches, not the stale preparation gate
- **Question:** dependency execution and merge conflicts
- **Options:** wait without implementation; merge current dependency branches and implement now
- **Chose:** merge build/m5-structured-runner before build/m6-orchestration-core where transitive dependency conflicts require composition, implement now, merge subsequent dependency updates before final tests, wait for queue deps ready only before landing. Current m5 cc631cf already composes accounts with native structured runners; resolve conflicts preserving both.
- **Why:** current authoritative LOOP forbids ending merely because an early dependency remains pending. Prior core D13,D16-D27 are expressly superseded by core D28.
- **Evidence:** current LOOP Night mode early steps1-4; queue status m6 core lane1 and m5 lane12 in progress; initial core merge conflicted in structured files, cleanly aborted before retrying current m5
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** dependency is blocked or its public contracts change
- **Source:** locked by docs/loop/LOOP.md

## D9: OpenAI implementers and verified Gemini independent review
- **Question:** SDD backend preflight and maximum dispatch width
- **Options:** omp tasks plus Opus; omp tasks plus reachable Gemini fallback
- **Chose:** IMPLEMENTER=omp-task, AUTHOR_FAMILY=openai, REVIEWER_ALIAS=gemini; at most three implementers with disjoint scopes and external worktrees. One final review round and blocking fixes under night mode.
- **Why:** opus and sonnet have no authenticated shipping model; Gemini resolves google/gemini-3.1-pro-preview:high, Flash google/gemini-flash-latest:medium. Codex openai-codex/gpt-6.1-sol:medium and Terra openai-codex/gpt-5.6-terra:high are reachable but same-family reviewers.
- **Evidence:** iteration3 pi-watch --check for all six aliases, from /tmp; no model prompt run during preflight
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** actual review dispatch fails
- **Source:** assumed — autonomous

## D10: Verify macOS now; preserve explicit cross-platform work
- **Question:** platform scope and runtime test safety
- **Options:** add Linux/Windows lifecycle branches; portable macOS implementation with deferred verification
- **Chose:** macOS tests with fresh temporary QUIRKY_HOME/HOME and deterministic provider fixtures, terminating every owned daemon/process. Linux/Windows exact-process close, agent readiness, structured support and user-input takeover need separate verification. No writes to real ~/.quirky, ~/.claude or ~/.codex.
- **Why:** platform and test-isolation constraints are locked; fixtures must drive real daemon APIs rather than claim provider availability.
- **Evidence:** docs/roadmap.md:282-287; LOOP Hard rules and Verify
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** another platform is authorized
- **Source:** deferred: platform

## D11: Reserve service coordinator APIs to lane11 without forged sessions
- **Question:** priority cross-lane coordination for headless Heimdall service Runs
- **Options:** forge runtime session evidence for plugins; add a distinct owner-Run coordinator principal
- **Chose:** a genuine CoordinatorEvidence union for worker start/control with kernel-validated service pluginId/runId; preserve RuntimeCallerEvidence for actual worker reports/heartbeat. Lane11 owns serviceRunCreate/Show, serviceWorkerStart, serviceCheck with positive question rows, serviceWorkerRelease/Stop and serviceReply after dependency merges. Explicit run/placement and exact expectedIdentity stop guard; no synthetic coordinator session or authority casts.
- **Why:** PluginContext.call supplies kernel plugin identity but no session attestation. Headless coordination is valid authority distinct from worker process ownership; conflating them would violate core D4/D15.
- **Evidence:** lane11 priority interjections; lane1 confirmation in /tmp/quirky-lane11-orchestration-service-reply.md; src/worker-contracts.ts CoordinatorEvidence/WorkerControlParams. Lane1 owns the after-commit message-arrived event; worker hooks do not conflict.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** service ownership or mailbox generation cannot be represented without false process provenance
- **Source:** assumed — autonomous

## Progress
Iteration3 claimed this new early item. Requirements and locked decisions read; core contracts researched. Initial core merge was aborted cleanly to merge latest transitive structured dependency first; conflict-resolution implementer is working only on conflicted paths. No worker feature runtime code or acceptance claim yet. Next: finish prerequisite merges, write combined logic/technical spec, commit contracts, dispatch at most3 implementers, exercise complete API/CLI acceptance and visible custody scenarios, merge dependency updates, final targeted suite/scripts/typecheck and independent review, wait deps ready and queue-controlled landing. Do not revive the old preparation-only dependency gate.
