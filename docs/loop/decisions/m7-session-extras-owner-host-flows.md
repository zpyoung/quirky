# m7-session-extras-owner-host-flows decisions

## D1: Compose the actual registered full-owner runtime
- **Question:** Are the predecessor's host authority prerequisites available, and which authority may the three feature owners use?
- **Options:** Block on historical absence; borrow phone/worker credentials; use current saved full-owner grants and registered mirrors.
- **Chose:** Existing quirky.cli/runtimeCall with both expectedHost and expectedRuntime, resolved against canonical quirky.worktree registered hosts and exact workspace mirrors. No local fallback.
- **Why:** Both dependency items are done; read-only source inspection establishes real same-connection host-generation and pre-network saved-grant fences. The three feature compositions remain absent.
- **Evidence:** packages/protocol/src/runtime-owner.ts; plugins/quirky.cli/main.ts101–180; plugins/quirky.worktree/src/daemon/remote.ts298–342,699–857; m7-sweep-sessions D16/D28; OwnerHostPrerequisites and SessionHostFeatureMap source maps.
- **Reversibility:** hard
- **Confidence:** high
- **Revisit if:** Real paired-owner acceptance shows a missing authority contract.
- **Source:** locked by dependency decisions and queue scope

## D2: Resolve autonomous gray areas without introducing another transport
- **Question:** Which defaults govern identity mapping, auth, errors, UI scope, loading, persistence, and cross-host transfer?
- **Options:** New host transport/plugin authority; silent local substitution; explicit host-qualified existing feature controls and failure states.
- **Chose:** Existing Accounts/Vault/Handoff built-ins and public APIs; focused exact-window workspace owner for Usage/Accounts with explicit visible scope; remote browser sign-in disabled; local preferences remain local. Stable host IDs are labels only until generation/grant/instance checks pass. Remote Vault inspection is sanitized, resume executes on that owner, and remote archived handoff opens the local review dialog carrying a validated owner/source reference. Target-side probe and detection use the exact target owner; cross-host secrets warn without falsely blocking; lineage carries both execution hosts. Offline/changed bindings fail visibly and preserve drafts, no uncertain automatic resend or destructive replay.
- **Why:** Accounts Remote server scope, Vault host/enable-all/actions/transport policy, and Handoff target/probe/delivery sections establish these observable outcomes. Purpose, consumers, scope, constraints, main behavior and success are covered by those flows; defaults are elected autonomously under LOOP.
- **Evidence:** external accounts.md93–97; ai-vault.md24–99,203–230; handoff.md35–60,122–208; docs/loop/LOOP.md Answering a skill's questions.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** A retained feature flow cannot be represented safely through these controls.
- **Source:** assumed — autonomous

## D3: Preserve independent feature slices and end-phase gates
- **Question:** How should this unattended omp item be specified, implemented and verified?
- **Options:** Typecheck-only historical shortcut; overlapping source writers; normal end-phase specs, disjoint workers, composed checks and bounded review.
- **Chose:** Sibling logic/tech specs, Codex combined spec review; shared owner-session reference types committed before three feature implementers. OpenAI task implementers; actual pi-watch --check finds Opus/sonnet unavailable and Gemini3.1Pro reachable, so Gemini is final cross-family reviewer. One discovery/fix round per LOOP. Every executable test and throwaway daemon scenario uses bun scripts/suite.ts; no real profile writes. Parent owns integration, shared contracts, one roadmap catch-up, evidence and canonical landing. Existing .serena/, test.ts and test-migrated.test.ts are inherited and remain untouched.
- **Why:** m7-test-triage already began, ending build-first shortcuts; independent feature scopes buy parallelism without shared-source races. Complexity gate fires across three subsystems and more than three files.
- **Evidence:** current authoritative LOOP; actual pi-watch all-alias probe exit5 (7/12 reachable); dependency D15/end-phase records; initial worktree status detached with only those three untracked entries.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** Reviewer dispatch or runner availability actually fails.
- **Source:** locked by docs/loop/LOOP.md; assumed — autonomous for backend fallback/isolation

## D4: Keep excluded capabilities and platform claims separate
- **Question:** Does paired-owner feature composition authorize SSH/WSL, native chat, dictation, quarantine, new credential scopes or deferred providers?
- **Options:** Reintroduce them to simplify integration; preserve the explicit exclusions.
- **Chose:** No SSH/WSL/native chat/dictation/quarantine; no GitLab/Bitbucket/Gitea/Azure, Objective runner or PR sitter; no phone/federation authority reuse. macOS product target only; remote Linux test placement is not a Linux product support claim. Native OS/browser/sign-in success is not inferred from API forwarding or a WebView shim.
- **Why:** Locked roadmap/architecture, predecessor D4, and queue title explicitly exclude these capabilities.
- **Evidence:** docs/architecture.md Decisions; docs/roadmap.md What the order rests on; m7-sweep-sessions D4/D12/D16; exact queue title.
- **Reversibility:** hard
- **Confidence:** high
- **Revisit if:** An authorized product ruling changes scope.
- **Source:** locked by docs/roadmap.md and docs/architecture.md; deferred: platform

## D5: Adjudicate the actual spec gate rather than call its models a clean gate
- **Question:** Did the required Codex combined-spec review establish implementable contracts, and what did its failed mechanical gate mean?
- **Options:** Label two empty model arrays PASS; discard the prepass; retain the failed gate and correct/adjudicate every reference.
- **Chose:** Actual standard no-tools Codex promote and fresh-refute calls returned valid empty arrays with no retries. Mechanical gate is NEEDS_FIXES with28 MEDIUM reference findings, zero suppressed. Accept F1–F10/F13–F25 as ambiguous package-relative pointers and expand them to full repository paths; F11/F12 are explicitly planned new test files, not missing implementation prerequisites. F26 is a contribution ID, F27 an RPC method and F28 a tagged shell command, not filesystem paths. Clarify those forms without changing the command. No semantic model defect was raised; do not relabel the recorded gate PASS.
- **Why:** The archived combined scratch bundle contained the exact committed specs but no repository .git; section coverage passed while symbol checking was skipped/tree_hash null. Both actual model calls completed, but same-family independence is reduced and the manifest records medium thinking ceiling despite high dispatch override. This is bounded specification review, not code/runtime assurance.
- **Evidence:** /tmp/quirky-l7-owner-spec-wiAR1U/{gate.json,manifest.json,prepass-bundle.json,promote.attempt1.stdout,refute.attempt1.stdout}; raw initial range could-not-run attempt retained. Parent read all28 exact findings.
- **Reversibility:** easy
- **Confidence:** high for observed outputs and pointer dispositions; bounded for semantic coverage
- **Revisit if:** Implementers cannot resolve an expanded pointer or a concrete shared contract remains ambiguous.
- **Source:** assumed — autonomous; locked by LOOP combined-spec review and no fabricated output

## D6: Fix shared operation shapes before source writers
- **Question:** Which consumer-visible fields were underspecified when tests were being written?
- **Options:** Let feature writers invent incompatible variants; settle the minimal shared fields once.
- **Chose:** Vault remote resume uses remote:OwnerSessionWorkspaceRef, exclusive with local worktree/group; target-side ownerResume accepts owner-local id plus exact worktree/expectedInstanceId/fork. Handoff prepared candidates use id=mirrorId with .remote binding; public targetAgents({target}) returns the existing listAgents result, forwarding only to target-side ownerAgents({worktree,expectedInstanceId}) for remote detection. prepare remains source-only. Accounts uses its own getLayout/onLayout and retains last workspace owner across nonworkspace Settings navigation.
- **Why:** These are missing parameter/consumer shapes inside approved scenarios, not new product scope. Committing them before implementation prevents parallel drift. Each feature retains its local API and existing delivery/account authority.
- **Evidence:** implementer clarification requests; UiPluginContext getLayout/onLayout in packages/protocol/src/ui.ts328–330; Handoff source.ts148–150 and service.ts354–358; amended tech Contracts & interfaces.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** Actual API/CLI/UI placement proof identifies an unsafe ambiguity.
- **Source:** assumed — autonomous

## Progress
Claimed exactly this item on lane7; created build/m7-session-extras-owner-host-flows from canonical build/roadmap. Both dependencies ready. Read all three feature-doc flows, mapped current APIs and verified reviewer availability. Next: finish sibling specs/shared contracts, combined spec review, three disjoint implementers, composed runtime/suite/typecheck/build/UI evidence, single catch-up and bounded final review, then canonical land.
