# Agent status ownership

Each runtime owns its hook installation, provider event normalization, status rows, and activity feed. Remote hooks are not replayed into a second local status store.

`getOnHost` and `hooksStatusOnHost` read from local, an exact saved paired-peer ID, or `runtime:<saved owner selector>`. Paired-peer reads retain the existing authenticated, fingerprint- and incarnation-fenced federation path. Owner-runtime reads and hook setup/removal use `quirky.cli/runtimeCall` with the exact saved owner target; returned results keep the target's exact runtime identity. A failed or phone-scoped owner call never falls back to local state or writes.

CLI examples:

```sh
orca agent-status get <session-id> --host <saved-peer-id> --json
orca agent-status hooks status --host <saved-peer-id> --json
orca agent-status hooks status --host 'runtime:dev-laptop' --json
orca agent-status hooks setup gemini --host 'runtime:dev-laptop'
orca agent-status hooks remove gemini --host 'runtime:dev-laptop'
```

Without `--host`, hooks setup/removal and status reads retain their local behavior. Paired-peer federation remains read-only; remote config mutation requires a separately saved owner runtime.
