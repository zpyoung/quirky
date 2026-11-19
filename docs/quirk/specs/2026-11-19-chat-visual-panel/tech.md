# Visual panel in native chat — tech spec

**Status:** Reviewed (complexity gate fired: crosses the quirky.view, quirky.structured, quirky.session and protocol subsystems).
**Logic spec:** [logic.md](logic.md). The signed-off mock is [mock/mock.html](mock/mock.html), and the inventory is [mock/screens.md](mock/screens.md).

All paths are relative to the repo root. `S/` means `plugins/quirky.session/src/window/chat/`, and `V/` means `plugins/quirky.view/`.

## Architecture

There are four units. Each one sits in a single plugin or package, and they meet only at the contracts pinned below.

| Unit | Home | Owns |
|---|---|---|
| **View core** | `V/main.ts`, `V/cli.ts`, `V/cli-spec.ts`, `V/quirky-plugin.json`, `V/src/core/*` | the new catalog kinds and their checks, version history, `patch`, `get --version`, the refused state, window-reported render failures, the default placement change, and `quirky view` guide text |
| **View renderer** | `V/src/render/*`, `V/src/Pane.tsx`, `V/src/ui.tsx`, `V/src/control.ts` | drawing every kind, pointable elements, card chrome (stepper, change highlight, didn't-render badge, drawing state, expand and pop out), the sandboxed HTML frame, and render-failure reporting |
| **Runners** | `plugins/quirky.structured/*`, `packages/protocol/src/chat.ts` | visual guidance at session start for Claude, Codex, pi and omp, the per-chat visual level (configure, journal, per-turn marker), and per-version `view` journal items |
| **Chat UI** | `S/*`, `plugins/quirky.session/src/drafts.ts`, `plugins/quirky.session/main.ts`, `plugins/quirky.session/quirky-plugin.json` | the docked panel shell (divider, persisted width, adaptive grid and filmstrip, collapse and rail, plan inside, expand), message visual chips, the Visualize icon, the dial, reference pills, and stripping the level marker |

Data flow, by logic-spec anchor:

- The agent sends a spec, and `V/` checks it, stores it and emits `changed`. The window then fetches it by id and version. See [Data flow](logic.md#data-flow).
- `quirky.structured` turns `changed` into `view` items, and the turn renders chips from them.
- `ChatView` lists the session's views and lays out the panel.
- Each card is a mounted `view:quirky.view/render`.
- A click on a pointable element runs a quirky.session command that inserts a pill into the composer.

Libraries in play:

- `mermaid`, through `packages/ui/src/markdown` (`MermaidFence`, `loadsImages`, `sanitizeSvg`, `withRemoteImagesBlocked`, `NO_HTML_LABELS`)
- KaTeX math, through `QuirkyMarkdown`
- `@anthropic-ai/claude-agent-sdk` `query()`
- the Codex app-server v2 protocol (`developerInstructions` on `ThreadStartParams` and `ThreadResumeParams`, verified on codex-cli 0.158.0)
- the pi and omp `--append-system-prompt` flag (verified in both CLIs' `--help`)
- `desktop.window.open`

## Code references

### View core
- `V/src/core/contract.ts`: the `CATALOG_TYPES` tuple (`:2-19`), `ViewNode` and `ViewSpec` (about `:23-27`), `ViewRecord` (`:29-40`) and `ViewAction`. **Shared with the renderer.** Extend these here.
- `V/src/core/catalog.ts`:
  - `COMPONENTS` (`:406`), the `Component`/`Field`/`Shape` types (`:54-71`) and the limits (`:30-39`)
  - `validateViewSpec` (`:855`), `readNode` (`:787`), where per-type semantic hooks go, as `checkTableWidth` does at `:820`
  - `checkMarkdown` (`:330`), `formatViewErrors` (`:878`) and `catalogGuide` (`:883`)
- `V/src/core/store.ts:5-19`: the `views` schema, and `replaceSpec` (`:81`).
- `V/main.ts:38`: the migrations array `[viewsMigration]`. Append, never edit.
- `V/main.ts:14`: `sessionOf`. `:65`: `windowOnly`. `:77-121`: method wiring.
- `V/src/core/views.ts`: `ViewService` `open` (`:78`), `update` (`:102`), `close` (`:110`), `move` (`:130`), `wait` (`:139`) and `action` (`:172`). Also `changed()` (`:220`) and `reject()` (`:258`).
- `V/cli.ts:86-118`: the `commands` map. `V/cli-spec.ts:8`: reads `--spec`.
- `V/quirky-plugin.json`: declares methods, events and `cli-command` entries. `cli.test.ts` checks that the manifest and module agree.

### View renderer
- `V/src/render/RenderNode.tsx`: a type switch over `layout.tsx`, `data.tsx`, `charts.tsx`, `controls.tsx` and `Markdown.tsx`. Prop readers live in `props.ts`.
- `V/src/render/ViewCard.tsx`: `ViewCardView` (`:176`) fetches through `quirky.view/get` and reloads on `quirky.view/changed`. The card body is at `:79-173`, and the runtime `send` is at `:84`.
- `V/src/Pane.tsx`: `ViewsPane`. `V/src/ui.tsx`: registers `view:quirky.view/render` (input `{viewId}`) and `view:quirky.view/pane` (input `{session}`).
- `V/src/control.ts`: the `move`, `action` and `control` commands.
- `packages/ui/src/markdown/components.tsx:18`: the `MermaidFence` registry entry. `packages/ui/src/markdown/blocks/MermaidBlock.tsx`, with `summarize` at `:62`.
- `packages/ui/src/design-system/read-only-preview.tsx:7-10, 46-50`: the existing sandboxed `srcDoc` iframe with a meta CSP. This is the pattern for the HTML frame, though not reusable as is because it has `script-src 'none'`.
- `plugins/quirky.session/src/markdownAssets.ts:5-85`: the `quirky.session/markdownAssets` image resolver. Its caller is `S/Prose.tsx:132-135`.
- `packages/ui/src/native-browser.ts:1181-1215`: `createNativeBrowserCapability`, which allows one resident native view per window. `plugins/quirky.browser` shows the mount pattern.

### Runners
- `plugins/quirky.structured/runner.ts`:
  - `StructuredStartOptions` (`:70`), the start inputs
  - `StructuredSettings` (`:86`)
  - the `StructuredRunner` interface (`:89`)
- `plugins/quirky.structured/claude-runner.ts`: the `query({prompt, options})` options object (`:403-418`), and `write(run, text)` (about `:443`).
- `plugins/quirky.structured/codex-runner.ts`: `thread/start` (`:339`), `thread/resume` (about `:323`) and `turn/start` (`:603`).
- `plugins/quirky.structured/pi-rpc.ts:55-65`: `piLaunchArgs`. `pi-runner.ts:471`: spawn. `pi-runner.ts:549`: the prompt RPC.
- `plugins/quirky.structured/main.ts`:
  - `startRunner` (defined at `:846`, called at `:1092` and `:1292`), and the `launchOptions` object it receives (built at `:1086`)
  - `send` param validation (`:1439`)
  - the `configure` allow-list (`:1562-1572`)
  - `quirky.structured/settings` (about `:1607`)
  - the `quirky.view/changed` and `quirky.view/rejected` subscribers (`:1934-1960`), including the once-per-view `entry.viewIds` guard
- `packages/protocol/src/chat.ts:9-38`: the `ChatItem` union, with `view` and `view-error` at `:28-29` and `mode` at `:46`.

### Chat UI
- `S/ChatView.tsx`:
  - the `body` row (`:37`, rendered at `:542`) and the transcript column (`:544`)
  - the `pane` style (`:64`) and the `plan` style (`:72`)
  - the Views aside (`:581-583`) and the Plan aside and sheet (`:586-592`)
  - `usePaneViews` (`:121`), `usePlanFits` (`:163`) and `PLAN_ASIDE_MIN_UNITS` (`:20`)
- `S/Embedded.tsx`: `mountView`, keyed on the stringified input. `S/Turn.tsx:15-16`: the view ids, and `:119-120` renders the `view` and `view-error` blocks. `S/turns.ts:27-28`: `Block`.
- `S/Composer.tsx`: `picks`, `pick()` (about `:157`, which calls `quirky.structured/configure`) and the toolbar (about `:560`). `S/controls.tsx`: `Picks` (`:20`) and `useTurnSettings`. `S/SettingsChip.tsx`.
- `S/composerDraft.ts:65`: `useDraftSync`. `plugins/quirky.session/src/drafts.ts:37`: `isDraft`, which is strict about the picks keys.
- `S/editor/pills.ts:9`: `parsePills` and its regex. `S/editor/types.ts`: `Pill`. `S/Prose.tsx:51`: the `MENTION` regex. `S/Prose.tsx:101`: `renderUserMarkdown`.
- `S/PlanPanel.tsx` and `S/plan.ts:10`: `planVersions`.
- `packages/protocol/src/kernel-schemas.ts:885`: `desktop.window.open`. The example caller is `plugins/quirky.agent-status/src/ui.tsx:70`.

## Contracts & interfaces

### C1. Catalog additions ([Kinds and the safety line](logic.md#behaviour--scenarios), SC-12, SC-13)
Every node may carry an optional `id` matching `ACTION_NAME_PATTERN` (`catalog.ts:42`, lowercase letters, digits and dashes only, ≤ 40 chars). The guidance text must state this format. The id is the stable key for pointing and for change highlighting. Ids must be unique within a spec, or the spec is refused with `path: duplicate id '<id>'`.

SCHEMA: new `CatalogType` members and their props. All strings are bounded, and the implementer picks the bounds within the limits below.
```
diagram        { source: string (Mermaid, ≤ 20 KiB), caption?: string }
image          { path: string (relative worktree path; png|jpg|jpeg|gif|webp|svg), alt: string, caption?: string }
html           { html: string (≤ 128 KiB), interactive: boolean, height?: number (px, 120..1200) }
live-preview   { url: string, caption?: string }
timeline       { items: list(1..100) of { id?: string, label: string, start: string, end?: string, tone?: TONE } }
board          { columns: list(1..8) of { title: string, cards: list(0..50) of { id?: string, title: string, detail?: string, tone?: TONE } } }
matrix         { columns: strings(1..12), rows: list(1..50) of { label: string, cells: strings, highlight?: strings } }
annotated-code { language: string, code: string (≤ 64 KiB), notes: list(0..50) of { lines: string ("4" | "3-7"), note: string } }
file-map       { entries: list(1..300) of { path: string, status: enum(added|modified|deleted|renamed|touched), note?: string } }
plot           { xLabel?: string, yLabel?: string, series: list(1..8) of { label: string, points: list(2..500) of { x: number, y: number } } }
sketch         { width: number, height: number, shapes: list(1..200) of { id?: string, kind: enum(box|ellipse|line|arrow|text), x: number, y: number, w?: number, h?: number, x2?: number, y2?: number, label?: string } }
```
Math reuses the existing `markdown` node (`$…$` / `$$…$$`), which KaTeX already renders. No new kind is added for it.

Checks that run in the daemon and return errors to the agent on the same call, through `reject()`:

- `diagram.source` must not trip `loadsImages()` (exported from `packages/ui/src/markdown`). Quirky does not parse Mermaid itself.
- `image.path` must be relative, contain no `..` segment and no leading `/`, and have an allowed extension.
- `html` must contain no `http:`, `https:` or `//` URL in a `src`, `href`, `action`, `srcset`, `poster` or CSS `url()`. The error is `path: remote content is not allowed in html; inline it as data:`.
- `live-preview.url` must be `http://` with host `localhost`, `127.0.0.1` or `*.quirky.localhost`.
- `annotated-code.notes[].lines` must fall within the code's line count.
- `matrix` row `cells` length must equal `columns` length, and `highlight` entries must be column names.
- `board` card ids and `sketch` shape ids follow the same uniqueness rule as node ids.

Every new kind needs a `summary` and a valid `example` in `COMPONENTS`, so `catalogGuide()` documents it and `catalog.test.ts`'s examples-are-valid test covers it.

### C2. Versions ([Arriving, changing and breaking](logic.md#behaviour--scenarios), SC-3, SC-8, SC-18)
- Every successful `open`, `update` and `patch` appends a version. The `open` call stores v1.
- The views row keeps the latest spec, so `list` stays cheap. `updates` is replaced in meaning by `version`, the latest version number.
- A refused spec is never a version.
- CONTRACT:
  - `quirky.view/get {viewId, version?: number}` returns a `ViewRecord` whose `spec`, `version` and `updatedAt` are those of the requested version.
  - `ViewRecord.updates` stays and equals `latestVersion - 1`, so existing readers keep working. `replaceSpec` is replaced by an append-version write that bumps both.
  - `ViewRecord` also gains `latestVersion: number` and `refused: Refused | null`.
  - An unknown version is NotFound.
- CONTRACT: the `quirky.view/changed` event is `{sessionId, viewId, version, kind: 'open' | 'update' | 'patch' | 'close' | 'move' | 'refused' | 'render-failed'}`. Adding fields is backward compatible, and existing subscribers ignore unknown fields.

### C3. Patch ([Changing](logic.md#behaviour--scenarios), SC-3)
- CONTRACT: `quirky.view/patch {viewId, ops: PatchOp[]}` returns `{viewId, version}`.
- `PatchOp` is the RFC 6902 subset `add | replace | remove`. Paths are JSON Pointers into the spec, with `~0` and `~1` escapes, and `-` appends to an array.
- Ops apply atomically to the latest spec, and the result goes through `validateViewSpec`.
- Any failure (a bad pointer, a missing parent or a validation error) goes through `reject()`. The CLI exits 2 with `path: message`, and the stored spec is unchanged.
- At most 200 ops per call.
- The CLI is `quirky view patch --id <viewId> --ops <json|@file>`.

### C4. Refused state and render failures (SC-9, SC-10)
- SCHEMA: `Refused = { attempt: 'open'|'update'|'patch'|'render', version: number | null, errors: string[], source: string (≤ 64 KiB), at: number }`.
- A refused `update` or `patch` on an existing view sets `views.refused_json`. The next successful version clears it.
- A refused `open` has no view, so it keeps today's behavior: a `rejected` event and a `view-error` item.
- CONTRACT: `quirky.view/render-failed {viewId, version, error: string}` is window-only (`windowOnly`).
  - It sets `refused` with `attempt: 'render'`. When the view's session is live, it sends the agent `Visual "<title>" v<version> didn't render: <error>. Fix it with quirky view update or patch (view <viewId>).` through `quirky.structured/send` with `when: 'idle'`.
  - It is deduplicated per `(viewId, version)`, so a second call for the same pair is a no-op returning `{duplicate: true}`.
  - A `render-failed` for a version that isn't the latest is ignored.

### C5. Default placement (SC-17)
`open` with no `placement` now stores `pane`. Inline placement is still accepted, and `move` is unchanged. This deliberately departs from `docs/quirk/specs/2026-11-16-agent-chat/logic.md` SC-13, so update that spec's Amendments log in the same change.

### C6. `quirky view get` CLI (SC-11 support)
`quirky view get --id <viewId> [--version N]` prints the record's `{viewId, title, version, latestVersion, spec}` as a JSON line, so an agent can reload a visual a reference chip names.

### C7. Card mount input (renderer ↔ chat UI; SC-7, SC-8, SC-16, SC-18)
- SCHEMA: `view:quirky.view/render` input is `{ viewId: string, version?: number, surface?: 'inline' | 'panel' | 'thumbnail' | 'expanded' | 'window', drawing?: boolean, focused?: boolean }`.
- The defaults are `surface: 'inline'`, version latest, and `drawing: false`.
- With no `version` the card follows the latest version. With one, it pins to it until the user steps.
- A `thumbnail` card draws a non-interactive scaled preview, with no chrome or pointing.
- Card chrome on every non-thumbnail surface shows the title, a `by <agent>` tag (SC-6; today's badge), the version stepper, expand and pop out. An `html` card with `interactive: true` also shows a `sandboxed · no network` tag (SC-12, Screens "Prototype, default").
- `drawing` is set only by the chat UI (C14). The card shows `drawing <title>` and a pending style while it is true.

### C8. Commands the renderer runs in quirky.session (pointing and expand; SC-11, SC-16)
CONTRACT, registered by quirky.session in its manifest `command` list:
- `command:quirky.session/chat-point {session, viewId, version, element, label}` inserts a visual pill into that session's composer and focuses it. `element` matches `/^[a-z0-9][a-z0-9._:-]{0,79}$/`, and `label` is ≤ 120 chars.
- `command:quirky.session/chat-expand-visual {session, viewId, version?}` enters the expanded layout for that visual.

The renderer runs pop out itself with `desktop.window.open({view: 'view:quirky.view/render', input: {viewId, surface: 'window'}, title})`, gated on `desktop.capabilities` `auxiliaryWindows`. The button is hidden when that capability is missing.

### C9. Pointable elements (SC-11, SC-12)
Each element key is stable across versions when the agent keeps the same ids. The renderer computes keys as follows:

| Kind | Element key | Label |
|---|---|---|
| any node with `id` | `node:<id>` | the node title or label prop |
| diagram | `dg:<mermaid node id>`, read from the rendered SVG's node group ids | the node text |
| table | `row:<index>` | the first cell |
| bar-chart / line-chart | `pt:<category>` | category and value |
| timeline / board / sketch | `item:<id or index>` | the item label |
| matrix | `cell:<row>:<column>` | row › column |
| file-map | `file:<index>` | the path |
| annotated-code | `line:<n>` | `line <n>` |
| image | `region:<x%>-<y%>` | `region near <x%>,<y%>` |
| html | `pt:<data-point value>` | the element's `data-point-label` or text, up to 60 chars |

A click outlines the element and runs C8 `chat-point`.

### C10. Sandboxed HTML frame (SC-12, [the safety line](logic.md#behaviour--scenarios))
- The element is `<iframe sandbox="allow-scripts">` when `interactive`, and `sandbox=""` otherwise. It never gets `allow-same-origin`, `allow-forms`, `allow-popups` or `allow-top-navigation*`. It also sets `referrerPolicy="no-referrer"` and a fixed `height`.
- The `srcdoc` is Quirky's wrapper. Its first `<head>` child is the meta CSP below, followed by Quirky's bridge script, then the agent HTML. **The agent HTML must never precede the CSP meta.**
- CONFIG: the meta CSP is `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; form-action 'none'; frame-src 'none'; child-src 'none'; worker-src 'none'; base-uri 'none'`.
- The bridge posts `{type: 'quirky-point', key, label}` for clicks on `[data-point]` elements.
- The parent accepts a message only when `event.source === iframe.contentWindow`. It ignores the origin, which is opaque, and ignores every other message type.
- `navigate-to` is left out of the CSP on purpose, because WebKit ignores it. The navigation reset below is the enforcement.
- A frame `load` event after the first means the frame navigated away. The parent then resets `srcdoc` and calls `render-failed` with `navigation is not allowed`.

### C11. Live preview (SC-13)
- A `live-preview` card mounts a native browser view through the same capability `plugins/quirky.browser` uses, sized to the card body. Only one native view can be resident per window.
- The focused or expanded live preview holds the native view. Every other live-preview card shows a placeholder with the URL and a **Show** button that moves the native view to it.
- On plain-web clients, where the native browser is unavailable, the card shows the URL and an open-in-browser-pane action.

### C12. Visual level and guidance ([How the agent becomes visual-first](logic.md#behaviour--scenarios), SC-4, SC-6)
- SCHEMA: `VisualLevel = 'off' | 'balanced' | 'visual-first'`.
- `StructuredSettings` gains `visualLevel: VisualLevel`.
- `quirky.structured/configure` accepts `visualLevel`.
- CONTRACT: `ChatItem` gains `{kind: 'visual-level', level: VisualLevel}`. Configure journals it when the level changes, mirroring `mode`.
- CONFIG: a new quirky.structured setting `default-visual-level` (`type: enum`, values as above, default `visual-first`). A chat with no `visual-level` item uses it.
- Guidance text lives in one module, `plugins/quirky.structured/visual-guidance.ts`, exporting `visualGuidance(): string`.
  - It is static and describes all three levels and the marker below.
  - It covers update-don't-duplicate, short prose that points at the visual, patch for small edits, fixing refused or failed versions, the reference pill format (C13), and `quirky view --help` for the catalog.
- Injection at session start and resume goes through a new `StructuredStartOptions.appendInstructions: string`, set on the `launchOptions` object (`main.ts:1086`) and on the resume path's options (`:1292`):
  - Claude: `options.systemPrompt = {type: 'preset', preset: 'claude_code', append}`
  - Codex: `developerInstructions` on `thread/start` and `thread/resume`
  - pi and omp: `--append-system-prompt <text>` in `piLaunchArgs`
- The starting level travels with the guidance. `appendInstructions` is `visualGuidance()` followed by the line `This chat's visual level is <level>.`, built from the chat's level at start or resume time. That counts as the level being announced.
- A mid-chat change is carried by a per-turn marker.
  - CONFIG: the marker is the first line `[quirky visual level: <level>]` followed by `\n`.
  - Structured prepends it to the outgoing user text only when the chat's level differs from the last level announced, whether announced by the guidance or by an earlier marker. A session that never changes level never carries a marker, so existing exact-text expectations hold.
  - The marker is part of the agent-visible text and must never render in the transcript (C14).

### C13. Reference pill text form (SC-11)
- REGEX: the pill is `@view:(view_[0-9a-f]{12})/v(\d+)/([a-z0-9][a-z0-9._:-]{0,79}) `, ending in a space.
- `parsePills` gains this branch, ahead of the `@path` branch.
- The composer and transcript render the pill as `◈ <title> › <label>`. Title and label come from a local cache filled by `chat-point`; when the cache misses, from `quirky.view/get`, which also covers older messages.

### C14. Chat UI behaviors (SC-5, SC-14..SC-16, Screens)
- **Panel shell.** The panel shell is a new `S/VisualPanel.tsx`, rendered in place of today's Views aside and Plan aside.
  - It appears in every native chat, and in the empty state when there are no visuals or plan.
  - It lists `placement === 'pane' && !closed` views through `quirky.view/list`, as `usePaneViews` does today.
  - The plan card comes first when a plan exists. It is today's `PlanPanel` content, and the sheet fallback is removed.
- **Width.**
  - The default is 45% of the body.
  - The minimum is `280 × unit` and the transcript minimum is `420 × unit`.
  - A drag sets the width, persisted globally (C15).
  - Below `720 × unit` body width the panel starts collapsed.
- **Layout.** Use a grid when the panel width is ≥ `2 × 300 × unit + gap`; otherwise use a filmstrip plus one focused card. The newest updated visual takes focus on `changed`.
- **Collapse.** Collapse shows a rail with an `N new` badge, counting `changed` opens and updates since collapse. Clicking the rail reopens the panel.
- **Drawing state (SC-7).** The panel passes `drawing: true` to a card while the session's turn is active and that view received a `changed` open, update or patch event during the current turn. It returns to false when the turn ends.
- **Dial default.** On a chat with no `visual-level` item and no draft pick, the dial shows the value of `default-visual-level`.
- **Expanded.** The expanded layout replaces the body row with one `surface: 'expanded'` card and keeps the composer. Esc or Back leaves it.
- **Chips.** Visual chips render per turn from `view` items (C16), one chip per view per turn showing the last version that turn made. A click focuses that visual at that version.
- **Visualize.**
  - Visualize is an icon-only button on agent prose blocks.
  - It is visible on hover or `:focus-within` and hidden otherwise, with the tooltip `Visualize`, per mock v2.
  - It sends `Visualize this part of your earlier reply as a visual in the panel:\n\n> <first 600 chars of the block>` through `quirky.structured/send` (`when: working ? 'idle' : 'now'`).
- **Dial.** The dial is a composer control next to the plan toggle, showing `Visuals: <Level>` with the three options.
  - It persists in the draft picks as `visualLevel` and calls `configure`.
  - `isDraft` and `normalizeDraft` accept the extra pick key. They also keep accepting old drafts without it.
- **Marker stripping.** `renderUserMarkdown` (`S/Prose.tsx:101`) strips a leading C12 marker line before rendering.

### C15. UI preference storage (SC-15)
- CONTRACT: `quirky.session/uiPref {key}` returns `{value: unknown | null}`, and `quirky.session/setUiPref {key, value}` returns `{}`. Both are window-only.
- The store is a new `ui_prefs(key TEXT PRIMARY KEY, value_json TEXT, updated_at INTEGER)` table, added as a new migration appended to `sessionMigrations` (`plugins/quirky.session/main.ts:19`).
- `key` matches `/^[a-z0-9.-]{1,64}$/`, and `value_json` is ≤ 4 KiB.
- The one key used is `chat.visual-panel.width-ratio`, a number between 0.2 and 0.8.

### C16. Per-version view journal items (SC-1, SC-8, SC-18)
- SCHEMA: `ChatItem` `view` becomes `{kind: 'view', viewId: string, version?: number}`. Old items without a version mean v1.
- The structured `quirky.view/changed` subscriber appends a `view` item for `open`, `update` and `patch` with the version. It replaces the once-per-view guard with "once per (viewId, version)".
- `Turn.tsx` renders `view` items in two ways:
  - for a pane-placed view, a visual chip (C14)
  - for an inline-placed view, today's inline card, once per view per turn
- `view-error` is unchanged.

## Data models / schemas

- **Migration 2** in `V/src/core/store.ts`, appended to the array at `V/main.ts:38`:
  - SCHEMA: `view_versions(view_id TEXT NOT NULL, version INTEGER NOT NULL, spec_json TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(view_id, version))`
  - `ALTER TABLE views ADD COLUMN version INTEGER NOT NULL DEFAULT 1`
  - `ALTER TABLE views ADD COLUMN refused_json TEXT`
  - Backfill one `view_versions` row per existing view from `spec_json`, with `version = 1`.
- **Shared types.** C1, C2, C4 and C7 go in `V/src/core/contract.ts`, the single copy imported by daemon and renderer. `VisualLevel` and the C12 and C16 `ChatItem` changes go in `packages/protocol/src/chat.ts`.
- **Fixtures.**
  - `V/test/fixtures/visual-kinds.json`: one valid spec using every new kind, used by catalog, views and render tests.
  - `V/test/fixtures/auth-flow-v1.json` and `auth-flow-v2.json`: the mock's diagram before and after the refresh loop. Used by the version, patch and highlight tests.

## DO-NOT-CHANGE fences

- **`validateViewSpec` must stay pure and never throw** (`V/src/core/catalog.ts:855`). The daemon, CLI tests and guide all rely on it collecting every error into `path: message`.
- **The `sessionOf(caller)` rule** (`V/main.ts:14`): agent methods take the session from the caller's authority, never from params. That rule is what keeps one session from drawing into another.
- **`viewsMigration`, the first migration string.** Existing databases have run it, and the harness replays by `user_version`. Only append.
- **The `quirky.view/action` routing and message text** (`V/src/core/views.ts:42, 172`). Agents already parse `View action "<name>" from "<title>"`.
- **`MermaidBlock`'s safety path** (`loadsImages`, `withRemoteImagesBlocked`, `sanitizeSvg`, `securityLevel: 'strict'`). The diagram kind reuses it. A diagram must never get a looser mermaid config than chat prose.
- **Plan mode behavior** (`S/plan.ts`, the `plan` and `mode` items, and the `/plan` command). Only where the plan panel renders changes.
- **`quirky.structured/send` existing params and queue semantics** (`main.ts:1439`). The marker is applied inside structured, not added as a new send param that other callers would have to know.
- **The one-resident native browser rule** (`packages/ui/src/native-browser.ts:1181-1215`). The live preview works within it rather than changing it.

## Always / Ask / Never

**Always**
- Return every spec, patch and path error to the agent on the same call through `reject()`.
- Keep the last good version on screen whenever a newer attempt is refused or fails to render.
- Inject the guidance for all four agents, so no agent is left out.
- Put the CSP meta before any agent HTML.
- Treat a `quirky-point` message as valid only when it comes from that card's own frame.
- Add `ui-scoreboard.json` entries for every new UI surface and state (`V/ui-scoreboard.json`, and quirky.session's if present). Keep `bun run ui:lint` clean.

**Ask** (choices delegated to the implementer, with a note in the PR)
- How the hand-drawn look of the sketch kind is achieved (jittered SVG paths are fine; no new dependency without a note).
- The exact visual treatment of the change highlight, within mock v2 (green outline plus a `changed in vN` note).
- Whether the window reads `default-visual-level` through `getSetting` with the full contribution id, or through `quirky.structured/settings`.

**Never**
- Never add `allow-same-origin` to a visual frame, or let one load remote content.
- Never parse Mermaid in the daemon by adding the `mermaid` dependency to `V/`. Window-side render failures go through C4.
- Never store a refused spec as a version.
- Never change the per-session auth model, or let the window pass a session to agent methods.
- Never run the full test suite locally. Per `AGENTS.md`, run only `bun test <file>`. The full suite runs on the draft PR.

## Cross-cutting

- **Security.**
  - The HTML frame boundary (C10) has three parts:
    - an opaque origin, so the frame can't reach the daemon's `127.0.0.1` origin or the RPC token in the main window's hash
    - the CSP, so it can't fetch, frame or submit
    - the navigation reset
  - The daemon-side remote-URL check means agents get a clear error instead of a silently blocked fetch.
  - Image paths go through `markdownAssets`, which already enforces worktree containment and the allowed types.
  - Live preview is limited to localhost hosts at validation and uses the existing native browser rules.
- **Migration.** Migration 2 is additive, and the backfill gives every existing view a v1. Rollback means reverting the plugin. The extra columns and table are ignored by old code, because `get` and `list` read only the original columns.
- **Observability.** `rejected` and `changed` events carry `kind` and `version`, so a refused or failed render shows in the journal (`view-error` items) and in daemon logs.
- **Compatibility.**
  - Old `view` items without a version render as v1.
  - Old drafts without `visualLevel` load.
  - Agents that never call `patch` or `get` keep working.

## Testing strategy

Run each file in its own process: `bun test <file>`. Daemon tests time out when they share a process with happy-dom tests.

- `V/test/catalog.test.ts`:
  - every new kind's example validates
  - each C1 check refuses with the exact `path: message`
  - duplicate ids are refused
  - `catalogGuide()` lists every kind
- `V/test/views.test.ts`:
  - versions append on open, update and patch
  - `get` with a version
  - a refused update leaves the latest version and sets `refused`, and the next good update clears it
  - `render-failed` sends once per `(viewId, version)` and ignores stale versions
  - the default placement is `pane`
  - migration 2 on a database that has run only migration 1
  - persistence across restart (SC-18)
- `V/test/cli.test.ts`: `patch` and `get` commands, exit codes (2 on refused), and manifest-module agreement.
- `V/test/render.test.ts`, with happy-dom:
  - every new kind renders from `visual-kinds.json`
  - pointing runs `chat-point` with the C9 key and label
  - the stepper steps and drops the highlight on older versions
  - the didn't-render badge opens the error
  - the HTML frame has the exact sandbox attribute, and its srcdoc starts with the CSP meta
  - `quirky-point` from a foreign source is ignored
  - thumbnail surface has no chrome
  - pop out is hidden without `auxiliaryWindows`
- `plugins/quirky.structured/test/claude-runner.test.ts`, `codex-runner.test.ts` and `pi-runner.test.ts`: each runner receives the guidance through its injection point on start and resume.
- `plugins/quirky.structured/test/structured.test.ts` (or a new `visual-level.test.ts`):
  - `configure` accepts `visualLevel` and journals `visual-level`
  - the marker is prepended on the first message and on a level change, and not otherwise
- `plugins/quirky.structured/test/changes.test.ts`: one `view` item per `(viewId, version)`. `view-error` is unchanged.
- `plugins/quirky.session/test/chat-view.test.ts`:
  - the panel renders in empty, grid and filmstrip layouts, with the plan first
  - the divider drag persists through `setUiPref`
  - collapse shows the rail and counts new visuals
  - expand and Esc
  - chips focus a version
  - Visualize appears only on hover or focus and sends the C14 text
- `plugins/quirky.session/test/composer.test.ts` and `drafts.test.ts`:
  - the dial persists in picks and calls `configure`
  - old drafts load
  - a visual pill parses, renders and round-trips through text
- `plugins/quirky.session/test/transcript.test.ts` (or `transcript-markdown.test.ts`): the level marker never renders.
- **Screens acceptance.** Every item in [logic.md#screens](logic.md#screens) is checked against mock v2 by driving the fixture (`scripts/redesign/fixture.ts`) with Playwright at DPR 1 and comparing by eye in the PR's before/after screenshots.

## Non-goals

- Mobile (the `quirky.view` methods stay off the mobile authorization list).
- Editing visuals by hand.
- Export and sharing.
- Terminal-pane agents.
- MCP Apps.
- Fence-lifting from prose.
- A headless Mermaid parser.
- Changing the native browser's one-view limit.
- Restyling chat prose (owned by [2026-11-17-vibrant-chat-markdown](../2026-11-17-vibrant-chat-markdown/logic.md)).
