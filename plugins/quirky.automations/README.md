# Automations

`quirky.automations` is a startup-activated daemon plugin for durable scheduled and manual structured-agent runs. Definitions and run history live in the daemon store, so scheduling and execution continue without an open window, terminal tab, or UI focus change.

## Execution model

A run row is evidence of one attempt, not proof that an agent succeeded. A manual request is persisted first, including when its definition is paused, and then dispatched outside the per-automation persistence lane. The API and CLI return the persisted state after the dispatch attempt; the status and evidence, not the request itself, determine success.

The dispatcher claims pending runs durably before preparation, rechecks the saved definition and target after awaited preparation steps, and never retries a provider launch automatically. Existing workspaces and new-per-run workspaces both use public repo/worktree APIs. New workspace setup defaults to `skip`; an explicit `run` only proceeds under the project's existing trust policy and never prompts or auto-consents to hooks. Workspaces are retained when a definition is removed.

New-per-run workspaces retain `automationProvenance`: the automation/run IDs, their creation-time name/title snapshots, project ID, and local host identity. Attribution is authorized by a single-use dispatch capability and stored with the workspace before setup or launch. Ordinary API-created workspaces and runs in existing workspaces are not relabelled. Renaming or deleting an automation, or pruning its run history, does not remove the workspace's attribution.

Scheduled runs resolve their captured target before insertion. Repeated scheduled occurrences with the same unavailable reason fold into a single final history row and advance the schedule cursor; manual refusals always have separate rows. The configured missed-run grace wins over target resolution and produces `skipped_missed`. Scheduled prechecks run before workspace creation; manual runs bypass them. A precheck failure or timeout records bounded evidence and prevents workspace creation and agent launch.

Claude and Codex use structured background sessions marked `background: true`, without a PTY, auto-created terminal tab, or focus change. A reusable session is eligible only for the same agent and existing workspace and only when it is live and not claimed by a newer nonfinal run. Reuse sends a new structured turn and keeps that session's original launch settings. Completion is based on journal evidence after the run's message cursor, not an older `done` event or an idle session. Restart reconciliation records durable evidence or fails ambiguous pre-launch work rather than replaying a potentially launched agent.

Run statuses distinguish `pending`, `dispatching`, `dispatched`, successful `completed`, precheck/missed/unavailable/authentication skips, and `dispatch_failed`. Output snapshots are capped at 256 KiB UTF-8. Run/source context, launch settings, precheck results, and usage records are each capped at 64 KiB serialized UTF-8 JSON. Usage and cost are attributed only from evidence for that run's structured turn; missing evidence is explicitly unavailable, never invented as zero.

Precheck evidence exposes `stdout`, `stderr`, `completedAt`, exit/timeout/cancellation state, and truncation flags; each stream retains its last 4000 characters. Usage exposes `status: known|unavailable`, token counts, `totalTokens`, and nullable `estimatedCostUsd`. Claude result tokens cover its main agent loop (`tokenScope: main_agent`); its cost is a delta from the prior cumulative SDK estimate, including subagents. A missing baseline or reset makes cost unavailable rather than charging the whole conversation again. These are estimates, not billing data; see the [SDK accounting contract](https://code.claude.com/docs/en/agent-sdk/cost-tracking#track-costs-in-streaming-input-mode).

## Targets and limits

Create resolves the registered project and, for `workspaceMode: "existing"`, the registered workspace. It captures the authority-local repo/workspace identity and normalized paths. The caller cannot supply an execution path through metadata. Ordinary edits preserve the saved capture; an explicit project, workspace, workspace-mode, or run-context move recaptures it. Supply the returned `owner` as `expectedOwner` to fence edit, remove, and manual run requests against stale target views.

The `target({ id })` API and `quirky automations target <id>` command inspect the saved capture and its current resolution without recapturing. A missing, moved, malformed, or remote target refuses execution; it never falls back to a local path. Remote SSH/runtime execution and registration generations are unavailable in this slice.

Before saving and again before dispatch, model and option picks are validated through `quirky.agents/resolveLaunch` as structured launch settings on the captured provider host. An authoritative, nonempty provider model snapshot retires a stale model only for definitions in this local owner store with the same agent and exact captured `runContext.hostId`; option values supported by the refreshed default catalog are retained. Empty, malformed, or unavailable probes leave definitions unchanged. Changing providers clears saved picks unless replacements are supplied. Raw `extraAgentArgs` are explicitly refused because structured sessions do not accept command-line arguments; `--extra-agent-args` exists only to report that refusal, not to enable a shell fallback.

## API

Methods are under `quirky.automations/`:

- `list`, `show`, `create`, `edit`, and `remove` manage definitions. Definition outputs include the captured `owner` when present.
- `run({ id, expectedOwner? })` persists a manual row and dispatches it. `runs` reads history with an optional `automationId`, limit, and cursor. Run outputs include `dispatchState` when dispatch has begun.
- `target({ id })` inspects the captured target and current availability. `dispatch({ runId })` explicitly dispatches a pending run; repeated or nonpending dispatch returns the current row without relaunching it.
- `schedule` inspects a schedule in an explicit IANA timezone. `tick` evaluates due work using the daemon's current time; the plugin reconciles dispatcher state before its immediate startup tick and evaluates every 60 seconds.

Definition edits preserve omitted fields. Nullable fields can be cleared with `null`. Changing a schedule resets `dtstart` to the current time unless the API supplies a new `dtstart`; changing the timezone recomputes the cursor without changing the anchor. Pausing and resuming do not move the cursor. The `changed` event is emitted only after a durable definition or run mutation.

Run history retains the 100 newest final rows per automation and preserves every active row. Retention ties use scheduled occurrence time before ID, while history paging uses timestamp and ID. Run numbers remain monotonic after pruning. Occurrence metadata keeps at most 100 final keys plus active keys; a durable pruned-through watermark prevents replay without retaining deleted run snapshots. API pages default to 100 rows and clamp limits to 1–100, with stable timestamp-and-ID cursors and legacy numeric offsets.

## UI and retained editor

Open **Automations** from its tool stripe, Settings, or `quirky automations open`. Its default slot is left-bottom and follows the host's saved placement. When the tool is already visible, navigation and opening the editor reuse it without replacing the center view or mounting a second editor. The host's **Minimize Automations** control dismisses the tool panel; the Automations header has no separate Close action. Standalone center views use the host's **Close active view** control. The `automations close` command closes the tool's actual slot or, in standalone use, returns to the preceding view. The page retains search, host/status/agent filters, sort, selection, and editor draft in the daemon session. Hiding the sidebar shortcut does not remove the Settings entry.

Reopening standalone Automations from its settings reuses the existing Automations tab. A subsequent `automations close` returns to the original preceding view, not the settings detour.

The header uses labeled icon buttons for settings, refresh, and New Automation so the Automations title has room in the default sidebar. Header actions, including the host minimize control, fit within the panel and follow the shared hover and focus behavior. In narrow sidebar panels, the search field shrinks to the available width, its label wraps, and Filters moves onto another row when needed.

**New Automation** opens a two-pane editor with four templates, project/workspace selection, structured agent model/options, preset or custom-cron schedule, timezone, grace, precheck, and setup choice. Reuse selects an existing worktree; New run selects a fresh session. Raw agent arguments are disabled because structured sessions reject them. Setup remains skipped unless explicitly selected and trusted; an uninspectable branch or hook fails closed to skip.

The list, settings, controlled action menus and editor compose the public
`@quirky/ui` components and canonical dark/light tokens, with no plugin-owned CSS
injection. The editor stacks into one scrollable column on narrow windows, keeping
its name/prompt fields and Cancel/Create actions reachable.

Saved definitions and background-run evidence refresh without replacing the mounted page or losing search focus. Details show schedule/target/prompt, truthful usage coverage, and paged run history. The Runs dashboard excludes future occurrences from its 24-hour and seven-day counts. Run details prefer saved output, then precheck output, error, and usage diagnostics. **View run** explicitly selects the recorded structured session, including a background session not yet adopted into a tab; it never creates a replacement shell. Missing or wrong-worktree selections show an error rather than silently falling back. Native startup failures retain bounded child stderr so an external interpreter or library failure remains diagnosable.

Native and OpenClaw row action menus close on Escape and explicit Refresh. Escape returns focus to the same row's trigger without running an action or changing navigation. The mounted page report includes `openMenuKey`.

Automation-created sidebar cards show **Created by automation**. Their Automation details retain the recorded name and run title and offer **Open automation** and **Open run** for the exact stored IDs. Availability checks distinguish loading, deleted definitions, missing run history, and failed reads; a failed check is not described as deletion. The sidebar's persisted **Hide automation-created** filter uses this durable attribution, not the workspace name or generic API creator.

The phone workspace list uses the same provenance for its saved **Hide automation-created** option. It reads the compact `quirky.loops/summaries` projection for loop labels, completed iteration counts, optional caps, and pause reasons in compact and detailed rows. Failed or disconnected summary reads make cached labels unverifiable; a successful empty read removes them. This read permission does not grant loop history, prompts, outputs, or mutation methods.

The UI commands are scriptable:

| Command | Input |
| --- | --- |
| `automations ui-state` | Current navigation and retained draft |
| `automations navigate --patch '<json>'` | Partial navigation object, such as `{"page":"runs","runStatus":"failed"}` |
| `automations editor-data` | Available local projects, workspaces, and agents, plus read errors |
| `automations editor-open` | Optional `--id` or `--template` |
| `automations editor-patch --patch '<json>'` | Partial draft; optional `--template` |
| `automations editor-save` | Validate and save the retained draft |
| `automations editor-cancel` | Discard the draft without changing its definition |
| `automations settings` / `automations close` | Open settings / restore the preceding view |

Delete confirms removing the definition and its history, never its workspaces. **Don't ask again** changes the public `ask-before-delete` setting. API/CLI deletion still follows the kernel's explicit `--yes` authorization convention.

## External OpenClaw jobs

OpenClaw rows come from the local user's `~/.openclaw/cron/jobs.json`; they are not native definitions. Discovery shows unreadable files and missing CLI capability separately from an empty list. The reader bounds file size, nesting, token count, and job count.

`quirky automations external list --json` returns the jobs and a captured owner. Pass that owner to `external action --owner '<json>' --job-id <id> --action pause|resume|run|delete`. Actions validate the current owner and job ID before invoking a fixed `openclaw cron` argv; delete requires confirmation. A changed jobs file or executable requires a refreshed owner. Commands have a 30-second deadline and bounded output; errors remain visible. SSH/runtime authorities are refused rather than redirected to the local CLI.


## CLI

Commands are in the `quirky automations` group: `list`, `show <id>`, `create`, `edit <id>`, `remove <id>`, `run <id>`, `runs [id]`, `target <id>`, and `dispatch <runId>`. JSON output preserves the API's `owner`, `dispatchState`, status, error, and evidence fields. `--expected-owner` takes a JSON owner snapshot on edit, remove, and run.

Create/edit accept `--trigger` or its `--schedule` alias with `hourly`, `daily`, `weekdays`, `weekly`, or a valid raw schedule. Daily and weekdays default to 09:00; weekly defaults to Monday at 09:00; hourly uses minute 00. `--time` supports 24-hour `H:MM`/`HH:MM`, and `--day` uses 0–6 with Sunday 0. `--enabled`/`--disabled` and `--reuse-session`/`--fresh-session` are mutually exclusive. `--missed-run-grace-minutes 0` is valid. `--model` and `--effort` are structured launch overrides; `inherit` clears saved values on edit. `--extra-agent-args` is explicitly refused when nonblank.

`--project`/`--repo` select a registered local project; `--workspace` selects an existing registered workspace. The workspace mode defaults to `existing` when a workspace is supplied, otherwise `new-per-run`. Setup defaults to `skip`. Remove is destructive and uses the kernel `--yes` confirmation convention.

Without paging flags, `runs` drains history in pages of 25 and reduces page size when a reply is too large. Supplying `--limit` or `--cursor` prints exactly one page and shows its next cursor when present. `target` prints current availability; `dispatch` operates on a pending run and prints its current truthful state.
