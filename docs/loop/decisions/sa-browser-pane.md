# sa-browser-pane decisions

## D1: Take both queue parts together and answer all design questions autonomously
- **Question:** What scope/approval governs this unattended item?
- **Options:** part1 alone; both queue parts; wait for user
- **Chose:** browser.md section1 items1–10, including page events; no asks, companion, adhd or external research swarms; self-reviewed single markdown logic spec with technical final section.
- **Why:** queue wait lane4 returned both parts; current LOOP.md night mode prescribes autonomous recommended defaults and one spec.
- **Evidence:** queue wait 2026-10-28T00:35Z; docs/roadmap.md:230-244; external read-only browser.md:47-70; git show build/roadmap:docs/loop/LOOP.md night mode.
- **Reversibility:** medium (scope and acceptance)
- **Confidence:** high
- **Revisit if:** locked source contradicts a selected behavior
- **Source:** locked by docs/loop/LOOP.md

## D2: Preserve native human browsing and Chrome Watch as separate modes
- **Question:** Which approach meets the locked browser architecture?
- **Options:** Chrome-only screencast for every browser; iframe pages in app; sandboxed native system-webview plus exact-page Chrome screencast
- **Chose:** native plus Watch; never substitute iframe/Chrome for native human browsing silently. Native unavailable in a plain web client is explicit; Watch is opt-in.
- **Why:** native saves unused browser memory, while agents need CDP; iframe cannot embed arbitrary sites. Destroy native view on hiding, keep at most one resident per window; stop Watch subscription on hiding without closing agent page.
- **Evidence:** docs/architecture.md:180-203,290-305; installed BrowserView.ts and preload/webviewTag.ts; BrowserPaneMap survey.
- **Reversibility:** hard (engine/lifetime model)
- **Confidence:** high
- **Revisit if:** public native SDK proves unable to host a secure view
- **Source:** locked by docs/architecture.md

## D3: Adopt source-visible interaction, loading, error and settings defaults
- **Question:** Visual gray areas — layout/information density, interactions, empty/loading/error, defaults?
- **Options:** compact source toolbar; a new dashboard; command-only view
- **Chose:** compact accessible toolbar, New Tab blank state, retained URL on error, source zoom and7 viewport presets, three defaults applied only to new tabs, contextual keybindings and ordinary public hosted tabs.
- **Why:** matches documented user flows without inventing another browser model.
- **Evidence:** external browser.md:9-39,55-70,116-121,156-168; logic SC1–SC6/SC12.
- **Reversibility:** easy (UI presentation)
- **Confidence:** high
- **Revisit if:** real dogfood finds an inaccessible/misleading control
- **Source:** locked by browser.md

## D4: Use schema-declared pane APIs, bounded history and exact target identity
- **Question:** API/CLI/Data/Integration gray areas — auth, error/format, state, persistence, concurrency and targeting?
- **Options:** new transport/private kernel integration; existing plugin methods/events with public native capability; unscoped CDP passthrough
- **Chose:** existing authenticated namespaced RPC and generated CLI; typed pane contract; bounded200 history/8 suggestions/2KiB query; credentials/session tokens stripped before persistence; native pane state distinct from agent restoration; Watch same-worktree exact binding and fresh lease, typed input, no guessed targets/replayed mutations.
- **Why:** every UI action must be scriptable and replaceable; existing agent D19/D21/D23/D26 are binding. Raw CDP and unscoped automation would break ownership.
- **Evidence:** docs/roadmap.md:19-53; sa-browser-agent D19,D21,D23,D26,D37–D43; packages/protocol/src/plugins.ts and ui.ts; shared pane-contract.ts.
- **Reversibility:** medium (public API while unstable)
- **Confidence:** high
- **Revisit if:** acceptance proves state or page identity races
- **Source:** locked by docs/roadmap.md

## D5: Preserve unsupported native page-event flows as explicit SDK follow-ups
- **Question:** How can native prompt/auth/certificate/download/OAuth parity be built on the pinned public SDK?
- **Options:** private pointer/FFI patch; Chrome-only replacement; async JS dialog fake; explicitly defer unsupported flows and ship independently reachable pane behavior
- **Chose:** no private FFI, global TLS bypass or fake dialogs; implement reachable CDP Watch events; queue exact native gaps with their SDK prerequisites before land when confirmed. Artifact publication remains dropped-integration non-goal. OAuth opener/postbody must not be approximated by URL-only creation.
- **Why:** installed SDK exposes native BrowserView navigation/find/zoom and download notifications, not JS dialog/auth/cert response or download-cancel/destination APIs. LOOP.md permits a flow deferral for outside limits when the core ships without it.
- **Evidence:** apps/desktop/.hutch/devkit/api/sdks/main/core/BrowserView.ts:44-218,309-374; preload/webviewTag.ts:12-26,361-402; BrowserPaneMap native survey; external browser.md:67-70.
- **Reversibility:** medium (requires SDK growth)
- **Confidence:** high for inspected public API, not proof of private native absence
- **Revisit if:** supported SDK hooks supply faithful synchronous response/popup/download ownership
- **Source:** deferred: native page-event interception

## D6: Use three disjoint implementation components and Gemini review
- **Question:** Execution preflight and decomposition — which backend pair/partition is reachable?
- **Options:** omp+Opus; omp+Gemini; same-family reviewer; one broad implementer
- **Chose:** omp OpenAI task implementers plus Google Gemini reviewer through pi-watch, with at most3 concurrent isolated components: Native public host capability, Runtime pane/CDP/API, UI contributions/CLI. Shared type files and spec committed first. Parent owns integration and scopes; no worker commits or checks while peers run.
- **Why:** actual pi-watch preflight reports Opus/Sonnet unavailable, Gemini reachable; disjoint component scopes buy real width without simultaneous edits. No successor wave planned, so no checkpoint review.
- **Evidence:** 2026-10-28 preflight pi-watch --check; logic Technical contracts and implementation partition; xd://lsp status: no language servers configured.
- **Reversibility:** easy (next run)
- **Confidence:** high
- **Revisit if:** worker exposes a real shared-file dependency; stop and replan scope rather than widen silently
- **Source:** assumed — autonomous

## D7: Verify macOS-native only by pending nightly scenarios and isolate all process tests
- **Question:** Platform/acceptance gray areas — how to verify native surfaces without foreground access or real home writes?
- **Options:** claim web proves native; foreground native dogfood; honest web Watch dogfood plus native nightly handoff
- **Chose:** web --owner yours --unattended only; pending native view/focus/OS scenarios; temp HOME/QUIRKY_HOME, disabled automatic hooks, mock-keychain owned Chrome and awaited cleanup. Linux/Windows host, downloads and external-launch verification remain deferred.
- **Why:** LOOP.md prohibits native foreground testing in this lane and requires native scenario handoff. Tests must never touch real agent/browser state.
- **Evidence:** docs/loop/LOOP.md Verify; docs/loop/NATIVE.md:60-80; sa-browser-agent D30,D32; m2-editor D22 incident.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** native nightly identifies actual runtime failures
- **Source:** deferred: platform

## D8: Bound Watch transport with renderer acknowledgment and daemon-owned tab lifecycle
- **Question:** Can generic broadcast events bound slow-reader memory, and do CLI pane operations open/close the real hosted tab?
- **Options:** unbounded event pushes/UI-only tab creation; generic stream rewrite; one outstanding frame with explicit ACK and daemon-owned hosted tabs
- **Chose:** paneFrameAck validates pane/watchId/sequence; retain only outstanding plus latest frame, expire stalled leases. paneOpen owns public openViewTab. `paneClose({pane,tabId?:string,fromTab?:boolean})` returns boolean `true` for every caller; the manifest result is boolean. `fromTab:true` is terminal-plugin-only and requires the matching hosted `tabId`; terminal `closeMethod` injects that tabId and requires exact `true`. Ordinary paneClose closes the actual hosted tab. No result union, compatibility shim, or terminal-contract weakening.
- **Why:** public events do not persist but transport can buffer; renderer ACK supplies real backpressure. UI-only hosted creation would break API/CLI equivalence, and preclose callback queue reentry deadlocks.
- **Evidence:** packages/daemon/src/plugins/events.ts:28-40; packages/daemon/src/service.ts:74-82; plugins/quirky.terminal/src/layout/service.ts:452-510; amended shared pane contract and logic spec. Parent-reported actual CLI smoke established the exact-true/injected-tabId closeMethod contract and failed manifest validation on 33 missing required CLI flag descriptions; metadata repair was reported in progress, not passed.
- **Reversibility:** medium (public lease and lifecycle contracts)
- **Confidence:** high
- **Revisit if:** backpressure or close-race acceptance exposes stale/duplicate state
- **Source:** pane lifecycle: assumed — autonomous; corrected close contract: parent-reported actual CLI smoke

## D9: Use supported native tag geometry with a narrow trusted zoom bridge
- **Question:** The native BrowserView lacks public bounds/navigation controls, while its custom tag omits the optional views-loader creation flag; does the core require private FFI or an engine change?
- **Options:** private FFI resize; Chrome replacement; unavailable-only scaffold; supported sandboxed tag plus public tag-owned BrowserView zoom
- **Chose:** supported tag for geometry/navigation/lifetime, synchronous allow-only safe-protocol rules, default appData=false, sandbox=true, and trusted host bridge restricted to tag-owned view zoom. Guest state/find reports remain untrusted display data. Remove self-selected views=false construction constraint; deny internal views/appdata navigation instead.
- **Why:** the SDK's public custom element is its maintained geometry/navigation API; its packaged public-asset loader flag conveys no daemon token or privileged RPC. Native browser architecture remains unchanged. No private pointer/FFI calls or fake successful unavailable mount.
- **Evidence:** installed SDK BrowserView.ts, preload/webviewTag.ts, public browser/webviewtag.ts; BrowserNativeHost feasibility packet; amended logic Public native capability contract.
- **Reversibility:** medium (public host adapter)
- **Confidence:** medium until native nightly surface verification; unsafe navigation-rule behavior would block this adapter
- **Revisit if:** actual SDK rules fail to deny internal protocols or guest content can access the trusted bridge
- **Source:** assumed — autonomous

## D10: Keep build and fixture conventions without a second entry point
- **Question:** Which exact entry/harness paths are required for a runnable component?
- **Options:** change generic build discovery; root ui.tsx shim; conventional src/ui.tsx and fixture dependency expansion
- **Chose:** UI owns src/ui.tsx, excluded explicitly from Runtime scope; Runtime owns existing browser harness.ts and automation.test.ts only where terminal dependency/acceptance requires it. No root UI alias or build-loop changes.
- **Why:** packages/ui/build.ts discovers src/ui.tsx; real hosted panes require terminal plugin in the isolated API harness.
- **Evidence:** BrowserPaneUi entry discovery and BrowserPaneRuntime harness packet; packages/ui/build.ts; plugins/quirky.browser/test/harness.ts:71-94.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** the barrier detects a genuine additional public API dependency
- **Source:** assumed — autonomous

## D11: Integrate lane8's explicit profile-isolation contract without overlapping feature ownership
- **Question:** The early dependent sa-browser-profiles-settings needs pane identity/profile switching and native clearing; which contract and paths are shared?
- **Options:** ignore profile selection; duplicate preference implementations; coordinated pane/profile seam with lane8-owned API/menu
- **Chose:** PaneTab.profileId/partition and paneOpen.profile; exact stable persist:quirky-browser-${profileId}, IDs default or profile_[0-9a-f]{32}, assigned before native creation. Public nativeBrowser.clearPartition uses supported Session.clearStorageData(all), unavailable web rejects. BrowserService.setPaneProfile validates existence, preserves pane/tab/URL and retires old Watch generation; UI remounts native on profile change. Lane8 owns src/preferences/**, src/preferences-window/**, profileSet registration and clear/delete guarded command. Menu props {context,pane,onError} after Browser menu/before History; no missing-component import here.
- **Why:** the user specifically requires real profile isolation and coordinated independent slices, not silent fallback or competing registrations. Actual native clear/isolation is pending nightly; tests never call the real native Session.
- **Evidence:** user interjections 2026-10-28 lane8 contracts; BrowserPaneRuntime seam acknowledgment; BrowserPaneUi insertion packet; BrowserStore.validProfileId existing grammar.
- **Reversibility:** medium (profile/native data boundary)
- **Confidence:** high for agreed contract, native behavior pending nightly
- **Revisit if:** supported SDK partition semantics or profile deletion prerequisites differ from the agreed public behavior
- **Source:** user ruling 2026-10-28 (lane8 coordination)

## D12: Queue the unsupported Native event flows before landing
- **Question:** How is D5's partial-flow deferral made durable without blocking the core pane?
- **Options:** hide unsupported controls; block all browser work; record exact limits and dependent follow-up
- **Chose:** queue.ts add created sa-browser-pane-native-events (todo, deps[sa-browser-pane]); BLOCKERS.md names native script/auth/cert response, controlled downloads, OAuth opener/postbody and external launch interception prerequisites. Watch equivalents remain this item's acceptance.
- **Why:** public SDK capability is an external limit for these Native flows, while native pane basics and exact-page Watch remain independently useful. No unavailable operation is reported passing.
- **Evidence:** exact queue.ts add exited0; authoritative build/roadmap queue JSON confirmed the new item; docs/loop/BLOCKERS.md sa-browser-pane entry; D5 SDK evidence.
- **Reversibility:** easy (follow-up can consume a supported SDK upgrade)
- **Confidence:** high for queue persistence and inspected public API limits
- **Revisit if:** a supported hook makes one of these flows reachable before the follow-up is claimed
- **Source:** deferred: native page-event interception

## D13: Install native navigation policy after a blank-first owned claim
- **Question:** Does the pinned tag constructor actually install its initial navigation rules, and can host overlays cover native content with CSS?
- **Options:** trust constructor/options and z-index; private FFI; supported blank-first claim/policy setter plus semantic masks
- **Chose:** create only sandboxed partitioned about:blank, verify tag ownership, call public BrowserView.setNavigationRules(['^*','https://*','http://*','file://*','about:blank']) before remote/file navigation, then allow requests. Supported native rules are wildcard, ^block, last-match-wins and unmatched-allow. Native host masks semantic dialog/menu/listbox overlays; z-index is insufficient. This supersedes D9's zoom-only host operation restriction.
- **Why:** local SDK constructor/native create request omits navigationRules, while public setter forwards them; initial untrusted src would load before policy. SDK docs explicitly describe native layers above host DOM and mask support.
- **Evidence:** installed SDK BrowserView.ts init and native.ts createWebview/webviewTagInit; https://framework.blackboard.sh/electrobun/apis/browser/electrobun-webview-tag/ (parent read); pending native DF-native-policy scenario.
- **Reversibility:** medium (host initialization)
- **Confidence:** high for documented grammar/local omission, actual native parser behavior pending nightly
- **Revisit if:** SDK fixes constructor forwarding or native runtime rejects a documented safe/deny rule
- **Source:** assumed — autonomous

## D14: Stop and recover the native worker's cross-worktree edit violation
- **Question:** Native worker used relative edit headers, which resolved to the parent checkout; can those edits be accepted?
- **Options:** keep them as implementation; reset the parent wholesale; stop worker and reverse only its exact accidental hunks
- **Chose:** stop Native edits, enumerate exact changed paths/calls, reverse only native-browser.ts additions, index.ts export and malformed ui.ts context hunk. Tool snapshots restored the original hashes9605/3E87/8E49. Parent PaneTab/spec/decision changes remained untouched. Worker retained only its absolute assigned-tree index export/test files and resumed under explicit absolute-header replan.
- **Why:** component scopes are correctness boundaries. No accidental parent source is accepted; no tests/commits ran against the contaminated tree. Runtime and UI were reminded, UI confirmed all its headers absolute.
- **Evidence:** worker exact3successful relative call report; actual scoped parent diff and changed-path enumeration; corrective edit tool snapshot hashes; /tmp/sa-browser-pane.fiGLjz/journal.json and later barrier audit.
- **Reversibility:** easy (recovered before component acceptance)
- **Confidence:** high for exact reversed paths; final barrier still required
- **Revisit if:** the barrier detects another parent/sibling mutation
- **Source:** assumed — autonomous

## D15: Reject native clear before invocation when deletion completion is unproven
- **Question:** Does awaiting the SDK's void clearStorageData prove deletion completed, and does QUIRKY_HOME isolate native website storage?
- **Options:** report cleared after invocation; probe real shared Default; infer HOME relocates WK storage; reject completion-unavailable and test new UUID partitions only
- **Chose:** clearPartition rejects before Session invocation unless a supported completion contract is proven. Lane8's one-use guarded command preserves Chrome/metadata on rejection and owns the native-profile-clear-completion follow-up. Native tests/nightly use fresh UUID profiles; never shared Default without a proven isolated native root. Existing partition format remains unchanged.
- **Why:** public SessionInstance.clearStorageData returns void and directly calls a native symbol; the installed SDK has no native completion/websiteDataStore implementation or public root override evidence. Await-void is not completion proof. User explicitly prohibited deleting native data or claiming completion on invocation alone.
- **Evidence:** installed SDK api/sdks/main/proc/native.ts:3347-3393; Native worker source packet (projected Go/Rust/Zig likewise invocation-only); user lane8 interjections; amended native scenarios.
- **Reversibility:** easy when supported SDK completion/root controls exist
- **Confidence:** high for the unavailable boundary; no claim about private native implementation timing
- **Revisit if:** supported native clearing completion is evidenced and verified on a run-owned partition
- **Source:** user ruling 2026-10-28 (lane8 native storage safety)

## D16: Expose unavailable clearing before consuming a destructive claim
- **Question:** How can lane8 distinguish a proven pre-invocation unavailable capability from an uncertain clear that may have started?
- **Options:** consume claim then catch all errors; infer from error text; explicit clearPartitionAvailable capability
- **Chose:** required public clearPartitionAvailable=false for current native and web adapters; lane8 checks first. clearPartition still validates/rejects before any host/Session action. Remove dormant native clear RPC route/Session import so no hidden clearing path remains.
- **Why:** the user requested this exact guard to preserve confirmed request/metadata state after a known unsupported operation. Injected test models may report true, but production cannot without supported completion evidence.
- **Evidence:** user lane8 availability interjection; Native worker acknowledgment; D15 public void API evidence.
- **Reversibility:** easy (a future supported completion capability can report true)
- **Confidence:** high
- **Revisit if:** SDK completion is implemented and verified on a run-owned native partition
- **Source:** user ruling 2026-10-28 (lane8 clear availability)

## D17: Record the remaining evidenced Native host and workspace-preview limits
- **Question:** Can normal reload stand in for hard reload, observational load events report failures, or passive daemon resources render grant-scoped active workspace HTML?
- **Options:** report approximate success; relax daemon HTML MIME; supported implementation where available and exact flow follow-ups for outside limits
- **Chose:** before the operator freeze, queue.ts add created and authoritative JSON confirmed sa-browser-pane-native-host-controls (cache-bypass reload and load-failed signal) and sa-browser-pane-workspace-preview (isolated grant conversion and Back). Explicit local HTML file navigation remains implemented, including outside-worktree browsing; sourcePath is exposed only for canonical in-worktree files. Do not claim direct file browsing/editor new-tab as grant preview or normal reload as hard reload.
- **Why:** public Native tag has no ignoreCache/reloadFromOrigin or load-failed event. Public file resources intentionally reject active HTML and sandbox responses; source workspace preview additionally needs isolated nonpersistent grant/assets and native outbound-network/permission/download policy. These are not safely supplied by weakening the passive capability.
- **Evidence:** Native worker SDK event/control packet; SDK browser/webviewtag.ts and preload/webviewTag.ts; public file-resource allowlist/CSP; external Orca doc-preview-protocol.ts:33-65,75-151; authoritative queued records todo/deps[sa-browser-pane].
- **Reversibility:** medium (requires supported Native/preview capabilities)
- **Confidence:** high for the inspected public boundaries; no private implementation timing/capability claim
- **Revisit if:** supported APIs make these exact flows reachable without weakening source security
- **Source:** deferred: native host controls and workspace grant preview

## D18: Stop creating queue follow-ups under the operator sprint ruling
- **Question:** The operator says browser follow-up count threatens the 4am sprint; how are further unavoidable gaps recorded?
- **Options:** keep adding dependent items under the older LOOP rule; hide gaps; freeze queue additions and finish reachable flows here
- **Chose:** no further queue.ts add for this item. Finish reachable in-scope flows in this item; any additional unavoidable limit only in this decision log and appended BLOCKERS.md. Existing queued records remain unchanged. All3implementers informed immediately.
- **Why:** the user's latest operator note explicitly supersedes the older requirement to add another item for every deferred flow.
- **Evidence:** user operator interjection at the 2026-10-28T01:25Z checkpoint; three worker steering messages.
- **Reversibility:** easy (operator may later requeue recorded gaps)
- **Confidence:** high
- **Revisit if:** the operator explicitly changes the follow-up freeze
- **Source:** user ruling 2026-10-28 (operator sprint)

## D19: Publish the real source checkpoint without claiming acceptance
- **Question:** Lane8 cannot integrate its early dependent service/UI while this branch contains only contracts; can it use the assembled source before the final gate?
- **Options:** keep source private until green; publish placeholders; checkpoint the real audited candidate with named known failures
- **Chose:** publish the complete assembled source plus already verified Native safety fixes and new-tab menu integration, explicitly UNVERIFIED. Keep the active runtime acceptance worker isolated and merge its repair delta afterwards. Lane8 merges repairs again before its final checks.
- **Why:** the user explicitly requested a real dependency-branch checkpoint even with known acceptance failures; no source scaffold or fake implementation is substituted.
- **Evidence:** lane8 checkpoint user interjection; initial barrier-audit.json/assembly.json; current root compiler diagnostics artifact82; real Native unit/DOM/preload proof.
- **Reversibility:** easy (subsequent repair commits)
- **Confidence:** high for scope/intent, no green product claim
- **Revisit if:** any worker or foreign source mutates the checkpoint tree during staging
- **Source:** user ruling 2026-10-28 (early dependency source checkpoint)

## D20: Preserve framework-owned DOM during Native find
- **Question:** Does injected mark-based find leave a reactive page working?
- **Options:** replace text nodes with marks; claim the SDK count limitation; use selection ranges without DOM replacement
- **Chose:** real DOM Range selection and match counting; no replacement/normalization of framework text nodes. Serialize the self-contained guest program lazily. Remove constant-copy/fake-find echo tests; keep real DOM regressions.
- **Why:** a production-adapter guest-program smoke reproduced a React mixed-text update remaining original-value suffix after find; Range-based search then showed updated-value suffix. Both real DOM find/update and next/previous/wrap/clear regressions passed.
- **Evidence:** /tmp/sa-browser-pane.fiGLjz/find-dom-smoke.ts actual red/green output; packages/ui/test/native-browser-dom.test.ts2pass/11assertions; Native capability7pass.
- **Reversibility:** medium (guest find implementation)
- **Confidence:** high for DOM logic, actual WebKit/native surface remains pending nightly
- **Revisit if:** Native nightly finds selection/scroll behavior differs from the DOM model
- **Source:** assumed — autonomous

## D21: Grow the public new-tab menu instead of substituting a pane menu
- **Question:** Browser's New Browser Tab contribution is rejected because the public menu API only knew the pane target; where must the command appear?
- **Options:** put it in the unrelated pane menu; hardcode Browser in Terminal; add the public tab-create target and render generic effective contributions
- **Chose:** TERMINAL_TAB_MENU/quirky.terminal/tab through protocol types, kernel schema, daemon validation and actual plus-menu renderer. Commands receive actual worktree/workspace/group; registry changes update an open menu, disabled/overridden items stay effective-only.
- **Why:** source discoverability requires the actual new-tab menu, and built-ins/third parties must share the same public API.
- **Evidence:** contract commit e084312b; menu-repair-audit.json six paths/in-scope; worker owned workspace-plus14pass and menu-kind8pass, parent final broad gate still pending.
- **Reversibility:** medium (public unstable API)
- **Confidence:** high for the exercised registry/controller path; built UI smoke still required
- **Revisit if:** actual plus-menu UI or wrong-group tests expose a targeting error
- **Source:** locked by docs/roadmap.md

## D22: Follow overdue night mode without inventing a review pass
- **Question:** The 00:35Z claim passed its two-hour bound at the observed 02:36:28Z clock; should an unstarted final review or full dogfood campaign begin now?
- **Options:** start another review campaign; call it passing; obey the deadline rule and retain required real-path verification
- **Chose:** skip the unstarted final review/full dogfood campaign under current LOOP.md night mode, explicitly record that neither passed. Continue fixing actual acceptance/type failures, exercise the real changed UI surface, run the required affected/scripts/type gates and land. Native-only scenarios remain pending nightly.
- **Why:** the user night rule says an overdue item lands as soon as its own tests and typecheck pass and skips unstarted review/dogfood. A skipped review is not evidence of correctness.
- **Evidence:** current LOOP.md read via build/roadmap; actual date command02:36:28Z; no final reviewer or UI campaign was started.
- **Reversibility:** easy (later review/native run can report actual findings)
- **Confidence:** high
- **Revisit if:** actual verification exposes another blocking defect; fix it rather than hiding it behind the deadline
- **Source:** locked by docs/loop/LOOP.md

## D23: Narrow the overdue landing to API/CLI pane lifecycle and navigation
- **Question:** Which acceptance remains current, and how are the other flows handed off without creating more queue items?
- **Options:** retain the original full UI/native matrix; drop the unfinished flows; ship API/CLI pane lifecycle and navigation with precise ownership in existing follow-ups.
- **Chose:** Current acceptance is pane lifecycle and navigation through the schema-declared API and generated CLI, using the committed build/sa-browser-pane and preserved repair trees. Preserve implementation and tests; no new queue records or title edits. sa-browser-pane-native-host-controls owns Watch screencast/input/find/zoom/viewport acceptance, remaining base-pane UI/hard-reload/load-error scenarios, AND cross-lane pane/profile integration acceptance against lane8's profile feature. sa-browser-pane-native-events owns dialogs/auth/cert/download/popups/OAuth/external events. sa-browser-pane-workspace-preview owns grant document preview/UI. Lane8's sa-browser-profiles-settings retains its own profile/settings implementation; the deferred pane/profile composition is assigned to this item's already-added native-host-controls follow-up, not made a new gate for lane8. Existing profile-import-ui, native-profile-clear-completion, native-identity and localhost-label-routing subflow handoffs remain exact. m7-sweep-browser-mobile is the final parity audit, not a substitute. Review skipped; Native nightly pending; no broad UI acceptance claim.
- **Why:** the latest operator ruling narrows this overdue landing while preserving every remaining flow with its existing owner; full UI/native parity is not silently implied.
- **Evidence:** latest operator instruction; existing follow-up records in docs/loop/queue.json and pane blocker entries; preserved candidate paths named by the operator.
- **Reversibility:** medium (residual acceptance remains with existing follow-ups)
- **Confidence:** high for the approved scope and ownership; no acceptance result is inferred
- **Revisit if:** the operator explicitly broadens this item's current acceptance
- **Source:** latest operator ruling for sa-browser-pane


## D24: Repair the actual API/CLI lifecycle boundary without relaxing contracts
- **Question:** Why did a source CLI smoke report unknown browser pane, and why would terminal-origin close refuse the Browser result?
- **Options:** force activation in the smoke; weaken manifest or terminal validation; repair Browser declarations and its close result.
- **Chose:** supply all 33 missing required CLI flag descriptions. Make paneClose return boolean true for every caller, declare the boolean schema, accept the terminal-injected tabId, and validate terminal caller plus matching hosted tab for fromTab. Keep terminal's exact-true close contract. Restore host:port normalization before explicit-scheme parsing and import fileURLToPath from node:url.
- **Why:** plugin.list showed Browser invalid because of missing flag descriptions, so no API or CLI declarations existed. Terminal's ensureViewsClosable expects true and injects tabId; the old object result/schema could not satisfy it. The fresh CLI smoke now executes open/state/navigate/report/reject/close/idempotence successfully, with zero Chrome starts.
- **Evidence:** isolated smoke failure and plugin.list diagnostics (artifact21); production-source smoke PANE_LIFECYCLE_CLI_SMOKE_OK; plugins/quirky.terminal/src/layout/service.ts:317–322; new pane-lifecycle.test.ts.
- **Reversibility:** medium (public unstable result contract; all current consumers migrated).
- **Confidence:** high for daemon/CLI lifecycle; Native rendering not exercised.
- **Revisit if:** controller verification exposes stale close ownership, deadlock or wrong-worktree state.
- **Source:** assumed — autonomous within operator-authorized lifecycle scope.

## D25: Preserve the unfinished repair snapshot rather than silently overwrite dependency seams
- **Question:** Are wavecheck's uncommitted runtime acceptance repairs already part of the item branch?
- **Options:** assume earlier merges included dirty work; merge the whole advanced candidate; preserve it intact and take only fixes required by current gates.
- **Chose:** commit the full twelve-file dirty repair snapshot as 22d17dfd on build/sa-browser-pane-wavecheck. Keep main's profile seams for lane8, preserve all tests, and implement only concrete lifecycle/compiler/isolation repairs on the item branch. Downloads use an internal constructor destination override in tests; production retains OS Downloads.
- **Why:** wavecheck HEAD was merged but its staged/unstaged runtime repairs were not. Blind copying would remove lane8's module seams and expand acceptance beyond the operator cut. The full source and strengthened advanced tests remain recoverable by the mapped follow-ups.
- **Evidence:** twelve-file scope inventory; checkpoint22d17dfd; current BrowserDependencies.downloadDirectory and isolated harness destination.
- **Reversibility:** easy (recover checkpoint from Git).
- **Confidence:** high for preservation, not an advanced-flow passing claim.
- **Revisit if:** a deferred owner needs the intact prompt-TTL/profile/screencast/page-event acceptance work.
- **Source:** latest operator ruling for sa-browser-pane.

## D26: Challenge only newly created CDP targets, never probe unrelated old pages
- **Question:** Why do real automation and Watch tests hang before a fresh page operation begins?
- **Options:** raise deadlines or waive tests; guess by URL/order; restrict candidates to targets created by tab_new and retain the exact challenge.
- **Chose:** snapshot target IDs before tab_new; exclude those IDs from candidate debugger attachments. Still require exactly one matching random scriptParsed challenge and preserve the exact helper tab/session/target mapping. No navigation replay, guessed target, lowered assertion or timeout change. Removed temporary boundary logs after the experiment.
- **Why:** a bounded real Chrome reproduction stalled while enabling Debugger on an old target, before onOperation. After candidate restriction, the same real sequence created about:blank, First and Events pages in5.54seconds. Old pages' debugger readiness is unrelated to identity of a fresh tab.
- **Evidence:** temporary identity traces at pre/post native tab_new, Target.getTargets/attachToTarget, Debugger.enable/disable, challenge evaluate and detach; CHROME_IDENTITY_DIAGNOSTIC_OK output for three sequential same-profile pages.
- **Reversibility:** medium (trusted page-binding algorithm).
- **Confidence:** high for the reproduced stall and corrected sequence; broader regression results are recorded separately.
- **Revisit if:** candidate creation races or a missing/ambiguous challenge appears; fail closed, never use URL/order matching.
- **Source:** assumed — autonomous blocking verification repair.

## D27: Preserve assertions while correcting test prerequisites and interception lifetime
- **Question:** Which remaining failures came from fixtures versus real retained Watch behavior?
- **Options:** weaken assertions/deadlines; retain broken fixtures; repair exact prerequisites and runtime request ownership.
- **Chose:** canonicalize the macOS /var fixture root before exact path comparisons. Trigger a real page repaint before expecting the next damage-driven screencast frame. Retain all existing frame, targeting, prompt, auth, TLS and download assertions. Resume Fetch.requestPaused on its exact session outside the profile FIFO, install handlers before enabling interception, and disable interception/certificate overrides when Watch stops.
- **Why:** /var is a symlink to /private/var, static CDP pages need not emit repeated frames, and auth interception also pauses ordinary requests. Leaving those requests paused or keeping interception enabled after unwatch strands navigation. The API/CLI lifecycle regression independently checks actual hosted tab removal, same-worktree fallback, cross-worktree retention, stale report rejection and terminal-origin close without queue deadlock.
- **Evidence:** first macOS pane failure path output and90second stalls; preserved repair checkpoint22d17dfd; new lifecycle regression remote pass; initial affected run339/340remote files passed, with only old invalid Browser manifest failing remotely.
- **Reversibility:** easy (fixtures) / medium (interception lifecycle).
- **Confidence:** high for the observed prerequisites and exact-session repair; no full UI or native parity claim.
- **Revisit if:** repaired Chrome regression files or controller full suite expose another concrete failure.
- **Source:** assumed — autonomous, preserving operator's no-weakened-tests rule.

## D28: Resume the exact owned headless target before helper selection
- **Question:** Why does switching back to an existing managed page still fail after fresh binding is repaired?
- **Options:** retry the mutation; guess another helper tab; bring the already-bound headless target forward before one helper switch.
- **Chose:** Page.bringToFront on the exact existing binding session before tab_switch. Keep unsupported native app-window focus rejected; this operates only inside the owned headless Chrome. Preserve a redacted helper error detail rather than discard the actual failing CDP command.
- **Why:** the bounded reproduction returned “CDP command timed out: Page.enable” from the helper while selecting a background tab. The exact-target resume then created three pages and switched through all three successfully in6.45seconds, with no retry or retarget.
- **Evidence:** actual three-page create/switch diagnostic, BEFORE_SWITCH/AFTER_SWITCH pairs and CHROME_IDENTITY_DIAGNOSTIC_OK; runtime/driver.ts exact session call.
- **Reversibility:** medium (headless helper selection).
- **Confidence:** high for the reproduced command boundary and corrected sequence; no OS focus claim.
- **Revisit if:** headless switching still stalls or any unrelated target is selected.
- **Source:** assumed — autonomous blocking verification repair.

## D29: Correct exact event/path consumers, not their behavioral assertions
- **Question:** Why did the retained Watch regressions still fail after real Chrome could create and select pages?
- **Options:** skip deferred tests; accept arbitrary events/files; use the actual protocol type and canonical owned path.
- **Chose:** the frame fixture consumes quirky.browser/paneFrame, matching PluginEvents.emit and production UI, not the contribution ID event:quirky.browser/paneFrame. Canonicalize a regular non-symlink download source before its exact staging-root containment check. Keep byte-content/collision, frame/backpressure and same-page targeting assertions. Delete only the obsolete copied catalog-array equality checks, as required for wiring/copy tests; real API/CLI execution and unsupported-command rejection remain.
- **Why:** contribution IDs are not event-stream types; /var and /private/var denote the same owned staging directory. The old catalog copy forbade every newly added pane method without testing consumer behavior.
- **Evidence:** packages/daemon/src/plugins/events.ts:28–41; production BrowserPaneWindow subscriptions; failing frame wait and download-completion wait; original actual catalog diff showing13 added pane methods.
- **Reversibility:** easy (fixtures) / medium (canonical file boundary).
- **Confidence:** high for inspected contracts; final regression verdict recorded separately.
- **Revisit if:** a malformed/unowned event or symlink download artifact is accepted.
- **Source:** assumed — autonomous, preserving consumer-visible assertions.

## D30: Count text occurrences and test filename safety independently of Chrome's rewriting
- **Question:** Why did retained Watch find report1 for three occurrences, and why did the collision fixture miss its existing file?
- **Options:** lower expected counts or re-pin Chrome's rewritten name; repair occurrence counting and exercise collision/safety as separate real downloads.
- **Chose:** count non-overlapping case-insensitive rendered text occurrences while retaining real window.find selection. DOM.performSearch counted matching DOM nodes, not occurrences. Use a literal safe.txt attachment for the unchanged safe (1).txt collision/content assertion; independently download the malicious ../../unsafe.txt header and assert its actual canonical parent is the owned Downloads directory, bytes match, and the pre-existing safe.txt is unchanged. Supply explicit yes for the destructive page-close test.
- **Why:** one text node contains all three matches. Chrome rewrites malicious header names before suggesting a filename; the resulting spelling is not a Quirky collision contract. Both collision and malicious-path safety remain exercised without lowering assertions, raising deadlines or skipping tests.
- **Evidence:** red find total1 and Chrome-suggested _.._safe.txt; corrected real macOS pane file passes3 tests/70 assertions in24seconds. Existing automation file passes exit0 in40.41seconds after exact-target resume; source lifecycle CLI smoke and three-page create/switch smoke also pass.
- **Reversibility:** medium (find counting) / easy (fixture composition).
- **Confidence:** high for exercised count, selection/next and collision/path invariants; no full UI/native claim.
- **Revisit if:** a deferred find/UI scenario exposes rendered-text boundary differences.
- **Source:** assumed — autonomous, preserving operator's no-weakened-tests rule.

## D31: Preserve the terminal creation menu's typed management footer
- **Question:** Why did the controller's SC-22 fail after adding Browser to the public new-tab menu?
- **Options:** re-pin or remove the footer assertion; hardcode Browser ordering; insert generic contributions before the typed manage entry.
- **Chose:** insert contributed rows immediately before MenuEntry.kind=manage, or append if the filtered menu has no management entry. Retain the existing SC-22 footer assertion and generic command/worktree/group dispatch.
- **Why:** the public contribution had been appended after Agent settings, violating the existing terminal menu footer. The fix uses entry kind, not displayed label or Browser-specific knowledge.
- **Evidence:** first controller land: all5Mac-only files passed, including Browser automation and pane; remote630files624passed6failed. workspace-tabs.test.ts SC-22 expected the management footer last and observed New Browser Tab.
- **Reversibility:** easy (menu composition).
- **Confidence:** high for the source cause; fresh affected proof follows.
- **Revisit if:** filtered or overridden contributed rows appear twice or target the wrong group.
- **Source:** assumed — autonomous blocking landing repair.

## D32: Hold the real post-body submit boundary deterministically in the cancellation fixture
- **Question:** How can the real-PTY cancellation test avoid losing its500ms window while the test process is descheduled?
- **Options:** raise the production delay or deadlines; weaken cancellation results; inject a private fixture hook after the unchanged real delay.
- **Chose:** optional internal beforeSubmit hook in the send engine/service activation. Normal activation supplies none and retains the real500ms cancellable delay. The test-only built-in overlay signals a run-owned file after the actual body write/delay, then awaits AbortSignal cancellation before Enter. The test watches that signal without polling and preserves accepted/cancelled outcomes, absent queued-body bytes and absent delayed Enter.
- **Why:** an external process cannot fake the daemon's clock, and two cancellation round trips can outlive a fixed delay under suite load. Holding the exact protocol boundary tests the cancellation invariant instead of scheduler speed.
- **Evidence:** first controller SC-21 reported no queued/active send after the first-body signal; src/send.ts unchanged cancellableDelay(500) plus optional hook; isolated fixture main and fs.watch signal.
- **Reversibility:** easy (internal injected dependency only).
- **Confidence:** high for the synchronization design; fresh runtime proof follows.
- **Revisit if:** ordinary activation changes delay/behavior, a hook leaks to production RPC, or fixture cleanup leaves a pending process/watcher.
- **Source:** assumed — autonomous blocking landing repair.

## D33: Reject global harness monkeypatches and incidental prose pins
- **Question:** Can a fixture safely patch E2eHarness.prototype.daemonEnv through shared pending globals, or require provisional notice prose to predict later transcript confirmation?
- **Options:** retain hidden global coupling; widen production environment switches; explicit per-harness built-in directory factory and actual effect assertions.
- **Chose:** remove the proposed prototype patch/WeakMap/pending flag. Add optional E2eOptions.builtinPluginsDir(home) to the existing isolated harness and resolve it once per instance. Remove only the old negative notice regex; retain actual transcript effort, visible screen, session-only interaction, settings-file sentinel and draft assertions.
- **Why:** concurrent harnesses must not inherit another test's gated plugin. A provisional “not confirmed” notice is not proof the later independently verified effect failed. Neither change relaxes production send safety or suppresses an error.
- **Evidence:** scoped six-file Dock writer diff; parent replaced private prototype access with the explicit test-harness field. Initial fixture check also caught and corrected a missing template-array comma, not a product timeout.
- **Reversibility:** easy (test fixture construction).
- **Confidence:** high for isolation and assertion intent; source/type/runtime gates follow.
- **Revisit if:** simultaneous ordinary/gated harnesses share plugin roots or an effect regression no longer fails the retained assertions.
- **Source:** assumed — autonomous, preserving test isolation and consumer-visible invariants.

## D34: Wait for agent readiness, not the former two-row menu size
- **Question:** Why did the corrected footer expose a second SC-22 failure with no Claude row?
- **Options:** remove the agent assertion; inflate a timeout; wait for the actual detected agent required by the scenario.
- **Chose:** SC-22 waits for a Claude menu row, not items.length>2. All existing first-row/key/footer/agent and dispatch assertions remain unchanged. Public contributions can legitimately make the initial Terminal/Settings fallback contain three rows before asynchronous agent discovery finishes.
- **Why:** the count predicate became true early after adding Browser; it did not represent loaded agents. Fresh SC-22 passes through the real renderer/daemon in the remote fixture.
- **Evidence:** first scoped run showed correct footer but zero Claude rows; corrected SC-22 remote file passes18.97seconds. Deterministic Dock send/defect files both pass in80.95seconds, flaky[]; typecheck after per-instance fixture plumbing passes44.90seconds.
- **Reversibility:** easy (test readiness predicate).
- **Confidence:** high for exercised readiness and cancellation boundaries.
- **Revisit if:** agent discovery itself never returns the fixture's configured Claude; retain the existing finite bound and fail.
- **Source:** assumed — autonomous, preserving all consumer assertions.

## Progress
Ready to retry canonical land. First merged gate had all5Mac files green and6remote failures; no merged success or on-time claim. Deterministic repairs now pass: Dock send/defect2files, menu SC-22, generic menu unit file; current-source typecheck after fixture plumbing passes. Existing full workspace-tabs run had15passing cases and a premature agent-readiness predicate, now corrected and its exact case verified; no false single-run whole-file pass. Git SC-29 scout found insufficient evidence for a source change, so no speculative timeout/CSS fix. Daemon lock/loops-store five-second failures remain unchanged for the normal configured full-gate retry. All303incoming m5-loops-core decisions read: no Browser conflict; structured background registration stays non-adopting, explicit paneOpen remains valid. No agents or smoke processes running. Commit these exact repairs/docs, detach and retry queue.ts land; wait for its full merged verdict before ending this one item.
