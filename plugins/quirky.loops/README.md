# Until-done loops

`quirky.loops` runs durable background Claude or Codex work in a worktree. The daemon owns the loop, so it continues after the CLI exits. It uses native structured sessions rather than terminals or UI tabs.

Loops repeat one prompt and start the next iteration when the structured agent is idle. Completion is never inferred from an assistant's `LOOP_DONE` claim alone: at least one configured independent check or evaluator must pass. If configured, every completion signal must pass for that exact configuration.

## Defaults and safety

- The preset is `until-done`, pacing is `on-idle`, the prompt repeats, and the session policy is `fresh`.
- There is no iteration, time, or cost cap unless one is set. Consider using `--max-iterations` while developing a loop.
- No-progress pausing, checkpoint commits, ask-before-next, and resume-at-reset are off by default.
- Checks are bounded to 1–600 seconds. An evaluator is read-only, tool-disabled, and bounded; evaluator errors never count as completion.
- A claimed `LOOP_DONE` without configured evidence does not complete a loop. `LOOP_BLOCKED: <reason>` and `LOOP_DECIDE: <question>` pause for attention.
- Approval asks are surfaced as `needs-you`; loops never approve tools on the user's behalf. External messages to a bound structured session can make the guarded iteration send stale or busy, in which case the loop waits and retains its steer notes.
- Cost is reported only when the provider supplies measurable USD. If a cost cap is configured and usage is unavailable, the loop pauses rather than treating missing cost as zero.
- Protected paths are checked before checkpointing. Checkpoints include only files changed by that iteration; loop notes are excluded. Folder workspaces are supported, but do not provide git tree snapshots or checkpoint commits.
- Multiple loops may share a worktree. They can change the same files concurrently, so isolate work or use protected paths when needed.
- A daemon restart pauses active loops and marks open attempts interrupted. They resume only after an explicit `resume`; they are not silently restarted.

Queue and interval loops, UI setup/rails, remote-host execution, and tab binding are not supported.

## CLI

The plugin group is `quirky loops` with `loop` as an alias. Create a loop with a required agent and prompt; `--worktree` defaults to the current worktree:

```sh
quirky loop create --agent claude \
  --prompt "Add a checksum command and its tests." \
  --check "test -f checksum.test.ts" \
  --max-iterations 8
```

A completion check runs after each iteration by default. `--check-when on-claim` runs it only when the agent prints `LOOP_DONE` on its own line. An evaluator can also verify a condition; when both are configured, both must pass.

```sh
quirky loop create --agent codex \
  --prompt "Implement the parser and add tests." \
  --check "bun test" --check-timeout 120 \
  --check-when every-iteration \
  --evaluator "The parser handles quoted delimiters and malformed input" \
  --protected-path "fixtures/secrets/**" --max-minutes 45
```

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
quirky loop stop <loop-id> --now # interrupt the owned structured session
```

`edit` changes only supplied settings; nested check/evaluator/cap/path sections are read from the current snapshot and merged before the update. Remove optional settings with `--no-check`, `--no-evaluator`, `--no-max-iterations`, `--no-max-minutes`, `--no-max-cost`, or `--no-protected-paths`. A set flag cannot be combined with its matching removal flag.

Output is human-readable by default. The standard CLI `--json` mode returns the complete API result.

## Public API

The `quirky.loops` methods are `create`, `list`, `get`, `iterations`, `pause`, `resume`, `stop`, `steer`, and `edit`. `create` accepts the shared `LoopConfig` shape: a `repeat` prompt source, `on-idle` pacing, `fresh` or `continue` session policy, `done` check/evaluator signals, optional caps and protected paths, and the four safety booleans. The API also emits `changed` snapshots and `notification` events for the notifications policy.
