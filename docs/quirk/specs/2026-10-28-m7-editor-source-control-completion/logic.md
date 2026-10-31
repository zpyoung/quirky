# Editor, Source Control and sidebar completion

## Status & amendments
Status: Approved autonomously under authoritative LOOP.md. Combined logic and technical specification; implementation and authored acceptance precede end-phase execution.

**Amendments:** 2026-10-28 — initial completion scope. Preserve m2-editor-complete-remaining-flows D20 ownership: this item implements rich details/document links/permissions, Git integration and sidebar boundaries; m2-editor-build-unbuilt-flows owns other missing Explorer/notebook/CSV/media interactions. Neither source presence nor authored tests is a passing GUI result.

2026-10-28 — preserve m2-source-control-core D33: Alt/Option-click opens a right split; Shift-click ranges and Cmd-click toggles selection. Reproducing Orca's unreachable-selection defect is not parity.

2026-10-28 — standalone Git diff preview consumes the editor owner's text-only sanitized renderPreview action; detached local images are omitted with a visible limitation and Source remains available. Existing source-bound editor previews retain their image capability.

## Goal and conceptual model
Complete the remaining named flows in editor.md, source-control.md and sidebar-extras.md using their canonical built-in plugins. Editable disk content and drafts belong to editor; Git owns repository operations and diff notes; hosting supplies fresh validated GitHub facts; terminal owns hosted tab identity and split placement; sidebar extras owns client-local presentation preferences. All UI commands have public API/CLI equivalents.

## Scope and non-goals
In scope: lossless details/toggle headings, document links and completion, permission-aware save and annotation, edit-tab Changes and Markdown diff preview, preview/permanent/split diff tabs, GitHub fork notices and validated target-specific push, sidebar edge coverage. Preserve all existing SC-3–22 behavior and author missing acceptance coverage without running the deferred suite/UI campaign.

Not in scope: replacing CodeMirror, non-GitHub forges, Objective runner, PR sitter, private cross-plugin imports, guessed Finder paths or an unapproved native runtime patch. Existing blocked m4-editor-drop-open-in-place exclusively owns native source identity. Existing m2-editor-build-unbuilt-flows owns its nonoverlapping unbuilt interactions; this item does not claim them delivered.

## Key decisions & rationale
1. Extend existing owners (recommended), rather than replace all document/tab state or create a parity plugin. A second owner duplicates drafts, notes and mutation authority.
2. Preserve lossless source reconciliation and fail-closed rich eligibility. Enable supported details/doc links only with real node parse/serialize/insert behavior; never remove a corruption guard to expose a button.
3. Disk write access is advisory OS-effective capability, separate from format read-only. Editable drafts and local review notes remain usable on readable but non-writable files. The actual save remains authoritative and retains the draft on denial.
4. A PR is evidence of its own head repository/ref, not permission to push a guessed remote. Only a fresh, validated configured GitHub push URL matching that identity may supply a destination. Revalidate immediately before mutation; never add a remote, push a URL supplied by the caller, or silently fall back to origin for a linked PR.
5. Use existing compact UI and canonical command routing. Loading, stale/ambiguous identity and unsupported capabilities remain visible and cannot start destructive actions.

## Behavior and acceptance scenarios

### C1: Lossless rich details and headings
Before: a CRLF Markdown file has frontmatter, paragraphs, empty details, nested details, escaped summary text, code containing closing-tag text and a collapsible heading. Opening rich mode and making no edit preserves original bytes. Editing an unrelated paragraph preserves untouched details and frontmatter. Inserting Toggle Text or Toggle H1–H5 creates an editable real node; its summary and body survive save/reopen and Source/Rich switches. Empty summaries/bodies and nested toggles do not delete content. Malformed or unsupported HTML still falls back to Source without changing the draft. Text inside fenced or inline code is not parsed as a close tag.

### C2: Document links insert, complete and navigate
Before: README.md and docs/Guide.md exist, with two ambiguous same-basename files elsewhere. Typing `[[Gu` at an allowed boundary offers case-insensitive name/path prefix matches, capped at20 with total/truncation information. Arrow keys select, Enter/Tab inserts, Escape dismisses; IME and read-only surfaces do not invoke completion. The public insert action creates `[[docs/Guide]]` or `[[docs/Guide|Read this]]`, with extension removed and no unintended whitespace/label change. No-op serialization preserves bytes. Clicking navigates only through canonical links resolution with exact-path preference and ambiguous basename refusal. Unsafe targets or malformed bracket/newline input fail without mutation.

### C3: Permission-aware drafts, save and notes
Before: a readable Markdown file is not writable under effective OS permissions/ACLs. State/read responses report disk write capability independently of format readOnly; UI explains the disk restriction. Editing preserves a draft, annotations persist in the owning note store, but denied save reports a concrete error and cannot clear dirty state, draft or baseline. If permissions are granted later, retry refreshes capability and saves through the existing content precondition. Never treat a chmod bit test as an ACL authority or promise a TOCTOU-free prediction.

### C4: Changes mode shares the actual buffer
Before: tracked code/Markdown has staged changes plus a newer shared draft. Changes on its edit tab shows HEAD versus current draft without opening another editor tab; staged content must not be mistaken for HEAD. Editing the modified pane updates the canonical draft/revision and uses the normal guarded save. Commit/HEAD change refreshes the original side without discarding the modified draft. Untitled, binary, notebook and unavailable/error surfaces do not advertise unsupported Changes. No uncommitted changes is explicit. Markdown preview shows only the modified side with an explanatory notice; switching back retains draft and tab identity.

Inline Changes preserves source line boundaries. A mid-line edit appears as a complete removed HEAD line and a complete added draft line, not separate rows for unchanged prefixes, changed fragments and unchanged suffixes. Unchanged surrounding lines remain context.

Side by side marks changed lines on both sides, shows line numbers, and applies the same wrapping and font settings to HEAD and Modified. Unchanged lines stay aligned after wrapped or inserted content; HEAD remains read-only while Modified edits the shared draft.

### C5: Diff tab lifetime and placement
Before: Source Control lists multiple changed files. Single click opens a replaceable italic preview tab; another row replaces only a clean preview. Double click or pin makes it permanent. Alt/Option-click creates a right-hand split, with exact worktree/group ownership and existing tab reuse rules; Shift-click range and Cmd-click toggle selection remain reachable under core D33. Staged, branch and commit diffs remain read-only; unstaged modified text may save through its existing guarded Git save. Combined diffs, notes and source preview retain their current boundaries; no private terminal-state edits. Public UI report exposes the selected diff identity, mode and placement.

### C6: GitHub fork notice and validated PR destination
Before: origin is the PR base and a configured fork remote is the PR head. A fresh linked open PR identifies head owner/repository/ref/OID; target selection derives from those facts and finds the matching configured push URL instead of trusting the default remote. The panel names the fork/destination; push and force-with-lease use that exact remote/ref. A trusted saved WorktreePushTarget may disambiguate matching remotes; its remote/ref must still validate against fresh provider identity. Local branch identity must match the actual registered checkout, but a PR head ref may differ from its local branch name. Deleted head repository, missing/ambiguous/multiple push URLs, non-GitHub URL, detached/stale local HEAD, closed/merged/stale PR, head identity change or transport failure yield explicit unavailable state and no push. Bind the private push-URL snapshot through mutation so a changed URL cannot redirect a validated remote name. Caller data cannot choose an arbitrary repository. Existing force confirmation and lease checks remain.

Before creating a PR, prepare/push targets the validated creation head repository/ref, then opens the canonical reviews composer only after confirmed success. Rejection or cancellation leaves the composer unopened and all local work intact. A linked review with unavailable head destination never degrades into Publish Branch.

### C7: Sidebar all-17 edge contract
1. Cross-repo grouping changes presentation only; Git/session ownership stays repo-scoped.
2. Folder rows and folder-kind repo members cannot receive worktree membership.
3. Async group creation uses instance/prior-membership CAS.
4. Missing or host-filter-hidden groups fall back to their repo.
5. Parent/child regroup preserves lineage and empty repo placeholders.
6. Group subtree deletion ungroups without deleting retained metadata/ledger records.
7. Cyclic/corrupt group ancestry remains reachable through canonical repair.
8. Quiet time-window cutoff advances without unrelated events.
9. Activity is max(activity,visit,exit), then creation/repo fallback.
10. Active workspace stays visible; departure stamps do not corrupt visit ordering.
11. Live-only exempts active/default per preference; only fresh canonical agent/session evidence counts as live, not stale rows.
12. Custom days accepts positive safe integers on Enter/blur; invalid/corrupt stored preferences recover conservatively.
13. Paired/client-local filter writes never overwrite another client's choices; legacy sleeping translation never widens a time window.
14. Unknown/empty/stale review cache remains visible; review-only hidden rows do not inflate activity-hidden counts.
15. Recovery clears activity only, Clear filters clears activity/review together; badge count is coherent.
16. Dirty dot uses only active-worktree status, excludes submodule children and treats capped count as a floor.
17. Separators persist across restart, change no row height, and exclude first/host-adjacent/sticky/nested/collapsed-Pinned boundaries.

### C8: Preserve editor SC-3–22 end-phase acceptance
Existing owned APIs plus authored coverage must retain the following consumer contracts. These are execution goals for the end phase, not an assertion that this iteration used the GUI:
- SC-3–6: mixed close-all save failures preserve unsaved tabs; Compare/Keep/Reload/Overwrite retain CAS; autosave holds survive unmount/restart; deleted dirty file recreates only on explicit save; inactive atomic replacements reconcile.
- SC-7–11: Explorer keyboard/range selection, ignored/symlink escape policy, create/rename/move/duplicate/delete+undo/redo and stale ownership, path copy, web import/collision and terminal path drag; Quick Open recency/line targeting; regex/include/exclude/truncation search.
- SC-13–15: slash and IME suppression, table keys, math/Mermaid/emoji/images, document completion, TOC/frontmatter/templates/PDF and exact confirmed note send settlement.
- SC-17–18: local trusted notebook environment discovery, consented install/venv, PEP668/ensurepip guidance, output sanitization and dead-kernel/restart behavior. Installation never changes user/system Python.
- SC-19–22: CSV ranges/rows/columns/clipboard/paging, PDF search/page-width, default-app/media seek, rebound shortcuts/copy-context and resource lifecycle across splits/remount.
Native file pickers, print/save sheets, clipboard, default-app/Finder and OS focus remain pending native-runner scenarios; existing findings and reports are not erased.

## Decisions locked
- Follow roadmap/architecture and all predecessor ownership/safety decisions, particularly sweep D3/D5/D8/D14 and editor completion D7/D20.
- Preserve public API boundaries, content CAS, note holds and exact snapshot settlement. Never bypass hooks, permission failures, confirmation or uncertainty.
- Autonomous standard gray areas: existing layout/density; explicit loading/empty/errors; atomic draft-preserving failures; exact identity/group ownership; persistence in canonical stores; generated CLI contracts. No research swarm or new visual design.
- Before the end phase: author tests/native scenarios, run typecheck, no suites/dogfood/review campaigns. Record exercised smoke separately from unexecuted acceptance.

## Industry insights
No external research swarm under LOOP build-first rules. Evidence is the three read-only feature docs, locked predecessor decisions, existing canonical API owners and recorded failures in BLOCKERS.md.

## Deferred ideas
No unrelated functionality. Existing Finder capability block and nonoverlapping m2-editor-build-unbuilt-flows remain with their registered owners. End-phase testing is not a new follow-up item.

## Glossary
Preview tab: replaceable hosted tab until promoted. Changes: same editable buffer against HEAD. Validated push target: configured remote and branch whose push repository matches fresh authenticated provider head metadata. Disk writable: advisory effective OS access, not a guaranteed successful save. Fresh liveness: canonical non-stale current session/agent evidence.

## Technical decisions and contracts
- Parent commits shared schemas/API signatures before at most three independent components: editor rich/permission/Changes; Git+hosting targets/diff placement; sidebar edges. Scope boundaries and existing methods are recorded at dispatch. No worker commits or checks mid-flight; parent audits scopes and integrates after every worker returns.
- Markdown uses existing `quirky.editor/markdown` action insert/format with `details`, `collapsibleHeading`, `documentLink` format additions. Existing expectedRevision/selection/target/text contracts remain; no retarget alias.
- Disk write capability is optional additive buffer metadata (`diskWritable`, concrete permission error if needed), never overload readOnly. Save checks actual write failures and retains draft; notes do not write the source file.
- Changes and diff preview use public Git diff calls and existing editor buffer/terminal hosted APIs. No direct cross-plugin imports; public schema changes and their consumers move together.
- Detached preview uses public `quirky.editor/markdown {action:'renderPreview',text}` returning `{html}` with the existing preview size/line/block bounds. It does not open or mutate buffers, authorize a filesystem path, create local-image resources or accept contextual buffer/worktree/path parameters. Existing source-bound preview behavior is unchanged.
- GitHub push-target selection must return explicit ready/unavailable state, exact repository identity, remote/ref and fresh branch/head evidence. Git revalidates the destination immediately before `push`; configured remotes only, no URL mutation or arbitrary caller-provided target. Existing configured ordinary pushes remain valid when no linked review applies.
- Tests use existing fixtures, fresh HOME/QUIRKY_HOME, hooks predisabled, and owned teardown for every launched process. Author actual API/window behavior regressions, not manifests/source-text/mock forwarding assertions. Exact gate is `bun run typecheck`; canonical absolute queue controller owns landing.
