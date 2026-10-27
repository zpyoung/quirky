# Editor implementation contracts
Status: reviewed by Codex promote/refute; confirmed findings resolved below, lexical planned-reference findings adjudicated in the decision log. Logic: [logic.md](logic.md).

## Architecture
Implements [conceptual model](logic.md#purpose-and-conceptual-model) and [data flow](logic.md#data-flow).

Create built-in `plugins/quirky.editor` with daemon services and lazy UI surfaces. Reuse public `PluginContext` and `UiPluginContext`; never import another plugin's files. Extend the existing `quirky.terminal` workspace with session-free hosted-view tabs. Its existing group tree and strip remain the only workspace tab/group owner. The editor view is embedded through `UiPluginContext.mountView`, not another top-level tab system.

Six disjoint implementation components share one up-front contract and can build concurrently: public file-resource capability; terminal hosted tabs; editor daemon/kernel registration; base editor/explorer/CodeMirror UI; Markdown services/rich UI; notebooks/viewer services/UI. Each owns its tests. The public capability and terminal contracts are fixed here before dispatch, so consumers need not wait for their implementation. Browser bundles must support real lazy imports for TipTap and viewers; update `packages/ui/build.ts` if its current nonsplitting build eagerly bundles them.

## Code references
Implements [plugin lifecycle](logic.md#sc-22-plugin-lifecycle-and-scriptability).
Repository root is `/Users/zpyoung/orca/workspaces/quirky/build-lane-4`; listed relative references are anchored beneath it.

- `packages/protocol/src/plugins.ts:48-78`, `PluginContext`: `provide`, `call`, `subscribe`, `emit`, `openStore`, declared settings, public error construction. `PluginCaller` carries non-plugin cwd/worktree identity; preserve it explicitly in downstream calls.
- `packages/protocol/src/ui.ts:184-232`, `MountFunction` and `UiPluginContext`: mount element/input/cleanup, public events/calls/context keys/commands and cross-plugin `mountView`.
- `plugins/quirky.worktree/quirky-plugin.json:835-956`, `resolve`: accepts selector/cwd/worktreeId, returns authorized workspace id/path. Realpath-check every file against that root including nearest existing parent for creates.
- `plugins/quirky.terminal/src/layout/types.ts:28-69`, `Tab`, `Workspace`, pane and group nodes: add discriminated session-free view tab without fake pane/session. Existing persisted terminal rows must still load.
- `plugins/quirky.terminal/src/layout/service.ts:50-117`, `LayoutService.methods`; `resolveWorkspace` at 163-177: add hosted-view mutations inside the existing serial mutation queue. Editor uses only these declared methods.
- `plugins/quirky.terminal/src/layout/{ops,tree,reconcile,store,titles}.ts`: update terminal-only branches and workspace validators to preserve hosted tabs. Session reconciliation/exit never removes or starts a session for a view tab.
- `plugins/quirky.terminal/src/window/workspace/{controller,GroupView,PaneLayer,model}.tsx` (controller/model are `.ts`): existing strip and active-content lifecycle. Hosted tab mounts effective declared view, unmounts on hiding; close affordance delegates editor dirty-close command.
- `plugins/quirky.terminal/src/ui.tsx`: existing workspace view and public context. Keep it the surrounding workspace owner.
- `plugins/quirky.git/src/{DiffView.tsx,language.ts}`: CodeMirror lifecycle/language reference, not cross-plugin imports.
- `plugins/quirky.worktree/main.ts:45-120` and `plugins/quirky.worktree/cli.ts:1-100`: public caller/setting/method conventions, not imports.
- `packages/daemon/test/helpers.ts:20-81`: `builtinsDir`, temporary homes, daemon harness (must explicitly load builtins).
- `plugins/test/imports.test.ts:50-105`: import fence; plugin imports limited to own files, runtime builtins, protocol and declared dependencies.
- `packages/ui/build.ts:37-53`: dynamic plugin discovery/browser build; `apps/desktop/scripts/bundle-plugins.ts:1-69`: manifest-discovered packaging. Do not add a hardcoded built-in list.
- `package.json:10-15`: verification commands; `apps/desktop/src/bun/page.ts:1-4`: daemon UI URL format.
- Pure reference code lives outside this worktree at `/Users/zpyoung/PycharmProjects/orca/src/renderer/src/components/editor/rich-markdown-source-reconcile.ts`, `/Users/zpyoung/PycharmProjects/orca/src/renderer/src/components/editor/rich-markdown-block-source.ts` and `/Users/zpyoung/PycharmProjects/orca/resources/notebook/kernel-bridge.py`. Port/adapt only needed behavior; no absolute imports, process-host or Electron dependency.

## Contracts & interfaces
Implements [open](logic.md#sc-1-open-and-navigate-files), [saves](logic.md#sc-5-external-change-and-guarded-save), [plugin lifecycle](logic.md#sc-22-plugin-lifecycle-and-scriptability).

### Public file-resource capability
Implements [bounded viewers](logic.md#sc-20-images-pdf-audiovideo-mermaid-and-binary). New public API, not a private daemon import.
`CONTRACT:`
```ts
PluginContext.createFileResource(options:{path:string;contentType:string;disposition?:'inline'|'attachment'}):Promise<{url:string;revoke():void}>
```
The plugin first authorizes path against its worktree. The daemon opens a regular canonical file, records its physical identity and issues a cryptographically unguessable capability URL scoped to the plugin activation. HTTP never accepts a path selector. GET/HEAD support one RFC byte range (inclusive start/end, open-end and suffix); correct 200/206/416, Content-Length/Content-Range/Accept-Ranges. Reject multi-range and invalid ranges. Stream bounded chunks, never whole-file base64. Recheck regular-file identity on each request with no-follow/handle checks so replacement/symlink races cannot expose another file. Missing/replaced file gives 404/410 and callers request a new resource; same physical file size uses current stat. Fixed safe content type, nosniff, no-store, same-origin resource policy and no-referrer prevent active-content/confidential token leakage; no general proxy/listing. Explicit revoke, failed activation, disable/replacement and daemon stop invalidate capabilities and close handles/streams. URL is a scoped bearer secret, not the daemon auth token.

Resource component owns `packages/protocol/src/plugins.ts`, the protocol export barrel if needed, `packages/daemon/src/plugins/{host,runtime}.ts`, `packages/daemon/src/{server,daemon}.ts`, a new daemon resource module and affected daemon/protocol tests. Live anchors: host ExtensionMembers at 20-36 and contextFor at 511-565; runtime extension create at 122-218/revoke at 220-228; server fetch at 73-112; daemon runtime/server composition at 126-213. Extend required context implementations/fixtures consistently. LSP reference lookup was attempted and reported no language server; use explicit symbol search fallback. No other component edits these files.

### Terminal hosted tabs
`CONTRACT:`
```ts
openViewTab({workspace?,group?,viewId,key,input?,title,reuse?,replace?,activate?,closeCommand?,closeMethod?,closeParams?,revision?}) -> {workspace,tab}
rekeyViewTabs({workspace?,viewId,changes:[{tab,key,input?,title?}],revision?}) -> {workspace}
```
`workspace` accepts the existing worktree selector convention. `tab` is the existing stable tab id. Reuse identity is workspace+viewId+key; replacement only explicitly targets an existing unpinned preview view tab. Store session-free viewId/key/input and close routing. Validate effective declared views and close contributions through public API. Shared move/pin/color/activate/group behavior works for either kind; old terminal rows load losslessly. Pane-only operations reject views. Before any close/replacement/bulk close/group removal, terminal calls closeMethod with closeParams plus the actual tabId; false/refusal preserves all affected view tabs. Renderer strip close invokes closeCommand with that same tabId so three-way dirty-close is reachable. Mounted input is augmented with tabId. No recursion: editor close resolves save/discard then calls terminal close; canClose only checks and never calls terminal methods. Preview-only closure neither drops a shared draft nor closes the edit tab/kernel. Closed view tabs never enter terminal session-restart history. Editor owns its reopen descriptions.

### Editor core
Create `plugins/quirky.editor/{package.json,quirky-plugin.json,main.ts}` and `src/{types.ts,daemon/**}`. The core component owns these shared contracts and the manifest. All feature services register under this one plugin, using `context.provide` for each declared method. Manifest methods are `open`, `state`, `draft`, `save`, `close`, `canClose`, `reopen`, `view`, `explorer`, `mutate`, `history`, `quickOpen`, `search`, `read`, `markdown`, `notes`, `notebook`, `viewer`; event `changed`. Additional narrowly typed methods are allowed only if needed to expose a specified flow, not unrelated scope. All args/results are schema declared; action methods use enumerated action names and typed optional fields, not an untyped arbitrary operation escape hatch. CLI group `editor` is generated from schemas. `open` can have alias `file` if compatible with existing CLI rules.

`SCHEMA:`
```ts
type EditorBuffer = {
  id:string; worktreeId:string; root:string; path:string; relativePath:string; name:string;
  kind:'text'|'markdown'|'notebook'|'csv'|'image'|'pdf'|'audio'|'video'|'mermaid'|'binary';
  content:string; draft:string|null; baseline:string|null; size:number; readOnly:boolean;
  dirty:boolean; external:'changed'|'deleted'|null; diskContent:string|null;
  mode:'source'|'rich'|'preview'; tabId:string|null; preview:boolean; pinned:boolean; untitled:boolean;
  revision:number; contentRevision:number; view:Record<string,unknown>; error:string|null
}
type SurfaceProps = {
  context:UiPluginContext; buffer:EditorBuffer;
  onDraft(content:string):void;
  onAction(method:string,params:Record<string,unknown>):Promise<unknown>;
  onView(patch:Record<string,unknown>):void
}
```
`content` is last loaded/saved text, `draft` is nullable current edit, never `draft || content`. Binary/media content is empty. Core state also has `tabs:{tabId:string;bufferId:string;mode:'edit'|'preview';group?:string}[]`; one buffer may have multiple tabs. View state holds selection/cursor/scroll/viewer preferences. Every mutation bumps revision; content mutations separately bump contentRevision. Public draft requires expectedRevision matching contentRevision; stale clients get a conflict and neither version is overwritten. UI serializes local updates using the acknowledged contentRevision and preserves local text on conflict rather than force-replacing the remote draft. Feature services capture the current contentRevision before async edits and pass it to host.draft. Draft persistence is independent of mounts.

`CONTRACT:`
```ts
interface EditorServices {
  context:PluginContext;
  store:PluginStore;
  get(bufferId:string):EditorBuffer;
  resolve(worktree?:string,caller?:PluginCaller):Promise<{id:string;path:string}>;
  path(worktreeId:string,relativePath:string,options?:{create?:boolean}):Promise<string>;
  draft(bufferId:string,content:string,expectedRevision:number):Promise<EditorBuffer>;
  save(bufferId:string,trigger?:'user'|'autosave'|'overwrite'):Promise<EditorBuffer>;
  readBytes(bufferId:string,offset:number,length:number):Promise<{data:string;eof:boolean;size:number}>;
  updateView(bufferId:string,patch:Record<string,unknown>):Promise<EditorBuffer>;
  emit():void;
  onClose(listener:(bufferId:string)=>void):()=>void;
}
type FeatureMethods = {methods:Record<string,MethodHandler>;dispose():void|Promise<void>}
createMarkdownMethods(host:EditorServices):FeatureMethods
createNotebookMethods(host:EditorServices):FeatureMethods
createViewerMethods(host:EditorServices):FeatureMethods
```
Feature factories live at `src/markdown/service.ts`, `src/notebook/service.ts`, `src/viewers/service.ts`. Core `main.ts` imports them; methods from each map are registered with declared manifest IDs. They use the shared host rather than duplicating buffers or saves. `get` throws public not-found for unknown IDs; `draft` refuses read-only/size-ineligible files, marks dirty and promotes preview; `save` errors on stale or unknown baseline without clearing draft; `path` rejects escape/symlink/junction traversal, including create parents; `readBytes` is base64, capped at 1 MiB per call. Feature methods receive real caller metadata. `onClose` means last owning edit tab closed, not hidden/unmounted.

Open resolves caller worktree and bounded file content, then calls openViewTab with viewId `view:quirky.editor/document`, key buffer.id for edit or `preview:<id>` for Markdown preview, input `{bufferId,mode?}`, closeCommand `command:quirky.editor/close`, closeMethod `quirky.editor/canClose`, closeParams `{bufferId}`. Terminal adds actual tabId to mount/close routing. Editor close/canClose resolve that tabId against authoritative tab mappings, not buffer.tabId alone; omitted tabId on an explicit editor close means the primary edit tab. Closing preview is always draft-neutral; closing last owning edit tab alone invokes onClose and quiesces saves/kernel. Dirty/pinned previews cannot be replaced. Focus defaults false for API and true for UI. State includes buffer/tab mappings, explorer, search, quick-open history and close requests.

Filesystem compare/write queues by canonical path and inode aliases. Explicit Overwrite alone is unguarded. Keep acknowledges freshly read disk but retains draft and sets a persisted autosave hold until successful explicit user/overwrite save or Reload; later edits do not lift it. Timers are generation-cancelled and recheck gates; save snapshots never clear later drafts. Restore retains drafts/baselines, verifies before autosave. Watch runs inside daemon/worker, not helper process; reveal/save restat excluded paths. Own echoes compare bytes. Atomic delete/create, missing and overflow preserve content. No mtime-only baseline. Trash/history preserve owner and preconditions. rg uses argument arrays; superseded search/processes abort on disposal.

### Base UI
Create `src/ui.tsx`, `src/window/**`; owns all editor contribution registration and shell integration. Expose `view:quirky.editor/document`, explorer panel/sidebar and overlay for quick-open/close dialogs as needed. Reuse public context methods; no private shell DOM/querying. `DocumentSurface` receives `{bufferId,mode?}`, subscribes daemon state and renders exactly one source/rich/viewer surface. Import Markdown and viewer UI lazily. Exported rich/viewer components at `src/markdown/MarkdownSurface.tsx`, `src/notebook/NotebookSurface.tsx`, `src/viewers/ViewerSurface.tsx` receive `SurfaceProps` above. Base owns CodeMirror source editor, conflict compare, file header, source/rich toggle, three-way close modal, explorer/search/quick-open and all editor keybindings. Window commands call API and update daemon view state. `onAction` receives full method (`quirky.editor/markdown`, etc.) and injects bufferId; it must not erase service-specific params.

CodeMirror extensions include history, language syntax, native find/replace, line numbers, wrapping compartment, zoom, position reveal, paste bound/chunk transaction and explicit keymap precedence. Save flushes local pending updates before API save; per-buffer UI draft queue is ordered. External content synchronization must not echo a spurious draft. State persists selection/scroll in daemon, but only visible view instances mount. Errors are visible and recoverable, not swallowed. Terminal path open and file drag integration use `quirky.editor/open` through public API.

### Markdown service and surface
Implements [SC-12](logic.md#sc-12-markdown-modes-and-byte-preservation) through [SC-15](logic.md#sc-15-markdown-review-notes). Scope `src/markdown/**`, `test/markdown*.test.ts`. TipTap + Markdown extension + compatible table/task/image/link/math/details nodes, sanitized GFM preview/Mermaid/math. `markdown` action enum covers capabilities, apply/format/insert, links/documents, TOC/frontmatter/search/replace, templates/new/retarget/import image/export. `notes` covers list/add/edit/delete/copy/send. Factories return only `markdown` and `notes` handlers. All document changes use host.draft/save and core file APIs; no separate save baseline. PDF export uses a real renderer/public OS capability; never fake generated bytes or return success without a valid artifact. Native picker routes can use public UI commands while API accepts explicit authorized paths. Use `.orca/templates` as parity source; no symlink traversal. Unknown placeholders literal. Notes persist in plugin store and send through public agent methods with readiness/trust gates. Feature-owned diff-note shelf is a handoff, not duplicated private state.

The concrete action names are fixed: markdown `capabilities|format|insert|apply|links|documents|toc|frontmatter|search|replace|templates|new|retarget|importImage|exportPdf`; notes `list|add|edit|delete|copy|send`. Core manifest declares their typed fields (bufferId, expectedRevision, action, query/text/format/target/path/title/template/selection/line spans and note/agent ids); feature service validates action-specific requirements. Core store migration includes `editor_notes(id TEXT PRIMARY KEY, buffer_id TEXT NOT NULL, payload TEXT NOT NULL)` for the Markdown component using host.store; it must not open a second inconsistent migration set. New files/import/retarget call core public mutate/open APIs. Export uses installed Chrome discovered from standard macOS locations or explicit configuration, isolated temporary profile/HTML and a real headless print/CDP operation with 60-second timeout and cleanup; fail with an actionable missing-renderer error if none. No global browser profile use.


Untouched source bytes are invariant. Preserve front matter/CRLF/trailing newline and no-op original. Reconcile source with proven canonical round trip plus block mapping; where correctness cannot be established, refuse rich mutation and leave the draft untouched with source-mode guidance. Never fallback to canonical full-document rewrite. Raw HTML/JSX/reference/footnotes use source unless explicitly preserved. Preview sanitizes active content; local images resolve through core authorization. Limits as logic spec; large preview must be bounded/virtualized. UI has real toolbar/slash/menu/table/link/TOC/template/note controls, not an API-only substitute.

### Notebook service and viewers
Implements [SC-16](logic.md#sc-16-notebook-parsing-and-cell-editing) through [SC-20](logic.md#sc-20-images-pdf-audiovideo-mermaid-and-binary). Scope `src/notebook/**`, `src/viewers/**`, `test/notebook*.test.ts`, `test/viewer*.test.ts`. Factories expose `notebook` and `viewer` handlers. Notebook actions cover parse/edit/insert/move/delete/type/clear/save, environments/describe/select/trust/install/venv/start/run/runAll/interrupt/restart/shutdown/state. Mutation writes one-space JSON with source-line arrays through host.draft; preserve unknown notebook metadata. Trust is runtime-only per open buffer and reset on close/restart; kernel shutdown registered via onClose and dispose. Python subprocess bridge asset is owned within `src/notebook/`, NDJSON using jupyter_client/ipykernel. Installation requires declared manifest confirmation predicate or explicit `yes`; Python/venv choice never silently writes package files. Processes have readiness/setup timeouts, bounded stderr/output and group cleanup; execution itself has no per-cell timeout. Queue cancels after failure; stdin disabled. Output HTML sandbox and CSP, sanitize SVG/HTML, no JS/widget execution. Large code/output displays virtualize/cap as feature doc.

Viewer action names: `metadata|page|edit|sort|filter|insertRow|deleteRow|insertColumn|deleteColumn|delimiter|copy|paste|save|zoom|find|position|media`. Fields include bufferId/action, row/column/index/count, value/text/query/delimiter/order, scale/page/offset/length. CSV >=1 MiB uses bounded indexed pages, not full content. Quoted multiline records/UTF-8 boundaries work. Image pixel limits checked before exposing decoded image. PDF.js worker/assets ship in packaged build; scripts disabled. Media/PDF/local-image URLs come from host.context.createFileResource after path authorization, revoked on buffer close/service disposal. Real controls seek through ranged transport, not giant data URLs. The resource API contract above resolves the missing capability before implementation.

## Dependencies and build ownership
Implements [lazy resources](logic.md#sc-22-plugin-lifecycle-and-scriptability).
Core component owns `plugins/quirky.editor/package.json`, `bun.lock` and any root workspace lock update. Dependencies include React 19, CodeMirror 6 state/view/commands/language/search/autocomplete and language packages; TipTap 3 core/react/starter-kit/markdown and compatible extensions (link/image/table/task-list/task-item/details/math as needed); source diff utility, sanitized Markdown renderer/GFM/math/KaTeX/DOMPurify, Mermaid, PapaParse or equivalent CSV parser, PDF.js. Declare every used bare import in the plugin package. Feature implementers may request extra dependencies through the orchestrator, never edit the package/lock in parallel. Base UI owner owns `packages/ui/build.ts` for real code splitting and asset copying, with generated outputs uncommitted. Desktop bundle discovery must copy any declared lazy chunks/assets; base UI owner may edit `apps/desktop/scripts/bundle-plugins.ts` for this packaging requirement. Kernel bridge asset must ship with editor plugin, not rely on source checkout paths.

## Data models / schemas
Implements [draft recovery](logic.md#sc-4-autosave-and-restart-recovery) and [scriptability](logic.md#sc-22-plugin-lifecycle-and-scriptability).
Plugin store migration owns buffers, baseline/draft/version, per-worktree explorer preferences, quick-open history, operation history and notes. Mode/reopen/expanded/search ephemeral state follows feature doc; durable draft rows include their baseline. Store schema names are internal to one component; public Buffer/SurfaceProps/EditorServices above are fixed. Every method manifest schema rejects invalid action names and wrong required field types; result schemas describe actual observable values, not empty placeholders. `changed` event consumers re-fetch authoritative state; no cross-plugin private state aliases.

## DO-NOT-CHANGE fences
Implements [scope](logic.md#scope--non-goals).
- `docs/loop/LOOP.md`, `scripts/build-loop/**`, queue/index files: protected loop infrastructure, never edit.
- `main`, `build/roadmap`, integration worktree and remotes: only queue.ts land changes integration; no pushes.
- Public worktree selector behavior and terminal/session PTY protocol: preserve identity/ownership and all existing terminal flows. Extend content kind, never fake a session.
- Real `~/.quirky`, `~/.claude`, `~/.codex` and external feature/Orca source trees: read-only; tests use temp homes and kill exactly their children.
- Plugin import fence and existing generic UI host contracts: use public calls/mounts, no private plugin/core DOM access.

## Always / Ask / Never
Implements [Decisions Locked](logic.md#decisions-locked).
Always: reuse established plugin/store/manifest style; query LSP references before exported symbol edits; fail closed on unsafe path/save/trust; tests drive CLI or real daemon API; dispose timers/watchers/kernels/URLs; record autonomous decisions.
Ask: never a person in this loop; answer repository-derived details, record assumptions; a locked-decision feasibility conflict blocks the item per LOOP.md.
Never: silent scope reduction, canonical source loss, fake PDF/kernel/media behavior, read-only drafts, global install without explicit consent, tests against real state, untyped API action escape hatches.

## Cross-cutting
Implements [safety](logic.md#defect-regression-requirements).
Security: root authorization on every request, no shell-interpolated queries, sanitized preview/notebook content, explicit notebook trust/setup confirmation, exact caller identity, bounded IO. Persistence: migration for editor state, compatible terminal tab migration. Logging: actionable public errors; do not log document secrets or notebook code. Rollback: plugin disable disposes resources; existing terminal/session data stays readable. Platforms: macOS only verification, portable APIs where cheap; record OS-specific Trash/open/dialog differences.

## Testing strategy
Implements every [behavior criterion](logic.md#behavior--scenarios).
Create integration files in `plugins/quirky.editor/test/` split by owning component: `core.test.ts`, `ui-api.test.ts`, `markdown.test.ts`, `notebook.test.ts`, `viewers.test.ts`; terminal extension owns `plugins/quirky.terminal/test/view-tabs.test.ts`. Reuse real daemon harness with builtins explicitly enabled and fresh temp home/repo; no echo mocks. Tests cover every SC and defect, including all explicit boundary/error transitions; subprocess tests use isolated homes and cleanup. GUI-only actions have public command/state API coverage plus real browser smoke. Permanent tests assert consumer behavior, never source text/wiring or incidental defaults.

Acceptance commands (run by orchestrator after all parallel editing has returned):
`COMMAND:`
```sh
bun test plugins/quirky.terminal/test/view-tabs.test.ts
bun test plugins/quirky.editor/test/core.test.ts
bun test plugins/quirky.editor/test/ui-api.test.ts
bun test plugins/quirky.editor/test/markdown.test.ts
bun test plugins/quirky.editor/test/notebook.test.ts
bun test plugins/quirky.editor/test/viewers.test.ts
bun test packages/daemon/test/plugins/file-resources.test.ts
bun run build
bun run test
bun test scripts
bun run typecheck
```
Every command exits 0; full suite runs only through `bun run test` on its remote host. Run one post-wave build/test gate (single wave has no checkpoint review); catch up `build/roadmap`, read incoming decisions, rerun gates; one final three-lens cross-family review + one fix batch as LOOP.md prescribes. Browser smoke starts real daemon with temporary QUIRKY_HOME at the token URL; `using-apps-like-a-user --surface web --owner yours --unattended` exercises each visible SC; tool-only blockers are documented with reports, app failures are fixed. Native-only SC-9/14/17/20/21 get pending nightly scenarios. Stop daemon/kernels and remove disposable state afterward. No full-suite claims from worker reports.

## Non-goals
See [logic scope](logic.md#scope--non-goals); this tech spec adds no narrowed feature scope. No generic tab-type registry, alternate editor layout, Electron/Monaco, private plugin imports, remote hosting implementation, browser engine, source-control diff implementation or native chat.
