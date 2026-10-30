# Editor follow-through

## Status & amendments
Status: design checkpoint only; no implementation changes. The operator-directed immediate landing supersedes the pending review and execution plan. Tests, debugging, review and GUI acceptance belong to the end phase.

**Amendments:** 2026-10-28 — initial completion design for the remainder transferred by m2-editor D25–D26. Later the user moved all testing/debugging to the end phase and directed in-progress items to land immediately after typecheck. The behavior below is the retained target, not delivered behavior. One follow-up names only unbuilt flows; already-built behavior needing verification or bug fixes stays with the end phase.

**Catch-up amendment:** the single pre-land roadmap merge brought in `m7-sweep-editor-source-control`, which already implements owned untitled creation/public `quirky.editor/saveAs`, Preview return handling and local draft-ack correlation. Those incoming implementations and their decision log supersede this checkpoint's earlier proposals; do not rebuild them or add a `markdown retarget` alias. Their remaining testing/debugging belongs to the end phase. `m7-editor-source-control-completion` already owns rich details/document-link and permission follow-through; the newly registered follow-up must skip delivered behavior and respect that existing owner, implementing only its remaining unbuilt interactions/controls/lifetime work.

## Purpose and conceptual model
Finish the existing built-in editor, not a second editor. The daemon continues to own one revision-checked buffer per worktree/path, durable drafts, disk baselines and view metadata. Terminal hosted tabs refer to those buffers. Source, Rich and separate Preview share text without sharing tab identity. A local asynchronous acknowledgment is not another writer.

## Scope & non-goals
The retained target is the exact remaining implementation and GUI matrix in [the original open findings](../../../loop/BLOCKERS.md#m2-editor-open-review-findings), retaining [original SC-1–22](../2026-10-27-m2-editor/logic.md#behavior--scenarios) as the behavioral contract. The cases below describe unfinished variants; this checkpoint does not implement or regression-check them. Existing product behavior is unchanged.

Excluded: Finder open-in-place (operator-owned item), native chat, private imports of neighboring plugins, remote execution implementation, unrelated shell redesign, and reconstructing real-home files from the historical D22 incident without a trustworthy baseline. Physical Finder drops, native pickers/save sheets, OS clipboard/default-app focus and menu shortcuts remain real-window scenarios for the nightly runner, not simulated web passes.

## Data flow
Rich operations parse into supported structured nodes, serialize, and reconcile against the original bytes before committing through the existing draft revision check. Untitled creation uses a collision-safe owned placeholder with explicit untitled identity; Save As writes the selected authorized relative destination, retargets the same live buffer/tabs only on success, and relinquishes placeholder cleanup rights. Permissions are an advisory disk capability, distinct from format read-only state; writes still perform authoritative permission and baseline checks. Rendering observes revisions and local pending acknowledgments without replacing newer unsent text.

## Approaches and decisions locked
- Extend the existing focused editor services and public API (chosen). Replacing the editor or adding a parallel document store would split ownership and violate the locked CodeMirror/plugin architecture.
- Enable details and document-link operations only with demonstrated structural round trips and untouched-byte preservation. Removing the safety gate alone is not a fix. Arbitrary HTML/JSX, references and footnotes keep their Source fallback.
- Untitled follows the feature doc's owned on-disk placeholder lifecycle, not a new virtual filesystem. Blank creation is untitled; template-created buffers are untitled but never auto-deleted as untouched blank placeholders. Named files never acquire cleanup rights.
- Save As is an explicit destination decision. Cancel, collision, denied write or stale source leaves original identity and draft intact. No implicit overwrite of an existing destination. Save on untitled opens the destination flow; autosave cannot accept a filename on the user's behalf.
- Read/write capability reflects actual OS access including ACLs, not chmod bits alone. Expose a permission indicator/error; permit an editable-format draft and review notes even when disk is currently unwritable. Denied save preserves the draft; refresh/retry can observe changed permissions. Binary/large-viewer read-only policy stays separate.
- Preview → Source/Rich focuses/reuses the matching edit tab and preserves the separate Preview. Same-window edit/undo/acknowledgment does not warn; a genuine stale peer edit still fails CAS and preserves local text with a warning.
- Existing density, keyboard registry, loading/empty/error surfaces, bounded inventories/search/resources, trust and process-lifetime rules remain. Every new user action has schema-declared API and generated CLI support; no renderer-only durable state.
- No human prompts in this unattended loop. Recommended defaults, docs and earlier decisions settle questions; every substantive choice is recorded. Mac only, native-only outcomes handed off. No global Python installation; all successful setup verification is inside disposable owned environments.

## Behavior & scenarios
Each acceptance case includes both daemon API/generated CLI coverage and a guarded web scenario for its visible portions. Existing tests are reused where they already prove a contract. A declaration or API-only pass is not GUI proof.

### C1: Details, toggle headings and document links (SC-12–13)
Before: CRLF document with front matter, an unusually spaced untouched paragraph, empty/populated nested details and a document link with a label. Open Rich, no-op save, edit only details body and save/reopen: untouched bytes stay exact, empty details survive, summary/body hierarchy remains. Insert Toggle Text and Toggle H1–H5 through toolbar/slash and API; collapse/expand does not delete content. Unknown HTML attributes/content must preserve semantics or safely use Source, never silently discard them.

Before: `target.md` and ambiguous same-basename files. Type `[[tar`, keyboard-select completion, and save/reopen: `[[target]]` is a document-link atom; `[[target|label]]` preserves both fields. Click unique targets/anchors correctly; ambiguous or unsafe paths do not open the wrong file. Invalid insertion leaves the draft unchanged.

### C2: Untitled and Save As (SC-3,14)
Before: root already contains named `untitled.md`. New Blank creates another collision-safe placeholder marked untitled and opens it. Cancel Save As retains the tab/draft. Save As `notes/new.md` commits and retargets all references to the same buffer/tab without replacing an existing file; a later normal Save writes there. Untouched empty blank close removes only the exact owned, still-empty placeholder; a replaced/externally edited placeholder, template-created content or named file is never deleted. Dirty close Save routes through Save As; Don't Save and close-all retain their existing safety gates. Restart retains untitled identity, draft and cleanup provenance.

### C3: Filesystem permission UX
Before: readable text/Markdown is denied writing by permissions or ACL. Open shows disk write restriction while content remains readable; notes can be added, local edits retained, and Save reports permission denial without clearing the draft. Re-enable writing, refresh/retry and save: the indicator and disk update. Permission-denied reads show a specific accessible error/retry state. The OS write result, not a stale indicator, decides success.

### C4: Shared draft acknowledgments and Preview routing
Before: one Source window with delayed draft acknowledgment. Type, undo, redo and switch/remount while acknowledgments arrive: text and undo history remain correct without a false newer-shared-draft warning. A second writer updates the same revision while unsent local text exists: stale submission is refused, local text remains recoverable and a real conflict is visible. Rich applies the same safety rule. Open separate Preview and choose Source/Rich: edit tab becomes active in requested mode, Preview remains distinct, draft unchanged; repeated switching does not duplicate edit tabs.

### C5: Close/conflict/watch/restart GUI (SC-3–6)
Before: clean, dirty and separate Preview tabs plus one file whose save will fail. Mixed Close All → Cancel preserves everything; Save All failure keeps the failed dirty tab and error, never discards it; Don't Save quiesces queued writes and closes selected buffers. Reopen history excludes Preview and deleted blank untitled placeholders.

Before: baseline `old`, draft `mine`, external disk `theirs`. Compare shows both sides; Keep retains draft and autosave hold through further typing, unmount/remount and daemon restart; explicit Save/Overwrite alone can replace disk. Reload displays `theirs`, Undo within eight seconds restores the draft safely. Clean external edits reload; deleted clean file can explicitly recreate without a spurious edit; autosave never recreates. Atomic replacement of an inactive/ignored file and overflow/reveal reconcile without dropping drafts.

### C6: Explorer operations and search GUI (SC-7–11)
Before: folders, dot/ignored files, valid/broken/escaping symlinks, nested file names and two candidate destinations. Verify natural directories-first sorting, visibility preferences, safe symlink errors, click/Cmd/Shift range selection and Up/Down/Left/Right/Home/End/Page keys/Space/Enter/Delete. Refresh errors keep previous children; active-file reveal expands ancestors; sidebar show shortcuts do not toggle closed.

Create files/folders with Enter/blur/Escape; rename/move open descendants; refuse collision/into-self/escape. Duplicate chooses successive copy names. Delete with a failing dirty save aborts; successful text deletion, create, rename/move undo/redo restore exact content, and a fresh mutation clears redo. Copy single/multiple absolute/relative/line paths; web import creates collision-safe copies; internal row drag moves, terminal drag inserts shell-escaped paths. Physical OS equivalents use native handoff. Row Actions closes after every action and on Escape or outside pointer/focus; choosing Rename closes the menu before the inline field receives focus. An open menu retains its focused action across Explorer rerenders, and Enter activates that action.

Quick Open ranks recent fuzzy multi-term names, handles arrows/Enter/Escape and `README.md:3:2`, rejects directories/unauthorized paths and shows truncation. Contents case/whole-word/regex/include/exclude (including brace commas) produce correct grouped matches; clicking reveals the exact span. Invalid regex is visible, stale searches do not replace current results, truncation is explicit, Find in Folder escapes its scope.

### C7: Rich controls, templates, PDF and notes GUI (SC-13–15)
Before: a supported rich document. Exercise Body/H1–H5, bold/italic/strike, lists/task lists/quote; slash aliases/up/down/Enter/Tab/Escape, composition and read-only suppression; table row/column add/delete and Tab/Enter; code language/copy/indent; math/Mermaid/emoji; link bubble open/copy/edit/remove; collision-safe image import/paste/drop and resource cleanup. Saved/reopened text is valid and untouched source is preserved.

Find case/whole-word, next/previous, replace/all respects preserved atoms. TOC repeated-heading slugs/H1–H5 navigation and front matter visibility/source edits work. New Markdown searches bounded templates and substitutes documented placeholders while preserving unknown placeholders. Export from Rich and Preview reports actual success/error/cancel, yields a valid PDF without changing Markdown; native save/replace sheets are handed off.

Select text with front matter, add/edit/delete note, inspect count and sorted/escaped copy format; send to existing and new-agent targets with readiness gates. Failure keeps notes, success deletes only delivered versions. No private agent/source-control imports or fake successful delivery.

### C8: Python setup and kernel recovery GUI (SC-17–18)
Before: disposable Python environments with/without pip/ipykernel, including externally-managed metadata. Choose interpreter and run: explicit tab trust precedes execution; install/venv actions show command/consent and errors, then successful consent-mediated setup uses only owned disposable environments. Missing pip follows ensurepip/retry; externally-managed Python routes to a workspace venv. No global install or silent interpreter execution.

Run-in-place/advance/all shows execution counts and serialized queue; errors cancel queued cells, state persists between runs, cwd is notebook directory and stdin is disabled. Interrupt/restart/death recovery preserves outputs appropriately; closing revokes trust and stops owned processes. Show ANSI streams/errors, JSON/Markdown/images and sandboxed sanitized HTML, not JavaScript/widgets/remote output content. Source remains available after errors.

### C9: CSV/media/PDF/shortcuts/lifecycle GUI (SC-19–22)
Before: quoted multiline CSV/TSV, a >=1 MiB paged CSV, image/PDF/audio/video/Mermaid/binary/oversized fixtures. Exercise small-table filter/sort/edit/copy/paste/rows/columns/delimiter/save and Source round trip; paged navigation is read-only, bounded, has changed-on-disk reload and malformed-record errors. Image zoom/metadata/limits; PDF find/page-width/zoom/position; media playback/seek/codec errors and native default-app handoff; Mermaid strict preview/Source; binary/too-large/retry errors do not break other tabs.

Rebind the declared editor/sidebar/save/close/reopen/copy/zoom/explorer shortcuts and verify effective bindings in editor and terminal focus across groups; Source Control dispatch must not also find-previous. Disable/remount editor with dirty drafts and a live notebook: subscriptions/timers/kernels/views/resources dispose and reactivation restores valid daemon state, not dead contributions or lost drafts.

## Defect regression requirements
Retain original deleted-clean-save, shortcut single-owner, rich-byte-preservation and bounds regressions. Add the observed Preview return and own-ack warning regressions. A successful UI action must show its intended effect, not an unrelated trailing click. Report tool-limited/blocked/partial evidence honestly; do not reinterpret those as passes.

## Industry insights
Reuse the original editor research: [CodeMirror composition](https://codemirror.net/docs/guide/), [TipTap Markdown](https://tiptap.dev/docs/editor/markdown/getting-started/basic-usage), [Jupyter security](https://jupyter-server.readthedocs.io/en/latest/operators/security.html), [HTTP ranges](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Range_requests) and [filesystem race constraints](https://nodejs.org/api/fs.html). These support retained architecture, not an independent claim that the missing flows work. No new architecture or external research swarm is needed for this completion against existing contracts.

## Deferred ideas
None newly added. Previously owned feature handoffs and native-only verification remain named above; no completion flow is silently deferred.

## Glossary
- Untitled: owned placeholder awaiting explicit destination, not any file named untitled.md.
- Format read-only: content kind cannot accept drafts; distinct from current disk write permission.
- Own acknowledgment: result/event of an identified pending local revision update, not arbitrary matching text.
- Separate Preview: read-only hosted tab sharing a buffer, not a replaceable editable browsing tab.

## Technical decisions — proposed, not implemented
The superseded separate tech draft is retained with this iteration's evidence, not shipped as an approved implementation contract. Repository mapping found these implementation boundaries:
- Rich custom nodes: `plugins/quirky.editor/src/markdown/{Toggle.ts,DocumentLink.ts,tiptap.ts,source.ts,operations.ts,service.ts,MarkdownSurface.tsx}`; retain original-source reconciliation and exact no-op/front-matter/CRLF invariants.
- Untitled lifecycle was mapped to `src/daemon/{service.ts,files.ts,store.ts}`, `src/types.ts`, `src/window/{DocumentSurface.tsx,CloseOverlay.tsx}`. The earlier service-signature proposal is superseded by the catch-up's actual public `quirky.editor/saveAs` contract, which requires `bufferId`, relative path and `expectedRevision`; preserve its implementation and provenance rather than adding a second API.
- Permissions: proposed optional `EditorBuffer.diskWritable` is distinct from format `readOnly`; effective OS access is advisory and denied writes preserve drafts. No type/schema has been changed.
- Notebook recovery: `src/notebook/{kernel.ts,service.ts,NotebookSurface.tsx}`; expose actual idle death and restart from dead while retaining trust, output and process cleanup.
- Viewer controls/lifetime: `src/viewers/{service.ts,ViewerSurface.tsx}`; expose row/column/range clipboard and exact mounted-owner resource release without invalidating another split viewer. Proposed media `leaseId`/`release` contract is unimplemented.
- Explorer missing keyboard flows belong to `src/window/ExplorerPanel.tsx`; public scriptability and manifest declarations remain mandatory. Read-only investigation also found incorrect absolute-path composition in Copy Path/Open in Terminal and empty-query Search intent, which are end-phase debugging evidence, not claimed fixes.
- Rebound shortcut double-dispatch is unproven: the shell already handles effective bindings at window capture and stops propagation. Exercise it in the end phase rather than adding a second binding subsystem on speculation.
- The public manifest stays on the flat schema subset. Future implementers must commit shared contracts first, use at most three implementers under current LOOP.md, and never run tests/review/dogfood until the end phase.
- Existing native scenarios remain in `docs/loop/native/m2-editor.json`; no new native surface was built here.

