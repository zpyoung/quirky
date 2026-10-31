import { createSelectionOverlay, selectionOverlayStyles } from '@quirky/ui/selection-overlay'
import { elementAtPoint, OVERLAY_ATTRIBUTE, resolveTarget, type Target } from './target'

const STOPPED = new Set(['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'dblclick', 'auxclick', 'contextmenu'])
const OBSERVED = [...STOPPED, 'pointermove', 'mousemove']

export type PickerHandlers = {
  pick(target: Target): boolean
  escape(): void
}

export type Picker = {
  host: HTMLElement
  /** While suspended the host is hidden and every event passes through untouched. */
  setSuspended(suspended: boolean): void
  setSelection(target: Target | null): void
  focus(): void
  dispose(): void
}

/**
 * A full-window selection surface in the host document. It owns the pointer: events aimed at its
 * host stop before the app sees them, except while Option is held, when the host lets them through.
 * Its caller owns placement, the Esc policy and what a selection means.
 */
export function createPicker(doc: Document, handlers: PickerHandlers): Picker {
  const win = doc.defaultView!
  const { host, surface, highlight, label } = createSelectionOverlay(doc, selectionOverlayStyles)
  let held = false
  let suspended = false
  let selected: Target | null = null
  let lastPointer: MouseEvent | null = null

  const hideHighlight = () => {
    highlight.hidden = true
    label.hidden = true
  }

  function drawTarget(target: Target) {
    const box = target.element.getBoundingClientRect()
    if (box.width <= 0 || box.height <= 0) return hideHighlight()
    Object.assign(highlight.style, { left: `${box.left}px`, top: `${box.top}px`, width: `${box.width}px`, height: `${box.height}px` })
    label.textContent = target.label
    Object.assign(label.style, { left: '0px', top: '0px' })
    highlight.hidden = false
    label.hidden = false
    const size = label.getBoundingClientRect()
    const above = box.top - size.height
    const top = Math.min(Math.max(above >= 0 ? above : box.top, 0), Math.max(win.innerHeight - size.height, 0))
    const left = Math.min(Math.max(box.left, 0), Math.max(win.innerWidth - size.width, 0))
    Object.assign(label.style, { left: `${left}px`, top: `${top}px` })
  }

  const setHeld = (next: boolean) => {
    if (held === next) return
    held = next
    for (const element of [host, surface]) element.style.setProperty('pointer-events', next ? 'none' : 'auto', 'important')
    if (next) hideHighlight()
    else if (!suspended && selected !== null) drawTarget(selected)
  }

  const follow = (event: MouseEvent) => {
    lastPointer = event
    if (selected !== null) return drawTarget(selected)
    const element = elementAtPoint(doc, event.clientX, event.clientY)
    if (element === null) return hideHighlight()
    drawTarget(resolveTarget(element))
  }

  const select = (event: MouseEvent) => {
    lastPointer = event
    const element = elementAtPoint(doc, event.clientX, event.clientY)
    if (element === null) return
    const target = resolveTarget(element)
    if (handlers.pick(target)) {
      selected = target
      drawTarget(target)
    }
  }

  const onPointer = (event: Event) => {
    if (suspended) return
    const pointer = event as MouseEvent
    const missedKeyup = held && !pointer.altKey
    setHeld(pointer.altKey)
    // the host was still pass-through when this event was aimed, so it landed on the app
    if (missedKeyup && STOPPED.has(pointer.type) && !(pointer.target instanceof Element && pointer.target.closest(`[${OVERLAY_ATTRIBUTE}]`) !== null)) {
      pointer.stopImmediatePropagation()
      pointer.preventDefault()
      return
    }
    if (pointer.target !== host) return
    if (STOPPED.has(pointer.type)) {
      pointer.stopImmediatePropagation()
      pointer.preventDefault()
    }
    if (held) return
    if (pointer.type === 'pointermove') follow(pointer)
    else if (pointer.type === 'click' && pointer.button === 0) select(pointer)
  }

  const onKey = (event: Event) => {
    if (suspended) return
    const press = event as KeyboardEvent
    setHeld(press.altKey)
    if (press.type !== 'keydown' || press.key !== 'Escape') return
    press.preventDefault()
    press.stopPropagation()
    handlers.escape()
  }

  const onBlur = () => setHeld(false)

  for (const type of OBSERVED) win.addEventListener(type, onPointer, true)
  win.addEventListener('keydown', onKey, true)
  win.addEventListener('keyup', onKey, true)
  win.addEventListener('blur', onBlur)

  return {
    host,
    setSuspended(next) {
      suspended = next
      if (next) {
        hideHighlight()
        host.style.setProperty('display', 'none', 'important')
      } else {
        host.style.removeProperty('display')
        surface.focus()
        if (!held && selected !== null) drawTarget(selected)
      }
    },
    setSelection(target) {
      selected = target
      if (suspended || held) hideHighlight()
      else if (target === null) {
        if (lastPointer === null) hideHighlight()
        else follow(lastPointer)
      } else drawTarget(target)
    },
    focus: () => surface.focus(),
    dispose() {
      for (const type of OBSERVED) win.removeEventListener(type, onPointer, true)
      win.removeEventListener('keydown', onKey, true)
      win.removeEventListener('keyup', onKey, true)
      win.removeEventListener('blur', onBlur)
      host.remove()
    }
  }
}
