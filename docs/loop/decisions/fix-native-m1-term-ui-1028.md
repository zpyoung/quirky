# fix-native-m1-term-ui-1028 decisions

## D1: Read the desktop pasteboard through the trusted window bridge
- **Question:** Why does SC-37 Cmd+V fail in WKWebView, and where should clipboard text come from?
- **Options:** retry the permission-gated Web Clipboard API; let native paste events bypass command routing; use the existing trusted preload/host RPC seam
- **Chose:** add a native text-read request backed by Electrobun `Utils.clipboardReadText`, exposed through public `UiPluginContext.readClipboardText`; retain the Web Clipboard API in browser shells
- **Why:** capture-phase command routing intentionally consumes Cmd+V, and the command currently calls `navigator.clipboard.readText`. The native report records permission rejection and the WebKit Paste callout. The installed Electrobun SDK already offers a native clipboard primitive. Clipboard text stays window-local; no daemon API or guest webview gains access.
- **Evidence:** native report `/Users/zpyoung/orca/workspaces/quirky/native-qa/.quirk/using-apps-like-a-user/runs/20261028T045314-56e5/report.md:12-14,42`; `plugins/quirky.terminal/src/window/commands.ts:89-95,241-244`; `apps/desktop/.hutch/devkit/api/sdks/main/core/Utils.ts:314-320`; `apps/desktop/src/bun/native-browser-preload.ts:33`
- **Reversibility:** easy (additive window API; three terminal readers migrate together)
- **Confidence:** high
- **Revisit if:** native bridge cannot read the system pasteboard or introduces duplicate delivery
- **Source:** assumed — autonomous

## D2: Preserve terminal paste framing and migrate all terminal clipboard reads
- **Question:** Should the native acquisition repair change terminal input handling or cover only the shortcut?
- **Options:** shortcut-only special case; migrate command/menu/right-click readers to the public window API and preserve the existing paste pipeline
- **Chose:** migrate all three readers; retain ClipboardEvent data handling, newline normalization, mode-dependent brackets, ordered chunks, size cap, and deadline
- **Why:** each reader hits the same permission gate; all already converge on pane paste. A transport repair must not bypass terminal mode or input gates.
- **Evidence:** `plugins/quirky.terminal/src/window/pane/TerminalPaneView.tsx:583-620,639-645`; `plugins/quirky.terminal/src/window/workspace/controller.ts:1254-1260`; m1-term-ui D22
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** browser or terminal paste behavior regresses
- **Source:** locked by docs/loop/decisions/m1-term-ui.md D22

## D3: Native OS interaction remains a nightly scenario, not a foreground lane action
- **Question:** How should this lane verify a native-only failure while obeying the loop's no-native-foreground rule?
- **Options:** take over the desktop; exercise the production window/terminal path with controlled clipboard sources and requeue SC-37 for native verification
- **Chose:** controlled real-daemon/window/PTY regression and smoke, typecheck/build, then reset only SC-37 to pending with historical failure evidence retained
- **Why:** LOOP.md explicitly forbids native/foreground dogfood by feature lanes and delegates native-only scenarios to the nightly run. m7-test-triage has been claimed, so this fix runs its own checks under the end-phase rules.
- **Evidence:** authoritative build/roadmap `docs/loop/LOOP.md` end phase and step 6; canonical queue status observed m7-test-triage in-progress lane 8
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** the nightly native run reports further failure
- **Source:** locked by docs/loop/LOOP.md

## D4: Keep source changes narrow and preserve existing bridge operations
- **Question:** How should implementer output be integrated and checked?
- **Options:** trust worker completion reports; inspect each declared source/fixture scope and preserve existing members
- **Chose:** one source implementer and one mechanical fixture updater, with parent-owned regression, contracts, documentation and verification; parent audits their returned diffs
- **Why:** source audit caught `closeWindow` accidentally replaced by the new RPC registration; fixture audit caught existing members overwritten by new clipboard methods. All were restored before the complete keys test, build and typecheck. The shell adapter invokes the method on its owning bridge to preserve its receiver. No unrelated production behavior changed.
- **Evidence:** returned source/fixture diffs in this iteration; `apps/desktop/src/bun/index.ts` request registrations; `packages/ui/src/shell.ts` clipboard adapter; seven context fixture additions
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** typed fixtures or existing native bridge operations regress
- **Source:** assumed — autonomous

## D5: Use controlled clipboard sources to prove the real terminal path without claiming native OS verification
- **Question:** What does this lane's proof establish?
- **Options:** infer native correctness from compilation; run the built renderer against a real private daemon and raw-mode PTY, injecting only the clipboard boundary
- **Chose:** real CLI/daemon/window regression plus built Chromium surface and raw PTY byte capture; retain native nightly SC-37 as pending
- **Why:** the regression failed before the repair with zero writes instead of `native-plain` (0 pass/1 fail, 4.84 s). It passed after acquisition moved to the host. The complete keys file passed 5 tests/178 assertions in 23.59 s, including browser clipboard fallback and native-read failure without Web Clipboard fallback. The built surface accepted actual Meta+V and the raw program printed exact unbracketed `native-surface-off` bytes and bracketed `ESC[200~native-surface-onESC[201~` bytes; native reads 2, web reads 0, no toasts or browser errors.
- **Evidence:** `plugins/quirky.terminal/test/e2e-ui/features-keys.test.ts` SC-37 and SC-60; screenshot `/var/folders/x5/07kj5yld16l9wd5p_v01h20c0000gp/T/omp-sshots-15b863bbd78dad77.webp`; owned service `lane5-native-paste-surface` exited 0 with `homeRemoved:true`; initial typecheck exit 0/32.26 s and full desktop build exit 0/18.73 s
- **Reversibility:** easy
- **Confidence:** high for application routing/framing; native pasteboard/cross-app Cmd+V remains unverified until the nightly run
- **Revisit if:** the real window's pending SC-37 fails
- **Source:** assumed — autonomous

## D6: Keep unsupported-platform native clipboard integration deferred
- **Question:** Does macOS verification establish Linux/Windows native clipboard behavior?
- **Options:** claim SDK portability; retain existing non-macOS browser clipboard behavior and defer native integration checks
- **Chose:** retain the macOS-only trusted desktop preload installation and browser fallback on other platforms; Linux/Windows native host clipboard verification is deferred
- **Why:** this item repairs macOS WKWebView, and the loop locks builds and tests to macOS. No foreign-platform native capability was introduced.
- **Evidence:** `apps/desktop/src/bun/index.ts` darwin preload/RPC condition; authoritative LOOP.md Platforms
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** native shells ship on Linux or Windows
- **Source:** deferred: platform

## D7: Treat focused read-only review as additional evidence, not native verification
- **Question:** What review and post-catch-up gates were completed?
- **Options:** infer correctness from implementer reports; request a fresh scoped review and recheck integration types
- **Chose:** a fresh read-only reviewer inspected the clipboard diff and reported no findings; post-catch-up `bun run typecheck` passed in 41.10 s
- **Why:** independent context checked the native trust boundary, non-fallback errors, browser behavior, three consumer migrations and bracketed-paste regression. Reviewer and implementers use the omp/OpenAI family, so model-family independence is reduced; this is not the full cross-family SDD review protocol and is not a native OS PASS.
- **Evidence:** ClipboardReview result: no findings, confidence 0.93, no checks run; post-catch-up typecheck exit 0 including UI lint and root/mobile/desktop projects
- **Reversibility:** easy
- **Confidence:** high for scoped source review, limited as stated
- **Revisit if:** the pending SC-37 native run reports a failure or the suite finds a clipboard regression
- **Source:** assumed — autonomous

## D8: Preserve existing end-phase failure ownership instead of expanding this native repair
- **Question:** How should the full-suite failure affect this item's native clipboard repair?
- **Options:** call the suite green; duplicate triage work and modify unrelated features; record the failed gate and preserve its existing queued area owners while landing the scoped typechecked repair
- **Chose:** disclose the failed broad suite in BLOCKERS.md, retain all existing `fix-test-*-1028` owners, and land only the specified SC-37 repair
- **Why:** the completed suite ran 853 remote files (702 pass/151 fail) and 7 macOS files (6 pass/1 fail, also failing its configured retry), exit 1 after 2284.59 s. Programmatic comparison of all 152 unique failed paths against the canonical triage report's 153 failed paths found zero new failing files; the sole absent prior failure was `plugins/quirky.handoff/test/service.test.ts`. All failures already have queued area owners. This comparison is file-level, not an assertion-by-assertion equivalence claim. The complete log has no `readClipboardText` error, and keys/pane-input/paste files are not among its failures. No failing test was suppressed, repinned, retried manually or weakened.
- **Evidence:** full suite raw `artifact://20`; canonical `docs/loop/reports/m7-test-triage.json`, baseline `97aaa12d9fdf91a966cbc78d5557e113fc9789b3`; canonical queue observed triage done and all area fix items present; `docs/loop/BLOCKERS.md` broad-suite verification receipt
- **Reversibility:** easy
- **Confidence:** high for exact failed-file ownership; individual unrelated defects remain with their repair owners
- **Revisit if:** an area repair identifies a clipboard regression or SC-37 fails its native rerun
- **Source:** assumed — autonomous

## D9: Migrate the concurrently landed editor fixture before retrying land
- **Question:** The canonical land type gate found a new `UiPluginContext` caller missing `readClipboardText`; should the public contract be weakened?
- **Options:** make the method optional; migrate the new typed fixture and retain the complete public contract
- **Chose:** merge current roadmap as required by land failure routing and add the method to `plugins/quirky.editor/test/explorer-path-actions.test.tsx` without changing its Explorer behavior
- **Why:** the first land failed safely on exactly this missing property after another lane's editor work landed. The fixture does not read the clipboard, so its existing default context now supplies an empty read result. Making the API optional would require fallback shims in every terminal consumer and would hide a missed caller migration.
- **Evidence:** canonical land attempt 1 typecheck diagnostic TS2741 at editor fixture line 187; required roadmap retry merge; fixture method addition
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** another concurrently landed typed caller is missing the required method
- **Source:** assumed — autonomous

## D10: Preserve all twelve incoming decision sets on the required retry merge
- **Question:** Does the retry merge change clipboard ownership or introduce a locked conflict?
- **Options:** silently proceed; read every incoming decision log and preserve their source and native-verification boundaries
- **Chose:** IncomingClipboardBindings read all twelve logs in full and found no binding conflict: fix-flaky-pty-host-clear, fix-flaky-quirky-worktree-create, fix-native-m2-editor-1028, fix-native-m3-accounts-1028, fix-native-m3-vault-1028, fix-native-sa-browser-agent-1028, fix-test-packages-daemon-1028, fix-test-scripts-1028, m7-terminal-owner-provisioning-and-selector-flows, m7-test-triage, sb-mobile-settings-visibility, and ui-screenshot-review
- **Why:** editor changes own copied path values, not clipboard acquisition; Vault's no-new-bridge decision concerns its separate reachability/details defects, not terminal paste. Their native scenarios remain pending. The persisted desktop installation UUID is not clipboard authority, a phone identity, or a machine identity. No guest or daemon clipboard route was introduced.
- **Evidence:** complete incoming logs and IncomingClipboardBindings handoff; retry merge's only missing caller was the editor fixture
- **Reversibility:** easy
- **Confidence:** high
- **Revisit if:** an incoming owner identifies a concrete API or trust-boundary conflict
- **Source:** assumed — autonomous

## D11: Retain exact retry-merge verification outcomes without weakening the Explorer test
- **Question:** Does a timing failure in the concurrently landed editor fixture justify changing this native clipboard repair?
- **Options:** increase its deadline or suppress the failure; report the failure and isolate the exact case once without source changes
- **Chose:** preserve all editor runtime/assertions/deadlines and record both the failed concurrent run and its successful isolated check
- **Why:** the merged clipboard keys file passed 5/0/178 in 46.63 s, UI lint/root/mobile/desktop typing passed in 64.23 s, and scripts passed 126/0/1103 in 112.33 s. The new editor file returned 2 pass/1 fail because its row-drop case exceeded 5000 ms while other checks ran; the exact case passed alone 1/0/12 in 4.29 s. This establishes different observed outcomes, not a diagnosed root cause or a no-retry full-file pass.
- **Evidence:** final keys/editor run raw `artifact://45`; scripts raw `artifact://46`; isolated editor case raw `artifact://48`; `docs/loop/BLOCKERS.md` concurrent editor-fixture timing receipt
- **Reversibility:** easy
- **Confidence:** high for exercised results, no claim about all-load stability
- **Revisit if:** the editor repair owner identifies a consumer-visible clipboard acquisition regression
- **Source:** assumed — autonomous

## Progress
Implementation and scoped verification complete. Contracts f3c329fd preceded implementation b48928eb; receipt 4ae6f086 records the failed broad suite and existing area owners. First canonical land failed safely on a concurrently landed editor fixture's missing required context method. Required retry roadmap merge completed, all twelve incoming logs were read, and that new caller was migrated. Final merged keys 5/0/178, typecheck and scripts 126/0/1103 passed; the editor file's one concurrent timing failure passed its exact isolated check without code/deadline/assertion changes (D11). Broad suite remains explicitly failed and native SC-37 pending. All agents/checks returned, owned browser closed and private smoke home removed. Ready to commit receipts, detach and retry canonical land; remove owned scratch only after success.
