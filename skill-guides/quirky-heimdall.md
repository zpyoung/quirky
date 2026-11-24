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

Heimdall watchers are durable reconcilers. The kernel reads the workspace or review, chooses an
action deterministically, then applies capability, approval, budget, and safety gates before an
action can run. Use the CLI as an **observe → decide → act** loop: inspect the current fleet and
watcher evidence first, decide only from that evidence, then issue the narrowest command.

`QUIRKY` is a placeholder for the executable you resolved in the stub. Substitute it before running
commands; do not create a shell variable or run `QUIRKY` literally. Prefer `--json` when an agent
needs to read the result. `--json` uses the standard Quirky CLI envelope; inspect the `result` as well
as process success, because refusals and indeterminate outcomes are returned as structured results.

## Observe, decide, act

### Observe

```text
QUIRKY heimdall list [--kind objective|hosted-review] [--worktree <selector>] [--json]
QUIRKY heimdall show <watcherId> [--json]
QUIRKY heimdall objective <watcherId> [--json]
QUIRKY heimdall debug <watcherId> [--out <path>] [--json]
```

- `list` is the fleet overview: watcher id, kind, state/phase, workspace, contact, and paused state.
  `--kind` and `--worktree` narrow the rows; omit them for the fleet. A remote contact that is
  `unverifiable` means the owner could not be confirmed, not that it is safe to target a local copy.
- `show` reads status and park reason, open escalations, and workers. It is the source for the exact
  escalation id, worker-question message id, and worker dispatch id needed by steering commands.
- `objective` reads an objective watcher's plan, tasks, and landing state. It is not valid for a
  `hosted-review` watcher.
- `debug` returns the bounded debug report as JSON even without `--json`; `--out` also writes that
  report to a path on the machine running the CLI. Review preserved paths and free-text details
  before sharing the report.

### Decide

Treat the status, decision trace, open escalations, and live worker evidence as the current facts.
A watcher in `held` state may be obeying a safety interlock, not failing. Read its hold reason before
changing settings or retrying an action.

Capability modes determine whether an action is permitted:

| Mode    | Effect                                                                                                                                       |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `off`   | The action is never taken. The gate reports `capability-off` without opening an escalation; the watcher can propose it again on later ticks. |
| `gated` | The action waits for explicit approval of its exact action scope.                                                                            |
| `on`    | The action can run unattended when its other gates pass.                                                                                     |

Approval is scoped to the action and the evidence/content it was prepared for. Approving one
escalation does not grant blanket authority for later content. Use the escalation id shown by
`show`; the CLI retrieves its approval scope itself. Never construct or guess an approval scope.

### Act

Use only the matching action for the evidence you observed:

```text
QUIRKY heimdall approve <watcherId> <escalationId> [--json]
QUIRKY heimdall answer <watcherId> <messageId> --body <text> [--json]
QUIRKY heimdall answer-escalation <watcherId> <escalationId> --body <text> [--json]
QUIRKY heimdall budget <watcherId> [--hours <n|none>] [--turns <n|none>] [--json]
```

- `approve` approves the exact pending action scope on that escalation.
- `answer` replies to a pending worker question. Take the message id from `show` and provide the
  answer as `--body`.
- `answer-escalation` supplies the operator's response to the exact owner escalation. It requires a
  host that supports `heimdall.watcher-answer-escalation.v1`; the body must fit the server's size
  limit. This is not the same as approving an action.
- `budget` adjusts the active-time limit (`--hours`) and/or turn limit (`--turns`). `none` means
  unlimited. Omitted dimensions remain unchanged. If a watcher parked because a budget was spent,
  raise that budget before trying `resume`.

Lifecycle and worker controls:

```text
QUIRKY heimdall pause <watcherId> [--json]
QUIRKY heimdall resume <watcherId> [--json]
QUIRKY heimdall disarm <watcherId> [--json]
QUIRKY heimdall rm <watcherId> [--json]
QUIRKY heimdall stop-worker <watcherId> <dispatchId> [--json]
QUIRKY heimdall set-concurrency <watcherId> <maxConcurrency> [--json]
```

- `pause` waits for the in-flight tick and keeps the enrollment. `resume` resumes a paused or
  automatically parked watcher; it refuses while the budget is exhausted or a worker question is
  open. Answer the question or increase the budget first.
- `disarm` stops the current enrollment generation but preserves the watcher record and audit
  ledger. It cannot be undone by `resume`; a later `create` can re-arm the stable record.
- `rm` permanently deletes the watcher and its stored history. It does **not** stop worker
  terminals. Prefer `disarm` when you may need the history; `rm` requires the host capability
  `heimdall.watcher-delete.v1` and is destructive.
- `stop-worker` needs the exact dispatch id and a verifiable process identity. Check `show` before
  issuing it; it stops that worker, not the watcher.
- `set-concurrency` is for objective watchers. Lowering the cap lets active dispatches finish;
  raising it applies on the next tick. Folder workspaces remain capped at 1.

There is no `wait` command. Heimdall advances on watcher pulses; inspect `list` or `show` again to
observe a later state.

## Create a watcher

```text
QUIRKY heimdall create objective --objective <text> [--worktree <selector>] [options] [--spec <json|@file>] [--json]
QUIRKY heimdall create hosted-review [--worktree <selector>] [options] [--spec <json|@file>] [--json]
```

The default worktree selector is `active`, resolved from the CLI's local working directory.
On a paired runtime, pass an explicit selector for a workspace local to that runtime; the client
directory cannot identify a server workspace. SSH- or other-runtime-owned workspaces are refused
without fallback. Connect directly to the owning runtime to create there. Hosted-review creation
requires a Git worktree with an open, supported PR/MR on its current branch; the host derives
the branch, provider, review number, and review URL from that worktree and the forge.

Both kinds accept:

- `--hours <n|none>` and `--turns <n|none>` set active-time and turn budgets.
- Repeatable `--cap <key>=<off|gated|on>` overrides a capability. Objective keys are `plan`,
  `implement`, `review`, `check`, and `land`; hosted-review keys are `updateBranch`,
  `resolveConflicts`, `fixChecks`, and `merge`. The CLI validates the key set for the selected kind.
- `--owner claude` with optional `--owner-model <model>` and `--owner-effort <effort>` configures
  the long-lived owner agent and sets owner interventions to `gated`. Owner enrollment requires
  `heimdall.enroll-owner.v1`; only `claude` has the required resumable structured session in this
  slice.

### Objective options and defaults

Objective-specific options:

- `--objective <text>` or `--objective-file <path>` supplies the required objective text; use one.
  `--objective-file` reads UTF-8 text from a path relative to the current directory.
- `--plan-file <path>` reads an existing UTF-8 plan from a path relative to the current directory
  (up to 65,536 characters).
- `--tier express|standard|full` and `--landing-bar files-on-disk|committed-local-branch|pushed-ref|hosted-review|merged`.
- `--max-concurrency <n>` sets the worker cap.
- Repeatable `--territory <glob>` declares writable workspace paths; the default is `**` (the whole
  workspace). Use narrow globs deliberately.
- Repeatable `--role-agent <role>=<agent>` selects agents for `planner`, `implementer`, `reviewer`,
  or `integrator`.
- Repeatable `--gate <name>=<command>` adds a check with a default timeout of 1,800 seconds.
- `--no-lanes` disables objective task lanes.

Defaults match the objective enrollment form: `standard` tier, `files-on-disk` landing bar, maximum
concurrency 3, lanes enabled, whole-workspace territory (`**`), no preselected role agents or gates,
4 active hours, and 40 turns. With the default landing bar, capability modes are `plan: gated`,
`implement: on`, `review: on`, `check: on`, and `land: on`. For any other landing bar, `land` defaults
to `gated`; the other four defaults stay the same. Use repeatable `--cap <key>=<off|gated|on>` to
narrow or widen the default capability modes.

A complete `--spec` fragment can set the full objective payload and all capability and budget values
that are not workspace-derived. For this example, `active` must resolve to a Git worktree:

```json
{
  "budget": { "wallClockActiveMs": 14400000, "turns": 40 },
  "capabilities": {
    "plan": "gated",
    "implement": "on",
    "review": "on",
    "check": "on",
    "land": "on"
  },
  "kindPayload": {
    "objectiveText": "Add integration coverage for the account export flow",
    "tier": "standard",
    "landingBar": "files-on-disk",
    "lanesEnabled": true,
    "maxConcurrency": 3,
    "writeTerritory": ["**"],
    "roleAgents": {},
    "sitterOverrides": {},
    "gates": []
  }
}
```

Save it as `objective.json` and run:

```text
QUIRKY heimdall create objective --objective "Add integration coverage for the account export flow" --worktree active --spec @objective.json --json
```

The CLI resolves the selected workspace and fills `repoId`, `worktreeId`, and, for objective
payloads, `workspaceKind`; do not copy ids from another watcher or pass workspace-derived fields in
the spec. For a folder, the CLI uses `workspaceKind: "folder"` and caps concurrency at 1. Optional
payload fields such as `existingPlan`, `roleLaunch`, or `sitterOverrides` may be supplied through
`--spec`. Flags and the partial `EnrollInput` are combined, with explicit flags taking precedence.

### Hosted-review options and defaults

Hosted-review-specific options:

- `--branch-update merge-base-update|rebase` selects the branch update method.
- `--merge-method merge|squash|rebase|default` selects a merge method; `default` follows the
  provider repository setting.

For hosted-review `--spec`, set `kindPayload.mergeCheckScope` to `"all"` or `"required"`; omitted
values default to `"all"`. `"all"` waits for every current-head check, while `"required"` uses only
checks required by branch rules.

`branch`, `provider`, `reviewNumber`, and `reviewUrl` are optional input candidates. A capable host
derives the authoritative values from the selected worktree and forge; candidate values do not
override or become persisted identity.

Defaults are all four hosted-review capabilities (`updateBranch`, `resolveConflicts`, `fixChecks`,
`merge`) set to `off`, 4 active hours, unlimited turns, `merge-base-update` for branch updates,
`all` for merge-check scope, and the provider's default merge method. The host must advertise the
hosted-review derived-payload runtime capability. If it does not, update and restart that Quirky
runtime before retrying; including candidate identity values in `--spec` does not bypass the
capability gate.

The check-scope capability `heimdall.hosted-review-check-scope.v1` is required for `"all"`. If an
older runtime does not advertise it, the CLI refuses an all-scope enrollment rather than silently
dropping or changing the requested scope. `"required"` remains compatible: the CLI omits that field
for the old runtime, preserving its legacy behavior. Update and restart the runtime to use `"all"`.

This complete spec fragment selects a conservative sitter on a Git worktree with an open review:

```json
{
  "budget": { "wallClockActiveMs": 14400000, "turns": null },
  "capabilities": {
    "updateBranch": "off",
    "resolveConflicts": "off",
    "fixChecks": "off",
    "merge": "off"
  },
  "kindPayload": {
    "branchUpdateMode": "merge-base-update",
    "mergeMethod": null
  }
}
```

Save it as `hosted-review.json` and run:

```text
QUIRKY heimdall create hosted-review --worktree <git-worktree-selector> --spec @hosted-review.json --json
```

`--spec` accepts inline JSON or `@path/to/file.json`; relative file paths resolve from the current
directory. It is a strict partial input with `kindPayload`, `capabilities`, `budget`, and optional
`owner` fields; the create subcommand selects the kind. Omit workspace identity and `workspaceKind`,
which the CLI resolves from the selector. Explicit flags win when a field appears in both places.
Use only one kind per create command.

## Remote ownership

Read and manage remote-owned watchers through the row returned by `list`. For every command addressed
by watcher id, the CLI resolves that row and sends its recorded `target` plus `ownerFence`; the
fence binds the mutation to the owner and revision that were observed. Never synthesize a remote
target, reuse a copied fence, or fall back to a same-id local watcher. Refresh with `list`/`show` if
ownership or pairing changes. Reads can report an unverifiable contact; a mutation that cannot reach
the owner must fail closed rather than act on another host.

Create is different: it enrolls only in a workspace local to the selected runtime; it does not
cross to a workspace owned by SSH or another runtime. Connect directly to the owning runtime to
create there. A fleet row for a different host does not make that workspace local to this runtime.

## Refusals and recovery

A command result may be `applied`, `refused`, or `indeterminate`. A refusal or indeterminate result
sets a nonzero exit code; with `--json`, read the result's `reason` and `detail`. A nonzero exit is
not permission to repeat the same command blindly.

| Result/reason               | What it means                                                                                                                        | Remedy                                                                                                                                           |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `owner-unreachable`         | The owning runtime cannot be reached.                                                                                                | Restore the pairing/host connection, refresh the fleet, then retry only after contact is live. The command is not redirected to a local watcher. |
| `unsupported-capability`    | The owner does not advertise the capability required by this operation, or is too old for the command.                               | Update Quirky on the owner. Do not retry against a different target or omit the capability gate.                                                 |
| `owner-conflict`            | The watcher owner or remote pairing changed.                                                                                         | Re-run `list`, select the current row, and inspect it again before acting.                                                                       |
| `stale-revision`            | The watcher changed since the owner fence was read.                                                                                  | Re-read with `list`/`show`; decide whether the requested action is still needed and issue a fresh command.                                       |
| `watcher-not-found`         | The id is unknown or was removed.                                                                                                    | Use `list` and copy a current watcher id; do not guess another id.                                                                               |
| `invalid-state`             | The operation's precondition is not met (for example, resume while budget is spent, a question is open, or the watcher is terminal). | Read `show`, address the named blocker (answer the question or raise budget before resume), and do not try to bypass terminal or disarmed state. |
| `question-already-answered` | The worker question is no longer pending.                                                                                            | Re-read `show` and use a currently pending question id, if one remains.                                                                          |
| `worker-unverifiable`       | The worker process identity cannot be confirmed for a stop request.                                                                  | Inspect worker liveness in `show`; wait for identity to become verifiable or leave it alone.                                                     |
| `coordinator-seat-lost`     | The watcher no longer has its required orchestration coordinator seat.                                                               | Re-establish coordinator ownership before retrying a steering command.                                                                           |
| `invalid-command`           | The command payload or referenced scope is invalid.                                                                                  | Correct the command arguments using current `show` data; never invent an approval scope.                                                         |
| `indeterminate`             | The request may have reached the owner, but the outcome could not be confirmed.                                                      | Read `show`/`list` before retrying so an already-applied external effect is not repeated.                                                        |

Enrollment refusals are distinct from command refusals:

- `invalid-payload` or `unknown-kind`: correct the named field or choose one of `objective` and
  `hosted-review`. Validation runs before enrollment; for hosted review, check that the selected
  attached Git branch has an open supported PR/MR and that the owner supports derived payloads.
- `duplicate-workspace`: inspect the existing watcher with `list --worktree <selector>` and `show`.
  Manage or re-arm the stable watcher rather than creating a second watcher for the same workspace.
- `owner-not-executable`: the selected workspace's scheduler owner cannot execute this enrollment
  from the selected runtime. Choose a workspace local to it, or connect directly to its owning
  runtime; the CLI does not redirect creation through another host.

The CLI checks required runtime capabilities before sending commands. Lifecycle commands need
`heimdall.commands.v1`, permanent removal needs `heimdall.watcher-delete.v1`, owner escalation
answers need `heimdall.watcher-answer-escalation.v1`, and configuring an owner needs
`heimdall.enroll-owner.v1`. An older runtime is a compatibility blocker: update it instead of
repeating the request.

## Next action

Start with `QUIRKY heimdall list --json`, then `show` the exact row before steering it. Use
`objective` for objective plan/task evidence. After acting, read the returned status; on refusal or
uncertain delivery, refresh the fleet and detail before doing anything again.
