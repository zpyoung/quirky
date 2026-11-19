import { useEffect, useMemo, useRef, useState } from 'react'
import { asNumber, asString, type Props } from './props'
import { clampLabel, ELEMENT_KEY, keyPart, pointKey } from './point'
import { useRuntime } from './runtime'

const FRAME_HEIGHT = { min: 120, max: 1200, fallback: 240 }

/**
 * What an agent's html may load: its own inline styles and scripts and `data:` or `blob:` media,
 * and nothing from the network. `navigate-to` is left out because WebKit ignores it; the load
 * check in HtmlFrame is what stops navigation.
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

/** Runs inside the frame: reports a click on a `[data-point]` element to the card that holds the frame. */
export const FRAME_BRIDGE = `(function () {
  var owner = function (node) {
    while (node && node.nodeType === 1) {
      if (node.hasAttribute('data-point')) return node;
      node = node.parentElement;
    }
    return null;
  };
  document.addEventListener('click', function (event) {
    var target = owner(event.target);
    if (!target) return;
    var label = target.getAttribute('data-point-label') || (target.textContent || '').trim().slice(0, 60);
    parent.postMessage({ type: 'quirky-point', key: target.getAttribute('data-point'), label: label }, '*');
  }, true);
})();`

const THEME_TOKENS = ['--ui-surface', '--ui-text', '--ui-muted', '--ui-accent', '--ui-border', '--ui-selected', '--ui-working', '--ui-needs-you', '--ui-failing', '--ui-font-body', '--ui-font-label', '--ui-font-mono']
const SAFE_VALUE = /^[#\w\s(),.%/-]+$/

/** The window's current token values, so a frame can draw in the same theme; a value that is not plain css is left out. */
function themeStyle(): string {
  if (typeof document === 'undefined') return ''
  const style = getComputedStyle(document.documentElement)
  const declarations = THEME_TOKENS.flatMap((name) => {
    const value = style.getPropertyValue(name).trim()
    return SAFE_VALUE.test(value) ? [`${name}:${value}`] : []
  })
  return `:root{${declarations.join(';')}}body{margin:0;background:var(--ui-surface);color:var(--ui-text);font:var(--ui-font-body) system-ui,sans-serif}`
}

/** The frame's document. The CSP meta is the first thing in it, so no agent markup can come before it. */
export function frameDocument(html: string, theme = themeStyle()): string {
  return `<meta http-equiv="Content-Security-Policy" content="${FRAME_CSP}"><style>${theme}</style><script>${FRAME_BRIDGE}</script>${html}`
}

/** The point a `quirky-point` message names, or null when it is not one or its key cannot be pointed at. */
export function pointFromMessage(data: unknown): { element: string; label: string } | null {
  if (typeof data !== 'object' || data === null) return null
  const { type, key, label } = data as { type?: unknown; key?: unknown; label?: unknown }
  if (type !== 'quirky-point' || typeof key !== 'string') return null
  const element = key.startsWith('pt:') && ELEMENT_KEY.test(key) ? key : pointKey('pt', keyPart(key, 'point'))
  return { element, label: clampLabel(typeof label === 'string' && label !== '' ? label : key, 60) }
}

/**
 * Agent html in a frame with an opaque origin, no network and no way to reach Quirky: scripts run
 * only when the node is interactive, and a message counts only when it comes from this frame.
 * A frame that navigates is put back as it was and reported.
 */
export function HtmlFrame({ props }: { props: Props }) {
  const interactive = props.interactive === true
  const height = Math.min(FRAME_HEIGHT.max, Math.max(FRAME_HEIGHT.min, asNumber(props.height) ?? FRAME_HEIGHT.fallback))
  const html = asString(props.html)
  const { point, renderFailed, viewId } = useRuntime()
  const frame = useRef<HTMLIFrameElement>(null)
  const loads = useRef(0)
  const [epoch, setEpoch] = useState(0)
  const srcdoc = useMemo(() => frameDocument(html), [html])

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const target = frame.current?.contentWindow
      if (!target || event.source !== target) return
      const found = pointFromMessage(event.data)
      if (found !== null) point(found.element, found.label)
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [point])

  useEffect(() => {
    loads.current = 0
  }, [srcdoc])

  const loaded = () => {
    loads.current += 1
    if (loads.current <= 1) return
    loads.current = 0
    setEpoch((value) => value + 1)
    renderFailed('navigation is not allowed')
  }

  return (
    <iframe
      key={epoch}
      ref={frame}
      title={`Visual ${viewId}`}
      data-view-node="html"
      sandbox={interactive ? 'allow-scripts' : ''}
      referrerPolicy="no-referrer"
      srcDoc={srcdoc}
      onLoad={loaded}
      style={{ display: 'block', width: '100%', height, border: 'var(--ui-border-width) solid var(--ui-border)', borderRadius: 'var(--ui-radius-control)' }}
    />
  )
}
