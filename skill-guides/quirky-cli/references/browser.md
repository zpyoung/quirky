# Built-in browser commands

Use a snapshot-interact-re-snapshot loop:

```text
QUIRKY goto --url https://example.com --json
QUIRKY snapshot --json
QUIRKY click --element @e3 --json
QUIRKY snapshot --json
```

Common commands:

```text
QUIRKY goto --url <url> --json
QUIRKY back --json
QUIRKY reload --json
QUIRKY snapshot --json
QUIRKY screenshot --json
QUIRKY full-screenshot --json
QUIRKY pdf --json
QUIRKY click --element <ref> --json
QUIRKY fill --element <ref> --value <text> --json
QUIRKY type --input <text> --json
QUIRKY select --element <ref> --value <value> --json
QUIRKY check --element <ref> --json
QUIRKY scroll --direction down --amount 1000 --json
QUIRKY hover --element <ref> --json
QUIRKY focus --element <ref> --json
QUIRKY keypress --key Enter --json
QUIRKY upload --element <ref> --files <paths> --json
QUIRKY wait --text <text> --json
QUIRKY wait --url <substring> --json
QUIRKY wait --selector <css> --json
QUIRKY wait --load networkidle --json
QUIRKY eval --expression <js> --json
QUIRKY tab list --json
QUIRKY tab create --url <url> --json
QUIRKY tab switch --index <n> --json
QUIRKY tab close --index <n> --json
QUIRKY cookie get --json
QUIRKY capture start --json
QUIRKY console --limit 50 --json
QUIRKY network --limit 50 --json
QUIRKY exec --command "help" --json
```

Browser rules:

- Re-snapshot after navigation, tab switches, clicks that change the page, and any `browser_stale_ref`.
- Refs like `@e1` are assigned by `snapshot`, scoped to one tab, and invalidated by navigation or tab switch.
- Browser commands default to the current worktree and its active tab. Use `--worktree all` only intentionally.
- For concurrent browser work, run `QUIRKY tab list --json`, read `tabs[].browserPageId`, and pass `--page <browserPageId>` on later commands.
- Use typed tab commands (`QUIRKY tab list/create/close/switch`), not `QUIRKY exec --command "tab ..."`, so Quirky keeps UI state synchronized.
- Prefer `wait --text`, `--url`, `--selector`, or `--load` after async page changes instead of bare timeouts.
- Anything not listed above goes through `QUIRKY exec --command "<agent-browser command>"`.
- If `fill` or `type` fails on a custom input, try `QUIRKY focus --element @e1 --json` then `QUIRKY inserttext --text "text" --json`.
- A client-hosted page renders in the paired desktop's browser engine, so every command against it needs that desktop online and returns `browser_host_unavailable` while it is closed, asleep, or disconnected. Server-hosted pages run with no desktop attached; prefer them for long or unattended automation.

Common recoveries:

- `browser_no_tab`: open a tab with `QUIRKY tab create --url <url> --json`.
- `browser_stale_ref`: run `QUIRKY snapshot --json` and retry with fresh refs.
- `browser_tab_not_found`: run `QUIRKY tab list --json` before switching or closing.
- `browser_host_unavailable`: the desktop hosting the page is offline. Bring it back, or recreate the page with server placement if the work must outlive the desktop session.
