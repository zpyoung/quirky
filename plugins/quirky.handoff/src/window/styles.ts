const STYLE_ID = 'quirky-handoff-styles'

const CSS = `
.overlay.hf-overlay { pointer-events: auto; }
.dialog.hf-dialog { width: min(1080px, calc(100vw - 32px)); }
.hf-columns { display: grid; grid-template-columns: minmax(280px, 380px) minmax(0, 1fr); gap: 14px; align-items: start; }
.hf-left { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.hf-left fieldset { min-width: 0; }
.hf-left label, .hf-left .hf-checks, .hf-left .hf-radios { display: flex; flex-direction: column; gap: 3px; }
.hf-left label:has(> input[type='checkbox']), .hf-left label:has(> input[type='radio']) { flex-direction: row; align-items: center; gap: 6px; }
.hf-left select { width: 100%; }
.hf-source { border: 1px solid var(--border); border-radius: 6px; padding: 6px 10px; margin-bottom: 10px; }
.hf-right { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.hf-right h3 { margin: 0; font-size: 13px; }
.hf-cost { font-size: 11px; min-height: 1.4em; }
.hf-editor { height: 300px; border: 1px solid var(--border); border-radius: 6px; overflow: hidden; }
.hf-secrets-line { color: var(--danger); font-size: 11px; }
.hf-detached { display: flex; align-items: center; justify-content: space-between; gap: 8px; border: 1px solid var(--border); border-radius: 6px; padding: 6px 10px; }
.hf-locked { border: 1px solid var(--border); border-radius: 6px; padding: 6px 10px; background: var(--bg-raised); }
.hf-locked pre { margin: 4px 0 0; max-height: 72px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 11px; color: var(--muted); }
.hf-strips { display: flex; flex-direction: column; gap: 4px; margin-top: 10px; }
.hf-warning { border: 1px solid color-mix(in srgb, var(--amber) 60%, transparent); background: color-mix(in srgb, var(--amber) 12%, transparent); border-radius: 6px; padding: 5px 10px; }
.hf-error { border-color: color-mix(in srgb, var(--danger) 60%, transparent); background: color-mix(in srgb, var(--danger) 14%, transparent); }
.hf-busy { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.hf-busy-actions { display: flex; gap: 6px; flex-shrink: 0; }
.hf-combo { position: relative; display: flex; flex-direction: column; gap: 2px; }
.hf-combo-button { text-align: left; }
.hf-path { font-size: 11px; overflow-wrap: anywhere; }
.hf-combo-pop { position: absolute; z-index: 5; top: 100%; left: 0; right: 0; margin-top: 2px; background: var(--bg-raised); border: 1px solid var(--border); border-radius: 6px; padding: 6px; display: flex; flex-direction: column; gap: 4px; max-height: 240px; overflow: auto; box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5); }
.hf-option { display: flex; flex-direction: column; align-items: flex-start; text-align: left; border: none; background: transparent; }
.hf-empty { padding: 4px 6px; }
.hf-template-save { display: flex; flex-direction: column; gap: 6px; }
.hf-settings { display: flex; flex-direction: column; gap: 12px; padding: 20px 24px; max-width: 760px; overflow: auto; }
.hf-settings h1 { margin: 0 0 4px; font-size: 18px; }
.hf-templates { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.hf-templates li { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; border: 1px solid var(--border); border-radius: 6px; padding: 8px 10px; }
.hf-template-text { min-width: 0; }
.hf-template-name { font-weight: 600; }
.hf-template-body { font-size: 11px; overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.hf-template-actions { display: flex; gap: 6px; flex-shrink: 0; }
.hf-settings-foot { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
`

/** Adds the handoff window's styles to `doc` once. */
export function injectHandoffStyles(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return
  const style = doc.createElement('style')
  style.id = STYLE_ID
  style.textContent = CSS
  doc.head.appendChild(style)
}
