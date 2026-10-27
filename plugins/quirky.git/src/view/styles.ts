/** The diff view's chrome, using only the shell's theme variables. */
export const VIEW_CSS = `
.qgv-root { display: flex; flex-direction: column; flex: 1; min-height: 0; min-width: 0; color: var(--text); background: var(--bg); }
.qgv-root button { font: inherit; }
.qgv-file, .qgv-combined, .qgv-review { display: flex; flex-direction: column; flex: 1; min-height: 0; }
.qgv-bar, .qgv-toolbar { display: flex; align-items: center; gap: 6px; padding: 6px 10px; border-bottom: 1px solid var(--border); background: var(--bg-raised); flex-wrap: wrap; }
.qgv-title { display: inline-flex; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
.qgv-sub, .qgv-muted, .qgv-count { color: var(--muted); font-weight: 400; }
.qgv-chip { padding: 0 6px; border: 1px solid var(--border); border-radius: 8px; color: var(--muted); font-size: 11px; }
.qgv-spacer { flex: 1; }
.qgv-menu-anchor { position: relative; display: inline-flex; }
.qgv-menu { position: absolute; right: 0; top: 100%; z-index: 20; display: flex; flex-direction: column; min-width: 180px; padding: 4px; background: var(--bg-raised); border: 1px solid var(--border); border-radius: 6px; }
.qgv-menu button { display: flex; align-items: center; gap: 6px; text-align: left; background: transparent; border: none; padding: 4px 8px; color: var(--text); }
.qgv-menu button:hover { background: var(--bg-hover); }
.qgv-check { display: inline-block; width: 1.2em; color: var(--accent); }
.qgv-body, .qgv-scroll { flex: 1; min-height: 0; overflow: auto; }
.qgv-split { display: flex; flex: 1; min-height: 0; }
.qgv-tree { flex: none; width: 220px; overflow: auto; border-right: 1px solid var(--border); padding: 6px; display: flex; flex-direction: column; gap: 2px; }
.qgv-tree h3 { margin: 0 0 4px; font-size: 11px; text-transform: uppercase; color: var(--muted); }
.qgv-tree-item { text-align: left; background: transparent; border: none; color: var(--text); padding: 2px 6px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.qgv-tree-item:hover { background: var(--bg-hover); }
.qgv-pad { padding: 8px 12px; }
.qgv-pane, .qgv-host { min-width: 0; }
.qgv-host .cm-mergeView { overflow: visible; }
.qgv-section { border-bottom: 1px solid var(--border); }
.qgv-section-head { display: flex; align-items: center; gap: 8px; padding: 4px 10px; background: var(--bg-raised); position: sticky; top: 0; z-index: 5; }
.qgv-chevron { background: transparent; border: none; color: var(--muted); padding: 0 4px; }
.qgv-path { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.qgv-counts { font-family: ui-monospace, Menlo, monospace; font-size: 11px; }
.qgv-add { color: var(--green); }
.qgv-del { color: var(--danger); }
.qgv-dirty { color: var(--amber); font-weight: 600; }
.qgv-notice { margin: 8px 12px; padding: 8px 12px; border: 1px solid var(--border); border-radius: 6px; background: var(--bg-raised); display: flex; flex-direction: column; gap: 6px; align-items: flex-start; }
.qgv-notice p, .qgv-notice dl { margin: 0; }
.qgv-notice dl { display: grid; grid-template-columns: max-content auto; gap: 2px 12px; }
.qgv-notice dt { color: var(--muted); }
.qgv-notice dd { margin: 0; font-family: ui-monospace, Menlo, monospace; }
.qgv-error { margin: 8px 12px; padding: 6px 10px; color: var(--danger); border: 1px solid var(--danger); border-radius: 6px; }
.qgv-stale { display: flex; align-items: center; gap: 8px; padding: 6px 10px; background: var(--bg-raised); color: var(--amber); border-bottom: 1px solid var(--amber); }
.qgv-stale span { flex: 1; }
.qgv-banner { display: flex; gap: 12px; align-items: center; padding: 6px 10px; border-bottom: 1px solid var(--border); background: var(--bg-raised); flex-wrap: wrap; }
.qgv-counter { font-family: ui-monospace, Menlo, monospace; color: var(--muted); }
.qgv-images { display: flex; gap: 12px; padding: 12px; }
.qgv-image-side { flex: 1; margin: 0; min-width: 0; display: flex; flex-direction: column; gap: 6px; align-items: flex-start; }
.qgv-image-side img { max-width: 100%; border: 1px solid var(--border); }
.qgv-overflow { display: flex; flex-direction: column; align-items: flex-start; gap: 6px; padding-bottom: 12px; }
.qgv-overflow p { margin: 0 12px; }
.qgv-overflow button { margin: 0 12px; }
.qgv-review-row { display: flex; align-items: center; gap: 8px; padding: 2px 6px; }
.qgv-badge { padding: 0 6px; border-radius: 8px; font-size: 11px; border: 1px solid var(--border); }
.qgv-badge-unresolved { color: var(--amber); }
.qgv-badge-resolved { color: var(--green); }
.qgv-badge-gone { color: var(--grey); }
`
