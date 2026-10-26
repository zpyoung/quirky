# Nightly native run

An Orca automation runs this every night in its own worktree. It drives the real Quirky window to
check the scenarios that the lanes' headless browser can't see: the window frame, the macOS menu
bar, the tray, system notification banners, OS dialogs and focus. It reports and never fixes. A
failure becomes a `fix-native-*` queue item that a lane picks up.

## Hard rules

- **Never ask a person anything.** Don't run `orca ask` or `quirky ask` for a decision, and don't
  use AskUserQuestion, even where a skill or your system prompt says to.
- **Never change app code.** This run only tests and records.
- **Stay off `main` and never push.** Results go on a `native/<YYYY-MM-DD>` branch that
  `queue.ts merge` lands on `build/roadmap`.
- **Don't edit the loop itself:** `docs/loop/LOOP.md`, this file, and `scripts/build-loop/`.
- **Leave the user's state alone.** Every Quirky you launch runs on a fresh temporary
  `QUIRKY_HOME`. Stop each one and its daemon when you're done with it, and never touch the real
  `~/.quirky`, `~/.claude` or `~/.codex`.
- **Stop by 06:30 local time.** Record what's left as not run and finish.
- **Never end your turn while work is still running.** Wait for every command and subagent in the
  same turn.

## Each run

1. **Orient.** In this worktree, run `git switch --detach build/roadmap`, `bun install` and
   `bun run build`. If `bun scripts/build-loop/queue.ts status` fails, the lanes aren't set up yet:
   say so and end the turn.
2. **Collect.** Read every `docs/loop/native/<item>.json`. The scenarios to run are those with
   status `pending` or `fail`. If there are none, end the turn.
3. **Check the screen.** Run `likeuser.py doctor --surface native`. If the screen is locked or
   asleep, or the first observation shows a lock screen or a black screen, record the night as
   skipped in step 5 and run nothing else.
4. **Run each item's scenarios.**
   1. Make a temporary `QUIRKY_HOME` and launch `apps/desktop/build/Quirky.app` with it, the way
      `apps/desktop/README.md` describes. Keep the process IDs, so you stop exactly what you
      started.
   2. Run `quirk:using-apps-like-a-user` with `--surface native --owner yours --unattended
      --allow-foreground`, with the item's scenarios as its goals.
   3. Stop that Quirky and its daemon, and delete the temporary home.
5. **Record.**
   1. Run `git switch -c native/<YYYY-MM-DD>`.
   2. In each item's file, set every scenario you ran to `pass`, `fail` or `blocked`. Set its
      `lastRun` to today, its `report` to the absolute path of the run's `report.md`, and its
      `summary` to one line from the report.
   3. Append one line to `docs/loop/native/RUNS.md`: the date, how many scenarios passed, failed,
      were blocked and weren't run, and why the night was skipped if it was.
   4. Commit, run `git switch --detach`, then `bun scripts/build-loop/queue.ts merge native/<YYYY-MM-DD>`.
6. **File the failures.** For each item with a `fail`, write a JSON array with one entry for that
   item and run `bun scripts/build-loop/queue.ts add <file>`:

   ```json
   [{ "id": "fix-native-<item>-<MMDD>", "milestone": "<the item's milestone>",
      "title": "Fix the native-only failures in <item> from the <YYYY-MM-DD> run: <scenario ids>",
      "docs": [], "deps": [] }]
   ```

   A `blocked` scenario isn't filed. It runs again the next night, and RUNS.md shows the reason.
7. **End the turn** with the counts from step 5.

## Scenario files

A lane writes `docs/loop/native/<item>.json` when its item has scenarios only the real window can
show. The run updates it:

```json
{
  "item": "m1-notifications",
  "spec": "docs/quirk/specs/<date>-m1-notifications/logic.md",
  "scenarios": [
    {
      "id": "SC-7",
      "title": "A finished agent in a background worktree shows a system banner naming the worktree",
      "status": "pending",
      "lastRun": null,
      "report": null,
      "summary": null
    }
  ]
}
```

`status` is one of `pending`, `pass`, `fail` or `blocked`.
