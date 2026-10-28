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
- **Chose:** paneFrameAck validates pane/watchId/sequence; retain only outstanding plus latest frame, expire stalled leases. paneOpen owns public openViewTab; paneClose uses fromTab preclose flag to avoid reentrant terminal queue while ordinary API closes the actual tab.
- **Why:** public events do not persist but transport can buffer; renderer ACK supplies real backpressure. UI-only hosted creation would break API/CLI equivalence, and preclose callback queue reentry deadlocks.
- **Evidence:** packages/daemon/src/plugins/events.ts:28-40; packages/daemon/src/service.ts:74-82; plugins/quirky.terminal/src/layout/service.ts:452-510; amended shared pane contract and logic spec.
- **Reversibility:** medium (public lease and lifecycle contracts)
- **Confidence:** high
- **Revisit if:** backpressure or close-race acceptance exposes stale/duplicate state
- **Source:** assumed — autonomous

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

## Progress
Claimed 2026-10-28T00:35Z. Contract/spec commit2ab093ce; three isolated OpenAI components running under /tmp/sa-browser-pane.fiGLjz with hard disjoint scopes/journal. Parent amendments D8–D10 communicated before code acceptance. Web dogfood doctor passed. Next: wave barrier HEAD/scope audits, merge implementations, owned acceptance/build and real Watch smoke, one Gemini review/fix, affected suite/scripts/types, one catchup/decision reconciliation, commit/detach/controller land. Native-only scenarios are pending nightly; no implementation verified yet.
