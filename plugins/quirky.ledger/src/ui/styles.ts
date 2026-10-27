export const LEDGER_CSS = `
.ledger-root { color: var(--text); font: inherit; box-sizing: border-box; min-width: 0; height: 100%; display: flex; flex-direction: column; }
.ledger-root *, .ledger-modal-backdrop * { box-sizing: border-box; }
.ledger-page, .ledger-panel, .ledger-chooser { display: flex; flex-direction: column; gap: .75rem; min-width: 0; min-height: 0; height: 100%; padding: 1rem; overflow: hidden; }
.ledger-header, .ledger-panel-header, .ledger-page-actions, .ledger-filters, .ledger-bulk-actions, .ledger-row-main, .ledger-row-actions, .ledger-dialog-actions { display: flex; align-items: center; gap: .5rem; flex-wrap: wrap; }
.ledger-header { justify-content: space-between; align-items: flex-start; }
.ledger-header h1, .ledger-panel-header h2, .ledger-dialog-header h2 { margin: 0; }
.ledger-summary, .ledger-muted, .ledger-evidence { color: var(--muted); }
.ledger-summary { margin: .3rem 0 0; }
.ledger-page-actions { justify-content: flex-end; }
.ledger-root button, .ledger-root input, .ledger-root select, .ledger-root textarea { color: inherit; font: inherit; }
.ledger-root button { background: var(--bg-raised); border: 1px solid var(--border); border-radius: 4px; padding: .35rem .6rem; cursor: pointer; }
.ledger-root button:hover:not(:disabled) { background: var(--bg-hover); }
.ledger-root button:disabled { opacity: .55; cursor: not-allowed; }
.ledger-root button.primary { background: var(--accent); color: var(--bg); border-color: var(--accent); }
.ledger-root input:not([type=checkbox]), .ledger-root select, .ledger-root textarea { background: var(--bg-raised); border: 1px solid var(--border); border-radius: 4px; padding: .4rem .5rem; min-width: 0; }
.ledger-root label { display: flex; flex-direction: column; gap: .25rem; min-width: 8rem; }
.ledger-root label > span { font-size: .9em; color: var(--muted); }
.ledger-root [aria-invalid=true] small, .ledger-form-conflict { color: var(--danger); }
.ledger-root input[type=checkbox] { accent-color: var(--accent); }
.ledger-filters { align-items: end; }
.ledger-filters label { flex: 1 1 8rem; }
.ledger-filters label.search { flex: 2 1 14rem; }
.ledger-entry-list, .ledger-candidate-list, .ledger-chooser-list { flex: 1 1 auto; overflow: auto; min-height: 0; margin: 0; padding: 0; list-style: none; }
.ledger-entry-row, .ledger-chooser-row, .ledger-candidate-row { border: 1px solid var(--border); border-radius: 5px; padding: .6rem; margin: 0 0 .45rem; min-width: 0; }
.ledger-row-main { align-items: flex-start; }
.ledger-row-title { flex: 1 1 16rem; min-width: 10rem; overflow-wrap: anywhere; }
.ledger-badge { border: 1px solid var(--border); border-radius: 1rem; padding: .05rem .45rem; white-space: nowrap; font-size: .82em; }
.ledger-badge.reviewed { color: var(--green); }
.ledger-badge.stale { color: var(--amber); }
.ledger-row-meta { color: var(--muted); font-size: .85em; }
.ledger-row-actions { justify-content: flex-end; margin-top: .4rem; }
.ledger-empty, .ledger-error, .ledger-state-message { margin: auto; padding: 1rem; text-align: center; color: var(--muted); }
.ledger-error { color: var(--danger); }
.ledger-nav-item { width: 100%; text-align: left; background: transparent !important; border: 0 !important; }
.ledger-nav-item::before { content: '▤'; margin-right: .55rem; }
.ledger-scope-tabs { display: flex; gap: .35rem; }
.ledger-scope-tabs [aria-pressed=true] { outline: 1px solid var(--accent); }
.ledger-modal-backdrop { position: fixed; inset: 0; z-index: 1000; display: grid; place-items: center; padding: 1rem; background: rgb(0 0 0 / 55%); }
.ledger-dialog { display: flex; flex-direction: column; width: min(52rem, calc(100vw - 2rem)); max-height: calc(100dvh - 2rem); min-height: 0; overflow: hidden; border: 1px solid var(--border); border-radius: 8px; background: var(--bg-raised); box-shadow: 0 1rem 3rem rgb(0 0 0 / 40%); }
.ledger-dialog-header, .ledger-dialog-actions { flex: 0 0 auto; padding: .8rem 1rem; }
.ledger-dialog-header { border-bottom: 1px solid var(--border); }
.ledger-dialog-header p { margin: .25rem 0 0; color: var(--muted); }
.ledger-dialog-actions { justify-content: flex-end; border-top: 1px solid var(--border); background: var(--bg-raised); }
.ledger-dialog-body, .ledger-detail-body { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: .8rem 1rem; }
.ledger-detail-dialog { width: min(72rem, calc(100vw - 2rem)); height: min(52rem, calc(100dvh - 2rem)); }
.ledger-detail-body section { border-bottom: 1px solid var(--border); padding: .3rem 0 .7rem; }
.ledger-detail-body h3 { margin: .4rem 0; }
.ledger-detail-body dl, .ledger-content-list { display: grid; grid-template-columns: minmax(8rem, max-content) minmax(0, 1fr); gap: .25rem .7rem; margin: .2rem 0; }
.ledger-detail-body dt, .ledger-content-list dt { color: var(--muted); }
.ledger-detail-body dd, .ledger-content-list dd { margin: 0; overflow-wrap: anywhere; white-space: pre-wrap; }
.ledger-detail-body pre { overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; }
.ledger-history-revision { border-top: 1px solid var(--border); padding: .35rem 0; }
.ledger-detail-actions { flex: 0 0 auto; }
.ledger-revert-control { flex-direction: row !important; align-items: center; }
.ledger-form { display: flex; flex-direction: column; gap: .7rem; }
.ledger-form > label, .ledger-location-fields > label { width: 100%; }
.ledger-form textarea { resize: vertical; }
.ledger-location-fields { border: 1px solid var(--border); border-radius: 5px; padding: .7rem; display: flex; flex-direction: column; gap: .55rem; }
.ledger-location-fields legend { color: var(--muted); padding: 0 .25rem; }
.ledger-check-row { flex-direction: row !important; align-items: center; }
.ledger-check-row > span { color: var(--text) !important; }
.ledger-confirm-snapshots { overflow: auto; max-height: 38vh; }
.ledger-confirm-snapshots li { overflow-wrap: anywhere; margin: .3rem 0; }
.ledger-settings { display: flex; flex-direction: column; gap: .75rem; max-width: 36rem; padding: 1rem; }
.ledger-settings input { width: 8rem; }
.ledger-settings-actions { display: flex; align-items: center; gap: .5rem; }
.ledger-chooser-row { display: flex; justify-content: space-between; align-items: center; gap: .75rem; }
.ledger-evidence { white-space: pre-wrap; overflow-wrap: anywhere; }
.ledger-attach { display: flex; align-items: end; gap: .6rem; flex-wrap: wrap; }
.ledger-refreshing { animation: ledger-spin 1s linear infinite; }
@keyframes ledger-spin { to { transform: rotate(360deg); } }
@media (max-width: 700px) {
  .ledger-page, .ledger-panel, .ledger-chooser { padding: .55rem; }
  .ledger-header, .ledger-page-actions { align-items: flex-start; }
  .ledger-row-actions button { flex: 1 1 auto; }
  .ledger-detail-dialog { height: calc(100dvh - 1rem); max-height: calc(100dvh - 1rem); width: calc(100vw - 1rem); }
  .ledger-dialog-actions { justify-content: flex-start; }
}
`
