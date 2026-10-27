export const ACCOUNTS_CSS = `
.accounts-ui{box-sizing:border-box;color:var(--text,#d7dae0);font:13px/1.45 system-ui,-apple-system,sans-serif;min-width:0;position:relative}
.accounts-ui *{box-sizing:border-box}
.accounts-ui button,.accounts-ui select,.accounts-ui input{font:inherit;color:inherit}
.accounts-ui button{background:var(--bg-raised,#1d2027);border:1px solid var(--border,#2b2f3a);border-radius:6px;padding:6px 10px;cursor:pointer}
.accounts-ui button:hover:not(:disabled){background:var(--bg-hover,#262a33)}
.accounts-ui button:focus-visible,.accounts-ui input:focus-visible,.accounts-ui select:focus-visible,.accounts-ui a:focus-visible{outline:2px solid var(--accent,#4f8ff7);outline-offset:2px}
.accounts-ui button:disabled{cursor:not-allowed;opacity:.55}
.accounts-ui a{color:var(--accent,#4f8ff7)}
.accounts-ui h1,.accounts-ui h2,.accounts-ui h3,.accounts-ui p{margin:0}
.accounts-ui h1{font-size:18px;font-weight:650}
.accounts-ui h2{font-size:15px;font-weight:650}
.accounts-ui h3{font-size:13px;font-weight:650}
.accounts-ui small,.accounts-ui .muted{color:var(--muted,#8a909e)}
.accounts-ui .account-stack{display:flex;flex-direction:column;gap:12px;min-height:0}
.accounts-ui .account-header,.accounts-ui .section-heading,.accounts-ui .row-heading,.accounts-ui .usage-heading,.accounts-ui .usage-footer,.accounts-ui .usage-controls,.accounts-ui .credential-row,.accounts-ui .login-actions,.accounts-ui .dialog-actions{align-items:center;display:flex;gap:8px;justify-content:space-between}
.accounts-ui .section-heading{margin-bottom:8px}
.accounts-ui .section-card,.accounts-ui .usage-popover,.accounts-ui .provider-details,.accounts-ui.provider-details,.accounts-ui .usage-cta,.accounts-ui .login-notice,.accounts-ui .reset-confirm,.accounts-ui .switch-dialog{background:var(--bg-raised,#1d2027);border:1px solid var(--border,#2b2f3a);border-radius:9px;padding:12px}
.accounts-ui .account-list,.accounts-ui .provider-list,.accounts-ui .usage-window-list,.accounts-ui .stale-list{display:flex;flex-direction:column;gap:7px}
.accounts-ui .account-row,.accounts-ui .provider-row,.accounts-ui .stale-row{align-items:center;background:var(--bg,#16181d);border:1px solid var(--border,#2b2f3a);border-radius:7px;display:flex;gap:10px;justify-content:space-between;padding:9px}
.accounts-ui .account-row-main,.accounts-ui .provider-row-main{display:flex;flex:1;flex-direction:column;gap:2px;min-width:0}
.accounts-ui .account-actions,.accounts-ui .row-badges,.accounts-ui .details-actions{align-items:center;display:flex;flex-wrap:wrap;gap:6px}
.accounts-ui .badge{background:var(--bg-active,#2d3240);border-radius:999px;color:var(--muted,#8a909e);font-size:11px;padding:2px 7px;white-space:nowrap}
.accounts-ui .badge.active{background:color-mix(in srgb,var(--green,#3fb950) 20%,transparent);color:var(--green,#3fb950)}
.accounts-ui .badge.warning{background:color-mix(in srgb,var(--amber,#f0b429) 20%,transparent);color:var(--amber,#f0b429)}
.accounts-ui .badge.danger{background:color-mix(in srgb,var(--danger,#e5534b) 20%,transparent);color:var(--danger,#e5534b)}
.accounts-ui .empty-note{border:1px dashed var(--border,#2b2f3a);border-radius:7px;color:var(--muted,#8a909e);padding:12px}
.accounts-ui.settings-shell{display:grid;grid-template-columns:minmax(150px,220px) minmax(0,1fr);height:100%;min-height:0}
.accounts-ui .settings-nav{border-right:1px solid var(--border,#2b2f3a);display:flex;flex-direction:column;gap:4px;overflow:auto;padding:14px 10px}
.accounts-ui .settings-nav button{text-align:left;background:transparent;border-color:transparent}
.accounts-ui .settings-nav button[aria-current="page"]{background:var(--bg-active,#2d3240);border-color:var(--border,#2b2f3a)}
.accounts-ui .settings-content{min-width:0;overflow:auto;padding:18px 22px}
.accounts-ui .settings-content>section{display:flex;flex-direction:column;gap:12px;max-width:880px}
.accounts-ui .settings-description{color:var(--muted,#8a909e);max-width:760px}
.accounts-ui .form-control{background:var(--bg,#16181d);border:1px solid var(--border,#2b2f3a);border-radius:6px;min-width:0;padding:7px 9px}
.accounts-ui .credential-row{border-bottom:1px solid var(--border,#2b2f3a);padding:9px 0}
.accounts-ui .credential-entry{display:flex;flex:1;gap:8px;min-width:0}
.accounts-ui .credential-entry input{flex:1}
.accounts-ui.usage-status-bar{align-items:center;display:flex;flex:1 1 auto;gap:6px;max-width:100%;min-width:0;position:relative;white-space:nowrap}
.accounts-ui .usage-status-cta{max-width:min(520px,calc(100vw - 48px));min-width:0;white-space:normal}
.accounts-ui .usage-measure{display:flex;gap:5px;left:0;pointer-events:none;position:absolute;top:0;visibility:hidden;width:max-content}
.accounts-ui .usage-trigger,.accounts-ui .usage-refresh{align-items:center;display:inline-flex;gap:5px;padding:4px 7px}
.accounts-ui .usage-chips{align-items:center;display:flex;flex:1 1 auto;gap:5px;min-width:0;overflow:hidden}
.accounts-ui .usage-chip{align-items:center;border:1px solid var(--border,#2b2f3a);border-radius:6px;display:inline-flex;flex:0 0 auto;gap:5px;padding:3px 6px}
.accounts-ui .usage-detailed-chip{display:inline-flex;gap:5px}
.accounts-ui .usage-detailed-chip>span{align-items:center;display:inline-flex;gap:3px}
.accounts-ui .usage-detailed-chip .meter{display:inline-block;height:4px;width:24px}
.accounts-ui .provider-letter{align-items:center;background:var(--bg-active,#2d3240);border-radius:4px;display:inline-flex;font-size:11px;font-weight:700;height:18px;justify-content:center;width:18px}
.accounts-ui .meter{background:var(--border,#2b2f3a);border-radius:4px;height:6px;overflow:hidden;width:100%}
.accounts-ui .meter>span{background:var(--meter-color,var(--accent,#4f8ff7));display:block;height:100%;width:var(--meter-width,0%)}
.accounts-ui .usage-popover{box-shadow:0 12px 34px #0008;bottom:calc(100% + 7px);max-height:min(76vh,640px);min-width:340px;overflow:auto;position:absolute;right:0;top:auto;width:min(440px,90vw);z-index:100}
.accounts-ui .usage-popover-header{align-items:center;display:flex;justify-content:space-between;margin-bottom:10px}
.accounts-ui .usage-controls{border-bottom:1px solid var(--border,#2b2f3a);margin-bottom:9px;padding-bottom:9px}
.accounts-ui .segmented{background:var(--bg,#16181d);border:1px solid var(--border,#2b2f3a);border-radius:7px;display:inline-flex;padding:2px}
.accounts-ui .segmented button{background:transparent;border:0;padding:4px 8px}
.accounts-ui .segmented button[aria-pressed="true"]{background:var(--bg-active,#2d3240)}
.accounts-ui .provider-row{cursor:pointer;width:100%;text-align:left}
.accounts-ui .provider-row:hover{background:var(--bg-hover,#262a33)}
.accounts-ui .provider-row-label{align-items:center;display:flex;gap:7px}
.accounts-ui .provider-summary{align-items:center;display:flex;gap:6px}
.accounts-ui .usage-window{display:flex;flex-direction:column;gap:4px;padding:7px 0}
.accounts-ui .usage-window-heading{display:flex;justify-content:space-between}
.accounts-ui .usage-footer{border-top:1px solid var(--border,#2b2f3a);margin-top:9px;padding-top:9px}
.accounts-ui .usage-cta{margin:6px 0}
.accounts-ui .usage-cta p{margin:5px 0 10px}
.accounts-ui .provider-details,.accounts-ui.provider-details{margin-top:8px}
.accounts-ui.provider-details{display:flex;flex-direction:column;gap:6px}
.accounts-ui .info-line{align-items:baseline;display:flex;gap:6px;justify-content:space-between;padding:4px 0}
.accounts-ui .status-error{color:var(--amber,#f0b429)}
.accounts-ui .status-danger{color:var(--danger,#e5534b)}
.accounts-ui .status-ready{color:var(--green,#3fb950)}
.accounts-ui .status-loading{color:var(--muted,#8a909e)}
.accounts-ui .context-menu{background:var(--bg-raised,#1d2027);border:1px solid var(--border,#2b2f3a);border-radius:8px;box-shadow:0 12px 34px #0008;bottom:calc(100% + 4px);display:flex;flex-direction:column;gap:4px;padding:8px;position:absolute;right:0;top:auto;z-index:110}
.accounts-ui .context-menu label,.accounts-ui .checkbox-row{align-items:center;display:flex;gap:8px;padding:5px 3px}
.accounts-ui .login-notice{margin-top:9px}
.accounts-ui .reset-confirm{border-color:var(--amber,#f0b429);margin-top:8px}
.accounts-ui.switch-overlay{align-items:center;background:#0008;display:flex;inset:0;justify-content:center;pointer-events:auto;position:fixed;z-index:10000}
.accounts-ui .switch-dialog{box-shadow:0 16px 48px #000a;max-height:80vh;max-width:560px;overflow:auto;width:min(560px,calc(100vw - 32px))}
.accounts-ui .dialog-actions{justify-content:flex-end;margin-top:12px}
.accounts-ui .stale-row{align-items:flex-start;flex-direction:column}
.accounts-ui .loading-indicator{animation:accounts-pulse 1.3s ease-in-out infinite}
@keyframes accounts-pulse{50%{opacity:.45}}
@media(max-width:640px){.accounts-ui.settings-shell{grid-template-columns:1fr}.accounts-ui .settings-nav{border-bottom:1px solid var(--border,#2b2f3a);border-right:0;flex-direction:row;overflow:auto}.accounts-ui .settings-content{padding:14px}.accounts-ui .account-row{align-items:flex-start;flex-direction:column}.accounts-ui .usage-popover{left:0;right:auto;min-width:min(340px,90vw)}}
`
