# Graphite editor surfaces

Status: Autonomously approved 2026-10-28 under LOOP.md; implements the editor row of the approved [redesign](../2026-10-28-ui-redesign/logic.md). One combined logic/technical specification under build-first.

## Purpose and conceptual model

Restyle every quirky.editor-owned desktop surface with the public shared UI components and semantic graphite tokens. The host remains the owner of center tabs and the Files tool (right-top by default, sidebar alias preserved). Editor state, content, commands, RPC contracts, keybindings, save guards and document engines remain authoritative and unchanged.

Plugin React surfaces compose shared buttons, icon buttons, fields, lists, tabs, dialogs, badges, form rows, empty states and tool frames as appropriate. Specialized source/rich/notebook/media content is not replaced by generic controls: its rendering stays functional, but its geometry and theme integration live in centrally owned, linted shared styles. No plugin-private stylesheet injection remains.

## Key decisions and rationale

- Adopt the approved graphite palette, type/spacing/radius scale and comfortable rows in both appearances. Remove legacy color fallbacks, bespoke control styling and injected plugin CSS. Shared layout rules may support editor engines and tree geometry, but cannot serve as an unmodified legacy-style escape hatch.
- Preserve behavior and public identifiers. Default placement is already implemented by the canonical host projection and is intentionally unchanged; do not duplicate a Files frame title if the slot already provides one.
- Prefer existing shared components over new abstractions. A native semantic input needed for specialized editing (cell textarea, contenteditable, range, checkbox) may use shared tokenized form/engine styling. Keep focus, keyboard routing, disabled/busy states, selected state, destructive confirmation and accessible names.
- Preserve user-controlled font size/family, runtime measured geometry, minimap canvas data, rich document attributes and generated document content. They are feature values, not permission to hide literals from the linter. Canvas theme colors come from computed semantic tokens and redraw on appearance changes.
- Alternative CSS-only migration retains divergent controls; rejected. Alternative replace editing engines changes feature behavior; rejected. Chosen approach migrates chrome and centralizes necessary engine styling without changing state authority.

## Behavior and acceptance scenarios

SC1 Files: opening Files shows the actual worktree tree in the existing right-top tool. Search names/contents, selected/expanded/ignored rows, create/rename/cancel, row/path/terminal actions, drag/import, undo/redo, preferences, refresh, empty/loading/error states retain behavior. Example: expand src, select app.ts, open it; the actual document opens without moving Files or changing worktree.

Files row-action menus use the shared portaled popup so the scrolling tree and footer cannot clip them. The popup stays within the viewport, opens above the row when needed, and preserves Escape dismissal and inline Rename focus.

SC2 Source: opening app.ts renders real CodeMirror content in the center view with themed gutter, selection, minimap and accessible document actions. Edit/save, selection context, find/replace, rename, wrap and zoom still use existing state/commands. Example: change text and save; the acknowledged draft and file bytes change through the existing save path, not component-local persistence.

SC3 Documents: Markdown rich/source/preview formatting, search, links, front matter, templates, table of contents, review notes, detached preview and export remain usable. Both themes have readable content, toolbar, selected mode and errors. Example: switch rich to source to preview; content is preserved. Exported PDF HTML is not app chrome; preserve its self-contained printable rendering without local plugin CSS construction.

SC4 Notebook and viewers: notebook cells/trust/kernel/output/error controls, CSV table/edit/search/selection/paging and image/PDF/audio/video/SVG viewers retain behavior and use shared chrome. Example: a CSV edit remains an existing guarded draft; a read-only paged preview cannot become editable. Preserve sanitized output and rendering isolation.

SC5 Overlays: Quick Open, Markdown new/open, unsaved-close, Save As and external-change comparison use shared dialogs and controls; keyboard navigation, focus, busy states, cancellation, error retry and save/discard choices still work. Example: cancel closing a dirty document leaves its draft intact; saving acknowledges the existing daemon write before closing.

SC6 Themes and enforcement: switching dark/light uses the canonical theme tokens throughout Files, source, Markdown, notebooks, viewers and overlays. No plugin-owned CSS file/style injection, raw style color or raw pixel literal survives opt-in. `scripts/ui-lint-plugins.json` includes quirky.editor; `bun run ui:lint` and full `bun run typecheck` exit zero. No lint suppressions, scanner exceptions, copied legacy palettes or baseline exemptions.

SC7 Shell integration: editor contributions remain in host-owned tools/views/overlays/settings. Existing commands and shortcuts are unchanged; no plugin chrome is added to the title/status/stripe regions. A failed document stays local to its surface and exposes its existing retry/error path.

## Scope and non-goals

All quirky.editor presentation source is in scope, including generated print styles where enforcement reaches them; existing daemon editing services are not redesigned. No phone restyle, new editor capability, public RPC change, new shortcut, feature removal, global host redesign, native-window change or golden-image modification. Build-first defers suites, automated screenshot scoring, review rounds and full dogfood to the existing end phase; no new verification-only follow-up is added. Minimum changed-surface runtime/visual smoke and typecheck still run under the coding contract, without claiming golden approval.

## Defect coverage

Retain existing behavioral tests for draft/save/close revisions, focus and window isolation, search/navigation, path operations, Markdown, notebook and viewers. Add or update only substantive interaction regressions when shared control semantics change (focus/keyboard, cancellation, disabled edit guards). Delete incidental source/style/wiring assertions rather than repinning them. Write tests but do not execute suites in build-first.

## Decisions Locked

Approved parent controls exact palette, comfortable density, host regions, shared components/tokens and default tool placement. Existing editor services control content and lifecycle. LOOP.md controls unattended autonomous decisions, contracts-first, no review/suites and typecheck-only landing.

## Industry Insights

Reuse the approved redesign's documented Linear, Zed, VS Code and design-system findings. No research swarm under build-first.

## Deferred Ideas

None. Screenshot review is existing end-phase work, not an unbuilt product flow. No new product successor is planned.

## Glossary

Chrome: controls surrounding document content. Engine styling: shared semantic presentation of CodeMirror, ProseMirror, notebook/output, media and table content. Files: existing editor Explorer contribution projected into the host right-top tool.

## Technical decisions and contracts

Public components/types stay at `@quirky/ui`; existing contracts are reused unchanged. No new cross-task API signatures are required. Commit this file and the decision log as the shared implementation contract before dispatch. New shared styles are three disjoint files under packages/ui/src/design-system: editor-window.css, editor-markdown.css and editor-viewers.css. Parent imports all three from styles.css, owns UI lint opt-in, editor package dependency, bun.lock and docs. Each stylesheet uses only canonical tokens, valid runtime measurements and relative/fractional values; add no compatibility tokens merely to preserve old arbitrary measurements. Shared helpers needed by an implementer must have an explicit package subpath and ownership amendment before another task consumes them.

One wave, three independent components (OpenAI omp tasks, no reviews dispatched):
1. Window owner: plugins/quirky.editor/src/ui.tsx and src/window/{DocumentSurface,SourceEditor,ChangesSurface,ExplorerPanel,QuickOpenOverlay,CloseOverlay}.tsx; packages/ui/src/design-system/editor-window.css; corresponding editor window interaction tests. Remove editorStyles/installStyles entirely; convert chrome to shared components and move necessary engine/layout rules to owned shared stylesheet.
2. Markdown owner: plugins/quirky.editor/src/markdown/** presentation/export only, packages/ui/src/design-system/editor-markdown.css; Markdown interaction tests. Preserve rich engine/parser/service behavior and sanitized content. Own any new pure shared print-style subpath implementation but request parent export/package integration.
3. Notebook/viewer owner: plugins/quirky.editor/src/notebook/NotebookSurface.tsx, src/viewers/ViewerSurface.tsx, packages/ui/src/design-system/editor-viewers.css; corresponding notebook/viewer UI interaction tests. Preserve rich outputs and data values; theme palette helpers are presentation only, no output authority change.

Tasks run in separate external worktrees using absolute paths, no checks/build/lint/formatters/stage/commit midflight. Parent audits exact HEAD and changed paths plus preserved inherited metadata at the barrier, integrates components, removes owned worktrees after preserving unknown files, runs `bun run ui:lint`, `bun run typecheck`, minimal `bun run --filter './packages/ui' build` and isolated actual renderer smoke in both themes. Catch up once with `git merge build/roadmap`, read incoming binding decisions and rerun full typecheck before canonical queue land.

## Self-review and amendments


Shared print contract amendment: `@quirky/ui/editor-print` exports pure `createEditorPrintHtml({ title, body, katexCss, theme }: { title: string; body: string; katexCss: string; theme: 'dark' | 'light' }): string`. It HTML-escapes title, embeds existing caller-provided sanitized body/bundled KaTeX CSS and canonical token-derived theme styles in standalone CSP-compatible HTML. Palette comes from canonical tokens.css through a static bundled text import, never copied literals or runtime bundle-relative file reads. Existing printable light default is preserved. Markdown owner owns editor-print.ts; parent owns package export/asset declaration integration. No public editor RPC changes.
2026-10-28: self-reviewed against all editor contribution categories and approved rollout. SC1–SC7 explicitly preserve behavior while covering presentation/lint/default placement. All observable gray areas resolved from approved spec and current feature semantics; no human questions or separate tech.md/spec review under build-first. Golden review not performed and not claimed.
