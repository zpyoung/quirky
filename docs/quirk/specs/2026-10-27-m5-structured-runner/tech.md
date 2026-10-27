# Shared structured runner and checks: technical specification

Status: Codex promote/refute reviewed; confirmed lifecycle and ownership findings addressed. Required by LOOP.md and cross-subsystem tier. Behavior: [logic.md](logic.md).

## Overview
Implement the native lifecycle, persistent resume and bounded checks contracts below, preserving the kernel's context-revocation ordering.

## Architecture
Traceability: [conceptual model](logic.md#conceptual-model), [data flow](logic.md#data-flow).

Extend `plugins/quirky.structured` in place: `plugins/quirky.structured/main.ts` owns orchestration, `Journal` owns private persistence, and provider-specific runners implement `StructuredRunner`. Add Codex transport and executable resolution beside the Claude files. Keep provider routing narrow. `quirky.session` remains owner of session records; structured identity updates and register/resume go through its public methods. Create the lazy built-in checks plugin using ordinary discovery, schemas and public worktree resolution. No kernel process API is required: trusted in-process plugins can use Node subprocess APIs.

## Code references
Traceability: [AC1](logic.md#ac1-launch-codex-without-a-terminal), [AC4](logic.md#ac4-persist-and-resume-both-native-providers), [AC7](logic.md#ac7-execute-shared-checks-in-the-requested-location).

Paths below are relative to `/Users/zpyoung/orca/workspaces/quirky/build-lane-12` (component worktrees have the same relative layout):
- `plugins/quirky.structured/runner.ts`: `StructuredContext`, `StructuredLaunchOptions`, `StructuredStartOptions`, `StructuredRunner`, factory. Native identity persistence and executable resolution are provider-neutral; start accepts an optional prompt and optional native resume ID.
- `plugins/quirky.structured/main.ts`: `activate`, `create`, `resume`, `send`, `setStatus`, `startRunner`, `release`, `deactivate`. Own routing, actual-provider settled events, launch metadata and single conversation ownership. Send waits on the session's startTasks barrier.
- `plugins/quirky.structured/claude-runner.ts`: `ClaudeRunner.start`, `launch`, `journal`. Use SDK resume for a captured identity; initial prompt is optional on resume. Keep SDK loading lazy until the runtime provider selection chooses Claude.
- `plugins/quirky.structured/claude-path.ts` and `plugins/quirky.structured/codex-path.ts`: login-shell native executable resolution, no global config writes.
- `plugins/quirky.structured/journal.ts`: `Journal`, `journalMigrations`, `setLaunchOptions`, `getLaunchOptions`. Private migration stores exact resolved options alongside the existing append-only journal/import.
- `plugins/quirky.structured/quirky-plugin.json`: schema declarations for create/resume/send/stop/messages and settled/message events.
- `plugins/quirky.structured/codex-runner.ts` and `plugins/quirky.structured/codex-connection.ts`: `createCodexRunner`, `CodexRunner`, `CodexConnection`; native stdio lifecycle and RPC correlation.
- `plugins/quirky.session/src/sessions.ts`: `SessionService.resume` delegates structured records; `register` validates original cwd and resumedFrom. Terminal launch/resume retains its existing path.
- `plugins/quirky.session/quirky-plugin.json`: register/resume schemas include structured delegation, optional prompt and register cwd/resumedFrom.
- `plugins/quirky.agents/quirky-plugin.json`: Codex structured mappings model -> model and effort -> effort. Existing resolver `plugins/quirky.agents/src/core/resolve.ts:80-112` and parser `plugins/quirky.agents/src/core/launch-options.ts` remain shared.
- `plugins/quirky.structured/test/structured.test.ts`, `plugins/quirky.structured/test/claude-runner.test.ts`, `plugins/quirky.structured/test/codex-runner.test.ts`, and `plugins/quirky.session/test/resume.test.ts`: daemon/provider/restart contracts. Scripted native transport lives in `plugins/quirky.structured/test/fakes/codex-app-server.ts`.
- `plugins/quirky.checks/main.ts`, `plugins/quirky.checks/executor.ts`, `plugins/quirky.checks/quirky-plugin.json` and `plugins/quirky.checks/test/checks.test.ts`: public run/cancel, process execution, schemas and real-process API acceptance.
- `packages/protocol/src/plugins.ts`: public PluginContext and PluginLaunch boundaries, unchanged.
- `plugins/quirky.ask/main.ts`, `plugins/quirky.ask/asks.ts`, `plugins/quirky.ask/store-migrations.ts`: creating-plugin ownership and lifecycle cancellation; `plugins/quirky.ask/test/asks.test.ts` proves AC3 cleanup.

## Contracts & interfaces
Traceability: [AC1–AC6](logic.md#behavior--scenarios), [AC7–AC9](logic.md#ac7-execute-shared-checks-in-the-requested-location).

### Structured lifecycle
- create accepts only claude/codex, validates picks before registration, refuses extras. Return remains a Session; startup errors append diagnostics and set exited (existing asynchronous-create convention).
- Use one runner per provider, or one minimal dispatcher implementing the same interface. Existing injected factory test seam remains effective and must not cause real SDK launches in tests.
- Extend start options with optional provider resume identity, keeping model/effort as native string fields. Resume without a prompt must allow a later send without creating a new provider conversation. Unsupported fork/provider overrides fail, never disappear silently.
- CONTRACT: StructuredRunner.start(session, prompt?: string, options?: StructuredStartOptions) returns Promise<void>. StructuredStartOptions carries optional model, effort and providerSession. A send arriving before start finishes awaits startTasks before invoking the provider; failed startup remains a send failure, never a fresh launch.
- `StructuredContext` exposes asynchronous persistence through session/setProviderSession (id, optional transcript path), and resolvers for native executables. Await provider ID persistence before the first turn so a successfully running conversation is resumable.
- structured/resume accepts session and optional prompt. New record preserves old worktree/cwd/agent/launchSettings, records resumedFrom, and uses private persisted launch options. Validate original cwd still exists as a directory, provider ID is usable and no conflicting launch picks/fork are accepted. session/resume delegates structured sessions, including providerSession override only if deliberately supported by structured/resume schema; otherwise rejects unsupported flags explicitly. Default path must never fall through to terminal launch.
- A native conversation has one connected owner. Atomically reserve `(agent, providerSession.id)` before async resume/registration; reject live-owner or competing resume conflicts. Release the reservation on failed startup, stop or exit. Idle/done runners still own their connected conversation. Restart has no connected owners.
- structured/stop stops but does not delete a session/journal. Removal retains existing journal deletion behavior. Shutdown waits for runner cleanup before stores close; no callbacks may write after deactivation. Pending ask cancellation on plugin disable/shutdown is owned by the ask plugin, because structured context.call is revoked before deactivate; do not change kernel revocation ordering.
- Successful done/waiting settled event includes actual agent and latest assistant message. Failed/interrupted turn or broken transport never emits successful done. Concurrent approvals keep status waiting until all resolve.

### Approval ownership cleanup
Traceability: [AC3](logic.md#ac3-answer-approvals-from-the-api).
- Save the creating plugin ID from PluginCaller (not caller-supplied parameters) as private ask metadata with a new migration. User asks have no plugin owner.
- On plugin.changed, use public plugin.list to identify disabled, removed or otherwise non-active owners and cancel only their pending owned asks. Cancellation settles waiters and persists through AskService, preserving seq and queue promotion rules.
- Ask-plugin shutdown cancels pending plugin-owned asks while its store is usable, then shuts down waiters/timers. Its emit/error callbacks must tolerate revoked context during deactivation; store mutation must not be skipped because emitting is revoked.
- On ask activation after a daemon crash, cancel persisted plugin-owned approvals: the old runner no longer exists. Do not cancel user-created asks. This avoids resurrecting stale permissions.

### Codex transport
- Spawn resolved `codex` argv `app-server` with cwd, stdin/stdout pipes and drained bounded stderr, no PTY. stdout is incremental UTF-8 JSONL, not readline's broader Unicode separator parsing. Bound incomplete/malformed frames; malformed JSON and invalid responses fail explicitly.
- Numeric/string request IDs correlate pending replies; server requests carry their own IDs. initialize response must precede initialized notification and thread methods. Stable API only, no experimental opt-in unless installed protocol proves required and the decision log records it.
- New: thread/start with cwd/model and an approval-capable policy; resume: thread/resume with threadId and original settings. Persist returned thread.id. Start input with turn/start `{threadId,input:[{type:'text',text}],model?,effort?}`; send while active uses turn/steer and expectedTurnId. Serialize input operations or otherwise resolve completion races without accidental duplicate sends.
- SCHEMA: thread/start and thread/resume use approvalPolicy `on-request` and sandbox `workspace-write`. These wire enums were verified against the installed CLI's generated ThreadStartParams schema, not camel-case documentation shorthand.
- Track active turn from response/notifications; filter events to this thread. Journal assistant messages and tool evidence without duplicating delta plus full-message text. Raw notifications may be kept as data. turn/completed status completed -> result/done; failed/interrupted -> explicit non-success diagnostic/state. Subsequent idle send retains original model/effort.
- Handle item/commandExecution/requestApproval and item/fileChange/requestApproval through asks. Replies are native accept/decline decisions using server request IDs; cancellation/errors deny. Unknown server requests return method-not-found. No implicit auto-approval or global settings mutation.
- Process error/exit, stdout closure, response error and protocol timeout reject pending operations, report exited and clean up. Bound control RPC waits without timing out legitimate long turns or human approval waits. stop interrupts an active turn with bounded wait then closes stdin and terminates process tree if needed; startup stop cannot spawn after cancellation.

### Shared checks API
- New lazy plugin ID quirky.checks, methods run/cancel, dependency quirky.worktree. CLI group generated from declarations, not handwritten CLI parsing.
- run params: command (nonblank string), worktree? selector, cwd? absolute existing directory (mutually exclusive with worktree), timeoutSeconds? integer 1..600 default 60, checkId? nonempty string. Resolve caller's current worktree when cwd/worktree both absent. Caller-supplied active ID cannot collide. Return checkId plus normalized result below. Method awaits bounded execution; cancellation is a separate call on another client/plugin invocation.
- cancel params: checkId; result cancelled boolean. Unknown/completed ID returns false. Shutdown cancels all active checks and awaits completion.
- Internal command execution can accept AbortSignal; an already-aborted signal does not spawn. Use current environment and a shell command in the requested cwd. Retain only 4000 decoded characters per stdout/stderr stream, maintaining independent truncation flags. The timeout stays active through stream drainage, including after direct child exit; descendant-held pipes cannot hang the result.
- POSIX process group TERM then KILL after 2 seconds on timeout/abort, and reap/drain/destroy pipes deterministically. Timer/listener cleanup on all paths. A cancel racing exit 0 must not return pass true. Do not mask a spawn failure as an exit code.

## Data models / schemas
Traceability: [AC4](logic.md#ac4-persist-and-resume-both-native-providers), [AC5](logic.md#ac5-apply-model-and-effort-exactly-once), [AC7](logic.md#ac7-execute-shared-checks-in-the-requested-location).

CONTRACT: structured methods return existing Session; `providerSession.id` stores native Claude session ID or Codex thread ID; `resumedFrom` is the old Quirky ID; `launchSettings` stays the existing catalog snapshot. Private launch metadata stores exact applied `{model?: string, effort?: string}` per session with versioned migration, not a new shared protocol vocabulary.

SCHEMA: checks result fields: `checkId: string`, `ran: boolean`, `pass: boolean`, `exitCode: number|null`, `timedOut: boolean`, `aborted: boolean`, `stdoutTail: string`, `stderrTail: string`, `stdoutTruncated: boolean`, `stderrTruncated: boolean`, `durationMs: number`, optional `error: string`. Pass iff ran, exitCode===0 and no timedOut/aborted/error. Missing target/refused input is explicit invalid-params/not-found or a failed result as appropriate; execution spawn errors are failed results.

## DO-NOT-CHANGE fences
Traceability: [scope](logic.md#scope--non-goals).
- `docs/loop/LOOP.md`, `scripts/build-loop/`, queue.json and DECISIONS.md: protected unattended-loop infrastructure, only queue.ts modifies shared state.
- External feature research tree: read-only source of requirements.
- PTY spawning, terminal resume construction and terminal delivery in `plugins/quirky.session/src/sessions.ts`: preserve except the early structured delegation and register validation; interactive agents must remain terminal sessions.
- Agent catalog selection/precedence rules and extraArgs refusal: existing binding decisions; do not invent a second catalog or accept raw structured argv.
- Kernel plugin lifecycle and public API declarations: no private daemon imports from either feature plugin.

## Always / Ask / Never
Traceability: [decisions](logic.md#decisions-locked).
- Always: use context.call for cross-plugin operations; update schemas and generated CLI availability; tests use temp homes/process cleanup; retain existing journal migrations and terminal behavior.
- Ask: no human asks; record autonomous defaults in item log. Conflict with locked roadmap/architecture means block item via LOOP protocol.
- Never: real home writes, paid agent calls in tests, retries that duplicate prompts, exec JSON as Codex transport, UI/chat expansion, silent fresh fallback on failed resume, unbounded output, worker commits or edits outside task scope.

## Cross-cutting
Traceability: [AC3](logic.md#ac3-answer-approvals-from-the-api), [AC9](logic.md#ac9-timeout-cancel-and-shutdown-check-process-trees).
Full-trust local daemon auth remains unchanged. Treat provider payloads as data, not commands to the host. Check command execution is intentional authenticated shell execution, not a new sandbox. Diagnostics must identify failure without claiming success; keep stderr bounded. Store migrations add private launch metadata and ask ownership only; existing sessions lacking launch metadata may recover explicit options from the immutable snapshot if lossless, otherwise refuse rather than misreport replay. Rollback leaves old journals readable. macOS is acceptance target; Windows process-tree cleanup/Linux verification are recorded in D10.

## Testing strategy
Traceability: [all acceptance scenarios](logic.md#behavior--scenarios).
- Daemon API tests drive AC1–AC6 through the real structured plugin, scripted app-server child/transport and SDK FakeQuery seam; assert session/journal/ask/settled outcomes, no PTY, persistence across restart and native resume arguments. Keep targeted provider tests for protocol races, failures and process shutdown. Delete obsolete incidental manifest/wiring/wording assertions rather than re-pin them to new implementation details; retain meaningful consumer-visible validation tests.
- Daemon checks API tests use actual shell commands and descendants in temp dirs to prove AC7–AC9, Unicode tails and timeout/abort kill. Never touch real QUIRKY_HOME.
- Acceptance commands (COMMAND): bun test plugins/quirky.structured/test/structured.test.ts; bun test plugins/quirky.structured/test/claude-runner.test.ts; bun test plugins/quirky.structured/test/codex-runner.test.ts; bun test plugins/quirky.checks/test/checks.test.ts; bun test plugins/quirky.ask/test/asks.test.ts. Orchestrator runs after edits; workers skip mid-flight checks per task contract. Use temporary HOME and QUIRKY_HOME; standalone smoke sets NODE_ENV=test and clears agent-home overrides.
- Final gate: `bun run test` (remote host only), `bun test scripts`, `bun run typecheck`. Smoke actual daemon API with scripted Codex app-server and real check process beyond unit assertions; CLI schema discovery proves commands are exposed. Build required if UI scenarios exist; this item adds no UI.

## Non-goals
See [scope](logic.md#scope--non-goals). No downstream automation/loop/objective implementations or unrelated suite-runner changes.
