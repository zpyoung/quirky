import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { ContextMenuList } from './context-menu'
import type { ContextMenuItem } from './context-menu-contracts'
import type { PopupItem, PopupMenuProps } from './contracts'

type OpenPopup = { close(): void }
let openPopup: OpenPopup | null = null

function toMenuItem(item: PopupItem): ContextMenuItem {
  const { lead, subtitle, selected, trailing, ...rest } = item
  const pill = selected ?? item.checked
  return {
    ...rest,
    icon: lead ?? item.icon,
    detail: subtitle ?? item.detail,
    checked: pill,
    // the list's only right-hand slot that renders a node is the shortcut label, which is typed string
    key: (trailing === undefined ? item.key : <>{trailing}{item.key}</>) as string | null | undefined
  }
}

function matches(item: PopupItem, query: string): boolean {
  return `${item.label}\n${item.subtitle ?? item.detail ?? ''}`.toLowerCase().includes(query)
}

/** Rows matching `query`, with headings and separators kept only where they still frame a row. */
function filterItems(items: readonly PopupItem[], query: string): PopupItem[] {
  const needle = query.trim().toLowerCase()
  if (needle === '') return [...items]
  const kept: PopupItem[] = []
  let pending: PopupItem[] = []
  for (const item of items) {
    if (item.heading || item.separator) {
      pending = item.heading ? [item] : pending.length > 0 && !pending[0]!.heading ? pending : [...pending, item]
      continue
    }
    if (!matches(item, needle)) continue
    kept.push(...(kept.length === 0 ? pending.filter((entry) => !entry.separator) : pending), item)
    pending = []
  }
  return kept
}

function themeScope(anchor: HTMLElement): string | undefined {
  const scope = anchor.closest('[data-theme]')
  return scope && scope !== document.documentElement ? (scope.getAttribute('data-theme') ?? undefined) : undefined
}

/**
 * A popup list anchored under (or above) a control: the shared popup shape for the project and
 * worktree switchers and status bar items. Only one is open at a time; opening another closes the
 * last. Escape closes it and returns focus to `anchor`, as do an outside press or `anchor` leaving
 * the DOM (those two leave focus alone). A `searchPlaceholder` adds a field filtering labels and subtitles.
 */
export function PopupMenu({ anchor, items, title, searchPlaceholder, onClose }: PopupMenuProps) {
  const searchable = searchPlaceholder !== undefined
  const root = useRef<HTMLDivElement>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  const closed = useRef(false)
  const [dismissed, setDismissed] = useState(false)
  const [query, setQuery] = useState('')
  const [position, setPosition] = useState<CSSProperties>({ visibility: 'hidden' })
  const visible = useMemo(() => filterItems(items, query), [items, query])
  const menuItems = useMemo(() => visible.map(toMenuItem), [visible])
  const hasRows = visible.some((item) => !item.heading && !item.separator)

  const dismiss = useCallback((restoreFocus: boolean) => {
    if (closed.current) return
    closed.current = true
    setDismissed(true)
    if (restoreFocus) anchor.focus()
    onCloseRef.current()
  }, [anchor])

  useLayoutEffect(() => {
    const handle: OpenPopup = { close: () => dismiss(false) }
    const previous = openPopup
    openPopup = handle
    previous?.close()
    return () => {
      if (openPopup === handle) openPopup = null
    }
  }, [dismiss])

  useEffect(() => {
    if (!anchor.isConnected) {
      dismiss(false)
      return
    }
    const outside = (event: Event) => {
      const target = event.target
      if (target instanceof Node && !root.current?.contains(target) && !anchor.contains(target)) dismiss(false)
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) dismiss(true)
    }
    const watcher = new MutationObserver(() => {
      if (!anchor.isConnected) dismiss(false)
    })
    watcher.observe(document.documentElement, { childList: true, subtree: true })
    document.addEventListener('pointerdown', outside, true)
    document.addEventListener('mousedown', outside, true)
    document.addEventListener('keydown', escape)
    return () => {
      watcher.disconnect()
      document.removeEventListener('pointerdown', outside, true)
      document.removeEventListener('mousedown', outside, true)
      document.removeEventListener('keydown', escape)
    }
  }, [anchor, dismiss])

  useLayoutEffect(() => {
    const node = root.current
    if (!node || dismissed) return
    const place = () => {
      const target = anchor.getBoundingClientRect()
      const size = node.getBoundingClientRect()
      const below = target.bottom
      const above = target.top - size.height
      const top = below + size.height > window.innerHeight && above >= 0 ? above : below
      setPosition((current) => {
        const next = {
          left: Math.max(0, Math.min(target.left, window.innerWidth - size.width)),
          top: Math.max(0, Math.min(top, window.innerHeight - size.height)),
          maxHeight: window.innerHeight
        }
        return current.left === next.left && current.top === next.top && current.maxHeight === next.maxHeight ? current : next
      })
    }
    place()
    const observer = new ResizeObserver(place)
    observer.observe(node)
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [anchor, dismissed, menuItems])

  if (dismissed) return null
  const label = title ?? searchPlaceholder ?? 'Menu'
  const header = searchable ? (
    <input
      className="ui-text-field__input qt-menu-search"
      autoFocus
      aria-label={searchPlaceholder}
      placeholder={searchPlaceholder}
      value={query}
      onChange={(event) => setQuery(event.target.value)}
    />
  ) : undefined

  return createPortal(
    <div
      ref={root}
      className="ui-popup"
      role={searchable ? 'dialog' : undefined}
      aria-label={searchable ? label : undefined}
      data-theme={themeScope(anchor)}
      style={position}
    >
      {title ? <div className="ui-popup__title">{title}</div> : null}
      <ContextMenuList
        items={menuItems}
        label={label}
        header={header}
        highlightFirst={searchable}
        onClose={() => dismiss(true)}
        onChoose={(item) => {
          dismiss(false)
          item.onSelect?.()
        }}
      />
      {searchable && !hasRows ? <div className="ui-popup__empty">No matches</div> : null}
    </div>,
    document.body
  )
}
