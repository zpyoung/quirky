# m4-editor-drop-open-in-place decisions

## D1: Preserve SC-9 and the explicit native-patch approval boundary
- **Question:** What is this item's consumer-visible scope and hard limit?
- **Options:** open inside-worktree Finder drops in place and import outside sources using a supported runtime API; retain import-all and claim parity; introduce a native patch or fork
- **Chose:** investigate the supported runtime path first; block the whole item if the necessary native capability is unavailable
- **Why:** this item specifically repairs the import-all exception and explicitly prohibits an unapproved native patch/fork. A typed event without real source paths would not deliver SC-9.
- **Evidence:** queue item m4-editor-drop-open-in-place; editor.md Opening a file; docs/loop/decisions/m2-editor.md D19
- **Reversibility:** easy (no runtime changes authorized)
- **Confidence:** high
- **Revisit if:** Electrobun publishes a supported native dropped-source-path API or the native-patch approval boundary changes
- **Source:** locked by queue item m4-editor-drop-open-in-place and docs/loop/decisions/m2-editor.md D19

## D2: Resolve the relevant gray areas without human interaction
- **Question:** How should integration data mapping, interaction style, duplicate handling and error handling behave?
- **Options:** preserve the feature document's open/import distinction and existing editor semantics; infer source identity from basenames/content; replace drops with a file picker; ask a person
- **Chose:** a genuine dropped absolute path determines inside/outside membership; existing tab reuse and focus rules apply; external files retain collision-safe import; ambiguous pathless drops do not count as open-in-place. No filename/content search, clipboard polling or substitute picker flow.
- **Why:** purpose, consumers, primary behavior, success criteria, scope and constraints are supplied by the queued title and feature doc. Guessing identity risks opening the wrong file and a picker is not a Finder drop.
- **Evidence:** editor.md lines 17,75–79; DocumentSurface.tsx handleDrop; m2-editor D5/D19; docs/loop/LOOP.md Answering a skill's questions
- **Reversibility:** medium (observable drop contract)
- **Confidence:** high
- **Revisit if:** supported native events supply a different explicit identity contract
- **Source:** assumed — autonomous

## D3: Investigate the latest published release rather than upgrade speculatively
- **Question:** Can a newer supported Electrobun release supply the missing source paths?
- **Options:** audit the current and latest published APIs; upgrade without capability evidence; patch native code
- **Chose:** inspect installed 2.0.4 and pinned upstream v2.0.5, including public events, BrowserView, browser/preload code, macOS native source and the complete release comparison
- **Why:** the registry's latest tag is 2.0.5 and beta is 2.0.5-beta.5. The version alone is not proof that drop paths exist. No dependencies or native artifacts are changed during feasibility research.
- **Evidence:** apps/desktop/hutch.config.ts:6–8; https://registry.npmjs.org/electrobun/latest; https://github.com/blackboardsh/electrobun/compare/v2.0.4...v2.0.5
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** a later release or documented supported API supplies source paths
- **Source:** assumed — autonomous

## D4: Block on the missing native source-path capability
- **Question:** Which supported implementation can deliver actual Finder open-in-place?
- **Options:** existing 2.0.4 SDK; published 2.0.5 SDK; native patch/fork; keep existing behavior and record the blocker
- **Chose:** block the item; leave production code and the 2.0.4 pin unchanged
- **Why:** installed and latest public webview event factories are identical and contain no drop-path event. The complete 2.0.4-to-2.0.5 comparison contains no non-test changes under main SDK, browser or preload. Latest macOS native source contains none of `NSDraggingInfo`, `draggingEntered`, `performDragOperation`, `GetFileNames` or `OnDragEnter`; its release diff only adds fullscreen diagnostics. The preload's only external-drop handler restores Windows focus and never extracts paths. The upstream inbound-drop discussion independently describes the missing native binding, but is corroboration rather than API documentation.
- **Evidence:** executable audit exited 0 on 2026-10-28 and printed `changedPublicSdkBrowserPreloadFiles: []`, identical eleven-entry webview event factories, and `nativeDropHooks: []`; https://github.com/blackboardsh/electrobun/blob/v2.0.5/package/src/sdks/main/events/webviewEvents.ts#L16-L39; https://github.com/blackboardsh/electrobun/blob/v2.0.5/package/src/preload/externalDropFocus.ts#L7-L40; https://github.com/blackboardsh/electrobun/compare/v2.0.4...v2.0.5; https://github.com/blackboardsh/electrobun/issues/63#issuecomment-4056077426
- **Reversibility:** easy (no production changes)
- **Confidence:** high
- **Revisit if:** upstream ships a documented source-path event/extractor, or the user explicitly approves a native patch/fork
- **Source:** locked by queue item m4-editor-drop-open-in-place

## D5: Do not substitute partial routing or an empty public event
- **Question:** Can this item land a useful independent subset without the missing native input?
- **Options:** route only URI-list drops; publish an event with no native producer; block before implementation
- **Chose:** block at brainstorming feasibility, before specs, contracts, implementation or review
- **Why:** this item's core is Finder source identity. `DataTransfer.files` takes precedence over URI lists in DocumentSurface and its staged transfer receives only filename/content. A URI-only special case cannot certify Finder parity; a typed RPC event cannot manufacture source paths. No unrelated editor, terminal, internal-drag or import behavior is changed.
- **Evidence:** plugins/quirky.editor/src/window/DocumentSurface.tsx:736–766; plugins/quirky.editor/src/window/transfers.ts:107–126; apps/desktop/src/bun/native-browser.ts:3–22; docs/loop/LOOP.md Blocking an item
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** the native producer prerequisite becomes available
- **Source:** assumed — autonomous

## D6: Keep the capability audit's verification limits explicit
- **Question:** What does the executable audit prove, and what platform work remains?
- **Options:** claim a synthetic event proves Finder behavior; execute public modules and report source-audit limits
- **Chose:** import installed/latest event modules in Bun under fresh temporary HOME/QUIRKY_HOME and audit pinned source; claim no actual Finder-drop/native-window acceptance. Linux and Windows drop-path integration remains unverified.
- **Why:** this is feasibility research with no production change. Web-created File objects do not reproduce native Finder identity, and this unattended lane does not exercise foreground OS windows. No permanent tests, build, daemon, browser or native process is needed to record a missing supported API.
- **Evidence:** ignored iteration archive `editor-drop-feasibility-evidence.tar.gz` contains audit.ts, audit-result.json, complete release comparison and fetched pinned upstream sources; audit result explicitly states it is not a Finder/native-UI test
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** a supported API permits real native acceptance on macOS and later platform hosts
- **Source:** deferred: platform

## D7: Unblock through the approved Electrobun fork patch
- **Question:** Where do real Finder source paths come from now that a native patch is allowed?
- **Options:** keep blocking; fork patch that reads file URLs from the drag pasteboard; CEF renderer swap
- **Chose:** fork branch `patch/drop-source-paths`: Electrobun WKWebViews are an `ElectrobunWKWebView` subclass whose `performDragOperation:` reads `NSPasteboardURLReadingFileURLsOnlyKey` file URLs, calls `super`, and emits a native-only `drop-source-paths` webview event for accepted drops. `BrowserView.supportsDropSourcePaths()` is true for macOS WKWebView and false for CEF, Linux and Windows. The SDK's event bridge refuses the event name from page script.
- **Why:** the fork spec approves this patch for this item. Public `NSDraggingDestination`/`NSPasteboard` API only; the page still gets its normal DOM drop. The native test drives a real `ElectrobunWKWebView` through `draggingEntered:`/`draggingUpdated:`/`performDragOperation:` and sees both the reported paths and the page's own `drop` with the same files.
- **Evidence:** fork commits 3a84328d, 659c89de; `package/src/native/macos/drop_source_paths.h`; `package/scripts/test-macos-drop-source-paths.sh`; docs/quirk/specs/2026-10-29-electrobun-fork/logic.md (The 8 items)
- **Reversibility:** medium (Quirky depends on the fork until upstream merges an equivalent)
- **Confidence:** high
- **Revisit if:** upstream ships its own drop-path API, or CEF needs the same capability
- **Source:** supersedes m4-editor-drop-open-in-place D4

## D8: Carry paths bun → shell webview → plugin context, correlated by the drop's own files
- **Question:** How does the editor's DOM drop get the paths of that same drop?
- **Options:** daemon-routed kernel event; window-local `subscribe` event plus plugin-side buffering; `UiPluginContext.nativeDropPaths(files)` backed by the shell bridge
- **Chose:** bun listens to `drop-source-paths` on the shell window's own webview and sends `dropSourcePaths` over the typed shell RPC (`NativeBrowserHostRPC.webview.messages`). The trusted preload keeps unclaimed reports for 2 s. `DesktopShellBridge.nativeDropPaths(fileNames)` and `UiPluginContext.nativeDropPaths(files)` claim the report whose paths pair one-to-one by basename with the dropped `File` names, waiting up to 500 ms. Plugin API goes to 1.1.0; the editor declares `apiVersion` 1.1.0.
- **Why:** the native report and the DOM drop travel separately and either may arrive first, so the page needs a claim with a short wait. The identity comes from the native report; the name check only confirms that report belongs to this drop (a mismatched or missing report yields null, never a guess). A daemon event would lose the window identity, and every plugin wanting drop paths would reimplement the correlation. The public plugin API grows rather than the editor reaching into the shell (roadmap rule).
- **Evidence:** apps/desktop/src/bun/drop-source-paths.ts; apps/desktop/src/bun/index.ts createWindow; apps/desktop/src/bun/native-browser-preload.ts; packages/ui/src/plugins/host.ts; packages/protocol/src/ui.ts; docs/plugin-api.md "Releases since 1.0.0"
- **Reversibility:** medium (public plugin API addition)
- **Confidence:** medium (500 ms wait chosen without measured latency on a loaded machine)
- **Revisit if:** real Finder drops show the report arriving later than 500 ms, or Electrobun delivers paths inside the DOM drop itself
- **Source:** assumed — autonomous

## D9: Editor drops open in place; Explorer folder drops still import
- **Question:** Which drop targets change behavior?
- **Options:** editor documents only; editor and Explorer folders
- **Chose:** `DocumentSurface` drops: sources inside the realpath'd worktree root open in place (existing tab reuse/focus via `quirky.editor/open`), others go through `mutate import` with `sourcePaths` (collision-safe copies beside the document). When `nativeDropPaths` returns null (browser shells, Linux, Windows, CEF, runtimes without the capability, unmatched drops) the m2-editor D19 import-all upload path runs unchanged. Explorer folder drops keep importing.
- **Why:** Orca's editor group opens in-worktree drops and imports the rest (editor.md line 17); its Explorer imports OS drops into the target folder (editor.md line 415). A dropped directory inside the worktree goes to `open` and fails with the daemon's error rather than being copied.
- **Evidence:** plugins/quirky.editor/src/window/DocumentSurface.tsx droppedFileTargets; plugins/quirky.editor/test/native-drop.test.ts
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** Explorer folder drops should also open in place, or in-worktree directory drops need their own behavior
- **Source:** supersedes m2-editor D19

## D10: Record what was and wasn't verified
- **Question:** What does this session's evidence prove?
- **Options:** claim Finder parity from tests; claim only what was run
- **Chose:** claim only what ran. Verified: the fork's native test (real `ElectrobunWKWebView`, real drag pasteboard, synthetic `NSDraggingInfo`), its source contract and event-bridge tests, the native symbol contract, all failing on v2.0.5 and passing with the patch; the private devkit build `2.0.5-quirky.0-drop-source-paths`; root and desktop typechecks against that devkit; the preload bundling for the browser; desktop inbox/match tests; the UI host test; and a real-daemon editor test proving open-in-place for an in-worktree source, a `report copy.txt` import for an outside source, and D19 import for a pathless drop. Not verified: a real Finder drag in the running app, because that takes over the shared Mac's pointer and windows; it is pending in docs/loop/native/m4-editor-drop-open-in-place.json. Linux and Windows report unsupported by construction and weren't run.
- **Why:** LOOP.md requires evidence for every pass claim.
- **Evidence:** the full suite (`bun run test`, run locally because the remote box was unreachable, under heavy machine load) reported 824/883 files passing. Rerunning `apps/desktop`, `packages/protocol`, `packages/ui` and `plugins/quirky.editor` with a full log found five tests that used 1.1.0 (or 1.0.1) as a "newer than the host" plugin API floor; they now use 1.1.1/1.2.0 and pass, together with `exit.e2e`, the new desktop, host and editor tests. Two editor tests fail identically on base commit 5b64f211, so they predate this item: `core-acceptance.test.ts` "SC-6/8: renaming a directory rekeys an open descendant" and `core.test.ts` "SC-3: a preview close is neutral…". The remaining full-suite failures outside those directories weren't individually rechecked; those plugins changed only by a one-line `nativeDropPaths` stub in their test fakes, which typecheck covers.
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** the native scenario runs
- **Source:** deferred: platform

## Progress
Unblocked by the fork patch (D7). Implemented D8 and D9 on `zpyoung/eb-m4-editor-drop-open-in-place`. The `apps/desktop/hutch.config.ts` pin stays at 2.0.4 in the commit; it moves to the `2.0.5-quirky.N` release that carries `patch/drop-source-paths` when the coordinator merges. Until then this branch needs that devkit to run. Remaining: the pending native Finder-drag scenario.
