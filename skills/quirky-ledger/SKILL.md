---
name: quirky-ledger
description: >-
  Use Quirky's ledger CLI through `quirky ledger ...` commands to keep a durable,
  typed record of engineering observations on a project or group: file a bug,
  deferred item, test gap, proposal, or decision with `quirky ledger file
  --type`, list and show entries with their revision and history, edit
  content or change lifecycle state under an optimistic `--if-revision`
  precondition, revert to an earlier revision, triage what is unreviewed or
  stale with `quirky ledger review --json`, and pull legacy BUGS.md,
  DEFERRED.md, TEST_BACKLOG.md, proposals.md, and docs/adr files in with
  `quirky ledger import --json`. Use when the user says "quirky ledger", "ledger
  entry", "file it in the ledger", "log this in the ledger", "ledger review",
  "ledger triage", "ledger import", or asks about a stale-revision conflict on
  a ledger entry. The ledger lives in the Quirky profile, not the git checkout,
  so entries survive worktree deletion and stay visible to sibling worktrees
  of the same project.
---

# Quirky Ledger

This discovery stub loads the version-matched guide from the Quirky executable used for this session.

Engage Quirky's ledger CLI (`quirky ledger ...`) whenever an engineering observation needs to
outlive the current worktree: file a bug, deferred item, test gap, proposal, or decision;
list, show, and triage what is already recorded; edit content or change lifecycle state
under an optimistic revision precondition; revert to an earlier revision; and import legacy
BUGS.md, DEFERRED.md, TEST_BACKLOG.md, proposals.md, and docs/adr files. Ledgers live in the
Quirky profile rather than the git checkout, so entries survive worktree deletion and stay
visible to sibling worktrees of the same project.

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
QUIRKY skills get quirky-ledger
```

Prefer `--json`. Use the selected executable's `--help` for commands or flags the guide does
not cover. If a command reports that Quirky is not running, start it with `QUIRKY open --json`
and retry. If it fails with `runtime_access_denied`, your sandbox blocked the connection:
re-run it with escalated permissions, and do not run `QUIRKY open` or restart Quirky. If
`skills get` is unknown, explain that updating Quirky restores the guide; use `--help` for
read-only discovery and do not guess unsupported commands.
