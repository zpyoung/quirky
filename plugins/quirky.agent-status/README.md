# Agent status ownership

Each runtime owns its hook installation, provider event normalization, status rows, and activity feed. Remote hooks are not replayed into a second local status store.

`getOnHost` and `hooksStatusOnHost` read from either `local` or an exact saved paired-peer ID. Remote reads use orchestration's authenticated `peerList`, `peerStatus`, and read-only `peerCall` methods, pin the peer fingerprint, pairing revision, and process incarnation for the request, and return the exact host identity beside the result. An unavailable or replaced peer fails instead of falling back to local data.

CLI examples:

```sh
orca agent-status get <session-id> --host <saved-peer-id> --json
orca agent-status hooks status --host <saved-peer-id> --json
```

`get` and `hooksStatus` remain local-owner reads. `hooksSetup` and `hooksRemove` remain local-owner mutations; this plugin does not forward provider-config writes through the existing federation grant. Remote hook administration requires a separate authenticated owner grant and is not implemented here.
