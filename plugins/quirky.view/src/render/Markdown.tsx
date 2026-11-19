import { QuirkyMarkdown } from '@quirky/ui/markdown'
import { asString, type Props } from './props'
import { useRuntime } from './runtime'
import { COLUMN } from './styles'

export function Markdown({ props }: { props: Props }) {
  const { openLink: onLink } = useRuntime()
  return (
    <div data-view-node="markdown" style={{ ...COLUMN, gap: 'var(--ui-space-8)', overflowWrap: 'anywhere' }}>
      <QuirkyMarkdown text={asString(props.text)} profile="untrusted" onOpenLink={onLink} />
    </div>
  )
}
