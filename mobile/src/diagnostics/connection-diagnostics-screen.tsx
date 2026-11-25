import { useCallback, useState, type ReactNode } from 'react'
import { ConnectionDiagnosticsView } from './connection-diagnostics-view'
import { diagnoseConnection } from './connection-diagnostics-analysis'
import type { DiagnosticsDeviceOperations } from './diagnostics-device-operations'
import type {
  ConnectionLogEntry,
  ConnectionState,
  MobileConnectionDiagnosticPath
} from '../transport/types'

export function ConnectionDiagnosticsScreen({
  device,
  host,
  state,
  reconnectAttempts,
  activePath,
  pendingPath,
  entries,
  writeClipboard,
  onBack,
  hostPicker
}: {
  device: DiagnosticsDeviceOperations | null
  /** Null only when no host is paired; an empty name or endpoint is still a host. */
  host: { id: string; name: string; endpoint: string } | null
  state: ConnectionState
  reconnectAttempts: number
  activePath?: MobileConnectionDiagnosticPath
  pendingPath?: MobileConnectionDiagnosticPath | null
  entries: readonly ConnectionLogEntry[]
  writeClipboard: (report: string) => Promise<unknown>
  onBack: () => void
  hostPicker?: ReactNode
}) {
  const [copiedHostId, setCopiedHostId] = useState<string | null>(null)

  const diagnosisArgs = host
    ? { endpoint: host.endpoint, state, activePath, pendingPath, entries }
    : null
  const diagnosis = diagnosisArgs ? diagnoseConnection(diagnosisArgs) : null
  const hostId = host?.id ?? null
  const copied = copiedHostId !== null && copiedHostId === hostId

  const copyDiagnostics = useCallback(async () => {
    if (!device || !hostId) {
      return
    }
    const { report } = await device.report()
    await writeClipboard(report)
    setCopiedHostId(hostId)
    setTimeout(() => setCopiedHostId((current) => (current === hostId ? null : current)), 2000)
  }, [device, hostId, writeClipboard])

  return (
    <ConnectionDiagnosticsView
      hasHost={host !== null}
      hostName={host?.name ?? ''}
      state={state}
      reconnectAttempts={reconnectAttempts}
      entries={entries}
      diagnosis={diagnosis}
      copied={copied}
      copyDiagnostics={copyDiagnostics}
      onBack={onBack}
      hostPicker={hostPicker}
    />
  )
}
