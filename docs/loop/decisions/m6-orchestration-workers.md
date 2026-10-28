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

## D12: Keep supervisor ownership epoch distinct from kernel process epoch
- **Question:** exact report/heartbeat/output evidence during implementation review
- **Options:** compare kernel caller epoch to the worker factory UUID; persist the actual attached identity epoch separately
- **Chose:** WorkerRecord.runtimeEpoch owns supervisor restart/in-flight operations; processRuntimeEpoch starts null and is stamped from actual SessionIdentity at attachment. Exact process proofs compare that kernel epoch and incarnation, never a fabricated equality.
- **Why:** the two epochs answer different questions. Comparing them rejected valid reports; ignoring them entirely could hide an authority mismatch.
- **Evidence:** lifecycle.ts isExactCaller review; worker-contracts.ts processRuntimeEpoch; corrected lifecycle23pass/110assert and output-fleet23pass/159assert with deliberately distinct fixture epochs
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** restored authority supplies a new independently proven kernel epoch for the same incarnation
- **Source:** assumed — autonomous

## D13: Separate read-only identity from destructive custody
- **Question:** live settled reclaimability, user takeover inspection and exit precedence
- **Options:** require owned custody for every read; independently prove the current process while guarding close separately
- **Chose:** same-current-owner user_owned/external workers remain readable and can prove liveness; transferred/released attempts remain archive-pinned. Owned succeeded/failed workers are reclaimable even while their agent stays live. Positive exact/certified exit outranks an earlier fresh working row. Live source cursors permit append but reject consumed-content rewrites.
- **Why:** takeover prohibits cleanup, not inspection. Settlement, liveness, content continuity and custody are independent facts.
- **Evidence:** orchestration.md:364-389; output/fleet corrections and actual23pass/159assert component run. First run exposed undefined fallback variable; fixed both auto and cursor paths. Removed a new incorrect show.terminalState assertion rather than add a nonexistent response field.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** public source-pinned output changes its continuity contract
- **Source:** locked by research/orca-features/orchestration.md

## D14: Replay durable completed requests before asynchronous preflight
- **Question:** how to refuse new invalid placement without invalidating an accepted replay
- **Options:** validate before the ledger; perform ledger replay/mismatch checks before a beforeAccept callback
- **Chose:** core mutation wrapper checks caller-bound replay/mismatch first, then runs asynchronous beforeAccept, then synchronously accepts Task/Dispatch/Worker/checkpoint in one transaction; process effects remain afterCommit.
- **Why:** a changed catalog or workspace cannot convert a completed exact replay into a new refusal or second launch.
- **Evidence:** WorkerStart interface finding; requested core DurableMutationOptions.beforeAccept in msg_57e61cdf00b0; AC19
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** the core implements a different equally atomic caller-bound replay fast path
- **Source:** assumed — autonomous

## D15: Distinguish a driving worker brief from an idle-mailbox pointer
- **Question:** whether the mailbox pointer seam can safely carry every initial worker preamble
- **Options:** reuse Cursor no-Enter nudges unchanged; make initial driving intent explicit in the exact-incarnation durable submit seam
- **Chose:** explicit worker_start driving purpose, provider-safe submit plan and full admitted brief size; preserve mailbox-only Cursor no-auto-Enter behavior. Runtime owner must confirm and publish the actual seam; no raw-write fallback.
- **Why:** the coordinator requested a new worker turn, not merely a hint to an idle agent. Treating all Cursor starts as unknown because the wrong API withheld Enter would not implement the launch flow.
- **Evidence:** core D10; orchestration.md:325-327,502-524; WorkerStart runtime seam question; msg_cd979e5c17f6
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** the existing public runtime submit already proves the required driving semantics for every supported provider
- **Source:** assumed — autonomous

## D16: Synchronous explicit input guards, not deferred generic write events
- **Question:** first-key custody, query replies and deactivation safety
- **Options:** treat PluginPty.onInput as human; emit an asynchronous PluginEvents notice; guard explicit physical input synchronously before bytes
- **Chose:** public reportUserInput/onUserInput/lastUserInput PTY seam and exact-incarnation terminal/userInput. Renderer onKey/custom keys/paste/drop/IME intent claims custody before its bytes; plain onData query replies and injected prompts do not claim. Positive early input evidence is reconciled at custody creation.
- **Why:** PluginPty.onInput hears programmatic writes, while PluginEvents schedules setImmediate and cannot fence cleanup before the first key.
- **Evidence:** packages/daemon/src/plugins/events.ts:62-70; pty-api.ts and terminal input changes; actual before smoke returned unknown terminal/userInput in a private home. After-change full runtime proof remains pending.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** a public input-origin hook provides stronger ordering with less machinery
- **Source:** assumed — autonomous

## D17: Apply the aged-item landing rule without claiming unperformed review
- **Question:** whether to begin a new final review or formal dogfood campaign after the item's two-hour boundary
- **Options:** start new campaigns; follow the current LOOP override for already-aged items
- **Chose:** finish real worker behavior, affected tests, scripts, typecheck and required runtime/UI smoke; do not start a new formal adversarial-review round or using-apps dogfood campaign. D9's verified cross-family pairing is retained as preflight evidence, not represented as a review that ran.
- **Why:** the authoritative night-mode rule explicitly skips review/dogfood not yet started for an aged item. Higher-priority actual-surface verification still applies to the input change; focused smoke is not a full dogfood pass.
- **Evidence:** lane9 iteration claim and spec commits on2026-10-27; actual API Run.createdAt2026-10-28T02:23Z and later, beyond the two-hour item boundary; current LOOP Night mode. Only doctor/goals preparation ran, no review dispatch or dogfood begin.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** the operator changes the night-mode override
- **Source:** locked by docs/loop/LOOP.md

## D18: Read the enforced core depth policy, not an undeclared setting
- **Question:** every actual terminal start failed after authority attachment when building the preamble
- **Options:** suppress the setting lookup exception; declare a mutable ordinary setting; expose the actual read-only core policy
- **Chose:** nestedWorkerMaxDepth is a read-only core getter used by admission and preamble generation, default1. Removed the nonexistent getSetting call and duplicate fallback helper. No ordinary RPC setting can raise a worker's own cap.
- **Why:** actual receipt said no setting setting:quirky.orchestration/nestedWorkerMaxDepth after a real session, custody and authority had been created. A new mutable setting would diverge from the current core cap and the source's caller restrictions.
- **Evidence:** artifact://152 full receipt line7; Core admission MAX_NESTED_DEPTH and worker starter; getter/adapter/fixture updates
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** the separately-owned settings flow adds an authorized persisted policy through this single core getter
- **Source:** assumed — autonomous

## D19: Complete the canonical Codex structured catalog cutover
- **Question:** native worker preflight refused a provider that already has an app-server runner
- **Options:** add another worker provider table; update canonical model/effort mapping and remove obsolete Claude-only restriction
- **Chose:** Codex model maps to structured.model and effort to structured.effort in the existing catalog. Structured eligibility consumes that public metadata rather than a stale Claude-only condition; the real native test requests gpt-5.6-luna/high and inspects actual app-server wire values.
- **Why:** AgentsService.optionsInfo derives structured support from the model mapping. Source inspection then found an additional agentId != claude hardcode in both worker placement paths, so catalog data alone was insufficient.
- **Evidence:** actual API gate artifact://154 native refusal, followed by the isolated native ready/report/release/archive smoke in D24. The current native API case reaches the real held turn with gpt-5.6-luna/high; its separate transport-replay defect is addressed by D27.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** a public structured provider registry replaces catalog-declared capability
- **Source:** assumed — autonomous

## D20: Preserve durable acceptance for destructive worker controls
- **Question:** actual stop/release rolled back with post-commit checkpoint required
- **Options:** relax the core ledger invariant; provide the existing truthful Worker acceptance checkpoint for scoped controls
- **Chose:** stop and release persist run/task/dispatch acceptance in the same transaction as their requested state before asynchronous identity/archive/close effects. Method-specific receipts still distinguish stop, release and start.
- **Why:** a crash between acceptance and close must remain inspectable without replaying an uncertain effect. No new ledger or fake process evidence is needed.
- **Evidence:** before-change actual API gate artifact://157 and core mutate guard; after-change actual private CLI stop returned stopped/closed_agent_terminal, while accepted completion plus release froze a readable terminal archive before exact close. The visible human-owned terminal and coordinator remained live.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** the core introduces a richer typed control checkpoint without losing atomic acceptance
- **Source:** assumed — autonomous

## D21: Read structured authority from its genuine kernel lease registry
- **Question:** real native deferred session existed but placement could never obtain its identity
- **Options:** fabricate worker identity; poll terminal-only getter; include the actual current structured lease in the kernel identity getter
- **Chose:** the kernel identity getter reads the live structured registry entry with current epoch/session/source checks. No worker-side identity fallback, copied token or status-based attestation; no unnecessary public lease identity field.
- **Why:** the private runtime probe returned placing_unknown/no live runtime identity with no native requests or messages. Source inspection found openStructuredLease already owns the exact real identity, while the current getter consulted terminals only. Waiting cannot make an omitted registry branch appear.
- **Evidence:** isolated raw native probe before and after the genuine getter fix; after it, ready/input_accepted, one native model/effort turn, exact real child report, guarded release and archived read all succeeded. Existing runtime-authority.test.ts also covers the real structured lease lifetime.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** structured lease ownership/liveness changes in the public kernel contract
- **Source:** locked by core D4/D15

## D22: Recover a source overwrite narrowly and preserve unrelated metadata
- **Question:** an implementer accidentally replaced contracts.ts with tool-request JSON during investigation
- **Options:** broad checkout/reset; restore the single corrupted file after exact blob checks and preserve all other work
- **Chose:** paused both affected workers, cancelled the offending task, preserved the129-byte payload/incident record outside the repo, and restored only contracts.ts from verified current HEAD81db1e70 baseline blob3ef7cf7185eaf4cc7f3c400c29dd5f2d1564ab46. No reset/clean or unrelated metadata removal. Further Serena/MCP calls are excluded for this continuation.
- **Why:** the corrupt blob4e4ef3b84f852b09d8d8bf7cd4e0fafe6520ccef was exact-matched immediately before recovery; other in-scope changes remained intact. Invocation-versus-routing root cause is not independently established.
- **Evidence:** /tmp/quirky-workers-lane9.3G1efn/contracts-overwrite-incident.json and contracts-overwrite-payload.json; restored941lines/27363bytes before the subsequent intentional checkpoint comment edit.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** a later diff identifies additional incident-attributable damage
- **Source:** assumed — autonomous

## D23: Create worker tabs atomically without stealing focus, and pin the task label
- **Question:** the actual built UI changed coordinator selection to the new worker and hid the meaningful Task title behind provider OSC
- **Options:** restore the prior selection after the fact; mutate layout storage; create through the public serialized terminal/newTab activate:false path and use public renameTab
- **Chose:** extend that existing public tab path with canonical model/options launch picks and explicit session title, then create fresh terminal workers with activate:false. After real custody exists, rename the exact returned tab to the meaningful worker Task title. Structured and external/reused user tabs keep their existing behavior.
- **Why:** restoring focus would race real user selection and allow transient theft. The existing layout transaction already preserves active group/tab/recent; customTitle already has documented precedence over OSC without changing generic title semantics.
- **Evidence:** before-change private UI changed selected tab-3 to tab-7 and rendered only the provider OSC title. After-change dedicated private UI retained tab-3 on both starts and visibly rendered Worker: Visible takeover worker; exact stop left the coordinator and human-owned tab alive. Editor was disabled through its public API for this scoped proof; D29 records the default-profile limit.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** the public session creation path gains an equally atomic explicit background-tab contract
- **Source:** locked by orchestration.md placement/focus and meaningful-title behavior

## D24: Treat provider-acknowledged native turns as distinct from queued user journal input
- **Question:** a held native turn has no assistant/tool/result yet, despite a genuine successful turn/start response
- **Options:** count every user message; wait for assistant text; recognize the existing native acknowledgement under exact fresh lease/thread/input checks
- **Chose:** only a fresh Codex user journal entry whose exact prompt, turn/start or turn/steer receipt, current provider thread and current lease match is positive native turn evidence. The producer appends it only after validating the real server turn ID. Generic Claude user journal entries remain insufficient.
- **Why:** a held acknowledged native turn has started even before generating output. Requested status or unacknowledged queued input is not that fact.
- **Evidence:** codex-runner.ts submitInput295-320; actual isolated native probe reached ready/input_accepted with one gpt-5.6-luna/high turn, exact child report, guarded release and archived read. Runtime submission re-attests the exact incarnation after observation.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** the provider-neutral public turn observation API exposes equivalent typed acknowledgement evidence
- **Source:** assumed — autonomous

## D25: Preserve actual UI custody proof without claiming a formal dogfood pass
- **Question:** how to verify the renderer's physical-input safety under the aged-item rule
- **Options:** rely on fake pane tests; start a new formal dogfood campaign; exercise the changed real built surface directly
- **Chose:** built the real UI/desktop, opened a private managed headless Chromium tab against the private daemon, clicked the worker terminal and typed physical keyboard input. Custody changed owned→user_owned/retained before release. The actual child reported completion; coordinator release returned retained/processAction:none; the same process stayed alive and accepted more visible input. Browser and all private processes were cleaned.
- **Why:** this proves the renderer→identity→synchronous guard→actual process path while respecting D17. Initial attachment/query traffic left custody owned. The D23 focus/title defects were subsequently fixed and re-exercised in the explicit profile described in D29.
- **Evidence:** final screenshots omp-sshots-15b77e5cf53fa0f5.png and omp-sshots-15b77e701d7fa0f6.png show physical input still working after retained release and exact stop of another worker. Private browser/profile, daemon, PTY host and providers were cleaned.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** physical input or custody ordering changes
- **Source:** assumed — autonomous

## D26: Reconcile interrupted worker state through the shared core transition
- **Question:** a real daemon crash recovered the Worker as start_unknown but left its Task dispatched
- **Options:** weaken the API assertion; update Task separately; run epoch reconciliation through the same core-authorized lifecycle transaction
- **Chose:** lifecycle initialization registers its real worker port before reconciling interrupted attempts. The shared core transition projects unknown Task state atomically with Worker state and metadata; the obsolete repository-only transition path is removed rather than retained as a second convention.
- **Why:** uncertainty must block the Task without falsely settling its pending Dispatch, fencing a valid exact report, creating a second process or resubmitting input.
- **Evidence:** private daemon SIGKILL/restart regression artifact://215 failed with dispatched instead of blocked. After the lifecycle cutover, that unchanged assertion and no-duplicate-resource/input replay case passed in the subsequent 13-file API gate; only the separately identified replay/archive/test-contract cases failed there.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** runtime reconciliation gains another equally atomic shared lifecycle entry point
- **Source:** locked by worker AC6/19 and core lifecycle authority

## D27: Give worker mutations fresh transport IDs and stable logical IDs
- **Question:** exact logical worker-start replay returned mutation.replayed:false
- **Options:** rewrite the response marker; bypass the durable receipt; align worker CLI transport IDs with the existing core CLI
- **Chose:** every worker CLI mutation sends a fresh outer randomUUID while preserving ctx.requestBase as params.requestId. Read calls remain unchanged.
- **Why:** the kernel transport cache previously returned the first response before the logical worker ledger could evaluate replay or mismatch.
- **Evidence:** native and unknown-start API replay failures, followed by an actual private child-CLI replay with replayed:true, the same Dispatch and unchanged worker input. No receipt flag was fabricated.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** the kernel separates logical mutation IDs from transport IDs itself
- **Source:** locked by core D11 and the existing core CLI replay convention

## D28: Freeze the visible terminal screen as well as scrollback
- **Question:** release archived an empty string while the worker's output remained on-screen
- **Options:** accept empty history as the whole terminal; fabricate capture success; combine the real bounded public screen read with paged history
- **Chose:** validate the public PTY read shape and combine its visible lines with bounded scrollback before close. Invalid reads remain unavailable and genuinely empty content remains empty.
- **Why:** terminal/history excludes the live screen. A quiet short worker can have visible output without any scrollback.
- **Evidence:** actual archive failure in the public API gate, then a fresh private runtime preserved ARCHIVE_SENTINEL9 after exact release with archived:true/source:terminal. Programmatic sentinel input kept custody owned.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** the public terminal snapshot API offers the same complete bounded text directly
- **Source:** locked by archive-before-close and output provenance requirements

## D29: Keep the UI verification profile and default-profile failure explicit
- **Question:** the merged default profile hit an editor activation timeout and shared-browser driver hangs
- **Options:** claim a whole-app pass; change editor or worker safety behavior; isolate the target through supported private-profile controls
- **Chose:** record the observed editor timeout as a typed integration issue in BLOCKERS.md, then disable that optional plugin through public plugin.disable in a fresh private profile and use an owned dedicated Chromium process. No worker behavior or authorization was bypassed.
- **Why:** this exercises the real terminal renderer and kernel path without attributing an unproven timeout cause or claiming all default-profile UI works.
- **Evidence:** default-profile screenshot and source inspection in BLOCKERS.md; actual selected-tab, visible title, physical custody, retained release and exact-stop proof in D23/D25. All private processes and browser data were cleaned.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** editor activation or shared-browser automation is changed
- **Source:** assumed — autonomous

## D30: Preserve typed output refusal reasons through the public CLI
- **Question:** source_changed was emitted only as message text, so callers could not read the declared typed reason
- **Options:** repin the test to wording; infer a reason in the CLI; emit data.reason at the output boundary
- **Chose:** cursor/source/limit refusals retain their existing numeric error kind and carry the stable reason in data.reason. The ordinary CLI error formatter exposes that field without parsing prose.
- **Why:** recovery commands must distinguish source changes from malformed cursors independently of wording.
- **Evidence:** the public recovery case failed on absent error.reason, then passed unchanged after the producer fix:3 tests71 assertions. Output/fleet regression24 tests165 assertions and the full typecheck also passed.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** the public error-envelope contract changes
- **Source:** locked by typed output/cursor recovery requirements

## D31: Remove owned component worktrees without deleting unattributed metadata
- **Question:** the three merged component worktrees retained parent contract mirrors and untracked Serena configuration
- **Options:** force-delete the dirty trees; leave their build/dependency copies consuming disk; preserve the exact known state and use checked removal
- **Chose:** verify the mirrors against the parent audit blob, preserve them in component commits, archive and move the Serena folders into the ignored iteration directory, then remove each clean owned worktree with ordinary git worktree remove.
- **Why:** the parent-owned mirror was attributable; the Serena metadata was not. This removes the owned copies while retaining the unknown files and refusing any unexpected remaining dirt.
- **Evidence:** all mirrors matched1f41749e5c52cafc4e3459dcf3ec3a3b23bdc9bb; preservation commits b6b3a98e/9be8988c/cf6a6fe1; metadata archive SHA256cf90669464ba91bd27000eca09ea734481e0fe9f0fe1ede4db86ea153fb287a5; the full checked-removal chain exited0. An incomplete full-tree archive was removed, never treated as evidence.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** another owner establishes different provenance for the retained metadata
- **Source:** assumed — autonomous

## Scoped verification before integration catch-up
- The affected runner exercised407 remote files and2 macOS files. Its first snapshot passed391 remote and both macOS files;16 failures were corrected, not reported as a passing aggregate.
- Correction gates covered the failed files and changed worker components. The final13-file API subset passed12 files; its remaining recovery file then passed unchanged after D30 (3 tests71 assertions). Output/fleet passed24 tests165 assertions; repaired protocol fixtures passed22 tests264 assertions.
- `bun test scripts`:68pass,0fail,554assertions. Deliberately failing nested verifier fixtures are part of that passing outer suite.
- `bun run typecheck`:exit0 after the final replay/archive changes; again passed in the recovery/output/typecheck chain after D30.
- `bun run build`:exit0 for UI/desktop. Missing icon-source warnings were emitted; no packaging failure was hidden. A final post-integration build still belongs to the landing preparation.
- Actual private runtime smoke proved replayed:true with the same Dispatch and unchanged input, programmatic input retaining owned custody, and ARCHIVE_SENTINEL9 readable from the terminal archive after exact close. All private processes were cleaned.
- Actual dedicated Chromium proof retained coordinator tab-3, displayed the meaningful worker title, transferred custody on physical typing, retained the completed human-owned terminal, and stopped only a second owned worker. D29 records the editor-disabled profile and observed default-profile issue.
- All implementation/fix agents have returned. No formal final review or dogfood campaign is claimed under D17. Authoritative queue deps returned ready:true; integration catch-up and queue landing remain.

## Final integration verification
- The sole roadmap catch-up is2bb56574. Its terminal launch conflict preserves both incoming shell commands and worker model/options/title; all six incoming binding decision logs were read in full and had no worker contract conflict.
- The affected integration runner passed415 remote files. Both macOS files initially failed under the runner and then passed its configured isolated retries: pane features5tests53assertions, terminal E2E23tests169assertions. The aggregate command exited0; no assertion, timeout or retry policy was changed for those results.
- Post-integration `bun run typecheck` and `bun run build` both exited0. The build produced19 plugin UI modules and27 bundled plugins; the same missing icon-source warnings remain explicit.
- Post-integration real Chromium interaction again retained tab-3, displayed Worker: Integrated visible worker, transferred custody on physical INTEGRATED9 input, and left the accepted human-owned worker live after release returned retained/processAction:none. Screenshot omp-sshots-15b78409aa4ca163.png and post-integration-ui-proof.json preserve the scoped proof; all private resources were cleaned.
- The default-profile editor timeout remains a recorded integration observation, not a worker-flow deferral or a whole-app UI pass. Source/native/CLI/archive/authority evidence and the public profile boundary remain as documented above.
- Worker depth is still the single enforced read-only core cap; the lane11 followup agrees with D18. The canonical-hook patch c8639c31 changes only the separately owned Heimdall service and introduces no worker signature conflict.

## Progress
Iteration3 is ready for authoritative landing: source e44874ca, sole roadmap merge2bb56574,415 remote files plus both macOS isolated retries passed, final build/typecheck passed, and actual post-integration terminal UI verified. All agents and private resources are finished; the three owned component worktrees were removed after preserving metadata. No local worker flow is voluntarily deferred. Next: commit this evidence, detach, invoke the canonical queue.ts land m6-orchestration-workers and wait for its full-merge verdict. Persist the outcome in the ignored iteration notes; do not claim landed until the queue confirms it.
