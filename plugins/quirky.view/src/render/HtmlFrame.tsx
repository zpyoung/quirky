import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { asNumber, asString, type Props } from './props'
import { clampLabel, ELEMENT_KEY, keyPart, pointKey } from './point'
import { useRuntime } from './runtime'

const FRAME_HEIGHT = { min: 120, max: 1200, fallback: 240 }

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

/**
 * The wrapper's policy. A frame cannot navigate itself away from a parent whose `frame-src` is
 * `'none'`, and the agent frame inherits this policy, so the media sources repeat the ones in
 * FRAME_CSP.
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

/**
 * Runs in the wrapper: passes a `quirky-point` message from the agent frame, and only that, on to
 * the card, and tells the card when the agent frame loads a second time, which means it navigated.
 */
export const FRAME_RELAY = `(function () {
  var loads = 0;
  window.addEventListener('message', function (event) {
    var inner = document.getElementById('agent');
    var data = event.data;
    if (!inner || event.source !== inner.contentWindow) return;
    if (typeof data !== 'object' || data === null || data.type !== 'quirky-point') return;
    parent.postMessage({ type: 'quirky-point', key: data.key, label: data.label }, '*');
  });
  document.addEventListener('load', function (event) {
    var inner = document.getElementById('agent');
    if (!inner || event.target !== inner) return;
    loads += 1;
    if (loads > 1) parent.postMessage({ type: 'quirky-navigated' }, '*');
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

const escapeAttribute = (text: string): string => text.replace(/&/g, '&amp;').replace(/"/g, '&quot;')

/**
 * The document the card's frame holds: the policy first, the relay, and the agent's frame filling
 * the page. The agent frame is nested so that its navigation is refused before any request is made.
 */
export function wrapperDocument(inner: string, interactive: boolean): string {
  const sandbox = interactive ? 'allow-scripts' : ''
  return `<meta http-equiv="Content-Security-Policy" content="${WRAPPER_CSP}"><style>html,body{margin:0;height:100%;overflow:hidden}iframe{display:block;width:100%;height:100%;border:0}</style><script>${FRAME_RELAY}</script><iframe id="agent" sandbox="${sandbox}" srcdoc="${escapeAttribute(inner)}"></iframe>`
}

/** The point a `quirky-point` message names, or null when it is not one or its key cannot be pointed at. */
export function pointFromMessage(data: unknown): { element: string; label: string } | null {
  if (typeof data !== 'object' || data === null) return null
  const { type, key, label } = data as { type?: unknown; key?: unknown; label?: unknown }
  if (type !== 'quirky-point' || typeof key !== 'string') return null
  const element = key.startsWith('pt:') && ELEMENT_KEY.test(key) ? key : pointKey('pt', keyPart(key, 'point'))
  return { element, label: clampLabel(typeof label === 'string' && label !== '' ? label : key, 60) }
}

/** Whether a message is the wrapper saying the agent frame navigated away. */
export const isNavigatedMessage = (data: unknown): boolean => typeof data === 'object' && data !== null && (data as { type?: unknown }).type === 'quirky-navigated'

/**
 * Agent html in a frame with an opaque origin, no network and no way to reach Quirky: scripts run
 * only when the node is interactive, and a message counts only when it comes from this frame.
 * The agent's frame sits inside a Quirky-owned wrapper frame that forbids it to navigate; a card
 * frame that navigates anyway is put back as it was and reported.
 */
export function HtmlFrame({ props }: { props: Props }) {
  const interactive = props.interactive === true
  const height = Math.min(FRAME_HEIGHT.max, Math.max(FRAME_HEIGHT.min, asNumber(props.height) ?? FRAME_HEIGHT.fallback))
  const html = asString(props.html)
  const { point, renderFailed, viewId } = useRuntime()
  const frame = useRef<HTMLIFrameElement>(null)
  const loads = useRef(0)
  const [epoch, setEpoch] = useState(0)
  const srcdoc = useMemo(() => wrapperDocument(frameDocument(html), interactive), [html, interactive])

  const reset = useCallback(() => {
    loads.current = 0
    setEpoch((value) => value + 1)
    renderFailed('navigation is not allowed')
  }, [renderFailed])

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const target = frame.current?.contentWindow
      if (!target || event.source !== target) return
      if (isNavigatedMessage(event.data)) return reset()
      const found = pointFromMessage(event.data)
      if (found !== null) point(found.element, found.label)
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [point, reset])

  useEffect(() => {
    loads.current = 0
  }, [srcdoc])

  const loaded = () => {
    loads.current += 1
    if (loads.current > 1) reset()
  }

  return (
    <iframe
      key={epoch}
      ref={frame}
      title={`Visual ${viewId}`}
      data-view-node="html"
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      srcDoc={srcdoc}
      onLoad={loaded}
      style={{ display: 'block', width: '100%', height, border: 'var(--ui-border-width) solid var(--ui-border)', borderRadius: 'var(--ui-radius-control)' }}
    />
  )
}
