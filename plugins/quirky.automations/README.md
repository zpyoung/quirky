# Automations

`quirky.automations` is a startup-activated built-in plugin for durable scheduled definitions and run history. It stores identifiers only; it does not resolve projects or workspaces, run prechecks, or launch agent processes. A pending run is the durable handoff to a later dispatcher.

## API

Methods are under `quirky.automations/`:

- `list`, `show`, `create`, `edit`, and `remove` manage definitions.
- `run` queues a manual run, including for paused definitions. `runs` reads history with an optional `automationId`, limit, and cursor.
- `schedule` inspects a schedule with an explicit IANA timezone and returns validity, a label, the next occurrence, and the latest occurrence.
- `tick` evaluates due work using the daemon's current time. The plugin also evaluates immediately on activation and every 60 seconds.
- `claim({ runId })` atomically claims a pending run. `updateRun({ runId, patch })` records allowed result evidence and status transitions.

Definition edits preserve omitted fields. Nullable fields can be cleared with `null`. Changing a schedule resets its `dtstart` to the current time unless the API supplies a new `dtstart`; changing the timezone recomputes the cursor without changing the anchor. Pausing and resuming do not move the cursor.

The `quirky.automations/changed` event is emitted only after a durable definition or run mutation. Scheduled evaluation creates only the latest elapsed occurrence. It accepts lateness through the configured grace plus 120 seconds; older occurrences become `skipped_missed`. Per-definition mutation lanes prevent schedule, manual-run, claim, edit, and delete races. A malformed stored schedule is folded into a `skipped_unavailable` history row without blocking other definitions or advancing its cursor.

Run history retains the 100 newest final rows per automation and preserves every active row; retention ties use scheduled occurrence time before ID, while history paging uses timestamp and ID. Run numbers remain monotonic after pruning. Occurrence metadata keeps at most 100 final keys plus active keys; a durable pruned-through watermark prevents replay without retaining deleted run snapshots. API pages default to 100 rows and clamp limits to 1–100, with stable timestamp-and-ID cursors and legacy numeric offsets. Output snapshots are capped at 256 KiB and mark `truncated` when shortened.

Runs have `pending`, `dispatching`, `dispatched`, and terminal states. Claiming changes only `pending` to `dispatching`; the core never starts an agent. Structured providers are limited to Claude and Codex. Raw agent arguments are refused; model and option values are stored as structured overrides without catalog resolution.

Run/source context, launch settings, precheck evidence, and usage objects are limited to 64 KiB each as serialized UTF-8 JSON. Oversized metadata is rejected before mutation; it does not reduce the separate output snapshot allowance.

## CLI

Commands are in the `quirky automations` group: `list`, `show <id>`, `create`, `edit <id>`, `remove <id>`, `run <id>`, and `runs [id]`.

Create/edit accept `--trigger` or its `--schedule` alias with `hourly`, `daily`, `weekdays`, `weekly`, or a valid raw schedule. Daily and weekdays default to 09:00; weekly defaults to Monday at 09:00; hourly uses minute 00. `--time` supports 24-hour `H:MM`/`HH:MM`, and `--day` uses 0–6 with Sunday 0. `--enabled`/`--disabled` and `--reuse-session`/`--fresh-session` are mutually exclusive. `--missed-run-grace-minutes 0` is valid. `--model` and `--effort` are structured launch overrides; `inherit` clears saved values on edit. `--extra-agent-args` is explicitly unsupported.

`--project` and `--repo` pass a project identity; `--workspace` passes an existing workspace identity. No host ownership, current working directory, or target lookup is inferred. A workspace target defaults to `existing`; otherwise the workspace mode defaults to `new_per_run`. Remove is destructive and uses the kernel `--yes` confirmation convention.

Without paging flags, `runs` drains history in pages of 25 and reduces page size when a reply is too large. Supplying `--limit` or `--cursor` prints exactly one page and shows its next cursor when present. JSON output contains the normal API result; text output names definitions, schedules, run states, and queued run IDs.
