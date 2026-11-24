---
name: quirky-loop
description: >-
  Use `quirky loop ...` to run an agent harness repeatedly in a worktree until a check command or
  evaluator condition says the work is done: create until-done, interval, or queue loops; list and
  inspect them; pause, resume (optionally granting more iterations), steer, edit, and stop. Use when
  the user says "quirky loop", "run the agent in a loop", "keep going until the tests pass",
  "babysit this PR every N minutes", or asks to queue several prompts for an agent in order.
---

# Quirky Loop

A loop sends one prompt per iteration to an agent in a terminal tab, waits for the agent to go idle,
then decides whether the work is done. The Quirky app owns the loop, so it keeps running after the
command returns and after its tab closes. Use the CLI as a **create → observe → adjust** cycle.

`QUIRKY` is a placeholder for the executable you resolved in the stub. Substitute it before running
commands; do not create a shell variable or run `QUIRKY` literally. Prefer `--json` when an agent
needs to read the result; it prints the standard Quirky CLI envelope. Every loop command requires a
runtime that advertises `loops.v1` and fails with `incompatible_runtime` otherwise, so update or
restart Quirky when you see that error.

## Create a loop

```text
QUIRKY loop create --agent <agent> [--worktree <selector>] [--name <name>]
  [--preset until-done|interval|queue]
  (--prompt <text> | --queue-item <text> ...) [--repeat-queue]
  [--every <minutes>] [--anchor from-end|wall-clock] [--session fresh|continue]
  [--check <command>] [--check-timeout <seconds>] [--check-when every-iteration|on-claim]
  [--evaluator <condition>]
  [--max-iterations <n>] [--max-minutes <n>] [--max-cost <usd>]
  [--no-progress] [--protected-path <glob> ...] [--checkpoint-commits]
  [--ask-before-next] [--resume-at-reset] [--json]
```

`--worktree` defaults to the current worktree (or folder workspace). `--name` defaults to
`<agent> <preset>`.

| Preset                 | Prompt                                  | Pacing                                           | Session default |
| ---------------------- | --------------------------------------- | ------------------------------------------------ | --------------- |
| `until-done` (default) | `--prompt`, repeated                    | next iteration starts when the agent goes idle   | `fresh`         |
| `interval`             | `--prompt`, repeated                    | every `--every` minutes, measured per `--anchor` | `continue`      |
| `queue`                | one `--queue-item` per prompt, in order | when the agent goes idle                         | `continue`      |

- `--anchor from-end` (default) counts the interval from the end of the previous iteration.
  `wall-clock` follows a fixed schedule and skips a tick that lands mid-iteration.
- `--repeat-queue` restarts a queue after its last item; without it the queue ends the loop.
- `--session` overrides the preset's default. Fresh sessions start from the notes file and the
  iteration header, so write prompts that do not rely on earlier conversation.
- `--protected-path <glob>` is repeatable.
- Switches default to off and also accept `--switch=false`. Put positional ids before bare
  switches on `edit` so the id is not read as a switch value.

### Choose the done signal

The agent printing `LOOP_DONE` on its own line is only a claim. The loop completes when every configured signal passes:

- `--check <command>` runs on the loop's host (exit 0 is a pass). `--check-when on-claim` runs it
  only after the agent claims done; the default runs it after every iteration. `--check-timeout`
  is 1 to 600 seconds, default 300.
- `--evaluator <condition>` has an evaluator model judge the condition against the iteration.
- With both set, both must pass. With neither, only caps, pauses, and `stop` end the loop.

Prefer a machine-checkable `--check`. Add an evaluator for what a command cannot see, such as
"no tests were skipped or weakened".

### Set limits

No `--max-*` flag means no cap on that measure, so set at least one for unattended runs.
`--max-iterations`, `--max-minutes` (running time only, not time paused or waiting on you), and
`--max-cost` are checked between iterations and never interrupt one in flight. `--no-progress`
pauses after 3 consecutive iterations with no git change and identical check output.
`--protected-path` pauses a loop whose iteration touches a matching path. `--checkpoint-commits` commits
after each iteration. `--ask-before-next` pauses after every iteration until you resume.
`--resume-at-reset` resumes automatically when a usage limit resets.

### Examples

```text
QUIRKY loop create --agent claude --prompt "Fix the failing tests" --check "pnpm test" --max-iterations 10
QUIRKY loop create --agent codex --preset interval --every 10 --prompt "Check the PR and fix CI" --check "gh pr checks" --max-minutes 480
QUIRKY loop create --agent claude --preset queue --queue-item "Add the endpoint" --queue-item "Write its tests"
```

## Observe

```text
QUIRKY loop list [--worktree <selector>] [--json]
QUIRKY loop show <loopId> [--json]
```

- `list` shows every loop, or one worktree's loops with `--worktree`: id, name, preset, agent,
  status, and iterations against the iteration cap.
- `show` adds the pause reason and detail, the current iteration phase, the next scheduled
  iteration, the agent's `LOOP_BLOCKED: <reason>` or `LOOP_DECIDE: <question>` message, warnings, and the latest iterations.

Loop status is one of `running`, `needs-you`, `paused: <reason>`, `completed`, `stopped`. Only a
passing done signal produces `completed`; every other non-user stop is a resumable pause.
`needs-you` means the agent is blocked on a permission or prompt that a person must answer in its
tab; the loop never answers for the agent and never types over a person. An `unverifiable`
pause means the host connection dropped; that is not evidence the agent exited.

## Adjust

```text
QUIRKY loop pause <loopId> [--json]
QUIRKY loop resume <loopId> [--add-iterations <n>] [--json]
QUIRKY loop stop <loopId> [--now] [--json]
QUIRKY loop steer <loopId> <text> [--json]
QUIRKY loop edit <loopId> [setting flags] [--json]
```

- `pause` holds the loop after the current iteration finishes.
- `resume` continues a paused loop. For a loop paused at its iteration cap, `--add-iterations N`
  raises the cap by N. Read the pause reason with `show` first: resuming without changing what
  caused it can pause the loop again.
- `stop` ends the loop after the current iteration. `--now` aborts the iteration in flight. A
  stopped loop cannot be resumed, so prefer `pause` when you may continue.
- `steer` adds a note to the next iteration's prompt. It is delivered once.
- `edit` takes the same setting flags as `create` (not `--worktree`, `--agent`, `--preset`, or
  `--queue-item`) and changes only the settings you pass. Changes apply from the next iteration.
  Quote values containing spaces.
- `edit` can also remove optional settings: `--no-check`, `--no-evaluator`,
  `--no-max-iterations`, `--no-max-minutes`, `--no-max-cost`, and `--no-protected-paths`. A
  removed cap means no limit on that measure. Combining one with its setting flag (for example
  `--no-check` with `--check`) is a usage error.

## Things to avoid

- Do not poll `show` in a tight loop; iterations take minutes. Check at the pacing of the loop.
- Do not use a loop for work that has no machine-checkable or evaluator-checkable end; use an
  interval loop with a time or cost cap instead.
- Several loops in one worktree can edit the same tree; start a second one only deliberately.
