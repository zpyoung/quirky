import { Children, cloneElement, isValidElement, useContext } from 'react'
import type { ComponentProps, ReactElement, ReactNode } from 'react'
import type { ExtraProps } from 'streamdown'
import { InsideBlockquoteContext } from '../runtime'

const ALERT_MARKER = /^\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*\n?/i
const ICONS: Record<string, string> = { note: 'ⓘ', tip: '✦', important: '◆', warning: '⚠︎', caution: '✕' }

type Paragraph = ReactElement<{ children?: ReactNode }>

function firstParagraphIndex(children: ReactNode[]): number {
  return children.findIndex((child) => isValidElement(child))
}

/** The alert type and the first paragraph without its marker, or null when the blockquote is not an alert. */
function readAlert(children: ReactNode): { type: string; paragraph: Paragraph | null; index: number; rest: ReactNode[] } | null {
  const all = Children.toArray(children)
  const index = firstParagraphIndex(all)
  if (index < 0) return null
  const paragraph = all[index] as Paragraph
  const inner = Children.toArray(paragraph.props.children)
  const head = inner[0]
  if (typeof head !== 'string') return null
  const marker = ALERT_MARKER.exec(head)
  if (!marker) return null
  const remainder = head.slice(marker[0].length)
  const tail = inner.slice(1)
  // remark-breaks turns the newline after the marker into a <br>, which would lead the body
  const bodyStart = remainder === '' && isValidElement(tail[0]) && (tail[0] as ReactElement).type === 'br' ? 1 : 0
  const body = [...(remainder === '' ? [] : [remainder]), ...tail.slice(bodyStart)]
  return {
    type: marker[1].toLowerCase(),
    paragraph: body.length === 0 ? null : cloneElement(paragraph, { children: body }),
    index,
    rest: all
  }
}

/** The blockquote component: a GitHub alert when its first paragraph opens with a marker, otherwise a plain quote. */
export function Blockquote({ children, node: _node, ...rest }: ComponentProps<'blockquote'> & ExtraProps) {
  const nested = useContext(InsideBlockquoteContext)
  const alert = nested ? null : readAlert(children)
  if (!alert) {
    return (
      <InsideBlockquoteContext.Provider value>
        <blockquote data-streamdown="blockquote" {...rest}>{children}</blockquote>
      </InsideBlockquoteContext.Provider>
    )
  }
  const content = alert.rest.map((child, position) => (position === alert.index ? alert.paragraph : child))
  const label = alert.type.charAt(0).toUpperCase() + alert.type.slice(1)
  return (
    <InsideBlockquoteContext.Provider value>
      <div className="qmd-alert" data-alert={alert.type} role="note">
        <div className="qmd-alert-label">
          <span className="qmd-alert-icon" aria-hidden="true">{ICONS[alert.type]}</span>
          <span>{label}</span>
        </div>
        <div className="qmd-alert-body">{content}</div>
      </div>
    </InsideBlockquoteContext.Provider>
  )
}
