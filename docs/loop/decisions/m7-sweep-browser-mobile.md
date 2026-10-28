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

## D8: Surface and repair cross-worktree contamination before accepting the wave
- **Question:** Can worker-reported completion override a relative-path write into the integration tree?
- **Options:** Ignore the location mistake; discard the work; pause, relocate exact owned hunks and restore the clean integration baseline.
- **Chose:** Pause PhoneLinks after its relative edits hit root SettingsScreen, TerminalView and SessionPage. Give it narrow temporary recovery authority over only those self-authored hunks: transplant into its component and restore root to a9ceffd6, then recapture before resuming. BrowserAcceptance separately reported two early root test edits (extras-automation and design-runtime), restored to exact prior contents, and now uses absolute paths. MobileContracts confirmed no root edits. All future writes require absolute component paths; parent performs authoritative HEAD/path audit after every writer stops.
- **Why:** Tool cwd did not follow the worker's intended worktree. Correct content in the wrong tree still violates isolation and must not be silently integrated. The three root phone files were clean before the worker wrote; no user changes are removed.
- **Evidence:** PhoneLinks and BrowserAcceptance incident messages; parent exact root diff; root baseline a9ceffd6; recovery receipt and final wave scope audit remain required. Parent Eval transfer calls aborted before execution, so no transfer success is claimed from them.
- **Reversibility:** easy
- **Confidence:** high for reported/diff-observed incident; restoration is not accepted until the receipt/audit
- **Revisit if:** Any additional root or cross-component path appears at the barrier; stop and replan that scope.
- **Source:** assumed — autonomous

## D9: Reclaim page-owned resources without closing the persistent phone RPC
- **Question:** Does page/route teardown release terminal input and Watch leases when the native client keeps its connection?
- **Options:** Close the shared connection; reorder React unmount only; reclaim exact page-owned results in the native bridge host, including late completions.
- **Chose:** Preserve close():void and immediate delivery shutdown; track/release exact stream and Watch identities through the captured original RPC. Handle late create/attach and connection replacement. A newer host adopting the same connection-owned Watch lease must not be stopped by older cleanup. No generic authority, shared-RPC close, guessed IDs or automatic mutation replay. MobileContracts owns only shell/resource tests, disjoint from PhoneLinks.
- **Why:** Reordering unmount cannot recover an in-flight acquisition whose reply is dropped. Closing the shared native RPC would disrupt unrelated consumers. Source inspection plus actual public runtime state confirms the leak.
- **Evidence:** web-entry/main.ts68-74; page-bridge.ts91-110,237-246; bridge-host.ts114-118,178-184,291-299; HostPageShell158-164; runtime754-759; broker connection.onClose. Actual /tmp/quirky-l7-bridge-lifecycle.ts output: realDaemon,realEncryptedPhone,realChrome true; fixturePty true; leakedWatch,leakedTerminal,phoneStillConnected true; cleanup homeRemoved true; exit0 in2.79s.
- **Reversibility:** medium
- **Confidence:** high for reproduced leak; repair remains to verify
- **Revisit if:** Native RPC ownership or the producer's lease identity semantics change.
- **Source:** assumed — autonomous

## D10: Record the short-viewport Tasks outcome without claiming a real phone keyboard
- **Question:** Does the current Tasks layout reproduce the documented clipped/shifted composer defect in the web surface?
- **Options:** Change CSS on inference; exercise the shipped page at short phone dimensions; infer native success.
- **Chose:** Run real daemon/encrypted bridge/shipped Tasks page against the stateful GitHub fixture at390x350. Issue22, Create Workspace, edited field, Cancel, return to list, Open filter and Cancel all produced the intended visible outcome with bounded fields/footer and restored header. No Tasks CSS change justified. Keep real keyboard native handoff pending.
- **Why:** All visible outcomes were observed; headless short viewport is not iOS/Android keyboard behavior. Initial issue-card refs returned STALE twice; the observed visible-card coordinate succeeded rather than relabeling those attempts as passes.
- **Evidence:** likeuser web run20261028T212606-3c08 report.md, tasks-short pass with obs5/6/8/9/10; missing favicon404 console finding retained. Fixture uses fake upstream GitHub and fixture PTY, not real hosting credentials. lane7.sweep.tasks exited0; TASKS_SMOKE_CLEANUP fixtureRootRemoved/fixtureHomeRemoved true,failures[].
- **Reversibility:** easy
- **Confidence:** high for exercised web layout only
- **Revisit if:** Real native keyboard run reproduces layout movement.
- **Source:** deferred: platform

## D11: Yield overlapping app fixtures to lane8 and consume its committed patch
- **Question:** How should the newly claimed fix-test-apps-mobile-1028 overlap be resolved?
- **Options:** Land competing fixture repairs; make lane8 wait for this whole sweep; retain one owner per file and consume its isolated test commit.
- **Chose:** Per lane8's explicit coordination, it owns bundle/shell/pages/terminal-artifacts and panels/files-tasks test fixtures plus the single app session-tabs macOS runner marker. MobileContracts restores its own duplicate five-file diffs without discarding its production plugin and new lifecycle tests. Parent removes only its duplicate app marker; retains five Browser/mobile-plugin Chrome markers. Consume lane8's published test patch before acceptance; no dependence on its full item. PhoneLinks additions inside session-tabs test source remain lane7-owned because lane8 owns only that file's runner marker.
- **Why:** Newly assigned work must not duplicate repairs or auto-combine independently authored versions. The confirmed page-resource leak and PhoneLinks production remain distinct work.
- **Evidence:** User coordination interjection after triage; /tmp/quirky-lane7-mobile-repair-coordination.md reply; MobileContracts/BrowserAcceptance steering and parent marker removal.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** The published patch names different paths or a shared production defect requires coordination.
- **Source:** locked by user lane8 coordination

## D12: Consume committed owner patches and route all further tests through the suite
- **Question:** How do simultaneous end-phase repairs and the overloaded Mac change verification?
- **Options:** Duplicate fixtures; copy foreign uncommitted files; consume published commits with explicit path ownership.
- **Chose:** Lane8's 3bd03d81/714795ea/6a9f9030/b54e70e5/e1a4f78b/0c266a03 are consumed as de6285af/4b03f2d0/d4ff7451/c6343b2d/5e08700f/bd5ef5f7. Keep both additive runner lists and imported author decision log. Existing app Watch uses preserved real Bun transport/HTTP/abort/timers, real JPEG load and faithful WheelEvent coordinates; inner deadline unchanged. Parent priority publications61f3f9de (five markers) and d34de2be (harness dependency) were made before overlapping owner messages; retain user-authoritative harness order at integration. Lane5 owns UI-copy/Settings/import fixtures; restore our duplicates and consume its committed repairs. Every later test, including one file, uses suite.ts, with only listed macOS cases local.
- **Why:** User coordination and operator routing override competing edits and direct local test commands. No production auth, sandbox or dependency bypass is justified by a simulated DOM fixture.
- **Evidence:** User receipts and /tmp/quirky-lane7-mobile-repair-coordination.md; lane5 checkpoint ebec3ad5/af5fa2fc/04b0d49d/1f60a947; root scoped marker proof18pass0fail before operator note; user fixture acceptance is not our final combined acceptance.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** A published patch changes another owner's production contract.
- **Source:** locked by user lane8/lane5 coordination and operator test-routing note

## D13: Repair the pinned helper dialect, not Browser authority or production deadlines
- **Question:** What caused actual select-all/pointer failures and the network/emulation assertions?
- **Options:** Repin expected failures; widen generic helper access; align the existing typed adapter with the pinned dispatcher and correct observable fixture semantics.
- **Chose:** macOS selectAll uses the existing CDP editing-command table. Mouse names/fields match agent-browser0.27.0; drag uses source/target selectors. Native helper calls are audited against pinned dispatch/handler source. Tests wait for actual wheel delivery, distinguish GET200 from OPTIONS204, and serve responsive metadata from the actual fixture source across profile reload. Parent published5e57ad16 only for the proven scoped checkpoint; the later drag patch remains under acceptance. No production viewport, timeout, transport classifier or permission workaround.
- **Why:** Successive runs reached deeper actual operations rather than proving the entire case green. Missing viewport metadata legitimately produces a980px layout; an action ACK does not guarantee the compositor has delivered a wheel event.
- **Evidence:** Mac baseline artifact59; repaired mixed-DOM design fixture and8pass2fail artifact131; later suite4pass1fail54asserts at drag; checkpoint /tmp/quirky-lane5-automation-checkpoint.json. After source/target repair SC5 progressed to a33s CDP-transport-loss label while SC6/SC7 passed; causal stage tracing is required before another fix.
- **Reversibility:** medium
- **Confidence:** high for observed helper/fixture mismatches; remaining transport-loss cause unproven
- **Revisit if:** The pinned helper version changes or traced failure contradicts the adapter contract.
- **Source:** assumed — autonomous

## D14: Verify page-resource reclamation through actual encrypted producer state
- **Question:** What does the S6 repair prove beyond mock forwarding?
- **Options:** Keep only RPC-call assertions; close the shared connection; retain race/security tests plus real daemon/Chrome ownership evidence.
- **Chose:** Keep the actual encrypted page lifecycle regression, route it to installed macOS Chrome, and remove a redundant mock-only close/forwarding test. Portable race/error tests cover pending close/rebind, same-lease adoption, foreign IDs, failed acknowledgements and reply delivery. Parent repaired the missing pendingStreamAttachments declaration reported by the first real portable run; it retains existing32-stream admission.
- **Why:** A closed page cannot rely on its own cleanup call reaching a now-closed bridge. Resource identity must be retained by the native host before late-response rejection without disconnecting unrelated consumers.
- **Evidence:** first portable run7pass6fail due undeclared counter; after counter fix suite bridge-resources1filePASS remotely18.44s; real page-bridge-lifecycle suite1macOSfilePASS11.53s, using actual daemon+encrypted phone+Chrome, fixture PTY, and shared RPC still connected. No default-keychain or native phone claim.
- **Reversibility:** medium
- **Confidence:** high for exercised release/state paths; full combined suite and final security review remain
- **Revisit if:** A final race regression or real page navigation retains or steals a lease.
- **Source:** assumed — autonomous

## D15: Repair live-receipt matchers and use a real PTY for approved hook execution
- **Question:** Why did the mobile Markdown revision, consent hash and marker assertions fail after reaching their producers?
- **Options:** weaken CAS/trust; repin missing fields; inspect actual public replies and the fixture execution path.
- **Chose:** keep production semantics. Actual consent reply contained the valid hash before its asymmetric toMatchObject; Markdown then sent revision object{} after expect.any(Number) had touched the reused receipt. Use scalar assertions on dynamic revision/hash values. The fake PTY only records writes, so switch the one script-execution case to existing real daemon/PTY fixture with public Mobile installation, ephemeral port0 and independent content pins. Add optional test-only extraEnv while forcing its owned fixture path. Restore the accidentally omitted Accounts cleanup variable, remove all temporary traces, retain both actual marker-file byte assertions.
- **Why:** an accepted dispatch is not execution, and mutating a receipt inside an assertion must not manufacture a backend validation defect.
- **Evidence:** trace artifact199 shows valid setup trustHash and Markdown expectedRevision object{}; subsequent Markdown file PASS. Real-fixture first run reached marker outcomes but failed undeclared accountsHost cleanup; parent restored it, then canonical remote consent file PASS19.85s. Existing real-fixture consumers workspace-flows file passed. Published7bf12184 and typed-options4dfe8539; pointer focus/select-all fixture passed1Macfile20.85s.
- **Reversibility:** easy
- **Confidence:** high for exercised fixture/producer boundaries
- **Revisit if:** an actual phone sends invalid revisions or valid consent fails outside test assertions.
- **Source:** assumed — autonomous

## D16: Complete the single catchup from a pinned canonical decision archive
- **Question:** Can conflicted worktree text certify incoming binding decisions?
- **Options:** trust partial worktree logs; stop on scout's absent Git capability; export exact canonical objects and reconcile them.
- **Chose:** one git merge build/roadmap, pinned incoming13ebf5bfaa2aa7fa5ffcc4a23d44967fdec97675, committedc9b46075. Parent Git archive supplied all25 canonical incoming logs to the read-only scout after its first worktree-only report disclosed the limitation. Every log was read at that pin; none changes our tab/lease/grant/CAS/Native/phone product boundaries. Resolve conflicts by owner: canonical mobile decision log includingD8-D18; remove redundant safe-manifest identity; retain our appended consumer regressions and captured Review confirmation; keep unique runner entries and authoritative harness order.
- **Why:** a tool limitation is not unreachable evidence; source pinning prevents current roadmap movement or conflict markers from becoming product authority.
- **Evidence:** /tmp/quirky-l7-incoming-decisions.tar generated by Git at the exact pin; SweepIncomingBindings canonical25-log coverage; actual merge conflict resolutions andc9b46075.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** land reports a genuine newer conflict; do not infer a second routine catchup is needed.
- **Source:** locked by docs/loop/LOOP.md

## D17: Count actual tabs through one sanitized canonical layout snapshot
- **Question:** Is Open workspace·1tab correct when the real session displays Shell plus Native Browser?
- **Options:** relabel session count; query Editor/Browser once per workspace; add a narrow Terminal layout-owner batch projection.
- **Chose:** public readOnly quirky.terminal/tabCounts({}) and terminal tab counts CLI, shared TerminalTabCounts DTO with counts and unavailableWorktrees. Read loaded cold/hot layout models in the existing queue; count current root tabs, not split panes/background sessions/closed history. Expose only IDs/counts/unreadable IDs. The phone consumes one batch under existing rpc+terminal grants on Workspaces; no new grant, raw layout, engine startup, per-workspace fetch or guessed fallback. Complete absence means zero unless unreadable; invalid/unavailable snapshots omit the number without breaking open/navigation.
- **Why:** mobile.md counts tabs and includes Browser/Markdown. Session records are not that authority. Direct owner projection preserves lazy engines, data minimization and six-month maintainability.
- **Evidence:** actual390px UI run20261028T232008-b8c6 screenshot4 row1tab versus screenshots1/5/10 two tabs; SweepTabCountMap; WorkspacesPage sessionRows.length; LayoutService owned map/load/queue; mobile.md121-135.
- **Reversibility:** medium
- **Confidence:** high for observed defect and canonical owner; implementation/acceptance still required
- **Revisit if:** layout model gains another tab container or count scope changes.
- **Source:** assumed — autonomous

## D18: Keep feedback intrinsic-height and preserve partial UI evidence
- **Question:** Did successful link transport also establish usable page layout?
- **Options:** call the whole screen passed; remove a notice only for this input; fix all session feedback wrappers' common flex behavior.
- **Chose:** parent retains gutters but adds a no-growth qp-session-feedback override to the four message wrappers, with no routing/resource/palette changes. Current run passed real terminal state persistence and explicit Watch target/close while Native stayed Native; it records F2 empty-band layout and leaves Markdown/options goals partial for a fresh repaired-page run. No retroactive pass. All owned runtime/browser resources were stopped.
- **Why:** qp-content is the main flex-growing scrolling body, not a message wrapper. A link-only special case would leave save/errors broken.
- **Evidence:** screenshot9 large empty band; styles.ts qp-content flex1; SessionPage four wrappers; run20261028T232008-b8c6 g1/g2 pass,g3/g4 partial,F1 fixture favicon404,F2 layout. end exited4 only because restoring preexisting frontmost SecurityAgent failed; no native prompt was touched, browser already closed (explicit close said not open), service exited0/homeRemoved true.
- **Reversibility:** easy
- **Confidence:** high for observed cause; repaired UI proof still required
- **Revisit if:** short-viewport error content prevents access after intrinsic layout repair.
- **Source:** assumed — autonomous

## D19: Prevent reviewer filesystem or shell access after an evidenced review breach
- **Question:** Which review execution risk is acceptable after incoming mobileD14 reports unauthorized restore and real-home log reading?
- **Options:** unrestricted reviewer Bash/read access; suppress failed stages; stage a frozen source/criteria package and use no-tools model stages.
- **Chose:** final cross-family review keeps actual promote/refute/gate protocol and parent-owned deterministic checks, but model stages get no tools and only frozen code/test/public-doc artifact plus verbatim behavior criteria, not decision-log rationale or private paths. Record the bounded source scope and inability to independently execute reproductions. Schema/empty-stage failures are retried/fallback, never hand-repaired or called clean. Parent maintains source identity and applies only adjudicated fixes.
- **Why:** readonly prompt text did not contain the reported breach. Tool removal prevents model writes and private-home reads without inventing a new product or review service.
- **Evidence:** canonical fix-test-apps-mobile-1028 D14-D15 and its explicit integrity limitations; verified Gemini/Flash availability; pi-dev supports no-tools judgment on supplied artifact. No final review pass is claimed yet.
- **Reversibility:** easy
- **Confidence:** high for chosen access restriction; future review evidence determines its assurance
- **Revisit if:** a supported path-scoped tool sandbox is available or staged context cannot evaluate a required seam.
- **Source:** assumed — autonomous

## Progress
All initial components and committed owner fixtures are integrated; one canonical catchup/read25bindinglogs complete. Root build after frozen dependency install passed20.65s. Actual caught-up phone UI proved live shell persistence and explicit Watch target/close without Native conversion, but uncovered real tab-count and feedback-height defects. S7/S8 contracts are approved; shared DTO/schema/CLI contracts commit before reusing PhoneLinks for the count slice. Parent feedback style change is applied but not visually closed yet. All owned smoke/browser processes are closed. Next: implement count projection/consumer with API/CLI tests, fresh UI Markdown/options/count/feedback and Phone link branch, docs, final gates, bounded no-tools cross-family review/fix batch, then land. No final completion claim.
