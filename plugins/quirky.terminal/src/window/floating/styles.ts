const CSS = `
.qf-button { position: fixed; z-index: 2; display: flex; align-items: center; justify-content: center; width: 36px; height: 36px; padding: 0; border: 1px solid var(--border); border-radius: 8px; background: var(--bg-raised); color: var(--text); box-shadow: 0 4px 12px rgba(0, 0, 0, 0.35); cursor: grab; pointer-events: auto; user-select: none; }
.qf-button:hover { background: var(--bg-hover); }
.qf-button[aria-pressed="true"] { background: var(--bg-active); }
.qf-button.qf-dragging { cursor: grabbing; }
.qf-panel { position: fixed; z-index: 1; display: flex; flex-direction: column; border: 1px solid var(--border); border-radius: 8px; background: var(--bg); box-shadow: 0 12px 40px rgba(0, 0, 0, 0.6); outline: none; overflow: hidden; pointer-events: auto; }
.qf-titlebar { flex: none; display: flex; align-items: center; justify-content: space-between; height: 28px; padding: 0 6px 0 10px; border-bottom: 1px solid var(--border); background: var(--bg-raised); font-size: 12px; cursor: grab; user-select: none; }
.qf-panel.qf-maximized .qf-titlebar { cursor: default; }
.qf-controls { display: flex; gap: 2px; }
.qf-control { display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px; padding: 0; border: none; border-radius: 4px; background: transparent; color: inherit; cursor: pointer; }
.qf-control:hover { background: var(--bg-active); }
.qf-body { position: relative; flex: 1; min-height: 0; min-width: 0; display: flex; }
.qf-edge { position: absolute; z-index: 5; }
.qf-edge-n { top: 0; left: 8px; right: 8px; height: 5px; cursor: ns-resize; }
.qf-edge-s { bottom: 0; left: 8px; right: 8px; height: 5px; cursor: ns-resize; }
.qf-edge-e { right: 0; top: 8px; bottom: 8px; width: 5px; cursor: ew-resize; }
.qf-edge-w { left: 0; top: 8px; bottom: 8px; width: 5px; cursor: ew-resize; }
.qf-edge-ne { top: 0; right: 0; width: 8px; height: 8px; cursor: nesw-resize; }
.qf-edge-nw { top: 0; left: 0; width: 8px; height: 8px; cursor: nwse-resize; }
.qf-edge-se { bottom: 0; right: 0; width: 8px; height: 8px; cursor: nwse-resize; }
.qf-edge-sw { bottom: 0; left: 0; width: 8px; height: 8px; cursor: nesw-resize; }
`

/** Adds the floating overlay's stylesheet to the document once; every later call finds it and does nothing. */
export function injectFloatingStyles(doc: Document = document): void {
  if (doc.head.querySelector('style[data-plugin="quirky.terminal"][data-part="floating"]')) return
  const style = doc.createElement('style')
  style.setAttribute('data-plugin', 'quirky.terminal')
  style.setAttribute('data-part', 'floating')
  style.textContent = CSS
  doc.head.appendChild(style)
}
