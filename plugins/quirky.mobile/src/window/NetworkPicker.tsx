import { useState } from 'react'
import type { MobileNetworkInterface } from '@quirky/protocol'

type Props = {
  interfaces: MobileNetworkInterface[]
  customAddresses: string[]
  selectedAddress: string
  busy?: boolean
  onSelect(address: string): void
  onRefresh(): Promise<void>
  onAdd(address: string): Promise<void>
  onRemove(address: string): Promise<void>
}
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function NetworkPicker({ interfaces, customAddresses, selectedAddress, busy = false, onSelect, onRefresh, onAdd, onRemove }: Props) {
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const uniqueCustom = customAddresses.filter((address) => !interfaces.some((network) => network.address === address))

  const refresh = async () => {
    try {
      await onRefresh()
      setError(null)
    } catch (reason) {
      setError(messageOf(reason))
    }
  }

  const add = async () => {
    const address = draft.trim()
    if (!address || busy || customAddresses.length >= 50) return
    try {
      await onAdd(address)
      setDraft('')
      setError(null)
    } catch (reason) {
      setError(messageOf(reason))
    }
  }

  const remove = async () => {
    try {
      await onRemove(selectedAddress)
      setError(null)
    } catch (reason) {
      setError(messageOf(reason))
    }
  }

  return (
    <div className="mobile-network">
      <label className="mobile-field">
        This computer’s address
        <select className="mobile-select" aria-label="Network address" value={selectedAddress} disabled={busy} onChange={(event) => onSelect(event.target.value)}>
          <option value="">Choose an address</option>
          {interfaces.map((network, index) => (
            <option key={`${network.name}-${network.address}`} value={network.address}>
              {index === 0 ? 'Recommended · ' : ''}{network.kind} · {network.name} ({network.address})
            </option>
          ))}
          {uniqueCustom.map((address) => (
            <option key={`custom-${address}`} value={address}>Custom · {address}</option>
          ))}
        </select>
      </label>
      {interfaces.length === 0 && uniqueCustom.length === 0 && (
        <p className="mobile-muted">No reachable address is available yet. Connect to Wi-Fi or Tailscale, or add an address manually.</p>
      )}
      <div className="mobile-actions">
        <button className="mobile-button" type="button" disabled={busy} onClick={() => void refresh()}>Refresh network interfaces</button>
        {customAddresses.length > 0 && selectedAddress && customAddresses.includes(selectedAddress) && (
          <button className="mobile-button" type="button" disabled={busy} onClick={() => void remove()}>Remove selected custom address</button>
        )}
      </div>
      <div className="mobile-address-row">
        <label className="mobile-field">
          Add custom address
          <input aria-label="Custom address" maxLength={16384} value={draft} disabled={busy || customAddresses.length >= 50} onChange={(event) => setDraft(event.target.value)} placeholder="host, host:port, or ws(s):// URL" />
        </label>
        <button className="mobile-button" type="button" disabled={busy || !draft.trim() || customAddresses.length >= 50} onClick={() => void add()}>Add custom address</button>
      </div>
      {customAddresses.length >= 50 && <p className="mobile-muted">You can save up to 50 custom addresses. Remove one before adding another.</p>}
      {error && <p className="mobile-error" role="alert">{error}</p>}
    </div>
  )
}
