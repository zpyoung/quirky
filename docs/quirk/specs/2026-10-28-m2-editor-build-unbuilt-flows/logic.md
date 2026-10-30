# Retained editor interactions and resource ownership

## Status & amendments
Status: implemented with narrow isolated daemon/API and actual browser-surface smoke evidence; acceptance suites, formal review and native clipboard execution remain end-phase work.

**Amendments:** 2026-10-28 — initial specification. The historical queue title is reconciled with m2-editor-complete-remaining-flows D20 before implementation: existing Save As/untitled work is preserved, and rich details/document-link/permission behavior remains owned by m7-editor-source-control-completion.

**Amendments:** 2026-10-28 — three scoped components implemented against the committed contracts. New range-coordinate inputs capture React event values synchronously after an actual first-input crash demonstrated deferred currentTarget lifetime. Existing restart trust revocation is unchanged. C1-native-clipboard is handed off pending; exercised smoke boundaries and limitations are recorded in the item decisions D12–D15.

**Amendments:** 2026-10-29 — successful Explorer rename/move/delete clears affected selection, focus and anchor, including directory descendants, while preserving unrelated selection; failed mutations preserve interaction state.

## Purpose and conceptual model
Complete four still-unbuilt interactions in the existing built-in editor. The daemon owns selection and execution state. Mounted viewers own revocable media capabilities, not the shared document. Multiple visible splits may share a buffer without sharing resource lifetime.

## Scope and non-goals
In scope: Explorer tree navigation and anchored range selection; notebook idle-death presentation and restart-from-dead controls; small-CSV row/column/rectangular clipboard controls; exact media-resource release on view unmount/reacquisition.

Not reimplemented here: owned untitled creation, Save As and placeholder provenance already delivered by m7-sweep-editor-source-control; rich details/toggle/document-link and effective-permission follow-through assigned to m7-editor-source-control-completion by prior D20. All other SC-3–22 acceptance and known-bug debugging stays in the end phase. No Finder open-in-place, editor replacement, native window automation, global Python installations, or private neighboring-plugin imports.

## Approaches and decisions locked
- Extend current Explorer, notebook and viewer services plus their public schemas (chosen). Renderer-only selection is rejected because agents cannot read or drive it. A replacement global editor model is rejected because existing buffers already own durable drafts.
- Existing compact controls, loading/error displays and keyboard ownership remain. Keyboard handling is confined to the visible tree, outside inputs/inline editing; composition and modified text-entry chords are not consumed.
- Explorer focus and anchor are distinct from selected membership. Home/End clamp to visible boundaries; Page movement is max(1,floor(visibleRows/10)); Right expands a collapsed folder, then enters its first visible child; Left collapses an expanded folder or selects the visible parent. Shift extends a contiguous range from a stable anchor; plain movement resets the anchor. Cmd/Ctrl-click toggles membership; right-click inside the selection preserves it. Enter renames, Space activates.
- Visible rows derive from authorized worktree listings, current expansion and name filter. Invalid/hidden targets cannot manufacture selection. Failed loads preserve previous children and show errors. Expansion and selection survive panel remount through daemon state; no new database migration is needed for ephemeral selection.
- Idle kernel death means an actual owned bridge/kernel transition, not inferred silence. State retains the death error and prior outputs. Restart is available in dead/ready states and uses the existing public restart action: stop the session, revoke trust, preserve selected interpreter and outputs, then request fresh trust on the next explicit run. It never executes cells or grants trust automatically.
- CSV copy uses source row/column indices even after filter/sort. Row, column, cell and inclusive rectangular copies return quoted TSV preserving embedded tabs/newlines/quotes; paste consumes that representation. Invalid/reversed/out-of-bounds ranges leave drafts untouched. Existing small-table/1 MiB paging and 50 MiB preview limits remain. Clipboard permission failures are visible; no false success.
- Every mounted media acquisition gets a unique lease. Releasing that lease is idempotent and cannot revoke another split or anonymous API caller. Refresh, source-mode switch and unmount release the exact lease, including late acquisition results. Close and plugin dispose revoke all owned resources. Lease state is ephemeral, never persisted into buffer view state.

## Data flow
Explorer click/key events call the existing namespaced API; the daemon computes authorized visible rows, applies focus/anchor/selection transitions, and returns authoritative interaction state. Renderer updates selection/expansion from that result and refreshes listings as needed. Notebook bridge status changes notify the notebook service, which publishes state; visible surfaces refresh and expose restart without changing saved outputs. CSV controls call existing copy/paste actions with explicit coordinates; copy returns text and the UI writes it to the clipboard. Media callers acquire capabilities with a lease ID and release that ID on effect cleanup; daemon buffer close/disposal is the final backstop.

## Behavior and acceptance scenarios
### E1: Boundaries, paging and ranges
Before: visible rows folder A, folder B and 23 naturally sorted files, with A containing two children. Select file 10. Home selects first row; End selects last; PageUp moves floor(25/10)=2 rows. Shift+Home selects the contiguous first-to-current span while retaining its anchor; Shift+Down contracts it correctly. Cmd-click toggles a row without turning the anchor into the last selected member. After: daemon state reports exact selected paths, focused path and anchor; remount restores them. Empty trees remain empty, and stale anchors resolve to the current target instead of selecting an unrelated range.

### E2: Hierarchy and keyboard scope
Before: A collapsed. Right expands A without jumping; Right again selects its first child; Left from child selects A; Left collapses A. Name-filter rows do not expand unrelated hierarchy. Space activates selected file/folder; Enter starts rename and selects the stem. Typing or navigation in search/inline input does not move tree selection. After: API and tree expose the same selection and expansion; errors preserve existing state and are visible.

### E3: Selection after creation
Before: another file or several rows are selected. Create a file or folder at the worktree root or beneath an expanded or collapsed directory. After: the created item is visible and is the only selected and focused path in both the tree and daemon state. New File opens that file in the editor. Footer Copy Path, Copy Relative Path and Delete target the created item, not the previous selection. Reveal ancestors and refresh cached expanded listings before completing creation; panel remount retains the selection.

### N1: Idle death and restart
Before: trusted Python notebook with selected interpreter, one completed output and idle ready kernel. Kill only its owned bridge/kernel. After: state reports dead with an error, the mounted notebook displays it without another run, outputs/draft survive and Restart kernel is enabled. Restart stops the dead session, revokes trust and resets execution state while preserving outputs/interpreter. The next explicit Run asks for fresh trust and starts a new session; old Python variables are gone. Close revokes trust and terminates owned children. Concurrent close/restart cannot resurrect a closed buffer or leave a hidden process.

### C1: CSV row, column and range clipboard
Before: rows [name,note], [a,embedded-tab], [b,multiline-note], including quotes; a filter or sort changes display order. Copy row, Copy column and an inclusive 2x2 range produce the exact source cells as quoted TSV. Paste into an explicitly selected source coordinate reconstructs the same cells. After: only the intended cells change and normal guarded Save persists them. Invalid bounds, clipboard denial and paged CSV copy/edit restrictions leave the prior draft intact and display a specific error.

### V1: Split ownership and late cleanup
Before: two mounted image/PDF/media viewers share a buffer and anonymous API client holds its own resource. Unmount one split: only its resource stops serving; second split and anonymous resource still serve correct bytes/ranges. Refresh or switch source mode revokes only the old mount lease; unmount during acquisition still revokes the late resource. Buffer close/plugin disable revokes remaining resources; remount acquires a new valid capability. Document drafts and persisted view position survive.

## Defect regression requirements
Retain original editor safety/byte-preservation/shortcut/deleted-save tests unchanged. New coverage asserts selection contraction, stale anchor safety, unexpected idle death, restart trust and output preservation, quoted clipboard round trips, invalid ranges, exact lease release and late-acquisition cleanup. These are plausible consumer-visible failures, not source-text or wiring assertions. Native macOS clipboard verification for the new row/column/range controls is pending in docs/loop/native/m2-editor-build-unbuilt-flows.json; no web result is a native pass. Existing editor native scenarios remain unchanged.

## Industry insights
No research swarm under the current loop. Reuse the retained editor evidence and documented [Jupyter client lifecycle](https://jupyter-client.readthedocs.io/en/stable/api/jupyter_client.html), [Node filesystem authorization constraints](https://nodejs.org/api/fs.html), and [React effect cleanup semantics](https://react.dev/reference/react/useEffect). These inform design, not executed acceptance claims.

## Deferred ideas
None newly introduced. Existing ownership boundaries above are preserved rather than queued again.

## Glossary
- Focus: current keyboard row, independent of selected membership.
- Anchor: stable start of a contiguous Shift selection.
- Source coordinate: original CSV row/column, not current sorted display position.
- Lease: per-acquisition capability ownership, independent of shared buffer identity.

## Technical decisions and implementation contracts
One spec replaces separate tech.md under LOOP build-first policy. Shared types and schemas are committed before at most three implementers. Parent owns types.ts and quirky-plugin.json contract changes; components own disjoint source/tests/worktrees.

### Explorer contract
Existing quirky.editor/explorer gains actions navigate and select. navigate requires key from ArrowUp/ArrowDown/ArrowLeft/ArrowRight/Home/End/PageUp/PageDown; select requires authorized visible path. Both accept extend; select also accepts toggle; query selects the same filtered inventory as the visible Names mode. Interaction state contains selectedPaths, focusedPath and selectionAnchor; paths are authorized absolute worktree paths. Navigation results include interaction and expanded (existing expansion uses normalized worktree-relative paths). Explorer snapshot adds optional interaction fields for additive compatibility with existing stored/fixture state. ExplorerService owns the transitions and existing daemon emits state after interaction changes. Do not trust caller-supplied visible rows.

Successful rename/move/delete clears affected selection, focus and anchor before publishing state; directory descendants are affected, unrelated selection is preserved, and failed mutations preserve interaction.

### Notebook contract
Existing notebook actions/state schema remain; no second restart API. KernelSession gains an optional status-change notification consumed by notebook service; only the current live runtime/session publishes. Renderer observes published status and permits restart from dead without automatic trust/run. Implementer owns kernel.ts, service.ts and NotebookSurface.tsx plus focused notebook tests. All process fixtures use fresh HOME/QUIRKY_HOME and terminate exact owned children.

### Viewer contract
Existing quirky.editor/viewer gains endRow/endColumn for copy, inclusive and requiring row/column; legacy row/column/cell/all forms retain their meaning. media accepts optional nonempty leaseId (at most128 characters); release requires leaseId and returns released boolean. Unknown release is idempotent even after buffer close; it cannot create a resource. Lease-bearing media returns leaseId alongside existing url/contentType/size/acceptsRanges; anonymous clients remain close/dispose owned. Shared ViewerResourceParams/CsvCopyRange types provide the worker boundary and are used by implementation. Implementer owns viewers/service.ts, ViewerSurface.tsx, optional focused helpers and viewer tests; it does not edit shared manifest/types.

### Execution and verification
One wave with three disjoint components: Explorer, notebook, viewers (clipboard+lifetime share the same two hub files and intentionally remain one component). Implementers write acceptance tests but do not run tests/build/lint/format/reviews mid-flight. Parent runs bun run typecheck after integration and fixes reported type errors. User defers suites/reviews/dogfood to the end phase; developer-required narrow runtime smoke uses isolated throwaway API and surface checks, not a suite or UI campaign. Catch up build/roadmap exactly once before land, read incoming decisions, commit/detach and use only the canonical queue.ts land. New native clipboard scenario C1-native-clipboard is handed off pending; no native window run is claimed.
