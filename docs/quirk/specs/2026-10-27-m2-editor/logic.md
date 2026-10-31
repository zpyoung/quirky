# Editor and file explorer

## Status & amendments
Status: approved autonomously after Codex promote/refute review and recorded adjudication; tech spec required by LOOP.md and subsystem scope.

**Amendments:** 2026-10-27 — initial full queued scope; Codex clarified preview close identity, optimistic draft revisions and Keep/autosave holds. Later user ruling via operator: every Finder/OS drop imports a copy, including an in-worktree source; native SC-9 remains pending and open-in-place is deferred to the operator-owned follow-up. 2026-10-30 — SC-11 result clicks open a durable, unpinned normal tab and leave existing explicit pins unchanged. 2026-10-31 — New File/Create leaves typing in the newly opened editor, including rich Markdown; later focus/navigation cancels an unready handoff, and unrelated tabs or refreshes do not steal focus.

**Delivery amendment (D25, user ruling via operator):** land the verified core flows under the operator deadline and queue `m2-editor-complete-remaining-flows` for the exact unfinished implementations, UI defects and acceptance variants recorded in [open findings](../../../loop/BLOCKERS.md#m2-editor-open-review-findings). The full SC-1–22 below remains the completion target; this landing does not claim that entire matrix passed. Named Markdown creation is delivered; true untitled creation/Save As, rich details/toggle serialization and document-link insertion remain in that dependent item. Native SC-9 stays pending under the separate Finder-import ruling.

## Purpose and conceptual model
Review and edit agent-created files without leaving Quirky. People use the worktree explorer, quick open and editor tabs; agents use the same namespaced API and generated CLI. A file has one daemon-owned buffer per worktree and canonical path. Tabs in the existing terminal workspace refer to that buffer through a declared editor view; a dirty draft and its last-read disk baseline survive UI unmounts and daemon restart. A read-only viewer never creates a draft. A save never silently replaces disk changes made since the baseline.

## Scope & non-goals
All three editor slices in docs/roadmap.md: explorer, tabs, CodeMirror 6 code editing, guarded save/autosave, watch, quick open/search; rich Markdown; notebooks and CSV/image/PDF/media viewers. Every editor-owned flow in editor.md is covered below. Feature-owned handoffs remain with source control (Changes/diff/conflict surfaces and shared diff-note shelf), embedded browser (HTML side preview/external-link policy), artifact publishing, remote/mobile hosting and native chat (explicitly dropped in architecture). Their editor entry points must use public commands rather than import those plugins. No Monaco, language server or native chat. No global Python package installation or code execution without explicit trust/confirmation. All automated verification uses disposable worktrees/homes, never real user data.

## Data flow
Opening resolves a worktree and authorized relative path, loads a bounded file or viewer page and creates/reuses a buffer and tab. Typing updates the shared draft immediately and promotes previews. Saves serialize per physical path, flush pending editor changes, compare the content hash and write only if the baseline still matches. Watch events reload clean buffers and flag dirty ones without replacing drafts. File mutations rekey affected tabs atomically; operation history supports safe undo/redo. UI state and every view operation are read/write through the API. Viewers load on demand and release browser resources when hidden. A notebook kernel belongs to one open notebook and stops when that notebook closes.

## Key decisions & rationale
- Keep services in the built-in editor plugin and UI contributions on the public API. A monolithic IDE embed is incompatible with the chosen CodeMirror and plugin architecture; UI-only state cannot satisfy the scripting contract.
- A content hash is the save baseline, not mtime. Missing baselines fail closed; explicit overwrite is an intentional separate operation. Missing files can be recreated by explicit save, never autosave.
- Rich Markdown is source-preserving, not a canonical whole-document formatter. Unchanged source bytes, front matter and CRLF stay unchanged. Unsupported content falls back to source with a reason.
- Notebook execution requires tab-lifetime trust and a local Python interpreter. Persistent kernel state and execution queues are not simulated in the renderer.
- Bound work and expose truncation/unsupported cases instead of freezing the app or silently hiding results.

## Decisions Locked
### Interaction, density and errors
- Reuse existing shell/tab and sidebar conventions; explorer/search share one contribution — assumed — fast-tracked.
- Preview replacement, first-edit promotion, pinning, dirty-close choices and bounded reopen history follow editor.md — locked by feature doc.
- Loading, empty, too-large, binary, missing-file, permission and conflict states are visible and script-readable — assumed — fast-tracked.
### API, ownership and persistence
- All editor actions, including view/focus/selection/search/settings, have schema-declared editor API methods and CLI commands — locked by roadmap.
- Paths are worktree-scoped, symlink escapes are refused and mutations are serialized — locked by feature doc and architecture.
- Draft restoration verifies the saved baseline before autosave; no caller may bypass trust or conflict gates implicitly — assumed — fast-tracked.
### Markdown, notebooks and viewers
- CodeMirror replaces Monaco; TipTap loads only for rich Markdown — locked by architecture.
- Source mode is always available for editable text formats; rich/file-type modes are selected as in editor.md — locked by feature doc.
- Read-only large CSV and media/binary viewers cannot save drafts — locked by feature doc.
- macOS is the tested platform; native-only interactions are handed to the nightly native runner — locked by LOOP.md.

## Behavior & scenarios
Each numbered criterion is an API/CLI acceptance flow and a visible UI goal where a UI is named. Examples specify durable outcomes rather than implementation wiring.

### SC-1: Open and navigate files
Before: worktree has `a.ts`, `b.ts`, `README.md`. Single-click `a.ts`, then `b.ts`: one replaceable preview shows `b.ts`. Double-click or pin makes it permanent. Reopen the same worktree/path/mode: reuse it. Explicit group/focus and line/column targets are honored; background CLI opens do not steal focus. Path links and drops route through the same open command. Source position targets on Markdown force source. Distinct worktrees never share buffers accidentally.

### SC-2: Edit, find, select and save
Before: `a.ts` contains `const answer = 1;`. Type `2`, find/replace, undo/redo and save with Cmd+S (including when focus is outside the editor). After: disk contains the edited text; draft clears only if it still equals the completed save. Word wrap, zoom (8..32), contextual path/line copy and search-in-files work; gutter copy exposes absolute/relative line paths. Large paste is one undo step, UTF-8 safe, refuses over 16 MiB and suspends autosave until complete. No action exposes Monaco-only menus.
Concurrent example: UI loaded draft revision 3; an agent commits revision 4; UI attempts a whole-content update against revision 3. The update is refused without overwriting revision 4 and the UI preserves its unsent text for comparison/recovery. Neither client silently destroys the other's newer edits.
After clicking Save successfully, focus returns to the editable document, including rich Markdown. Later pointer or keyboard navigation takes priority while saving; command-triggered saves do not move focus.

### SC-3: Dirty close, close all and reopen
Before: two dirty tabs. Close one or all: Cancel preserves tabs/drafts; Don't Save quiesces timers/inflight work and discards; Save waits for a successful save before closing, leaves the dialog/error if it fails. Reopen closed uses a 10-entry nonpersistent stack, excluding Markdown previews and deleted empty untitled files. Background tab switches preserve cursor/scroll and draft.
Separate-preview example: dirty README edit tab and its read-only Preview are both open. Closing Preview closes only that tab with no dirty-close prompt, draft clearing or kernel cleanup. Closing the edit tab follows the dirty decision above; bulk/group closes cannot bypass it.

### SC-4: Autosave and restart recovery
Before: autosave off; dirty edit remains on disk baseline. Enable autosave, delay 1000 ms (clamped 250..10000): quiet edits save. Disk verification, conflict, deletion, large paste and explicit holds pause autosave. Restore a dirty tab after restart: retain its exact draft and saved baseline, verify disk before resuming. A save completed after a newer edit must not erase the newer draft.

### SC-5: External change and guarded save
Before: buffer read `old`, draft `mine`; disk changes to `theirs`. After watch/reveal or raced save: draft stays `mine`, disk stays `theirs`, conflict exposes Compare (disk left, draft right), Reload, Overwrite and Keep My Edits. Reload changes buffer to `theirs` with an 8-second draft-undo option. Keep keeps `mine` while acknowledging the new baseline so the next explicit save replaces `theirs`; autosave does not silently acknowledge it. Overwrite explicitly writes `mine`. A missing baseline or stale hash fails closed; equal mtime does not matter. Own-write echoes do not cause false conflicts.
Keep transition: acknowledgement sets an autosave hold that survives later typing and restart; only a successful explicit user/overwrite save or Reload clears it. Thus acknowledging disk cannot indirectly overwrite it on the next autosave timer.

### SC-6: Delete, rename, overflow and watch gaps
Before: open clean and dirty files. External deletion preserves content and marks deleted; explicit save recreates even an otherwise clean deleted buffer (regression against the observed Orca no-op); autosave never recreates. Atomic delete/create reloads or conflicts, not a stuck deleted mark. Rename rekeys tabs/drafts and paths. Overflow/reveal rescans buffers, including inactive/ignored paths, and never drops dirty content. Watch subscriptions are bounded and disposed with the owning plugin/worktree.

### SC-7: Explorer tree, settings and keys
Before: files/folders, dotfiles, ignored files, symlinks. Explorer sorts directories first, naturally; always hides `.git` and `node_modules`; toggles dotfiles/ignored/follow-linked-directories. Expand valid in-root symlinks only, with visible error for escape/broken links. Click/Cmd-click/Shift-click selection, arrows, Home/End/PageUp/PageDown, Space, Enter rename, Delete, path copy and operation undo/redo match the feature doc. Active file reveals ancestors; refresh preserves earlier children on read error. Sidebar open/search shortcuts only show, not toggle closed; resizing respects minimum editor space; activity bar position is adjustable.
At 160pt width in a default-height lower side slot, the Explorer leaves complete file rows visible and the tree scrolls to the remaining files. Short panels compact the path and search chrome; search keeps its accessible label, the worktree selector stays available when needed, and the header actions retain selection-wide path copying, deletion and Search in Files.

### SC-8: Explorer create, rename, duplicate, delete and history
Before: `file.txt` and directory. Inline New File/New Folder: Enter/blur commits, Escape cancels, initial menu blur does not accidentally commit. Row-menu and Enter-key Rename prefill only the basename and select a file's stem before its final extension (the whole name if extensionless) or a directory's full name including dots; submitting a filename retains its original parent. Rename and drag-move update all open descendants atomically; reject collisions, into-self and escapes. Duplicate chooses `file copy.txt`, then numbered copies without overwriting. Local delete uses Trash, saves dirty buffers first and aborts on save failure. Undo/redo (50 steps) restores text deletion/create/rename/move, refuses stale owner or changed destinations and clears redo on new mutation. Multiselection drops descendants of selected parents.
Delete confirmation names a single file or folder by basename; multiple targets show a plural item count. Row-menu and footer actions use the same confirmation.
New File/New Folder name inputs remain single-line and match the Find files input height.
After New File/Create succeeds, the new file's editable view receives focus once ready and after the inline controls close; source text and rich Markdown accept typing without another click. A later user focus or navigation action cancels an unready handoff; later refreshes or unrelated/background tabs do not steal focus.
Inline New File/New Folder and Rename controls remain outside the role=tree ownership while sharing the explorer scroll container; the tree contains treeitems only and retains keyboard navigation.
Successful inline Rename returns focus and selection to the renamed visible row, or a surviving neighbor if the new name is hidden by Explorer preferences or the current filter. Confirmed Delete focuses and selects the next surviving visible row, otherwise the previous row; deleted folder descendants are skipped, and an empty tree keeps keyboard focus without an active descendant. Newer user navigation takes priority over a pending mutation handoff; automatic focus changes caused by closing a deleted document do not cancel it.
New files, browser uploads (including chunked uploads), and create redo use normal file-creation permissions masked by the daemon's umask: `0644` under `022`, `0600` under `077`. External path imports use the source file's permission bits masked by that umask. Initial duplication preserves the source file's mode; duplicate redo reapplies the retained duplicate mode with the current umask. Owner-only sources remain owner-only through import and duplicate undo/redo. Private transfer staging remains owner-only.

### SC-9: Imports, clipboard paths and external tools
Before: an external file and a file already inside the worktree. Every Finder/OS file drop into the editor/explorer imports a collision-safe copy and opens the imported file; it does not open the source in place. App-defined row drops on folders still move, and dragging paths into terminals still inserts shell-escaped paths. Copy absolute/relative/multiple paths, header rename/copy/reveal and Open in Terminal use the existing public contributions. Native OS drop/picker/reveal/clipboard verification remains pending. Source: user ruling 2026-10-27 (via operator); the operator owns the open-in-place follow-up.

### SC-10: Quick open
Before: file inventory with recent paths and similar names. Cmd+P shows Go to file; fuzzy multi-term match, recent ranking, keyboard up/down/Enter/Escape and `README.md:3:2` open/reveal correctly. Absolute paths must still authorize within worktree; directories rejected. At 20,001 inventory entries/50 results truncation is visible; overlong query returns no results; missing ripgrep reports actionable guidance. Nested worktrees and excluded heavy folders are not traversed.

### SC-11: Contents search
Before: files contain literal/regex/whole-word matches. Names filters paths; Contents exposes case, whole-word, regex and include/exclude globs (including commas inside braces). Search produces grouped counts and one-line previews; clicking a result opens a durable, unpinned normal tab, preserves existing explicit pins, and reveals/selects the exact match. New query cancels older work and ignores stale results/owner changes. Cap 2,000 matches/15 seconds with visible truncation; bound 8 KiB inputs and 5 MiB files; invalid regex is a visible error. Find in Folder seeds an escaped include glob. Copy line path is scriptable.
The Explorer footer's Search in Files action focuses the Contents query field so typing can start immediately.
Switching between Contents and Names preserves the query. If the Names filter matches no paths, show a status naming the query and a Clear filter action. Clearing restores the tree, including files created while filtered, and focuses Find files.
Result navigation focuses Source at the hit's line/column and scrolls offscreen matches into view, including in an already-open tab. Repeating a hit navigates again; returning without a new hit restores the later cursor. A delayed acknowledgment of an earlier hit cannot discard the newest requested location.

### SC-12: Markdown modes and byte preservation
Before: CRLF Markdown with front matter, unusual bullet spacing, optional escapes and two paragraphs. Opens rich when supported; change only paragraph two and save: front matter and untouched paragraph bytes remain exact. No-op open/save leaves every byte unchanged. Source/rich switch and separate Preview use one draft; a separate Preview is a distinct terminal tab titled `<filename> (Preview)` while edit tabs keep `<filename>`. Mode changes, pinning, promotion, rename/Save As and reopening retain the title appropriate to each tab's mode. Flush on blur/save/unmount. HTML/JSX/MDX, reference links, footnotes or unsafe round trips fall back to source with a reason; 600 KiB rich gate, explicit Open anyway up to 1 MiB, preview limit 8 MiB. A render failure leaves the rest of the app usable and offers retry/source.
Native typing within a multiline paragraph preserves untouched soft newlines as plain newlines, including inside inline formatting. Existing hard breaks and newly inserted Shift+Enter hard breaks retain their explicit Markdown markers.
Document header controls wrap within the available editor width when side panels are open. View modes, Changes, Save, pin/close and zoom remain fully visible without horizontal scrolling; File actions stays right-aligned so its menu opens inside the document surface.
File actions closes on Escape and restores focus to its trigger. Clicking or focusing outside, including activating another right-rail panel without a pointer event, dismisses it without interrupting that action. Settings controls inside the disclosure remain usable while it is open.
Changes keeps focus on its Markdown preview/Source editor toggle in both directions.

### SC-13: Rich Markdown formatting and insertion
Before: editable document. Toolbar and slash catalog support Body/H1..H5, bold/italic/strike, bullet/numbered/task lists, quote, links/images, code, divider, tables, collapsible text/headings, Mermaid, inline/block math and emoji. Slash keyboard navigation filters aliases and Escape leaves `/`; IME/read-only suppresses it. Code language/copy/indent, table row/column operations and keyboard navigation preserve valid Markdown. Doc-link completion handles `[[target|label]]`, bounded inventory and ambiguity without a wrong destination. Link bubble open/copy/edit/remove, relative document/anchor navigation and alternate system routing work. Image import/paste uses collision-safe same-folder paths and limits, never arbitrary file reads.

### SC-14: Markdown search, TOC, front matter, templates and PDF
Before: Markdown with repeated headings/front matter and `.orca/templates` documents. Rich/preview find, case/whole-word, next/previous, replace/all never edit preserved atoms. TOC H1..H5 uses deduplicated slugs and scrolls; front matter toggles read-only; source edits it. New Markdown creates collision-safe untitled file with optional bounded templates and the documented placeholders, unknown placeholders stay literal. Save retargets untitled in place; untouched empty placeholder close removes only its own unmodified file. PDF export from rich/preview produces a valid PDF and preserves disk Markdown; unavailable export reports a real error rather than fake success. Native save sheet/replace confirmation is handed off.

### SC-15: Markdown review notes
Before: Markdown selection. Add/edit/delete note with selected excerpt and front-matter-correct line span; rail count and copy use documented sorted prompt formatting and escaping. Send existing/new-agent targets through public agent send/launch readiness gates; keep notes on failure, delete only delivered notes. Read-only/oversized input errors are visible. Source-control note shelf remains owned by source-control plugin, not duplicated.
The rich editor starts with the review-notes rail hidden. Its visible Review notes count toggle opens or hides the rail without losing saved notes or an unsent composer draft. Adding a note from the selected text opens the rail. At narrow editor widths, the rail's heading and action labels wrap inside it.

### SC-16: Notebook parsing and cell editing
Before: `.ipynb` with metadata, Markdown, code/raw cells and outputs. Opens Notebook with Source toggle, count and language. Edit cell, insert above/below, move, change type, delete (last cell becomes empty code), clear outputs and save valid JSON with one-space indent and preserved root metadata. Source arrays retain newlines; id-less executed cells acquire ids and nbformat_minor >=5. Malformed notebooks show a useful error and raw source remains accessible.

### SC-17: Notebook trust, Python and setup
Before: untrusted local Python notebook. Run cell/all refuses until the tab's trust is explicitly granted; closing revokes trust and shuts kernel. Discover workspace `.venv`/`.conda` and PATH interpreters; arbitrary interpreter probing is explicit because it runs code. Select/Browse Python validates executable/version without silently mutating notebook content. Missing Python/ipykernel show actionable setup; Install requires explicit irreversible confirmation or `--yes`. PEP 668 routes to workspace venv; missing pip may ensurepip then retry. Non-Python/nonlocal/unresolved hosts cannot run. Never install globally without explicit consent.

### SC-18: Notebook kernel lifecycle and outputs
Before: trusted notebook/kernel. Run in place or advance; run-all queues one execution at a time, error cancels remaining queued cells; variables persist between cells. Run with cwd notebook's real directory and stdin disabled. Interrupt, stalled-interrupt notice, restart (keep outputs, drop queue), unexpected death/stderr and close cleanup work. Render stream/errors with ANSI, safe MIME preference, JSON/Markdown/images and sandboxed sanitized HTML; never execute JavaScript/widgets or remote content in output. Execution count and busy state are observable via API.

### SC-19: CSV and TSV
Before: quoted delimiters/newlines, editable small CSV. Table defaults rich, Source works; filter/sort/cell edit/copy/paste/add/remove rows/columns/delimiter/save keep syntactically correct values. Table mutations cannot exceed 1 MiB. CSV >=1 MiB is read-only paged preview with bounded records/columns/cache; no giant full-text load, no accidental draft, changed-on-disk notice and reload. Invalid/over-limit records show an error instead of hanging.

### SC-20: Images, PDF, audio/video, Mermaid and binary
Before: sample files. Images show dimensions/bytes and zoom 0.25..8; reject oversized decoded pixels and malformed preview. PDF supports page-width/zoom 0.25..5, find and retained view position without unsafe embedded scripts. Audio/video use native controls and bounded ranged transport, explicit codec error and Open in Default App. Mermaid uses strict sanitized rendering with Source. NUL binary shows cannot-display; files >50 MiB show too-large; loading/error/retry do not crash other tabs. Revoke object URLs and dispose hidden viewers.

### SC-21: Settings and shortcut precedence
Before: editor and terminal focus. Settings cover autosave/delay/font/wrap, preview reuse, spellcheck/review tools, dot/ignored/symlink preferences, sidebar/activity and font zoom. Daemon state and public view commands agree with what window shows. Cmd+Shift+G opens Source Control exactly once and must not also run editor find-previous (recorded Orca behavior); Cmd+L, Cmd+Shift+E/F, Cmd+P and save/close/reopen honor focus and declared bindings. Unsupported feature-owned commands return a precise unavailable error.

### SC-22: Plugin lifecycle and scriptability
Before: stock plugin registry. Editor contributes schemas, commands, keybindings, settings, sidebar/view and namespaced API/CLI using only public API. Disable/replace contributions: no private runtime dependency; watchers, timers, kernel processes and mounted editors dispose. Every SC above has a CLI/API test and UI scenario where visible; native-only interactions are recorded separately. Agents can read buffers, tabs, selection, conflicts, search results, viewer and kernel state without screenshots.

## Defect regression requirements
- Dirty drafts never lose content on watcher echoes, save races, reload failure, restart, close-all partial failure or filename-owner collisions (SC-3..6).
- Clean deleted files can be intentionally recreated without first making a spurious edit (SC-6).
- Shell/CodeMirror keyboard dispatch has one owner: Source Control shortcut does not also invoke editor find (SC-21).
- Rich editing never rewrites untouched source bytes through a canonical fallback (SC-12).
- Overlong inputs, watcher gaps/overflow, paged files and unsupported MIME types remain bounded, safe and visible (SC-6, SC-10..20).

## Industry Insights
- [CodeMirror's system guide](https://codemirror.net/docs/guide/) separates state, view and extensions; explicitly compose find, history, language and keymaps, and destroy hidden views.
- [TipTap Markdown usage](https://tiptap.dev/docs/editor/markdown/getting-started/basic-usage) describes structural parsing/serialization, not byte preservation. Test round trips and retain original source alongside the structured document.
- [Jupyter security](https://jupyter-server.readthedocs.io/en/latest/operators/security.html) treats notebook execution as arbitrary code execution; tab trust must gate kernel start as well as run.
- [HTTP range requests](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Range_requests) and [PDF.js loading](https://mozilla.github.io/pdf.js/api/draft/module-pdfjsLib.html) allow bounded seeking rather than whole-file base64 transfers.
- [Node filesystem documentation](https://nodejs.org/api/fs.html) warns concurrent writes are unsynchronized. Serialize compare/write by physical identity and recheck disk immediately before writing; do not claim a cross-process atomic compare-and-swap that filesystem APIs cannot provide.
- Context research and option validation compared a monolithic editor, focused services/components and embedding an IDE. Focused services/components fit Quirky's public mounts, daemon ownership and memory model; an embedded IDE does not remove the local save/trust contracts.

## Deferred Ideas
None beyond the feature-owned handoffs named in Scope. `[tech-spec]`: exact public contribution seams, watcher worker, Markdown source mapping, notebook bridge and viewer streaming contracts belong in tech.md.

## Glossary
- Buffer: shared file content, baseline and draft, independent of visible tabs.
- Preview tab: replaceable tab until promoted by edit, pin or double-click.
- Baseline: content hash of bytes last loaded/acknowledged, not filesystem metadata.
- Conflict: disk no longer matches the baseline; draft and disk remain separately accessible.
- Rich mode: structured editable Markdown/table/notebook presentation; source remains available.
- Trust: explicit, nonpersistent permission to execute notebook code for this open notebook.
