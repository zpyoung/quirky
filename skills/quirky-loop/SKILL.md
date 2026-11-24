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

This discovery stub loads the version-matched guide from the Quirky executable used for this session.

Use Quirky's `loop` CLI to run an agent repeatedly in a worktree until a check or evaluator says it is
done: create until-done, interval, or queue loops, list and inspect them, pause, resume with extra
iterations, steer the next iteration, edit settings, and stop. Loops run inside the Quirky app, so they
outlive the command and the terminal tab. Start by reading the full guide before acting.

## Resolve the CLI for this session

Choose the executable once and reuse it for every later command:

- If the `QUIRKY_CLI_COMMAND` environment variable is set, use its value. Quirky exports this
  for managed WSL sessions.
- Otherwise, in a dev checkout whose session exposes `QUIRKY_DEV_REPO_ROOT`, use `quirky-dev`.
- Otherwise, on Linux outside an Quirky-managed terminal, use `quirky-ide`. Never run bare
  `quirky` there — outside Quirky's terminals it normally resolves to the
  GNOME Quirky screen reader (`/usr/bin/quirky`) and starts speech on the user's machine.
- Otherwise, use `quirky`.

Below, `QUIRKY` is a placeholder for the executable you resolved. Substitute it before
running anything; do not create a shell variable or run `QUIRKY` literally. This works the
same way in POSIX shells, PowerShell, and cmd.exe.

If the selected executable cannot run, report its exact error and stop. Do not fall through
to another executable, which could silently target a different Quirky build.

## Load the version-matched guide before running Quirky commands

```text
QUIRKY skills get quirky-loop
```

Prefer `--json`. Use the selected executable's `--help` for commands or flags the guide does
not cover. If a command reports that Quirky is not running, start it with `QUIRKY open --json`
and retry. If it fails with `runtime_access_denied`, your sandbox blocked the connection:
re-run it with escalated permissions, and do not run `QUIRKY open` or restart Quirky. If
`skills get` is unknown, explain that updating Quirky restores the guide; use `--help` for
read-only discovery and do not guess unsupported commands.
