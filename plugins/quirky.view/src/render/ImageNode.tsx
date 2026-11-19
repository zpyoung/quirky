import { useEffect, useState, type ReactNode } from 'react'
import { InlineError, NoticeLine } from '@quirky/ui'
import { errorText } from './errors'
import { asString, type Props } from './props'
import { useRuntime } from './runtime'
import { MUTED } from './styles'
import { when } from './when'

type ImageState = { kind: 'loading' } | { kind: 'ready'; url: string } | { kind: 'failed'; message: string }

type AssetsReply = { images?: Record<string, string | null> }

/** A worktree image of the visual's session, shown through the same asset resolver chat replies use. */
export function ImageNode({ props }: { props: Props }) {
  const path = asString(props.path)
  const alt = asString(props.alt)
  const caption = asString(props.caption)
  const { context, session, renderFailed } = useRuntime()
  const [state, setState] = useState<ImageState>({ kind: 'loading' })

  useEffect(() => {
    let live = true
    const fail = (message: string) => {
      if (!live) return
      setState({ kind: 'failed', message })
      renderFailed(message)
    }
    setState({ kind: 'loading' })
    if (context === null) {
      fail('no window to resolve the image in')
      return
    }
    void (async () => {
      try {
        const reply = (await context.call('quirky.session/markdownAssets', { session, images: [path] })) as AssetsReply
        const url = reply.images?.[path]
        if (typeof url !== 'string') fail(`${path} is not an image in this worktree`)
        else if (live) setState({ kind: 'ready', url })
      } catch (error) {
        fail(errorText(error))
      }
    })()
    return () => {
      live = false
    }
  }, [context, session, path, renderFailed])

  const picture = (url: string) => (
    <img
      src={url}
      alt={alt}
      data-point-region=""
      onError={() => renderFailed(`${path} could not be drawn`)}
      style={{ display: 'block', maxWidth: '100%', height: 'auto', cursor: 'crosshair' }}
    />
  )
  const body = (): ReactNode => {
    switch (state.kind) {
      case 'loading':
        return <NoticeLine>Loading image…</NoticeLine>
      case 'failed':
        return <InlineError message={`Could not load image: ${state.message}`} />
      default:
        return picture(state.url)
    }
  }
  return (
    <figure data-view-node="image" style={{ margin: 0, display: 'flex', flexDirection: 'column', gap: 'var(--ui-space-4)', minWidth: 0 }}>
      {body()}
      {when(caption !== '', () => <figcaption style={MUTED}>{caption}</figcaption>)}
    </figure>
  )
}
