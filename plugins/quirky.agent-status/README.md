# Agent status ownership

Each runtime owns its hook installation, provider event normalization, status rows, and activity feed. Remote hooks are not replayed into a second local status store.

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

Activity and Agent Dashboard remain registered center views, with their existing tool-stripe entries. Shared controls, agent cards and semantic status dots follow the host theme; detailed status labels, filters, read/clear actions and exact-session navigation remain authoritative. The experimental Dashboard setting still controls its navigation entry. An interrupted or unconfirmed session is not presented as successful completion.
