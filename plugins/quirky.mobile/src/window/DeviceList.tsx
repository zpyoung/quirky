import { useState } from 'react'
import type { MobileDevice, UiPluginContext } from '@quirky/protocol'
import { revokeMobileDevice } from './api'
import { pairedDateLabel } from './date'

type Props = {
  context: UiPluginContext
  devices: MobileDevice[]
  onChanged(): Promise<void>
}

export function DeviceList({ context, devices, onChanged }: Props) {
  const [busyDevice, setBusyDevice] = useState<string | null>(null)
  const [feedback, setFeedback] = useState<{ kind: 'success' | 'error'; message: string } | null>(null)

  const revoke = async (device: MobileDevice) => {
    setBusyDevice(device.deviceId)
    setFeedback(null)
    try {
      await revokeMobileDevice(context, device.deviceId)
      setFeedback({ kind: 'success', message: 'Device revoked.' })
      try {
        await onChanged()
      } catch (reason) {
        const message = reason instanceof Error ? reason.message : String(reason)
        setFeedback({ kind: 'error', message: `Device revoked, but the paired-device list could not refresh: ${message}` })
      }
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason)
      setFeedback({ kind: 'error', message: `Failed to revoke device: ${message}` })
    } finally {
      setBusyDevice(null)
    }
  }

  return (
    <section className="mobile-card" aria-label="Paired devices">
      <h2>Paired Devices</h2>
      {devices.length === 0 ? (
        <p className="mobile-muted">No devices paired yet.</p>
      ) : (
        <div className="mobile-device-list" role="list">
          {devices.map((device) => (
            <div className="mobile-device" key={device.deviceId} role="listitem">
              <div>
                <div className="mobile-device-name">{device.name || 'Phone'}</div>
                <div className="mobile-device-meta">{pairedDateLabel(device.pairedAt)}</div>
              </div>
              <button className="mobile-button danger" type="button" aria-label={`Revoke device ${device.name || 'Phone'}`} disabled={busyDevice !== null} onClick={() => void revoke(device)}>
                {busyDevice === device.deviceId ? 'Revoking…' : 'Revoke device'}
              </button>
            </div>
          ))}
        </div>
      )}
      {feedback && <p className={feedback.kind === 'error' ? 'mobile-error' : 'mobile-success'} role={feedback.kind === 'error' ? 'alert' : 'status'}>{feedback.message}</p>}
      <p className="mobile-muted">Revoking a device disconnects it immediately.</p>
    </section>
  )
}
