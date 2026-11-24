# Quirky Ledger

This discovery stub loads the version-matched guide from the Quirky executable used for this session.

Engage Quirky's ledger CLI (`quirky ledger ...`) whenever an engineering observation needs to
outlive the current worktree: file a bug, deferred item, test gap, proposal, or decision;
list, show, and triage what is already recorded; edit content or change lifecycle state
under an optimistic revision precondition; revert to an earlier revision; and import legacy
BUGS.md, DEFERRED.md, TEST_BACKLOG.md, proposals.md, and docs/adr files. Ledgers live in the
Quirky profile rather than the git checkout, so entries survive worktree deletion and stay
visible to sibling worktrees of the same project.

<!-- shared: resolver -->

## Load the version-matched guide before running Quirky commands

```text
QUIRKY skills get quirky-ledger
```

<!-- shared: no-guessing -->
