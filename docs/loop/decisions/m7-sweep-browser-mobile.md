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

## D20: Transfer existing Mobile fixture repair ownership to lane12
- **Question:** Who owns the newly claimed fix-test-mobile-1028 item and overlapping optional Browser/fixture failures?
- **Options:** duplicate runtime/test edits; share uncommitted files; publish existing commits and keep disjoint ownership.
- **Chose:** lane12 owns the repair item, existing mobile-plugin test files and further optional-provider/params-scope regressions. They consumed7bf12184 as11477ce7 and published5cc0ba3d; parent consumed5cc as6cb9c6ac. The optional missing Browser MethodNotFound source hunk already matched72ef6dae, so intake adds only real CLI prerequisites, early fixture cleanup and removal of an incidental generated-name assertion. Lane7 retains PhoneLinks/S6 and the NEW count contract/admission/consumer slice, not their service.ts scope repair.
- **Why:** one producer fix should not acquire competing variants; legitimate method params.scope is distinct from the still-forbidden caller envelope scope. Their exact-policy repair remains theirs until published.
- **Evidence:** committed5cc0ba3d diff and actual cherry-pick6cb9c6ac; /tmp/quirky-lane12-mobile-checkpoint.json; lane12 reports real encrypted Markdown smoke45savedbytes/staleCASdenied/dirtyClosepreserved and all homes removed. Those are lane12 receipts, not a final lane7 gate.
- **Reversibility:** easy
- **Confidence:** high for ownership and committed intake; pending scope repair not yet verified here
- **Revisit if:** a published prerequisite changes count admission or a final consumer gate finds a distinct production defect.
- **Source:** assumed — autonomous

## D21: Review the amended count/feedback specs with isolated actual stages
- **Question:** Does the original S1–S6 spec review cover the later S7/S8 changes?
- **Options:** reuse its clean result; skip amended review; run a new frozen-artifact campaign.
- **Chose:** new deep spec-design campaign at4d253fa1, actual fresh no-tools Codex promote/refute, deterministic reference/heading prepass and claims/merge/gate/manifest. Parent read the raw empty arrays and gate/manifest. Gate PASS, zero findings/advisories/limitations/questions/suppressions/contests. Reviewer openai-codex/gpt-6.1-sol, reduced independence versus OpenAI author; this is not the final cross-family code review or runtime proof.
- **Why:** later acceptance contracts cannot inherit assurance from an earlier artifact; tool removal preserves the new reviewer-access boundary.
- **Evidence:** /tmp/m7-sweep-spec-s7-s8.Jbbyb8/{promote.raw.txt,refute.raw.txt,gate.json,manifest.json}; combined artifact hashf651027502bb0044276d5892d5b4c053fa025ee6dccdf52dee6d564518662d33; internal reference-resolution/section-coverage checks exit0.
- **Reversibility:** easy
- **Confidence:** high for actual protocol/result; reduced-family static review limitation retained
- **Revisit if:** criteria/contracts change or production evidence contradicts them.
- **Source:** locked by docs/loop/LOOP.md

## D22: Prove count authority at the API, CLI and rendered consumer boundaries
- **Question:** What closes the observed session-record/tab-count mismatch without another provider fan-out?
- **Options:** repin the old number; assert handler wiring; drive the owner model/API and actual phone card.
- **Chose:** same PhoneLinks identity implemented dc97d9f4 against committed contracts; parent integrated it and removed its worktree. Queue-only owner projection counts group tabs, not panes/history/background records; unreadable wins. Private inline consumer parser rejects duplicate/conflicting/unsafe counts, and existing load generations guard late responses. No new cache, provider startup or raw payload.
- **Why:** ownership is structural; the phone must not infer another product's tabs from Session rows.
- **Evidence:** three new focused test files; first remote failures were wrong fixture import/onNavigate recorder, corrected without source workaround. Two final count files pass0retries29.30s; Mobile negative-boundary file passed; component typecheck37.65s; added first-query no-default-terminal regression passes35.03s. Real390px UI screenshot2 shows2tabs/1session and14 shows3tabs/1session after a real Markdown tab. Actual CLI parser returned tabCount3/unavailable[] on the same live daemon.
- **Reversibility:** medium
- **Confidence:** high for exercised counts and consumer transitions
- **Revisit if:** another layout-owned container becomes countable or a provider starts during a pure count query.
- **Source:** assumed — autonomous

## D23: Close source UI defects with fresh evidence and retain fixture/native limits
- **Question:** Can the earlier partial/failing phone report be called green after a source fix?
- **Options:** relabel old evidence; skip remaining visible flows; run fresh repaired pages and preserve both reports.
- **Chose:** fresh real daemon/PTY/encrypted phone and built pages1019127bytes. Run20261029T003428-8f25 passes counts, Markdown create/edit/list-preview/dirty-close Keep/save/back/reopen, explicit URL→actual Chrome Watch beside unchanged Native→Close to live Shell, and options/Sleep Cancel/view parking/wake. A real variable printed BEFORE_SLEEP_kept_7 and AFTER_SLEEP_kept_7. Feedback is intrinsic56px with usable tab strip/controls/frame, not the prior empty flex band.
- **Why:** transport success alone does not establish usable layout or persistence. Native Settings is not in this web page, so its Phone-mode counterpart used separate fixture run20261029T005206-9a5a, which passes exact external callback/no-new-Watch. The desktop report retains its historical partial for that unexecuted counterpart; no retroactive pass or native-browser claim.
- **Evidence:** both actual likeuser reports/end oktrue; screenshots2/7–17/20–21/25–36 and Phone-mode screenshot2 plus readonly callback event1709. Favicon404 fixture findings retained. Actual CLI count3. Owned service lane7.sweep.counts-ui exit0/homeRemovedtrue, both browsers/popups closed; shutdown Worktree deactivation warning retained.
- **Reversibility:** easy
- **Confidence:** high for real source-web/API/PTY boundaries; native window/OS browser/default keychain remain pending
- **Revisit if:** real phone WebView/keyboard/OS handoff contradicts source-web proof.
- **Source:** locked by docs/loop/LOOP.md

## D24: Consume the landed domain-scope repair without taking over another item
- **Question:** Does a missing peer branch mean its reported prerequisite is unreachable?
- **Options:** duplicate its source edit; stop at missing branch; inspect canonical committed provenance.
- **Chose:** canonical service history identified2516679e after build/fix-test-mobile-1028 disappeared. Read its complete D1–D9 decisions and consumed it asb35f96c7. Keep the exact published owner log after the expected absent-base modify/delete conflict; source/docs otherwise auto-merged. Params.scope is domain data, envelope scope/token identity stays forbidden/registry-derived, strict method policy remains. Keep existing Hosting/Tasks repair ownership and their complete appended failure inventory.
- **Why:** a deleted landed branch is not missing evidence. One literal parameter-identity correction fixes legitimate Stage/Vault consumers without new per-feature exceptions or authority widening.
- **Evidence:** git show2516679e and actual b35f96c7; lane12's real encrypted Stage/anti-spoof smoke3.95s and prior expanded31file gate25pass6fail remain their receipts, not a whole-suite pass here.
- **Reversibility:** easy
- **Confidence:** high for narrow committed intake; final whole-importer gate runs here
- **Revisit if:** a transport derives credential authority from method params or a shared fixture traces a failure to this patch.
- **Source:** locked by fix-test-mobile-1028 D9

## D25: Preserve no-tools review across the operating-system argument boundary
- **Question:** How can a273025byte frozen code artifact reach the selected reviewer without granting filesystem tools?
- **Options:** drop context; grant read/Bash; duplicate SDK behavior; feed the shipped CLI parser from an in-memory argument.
- **Chose:** temporary Node launcher reads the staged prompt, enforces --no-tools/rejects --tools, sets process.argv in memory and imports the actual pi-watch.mjs entry. No CLI/source SDK fork, default resource scan, product service or model filesystem access. Real help invocation with the273k artifact exits0; model stages still require their actual dispatch/output/claims/refute/gate.
- **Why:** plain argv exceeds macOS limits; the shipped module executes unconditionally and already supplies the empty resource loader, in-memory sessions, tool list, streaming/flush and exit behavior.
- **Evidence:** SweepPromptTransport plus actual parser/module source134–173/384–490; /tmp/quirky-l7-pi-prompt-file.mjs; help2.06s. Frozen source b35f96c7 against13eb, code/test/publicREADME only, resolve hash2f091d8d613fa9aae4c07f5401fb867e5f852d856f211b0c9dfd471bdf11875c. Actual select-model resolves verifiedgoogle/gemini-3.1-pro-preview:high/full independence. No final review result is implied by that preflight.
- **Reversibility:** easy
- **Confidence:** high for transport/no-tools structure; judgment evidence remains pending
- **Revisit if:** shipped CLI gains a supported prompt-file transport or its entrypoint stops executing on import.
- **Source:** assumed — autonomous

## D26: Preserve the failed whole-suite scope and recover evidence before rerunning anything
- **Question:** What did the long final prepass actually establish?
- **Options:** invent totals from an older lane snapshot; rerun the whole suite for lost logs; inspect persisted evidence and runner retention.
- **Chose:** retain the actual3132.12s combined exit1. Build/typecheck reached the full packages/apps/plugins/scripts suite; its retained tail proves our new design-runtime annotation case timed out120s with4other cases passed and later window-undefined cleanup errors. The mechanical prepass stores only4000output bytes. Read-only scout verified remote snapshots/JUnit files are removed and no full output/manifest is persisted; remote totals/other failures are therefore unknown here, not green.
- **Why:** source reachability checks cannot recover bytes the runner deleted. A failed current file needs a cause/fix, not another unchanged baseline run. Future commands use an owned full-output capture before mechanical truncation. This is a slow-suite observation; Python-only pytest-xdist is not applicable to this Bun suite, and no runner configuration is changed.
- **Evidence:** /tmp/quirky-l7-final-review-sT15E3/prepass.json duration3131830ms/exit1; SweepSuiteReceipts source mapping of suite.ts143–202/231–322. Lane8's separately reported877remote682pass195fail snapshot was read for our six files and matched already-repaired families; it is not a substitute for this run's missing totals or a new repair assignment.
- **Reversibility:** easy
- **Confidence:** high for retained failure and retention limitation; unretained totals unknown
- **Revisit if:** a durable run manifest/full log is supplied by an actual runner.
- **Source:** assumed — autonomous

## D27: Consume the published typed Watch contract without duplicating its owner
- **Question:** Does the first lane12 checkpoint contain its later accepted Watch findings?
- **Options:** keep a known old input restriction; create a competing fix; read and consume the later published delta.
- **Chose:** canonical history supplies399a7eb8, consumed70e77f2b. Shared validMobileBrowserParams now admits the already-public optional-code/char/64KiB/finite-wheel vocabulary, preserving exact lease/frame/connection authorization. Contribution loss matches the actual method:-prefixed identity; exact MethodNotFound handling remains once. Read full canonical MobileD1–D16; later generic Git lint inventory supersedes their narrow D11, while our lint source remains untouched.
- **Why:** these are advertised-contract repairs, not new APIs/grants or permission to take over Mobile. Actual source conflict was ordering/identity text, resolved to the published tighter branch and existing exact unknown-method branch.
- **Evidence:** published399diff; actual70e77f2b; current root typecheck32.23s passes. Their real red/green/57file consumer and fresh JPEG/4097byte/char/foreign-denial receipts remain owner evidence; the specific activation-race interleaving still has source-only qualification.
- **Reversibility:** easy
- **Confidence:** high for exact intake and current compilation; current focused consumers run here
- **Revisit if:** actual producer behavior contradicts the shared vocabulary or exact provider identity.
- **Source:** locked by fix-test-mobile-1028 D13–D16

## D28: Repair the annotation consumer fixture against semantic UI, not legacy classes
- **Question:** Why did the new real two-selection case hang after catch-up although its backend cases passed?
- **Options:** extend120s timeout; change production note storage; locate the awaited real consumer signal.
- **Chose:** same Browser implementer gets one explicit root test-file scope. AfterAll diagnostics prove both initial/retry hang at waiting for annotation count1 after real picker/Feedback/Add. Current UI renders Browser annotations articles, not the removed qbp-design-note class; Running agents uses menuitems. Use those accessible regions, required Annotate control, dynamic React client import after DOM setup, and an actual completion Promise for non-DOM designSend data. Retain two selections/comments/distinct IDs/redaction/no page clicks and retention after unconfirmed delivery; delete bare nonempty/incidental-default pins.
- **Why:** a MutationObserver cannot observe an ordinary JS assignment, and obsolete implementation classes are not a product defect. No deadline, production policy, permissions, frame producer or behavioral coverage is weakened.
- **Evidence:** annotation-diagnostic.full.log initial/retry4pass1fail2errors257.07s and exact afterAll stage; source Browser annotations/Running agents; corrected actual suite annotation-semantic file1/1MacPASS0retries11.73s. Temporary diagnostics are removed before final checks/review; all raw failure evidence retained.
- **Reversibility:** easy
- **Confidence:** high for observed fixture cause and corrected real Chrome flow
- **Revisit if:** current semantic consumer or actual duplicate selection/retention behavior fails.
- **Source:** assumed — autonomous

## D29: Consume completed Protocol/Terminal repairs and delete the superseded loop namespace pin
- **Question:** Are the current consumer failures new count defects or already-owned acceptance migrations?
- **Options:** repin inventories/defaults and unsupported-platform behavior; duplicate completed owners; consume their committed repair and keep the new count contract.
- **Chose:** captured current gate173remote148pass25fail/488.005s and exact26unique failure-file inventory across remote/Mac. Mobile-plugin/new count files pass. Protocol's two files match completed fix-test-packages-protocol-1028; Terminal files match completed fix-test-terminal-1028. Read their complete logs/patches and consumedc2f243a1→ec4f1c14,6a885635→2da7cf97,b8bee4c1→07aaacc1. Union only independent macOS runner markers. No Terminal/Protocol production change, alias, platform bypass or deadline increase.
- **Why:** later canonical repairs were absent from the earlier caught-up snapshot. One new legitimate readonly tabCounts call invalidates the app loop test's no-Terminal-namespace wiring pin, not its summary behavior. Same PhoneLinks implementer removes that and exact loop-call copies only; actual rendered both-layout labels, report privacy and negative route/params/controller denials remain.
- **Evidence:** owned-api-consumers.full.log plus extracted failure inventory; canonical queue owners status done; published repair commits and full D1–D5 Protocol/D1–D12 Terminal. Their98remote+5Mac/real API smoke and29file Protocol results remain owner receipts; the newly composed gate runs here before final review. Parent seeded the privacy fixture's actual dummy URL instead of asserting an absent string.
- **Reversibility:** easy
- **Confidence:** high for exact failure/owner alignment and narrow intake; composed verification pending
- **Revisit if:** a current valid consumer failure remains after these committed migrations.
- **Source:** locked by completed repair decisions and current tab-count contract

## D30: Compose current owner prerequisites before the end-phase final review
- **Question:** Should the remaining three concrete importer failures be patched against an incomplete published context?
- **Options:** compatibility selectors/per-feature dependency shims; keep importing disconnected fixture fragments; compose the current canonical owners and reverify.
- **Chose:** compose current build/roadmap on the item branch before Final Round1, pin/read every incoming decision, preserve all owner contracts, then freeze a new bounded source artifact. The prior no-second-catchup interpretation is superseded: LOOP's once rule is under the build-first override that ends when triage is claimed; normal end-phase step5 requires composition before final review. No new work item or product scope.
- **Why:** current359 gate passes185/188remote and15/15Mac, but Settings fixture still targets removed button.gear, structured transcript fixtures expect the newer semantic log, and loop fixture cannot find the absent Worktree setting. Published Settings consumer migration and completed Terminal gate used newer prerequisites. Layering aliases or more partial copies would create a combination no owner verified. No final model has dispatched, so this is not a second review campaign or moving an adjudicated artifact.
- **Evidence:** current final-owned.full.log403.986s; canonical f4befdd7 Settings test migration; TerminalD8 composed incoming Browser/Editor/Session context; normal LOOP end-phase/step5 versus build-first-only override. Old failed artifacts/prepasses remain immutable history.
- **Reversibility:** medium
- **Confidence:** high for observed context mismatch and normal end-phase workflow
- **Revisit if:** current composed source still fails; diagnose exact remaining cause rather than infer success from merge.
- **Source:** supersedes m7-sweep-browser-mobile D16 (one-catchup interpretation only); locked by docs/loop/LOOP.md normal end phase

## Progress
All implementation and explicit committed prerequisites integrated through07aaacc1; no second routine roadmap merge. Count/feedback/UI/CLI/PTY smokes passed and resources closed. Current consumer capture identifies completed Protocol/Terminal repairs now consumed; obsolete app loop RPC wiring pin removed. Real annotation semantics pass11.73s, temporary diagnostics removed with all meaningful two-selection/privacy/retention coverage. All writers stopped; current full build/types/owned Browser/Mobile/Terminal/Protocol/apps/scripts/helper checks follow on the composed tree. Old whole-suite failure/tail-loss and exact broad owner limits retained, not called green. Final models undispatched; next freeze current code artifact/chain, actual no-tools C/S/X Final Round1 plus one fix batch/checks, explicit remaining findings/limits, then commit/detach canonical land and own scratch cleanup.
