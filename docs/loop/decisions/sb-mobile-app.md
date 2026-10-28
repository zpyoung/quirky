# sb-mobile-app decisions

## D1: Build the combined phone foundation and workspace/session scope
- **Question:** how to interpret the combined queue item and its exclusions.
- **Options:** foundation only; both enumerated parts; all mobile routes.
- **Chose:** both parts: Expo phone shell, QR/link/paste pairing, strict v2 direct encrypted JSON-RPC, host/keychain stores, onboarding/home/settings/diagnostics/page bundle, workspace list/options/search and session tabs/terminal/chat/dock/actions/driver-fit. Exclude source control/files/tasks/accounts/history routes; their unrelated home links must not imply shipping those screens.
- **Why:** the queue title explicitly unions the two parts and limits each Not note to exclusions not covered by another part.
- **Evidence:** queue.ts wait --lane 5 returned sb-mobile-app; mobile.md flows3–7,9 and client/page-bundle sections.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** the queue scope changes.
- **Source:** locked by docs/loop/queue.json

## D2: Preserve the direct-only Quirky protocol and dependency authority
- **Question:** fork strategy and wire compatibility.
- **Options:** port Orca's RPC catalog; adapt its Expo app boundaries to Quirky public APIs; use hosted relay.
- **Chose:** adapt the Expo phone app onto Quirky JSON-RPC 2.0, quirky://pair, pinned v2-only encryption and Quirky terminal frames. LAN/tailnet only. Reuse existing daemon contracts and upstream reusable phone modules with attribution, not legacy RPC aliases or hosted services. Secure-store tokens never enter metadata, page init or diagnostics. Existing v2 latch remains durable; no legacy fallback is introduced.
- **Why:** architecture mobile decision and daemon D1/D2/D6/D12 bind this item. Dependency is already done (deps ready:true).
- **Evidence:** docs/architecture.md:298–301; docs/loop/decisions/sb-mobile-daemon.md; absolute queue.ts deps sb-mobile-app.
- **Reversibility:** hard
- **Confidence:** high
- **Revisit if:** an authorized protocol version migration is introduced.
- **Source:** locked by docs/architecture.md

## D3: Apply unattended night-mode workflow and isolated worker attribution
- **Question:** which skill prompts and execution gates apply.
- **Options:** human questions and research swarms; autonomous source-grounded defaults.
- **Chose:** resolve all applicable Visual/API/Data/Integration gray areas autonomously; no human prompt or research swarm. One combined logic spec including final technical contracts, self-review against all in-scope flows, shared signatures committed before at most three implementers. External temporary component worktrees; absolute-path-only worker tools; retain inherited parent .serena metadata untouched. Parent owns affected-suite/scripts/typecheck/build/smoke and one final cross-family review; land owns full suite. Catch up once just before land.
- **Why:** authoritative LOOP.md overrides ordinary skill process. Earlier mobile worker incidents show relative tool paths are not a safe cwd boundary.
- **Evidence:** git show build/roadmap:docs/loop/LOOP.md; sb-mobile-daemon D11; LSP status reports no configured language servers.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** authoritative loop changes.
- **Source:** locked by docs/loop/LOOP.md

## D4: Use OpenAI omp implementers and Gemini review
- **Question:** backend pairing preflight.
- **Options:** omp+opus; omp+gemini; same-family review.
- **Chose:** IMPLEMENTER=omp-task, AUTHOR_FAMILY=openai, REVIEWER_ALIAS=gemini, high reasoning; maximum three concurrent implementers.
- **Why:** actual pi-watch --check reports7/12 ready; opus/sonnet unavailable and Gemini3.1Pro available. No backend asks are permitted.
- **Evidence:** iteration9 preflight tool output; Serena session37452ece.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** the reviewer cannot execute.
- **Source:** assumed — autonomous

## D5: Defer locked native-chat and dictation flows without inventing a replacement API
- **Question:** the queue names structured chat and phone settings, but the architecture drops interactive native chat and the roadmap drops dictation.
- **Options:** override the locked decisions; block the complete phone item; ship the independent core and defer only conflicting flows.
- **Chose:** real terminal sessions plus real ask question/approval cards, no interactive structured launches/transcripts/attachments/queued-chat/options UI or voice dictation/model management. Settings expose actual supported behavior and explicit unavailable capabilities. Record the conflicting flows in the single follow-up just before land; its prerequisite is an authorized architecture ruling and API contract. Do not claim a native-chat pass or treat ask cards as a chat implementation.
- **Why:** LOOP.md permits independent core shipment when a flow conflicts with an outside limit or locked ruling. The phone can pair, list workspaces, drive terminals and answer the side-track exit-test question without forbidden chat.
- **Evidence:** docs/architecture.md:145–178; docs/roadmap.md:175–181; mobile.md Session screen/Phone settings; prerequisite scout confirmed no interactive transcript/send contract.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** locked native-chat/dictation exclusions are explicitly changed.
- **Source:** deferred: interactive native-chat and voice

## D6: Resolve Visual, API, Data and Integration gray areas from source
- **Question:** layout/density/loading/empty/errors/interaction, auth/versioning/pagination, storage/idempotency, retry/mapping/conflicts.
- **Options:** wholesale upstream app; new browser-only phone UI; selective Expo/native fork onto existing public API.
- **Chose:** selective fork with upstream MIT notice. Native host cards and truthful statuses, scrollable sheets, responsive workspace/session pages, separate SecureStore credentials, key identity deduplication, v2-only latch, bounded redacted diagnostics and reconnect without mutation replay. Page generations verify bytes/hash/build identity before activation; max6hosts LRU; per-route grants and no page socket/token. Unsupported cloud/push/distribution remain explicit, not upstream links. All detailed question/default answers and examples are in the committed combined logic spec.
- **Why:** preserves all independent observable flows while respecting the direct-only architecture and daemon ownership.
- **Evidence:** mobile.md flows3–7/9, Client details, Credential storage and Page bundle; docs/quirk/specs/2026-10-28-sb-mobile-app/logic.md Decisions locked and A1–A8.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** actual Expo/native compatibility evidence invalidates the split.
- **Source:** assumed — autonomous

## D7: Reserve the panel extension seam for lane4 after the base lands
- **Question:** how independent sb-mobile-app-panels avoids shared-file conflicts with this base.
- **Options:** concurrent shared route/auth/App edits; isolated panel registry followed by a dependency cutover.
- **Chose:** lane4 owns apps/mobile/src/panels/** and exports PanelApp/route registry now. This item owns workspaces/session MobileRoute, PageApp, HostPageShell, bridge and base authorization. Lane4 extends route union, native grants/navigation/App and panel-specific authorization after this item lands. Base never waits on panels. Notification subscriptions remain lane4's scope, not a duplicate follow-up.
- **Why:** priority interjection explicitly establishes this independent seam; shared-file writes would violate component attribution.
- **Evidence:** priority lane4 coordination message; committed interface d0f213c5; shared implementation packet.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** the base export contract changes incompatibly.
- **Source:** assumed — autonomous

## D8: Defer real workspace Sleep until reversible stop/resume exists
- **Question:** whether the phone row can safely implement upstream Sleep using existing public APIs.
- **Options:** close/kill/status shortcut; add a full PTY/session/worktree lifecycle; explicitly defer the isolated flow to its prerequisite.
- **Chose:** no destructive substitute. Group Sleep/Hide sleeping with the single deferred-flow follow-up; require stop-with-history, persisted resume records, verified process teardown and worktree lifecycle before enabling it. Remaining core pages ship independently.
- **Why:** upstream Sleep captures resumes before stopping and verifying every process. Quirky close forgets/deletes; killed sessions are explicitly nonrestorable. Treating either as sleep risks losing session history and agent resume identity.
- **Evidence:** upstream mobile use-host-worktree-actions.ts:144–150; worktree-terminal-sleep.ts:130–305; Quirky sessions.ts:663–713,782–892; public PluginPty has kill/forget but no suspend operation.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** a reversible PTY/session contract lands.
- **Source:** deferred: reversible workspace sleep prerequisite

## D9: Keep shared delivery DTOs on the public plugin API
- **Question:** where bundle server and Expo shell share typed delivery data.
- **Options:** plugin imports private app source; duplicate DTOs; public protocol DTOs.
- **Chose:** canonical MobileBundle DTOs and MobilePageGrant in packages/protocol/src/mobile.ts, re-exported under unchanged names by app contracts. No runtime implementation or existing signature changes. Existing protocol index already exports mobile. Root typecheck now also checks the Expo app; desktop bundle integration builds pages.
- **Why:** plugins must use only public plugin API; a private app-type import would establish a second ownership convention.
- **Evidence:** docs/roadmap.md:19–20,50–53; shared contract vocabulary search found only app definitions before cutover.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** plugin API freeze changes delivery schema ownership.
- **Source:** locked by docs/roadmap.md

## D10: Expose trusted live connection state without broad event subscription
- **Question:** how base pages and later panels disable mutations immediately and refresh safely.
- **Options:** generic daemon events.subscribe; role-filtered projected event service; live transport state plus bounded read-only polling.
- **Chose:** MobilePageInit.connectionState and bridge readonly state/onState committed53b19b61. Shell forwards authenticated RPC lifecycle, native background closes/suspends owned direct clients, foreground reacquires a fresh channel, pages stop polling while disconnected/hidden. Keep events.subscribe denied; no implicit global subscription or generic event payload forwarding. Mounted pages refresh only safe read-only queries.
- **Why:** lane4 supplied source evidence that Core.broadcast sends unfiltered events to subscribed clients except two special cases. A global subscription would reveal unrelated sensitive payloads. Socket state needs no event permission. Native transport stays generic rather than maintaining a third divergent method-policy catalog.
- **Evidence:** priority lane4 source report packages/daemon/src/service.ts Core.broadcast; MobilePageBridge contract53b19b61; worker directives. Lane4 panel contracts eb750d27 and notification-only backend17bbe2b7 remain independent.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** a narrowly projected per-event consumer contract is introduced.
- **Source:** assumed — autonomous

## D11: Match terminal input authorization to its exact connection lease
- **Question:** whether a phone can infer driver ownership from deviceId alone.
- **Options:** optimistically treat any driver as this phone; compare same bearer identity; project exact connection-plus-device authority.
- **Chose:** mobileState returns caller-scoped controlledByCaller in response entries, not stored/event state. Clear/displayMode obey the exact same connection lease. Scope the existing input guard to connection+device, preserving trusted plugin bypass.
- **Why:** parent actual preimplementation two-socket probe showed a second socket using the same token, never attached, successfully wrote into the first socket's terminal. The expected denial failed with Missing expected rejection. Existing attach/claim already treats connection ID as owner identity; device-only input checking was inconsistent.
- **Evidence:** /tmp/quirky-phone-lane5-GcxchL/lease-red.ts; actual bg8 exit1 in4.68s; mobile-driver.ts:84,144–151. Both encrypted peers and temporary daemon cleanup were awaited. Post-fix proof still required.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** explicit shared-device multi-socket driving is authorized.
- **Source:** assumed — autonomous

## D12: Reject wrong-worktree attempts and relocate only proven owned edits
- **Question:** all three workers ignored assigned component roots and wrote into the parent.
- **Options:** silently accept contamination; discard everything; freeze and attribute exact source before relocation.
- **Chose:** froze all workers and waited for returns. Parsed raw write/edit payloads, confirmed component trees had no source changes and HEADd0f213c5, captured exact56file contents/hashes (23native/8pages/25bundle) and14tracked baseline blobs. Every changed source path was attributable and in its declared logical component; parent docs were separate. Copied exact contents into correct component trees through write tools, restored14tracked parent files byte-for-byte and removed42preserved new files through anchored edits. Inherited .serena untouched. Advanced components to53b19b61 and dispatched one fresh retry per component with explicit absolute path fences.
- **Why:** relative tool edit headers and absolute writes to the default workspace bypassed requested worktree isolation. No contaminated source was committed or accepted as complete. Source preservation avoids discarding attributed work or unrelated user data.
- **Evidence:** /tmp/quirky-phone-lane5-GcxchL/attribution-raw.json, relocation-snapshot.json, parent-owned-removal.patch; original worker freeze receipts; relocation preflight unexpected:[] and component HEAD checks.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** any subsequent source mutation targets the wrong worktree; stop that writer immediately.
- **Source:** assumed — autonomous

## D13: Project mobile Session results at their producer and use a safe agent catalog
- **Question:** lane4 identified credentials in Session.launch.env and raw AgentsService.info environment results.
- **Options:** guess recursive transport scrubbing; deny all sessions; producer-owned exact projection and safe catalog.
- **Chose:** session plugin omits optional launch for mobile list/get/create/resume/restore/setName before serialization, leaving local CLI/desktop/plugin object and launch intact. Real encrypted-consumer regression covers all six methods and local retention; red failed at own launch presence, then green1test14assertions in911ms. Launch metadata is never sent to pages for client-side redaction. Raw quirky.agents/list remains denied; base launcher uses lane4-owned quirky.mobile/agentCatalog with only id/label/enabled/available/resumable/defaultAgent. No vault prepareResume exposure; lane4 handles vault producer separately.
- **Why:** producer knows the specific credential-bearing field. Broad response scrubbing could miss it or corrupt unrelated typed results. Safe launch IDs still resolve full configuration on the desktop.
- **Evidence:** priority lane4 source reports model.ts256–278, records.rowToSession and AgentsService.info538–558; main.ts producer projection; plugins/quirky.session/test/mobile-projection.test.ts red artifact32 then green bg11.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** new mobile Session-returning methods or catalog credential fields are added.
- **Source:** assumed — autonomous

## D14: Adopt the committed safe catalog's exact installed/isDefault shape
- **Question:** lane4's completed producer differs from its initial available-field proposal.
- **Options:** keep the proposal with an alias; consume the real producer contract exactly.
- **Chose:** cherry-pick module/test-only619876b9 as94597e25, never the panels branch. Exact result `{defaultAgent:string|null,agents:[{id,label,installed,enabled,isDefault,resumable}]}`; no available alias or raw-list fallback. Parent intentionally advanced bundle component53b19b61→94597e25 to supply that prerequisite without touching its uncommitted source. Bundle owns main/manifest/CLI/literal authorization integration. Existing Schema cannot express a string/null union, so nullable defaultAgent is accurately described and producer-owned rather than broadening the protocol schema.
- **Why:** eliminates credential-bearing agents/info payloads while launching the full saved config server-side. The exact producer, not an earlier proposal, is the contract.
- **Evidence:** lane4 checkpoint619876b9 and supplied green sealed catalog1test6assertions; actual cherry-pick94597e25; producer exports registerMobileAgentCatalog; public schema type limitations reported by bundle implementer.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** catalog producer fields change or public schema gains nullable unions.
- **Source:** supersedes sb-mobile-app D13 catalog field proposal

## D15: Resume the integrated source instead of repeating the implementation wave
- **Question:** iteration10 notes still described active component workers although source had advanced.
- **Options:** replay workers; recover the tree and checkpoint the existing repairs.
- **Chose:** source checkpoint5f38fe26, then canonical queue wait reclaimed only sb-mobile-app. No retained worker was running. Prior integrated commits are eded38d5 pages,248bd077 native,8c7c2480 delivery,cbe76914 integration. Preserve inherited .serena; no second item.
- **Why:** the tree and process registry supersede stale notes. Repeating implementation would overwrite completed work.
- **Evidence:** iteration10 initial git status/log and proc://; scratch wave-final-audit.json and retry-native-pages-audit.json.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** attribution evidence contradicts a source path.
- **Source:** assumed — autonomous

## D16: Verify the portable native runtime against the actual encrypted daemon and PTY
- **Question:** whether test peers alone prove phone interoperability and terminal authority.
- **Options:** rely on mocks; run production createMobileRuntime with an isolated actual daemon.
- **Chose:** actual runtime pairing, info/preferences, shipped bundle bytes, real shell output, desktop display-mode input denial and phone reclaim, ask answer/wait, revocation to auth-failed, credential removal. All passed in29.974s and cleanup observed homeRemoved:true. This does not prove iOS SecureStore, camera or WebView behavior.
- **Why:** independently exercises production client/server framing and public APIs with real PTY output.
- **Evidence:** iteration10 native-smoke.ts output; apps/mobile/test/daemon-questions.test.ts; docs/loop/native/sb-mobile-app.json N1–N5.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** native transport or daemon framing changes.
- **Source:** assumed — autonomous

## D17: Declare the Babel preset required by the actual Expo export
- **Question:** Expo iOS export failed before bundling because babel.config.js could not resolve babel-preset-expo.
- **Options:** depend on transitive hoisting; remove the Expo preset; declare its installed Expo55 version directly.
- **Chose:** direct devDependency babel-preset-expo55.0.25. Actual rerun exported811modules and a3MB iOS Hermes bundle. Native Swift policy executable also printed mobile web shell checks OK. The export is not a device launch.
- **Why:** isolated Bun workspaces do not make transitive presets resolvable from the app config.
- **Evidence:** iteration10 failed then successful bunx expo export --platform ios; apps/mobile/babel.config.js; package.json and bun.lock.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** Expo major version changes.
- **Source:** assumed — autonomous

## D18: Keep launch authorization no wider than the shipped phone launcher
- **Question:** the existing rejection regression found prompt accepted by daemon authorization although the page only sends worktree/agent/cols/rows.
- **Options:** relax the test; expose unused launch arguments; restrict the producer-side literal parameter list.
- **Chose:** exactly worktree/agent/cols/rows; command/cwd/extraArgs/model/options/prompt remain denied. No arbitrary launch configuration or compatibility alias.
- **Why:** saved agent configuration is desktop-owned; unused argument authority serves no shipping consumer.
- **Evidence:** iteration10 authorization.test.ts failure then focused pass; SessionPage.tsx create call; bridge-policy.ts literal create contract.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** a reviewed phone launch flow requires another typed argument.
- **Source:** assumed — autonomous

## D19: Isolate daemon fixtures without increasing deadlines or weakening security assertions
- **Question:** full-builtins startup exceeded default5s in focused catalog/daemon cases; the same-token regression also dialed advertised192.0.2.17 instead of loopback.
- **Options:** raise deadlines; remove behavior assertions; curate real feature dependencies and correct the fixture address.
- **Chose:** reuse existing makeBuiltinDir pattern: catalog activates real mobile+agents; daemon scenarios activate the nine actual services they exercise. Same-token second socket dials the actual loopback listener. Preserve exact-connection denial for input/clear/displayMode. Move omitted-params admission assertion beside the existing16pending agent-status waits; remove its duplicate setup using now-denied ask/wait. No new mobile permission and no changed test timeout.
- **Why:** unrelated startup and a nonlocal test endpoint are fixture costs, not feature behavior. Denied calls cannot occupy the request budget.
- **Evidence:** iteration10 failures artifacts20/24/37/40; CatalogLifecycleDiagnosis; plugins/quirky.session/test/support.ts makeBuiltinDir; daemon.test.ts.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** a curated fixture omits a dependency its consumer actually needs.
- **Source:** assumed — autonomous

## D20: Apply every incoming binding after one canonical catchup
- **Question:** what changed on build/roadmap during the mobile implementation.
- **Options:** ignore concurrent decisions; merge and review every incoming log.
- **Chose:** catchup ecbdc395; only bun.lock conflicted, preserving incoming loops UI dependencies and mobile dependencies. Frozen install passed. IncomingMobileBindings read all14 logs fully: editor-drop-open-in-place, automations-dispatch/UI, loops-UI, structured-runner, heimdall-control/core/owner, orchestration-UI/workers, sweep-hosting/terminal, browser-pane/profiles-settings. No binding conflict found.
- **Why:** public ownership, exact identities, background focus safety and truthful unavailable behavior remain authoritative.
- **Evidence:** iteration10 merge output and IncomingMobileBindings full report with each log's D numbers.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** another decision explicitly changes the mobile boundary.
- **Source:** locked by docs/loop/LOOP.md

## D21: Do not invent Browser or Markdown session tabs without a safe consumer contract
- **Question:** upstream session tabs include Browser and Markdown but the public Session model only supports terminal/structured kinds.
- **Options:** fake tabs; expose unrestricted browser/editor methods; explain unavailable capabilities and track their prerequisite.
- **Chose:** explicit unavailable descriptions in New tab. Include safe Browser/Markdown session rendering in the single deferred-flow follow-up, requiring a real phone-authorized read API, renderer and public session identity.
- **Why:** headless browser methods are not phone-allowlisted; editor preview needs an open buffer and the page has no Markdown renderer. Neither can be represented by a terminal session alias.
- **Evidence:** SessionPage.tsx New tab unavailable descriptions; guarded run20261028T104207-81f5 obs14; protocol SessionKind.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** those safe producer and rendering capabilities land.
- **Source:** deferred: Browser and Markdown session prerequisites

## D22: Skip the unstarted model review under the overdue-item rule
- **Question:** whether to start the planned Gemini final review after this item already exceeded the night-mode two-hour limit.
- **Options:** start another model round; finish its own required gates and land.
- **Chose:** no unstarted model review. Complete the already-started UI proof and required affected suites/scripts/typecheck. No model-review PASS is claimed.
- **Why:** authoritative LOOP.md says an already-overdue item lands as soon as its own tests/typecheck pass, skipping reviews and dogfood passes it has not started.
- **Evidence:** authoritative LOOP.md Night mode; elapsed retained iteration9 source/evidence timestamps.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** a required gate exposes a concrete defect.
- **Source:** locked by docs/loop/LOOP.md

## D23: Separate guarded verdicts, direct visual proof and native-device obligations
- **Question:** guarded actions reported UNSETTLED even when their screenshots showed the intended result.
- **Options:** relabel them pass; discard visible evidence; preserve the exact verdict and independently inspect the built phone surface.
- **Chose:** guarded run20261028T104207-81f5: ask and New tab pass; workspace/terminal partial, no test overrides, no kept-open state or cleanup errors. obs8 shows actual PHONE_UI_SMOKE_OK; obs12 shows the real ask Answered: Yes. A separate isolated-browser proof at320×568 and320×300 verified304px-wide options inside320px, reachable bottom Done/new-workspace actions, cancellation restoring layout, keyboard text and icon focusing the actual terminal textarea, real PHONE_320_OK output, actual second terminal creation and tab-specific replay, and a reachable cancelled close confirmation. No new page errors were observed. First shared-browser screenshot failed and its tab was killed; a fresh owned browser succeeded.
- **Why:** tool settling limits are not application passes or application failures. The fixture uses the actual built bundle, production bridge/runtime and actual encrypted daemon/PTY; its native bridge shim is not a real iOS WebView or OS keyboard.
- **Evidence:** .quirk/using-apps-like-a-user/runs/20261028T104207-81f5/report.json; iteration10 browser screenshots and geometry/focus/output results; both owned surface cleanup receipts exit0/homeRemoved:true.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** physical device checks N1–N6 fail.
- **Source:** assumed — autonomous

## D24: Keep one grouped prerequisite follow-up, never guessed origin filters
- **Question:** which independent flows remain impossible under current public capabilities and locked exclusions.
- **Options:** fake or destructive substitutes; one item per unavailable control; one grouped prerequisite item.
- **Chose:** single dependent item sb-mobile-app-prerequisites names native-chat/attachments/queue/options/background-task UI and voice/settings (authorized architecture/roadmap ruling and APIs), Sleep/Hide sleeping (reversible stop/history/resume), automation/other-client filters (real provenance), Browser/Markdown session tabs (safe data/renderer and public identity). In particular createdBy=api is not evidence of automation. Separately owned panels/notification subscriptions and installation links are not duplicated.
- **Why:** each missing prerequisite is stated at the unavailable UI; the independently functioning terminal/ask companion can land without overriding locked decisions or destroying session state.
- **Evidence:** D5,D8,D21; logic.md amendments and deferred ideas; WorkspacesPage unavailable filter descriptions; single queue-add packet followup.json.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** one of the explicit prerequisites becomes available.
- **Source:** deferred: locked and producer-dependent mobile flows

## D25: Keep unexecuted platforms and physical-device behavior explicit
- **Question:** what native platform claims the macOS execution supports.
- **Options:** infer Android/iOS execution from source/export; retain pending native/platform obligations.
- **Chose:** macOS build/test only. Expo iOS JS/Hermes export and portable Swift policy executable ran; no iOS simulator/device launch or Android build is claimed. Native camera, SecureStore lock, origin WebView, system keyboard, home/onboarding/settings stay N1–N6 pending. Android runtime/native compilation and Linux/Windows host integration remain unverified platform work.
- **Why:** exporting JavaScript and checking portable policy do not execute OS integrations.
- **Evidence:** actual Expo export and swiftc outputs; docs/loop/native/sb-mobile-app.json.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** platform-specific runners execute these scenarios.
- **Source:** deferred: platform

## D26: Close the actual affected-gate failure without pinning an incidental DTO shape
- **Question:** the affected runner found one daemon identity test expecting the old whole caller object without the new mobile connection.
- **Options:** hard-code the new serialized connection fields; remove the security regression; assert the immutable identity across malicious inputs.
- **Chose:** initial trusted identity uses its security fields, then malicious hello and forged role/name/device parameters must leave the complete initial identity unchanged. No literal connection ID or new object shape is pinned. Focused regression passed5tests38assertions in378ms. Document the mobile CallerConnection contract.
- **Why:** D11 needs exact live connection authority, and spoofed RPC fields must never change it; unrelated DTO growth is not an identity-forgery failure.
- **Evidence:** affected run236remote files235passed/1failed; plugin-clients.test.ts actual expected-object failure; focused5pass0fail. Both macOS files accepted after terminal e2e SC2 passed its canonical isolated rerun. No no-retry or single-run238/238 claim.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** caller identity or connection admission changes.
- **Source:** assumed — autonomous

## D27: Retain final own-gate evidence and repair invalid meta policy at its source
- **Question:** what evidence supports landing the companion after catchup.
- **Options:** infer success from worker reports; retain exact commands and limits.
- **Chose:** affected235/236remote plus repaired daemon file5/0;2mac files accepted with the noted retry. Scripts68pass0fail580assertions; caught-up root/mobile typecheck exit0 in122.34s. Desktop package exit0; Expo export811modules/3MB; Swift policy checks OK; real encrypted runtime smoke29.974s/homeRemoved:true. Final page generation26a5a2e8499f650823cb328b0440cc4455ff133f3fb871f621100d6fdd8188fb contains589385bytes/3assets; bundle/shell10pass0fail50assertions. Browser warned that frame-ancestors is ignored in meta and navigate-to unsupported; remove those ineffective meta directives, retaining native response-header frame-ancestors and native navigation denial. The corrected bundle drove the narrow real-PTY visual proof with no new page errors. Original guarded report retains its CSP and fixture-favicon findings rather than rewriting history.
- **Why:** actual consumer checks and smoke evidence support the shipping scope; the canonical land still owns the whole merge-result suite.
- **Evidence:** iteration10 commands bg3/6/7/11/18/20/21/22/23; guarded report; direct browser proof. Expected negative fixture errors and optional icon/release warnings are not hidden.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** canonical land or native handoff exposes a failure.
- **Source:** assumed — autonomous

## D28: Follow canonical landing retry rules after a concurrent dependency conflict
- **Question:** first land refused the feature's merge with the newer roadmap before running its tests.
- **Options:** bypass the queue; discard another feature's dependencies; merge the canonical branch and reverify.
- **Chose:** required retry merge. Preserve Expo plist/transitive entries and incoming Browser design pngjs7 plus qrcode's nested pngjs5; do not edit protected loop code or weaken verification. MobileRetryBindings read all five newly incoming logs fully: fix-flaky-daemon-pty-client D1–D9, hosting-api-github-parity D1–D21, structured-runner D1–D53, heimdall-control D1–D16 and browser-design-mode D1–D37. No mobile binding conflict. Re-run affected directories and root/mobile typing on the resolved merge before retrying land.
- **Why:** other lanes landed while this item verified. The new PTY retirement fix does not satisfy reversible mobile Sleep, and Browser design does not supply mobile-safe Browser tabs.
- **Evidence:** first canonical land bg25 refused after261.41s; feature checkpoint32cd60fa; bun.lock conflict blocks; MobileRetryBindings full report. The merged queue confirms sb-mobile-app-prerequisites status todo with this item's dependency.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** the merged gate fails.
- **Source:** locked by docs/loop/LOOP.md

## D29: Land now under the operator's build-first, end-phase testing directive
- **Question:** the operator moved all suites, debugging, dogfood and review work to the end phase while this item was retrying landing.
- **Options:** continue investigating the shell-path gate; obey the new typecheck-only landing rule.
- **Chose:** stop testing and debugging immediately. Latest merged source5a3ddce3 already passed bun run typecheck, including mobile, in75.99s. Commit this receipt and retry canonical land, which now checks typecheck only. Keep the one existing follow-up solely for unbuilt flows; add no test/debug/review item.
- **Why:** new authoritative LOOP.md Build first, test at the end and the direct operator instruction override earlier gate requirements. Historical failed tests remain failed, not waived passes.
- **Evidence:** retry affected run235/236remote plus2/2mac passed; shell-path.test.ts guardian bootstrap hooks failed after15passing cases and repeated in its isolated retry. GuardianStartupDiagnosis found no proven cause; read-only remote inventory showed4zombies, not evidence of exhaustion. One attempted diagnostic preload exited127 because remote noninteractive PATH lacked bun, so it ran no tests and changed no source. No shell-path/process-scope repair was applied. This evidence belongs to m7-test-triage, not a new follow-up.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** the typecheck-only canonical land fails.
- **Source:** locked by docs/loop/LOOP.md Build first, test at the end; supersedes D28's test-gate requirement

## Progress
Operator build-first override applied: tests/debugging stopped, no additional test/review follow-up. Resolved concurrent merge5a3ddce3 passes root/mobile typecheck75.99s; shell-path guardian failure retained for the end phase without a source fix or passing claim. One unbuilt-flow follow-up is registered. Commit this receipt, detach and retry absolute queue land sb-mobile-app under its typecheck-only gate, then clean owned scratch and end this one-item iteration. No active agents/services remain; native N1–N6 pending.
