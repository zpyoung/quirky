import { Button, Dialog, TextField, ToolPanelFrame, uiTokens } from '@quirky/ui'
import { useEffect, useState } from 'react'
import type { MobilePairingResult } from '@quirky/protocol'

type Props = {
  offer: MobilePairingResult | null
  busy: boolean
  error: string | null
  buttonLabel: string
  onGenerate(rotate: boolean): Promise<void>
}

export function PairingPanel({ offer, busy, error, buttonLabel, onGenerate }: Props) {
  const [enlarged, setEnlarged] = useState(false)
  const [copyStatus, setCopyStatus] = useState<string | null>(null)
  const available = offer?.available === true ? offer : null
  const unavailable = offer !== null && !offer.available ? offer : null
  useEffect(() => {
    setEnlarged(false)
    setCopyStatus(null)
  }, [available?.pairingUrl])

  const copy = async () => {
    if (!available) return
    try {
      const clipboard = globalThis.navigator?.clipboard
      if (!clipboard?.writeText) throw new Error('Clipboard access is unavailable. Select the pairing code below and copy it manually.')
      await clipboard.writeText(available.pairingUrl)
      setCopyStatus('Pairing code copied.')
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason)
      setCopyStatus(`Copy failed: ${message}`)
    }
  }

  return (
    <ToolPanelFrame title="Phone pairing">
      <div className="ui-stack">
        <p className="ui-text-muted">Open Quirky Mobile and scan this code. Pairing is direct over your selected LAN or Tailscale address.</p>
        {error && <p className="ui-error-text" role="alert">{error}</p>}
        {unavailable && <p className="ui-error-text" role="alert">{unavailable.guidance}</p>}
        {available && (
          <div className="ui-stack">
            {available.qrDataUrl ? (
              <Button aria-label="Enlarge pairing QR code" onClick={() => setEnlarged(true)}>
                <img
                  src={available.qrDataUrl}
                  alt="Pairing QR code"
                  style={{ width: `calc(var(${uiTokens.row.double}) * 6)`, maxWidth: '100%' }}
                />
              </Button>
            ) : (
              <p className="ui-text-muted" role="status">This pairing code couldn’t be rendered as a QR code. Copy it into Quirky Mobile instead.</p>
            )}
            <p><strong>Endpoint</strong></p>
            <pre className="ui-readout">{available.endpoint}</pre>
            <TextField
              label="Pairing code URL"
              readOnly
              value={available.pairingUrl}
              onFocus={(event) => event.currentTarget.select()}
            />
            <div className="ui-cluster">
              <Button variant="primary" onClick={() => void copy()}>Copy pairing code</Button>
              <Button disabled={busy} onClick={() => void onGenerate(true)}>Regenerate code</Button>
            </div>
            {copyStatus && (
              <p className={copyStatus.startsWith('Copy failed:') ? 'ui-error-text' : 'ui-text-muted'} role={copyStatus.startsWith('Copy failed:') ? 'alert' : 'status'}>
                {copyStatus}
              </p>
            )}
            {available.qrError === 'encoding_failed' && <p className="ui-error-text" role="alert">QR encoding failed; the pairing URL is still available to copy.</p>}
          </div>
        )}
        {!available && (
          <div className="ui-cluster">
            <Button variant="primary" disabled={busy} onClick={() => void onGenerate(false)}>{busy ? 'Generating…' : buttonLabel}</Button>
          </div>
        )}
        {available && busy && <p className="ui-text-muted" role="status">Generating…</p>}
        <Dialog
          open={enlarged && Boolean(available?.qrDataUrl)}
          title="Enlarged pairing QR code"
          onClose={() => setEnlarged(false)}
          actions={<Button onClick={() => setEnlarged(false)}>Close</Button>}
        >
          {available?.qrDataUrl && (
            <div className="ui-stack">
              <img
                src={available.qrDataUrl}
                alt="Pairing QR code"
                style={{ width: `calc(var(${uiTokens.row.double}) * 12)`, maxWidth: '100%' }}
              />
              <pre className="ui-readout">{available.endpoint}</pre>
            </div>
          )}
        </Dialog>
      </div>
    </ToolPanelFrame>
  )
}
