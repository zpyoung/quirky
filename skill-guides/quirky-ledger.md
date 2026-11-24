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

A ledger is a durable, typed record of engineering observations attached to an Quirky Project
or Project Group. Each entry has an id, a type, a lifecycle state, an append-only change
history, and an `origin` snapshot of where it was filed. Entries live in the Quirky profile
rather than the git checkout, so they outlive the worktree and branch they were filed from,
and ids are allocated centrally so parallel agents never collide.

Reach for it when an observation needs to outlive the current worktree. Use ordinary notes
or the code itself when it does not.

## Start Here

`QUIRKY` is a placeholder for the executable you resolved in the stub; substitute it before
running. Do not create a shell variable or run `QUIRKY` literally.

```text
QUIRKY status --json
QUIRKY ledger list --json
```

Prefer `--json` for agent-driven calls. Success is
`{ "id": "ledger", "ok": true, "result": { ... }, "_meta": { "runtimeId": "..." } }` with
`result.schemaVersion` of `1`; failure is
`{ "id": ..., "ok": false, "error": { "code", "message", "data" }, "_meta": ... }`.

A runtime that predates the ledger rejects every command with `incompatible_runtime` and the
message `Selected runtime does not support ledger.v1`. Report that and stop rather than
retrying.

## Entry Types And Required Fields

Every entry has a type, fixed at filing time and never editable. Each type requires its own
content flags:

| type       | required flags                                         |
| ---------- | ------------------------------------------------------ |
| `bug`      | `--title --file --description --severity`              |
| `deferred` | `--title --why-deferred --priority`                    |
| `test-gap` | `--title --file-under-test --reason-skipped`           |
| `proposal` | `--title --context --recommendation`                   |
| `decision` | `--title --context --decision --consequences --status` |

Three fields are closed sets, validated by the runtime rather than the CLI, so a wrong value
comes back as `invalid-enum` rather than a local argument error:

- `--severity critical|high|medium|low` — `bug` only
- `--priority high|medium|low` — `deferred` only
- `--status proposed|accepted|superseded` — `decision` only

`--status` is the decision's own status and is independent of lifecycle state. A `decision`
entry can be `accepted` and still `open`.

`--file` and `--file-under-test` take `path` or `path:line`. Paths are recorded relative to
the workspace root; a path outside it is accepted and recorded as external.

## File An Entry

Filing creates the ledger on first use — there is no separate init step.

```text
QUIRKY ledger file --type bug --title "Login button unresponsive in Safari" --file src/components/LoginButton.tsx:42 --description "Clicking Login does nothing in Safari 17" --severity high --json
QUIRKY ledger file --type deferred --title "Add retry backoff to sync job" --why-deferred "Not blocking the current milestone" --priority medium --json
QUIRKY ledger file --type test-gap --title "No coverage for empty CSV import" --file-under-test src/import/csv.ts --reason-skipped "Needs a large fixture" --json
QUIRKY ledger file --type proposal --title "Split the sync worker" --context "One worker handles both fetch and merge" --recommendation "Extract merge into its own queue" --json
QUIRKY ledger file --type decision --title "Use SQLite for the local cache" --context "Need embedded storage with no server process" --decision "Adopt better-sqlite3" --consequences "Adds a native dependency; CI must build native modules" --status accepted --json
```

The response carries a `matches` array of possible duplicates: existing entries of the same
type that share a normalized location, or whose title overlaps this one's by at least 60% of
its words. **Read `matches` before filing a second entry about the same thing** — nothing
blocks a duplicate.

## List, Show, And Review

```text
QUIRKY ledger list --json
QUIRKY ledger list --type bug --state open --json
QUIRKY ledger list --reviewed false --stale true --json
QUIRKY ledger show --id bug-3 --json
QUIRKY ledger review --json
```

`list` filters on `--type`, `--state`, `--reviewed <true|false>`, `--stale <true|false>`, and
`--branch <name>`. `--reviewed` and `--stale` take an explicit `true` or `false`; they are not
bare switches.

`show` returns the entry's content, its current `revision`, and its `history` — one record
per change, each with the revision it produced. Both the current revision and the history
revisions are what the edit commands below take as preconditions.

**Pass entry ids as `--id <id>`.** A bare positional works locally, but it is not recognized
over the reduced SSH fallback described below, where the id is only read from `--id`.

`review` returns triage candidates ranked unreviewed-and-stale first, then by unverified
author, then oldest-updated. It is read-only: it reports what deserves attention and cannot
mark anything reviewed. Only the Quirky app sets `reviewed` to true — every CLI `edit`,
`state`, and `revert` resets it to false. Entries go stale after the ledger's threshold,
90 days by default.

## Choosing Which Ledger

With no target flag, commands resolve the Quirky-managed worktree containing the current
directory and use that project's ledger. Outside a managed worktree they fail with
`No Quirky-managed worktree contains the current directory`.

- `--group` targets the group ledger that owns the selected workspace instead of the project
  ledger.
- `--group-selector <id|name>` targets one specific group, searched through the workspace's
  group and its ancestors. It must match exactly one, or the call fails `group-ambiguous`
  with the eligible groups in `error.data.eligible`.
- `--workspace <id>` names the worktree explicitly. On `list` and `review` it also filters
  rows to entries filed from that worktree, so pass no `--workspace` when you want the whole
  ledger.
- `--ledger <id>` opens a ledger directly by id, including one whose project or group was
  deleted. It is accepted only by `list`, `show`, and `review`, and is mutually exclusive
  with `--workspace`, `--group`, and `--group-selector`.

`--group` and `--group-selector` are mutually exclusive with each other.

```text
QUIRKY ledger file --type bug --title "Shared CI runner is flaky" --file .github/workflows/ci.yml --description "Intermittent timeout" --severity medium --group --json
QUIRKY ledger list --ledger <ledger-id> --json
```

## Edit, State, And Revert

These three commands take an optimistic precondition. Read the entry's current `revision`
from `show` (or from the response that created or last changed it), pass it as
`--if-revision`, and the runtime applies the change only if nothing else moved the entry
first.

```text
QUIRKY ledger show --id bug-3 --json
QUIRKY ledger edit --id bug-3 --if-revision 1 --severity critical --json
QUIRKY ledger state --id bug-3 --state resolved --if-revision 2 --json
QUIRKY ledger revert --id bug-3 --to-revision 1 --if-revision 3 --json
```

- `edit` needs at least one content flag and merges the fields you pass over the existing
  content. An edit that changes nothing does not bump the revision.
- `state` accepts `open`, `resolved`, or `archived` from any current state, so reopening is
  an ordinary state change. Archive is the normal way to retire an entry.
- `revert` restores editable content and state from the revision named by `--to-revision`,
  as a new revision on top. It never rewinds the entry's id, type, or history.

A stale precondition fails without writing anything:

```text
{ "ok": false, "error": { "code": "conflict", "message": "Entry revision is stale", "data": { "currentRevision": 4 } } }
```

Recover by re-reading the entry with `show`, deciding whether the other writer's change
already covers yours, and retrying with the revision you just read. Do not retry with the
same number.

## Import

`import` reads legacy files from the workspace root and files them as entries: `BUGS.md`,
`DEFERRED.md`, `TEST_BACKLOG.md`, `proposals.md`, and every Markdown file under `docs/adr/`.
Every input is optional. It never writes to or deletes those files, and it never overwrites
an entry that was edited in the ledger — it skips instead.

```text
QUIRKY ledger import --json
```

**A nonzero exit code here does not mean the command failed.** Any skip sets the exit code
while the response still reports `ok: true`. Read `result.importResult.skipped` for the
anchors that were skipped and why, and treat an empty `skipped` array as a clean import.

Labels may be plain (`Key: value`) or bold with the colon inside or outside (`**Key:** value`,
`**Key**: value`). Extra legacy fields are preserved; severity, priority, and decision status
are enum-checked only for the entry type that owns them.

A failed record commit is reported in `skipped`; successful commits remain visible in
`created` or `updated`, and later records are still attempted. Re-running the import uses
the persisted source anchors to recognize successful records and retry failed ones.

## Errors

- `conflict`: the entry moved since you read it. Re-run `show` and retry with the revision it
  reports in `error.data.currentRevision`.
- `not-found`: the entry id, the `--to-revision` value, or the `--ledger` id does not exist.
  List first rather than guessing another id.
- `forbidden`: the operation is app-only. Review, hard delete, and attaching a detached
  ledger are not available from the CLI; ask the user to do it in Quirky.
- `invalid-content`: a required field was empty or the wrong shape. Check the required-flags
  table for the entry's type.
- `invalid-enum`: a `--severity`, `--priority`, or `--status` value is outside its closed set.
- `invalid-location`: a `--file` or `--file-under-test` value is malformed. Use `path` or
  `path:line` with a positive line number.
- `invalid-target`: the target flags conflict. Pass only one of `--group`,
  `--group-selector`, or `--ledger`.
- `owner-required`, `owner-missing`, `owner-ambiguous`: the workspace does not resolve to
  exactly one live project. Pass an explicit `--workspace <id>`.
- `group-missing`: the workspace belongs to no group, so there is no group ledger to target.
- `group-ambiguous`: `--group-selector` matched more than one group. Choose one from
  `error.data.eligible`.
- `workspace-missing`: the host that owns the workspace is unreachable, so a file location
  cannot be normalized. Check that the workspace's host is up.
- `incompatible-store`: the ledger file could not be opened. Report it; retrying will not
  help.
- `incompatible_runtime`: the selected runtime is older than `ledger.v1`. Tell the user to
  update Quirky.

## Remote And SSH

Against a paired remote runtime (`--environment` or `--pairing-code`), the current directory
belongs to your machine, not the runtime's, so cwd resolution is refused. Pass an explicit
`--workspace <id>` naming a worktree on that runtime.

Over SSH, Quirky normally runs the host's own CLI and behavior matches everything above. On a
host whose bundled CLI cannot launch, a reduced fallback takes over: pass entry ids with
`--id`, and read `--json` output, because the human-readable rendering there is a single
line of raw JSON.

## Next Action

Confirm `QUIRKY status --json` unless already checked this turn, then choose the narrowest
command: `ledger list` or `ledger review` to see what is already recorded, `ledger show --id`
before any change, and `ledger file` only after checking `matches` for a duplicate.
