---
name: quirky-ask
description: >-
  Use `quirky ask` to ask the user a question and block until they answer it —
  select/multiselect/text/number/date/confirm questions with a structured JSON
  answer envelope back, for a genuine human decision the agent cannot
  determine by reading code, config, or tests. Not for permission to proceed,
  and not the same as `quirky orchestration ask` (worker-to-coordinator agent
  messaging inside an orchestration run — see the quirky-orchestration skill for
  that). Triggers include "quirky ask", "ask the user", "ask a question and
  wait for the answer", or needing the user to choose between options,
  confirm a decision, or supply a non-secret value.
---

# Quirky Ask

This file is a discovery stub, not the usage guide. The full, version-matched Quirky ask
reference is served by the `quirky` binary itself — kept out of this file on purpose so it
can never drift from the binary that will actually run your commands.

Engage `quirky ask` whenever you need a genuine human decision you cannot determine by
reading code, config, or tests — not for permission to proceed, and not the same as
`quirky orchestration ask`, which is worker-to-coordinator agent messaging inside an
orchestration run (see the quirky-orchestration skill for that). Triggers include "quirky ask",
"ask the user", "ask a question and wait for the answer", or needing the user to choose
between options, confirm a decision, or supply a non-secret value.

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
QUIRKY skills get quirky-ask
```

That prints the complete, version-matched guide for the exact binary that will handle your
next commands — the register/wait/cancel commands, the register → wait loop, exit codes,
the question schema, escape hatches, credential refusal, and answer shapes. Read it first,
then run the specific command you need.

There is no safe read-only substitute for `ask` itself — registering one is a real,
user-visible side effect, and an older binary may not have the command at all. Do not
fall back to `quirky orchestration ask`; it is a different tool for worker-to-coordinator
messaging, not for asking the human user.

Prefer `--json`. Use the selected executable's `--help` for commands or flags the guide does
not cover. If a command reports that Quirky is not running, start it with `QUIRKY open --json`
and retry. If it fails with `runtime_access_denied`, your sandbox blocked the connection:
re-run it with escalated permissions, and do not run `QUIRKY open` or restart Quirky. If
`skills get` is unknown, explain that updating Quirky restores the guide; use `--help` for
read-only discovery and do not guess unsupported commands.
