import { ChatMarkdown } from '../../markdown'
import { asString, type NodeProps } from './view-prop-readers'
import { useViewRuntime } from './view-runtime'

/** A fence long enough that nothing inside the Mermaid source can close it early. */
export function fenceFor(source: string): string {
  const longest = Math.max(2, ...(source.match(/`+/g) ?? []).map((run) => run.length))
  return '`'.repeat(longest + 1)
}

/**
 * A Mermaid diagram drawn by the same fence renderer chat replies use, so it gets the same strict
 * security level, remote image refusal and svg sanitising; a diagram it refuses shows its source.
 */
export function DiagramNode({ props }: { props: NodeProps }) {
  const source = asString(props.source)
  const caption = asString(props.caption)
  const { openLink } = useViewRuntime()
  const fence = fenceFor(source)
  return (
    <figure data-view-node="diagram" className="native-chat-view-figure">
      <ChatMarkdown text={`${fence}mermaid\n${source}\n${fence}`} onOpenLink={openLink} />
      {caption !== '' && <figcaption className="native-chat-view-muted">{caption}</figcaption>}
    </figure>
  )
}
