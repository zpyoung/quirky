# Automations

`quirky.automations` is a startup-activated daemon plugin for durable scheduled and manual structured-agent runs. Definitions and run history live in the daemon store, so scheduling and execution continue without an open window, terminal tab, or UI focus change.

## Execution model

A run row is evidence of one attempt, not proof that an agent succeeded. A manual request is persisted first, including when its definition is paused, and then dispatched outside the per-automation persistence lane. The API and CLI return the persisted state after the dispatch attempt; the status and evidence, not the request itself, determine success.

The dispatcher claims pending runs durably before preparation, rechecks the saved definition and target after awaited preparation steps, and never retries a provider launch automatically. Existing workspaces and new-per-run workspaces both use public repo/worktree APIs. New workspace setup defaults to `skip`; an explicit `run` only proceeds under the project's existing trust policy and never prompts or auto-consents to hooks. Workspaces are retained when a definition is removed.

Scheduled runs resolve their captured target before insertion. Repeated scheduled occurrences with the same unavailable reason fold into a single final history row and advance the schedule cursor; manual refusals always have separate rows. The configured missed-run grace wins over target resolution and produces `skipped_missed`. Scheduled prechecks run before workspace creation; manual runs bypass them. A precheck failure or timeout records bounded evidence and prevents workspace creation and agent launch.

Claude and Codex use structured background sessions, without a PTY, visible tab, or focus change. A reusable session is eligible only for the same agent and existing workspace and only when it is live and not claimed by a newer nonfinal run. Reuse sends a new structured turn and keeps that session's original launch settings. Completion is based on journal evidence after the run's message cursor, not an older `done` event or an idle session. Restart reconciliation records durable evidence or fails ambiguous pre-launch work rather than replaying a potentially launched agent.

Run statuses distinguish `pending`, `dispatching`, `dispatched`, successful `completed`, precheck/missed/unavailable/authentication skips, and `dispatch_failed`. Output snapshots are capped at 256 KiB UTF-8. Run/source context, launch settings, precheck results, and usage records are each capped at 64 KiB serialized UTF-8 JSON. Usage and cost are attributed only from evidence for that run's structured turn; missing evidence is explicitly unavailable, never invented as zero.

## Targets and limits

Create resolves the registered project and, for `workspaceMode: "existing"`, the registered workspace. It captures the authority-local repo/workspace identity and normalized paths. The caller cannot supply an execution path through metadata. Ordinary edits preserve the saved capture; an explicit project, workspace, workspace-mode, or run-context move recaptures it. Supply the returned `owner` as `expectedOwner` to fence edit, remove, and manual run requests against stale target views.

The `target({ id })` API and `quirky automations target <id>` command inspect the saved capture and its current resolution without recapturing. A missing, moved, malformed, or remote target refuses execution; it never falls back to a local path. Remote SSH/runtime execution and registration generations are unavailable in this slice.

Model and option picks are validated through `quirky.agents/resolveLaunch` as structured launch settings before a definition is written and are checked again for a fresh launch. Changing providers clears saved picks unless replacements are supplied. Raw `extraAgentArgs` are explicitly refused because structured sessions do not accept command-line arguments; `--extra-agent-args` exists only to report that refusal, not to enable a shell fallback.

## API

Methods are under `quirky.automations/`:

- `list`, `show`, `create`, `edit`, and `remove` manage definitions. Definition outputs include the captured `owner` when present.
- `run({ id, expectedOwner? })` persists a manual row and dispatches it. `runs` reads history with an optional `automationId`, limit, and cursor. Run outputs include `dispatchState` when dispatch has begun.
- `target({ id })` inspects the captured target and current availability. `dispatch({ runId })` explicitly dispatches a pending run; repeated or nonpending dispatch returns the current row without relaunching it.
- `schedule` inspects a schedule in an explicit IANA timezone. `tick` evaluates due work using the daemon's current time; the plugin reconciles dispatcher state before its immediate startup tick and evaluates every 60 seconds.
- `claim` now enters the owned dispatcher rather than exposing a launch-free claim. Production `updateRun` rejects client-controlled lifecycle/result writes; run completion and evidence belong to the dispatcher. Standalone core-only service use retains the lower-level store contract for tests.

Definition edits preserve omitted fields. Nullable fields can be cleared with `null`. Changing a schedule resets `dtstart` to the current time unless the API supplies a new `dtstart`; changing the timezone recomputes the cursor without changing the anchor. Pausing and resuming do not move the cursor. The `changed` event is emitted only after a durable definition or run mutation.

Run history retains the 100 newest final rows per automation and preserves every active row. Retention ties use scheduled occurrence time before ID, while history paging uses timestamp and ID. Run numbers remain monotonic after pruning. Occurrence metadata keeps at most 100 final keys plus active keys; a durable pruned-through watermark prevents replay without retaining deleted run snapshots. API pages default to 100 rows and clamp limits to 1–100, with stable timestamp-and-ID cursors and legacy numeric offsets.

## CLI

Commands are in the `quirky automations` group: `list`, `show <id>`, `create`, `edit <id>`, `remove <id>`, `run <id>`, `runs [id]`, `target <id>`, and `dispatch <runId>`. JSON output preserves the API's `owner`, `dispatchState`, status, error, and evidence fields. `--expected-owner` takes a JSON owner snapshot on edit, remove, and run.

Create/edit accept `--trigger` or its `--schedule` alias with `hourly`, `daily`, `weekdays`, `weekly`, or a valid raw schedule. Daily and weekdays default to 09:00; weekly defaults to Monday at 09:00; hourly uses minute 00. `--time` supports 24-hour `H:MM`/`HH:MM`, and `--day` uses 0–6 with Sunday 0. `--enabled`/`--disabled` and `--reuse-session`/`--fresh-session` are mutually exclusive. `--missed-run-grace-minutes 0` is valid. `--model` and `--effort` are structured launch overrides; `inherit` clears saved values on edit. `--extra-agent-args` is explicitly refused when nonblank.

`--project`/`--repo` select a registered local project; `--workspace` selects an existing registered workspace. The workspace mode defaults to `existing` when a workspace is supplied, otherwise `new-per-run`. Setup defaults to `skip`. Remove is destructive and uses the kernel `--yes` confirmation convention.

Without paging flags, `runs` drains history in pages of 25 and reduces page size when a reply is too large. Supplying `--limit` or `--cursor` prints exactly one page and shows its next cursor when present. `target` prints current availability; `dispatch` operates on a pending run and prints its current truthful state.
