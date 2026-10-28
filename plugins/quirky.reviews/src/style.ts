export const REVIEWS_STYLE = `
.reviews-surface{height:100%;min-height:0;overflow:auto;padding:12px;color:var(--text);background:var(--bg);font-size:13px;line-height:1.5;box-sizing:border-box}
.reviews-surface *{box-sizing:border-box}
.reviews-surface button,.reviews-surface input,.reviews-surface select,.reviews-surface textarea{font:inherit;color:inherit;background:var(--bg-raised);border:1px solid var(--border);border-radius:5px;padding:5px 8px;max-width:100%}
.reviews-surface button{cursor:pointer}.reviews-surface button:hover:not(:disabled){background:var(--bg-hover)}.reviews-surface button:disabled{cursor:not-allowed;opacity:.55}
.reviews-surface button:focus-visible,.reviews-surface input:focus-visible,.reviews-surface select:focus-visible,.reviews-surface textarea:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.reviews-surface textarea{display:block;width:100%;resize:vertical;min-height:80px}.reviews-surface a{color:var(--accent);overflow-wrap:anywhere}
.reviews-surface h1{font-size:21px;line-height:1.3}.reviews-surface h2{font-size:16px}.reviews-surface h3{font-size:14px}.reviews-surface h1,.reviews-surface h2,.reviews-surface h3{margin:12px 0 8px}
.reviews-surface [role=alert]{padding:8px;border:1px solid var(--danger);border-radius:5px;color:var(--danger);margin-bottom:10px;white-space:pre-wrap}.reviews-surface [role=alert] button{margin-left:8px}
.reviews-surface [role=tablist]{display:flex;flex-wrap:wrap;gap:5px;border-bottom:1px solid var(--border);padding-bottom:8px;margin:12px 0}.reviews-surface [role=tab][aria-selected=true]{border-color:var(--accent);background:var(--bg-active)}
.reviews-surface pre{max-width:100%;overflow:auto;background:var(--bg-raised);padding:10px;border:1px solid var(--border);border-radius:4px;font-size:12px;white-space:pre}
.reviews-surface fieldset{border:1px solid var(--border);border-radius:5px;margin:10px 0;padding:10px}.reviews-surface label{max-width:100%}
.reviews-surface table{border-collapse:collapse;width:100%;text-align:left}.reviews-surface td,.reviews-surface th{padding:5px;border-bottom:1px solid var(--border)}
.reviews-surface details{border-bottom:1px solid var(--border);padding:8px 0}.reviews-surface summary{cursor:pointer}
.reviews-surface [role=dialog]{position:fixed;inset:8% max(18px,calc((100% - 700px)/2));z-index:90;background:var(--bg-raised);border:1px solid var(--border);border-radius:8px;padding:18px;overflow:auto;box-shadow:0 8px 40px #0005}
.reviews-surface .review-page-content{display:grid;grid-template-columns:minmax(0,1fr) 300px;gap:20px;align-items:start}.reviews-surface .review-page-main,.reviews-surface .review-page-rail{min-width:0}
.reviews-surface .review-page-rail{display:grid;gap:12px}.reviews-surface .review-page-rail>section{border:1px solid var(--border);border-radius:6px;padding:12px;background:var(--bg-raised)}.reviews-surface .review-page-rail p{margin:4px 0}
.reviews-surface .review-page-header-top,.reviews-surface .review-title-block{display:flex;justify-content:space-between;align-items:start;flex-wrap:wrap;gap:10px}
.reviews-surface .review-page-header-top nav,.reviews-surface .review-link-actions,.reviews-surface .review-meta{display:flex;align-items:center;flex-wrap:wrap;gap:8px}.reviews-surface .review-meta{margin:8px 0;color:var(--muted)}
.reviews-surface .review-actions{display:grid;gap:6px}.reviews-surface .review-merge-actions,.reviews-surface .review-assignment-header{display:flex;align-items:center;flex-wrap:wrap;gap:6px}.reviews-surface .review-assignment-header{justify-content:space-between}
.reviews-surface .review-checks-toolbar,.reviews-surface .review-files-toolbar,.reviews-surface .review-file-header{display:flex;align-items:center;flex-wrap:wrap;gap:6px}.reviews-surface .review-files-toolbar h3{width:100%;margin-bottom:0}
.reviews-surface .review-checks-toolbar>span{white-space:nowrap}.reviews-surface .review-check-rows{padding-left:20px}.reviews-surface .review-check-row{margin:8px 0}
.reviews-surface .review-check-row-heading,.reviews-surface .review-check-row-heading>button:first-child{display:flex;align-items:center;flex-wrap:wrap;gap:8px}.reviews-surface .review-check-row-heading>button:first-child{min-width:0;text-align:left}
.reviews-surface .review-check-failure .review-check-row-heading>button:first-child>span:first-child{color:var(--danger)}.reviews-surface .review-check-success .review-check-row-heading>button:first-child>span:first-child{color:var(--green)}
.reviews-surface .review-files-layout{min-width:0;margin-top:10px}.reviews-surface .review-files-layout:has(>.review-file-tree){display:grid;grid-template-columns:180px minmax(0,1fr);gap:12px}.reviews-surface .review-file-tree ul{list-style:none;padding:0}
.reviews-surface .review-file-diff{border:1px solid var(--border);border-radius:5px;margin-bottom:12px;min-width:0}.reviews-surface .review-file-header{padding:8px;background:var(--bg-raised)}.reviews-surface .review-file-content{padding:8px;overflow:auto}
.reviews-surface .review-diff-line{display:flex;align-items:start;gap:8px;white-space:pre-wrap;overflow-wrap:anywhere}.reviews-surface .review-diff-lines{min-width:45px;color:var(--muted)}.reviews-surface .review-diff-add{background:color-mix(in srgb,var(--green) 12%,transparent)}.reviews-surface .review-diff-delete{background:color-mix(in srgb,var(--danger) 12%,transparent)}
.reviews-surface .review-side-by-side .review-diff-line{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr)}.reviews-surface .review-inline-actions{display:flex;flex-wrap:wrap;gap:6px;grid-column:1/-1}
.reviews-surface .review-muted{color:var(--muted)}
@media(max-width:1100px){.reviews-surface .review-page-content{grid-template-columns:minmax(0,1fr)}.reviews-surface [role=dialog]{inset:12px}.reviews-surface .review-files-layout:has(>.review-file-tree){grid-template-columns:140px minmax(0,1fr)}}
`
