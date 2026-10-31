# Sessions

## Workspace sleep

Workspace sleep reversibly stops active worktree sessions. Terminal sessions retain PTY history; structured Claude/Codex sessions stop through their provider runner and resume from the saved provider conversation ID. It never closes or forgets sessions. A shell wakes into the same session/history; agents use their provider-aware resume path.

## API

- `quirky.session/sleepWorkspace({ worktree: string }) -> WorkspaceSleepState`
- `quirky.session/wakeWorkspace({ worktree: string }) -> WorkspaceSleepState`
- `quirky.session/workspaceSleepStates({}) -> WorkspaceSleepState[]`

`worktree` is a worktree selector (including `floating`). `WorkspaceSleepState` is `{ worktreeId, state, updatedAt, sessions }`; `state` is `awake | sleeping | asleep | waking | partial`. Each session entry is `{ sessionId, state, error }`, with `state` `pending | stopped | restored` and `error` a message or `null`.

Sleep supports shells, resumable terminal agents with a valid stored provider ID, and structured Claude/Codex sessions with a valid provider ID. Other structured providers and nonresumable or unidentified agents are rejected before teardown. Sleep first validates every active session, then persists recovery intent before stopping any process. Sleep and wake serialize with session creation, resume, restore, registration, close, and provider-session updates for that workspace. New sessions are refused until a partial or sleeping workspace is explicitly woken.

Terminal sessions use the PTY stop operation, which terminates the owned process tree, verifies that descendants are gone, flushes history and stores the session as restorable. Structured sessions use their provider runner's stop/resume lifecycle and retain provider history. `killed` sessions retain their existing nonrestorable behavior. Partial stop or wake results keep per-session errors and can be retried. If daemon restart interrupts `sleeping` or `waking`, startup turns it into `partial` so the caller can retry. Repeated sleep/wake calls on an already asleep/awake workspace are idempotent.

Recovery records pin the worktree's filesystem `instanceId`. If the same path now names a different instance, sleep/wake reports a partial recovery error and will not restore old sessions there. The old session records and terminal history remain available, while fresh sessions can launch on the replacement instance.

## CLI

- `quirky session sleep <worktree>` — sleep a worktree and print each session outcome.
- `quirky session wake <worktree>` — wake it, resuming agents from their saved provider session IDs.
- `quirky session sleep-states` — list durable workspace sleep and recovery states.

### Example

```sh
quirky session sleep floating
quirky session sleep-states
quirky session wake floating
```

Use `quirky session wake <worktree>` to retry partial recovery. A failed session retains its error and is not silently relaunched as a blank agent conversation.

## Agent restore and Fork

`quirky.session/restore({ session })` restores retained terminal history under the same session ID. A still-running session is returned unchanged. Shell sessions resume as shells; a lost agent session resumes only when it has a syntactically valid captured provider session, a saved launch record, a resumable provider and an existing launch folder. The restore reuses `quirky.agents/prepareResume`, the launch record, provider account preparation and the saved cwd. It does not create a replacement session or type a resume command into a live PTY.

Missing or syntactically invalid provider IDs, unsupported providers and unavailable launch folders refuse before a PTY is spawned. The record stays exited/restorable and the host history is retained; inspect it with `quirky terminal history <session>` rather than silently replacing the agent with a shell. Provider IDs continue to come from the existing hook capture path. A syntactically valid but stale provider ID has no separate public existence-check API; the provider CLI remains authoritative when the restore process starts.

The terminal pane Fork command is `command:quirky.terminal/fork-agent-session({ session })`. It accepts the exact pane session ID, refuses shells and stale/mismatched sessions, then calls `quirky.session/resume({ session, fork: true })` and opens only the distinct returned session. The public session resolver remains authoritative for provider support and fork-ID validation.

## Desktop presentation

Session views use shared tabs, menus, prompt dialogs, status dots and controls in both host themes. Detailed status, progress, unread reasons, close actions and shortcuts remain available. The terminal plugin's effective worktree view normally takes precedence; disabling it exposes the session plugin's fallback view without a second registration path. Session Info remains a separate right-bottom tool, with History and Transcript as center views; its accordion state and inspection/actions remain daemon-owned.

Background session transcripts hide hook system events and empty assistant turns by default. Check **Show all events** to include them; conversation messages and other system events remain visible either way.
