# Agent provider models

Model discovery is provider-owned and host-specific. `local` means this agent runtime; a nonlocal host must be an exact saved peer ID and is probed only through the authenticated `quirky.orchestration/peerList`, `peerStatus`, and `peerCall` authority. An unavailable or unsupported peer is never replaced by a local probe.

The built-in Codex probe runs the real stdio app-server `model/list` operation with read-only, no-approval, and plugins-disabled flags. It derives the launch environment from `quirky.agents/plan` and `quirky.accounts/prepareProviderEnv`, preserving the active account home without creating an account session. If account preparation fails, no process is started. Managed Codex config sync is limited to the owned account profile; no System default provider config or credentials are written or returned. Output and lifetime are bounded, and stderr is not returned.

Only a successful, authoritative, nonempty model snapshot updates that agent's catalog for its exact host and emits `modelSnapshot`. Empty, malformed, unavailable, and unsupported results do not retire saved picks. Model resolution is performed by the same provider host that owns the catalog.

CLI examples:

```sh
orca agents options codex
orca agents options codex --host <saved-peer-id>
orca agents discover-models codex --host local
orca agents resolve codex --host <saved-peer-id> --model <id>
```
