# Editor implementation contracts

Status: source-backed contracts as of 2026-10-27; this document does not claim any verification gate passed. Logic: [logic.md](logic.md).

## Composition and ownership

`plugins/quirky.editor/main.ts` composes the editor daemon with the Markdown, notebook, and viewer method services. The terminal workspace remains the owner of tabs and groups; editor documents mount as the declared `view:quirky.editor/document`, with no second editor tab system. The editor owns its buffers, authoritative tab mappings, and UI surfaces. Cross-plugin calls use declared public methods and contributions.

## Terminal hosted tabs

```ts
openViewTab({
  workspace?, group?, viewId, key, input?, title?, reuse?, replace?: string,
  activate?, preview?, closeCommand?, closeMethod?, closeParams?, closeContext?: boolean, revision?
}) -> { workspace, tab: string }

rekeyViewTabs({
  workspace?, viewId,
  changes: Array<{ tab: string; key: string; input?; title?; preview? }>,
  revision?
}) -> { workspace }
```

Additive API amendment, 2026-10-28: `closeContext: true` opts a guard into host-computed `closeReason` (`single`, `bulk`, or `replacement`), `closeViewId`, `closeViewKey`, and `closeViewInput`. These trusted keys override static `closeParams`; unopted calls receive no added context, and reserved trusted keys are stripped even when supplied as static parameters. Ordinary legacy close parameters remain unchanged. Static close parameters are not proof of removal intent or view identity. See the [current loop UI contract](../2026-10-28-m5-loops-ui/tech.md#contracts--interfaces).


Reuse identity is workspace + `viewId` + `key`; `tab` is the stable terminal tab ID, whether created, reused, or replaced. `replace` names an existing unpinned view tab already marked `preview`; a refusal from its close guard leaves it intact. `rekeyViewTabs` may also change each tab's `preview` flag and rejects duplicate keys within that view. It preserves tab IDs.

Editor `mode: 'preview'` is a separate read-only Markdown preview surface. It is distinct from `preview: true`, which marks a replaceable editable browsing tab. Generated keys also distinguish explicit groups and are opaque to consumers. Use `openedTabId` for the actual tab returned by each `open`; `EditorBuffer.tabId` is only the primary edit-tab summary. Dirty editable browsing tabs stay close-guarded, and closing a sole neutral preview retains any API-created dirty buffer. API `open` defaults `focus` to false; a UI caller defaults it to true.

## Editor data and text access

The daemon's internal `EditorBuffer` owns `content`, nullable `draft`, and nullable `diskContent`. Public snapshots use `EditorBufferInfo`: the three text fields are optional while their UTF-16 lengths, UTF-8 byte lengths, and disk signature describe omitted values. The `state` result always omits `content`, `draft`, and `diskContent`; other projected method results may inline text within one shared 256 KiB response budget. An omitted field is lazy data, not empty text. `EditorSurfaceBuffer` receives hydrated content and draft; disk comparison text is fetched separately when needed.

Draft writes compare `expectedRevision` with `contentRevision`; stale writes conflict without replacing the current draft. General state changes advance `revision`, while content changes advance `contentRevision`. Text `read` chunks are bounded to 64 Ki UTF-16 code units, carry the matching `contentRevision`, and avoid splitting surrogate pairs. Disk reads also require the current `diskSignature`. Use these reads to hydrate omitted snapshot text rather than treating absent fields as content.

Source and Changes render the latest local text while draft writes await acknowledgement, rather than replacing it with an earlier acknowledged draft. `DocumentSurface` correlates shared revisions with pending and acknowledged writes; a genuinely competing revision preserves local text and exposes Compare local text.

## Staged transfers

The UI uses inline draft calls through 128 KiB and stages larger drafts. Staging leaves the existing 16 MiB frame cap unchanged; a staged chunk contains at most 64 KiB decoded bytes. Drafts and individual files are limited to 50 MiB. Import accepts at most 256 files, 50 MiB aggregate data, and 256 KiB of path/name metadata. The daemon permits at most four active transfers and 100 MiB of reserved staged data, with a five-minute idle expiry.

A draft transfer reserves its buffer at the supplied `contentRevision`; a second transfer, autosave, or close cannot race through that hold. Commit checks the revision and complete byte count before applying the draft; cancel, expiry, commit, or disposal removes the stage and releases the hold.

## Surface callbacks and commands

Feature surfaces receive the actual `SurfaceProps`: `context`, hydrated `buffer`, `fontSize`, `onDraft(content)`, `onAction(method, params)`, `onView(patch)`, and `registerCommandHandlers(handlers)`. Registered renderer handlers cover `find`, `replace`, `copy-context`, `add-review-note`, `zoom-in`, `zoom-out`, and `reset-zoom`, plus optional `flush`. `onAction` makes the public method call and supplies the current `bufferId` or `tabId` only when the surface did not already provide one; feature parameters are otherwise preserved.

The canonical 12 surface/UI commands are `find`, `replace`, `markdown-preview`, `toggle-word-wrap`, `copy-context`, `add-review-note`, `zoom-in`, `zoom-out`, `reset-zoom`, `toggle-right-sidebar`, `new-markdown`, and `open-markdown`. Each has a declared editor method and CLI route; `main.ts` forwards it through public `ui.command.run` as `command:quirky.editor/<name>` with its args.

The renderer registers an active document only while its hosted surface is mounted, and treats it as active only when its terminal group and hosted tab are active. Surface focus/pointer activity selects the active document; blur, tab/group deactivation, and unmount clear the relevant focus registration/context. `ui.command.run` routes to the focused window (or most recently open window), waits up to 30 seconds, and returns a conflict if no window is open or the window disconnects/stays silent. A surface command also errors when there is no focused document or that command is unsupported for the current kind/mode; these UI commands do not have a headless implementation.

## Public file-resource capability

`PluginContext.createFileResource({path, contentType, disposition?})` returns `{url, revoke()}`. The calling plugin authorizes the file before issuing the capability. The daemon resolves a canonical regular file, records its device/inode identity, and serves only an opaque activation-scoped token URL; HTTP request paths never select filesystem paths. `GET` and `HEAD` support one byte range (closed, open-ended, or suffix) with `200`, `206`, and `416` responses and the appropriate `Content-Length`, `Content-Range`, and `Accept-Ranges` headers. Multi-ranges and malformed/unsatisfiable ranges are rejected. Responses stream in 64 KiB chunks with fixed safe content types and no-store, no-referrer, same-origin resource policy, CSP, and `nosniff` headers. Each request rechecks file identity without following symlinks; a missing or replaced file returns `410`, while a revoked/unknown token returns `404`. Explicit revoke and plugin deactivation invalidate the token and close its handles and streams.

This public capability is specified here for the editor's PDF/media/local-image consumers; its API addition to the daemon contract is indexed from [m0-daemon-api](../2026-10-26-m0-daemon-api/tech.md).

## Generic panel geometry

The public `ui.panel.configure` contract stores desired width per effective panel ID in daemon-owned `UiLayout.panelWidths`; widths are integers from 220 through 4096 CSS pixels. `activityBarPosition` is global and is either `top` or `side`. The editor contributes `editorSidebarWidth` (default 350, range 220–900) and `activityBarPosition` (default `top`); it configures the Explorer panel through the public API and reapplies the values when either setting changes. This additive UI contract is indexed from [m0-ui-api](../2026-10-26-m0-ui-api/tech.md).

## Import policy and packaged assets

Finder/file-URI drops are imports: the editor copies every selected file into the chosen worktree directory using collision-safe names, then opens the imported copies. This is not open-in-place behavior. Native picker flows remain pending and are not part of the current contract.

The browser build emits split plugin UI modules and copies the PDF.js worker plus KaTeX CSS and fonts into the editor UI asset tree. Desktop plugin packaging copies that generated UI tree and the plugin-local `src/notebook/kernel-bridge.py`; these are runtime assets, not planned dependencies.

## Markdown rich-mode boundary

Lossless rich serialization of actual `<details>` content (including empty details) and details/collapsible-heading inserts is deferred under D25. These use Source fallback or safe rejection without changing the draft; fenced HTML examples remain ordinary editable code. Custom document-link insertion also remains a follow-through round trip. Sanitized preview, math, ordinary rich formatting and relative-link navigation remain in the core contract.

## Advanced-flow follow-up

True untitled-buffer creation/Save As is not delivered; `new` creates named Markdown files and `retarget` is not a published action. Filesystem mode-bit/ACL UX, successful confirmation-mediated notebook install/venv, the observed Preview-to-Rich and own-write warning defects, and the exhaustive advanced GUI matrix are assigned to `m2-editor-complete-remaining-flows`. Exact reasons and evidence are in the [open findings](../../../loop/BLOCKERS.md#m2-editor-open-review-findings); declared methods or packaged assets alone do not prove those flows.

## Manifest validation and gate

Plugin method schemas use the protocol's flat JSON Schema subset. Describe action-dependent unions and nullable result shapes in field descriptions; enforce action-specific required fields, cross-field constraints, and union branches in the service. `oneOf`/`anyOf` and other unsupported schema keywords are not valid substitutes for service guards.

D25's gate is the affected test suites, `bun test scripts`, and `bun run typecheck`, followed by landing the whole item. It is not an exhaustive pre-land full-suite/build/browser matrix. No passing result is asserted here. Native picker/open-in-place work and other advanced flows without runtime proof remain follow-up, not promises of this contract.
