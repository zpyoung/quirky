import { useEffect, useRef, useState } from 'react'
import { Button, EmptyState, FormRow, InlineError, NoticeLine, ToolPanelFrame } from '@quirky/ui'
import type { UiPluginContext } from '@quirky/protocol'
import type { EmulatorDevice, EmulatorFrame, EmulatorListing } from '../emulator'

/** Mounted only while its hosted tab is visible; polling never boots or controls a simulator. */
export function EmulatorView({ context, input, report }: { context: UiPluginContext; input?: unknown; report?(state: unknown): void }) {
  const requested = typeof input === 'object' && input !== null && 'device' in input && typeof input.device === 'string' ? input.device : ''
  const [devices, setDevices] = useState<EmulatorDevice[]>([])
  const [selected, setSelected] = useState(requested)
  const [frame, setFrame] = useState<EmulatorFrame | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [revision, setRevision] = useState(0)
  const sequence = useRef(0)
  const listSequence = useRef(0)
  const device = devices.find((entry) => entry.id === selected)

  async function loadDevices() {
    const attempt = ++listSequence.current
    setLoading(true)
    setError(null)
    try {
      const listing = await context.call('quirky.terminal/emulators', {}) as EmulatorListing
      if (attempt !== listSequence.current) return
      setDevices(listing.devices)
      if (!listing.available) setError(listing.reason ?? 'iOS Simulator is unavailable.')
    } catch (reason: unknown) {
      if (attempt === listSequence.current) setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      if (attempt === listSequence.current) setLoading(false)
    }
  }

  function refresh() {
    setFrame(null)
    setRevision((value) => value + 1)
    void loadDevices()
  }

  useEffect(() => {
    void loadDevices()
    return () => { listSequence.current++ }
  }, [context])

  useEffect(() => {
    const attempt = ++sequence.current
    let active = true
    let timer: number | undefined
    setFrame(null)
    if (!selected || device?.state !== 'Booted') return () => { active = false }
    const capture = async () => {
      try {
        const next = await context.call('quirky.terminal/emulatorFrame', { device: selected }) as EmulatorFrame
        if (!active || attempt !== sequence.current) return
        if (next.device !== selected || next.mime !== 'image/png') throw new Error('Simulator frame belongs to a different device.')
        setFrame(next)
        setError(null)
        timer = window.setTimeout(() => void capture(), 1000)
      } catch (reason) {
        if (active && attempt === sequence.current) setError(reason instanceof Error ? reason.message : String(reason))
      }
    }
    void capture()
    return () => { active = false; window.clearTimeout(timer) }
  }, [context, selected, device?.state, revision])

  useEffect(() => { report?.({ selected: selected || null, device: device ?? null, loading, error, capturedAt: frame?.capturedAt ?? null }) }, [report, selected, device, loading, error, frame?.capturedAt])

  return (
    <div className="tt-tool-panel-fill tt-emulator-panel" data-terminal-emulator>
      <ToolPanelFrame title="Mobile Emulator" actions={<Button disabled={loading} onClick={refresh}>Refresh</Button>}>
        <div className="tt-emulator-layout">
          <FormRow label="iOS Simulator" htmlFor="terminal-emulator-device">
            <select
              id="terminal-emulator-device"
              className="ui-text-field__input"
              aria-label="Simulator device"
              value={selected}
              onChange={(event) => { setError(null); setSelected(event.target.value) }}
              disabled={loading}
            >
              <option value="">Choose a simulator</option>
              {devices.map((entry) => <option key={entry.id} value={entry.id}>{entry.name} · {entry.state}</option>)}
            </select>
          </FormRow>
          <p className="ui-text-muted">Read-only preview of the exact selected Xcode simulator. Start it in Simulator; agents keep their own control tools. Hidden tabs stop polling.</p>
          {loading ? <div role="status"><NoticeLine>Loading simulators…</NoticeLine></div> : null}
          {error ? <InlineError message={error} action={{ label: 'Retry', onAction: refresh }} /> : null}
          {!loading && devices.length === 0 && !error ? (
            <EmptyState
              message="No available iOS simulators. Install a simulator runtime in Xcode, then Refresh."
              action={{ label: 'Refresh', onAction: refresh }}
            />
          ) : null}
          {selected && !device && !loading ? <p className="ui-text-muted">The selected simulator is no longer available. Choose another device explicitly.</p> : null}
          {device && device.state !== 'Booted' ? <p className="ui-text-muted">{device.name} is {device.state}. Start this exact device in Simulator, then Refresh.</p> : null}
          {device?.state === 'Booted' && !frame && !error ? <div role="status"><NoticeLine>Capturing {device.name}…</NoticeLine></div> : null}
          {frame ? <small className="ui-text-muted">Last frame: {new Date(frame.capturedAt).toLocaleTimeString()}{error ? ' · Preview paused; Refresh to retry.' : ''}</small> : null}
          {frame ? <img className="tt-emulator-frame" alt={`Preview of ${device?.name ?? frame.device}`} src={`data:image/png;base64,${frame.data}`} /> : null}
        </div>
      </ToolPanelFrame>
    </div>
  )
}
