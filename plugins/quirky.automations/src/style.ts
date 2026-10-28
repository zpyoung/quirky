export const AUTOMATIONS_STYLE = `
.quirky-automations { display:flex;flex:1;flex-direction:column;min-width:0;min-height:0;color:var(--text);font-size:13px;background:var(--bg); }
.quirky-automations * { box-sizing:border-box; }
.quirky-automations button,.quirky-automations input,.quirky-automations select,.quirky-automations textarea { font:inherit;color:inherit; }
.quirky-automations button { border:1px solid var(--border);border-radius:6px;background:var(--bg-raised);padding:6px 10px;cursor:pointer; }
.quirky-automations button:hover:not(:disabled) { background:var(--bg-hover); }
.quirky-automations button:disabled { opacity:.5;cursor:not-allowed; }
.quirky-automations button[aria-pressed=true],.quirky-automations [aria-selected=true] { background:var(--bg-active); }
.quirky-automations :focus-visible { outline:2px solid var(--accent);outline-offset:2px; }
.quirky-automations input:not([type=checkbox]),.quirky-automations select,.quirky-automations textarea { border:1px solid var(--border);border-radius:5px;background:var(--bg);padding:7px;max-width:100%; }
.quirky-automations textarea { resize:vertical; }
.quirky-automations [role=alert] { color:var(--danger);white-space:pre-wrap; }
.quirky-automations table { width:100%;border-collapse:collapse; }
.quirky-automations th,.quirky-automations td { padding:9px 10px;text-align:left;border-bottom:1px solid var(--border);vertical-align:top; }
.quirky-automations th { color:var(--muted);font-weight:500; }
.quirky-automations h1 { font-size:23px;margin:0; }
.quirky-automations h2 { font-size:18px; }
.quirky-automations p { line-height:1.5; }
.quirky-automations pre { white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px; }
.quirky-automations code { overflow-wrap:anywhere; }
.auto-shell-header { display:flex;align-items:center;gap:8px;padding:8px 16px;border-bottom:1px solid var(--border); }
.auto-settings-link { margin-left:auto; }
.auto-settings { overflow:auto;padding:24px;gap:10px; }
.auto-settings label { display:block; }
.auto-sidebar { position:relative;display:flex;flex-direction:column;width:100%; }
.auto-sidebar>button { text-align:left; }
.auto-sidebar [role=menu] { position:absolute;top:100%;left:0;z-index:40;background:var(--bg-raised);border:1px solid var(--border);padding:5px; }
@media(max-width:750px) { .quirky-automations th,.quirky-automations td { padding:7px; } }
`
