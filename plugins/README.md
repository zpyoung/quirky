# Built-in plugins

This directory holds Quirky's built-in plugins, one per subdirectory, each with a `quirky-plugin.json` manifest. The daemon finds it through `QUIRKY_BUILTIN_PLUGINS_DIR`.

## Session Info

`quirky.session-info` contributes the **Session Info** right-column panel and the
`quirky session-info` CLI group. The panel follows the focused main or floating terminal pane.
Shells and nonterminal views show an empty state; every agent has identity and live activity,
while local Claude sessions can also supply usage, context, plan windows and lines changed.

```sh
quirky session-info get --json
quirky session-info get --session <session-id> --json
quirky session-info sections --open '["identity","usage","liveActivity"]' --json
quirky session-info inspect --session <session-id> --json
quirky session-info enable-telemetry --session <session-id>
quirky session-info enable-telemetry --session <session-id> --enabled=false
```

Section preferences live in the daemon and survive window restarts. Stale usage retains the last
successful values and offers **Retry**, including when Hooks & MCP is closed. Identity actions
open session history, focus the exact pane, copy its provider ID, and open or reveal its captured
transcript. History supports resume, fork and copying the resume command; these actions are also
routed public UI commands and require an open window.

Claude telemetry uses a composed, per-launch `--settings` overlay. It never rewrites the user's
`~/.claude` settings. A custom statusline requires explicit consent to chaining; its command,
stdin, successful stdout and formatting fields are preserved. Consent or opt-out applies to the
**next launch**, not an already-running CLI. User `--settings` JSON/files in configured agent
arguments are preserved on launch and resume; the restricted per-launch `extraArgs` allowlist
is unchanged.

Rich telemetry is accepted only for the captured active provider session; late ticks and scans
cannot populate another conversation. Claude hook health is based on observed, correlated
per-launch hook evidence, not a claimed global installation. Transcript reads are bounded to
16 MiB and accept only the recorded local path.
Settings and MCP configuration files are limited to 4 MiB and must resolve to regular files;
symlinks to regular files are supported. Oversized files, pipes and devices are rejected rather
than read without a bound. Configured settings report an error; MCP inspection retains valid
results from the other scopes.

The API schemas are discoverable through `quirky api --json`.
[Behavior and acceptance scenarios](../docs/quirk/specs/2026-10-27-m3-session-info/logic.md).

Launch-hook authors can return structured options through `LaunchPatch.jsonArgs` instead of appending competing
settings flags. The host merges object fields in hook-ID order, replaces arrays/scalars with the
later value, and renders one JSON argument per option. Hook input exposes the accumulated
read-only `jsonArgs` and the original launch record/model/options/extras. Ordinary argument
ordering is unchanged. See the public
[launch types](../packages/protocol/src/plugins.ts) and the
[composition contract](../docs/quirk/specs/2026-10-27-m3-session-info/tech.md#json-launch-argument-composition).

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

Top-level PR conversation comments use `hosting review-conversation`, not issue
or Project mutation routes:

```sh
quirky hosting review-conversation --number 7 --action add --body 'Review notes' --json
quirky hosting review-conversation --number 7 --action edit --comment-id 101 --body 'Updated notes' --json
quirky hosting review-conversation --number 7 --action delete --comment-id 101 --yes --json
quirky hosting review-assignees --number 7 --action set --logins jo --logins pat --json
```

Only deletion requires confirmation. Edits and deletes recheck that the comment
belongs to that exact PR; assignee `set` replaces the assignment and accepts an empty
array through `--params` to clear it. `add` and `remove` take at least one login.
Use `--pr-repo '{"host":"github.com","owner":"team","repo":"project"}'`
when origin and upstream contain different PRs with the same number.

`quirky git mergePreview --base <full-sha> --head <full-sha> --json` reports
conflicting paths from existing local commit objects without changing HEAD, refs,
the index or working files. It never fetches or executes a custom merge driver.
An unavailable preview reports a reason rather than presenting changed files as
conflicts. Git may add immutable merge-tree objects to its object database.

`quirky hosting review-stack --number 7 --json` hydrates up to 100 member PRs
through the provider's stack-membership read. The request number is the selected
PR; `stack.number` is a distinct stack resource ID, and `stack.entries[].number`
contains the real member PR numbers. Unsupported or mismatched membership is
explicitly unavailable, never synthesized from that stack ID. `truncated` reports
omitted members. Optional `--pr-repo` preserves origin/upstream identity.

## Plugin settings pages

A UI plugin can opt a declared view into the shell's **Settings → Plugin settings**
navigation with `"settings": true`:

```json
{"view": [{"id": "settings", "title": "Hosting settings", "settings": true}]}
```

Provide the view through the normal public UI API. The Settings link opens its
effective view ID through `ui.view.open`; it does not import feature code into the
shell. Disabled or overridden-away views have no link. A view with no active UI
module is shown disabled, and failed navigation leaves Settings open with an error.
Ordinary views remain outside Settings unless they explicitly opt in.

## Hosting reviews

`quirky.reviews` owns the active-workspace **Checks** panel, full pull-request
page, creation composer and hosting settings. It calls the public Hosting, Git,
Worktree, Tasks and Agents APIs; the renderer never invokes `gh` directly.

```sh
quirky reviews open --worktree <id> --number 12 --tab conversation --json
quirky reviews detail-set-tab --worktree <id> --number 12 --tab checks --json
quirky reviews show-checks --json
quirky reviews create-open --worktree <id> --json
quirky reviews settings-open --worktree <id> --json
quirky reviews state --json
```

Checks follows the workspace in the active view. PR headers open the shared Tasks
workspace composer; they do not silently create or switch branches. Provider
identity remains explicit when origin and upstream reuse a PR number. Merge and
comment deletion retain kernel confirmation and canonical provider validation;
queued merge is not displayed as completed merge.

Creation rechecks the exact branch/head and eligibility, pushes first only when
required, preserves an existing review, and reports a created PR separately from
failed stack registration. Failed or superseded generation cannot replace another
head's draft. Settings retain stale observations with an error instead of
inventing connected accounts or empty budgets.

The live API catalog contains all method schemas and generated command aliases.
`reviews state` is the full daemon-owned navigation/draft/provider snapshot. Window
slot reports are bounded summaries pointing to that method, so large comments or
diffs do not exceed the kernel's 64-KiB report limit.

Other-provider review/create/settings and in-app link routing have explicit
prerequisite-dependent queue items; current cards and routing never claim those
unavailable capabilities succeeded. Clipboard/system-browser/focus behavior is
handed to the native scenario run, not inferred from headless web output.
