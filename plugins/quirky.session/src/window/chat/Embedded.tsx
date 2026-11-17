import { useEffect, useRef, useState, type CSSProperties } from 'react'
import type { UiPluginContext } from '@quirky/protocol'

const quiet = { color: 'var(--ui-muted)', fontSize: 'var(--ui-font-label)' } satisfies CSSProperties
const host = { display: 'flex', flexDirection: 'column', minWidth: 0 } satisfies CSSProperties

/**
 * Mounts another plugin's view with `input` and unmounts it when this element goes away or the
 * input changes. A view the window doesn't have (its plugin is off) leaves `fallback` in place,
 * so the transcript still reads.
 */
export function Embedded({
  context,
  viewId,
  input,
  fallback = 'This item is not available.',
  style
}: {
  context: UiPluginContext
  viewId: string
  input: unknown
  fallback?: string
  style?: CSSProperties
}) {
  const element = useRef<HTMLDivElement>(null)
  const [missing, setMissing] = useState(false)
  const key = JSON.stringify(input)

  useEffect(() => {
    const target = element.current
    if (!target) return
    setMissing(false)
    let unmount: (() => void) | undefined
    try {
      unmount = context.mountView(viewId, target, JSON.parse(key))
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      if (!reason.startsWith('no contribution')) context.log(`could not mount ${viewId}: ${reason}`)
      setMissing(true)
    }
    return () => {
      if (unmount) queueMicrotask(unmount)
    }
  }, [context, viewId, key])

  if (missing) return <div role="note" style={quiet}>{fallback}</div>
  return <div ref={element} data-embedded={viewId} style={{ ...host, ...style }} />
}
