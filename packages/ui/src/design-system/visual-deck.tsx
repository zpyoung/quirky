import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import { Menu } from './navigation'
import type { MenuEntry } from './contracts'
import { classNames } from './shared'
import { fitDeckTabs, orderDeckEntries, type DeckClosedEntry, type DeckEntry } from './visual-deck-model'

export type VisualDeckTabsProps = {
  label: string
  /** Unordered; the row orders them. */
  entries: readonly DeckEntry[]
  /** Newest closed first in the menu (highest `closedOrder` first). */
  closed: readonly DeckClosedEntry[]
  focusedId: string | null
  dots: ReadonlySet<string>
  onPick(id: string): void
  onClose(id: string): void
  onReopen(id: string): void
}

const MORE_KEY = '__more'

type Measure = { widths: Record<string, number>; more: number; available: number }

const sameMeasure = (a: Measure | null, b: Measure): boolean =>
  a !== null &&
  a.more === b.more &&
  a.available === b.available &&
  Object.keys(b.widths).length === Object.keys(a.widths).length &&
  Object.keys(b.widths).every((id) => a.widths[id] === b.widths[id])

function TabContent({ entry, dot }: { entry: DeckEntry; dot: boolean }) {
  return (
    <>
      <span className="ui-visual-deck__label">{entry.label}</span>
      {dot && <span className="ui-visual-deck__dot" role="img" aria-label="New activity" />}
      {entry.done && <>{' '}<span className="ui-visual-deck__done">done</span></>}
    </>
  )
}

/**
 * The deck's tab row: an underline tablist of the visuals, overflowing by width into a +N menu that
 * also holds the closed visuals. Owns layout and keyboard only; the caller owns focus, dots and what
 * close and reopen mean.
 */
export function VisualDeckTabs({ label, entries, closed, focusedId, dots, onPick, onClose, onReopen }: VisualDeckTabsProps) {
  const rootRef = useRef<HTMLDivElement | null>(null)
  const measureRef = useRef<HTMLDivElement | null>(null)
  const tabRefs = useRef(new Map<string, HTMLButtonElement>())
  const [measure, setMeasure] = useState<Measure | null>(null)
  const ordered = useMemo(() => orderDeckEntries(entries), [entries])

  useLayoutEffect(() => {
    const read = () => {
      const root = rootRef.current
      const row = measureRef.current
      if (!root || !row) return
      const widths: Record<string, number> = {}
      let more = 0
      for (const element of row.querySelectorAll<HTMLElement>('[data-deck-measure]')) {
        const key = element.getAttribute('data-deck-measure') as string
        const width = element.getBoundingClientRect().width
        if (key === MORE_KEY) more = width
        else widths[key] = width
      }
      const next: Measure = { widths, more, available: root.getBoundingClientRect().width }
      setMeasure((previous) => (sameMeasure(previous, next) ? previous : next))
    }
    read()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(read)
    if (rootRef.current) observer.observe(rootRef.current)
    if (measureRef.current) observer.observe(measureRef.current)
    return () => observer.disconnect()
  })

  const fit = useMemo(() => {
    const everything = { visible: ordered.map((entry) => entry.id), hidden: [] as string[] }
    if (!measure || measure.available <= 0) return everything
    const widths = ordered.map((entry) => measure.widths[entry.id] ?? 0)
    if (widths.every((width) => width <= 0)) return everything
    return fitDeckTabs(ordered, widths, measure.available, measure.more, focusedId)
  }, [ordered, measure, focusedId])

  const byId = new Map(ordered.map((entry) => [entry.id, entry]))
  const visible = fit.visible.map((id) => byId.get(id)).filter((entry): entry is DeckEntry => entry !== undefined)
  const hidden = fit.hidden.map((id) => byId.get(id)).filter((entry): entry is DeckEntry => entry !== undefined)

  const selectedIndex = visible.findIndex((entry) => entry.id === focusedId)
  const rovingIndex = selectedIndex >= 0 ? selectedIndex : 0

  const focusAndPick = (index: number) => {
    const target = visible[index]
    if (!target) return
    tabRefs.current.get(target.id)?.focus()
    onPick(target.id)
  }

  const onTabKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number) => {
    let target: number
    if (event.key === 'ArrowRight') target = (index + 1) % visible.length
    else if (event.key === 'ArrowLeft') target = (index - 1 + visible.length) % visible.length
    else if (event.key === 'Home') target = 0
    else if (event.key === 'End') target = visible.length - 1
    else return
    event.preventDefault()
    focusAndPick(target)
  }

  const menuItems: MenuEntry[] = hidden.map((entry) => ({
    id: `hidden:${entry.id}`,
    label: entry.done ? `${entry.label} (done)` : entry.label,
    onAction: () => onPick(entry.id),
  }))
  if (closed.length > 0) {
    if (menuItems.length > 0) menuItems.push({ kind: 'separator', id: 'closed-separator' })
    menuItems.push({ kind: 'note', id: 'closed-heading', label: 'Closed' })
    for (const entry of [...closed].sort((a, b) => b.closedOrder - a.closedOrder)) {
      menuItems.push({ id: `closed:${entry.id}`, label: entry.label, onAction: () => onReopen(entry.id) })
    }
  }
  const showMore = hidden.length > 0 || closed.length > 0

  return (
    <div ref={rootRef} className="ui-visual-deck">
      <div className="ui-visual-deck__tabs" role="tablist" aria-label={label}>
        {visible.map((entry, index) => (
          <div key={entry.id} className="ui-visual-deck__item">
            <button
              ref={(element) => {
                if (element) tabRefs.current.set(entry.id, element)
                else tabRefs.current.delete(entry.id)
              }}
              type="button"
              role="tab"
              data-deck-id={entry.id}
              aria-selected={entry.id === focusedId}
              title={entry.title}
              tabIndex={index === rovingIndex ? 0 : -1}
              className={classNames(
                'ui-visual-deck__tab',
                !entry.pinned && 'ui-visual-deck__tab--closable',
                entry.done && 'ui-visual-deck__tab--done',
              )}
              onClick={() => onPick(entry.id)}
              onKeyDown={(event) => onTabKeyDown(event, index)}
            >
              <TabContent entry={entry} dot={dots.has(entry.id)} />
            </button>
            {!entry.pinned && (
              <button
                type="button"
                className="ui-visual-deck__close"
                aria-label={`Close ${entry.title}`}
                tabIndex={index === rovingIndex ? 0 : -1}
                onClick={() => onClose(entry.id)}
              >
                <span aria-hidden="true">×</span>
              </button>
            )}
          </div>
        ))}
      </div>
      {showMore && (
        <div className="ui-visual-deck__more">
          <Menu
            label={hidden.length > 0 ? `${hidden.length} more visuals` : 'Closed visuals'}
            trigger={hidden.length > 0 ? `+${hidden.length}` : <span aria-hidden="true">▾</span>}
            items={menuItems}
            align="end"
          />
        </div>
      )}
      <div ref={measureRef} className="ui-visual-deck__measure" aria-hidden="true">
        {ordered.map((entry) => (
          <span key={entry.id} className="ui-visual-deck__item" data-deck-measure={entry.id}>
            <span className={classNames('ui-visual-deck__tab', !entry.pinned && 'ui-visual-deck__tab--closable', entry.done && 'ui-visual-deck__tab--done')}>
              <TabContent entry={entry} dot={dots.has(entry.id)} />
            </span>
          </span>
        ))}
        <span className="ui-visual-deck__more-measure ui-menu__trigger" data-deck-measure={MORE_KEY}>+99</span>
      </div>
    </div>
  )
}
