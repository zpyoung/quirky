export function MobileStyles() {
  return (
    <style>{`
      .mobile-root { box-sizing: border-box; max-width: 1040px; margin: 0 auto; padding: 28px 32px 48px; color: var(--text, #d7dae0); }
      .mobile-root * { box-sizing: border-box; }
      .mobile-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 20px; margin-bottom: 24px; }
      .mobile-title { margin: 0; font-size: 28px; font-weight: 650; letter-spacing: -0.02em; }
      .mobile-description { margin: 8px 0 0; color: var(--muted, #8a909e); line-height: 1.5; }
      .mobile-card { border: 1px solid var(--border, #2b2f3a); border-radius: 10px; padding: 20px; margin: 16px 0; background: var(--bg-raised, #1d2027); }
      .mobile-card h2, .mobile-card h3 { margin: 0 0 10px; font-size: 17px; }
      .mobile-card p { line-height: 1.5; }
      .mobile-muted { color: var(--muted, #8a909e); }
      .mobile-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin-top: 16px; }
      .mobile-button { border: 1px solid var(--border, #2b2f3a); border-radius: 6px; background: var(--bg-hover, #262a33); color: var(--text, #d7dae0); padding: 8px 12px; cursor: pointer; font: inherit; }
      .mobile-button:hover:not(:disabled) { background: var(--bg-active, #2d3240); }
      .mobile-button.primary { background: var(--accent, #4f8ff7); border-color: var(--accent, #4f8ff7); color: white; }
      .mobile-button.danger { color: var(--danger, #e5534b); }
      .mobile-button:disabled { opacity: 0.55; cursor: not-allowed; }
      .mobile-choice-row { display: flex; gap: 8px; flex-wrap: wrap; margin: 12px 0; }
      .mobile-choice[aria-pressed="true"] { border-color: var(--accent, #4f8ff7); box-shadow: inset 0 0 0 1px var(--accent, #4f8ff7); }
      .mobile-field { display: grid; gap: 6px; margin: 12px 0; max-width: 560px; }
      .mobile-field input, .mobile-field select, .mobile-select { min-width: 0; padding: 8px 10px; border: 1px solid var(--border, #2b2f3a); border-radius: 6px; background: var(--bg, #16181d); color: var(--text, #d7dae0); font: inherit; }
      .mobile-address-row { display: flex; align-items: end; gap: 8px; flex-wrap: wrap; }
      .mobile-address-row .mobile-field { flex: 1 1 260px; }
      .mobile-error { color: var(--danger, #e5534b); margin: 10px 0; }
      .mobile-success { color: var(--green, #3fb950); margin: 10px 0; }
      .mobile-callout { border-left: 3px solid var(--amber, #f0b429); padding: 10px 14px; background: var(--bg, #16181d); line-height: 1.5; }
      .mobile-pairing { display: grid; grid-template-columns: minmax(180px, 260px) minmax(0, 1fr); gap: 24px; align-items: start; margin-top: 20px; }
      .mobile-qr { width: 100%; max-width: 240px; background: white; border: 8px solid white; border-radius: 4px; cursor: zoom-in; }
      .mobile-pairing-url { width: 100%; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
      .mobile-device-list { display: grid; gap: 8px; }
      .mobile-device { display: flex; align-items: center; justify-content: space-between; gap: 16px; border: 1px solid var(--border, #2b2f3a); border-radius: 8px; padding: 12px; }
      .mobile-device-name { font-weight: 600; }
      .mobile-device-meta { margin-top: 4px; font-size: 12px; color: var(--muted, #8a909e); }
      .mobile-sidebar-button { display: flex; width: 100%; align-items: center; gap: 10px; border: 0; padding: 9px 12px; text-align: left; color: inherit; background: transparent; cursor: pointer; font: inherit; }
      .mobile-sidebar-button:hover { background: var(--bg-hover, #262a33); }
      .mobile-badge { margin-left: auto; border-radius: 10px; padding: 2px 7px; background: var(--accent, #4f8ff7); color: white; font-size: 11px; }
      .mobile-modal-backdrop { position: fixed; inset: 0; z-index: 1000; display: grid; place-items: center; padding: 24px; background: rgba(0, 0, 0, .72); }
      .mobile-modal { max-width: min(90vw, 680px); max-height: 90vh; overflow: auto; padding: 20px; border: 1px solid var(--border, #2b2f3a); border-radius: 10px; background: var(--bg-raised, #1d2027); text-align: center; }
      .mobile-modal img { display: block; max-width: min(70vh, 520px); max-height: 70vh; margin: 16px auto; background: white; }
      @media (max-width: 640px) { .mobile-root { padding: 20px 16px 32px; } .mobile-header { flex-direction: column; } .mobile-pairing { grid-template-columns: 1fr; } .mobile-qr { max-width: 200px; } }
    `}</style>
  )
}
