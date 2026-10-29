# fix-test-mobile-1028 decisions

## D1: Repair the three public mobile boundaries without compatibility aliases
- **Question:** Which failures belong to this end-phase item, and how should shared ownership be handled?
- **Options:** add mobile-only browser/trust bypasses; repair the public contracts and coordinate shared owners
- **Chose:** repair the public contracts and coordinate shared owners
- **Why:** Triage records missing Chromium, missing consent trustHash, and an unknown browser paneState method; none justifies restoring obsolete aliases or bypassing content-pinned consent.
- **Evidence:** docs/loop/reports/m7-test-triage.json groups plugins/quirky.mobile; queue item fix-test-mobile-1028
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** current runtime evidence identifies a different consumer-visible boundary
- **Source:** locked by docs/loop/LOOP.md

## D2: Use reported baseline failures as red evidence and verify changes with the canonical suite
- **Question:** Should the baseline failures be rerun merely to confirm them?
- **Options:** repeat triage; trust reported evidence and run changed-path verification
- **Chose:** trust reported evidence and run changed-path verification
- **Why:** The supplied triage is authoritative failure evidence. Verification will use bun scripts/suite.ts with fresh isolated homes; no real user state is permitted.
- **Evidence:** docs/loop/reports/m7-test-triage.json baseline 97aaa12d9fdf91a966cbc78d5557e113fc9789b3; docs/loop/LOOP.md end phase and step 6
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** a new regression needs a new failing scenario
- **Source:** assumed — autonomous

## D3: Consume the existing mobile owner's published repair rather than duplicate it
- **Question:** How do the narrower repair and the active browser/mobile sweep share code?
- **Options:** reimplement the same fixtures; merge the whole unfinished sweep; consume only published prerequisite changes
- **Chose:** consumed lane7 commit 7bf12184 as 11477ce7 and its exact optional-method classification from 72ef6dae through one narrow omp implementer. Preserve the existing macOS Watch marker; do not take over PhoneLinks, bridge resources or browser runtime.
- **Why:** Peer patches already identify live-receipt matcher mutation, hard-coded Watch coordinates and fake PTY execution. The older consent fixture conflict was resolved in favor of the real PTY; obsolete Git shim helpers were removed. The signature's optional environment preserves existing fixture callers.
- **Evidence:** build/m7-sweep-browser-mobile D6/D11–D14; commits 7bf12184/72ef6dae; terminal input receipts 425db308-3524-45f5-9113-31358013c415 and 42f288f9-44f2-4050-9555-b4d1fcaf199c establish accepted coordination, not proven delivery
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** peer supplies a conflicting public contract
- **Source:** assumed — autonomous

## D4: Preserve runtime receipts before using their hashes and revisions
- **Question:** Why did a valid producer hash fail the subsequent string check?
- **Options:** weaken producer validation; cast matcher objects; assert scalar fields without mutating the receipt
- **Chose:** scalar assertions retain the actual hash/revision for the next request. Real paired consent still requires setup and issue pins and verifies both marker files after real PTY execution.
- **Why:** A disposable Bun probe observed toMatchObject replacing the actual trustHash string with ExpectStringMatching and revision number with ExpectAny. The failure was in the test's retained receipt, not permission to relax content pins or CAS. Coordinate-based Watch input targets the actual field in the displayed frame, not a fixed pixel.
- **Evidence:** actual bun probe before hashType:string/revision:7 → after hashType:object/revisionType:object; canonical first acceptance actual paired-consent pass and macOS Watch file pass
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** a later Bun release changes matcher behavior
- **Source:** assumed — autonomous

## D5: Keep optional providers optional, without swallowing operational failures
- **Question:** Should absent Browser prevent listing actual Editor tabs?
- **Options:** require Browser in every Markdown fixture; swallow every browser error; recognize only the exact missing optional method
- **Chose:** recognize MethodNotFound only with the exact unknown-method message for the requested plugin and method. Preserve other failures, existing disabled/invalid handling, actual tab identity, dirty-close, CAS and byte limits.
- **Why:** Markdown integration intentionally omits Browser. The existing classifier covered disabled and declared-but-missing providers but not an uninstalled method. Installing a fake provider would hide this consumer defect.
- **Evidence:** plugins/quirky.mobile/src/daemon/session-tabs.ts unavailableMethod/sessionTabs; triage unknown quirky.browser/paneState; disposable actual RPC smoke passed create/list/write/stale refusal/dirty-close refusal/save/close with browserInstalled:false and cleanup rootRemoved/daemonHomeRemoved:true
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** daemon missing-method errors become a structured provider-availability contract
- **Source:** assumed — autonomous

## D6: Supply the real declared CLI dependency in isolated fixtures
- **Question:** Why did the current smoke/suite stop at unknown quirky.worktree/list before reaching mobile behavior?
- **Options:** weaken Worktree dependency admission; fake its methods; include the actual declared dependency in the fixtures
- **Chose:** add quirky.cli to the isolated Markdown fixture and the shared Hosting fixture; retain duplicate-symlink protection. Register the Markdown harness for cleanup before connection/repository preconditions.
- **Why:** Worktree's current manifest declares quirky.repo and quirky.cli. Neither fixture included CLI. Real dependency admission is correct; fixture omissions are not product authority defects. Hosting helper affects mobile task/Vault consumers and Tasks flows, so its full consumers need verification. fix-test-hosting-1028 is still unclaimed; no production Hosting change is taken from that owner.
- **Evidence:** first canonical mobile/tasks/scripts gate exit1 in37.05s: 27/32 remote files pass and1/1 Mac file pass; missing worktree/list in Markdown/Hosting consumers. Smoke after dependency and canonical-path fixture correction passed in3.07s. scripts and real consent passed; two additional encrypted-mobile failures assigned to a separate disjoint worker.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** the declared Worktree dependency changes
- **Source:** assumed — autonomous

## D7: Use a reachable cross-family reviewer and preserve platform limits
- **Question:** Which review/backend and platform evidence are available on this omp lane?
- **Options:** preferred Opus; verified Gemini fallback; imply native phone coverage from API tests
- **Chose:** omp/OpenAI implementers, Gemini google/gemini-3.1-pro-preview:high reviewer after Opus probe exit5 and Gemini probe exit0. macOS owned Chrome for Watch; remote portable tests via suite.ts. No native phone/keyboard/keychain success inferred.
- **Why:** Preferred Opus has no authenticated/shipping model. The real Chromium-dependent file is already in scripts/test-on-macos.txt; no fake or skipped browser acceptance. The changed product boundary is daemon/API, not a UI restyle.
- **Evidence:** actual pi-watch probes; scripts/test-on-macos.txt; existing mobile/native scenario owners
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** actual reviewer dispatch or native evidence differs
- **Source:** assumed — autonomous; deferred: platform

## D8: Keep independent Hosting and Tasks failures with their queued repair owners
- **Question:** Does a shared fixture dependency correction authorize changing Hosting push policy or Tasks UI contracts?
- **Options:** weaken assertions/security; duplicate other area repairs; retain complete failed verification evidence with the existing queue owners
- **Chose:** retain fix-test-hosting-1028 and fix-test-tasks-1028 ownership, including all actual consumer failures. No new duplicate item or false green broad-suite claim. Continue fixing mobile's own rejected Vault/Git/session requests with exact method diagnostics.
- **Why:** The expanded canonical gate exercises actual providers after admission is repaired. Its two Hosting push tests and nine Tasks Projects/list cases match the existing queued failures. Tasks also reports workspace-composer trust UI and restyle-detail cancellation failures; those join that area's recorded repair evidence, not a mobile-only workaround.
- **Evidence:** canonical expanded gate exit1/235.19s,31 remote files25pass6fail; pr.test.ts44pass2fail; projects-ui.test.tsx3pass4fail; remaining-list-issue.test.ts7pass5fail; workspace-composer.test.tsx3pass1fail; restyle-detail.test.tsx0pass1fail/1error. Markdown file, Tasks workspace flows and Git merge-preview pass. Mobile paired-hook execution passes; Vault request remains diagnosed, not deferred.
- **Reversibility:** easy
- **Confidence:** high for observed outcomes and queue ownership
- **Revisit if:** owning repair traces a failure to a production change from this item
- **Source:** assumed — autonomous

## D9: Distinguish feature-domain scope from authenticated credential scope
- **Question:** Why did valid phone Stage all and local Vault search fail as unauthorized?
- **Options:** change valid UI requests into narrower fixtures; add exceptions per feature; remove the identity/domain conflation while retaining existing method policy
- **Chose:** remove scope only from parameter caller-identity fields. Keep scope in envelope identity fields and keep credential scope derived solely from the authenticated registry/token. Existing method allowlists, feature-specific validation, public schemas and current-credential checks remain unchanged. Add a real encrypted top-level scope-spoof refusal assertion.
- **Why:** Temporary method/key-only diagnostics located the failures at Git stage with worktree/scope and Vault search with host/query/scope/freshness/limit/filters/within. The actual Source Control producer uses scope:all; both public feature schemas and the paired-method ceiling permit domain scopes. service.ts rewrote/rejected these before that policy ran. sb-mobile-app-panels D16 already records removing the same collision; owner-provisioning D2 requires separate authenticated grants, not treating every feature scope as an identity claim.
- **Evidence:** canonical diagnostic gate exit1/48.85s; apps/mobile/src/panels/source-control/index.tsx Stage all/tracked producer; PANEL_METHOD_PARAMS and assertPanelParameters; service.ts guardEnvelopeIdentity/authorizeConnection; sb-mobile-app-panels D16/D18; m7-terminal-owner-provisioning-and-selector-flows D2. Disposable actual encrypted smoke exit0/3.95s staged the saved note in the real Git index, retained mobile role and refused daemon.stop and envelope scope spoof; both private homes removed.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** an authenticated transport starts deriving authority from method parameters, which would violate the retained token/registry contract
- **Source:** locked by sb-mobile-app-panels D16 and m7-terminal-owner-provisioning-and-selector-flows D2

## D10: Preserve incoming presentation owners and the orchestration exit-order repair
- **Question:** What binding changes arrived in catch-up and lane8's direct coordination?
- **Options:** take over their behavior; ignore their boundaries; preserve each current owner
- **Chose:** sole roadmap merge reads ui-restyle-ask D1–D12 and ui-restyle-settings D1–D11 completely, including long omitted lines. Preserve shared preview subpath, input authority, pairing/revoke/secret masking and current UI lint enrollment. Reply to lane8 that its synchronous liveness UNKNOWN invalidation before async refresh has no conflict; no RuntimeSessionAuthority or Ask source/API edits here.
- **Why:** source scopes do not overlap; token-derived mobile credential scope is unrelated to session liveness. Current Mobile desktop UI tests arrive with Settings and are included in post-merge verification.
- **Evidence:** sole catch-up merge output; both full decision logs; /tmp/quirky-lane8-orchestration-reply.md; incoming direct user instruction naming build/fix-test-orchestration-1028
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** an owning repair reports an actual shared-file or authority conflict
- **Source:** locked by incoming ui-restyle decisions and lane8 coordination

## D11: Classify generated Mobile page output as build output, not authored plugin UI
- **Question:** Why did caught-up typecheck fail on ignored assets after the Mobile plugin's lint enrollment?
- **Options:** remove inherited build files; exempt all assets or disable Mobile lint; exclude exactly the canonical generated bundle directory
- **Chose:** source collection skips only assets/mobile under quirky.mobile, matching the builder's default destination and explicit gitignore rule. All authored Mobile source and other asset directories remain enforced. Extend the existing runner regression with generated CSS/JS/HTML and real source/SVG violations; delete incidental full-message assertions rather than repin them.
- **Why:** the13 diagnostics came solely from inherited generated page.css/page.js/index.html. Removing those unrelated files would conceal the normal build→typecheck failure. A blanket assets exclusion would weaken source enforcement. The private collector's optional excluded subdirectory changes no exported API or lint baseline.
- **Evidence:** actual typecheck exit1/1.87s; apps/mobile/scripts/build-pages.ts89+; .gitignore12; scripts/ui-lint.ts collector and CLI-boundary test. Corrected full UIlint/root/mobile/prepared-desktop typecheck passed39.64s; final focused lint regression plus full typecheck passed45.346s in the review prepass.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** the canonical bundle destination changes
- **Source:** assumed — autonomous

## D12: Record the completed bounded review and exact current verification
- **Question:** What evidence establishes completion without claiming universal UI/native or unrelated-area clearance?
- **Options:** report whole-suite success; run another discovery campaign; one fixed-artifact standard cross-family promote/refute review plus observed gates
- **Chose:** Gemini standard review over the11 owned source/test/document paths, combined correctness/contract/security mandate. Actual promote199.797s returned[]; fresh-context refute6.942s returned[]. Deterministic claims/merge/gate/manifest all exited0: PASS, full family independence,0 blocking/advisory/suppressed/contested findings,0 limitations/questions/excluded/unreviewed paths. No fix batch was needed. The593-line patch's deep suggestion was explicitly bounded to standard independent promote/refute; no claim of three separate lenses or exhaustive assurance.
- **Why:** fix items skip feature specs; one bounded final review is the loop's completion bar. Raw prompts/replies, immutable patch, chained prepass/model/gate/manifest are retained, with no author reasoning given to the reviewer and no shell/test tools granted. Current consumer gate passes34remote+1macOS files, flaky[]; final lint regression+typecheck passes. Current caught-up real API/encrypted smoke passed3.37s with45 saved bytes, real index mutation, spoof/owner-method refusal and both homes removed. Known shutdown Worktree deactivation warning remains visible; no pristine-log claim.
- **Evidence:** review run689cb79bb85a1514 artifact8f5edb917d5a8da89c9a25769ee4aec60091d084e2863588aa5c518020f2923d; canonical Mobile gate94.99s; prepass45.346s; smoke3.37s. Existing Hosting/Tasks repair inventory plus newly queued fix-test-reviews-tool-1028 retains separate consumer failures; canonical deps confirms ready:true. Earlier daemon timeout passed its configured retry and final unmodified run; deadlines unchanged.
- **Reversibility:** easy
- **Confidence:** high for exercised boundaries, bounded for review completeness/native behavior
- **Revisit if:** merge-result typecheck, existing repair owners or native evidence contradicts these results
- **Source:** assumed — autonomous; deferred: platform for native phone behavior only

## Progress
Ready for canonical land after final static plugin validation returns. All3implementers finished; source/dependency/scope repairs and generated-output lint classification are complete. Sole roadmap catch-up read/reconciled Ask and Settings logs; final Mobile/scripts/workspace-flow/Git gate passes34remote+1macOS files/no flakes, final lint-regression+full typecheck passes, current actual API/encrypted smoke passes with owned cleanup. Gemini standard promote/refute gatePASS has no findings; raw review evidence retained beside lane notes. No owned process/background check remains except the read-only static validator. Next: commit remaining tests/docs, detach, canonical queue land and await result; remove only owned scratch after success. Separate Hosting/Tasks/Reviews defects stay with named queue owners.
