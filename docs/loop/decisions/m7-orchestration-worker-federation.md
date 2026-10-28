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

## Progress
Claimed exactly this item after canonical waits returned busy14 times including the final wait that claimed it. Combined spec self-reviewed; shared federation ports and on/remote-host worker types ready for contracts commit. Next: dispatch three isolated implementers, integrate, typecheck and narrow real paired-daemon smoke, catch up once/read new decisions, commit/detach/canonical land and await receipt. No suites/reviews/full UI/native passes claimed; inherited .serena/ untouched.
