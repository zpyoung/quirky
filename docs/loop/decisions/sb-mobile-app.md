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

## Progress
All original workers stopped;56attributed source files relocated into correct component trees and parent baseline restored. Fresh NativeCompletion/PagesCompletion/BundleCompletion retries running at53b19b61 with exact roots; parent owns session projection only, plus docs. Encrypted Session confidentiality1test14assertions passed after red; broader source/build/UI still unverified. Await source completion, audit HEAD/scope and run full affected acceptance; safe catalog helper from lane4 pending. Single-followup/onecatchup/finalreview/queue land still required. No wholequeuecompletion marker.
