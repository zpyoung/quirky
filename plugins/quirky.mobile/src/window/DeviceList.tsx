import { Button, EmptyState, ListRow, ToolPanelFrame } from '@quirky/ui'
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
    <ToolPanelFrame title="Paired devices">
      <div className="ui-stack">
        {devices.length === 0 ? (
          <EmptyState message="No devices paired yet." />
        ) : (
          <div className="ui-stack" role="list">
            {devices.map((device) => (
              <div key={device.deviceId} role="listitem">
                <ListRow
                  title={device.name || 'Phone'}
                  description={pairedDateLabel(device.pairedAt)}
                  trailing={(
                    <Button
                      variant="destructive"
                      aria-label={`Revoke device ${device.name || 'Phone'}`}
                      disabled={busyDevice !== null}
                      onClick={() => void revoke(device)}
                    >
                      {busyDevice === device.deviceId ? 'Revoking…' : 'Revoke device'}
                    </Button>
                  )}
                />
              </div>
            ))}
          </div>
        )}
        {feedback && (
          <p className={feedback.kind === 'error' ? 'ui-error-text' : 'ui-text-muted'} role={feedback.kind === 'error' ? 'alert' : 'status'}>
            {feedback.message}
          </p>
        )}
        <p className="ui-text-muted">Revoking a device disconnects it immediately.</p>
      </div>
    </ToolPanelFrame>
  )
}
