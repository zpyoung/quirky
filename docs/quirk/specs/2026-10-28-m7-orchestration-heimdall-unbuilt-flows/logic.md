# Federated orchestration and host-authoritative Heimdall

## Status & amendments
Approved autonomously under LOOP.md. Combined logic and technical specification; separate review and tech.md omitted under build-first rules. 2026-10-28 initial design.

## Goal and conceptual model
Keep Run/Task authority on the coordinator's daemon while a configured, authenticated peer owns the actual worker process. Heimdall remains a generic plugin kernel: workspace-host epochs fence execution, kind-owned submission hooks guard reports before settlement, and external judgments are optional observations, never action authority.

## Scope and non-goals
Implement the queue item's remote placement/attachment, bidirectional durable mail/ask/report relay and settlement, remote stop/release/read/fleet/task navigation, Heimdall local workspace-host epoch leases, confirmed registered-workspace removal, paired fleet/control routing, private optional shadow judgments and public kind-owned submission preflight. Preserve m6-orchestration-core D9. Existing queued idle-pointer/shutdown and host-power items retain their flows. Objective runner, PR sitter, non-GitHub hosting, native remote window creation and Linux/Windows verification are not included.

## Alternatives and decisions locked
- Use a dedicated authenticated peer endpoint contributed by orchestration, not mobile pairing (whose phone-specific method ceiling and identity cannot grant server authority). HTTPS for non-loopback transport; loopback HTTP permits isolated multi-daemon development. Explicit private shared pairing credentials and pinned stable fingerprint, incrementing pairing revision, per-start incarnation. Never publish secrets in inventory or logs.
- Reject transparent local fallback and unrestricted generic remote RPC. Peer dispatch only admits federation-owned orchestration methods and dedicated Heimdall remote endpoints. Plugin-only local peerCall routes calls; remote authenticated identity is re-derived at the boundary, not accepted from request JSON.
- Preserve existing Task/Dispatch/mailbox/lifecycle code; federation records bind home IDs to the host-owned Run/Dispatch and exact process identity. Remote uncertainty stays unknown, not failed/exited. Durable request identities and contiguous relay cursors prevent duplicate process actions and reports.
- Leases live on the workspace host, not in an in-memory map or only the watcher database. Atomic epoch claims and holder+epoch release/assert prevent stale writers. Use host time and a 90s TTL renewed at 30s. Failed reads/contact are unverifiable. Only an authoritative worktree inventory removal event or confirmed registered-workspace absence may terminate supervision; missing filesystem paths alone do not authorize cleanup. Never stop or release workers on removal.
- Shadow provider config is a private regular file under the plugin data directory, enabled explicitly. Bounded state/request/response sizes, deadlines and retries. No config/key means no outbound request. Judgment answers only append observations and never approve, dispatch or settle effects.
- A kind may register an owner-namespaced submission hook. A report on its owned Run is offered to that hook after sender/Dispatch authority checks but before lifecycle settlement. Rejection persists an explicit rejected receipt and leaves assignment active; timeout/unavailable hook cannot silently accept. No hook preserves existing acceptance.

## Flow acceptance scenarios
1. **Remote start and fencing.** Before: coordinator owns Run R and ready Task T, paired peer P revision1. Start on P with an exact remote worktree or new-top-level placement. After: T's home Dispatch maps to an actual peer worker, reports its exact incarnation, and no local worker is launched. Invalid placement/capability/pin/revision refuses before effects. Lost receipt is start_unknown and retries use the same durable request.
2. **Relay and questions.** Before: ready remote worker D. Worker status/question and coordinator reply cross durable ordered queues once. After: home mailbox owns delivery/ack, remote ask resumes the same question; gap, reconnect or duplicate does not fabricate settlement or lose unread mail. Worker_done receives home's actual accepted/rejected lifecycle verdict.
3. **Remote lifecycle and output.** Before: retained live peer worker. Read gets bounded real peer output; fleet distinguishes assignment from process liveness. Stop/release require pinned peer, current incarnation and exact custody; changed identity or lost contact returns unknown/refused and never closes a replacement. Task navigation resolves peer provenance instead of focusing a local lookalike.
4. **Workspace-host epochs.** Before: two kernels on the same workspace. Only the current unexpired holder executes; after expiry a higher epoch may claim. Old assert/release cannot affect the new holder; lease loss fences new effects. Missing permissions/unavailable workspace is unverifiable, not removal.
5. **Mirrored fleet and controls.** Before: local plus paired remote watcher. Fleet includes both, target contains peer revision, detail/debug and commands reach the actual owner with full expectedOwner fence. After disconnect: keep last confirmed row marked unverifiable; no optimistic applied result. Stale pair/owner/command revisions refuse and do not mutate.
6. **Optional judgment.** Before: no private enabled config. Tick makes zero provider calls. With valid private config, a bounded provider result appends a shadow observation; malformed/oversized/timeout results are observations of failure and never change a gate. API keys never enter fleet/debug/journal.
7. **Confirmed removal.** Before: live watcher and running workers on registered workspace. An authoritative removal terminates/disarms watcher and closes billing without stopping/releasing processes. Failed inventory/path checks alone keep supervision unreachable rather than terminal.
8. **Submission preflight.** Before: active authenticated worker report and registered kind submission hook. Rejected report leaves Task/Dispatch unsettled and returns rejected lifecycle. Accepted report uses existing settlement. Cross-plugin hook spoof, stale dispatch or unverified sender never invokes privileged kind logic or settles work.

## Defect and failure invariants
Absence/timeout is never positive proof. Peer capability/version skew is an explicit refusal. Pin/revision/process mismatch cannot mutate another host/process. Duplicate deliveries and mutation retries cannot repeat side effects. UI fleet refresh preserves last confirmed evidence. Existing core gate semantics and current local flows remain intact.

## Industry insights
Use repository feature docs and prior decisions as the research source per LOOP's no-research-swarms rule. Sources: external orchestration.md Federation/Fork relation/Races; external heimdall.md Leases/Judgment/Fleet/Workspace deleted; m7-sweep-orchestration D7,D8,D11,D15. No external research claimed.

## Glossary
Home: Run/Task authority. Peer: explicitly paired daemon. Pairing revision: local pairing-generation fence. Incarnation: a daemon-start identity. Epoch: monotonically advancing workspace lease identity. Submission: authenticated worker status/report offered before settlement. Shadow: observation with no execution authority.

## Deferred ideas
None added by brainstorming. Any inaccessible external prerequisite must be recorded precisely as a decision and at most one implementation-only follow-up; never a verification follow-up.

## Technical decisions and implementation contracts
Shared JSON contracts are committed in packages/protocol/src/runtime-peers.ts before implementers. quirky.orchestration contributes peerList (safe inventory), peerStatus and plugin-only peerCall with RuntimePeerCall/Reply. Peer transport admits only federation endpoints plus quirky.heimdall/remoteFleet, remoteDetail, remoteDebugReport and remoteCommand. RuntimePeerStatus includes stable fingerprint, current incarnation and capabilities. Request IDs are mandatory for remote mutations. Dedicated remote endpoints require kernel-authenticated quirky.orchestration plugin callers; arbitrary peer-supplied pluginId is never trusted.

Three disjoint implementation components: (A) plugins/quirky.orchestration/** owns peer transport, all federation/lifecycle/mail/navigation/API/CLI and their regression source; (B) plugins/quirky.heimdall/** except control-api.ts/fleet.ts/ui.tsx/control-contracts.ts owns epoch leases, removal authority, shadow judgment and submission integration via public orchestration calls; (C) those four excluded Heimdall files plus new remote-fleet.ts and remote-fleet tests owns mirror/control/UI integration. Parent owns public protocol, specs, decision log, docs, cross-component integration and queue.

Submission RPC seam: quirky.heimdall/submissionPreflight accepts OrchestrationSubmission and returns OrchestrationSubmissionVerdict. Orchestration calls it only for owned Heimdall service Runs (and does not accept callback methods from untrusted worker params); Heimdall rechecks Run/enrollment ownership and validates registered hook namespace. Generic registration can store a preflight method reference using an owner-only registration API, including future third-party consumers; no private imports across plugins.

Write boundary/acceptance regressions with fresh HOME/QUIRKY_HOME and disabled hook installers. Do not run suites or review campaigns in this phase. Parent runs typecheck after all source workers return, plus a minimal actual changed-path smoke required by the coding contract. End-phase owns full execution/debugging. Platform portability remains unverified outside macOS.
