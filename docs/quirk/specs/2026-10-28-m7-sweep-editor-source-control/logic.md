# Editor, sidebar extras and Source Control parity sweep

## Status & amendments
Status: Approved autonomously under LOOP.md; combined logic and technical spec under night rules.

**Amendments:** 2026-10-28 — initial sweep of the three feature documents, preserving their explicit provider exclusions and prior native capability ruling.

## Goal and conceptual model
Close concrete cross-item gaps without replacing canonical owners. `quirky.editor` owns file buffers and Markdown notes; `quirky.git` owns diff notes and Source Control; sidebar extras projects worktree/repo/session/hosting facts through public APIs. UI and generated CLI drive the same declared methods. Source editing remains CodeMirror 6, as architecture.md requires.

## Scope and coverage map
The read-only source documents are `/Users/zpyoung/PycharmProjects/PERSONAL/quirky/research/orca-features/{editor,sidebar-extras,source-control}.md`. Existing source/test coverage is a map, not a new passing claim.

| Document flow | Existing owners/evidence | Sweep disposition |
| --- | --- | --- |
| Editor opening, preview/permanent tabs, close/reopen, code editing, view modes | editor daemon/service.ts, window/{DocumentSurface,SourceEditor}.tsx; core, ui-api, active-document tests | Preserve; repair preview return and own-ack warning; add untitled lifetime |
| Guarded save/autosave/external changes/deleted recovery | editor service.ts; core/core-acceptance/ui-api tests | Preserve content CAS, explicit deleted-save fix, dirty-close choices |
| Rename/untitled/duplicate/delete/history | editor service.ts, markdown/service.ts; core/markdown tests | Implement actual untitled placeholder and Save As, never delete ordinary named files |
| Markdown rich/source/preview/notes/templates/TOC/frontmatter/PDF | editor markdown modules; markdown and markdown-acceptance tests | Integrate canonical Markdown notes into Source Control; retain safe source fallback for unsupported rich constructs |
| Notebook editing/trust/local execution/setup/outputs | editor notebook; notebook/viewer-acceptance tests | Preserve; exhaustive GUI/setup acceptance is larger completion work |
| Explorer/search/Quick Open, keyboard, mutations and file viewers/settings | editor window/daemon/viewers; core, viewer, ui-api tests | Preserve; carry exhaustive unaccepted GUI variants into explicit completion follow-up |
| Native Finder same-worktree open versus external import | m4-editor-drop-open-in-place D1–D6 | Existing blocked item owns missing native source paths; no guessed identity or unapproved native patch |
| Cross-repo worktree groups/create/assign/drag/remove/subtree deletion/folder guards | worktree Menu/Tree/report, repo/groups; sidebar-membership/sidebar-groups/sidebar-extras-ui/e2e tests | Preserve membership CAS, repo ownership, placeholders and lineage; ledger handoff already exists |
| Activity windows/custom validation/live exemption/hidden count/badge/clear | sidebar-extras state/projection; worktree ActivityFilters/useSidebarActivity; activity/UI tests | Check quiet aging and blur-only custom validation, retain per-client isolation and max recency semantics |
| Review filters/cache/stale safeguards | sidebar-extras reviews/projection, hosting cachedReviews; review-filters/cached-reviews/UI tests | Preserve conservative unknown/stale visibility, activity-only count and cache-only reads |
| Dirty activity dot and separators | sidebar-extras dirty/ui, worktree report/Tree; dirty/ui/e2e tests | Preserve active-worktree-only count, accessible title, capped floor and geometry |
| Git panel/sections/filter/tree/selection/discard/commit/remote/compare/history/conflicts/huge repo | git panel/daemon/view; scenarios and window tests | Preserve unreachable-selection fix, Continue operations and explicit diff read failures |
| GitHub header/create/link/status and hosted review handoffs | git WorktreePanel; hosting pr-create/pr-review; reviews create methods/UI | Repair missing public handoffs and status gating using existing hosting/reviews owners; never introduce non-GitHub providers |
| Diff/combined/branch/commit/binary/large display and notes | git view/notes/daemon; diff/notes/window/UI tests | Preserve caps and errors; unify Markdown and diff shelf operations with snapshot-safe settlement |
| Edit-tab Changes mode, Markdown diff preview, hosted preview/split diff tabs | Earlier core D35; no integrated owner found | Record as larger explicit completion flow, not claim present because a separate Git diff view exists |
| AI messages/fixes/recipes/defaults | git ai/daemon, agents; ai scenarios/window tests | Preserve user-owned CLI execution, cancellation and no-hook-bypass; hosted creation composer stays reviews-owned |

## Behavior & scenarios

### P1: Untitled Markdown has a real lifetime and Save As
Before: `untitled.md` already contains unrelated text. New blank Markdown creates a collision-safe placeholder, marks its buffer untitled and opens an edit tab. Saving asks for an authorized relative destination. Cancel preserves the placeholder and draft. Saving to `notes/plan.md` writes the latest acknowledged draft, preserves buffer/tab identity, clears untitled, updates note paths and removes only the owned placeholder. An occupied destination or stale expected revision fails without overwriting either side. Closing a clean zero-byte non-template placeholder removes it; template-created or edited files are retained. Ordinary named files are never cleaned up as placeholders.

### P2: Preview returns to an editor, and own acknowledgments are not peers
Before: a Markdown buffer has a separate rendered Preview tab and a dirty shared draft. Source or Rich Editor on that tab returns to an editable surface while preserving content and tab identity. An edit/undo whose draft response and subscription arrive in either order does not produce a false shared-writer warning. A genuinely newer competing update still retains local text and reports conflict; content-revision CAS is not weakened.

### P3: One Notes shelf, two canonical stores
Before: worktree A has a Git note on `src/a.ts` and a Markdown note on `README.md`; worktree B has another note. The Source Control shelf and file counts include both A notes, sorted by path/line, and exclude B. Markdown notes remain visible after their editor tab closes and after restart. Opening one uses its real editor file/line rather than a Git-only diff. Shelf copy/send uses `File`, `Source: markdown` when applicable, `Line`/`Lines`, escaped `User comment`; it does not append Markdown excerpts on this shared surface. Markdown's own rail keeps its existing excerpt formatter.

A mixed-scope send makes one prompt and holds the chosen snapshots against duplicate sends. Success deletes only unchanged delivered notes from their owning stores. If a note changes during delivery, that version survives. Failed/unconfirmed delivery deletes nothing. Clear-all or per-file uses the existing confirmation and clears both stores without cross-worktree mutation. Missing editor plugin leaves Git notes usable; other errors remain diagnosable rather than silently implying no notes.

### P4: GitHub handoffs use current canonical review state
Before: a GitHub branch is open in Source Control. Lookup/current head identity determines found, no-review or unavailable state. Found reviews offer their link/open action; loading/unavailable state never starts speculative review creation. Create PR opens the existing reviews-owned composer with the exact worktree after the existing guarded prepare flow; title/body/draft/template/generation are not reimplemented. Merged/closed or linked review states and push-before-review actions use public hosting/reviews contracts where available; any genuinely larger remaining flow is named explicitly in the one follow-up, not marked shipped by presence of a button. No speculative push to a PR-derived remote is allowed without validated target support.

### P5: Sidebar boundaries remain usable and scriptable
A Custom-days input changed from 30 to 3 and blurred without Enter persists 3; invalid zero/text/unsafe integers retain the prior value and show an inline error. A quiet workspace ages out as the cutoff advances without unrelated store events; the open workspace remains. Recovery resets only activity, while Clear resets activity and both review filters. Fresh agent liveness and unknown providers do not invent activity/health evidence. Existing group, review, dirty and separator regressions remain intact.

## Decisions locked
- Scope is all three documents except the explicitly named non-GitHub forges, Objective runner and PR sitter. The item explicitly authorizes larger flows as follow-ups; record one consolidated follow-up once before landing.
- Native Finder capability remains governed by the existing blocked item; do not duplicate it or fake paths.
- Preserve canonical storage and public APIs, content-hash/CAS guards, exact snapshot deletion and confirmation conventions. No private cross-plugin imports.
- Prefer focused extensions of existing owners over a new parity plugin or duplicate note store. Replacing the full editor/Git UI would duplicate state and increase regression risk.
- Keep macOS-only verification, isolated HOME/QUIRKY_HOME and owned process cleanup. Linux/Windows behavior is not verified here.

## Industry insights
No external research swarm under LOOP.md night mode. The three feature docs, existing owner APIs, recorded failures and prior decision logs supply evidence.

## Deferred ideas
Queued once as `m7-editor-source-control-completion`, dependent on this sweep: lossless rich details/collapsible headings and custom document-link insertion/completion; full editor GUI acceptance matrix in BLOCKERS.md SC-3–22; permission-aware filesystem UX; integrated edit-tab Changes/Markdown diff preview and hosted preview/permanent/split diff tabs; GitHub fork notices, validated PR-derived push destinations and target-specific push-before-PR; exhaustive sidebar edge acceptance. Existing native Finder blocker is separate and unchanged.

## Glossary
Untitled placeholder: an owned on-disk Markdown file whose tab has not chosen its final destination. Snapshot settlement: deletion only when every persisted note field still matches the version delivered. Canonical owner: the plugin that persists the feature's authoritative data.

## Technical decisions and contracts
- Shared schemas are committed before implementers. `quirky.editor/saveAs {bufferId,path,expectedRevision}` returns saved/retargeted buffer info and refuses stale revisions, existing destination and non-untitled input.
- `quirky.editor/workspaceNotes {worktree?,action:'list'|'reserve'|'release'|'settle',path?,snapshots?,holdId?}` lists canonical Markdown note objects including closed buffers; reserve requires a unique holdId and exact snapshots and returns `{reservedNoteIds,unavailableNoteIds}`; release requires holdId and returns `{releasedNoteIds}`; settle returns `{deletedNoteIds,retainedNoteIds}` after exact snapshot comparison and, when holdId is given, only for that holder. Reservation is shared with Markdown-rail sends, acquired before delivery and released in finally on every outcome. Notes from other worktrees are never mutated. All normal Markdown note writes and settlement emit existing editor changed notification.
- Git reads the editor via public calls, locally projects Markdown notes into its existing Note shape with explicit origin/owner metadata, and routes settlement back to editor. No cross-plugin source imports or replicated tables. Existing Git-generated CLI methods cover the unified shelf operations.
- Three disjoint implementers: editor lifetime/surface fixes; mixed canonical note shelf; GitHub status/handoff integration. Parent owns sidebar boundary checks and shared schema amendments. Editor lifecycle owns service/types/store/markdown-service/main/UI; notes owns editor markdown/notes plus Git notes/targets/readers/shelf, never editor main/types/service/manifest. Parent integrates workspaceNotes registration after the wave. Tests are single-owner.
- Use existing package fixtures and public daemon/CLI acceptance. Implementers do not run build/lint/tests mid-flight; parent runs behavioral checks after the barrier. Permanent regressions cover consumer behavior, races and boundaries, not text copies or internal forwarding.
- Gates: affected `bun scripts/suite.ts` directories, `bun test scripts`, `bun run typecheck`; build and one real-daemon guarded web campaign for changed controls. The unstarted final review campaign is skipped under LOOP's aged-item rule, with no review-clearance claim. One roadmap catch-up immediately before queue-controlled landing; land owns whole-suite verification.
- **Amendment 2026-10-28:** owner-side reserve/release closes the cross-surface duplicate-delivery race; Git-local holds alone cannot fence a simultaneous Markdown-rail send.
- **Amendment 2026-10-28:** empty headless Markdown initializes an actual empty document instead of invoking Tiptap's HTML parser without a window. Strict snapshot fields, BINARY path ordering and optional-owner fixture outcomes were repaired from concrete required-gate failures.
