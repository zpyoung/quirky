import { useEffect, useRef, useState } from 'react'
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
  const device = devices.find((entry) => entry.id === selected)

  useEffect(() => {
    let active = true
    setLoading(true)
    setError(null)
    void context.call('quirky.terminal/emulators', {}).then((value) => {
      if (!active) return
      const listing = value as EmulatorListing
      setDevices(listing.devices)
      if (!listing.available) setError(listing.reason ?? 'iOS Simulator is unavailable.')
    }).catch((reason: unknown) => {
      if (active) setError(reason instanceof Error ? reason.message : String(reason))
    }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [context, revision])

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

  return <section aria-label="Mobile Emulator" style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden', padding: 12, boxSizing: 'border-box', gap: 10 }}>
    <header style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
      <strong>Mobile Emulator</strong>
      <label>iOS Simulator <select aria-label="Simulator device" value={selected} onChange={(event) => { setError(null); setSelected(event.target.value) }} disabled={loading}>
        <option value="">Choose a simulator</option>
        {devices.map((entry) => <option key={entry.id} value={entry.id}>{entry.name} · {entry.state}</option>)}
      </select></label>
      <button type="button" disabled={loading} onClick={() => setRevision((value) => value + 1)}>Refresh</button>
    </header>
    <small>Read-only preview of the exact selected Xcode simulator. Start it in Simulator; agents keep their own control tools. Hidden tabs stop polling.</small>
    {loading ? <p role="status">Loading simulators…</p> : null}
    {error ? <p role="alert">{error}</p> : null}
    {!loading && devices.length === 0 && !error ? <p>No available iOS simulators. Install a simulator runtime in Xcode, then Refresh.</p> : null}
    {selected && !device && !loading ? <p>The selected simulator is no longer available. Choose another device explicitly.</p> : null}
    {device && device.state !== 'Booted' ? <p>{device.name} is {device.state}. Start this exact device in Simulator, then Refresh.</p> : null}
    {device?.state === 'Booted' && !frame && !error ? <p role="status">Capturing {device.name}…</p> : null}
    {frame ? <small>Last frame: {new Date(frame.capturedAt).toLocaleTimeString()}{error ? ' · Preview paused; Refresh to retry.' : ''}</small> : null}
    {frame ? <img alt={`Preview of ${device?.name ?? frame.device}`} src={`data:image/png;base64,${frame.data}`} style={{ minHeight: 0, maxWidth: '100%', flex: '1 1 0', objectFit: 'contain', alignSelf: 'center' }} /> : null}
  </section>
}
