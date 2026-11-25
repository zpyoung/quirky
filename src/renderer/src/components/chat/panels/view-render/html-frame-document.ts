/**
 * What an agent's html may load: its own inline styles and scripts and `data:` or `blob:` media,
 * and nothing from the network. `navigate-to` is left out because WebKit ignores it; the wrapper
 * frame's `frame-src 'none'` is what stops the agent frame from navigating.
 */
export const FRAME_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  'img-src data: blob:',
  'font-src data:',
  'media-src data: blob:',
  "connect-src 'none'",
  "form-action 'none'",
  "frame-src 'none'",
  "child-src 'none'",
  "worker-src 'none'",
  "base-uri 'none'"
].join('; ')

/**
 * The wrapper's policy. The agent frame inherits it, so the media sources repeat the ones in
 * FRAME_CSP, and `frame-src 'none'` stops the agent frame from navigating itself away.
 */
export const WRAPPER_CSP = [
  "default-src 'none'",
  "frame-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  'img-src data: blob:',
  'font-src data:',
  'media-src data: blob:'
].join('; ')

/** Runs in the wrapper: tells the card when the agent frame loads a second time, which means it navigated. */
const FRAME_RELAY = `(function () {
  var loads = 0;
  document.addEventListener('load', function (event) {
    var inner = document.getElementById('agent');
    if (!inner || event.target !== inner) return;
    loads += 1;
    if (loads > 1) parent.postMessage({ type: 'quirky-navigated' }, '*');
  }, true);
})();`

const THEME_TOKENS: readonly (readonly [name: string, source: string])[] = [
  ['--ui-surface', '--background'],
  ['--ui-text', '--foreground'],
  ['--ui-muted', '--muted-foreground'],
  ['--ui-accent', '--primary'],
  ['--ui-border', '--border'],
  ['--ui-selected', '--muted'],
  ['--ui-working', '--status-success'],
  ['--ui-needs-you', '--status-warning'],
  ['--ui-failing', '--destructive']
]
const SAFE_VALUE = /^[#\w\s(),.%/-]+$/

/** The window's current token values, so a frame draws in the same theme; a value that is not plain css is left out. */
export function frameThemeStyle(): string {
  if (typeof document === 'undefined') {
    return ''
  }
  const style = getComputedStyle(document.documentElement)
  const declarations = THEME_TOKENS.flatMap(([name, source]) => {
    const value = style.getPropertyValue(source).trim()
    return SAFE_VALUE.test(value) ? [`${name}:${value}`] : []
  })
  return `:root{${declarations.join(';')}}body{margin:0;background:var(--ui-surface);color:var(--ui-text);font:14px system-ui,sans-serif}`
}

/** The frame's document. The CSP meta is the first thing in it, so no agent markup can come before it. */
export function frameDocument(html: string, theme = frameThemeStyle()): string {
  return `<meta http-equiv="Content-Security-Policy" content="${FRAME_CSP}"><style>${theme}</style>${html}`
}

const escapeAttribute = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/"/g, '&quot;')

/**
 * The document the card's frame holds: the policy first, the relay, and the agent's frame filling
 * the page. The agent frame is nested so that its navigation is refused before any request is made;
 * it runs scripts only when the node is interactive.
 */
export function wrapperDocument(inner: string, interactive: boolean): string {
  const sandbox = interactive ? 'allow-scripts' : ''
  return `<meta http-equiv="Content-Security-Policy" content="${WRAPPER_CSP}"><style>html,body{margin:0;height:100%;overflow:hidden}iframe{display:block;width:100%;height:100%;border:0}</style><script>${FRAME_RELAY}</script><iframe id="agent" sandbox="${sandbox}" srcdoc="${escapeAttribute(inner)}"></iframe>`
}

/** Whether a message is the wrapper saying the agent frame navigated away. */
export function isNavigatedMessage(data: unknown): boolean {
  return (
    typeof data === 'object' && data !== null && 'type' in data && data.type === 'quirky-navigated'
  )
}
