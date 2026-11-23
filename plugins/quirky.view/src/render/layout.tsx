import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { SectionHeader } from '@quirky/ui'
import { asString, type Props } from './props'
import { COLUMN } from './styles'

export function Stack({ children }: { children: ReactNode }) {
  return <div data-view-node="stack" style={COLUMN}>{children}</div>
}

/** The narrowest a board or columns track gets before the visual scrolls sideways instead. */
export const MIN_TRACK = 'calc(var(--ui-length-unit) * 160)'

const SCROLL_FADE: CSSProperties = {
  position: 'absolute',
  insetBlock: 0,
  insetInlineEnd: 0,
  width: 'var(--ui-row-double)',
  background: 'linear-gradient(to right, var(--ui-transparent), var(--ui-surface))',
  pointerEvents: 'none'
}

/** Scrolls its children sideways when they are wider than the space, with a fade on the right edge while there is more to see. */
export function ScrollX({ node, style, children }: { node: string; style: CSSProperties; children: ReactNode }) {
  const scroller = useRef<HTMLDivElement>(null)
  const [more, setMore] = useState(false)
  const measure = useCallback(() => {
    const element = scroller.current
    if (element) setMore(element.scrollLeft + element.clientWidth < element.scrollWidth - 1)
  }, [])
  useEffect(() => {
    measure()
    const element = scroller.current
    if (!element || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    for (const child of Array.from(element.children)) observer.observe(child)
    return () => observer.disconnect()
  }, [measure])
  return (
    <div style={{ position: 'relative', minWidth: 0 }}>
      <div ref={scroller} data-view-node={node} onScroll={measure} style={{ ...style, overflowX: 'auto', minWidth: 0 }}>
        {children}
      </div>
      {more && <div data-view-scroll-fade aria-hidden="true" style={SCROLL_FADE} />}
    </div>
  )
}

export function Columns({ count, children }: { count: number; children: ReactNode }) {
  return (
    <ScrollX
      node="columns"
      style={{ display: 'grid', gridTemplateColumns: `repeat(${Math.max(1, count)}, minmax(${MIN_TRACK}, 1fr))`, gap: 'var(--ui-space-12)', alignItems: 'start' }}
    >
      {children}
    </ScrollX>
  )
}

export function Section({ props, children }: { props: Props; children: ReactNode }) {
  const title = asString(props.title)
  return (
    <section data-view-node="section" aria-label={title} style={COLUMN}>
      <SectionHeader title={title} />
      {children}
    </section>
  )
}
