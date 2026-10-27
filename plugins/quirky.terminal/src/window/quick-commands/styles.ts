const STYLE_ATTRIBUTE = 'quirky.terminal-qc'

const CSS = `
.qc-panel { display: flex; flex-direction: column; height: 100%; min-height: 0; font-size: 12px; color: var(--text, #d7dae0); }
.qc-header { display: flex; align-items: center; gap: 6px; padding: 8px 10px; border-bottom: 1px solid var(--border, #2b2f3a); }
.qc-header input[type="search"] { flex: 1; min-width: 0; }
.qc-input, .qc-select, .qc-textarea { background: var(--bg, #16181d); border: 1px solid var(--border, #2b2f3a); border-radius: 5px; padding: 4px 8px; color: inherit; font: inherit; }
.qc-input:focus, .qc-select:focus, .qc-textarea:focus { outline: 1px solid var(--accent, #4f8ff7); outline-offset: -1px; }
.qc-list { list-style: none; margin: 0; padding: 4px 0; overflow-y: auto; flex: 1; min-height: 0; }
.qc-row { display: flex; align-items: center; gap: 8px; padding: 6px 10px; }
.qc-row:hover { background: var(--bg-hover, #262a33); }
.qc-row-main { flex: 1; min-width: 0; }
.qc-row-title { display: flex; align-items: center; gap: 6px; min-width: 0; }
.qc-label { font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.qc-badge, .qc-hint { flex-shrink: 0; padding: 0 6px; border-radius: 9px; font-size: 10px; line-height: 16px; border: 1px solid var(--border, #2b2f3a); color: var(--muted, #8a909e); }
.qc-body { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; color: var(--muted, #8a909e); }
.qc-empty { margin: 0; padding: 16px 12px; color: var(--muted, #8a909e); line-height: 1.5; }
.qc-icon-button { display: inline-flex; align-items: center; justify-content: center; padding: 3px; border: none; border-radius: 4px; background: transparent; color: var(--muted, #8a909e); }
.qc-icon-button:hover:not(:disabled) { background: var(--bg-active, #2d3240); color: var(--text, #d7dae0); }
.qc-icon-button.qc-danger:hover:not(:disabled) { color: var(--danger, #e5534b); }
.qc-actions { display: flex; align-items: center; gap: 2px; flex-shrink: 0; }

.qc-strip { display: inline-flex; align-items: center; align-self: center; flex-shrink: 0; margin: 0 4px; font-size: 12px; }
.qc-split { display: flex; align-items: stretch; height: 28px; overflow: hidden; border: 1px solid var(--border, #2b2f3a); border-radius: 6px; }
.qc-split button, .qc-single { display: inline-flex; align-items: center; gap: 6px; height: 100%; padding: 0 6px; border: none; border-radius: 0; background: transparent; color: var(--muted, #8a909e); }
.qc-split button:hover:not(:disabled), .qc-single:hover:not(:disabled) { background: var(--bg-hover, #262a33); color: var(--text, #d7dae0); }
.qc-split .qc-more { padding: 0 4px; border-left: 1px solid var(--border, #2b2f3a); }
.qc-run-label { max-width: 160px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500; }
.qc-single { height: 28px; border-radius: 6px; }

.qc-menu { position: fixed; z-index: 1000; width: 320px; max-width: calc(100vw - 16px); display: flex; flex-direction: column; border: 1px solid var(--border, #2b2f3a); border-radius: 8px; background: var(--bg-raised, #1d2027); color: var(--text, #d7dae0); box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45); font-size: 12px; }
.qc-menu-search { border: none; border-bottom: 1px solid var(--border, #2b2f3a); border-radius: 8px 8px 0 0; padding: 8px 10px; background: transparent; color: inherit; font: inherit; outline: none; }
.qc-menu-list { max-height: 288px; overflow-y: auto; padding: 4px 0; }
.qc-menu-item { display: flex; align-items: center; gap: 8px; margin: 2px 4px; padding: 6px 8px; border-radius: 7px; cursor: pointer; }
.qc-menu-item[aria-selected="true"], .qc-menu-item:hover { background: var(--bg-active, #2d3240); }
.qc-menu-item .qc-actions { opacity: 0; }
.qc-menu-item:hover .qc-actions, .qc-menu-item[aria-selected="true"] .qc-actions, .qc-menu-item:focus-within .qc-actions { opacity: 1; }
.qc-menu-separator { height: 1px; margin: 4px 0; background: var(--border, #2b2f3a); }
.qc-menu-empty { padding: 14px 8px; text-align: center; font-size: 11px; color: var(--muted, #8a909e); }
.qc-menu-footer { padding: 4px; border-top: 1px solid var(--border, #2b2f3a); }
.qc-menu-footer button { display: flex; width: 100%; align-items: center; gap: 8px; border: none; background: transparent; padding: 6px 8px; text-align: left; color: var(--muted, #8a909e); }
.qc-menu-footer button:hover { background: var(--bg-hover, #262a33); color: var(--text, #d7dae0); }

.qc-backdrop { position: fixed; inset: 0; z-index: 1100; display: flex; align-items: center; justify-content: center; background: rgba(0, 0, 0, 0.5); }
.qc-dialog { display: flex; flex-direction: column; width: min(640px, calc(100vw - 32px)); max-height: min(90vh, 640px); border: 1px solid var(--border, #2b2f3a); border-radius: 10px; background: var(--bg-raised, #1d2027); color: var(--text, #d7dae0); box-shadow: 0 16px 48px rgba(0, 0, 0, 0.55); font-size: 12px; }
.qc-dialog-head { padding: 16px 20px 0; }
.qc-dialog-head h2 { margin: 0; font-size: 14px; font-weight: 600; }
.qc-dialog-head p { margin: 4px 0 0; color: var(--muted, #8a909e); }
.qc-dialog-body { display: flex; flex-direction: column; gap: 14px; min-height: 0; margin: 0; padding: 16px 20px; border: none; overflow-y: auto; }
.qc-field { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.qc-field > span, .qc-field > legend { font-weight: 500; }
.qc-row-fields { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 12px; align-items: end; }
.qc-choice { display: inline-flex; align-items: center; gap: 6px; margin-right: 12px; font-weight: 400; }
.qc-textarea { min-height: 96px; resize: vertical; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; line-height: 1.45; }
.qc-switch { display: inline-flex; align-items: center; gap: 8px; align-self: flex-start; padding: 0; border: none; background: transparent; color: inherit; }
.qc-switch-track { position: relative; width: 28px; height: 16px; border-radius: 8px; background: var(--dim, #4a505c); transition: background 0.12s; }
.qc-switch-track::after { content: ''; position: absolute; top: 2px; left: 2px; width: 12px; height: 12px; border-radius: 50%; background: #fff; transition: transform 0.12s; }
.qc-switch[aria-checked="true"] .qc-switch-track { background: var(--accent, #4f8ff7); }
.qc-switch[aria-checked="true"] .qc-switch-track::after { transform: translateX(12px); }
.qc-advanced-toggle { align-self: flex-start; display: inline-flex; align-items: center; gap: 4px; padding: 0; border: none; background: transparent; color: var(--muted, #8a909e); font-weight: 500; }
.qc-note { color: var(--muted, #8a909e); font-size: 11px; }
.qc-error { padding: 6px 10px; border: 1px solid var(--danger, #e5534b); border-radius: 5px; color: var(--danger, #e5534b); }
.qc-dialog-foot { display: flex; justify-content: flex-end; gap: 8px; padding: 12px 20px 16px; border-top: 1px solid var(--border, #2b2f3a); }
`

/** Adds the quick-command styles to the document once; a second call does nothing. */
export function ensureQuickCommandStyles(): void {
  if (typeof document === 'undefined') return
  if (document.head.querySelector(`style[data-plugin="${STYLE_ATTRIBUTE}"]`)) return
  const style = document.createElement('style')
  style.setAttribute('data-plugin', STYLE_ATTRIBUTE)
  style.textContent = CSS
  document.head.appendChild(style)
}
