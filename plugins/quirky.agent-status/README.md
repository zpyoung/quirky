# Agent status ownership

Each runtime owns its hook installation, provider event normalization, status rows, and activity feed. Remote hooks are not replayed into a second local status store.

An idle terminal title displays Idle until the session has shown work or attention. Once work has been observed, a return to an idle title displays Done. Hooks and program-status reports retain their existing precedence over titles.

`getOnHost` and `hooksStatusOnHost` read from local, an exact saved paired-peer ID, or `runtime:<saved owner selector>`. Paired-peer reads retain the existing authenticated, fingerprint- and incarnation-fenced federation path. Owner-runtime reads and hook setup/removal use `quirky.cli/runtimeCall` with the exact saved owner target; returned results keep the target's exact runtime identity. A failed or phone-scoped owner call never falls back to local state or writes.

CLI examples:

```sh
quirky agent-status get <session-id> --host <saved-peer-id> --json
quirky agent-status hooks status --host <saved-peer-id> --json
quirky agent-status hooks status --host 'runtime:dev-laptop' --json
quirky agent-status hooks setup gemini --host 'runtime:dev-laptop'
quirky agent-status hooks remove gemini --host 'runtime:dev-laptop'
```

Without `--host`, hooks setup/removal and status reads retain their local behavior. Paired-peer federation remains read-only; remote config mutation requires a separately saved owner runtime.

## Desktop Activity and Dashboard

Activity remains a registered center view, and its existing right-rail entry renders the feed and empty state in place; filtering and grouping there do not open the center view. The center view retains scriptable worktree filtering. Read and clear actions refresh the feed using its current filters when their requests finish. Agent Dashboard remains a registered center view with its existing tool-stripe entry. Shared controls, agent cards and semantic status dots follow the host theme; detailed status labels, read/clear actions and exact-session navigation remain authoritative. Clear completed stays disabled while data is loading or unavailable, or when no completed thread is loaded. The experimental Dashboard setting still controls its navigation entry. An interrupted or unconfirmed session is not presented as successful completion. Activity cards exclude harness-injected task-notification messages from prompts while retaining the assistant reply as the thread detail.
