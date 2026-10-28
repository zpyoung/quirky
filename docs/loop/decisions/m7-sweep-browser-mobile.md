# m7-sweep-browser-mobile decisions

## D1: Sweep only the claimed browser/mobile item after the end phase starts
- **Question:** Which item and workflow apply after many busy waits?
- **Options:** End on busy; resume prior landed mobile work; wait for a real claim and use current canonical policy.
- **Chose:** Canonical lane7 wait returned m7-sweep-browser-mobile after43 waits. Created build/m7-sweep-browser-mobile from build/roadmap. Canonical queue now shows m7-test-triage in-progress lane8, so execute normal end-phase tests/review/dogfood. No human questions.
- **Why:** Busy is not a stopping condition; triage claim is the policy switch.
- **Evidence:** bg_43 queue receipt; integration queue m7-test-triage read; git show build/roadmap:docs/loop/LOOP.md.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** Current canonical policy changes.
- **Source:** locked by docs/loop/LOOP.md

## D2: Preserve Native, product-scope and external-service prerequisites
- **Question:** Does parity authorize changing locked architecture or duplicate blocked work?
- **Options:** Substitute Chrome for Native; infer native chat/voice authorization; retain every prerequisite with its existing owner.
- **Chose:** Retain Native hard-reload/events/identity/storage-clear/preview/capture prerequisites and exact Native tab identity; background-only structured scope and dropped voice; no upstream hosted relay; no incompatible signed distribution/push service invention. Existing owners remain blocked or active; no duplicate successor for them.
- **Why:** Feature parity is bounded by locked roadmap/architecture decisions and earlier explicit ownership. Pending native verification is not missing code.
- **Evidence:** docs/architecture.md180-203,290-324; docs/roadmap.md13-56,175-181; BrowserMobileMap ledger; sb-mobile-chat-voice-native-ruling D2-D6; sa-browser-pane-native-host-controls D1-D7; sa-browser-pane-workspace-preview D1-D7.
- **Reversibility:** hard
- **Confidence:** high
- **Revisit if:** Authorized product ruling or supported Native producer lands.
- **Source:** locked by docs/architecture.md

## D3: Add explicit terminal-link Watch routing using existing authority
- **Question:** How should desktop terminal-link preference behave now that Watch exists?
- **Options:** Keep disabled; silently convert Native; create a new explicitly elected Chrome Watch tab through the current SessionPage owner.
- **Chose:** Third option. Phone remains the upgrade/default choice; Settings explicitly names Desktop (Chrome Watch). Reuse terminalLinkMode and browserWatchCreate URL/tab contract. Exact current worktree, safe http(s), visible failure/no fallback, duplicate pending guard and stale completion/owned lease cleanup. No new generic browser grant.
- **Why:** The old unavailable label is stale after sb-mobile-app-prerequisites. Missing glue is reachable, not a Native frame prerequisite.
- **Evidence:** apps/mobile/src/native/SettingsScreen.tsx137-143; src/pages/TerminalView.tsx119-127; SessionPage.tsx481-495; packages/protocol/src/mobile-browser.ts; mobile.md flow9 Browser settings; sb-mobile-app-prerequisites D7.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** Watch ownership or feature-doc semantics change.
- **Source:** assumed — autonomous

## D4: Resolve all relevant gray areas with existing consumer conventions
- **Question:** Which Visual,API,Data,Integration and CLI defaults govern this sweep?
- **Options:** New UI/API abstractions; broad authority/retries; current conventions and fail-closed ownership.
- **Chose:** Existing compact phone settings/tabs; visible loading/empty/errors; exact per-route grants, structured plugin errors and existing CLI group; one enum persistence; no auto retry for uncertain mutations; no credential exposure; actual producer pins for script consent; unknown origin stays unknown; no inferred successful native completion.
- **Why:** Consumers already use these boundaries; second conventions would create retargeting and stale-state risk. Purpose/consumer/observable success/scope/constraints are explicit in logic.md.
- **Evidence:** BrowserMobileMap report; sb-mobile-app-prerequisites D4,D7,D8,D16; external browser.md and mobile.md edge cases; current contracts.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** Actual producer evidence contradicts the contract.
- **Source:** assumed — autonomous

## D5: Use three disjoint implementation slices and a verified cross-family fallback reviewer
- **Question:** Which implementation/review pairing and granularity are reachable?
- **Options:** omp+opus; omp+Gemini; same-family review.
- **Chose:** OpenAI omp task implementers; Gemini reviewer because pi-watch --check finds no authenticated Opus/Sonnet while Gemini google/gemini-3.1-pro-preview:high resolves. Shared existing API contracts and both specs commit before dispatch. Max3 independent components: PhoneLinks,MobileContracts,BrowserAcceptance. Parent owns runner placement/docs/integration/smoke. Preserve inherited untracked files untouched.
- **Why:** Real cross-family independence survives unavailable preferred reviewer. Splitting one small link setting from Session ownership would add overhead; combining it keeps one vertical slice.
- **Evidence:** pi-watch --check exited5 with7/12 ready; tech.md Components; initial git status.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** Reviewer dispatch actually fails; use skill ladder and record limits rather than claim a pass.
- **Source:** assumed — autonomous

## D6: Treat baseline failures as evidence, never repin incidental wording
- **Question:** What did baseline verification establish?
- **Options:** Ignore failures; relax safety until fixtures pass; repair actual contracts and test setup with behavior assertions.
- **Chose:** Root bun run build exited0. suite.ts browser/mobile/apps ran63 remote files:48passed,15failed;3macOS-only files passed. Observed failures include absent Chrome remotely, missing mobile helper/imports, stale route manifest fixture assumptions, missing browser producer in tab fixture, stale consent pin and origin fixture expectations, and browser copy assertions. Investigate exact causes, delete incidental-copy assertions, preserve real consumer behavior. Move Chrome-dependent tests to macOS runner list rather than fake or skip them.
- **Why:** A suite failing before exercising behavior is not product proof; bypassing route/consent/provenance validation would create a bug. User observations and test output stand; no rerun just to reconfirm failures.
- **Evidence:** artifact53 complete baseline output; build output exit0 in54.92s; scripts/suite.ts/test-on-macos.txt policy.
- **Reversibility:** easy
- **Confidence:** high for observed failures; root causes remain to be established per slice
- **Revisit if:** Narrow investigation finds a different production cause.
- **Source:** assumed — autonomous

## D7: Scope platform proof to actual surfaces exercised
- **Question:** Can a web shim or isolated Chrome prove Native/phone OS behavior?
- **Options:** Infer native passes; use foreground/native drivers; preserve exact native handoffs and run isolated web/daemon evidence.
- **Chose:** macOS web/daemon/CDP only here; actual native phone keyboard/WebView/storage/background/OS push and supported Native browser lifecycle remain pending in their existing files. All processes use fresh HOME/QUIRKY_HOME. Chrome harness may use --use-mock-keychain with that limit recorded; no default-keychain approval inferred.
- **Why:** Locked platform scope and existing native safety boundaries forbid real-home writes and unsupported engine evidence.
- **Evidence:** LOOP Native rules; sb-mobile-app-prerequisites D12; existing docs/loop/native browser/mobile scenario files; likeuser doctor web ready.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** An authorized native run supplies real device/OS evidence.
- **Source:** deferred: platform

## Progress
Oriented, read source docs and locked rules, mapped every feature category with one read-only scout. Baseline production build passed; baseline suite failures captured. Logic/technical contracts self-reviewed; next commit specs/contracts, dispatch3disjoint implementers in /tmp worktrees, integrate, run final tests/runtime/UI, catch up once, review and land. No completion pass yet.
