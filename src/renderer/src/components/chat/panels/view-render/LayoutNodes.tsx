import type { ReactNode } from 'react'
import { asString, type NodeProps } from './view-prop-readers'

export function StackNode({ children }: { children: ReactNode }) {
  return (
    <div data-view-node="stack" className="native-chat-view-column">
      {children}
    </div>
  )
}

export function ColumnsNode({ count, children }: { count: number; children: ReactNode }) {
  return (
    <div
      data-view-node="columns"
      className="native-chat-view-columns"
      style={{ gridTemplateColumns: `repeat(${Math.max(1, count)}, minmax(0, 1fr))` }}
    >
      {children}
    </div>
  )
}

export function SectionNode({ props, children }: { props: NodeProps; children: ReactNode }) {
  const title = asString(props.title)
  return (
    <section data-view-node="section" aria-label={title} className="native-chat-view-column">
      <h4 className="native-chat-view-section-title">{title}</h4>
      {children}
    </section>
  )
}
