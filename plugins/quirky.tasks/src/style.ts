export const TASKS_STYLE = `
.quirky-tasks{display:flex;flex:1;min-height:0;min-width:0;flex-direction:column;color:var(--text);background:var(--bg);font-size:13px;line-height:1.5;overflow:hidden}
.quirky-tasks *{box-sizing:border-box}
.quirky-tasks button,.quirky-tasks input,.quirky-tasks select,.quirky-tasks textarea{font:inherit;color:inherit;background:var(--bg-raised);border:1px solid var(--border);border-radius:5px;padding:5px 9px;max-width:100%}
.quirky-tasks button{cursor:pointer;white-space:nowrap}
.quirky-tasks button:hover{background:var(--bg-hover)}
.quirky-tasks button:disabled{opacity:.5;cursor:not-allowed}
.quirky-tasks button[aria-pressed=true]{background:var(--bg-active);border-color:var(--accent)}
.quirky-tasks :focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.quirky-tasks input[type=checkbox]{width:auto;accent-color:var(--accent)}
.quirky-tasks a{color:var(--accent)}
.quirky-tasks h2,.quirky-tasks h3{margin:0;font-size:16px}
.quirky-tasks [role=alert]{color:var(--danger);padding:8px}
.quirky-tasks table{width:100%;border-collapse:collapse;text-align:left}
.quirky-tasks th,.quirky-tasks td{padding:8px;border-bottom:1px solid var(--border);vertical-align:top}
.quirky-tasks th{font-weight:600;background:var(--bg-raised)}
.tasks-header{display:flex;align-items:center;gap:12px;padding:12px 16px;border-bottom:1px solid var(--border);flex-wrap:wrap;flex-shrink:0}
.tasks-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.tasks-settings-button{margin-left:auto}
.tasks-body{display:flex;flex:1;flex-direction:column;overflow:auto;min-height:0;min-width:0;padding:16px;gap:12px}
.tasks-settings{padding:12px 16px;border-bottom:1px solid var(--border);display:flex;flex-direction:column;gap:8px;flex-shrink:0}
.tasks-settings p{color:var(--muted);margin:0}
.quirky-tasks [role=dialog]{max-height:90vh;overflow:auto}
.quirky-tasks textarea{min-height:100px;resize:vertical}
.quirky-tasks p{overflow-wrap:anywhere}
@media(max-width:720px){.tasks-header{gap:6px;padding:8px}.tasks-body{padding:10px}.tasks-settings-button{margin-left:0}.quirky-tasks table{min-width:640px}}
`
