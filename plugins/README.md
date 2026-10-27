# Built-in plugins

This directory holds Quirky's built-in plugins, one per subdirectory, each with a `quirky-plugin.json` manifest. The daemon finds it through `QUIRKY_BUILTIN_PLUGINS_DIR`.

## Session Info

`quirky.session-info` contributes the **Session Info** right-column panel and the
`quirky session-info` CLI group. The panel follows the focused main or floating terminal pane.
Shells and nonterminal views show an empty state; every agent has identity and live activity,
while local Claude sessions can also supply usage, context, plan windows and lines changed.

```sh
quirky session-info get --json
quirky session-info get --session <session-id> --json
quirky session-info sections --open '["identity","usage","liveActivity"]' --json
quirky session-info inspect --session <session-id> --json
quirky session-info enable-telemetry --session <session-id>
quirky session-info enable-telemetry --session <session-id> --enabled=false
```

Section preferences live in the daemon and survive window restarts. Stale usage retains the last
successful values and offers **Retry**, including when Hooks & MCP is closed. Identity actions
open session history, focus the exact pane, copy its provider ID, and open or reveal its captured
transcript. History supports resume, fork and copying the resume command; these actions are also
routed public UI commands and require an open window.

Claude telemetry uses a composed, per-launch `--settings` overlay. It never rewrites the user's
`~/.claude` settings. A custom statusline requires explicit consent to chaining; its command,
stdin, successful stdout and formatting fields are preserved. Consent or opt-out applies to the
**next launch**, not an already-running CLI. User `--settings` JSON/files in configured agent
arguments are preserved on launch and resume; the restricted per-launch `extraArgs` allowlist
is unchanged.

Rich telemetry is accepted only for the captured active provider session; late ticks and scans
cannot populate another conversation. Claude hook health is based on observed, correlated
per-launch hook evidence, not a claimed global installation. Transcript reads are bounded to
16 MiB and accept only the recorded local path.
Settings and MCP configuration files are limited to 4 MiB and must resolve to regular files;
symlinks to regular files are supported. Oversized files, pipes and devices are rejected rather
than read without a bound. Configured settings report an error; MCP inspection retains valid
results from the other scopes.

The API schemas are discoverable through `quirky api --json`.
[Behavior and acceptance scenarios](../docs/quirk/specs/2026-10-27-m3-session-info/logic.md).

Launch-hook authors can return structured options through `LaunchPatch.jsonArgs` instead of appending competing
settings flags. The host merges object fields in hook-ID order, replaces arrays/scalars with the
later value, and renders one JSON argument per option. Hook input exposes the accumulated
read-only `jsonArgs` and the original launch record/model/options/extras. Ordinary argument
ordering is unchanged. See the public
[launch types](../packages/protocol/src/plugins.ts) and the
[composition contract](../docs/quirk/specs/2026-10-27-m3-session-info/tech.md#json-launch-argument-composition).
