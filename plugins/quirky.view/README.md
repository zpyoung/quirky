# Views (`quirky.view`)

`quirky.view` lets an agent draw a view in its chat with `quirky view`. A view is a JSON spec built from a fixed catalog of components. The daemon checks the whole spec before storing it, so nothing renders half-built, and the window draws it with its own components. This plugin holds the catalog, the checks, the stored views and the action routing. The renderer is added separately.

## Public API and CLI

| Method | Request | Behavior |
|---|---|---|
| `quirky.view/open` | `{spec, placement?}` | Checks and stores a view for the caller's live session as version 1; returns `{viewId}`. Placement is `pane` unless `inline` is asked for. The session comes from `caller.sessionAuthority`, never from params. |
| `quirky.view/update` | `{viewId, spec}` | Makes the spec the view's next version. Placement and a user's move are kept. |
| `quirky.view/patch` | `{viewId, ops}` | Applies up to 200 RFC 6902 `add`, `replace` and `remove` ops (JSON Pointer paths; `-` appends; `~0` and `~1` escape) to the latest spec as the next version; returns `{viewId, version}`. All or nothing, and the result is checked like any spec. |
| `quirky.view/close` | `{viewId}` | Marks the view closed and ends its waits with `{status:'closed'}`. |
| `quirky.view/wait` | `{viewId, timeoutMs?}` | Long-polls (max 60000 ms) for an action: `{action}`, or `{status:'timeout'}`. |
| `quirky.view/list` | `{session}` | The session's views in opening order, closed ones included. |
| `quirky.view/get` | `{viewId, version?}` | One `ViewRecord`: the latest version, or the one asked for (an unknown version is not found). `updates` is always `latestVersion - 1`. |
| `quirky.view/move` | `{viewId, placement}` | Window only. Records the user's choice; later updates keep it. |
| `quirky.view/render-failed` | `{viewId, version, error}` | Window only. The window could not draw a version. Marks the latest version of an open view refused and, when its session is live, sends `Visual "<title>" v<version> didn't render: <error>. Fix it with quirky view update or patch (view <viewId>).` through `quirky.structured/send` with `when: 'idle'`. Once per `(viewId, version)`: a repeat returns `{duplicate: true}`, and a report for any other version or a closed view returns `{ignored: true}`. |
| `quirky.view/action` | `{viewId, name, source, data?}` | Window only. Resolves the waits parked on the view; with none, sends `View action "<name>" from "<title>" (view <viewId>): <JSON of data or {}>` through `quirky.structured/send` with `when: 'idle'`. |

Events: `changed {sessionId, viewId, version, kind}` after every open, update, patch, close and move, and when a refusal or render failure is recorded (`kind` is `open`, `update`, `patch`, `close`, `move`, `refused` or `render-failed`; `version` is the view's latest version afterwards). `rejected {sessionId, title, errors, source}` fires when an open, update or patch is refused. A refused spec is never stored, and `quirky.structured` subscribes to both to write the session journal.

CLI: `quirky view open --spec @file.json [--placement inline|pane]`, `update --id <viewId> --spec @file.json`, `patch --id <viewId> --ops <json|@file>`, `get --id <viewId> [--at-version N]`, `close --id <viewId>` and `wait --id <viewId> [--timeout-ms N]`. A refused spec or patch exits 2 with `path: message; ...` on stderr. `get` prints `{viewId, title, version, latestVersion, spec}` as one JSON line so an agent can reload a visual the user pointed at. The version flag is `--at-version` because `--version` is a global CLI switch that plugin commands cannot declare. Outside an agent session the commands exit 1. `quirky view` with no arguments prints the usage and the catalog guide from `src/core/catalog.ts`.

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

`src/core/catalog.ts` is the one place that defines the components, their props and the limits (500 nodes, 12 levels, 256 KiB, 500 table rows, 500 chart points). The guide text and the checks both read it, and every component's example is tested to be valid. Props are strings, with finite numbers in charts and fields and booleans in fields. There are no style, class, event or URL props. Markdown links must be absolute `http(s)` URLs; images are refused. Math in a `markdown` node (`$x^2$`, `$$x^2$$`) is typeset by the renderer; it has no kind of its own.

Every node may carry an `id` (lowercase letters, digits and dashes, at most 40 characters), as may timeline items, board cards and sketch shapes. Ids are unique in a spec and are what pointing and the change highlight key on.

The visual kinds and the checks the daemon runs on them, each refused on the same call with `path: message`:

| Kind | Props | Daemon checks |
|---|---|---|
| `diagram` | `source` (Mermaid, 20 KiB), `caption?` | `source` must not trip `loadsImages` from `packages/ui/src/markdown/blocks/mermaid-safety.ts`. The daemon does not parse Mermaid, so a diagram that fails to draw comes back through `render-failed`. |
| `image` | `path`, `alt`, `caption?` | `path` is relative to the worktree, has no `..` segment, no leading `/` and no scheme, and ends in png, jpg, jpeg, gif, webp or svg. |
| `html` | `html` (128 KiB), `interactive`, `height?` (120 to 1200) | No `http:`, `https:` or `//` URL in `src`, `href`, `action`, `srcset`, `poster` (and `formaction`, `xlink:href`, `data`, `ping`) or CSS `url()` / `@import`. |
| `live-preview` | `url`, `caption?` | `http://` on `localhost`, `127.0.0.1` or `*.quirky.localhost`, with no credentials. |
| `timeline` | `items` (1 to 100: `id?`, `label`, `start`, `end?`, `tone?`) | |
| `board` | `columns` (1 to 8, each with up to 50 `cards`: `id?`, `title`, `detail?`, `tone?`) | |
| `matrix` | `columns` (1 to 12), `rows` (1 to 50: `label`, `cells`, `highlight?`) | A row has one cell per column, and `highlight` names columns. |
| `annotated-code` | `language`, `code` (64 KiB), `notes` (0 to 50: `lines`, `note`) | `lines` is `"4"` or `"3-7"`, inside the code's line count. |
| `file-map` | `entries` (1 to 300: `path`, `status`, `note?`) | |
| `plot` | `xLabel?`, `yLabel?`, `series` (1 to 8, each with 2 to 500 `points`) | |
| `sketch` | `width`, `height`, `shapes` (1 to 200: `id?`, `kind`, `x`, `y`, `w?`, `h?`, `x2?`, `y2?`, `label?`) | |

`catalogGuide()` documents each kind with a summary and a valid example, and the examples are tested. A `field` takes one ask question (select, multiselect, text, number or confirm), checked with the same rules as `quirky.ask` but reimplemented here, and its answer is an action named after the question id.

## Storage

The plugin store holds `views(view_id, session_id, title, spec_json, placement, moved_by_user, updates, created_at, updated_at, closed, version, refused_json)` and `view_versions(view_id, version, spec_json, created_at)`. `views` keeps the latest spec so a list is one table read, and every version, the latest included, has a `view_versions` row. Views, versions and the refused state survive a restart.

Migration 2 adds `view_versions`, `version` and `refused_json`, and gives every view that existed before it a version 1 from its current spec. `updates` is read as `version - 1`, so a view that was updated before the migration reports 0 updates afterwards.

A refused `update` or `patch` on an existing view stores `refused = {attempt, version: null, errors, source, at}` and leaves the latest version alone; a `render-failed` stores `attempt: 'render'` and the version that failed. The next successful version clears it.
