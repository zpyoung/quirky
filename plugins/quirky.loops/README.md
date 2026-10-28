# Durable loops

`quirky.loops` runs Claude or Codex work in daemon-owned background sessions and continues after the CLI exits or its view closes. Execution uses native structured sessions, not terminal panes; optional workspace tabs show the journal and loop controls without owning the agent process.

## Presets

Choose one of three loop presets:

- **Until-done** repeats one prompt whenever the agent is idle. It is the default preset and requires an independent check or evaluator to complete; an assistant's `LOOP_DONE` claim alone is not evidence.
- **Queue** sends one queued task per successful iteration. Create a queue with at least one `--queue-item`; add, edit, move, or remove items later. Queue item IDs stay stable while their zero-based positions change. The CLI uses on-idle pacing for queues; the public API can also combine a queue prompt source with interval pacing.
- **Interval** repeats one prompt. The first iteration starts immediately. Later iterations wait for the configured interval; they do not overlap or catch up missed ticks.

Queue exhaustion is a completion condition when no check or evaluator is configured. If a configured check or evaluator has not passed when the queue is exhausted, the loop pauses as `queue-exhausted`; add more work and resume it. A passing independent completion condition can complete a queue before exhaustion. If both check and evaluator are configured, both must pass.

`--ask-before-next` pauses after a completed iteration when another task is available. Each explicit `resume` approves exactly one next iteration. Queue exhaustion takes precedence, so there is no approval pause after the final task.

## Workspace UI

Open the workspace tab-bar **+** menu and choose **Loop…**, the last contributed action before the Agent settings footer. The New loop dialog offers Until done, On an interval, and Queue. It starts with a ten-iteration cap and no-progress pausing enabled; the CLI defaults below remain uncapped with no-progress off. Advanced contains completion checks, evaluator conditions, budgets, protected paths and iteration safety options. Folder workspaces do not offer checkpoint commits.

Starting a loop opens its view in a background tab without changing the active tab. Open that tab to read the structured journal beside the Loop rail, or below it in a narrow workspace. The rail shows state, pause reason, progress, check results and retained iteration evidence. Pause waits until the current iteration finishes; Resume can add iterations at a cap. Steer queues guidance for the next prompt. Edit changes subsequent iterations, and queue controls cannot alter an in-progress item.

Running conversations use the live structured journal. Settled fresh-session and ended loops show labelled saved iteration output from the loop's durable evidence, so normal session cleanup does not erase the visible result. Saved output is not a live connection.

Closing a running or needs-you loop tab offers Cancel, Stop loop, or Keep running. Keep running removes only the view; Stop loop stops the loop before closing its tab, even if it paused after the dialog opened. A failed close leaves the tab open. Closing a paused/ended view without choosing Stop, or bulk-closing tabs, does not stop the background loop.

All view actions have declared commands under `command:quirky.loops/`: `new`, `setup-action`, `open`, `action`, `close-tab`, and `close-choice`. `quirky ui state --json` reports setup drafts, validation, active rail forms, iteration details and the close choice alongside the workspace layout. The `quirky loop ui` CLI group exposes the same commands; use `--payload` for action parameters.

For example, open a loop through the window bridge:

```sh
quirky ui run command:quirky.loops/open --args '{"loopId":"<loop-id>"}'
```


## Defaults and safety

- In the CLI, `until-done` uses `on-idle` pacing and `fresh` sessions by default; `queue` and `interval` use `continue`. All presets accept an explicit `--session fresh` or `--session continue`.
- CLI loops have no iteration, time, or cost cap unless one is set. Consider using `--max-iterations` while developing a loop.
- In the CLI, no-progress pausing, checkpoint commits, ask-before-next, and resume-at-reset are off by default.
- Checks are bounded to 1–600 seconds. An evaluator is read-only, tool-disabled, and bounded; evaluator errors never count as completion.
- `LOOP_BLOCKED: <reason>` and `LOOP_DECIDE: <question>` pause for attention. Approval asks are surfaced as `needs-you`; loops never approve tools on the user's behalf.
- External messages to a bound structured session can make a guarded iteration send stale or busy. The loop waits and retains its steer notes.
- Cost is reported only when the provider supplies measurable USD. If a cost cap is configured and usage is unavailable, the loop pauses rather than treating missing cost as zero.
- Protected paths are checked before checkpointing. Checkpoints include only files changed by that iteration; loop notes are excluded. Folder workspaces are supported, but do not provide git tree snapshots or checkpoint commits.
- Multiple loops may share a worktree and can change the same files concurrently. Isolate work or use protected paths when needed.
- A daemon restart pauses active loops and marks open attempts interrupted. Resume them explicitly; they do not restart or catch up automatically.

## CLI

The plugin group is `quirky loops`; `loop` is an alias. The default loop name is `<agent> <preset>`, and `--worktree` defaults to the current worktree.

Create an until-done loop with a required agent and prompt:

```sh
quirky loop create --agent claude \
  --prompt "Add a checksum command and its tests." \
  --check "test -f checksum.test.ts" \
  --max-iterations 8
```

A completion check runs after each iteration by default. `--check-when on-claim` runs it only when the agent prints `LOOP_DONE` on its own line. An evaluator can also verify a condition; when both are configured, both must pass.

Create a queue by repeating `--queue-item`. Queue loops continue the structured session by default and use on-idle pacing in the CLI:

```sh
quirky loop create --agent codex --preset queue \
  --queue-item "Implement the parser." \
  --queue-item "Add parser tests." \
  --ask-before-next
```

Use `--repeat-queue` to repeat completed items after a cycle; it defaults to false. Create a queue with at least one item; queues can become empty later when items are removed. If no check or evaluator is configured, exhaustion completes the loop. If a configured check or evaluator has not passed, exhaustion pauses the loop as `queue-exhausted`.

Queue changes use stable item IDs and absolute zero-based final positions:

```sh
quirky loop queue <loop-id> add "Add a parser test." --position 0
quirky loop queue <loop-id> edit <item-id> "Update the parser test."
quirky loop queue <loop-id> move <item-id> 0
quirky loop queue <loop-id> remove <item-id>
```

`add` appends by default; `--position 0` inserts at the start. Add positions range from zero through the current queue length; move positions range from zero through the last current index. There is no clamping. Done items remain editable, movable, and removable; an in-flight item cannot be edited, moved, or removed.

Create an interval loop with a repeated prompt and a positive whole-number interval in minutes:

```sh
quirky loop create --agent claude --preset interval \
  --prompt "Review the service dashboard." \
  --every 60 --anchor wall-clock
```

The first iteration starts immediately. `from-end` is the default anchor and schedules from the last settled iteration's end. `wall-clock` uses loop creation time as its epoch. Ticks that pass during an iteration are skipped and counted, never queued for catch-up; a delayed driver starts at most one due iteration. Pausing does not accumulate a backlog. Interval loops continue the structured session by default.

`--every` and `--anchor` apply only to the interval preset. `--queue-item` and `--repeat-queue` apply only to the queue preset. Queue creation requires queue items and rejects `--prompt`; interval creation requires `--prompt` and `--every`. Both presets reject conflicting flags before a loop starts.

Useful lifecycle commands:

```sh
quirky loop list
quirky loop show <loop-id>
quirky loop iterations <loop-id>
quirky loop pause <loop-id>
quirky loop resume <loop-id> --add-iterations 3
quirky loop steer <loop-id> "Preserve the public API and add a regression test."
quirky loop edit <loop-id> --prompt "Updated repeated task" --check "bun test"
quirky loop stop <loop-id>       # finish the current iteration
quirky loop stop <loop-id> --now # interrupt the owned structured turn
```

`edit` changes only supplied settings; nested check, evaluator, cap, and path sections are preserved. Remove optional settings with `--no-check`, `--no-evaluator`, `--no-max-iterations`, `--no-max-minutes`, `--no-max-cost`, or `--no-protected-paths`. A set flag cannot be combined with its matching removal flag. `--repeat-queue` is queue-only; `--every` and `--anchor` are interval-only. `--repeat-queue=false` and `--ask-before-next=false` explicitly turn those settings off. Editing one interval field preserves the other. Show and list include the next iteration deadline in ISO format and nonzero skipped-tick counts; show also lists queue item IDs, positions, bodies, and states.

Output is human-readable by default. The standard CLI `--json` mode returns the complete API result.

## Public API

The `quirky.loops` methods are `create`, `list`, `get`, `iterations`, `pause`, `resume`, `stop`, `steer`, `edit`, and `queue`. `create` accepts the shared `LoopConfig` shape: a repeat or queue prompt source, on-idle or interval pacing, optional `fresh` or `continue` session policy, done check/evaluator signals, optional caps and protected paths, and the safety booleans. If session policy is omitted, until-done defaults to `fresh`, while queue and interval default to `continue`. Until-done requires a repeat prompt with on-idle pacing; interval requires a repeat prompt with interval pacing; queue requires a non-empty seed list and a queue prompt source. Queue prompt source and pacing are independent in the API. The `queue` method takes a strict `QueueOperation` and returns the updated snapshot. The API also emits `changed` snapshots and `notification` events for the notifications policy.

The preset and prompt-source kind stay immutable after creation. The public `edit` method can switch `pacing` between `{"kind":"on-idle"}` and `{"kind":"interval","minutes":1,"anchor":"from-end"}` independently of the preset; changing back to on-idle wakes an eligible waiting iteration. Creation validation stays strict, and the CLI's `--every`/`--anchor` flags remain restricted to the interval preset.
