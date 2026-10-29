# sa-browser-native-profile-clear-completion decisions

## D1: Apply the unattended combined-spec workflow without native side effects
- **Question:** Which workflow, research, approval and verification steps apply to this follow-up?
- **Options:** ask a person; start a research swarm and native deletion probe; inspect current public prerequisites and record autonomous choices
- **Chose:** standard gray areas, autonomous recommended defaults, one combined logic/technical spec and one read-only scout; no human asks, visual companion, external research swarm, tests, dogfood or review. No implementation dispatch because the core prerequisite is absent.
- **Why:** authoritative LOOP.md's Build first, test at the end section overrides the normal multi-spec/review/test cadence; its blocking rule applies when the core cannot ship. A real Session deletion probe cannot be made safe by QUIRKY_HOME alone.
- **Evidence:** build/roadmap:docs/loop/LOOP.md, Build first, test at the end and Blocking an item; predecessor sa-browser-profiles-settings D9/D21.
- **Reversibility:** easy (workflow only)
- **Confidence:** high
- **Revisit if:** the item is resumed after a supported public SDK capability is provided
- **Source:** locked by docs/loop/LOOP.md

## D2: Retain the established profile API and destructive-operation semantics
- **Question:** Brainstorming API/Data/Integration gray areas: who consumes this, which flows change, what is success, and how do authentication, errors, cancellation, active use and partial failure behave?
- **Options:** Chrome-only clear reported as full success; new independent profile store/API; complete the existing confirmed clear/remove transaction only with native completion evidence
- **Chose:** Settings and generated CLI use the existing namespaced plugin methods and confirmation/--yes contract. Default clear preserves Default; isolated removal deletes its metadata only after native completion and Chrome maintenance. Active/pending use refuses before mutation; cancellation preserves data. Unavailable completion refuses before native invocation and request claim; uncertain already-claimed completion keeps admission closed. No optimistic toast or partial-success reinterpretation.
- **Why:** browser.md section2.5 requires actual cookies clear/profile removal, not a callback invocation. Existing one-use confirmation and admission guards protect unrelated profiles and late native deletion. Existing UI layout/loading/error style is unchanged.
- **Evidence:** browser.md:80-85; docs/roadmap.md:19-20,31-41; sa-browser-profiles-settings D8/D9/D11; plugins/quirky.browser/src/preferences-lifecycle.ts:21-31,52-87; src/preferences-ui.tsx:19-30.
- **Reversibility:** medium (consumer-visible storage semantics)
- **Confidence:** high
- **Revisit if:** the public native SDK exposes stronger completion/cancellation semantics
- **Source:** locked by docs/loop/decisions/sa-browser-profiles-settings.md

## D3: Block instead of equating native invocation with completion
- **Question:** Which implementation approach can satisfy acknowledged native cookies/site-data removal with the current SDK?
- **Options:** await the void method or add a timer; poll visible cookies/DOM storage; use a supported public native completion barrier and otherwise block
- **Chose:** block the whole item. Leave clearPartitionAvailable=false and reject-before-invocation unchanged. Neither timer/await-void nor cookie/DOM polling proves removal of all native website data; no private FFI/Swift bridge or browser-engine substitution.
- **Why:** configured and projected Electrobun 2.0.4 still exposes SessionInstance.clearStorageData(...):void. Its native ABI takes only partition/type cstrings and returns FFIType.void; the inspected public Session object has no acknowledgement, completion event or barrier. No native Session deletion was invoked. This is a public-contract limitation, not a claim about whether private native code internally waits.
- **Evidence:** apps/desktop/hutch.config.ts:6-8; apps/desktop/.hutch/devkit/package.json:1; apps/desktop/.hutch/devkit/api/sdks/main/proc/native.ts:1102-1105,3346-3394; packages/ui/src/native-browser.ts:990-1008. Read-only scout NativeStoragePrereqs independently confirmed the public surface.
- **Reversibility:** easy (no product change)
- **Confidence:** high for the inspected public-contract limitation
- **Revisit if:** a supported public deletion completion/error acknowledgement or documented barrier exists in the configured SDK and can be demonstrated safely
- **Source:** locked by docs/loop/decisions/sa-browser-profiles-settings.md

## D4: Require separate native root-isolation proof before any Default scenario
- **Question:** Does a temporary QUIRKY_HOME, helper HOME or a Browser partition establish a run-owned native websiteDataStore root?
- **Options:** assume helper env relocates WKWebView storage; clear Default under temporary QUIRKY_HOME; require supported native storage-root configuration and independent proof
- **Chose:** do not open or clear shared Default. Require a supported root configuration before native view creation and proof that the actual native website data resides only in the owned root. Existing nightly scenarios remain unchanged and pending; fresh UUID profiles are the only permitted partition-isolation scenario until root isolation is proven.
- **Why:** public BrowserView options expose partition, not a native storage-root setting; helper-process env isolation is not a documented WKWebView storage contract. The inspected SDK API projection has no websiteDataStore/storageRoot/storagePath/userDataPath surface. Completing isolated-profile removal alone is also impossible without D3's completion prerequisite, so no independently shippable remainder exists.
- **Evidence:** SDK api/sdks/main/core/BrowserView.ts:44-78; plugins/quirky.browser/src/runtime/native.ts:185-246; sa-browser-profiles-settings D21; docs/loop/native/sa-browser-profiles-settings.json:5-7; public SDK API search for websiteDataStore/storageRoot/storagePath/userDataPath.
- **Reversibility:** medium (native runtime/test environment prerequisite)
- **Confidence:** high for absent inspected public configuration; no claim about unprojected private implementation
- **Revisit if:** SDK documents/provides isolated native storage configuration and an owned environment can demonstrate the actual root before touching Default
- **Source:** locked by docs/loop/decisions/sa-browser-profiles-settings.md

## D5: Keep this blocker narrow and do not enqueue duplicate work
- **Question:** Should the item land a refusal-only change or enqueue another follow-up for the same unsupported flow?
- **Options:** land unchanged guards as completion; create another completion item; queue-block this existing owner with exact unblock conditions
- **Chose:** preserve all product code/tests/native handoffs, commit this spec/decision record on blocked/sa-browser-native-profile-clear-completion, and let queue.ts block append the blocker/index. No duplicate queue item or invented passing test evidence.
- **Why:** the predecessor already ships the safe refusal; repeating it would not implement any requested flow. The loop requires whole-item blocking when the core cannot ship.
- **Evidence:** docs/loop/BLOCKERS.md:279; packages/ui/src/native-browser.ts:1001-1008; docs/loop/LOOP.md, Blocking an item.
- **Reversibility:** easy (resume this exact item when SDK prerequisites exist)
- **Confidence:** high
- **Revisit if:** both native completion and root-isolation prerequisites become available
- **Source:** assumed — autonomous

## D6: Unblock on Quirky's Electrobun fork patch
- **Question:** Both blocking prerequisites (D3, D4) were missing from public Electrobun 2.0.4/2.0.5. Where do they come from?
- **Options:** keep waiting for upstream; private FFI or Swift bridge; a public-API patch on Quirky's Electrobun fork
- **Chose:** the fork patch `patch/storage-clear-completion` on `v2.0.5`. `Session.clearStorageData()` returns `{status:'cleared'}` only from WebKit's `removeDataOfTypes:modifiedSince:completionHandler:` callback, otherwise `failed` (timeout, invalid-types) or `unsupported` (platform, partition). `Session.setStorageIdentifier(uuid)` picks the `WKWebsiteDataStore(forIdentifier:)` a `persist:` partition uses before its first view, and `BrowserView.getStorageIdentifier()` reads the store the live view was created with. Linux, Windows and macOS before 14 report unsupported.
- **Why:** these are public WebKit calls (macOS 14 for the identifier store), so the D3 rule against private native pointers still holds. The patch also fixes upstream's default `clearStorageData()` call, which sent `["all"]` and removed nothing on macOS.
- **Evidence:** fork `package/src/native/macos/website_data_store.h`, `nativeWrapper.mm` `sessionClearStorageData`/`sessionSetStorageIdentifier`/`webviewGetStorageIdentifier`; upstream PR text `prs/storage-clear-completion.md` on the fork's `quirky` branch; docs/quirk/specs/2026-10-29-electrobun-fork/logic.md.
- **Reversibility:** easy (drop the patch when upstream ships an equivalent; Quirky code only needs the result shapes)
- **Confidence:** high
- **Revisit if:** upstream merges a different API shape for the PR
- **Source:** supersedes sa-browser-native-profile-clear-completion D3

## D7: Scope each profile's native store to the Quirky home
- **Question:** What store identifier does each Browser partition get, so a test home can't share the user's real Default?
- **Options:** keep Electrobun's name hash (shared by every install of the app); a random UUID per profile in profile metadata; a hash of a per-home install id and the partition
- **Chose:** the desktop host keeps a random install id in `<QUIRKY_HOME>/desktop/native-browser-storage-id` (0600, created once, refused rather than replaced if damaged) and gives `persist:quirky-browser-<profile>` the UUID made from `sha256(installId + "\n" + partition)`. It assigns Default at host start, before any window exists, and the UI asks the host to assign a profile's store before it creates that profile's guest. The claim refuses a view whose live store identifier isn't the expected one, so every claimed guest is proven to be in its home's own store.
- **Why:** the desktop host is the only process that creates native views and needs no daemon round trip. A temporary QUIRKY_HOME then gets stores no other home uses, and the claim check is the per-view root proof that D4 asked for. Deriving instead of storing per-profile UUIDs means profile metadata, owned by the plugin, doesn't change.
- **Evidence:** apps/desktop/src/bun/native-browser-storage.ts; apps/desktop/src/bun/native-browser.ts `claim`; packages/ui/src/native-browser.ts `start()`; apps/desktop/test/native-browser-storage.test.ts.
- **Reversibility:** medium. Native cookies stored before this change sit in the old name-hashed store and are no longer used. They aren't deleted, and pointing the identifier back at the name hash would bring them back.
- **Confidence:** high
- **Revisit if:** profiles need to move between Quirky homes, or the user wants pre-fork native cookies kept
- **Source:** assumed — autonomous

## D8: Advertise clearing only when the host proved support at startup
- **Question:** `clearPartitionAvailable` is a synchronous boolean read before the one-use claim. How does the shell know the host can confirm completion?
- **Options:** assume it whenever the bridge has a clear method; ask the host asynchronously; the host injects what it found at startup into the trusted preload
- **Chose:** the host computes `supported` from assigning Default's store (status `set` only on macOS 14+ with the patched SDK) and prefixes the trusted shell preload with `const QUIRKY_NATIVE_BROWSER_CLEAR_AVAILABLE = <bool>`. The bridge exposes it as `clearPartitionAvailable`, and the UI adapter advertises clearing only when that flag is true and the clear method exists.
- **Why:** an unavailable host must refuse before the claim (D2, profiles-settings D8). A claimed-then-failed clear leaves the profile locked until daemon restart, so availability can't be guessed. Bridge storage members are optional, so a shell served to an older desktop keeps the existing refusal.
- **Evidence:** apps/desktop/src/bun/index.ts, native-browser-preload.ts, packages/ui/src/native-browser.ts `createElectrobunNativeBrowserAdapter`.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** Plugin API gains an async capability probe
- **Source:** assumed — autonomous

## D9: A clear succeeds only on the engine's own completion
- **Question:** What does the host do with each clear result?
- **Options:** treat timeout as success; retry; return `{cleared:true}` only for `cleared`
- **Chose:** the host first re-assigns the partition's store (the assignment lives in the app process, and a profile not opened since launch must still clear its own store, not the name-hashed one), then calls `clearStorageData('all')`. Only `cleared` returns `{cleared:true}`. Every other result throws with its status and reason, so the lifecycle keeps its existing uncertain-completion rule and never repeats a timed-out deletion.
- **Why:** D2 and D3 rule out reading invocation or a timer as completion. The lifecycle (`preferences-lifecycle.ts`) already sequences Chrome and metadata after a `{cleared:true}` reply, so it needed no change.
- **Evidence:** apps/desktop/src/bun/native-browser-storage.ts `clear`; plugins/quirky.browser/test/preferences-native-command.test.ts.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** none
- **Source:** locked by docs/loop/decisions/sa-browser-profiles-settings.md

## D10: Verified on this Mac, with the gaps named
- **Question:** What was actually proven, and how?
- **Options:** claim completion from unit tests; run the real app against the user's data; run the real app in an isolated home and bundle id
- **Chose:** the real desktop app (private devkit `2.0.5-quirky.0-storage-clear-completion`, macOS 26 arm64) with a temporary QUIRKY_HOME and a temporary, uncommitted bundle id `dev.quirky.clearprobe`. The bundle id matters: WebKit keeps stores per bundle id, and the user's running Quirky.app (`dev.quirky.app`) has its shell's `persist:default` store (`37a8eec1-…`) in that container, so a same-id dev build would have opened it concurrently.
- **Verified:**
  - Root proof (SC5): the host created the install id (0600). The Default Native guest claimed successfully, so its live `getStorageIdentifier()` matched. Its store appeared as `WebsiteDataStore/839dd938-9d0a-a3cc-7cfd-79e41151cd02`, the UUID derived from that home, not the stock name hash `5fde1a3e-…`. The user's `dev.quirky.app` container gained no data from the run (no fixture origin anywhere in it).
  - Clear (SC2): the guest loaded a local fixture whose page reported `cookie=probe=cookie-value | ls=stored-value`. After closing the Default panes, Browser Settings showed the available copy, and Clear cookies & site data > Clear Data finished with no error. On disk the store's Cookies and LocalStorage folders were empty and Origins held only its salt. A reopened Default guest's accessibility tree read `cookie: (none)` and `localStorage: (none)`. The only fixture cache record was written after the clear, by that read page.
  - The GUI run used the first private build. A code review then made two fork changes: `setStorageIdentifier` reports the identifier in WebKit's uppercase form, and the view init stopped reading a freed partition pointer. The devkit was rebuilt with both, and Quirky's typecheck and claim check are unaffected because the host compares identifiers case-insensitively. The GUI run wasn't repeated on that rebuild.
  - Fork: `scripts/test-macos-website-data-store.sh` (real WebKit, fresh stores, clears one and checks the other keeps its records), plus the TS/contract tests, all pass. Quirky `bun run typecheck` passes against the patched devkit.
  - Quirky tests: apps/desktop/test/native-browser.test.ts, apps/desktop/test/native-browser-storage.test.ts, packages/ui/test/native-browser.test.ts, packages/ui/test/native-browser-dom.test.ts, and plugins/quirky.browser/test/preferences-{native-command,window,lifecycle,integration,api}.test.ts(x) plus pane-window-find.test.tsx pass. The suite ran locally because no remote host answered. One integration test ("profile menus API persists creation…") hit its 5 s timeout twice at load average ~186 and passed 5/5 with `--timeout 60000`. It spawns two CLI processes and touches none of this change.
- **Not verified:**
  - Isolated-profile Remove (SC3) in the GUI. It uses the same host clear path, which the lifecycle, integration and command tests cover.
  - macOS 13. No machine was available; the unsupported path is covered by unit tests.
  - Screenshots. The app window sat in the Stage Manager strip, so captures were thumbnails, and the GUI verdicts were recorded `partial` on accessibility-tree, pane-state and filesystem evidence. Address-bar typing through the background driver dropped characters, so the two fixture navigations used the plugin's paneOpen API as setup. Run report: `.quirk/using-apps-like-a-user/runs/20261029T113425-f1ef/report.md` (ignored, local only).
  - Linux and Windows behavior beyond the patch's contract test.
- **Reversibility:** easy
- **Confidence:** high for macOS 14+ Default clear and root isolation; medium for SC3 in the GUI
- **Revisit if:** the nightly native run reports SC1–SC5 (`docs/loop/native/sa-browser-native-profile-clear-completion.json`)
- **Source:** assumed — autonomous

## Progress
Implemented against the fork patch `patch/storage-clear-completion` and verified as D10 describes. Native scenarios are handed off as pending in docs/loop/native/sa-browser-native-profile-clear-completion.json. Before this branch merges, the coordinator moves `apps/desktop/hutch.config.ts` to the `2.0.5-quirky.N` release that contains the patch. The private-test pin is not committed. The queue entry stays `blocked` until the coordinator lands it; this branch doesn't touch queue.json or BLOCKERS.md.
