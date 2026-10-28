# m7-orchestration-worker-federation decisions

## D1: Apply autonomous combined-spec build-first workflow
- **Question:** Brainstorming format, gray-area scope and approval/check gates.
- **Options:** human asks/external swarms/two specs; autonomous standard gray areas and one combined markdown spec.
- **Chose:** Selected API/CLI/Data/Integration authentication, response/errors, flags/recovery, pagination/idempotency, sync/conflict/retry/mapping; resolve from feature and locked decisions. No human asks, companion, adhd, external swarm, suites, reviews or full dogfood. Self-review specification. Actual narrow smoke supplements typecheck because the coding contract requires exercised behavior.
- **Why:** Current authoritative LOOP explicitly changes this unattended workflow.
- **Evidence:** build/roadmap:docs/loop/LOOP.md Build first; orchestration.md Federation/Messaging/Questions.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** end-phase triage starts or authoritative LOOP changes.
- **Source:** locked by docs/loop/LOOP.md

## D2: Reuse one store and real paired transport with distinct remote authority
- **Question:** Where should worker execution and report authority live?
- **Options:** unrestricted remote proxy; copied local caller evidence; typed federation mapping over existing paired transport and host service workers.
- **Chose:** Home owns authoritative Task/Dispatch/settlement; host owns service Run/Dispatch/process/custody. Durable binding fences peer pin/revision, daemon and process incarnation. Inbound principal comes directly from authenticated credential lookup, never JSON. Remote report authority is distinct from RuntimeCallerEvidence.
- **Why:** Existing local workers and transport are real; no source prerequisite blocks implementing their missing connection. Forged local evidence would violate kernel process ownership.
- **Evidence:** FederationSeams source map; peers.ts324-394,574-643; services/coordinator.ts159-176; predecessor D2,D11,D13.
- **Reversibility:** hard
- **Confidence:** high
- **Revisit if:** paired transport cannot convey authenticated principal without spoofing.
- **Source:** assumed — autonomous

## D3: Exact remote placement and durable uncertainty without fallback
- **Question:** CLI flags, launch target, response and retry semantics.
- **Options:** inferred/current workspace and local fallback; explicit --on peer and exact workspace/new-top-level.
- **Chose:** Exact saved peer ID; existing remote workspace or repo/name new-top-level only. Reject current/new-child and irrelevant creation flags before effects. Durable UUID same-input replay, changed-input refusal, unknown accepted effects with inspection recovery; no duplicate launch on timeout.
- **Why:** Documented federation placement and absence-is-never-proof rules.
- **Evidence:** orchestration.md:562-574; local worker specification AC1,AC3,AC6.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** an authorized placement contract supersedes it.
- **Source:** locked by research/orca-features/orchestration.md

## D4: Commit home verdict before host report acceptance
- **Question:** Sync direction, ordering, kind rejection and blocking ask conflict semantics.
- **Options:** enqueue counts as success; host settles first; ordered durable relay with actual home verdict.
- **Chose:** Bidirectional per-binding sequence queues, contiguous replay-safe import, bounded50-item/six-page sync and durable cursors. Home validates exact binding/current attempt and owner-namespaced preflight before atomic settlement; host accepts only that verdict. Ask timeout keeps original question, resume does not duplicate, identical answer idempotent/different answer conflict, settlement closes questions.
- **Why:** Local authority and core D9 survive transport federation. Unavailable preflight cannot become acceptance.
- **Evidence:** orchestration.md Federation, Blocking ask/reply, Fork relation; core D9; predecessor D4.
- **Reversibility:** hard
- **Confidence:** high
- **Revisit if:** real transport settlement proof exposes an unresolvable ownership race.
- **Source:** locked by docs/loop/decisions/m6-orchestration-core.md

## D5: Remote lifecycle retains host custody and honest fleet/output provenance
- **Question:** Controls, output recovery, pagination and task navigation behavior.
- **Options:** home closes guessed local session; return metadata without viewer; route pinned host custody operations and actual output viewer.
- **Chose:** Host exact stop/release/retain; archive before release; takeover/external custody wins. Contact loss means unverifiable/unknown/pending, never exited. Bound source-pinned output and snapshot fleet pages, partial host errors, actual remote task-output viewer rather than unrelated local session.
- **Why:** These are user-visible required flows and safe failure invariants, not optional validation work.
- **Evidence:** orchestration.md Worker ownership/output/fleet/Federation/UI task links.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** the public view API cannot display remote output without a private import.
- **Source:** locked by research/orca-features/orchestration.md

## D6: Three isolated implementers against committed contracts
- **Question:** Implementation decomposition and reviewer pairing.
- **Options:** shared concurrent writers; isolated engine/mail/surface components.
- **Chose:** OpenAI task implementers, maximum3. Engine owns transport/core/start/main; mail owns messaging/new relay; surface owns lifecycle/output/fleet/navigation/CLI/manifest/UI. Parent owns spec/decisions/shared initial contracts and integration. No review launched under build-first, so no reviewer reachability/pass is claimed. LSP status reports none configured; source mapping used instead.
- **Why:** Existing worker pipeline and store remain one convention; no overlapping source writer. Shared contracts are committed before dispatch.
- **Evidence:** src/federation/contracts.ts; logic.md technical decisions; actual xd://lsp status.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** shared seam changes require parent serialized integration.
- **Source:** assumed — autonomous

## D7: Preserve platform and existing lane boundaries
- **Question:** Portability, test state and neighboring flow ownership.
- **Options:** ambient state/cross-platform claims/unrelated policy changes; fresh-home macOS-only implementation evidence.
- **Chose:** Every process fixture uses isolated HOME/QUIRKY_HOME and cleanup; no hooks/real credentials. Portable transport APIs where cheap; Linux/Windows process identity/TLS/lifecycle validation remains deferred. Keep core D9 and pointer/shutdown/host-power queue ownership, exclude Objective/PR sitter/non-GitHub.
- **Why:** Locked architecture/roadmap and item scope.
- **Evidence:** docs/loop/LOOP.md Hard rules/Platforms; predecessor D6,D7,D14.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** other platforms or excluded flows are explicitly authorized.
- **Source:** deferred: platform

## D8: Use exact remote output routes in every existing task navigation consumer
- **Question:** Existing terminal task links and sidebar rows assumed taskTerminal always returned a local session/workspace.
- **Options:** return foreign IDs as local sessions; add an exact remote-output variant and migrate both consumers.
- **Chose:** Remote result is `{kind:'remote_output',taskId,dispatchId,viewId:'view:quirky.orchestration/remote-worker-output',input:{dispatchId}}`; local result remains its actual existing variant. Both public consumers validate the fixed view/dispatch route. Sidebar groups remote rows under the actual home coordinator workspace and never deduplicates or renders a remote process as a same-ID local session. Remote output keeps host sourceIdentity/cursor pinning and explicit peer/binding/host provenance.
- **Why:** A metadata-only response cannot navigate to an actual viewer, and foreign session IDs cannot grant local focus or liveness.
- **Evidence:** src/navigation.ts; quirky.terminal/src/window/pane/task-links.ts81-110; quirky.worktree/src/OrchestrationRows.tsx; Surface contract publication.
- **Reversibility:** medium
- **Confidence:** high for the source contract; runtime surface proof pending.
- **Revisit if:** real public navigation cannot open the registered viewer.
- **Source:** assumed — autonomous

## D9: Attribute misplaced mutations before restoring the parent and integrating components
- **Question:** The all-worker barrier found three Engine edits in the parent and a new boundary-guard module outside Surface's initial path list.
- **Options:** trust reports/overwrite unknown bytes; preserve raw calls and prove exact attribution before restoring.
- **Chose:** Preserve the three raw successful relative-header edit payloads and parent diff in external scratch. Reconstruct their effects against ad46e443 and compare Git blob hashes; all three match, with core's repeated unchanged import normalized exactly as the edit tool did. Restore only those three fully attributed parent files to their original bytes; complete intended source remains in the Engine tree. Explicit parent integration scope now owns the small canonical federation/guards.ts boundary module rather than silently accepting undeclared worker scope. Preserve inherited .serena metadata.
- **Why:** Agent relative headers reached parent despite assigned worktrees; no user work may be discarded. All component HEADs remained ad46e443. Returned main inserted new migrations before existing policyMigration; parent corrected to append after the entire established migration prefix, protecting existing stores.
- **Evidence:** component-audit.json, misplaced-tool-payloads.json, parent-attribution.json and misplaced-parent.patch in owned scratch; three exact matching hashes from actual Git; main.ts62-64 parent correction.
- **Reversibility:** easy
- **Confidence:** high for exact attribution/restoration and scope; runtime/type evidence pending.
- **Revisit if:** merged typecheck or smoke exposes a remaining integration seam.
- **Source:** assumed — autonomous

## D10: Repair concrete integration boundaries without weakening identity fences
- **Question:** Merged typechecking and real paired-daemon execution exposed cross-component contract gaps.
- **Options:** unsafe casts/local fallback or suppress failures; repair the actual typed and runtime producers.
- **Chose:** Concrete composed core type, proper local/federated union narrowing and migrated fixtures; remove unused operator/caller-epoch APIs. Route authenticated service starts/controls through the same federation pipeline and declare on in serviceWorkerStart. Keep original task labels separate from worktree creation flags. Permit null-to-known host attachment slots while rejecting changes to any already-proven slot. Preserve host failure detail, stable UUIDv8 relay mutation IDs, and exact verified sender Dispatch routing instead of comparing unrelated supervisor/process epochs.
- **Why:** Initial typecheck reported86 diagnostics, then12; repaired root/mobile typecheck passed24.61s. Actual smoke proved host launch, distinct home/host IDs, no home process creation, correct remote viewer route and ordered F1/F2. It then exposed an unqueued question; after sender routing repair the persisted host queue contained that question, while real daemon logs proved Import/Ack were missing required UUIDs. These are producer/authority repairs, not a passing whole-flow claim.
- **Evidence:** artifacts33,35 and root/mobile typecheck output; actual smoke outputs and safe failure-state/daemon artifacts in owned scratch. A real production openPluginStore upgrade5→7 preserved policy7 and created all federation tables, with homeRemoved:true.
- **Reversibility:** medium
- **Confidence:** high for observed boundaries and exact diagnostics; complete smoke/viewer proof still pending.
- **Revisit if:** the next actual paired-daemon run contradicts these repaired contracts.
- **Source:** assumed — autonomous

## D11: Keep lifecycle identity separate from mutable state and record exercised proof
- **Question:** Real report settlement and owner rejection reached additional authority/concurrency boundaries.
- **Options:** weaken fences or accept transport enqueue as success; retain exact identity while fixing actual state transitions.
- **Chose:** Attach the proven foreign process to the home Dispatch through a distinct core federation-authority method; no local caller evidence. Promote a ready home attempt to dispatched. Serialize per-binding asynchronous imports so simultaneous push/pull cannot both apply one sequence. Compare immutable binding identity independently of active→settled state, allowing the committed home verdict to reach the host. Remove temporary exception logging after finding the exact failure.
- **Why:** The real daemon proved a home completion had committed before a post-commit identity check rejected its own mutable state change. Earlier concurrent status import committed once but a second importer raced the cursor. Both must be replay-safe without re-running kind policy or claiming an absent host exited.
- **Evidence:** Actual readonly queue/inbox snapshots and isolated exception trace; final two-real-daemon/real-PTY CLI smoke exit0 in14.15s: illegal placement refused, distinct home/host IDs with no home spawn, ordered F1/F2, blocking question→beta, heartbeat/status, actual2433-byte remote output, home completion before host acceptance, released archived output/fleet, real installed owner rejecting then accepting a remote new-top-level worker, exact stop preserving both coordinators. Both homes removed.
- **Reversibility:** medium
- **Confidence:** high for these paths; acceptance suites/restart/fault campaigns remain unexecuted under LOOP.
- **Revisit if:** end-phase execution contradicts the observed contracts.
- **Source:** assumed — autonomous

## D12: Report focused shipped-view evidence without claiming a UI campaign
- **Question:** What actual visible behavior was exercised under the required minimal runtime verification?
- **Options:** infer UI from types; run a full forbidden dogfood campaign; exercise the actual shipped components against private real daemons.
- **Chose:** Build a temporary adapter around shipped OrchestrationRows, terminal task-link handler and registered RemoteWorkerOutputView. Actual sidebar and task-link clicks opened the fixed remote-output route; viewer showed worker-host, terminal source, live evidence, source fallback and real FEDERATION_SHIPPED_VIEW output. Refresh worked; no toast was shown. Close the browser, stop the owned service and remove both homes. Do not call this full-app/native or all-scenario coverage.
- **Why:** The coding contract requires actual surface proof while LOOP defers campaigns. Scratch bundling initially lacked plugin-owned React dependencies, corrected by linking that actual dependency directory. The adapter's SSE hit Bun's default10s idle timeout; this produced a transport warning, not a viewer success fabrication.
- **Evidence:** Screenshot omp-sshots-15b823586b1ed1dc.webp and actual route/taskTerminal response; federation-surface-lane5-v3 exit0 with both homeRemoved:true. Root/mobile typecheck passed24.65s after the real-path repairs. The earlier two-hour item target was not met; no new flow or external blocker was invented to hide the implementation work.
- **Reversibility:** easy
- **Confidence:** high for the exercised shipped surfaces; full suites/reviews/native/TLS-network campaigns were not run.
- **Revisit if:** end-phase browser/native checks expose different behavior.
- **Source:** assumed — autonomous

## D13: Preserve incoming product exclusions and final caught-up gate evidence
- **Question:** Did the single roadmap catch-up introduce an authority conflict?
- **Options:** silently override incoming decisions; read and compose the binding log.
- **Chose:** Read all sb-mobile-chat-voice-native-ruling D1–D6 and Progress. Preserve background-only structured workers, no native chat/dictation product, no Native-browser substitution or phone authority growth. The catch-up changed only queue/index/blocker/decision documentation, not this exercised source. No follow-up is needed because every claimed worker-federation flow has a real implementation and acceptance source.
- **Why:** Worker federation reuses background workers and explicit paired-daemon authority; it does not authorize the independently blocked mobile products. The branch remains one claimed item, with no second queue claim.
- **Evidence:** Actual git merge build/roadmap changed four documentation files without conflict; full incoming decision log read. Caught-up root/mobile typecheck passed24.44s. Prior focused real smoke exit0/14.15s, migration5→7 and actual shipped-view evidence retain their stated limits; no suite/review/native claim.
- **Reversibility:** easy
- **Confidence:** high for inspected binding compatibility and exercised checks.
- **Revisit if:** the controller's merged-source typecheck names a concrete integration conflict.
- **Source:** locked by docs/loop/LOOP.md

## Progress
Implementation, acceptance sources, README/spec/decisions and focused proof are complete. Single roadmap catch-up and complete incoming binding review done; caught-up root/mobile typecheck passed. All implementers and owned UI/daemon/browser processes finished; component trees removed with inherited metadata preserved. Next: commit this evidence, detach and canonical queue.ts land m7-orchestration-worker-federation; await its receipt before ending this iteration. No second claim and no whole-queue completion marker unless the canonical queue later returns done/check succeeds.
