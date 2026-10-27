const CSS = `
.qt-workspace { position: relative; flex: 1; min-width: 0; min-height: 0; display: flex; background: var(--bg); color: var(--text); }
.qt-muted { color: var(--muted); }
.qt-pad { padding: 12px; }
.qt-groups { position: relative; flex: 1; min-width: 0; min-height: 0; overflow: hidden; }
.qt-group-slot { position: absolute; display: flex; min-width: 0; min-height: 0; overflow: hidden; }
.qt-group-divider { position: absolute; background: var(--border); z-index: 6; }
.qt-group-divider:hover { background: var(--accent); }
.qt-group-divider-right { cursor: col-resize; }
.qt-group-divider-down { cursor: row-resize; }
.qt-group { flex: 1; display: flex; flex-direction: column; min-width: 0; min-height: 0; }
.qt-strip { display: flex; align-items: stretch; flex: none; background: var(--bg-raised); border-bottom: 1px solid var(--border); }
.qt-strip.qt-drop-end { box-shadow: inset -2px 0 0 var(--accent); }
.qt-tabs { display: flex; min-width: 0; overflow-x: auto; flex: 0 1 auto; }
.qt-tab { position: relative; display: flex; align-items: center; gap: 6px; max-width: 220px; padding: 5px 6px 5px 10px; border-right: 1px solid var(--border); color: var(--muted); white-space: nowrap; cursor: pointer; user-select: none; }
.qt-tab:hover { background: var(--bg-hover); }
.qt-tab.qt-selected { background: var(--bg); color: var(--text); }
.qt-tab.qt-focused { box-shadow: inset 0 -2px 0 var(--accent); }
.qt-tab.qt-drop-before { box-shadow: inset 2px 0 0 var(--accent); }
.qt-tab.qt-drop-target { background: var(--bg-active); outline: 1px dashed var(--accent); }
.qt-tab-title { overflow: hidden; text-overflow: ellipsis; }
.qt-dot { display: inline-block; flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--grey); }
.qt-dot-waiting { background: var(--amber); }
.qt-dot-working { background: var(--accent); }
.qt-dot-done { background: var(--green); }
.qt-dot-exited { background: var(--dim); }
.qt-color { flex: none; width: 8px; height: 8px; border-radius: 50%; }
.qt-pin { display: inline-flex; flex: none; width: 18px; height: 18px; align-items: center; justify-content: center; }
.qt-icon { display: inline-flex; align-items: center; justify-content: center; min-width: 18px; height: 18px; padding: 0 3px; border: none; border-radius: 4px; background: transparent; color: inherit; cursor: pointer; }
.qt-icon:hover:not(:disabled) { background: var(--bg-active); }
.qt-icon:disabled { opacity: 0.35; cursor: default; }
.qt-plus, .qt-actions { align-self: center; margin: 0 2px; min-width: 24px; height: 24px; font-size: 15px; }
.qt-rename, .qt-title-field { min-width: 80px; max-width: 160px; padding: 0 4px; border: 1px solid var(--accent); border-radius: 3px; background: var(--bg); color: var(--text); font: inherit; outline: none; }
.qt-body { position: relative; flex: 1; min-height: 0; display: flex; flex-direction: column; }
.qt-panes { position: relative; flex: 1; min-height: 0; overflow: hidden; }
.qt-pane { position: absolute; overflow: hidden; }
.qt-divider { position: absolute; z-index: 5; background: var(--border); }
.qt-divider:hover { background: var(--accent); }
.qt-divider-right { cursor: col-resize; }
.qt-divider-down { cursor: row-resize; }
.qt-pane-header { position: absolute; top: 4px; right: 8px; z-index: 12; display: flex; align-items: center; gap: 2px; padding: 2px 4px; border: 1px solid var(--border); border-radius: 6px; background: var(--bg-raised); font-size: 12px; }
.qt-pane-accessories { position: absolute; top: 4px; left: 8px; z-index: 11; display: flex; align-items: center; gap: 4px; max-width: calc(100% - 16px); }
.qt-pane-accessory { display: flex; align-items: center; min-width: 0; }
.qt-pane-title { max-width: 200px; padding: 0 4px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.qt-grip { cursor: grab; }
.qt-exit { position: absolute; inset: 0; z-index: 14; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; padding: 16px; background: rgba(0, 0, 0, 0.6); text-align: center; }
.qt-exit-actions { display: flex; gap: 8px; }
.qt-drop-preview, .qt-zone { position: absolute; z-index: 13; border: 2px solid var(--accent); background: rgba(79, 143, 247, 0.18); pointer-events: none; }
.qt-zone { z-index: 20; }
.qt-structured { position: absolute; inset: 0; display: flex; flex-direction: column; }
.qt-structured-body { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.qt-empty { margin: auto; display: flex; flex-direction: column; gap: 6px; min-width: 220px; }
.qt-empty button { display: flex; justify-content: space-between; gap: 24px; }
.qt-menu-anchor { position: fixed; z-index: 60; }
.qt-menu { position: relative; min-width: 190px; padding: 4px; border: 1px solid var(--border); border-radius: 6px; background: var(--bg-raised); box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5); outline: none; }
.qt-menu-row { position: relative; }
.qt-menu-item { display: flex; align-items: center; gap: 8px; width: 100%; padding: 4px 8px; border: none; border-radius: 4px; background: transparent; color: var(--text); text-align: left; cursor: pointer; }
.qt-menu-item:hover:not(:disabled), .qt-menu-item.qt-highlight { background: var(--bg-hover); }
.qt-menu-item:disabled { opacity: 0.4; cursor: default; }
.qt-menu-item.qt-danger { color: var(--danger); }
.qt-menu-label { flex: 1; }
.qt-menu-key, .qt-menu-arrow { color: var(--muted); font-size: 11px; }
.qt-menu-separator { height: 1px; margin: 4px 0; background: var(--border); }
.qt-menu-search { width: 100%; margin-bottom: 4px; padding: 4px 8px; border: 1px solid var(--border); border-radius: 4px; background: var(--bg); color: var(--text); outline: none; }
.qt-submenu { position: absolute; top: -5px; left: 100%; z-index: 61; }
.qt-swatch { display: inline-block; width: 10px; height: 10px; border-radius: 50%; }
.qt-overlay { position: fixed; inset: 0; z-index: 70; display: flex; align-items: center; justify-content: center; background: rgba(0, 0, 0, 0.5); }
.qt-dialog { width: min(420px, calc(100vw - 32px)); padding: 14px 16px; border: 1px solid var(--border); border-radius: 8px; background: var(--bg-raised); box-shadow: 0 12px 40px rgba(0, 0, 0, 0.6); }
.qt-dialog h2 { margin: 0 0 10px; font-size: 14px; }
.qt-dialog-text { margin: 0 0 8px; color: var(--muted); }
.qt-dialog-name { margin: 0 0 8px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
.qt-dialog-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 12px; }
.qt-check { display: flex; align-items: center; gap: 6px; color: var(--muted); }
.qt-form { display: flex; flex-direction: column; gap: 10px; }
.qt-form label { display: flex; flex-direction: column; gap: 4px; color: var(--muted); }
.qt-primary { background: var(--accent); border-color: var(--accent); color: #fff; }
.qt-primary.qt-danger { background: var(--danger); border-color: var(--danger); }
.qt-switcher ul { margin: 0; padding: 0; list-style: none; }
.qt-switcher li { padding: 4px 8px; border-radius: 4px; cursor: pointer; }
.qt-switcher li.qt-highlight { background: var(--bg-active); }
`

/** Adds the workspace's stylesheet to the document once; every later call finds it and does nothing. */
export function injectWorkspaceStyles(doc: Document = document): void {
  if (doc.head.querySelector('style[data-plugin="quirky.terminal"][data-part="workspace"]')) return
  const style = doc.createElement('style')
  style.setAttribute('data-plugin', 'quirky.terminal')
  style.setAttribute('data-part', 'workspace')
  style.textContent = CSS
  doc.head.appendChild(style)
}
