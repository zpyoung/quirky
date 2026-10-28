# m5-automations-dispatch-remote-and-args decisions

## D1: Stop at the missing public host execution prerequisite
- **Question:** Can this follow-up implement SSH/runtime registration-generation fencing and workspace pin/re-pin/re-adoption through the current public plugin API?
- **Options:** consume an existing public host authority; invent automation-private SSH/process routing; block until the prerequisite exists
- **Chose:** block the item; preserve existing local ownership and fail-closed remote refusal unchanged
- **Why:** The prerequisite named in the item title still does not exist. Inspection of all 29 built-in manifests found 638 public methods but no SSH/runtime registration-generation authority. The actual repo/worktree/checks/structured schemas have no remote destination or registration-generation contract. An automation-only generation field cannot fence the side-effecting execution primitive. Implementing a general remote runtime/registration subsystem is not this dependent automation integration item.
- **Evidence:** plugins/quirky.automations/dispatch-contract.ts:4-32; plugins/quirky.automations/target.ts:124-151; plugins/quirky.repo/quirky-plugin.json:422-458; plugins/quirky.worktree/quirky-plugin.json:196-283,1324-1358; plugins/quirky.checks/quirky-plugin.json:14-46; plugins/quirky.structured/main.ts:569-597; executable manifest inspection on 2026-10-28 enumerated 29 plugins/638 methods, no registration-generation declarations, and printed parameter names for the five required execution/resolve methods
- **Reversibility:** easy (resume this item after the public foundation lands)
- **Confidence:** high for current checked-out public contracts; no live SSH runtime capability claimed
- **Revisit if:** public host registration/incarnation lookup, remote repo/workspace identity and generation-fenced worktree/checks/structured execution are implemented
- **Source:** locked by docs/loop/decisions/m5-automations-dispatch.md D3

## D2: Resolve raw extras by retaining the locked native-options-only policy
- **Question:** Does resolving the extra-agent-arguments portion authorize raw argv parsing, partial translation or a terminal fallback?
- **Options:** forward raw argv; partially translate the feature-doc allowlist; retain catalog-native model/effort and explicit raw-argument refusal
- **Chose:** retain native model/options and raw-argument refusal; no product change is needed for this policy resolution
- **Why:** Structured-runner D6 explicitly refuses extras and uses the shared native launch resolver. Automation create/edit already reject nonblank extraAgentArgs before persistence; structured create independently rejects extraArgs and unknown parameter names. The feature doc's terminal argument mechanics do not override the locked structured background architecture. No alias, parser or false capability was added.
- **Evidence:** docs/loop/decisions/m5-structured-runner.md:55-63; docs/loop/decisions/m5-automations-dispatch.md D1-D2; plugins/quirky.automations/service.ts:484-505; plugins/quirky.structured/main.ts:569-597; research/orca-features/automations.md, Extra agent args and launch overrides
- **Reversibility:** medium (a policy change must update launch resolution, native runner semantics and snapshots together)
- **Confidence:** high
- **Revisit if:** an explicit decision supersedes D6 and specifies a complete structured-native representation
- **Source:** locked by docs/loop/decisions/m5-structured-runner.md D6

## D3: Keep the remote flow whole rather than land metadata-only scaffolding
- **Question:** Can a useful independently complete flow land while remote execution remains unavailable?
- **Options:** persist remote selectors/generations with no execution; claim completion of existing local behavior; block the core remote integration item
- **Chose:** block, with no follow-up queue duplication and no new production types, schemas or tests
- **Why:** Local owner/instance fencing and native launch settings already shipped in the dependency. Every newly requested remote flow depends on the absent public authority and execution route. Metadata-only pinning would not implement remote execution or safe re-adoption and could misrepresent unsupported ownership. No independent unbuilt flow can ship from this item without that prerequisite.
- **Evidence:** docs/quirk/specs/2026-10-27-m5-automations-dispatch/logic.md:13-18,102-106; research/orca-features/automations.md, Workspace policy, pin, and re-pin and Execution target, owner, and host fencing; docs/loop/LOOP.md, Blocking an item
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** the missing public foundation becomes available
- **Source:** assumed — autonomous

## D4: Resolve unattended workflow and evidence boundaries without running the deferred end phase
- **Question:** Which brainstorming questions, implementation phases and checks apply to a prerequisite-blocked feature item?
- **Options:** ask a person; invent unresolved contracts and dispatch implementers; investigate current contracts, record the blocker and stop before implementation
- **Chose:** API/CLI/Data/Integration scope; preserve existing JSON/error/auth/CLI behavior, authoritative registry mapping, explicit stale-owner conflicts, no automatic remote retries or local fallback, and native-only provider settings. No UI redesign, schedule change or extra trigger. Skip visual/adhd offers, external research swarms, speculative spec/contracts, implementation and review. Preserve inherited .serena/ unchanged. No tests, builds, typecheck, runtime launch or dogfood run because no executable behavior changed; only read-only executable manifest inspection was performed.
- **Why:** LOOP forbids human questions and moves feature testing/review to the end phase. The essential purpose, consumers, scope, constraints, success bar and unavailable prerequisite are established by the feature doc, roadmap and binding decisions. A read-only scout returned current source evidence; one parent inspection corrected its first manifest enumeration from contributes.api to the actual contributes.method before relying on the output. No failed/empty enumeration is claimed as proof. Platform execution is unverified, not inferred.
- **Evidence:** authoritative build/roadmap:docs/loop/LOOP.md, Build first, test at the end and Answering a skill's questions; docs/roadmap.md:19-38,47-53,202-214; current manifest enumeration and parameter inspection results; MapRemoteAutomation read-only report
- **Reversibility:** easy
- **Confidence:** high for inspected contracts only
- **Revisit if:** the item resumes with real public host contracts and implementation can begin
- **Source:** locked by docs/loop/LOOP.md

## Progress
Blocked at step 3 prerequisite/feasibility research before spec or implementation. Raw-argument policy is resolved by D2 with existing behavior unchanged. No production code, test, schema or runtime state changed; the only item artifact is this decision log. All agents have returned and no background command or service remains. Commit this log, rename build/m5-automations-dispatch-remote-and-args to blocked/m5-automations-dispatch-remote-and-args, detach and invoke the authoritative absolute queue.ts block command with the external blocker entry. Resume only after generation-fenced public host/runtime execution contracts exist. No person is asked a question in this unattended iteration.
