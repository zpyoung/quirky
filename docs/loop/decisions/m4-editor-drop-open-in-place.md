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

## Progress
Blocked at step 3 (brainstorming feasibility), before specs/implementation. No supported dropped-source-path API exists in the inspected installed 2.0.4 or latest published 2.0.5 surfaces. The executable public-module/source audit exited 0; no actual Finder/native acceptance or feature completion is claimed. Preserve the evidence archive in this lane's ignored iteration folder, commit this decision record, rename the branch to blocked/m4-editor-drop-open-in-place, detach, and invoke canonical queue.ts block with the external blocker entry. The next attempt requires an upstream supported API or explicit native-patch/fork approval.
