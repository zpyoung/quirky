# fix-native-m2-editor-1028 decisions

## D1: Repair the confirmed Explorer path contract mismatch
- **Question:** Which SC-9-native observations are confirmed failures requiring this fix?
- **Options:** repair clipboard paths; assume synthetic drag failures prove native drag breakage; reimplement unsupported Finder source-path extraction
- **Chose:** repair the absolute/relative path contract at Explorer clipboard and same-scenario URI export boundaries; preserve native import-all policy and unrelated native scenarios.
- **Why:** the native report independently checked wrong clipboard values using a sentinel and Find files. Explorer daemon entries and selection use absolute paths, while copyPaths prepends the listing root or returns absolute selection unchanged. URI export repeats the same incorrect join. Synthetic native drag results are explicitly inconclusive; Finder imports and Reveal were not exercised.
- **Evidence:** docs/loop/native/m2-editor.json SC-9-native; native-qa report 20261028T061952-27c6 lines 20–22; plugins/quirky.editor/src/window/ExplorerPanel.tsx copyPaths/onDragStart; plugins/quirky.editor/src/daemon/explorer.ts interact; m2-editor D19; m4-editor-drop-open-in-place D4
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** actual native retest identifies another confirmed failure
- **Source:** assumed — autonomous

## D2: Use canonical worktree identity for relative clipboard paths
- **Question:** What root defines Copy Relative Path when Explorer displays a subdirectory?
- **Options:** displayed listing root; canonical documentRoot worktree path; basename only
- **Chose:** canonical worktree root resolved by the existing documentRoot owner; Copy Path preserves the absolute entry identity without shell quoting. URI export encodes that identity once. Keep existing newline-delimited multi-selection order.
- **Why:** listing.root can be a display-root subdirectory. Relative paths must remain worktree-relative and must preserve apostrophes, spaces, hash and Unicode exactly. No public protocol changes or alternative tree-path convention are needed.
- **Evidence:** ExplorerPanel worktreeRoot/documentRoot and relativeExplorerPath; ExplorerService.call returns target.path as listing root
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** public Explorer entry identity contract changes
- **Source:** assumed — autonomous

## D3: Export relative worktree drag paths without weakening terminal authorization
- **Question:** Does the same absolute-path assumption affect SC-9 terminal insertion?
- **Options:** allow absolute internal paths in the terminal; fix the Explorer producer; treat synthetic native drag silence as proof of a separate native defect
- **Chose:** keep Explorer selection absolute, export worktree-relative internal MIME paths, and export exact absolute file URIs. Preserve terminal ownership/traversal checks and shell escaping. Correct Open in Terminal's same erroneous root join.
- **Why:** terminal handling prefers the internal MIME payload and explicitly rejects absolute paths before writing input; the current Explorer producer emits absolute entries. This deterministic contract mismatch explains a refusal independently of the native harness's inconclusive drag. Existing editor document/move consumers accept worktree-relative source paths; daemon same-source/target moves already return a no-op.
- **Evidence:** plugins/quirky.terminal/src/window/pane/drop.ts:12–58; TerminalPaneView.tsx:655–680; ExplorerPanel.tsx:678–683,926–931; DocumentSurface.tsx:886–895; editor daemon service.ts:2015–2019
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** a public drag contract changes; actual OS input remains a separate native retest
- **Source:** assumed — autonomous

## D4: Preserve the native retest boundary and explicit verification limits
- **Question:** What evidence is sufficient for this repair without taking over macOS windows?
- **Options:** claim SC-9-native passed from browser events; exercise the shared rendered/API path and return native acceptance to the nightly run
- **Chose:** daemon-backed rendered Explorer regression plus isolated headless browser smoke; reset only SC-9-native to pending, retaining its historical report/date. No Finder, system clipboard, native window or cross-app drag certification.
- **Why:** the changed browser code is shared by native WebKit, but Chromium's clipboard and synthetic drag are not native OS acceptance. The regression first reproduced the exact doubled-root defect; the corrected run passed all three tests with 34 assertions, including narrowed root, multi-selection, Terminal cwd and actual file move. React act/fixture shutdown warnings occurred and are not described as pristine output.
- **Evidence:** bun test plugins/quirky.editor/test/explorer-path-actions.test.tsx: 3 pass/0 fail/34 assertions; browser printed EDITOR_BROWSER_CLIPBOARD_SMOKE_OK after exact absolute/relative clipboard readback. The first synthetic browser drag emitted an observed quirky.terminal/write RPC with exact shell-escaped data; its smoke assertion mistakenly checked params.text instead of params.data, and a retry captured no frame, so no repeatable/native drag pass is claimed.
- **Reversibility:** easy
- **Confidence:** high for shared clipboard path behavior; medium for native interaction until retest
- **Revisit if:** native QA still observes incorrect copied paths or rejects actual Explorer drags
- **Source:** assumed — autonomous

## D5: Keep runtime and platform verification scoped
- **Question:** Which environment-specific smoke failures require production changes?
- **Options:** increase production activation deadlines or weaken clipboard handling; correct fixture permissions and retry cached assets
- **Chose:** leave production activation/clipboard security unchanged. The first browser load timed out activating multiple plugins while asset requests stalled for about 26 seconds; one reload activated Explorer. Grant the isolated Chromium context clipboard-sanitized-write alongside clipboard-read/write after its initial write was denied. Run no foreground/native window. Linux/Windows Explorer clipboard, URI and terminal interactions remain unverified.
- **Why:** the UI loaded and copied exact values once cached assets and required test-context permissions were available. These observations do not justify changing unrelated timeouts or bypassing browser permission errors.
- **Evidence:** owned browser network/console log and screenshots; bun packages/ui/build.ts built 25 plugin UI modules; bun run typecheck passed root/mobile/desktop before catch-up
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** activation failure reproduces without stalled requests, or platform QA identifies incompatible path behavior
- **Source:** deferred: platform

## D6: Preserve incoming owners and retain bounded smoke cleanup evidence
- **Question:** Do the single roadmap catch-up and smoke shutdown require another production change?
- **Options:** broaden this editor repair into owner provisioning, UI activation or Bun process lifetime; retain those owners and document the observed boundary
- **Chose:** keep the scoped path correction. Read all six incoming decision logs, including omitted Progress lines: fix-flaky-pty-host-clear, fix-flaky-quirky-worktree-create, fix-native-m3-accounts-1028, fix-native-sa-browser-agent-1028, m7-terminal-owner-provisioning-and-selector-flows, and ui-screenshot-review. No conflicting editor clipboard/drag contract. Preserve canonical selector/CLI/runtime authority, native credentials and UI lint/theme/capture owners. The isolated smoke printed EDITOR_SMOKE_CLEANED after awaited harness/home/repo cleanup; its Bun host remained alive and was explicitly stopped. No natural-exit-zero claim.
- **Why:** unrelated timing/provisioning/native evidence cannot justify a fallback or widened fix. The new regression still passes against the incoming real daemon dependencies, and merged typecheck passed.
- **Evidence:** clean ort roadmap merge after source commit 2d137f18; caught-up regression 3 pass/0 fail/34 assertions in 8.65s; full caught-up typecheck exit 0 in 33.19s; owned smoke service cleanup acknowledgment followed by stopped/exited receipt; static plugin validation found zero blocking incompatibilities
- **Reversibility:** easy
- **Confidence:** high for exercised clipboard/path contracts; smoke host natural-exit cause unestablished
- **Revisit if:** a concrete regression or process-owner diagnostic identifies another changed boundary
- **Source:** locked by incoming decision logs for their separate owners; assumed — autonomous for scoped evidence

## D7: Land the verified native-path repair without misreporting broader suites
- **Question:** Should unrelated suite failures suppress this fix, weaken assertions, or trigger another debugging item?
- **Options:** broaden the item into every failing package flow; claim tests pass; retain precise failure evidence for the existing end phase and use LOOP's typecheck landing gate
- **Chose:** retain the exact inventory in BLOCKERS.md and land the complete scoped repair. No debug/testing successor, suppressed assertion, arbitrary timeout or claim of green package/scripts suites.
- **Why:** the native clipboard failure is repaired and exercised through real daemon data and the rendered surface. Broad suite failures cover independent CSV/Markdown, terminal admission/metadata/defaults, platform-only cases and incoming UI-review fixtures. LOOP explicitly gates land on typecheck and retains debugging for the end phase. None of these failures demonstrates an incorrect copied Explorer path.
- **Evidence:** affected-suite command exit 1/414.24s: remote 101 passing/19 failing files, local 2 passing/1 failing file; caught-up scripts exit 1/82.08s: 113 pass/13 fail/1,009 assertions. Complete named inventories and concrete boundaries in docs/loop/BLOCKERS.md under this item. Caught-up scoped regression and typecheck passed as D6 records.
- **Reversibility:** easy
- **Confidence:** high for observed results; no attribution of every failure's historical origin
- **Revisit if:** a failing end-phase scenario is traced to this change's exact path export boundary
- **Source:** locked by docs/loop/LOOP.md

## Progress
Source committed as 2d137f18; single clean roadmap catch-up merged and all six incoming decision logs read completely. Caught-up root/UIlint/mobile/prepared-desktop typecheck passed (33.19s); caught-up Explorer regression passed 3/0 with 34 assertions (8.65s). Static plugin validation returned zero blocking issues. Actual browser clipboard smoke passed with D4/D5 limits; browser tab closed, smoke runtime cleanup acknowledged and remaining Bun host explicitly reaped (D6). All owned agents and finite jobs returned. Broader suite/script failures are recorded in D7 and BLOCKERS.md, not claimed green. Only SC-9-native is pending with historical date/report retained. Ready to commit this receipt, detach and canonical queue land, await merge-result typecheck, remove the owned temporary smoke script, and end exactly this one-item iteration.
