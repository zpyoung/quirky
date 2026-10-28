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

## Progress
Combined specification self-reviewed against all claimed flows. Public peer/report JSON contracts prepared before implementation. Next: commit spec/contracts and dispatch three disjoint implementers. Inherited .serena/ untouched. No suite/review/dogfood claimed.
