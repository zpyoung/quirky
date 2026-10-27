# Built-in plugins

This directory holds Quirky's built-in plugins, one per subdirectory, each with a `quirky-plugin.json` manifest. The daemon finds it through `QUIRKY_BUILTIN_PLUGINS_DIR`.

## GitHub hosting

`quirky.hosting` provides GitHub's API and generated `quirky hosting` commands. It
uses the installed `gh` CLI and has no UI surface. Run commands from a registered
Git workspace, or select one with `--worktree`.

```sh
quirky hosting repository --json
quirky hosting review --number 7 --json
quirky hosting --help
```

`review` returns a lookup envelope: `kind` distinguishes a found review, no review,
and an unavailable lookup. A found review is under `review`; its `headRefOid` is
the commit required by `merge --expected-head`. Merge also requires `--number`,
`--method` (`squash`, `merge`, or `rebase`), and `--action` (`direct` or `queue`).
It requests confirmation unless `--yes` authorizes the action. With asks disabled,
the call fails closed; a changed head is refused even with `--yes`. People and
plugin callers use the same `quirky.hosting/merge` implementation.

A present, empty provider review decision is `NONE`; unavailable review metadata
is `UNKNOWN`. Ordinary PRs without required approvals can merge with `NONE`, but
unknown safety data still blocks merging.

Project-item edits and comment updates do not prompt. Deleting a project-item
comment uses the same kernel confirmation rule as merge; authorize it with
`--yes` or an answered confirmation. `project-item-mutation-confirmation` previews
that deletion without changing data. Issue-type actions currently require an
organization-owned project; support for user-owned projects is tracked separately.

`gh` owns credentials. Normal requests use its ambient login or a repository's
configured keyring-account binding; a failed binding never falls back to another
account. Projects v2 uses the ambient login, not that binding. Enterprise hosts
must appear in the local `gh auth status` inventory.

The command group also exposes PR creation and stacks, checks and logs, comments
and review actions, file contents, issues, work-item searches, Projects v2, and
connection-owned refreshes. Use `quirky api --json` for the live method, parameter,
result, and event contracts. Fixed-cap reads report truncation, partial results, or a limit error;
only work-item search exposes client `--page` and `--limit`.
