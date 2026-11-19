import { useEffect, type RefObject } from 'react'

/** The element key shape `chat-point` accepts, and the longest label it keeps. */
export const ELEMENT_KEY = /^[a-z0-9][a-z0-9._:-]{0,79}$/
const MAX_LABEL = 120
const MAX_PART = 40
const POINT_KEY = 'data-point-key'
const POINT_LABEL = 'data-point-label'
const POINT_REGION = 'data-point-region'
const CONTROLS = 'button,a,input,textarea,select,summary'
const REGION_KEY = /^region:(\d{1,3})-(\d{1,3})$/
const MARKER = 'data-point-marker'
const GLOW = 'drop-shadow(0 0 var(--ui-space-2) var(--ui-accent))'

export type Point = { element: string; label: string }

/** A lowercase fragment of `text` that is safe inside an element key, or `fallback` when nothing is left. */
export function keyPart(text: string, fallback: string): string {
  const slug = text.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[-._]+|-+$/g, '').slice(0, MAX_PART)
  return slug === '' ? fallback : slug
}

/** Joins key fragments under a kind prefix, for example `pointKey('cell', 'patch', 'codex')` is `cell:patch:codex`. */
export const pointKey = (prefix: string, ...parts: string[]): string => [prefix, ...parts].join(':').slice(0, 80)

/** One-line label of at most 120 characters. */
export function clampLabel(text: string, max = MAX_LABEL): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length <= max ? line : `${line.slice(0, max - 1)}…`
}

const percent = (offset: number, size: number): number => (size > 0 ? Math.min(100, Math.max(0, Math.round((offset / size) * 100))) : 0)

/**
 * The element a click or key press points at: the nearest ancestor that names itself with a
 * `data-point-key`, else a `data-point-region` image at the clicked spot. A control inside the
 * pointed-at element keeps its own click.
 */
export function pointAt(target: EventTarget | null, at?: { clientX: number; clientY: number }): Point | null {
  if (!(target instanceof Element)) return null
  const named = target.closest(`[${POINT_KEY}]`)
  const control = target.closest(CONTROLS)
  if (control !== null && (named === null || named.contains(control)) && control !== named) return null
  if (named !== null) {
    const element = named.getAttribute(POINT_KEY) ?? ''
    return ELEMENT_KEY.test(element) ? { element, label: clampLabel(named.getAttribute(POINT_LABEL) ?? named.textContent ?? element) } : null
  }
  const region = target.closest(`[${POINT_REGION}]`)
  if (region === null || at === undefined) return null
  const box = region.getBoundingClientRect()
  const x = percent(at.clientX - box.left, box.width)
  const y = percent(at.clientY - box.top, box.height)
  return { element: `region:${x}-${y}`, label: `region near ${x}%,${y}%` }
}

function newMarker(): HTMLElement {
  const marker = document.createElement('span')
  marker.setAttribute(MARKER, '')
  marker.setAttribute('aria-hidden', 'true')
  Object.assign(marker.style, {
    position: 'absolute',
    width: 'var(--ui-space-16)',
    height: 'var(--ui-space-16)',
    transform: 'translate(-50%, -50%)',
    borderRadius: '50%',
    borderWidth: 'var(--ui-focus-width)',
    borderStyle: 'solid',
    borderColor: 'var(--ui-accent)',
    pointerEvents: 'none'
  })
  return marker
}

/** Puts the ring at `at` percent of `image`, inside the image's parent so it moves with the picture. */
function placeMarker(host: HTMLElement, image: HTMLElement, at: RegExpExecArray): void {
  host.style.position = getComputedStyle(host).position === 'static' ? 'relative' : host.style.position
  const marker = host.querySelector<HTMLElement>(`:scope > [${MARKER}]`) ?? host.appendChild(newMarker())
  marker.style.left = `${image.offsetLeft + (Number(at[1]) / 100) * image.offsetWidth}px`
  marker.style.top = `${image.offsetTop + (Number(at[2]) / 100) * image.offsetHeight}px`
}

/** Rings the selected image region: the one last clicked, else the first image of the card. */
function markRegion(root: HTMLElement, region: Element | null, selected: string | null): void {
  const at = selected === null ? null : REGION_KEY.exec(selected)
  const image = at === null ? null : region ?? root.querySelector(`[${POINT_REGION}]`)
  const host = image instanceof HTMLElement ? image.parentElement : null
  const stale = [...root.querySelectorAll(`[${MARKER}]`)].filter((marker) => marker.parentElement !== host)
  stale.forEach((marker) => marker.remove())
  void (at !== null && image instanceof HTMLElement && host !== null && placeMarker(host, image, at))
}

/**
 * Outlines the pointed-at element inside `host`, rings the clicked spot of an image region, and
 * gives every pointable element a pointer cursor, also as the content changes. `region` holds
 * the image the last click landed on.
 */
export function usePointStyles(host: RefObject<HTMLElement | null>, selected: string | null, region: RefObject<Element | null>): void {
  useEffect(() => {
    const root = host.current
    if (root === null) return
    const apply = () => {
      for (const element of root.querySelectorAll<HTMLElement | SVGElement>(`[${POINT_KEY}]`)) {
        const on = element.getAttribute(POINT_KEY) === selected
        element.style.cursor = 'pointer'
        if (element instanceof SVGElement) element.style.filter = on ? GLOW : ''
        else {
          element.style.outlineWidth = on ? 'var(--ui-focus-width)' : ''
          element.style.outlineStyle = on ? 'solid' : ''
          element.style.outlineColor = on ? 'var(--ui-accent)' : ''
        }
        if (element.closest('[aria-hidden="true"],[role="img"]') === null) element.tabIndex = 0
      }
      markRegion(root, region.current !== null && root.contains(region.current) ? region.current : null, selected)
    }
    apply()
    const observer = new MutationObserver(apply)
    observer.observe(root, { childList: true, subtree: true })
    return () => {
      observer.disconnect()
      root.querySelectorAll(`[${MARKER}]`).forEach((marker) => marker.remove())
    }
  }, [host, selected, region])
}
