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

## D20: Treat the full prepass as a failed gate, not a completed review
- **Question:** What does the first committed-snapshot final prepass establish?
- **Options:** Dispatch against a red check and call it complete; hide failures behind the focused result; finish the exact remaining consumer roots before final discovery.
- **Chose:** Retain prepass1 as failed:260remote files/249pass/11fail, all5macOS files pass, scripts/compiler/build stages not reached. No final promote/refute discovery has run. Repair current fixture mismatches and obtain fresh full evidence before the single final review round. Keep the campaign baseline/criteria/scope fixed, updating only its source snapshot.
- **Why:** Failures include remaining request/keybinding mirrors, stream-subscription timing, real scrollback versus live-screen history, current account DTO/notify arguments, index settle and load-sensitive activation/test deadlines. No runtime deadline, retry, provider identity or kernel authority is weakened. Handoff's fixture now loads its real declared dependency/context owners instead of unrelated built-ins; focused two-file acceptance passed with service.test.ts explicitly flaky under configured isolation retry, not a clean first attempt. Editor activation delay and the index wait still require evidence, not invented causes.
- **Evidence:** final-review/shared-1/prepass.json; final-review/verified-1/check-0.log; handoff-owner-closure/result.json; actual Handoff dependency manifests and required context owners; SessionGateRoots producer/scrollback trace; TerminalGateRoots stream-subscription trace.
- **Reversibility:** easy
- **Confidence:** high for observed gates and producer boundaries; no causal claim for unexplained load-sensitive delays.
- **Revisit if:** The fresh full affected gate remains red.
- **Source:** assumed — autonomous, actual prepass and isolated retry evidence

## D21: Remove only the requested Session Info wording assertion
- **Question:** How should lane9's canonical session-fix ownership and reported restyle failure be handled?
- **Options:** Re-pin a replacement title; edit Session Info production; remove the one incidental assertion and preserve semantic coverage.
- **Chose:** Commit666e590a deletes only the old ui.test.tsx175 assertion requiring the redundant inner “Session Info” title. Preserve accessible sections, interrupted/stale states, context thresholds and action assertions. No Session Info production change. Freeze further Session source/fixture work under lane9; this branch's Session production diff is comment-only, and its earlier fixture repairs remain separately reviewable.
- **Why:** The user reports that canonical restyle removed the redundant inner title. The title text is not a behavior contract; replacing it would recreate the same incidental pin. No external dependency or human decision is needed.
- **Evidence:** user Lane9 interjection; exact one-deletion commit666e590a; session-info-title-removal/result.json remote1/1pass/no-flakes; peer send request379e58d9-b91d-4b53-95cf-08835f86f50a input_accepted/provider unsupported (not proof of observed delivery or turn start).
- **Reversibility:** easy
- **Confidence:** high for the narrow deletion and exercised semantic file.
- **Revisit if:** A named merge conflict requires reconciling lane9's newer producer contract.
- **Source:** locked by user Lane9 scope and narrow assertion-removal request

## D22: Distinguish positive startup owner loss from ordinary PTY absence
- **Question:** Was the earlier structured restart assertion correctly classified as an unsupported PTY inference?
- **Options:** Keep that classification; conflate all reconnects with startup; accept the canonical Session owner's independent lifetime trace.
- **Chose:** Supersede D18's structured-restart classification. Runtime structured leases are memory-only; reverse dependent shutdown stops runners/releases leases, and Session startup precedes lazy Structured activation. Startup owner loss is positive evidence for finalizing persisted active structured sessions, while ordinary startup:false PTY reconnect remains terminal-only. Preserve lane9's restored startup-only finalize loop and stronger provider-ID/cwd retention regression, plus lazy-activation survival coverage, during integration.
- **Why:** The user's independent source trace establishes the missing ownership distinction. The earlier test removal must not be treated as a new lifecycle contract or a fix for the underlying startup regression. This branch remains frozen for further Session source/fixture work; no duplicate kernel or Structured repair is authorized.
- **Evidence:** user Lane9 ACK and source trace; canonical owner reports restoration of the loop removed by48083f14 and retention of the substantive regression; af513cb7 imported only our narrow Session Info title fix. No passing result for the owner's expanded startup tests is asserted here before its receipt.
- **Reversibility:** medium
- **Confidence:** high for the authoritative ownership distinction; canonical expanded verification remains separately reported.
- **Revisit if:** Canonical integration loses either startup finalization or ordinary reconnect/lazy-activation safety.
- **Source:** supersedes m7-sweep-sessions D18 structured-restart classification; locked by user Lane9 lifetime trace

## D23: Adopt the landed Session owner's overlapping files verbatim
- **Question:** How can this branch avoid reapplying its superseded Session variants now that the canonical repair has landed?
- **Options:** Retain competing variants; import a whole newer roadmap/restyle; perform an exact bounded canonical-file cutover.
- **Chose:** Replace only the eight overlapping Session source/fixture files fromf9ac686846d26d9299e6ce6a77b9ae27a3db2d19. Their recorded Git blob hashes match exactly. This preserves the startup-only finalize loop, substantive startup/provider/cwd regression, exact live structured lease on ordinary reconnect and final fake-account/plan result schemas. No unrelated UI restyle, kernel or structured/main.ts change is imported; no second general roadmap merge is performed.
- **Why:** The user explicitly requires canonical semantics and forbids reapplying the removed structured-test deletion/comment-only assumption. Whole-file identity eliminates residual competing fixture variants. The canonical owner's complete11-decision log was read; its reported38-file, typecheck and real private PTY evidence stays attributed to that owner. Our previous nine-directory prepass3 passed259remote+5Mac without flakes, scripts/types/build passed, but it is not relabeled as a fresh check of the later canonical cutover.
- **Evidence:** authoritative user landing receipt roadmap2c3d4c91/sourcef9ac6868; canonical-session-cutover.json eight exact blob pairs; complete canonical fix-test-session-1028 D1–D11/Progress; final-review/verified-3/result.json and check-0.log.
- **Reversibility:** medium
- **Confidence:** high for exact source identity and binding semantics; current integrated verification remains required.
- **Revisit if:** The scoped integrated gate shows a source/fixture dependency mismatch.
- **Source:** locked by user canonical Session landing and preservation instruction; supersedes this branch's competing Session implementation/fixture variants

## D24: Complete the canonical consumer closure and retain the older broad-red receipt
- **Question:** What remained after importing the exact Session owner slice, and what does lane8's broader inventory imply?
- **Options:** Weaken the new lifecycle tests; undo completed repairs from an older snapshot; fix the exact consumer prerequisites and preserve evidence scope.
- **Chose:** Adopt the two already-canonical Structured test bootstrap additions of the real CLI owner fromf9ac6868. Keep startup/lazy activation and background lifecycle assertions unchanged. The current terminal search fixture waits for its actual mounted search report before typing, using the same existing convention as its other scenarios. No production/kernel/Structured bridge change or timeout increase.
- **Why:** Full cutover prepass4 had270remote files/265pass/5fail and5Macpass; Handoff service/start passed their isolated retries, while the new Structured files lacked Worktree's real CLI dependency. The search test dereferenced its input immediately after an asynchronous shortcut. The exact corrected three-file remote gate then passed3/3/no-flakes. Lane8's older877-file consumer snapshot is separately red682pass/195fail, Mac10/13; its owned-area signatures match missing cwd/plan, null optional input, spawn-update timing and title pins already repaired here or by the canonical Session owner. It is not a new assignment or an877-file pass.
- **Evidence:** final-review/verified-4/check-0.log; exact f9ac6868 two-file diff; structured-consumer-closure/result.json; lane8 full-consumer-failures.json filtered to Accounts/Session/Session Info; user expressly preserves existing queue owners.
- **Reversibility:** easy
- **Confidence:** high for observed failures and corrected focused acceptance; current full integrated proof remains required.
- **Revisit if:** The full integrated gate exposes a new consumer-visible failure.
- **Source:** assumed — autonomous, actual gate and canonical bootstrap evidence; locked by user lane8 scope-preservation instruction

## D25: Exercise the canonical startup cutover through actual processes
- **Question:** What runtime proof covers the later canonical executable Session change rather than only the earlier five-feature smoke?
- **Options:** Infer it from types; duplicate the owner's claim; run a narrow private native-PTY/daemon/generated-CLI scenario remotely.
- **Chose:** A temporary transport starts the real daemon and native PTY with six real dependency owners, persists structured Session metadata, restarts only the daemon, and reads the result through generated CLI. It proves finalization with identical provider/cwd, terminal PID/incarnation survival across daemon restart, real sleep/wake and a first-launch-only scrollback marker retained exactly once. The case asserts client/daemon/PTY/process-scope/home cleanup and full environment restoration.
- **Why:** Remote smoke passed1/1/no-flakes in26.041s. A private marker file prevents wake from regenerating the history evidence. This is structured-record startup normalization, not a claim that a native structured provider runner or live lease was launched; those lifetime boundaries remain covered by the canonical Structured regressions. The runner suppresses successful stdout, so no raw session IDs or printed cleanup JSON are invented.
- **Evidence:** canonical-real-runtime/result.json; canonical-runtime-smoke-source.tar.gz containing the exercised transport; gzip integrity passed; temporary repository file removed before final review/compiler/landing.
- **Reversibility:** easy
- **Confidence:** high for exercised real daemon/CLI/native-PTY/state/history and cleanup assertions; no UI/native OS/provider-service inference.
- **Revisit if:** The final integrated gate or review identifies a conflicting lifetime boundary.
- **Source:** assumed — autonomous, actual operator-compliant runtime proof

## D26: Bind the single final review to the passing maintained snapshot
- **Question:** Which exact evidence may the final cross-family review and delivery use?
- **Options:** Reuse an older snapshot or claim no flakes; share one current live prepass and disclose each boundary.
- **Chose:** Freeze2ea45ce9 and its54-code-path artifact, net of the fixed incoming899b0573 baseline. Share the actual shared-5 resolve/prepass/model across C/S/X. Current full gate passed270remote files plus5Mac files; Handoff delivery required its configured isolated retry and remains explicitly flaky. Scripts12 passed; full typecheck29.424s and packaged build17.951s passed. Prepass has no deterministic findings; actual reviewer binding is google/gemini-3.1-pro-preview/high, triple verified, cross-family independence full.
- **Why:** The latest source includes the canonical Session ownership and DTOs, real Structured dependency closure, search mount precondition and no temporary transports. Original user metadata hashes and unchanged source identity were checked before review. Prepass926.925s exceeds the skill's slow-suite advisory threshold; the existing Bun/global-slot isolation remains unchanged. Pytest-xdist is not applicable here, and browser-context reuse would need separate isolation proof.
- **Evidence:** final-review/verified-5/result.json; check-0.log270/5 counts and Handoff delivery retry; shared-5/prepass.json artifact62e32ec5fbac9dfef876585c7e9722264dd25032df4c01aa63dd9747a64a147c; shared-5/model.json; source-before.json; final-review-scope-5.json.
- **Reversibility:** easy
- **Confidence:** high for exercised checks and live model selection; the final model review has no verdict until all three actual promote/refute/gate runs return.
- **Revisit if:** A reviewer changes source, a dispatch fails, or an accepted finding changes the checked snapshot.
- **Source:** assumed — autonomous, actual frozen-source verification and review protocol

## D27: Preserve the raw review verdict while rejecting prohibited test restoration
- **Question:** Should the sole specification finding restore deleted catalog/schema/default and forwarding snapshots?
- **Options:** Blindly restore them; reroll the reviewer until green; retain the actual gate and adjudicate against the binding test policy and surviving behavior.
- **Chose:** C/X deep promote/refute gates PASS with zero findings; S retains one standing HIGH/LOW-confidence S1 and NEEDS_FIXES. Reject its restoration remediation: wiring/copy/default/wording/mock-echo tests must be deleted, never re-pinned. The review criteria did not explicitly repeat that binding negative test policy; do not hide this staging limitation or rerun discovery with a friendlier bar. Accepted product-code fix batch is empty; document the actual behavioral contract evidence and formally retain S1 under this item's open review findings.
- **Why:** The claim says independent contract verification was removed “without replacing it,” but its own cited surviving tests execute real generated CLI against daemon state. Session cold restore retains provider/cwd/launch/argv/env/no-spawn/history and account-preparation checks; Handoff required-input validation and actual daemon loading remain. The exact canonical Session owner D6–D10 also intentionally removes fake forwarding/source inventories while strengthening real lifecycle and CLI behavior. Restoring the proposed tests would contradict explicit engineering rules without identifying a broken public API or failing consumer.
- **Evidence:** actual C/S/X promote/refute/gate/manifest JSON; S1 at agents/test/cli.test.ts556–564, session/test/cli.test.ts469–498, handoff/test/manifest.test.ts29–39, session/test/sessions.test.ts1353–1406; canonical fix-test-session-1028 D6–D10; full current275-file/12-script proof and real runtime receipts; source-after.json shows all54code hashes unchanged and original metadata preserved.
- **Reversibility:** easy
- **Confidence:** high for policy conflict and concrete counter-evidence; no exhaustive coverage guarantee or clean S gate asserted.
- **Revisit if:** A reproducible consumer-visible schema/CLI/identity regression is identified, rather than a missing static snapshot.
- **Source:** locked by mandatory permanent-test policy; assumed — autonomous review adjudication per LOOP

## D28: Register exactly one still-unbuilt feature-composition successor
- **Question:** Did the newly completed VM/workspace prerequisite already implement the three prepared application-level host flows?
- **Options:** Assume generic routing supplies them; add duplicates; recheck immutable canonical data and register only genuinely unbuilt composition.
- **Chose:** Canonical snapshotc3cdbea08a9a9df17334ab9e3e4995ff4f537878 still lacks focused-owner Accounts selection/sign-in, a production Vault host contributor and host-qualified Handoff target/probe/delivery/lineage. Register only m7-session-extras-owner-host-flows, depending on this item and the now-done VM/workspace owner. Absolute canonical queue add succeeded; readback atcadb41ab2102120730de45add9ebaabf359cda4d shows exactly one ID/status todo/deps intact.
- **Why:** The first scout result used the old item checkout and was discarded as noncanonical. Parent materialized13exact Git-object files and canonical queue facts; a fresh scoped read found the VM owner's D5/D12/D21 ship generic remote-workspace/VM surfaces, not these app integrations. Structured inspection of30production manifests finds zero vault-host contributors. Accounts remains provider/account-scoped; Handoff target/probe remains worktree/local-path scoped. The existing done Vault test-repair item is not a duplicate implementation owner.
- **Evidence:** successor-prereq/canonical-facts.json and immutable snapshot; corrected scout report; complete current VM owner decision/source evidence; host-flow-followup.json; host-flow-successor-receipt.json; canonical deps for this item ready:true/pending[].
- **Reversibility:** medium
- **Confidence:** high for exact missing feature boundaries and unique registration; successor must use the shipped full-owner authority, not synthetic hosts or borrowed grants.
- **Revisit if:** The successor's implementing lane finds a later canonical owner already supplies an exact flow.
- **Source:** deferred: paired-owner Accounts/Vault/Handoff composition — explicit user/LOOP implementation-successor policy

## D29: Finish with the actual post-review gate, not historical or peer totals
- **Question:** What is ready for canonical landing after the sole review/disposition batch?
- **Options:** Relabel old or peer results; run further discovery; retain exact current bounded proof and land.
- **Chose:** Post-review fed339b4 source passes270remote+5Mac files with flaky[], scripts12/12, full typecheck32.070s and packaged build16.955s; total722.84s. No product code changed during/after review, and both real runtime probes and their cleanup assertions remain applicable. C/X PASS and S NEEDS_FIXES/caller rejection remain distinct. Native three scenarios stay pending; guarded A1pass/A2A3partial/15unattempted report stays partial.
- **Why:** All reachable local behavior, current affected consumers and mandatory compiler/build gates are exercised. Paired-host composition has one actual queued implementation owner. No new Ask read API, wait/identity/digest weakening, account authority shim, source-file mutation, real provider invocation or global877-file passing claim is introduced.
- **Evidence:** post-review/result.json/check-0.log/check-1.log; source-after.json; actual runtime receipts and archived/removed transports; native m7-sweep-sessions.json; actual guarded report20261028T215248-54b3; canonical successor registration.
- **Reversibility:** easy
- **Confidence:** high for exercised API/CLI/process/check boundaries; explicitly bounded for visual/native/provider-service outcomes.
- **Revisit if:** Canonical land names a concrete conflict or merge-result failure.
- **Source:** locked by LOOP/operator verification and landing contract; assumed — autonomous bounded evidence

## Progress
Ready for canonical land. Post-review270remote+5Mac/no-flakes, scripts12, full typecheck and packaged build pass; real five-owner and canonical startup/sleep/history probes passed with private cleanup. Source reviewed once: C/X PASS0, S NEEDS_FIXES1/caller-rejected restoration recorded in BLOCKERS; no accepted code finding or second discovery. Exactly one genuine implementation successor is registered, with actual canonical owner prerequisite done; web/native limits remain honest. Commit only final evidence/spec updates, detach and invoke the absolute canonical queue.ts land for this item. On named conflict/failure perform only required recovery while preserving canonical owner semantics and incoming binding decisions; do not claim a receipt before the controller returns. Archive/clean owned scratch after success, preserve inherited metadata and end exactly this iteration.
