# m6-heimdall-control decisions

## D1: Ship controls and fleet together on the core plugin
- **Question:** scope, purpose, consumers and approach during brainstorming
- **Options:** separate private-import controls plugin; daemon-native UI; operator layer in quirky.heimdall
- **Chose:** operator layer in the built-in plugin, public methods/CLI/UI; no second store. Include all ten commands and fleet/detail page; no New objective sheet, owner runtime, concrete kind algorithms, leases or remote mirrors.
- **Why:** queue combines both feature slices; roadmap orders the core before its controls/kinds. UI/CLI must share authority and outcomes.
- **Evidence:** heimdall.md Act on a watcher/Command results/Read the fleet; docs/roadmap.md:216-228; m6-heimdall-core D1/D3
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** core contract cannot safely fence commands
- **Source:** locked by docs/loop/queue.json

## D2: Resolve observable gray areas with the source defaults
- **Question:** brainstorming layout/density/loading/empty/error/interaction; API errors/authority/idempotency; CLI flags/output/exits; integration conflict/recovery
- **Options:** ask a person; choose arbitrary new UX; use documented outcomes and existing public conventions
- **Chose:** every area selected and source defaults accepted. Exact fleet column/sort/bucket semantics; retained last snapshot/error banner; confirmation leaves workers running; exact approval scope and optimistic fence; budget zero/null; cap1..1024/folder1; specific refusals and indeterminate outcomes; CLI source names; bare JSON debug. No retry after uncertain effect. Reasons remain visible without cards, including operator edits/rejected plan.
- **Why:** unattended loop requires autonomous answers; supplied doc establishes primary flows and both defects. Logic spec AC1..9 covers outcomes and boundaries; self-reviewed against each included source section.
- **Evidence:** external heimdall.md:18-64,229-271,277-289,335-338; logic.md Decisions locked
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** supplied kind projection cannot provide a reason
- **Source:** locked by docs/loop/LOOP.md

## D3: Night mode uses one combined specification and a three-component wave
- **Question:** spec format/reviews, execution and backend preflight
- **Options:** normal two-spec multi-review pipeline; current night-mode override
- **Chose:** markdown logic.md with technical section; no research swarms, companion/adhd/human gates or separate spec review. Contracts committed first. IMPLEMENTER=omp-task, AUTHOR_FAMILY=openai, REVIEWER_ALIAS=gemini. Cap3, one wave, disjoint controls, API/CLI/fleet and UI files; parent owns integration. No mid-flight builds/tests/formatters; parent runs checks at barrier. One final cross-family review and blocking fix batch.
- **Why:** current LOOP night mode overrides normal skill phases. pi-watch --check resolved Gemini google/gemini-3.1-pro-preview:high; Opus/Sonnet unavailable. Codex/Terra/Flash available. Untracked .serena/ is inherited tool state, excluded from commits/work scopes rather than removed.
- **Evidence:** current LOOP Night mode; actual pi-watch --check output exit5 (7/12 ready); initial git status detached with only .serena/
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** real reviewer dispatch fails
- **Source:** assumed — autonomous

## D4: Keep remote and worker authority honest
- **Question:** local core versus source fleet transport and worker controls
- **Options:** simulate remote support or process identity; refuse unsupported/unknown authority
- **Chose:** local fleet only; foreign connection/owner refused. Worker stop/answers use public orchestration service authority, exact identities and real outcomes. No raw PID kill or forged runtime evidence. Kernel barrier must fence effects before draining a tick; delete does not stop workers.
- **Why:** core explicitly excludes leases/remotes, and orchestration's binding service identity separates plugin from worker runtime authority.
- **Evidence:** m6-heimdall-core D6; core contracts; control-contracts.ts KernelControlHost
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** remote fleet dependency lands separately
- **Source:** locked by docs/loop/decisions/m6-heimdall-core.md

## D5: Verify only macOS and isolate process state
- **Question:** platform/native notification verification
- **Options:** claim cross-platform parity; portable APIs plus macOS proof
- **Chose:** fresh temporary QUIRKY_HOME for every process scenario, cleanup owned daemons/workers, web UI dogfood once. Native notification banner pending scenario; Linux/Windows integration verification deferred.
- **Why:** locked platform/isolation constraints. Web notification records are not native banner evidence.
- **Evidence:** LOOP Hard rules/platform/UI/native sections
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** other platforms authorized
- **Source:** deferred: platform

## D6: Preserve conditional confirmations and unified notification ownership
- **Question:** binding-log review found API confirmation, non-consuming reads, glyph ownership and sole-notifier details missing from the first spec
- **Options:** UI-only confirm/direct notifier/consuming mailbox; existing public confirmation, producer events and owner read projection
- **Chose:** command declares destructive:true with read-only describeCommand returning null for reversible controls and exact deletion text for delete; only UI-confirmed delete supplies yes:true. Heimdall emits declared notification transition events; quirky.notifications reuses its normal enabled/focus/cooldown/marker/sound gates and remains sole context.notify caller. Worktree UI owns its glyph using public fleet API/events, clearing it when unavailable. Fleet/detail/debug use non-consuming owner service inspection only.
- **Why:** m0 confirmation and UI contracts, m1 D5/D18/D40 sole-notifier policy and orchestration D7/D9 prohibit the shortcuts. Source titles/bodies remain unchanged; policy gating is deliberate inherited behavior, not a second notifier.
- **Evidence:** daemon/plugins/confirm.ts:67-80; m0-ui-api D6/D10; m1-notifications D5/D18/D40; m6-orchestration-core D7/D9; amended logic.md AC2/3/6/9
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** notifications policy cannot accommodate watcher event semantics
- **Source:** locked by docs/loop/decisions/m1-notifications.md

## D7: Preserve typed owner config and reserve owner runtime integration
- **Question:** lane12 owner item requires compatible CLI enrollment and exact owner escalation answer without competing hub edits
- **Options:** reject owner config until later; invent owner runtime in controls; consume published typed config and delegate exact owner effect
- **Chose:** merged be27618f config/enrollment contracts into root/components. CLI supports owner Claude/model/effort with explicit flags overriding spec and intervention capability default off. Owner modules and ownerReady/ownerInspect reserved lane12. Host escalation hook delegates OwnerController.answer; only reason owner-answer-sent maps applied, never uncertainty. Controller does not save/unpark/revise enrollment; plane does so once after positive send. Core/main/manifest/service hub edits serialized after core, then owner merges lane10.
- **Why:** explicit user/lane12 integration contract; structured owner conversation authority must not be simulated or duplicated. Generic Resume cannot bypass owner-escalation.
- **Evidence:** user interjections; be27618f; owner contract63ec64f9; /tmp/quirky-lane12-owner-control-reply.md
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** controller cannot positively attest the native human-reply send
- **Source:** assumed — autonomous

## D8: Translate CLI creation flags from the actual source contract, not inferred payload names
- **Question:** component review left plan-file and hosted branch-update mappings marked as inference
- **Options:** keep guessed fields and a payload-copy objective view; read the supplied kind docs and cited CLI implementation
- **Chose:** objectiveText/existingPlan, merged roleAgents assignments, named command gates with 1800-second timeout, string branch-update merge-base-update|rebase and merge-method default|merge|squash|rebase (default null). Apply kind capability defaults, then spec and flags; normalize owner-intervention to the root capability. Objective CLI delegates the real public objectiveDetail provider owned by the objective-plan item and propagates its absence; show remains kernel inspection. No fake plan projection or legacy field alias.
- **Why:** external heimdall-objective.md and hosted-review-sitter.md identify the flag contract. Their cited create-flag-values.ts/create-spec.ts resolve the exact JSON mapping. Registered kind authorization still owns workspace/host identity and payload validation.
- **Evidence:** external heimdall-objective.md:59,101,219; hosted-review-sitter.md:101; /Users/zpyoung/PycharmProjects/orca/src/cli/fork-heimdall/create-flag-values.ts:103-250 and create-spec.ts:111-160; new real-daemon CLI acceptance scenarios
- **Reversibility:** medium
- **Confidence:** high for source mapping; public runtime proof still pending core integration
- **Revisit if:** a Quirky kind publishes a different explicit public request contract
- **Source:** locked by docs/roadmap.md

## D9: Use one fleet selector contract and preserve concurrent kernel writes
- **Question:** source integration review found divergent API/browser selectors and stale whole-enrollment command writes
- **Options:** keep duplicate projections and old snapshots; shared pure selectors and transactional latest-row patch
- **Chose:** one fleet-selectors.ts for API/CLI/UI; explicit tick-error evidence, not a regex on arbitrary reason text. Preserve source urgency/buckets including paused inactive and held tick-error active unless contact is actually lost. persistMutation reloads/rechecks owner+revision inside the transaction and patches current state. Positive question/escalation answers resolve their exact linked park records; group: folder identities also enforce cap1.
- **Why:** API and UI must not disagree about urgency/attention; an entered effect may finish during a non-draining control await. RED/GREEN regressions proved lost orchestrationRunId, lingering park escalations and a folder-group concurrency escape. Mock forwarding/copy assertions were removed, not repinned.
- **Evidence:** focused tests38pass184assertions; RED artifacts45/48/51/64; canonical core control-reply journal vocabulary; notifications/service.ts folder identity convention
- **Reversibility:** easy
- **Confidence:** high for exercised state boundaries; actual daemon/worker/UI remains required
- **Revisit if:** final core integration exposes another concurrent-state transition
- **Source:** assumed — autonomous

## D10: Validate consumed response projections without rejecting canonical service metadata
- **Question:** plugin validation found the host adapter's strict partial schemas rejected complete public Run/question rows and mutation receipts
- **Options:** drop validation; duplicate every backend field; validate consumed projection and permit other declared public metadata
- **Chose:** schemas validate consumed fields and exact returned Run/question/dispatch identity, while allowing full public metadata/receipts. Nullable worker fields retain explicit runtime checks. Hoist static response schemas. Keep uncertainty indeterminate after an unconfirmed remote effect. Terminal producer always sends a string reason, including empty when no explanation is known, rather than dropping the consumer-required field or inventing text.
- **Why:** three RED regressions returned indeterminate or never reached mutation for valid canonical responses; all three pass after the projection fix. A separate RED terminal test proved the reason field vanished and now passes. Source validator's objective provider limitation belongs to objective-plan; owner callback remains the explicitly serialized lane12 integration, neither represented as completed behavior.
- **Evidence:** plugin-validator report and amended dispositions; RED artifacts87/90; control-host3pass7assertions; final five-file focused check42pass192assertions; manifest/nullable-owner schema validation and activation import smoke
- **Reversibility:** easy
- **Confidence:** high for exercised boundary regressions; full daemon/worker/UI acceptance still pending executable dependencies
- **Revisit if:** owner service responses change their consumed identity or certainty contract
- **Source:** assumed — autonomous

## D11: Validate commands before opening conditional deletion confirmation
- **Question:** malformed delete requests reached the daemon's confirmation path before canonical command validation
- **Options:** confirm invalid requests; duplicate a looser parser; reuse the control plane's canonical parser
- **Chose:** describeCommand uses exported parseControlRequest. Invalid requests never open an ask and return invalid-command; valid delete retains single-use exact confirmation. Preserve ordinary awaiting-approval as Held: only verdict escalate records Escalated.
- **Why:** a public invalid-delete regression first returned confirmation-required, then passed after the shared preflight. The real public control suite exercises exact approval, lifecycle, budget, flags, fences and confirmation cancellation without model calls.
- **Evidence:** control-acceptance.test.ts; observed12pass98assertions2.40s before owner composition; runner verdict branch retained through ccbfa0cb/f1f29443
- **Reversibility:** easy
- **Confidence:** high for exercised public boundaries
- **Revisit if:** describeCommand and command accept different request shapes
- **Source:** assumed — autonomous

## D12: Compose genuine dependency authority and preserve landed persistence history
- **Question:** old dependency ancestry conflicted with canonical session/structured migrations and actual owner resource lifetime
- **Options:** duplicate stores or fabricate service authority; compose real checkpoints and preserve canonical state
- **Chose:** real orchestration ancestry7f789885, owner348efc61 through ccbfa0cb, then owner/core f1f29443. Preserve session badge migration8 and append pointer migration9; structured journal1 and receipt migration2; Session.launchSettings remains the only native launch replay snapshot. Scoped owner lifetimes stay in memory. Owner release must settle before deleting its enrollment, and uncertainty retains the row. Only owner-answer-sent maps to applied; plane owns revision/save/unpark.
- **Why:** metadata cannot forge an attested worker or prove a stopped child. Renumbering landed migrations loses persisted state. Full public response metadata must not invalidate an otherwise exact consumed Run/question/receipt projection.
- **Evidence:** session127pass386assertions; protocol12pass240assertions; merged structured/Claude56pass212assertions; owner/public-control62pass420assertions; control-host canonical receipt regressions. Actual backend proof currently reports core.listDispatches.bind activation failure, assigned to core rather than bypassed.
- **Reversibility:** medium
- **Confidence:** high for observed persistence/native/public boundaries; worker backend acceptance not yet passing
- **Revisit if:** dependency catch-up changes canonical authority or persistence ownership
- **Source:** assumed — autonomous

## D13: Apply the aged-item rule without claiming an unrun dogfood campaign
- **Question:** whether to begin the unstarted final review and seven-goal UI campaign after this item exceeded two hours
- **Options:** start another campaign; follow the current night-mode exception while retaining actual-surface smoke
- **Chose:** skip unstarted full review/dogfood under the aged-item rule. Run a bounded actual web-surface smoke required by the coding workflow: fresh isolated quirkyd, real built-in UI, public fixture kind, visible fleet/detail/glyphs/explanation and Pause. Keep native banners pending. No seven-goal likeuser verdict or final-review pass is claimed.
- **Why:** current LOOP explicitly skips those unstarted campaigns for aged items, not implementation or verification. The minimal surface showed pushed fleet/counters/glyphs, verbatim operator-edit explanation and positive Pause feedback followed by Resume enabled/Pause disabled, with no frontend errors. Browser full-page screenshot wrapper stalled; a direct owned-CDP viewport capture succeeded, without an app workaround.
- **Evidence:** authoritative LOOP Night mode; source claim/spec chronology; /tmp/heimdall-control-fleet.png and /tmp/heimdall-control-paused-detail.png; browser observations. Invalid first fixture setup used reserved built-in namespace under installed plugins; corrected to private real builtins, never relaxed admission.
- **Reversibility:** easy
- **Confidence:** high for exercised surface only
- **Revisit if:** loop policy changes or a required surface fails
- **Source:** locked by docs/loop/LOOP.md

## D14: Require an acknowledged dispatch, not merely a live process or completed work
- **Question:** the real child question fixture first mistook an attached failed-start process for active work, then incorrectly waited for a completed work effect
- **Options:** widen default-Run lookup or add an explicit recipient; trust liveness alone; require the existing positive ready-dispatch acknowledgment
- **Chose:** keep default worker Run routing and exact authentication unchanged. Trigger the real child CLI only when a live exact session/incarnation matches the running attempt's persisted dispatchId. The adapter writes that association only after a ready receipt; running work remains unresolved until its outcome is known. Positive rejected starts fail setup rather than being treated as ready.
- **Why:** the child inspector proved matching expected/actual/assignee session IDs but Dispatch status failed, so run_required was not an authentication or resolver defect. Owner checkpoint42791478 fixes worker_start reaching the native startup barrier while preserving mailbox-pointer refusal. The held Codex fixture can opt into real input-driven assistant commentary without completing its turn; no timer, fake status or production observer bypass.
- **Evidence:** actual child diagnostic artifact235; orchestration.ts ready-only dispatch mapping; runner.ts applyDispatchResult; isolated fixture checkpointa5489be7; unchanged-default Codex/protocol/host26pass291assertions. Final worker question/stop scenario remains under verification.
- **Reversibility:** easy
- **Confidence:** high for the identified setup and dispatch semantics; final native acceptance not yet passing
- **Revisit if:** ready acknowledgment and exact live identity disagree
- **Source:** assumed — autonomous

## D15: Exercise a blocking Ask rather than invent a pending one-way message
- **Question:** the native fixture sent a question-type message, then expected the blocking-question thread projection to expose it
- **Options:** widen the backend projection and invent lifecycle state; create a real blocking Ask through the attested child CLI
- **Chose:** actual child orchestration ask, atomically record its started identity before it exits, answer through Heimdall, then require the child CLI's exact answered message ID and body. Keep serviceRunShow's non-consuming question-thread projection unchanged. Pending-only UI rows may disappear after answer; positive service-backed journal evidence and the worker's received answer prove closure.
- **Why:** source orchestration.md explicitly defines ask as the only worker question path. send --type question creates a one-way message but no question_threads row; changing the projection alone would not create answer authority. The apparent missing projection was our fixture error, not consumption deleting a pending Ask.
- **Evidence:** source orchestration.md:477–488; messaging.ts send/beginAsk/serviceQuestions/answerQuestion. Corrected real-child flow passes1test19assertions14.25s after core582a427f: exact Ask reply, unpark, duplicate refusal, exact stop and positive target-session exit. No backend projection workaround applied.
- **Reversibility:** easy
- **Confidence:** high for the exercised complete native worker-control flow
- **Revisit if:** a real pending Ask disappears from the owned read projection
- **Source:** locked by docs/roadmap.md

## D16: Verify observable settlement rather than incidental exit metadata or callback timing
- **Question:** an explicit structured stop confirmed exited with no numeric OS exit code, and a native test checked a public event before asynchronous delivery
- **Options:** pin null or widen timing; require the actual public state/event
- **Chose:** keep exact stop receipt and public session/get exited proof; remove the numeric exit-code and unchanged PID-file assertions. Await the actual settled event, not an internal fake-world status log, before checking its consumer-visible native output. Remove an exact protocol-method sequence assertion rather than re-pin wiring.
- **Why:** an explicit SDK stop need not expose an OS exit status. A remembered PID file does not prove termination. Internal status persistence does not imply the subscribed public event has arrived.
- **Evidence:** real native control flow1pass19assertions14.25s; focused native settlement1pass10assertions899ms; full composed typecheck0diagnostics25.01s
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** a public positive settlement can be observed without the corresponding exact resource transition
- **Source:** assumed — autonomous

## Progress
- Integrated core582a427f as801779e1, preserving canonical journal1/receipts2 and transactional receipt cleanup. Later atomic CLI-reply publication fixes and isolated native fixture83e4c51b are included.
- Complete real native worker control flow passes1test19assertions14.25s. Public controls pass12tests98assertions4.33s; notifications3tests4assertions. Minimal actual web smoke completed; owned resources stopped. Native banners remain pending.
- Full composed typecheck passed with0diagnostics25.01s. Production build packaged Quirky.app55.91s. Scripts passed66tests517assertions.
- Initial broad scope had297/309remote files pass and12 failures; the runner's Mac terminal retry passed. Corrected native/operator/session/structured/auth/schema scope now passes49/49files with no flaky reruns. Repaired ordinary orchestration callers are being checked separately.
- Aged-item policy skips the unstarted full review and seven-goal dogfood campaign; no such pass is claimed.
- Next: finish remaining affected orchestration verification after core's report/release correction, await dependency-ready, merge build/roadmap once, read incoming decisions, and land through queue.ts.

