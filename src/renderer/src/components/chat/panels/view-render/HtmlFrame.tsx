import { translate } from '@/i18n/i18n'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { isNavigatedMessage, frameDocument, wrapperDocument } from './html-frame-document'

const FRAME_HEIGHT = { min: 120, max: 1200, fallback: 240 }

/**
 * Agent html in a frame with an opaque origin, no network and no way to reach Quirky: scripts run
 * only when the node is interactive. The agent's frame sits inside a Quirky-owned wrapper frame that
 * forbids it to navigate; a frame that navigates anyway is put back as it was.
 */
export function HtmlFrame({
  html,
  interactive,
  height,
  title
}: {
  html: string
  interactive: boolean
  height?: number
  title: string
}) {
  const frame = useRef<HTMLIFrameElement>(null)
  const loads = useRef(0)
  const [epoch, setEpoch] = useState(0)
  const [navigated, setNavigated] = useState(false)
  const shown = Math.min(
    FRAME_HEIGHT.max,
    Math.max(FRAME_HEIGHT.min, height ?? FRAME_HEIGHT.fallback)
  )
  const srcDoc = useMemo(
    () => wrapperDocument(frameDocument(html), interactive),
    [html, interactive]
  )

  const reset = useCallback(() => {
    loads.current = 0
    setNavigated(true)
    setEpoch((value) => value + 1)
  }, [])

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const target = frame.current?.contentWindow
      if (target && event.source === target && isNavigatedMessage(event.data)) {
        reset()
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [reset])

  useEffect(() => {
    loads.current = 0
  }, [srcDoc])

  return (
    <>
      <iframe
        key={epoch}
        ref={frame}
        title={title}
        data-view-node="html"
        className="native-chat-view-frame"
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        srcDoc={srcDoc}
        style={{ height: shown }}
        onLoad={() => {
          loads.current += 1
          if (loads.current > 1) {
            reset()
          }
        }}
      />
      {navigated && (
        <p className="native-chat-view-error">
          {translate(
            'components.chat.viewRender.pageNavigated',
            'The page tried to navigate and was reset.'
          )}
        </p>
      )}
    </>
  )
}
