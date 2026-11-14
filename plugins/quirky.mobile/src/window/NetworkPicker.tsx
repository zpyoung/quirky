import { Button, EmptyState, InlineError, SelectField, TextField } from '@quirky/ui'
import { useState } from 'react'
import type { MobileNetworkInterface } from '@quirky/protocol'
import type { MobileData } from './useMobileState'

type Props = {
  mobile: Pick<MobileData, 'refreshInterfaces' | 'configure'>
  interfaces: MobileNetworkInterface[]
  customAddresses: string[]
  selectedAddress: string
  busy?: boolean
  onAddressChange(address: string): void
}
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function NetworkPicker({ mobile, interfaces, customAddresses, selectedAddress, busy = false, onAddressChange }: Props) {
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const uniqueCustom = customAddresses.filter((address) => !interfaces.some((network) => network.address === address))
  const full = customAddresses.length >= 50
  const refresh = async () => {
    try {
      const nextInterfaces = await mobile.refreshInterfaces()
      if (!nextInterfaces.some((item) => item.address === selectedAddress) && !customAddresses.includes(selectedAddress)) {
        onAddressChange(nextInterfaces[0]?.address ?? customAddresses[0] ?? '')
      }
      setError(null)
    } catch (reason) {
      setError(messageOf(reason))
    }
  }

  const add = async () => {
    const address = draft.trim()
    const current = customAddresses
    if (!address || busy || full) return
    if (current.includes(address)) {
      onAddressChange(address)
      setDraft('')
      setError(null)
      return
    }
    try {
      const next = await mobile.configure({ customAddresses: [...current, address] })
      if (!next.customAddresses.includes(address)) throw new Error('The address was not saved.')
      onAddressChange(address)
      setDraft('')
      setError(null)
    } catch (reason) {
      setError(messageOf(reason))
    }
  }

  const remove = async () => {
    try {
      const next = await mobile.configure({
        customAddresses: customAddresses.filter((address) => address !== selectedAddress)
      })
      onAddressChange(next.interfaces[0]?.address ?? next.customAddresses[0] ?? '')
      setError(null)
    } catch (reason) {
      setError(messageOf(reason))
    }
  }
  return (
    <div className="ui-stack">
      <SelectField
        label="This computer’s address"
        aria-label="Network address"
        value={selectedAddress}
        disabled={busy}
        onChange={(event) => onAddressChange(event.target.value)}
      >
        <option value="">Choose an address</option>
        {interfaces.map((network, index) => (
          <option key={`${network.name}-${network.address}`} value={network.address}>
            {index === 0 ? 'Recommended · ' : ''}{network.kind} · {network.name} ({network.address})
          </option>
        ))}
        {uniqueCustom.map((address) => (
          <option key={`custom-${address}`} value={address}>Custom · {address}</option>
        ))}
      </SelectField>
      {interfaces.length === 0 && uniqueCustom.length === 0 && (
        <EmptyState message="No reachable address is available yet. Connect to Wi-Fi or Tailscale, or add an address manually." />
      )}
      <div className="ui-cluster">
        <Button disabled={busy} onClick={() => void refresh()}>Refresh network interfaces</Button>
        {customAddresses.length > 0 && selectedAddress && customAddresses.includes(selectedAddress) && (
          <Button disabled={busy} onClick={() => void remove()}>Remove selected custom address</Button>
        )}
      </div>
      <TextField
        label="Add custom address"
        aria-label="Custom address"
        maxLength={16384}
        value={draft}
        disabled={busy || full}
        onChange={(event) => setDraft(event.target.value)}
        placeholder="host, host:port, or ws(s):// URL"
      />
      <div className="ui-cluster">
        <Button disabled={busy || !draft.trim() || full} onClick={() => void add()}>Add custom address</Button>
      </div>
      {full && <p className="ui-text-muted">You can save up to 50 custom addresses. Remove one before adding another.</p>}
      {error && <InlineError message={error} />}
    </div>
  )
}
