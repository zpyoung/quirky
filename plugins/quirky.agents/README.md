# Agent provider models

Model discovery is provider-owned and host-specific. `local` means this agent runtime; a nonlocal host may be an exact saved peer ID for the existing read-only federation path, or `runtime:<saved owner selector>` for an owner-scoped call through `quirky.cli/runtimeCall`. Runtime results retain the exact safe owner identity and the target result's own `host` value; they are never relabeled as local or replaced with a local probe.

Codex uses its real stdio app-server `model/list` operation with read-only, no-approval, and plugins-disabled flags. It derives the launch environment from `quirky.agents/plan` and `quirky.accounts/prepareProviderEnv`, preserving the selected account home without creating an account session.

Claude uses the official Models API `GET https://api.anthropic.com/v1/models`, with `limit=1000`, `after_id` pagination, `anthropic-version: 2026-10-21`, and the selected account's API key as a bearer credential. The selected profile is prepared with `quirky.accounts/prepareProviderEnv`; `account.authKind` must be `api-key` before a profile or inherited key is used. Explicit `ANTHROPIC_API_KEY` launch configuration is honored; OAuth tokens are never sent to this API. Keys are never returned. Model effort options are taken from each API model's `capabilities.effort`.

Both probes require complete, nonempty valid snapshots before they update that host's catalog or emit `modelSnapshot`. Empty, malformed, unavailable, unsupported, truncated, and timed-out probes preserve the prior catalog and choices. HTTP probe time is capped at 8 seconds; response and normalized snapshot size at 256 KiB; pagination at 32 pages and 4096 models. The Anthropic protocol follows the official [List Models reference](https://docs.anthropic.com/en/api/models-list), [API overview and authentication headers](https://docs.anthropic.com/en/api/overview), and [API versioning documentation](https://docs.anthropic.com/en/api/versioning), which requires `anthropic-version: 2026-10-21`.

Other protocols, including Gemini's models API and Pi's `get_available_models` RPC, are not declared or implemented here. They must not be reported as successful discovery until their real protocol is implemented with the correct selected-account authority.

CLI examples:

```sh
quirky agents options codex
quirky agents options claude --host local
quirky agents discover-models claude --host local
quirky agents options claude --host 'runtime:dev-laptop'
quirky agents discover-models claude --host 'runtime:dev-laptop'
quirky agents resolve claude --host 'runtime:dev-laptop' --model <id>
quirky agents configure claude --host 'runtime:dev-laptop' --command claude
```

Provider process creation remains owned by `quirky.session`. To launch remotely, call `quirky.cli/runtimeCall` for the saved target with `method: "quirky.session/create"`; do not return a target launch plan to a local session owner or relabel local execution as remote.
