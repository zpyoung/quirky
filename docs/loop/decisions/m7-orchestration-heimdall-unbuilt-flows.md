# m7-orchestration-heimdall-unbuilt-flows decisions

## D1: Apply unattended defaults and the combined build-first spec
- **Question:** How should brainstorming/spec/implementation gates run unattended?
- **Options:** human questions and external swarms; autonomous standard gray-area answers from the feature docs and prior decisions.
- **Chose:** Autonomous recommended defaults, markdown combined logic/technical spec, no visual companion, adhd, human asks or research swarms; self-review against every claimed flow.
- **Why:** Current LOOP explicitly requires this build-first workflow.
- **Evidence:** build/roadmap:docs/loop/LOOP.md, Build first and Answering a skill's questions.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** a locked conflict prevents safe implementation.
- **Source:** locked by docs/loop/LOOP.md

## D2: Dedicated authenticated peer transport with explicit authority
- **Question:** API/integration gray areas: peer auth, conflict handling, retries, response mapping and errors.
- **Options:** reuse phone authority; unrestricted remote proxy; dedicated paired server protocol.
- **Chose:** Scoped peer endpoint, private explicit pairing credentials, pinned stable fingerprint, pairing revision and daemon incarnation; HTTPS off loopback. Durable mutation IDs and ordered relay; uncertainty never becomes local success or absence proof.
- **Why:** Phone method ceilings and identities do not authorize server placement. No server transport exists in the current implementation map, so it must be supplied rather than simulated.
- **Evidence:** source inventory FlowPrerequisiteMap; orchestration.md Federation and Safe failure; m7-sweep-orchestration D8,D15.
- **Reversibility:** hard
- **Confidence:** medium
- **Revisit if:** a real existing peer boundary provides equivalent fencing.
- **Source:** assumed — autonomous

## D3: Host epochs, authoritative removal and optional shadow observations
- **Question:** Data/integration gray areas: who owns lease time, removal evidence, credentials and judgment effects?
- **Options:** in-memory lock/path absence/always-on provider; host-resident epochs/authoritative inventory/private opt-in shadow client.
- **Chose:** Host epoch claims with holder+epoch assertions and release; 90s TTL/30s renewal. Terminate only on confirmed registered-workspace removal, never stop/release workers. Private regular-file judgment config, bounded bytes/deadlines/retries; observation-only outputs and no secret leakage.
- **Why:** These are the documented host-authority and shadow-only invariants. Missing contact cannot establish removal or effect outcome.
- **Evidence:** heimdall.md Leases, Judgment, Fleet and Workspace deleted.
- **Reversibility:** hard
- **Confidence:** high
- **Revisit if:** real host authority is unavailable or provider contracts contradict documented endpoints.
- **Source:** locked by research/orca-features/heimdall.md

## D4: Report-specific kind preflight precedes orchestration settlement
- **Question:** Where can a kind reject reports while preserving worker authority?
- **Options:** existing action preflight; post-settlement callback; authenticated submission hook before settlement.
- **Chose:** Public owner-namespaced submission hook after sender/Dispatch membership validation and before settlement; rejected/unavailable hook never silently accepts. Absent hook preserves normal local acceptance.
- **Why:** Action preflight cannot guard report submission, and post-settlement rejection is too late.
- **Evidence:** m7-sweep-orchestration D11; orchestration.md Fork relation.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** generic owners cannot prove Run/Dispatch membership.
- **Source:** assumed — autonomous

## D5: Three disjoint implementation components after shared contracts
- **Question:** Execution decomposition and model pairing.
- **Options:** overlapping shared-tree edits; three isolated vertical components.
- **Chose:** OpenAI task implementers. Orchestration owns its entire plugin; Heimdall host/runner/submission/judgment excludes fleet/control/UI files; fleet component owns those excluded files. Parent owns public protocol/spec/docs and integration. Review is postponed by current LOOP, not claimed passed. Opus preflight actually returned unavailable (exit5); no reachable reviewer claimed.
- **Why:** Explicit RPC signatures allow concurrent work without shared source edits. xd://lsp status returned no configured servers, so source searches provide caller inventory.
- **Evidence:** logic.md Technical decisions; FlowPrerequisiteMap; actual lsp and pi-watch outputs.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** a shared-file dependency requires sequenced parent integration.
- **Source:** assumed — autonomous

## D6: Preserve core gate semantics and existing pointer/power ownership
- **Question:** Should this item amend gate readiness or duplicate queued flows?
- **Options:** amend D9; preserve D9 and existing queue owners.
- **Chose:** Gate resolution readies Task; dispatch admission separately rechecks dependencies/pending gates. Existing idle-pointer/shutdown and host-power items retain their flows. Objective runner, PR sitter and non-GitHub hosts remain excluded.
- **Why:** Item title and prior decisions lock these boundaries.
- **Evidence:** m7-sweep-orchestration D7,D15; m6-orchestration-core D9.
- **Reversibility:** hard
- **Confidence:** high
- **Revisit if:** an authorized decision supersedes the lock.
- **Source:** locked by docs/loop/decisions/m6-orchestration-core.md

## D7: Preserve isolated runtime state and macOS validation boundary
- **Question:** Test state, portability and verification timing.
- **Options:** ambient homes/full campaigns now; isolated fixtures and end-phase campaigns.
- **Chose:** Fresh HOME/QUIRKY_HOME and disabled hook installers for spawned fixtures; no changes to real user state. Write acceptance sources without running suites/reviews/dogfood. Parent typecheck and minimal changed-path smoke only. Portable APIs where cheap; Linux/Windows remain unverified.
- **Why:** Current LOOP defers campaigns, while the coding contract still requires actual changed-path runtime evidence. Platform scope is locked to macOS.
- **Evidence:** docs/loop/LOOP.md Hard rules/Build first; docs/roadmap.md Platforms.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** end-phase triage starts or platform checks become authorized.
- **Source:** deferred: platform

## D8: Derive provider questions and early-report authority from actual contracts
- **Question:** The first judgment source used an inferred provider payload, and report admission depended solely on a ready receipt already present in the watcher journal.
- **Options:** ship inferred `{model,kind,state}`; invent generic judgment policy; use verified provider questions from an optional kind hook. Trust only journal mapping; inspect the active owned service Run.
- **Chose:** Verified `{model,state,questions}` protocol from the cited original client, optional owner-namespaced `judgmentQuestions`, no outbound call without non-empty valid questions. Recheck actual owner-scoped serviceRunShow active worker inventory before/after submission hook; journal is supplemental.
- **Why:** Original provider validation requires questions; generic Heimdall must not invent Objective policy. A worker can authenticate and report before worker-start returns ready, so journal timing is not proof of missing Dispatch authority.
- **Evidence:** HostKernelAuthority source investigation of `/Users/zpyoung/PycharmProjects/orca/src/main/fork-heimdall/judgment/client.ts`; returned service.ts initial ownsActiveDispatch; orchestration.md Races and fencing early worker reports.
- **Reversibility:** medium
- **Confidence:** high for documented wire/identity contracts; runtime evidence pending.
- **Revisit if:** actual provider or daemon response violates the consumed schema.
- **Source:** assumed — autonomous

## D9: Integrate attributed source and actual schema/type diagnostics
- **Question:** How should returned component changes and discovered contract mismatches be accepted?
- **Options:** trust reports; overwrite unexpected changes; audit exact scopes and preserve actual outcomes.
- **Chose:** Kernel e72549b8 and fleet 76568327 accepted after original-wave scope/HEAD audit; both worktrees removed. Worker explicitly attributed its accidental parent runner-test edit, and parent restored only its two missing original lines before merge. Synchronize canonical method/event schemas with AST edits, including null for missing detail/debug results.
- **Why:** The first kernel merge refused the unexpected test change rather than overwriting it. Structural plugin validation found four object-only schemas whose implementation returns null. Initial integrated typecheck reported five concrete errors; parent restored budgetUsage import, captured kind identity for closure narrowing, supplied the unavailable-hook fixture control and retained Bun fetch.preconnect on the test seam.
- **Evidence:** Actual merge refusal and worker attribution; git scope outputs and component commits; HeimdallDeclarationCheck structural report; typecheck exit2 in21.37s. Real filesystem epoch smoke returned epoch1 then2 with stale renewal/release false and current release true.
- **Reversibility:** easy
- **Confidence:** high for these exact observations; no suite or full daemon proof claimed yet.
- **Revisit if:** final typecheck or changed-path smoke contradicts them.
- **Source:** assumed — autonomous

## D10: Give paired watchers explicit CLI selectors and incarnation fences
- **Question:** Existing CLI commands always constructed a local target, even though the fleet now contains remote owners.
- **Options:** silently choose a same-ID local watcher; add global remote flags; qualify the existing watcher positional.
- **Chose:** `<peer-id>::<watcher-id>` resolves exactly one current fleet target; list text emits it, detail verifies returned peer/revision, and controls carry the observed owner incarnation. Plain watcher IDs remain local. Declare fleet lookup in each affected CLI method ceiling.
- **Why:** A remote row must be scriptable without guessing a local session or losing pairing authority. Missing/ambiguous/mismatched ownership refuses before mutation.
- **Evidence:** control-cli.ts targetFor/detailFor/commandParams; control-api.ts command declarations; new rejection-boundary regression source. Tests have not run.
- **Reversibility:** medium
- **Confidence:** high for intended contract; actual CLI/daemon smoke pending.
- **Revisit if:** an existing peer ID can contain the reserved `::` separator.
- **Source:** assumed — autonomous

## D11: Defer only the genuinely unbuilt remote worker flows at build-first cutover
- **Question:** The initial federation implementer returned only transport/submission source and a fresh retry had not completed an end-to-end remote worker flow before the prescribed item cutover.
- **Options:** advertise stub worker federation; block useful completed host/fleet work without an external blocker; remove disconnected work and register one product implementation item.
- **Chose:** Land completed peer transport, Heimdall host epochs/removal/judgment/report admission and paired watcher controls. Remove unconnected remote-start APIs, guard stubs, tables and capabilities. One follow-up `m7-orchestration-worker-federation` owns remote placement/attachment, durable mail/ask/report home settlement, worker lifecycle/output/fleet/navigation. No test/review/debug follow-up; no invented external prerequisite.
- **Why:** LOOP requires a build-first, bounded item cutover and allows a single remaining-flow item. The completed flows operate without worker federation; transport is not proof that workers can execute remotely. Original scenarios1–3 remain explicit requirements in the amended spec.
- **Evidence:** original RemoteFederation incomplete return with no external blocker; fresh FederationImplement component; current LOOP Build first, test at the end; external orchestration.md Federation.
- **Reversibility:** medium
- **Confidence:** high that these worker flows are not yet built; no passing worker federation claim.
- **Revisit if:** the named follow-up implements real peer-owned workers and home-authoritative relay settlement.
- **Source:** deferred: remote worker federation

## D12: Keep observed runtime proof narrower than feature acceptance
- **Question:** What did the actual changed-path smoke prove, and what failed before it?
- **Options:** infer full parity from types; retain only observed filesystem, daemon/CLI and shipped-view evidence.
- **Chose:** Record real filesystem epoch1→2 contention/expiry/stale-holder proof; two actual isolated quirkyd/PTY processes, reciprocal pinned pairing/status, secret-free inventory, remote watcher fleet/detail/debug, qualified CLI show and owner-applied budget, remote delete description; actual shipped React view shows peer provenance and applies Pause on the owner. Final owner read returned paused:true/revision2 and both daemon fixtures cleaned with exit0.
- **Why:** This exercises real transport/owner routing without claiming real remote workers, paid provider calls, a complete UI campaign or native window behavior. The smoke caught a missing successful-start `started=true` assignment introduced by the kernel integration; restoring it allowed real kind registration. Initial browser failure was the throwaway adapter's missing onConnection implementation; the final adapter uses actual EventSource state and the final surface reported zero errors.
- **Evidence:** lease-smoke.ts output; heimdall-peer-smoke6f API/CLI output and FINAL_OWNER_STATE; actual browser screenshot/observations at /var/folders/x5/07kj5yld16l9wd5p_v01h20c0000gp/T/omp-sshots-15b808986dc873dc.webp. Earlier failed fixtures and readiness outputs remain historical failures, not passing claims.
- **Reversibility:** easy
- **Confidence:** high for those exact paths only; provider credentials, removal-worker acceptance and full suites remain unexecuted under build-first.
- **Revisit if:** end-phase execution contradicts the observed boundary behavior.
- **Source:** assumed — autonomous

## D13: Preserve landed worker contracts while removing only new disconnected federation work
- **Question:** The cutover retry removed existing includeRemote uncertainty reporting, archived-output reasons and a fleet expiry scheduling call along with its own incomplete federation code.
- **Options:** ship that unrelated worker contract removal; preserve the exact pre-item worker sources and schemas.
- **Chose:** Restore the five affected worker source/test files to the committed pre-item contents and restore workerRead/workerList/worker-list declarations. Keep the existing honest capability_unsupported result; remove only this item's unconnected --on implementation/tables/capabilities. Integrate peer/submission source as f569e2f9.
- **Why:** Existing consumer contracts and expiry behavior are not obsolete merely because worker federation remains deferred. No previously landed behavior is silently weakened. Final type diagnostics also exposed a removed core type import and two incomplete typed worker projections; parent corrected those exact errors and removed unsupported minLength schema keywords while keeping real token byte validation.
- **Evidence:** returned-component scope/diff audit; existing worker snapshots and original manifest declarations; typecheck exit2 in20.81s; core/fixture edits and live plugin activation in the two-daemon smoke.
- **Reversibility:** easy
- **Confidence:** high for preserved source and observed live activation.
- **Revisit if:** the worker-federation implementation replaces these contracts end to end.
- **Source:** assumed — autonomous

## D14: Compose incoming host power and pointer authority without taking their ownership
- **Question:** The one mandatory roadmap catch-up conflicted in the protocol export list and kernel shutdown cleanup.
- **Options:** keep one side and lose an authority boundary; compose the independent additions.
- **Chose:** Preserve both runtime-peers and terminal-artifacts exports; unsubscribe workspace-change handling and dispose host-power callbacks at shutdown. Keep incoming synchronous sleep fencing, late-runner suspended-state inheritance and mailbox-correct pointer/shutdown generation fences. Migrate the new submission fixture to the canonical HostPowerService test capability.
- **Why:** All 14 incoming logs were read completely (155 D entries and14 Progress sections, no unreads). Their authority boundaries are additive and do not grant remote ledger/artifact filesystem or worker execution authority. Our peer transport does not unblock unrelated blocked host-authority work by implication.
- **Evidence:** IncomingAuthorityDecisions report; m6-heimdall-host-power D1,D6; m6-orchestration-idle-pointer-shutdown D8–D10; exact two conflict resolutions. Composed root+mobile typecheck passed24.17s. A post-catch-up two-real-daemon pairing/remote watcher/detail/debug/qualified CLI/owner-budget smoke passed; its fixtures then exited0 and cleaned. The first post-catch-up fixture attempt stopped before daemon startup because its hook-setting overlay needed the current manifest shape; only the private fixture overlay was adapted.
- **Reversibility:** medium
- **Confidence:** high for read decisions, typecheck and exercised API paths; real OS sleep cycle and remote workers remain unverified/unbuilt respectively.
- **Revisit if:** native end-phase or federation implementation demonstrates a conflicting authority seam.
- **Source:** assumed — autonomous

## D15: Register exactly one implementation follow-up and preserve final gate evidence
- **Question:** Which remaining work may stay queued when the amended item lands?
- **Options:** separate verification/debug items; one product implementation item for the genuinely unbuilt remote workers.
- **Chose:** Canonical queue add registered `m7-orchestration-worker-federation`, status todo, depending on this item. Its title names remote placement/attachment, durable mail/ask/report home settlement, lifecycle/output/fleet/navigation and exact peer/process authority; no verification-only work or new external blocker. No second follow-up.
- **Why:** D11 records the allowed flow cutover without pretending peer transport is worker federation. Final source merge d3dd29e5 passed root+mobile `bun run typecheck` in24.09s, after all source/fixture composition.
- **Evidence:** Canonical absolute queue add exit0 and authoritative queue JSON entry; final typecheck output bg7; D12–D14 runtime/evidence limits.
- **Reversibility:** medium
- **Confidence:** high for registration and exercised checks only.
- **Revisit if:** the controller's merged-source typecheck rejects this branch.
- **Source:** deferred: remote worker federation

## D16: Retry only after the controller names a new integration conflict
- **Question:** The first canonical land rejected the branch because roadmap advanced with mobile prerequisites.
- **Options:** force the old merge; follow LOOP step7.3 and compose the new source.
- **Chose:** Controller-required additional catch-up, preserving runtime-peers plus mobile-workspaces/mobile-browser exports. Read all sb-mobile-app-prerequisites D1–D17 and Progress, including the complete Watch ownership decision. Preserve canonical view-parking Sleep distinct from explicit stop-with-history, producer CAS, session-scoped Watch leases and mobile caller provenance. No second follow-up or new host authority implied.
- **Why:** These independent public exports do not compete. Worker federation remains deferred; mobile connectivity/metadata still does not authorize remote filesystem or Native mirroring. This retry follows an actual controller conflict, not routine repeated catch-up.
- **Evidence:** First canonical land exit1 in1.06s with conflict receipt; exact protocol export conflict #3; sb-mobile-app-prerequisites decision log. Source behavior evidence remains D12–D14; fresh composed typecheck is required before this retry.
- **Reversibility:** easy
- **Confidence:** high for inspected additive composition.
- **Revisit if:** the canonical merged-source gate reports another concrete conflict or type error.
- **Source:** locked by docs/loop/LOOP.md step7.3

## Progress
First canonical land rejected only the newly advanced roadmap merge. Controller-required retry source is composed additively and the new mobile decision log fully read. One implementation-only worker-federation follow-up is registered. All owned workers, processes, tabs and component worktrees are finished/removed. Next: commit the resolved retry merge, run root/mobile typecheck, detach and retry the absolute canonical land; record actual receipt in ignored loop notes and remove owned scratch only after success. No suites, full UI campaign, paid-provider call, final review or native OS-cycle pass is claimed. Inherited .serena/ untouched; two-hour target was missed.
