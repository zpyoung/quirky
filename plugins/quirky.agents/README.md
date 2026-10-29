# Agent provider models

Model discovery is provider-owned and host-specific. `local` means this agent runtime; a nonlocal host may be an exact saved peer ID for the existing read-only federation path, or `runtime:<saved owner selector>` for an owner-scoped call through `quirky.cli/runtimeCall`. Runtime results retain the exact safe owner identity and the target result's own `host` value; they are never relabeled as local or replaced with a local probe.

Codex uses its real stdio app-server `model/list` operation with read-only, no-approval, and plugins-disabled flags. It derives the launch environment from `quirky.agents/plan` and `quirky.accounts/prepareProviderEnv`, preserving the selected account home without creating an account session.

If account preparation is unavailable, Codex discovery refuses to start the provider process and preserves the previous model catalog; it never bypasses account preparation with an inherited `CODEX_HOME`.

Claude uses the official Models API `GET https://api.anthropic.com/v1/models`, with `limit=1000`, `after_id` pagination, `anthropic-version: 2026-10-21`, and the selected account's API key as a bearer credential. The selected profile is prepared with `quirky.accounts/prepareProviderEnv`; `account.authKind` must be `api-key` before a profile or inherited key is used. Explicit `ANTHROPIC_API_KEY` launch configuration is honored; OAuth tokens are never sent to this API. Keys are never returned. Model effort options are taken from each API model's `capabilities.effort`.

Both probes require complete, nonempty valid snapshots before they update that host's catalog or emit `modelSnapshot`. Empty, malformed, unavailable, unsupported, truncated, and timed-out probes preserve the prior catalog and choices. HTTP probe time is capped at 8 seconds; response and normalized snapshot size at 256 KiB; pagination at 32 pages and 4096 models. The Anthropic protocol follows the official [List Models reference](https://docs.anthropic.com/en/api/models-list), [API overview and authentication headers](https://docs.anthropic.com/en/api/overview), and [API versioning documentation](https://docs.anthropic.com/en/api/versioning), which requires `anthropic-version: 2026-10-21`.

Gemini Models API and Pi RPC discovery use their documented provider protocols. They do not create managed accounts or sessions; their credential and runtime boundaries are described below.
Gemini uses the official [Models API](https://ai.google.dev/api/models) with `pageSize=1000`, `nextPageToken` pagination, and `generateContent` filtering; launch IDs use `baseModelId`. `GEMINI_API_KEY` or `GOOGLE_API_KEY` is accepted only from an explicit per-agent launch environment; if both are set there, `GOOGLE_API_KEY` takes precedence. The key is sent in `x-goog-api-key`, never taken from ambient system variables or Gemini OAuth credentials.

Pi runs `pi --mode rpc --no-session` and queries the documented [JSONL RPC](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/rpc.md) `get_available_models` command. IDs retain the exact `provider/modelId` accepted by Pi's [`--model` option](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/cli.md). For reasoning-enabled models, `set_model` and `get_available_thinking_levels` provide exact per-model `--thinking` choices. The process uses the planned launch environment and real provider home without inventing an account or session.

All provider probes need a complete nonempty snapshot before replacing choices. Requests/processes time out after 8 seconds; output and normalized snapshots are capped at 256 KiB; API pagination at 32 pages/4096 records; and selector catalogs at 500 models. Credentials and pagination tokens are never returned.

Agent contribution metadata may omit `homepage` and `install`; when provided, each must be an HTTP(S) URL. Invalid metadata is reported as an invalid contribution rather than exposing a non-web link in the catalog.

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

Custom agent declarations must include a prompt mode. Their `homepage` and `install` links accept only HTTP(S) URLs; invalid links exclude that declaration from the catalog and appear in `agents list --all`.

Provider process creation remains owned by `quirky.session`. To launch remotely, call `quirky.cli/runtimeCall` for the saved target with `method: "quirky.session/create"`; do not return a target launch plan to a local session owner or relabel local execution as remote.

## Desktop configuration

The Agents center view uses the shared graphite controls and theme tokens. Default agent, permissions, detection/refresh, enable switches, command/argument/environment overrides and workspace trust keep their existing public APIs. Fields save on Enter or blur (Cmd/Ctrl+Enter for multiline environment values); Reset removes that override. Appearance follows the host's dark/light choice.
