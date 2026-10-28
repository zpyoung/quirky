# m7-sweep-sessions decisions

## D1: Sweep all five session feature docs through their canonical owners
- **Question:** What is the purpose, consumer, scope and success criterion of this iteration?
- **Options:** Rebuild the features; only run inherited suites; inventory every flow and repair missing behavior in the existing built-ins.
- **Chose:** Inventory accounts, AI Vault, handoff, Session Info and terminal dock; implement missing kept flows through their existing public owners and verify the actual changed paths.
- **Why:** The queue names all five docs and roadmap parity requires every kept flow without Orca's defects. Existing implementations and decisions bind this work.
- **Evidence:** docs/roadmap.md:13-55,171-188; external accounts.md, ai-vault.md, handoff.md, session-info.md, terminal-dock.md; canonical queue wait receipt for m7-sweep-sessions.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** A required flow conflicts with a locked architecture decision.
- **Source:** locked by docs/roadmap.md and queue item

## D2: Apply the end-phase verification policy now that triage is claimed
- **Question:** Does build-first mode still suppress testing and dogfood?
- **Options:** Assume the old policy remains; inspect the canonical queue and follow the phase transition.
- **Chose:** Normal end-phase sweep verification; m7-test-triage is in-progress on lane8. Do not run implementer checks mid-flight; parent verifies after the barrier.
- **Why:** LOOP explicitly ends build-first suppression when m7-test-triage is claimed, and this sweep became available after that transition.
- **Evidence:** docs/loop/queue.json m7-test-triage status in-progress/lane8; authoritative build/roadmap:docs/loop/LOOP.md.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** The operator changes verification policy.
- **Source:** locked by docs/loop/LOOP.md

## D3: Resolve unattended gray areas using the existing product contracts
- **Question:** Which Visual, API, CLI, Data and Integration choices apply?
- **Options:** New layouts/auth/persistence conventions; preserve existing defaults, ownership and explicit failures.
- **Chose:** Existing panels, menus, settings and daemon-authoritative view state; visible empty/loading/waiting/stale/error states; schema-generated CLI and existing error envelopes; exact source/account/provider/host identity; bounded data and generation guards; no automatic uncertain resend, scope widening or destructive replay. Usage urgency follows consumption even in Remaining mode; search remains opt-in; edited handoff previews and newer dock drafts survive failures.
- **Why:** These are observable requirements in the five feature docs, not new product design. Standard relevant gray areas are layout/density/interaction/empty/error/loading, auth/errors/pagination, output/flags/recovery, input/error/idempotency, and mapping/conflict/retry. Purpose, consumers, scope, constraints, main behavior and success are established by D1 and the source docs. Markdown combined spec and autonomous approval follow LOOP; no research swarm, companion, ADHD or human ask.
- **Evidence:** External feature docs What the user can do and Edge cases; m3-* decision logs; docs/loop/LOOP.md Answering a skill's questions.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** An actual flow shows a missing public capability.
- **Source:** locked by feature docs and docs/loop/LOOP.md

## D4: Preserve explicit dropped features and other owners
- **Question:** Does the broad parity title authorize native chat, dictation, quarantine, new transports or deferred hosting products?
- **Options:** Reintroduce dropped dependencies; preserve the locked adaptations and implement only kept session flows.
- **Chose:** Interactive terminal plus dock, no native chat or dictation or input-quarantine refusal; no global Claude settings writes; no GitLab/Bitbucket/Gitea/Forgejo/Azure, Objective runner or PR sitter. Reuse authenticated host owners rather than invent authority or widen phone grants. Preserve inherited untracked .serena untouched.
- **Why:** These exclusions are locked by roadmap/architecture or explicit queue scope. A source code path is not authorization to recreate a dropped product.
- **Evidence:** docs/architecture.md:175-178,290-324; docs/roadmap.md:173-181; m3-terminal-dock D10; m3-session-info D5; queue title.
- **Reversibility:** hard
- **Confidence:** high
- **Revisit if:** An authorized product ruling changes the locked scope.
- **Source:** locked by docs/architecture.md and docs/roadmap.md

## D5: Apply normal end-phase specification and caught-up review gates
- **Question:** Does the triage transition end only test suppression, or every build-first shortcut?
- **Options:** Combined spec/typecheck-only shortcut; normal logic+tech, combined spec review, affected tests/build/web and final review.
- **Chose:** Normal gates. Corrected the initial combined-spec assumption before implementation; authored sibling tech.md and performed actual Codex standard promote/refute review. Use omp-task/OpenAI implementer and Gemini final review after actual Opus unavailable/Gemini reachable probes.
- **Why:** LOOP's build-first overrides last only until m7-test-triage is claimed. The semantic spec review proposed F1 opener outcome ambiguity (refuted: contract already distinguishes accepted spawn from eventual browser/login), F2 too-narrow suffix allocation (contested below-deep, caller clarified reserved minimum and220px acceptance), F3 post-review catch-up ambiguity (standing MEDIUM, gate suppressed due stale LOOP line evidence; caller independently accepts and fixes ordering to catch-up/recheck before final review). No semantic blocker remains after corrections; no fabricated green gate.
- **Evidence:** /tmp/quirky-session-sweep.2Whr6x/spec-review raw promote/refute/gate/manifest; tech.md Contracts and Testing strategy; canonical queue triage in-progress.
- **Reversibility:** easy
- **Confidence:** high for observed review and corrections; Codex same-family independence is reduced.
- **Revisit if:** Final gate or actual flow reveals a new boundary mismatch.
- **Source:** supersedes D3 combined-spec shortcut; locked by docs/loop/LOOP.md

The deterministic combined-scratch prepass returned25 path findings, not a clean result. Caller dispositions: F4–6 abbreviated account paths expanded/located under the explicitly named Accounts plugin; F8–15 abbreviated Vault/Dock/Info paths expanded to full plugin paths; F20 protected index path expanded. F7 is an RPC name, not a file. F16–19 are explicitly new helper/test targets or a command naming those future targets. F21 names the newly authored native handoff (created during review, absent from the prepass's tracked snapshot). F22–28 are valid sibling relative links in the actual committed spec directory, relocated by the combined scratch artifact. These are resolved references/planned artifacts/command grammar, not missing product behavior. The gate remains NEEDS_FIXES with25 deterministic findings and3 suppressions; caller adjudication supplies the recorded correction/false-positive disposition rather than changing reviewer JSON.

## D6: Repair the two current Accounts defects and verify, not rewrite, completed flows
- **Question:** Which apparent gaps remain in current source after historical follow-ups?
- **Options:** Reimplement old Vault/Dock fixes; trust done queue labels; inspect current source and execute every retained flow.
- **Chose:** Accounts gap-aware layout/contained measurement and native-compatible Open invocation are the initial repairs. Vault copy-first/log portal, dock stacking/cards/cache/lifecycle/fractional-height fixes and Session Info wrapping already exist and receive actual verification. No shared API change; reuse the public terminal opener and existing validated pending URL.
- **Why:** SessionParityMap corrected its historical-gap shortlist against current source and complete later logs. Accounts overflow D8 explicitly made no source fix and native link remains target=_blank; the other named gaps were repaired before their verification campaigns stopped.
- **Evidence:** Accounts Usage.tsx403–434/styles.ts39–44/AccountsSettings.tsx28–49; m3-accounts-overflow-verification D7–D8; native m3-accounts AC6–7; Vault HistoryPanel324/570–572/styles27; dock fix D6–D19; Session Info followup D7–D8.
- **Reversibility:** medium
- **Confidence:** high for source/failure records; no current runtime pass claimed.
- **Revisit if:** Actual smoke/UI/suites expose another kept flow defect.
- **Source:** assumed — autonomous, source-grounded parity inventory

## D7: Correct the new fitter at its actual boundary and prove real layout
- **Question:** Does the returned Accounts component satisfy its gap contract?
- **Options:** Trust the worker; run exact regression and inspect actual rendered layout.
- **Chose:** Parent caught the extra suffix gap: prefixWidth already included each preceding gap. Removed the duplicate term, restored the accidentally omitted original chip styling and removed an incidental exact-toast wording assertion.
- **Why:** Initial new tests returned3pass/3fail; corrected tests returned6pass/0fail/15assertions. Actual built-web measurements across220–3200px and Compact/Used, Detailed/Remaining and icon-only show zero Accounts row/chip overflow, hittable contained +N and recovery to all10 providers. No whole-page overflow claim: old shell header still extends beyond narrow viewports and has its own active redesign owner.
- **Evidence:** component0ec50212 / integration9132ace0; wave-final-audit.json; layout-detailed-used.json and layout-variants.json; actual screenshot after narrow/wide measurement.
- **Reversibility:** easy
- **Confidence:** high for exact test/rendered boundaries; native outcomes remain separate.
- **Revisit if:** UI restyle changes chip geometry without remeasurement.
- **Source:** assumed — autonomous, actual regression and real-surface proof

## D8: Align Accounts command exports with existing stable catalog IDs
- **Question:** Why did actual generated `accounts login-status` fail while direct API tests worked?
- **Options:** Add compatibility aliases/change contribution IDs; migrate command implementation keys and direct callers to stable existing IDs.
- **Chose:** Kebab-case exports for the13 mismatches, unchanged manifest IDs/words/methods and no aliases. Migrate direct session-home consumer; keep an actual generated-CLI pending login/read/cancel regression proving selected account and saved auth bytes remain unchanged.
- **Why:** Actual smoke returned “CLI module ... has no command login-status”; the dispatcher looks up the manifest ID, not the RPC method name. Directly invoking camelCase handlers bypassed that boundary.
- **Evidence:** actual failed runtime smoke; plugins/quirky.accounts/cli.ts, test/sweep-cli.test.ts and accounts-api.test.ts; scoped audit exactly3files; new CLI lifecycle test passed in the20-test local command (16pass/4fail overall).
- **Reversibility:** easy
- **Confidence:** high for generated dispatcher root and new lifecycle proof; other current failures are not called green.
- **Revisit if:** A manifest command ID no longer matches its implementation key.
- **Source:** assumed — autonomous, observed end-phase defect

## D9: Retain actual failures and coordinate canonical shared owners
- **Question:** How should the first broad acceptance failures and concurrent triage be handled?
- **Options:** Call failures unrelated without proof; duplicate shared fixes; preserve raw failures, trace roots and coordinate canonical ownership.
- **Chose:** First affected gate remains failed258files/227pass/31fail, no flaky; scripts did not run because the chain stopped. Own current Accounts CLI/provider diagnostics and Vault/Handoff sweep repairs. User/Lane12 owns the canonical confirmation fix using the existing public Ask list snapshot by exact ID; no new read API or kernel cutover exists on this branch. Await its landed checkpoint for final catch-up. Lane11 owns the separately requeued full Accounts acceptance; coordinate UI/source overlaps rather than rewrite.
- **Why:** A stale item-branch queue hid freshly claimed fix-test owners. Canonical status and actual peer terminals identify current ownership. Kernel Confirmations.consume called connection-only Ask wait as kernel; the user explicitly preserves connection/caller/digest/atomic one-use boundaries. Our speculative repair worker was halted and returned zero edits/checks.
- **Evidence:** first-affected/check-0.log and suite-result false; canonical status; accepted peer message receipts; user interjection specifying lane12 design; AskConfirmationRepair zero-edit checkpoint.
- **Reversibility:** medium
- **Confidence:** high for observed failures/ownership; no final all-green claim yet.
- **Revisit if:** Canonical integration supplies a conflicting or incomplete fix.
- **Source:** locked by user Lane12 canonical fix-test-ask-1028 ruling

## D10: Distinguish public opener evidence from native browser success
- **Question:** Is a guard NO_EFFECT on Open proof the repaired button failed?
- **Options:** Claim native success; label a logged-only fixture dead; retain independent invocation evidence and guard limitation.
- **Chose:** Private scene routes the real public opener to an owned log instead of launching a browser. The visible button increased the log from its single setup entry to two exact displayed-URL entries while the login remained pending. Keep NO_EFFECT in the guarded report, no trailing-action pass; native system-browser/OAuth completion remains pending.
- **Why:** The intended side effect is outside the page and deliberately intercepted by the native test seam. It is not visible browser navigation or authentication.
- **Evidence:** SessionSweepSurface scene6225, actual guardedA3obs19 and open-external.jsonl2entries; native m7-sweep-sessions A3 pending.
- **Reversibility:** easy
- **Confidence:** high for public invocation only.
- **Revisit if:** Native runner observes the actual system handler refusing the same URL.
- **Source:** assumed — autonomous, required evidence boundaries

## D11: Resolve direct provider probes to their actual executable
- **Question:** Why did valid nonempty Codex model data never become authoritative?
- **Options:** Relax parsing/authority; change valid fixture data; diagnose the actual failed probe branch and correct executable resolution.
- **Chose:** Direct model probing uses `Detection.locate(command)?.path`, preserving the account environment and all output/lifetime/nonempty snapshot guards.
- **Why:** Actual isolated diagnostic returned “the provider executable could not be resolved.” `resolveExecutable()` intentionally returns null for commands already on the login PATH because shell launches need no override; a direct-spawn probe still needs their absolute location. The existing discovery test exercises this consumer-visible path. The separate login setup timeout was not reproduced by traced owned children (385ms/241ms); its cause remains undetermined, with no deadline or retry change.
- **Evidence:** agents/src/detect.ts106–134; agents/src/service.ts649–657; provider-debug/diagnostic-output.json including executable0700 before/after, exact synthetic homes/config/auth and discovery reason.
- **Reversibility:** easy
- **Confidence:** high for discovery root; no causal claim for the historical login timeout.
- **Revisit if:** A fresh current-source remote acceptance run contradicts direct-spawn resolution.
- **Source:** assumed — autonomous, actual runtime diagnostic

## D12: Move every further automated test to the remote suite runner
- **Question:** How should verification change after the operator reports Mac load260 with12 lanes debugging?
- **Options:** Keep local single-file tests; use canonical remote runner for every test.
- **Chose:** All subsequent tests, including single files and scripts, use `bun scripts/suite.ts <file-or-dir>`. Only files explicitly in scripts/test-on-macos.txt and packaged native-app checks run locally. Keep one necessary guarded web scene and close all owned browsers/Quirky processes when their work ends.
- **Why:** The operator supplied authoritative resource evidence and supersedes the earlier local-test allowance. Existing completed local results remain historical, not rerun locally.
- **Evidence:** operator interjection; scripts/test-on-macos.txt; global worker notification acknowledged by provider diagnostic worker.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** Operator changes test-host policy.
- **Source:** locked by operator remote-test instruction

## D13: Preserve partial visual evidence and close local resources
- **Question:** What is actually established by the guarded campaign under the later remote-only execution policy?
- **Options:** Infer18passes; restart unsupported local checks; retain the exact report and finish reachable remote proof.
- **Chose:** Report20261028T215248-54b3 has A1pass, A2/A3partial and15unattempted goals (formally partial). No overrides, kept-open windows or cleanup errors; frontmost restored, clipboard restoration unclaimed. Stop the owned scene and keep all local browsers/Quirky processes closed. Remote prerequisite inventory found no Chrome/Chromium/playwright-cli; the supported guard requires Darwin desktop baseline even for web and rejects web CDP-port selection. No fake-desktop override or unapproved guard portability change.
- **Why:** A screenshot or mounted/API test cannot be called a passing unrun visual scenario. LOOP permits tool/policy-limited partial evidence with its report. F1 was the Settings button behind an already-open modal (parent inspected obs5), not evidence for raising overlay layers. The public Open click was independently logged, not native success.
- **Evidence:** actual guarded report.json/run.test_overrides=[]/state_left; parent read obs5/19; ui-policy-limit.json explicitly not a guarded run; skill _begin_bind native baseline and _desktop unsupported_platform; remote executable inventory; scene.ts --stop exit0 and service exit0.
- **Reversibility:** easy
- **Confidence:** high for observed subset and teardown; no new-shell or remaining15-goal visual pass claim.
- **Revisit if:** A supported remote guarded web driver or authorized execution policy becomes available.
- **Source:** locked by operator remote-test instruction; LOOP tool-limitation reporting

## D14: Correct invalid acceptance preconditions, not product behavior
- **Question:** What caused the remaining Vault/Agents fixture failures after the initial repair wave?
- **Options:** Loosen product limits/cursors or deadlines; establish the real public request and reachable boundary.
- **Chose:** Vault tests wait for the injected error after debounce, isolate each in-process host's actual Vault module, batch Gemini formats, enable search before settling, and replay the UI's exact first-page request identity. Use49distinct short terms below512characters to reach the planner's48-token limit; do not send a query rejected by view/service input constraints. Agents discovery fixture declares its required prompt mode. Remove only Handoff's incidental inventory pin.
- **Why:** The parent caught two repair-introduced test mistakes (removed search enable and a mismatched Claude-only cursor). Phase diagnostics then proved the remaining wait was query-truncation, not paging: >512 input was rejected, so no response flag could exist. Actual stale-page assertions passed before that point. No product cursor/limit/error policy or timeout was relaxed. Temporary diagnostics were removed.
- **Evidence:** repair-remote and vault-cursor-trace logs; source view-state query boundary/search engine planner; vault-query-limit-corrected run passed its isolated configured retry after candidate-index settle timed out initially, explicitly reported flaky. Earlier full affected failure remains retained.
- **Reversibility:** easy
- **Confidence:** high for traced invalid preconditions; candidate-index timing remains an observed flaky path, not a claimed product root.
- **Revisit if:** Full current-source remote suites expose a consumer regression.
- **Source:** assumed — autonomous, actual acceptance boundary evidence

## D15: Preserve both source intents in the single roadmap catch-up
- **Question:** How should the actual incoming899b0573 conflicts and newly binding decisions be reconciled?
- **Options:** Keep the old shell/owner assumptions; overwrite measurement; combine current owner contracts with the sweep's distinct changes.
- **Chose:** Merge checkpoint7cfa4ee8 with build/roadmap once as bb774ec6. Read all22 full incoming logs/206decisions/305050bytes, including Progress/evidence. Keep incoming native Open single-flight/inline error/keyed login state; keep incoming separate empty-Usage/status ownership while retaining chipsRef/gap fitting/contained measurement; remove obsolete CTA-only CSS. Remove the duplicated early provider resolver because the canonical direct-process branch already uses locate after its saved command override and HTTP providers need no CLI.
- **Why:** The actual conflicts were competing implementations of compatible intents, not permission to discard either feature. Canonical Ask now reads list{askId} through SQL filtering before deserialization, preserving wait connection identity and confirmation digest/atomic one-use. New six-slot shell replaces legacy rails but preserves contribution IDs and exact-window routing/input/history. Incoming fixture/native evidence retains its own partial and red results.
- **Evidence:** immutable incoming899b05738ac51c06cf7330416f7b006049c439e1; actual-catchup.json; complete incoming-decisions manifest/materialized logs and scout inventory; five resolved conflict blocks in four files; bb774ec6.
- **Reversibility:** medium
- **Confidence:** high for source intent and complete decision inventory; final current-source gates remain independent.
- **Revisit if:** Canonical landing reports a new conflict or current acceptance exposes a regression.
- **Source:** locked by incoming decision logs and user canonical Ask ruling

## D16: Keep genuine unbuilt host integrations explicit
- **Question:** Did earlier local M3 completion leave actual kept host flows unbuilt, rather than merely unverified?
- **Options:** Infer full parity from extension tests; borrow worker/phone authority; retain local core and register one exact implementation successor after the canonical owner prerequisite.
- **Chose:** Prepare one successor for focused-owner Accounts scope/sign-in gates, a shipped production paired Vault host contributor and remote actions, and host-qualified Handoff target/detection/reachability/secret-warning/delivery/lineage. It depends on this item and m7-vm-and-owner-bound-host-workspaces. Reconfirm the production-contributor absence after catch-up; register only once just before landing. No verification-only successor.
- **Why:** Accounts state/UI lacks host scope; Vault consumes vault-host contributions but the only concrete contributors are test fixtures; Handoff's target and probe model are local. Registered full-owner workspace placement is separately in progress. A test forwarder, local filesystem path, or worker/phone grant cannot establish the missing feature authority. Local flows are independently usable. SSH/WSL and native chat remain locked exclusions, not new paired feature work.
- **Evidence:** SessionsDeferredFlowAudit source inventory; external accounts Remote server scope, Vault host/enable-all and Handoff Target/host/probe sections; post-catchup repository literal search finds vault-host only in the consumer and tests; canonical queue m7-vm-and-owner-bound-host-workspaces in-progress.
- **Reversibility:** medium
- **Confidence:** high for missing composition boundary; successor must derive exact current public owner contracts rather than invent method names.
- **Revisit if:** The authority owner or a separately queued feature already ships the exact flows before registration.
- **Source:** deferred: paired-owner session feature composition — explicit LOOP/user flow-successor policy

## D17: Prove real five-owner integration remotely and remove the probe
- **Question:** How can actual runtime proof continue without running tests or leaving Quirky/browser processes on the overloaded Mac?
- **Options:** Keep local smoke; claim mocked calls prove behavior; temporarily adapt the existing real probe to the remote suite runner.
- **Chose:** Four untracked temporary files adapt the existing isolated native-format provider fixtures and actual daemon/PTY/CLI probe to a remotely built UI bundle. Run through suite.ts, then archive and remove all four before compiler/review/landing.
- **Why:** The final real remote probe passed1/1file with no retries: ten quota adapters, captured revision/one confirmed external redemption, generated login/status/cancel, Vault consent/index/search/source preservation, Session Info telemetry/MCP/consent and neutral Codex, Dock state, real Handoff paste bytes/locked notice/lineage and live source PTY. Failed probe versions are retained: missing Linux Cursor XDG fixture path, Orca-style rather than namespaced Vault command, an unsuitable stale-prompt Codex readiness fixture, and a too-strict running status pin (working/waiting are live). The positive target reuses Handoff's canonical readiness-capable Gemini fixture; source liveness is verified through the actual host, not an incidental lifecycle label.
- **Evidence:** postmerge-runtime-liveness/result.json and remote1/1/no-flakes receipt; remote-smoke-source.tar.gz integrity check; all four temporary files removed by owned-path deletion; earlier failed outputs retained in scratch.
- **Reversibility:** easy
- **Confidence:** high for exercised real daemon/PTY/native-format/synthetic-provider boundaries; not native OS or unrun visual acceptance.
- **Revisit if:** Current full affected acceptance or final review identifies a missed boundary.
- **Source:** assumed — autonomous, operator-compliant actual runtime evidence

## D18: Repair consumer prerequisites without weakening producer contracts
- **Question:** How should the post-catch-up acceptance failures be resolved?
- **Options:** Treat the narrower suite as enough; weaken runtime contracts; repair real dependency closures and obsolete fixture assumptions, preserving meaningful boundaries.
- **Chose:** Accounts and Vault fixtures include the real CLI owner required by Worktree; fake executable discovery uses its owned search directory. Handoff fixtures use the current built-in owner set. Remove source/catalog/default/wording mirrors rather than re-pin them. Preserve stale cursor replacement, exact account/model snapshots, cold restore/admission/history, clipboard refusal and exact destination/no-extra-spawn checks. A PTY reconciliation test cannot infer a manually registered structured runner's death; keep its real terminal lost/kept proof and remove the unrelated unsupported inference.
- **Why:** The broad postmerge gate failed263files/214pass/49fail. The subsequent six-plugin gate was124files/122pass/2fail: independent Usage app-server traffic invalidated a global request-inventory pin, and the separate Vault resume bootstrap still lacked its real owner closure. Accounts' remaining behavioral assertions passed after removing only that inventory/logging; scripts passed12/12 remotely. Provider metadata tests also exposed that homepage/install bypassed the existing HTTP(S) validator; both now use that validator, with rejection assertions rather than English error pins.
- **Evidence:** postmerge-affected/check-0.log; post-shell-owned/check-0.log102–104; accounts-discovery-current/result.json; agents/src/core/entry.ts link validation; actual Worktree manifest dependencies; current terminal shell and provider/session contracts.
- **Reversibility:** easy
- **Confidence:** high for traced prerequisite failures and completed focused checks; the next full affected gate remains required.
- **Revisit if:** Full affected acceptance shows a product failure rather than an invalid fixture prerequisite.
- **Source:** assumed — autonomous, actual remote failure evidence

## D19: Route Darwin-only acceptance to the actual supported host
- **Question:** Should Linux artifact/simulator refusal be bypassed to make remote acceptance green?
- **Options:** Weaken production guards; skip the tests; register the exact supported macOS-only files.
- **Chose:** Add terminal artifacts.test.ts, artifacts-api.test.ts and emulator.test.ts to scripts/test-on-macos.txt with their actual platform reasons. Keep their substantive grant, inode, revision and device-identity checks unchanged; suite.ts runs them on this Mac as the operator explicitly permits.
- **Why:** Terminal artifacts require Darwin and positive O_NOFOLLOW/O_NONBLOCK constants before grant handling; Simulator preview refuses non-Darwin before invoking xcrun. The retained Linux failures reached those intentional platform gates, not the behavior under test.
- **Evidence:** terminal/src/artifacts.ts93–95,275–276; terminal/src/emulator.ts20–21,47; postmerge-affected/check-0.log2042–2079,3406–3501; scripts/test-on-macos.txt.
- **Reversibility:** easy
- **Confidence:** high for current platform guards; no unrun macOS pass claimed.
- **Revisit if:** A separately authorized portable safe host implementation changes those guards.
- **Source:** deferred: platform — Linux/Windows artifact and Simulator implementation

## Progress
Single catch-up bb774ec6 complete, all22 incoming decision logs read. Real remote five-owner integration smoke passed1/1 with no retries; four temporary adapter files archived and removed. Local UI/browser/runtime resources remain closed. Current compiler and packaged build pass. Broader affected gate remains red; six-plugin gate122/124 and focused Accounts1/1 plus scripts12/12 results are retained separately. TerminalConsumerRepair, SessionConsumerRepair and VaultResumeBootstrap finish the remaining real consumer fixtures before the full affected gate and one cross-family final review/fix batch. Register the single genuine unbuilt host-flow successor immediately before canonical landing. No full visual/native or whole-repository passing claim is made.
