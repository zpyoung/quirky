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

## Progress
Implementation and narrow regression complete. Parent observed true red clipboard values, then 3 pass/0 fail/34 assertions. Web UI build and first full typecheck passed. Isolated browser clipboard readback passed; see D4/D5 for synthetic drag and environment limits. Browser tab closed and smoke daemon sent shutdown. Affected editor/terminal suite is running; scripts tests passed 81/0 with 820 assertions. Static plugin validation pending. Next: await every owned job, record suite results, commit, catch up once with build/roadmap and read incoming decisions, rerun typecheck, then detach and land using canonical queue script. Only SC-9-native reset to pending; all other scenarios untouched.
