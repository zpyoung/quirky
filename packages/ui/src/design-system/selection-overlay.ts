import tokenStyles from './tokens.css' with { type: 'text' }

/** DOM-only selection chrome for an isolated guest document, without a React root.
 * The closed shadow host carries its own canonical token scope; page CSS cannot
 * recolor the picker. Its caller still owns geometry, events and lifecycle.
 */
const selectionOverlayStyles = `${tokenStyles.replaceAll(':root', ':host').replaceAll("[data-theme='dark']", ":host([data-theme='dark'])").replaceAll("[data-theme='light']", ":host([data-theme='light'])")}
:host { all: initial; contain: strict; }
* { box-sizing: border-box; }
.surface { position: fixed; inset: 0; outline: none; cursor: crosshair; background: transparent; pointer-events: auto; }
.highlight { position: fixed; border: var(--ui-focus-width) solid var(--ui-accent); box-shadow: 0 0 0 var(--ui-border-width) var(--ui-surface); pointer-events: none; }
.label { position: fixed; max-width: 90vw; padding: var(--ui-space-4) var(--ui-space-8); border-radius: var(--ui-radius-mark); background: var(--ui-selected); color: var(--ui-text); font: var(--ui-font-body)/1.4 system-ui, sans-serif; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; pointer-events: none; }
`

function createSelectionOverlay(document: Document, styles: string) {
  const host = document.createElement('div')
  const appearance = document.documentElement.getAttribute('data-theme')
  host.setAttribute('data-theme', appearance === 'dark' || appearance === 'light'
    ? appearance
    : document.defaultView?.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
  for (const [property, value] of Object.entries({
    position: 'fixed', inset: '0', width: '100vw', height: '100vh',
    'z-index': '2147483647', background: 'transparent', 'pointer-events': 'auto',
  })) host.style.setProperty(property, value, 'important')
  const shadow = host.attachShadow({ mode: 'closed' })
  const style = document.createElement('style')
  style.textContent = styles
  const surface = document.createElement('div')
  surface.className = 'surface'
  surface.tabIndex = 0
  const highlight = document.createElement('div')
  highlight.className = 'highlight'
  highlight.hidden = true
  const label = document.createElement('div')
  label.className = 'label'
  label.hidden = true
  shadow.append(style, surface, highlight, label)
  return { host, shadow, surface, highlight, label }
}

/** Self-contained expression for an unbundled guest world; no app globals leak. */
export const selectionOverlayProgram = `(${createSelectionOverlay.toString()})(document,${JSON.stringify(selectionOverlayStyles)})`
