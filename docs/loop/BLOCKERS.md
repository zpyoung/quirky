# Blockers

Items the build loop couldn't finish. Each entry names the item, the step it stopped at, the
evidence, what was tried, and what a person needs to decide or fix. The work is on `blocked/<id>`.

## m0-core: open review findings

Final Round 1's fix batch closed every finding with a test except the one below, which it closed only in part.

- **HIGH, D21/SC-35/SC-38, `plugins/quirky.session/src/window/model.ts:224`:** a session view whose daemon input carries no `session` picks its active tab from window memory (`lastActiveByWorktree`), so a fresh window can show a different tab than the old one did. Any tab selection, new session or close now writes the session into the daemon's view input, so the gap is only a view opened with `{worktree}` alone and never switched since. Closing it means publishing the picked session through `openView` on mount when the input has none. That adds one layout write per such mount and changes a test that expects no `openView` there. Found by Final Round 1, spec lens (scratchpad fr1-P/S/gate.json, S1).
  - **Closed at the M0 gate in `3bec5ae`:** the view now publishes the tab it picked through `openView` once, with a test that a fresh window shows the same tab.
