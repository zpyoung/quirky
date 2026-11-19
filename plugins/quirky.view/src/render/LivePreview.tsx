import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react'
import { ControlIcon, IconButton, InlineError, NoticeLine } from '@quirky/ui'
import { errorText } from './errors'
import { claimPreview, releasePreview, rememberHandle, residentPreview, subscribePreview } from './previews'
import { asString, type Props } from './props'
import { useRuntime } from './runtime'
import { MONO, MUTED, ROW } from './styles'
import { when } from './when'

const PARTITION = 'persist:quirky-browser-default'
const OPEN_IN_PANE = 'command:quirky.browser/new-tab'

/**
 * The worktree's dev server through the native browser. The window has one native view, so only
 * the focused or expanded preview holds it; every other card shows its URL and a Show button.
 * Where there is no native browser the card offers to open the URL in a browser pane instead.
 */
export function LivePreview({ props }: { props: Props }) {
  const url = asString(props.url)
  const caption = asString(props.caption)
  const { context, surface, focused, control } = useRuntime()
  const id = useId()
  const host = useRef<HTMLDivElement>(null)
  const resident = useSyncExternalStore(subscribePreview, residentPreview)
  const [mountError, setMountError] = useState<string | null>(null)
  const native = context?.nativeBrowser
  const interactive = surface !== 'thumbnail'
  const available = interactive && native?.available === true
  const wants = focused || surface === 'expanded' || surface === 'window'
  const holds = available && resident === id

  useEffect(() => {
    if (!available) return
    if (residentPreview() === null) claimPreview(id)
    return () => releasePreview(id)
  }, [available, id])

  useEffect(() => {
    if (available && wants) claimPreview(id)
  }, [available, wants, id])

  useEffect(() => {
    const element = host.current
    if (!holds || element === null || native === undefined) return
    setMountError(null)
    try {
      const handle = native.mount(element, { id, url, zoom: 0, partition: PARTITION, onState: () => {} })
      rememberHandle(id, handle)
      return () => {
        rememberHandle(id, null)
        handle.dispose()
      }
    } catch (error) {
      setMountError(errorText(error))
    }
  }, [holds, native, url, id])

  const openInPane = async (): Promise<void> => {
    try {
      await context?.executeCommand(OPEN_IN_PANE, { url })
    } catch (error) {
      context?.toast('Could not open the browser pane', errorText(error))
    }
  }

  return (
    <figure data-view-node="live-preview" style={{ margin: 0, display: 'flex', flexDirection: 'column', gap: 'var(--ui-space-4)', minWidth: 0 }}>
      <div style={{ ...ROW, justifyContent: 'space-between' }}>
        <span style={{ ...MONO, overflowWrap: 'anywhere' }}>{url}</span>
        {when(holds, () => (
          <IconButton label="Reload preview" onClick={() => control({ action: 'reload-preview', node: id })}>
            <ControlIcon name="arrows-clockwise" />
          </IconButton>
        ))}
      </div>
      <div ref={host} style={{ display: holds ? 'block' : 'none', height: 'calc(var(--ui-row-double) * 8)', minWidth: 0 }} />
      {when(mountError !== null, () => <InlineError message={`Could not show the page: ${mountError}`} />)}
      {when(available && !holds, () => (
        <NoticeLine actions={[{ label: 'Show', onAction: () => control({ action: 'show-preview', node: id }) }]}>The browser view is on another preview.</NoticeLine>
      ))}
      {when(interactive && !available, () => (
        <NoticeLine actions={[{ label: 'Open in browser pane', onAction: () => void openInPane() }]}>Live previews need the desktop app.</NoticeLine>
      ))}
      {when(caption !== '', () => <figcaption style={MUTED}>{caption}</figcaption>)}
    </figure>
  )
}
