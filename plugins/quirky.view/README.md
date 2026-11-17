# Views (`quirky.view`)

`quirky.view` lets an agent draw a view in its chat with `quirky view`. A view is a JSON spec built from a fixed catalog of components. The daemon checks the whole spec before storing it, so nothing renders half-built, and the window draws it with its own components. This plugin holds the catalog, the checks, the stored views and the action routing. The renderer is added separately.

## Public API and CLI

| Method | Request | Behavior |
|---|---|---|
| `quirky.view/open` | `{spec, placement?}` | Checks and stores a view for the caller's live session; returns `{viewId}`. Placement is `inline` unless `pane` is asked for. The session comes from `caller.sessionAuthority`, never from params. |
| `quirky.view/update` | `{viewId, spec}` | Replaces the content in place and counts the update. Placement and a user's move are kept. |
| `quirky.view/close` | `{viewId}` | Marks the view closed and ends its waits with `{status:'closed'}`. |
| `quirky.view/wait` | `{viewId, timeoutMs?}` | Long-polls (max 60000 ms) for an action: `{action}`, or `{status:'timeout'}`. |
| `quirky.view/list` | `{session}` | The session's views in opening order, closed ones included. |
| `quirky.view/get` | `{viewId}` | One `ViewRecord`. |
| `quirky.view/move` | `{viewId, placement}` | Window only. Records the user's choice; later updates keep it. |
| `quirky.view/action` | `{viewId, name, source, data?}` | Window only. Resolves the waits parked on the view; with none, sends `View action "<name>" from "<title>" (view <viewId>): <JSON of data or {}>` through `quirky.structured/send` with `when: 'idle'`. |

Events: `changed {sessionId, viewId}` after every open, update, close and move, and `rejected {sessionId, title, errors, source}` when an open or update is refused. A refused spec is never stored. `quirky.structured` subscribes to both to write the session journal.

CLI: `quirky view open --spec @file.json [--placement inline|pane]`, `update --id <viewId> --spec @file.json`, `close --id <viewId>` and `wait --id <viewId> [--timeout-ms N]`. A refused spec exits 2 with `path: message; ...` on stderr. Outside an agent session the commands exit 1. `quirky view` with no arguments prints the usage and the catalog guide from `src/core/catalog.ts`.

UI commands use the mounted window's authority; they don't change the agent CLI's session requirements. Discover mounted cards and panes, including embedded cards, before addressing a control:

```sh
quirky ui run command:quirky.view/control --args '{"action":"state"}' --json
quirky ui run command:quirky.view/control --args '{"instance":"<instance>","action":"select-tab","viewId":"<viewId>"}' --json
quirky ui run command:quirky.view/move --args '{"viewId":"<viewId>","placement":"pane"}' --json
quirky ui run command:quirky.view/action --args '{"viewId":"<viewId>","name":"go","source":"button"}' --json
```

The API equivalent is `ui.command.run({id:'command:quirky.view/action',args:{viewId,name,source,data}})`. Move accepts `inline` or `pane`; action data is optional.

`control state` returns `{instances:[...]}` with each mount's opaque `instance`, surface, target, active view, phase, tabs and pending link. Other controls require that exact instance:

- `refresh` retries its read.
- `select-tab` and `dismiss-tab` take an open pane `viewId`. Dismissal only hides the tab locally until its record changes.
- `link-preview` takes the active `viewId` and an absolute HTTP(S) `href`, opening a confirmation without opening the URL.
- `link-cancel` and `link-confirm` take the active `viewId`. Confirm uses only the pending URL; it accepts no replacement URL.

Unmounting invalidates the instance. A changed active card or spec clears link confirmation. Invalid commands reject before effects; draft edits stay local until Send or form submission.

Mobile has no access: no `quirky.view` method is in the mobile authorization list.

## Catalog

`src/core/catalog.ts` is the one place that defines the components, their props and the limits (500 nodes, 12 levels, 256 KiB, 500 table rows, 500 chart points). The guide text and the checks both read it, and every component's example is tested to be valid. Props are strings, with finite numbers in charts and fields and booleans in fields. There are no style, class, event or URL props. Markdown links must be absolute `http(s)` URLs; images are refused. A `field` takes one ask question (select, multiselect, text, number or confirm), checked with the same rules as `quirky.ask` but reimplemented here, and its answer is an action named after the question id.

## Storage

The plugin store holds `views(view_id, session_id, title, spec_json, placement, moved_by_user, updates, created_at, updated_at, closed)`. Views and their counters survive a restart.
