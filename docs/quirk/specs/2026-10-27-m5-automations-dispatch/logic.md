# Automations dispatch

## Status & amendments
Status: Approved autonomously; implementation verified and ready for queue landing. Combined night-mode spec.

**Amendments:** 2026-10-27: creator-lifetime cancellation belongs to checks because a revoked automation context cannot cancel during deactivate (D11). Catalog-declared opaque model IDs remain accepted under m1-launch-settings D10; invalid option values still refuse. Dispatched provider identity is immutable. 2026-10-28: landed loops D19 clarifies the locked architecture: automatic terminal adoption accepts terminal sessions only, regardless of a structured session's background flag. This supersedes the earlier assumed ordinary-structured auto-adoption behavior; existing explicit bindings remain intact.

## Purpose and conceptual model
A persisted automation run is the evidence of one attempt, not evidence that an agent succeeded. The daemon claims a pending run durably before any precheck, workspace creation or agent launch. The automations built-in owns dispatch policy; public repo/worktree/checks/structured/session APIs own execution. Closing the window cannot stop scheduling or execution.

The feature doc's terminal mechanics are superseded by the locked structured-background-agent architecture (docs/architecture.md, Structured agent sessions). Claude and Codex run without a PTY or a visible tab; no renderer launcher or focus change is needed. Raw extra arguments stay refused under m5-structured-runner D6. Model and effort use catalog-native structured options.

## Scope and non-goals
In scope: local target capture and refusal; durable claim and recheck; scheduled-only prechecks; existing and new-per-run workspaces; explicit setup policy; structured launch and live reuse; completion/failure detection, output snapshots and provider-evidenced usage; scheduler refusal folding; restart reconciliation; public API and existing automation CLI.

Non-goals assigned to other items: automation page/editor/dashboard and sidebar provenance UI; external OpenClaw; schedule/storage redesign; general session retirement policy. Native-only/UI scenarios: none, because this slice has no UI surface and never focuses a window.

Two feature-doc flows have unavailable or conflicting prerequisites and are explicitly deferred, not simulated: remote SSH/runtime registration-generation, host pin/re-pin/re-adoption execution (no public host execution/registration API exists), and raw extra arguments (binding structured-runner D6 refuses them). Remote contexts must remain visible and refuse execution; they never fall back to local. A single dependent follow-up names both flows before landing.

## Data flow
Create/edit validates structured launch picks and resolves the selected project/workspace from the authority's registry. It captures a local execution owner and immutable target identity/path in runContext; client metadata cannot override the resolved path. An explicit selector move recaptures; unrelated edits retain the original captured target so deleted/moved projects remain fenced.

Manual run persists first even when paused, then enters the same per-automation dispatch lane as scheduled runs. The scheduler resolves before insertion so identical successive scheduled unavailable reasons fold into one final row. Manual refusals always have separate rows. Dispatch snapshots semantic definition and destination, claims, re-reads and re-resolves after every awaited preparation boundary, refuses changes before starting the provider, and records the returned structured session identity. The lane ends at dispatch, not completion. Completion reads only journal entries newer than that run's starting sequence; a prior done edge can never complete a reused run.

## Decisions locked
- **API/data mapping:** existing namespaced automation methods and CLI remain; target inspection and explicit pending-run dispatch may be added for scriptability. Structured session identity is authoritative; no terminal aliases.
- **Target/auth:** local owner capture is authoritative. Remote/malformed/changed context is a typed refusal. No filesystem path supplied as metadata is trusted.
- **Idempotency/conflicts:** durable pending-to-dispatching claim is unique; repeated dispatch returns existing run and never launches twice. Edits/removal before launch cancel/refuse; no new row for a removed definition. Scheduler fields lastRunAt/updatedAt/nextRunAt are excluded from semantic equality.
- **Error/retry:** no automatic provider launch retry. Unavailable targets are skipped_unavailable; precheck failures skipped_precheck; launch/provider error, blocked approval or lost runner dispatch_failed. Unknown/lost transport is never success.
- **CLI/output:** existing JSON records remain truthful through pending/starting/launched/final states. Model/effort overrides are validated at save and fresh launch, with effective snapshot retained per run. Reuse retains original settings.
- **Workspace:** default setup is skip; run uses existing trust enforcement, never auto-consents to unknown hooks. New workspace creation is background and never starts an interactive agent. A saved setup run that cannot proceed unattended refuses/fails without prompting.
- **Usage:** direct structured provider result/turn evidence only; never allocate whole-session/provider totals to every run. Unavailable/ambiguous fields are explicit, never invented cost zero.
- **Platform:** macOS validated; Linux/Windows process and provider behavior require independent validation.

## Acceptance scenarios
Each scenario has a permanent API-driven regression where it represents a consumer-visible invariant; real CLI/native-process smoke proves the integrated path. Tests isolate HOME/QUIRKY_HOME and stop all owned processes.

### AC1: Existing target, local ownership and target drift
Before: registered project P at /repo and workspace W at /repo/w. Create an existing-mode automation for P/W.
Walkthrough: inspect its capture; run manually with no window. Then remove W or move P's registered path and run again.
After: first run launches structured in W with no PTY/tab/focus; later run is skipped_unavailable with specific target reason and no provider process. Missing project at create is rejected. A forged context path/host cannot redirect execution. Ordinary edits never silently recapture an orphan. Explicit target moves recapture and stale expectedOwner conflicts.

### AC2: Scheduled refusal folding, manual refusal visibility
Before: a saved target becomes unavailable; a minute schedule has three due occurrences.
Walkthrough: evaluate each occurrence, then request two manual runs.
After: one scheduled skipped_unavailable row has occurrenceCount 3 and latest lastOccurrenceAt, cursor advanced and no agent; two manual refusal rows remain separate. A changed refusal reason does not fold with the old reason. Late beyond-grace still uses skipped_missed.

### AC3: Unique durable claim and prelaunch recheck
Before: one pending run and a valid captured destination.
Walkthrough: concurrently dispatch twice; change definition/destination while an awaited precheck or target lookup is held; delete another automation during preparation.
After: at most one session launches; semantic changes refuse before launch. Deleted definition never reappears and no launch occurs. Scheduler bookkeeping does not cause false semantic-change refusal. Nonpending/final runs do not relaunch.

### AC4: Precheck passes, refuses, times out; manual bypass
Before: scheduled automation with a shell precheck and target at /repo.
Walkthrough: success command runs in authoritative project cwd before workspace creation; nonzero/timeout/error commands are evaluated. Run the same automation manually with a failing precheck.
After: scheduled success launches; failures persist bounded stdout/stderr and precise reason as skipped_precheck with no workspace/agent. Manual skips precheck and launches. Shared checks runner enforces timeout/tree cleanup; cancellation on plugin stop cancels owned active checks.

### AC5: Fresh workspace and setup decision
Before: P with a known base branch, setup script, new_per_run automation, setup omitted/skip/run.
Walkthrough: two runs create separate auto-<slug>-<UTC stamp>-unique names, base branch passed and no parent/activation. Run explicit trusted setup and test changed/untrusted hooks.
After: unique workspaces are retained and identified on runs. Default/skip does not run setup. Run honors existing project trust without an interactive ask. Provider starts after required setup is finished; failed setup never launches an agent. Deleting automation leaves workspaces.

### AC6: Fresh launch overrides and immutable snapshot
Before: Claude/Codex automation with selected model and effort.
Walkthrough: save valid picks, reject catalog-disallowed picks, launch; edit the definition's provider and picks after dispatch. Opaque model IDs are accepted when the catalog explicitly allows them.
After: native provider receives valid structured fields; run launchSettings and completion identity stay those of the actual session. The definition's agent change clears old picks unless replacements are provided and affects only future launches. Raw extra arguments are rejected before mutation (binding decision, not a shell fallback).

### AC7: Reuse one live completed structured conversation
Before: same automation/workspace/agent has completed live session S with original settings.
Walkthrough: next run submits through structured/send; an older session already claimed by a newer nonfinal run is excluded. Test busy/exited/missing/wrong-agent/wrong-workspace sessions, and a stale done event before send.
After: only eligible S is reused; original settings preserved; prompt acceptance and a new post-cursor result determine completion. Otherwise fresh structured session. No prompt is sent twice after ambiguous acceptance; failed submission is truthful failure unless absence is proven before send. Parallel manual requests cannot share an active session.

### AC8: Completion and bounded output
Before: dispatched run, provider emits assistant/result messages, errors or waiting state.
Walkthrough: result may arrive before launch acknowledgement, failed result may accompany done, session may disappear, daemon may restart.
After: latest assistant/result content from this run captured (256KiB UTF-8 bound/truncation); actual successful result completes once, failed result/blocked approval/exit without successful result fails; never complete merely because session was idle/done before run. Reconciliation marks stranded claimed/manual pending runs truthfully without replaying a possibly launched agent; dispatched runs re-read durable journal evidence. Completion is final once, with no late overwrite. Observation deadline is six hours.

### AC9: Usage and cost are per run
Before: one reused Claude streaming query reports cumulative cost0.09, then0.102; the second turn reports12 input and5 output tokens.
Walkthrough: persist the latest pre-prompt journal cost baseline, then collect the new turn's result. Also exercise a result without cost evidence.
After: the second run reports17 main-agent tokens and estimated cost0.012, never the cumulative0.102. Claude `usage` is per-turn main-agent-loop evidence (`tokenScope: main_agent`); cost includes subagents and is the nonnegative difference from the proven prior cumulative total. Missing/decreasing totals make cost unavailable. Codex reported turn tokens are recorded without double-counting cached/reasoning subsets; unreported cost stays null. Missing evidence has an unavailable reason; known amounts are not downgraded.

## Defects not reproduced
- No renderer dependency/no-dispatch-window defect: daemon-native structured execution works with no window (AC1).
- Claim/edit/delete races and early completion cannot launch twice or falsely complete (AC3, AC8).
- Lost runner is failure, never success; no stale done reuse completion (AC7, AC8).
- Usage is scoped to one turn, not repeated cumulative totals (AC9).
- Core timezone/DST/grace/retention regressions remain in the inherited core tests, not reimplemented here.

## Key decisions and rationale
Recommended: daemon automations policy calls existing public structured/check/worktree methods. Rejected: renderer/hidden PTY dispatch, which violates locked architecture and loses headless independence; duplicate provider/check runners, which creates incompatible launch/trust/cleanup behavior. Target and runner helpers are separate from CRUD/scheduler integration to keep three independent work scopes.

## Industry insights
Night mode uses the feature doc, roadmap, architecture and existing decisions rather than external research swarms. Source: automations.md sections Target resolution through Extra agent args; m5-structured-runner D3–D8 and D12; m5-automations-core D1–D13.

## Deferred ideas
Only the two explicitly unavailable/conflicting flows named under Scope. No added triggers, retries, telemetry or generic workflow framework.

## Glossary
Owner: authority-local captured target identity, not a client-supplied execution path. Claim: persisted pending-to-dispatching transition. Cursor: last structured journal sequence before this run sends a prompt. Refusal: a visible final skipped run without provider launch.

## Technical decisions and shared contracts
- Existing types.ts remains the persisted automation model. Add optional definition owner and run dispatch metadata; no raw argument string is persisted. Keep core rows readable and retain retention/schedule SQL semantics.
- New dispatch-contract.ts contains the exact shared interfaces used by all three implementers; commit it before dispatch. New target.ts implements createAutomationTargetResolver(context). New dispatch.ts implements createAutomationDispatcher(context, hooks). Runtime policy is wired in main.ts; service.ts passes its store/lane/mutation event hooks and dispatches after core run creation.
- Target resolver captures authoritative local repo/worktree IDs, normalized paths and workspace instance identity; resolution compares these on every launch. Unsupported remote contexts are refused before any local command. Capture on explicit selector change only. expectedOwner must compare to saved capture before mutating/removing/running.
- Dispatcher uses public calls only: quirky.repo/resolve/show, quirky.worktree/resolve/create, quirky.checks/run/cancel, quirky.agents/resolveLaunch, quirky.structured/create/send/messages/stop, quirky.session/get/list. No imports from another plugin's implementation or daemon internals. Tests may use existing test seams.
- Shared helpers return concrete target/refusal unions and receive store hooks, not generic workflow graphs. Dispatcher holds the service's per-id lane through precheck/launch; direct store writes emit committed changes synchronously. Disposal clears timers/subscriptions and requests check cancellation; checks additionally owns creator-lifetime cancellation on plugin.changed so context revocation cannot strand its processes. Stopped contexts cannot start new work.
- Integration owns service/main/CLI/manifest/core API fixture migration. Target owns target.ts and target API tests. Execution owns dispatch.ts and dispatch API tests; if Codex needs tokenUsage journal evidence, execution also owns the specific structured runner source and regression.
- Parent owns the shared lifecycle seam in quirky.checks/main.ts, its method documentation, and test/owner.test.ts. Registered plugin creators are distinguished from clients; disabling one cancels only its checks. Check-ID uniqueness is checked after awaited owner resolution.
- The public Session model adds optional background boolean. Structured create/register and resume persist it through an appended session-store migration. Automatic terminal adoption accepts only terminal sessions and excludes background true; no structured session auto-creates a pane. Existing explicit bindings remain unchanged. Dispatch state optionally stores claudeCostBaseline, captured before reused prompt delivery. Obsolete core-only claim/updateRun handoff methods and result parsers are removed; dispatch/runs is the sole production lifecycle surface.
- Verification commands: implementers run only owned files. Parent runs `bun scripts/suite.ts packages/protocol plugins/quirky.automations plugins/quirky.structured plugins/quirky.checks plugins/quirky.session plugins/quirky.terminal`, `bun test scripts`, `bun run typecheck` once before land. Actual daemon + CLI + scripted native provider smoke covers native execution, background layout/focus invariance, reuse, new workspaces and the real60-second scheduler. No feature UI is added; API-observed layout evidence is not claimed as browser/native-window verification.
- Reviewer binding: omp-task/OpenAI implementers; Gemini high was reachable after opus/sonnet probes failed. No final model-review stage was dispatched: the item exceeded two hours and LOOP's night-mode fast path explicitly skips unstarted rounds once owned checks/typecheck pass (decision D26). Deterministic checks and model availability are not review clearance.
