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

## Background structured sessions

`quirky.structured` runs Claude through its Agent SDK and Codex through `codex app-server` over
stdio JSONL. Neither allocates a PTY. Start a background session from a registered worktree:

```sh
quirky session new --background --agent codex --prompt "Review this repository" \
  --model gpt-5.5 --effort high --json
```

The model and effort use the agent catalog. Omit both to leave the provider defaults untouched.
Raw extra arguments are refused for structured sessions.

With `quirky.accounts` enabled, creation and resume prepare the selected Claude or Codex account
before starting the native process. Explicit provider-home configuration takes precedence;
preparation failure refuses the launch. Prepared environment values are not saved in the launch
snapshot. Codex resume retains the native conversation ID and records its relocated transcript
path when account preparation moves the conversation.

The plugin exposes `create`, `messages`, `send`, `stop`, and `resume`. Creation returns a session
record before startup finishes; `send` waits for native startup before submitting input. Messages
are journaled and status comes from native events. Command/file permissions become ordinary
`quirky.ask` questions. Cancellation denies approval; disabling the creating plugin cancels its
pending approvals.

Stop a connected runner before resuming its conversation:

```sh
quirky structured stop --session "$SESSION_ID"
quirky session resume "$SESSION_ID" --json
```

Resume returns a new Quirky session ID with `resumedFrom`, preserving the original directory,
native conversation ID, model/effort and launch snapshot—even after a daemon restart. The old
record and journal remain unchanged. A connected conversation has one owner; competing resumes,
missing native identity, a missing directory, forks and launch overrides are refused. Use the new
ID with `quirky structured send --session <id> --text <prompt>`.

Codex stop bounds its final pipe cleanup even when an independently detached child retains an
output descriptor. Its process group is the execution ownership boundary; it does not adopt
independently detached services.

## Shared checks

`quirky.checks` executes local shell commands independently of agent sessions:

```sh
quirky checks run --cwd "$PWD" --command "bun run typecheck" --timeout-seconds 60 --json
```

Plugins call `quirky.checks/run` with `command`, optional `cwd` or `worktree` (mutually exclusive),
optional `timeoutSeconds` (1–600, default 60), and optional `checkId`. Without a target it resolves
the caller's current worktree. A consumer can pass its own timeout, run/skip policy and evidence
retention; this plugin does not schedule work.

The result includes `ran`, `pass`, `exitCode`, `timedOut`, `aborted`, `durationMs`, stdout/stderr
tails and independent truncation flags. Each tail holds at most 4000 decoded Unicode characters.
Inspect `pass` in the JSON result: a nonzero command exit is returned as failed check evidence,
not an RPC error. Timeout, cancellation and spawn errors never pass.

Provide a unique active `checkId` to cancel from another invocation:

```sh
quirky checks cancel --check-id "$CHECK_ID" --json
```

Timeout/cancel sends TERM to the process group, then KILL after a two-second grace period,
including descendants retaining output pipes. Plugin shutdown cancels and awaits active checks.
Completed IDs can be reused; cancelling an unknown/completed ID returns `cancelled: false`.
Process-tree cleanup is verified on macOS; Windows requires separate process-tree support.
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

## Mobile pairing

`quirky.mobile` adds the sidebar Mobile flow, **Settings > Mobile**, and the
`quirky mobile` command group. It pairs direct LAN or tailnet clients with the
same JSON-RPC API used by the desktop and CLI. The compatible Quirky phone app
and its signed installation links are not distributed yet; the desktop does
not redirect users to the incompatible Orca app or its hosted relay.

```sh
quirky mobile info --json
quirky mobile state --json
quirky mobile interfaces --json
quirky mobile pair --address 192.168.1.20 --json
quirky mobile devices --json
quirky mobile revoke <device-uuid>
quirky mobile configure --restore-fit-ms 60000
quirky mobile configure --keep-phone-size
quirky mobile open --settings
```

Treat the pairing URL and QR as credentials. Regenerating replaces the unscanned
offer, not already-paired phones. Revocation disconnects the device immediately
and rejects its next encrypted authentication. Device lists and state reports
never contain tokens.

Paired phones read the configured machine name and platform through
`quirky.mobile/info`. Pairing state, generation, configuration and revocation
remain local administration methods.

The mobile-only listener starts on loopback and widens when a network offer is
issued or a previously paired phone is restored. Its default port and fallback
ladder are defined in
[`transport.ts`](quirky.mobile/src/daemon/transport.ts). The desktop UI, plugin
assets and agent hooks remain on their separate loopback listener.
`QUIRKY_MOBILE_PORT` pins a nonzero port (`0` chooses a free test port);
`QUIRKY_MOBILE_HOST` pins the bind address and prevents widening a pinned loopback
listener.

A phone's terminal attachment claims input and viewport ownership. Desktop output
continues while typing is paused. Use **Take back** to restore desktop dimensions,
or **Restore** after the phone leaves. The default retains phone dimensions until
restored; Settings offers timed restoration. The corresponding APIs are
`quirky.terminal/mobileState`, `/takeBack`, `/restoreFit` and `/claim`.

Trusted transport plugins can use the public
[`PluginContext.clients.accept`](../packages/protocol/src/plugins.ts) API after
authenticating a peer. The admitted identity is immutable; authorization runs
before each dispatch, including cached and confirmed calls. Disconnect and plugin
revocation close its streams and subscriptions. Mobile's v2 channel seals text
requests and binary terminal output; terminal input uses JSON-RPC, not inbound
binary commands.

Mobile views accept scriptable page input through `ui.view.open`: `stage`
(`intro`, `install`, `pair`, `paired`), `platform`, `channel` and `address`.
Their non-secret stage, choices, devices and error state are readable through
`ui.state` slot reports. The live method schemas are in `quirky api --json`;
[the behavior spec](../docs/quirk/specs/2026-10-27-sb-mobile-daemon/logic.md)
defines the scope and limits.

## Create a workspace from GitHub

Use the new-workspace dialog's Smart field for `#123` or a GitHub PR/issue URL.
The GitHub tab lists both kinds of work item and lets you select or clear a source.
The same creation path is available from the CLI:

```sh
quirky wt create --repo demo --github '#3' --json
quirky wt create --repo demo --github 'https://github.com/OWNER/REPO/issues/4' --issue-command skip --json
```

Replace `demo` and the URL with your registered project and work item. A URL must
match a configured GitHub remote in that project. An unresolved source fails;
it is never treated as a plain workspace name.

API callers use `quirky.worktree/create` with `repo` and `github`. Pass the exact
item URL when it is already known, including from a Tasks or Project row. To inspect
the fresh source without creating anything, call `quirky.hosting/worktreeSource`
with a registered `worktree` and `reference`.

A PR checks out its verified head commit and head branch. Fork pushes target the
contributor's repository, while the compare base remains the PR's base branch.
Occupied or diverged local branches are refused without a reset. Issues use the
ordinary base and branch-prefix rules. The source title supplies the default card
label and lowercase folder slug; `--name` changes the folder, while
`--display-name` changes the card label. Linked PR/issue identity survives note edits
and daemon restarts.

### Run a command for a linked issue

Configure **Custom GitHub issue command** in Project Settings, or set `issueCommand`
in `quirky.yaml` (`orca.yaml` is the fallback). Templates accept `{{issue}}` and
`{{artifact_url}}`. The command runs in its own terminal, beside Setup when present.
`--issue-command skip` suppresses it for one creation.

Local configuration follows the project's command-source policy. Shared commands
need content approval independently of setup. One-time approval pins the displayed
script hash; changed content needs another decision and is not approved by an
earlier prompt. CLI/API callers can pin the same content with
`--trust-issue-command --trust-issue-command-hash <hash-from-error>`, or
`--trust-setup --trust-setup-hash <hash-from-error>` for setup.
Trust flags without a hash authorize the current call's script.
