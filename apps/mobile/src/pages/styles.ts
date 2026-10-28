export const PAGE_CSS = `
:root{color-scheme:dark;font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#101318;color:#eef1f5;font-synthesis:none;text-rendering:optimizeLegibility}
*{box-sizing:border-box}
body{margin:0;min-width:320px;min-height:100%;background:#101318}
button,input,select,textarea{font:inherit}
button{color:inherit}
button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible,[tabindex]:focus-visible{outline:2px solid #79b8ff;outline-offset:2px}
.qp-page{--safe-top:0px;--safe-bottom:0px;height:100dvh;min-height:320px;display:flex;flex-direction:column;overflow:hidden;background:#101318;color:#eef1f5;font-size:14px}
.qp-topbar{z-index:2;flex:none;display:flex;align-items:center;gap:8px;min-height:58px;padding:calc(8px + var(--safe-top)) 14px 8px;border-bottom:1px solid #292e38;background:#15191f}
.qp-topbar__titles{flex:1;min-width:0}
.qp-topbar h1{font-size:16px;line-height:1.2;margin:0;font-weight:650;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.qp-topbar p{font-size:12px;color:#9da8b6;margin:3px 0 0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.qp-icon-button,.qp-button,.qp-chip,.qp-tab{display:inline-flex;align-items:center;justify-content:center;gap:6px;border:1px solid #343b47;border-radius:10px;background:#20252d;padding:9px 12px;min-height:40px;cursor:pointer;text-decoration:none;color:inherit}
.qp-icon-button{padding:8px 10px;min-width:40px}
.qp-button--primary{background:#3478d4;border-color:#448ce8;color:#fff;font-weight:600}
.qp-button--danger{background:#49272a;border-color:#71383c;color:#ffdfe0}
.qp-button--quiet{background:transparent}
.qp-button:disabled,.qp-icon-button:disabled,.qp-tab:disabled{opacity:.45;cursor:not-allowed}
.qp-topbar .qp-button{white-space:nowrap}
.qp-connection{display:flex;align-items:flex-start;gap:9px;padding:10px 14px;border-bottom:1px solid #4b3e24;background:#292317;color:#ffdf9b;font-size:13px}
.qp-connection__text{flex:1;min-width:0}
.qp-connection strong{display:block;margin-bottom:2px}
.qp-connection p{margin:0;color:#dbcba8;line-height:1.35}
.qp-connection .qp-button{min-height:34px;padding:6px 9px;font-size:12px}
.qp-status-dot{width:8px;height:8px;flex:none;border-radius:50%;background:#43c184;margin-top:4px}
.qp-status-dot--stale{background:#e6ac4d}
.qp-error{padding:10px 12px;margin:8px 0;border:1px solid #71383c;border-radius:10px;background:#321f22;color:#ffdfe0;overflow-wrap:anywhere}
.qp-content{flex:1;min-height:0;overflow:auto;padding:14px max(12px,env(safe-area-inset-right)) calc(18px + var(--safe-bottom)) max(12px,env(safe-area-inset-left))}
.qp-page--workspaces{flex:1;min-height:0;display:flex;flex-direction:column}
.qp-page--workspaces .qp-content{padding-top:12px}
.qp-workspace-layout{display:flex;min-height:100%;gap:12px;max-width:1440px;margin:0 auto}
.qp-sidebar{display:none;position:relative;flex:none;width:var(--sidebar-width,292px);min-width:220px;max-width:480px;border:1px solid #292e38;border-radius:14px;background:#15191f;padding:12px;overflow:auto}
.qp-sidebar-toggle{display:none}
.qp-sidebar__heading{font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#9da8b6;margin:4px 8px 10px}
.qp-sidebar__project{display:flex;width:100%;justify-content:space-between;text-align:left;background:transparent;border:0;border-radius:8px;padding:10px 8px;color:#c8d0db;cursor:pointer}
.qp-sidebar__project[aria-pressed=true]{background:#242b35;color:#fff}
.qp-sidebar__resize{position:absolute;right:-7px;top:0;bottom:0;width:14px;cursor:col-resize;touch-action:none}
.qp-main-list{flex:1;min-width:0}
.qp-toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:10px}
.qp-toolbar__fill{flex:1}
.qp-search{width:100%;min-height:42px;border:1px solid #394250;border-radius:10px;background:#171c23;color:#fff;padding:9px 12px}
.qp-search-row{display:flex;gap:8px;width:100%;margin-top:2px}
.qp-search-row .qp-search{flex:1;min-width:0}
.qp-count{color:#aab4c1;font-size:12px;padding:0 4px}
.qp-worktree-group{margin:10px 0 16px}
.qp-group-heading{display:flex;align-items:center;width:100%;gap:8px;border:0;background:transparent;color:#c3ccd8;padding:9px 4px;font-size:12px;font-weight:700;letter-spacing:.07em;text-align:left;text-transform:uppercase;cursor:pointer}
.qp-group-heading small{font-size:11px;color:#828d9a;font-weight:500;letter-spacing:0;margin-left:auto;text-transform:none}
.qp-worktree-rows{display:flex;flex-direction:column;gap:8px}
.qp-worktree-card{position:relative;min-width:0;border:1px solid #2b323e;border-radius:13px;background:#171c23;padding:12px;box-shadow:0 2px 6px #0002}
.qp-worktree-card--compact{padding:8px 10px}
.qp-worktree-card--child{border-left:2px solid #526b8c}
.qp-worktree-card__main{display:flex;align-items:flex-start;gap:10px;min-width:0}
.qp-worktree-card__body{flex:1;min-width:0}
.qp-worktree-card__name{font-weight:650;font-size:14px;line-height:1.25;overflow-wrap:anywhere}
.qp-worktree-card__branch{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;color:#aab8ca;margin-top:5px;overflow-wrap:anywhere}
.qp-worktree-card__project{font-size:11px;color:#94a0af;margin-top:4px}
.qp-worktree-card__actions{display:flex;flex:none;gap:4px;align-items:center}
.qp-worktree-card__actions .qp-icon-button{min-width:36px;min-height:36px;padding:6px;border-radius:9px}
.qp-worktree-card__open{width:100%;margin-top:9px;min-height:38px}
.qp-chips{display:flex;flex-wrap:wrap;gap:5px;margin-top:8px}
.qp-chip{min-height:25px;border-radius:99px;padding:3px 8px;font-size:11px;background:#222a34;border-color:#333d4b;color:#d1dae5}
.qp-chip--accent{background:#17354a;border-color:#255a76;color:#c7ecff}
.qp-chip--warn{background:#382d19;border-color:#5f4b27;color:#ffdf9b}
.qp-chip--muted{color:#9ca7b5}
.qp-worktree-card__menu{position:absolute;z-index:4;right:8px;top:48px;width:min(240px,calc(100vw - 56px));padding:6px;border:1px solid #424b59;border-radius:12px;background:#20262e;box-shadow:0 14px 36px #0008}
.qp-worktree-card__menu button{width:100%;text-align:left;min-height:38px;padding:8px;border:0;border-radius:7px;background:transparent;color:#e7ebf0;cursor:pointer}
.qp-worktree-card__menu button:hover:not(:disabled){background:#2d3540}
.qp-worktree-card__menu button:disabled{opacity:.48;cursor:not-allowed}
.qp-worktree-card__menu p{margin:5px 8px 8px;font-size:11px;color:#c4a865;line-height:1.35}
.qp-empty{border:1px dashed #404855;border-radius:14px;padding:24px 18px;text-align:center;color:#aeb8c5;line-height:1.45}
.qp-empty strong{display:block;color:#e5eaf1;margin-bottom:5px}
.qp-sheet-backdrop{position:fixed;z-index:20;inset:0;display:flex;align-items:flex-end;justify-content:center;padding:8px max(8px,env(safe-area-inset-right)) calc(8px + var(--safe-bottom)) max(8px,env(safe-area-inset-left));background:#0009}
.qp-sheet{width:min(100%,680px);max-height:calc(100dvh - var(--safe-top) - var(--safe-bottom) - 16px);overflow:auto;overscroll-behavior:contain;border:1px solid #3a424e;border-radius:18px 18px 12px 12px;background:#181d24;box-shadow:0 20px 60px #000a;padding:15px 16px 18px}
.qp-sheet__header{position:sticky;top:-15px;z-index:1;display:flex;align-items:center;gap:8px;margin:-15px -16px 12px;padding:15px 16px 11px;background:#181d24;border-bottom:1px solid #2d343e}
.qp-sheet__header h2{font-size:16px;margin:0;flex:1}
.qp-sheet__section{border-bottom:1px solid #2c333d;padding:11px 0}
.qp-sheet__section:last-child{border-bottom:0}
.qp-sheet__section h3{font-size:12px;color:#aab4c1;margin:0 0 8px;letter-spacing:.04em;text-transform:uppercase}
.qp-form-field{display:grid;gap:5px;margin:11px 0;color:#c7d0dc;font-size:12px}
.qp-form-field input,.qp-form-field select,.qp-form-field textarea,.qp-control{width:100%;min-height:42px;border:1px solid #394250;border-radius:9px;background:#11161c;color:#fff;padding:9px 10px}
.qp-form-field textarea{min-height:86px;resize:vertical}
.qp-form-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.qp-form-row>*{flex:1;min-width:120px}
.qp-choice-list{display:grid;gap:5px}
.qp-choice{display:flex;gap:9px;align-items:center;padding:9px 10px;border:1px solid #303844;border-radius:9px;background:#1d232b;min-height:40px}
.qp-choice input{accent-color:#5da3fa}
.qp-option-row{display:flex;flex-wrap:wrap;gap:7px}
.qp-option-row>.qp-ask-option{display:grid;align-content:start;gap:4px;min-width:min(100%,180px)}
.qp-option-row>.qp-form-field{flex:1 1 100%;min-width:100%;margin:4px 0}
.qp-ask-option details{margin:4px 0}
.qp-ask-option pre{max-height:50dvh;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere}
.qp-ask-card__question>.qp-dialog-copy{margin:0 0 7px}
.qp-option-row button[aria-pressed=true],.qp-chip[aria-pressed=true]{border-color:#5792df;background:#1c3656;color:#fff}
.qp-filter-toggle{display:flex;gap:9px;align-items:flex-start;padding:9px 0;color:#dce2ea;line-height:1.35}
.qp-filter-toggle input{margin-top:2px;accent-color:#5da3fa}
.qp-filter-toggle small{display:block;color:#9ba6b3;font-size:11px;margin-top:2px}
.qp-sheet__footer{display:flex;justify-content:flex-end;gap:8px;flex-wrap:wrap;margin-top:14px}
.qp-dialog-copy{white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.45;color:#d8dee7}
.qp-tabs{display:flex;align-items:center;gap:6px;overflow-x:auto;padding:8px 1px;scrollbar-width:thin}
.qp-tab{flex:none;min-height:38px;max-width:190px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;padding:7px 10px;background:#191e25}
.qp-tab[aria-selected=true]{border-color:#5a8ecc;background:#21354c;color:#fff}
.qp-tab__name{overflow:hidden;text-overflow:ellipsis}
.qp-session-layout{flex:1;min-height:0;display:flex;flex-direction:column}
.qp-session-header{display:flex;align-items:center;gap:8px;padding:10px 12px 0;min-width:0}
.qp-session-header__title{flex:1;min-width:0}
.qp-session-header__title strong{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.qp-session-header__title small{display:block;color:#9aa5b3;margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.qp-session-body{flex:1;min-height:0;overflow:auto;padding:8px 12px calc(8px + var(--safe-bottom))}
.qp-terminal-wrap{display:flex;flex-direction:column;min-height:0;height:min(52dvh,520px);min-height:220px;border:1px solid #2d3540;border-radius:12px;overflow:hidden;background:#101318}
.qp-terminal-status{display:flex;align-items:center;gap:7px;flex:none;padding:6px 9px;border-bottom:1px solid #262c35;background:#171c22;color:#aab4c1;font-size:11px}
.qp-terminal-status__fill{flex:1}
.qp-terminal-screen{flex:1;min-height:0;overflow:hidden;padding:6px}
.qp-terminal-screen .xterm{height:100%;width:100%}
.qp-terminal-screen .xterm-viewport{overflow-y:auto!important}
.qp-terminal-screen .xterm-screen{width:100%!important}
.qp-terminal-stale{display:flex;align-items:center;gap:7px;padding:8px 10px;border-top:1px solid #564622;background:#2a2419;color:#f4d58f;font-size:12px}
.qp-session-dock{flex:none;border-top:1px solid #2b323d;background:#161a20;padding:8px 10px calc(8px + var(--safe-bottom));}
.qp-dock-row{display:flex;align-items:center;gap:6px;overflow-x:auto;padding:2px 0;scrollbar-width:thin}
.qp-dock-row+.qp-dock-row{margin-top:5px}
.qp-dock-row .qp-button,.qp-dock-row .qp-icon-button{flex:none;min-height:36px;padding:7px 10px;font-size:12px}
.qp-dock-input{flex:1;min-width:80px;min-height:38px;border:1px solid #394250;border-radius:9px;background:#10151b;color:#fff;padding:8px 10px}
.qp-ask-card{margin:10px 0;border:1px solid #3c4c60;border-radius:13px;background:#19222c;padding:12px}
.qp-ask-card h2{font-size:14px;margin:0 0 8px}
.qp-ask-card__scope{display:flex;gap:6px;margin-bottom:9px}
.qp-ask-card__question{border-top:1px solid #2f3945;padding:10px 0}
.qp-ask-card__question:first-of-type{border-top:0}
.qp-ask-card__question strong{display:block;margin-bottom:7px;line-height:1.35}
.qp-ask-card__question small{color:#9da8b6}
.qp-ask-card__error{color:#ffbbbb;font-size:12px;margin:8px 0 0}
.qp-session-empty{max-width:600px;margin:16px auto}
.qp-inline-menu{position:fixed;z-index:12;inset:0;background:#0005;display:flex;align-items:flex-end;justify-content:center;padding:12px}
.qp-inline-menu__panel{width:min(100%,520px);max-height:80dvh;overflow:auto;border:1px solid #424b59;border-radius:16px;background:#1b2028;padding:12px;box-shadow:0 16px 44px #0009}
.qp-inline-menu__panel h2{font-size:15px;margin:2px 2px 10px}
.qp-inline-menu__panel button{width:100%;justify-content:flex-start;text-align:left;margin:3px 0}
.qp-visually-hidden{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
@media(min-width:900px){
 .qp-topbar{padding-left:24px;padding-right:24px}
 .qp-content{padding-left:24px;padding-right:24px}
 .qp-sidebar{display:block}
 .qp-sidebar-toggle{display:inline-flex}
 .qp-sidebar--collapsed{display:none}
 .qp-workspace-layout[data-sidebar-collapsed=true] .qp-sidebar{display:none}
 .qp-session-header{padding-left:22px;padding-right:22px}
 .qp-session-body{padding-left:22px;padding-right:22px}
 .qp-terminal-wrap{height:min(60dvh,760px)}
 .qp-session-dock{padding-left:18px;padding-right:18px}
 .qp-sheet-backdrop{align-items:center}
 .qp-sheet{border-radius:16px}
}
@media(max-width:420px){
 .qp-topbar{gap:5px;padding-left:9px;padding-right:9px}
 .qp-topbar .qp-button{padding:7px 8px;font-size:12px}
 .qp-icon-button{min-width:38px;padding:7px}
 .qp-content{padding-left:8px;padding-right:8px}
 .qp-worktree-card{padding:10px}
 .qp-worktree-card__actions .qp-icon-button{min-width:34px;min-height:34px}
 .qp-terminal-wrap{height:45dvh;min-height:200px}
 .qp-dock-row .qp-button,.qp-dock-row .qp-icon-button{padding-left:8px;padding-right:8px}
}
`