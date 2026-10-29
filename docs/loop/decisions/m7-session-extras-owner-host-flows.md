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

## D7: Establish missing-feature RED before the three source implementations
- **Question:** Can inherited owner transport tests stand in for acceptance of these missing feature compositions?
- **Options:** Infer coverage from dependencies; write forwarding/catalog mirrors; exercise new flows against real registered owner daemons first.
- **Chose:** Tests-first component drafts, parent-only canonical remote runner, then explicit source GO. Accounts two files fail on absent ownerCall and absent owner-scoped UI loads/requests. Vault fails its production contributor test (one local duplicate-provider record instead of three host-qualified records). Handoff corrected API test fails on absent remote prepared candidate after real pairing/registration. None is called a passing gate. Renderer forwarding/catalog-copy assertions are removed rather than re-pinned; actual generated CLI must prove dispatch.
- **Why:** Real setup reached the missing behavior. Vault's second test initially hit a reserved QUIRKY_ fixture env name; worker corrects that precondition without weakening redaction. Handoff's first test had an unescaped apostrophe; parent corrected exactly that syntax and reran to obtain the actual missing-feature RED. Existing runner isolation retry repeats failures and is retained, not hidden.
- **Evidence:** parent suite commands on component Vault1file (exit1/18.43s), Accounts2files (exit1/30.71s), initial Handoff2files (exit1/15.50s), corrected Handoff1file (exit1/13.77s), all remote quirkyci@34.122.38.64, zero configured flaky passes. Raw tool outputs identify missing source behavior and fixture failures.
- **Reversibility:** easy
- **Confidence:** high for exercised RED; no implementation pass claimed
- **Revisit if:** Implemented source does not pass the composed consumer acceptance or actual real-PTY smoke.
- **Source:** assumed — autonomous; locked by operator remote-test placement and test-before-implementation workflow

## D8: Close Accounts declaration, scope and real-transport fixture defects at their owners
- **Question:** What did the first actual implementation gates establish, and what caused each failure?
- **Options:** Suppress unknown methods/errors, re-pin defaults or loosen deadlines; repair the invalid declaration, source guards and actual fixture boundary.
- **Chose:** Rename the newly added CLI flag params to operation-params because the manifest reserves params; migrate its actual generated handler/test/docs with no alias. Replace undefined asRecord references with the existing window isRecord guard. Compare unchanged pending-login identity/state against the real setup baseline, not an incidental null default. Identify the actual sign-in action semantically, preserve Bun network globals around HappyDOM, and settle in-flight fixture RPC before teardown. Use nullable-timer guards and explicit scope discrimination from actual compiler errors.
- **Why:** The invalid CLI declaration disabled the entire plugin, explaining existing beginLogin method-not-found. After that fix, real scoped API/CLI selection passed before the UI source guard and invalid default expectation failed. The final three-file component gate passed17.18s/no flakes; after integration and compiler fixes, all17 Accounts files pass24.99s/no failures/flakes. The initial compiler's9 diagnostics are retained; a fresh complete compiler gate remains required after composition.
- **Evidence:** component f6ad2070 merged; actual remote gates17.89s/20.18s/22.92s failures and17.18s/24.99s successes; compiler artifact70 exact source lines; unchanged private local/remote auth/profile and scope-race assertions.
- **Reversibility:** easy
- **Confidence:** high for executed Accounts behavior and source/declaration causes; no full-item or native sign-in claim
- **Revisit if:** Composed compiler/importer/runtime/UI evidence reveals another scope or lifecycle mismatch.
- **Source:** assumed — autonomous, observed red/green evidence

## D9: Repair the actual paired-search payload and fixture activation boundary
- **Question:** Why did all-host search fail while direct owner search and manually forwarded requests succeeded?
- **Options:** Weaken encrypted transport validation, guess index timing or suppress host failures; trace exact request/response shapes and fix their producer.
- **Chose:** Preserve raw bounded diagnostics and fix aggregateSearch so it removes the aggregate cursor and includes a host cursor only when it is a string. The prior own cursor:undefined violated paired-client checkJsonTree before JSON serialization; direct QuirkyClient diagnostics hid it by dropping undefined during serialization. Remove every temporary trace/debug flag after closure. Keep all-history fixtures explicit, but do not call the earlier retention hypothesis the transport root cause.
- **Why:** Actual safe boundary traces showed raw own-undefined cursor versus absent serialized cursor, successful direct host indexes and manual forwarded shapes, and generic runtime failure only for the plugin's in-memory payload. Protocol client.ts93–114,281–291 establishes the pre-serialization rejection. The real production-provider acceptance then progressed through search, scope and partial failure checks.
- **Evidence:** raw artifacts64/69/74; service aggregate hostRequest1216–1219; protocol paired-client/client.ts checkJsonTree; post-fix production-provider gate.
- **Reversibility:** easy
- **Confidence:** high for the exercised payload defect and narrow producer correction
- **Revisit if:** A host cursor or another optional parameter can still create an own undefined value at this strict boundary.
- **Source:** assumed — autonomous, source-proven boundary trace

The next privacy assertion exposed a separate fixture contamination: lazy Vault activation occurred only after all three in-process kernels had changed process.env to the last owner. main.ts snapshots env correctly at activation, but the fixture never activated the earlier rigs in their own environments. A public local searchStatus call now activates each rig before the next one starts, without enabling indexing or changing the three-kernel topology. Per-activation worker ownership remains the production implementation; no eager startup/global fallback was added. The targeted production case passes19.66s/no flakes. All25 Vault files then report24pass/1fail solely at the expected still-uncomposed Handoff source.archived.owner schema boundary (87assertions reached); full composed acceptance is still required.

## Progress
Specs/contracts and bounded combined review complete. Accounts merged/worktree removed; all17 current Accounts files pass remotely, with narrow compiler repairs awaiting the composed gate. Vault production host/search/partial and local consumers pass; its full owner-action test reaches the still-old Handoff schema boundary. Handoff UI race file passes after component-local listbox identity repair, but its live manifest remains invalid JSON and is being corrected using actual parser locations/registry diagnostics, not guessed suppressions. Parent actual child-daemon/real-PTY/CLI/production-web scenario remains unrun. Next: finish the two components and composed acceptance/types/build/smoke, sole canonical catch-up/full incoming decisions, bounded cross-family final review/fix/check, docs and canonical land.
