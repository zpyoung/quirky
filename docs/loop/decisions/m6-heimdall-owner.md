# m6-heimdall-owner decisions

## D1: Build only the optional owner slice
- **Question:** brainstorming purpose, consumer, scope and success
- **Options:** whole Heimdall feature; optional owner layer only
- **Chose:** owner config, typed deviations, report/intervention gates, silence and worker idle/stall detection; not judgment, fleet, concrete kinds or UI.
- **Why:** queue title explicitly names the owner layer; core and controls have independent owners.
- **Evidence:** queue wait lane12; external heimdall.md:219-224; logic.md AC1-8
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** source in-scope flow cannot be exposed through public methods
- **Source:** locked by docs/loop/queue.json

## D2: Resolve all skill questions autonomously with source-grounded defaults
- **Question:** brainstorming standard API/CLI/data/integration gray areas, format and approvals
- **Options:** human waits/research swarms; unattended night defaults
- **Chose:** API discriminated outcomes, explicit errors and exact report identity; generated CLI; natural-key dedupe, durable uncertainty and bounded UTF8 payloads; source thresholds and common intervention vocabulary. Claude only, optional model/effort. Separate owner capability default off plus native gates. One logic.md with final technical section, self-reviewed against owner flows; no research swarm/visual/adhd/human wait.
- **Why:** LOOP mandates unattended defaults and night-mode single spec. Questions about platform, errors, recovery, authentication, idempotency, missing evidence and scope are all resolved explicitly in logic.md Decisions locked.
- **Evidence:** current build/roadmap LOOP Night mode and Answering skills; external heimdall.md owner section; architecture Decisions
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** core authority contract conflicts
- **Source:** locked by docs/loop/LOOP.md

## D3: Use in-plugin owner modules and public cross-plugin calls
- **Question:** design alternatives and integration
- **Options:** owner modules in quirky.heimdall; separate private-state owner plugin; duplicated per-kind owners
- **Chose:** modules in existing built-in, public structured/orchestration calls, kind-owned translation hooks. Parent integrates runner gates and serialized controls; worker modules consume committed owner/contracts.ts.
- **Why:** core D3/D8/D10 require public namespaced kind hooks, service authority and synchronous fencing. Separate plugin would add a private state boundary.
- **Evidence:** m6-heimdall-core D3/D8/D10; owner contracts; OwnerSurface scout
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** public service API cannot observe or address an exact owned worker
- **Source:** locked by docs/loop/decisions/m6-heimdall-core.md

## D4: OpenAI implementers and Gemini cross-family fallback
- **Question:** SDD preflight reviewer pairing, checks, and decomposition
- **Options:** omp task+Opus; omp task+Gemini; reduced-independence OpenAI review
- **Chose:** IMPLEMENTER=omp-task, AUTHOR_FAMILY=openai, REVIEWER_ALIAS=gemini, verified google/gemini-3.1-pro-preview:high. One wave with two disjoint external worktrees (runtime, detection), cap3; parent integrates hubs. Workers skip builds/tests/lint/formatters mid-flight. Parent runs acceptance after barrier, affected suite/scripts/typecheck once before final review and queue land. No whole-suite baseline.
- **Why:** actual pi-watch --check reports no authed Opus/Sonnet; Gemini ready. Contracts first avoids implementation races.
- **Evidence:** alias preflight output artifact://7; committed owner/contracts.ts; LOOP Night mode
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** actual reviewer dispatch fails
- **Source:** assumed — autonomous

## D5: Preserve current landed structured runner while merging early core contracts
- **Question:** early dependency merge conflicts in stale m5 history
- **Options:** take stale dependency m5 versions; keep current roadmap m5 versions
- **Chose:** roadmap versions of m5 decision log, plugins README, structured runner and its two tests. Core contracts/spec/decisions merged at2769ff97. Sent core lane the owner integration request; no private worktree edits.
- **Why:** m5 already landed and its verified restoration must not be undone by older core ancestry.
- **Evidence:** merge conflict output and2769ff97; lane12 previous notes; core terminal send request e4a7ac0a-1198-45d6-9479-7c73eea55f39 input accepted (turn not attested)
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** core shows a specifically required conflicting change
- **Source:** assumed — autonomous

## D6: Limit platform verification to macOS
- **Question:** platform and process safety
- **Options:** claim portability from APIs; verify Mac and defer other OS checks
- **Chose:** portable TypeScript/Bun, macOS tests/smoke only. Linux/Windows lifecycle and file-opening verification deferred. Fresh HOME/QUIRKY_HOME, NODE_ENV=test and cleared provider-home overrides for all spawned smoke processes; owned processes always cleaned.
- **Why:** LOOP platform rule and prior real-home incident require explicit isolation.
- **Evidence:** LOOP Hard rules; m5-structured-runner D11; logic.md technical decisions
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** another platform is authorized
- **Source:** deferred: platform

## D7: Bind live owner connections to their authenticated creating plugin
- **Question:** owner native cleanup after the kernel revokes context before deactivate
- **Options:** bypass revocation/private imports; change kernel ordering; opt-in public structured connection lifetime
- **Chose:** structured create/resume accept lifetime=plugin only from a registered active/activating authenticated PluginCaller. Structured retains the live connection's creator and reacts to plugin.changed by querying plugin.list and stopping only opt-in connections of inactive creators. Default sessions/workers are unchanged. Historical native conversations remain persisted; owner resume explicitly rebinds the new connection, so a persistent second ownership index is unnecessary.
- **Why:** no pre-deactivate hook exists. Host marks the owner attempt revoked before deactivate, so its context.call cannot perform cleanup. Structured's own context remains usable after only Heimdall is disabled, and its own teardown stops every connection on daemon shutdown. This preserves locked revocation ordering and public-only composition.
- **Evidence:** OwnerSurface exact lifecycle investigation; packages/daemon/src/plugins/host.ts:631-678; runtime.ts:123-126,177-180; plugins/quirky.structured/main.ts lifetimePlugin/reconcilePluginLifetimes; public manifest optional lifetime; logic.md amendment
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** a public before-revoke resource lifecycle appears
- **Source:** assumed — autonomous

## D8: Use scoped service worker effects and separate exact approvals
- **Question:** common intervention effects, kind mapping, report evidence and control answer ownership
- **Options:** raw session input/forged coordinator; authenticated owned-run service methods
- **Chose:** serviceRunShow proves worker membership and exact incarnation; serviceSend messages, serviceReply answers an exact pending question, serviceWorkerStop stops exact live identity. Native common capability names equal intervention kind. owner-intervention has an independent exact approval actionKind owner-intervention:<native-kind>; native approval is insufficient. Report proposals preserve issued content identity. Driver stages a proposal and reads durable attempt results; runner executes it through ordinary gates/write-ahead. Lane10 owns final commandRevision/save/unpark after exact owner answer positively sends.
- **Why:** source interventions cannot bypass native authority or invent worker credentials, and stale reports cannot silently acquire a fresh content identity. Applying effects outside the runner would violate the write-ahead contract.
- **Evidence:** /tmp/quirky-lane12-owner-core-reply.md:32-38; /tmp/quirky-lane12-owner-control-reply.md:5-8; owner/{contracts,driver,gate,workers,api}.ts
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** concrete kind requires a different native capability mapping
- **Source:** assumed — autonomous

## D9: Add a real API/CLI acceptance component without shared writes
- **Question:** flow-level proof beyond runtime/detector boundary tests
- **Options:** mock-only unit tests; actual plugin-host/CLI with scripted provider boundary
- **Chose:** third implementer owns owner-acceptance.test.ts and owner-fakes only, forked from the same63ec64f9 wave base. One wave remains width3, no overlap; parent waits for all returned components before checks/commits. Real daemon/CLI missing-owner smoke first returned -32601 for ownerReady/ownerInspect, daemon cleanup exit0. Final runtime API tests use injected non-paid Claude runner; timeout boundaries use injected clock, not900s sleeps.
- **Why:** no general daemon clock injection exists. Source CLI and API behavior must actually run; native model work must not touch real accounts or spend tokens.
- **Evidence:** /tmp/quirky-owner-l12-before.ts output REAL_DAEMON_OWNER_APIS_MISSING_CONFIRMED and daemonExit0; OwnerSurface fixture mapping; process-scope/helper signatures
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** fixture misses a production service ownership boundary
- **Source:** assumed — autonomous

## D10: Correct concrete red checks and remove incidental timing assertions
- **Question:** first component acceptance failures and final write-scope attribution
- **Options:** suppress failures; change source to satisfy incidental scheduling; repair real defects and retain behavioral criteria
- **Chose:** fixed undefined ready enrollment, unclosed detector regex, bounded report-open/read/shutdown behavior and contact-loss checkpoint cutoff. Emit ordinary owner-deviation escalation revisions for existing inspection. Removed exact internal revision/fold-count assertions and the detector's nextCheck=null assertion, which contradicted an independently scheduled silent check; durable queue test now drives the next tick rather than requiring two work items in one call.
- **Why:** source requires durable queue progression and exact boundary detection, not incidental per-call sequencing or internal fact counts. The production ready and parser defects were real and repaired, not masked.
- **Evidence:** initial runtime13pass/6fail and detector syntax error; next runtime18pass/1fail and detector17pass/1fail; corrected runtime19pass/144assertions and detector18pass/65assertions. All component heads still63ec64f9 before parent commit. Scoped new-file lists matched contracts; all three inherited .serena files matched parent hashes in every component.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** a flow-level test exposes lost queued work
- **Source:** assumed — autonomous

## D11: Keep local worker controls inside ordinary write-ahead owner proposals
- **Question:** common intervention locality and queued-owner pacing
- **Options:** classify local mailbox/process controls as publishing effects; classify them as local Quirky resource operations
- **Chose:** common interventions are local actions, still gated by their native capability, separate owner capability, commit fences and durable attempt. Exact worker service identity/ownership remains mandatory. Kind-specific actions preserve their declared local/external visibility. A completed owner proposal requests an immediate next tick, so queued deviations do not wait for idle pacing.
- **Why:** stop/message/answer operate on Quirky-owned resources, not publishing state; they must remain usable to reconcile a running worker. External native effects retain their existing unresolved-attempt wall. Runtime staging cannot itself execute an effect.
- **Evidence:** owner/driver.ts action preparation and proposal staging; owner/workers.ts scoped services; pending core runner/gate write-ahead path
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** a future remote execution surface changes resource locality
- **Source:** assumed — autonomous

## D12: Preserve updated dependency authority contracts and canonical owner types
- **Question:** early core branch updates and acceptance assumptions
- **Options:** fork scheduler/worker authority; integrate the published public shapes
- **Chose:** merge updated core configuration and orchestration store contracts; read core D11–D14 and orchestration D1–D35, including D28's superseding early execution rule. No authority conflict. Canonical OwnerConfig is the base core type. Publish optional OwnerKernelPort, typed natural-key deviation, park owner-escalation and ownerAction hook centrally. Core inspect remains an array even for a selected ID; acceptance selects the matching enrollment instead of changing that API.
- **Why:** service sender authority is not synthetic session evidence, and owner effects must preserve those boundaries. Inert shared contracts are already published independently of pending runtime implementation.
- **Evidence:** dependency merge output7files/358insertions; core reply Runtime integration checkpoint; src/contracts.ts; test acceptance inspect helper
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** incoming runtime changes the documented service signatures
- **Source:** assumed — autonomous

## D13: Reconcile the action that parked a watcher before applying inactivity guards
- **Question:** integration analysis found ask-human could park the watcher before the controller recorded its landed proposal
- **Options:** defer the park outside its write-ahead action; reconcile the durable outcome before refusing new inactive work
- **Chose:** ready proposals may query host.apply before the controller's paused/disarmed guard. Driver first returns an existing durable attempt outcome, then refuses to stage any new proposal when disabled/paused/parked. No owner wake or effect bypasses ordinary runner gates.
- **Why:** otherwise the next tick leaves phase ready forever, while exact answer requires phase parked. This is state reconciliation, not permission to execute inactive work.
- **Evidence:** strengthened existing ask-human regression sets enrollment parked before reconciliation; failed ready versus parked before repair, focused test passed11assertions after; entire owner-runtime file19pass/144assertions
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** an inactive proposal reaches an effect without a pre-existing durable attempt
- **Source:** assumed — autonomous

## D14: Recheck the live runner fence at automatic owner dispatch
- **Question:** pause/disarm can arrive while an owner brief is preparing asynchronously, before the structured call
- **Options:** trust the earlier enrollment snapshot; treat positive non-dispatch as uncertainty; recheck the captured runner fence and durably defer
- **Chose:** OwnerKernelPort.step accepts a current per-tick canDispatch predicate; driver supplies it to automatic create/send/resume/reminder checks immediately before the native call. A positively fenced, unstarted turn persists phase deferred, closes its unused owner interval and resumes only after authority returns. Exact human answers remain the separate serialized control operation. Ready proposals still recover existing durable outcomes, never execute under the fence.
- **Why:** an earlier enabled snapshot does not authorize a new model turn after a control fence. No native call occurred, so calling the result indeterminate would strand a safely resumable turn.
- **Evidence:** new regression failed because creates length1 under a false fence; focused green4assertions after repair, including persisted deferred restart; reminder allowance remains unused while fenced. Hung-send shutdown watchdog test passed2assertions in1.65s and proved no late journal writes.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** a native call occurs after its captured runner predicate turns false
- **Source:** assumed — autonomous

## D15: Prove lifecycle and conversation behavior with real isolated provider processes
- **Question:** acceptance's original callback-only runner could prove wiring but not resource cleanup or native continuity
- **Options:** retain mock echoes; use a non-paid process-backed native boundary
- **Chose:** scripted JSONL child per session, fresh ProcessScope HOME/QUIRKY_HOME, hashed durable native conversation file. Lifecycle assertions observe owner child exit, an unrelated child's real follow-up acknowledgement, and persisted turns; restart reads prior conversation state. Remove unit assertions that only copy native params or pin diagnostic wording. Core's confirmed scheduler is daemon, host local; nullable owner fields align with the published core contract. Deviation-only decisions are admitted without an otherwise redundant reason.
- **Why:** callback arrays do not prove a process stopped or a conversation survived. Public owner behavior must remain independently exercised through the real daemon and CLI.
- **Evidence:** standalone /tmp/quirky-owner-native-lifetime-l12.ts emitted REAL_CHILD_PLUGIN_LIFETIME_SMOKE_OK (ownerExit0, independentAlive true, nativeTurns2, client lifetime refused), then cleanup success;45owned boundary tests passed215assertions. Core publication watcher observed794266f1, not queue completion.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** the scripted boundary diverges from a public structured contract
- **Source:** assumed — autonomous

## D16: Release owner resources by authenticated plugin and watcher key before terminal persistence
- **Question:** replacement, deletion, reconfiguration and an ambiguous native create/stop must not leak a connection or close a sibling
- **Options:** stop a remembered session only; release all plugin sessions; scoped public stopOwned with positive settlement
- **Chose:** owner create/resume use plugin lifetime and watcher lifetimeKey. Controller.release serializes per watcher, bounds cleanup, preserves uncertain reservations and refuses replacement until exact cleanup succeeds. Terminal runner release precedes terminal persistence; delete releases before row removal. No late controller write may recreate deleted state. Historical native conversations remain available.
- **Why:** a lost create reply can commit a child without returning its session ID. A watcher key recovers that resource without broad cleanup authority. Unknown stop does not prove a native conversation is safe to resume.
- **Evidence:** e05ba8b5,28a5e08a,348efc61; runtime32pass221assertions; standalone SCOPED_NATIVE_CLEANUP_SMOKE_OK proved unknown-stop reservation, exact retry, lost-reply cleanup, sibling/foreign-key isolation and independent real follow-up
- **Reversibility:** medium
- **Confidence:** high for exercised lifecycle boundaries
- **Revisit if:** the public structured lifetime contract changes
- **Source:** assumed — autonomous

## D17: Admit only canonical effective hooks owned by their declaring plugin
- **Question:** user-reported real-daemon registration failed because public contribution IDs already include method namespace
- **Options:** concatenate plugin/id; accept legacy short IDs; parse the canonical contribution and enforce its owner
- **Chose:** effectiveHookReferences parses contribution ID, requires method kind and parsed namespace equal to item.plugin, then admits the actual namespace/name RPC reference. Preserve effective status and method-kind filters. No legacy fallback or relaxed ownership fence.
- **Why:** concatenation produced plugin/method:plugin/name and rejected every valid startup registration. Accepting a foreign namespace would instead create an authority bypass.
- **Evidence:** user diagnostic; c8639c31 isolated fix, peer cherry-pick79110a3a; actual kind registration/enrollment/reconcile daemon smoke passed
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** the public contribution ID contract changes
- **Source:** assumed — autonomous

## D18: Rebrief stale owner evidence and keep approval waits Held
- **Question:** a report issued for snapshot A must not execute against B or leave the owner stranded; an ordinary approval hold must not become Escalated
- **Options:** refresh report identity silently; retry the stale report; refuse it and issue a typed fresh deviation in the same native conversation
- **Chose:** stale live content identity queues gate-held with a snapshot-bound natural key, refuses the old proposal and obtains a new issued report/key in the same conversation. Owner approval uses Hold. Preserve the user-published generic runner correction: recordGate escalates only verdict escalate, never merely reason awaiting-approval.
- **Why:** permission for one snapshot does not authorize another. A fresh report restores progress without bypassing native or owner gates. The source shows pending approval as Held.
- **Evidence:** 6c5bce1a; stale A-to-B API regression; runner.ts recordGate verdict branch; user controls checkpointccbfa0cb
- **Reversibility:** easy
- **Confidence:** high for exercised owner stale-report flow
- **Revisit if:** a report can execute after its issue-time identity changes
- **Source:** assumed — autonomous

## D19: Preserve public schema bounds and prove owner behavior through real API and CLI effects
- **Question:** initial manifest validation rejected unsupported length keywords and callback fixtures did not prove actual publication or process continuity
- **Options:** loosen runtime validation; duplicate provider callbacks as evidence; supported public schemas with bounded runtime parsing and process-backed effects
- **Chose:** supported manifest schemas; retain report-key, byte, UTF-8 and private-file checks in runtime. Explicit owner-ready and owner-inspect CLI declarations/handlers match public camelCase methods. Process-backed scripted provider stores native history and writes the report; the kind executor appends a real publication receipt. Shared fake selectors accept canonical id:/path: selectors. Delete incidental diagnostic/default/copy assertions rather than re-pin them.
- **Why:** an invalid manifest prevents activation before the bounded parser runs. Parameter echoes are not evidence that a child, conversation or effect exists.
- **Evidence:** 5de9734f,03d3c8c4; owner API acceptance15pass95assertions14.61s, actual daemon/CLI + real JSONL child + file publication; plugin-validator supported manifests PASS
- **Reversibility:** easy
- **Confidence:** high for exercised API flows before final dependency catch-up
- **Revisit if:** final integrated acceptance exposes a public schema or native boundary mismatch
- **Source:** assumed — autonomous

## D20: Preserve canonical launch snapshots and the native receipt migration during serial hub integration
- **Question:** old dependency ancestry restored a private launch-options table while the verified controls composition uses canonical Session.launchSettings
- **Options:** retain both replay stores; discard current native behavior; preserve one canonical public snapshot and append only the receipt migration
- **Chose:** merge actual core50fb4027 and controlsccbfa0cb, retain canonical journal migration1 plus send-receipts migration2 and public immutable Session.launchSettings for native model/effort replay. Keep account-prepared environment, real provider identities, exact-incarnation authority, keyed plugin lifetimes and unknown-stop reservations. Main owns lease acquisition/release; runner factories receive existing options.env, no invented callbacks. Public owner-answer callback maps only owner-answer-sent to applied; plane owns revision/save/unpark.
- **Why:** a second launch replay store can diverge and renumber installed migrations. Native execution and service identity must remain real, not reconstructed from plugin metadata.
- **Evidence:** user serial-hub handoffs; /tmp/quirky-lane12-owner-control-reply.md; 76eb1a28; read core D15–D19, control D1–D10, worker D1–D16 and prior orchestration D1–D35; no authority conflict
- **Reversibility:** medium
- **Confidence:** high for the public contract; final merged gate pending
- **Revisit if:** final dependency integration changes canonical snapshot or receipt ownership
- **Source:** assumed — autonomous

## D21: Apply the aged-item rule without inventing completion evidence
- **Question:** whether to start an unstarted final review or dogfood campaign after the item exceeded two hours
- **Options:** begin another campaign; follow the current night-mode aged-item landing rule
- **Chose:** finish reachable implementation, required affected tests/scripts/typecheck and already-started API/native smoke, then land without starting a new review or UI dogfood round. This item adds no owner UI. Preserve failed/partial evidence as such; peer checks are explicitly peer evidence.
- **Why:** current LOOP requires aged items to land after their own tests/typecheck and skips unstarted review/dogfood. It does not authorize fake backend proof, partial owner effects or bypassed queue dependencies.
- **Evidence:** authoritative build/roadmap:docs/loop/LOOP.md Night mode; owner spec commit63ec64f9 claim-age evidence; current verification progress
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** the unattended loop policy changes
- **Source:** locked by docs/loop/LOOP.md

## D22: Correct reported owner type errors without replaying the failing full check
- **Question:** user assigned five owner diagnostics from an observed214-diagnostic/37-file typecheck
- **Options:** rerun to confirm; assert away nullable state and incomplete fixtures; correct the actual types and narrowing
- **Chose:** capture a non-null pending value explicitly before deviation updates. Read post-mutation wake deadlines through a typed helper rather than TypeScript's stale pre-await null narrowing or non-null assertions. Construct complete JournalEntry approval facts. Supply the canonical provider transcriptPath, preserving an existing path or null. Publish only these three files as913a63a0 while core/control lanes own their assigned diagnostics.
- **Why:** optional equality does not narrow its parent object, and TypeScript does not model issueNext mutating state.pending across the call. A double cast would hide fixture drift. No runtime permission or deadline policy changed.
- **Evidence:** user-reported three runtime/one gate-fixture/one scripted-provider errors; runtime pending guards/deadline helper, complete approval fields and SessionProviderSession contract; source checkpoint913a63a0. Focused post-fix checks pending the component edit barrier.
- **Reversibility:** easy
- **Confidence:** high for the exact reported type causes; verification pending
- **Revisit if:** the integrated typecheck reports another owner diagnostic
- **Source:** assumed — autonomous

## D23: Keep one public native launch snapshot while integrating the real service facade
- **Question:** incoming core D25 proposes a third private launch-options migration after preserving journal1/receipts2, conflicting with the user-verified canonical Session.launchSettings replay
- **Options:** reintroduce an unused private replay table; renumber receipts; retain one canonical public snapshot and preserve genuine provider fixes
- **Chose:** retain journal migration1 and receipt migration2, no private launch-table/accessors. Resume derives model/effort from Session.launchSettings and prepares the current account environment. Preserve core D25's SDK-init-confirmed native IDs, real resume identity/transcript, current-run guards and honest failed-result status. Integrate df799424's eight actual service providers and worker evidence; publish source separately from runtime acceptance.
- **Why:** no main caller needs the private table after canonical replay cutover. Keeping two replay stores adds divergence and dead weight, while renumbering an installed receipt migration is unsafe. This supersedes only D25's private launch-table addition, not its provider-identity or receipt ordering invariants.
- **Evidence:** user canonical snapshot/journal handoff; f1f29443 native composition; native main launchOptionsFromSnapshot; source df799424; incoming core D20–D26 read. User-reported old-core activation failure is ground truth; the new source now implements listDispatches, boundRunId and attentionFor, but actual post-integration activation is not yet verified.
- **Reversibility:** medium
- **Confidence:** high for canonical replay and forward receipt order; actual backend acceptance pending
- **Revisit if:** a real launch option cannot be represented by the public immutable snapshot
- **Source:** supersedes m6-heimdall-core D25 (private launch-options table only)

## D24: Separate assignment activity from a retained process's liveness
- **Question:** the actual service projection exposes assignmentActive separately from live/exited/unverifiable state
- **Options:** scan every still-live process as active work; scan only positively active assignments and keep exact cleanup authority separate
- **Chose:** owner activity scanning skips inactive assignments and reuses the canonical KernelWorkerObservation type. Exact stop still accepts positively exited identity and delegates to the owning service. A stop is applied only for an exact closed receipt or a positively already-settled stopped/succeeded/failed receipt; mismatched dispatch or unknown/stop_unknown remains indeterminate.
- **Why:** a retained live process from completed work must not park its watcher as though it were an active stalled worker. A stopped/released label alone does not prove an exact process was closed.
- **Evidence:** inactive-live regression failed enabled=true versus false before the scan guard; after repair driver/worker files9pass25assertions, including the active-assignment positive park transition. New source uses KernelWorkerObservation instead of a duplicate projection; LSP references unavailable, fallback search found no external OwnedWorker consumer.
- **Reversibility:** easy
- **Confidence:** high for exercised assignment and stop receipt boundaries
- **Revisit if:** the service changes assignment retirement or exact stop receipts
- **Source:** assumed — autonomous

## D25: Ground final owner evidence in actual effects and distinguish fixture failures
- **Question:** final owner checks and actual backend acceptance exposed different kinds of failure
- **Options:** call every checkpoint passing; relax production worker admission; preserve exact evidence and repair fixture preconditions
- **Chose:** report the58-test owner runtime/gate/worker/API pass separately from backend acceptance. The new public API case proves ask-human parks, wrong escalation refuses, the exact answer reaches the same native conversation, and replay refuses. Standalone owner-ready/owner-inspect CLI and real publication receipt plus native keyed cleanup pass. Correct the smoke's mistaken assumption that resolved history lives in ownerInspect: current owner identity belongs there, full durable explanations belong in watcher inspect.
- **Why:** the actual worker test's durable inspection proved Agent codex not enabled/launchable, not a missing service facade. The fixture creates its launcher after catalog startup; repair uses public refresh and setEnabled, not a fake backend or relaxed production admission. Share its existing process scope rather than layer independent cleanup owners.
- **Evidence:**58pass354assertions34.76s; SCOPED_OWNER_TYPES_OK20files after assigned fixes; OWNER_API_CLI_PUBLICATION_SMOKE_OK and SCOPED_NATIVE_CLEANUP_SMOKE_OK8.94s; backend red artifact156; failed fixture process snapshot found zero matching processes. Refreshed backend rerun pending.
- **Reversibility:** easy
- **Confidence:** high for exercised owner paths and captured admission cause; final backend/full-project gates pending
- **Revisit if:** the refreshed actual native worker flow exposes another integration defect
- **Source:** assumed — autonomous

## Progress
Actual core facade df799424 is merged as e410f69f after canonical owner/control integration f1f29443 and assigned owner type fixes913a63a0. All implementers returned. Own runtime/gates/worker/API58tests354assertions pass, including the16th exact human-answer API case;20owner files passed scoped compiler diagnostics. Both standalone API/CLI publication and scoped native cleanup smokes pass. New inactive-live assignment regression failed before and driver/worker9tests25assertions pass after the scan guard. Actual owner-worker acceptance initially failed because its Codex launcher appeared after catalog startup; durable inspection proves refusal, fixture now refreshes/enables through public API and shares the existing process scope. Refreshed real backend run is active. Final affected suite/scripts/full typecheck not yet run; queue dependency core still pending, bg_24 awaits readiness. Next: finish actual worker flow and any concrete fixes, publish checkpoint, merge dependency corrections, await deps ready, catch up build/roadmap once/read incoming logs, required gates, commit/detach/queue land. No fake backend, unstarted review/dogfood campaign or silent scope reduction.
