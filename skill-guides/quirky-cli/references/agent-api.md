# Agent API: drive the Quirky app from the CLI

Use these commands to read what the app shows, act on it, and follow what happens next, without Computer Use. Every command below prints one JSON envelope with `--json` and fails with a stable error code.

## Discover commands and shapes

```text
QUIRKY schema --json
QUIRKY schema chat send
QUIRKY schema file write
QUIRKY rpc list --json
```

- `schema` lists every command with its summary. `schema <command...>` prints one command's contract: `params` and `result` as JSON Schema, `flags`, `positionalArgs`, `destructive`, `approvalCategory`, `errors` and `stability`. It reads a local table, so it works with Quirky stopped.
- A command with no `params` or `result` is hand-written; read its `flags` and run `QUIRKY <command> --help`.
- `rpc list` names every method the CLI knows. `QUIRKY rpc <method> --params '<json>' [--yes]` calls one directly. `rpc` is unstable: methods and params can change between releases, and `schema` marks them `unstable`. Use a named command when one exists.

## Read JSON, not text

Pass `--json`. Agent terminals set `QUIRKY_OUTPUT=json`, so output is JSON there without the flag. Success is `{"ok": true, "result": ...}`. Failure is `{"ok": false, "error": {"code", "message", "data"}}`. Only `schema` and `events` print something else: `schema --json` is a bare array, and `events` prints one JSON frame per line.

## Branch on the exit code and error code

| Exit | `error.code`         | Meaning                                                   |
| ---- | -------------------- | --------------------------------------------------------- |
| 0    |                      | success                                                   |
| 1    | `internal`           | unexpected failure; the original code is in `data.reason` |
| 2    | `invalid_argument`   | a flag or value is wrong; fix it, do not retry unchanged  |
| 3    | `not_found`          | the workspace, tab, session or request does not exist     |
| 4    | `needs_confirmation` | a person or `--yes` must confirm first                    |
| 5    | `conflict`           | state changed or a selector matched several things        |
| 6    | `unavailable`        | Quirky is not running, has no window, or lacks the method |
| 6    | `timeout`            | `--wait`, `--timeout` or an event wait ran out            |
| 6    | `unauthorized`       | the caller is not allowed; stop and tell the user         |

- `error.data.reason` is the specific cause, for example `no_ui`, `capability_missing`, `preview`, `declined`, `timed_out`.
- `error.data.next` is a list of `{command, why}`. It is never empty for `not_found`, `needs_confirmation`, `conflict` or `unavailable`. Run the first step that fits before guessing.
- Older command families (terminal, browser, worktree, orchestration and the rest) keep their original `error.code` such as `selector_not_found` for the compatibility window. Their stable code is in `error.data.stableCode`, and their exit code follows this table. Read `data.stableCode ?? code` if you handle both families.

## Preview a destructive call, then confirm

A destructive command run without `--yes` changes nothing. It exits 4 with `needs_confirmation`, `data.reason: "preview"` and `data.effects`, the list of what would happen.

```text
QUIRKY action run workspace.delete --workspace id:<repoId>::<path> --json
QUIRKY action run workspace.delete --workspace id:<repoId>::<path> --yes --json
```

Show the effects to the user unless they already asked for exactly this, then re-run with `--yes`. A `--yes` call can still wait on the user: when the call's category is set to `ask` under Settings, Agents, Approvals, the app shows an approval prompt and the command blocks until they answer. The categories are `workspace-delete`, `file-overwrite-delete`, `chat-discard-rewind`, `permission-answers` and `security-settings`.

- `needs_confirmation` with reason `declined`: the user refused. Stop and say so. Retrying asks them again.
- `needs_confirmation` with reason `timed_out`: nobody answered in 10 minutes. Retry only when the user is at Quirky.

## Follow events

```text
QUIRKY events --topic ui,workspace,activity
QUIRKY events --topic chat --after 41
QUIRKY events --topic notifications --until notification.raised --timeout 60000
```

- Topics are `chat`, `ui`, `notifications`, `workspace` and `activity`. Without `--topic` you get all of them.
- The first frame is `{"type":"ready","subscriptionId","cursor"}`. Each event is `{seq, at, topic, type, caller?, data}`. Event types: chat `turn.started`, `turn.finished`, `turn.failed`, `turn.needs-input`; ui `focus.changed`, `tab.opened`, `tab.closed`, `view.changed`; notifications `notification.raised`; workspace `worktree.created`, `worktree.removed`, `terminal.exited`, `terminal.idle`, `settings.changed`; activity `activity.recorded`.
- Pass `--after <seq>` to replay events you missed. When the cursor is older than what the app kept, the stream sends `{"type":"events.gap","from","oldest"}` first. Treat that as lost events and re-read state with `ui state` or `chat history`.
- `--until <type>` exits 0 on the first event of that type, and exits 6 if the stream ends first. `--timeout <ms>` ends a plain listen cleanly, and with `--until` it exits 6 `timeout`.
- Without `--after` you only see events from now on. Start the stream, wait for `ready`, then act, so you cannot miss the result.
- `--wait` on `action run` and `chat send` does this for you. `action run --wait` returns on the next `ui` event, or after 2 seconds with the current `ui state`. `chat send --wait` returns when the turn finishes, fails or needs input.

## UI state and actions

```text
QUIRKY ui state --json
QUIRKY action list --available --json
QUIRKY action run view.tasks --wait --json
QUIRKY layout get
```

- `ui state` returns `worktreeId`, `view`, `tab`, `paneId`, `panels` and `editorFile`. It needs the app window.
- `action list --available` shows the actions that apply now. Without `--available` each entry carries `available` and a `reason`. `destructive` marks the ones that need `--yes`. Some actions run only in the window and answer `unavailable` with reason `not_applicable`.
- `action run <id>` takes `--workspace <selector>` for actions that act on a workspace (`workspace.delete` requires it). It returns `{claimed: true}`.
- `layout get` prints one layout frame as JSON, without the `ok` envelope.

## Tabs of every type

`tab` commands take `--type all|terminal|editor|markdown|chat|browser`. With `--type` unset they act on browser tabs as before.

```text
QUIRKY tab list --type all --json
QUIRKY tab focus <id> --type all
QUIRKY tab close --page <id> --type all
QUIRKY tab move <id> --to-group <groupId> --type all
QUIRKY tab pin <id> --type all
```

- Each row has `id`, `type`, `title`, `active`, `pinned`, `worktree` and `groupId`. Add `--worktree <selector>` to list one workspace. Without it you see every workspace, and a tab id open in two workspaces needs `--worktree` or the command exits 5.
- `tab close` takes `--page <id>` or `--index <n>`, not a positional id.
- `tab create` opens browser tabs only. For other types use `terminal create` or `file open`.

## Chat sessions

```text
QUIRKY chat create --workspace id:<repoId>::<path> --agent claude --json
QUIRKY chat send <session> "run the tests" --wait --timeout 300000 --json
QUIRKY chat requests <session> --json
QUIRKY chat respond <session> <request> --allow --yes --json
QUIRKY chat history <session> --limit 20 --json
```

- `chat create` prints `sessionId`. `--message <text>` sends the first message; `--model <id>` picks a model.
- `chat send --wait` returns `status` as `finished`, `failed` or `needs-input`, plus `turnId` and `lastAssistantMessage`. On `needs-input`, call `chat requests`. The default wait is 10 minutes.
- `chat respond` takes exactly one of `--allow`, `--deny`, `--option <id>` or `--answer <text>`. A permission answer needs `--yes`, otherwise it exits 4. An unknown request id exits 3.
- `chat history` pages backwards: when `hasOlder` is true, pass `--before <nextBefore>` for the next page.
- `chat list`, `cancel`, `rewind`, `clear`, `resume` and `options get|set` also exist. `rewind` and `clear` need `--yes`.

## Settings, notifications, plugins, files

```text
QUIRKY settings get compactWorktreeCards --json
QUIRKY settings set compactWorktreeCards true --json
QUIRKY notifications list --json
QUIRKY notifications dismiss <id> --json
QUIRKY plugins list --json
QUIRKY plugins run <pluginKey> <commandId> --json
QUIRKY file read <path> --worktree id:<repoId>::<path> --json
QUIRKY file search --worktree id:<repoId>::<path> --query "TODO" --max-results 20 --json
QUIRKY file write <path> --worktree id:<repoId>::<path> --params-json '{"content":"..."}' --yes --json
```

- `settings get` without a key returns every setting; `settings list` prints key and value lines. `settings set` reads the value as JSON when it parses, else as text. Setting `agentDefaultEnv`, `agentDefaultArgs`, `nativeChatPermissionMode` or `agentStatusHooksEnabled` is a `security-settings` change: the user may be asked, and against a remote server it needs `--yes`.
- `notifications list` takes `--last-seen-seq <n>` to read only newer ones.
- `plugins enable <key>` and `plugins disable <key>` toggle a plugin.
- `file read|write|search|list` act on workspace files. `file write` replaces the whole file, so it is destructive: preview first, then `--yes`. `file open`, `diff` and `open-changed` are the older commands that show a file in the editor.
- Nested params for a generated command go in `--params-json`; named flags override matching keys.

## When the app has no window or is too old

- A headless host (`quirky serve`) answers `ui state`, `action list`, `action run` and `layout get` with `unavailable`, reason `no_ui`. Commands that need no window, such as `file`, `settings` and `events`, still work; otherwise start the desktop app.
- A runtime that predates a command answers `unavailable`, reason `capability_missing`, with `next: quirky status`. Run `status`, tell the user the app needs updating, and do not try the method through `rpc` unless `rpc list` names it.
- `unavailable` with reason `runtime_unavailable` means Quirky is not running: run `QUIRKY open --json`, then retry once.
