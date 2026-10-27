# Blockers

Items the build loop couldn't finish. Each entry names the item, the step it stopped at, the
evidence, what was tried, and what a person needs to decide or fix. The work is on `blocked/<id>`.

## m0-core: open review findings

Final Round 1's fix batch closed every finding with a test except the one below, which it closed only in part.

- **HIGH, D21/SC-35/SC-38, `plugins/quirky.session/src/window/model.ts:224`:** a session view whose daemon input carries no `session` picks its active tab from window memory (`lastActiveByWorktree`), so a fresh window can show a different tab than the old one did. Any tab selection, new session or close now writes the session into the daemon's view input, so the gap is only a view opened with `{worktree}` alone and never switched since. Closing it means publishing the picked session through `openView` on mount when the input has none. That adds one layout write per such mount and changes a test that expects no `openView` there. Found by Final Round 1, spec lens (scratchpad fr1-P/S/gate.json, S1).
  - **Closed at the M0 gate in `3bec5ae`:** the view now publishes the tab it picked through `openView` once, with a test that a fresh window shows the same tab.

## m1-term-ui: the single-process test suite is close to running out of file descriptors
- **Severity:** medium (it will start failing land again as tests are added)
- **What:** under `bun test` (Bun 1.4.0), every dynamic `import()` of a module from a path not imported before keeps about four file descriptors open until the process exits. In-process daemon harnesses (`packages/daemon/test/helpers.ts` `startHarness` with a per-test `builtinPluginsDir`, as in `plugins/quirky.session/test/support.ts`, `plugins/quirky.worktree/test/`, `packages/daemon/test/`) import each plugin's `main.ts` from a fresh temp path on every start. After enough starts, `posix_spawn` fails with `EBADF` for the rest of `bun run test` (177 failures at the m1-term-ui catch-up merge).
- **Done here:** `plugins/quirky.terminal/test/support.ts` now reuses one built-in directory per process (D51), which brought the suite back under the limit.
- **A person should decide:** either make `queue.ts land` / `bun run test` run each package or plugin in its own `bun test` process (`scripts/build-loop/` and the root `package.json` script), or move the other harnesses to shared built-in directories the same way.

## m1-term-ui: open review findings
The item landed with these low-severity findings from the like-a-user pass and the fix workers left open. None breaks a scenario.

- **LOW, Settings dialog:** Save and Cancel scroll with the form instead of staying pinned, so on a short window you scroll to the bottom to reach them (`packages/ui/src/styles.css` `.dialog`, which now scrolls; D56). Found in runs/20261027T101826-fd23 (obs-31, obs-32).
- **LOW, focus after Settings closes:** keyboard focus doesn't go back to the terminal pane, so typing is lost until the pane is clicked. Found in runs/20261027T100045-4ea7 (obs-118).
- **LOW, narrow tab area:** with the Quick Commands side panel open at 1280 px, the header buttons wrap and Questions overlaps the Worktree title, and a third tab shrinks to a dot under the + and quick-command buttons. Found in runs/20261027T100045-4ea7 (obs-37, obs-52, obs-54).
- **LOW, test fragility:** the final fix batch's worker reported that the quick-commands window tests sharing `plugins/quirky.terminal/test/window/qc-support.tsx` depend on the order the test files run in. The gate has never failed on it.

## m2-editor: open review findings

The user authorized a core-flow landing and a dependent completion item under the 2026-10-27 operator deadline (m2-editor D25). These are not claims that every original SC-1–22 scenario is complete.

- **MEDIUM — rich details/toggle serialization, `plugins/quirky.editor/src/markdown/service.ts:138,217-221`:** actual `<details>` content, including empty details, and `details`/`collapsibleHeading` inserts cannot yet be losslessly round-tripped by the rich editor. The current contract fails closed to Source or rejects the edit without changing the draft; sanitized preview and math remain supported. Complete the rich representation and byte-preservation tests before enabling it.
- **MEDIUM — document-link insertion, `plugins/quirky.editor/src/markdown/DocumentLink.ts:1`:** the SC-13 RPC trace reaches `insert:documentLink` after the core formatting/table/math/emoji cases pass, then rejects parsing safely. Relative-link resolution/navigation remains separate. Finish the custom-node insertion/serialization round trip and its UI completion path.
- **MEDIUM — untitled creation and Save As, `plugins/quirky.editor/src/daemon/service.ts:284`:** public creation currently produces named files, not untitled buffers. Retarget is therefore not published as a supported Markdown action. Add a real untitled creation/lifetime path before exposing Save As/retarget; closing a named file must not delete it.
- **LOW — filesystem permission UX, `plugins/quirky.editor/src/daemon/service.ts:284`:** the current read-only capability is not a tested policy for Unix mode bits/ACLs. The chmod-only annotation expectation was removed rather than redefining permissions through a test. Specify and verify permission-aware indicators and annotation/save behavior.
- **MEDIUM — return from rendered Preview, `plugins/quirky.editor/src/window/DocumentSurface.tsx:813`:** the visible Rich Editor control did not leave the separate Preview tab on two observed attempts. The original edit tab remains an alternate route. Evidence: browser run `20261027T195525-588b`, F35, obs-65–67.
- **MEDIUM — own-draft warning, `plugins/quirky.editor/src/window/SourceEditor.tsx:450-452` and `plugins/quirky.editor/src/window/DocumentSurface.tsx:285-286`:** a single-window edit/undo can show the newer-shared-draft warning. Local text was preserved and saved edits survived reopening; the observed warning path is not established to be a second writer. Distinguish own asynchronous acknowledgments from genuine peer conflicts. Evidence: the same run, F34/F36 and obs-53/59/62/63.
- **HIGH — verification configuration incident, `docs/loop/decisions/m2-editor.md:234-243` (D22):** an early in-process smoke inherited the real HOME and the hook installer logged writes to six real configuration paths. No trustworthy before-image was available, so a blind uninstall/restore was not attempted. Future runs now preseed hooks off and isolate HOME/QUIRKY_HOME, including remote test children. Reconcile the six paths against an independent baseline if one becomes available; do not assume generic Quirky markers identify this run.

### Completion-flow acceptance

The dependent item must finish the following end-to-end verification, which was not completed in this landing pass:

- **SC-3–6:** mixed close-all save failures; Compare/Keep/Reload/Overwrite dialogs; autosave holds through unmount/restart; deleted-file recovery and inactive atomic-replacement UI. Daemon safety paths have integration coverage; the complete GUI sequence remains to run.
- **SC-7–11:** Explorer keyboard/range selection, ignored/symlink states, create/rename/move/duplicate/delete with undo/redo, path copy, web import/collision and terminal drag; quick-open recency/line targeting and regex/filter/truncation search UI. Core open/save/quick-open/search were observed; the exhaustive variants were not.
- **SC-13–15:** slash/IME/table keyboard controls, rich math/Mermaid/emoji/image paste/drop, document-link completion, TOC/frontmatter controls, template creation and PDF export dialogs, and successful review-note delivery through the GUI. API coverage is not a substitute for these renderer interactions.
- **SC-17–18:** successful consent-mediated install/venv and PEP-668/ensurepip guidance in a disposable environment; GUI kernel choice/trust, rich output sanitization and unexpected-kernel-death recovery. Real kernel execution, trust revocation and process cleanup were exercised through the API; package installation was not performed.
- **SC-19–22:** full CSV clipboard/row/column/large-page workflows; PDF search/page-width and codec/default-app/audio/video seeking; every rebound shortcut, copy-context, and disable/remount lifecycle across focused groups. Basic viewer rendering/save is a separate smoke gate, not proof of this matrix.

Physical Finder import remains a pending native SC-9 scenario. Open-in-place belongs only to the operator-owned `m4-editor-drop-open-in-place`; this entry does not add another such item.
