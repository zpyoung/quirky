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

## Progress
Both implementers returned; initial3repairs and newly observed mobile scope/dependency defects are implemented. Actual independent public Markdown and encrypted Stage all/anti-spoof smoke passed with owned cleanup. Temporary diagnostic client hook restored byte-for-byte to its original snapshot. Complete mobile/scripts/Reviews/workspace-flow/Git-merge consumer suite is running; expanded Hosting/Tasks results retained with existing area owners. Next: commit source, sole roadmap catch-up/read incoming decisions, typecheck, bounded cross-family final review/fix and canonical land. No full native/UI dogfood claim.
