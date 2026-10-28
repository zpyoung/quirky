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

`quirky.structured` runs Claude through its Agent SDK and Codex through the native `codex app-server`
over stdio JSONL. Both run without a PTY. Start either provider in a registered worktree:

```sh
quirky session new --background --agent claude --prompt "Review this repository" --json
quirky session new --background --agent codex --prompt "Review this repository" \
  --model gpt-5.5 --effort high --json
```

The model and effort use the agent catalog. Omit both to leave the provider defaults untouched.
Raw extra arguments are refused for structured sessions.

With `quirky.accounts` enabled, creation and resume prepare the selected Claude or Codex account
before starting the native process. Explicit provider-home configuration and trusted launch-hook
home overrides take precedence over managed selection; the account record describes the effective
home. Preparation failure refuses the launch. Prepared environment values are not saved in the
launch snapshot. Codex resume retains the native conversation ID and records its relocated
transcript path when account preparation moves the conversation.

The plugin exposes `create`, `messages`, `send`, `stop`, and `resume`. Creation returns a session
record before startup finishes; `send` waits for native startup before submitting input. Messages
are journaled and status comes from native events. Command/file permissions become ordinary
`quirky.ask` questions. Cancellation denies approval; disabling the creating plugin stops its
owned runners and cancels their pending approvals.

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

Background consumers can pass `requireIdle: true` and the observed `expectedAfterSeq` to
`quirky.structured/send`. The service serializes sends and rejects busy or stale observations
before delivering the prompt. `messages` accepts `limit` and `tail`; a tail query selects the
newest bounded messages and still returns them in ascending sequence order.

## Until-done loops

`quirky.loops` owns persistent background loops; `quirky loop` is its CLI alias:

```sh
quirky loop create --agent codex --prompt "Finish the task and keep notes" \
  --check "bun test" --max-iterations 5
quirky loop list --json
quirky loop show <loop-id> --json
quirky loop steer <loop-id> "Concentrate on the failing scenario"
quirky loop resume <loop-id> --add-iterations 2
```

Completion requires all configured independent check/evaluator signals to pass. `LOOP_DONE`
alone never completes a loop. Pause, stop, edit, protected paths, checkpoints, no-progress and
budget controls share the same public `quirky.loops/*` methods. Active loops pause after a
daemon restart; only an explicit resume starts them again. Notes live under `.quirky/loops/`
and remain private to the Git worktree.

The plugin uses native structured sessions and never creates a PTY or adopts a terminal pane.
See [the loop command and API guide](quirky.loops/README.md) for flags, evidence and lifecycle rules.

Plugin stores still refuse a schema newer than their migration list by default. A reader can opt
in with `context.openStore(migrations, { newerVersion: 'read-only' })` and inspect `store.readOnly`;
SQLite enforces read-only access, migrations do not run, and write/transaction methods refuse.

## Orchestration

`quirky.orchestration` provides durable Runs, dependent Tasks, authoritative Dispatch attempts,
mailboxes, resumable questions, decision gates and worker lifecycle operations. The manifest
declares session and worker APIs plus CLI verbs under `quirky orchestration`.
Actor-sensitive commands run inside a live Quirky-managed terminal or structured session;
the kernel verifies its launch credential and process or lease identity. `--from` and
`--terminal` are equality assertions, not credentials.

```sh
quirky orchestration run-create --objective "Coordinate the change" --json
quirky orchestration task-create --spec "Implement the first task" --json
quirky orchestration check --wait --types worker_done,escalation,question --json
```

Process every message in a returned Delivery before passing its ID to `check --ack`.
A lost response replays the same batch; type filters control wakeups, not batch contents.
`--peek` and `--all` do not consume mail. An `ask` timeout leaves its question pending:
use the printed `ask --resume` command rather than asking again.

Reuse `--retry-request` for an uncertain mutation and inspect it with `request-show --request`.
An absent receipt never proves no effect. Rejected worker reports remain auditable and exit
nonzero; neither an idle pointer nor missing status proves that work finished.

Public session helpers provide exact-incarnation identity, guarded close and idempotent prompt
submission. Structured `create` accepts `deferStart: true` without a prompt, so authority can attach
before the first turn. Automatic idle-mailbox nudging is deferred to
`m6-orchestration-idle-pointer-shutdown`; explicit safe submission and durable mail remain available.
Worker placement, custody and fleet use this same core. Headless coordinators use the plugin-owned
service APIs below; plugin metadata cannot impersonate a session.

Settings → Orchestration installs the version-matched `/orchestration` skill, shows actual
per-agent file coverage, and provides copyable supervised-work prompts. Installation is explicit;
unsupported loaders and partial failures are reported per agent. The same setup is scriptable:

```sh
quirky orchestration skill-status --json
quirky orchestration skill-install --json
quirky orchestration policy-show --json
quirky orchestration policy-set --nested-worker-max-depth 2 --json
```

Run policy changes from an unbound operator client. Session-attested, paired-device and plugin
callers cannot change the cap, and generic settings do not expose it. The persisted integer
defaults to 1 and governs future dispatch admission and worker preambles; lowering it does not
stop admitted workers. This is a policy guard, not a sandbox against other holders of the user token.

Terminal `task_…` links and nested sidebar rows resolve the latest exact assignment through
`taskTerminal`; `task-terminal --task-id <id> --json` returns the same session/workspace target.
Context-only Dispatches are navigable too. Reused, released, changed or structured-only sessions
are refused rather than opening an unrelated terminal. Fleet rows separate task labels and
lineage from `currentAssignment` confidence; uncertain workers remain visible without stale task
titles. Physical input transfers existing worker custody to the user, so release retains that
terminal instead of closing it. The setup affordance's open and dismiss actions are public UI commands.

**Session, worker and setup methods:** `runCreate`, `runUse`, `runCurrent`, `runList`, `runShow`, `taskCreate`,
`taskList`, `taskUpdate`, `dispatch`, `dispatchShow`, `send`, `check`, `reply`, `inbox`, `ask`,
`gateCreate`, `gateResolve`, `gateList`, `requestShow`, `reset`, `workerStart`, `workerShow`,
`workerRead`, `workerList`, `workerStop`, `workerAbandon`, `workerRelease`, `workerRetain`,
`workerTerminalUserInput` (internal terminal-custody guard), `skillShow`, `skillStatus`,
`skillInstall`, `policyShow`, `policySet`, `taskTerminal`.

**CLI verbs (34):** `run-create`, `run-use`, `run-current`, `run-list`, `run-show`, `task-create`,
`task-list`, `task-update`, `dispatch`, `dispatch-show`, `send`, `check`, `reply`, `inbox`, `ask`,
`gate-create`, `gate-resolve`, `gate-list`, `request-show`, `reset`, `worker-start`, `worker-show`,
`worker-read`, `worker-list`, `worker-stop`, `worker-abandon`, `worker-release`, `worker-retain`,
`skill-show`, `skill-status`, `skill-install`, `policy-show`, `policy-set`, `task-terminal`.
Use `quirky api --json` for the current method and result schemas.

See the [contracts](quirky.orchestration/src/contracts.ts),
[runtime interfaces](quirky.orchestration/src/runtime-contracts.ts),
[core behavior specification](../docs/quirk/specs/2026-10-27-m6-orchestration-core/logic.md),
[worker behavior specification](../docs/quirk/specs/2026-10-27-m6-orchestration-workers/logic.md) and
[setup and UI specification](../docs/quirk/specs/2026-10-28-m6-orchestration-ui/logic.md).

## Heimdall kernel and service-owned Runs

`quirky.heimdall` runs bounded watchers supplied by registered kind plugins. A kind owns its
authorization, observation, decision, execution and stop hooks; the kernel owns scheduling,
capability gates, durable attempts, budgets and recovery. Register through `quirky.heimdall/registerKind`,
then use `enroll`, `inspect` and `reconcile`. Hook and result types are defined in
[`contracts.ts`](quirky.heimdall/src/contracts.ts).

Enrollment is unique per canonical workspace. Re-enrollment preserves watcher identity;
re-arming an operator-disarmed watcher starts a new budget generation. Work in flight counts
toward active time without double-counting overlaps. Background workers require positive live
identity and an active assignment to count. Missing contact, an idle prompt or a lost reply does
not prove completion. Unknown effects retain their durable request identity.

Headless plugins use the eight `quirky.orchestration` service methods through `PluginContext.call`:

- `serviceRunCreate` creates a stable Run for the authenticated plugin and its key. It does not
  invent a coordinator session.
- `serviceRunShow` reads owned worker identities and blocking Ask threads without consuming mail
  or changing consumer generations.
- `serviceWorkerStart` starts an attested worker in an explicit workspace. `serviceSend` sends
  guidance with the Run as sender; `serviceCheck` consumes and acknowledges owned Run deliveries.
- `serviceReply` answers a pending blocking Ask. `serviceWorkerStop` requires the exact session
  and process incarnation; `serviceWorkerRelease` uses settled-outcome, archive and custody guards.

Another plugin cannot read or control that service-owned Run. Ordinary worker CLI commands keep
their native launch authority; they do not receive the service principal. See
[`services/contracts.ts`](quirky.orchestration/src/services/contracts.ts) for request and result types.

Watcher state, attempt facts, a bounded diagnostic trace ring and terminal summaries live in the
plugin's private store; unresolved attempt traces remain pinned. A newer unknown store version
remains inspectable but cannot execute work. Removing a
watcher removes its own history, not its workers. Automatic OS sleep/wake binding is not installed
by this plugin.

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
that deletion without changing data. Issue types belong to the Issue's repository,
not the Project containing it: user-owned Projects can edit organization-repository
types. Personal repositories expose no organization types; unavailable or disabled
types are refused before mutation.

`gh` owns credentials. Normal requests use its ambient login or a repository's
configured keyring-account binding; a failed binding never falls back to another
account. Projects v2 uses the ambient login, not that binding. Enterprise hosts
must appear in the local `gh auth status` inventory.

The command group also exposes PR creation and stacks, checks and logs, comments
and review actions, file contents, issues, work-item searches, Projects v2, and
connection-owned refreshes. Use `quirky api --json` for the live method, parameter,
result, and event contracts. Fixed-cap reads report truncation, partial results, or a limit error;
only work-item search exposes client `--page` and `--limit`.

Concurrent work-item search/count reads batch within the same authenticated repository
scope. Valid cursor pages are reused for up to two minutes within bounded caches;
forced refresh and mutations invalidate them. A failed GraphQL alias does not discard
another alias's successful result. Tasks' direct numbered pages remain direct requests.
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

Review links use Browser's Link Routing setting and Shift+Cmd/Ctrl modifier policy.
Each PR/Checks action carries its originating worktree, including when the two surfaces
show different worktrees. API callers can supply `--worktree`; an omitted target is
inferred only from an unambiguous visible Review/Checks context. Routing failures do
not silently launch the system browser. Other-provider review/create/settings remain
explicitly deferred. Clipboard/system-browser/focus and native guest behavior are
handed to the native scenario run, not inferred from headless web output.
## GitHub Tasks

`quirky.tasks` supplies Tasks lists, issue detail/creation, Project tables/boards/roadmaps,
and the shared workspace composer. Its generated commands use the `tasks` group:

```sh
quirky tasks open --mode issues --json
quirky tasks open --mode prs --page 3 --json
quirky tasks projects --json
quirky tasks --help
```

`quirky.tasks/workspace` with `action: "start"` opens the retained composer; it does not
create a workspace until confirmation. Targets contain `worktree`, `kind` (`issue` or
`pullRequest`), `number`, and the exact GitHub `url`. Creation delegates to
`quirky.worktree/create` with that URL as `github`; there is no plain-create fallback.
Merge uses conditional kernel confirmation and the canonical hosting expected-head guard.
Ordinary issue edits, reviewer changes and opening the composer do not ask.

The public UI-library exports are `@quirky/plugin-tasks/markdown`
(`Markdown`, `MarkdownComposer`, `safeHttpUrl`) and
`@quirky/plugin-tasks/review-navigation` (`openReview`).
PR navigation calls `quirky.reviews/open` with `{worktree, number, tab?}`;
`tab` is `conversation`, `checks`, or `files`. Missing contributions produce an error,
not an issue page pretending to be PR detail.

Task Sources is a contributed Settings view. A boolean setting can also declare
`"menu": "view"` for a native View-menu toggle backed by the same public setting value.
Native clipboard, system-browser and focus effects remain pending in the nightly handoff.
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

## Accounts and running sessions

Account selection applies to future launches. Existing Claude and Codex processes keep their old
account until restarted. The Codex pane's **Keep old account** and **Restart** controls use the same
revision-checked actions as Usage. A restart preserves the native conversation and focuses its new
terminal; removing an earlier Codex account does not invalidate the current transcript locator.

Display preferences and “Don't ask again” choices do not advance account-selection authority.
A later account selection still invalidates an earlier restart choice or unspent reset offer.
Reset retries retain the displayed account/offer scope and request ID; missing credit, changed
offers and unknown outcomes are shown separately from confirmed redemption.

Full remaining UI acceptance and native-only clipboard, browser, Keychain and OS-focus checks are
tracked in [the completion decisions](../docs/loop/decisions/m3-accounts-remaining-flows.md).

## Heimdall fleet and controls

`quirky.heimdall` provides the Heimdall sidebar entry, fleet view and watcher controls.
Kinds register their enrollment and execution hooks through the public plugin API.
Enrollment refuses an unknown kind; kind-specific commands such as `objective` require
that kind's public detail provider.

```sh
quirky heimdall list --json
quirky heimdall show <watcher-id>
quirky heimdall pause <watcher-id> --json
quirky heimdall budget <watcher-id> --hours 2 --turns none --json
quirky heimdall debug <watcher-id> --out /tmp/heimdall-debug.json
```

Controls use the last observed owner fence and command revision. A changed revision is
refused, so refresh the detail before submitting another command. Results distinguish
`applied`, `refused` and `indeterminate`; an uncertain reply is not permission to repeat
an external effect.

Pause drains the current tick before committing. Resume cannot undo Disarm and refuses
an exhausted budget or pending worker question. A budget limit of zero is valid; `none`
means unlimited. Objective concurrency is limited to one in folder workspaces.

Deleting a watcher removes its saved history and requires confirmation unless `--yes`
authorizes it. Worker sessions keep running. `stop-worker` instead uses the exact recorded
session and process incarnation; missing or unverifiable identity is refused.

The API exposes `quirky.heimdall/fleet`, `detail`, `command` and `debugReport`.
`fleetChanged` pushes newer snapshots; a failed refresh retains the last confirmed view.
Fleet activity counts only live workers whose Dispatch assignment is still active. A live process
retained after completion is not running work; `detail` and `debugReport` keep that worker visible
and expose `assignmentActive` separately from process `state`.
The schema-2 debug JSON includes bounded journal and trace history. Approval-request and
terminal transitions go through `quirky.notifications`, including its enabled, focus and
cooldown policy. Disabling that plugin silences delivery.

### Optional Claude owner

An enrollment can set `owner: { agent: "claude", model?, effort? }` and
`ownerInterventionCapability: "off" | "gated" | "on"` (default `"off"`).
Without an owner, deterministic watcher behavior is unchanged. A configured owner receives
typed deviations, including full rejected-plan and operator-edit details, in one resumable
native conversation. Repeated evidence keys do not start duplicate turns.

```sh
quirky heimdall owner-inspect --watcher-id <watcher-id> --json
quirky heimdall owner-ready --watcher-id <watcher-id> --report-key <issued-key> --json
```

`ownerInspect` exposes the current issued report path and key. Write the intervention JSON
only to that private path, then submit the key through `ownerReady`; the API never accepts
an arbitrary report path. Reports are limited to 64 KiB and reject malformed, stale or
symlinked input. Kind-specific proposals use the registered kind's public `ownerAction`
hook. Every proposal still requires both the owner-intervention grant and the native
action's capability, exact approvals and current evidence.

An owner that stays silent for 15 minutes receives one reminder; another 15 minutes parks
the watcher with `owner-escalation`. Only answering that exact escalation resumes its owner
flow. Deleting a watcher or disabling Heimdall releases its owner connection without
stopping worker or independent sessions. Unconfirmed cleanup retains uncertainty rather
than starting a replacement conversation.

Use `quirky heimdall --help` and `quirky api --json` for the live commands and schemas.
