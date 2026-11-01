import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { CSSProperties } from 'react'
import type { PopoverProps } from './contracts'

/** Nonmodal anchored dialog that receives focus on open, without a focus trap or backdrop. */
export function Popover({ open, label, anchor, boundary, onClose, children }: PopoverProps) {
  const root = useRef<HTMLDivElement>(null)
  const wasOpen = useRef(false)
  const opener = useRef<HTMLElement | null>(null)
  const close = useRef(onClose)
  close.current = onClose
  const [position, setPosition] = useState<CSSProperties>({ visibility: 'hidden' })
  if (open && !wasOpen.current) {
    opener.current = typeof document !== 'undefined' && document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null
  }
  wasOpen.current = open
  useLayoutEffect(() => {
    if (!open) return
    const update = () => {
      const node = root.current
      const target = anchor.current
      if (!node || !target) return
      const box = target.getBoundingClientRect()
      const bound = boundary?.getBoundingClientRect()
      const left = Math.max(0, bound?.left ?? 0)
      const right = Math.min(window.innerWidth, bound?.right ?? window.innerWidth)
      const top = Math.max(0, bound?.top ?? 0)
      const bottom = Math.min(window.innerHeight, bound?.bottom ?? window.innerHeight)
      const width = Math.max(0, right - left)
      const height = Math.max(0, bottom - top)
      node.style.maxWidth = `${width}px`
      node.style.maxHeight = `${height}px`
      const size = node.getBoundingClientRect()
      setPosition({
        maxWidth: width,
        maxHeight: height,
        left: Math.max(left, Math.min(box.left, right - size.width)),
        top: Math.max(top, Math.min(box.bottom, bottom - size.height)),
      })
    }
    update()
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => { window.removeEventListener('resize', update); window.removeEventListener('scroll', update, true) }
  }, [open, anchor, boundary, children])
  useEffect(() => {
    if (!open || position.visibility === 'hidden') return
    const node = root.current
    if (!node?.contains(document.activeElement)) node?.focus()
  }, [open, position.visibility])
  useEffect(() => {
    if (!open) return
    const node = root.current
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !anchor.current?.contains(event.target) && !root.current?.contains(event.target)) close.current()
    }
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        if (node?.contains(document.activeElement)) opener.current?.focus()
        close.current()
      }
    }
    document.addEventListener('pointerdown', outside, true)
    document.addEventListener('keydown', keydown, true)
    return () => { document.removeEventListener('pointerdown', outside, true); document.removeEventListener('keydown', keydown, true) }
  }, [open, anchor])
  return open ? createPortal(<div ref={root} className="ui-popover ui-stack" role="dialog" aria-label={label} tabIndex={-1} style={position}>{children}</div>, document.body) : null
}
