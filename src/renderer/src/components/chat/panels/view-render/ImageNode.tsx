import { translate } from '@/i18n/i18n'
import { useEffect, useState } from 'react'
import { asString, type NodeProps } from './view-prop-readers'
import { useViewRuntime } from './view-runtime'
import { resolveWorkspaceImagePath } from './workspace-image-path'

type ImageState =
  | { kind: 'loading' }
  | { kind: 'ready'; url: string }
  | { kind: 'failed'; message: string }

/** A workspace image: the path must stay inside the workspace, or an error tile shows instead. */
export function ImageNode({ props }: { props: NodeProps }) {
  const path = asString(props.path)
  const alt = asString(props.alt)
  const caption = asString(props.caption)
  const { workspaceRoot, readWorkspaceImage } = useViewRuntime()
  const [state, setState] = useState<ImageState>({ kind: 'loading' })

  useEffect(() => {
    let live = true
    const resolved = resolveWorkspaceImagePath(workspaceRoot, path)
    if (!resolved.ok) {
      setState({ kind: 'failed', message: resolved.reason })
      return
    }
    setState({ kind: 'loading' })
    readWorkspaceImage(resolved.relativePath).then(
      (image) => {
        if (live) {
          setState({ kind: 'ready', url: image.dataUrl })
        }
      },
      (error: unknown) => {
        if (live) {
          setState({
            kind: 'failed',
            message: error instanceof Error ? error.message : String(error)
          })
        }
      }
    )
    return () => {
      live = false
    }
  }, [workspaceRoot, path, readWorkspaceImage])

  return (
    <figure data-view-node="image" className="native-chat-view-figure">
      {state.kind === 'loading' && (
        <p className="native-chat-view-muted">
          {translate('components.chat.viewRender.loadingImage', 'Loading image…')}
        </p>
      )}
      {state.kind === 'failed' && (
        <p role="alert" className="native-chat-view-error" data-image-error>
          {translate(
            'components.chat.viewRender.imageFailed',
            'Could not show {{target}}: {{message}}',
            {
              target: path || translate('components.chat.viewRender.theImage', 'the image'),
              message: state.message
            }
          )}
        </p>
      )}
      {state.kind === 'ready' && (
        <img src={state.url} alt={alt} className="native-chat-view-image" />
      )}
      {caption !== '' && <figcaption className="native-chat-view-muted">{caption}</figcaption>}
    </figure>
  )
}
