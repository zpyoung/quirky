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

## Progress
Design/spec self-review complete; shared native/page/bundle contracts authored before implementers. Next: commit contracts/spec/decisions, create three disjoint temporary component worktrees and dispatch native/transport, pages and bundle/bridge/server implementers. Dependency ready:true; inherited .serena untouched; no implementation code/tests run yet. LSP unavailable; reviewer preflight Gemini reachable.
