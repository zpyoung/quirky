# Built-in plugins

This directory holds Quirky's built-in plugins, one per subdirectory, each with a `quirky-plugin.json` manifest. The daemon finds it through `QUIRKY_BUILTIN_PLUGINS_DIR`.

## Background structured sessions

`quirky.structured` runs Claude through its Agent SDK and Codex through `codex app-server` over
stdio JSONL. Neither allocates a PTY. Start a background session from a registered worktree:

```sh
quirky session new --background --agent codex --prompt "Review this repository" \
  --model gpt-5.5 --effort high --json
```

The model and effort use the agent catalog. Omit both to leave the provider defaults untouched.
Raw extra arguments are refused for structured sessions.

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

