import tokenCss from './design-system/tokens.css' with { type: 'text' }
import type { UiTheme } from './design-system/contracts'

export type EditorPrintHtmlOptions = {
  title: string
  body: string
  katexCss: string
  theme: UiTheme
}

const printCss = `@page{size:A4;margin:0.75in}html,body{background:var(--ui-surface);color:var(--ui-text)}body{font:12pt/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}pre{white-space:pre-wrap;overflow-wrap:anywhere}table{border-collapse:collapse}th,td{border:var(--ui-border-width) solid var(--ui-border);padding:.35em .6em}img{max-width:100%;height:auto}blockquote{border-left:var(--ui-space-4) solid var(--ui-border);margin-left:0;padding-left:1em}`

function htmlEscape(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!)
}

export function createEditorPrintHtml({ title, body, katexCss, theme }: EditorPrintHtmlOptions): string {
  return `<!doctype html><html data-theme="${theme}"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: http: https: file:; style-src 'unsafe-inline'; font-src data:;"><title>${htmlEscape(title)}</title><style>${tokenCss}\n${katexCss}\n${printCss}</style></head><body><main class="markdown-body">${body}</main></body></html>`
}
