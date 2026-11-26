---
name: quirky-heimdall
description: >-
  Use `quirky heimdall ...` to observe and manage durable Heimdall watchers: list the fleet,
  inspect status, escalations, workers, plans, and debug reports; create objective or
  hosted-review watchers; approve gated actions; answer worker or owner questions; adjust
  budgets and concurrency; and pause, resume, disarm, or permanently remove a watcher. Use
  when the user says "quirky heimdall", "Heimdall watcher", "watcher fleet", "PR sitter",
  or asks to create, inspect, steer, or stop an objective or hosted-review watcher.
---

# Quirky Heimdall

This discovery stub loads the version-matched guide from the Quirky executable used for this session.

Use Quirky's `heimdall` CLI to observe and manage the watcher fleet: list and inspect watchers,
create objective or hosted-review watchers, approve or answer escalations, adjust budgets, steer
workers, pause, resume, disarm, or remove a watcher. Management commands can target remote-owned
watchers through the fleet row's recorded owner; create enrolls only on a workspace local to the
selected runtime, so connect directly to another owner rather than relying on a fallback. Start by
reading the full guide before acting.

## Resolve the CLI for this session

Choose the executable once and reuse it for every later command:

- If the `QUIRKY_CLI_COMMAND` environment variable is set, use its value.
- Otherwise, in a dev checkout whose session exposes `QUIRKY_DEV_REPO_ROOT`, use `quirky-dev`.
- Otherwise, use `quirky`.

Below, `QUIRKY` is a placeholder for the executable you resolved. Substitute it before
running anything; do not create a shell variable or run `QUIRKY` literally.

If the selected executable cannot run, report its exact error and stop. Do not fall through
to another executable, which could silently target a different Quirky build.

## Load the version-matched guide before running Quirky commands

```text
QUIRKY skills get quirky-heimdall
```

Prefer `--json`. Use the selected executable's `--help` for commands or flags the guide does
not cover. If a command reports that Quirky is not running, start it with `QUIRKY open --json`
and retry. If it fails with `runtime_access_denied`, your sandbox blocked the connection:
re-run it with escalated permissions, and do not run `QUIRKY open` or restart Quirky. If
`skills get` is unknown, explain that updating Quirky restores the guide; use `--help` for
read-only discovery and do not guess unsupported commands.
