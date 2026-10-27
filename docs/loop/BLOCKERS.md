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
