# sb-mobile-app-prerequisites decisions

## D1: Handle only the claimed prerequisite follow-up
- **Question:** Which work and workflow does this iteration own?
- **Options:** Resume the previously blocked preview item; claim another item; handle the canonical lane 7 claim only.
- **Chose:** Handle only sb-mobile-app-prerequisites on build/sb-mobile-app-prerequisites. Canonical queue deps reports ready with no pending dependencies. Use the current integration queue.ts from this worktree. No human questions, research swarms, review rounds or unrelated source changes.
- **Why:** The preceding iteration already blocked sa-browser-pane-workspace-preview. Its blocker does not authorize resuming it. LOOP.md requires one item and autonomous source-grounded decisions.
- **Evidence:** Canonical queue.ts wait --lane 7 returned this item; queue.ts deps sb-mobile-app-prerequisites returned {ready:true,pending:[]}; git show build/roadmap:docs/loop/LOOP.md, Each iteration and Build first sections.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** The queue explicitly reassigns the item or the controlling loop policy changes.
- **Source:** locked by docs/loop/LOOP.md

## D2: Preserve every deferred category and its explicit condition
- **Question:** What is the consumer, purpose, primary behavior, success criterion and scope of this follow-up?
- **Options:** Rebuild the working companion; implement only one convenient control; assess and retain all prerequisite-dependent flows.
- **Chose:** The paired phone is the consumer. The requested behavior is real interactive native chat with attachments, queued messages, options and background tasks; voice dictation/models/settings; reversible workspace Sleep/Hide sleeping; genuine automation/other-client origin filters; and Browser/Markdown session tabs. Each category must satisfy the prerequisites named in the claimed title and parent D5/D8/D21/D24. Keep the shipped terminal/ask companion unchanged. Separately owned panels, push, signed distribution and source-control/files/tasks/accounts/history are not new work here.
- **Why:** This is the single grouped unbuilt-flow follow-up registered by sb-mobile-app, not a new approval of dropped products or a request to relabel unavailable controls as successful implementations.
- **Evidence:** Canonical claimed item title; docs/loop/decisions/sb-mobile-app.md:47-56,80-89,223-232,256-265; docs/quirk/specs/2026-10-28-sb-mobile-app/logic.md:6-18,67-68; external mobile.md flows 6,7,9.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** An authorized ruling changes the requested conditions or a real prerequisite lands.
- **Source:** locked by docs/loop/decisions/sb-mobile-app.md

## D3: A follow-up title cannot override the locked native-chat and dictation exclusions
- **Question:** May the unattended lane authorize the requested interactive structured chat and speech products?
- **Options:** Treat general parity or the follow-up as an override; expose background structured jobs as interactive chat; require the explicit ruling named by the follow-up.
- **Chose:** Require an authorized architecture/roadmap ruling and real public APIs before implementing native interactive chat or dictation/model/settings. Do not widen mobile authority to create structured interactive sessions, fake a transcript with asks, add inert settings, or repurpose terminal command injection as native chat.
- **Why:** Architecture Decisions limits structured sessions to background agents; its structured-session section explicitly retains interactive Claude/Codex in terminals because native chat was dropped. Roadmap explicitly says dictation was dropped. LOOP.md locks those decisions and requires blocking a design that needs them changed.
- **Evidence:** docs/architecture.md:164-178,290-305; docs/roadmap.md:175-181; docs/loop/decisions/sb-mobile-app.md D5/D24; literal policy plugins/quirky.mobile/src/daemon/authorization.ts:8-52,223-230.
- **Reversibility:** hard (only an authorized scope ruling can change the product boundary)
- **Confidence:** high
- **Revisit if:** The authorized architecture/roadmap ruling explicitly permits interactive native chat and voice, with a corresponding owned API contract.
- **Source:** locked by docs/architecture.md

## D4: Resolve safety and interaction gray areas without inventing provenance or destructive substitutes
- **Question:** What defaults apply to API authorization/errors, visual interactions, data mapping/persistence and cross-client lifecycle?
- **Options:** Guess identities/statuses and broaden generic authority; preserve precise public boundaries; silently hide deferred categories.
- **Chose:** Preserve exact connection-scoped terminal driving, literal phone method and route grants, credential-free producer projections, explicit unavailable descriptions and authoritative errors. Do not infer automation from createdBy=api, infer other-client ownership from a caller label, map Sleep to close/kill/delete/status, alias Browser/Markdown tabs to terminal session IDs, or use agent Chrome as an unapproved human renderer. Keep historical unknown origin unknown. Missing adapters alone are implementable work, not proof of an outside blocker; evaluate upstream ownership and actual capability separately.
- **Why:** The parent decisions require real provenance, reversible history/resume and safe phone data/renderers/public identity. Grant checks and a label are not implementations of those features. They must not damage the independently working companion.
- **Evidence:** docs/loop/decisions/sb-mobile-app.md D8,D10,D11,D13,D18,D21,D24; docs/architecture.md:302-305; external mobile.md flows 6,7,9.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** New producer-owned contracts establish real identities, lifecycle and safe rendering.
- **Source:** assumed — autonomous

## D5: Build the permitted prerequisites rather than block on missing adapters
- **Question:** Does the absent chat/voice ruling make every category impossible?
- **Options:** Block the grouped item immediately; invent chat authorization; implement the independent permitted producer lifecycles and phone consumers.
- **Chose:** Implement reversible Sleep, trustworthy origins and safe nonterminal phone tabs in three disjoint components, retaining only genuinely locked/outside-limited flows in one follow-up before land. Commit shared public DTOs and the one combined spec before dispatch. OpenAI omp task implementers; review dispatch is disabled by the controlling build-first policy, so no reviewer availability or review pass is claimed.
- **Why:** The read-only scout found existing PTY restore/history, worktree persistence, editor buffers/UI tab identities and Browser public APIs. Missing public operations can be built in this milestone under roadmap19-53; only native chat/voice has a confirmed scope prohibition. Browser streaming must satisfy the existing Native-human/Chrome-agent boundary.
- **Evidence:** MobilePrerequisites completed report; packages/protocol/src/pty.ts; plugins/quirky.session/src/sessions.ts; plugins/quirky.worktree/src/daemon/store.ts; plugins/quirky.editor/src/types.ts; docs/quirk/specs/2026-10-28-sb-mobile-app-prerequisites/logic.md.
- **Reversibility:** medium
- **Confidence:** high for authorization distinction; implementation proof remains required
- **Revisit if:** A concrete producer limit prevents a specific flow without overriding a locked decision.
- **Source:** assumed — autonomous

## D6: Extend atomic save rather than perform an unsafe mobile precheck
- **Question:** Can the mobile adapter enforce revision-guarded Save using the existing editor save API?
- **Options:** Precheck then call unguarded Save; add an optional producer-owned CAS guard.
- **Chose:** Add optional expectedRevision to quirky.editor/save and check it under the existing buffer lock before writing. Mobile always supplies the revision; unrelated current callers retain their unguarded operation. Markdown Copy Path uses normalized worktree-relative metadata, not an absolute host path.
- **Why:** A desktop draft can change between adapter precheck and save. Only the owning locked producer can prevent that stale write atomically.
- **Evidence:** MobileTabs producer inspection and contract request; combined spec dated CAS amendment; shared MobileMarkdownDocument.relativePath.
- **Reversibility:** medium
- **Confidence:** high for race requirement; implementation proof pending
- **Revisit if:** Buffer locking or revision semantics change.
- **Source:** assumed — autonomous

## D7: Ship explicit Watch with exclusive producer ownership, not a silent Native replacement
- **Question:** Does absent Native frame capture prevent all phone Browser tabs?
- **Options:** Claim all Browser flows blocked; silently start Chrome for a Native tab; implement explicitly elected Watch through an owned public lease.
- **Chose:** Browser (Chrome Watch) is explicit opt-in under sa-browser-pane D2. Existing Native tabs with actual hosted tab IDs remain visible with a precise streaming-unavailable explanation and are never converted on selection. Extend the existing public Browser Watch producer to distinguish the default local consumer from a kernel-authenticated quirky.mobile plugin consumer; the phone broker derives its consumer key from the actual live caller connection, never request identity. Start/ack/input/navigation/control/stop/close cannot borrow or interfere with another consumer's lease. Frame projection is latest-only, exact worktree/tab/watch/connection matched, capped at512KiB encoded JPEG and acknowledged only after image load. Stop hidden/closed/disconnected consumers and await plugin disposal.
- **Why:** The existing paneWatch returns the same active pane-global watchId, so a mobile-only broker would otherwise stop desktop streaming or acknowledge another renderer's undrawn frame. That is missing implementable producer ownership, not an outside host limit. Native capture truly lacks a current producer, but Watch is already an authorized explicit mode.
- **Evidence:** docs/loop/decisions/sa-browser-pane.md:14-23,36-45; plugins/quirky.browser/src/pane-service.ts:960-1013,1031-1052,1055-1085; runtime/driver.ts:886-892 JPEG screencast; shared MobileBrowserFrame/closed method table; combined spec Watch amendment.
- **Reversibility:** medium
- **Confidence:** high for ownership requirement and mode ruling; runtime proof pending
- **Revisit if:** Native offers a real safe frame/control producer or multi-renderer Watch gains independently acknowledged consumer streams.
- **Source:** locked by docs/loop/decisions/sa-browser-pane.md

## D8: Keep unknown origins visible and replace incidental protocol pins with behavioral compatibility coverage
- **Question:** How should absent historical origin evidence and the new PTY wire operation affect existing consumers?
- **Options:** Guess automation/other-client ownership and repin version literals; preserve unknowns and compatibility behavior.
- **Chose:** Only true producer predicates hide rows; null origin and partial recovery remain visible. Persist Hide sleeping and origin preferences without forcing them false. PTY's actual stop-with-history operation requires wire version4 so a running pre-feature host is replaced. Remove runtime type-shape/constant-literal tautologies and duplicate old-host version-pin tests; retain substantive old-host retirement and newer-host refusal without pinning an incidental current version or message.
- **Why:** A path-derived workspace ID or createdBy=api is not origin evidence, and a constant equality does not exercise compatibility. Newer-host refusal must still preserve the live newer host without shutdown or spawning a replacement.
- **Evidence:** MobileOrigin completed producer report and worktree_origins instance-keyed store; MobileSleep protocol-change report; packages/daemon/test/pty-client.test.ts compatibility scenarios; deleted packages/protocol/test/pty-protocol.test.ts consisted of literal/type assertions.
- **Reversibility:** easy
- **Confidence:** high for policy and test intent; no suite execution claimed
- **Revisit if:** Trusted stable client provenance becomes available for additional surfaces.
- **Source:** assumed — autonomous

## D9: Pin recovery to filesystem identity and avoid structured callback deadlocks
- **Question:** Can a path-derived worktree ID safely authorize durable wake and nested structured callbacks?
- **Options:** Restore by ID/path alone and hold a non-reentrant workspace lock across every backend call; pin verified instances and admit exact owned structured lifecycle callbacks.
- **Chose:** Private recovery instance_id, verified before teardown/resume and when projecting states. Stale recovery is partial, keeps history and cannot spawn into a replacement; a verified new instance can launch fresh sessions. Partial workspaces remain openable without automatic Wake. Normal structured resume checks awake state without holding the workspace lock across the backend's reentrant register call. During wake, only exact-session, bounded, kernel quirky.structured callbacks can publish provider IDs through the held lifecycle.
- **Why:** IDs are derived from paths, not filesystem identity. The original assembled structured resume would reenter the same workspace mutex; provider-ID callbacks also need an explicit scoped admission rather than a broad caller-supplied bypass.
- **Evidence:** plugins/quirky.session/src/sessions.ts instance checks, structuredWakeProviderUpdates and register/setProviderSession; src/records.ts private migration; workspace-sleep.test.ts ordinary structured resume, wake/provider propagation, and same-path replacement regressions.
- **Reversibility:** medium
- **Confidence:** high for inspected invariants; shell lifecycle smoke executed, structured/provider edge tests written but not run
- **Revisit if:** A new backend publishes lifecycle callbacks through another ownership path.
- **Source:** assumed — autonomous

## D10: Correct actual cross-plugin bounds and schema errors before claiming integration
- **Question:** What did real compilation, manifest validation and the production phone smoke establish?
- **Options:** Pin incidental test literals or relax checks; repair the producer contracts and use behavioral coverage.
- **Chose:** Correct the three unsupported nullable type arrays in Sleep result schemas to documented untyped nullable error fields. Correct atomic Editor Save return/discriminant typing and test DTO narrowing. Use the canonical public tab/document/frame types, not temporary augmented copies. The first actual phone smoke failed because Markdown read requested65537 UTF-16 units while the public editor maximum is65536; request65536, retaining the UTF-8 producer precheck/EOF/revision guards and add the exact ASCII-boundary regression.
- **Why:** Valid TypeScript alone does not admit a plugin manifest, and a nominal64KiB byte budget does not authorize a65537-unit public read. An inert or invalid contribution is not a shipped feature.
- **Evidence:** MobileContractValidation read-only report identified session manifest1629/1661/1690; actual initial bun run typecheck diagnostics, then successful root+mobile typecheck; actual first smoke exited1 with editor text-length error and homeRemoved:true; subsequent actual encrypted client smoke printed all five true fields and cleaned its home.
- **Reversibility:** easy
- **Confidence:** high for exercised compilation, schema repair and Markdown runtime path; no suite pass claimed
- **Revisit if:** The editor chunk contract or public Schema vocabulary changes.
- **Source:** assumed — autonomous

## D11: Keep complete safe Markdown rendering and actual Watch hit testing
- **Question:** Is a heading-only preview or an unscaled screenshot pointer sufficient for phone tabs?
- **Options:** Ship partial Markdown and raw frame coordinates; reuse the existing Markdown ecosystem and honor actual screencast geometry.
- **Chose:** Direct mobile dependencies react-markdown10.1 and remark-gfm4, no raw HTML plugin, inert links/images. The Watch runtime records actual pageScaleFactor/offsetTop and converts frame DIP pointer/wheel coordinates to layout CSS pixels only after validating the frame. Keep exact tab/lease/connection authorization unchanged.
- **Why:** Real UI showed headings/lists/emphasis and inert script text. A real nonresponsive page had visualViewport.scale0.382653: clicking its displayed button missed, while the incorrect unscaled location activated it. After conversion, the actual displayed button activated the target; public readback showed heading BROWSER_CLICKED_7 and input PHONE_TYPED_7. This is a geometry bug, not a reason to special-case the fixture or weaken lease checks.
- **Evidence:** apps/mobile/src/pages/MarkdownPreview.tsx; packages/protocol/src/mobile-workspaces.ts; plugins/quirky.browser/src/runtime/driver.ts frame metadata/input conversion; actual owned page screenshots and public quirky.browser/eval observational readback; browser-watch.test.ts real scaled-button regression.
- **Reversibility:** medium
- **Confidence:** high for actual visual click/text path
- **Revisit if:** Chrome changes its screencast metadata coordinate contract.
- **Source:** assumed — autonomous

## D12: Separate default Chrome launch limits from isolated runtime proof
- **Question:** What does macOS headless Watch evidence prove without using the real user's keychain?
- **Options:** Call a timed-out default launch a pass; change timeouts or suppress transport loss; use the established isolated-keychain harness option and retain the default-launch obligation.
- **Chose:** Record the two default-launch Page.navigate stalls without relabeling them. A controlled Browser factory override changed only Chrome arguments to the existing harness's --use-mock-keychain; the real runtime then navigated, continued intercepted requests, streamed JPEGs and handled owned input/history/reload/close. No production timeout/classifier change was made to hide the stall. Real macOS default-keychain/permission behavior and phone OS interactions are pending N1–N3, not a new testing/debug queue item.
- **Why:** The trace proved CDP Page.navigate timed out before a response; later transport loss came from existing epoch invalidation. It did not prove a prior WebSocket disconnect or the underlying native prompt cause. Mock-keychain success is isolated-runtime evidence, not a default native launch pass.
- **Evidence:** WatchNavigationCause read-only causal report; temporary script CdpConnection tracing; lane7MobileWatchTrace Page.navigate timeout; lane7MobileWatchSafeKeychain and lane7MobileWatchInputProof CDP navigate/Fetch continuation traces; docs/loop/native/sb-mobile-app-prerequisites.json.
- **Reversibility:** easy
- **Confidence:** high for observed difference; underlying default-launch native cause unproven
- **Revisit if:** The nightly native default-launch scenario identifies a concrete product failure or completes its native permission flow.
- **Source:** deferred: platform

## D13: Retain exact smoke evidence and postpone suites under the controlling build-first policy
- **Question:** Which completed checks may be claimed?
- **Options:** Infer acceptance from worker reports; run postponed suites/review rounds; retain the executed API/UI smoke and typecheck only.
- **Chose:** All three component workers stopped before parent commits48083f14/68f5c445/a6df3deb and merges; their temporary worktrees were removed immediately after merge. Write acceptance/regression tests but run no suite, model review campaign or full desktop build. Actual production createMobileRpc paired two devices against a real daemon/PTY in fresh HOME/QUIRKY_HOME: caller-relative origins, Markdown stale/CAS/worktree denial/save, unique shell output, Sleep, daemon restart and Wake retained history all passed. Built pages into each owned temporary home, not the product asset directory, for the required changed-surface smoke.
- **Why:** LOOP.md postpones tests/reviews, while higher-level verification requires actual changed behavior. A portable/browser shim does not execute iOS SecureStore, the real WebView, OS clipboard, keyboard or native keychain dialogs.
- **Evidence:** MOBILE_API_SMOKE {actualEncryptedPhone:true,realPty:true,distinctCallerOrigins:true,markdownCasAndScope:true,sleepRestartWakeHistory:true};800589-byte built page generation; real UI390px and320×360 filter/Sleep/Wake/dirty-note/sanitized-preview checks; Watch target DOM/pixels and PHONE_WATCH_CLOSE_REAL_TERMINAL_OUTPUT_OK. All five owned smoke processes exited; every created home reported homeRemoved:true. Browser tabs released. Root/mobile typecheck passed before the final Watch geometry change; final caught-up typecheck remains the landing gate.
- **Reversibility:** easy
- **Confidence:** high for executed paths only
- **Revisit if:** End-phase suites or native N1–N3 identify a failure.
- **Source:** locked by docs/loop/LOOP.md

## D14: Keep one follow-up for only the still-unbuilt ruled/host-dependent flows
- **Question:** What remains unbuilt after the independent permitted flows ship?
- **Options:** Duplicate completed controls or file testing/review follow-ups; one prerequisite-only item for locked chat/voice and Native mirroring.
- **Chose:** Register only sb-mobile-chat-voice-native-ruling, dependent on this item, for interactive native-chat transcripts/attachments/queued messages/options/background-task UI and dictation/models/settings requiring an authorized scope ruling and APIs, plus Native tab mirroring requiring an actual safe Native frame/control producer. No test, review, default-keychain verification or completed-flow item was added.
- **Why:** The new explicit Watch path does not mirror Native webviews, and a follow-up title is not authority to reverse architecture/roadmap exclusions. The terminal/ask companion and newly built Sleep/origin/Markdown/Watch paths remain intact.
- **Evidence:** Canonical queue.ts add exited0; canonical integration queue read confirmed the exact single follow-up with status todo and dependency sb-mobile-app-prerequisites; D3/D7/D12 and native N1–N3.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** An authorized ruling or real Native producer removes one of these prerequisites.
- **Source:** deferred: remaining ruled and Native host flows

## D15: Correct the inherited Sleep assumption without discarding the explicit recovery prerequisite
- **Question:** The canonical catchup supplies a source-grounded decision that Worktree Sleep parks views, while the older mobile deferral assumed it stops processes.
- **Options:** Ignore the incoming ruling; silently replace the built recovery APIs with parking; preserve both explicit operations with distinct authority and names.
- **Chose:** Phone Sleep workspace/Wake workspace/Hide sleeping consume the canonical quirky.worktree/sleep,wake and Worktree.sleeping, keeping processes/buffers. Opening wakes parked views. Retain the newly built session stop/history/resume prerequisite under a separate Stop sessions (retain history) confirmation and Resume stopped sessions action, with distinct status wording and CLI/API ownership. No automatic descendant authority. Parked state is not inferred from session recovery, and partial recovery remains openable.
- **Why:** Incoming m7-sweep-terminal-completion D9 reread the actual worktrees source and explicitly corrected its old safety interpretation. A generic Sleep button must not kill agents under a decision that guarantees view parking. The queue's explicit retained-history/session-resume prerequisite can still ship without redefining Worktree Sleep.
- **Evidence:** docs/loop/decisions/m7-sweep-terminal-completion.md:91-100; plugins/quirky.worktree/src/daemon/controls.ts:205-232; current Worktree.sleeping contract; combined logic spec dated canonical-catchup amendment.
- **Reversibility:** medium
- **Confidence:** high
- **Revisit if:** An authorized product ruling explicitly unifies these distinct lifecycles.
- **Source:** supersedes sb-mobile-app D8 (Sleep interpretation only)

## D16: Preserve every incoming authority and producer convention during the one canonical catchup
- **Question:** Which incoming feature contracts must coexist with this implementation?
- **Options:** Resolve whole files to one side; combine source owners and migrate the new consumers.
- **Chose:** Read all15incoming decision logs fully through MobileIncomingBindings. Preserve bounded polling notifications and generation-specific cancellation, panel/terminal-artifact route grants, native transport proof, strict report/viewport/claim validation, secret-free producer projections, loop summaries and real Native metadata. Merge Editor Save CAS inside incoming permission/writability/viewer ownership. Keep incoming canonical Worktree migration5 unchanged and append the private creator table as migration6. Derive positive automation only from canonical immutable live-dispatch automationProvenance; private origin evidence supplies stable paired-device comparison, not a second automation classifier.
- **Why:** Concurrently landed producer ownership is binding. A missing origin-table row cannot erase reliable canonical automation evidence, and mixing two additions into an already-applied migration would leave existing integration homes without a table. Neither metadata nor mobile connectivity grants remote-host/filesystem or Native engine authority.
- **Evidence:** MobileIncomingBindings D coverage for all15logs; MobileOrigin merge resolution; MobileTabs atomic-save/permission resolution; source merge conflict receipts. New phone tab operations remain session-route-only; lifecycle/origin queries stay base-workspace routes; unrelated panels do not acquire Browser driving authority.
- **Reversibility:** medium
- **Confidence:** high for inspected composition; postmerge typecheck/runtime smoke still required
- **Revisit if:** The final caught-up gate exposes a concrete contract conflict.
- **Source:** locked by docs/loop/LOOP.md

## D17: Land only the caught-up tree with exact executed proof
- **Question:** Does the canonical merge preserve the changed phone paths and pass its only build-first gate?
- **Options:** Treat premerge evidence as postmerge proof; verify the actual composed source and retain limits.
- **Chose:** Resolve all source conflicts without whole-file backouts, remove the duplicate safe-catalog CLI handler reported by the first postmerge compiler run, then run root/mobile typecheck successfully in24.22s. Run a fresh real daemon/PTY/encrypted-phone smoke on the caught-up source. Canonical view Sleep preserved the running shell; explicit session stop/restart/resume retained history. The actual phone UI separately parked/hid/woke the worktree and stopped its sessions; Hide sleeping kept the stopped-but-unparked row visible. Opening resumed its shell. Markdown preview remained inert. Session-scoped Watch navigated, streamed and sent displayed-pixel pointer/text input to the actual target.
- **Why:** Canonical parking, immutable dispatch provenance, strict page policies and Editor permissions arrived during implementation. Their compiled/runtime composition—not an earlier branch—is the deliverable.
- **Evidence:** bun run typecheck exit0, including apps/mobile TS; MOBILE_API_SMOKE {actualEncryptedPhone:true,realPty:true,distinctCallerOrigins:true,markdownCasAndScope:true,viewSleepPreservesProcesses:true,sleepRestartWakeHistory:true};1006227-byte temporary page bundle; PHONE_VIEW_PARKING true with sessionStatus running; actual UI parkedRowHidden true and stopped row visible; POSTMERGE_WATCH_INPUT_OK true with BROWSER_CLICKED_7/POSTMERGE_PHONE_7 read from the real target. Postmerge smoke exited0 in4m39s with homeRemoved:true; all reported hook files were inside that owned temporary HOME; owned browser tab released. No suite, review campaign, full desktop build or default native-keychain/iOS pass claimed.
- **Reversibility:** easy
- **Confidence:** high for executed caught-up paths only
- **Revisit if:** Canonical land reports a conflict/type error, or end-phase/native scenarios find a concrete regression.
- **Source:** assumed — autonomous

## Progress
Single canonical catchup resolved; all workers/services stopped and all owned smoke homes cleaned. The caught-up source passed root/mobile typecheck and actual API/PTY/UI merge-seam smoke in D17. Native N1–N3 remain pending; suites/reviews remain postponed. The single remaining unbuilt-flow follow-up is registered. Next: commit the merge receipt and resolutions, detach, run canonical queue.ts land sb-mobile-app-prerequisites, clean owned scratch, update loop notes, and end this one item without another claim.
