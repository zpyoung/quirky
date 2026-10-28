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

## Progress
Runtime component ad985463 and detection5b305152 merged after barrier; worktrees removed. Parent checkpoint3ce5124a contains gated proposals/API/common worker effects/canonical contracts and opt-in structured lifetime. Runtime19pass/144assertions, detector18pass/65assertions, owner gate/worker boundaries6pass/15assertions. Standalone actual daemon lifetime smoke passed and cleaned. D13 fixed a reproduced parked-settlement deadlock; full runtime regression stays green. Acceptance component remains uncommitted in /tmp/quirky-owner-acceptance-l12, fixture updated to core inspect array and owned temporary worktree. Core/controls runtime still pending; their hubs remain untouched. deps bg_6 currently waiting core. Next: merge committed core/control runtime, central runner/registry/service/manifest integration, real owner/worker API+CLI flows, affected suite/scripts/typecheck, deps-ready/catch-up/final review/land. No whole-feature completion claimed.
