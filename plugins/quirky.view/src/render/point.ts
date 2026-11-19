import { useEffect, type RefObject } from 'react'

/** The element key shape `chat-point` accepts, and the longest label it keeps. */
export const ELEMENT_KEY = /^[a-z0-9][a-z0-9._:-]{0,79}$/
const MAX_LABEL = 120
const MAX_PART = 40
const POINT_KEY = 'data-point-key'
const POINT_LABEL = 'data-point-label'
const POINT_REGION = 'data-point-region'
const CONTROLS = 'button,a,input,textarea,select,summary'
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

/** Outlines the pointed-at element inside `host` and gives every pointable element a pointer cursor, also as the content changes. */
export function usePointStyles(host: RefObject<HTMLElement | null>, selected: string | null): void {
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
    }
    apply()
    const observer = new MutationObserver(apply)
    observer.observe(root, { childList: true, subtree: true })
    return () => observer.disconnect()
  }, [host, selected])
}
