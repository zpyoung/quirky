# Quirky Ask

This file is a discovery stub, not the usage guide. The full, version-matched Quirky ask
reference is served by the `quirky` binary itself — kept out of this file on purpose so it
can never drift from the binary that will actually run your commands.

Engage `quirky ask` whenever you need a genuine human decision you cannot determine by
reading code, config, or tests — not for permission to proceed, and not the same as
`quirky orchestration ask`, which is worker-to-coordinator agent messaging inside an
orchestration run (see the orchestration skill for that). Triggers include "quirky ask",
"ask the user", "ask a question and wait for the answer", or needing the user to choose
between options, confirm a decision, or supply a non-secret value.

<!-- shared: resolver -->

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

<!-- shared: no-guessing -->
