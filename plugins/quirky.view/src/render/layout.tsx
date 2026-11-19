import type { ReactNode } from 'react'
import { SectionHeader } from '@quirky/ui'
import { asString, type Props } from './props'
import { COLUMN } from './styles'

export function Stack({ children }: { children: ReactNode }) {
  return <div data-view-node="stack" style={COLUMN}>{children}</div>
}

export function Columns({ count, children }: { count: number; children: ReactNode }) {
  return (
    <div
      data-view-node="columns"
      style={{ display: 'grid', gridTemplateColumns: `repeat(${Math.max(1, count)}, minmax(0, 1fr))`, gap: 'var(--ui-space-12)', alignItems: 'start', minWidth: 0 }}
    >
      {children}
    </div>
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
