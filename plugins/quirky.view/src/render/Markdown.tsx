import { useMemo } from 'react'
import { renderMarkdown } from '../markdown'
import { asString, type Props } from './props'
import { useRuntime } from './runtime'
import { COLUMN } from './styles'

export function Markdown({ props }: { props: Props }) {
  const { openLink } = useRuntime()
  const text = asString(props.text)
  const body = useMemo(() => renderMarkdown(text, openLink), [text, openLink])
  return <div data-view-node="markdown" style={{ ...COLUMN, gap: 'var(--ui-space-8)', overflowWrap: 'anywhere' }}>{body}</div>
}
