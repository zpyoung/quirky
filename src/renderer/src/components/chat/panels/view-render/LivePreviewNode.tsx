import { ExternalLink } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { localPreviewUrl } from './local-preview-url'
import { asString, type NodeProps } from './view-prop-readers'
import { useViewRuntime } from './view-runtime'

/** A localhost page the agent started; it opens in the app's browser tab rather than inside the chat. */
export function LivePreviewNode({ props }: { props: NodeProps }) {
  const raw = asString(props.url)
  const caption = asString(props.caption)
  const { openPreview } = useViewRuntime()
  const url = localPreviewUrl(raw)
  return (
    <figure data-view-node="live-preview" className="native-chat-view-figure">
      <div className="native-chat-view-row native-chat-view-between">
        <span className="native-chat-view-mono">{raw}</span>
        {url !== null && (
          <Button size="xs" variant="outline" onClick={() => openPreview(url)}>
            <ExternalLink />
            Open preview
          </Button>
        )}
      </div>
      {url === null && (
        <p role="alert" className="native-chat-view-error">
          Only localhost and 127.0.0.1 previews can open.
        </p>
      )}
      {caption !== '' && <figcaption className="native-chat-view-muted">{caption}</figcaption>}
    </figure>
  )
}
