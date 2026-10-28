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
    <section className="mobile-card" aria-label="Phone pairing">
      <h2>Pair a phone</h2>
      <p className="mobile-muted">Open Quirky Mobile and scan this code. Pairing is direct over your selected LAN or Tailscale address.</p>
      {error && <p className="mobile-error" role="alert">{error}</p>}
      {unavailable && <p className="mobile-error" role="alert">{unavailable.guidance}</p>}
      {available && (
        <div className="mobile-pairing">
          <div>
            {available.qrDataUrl ? (
              <button className="mobile-qr-button" type="button" aria-label="Enlarge pairing QR code" onClick={() => setEnlarged(true)}>
                <img className="mobile-qr" src={available.qrDataUrl} alt="Pairing QR code" />
              </button>
            ) : (
              <p className="mobile-callout" role="status">This pairing code couldn’t be rendered as a QR code. Copy it into Quirky Mobile instead.</p>
            )}
          </div>
          <div>
            <p><strong>Endpoint</strong><br /><code>{available.endpoint}</code></p>
            <label className="mobile-field">
              Pairing code URL
              <input className="mobile-pairing-url" aria-label="Pairing code URL" readOnly value={available.pairingUrl} onFocus={(event) => event.currentTarget.select()} />
            </label>
            <div className="mobile-actions">
              <button className="mobile-button primary" type="button" onClick={() => void copy()}>Copy pairing code</button>
              <button className="mobile-button" type="button" disabled={busy} onClick={() => void onGenerate(true)}>Regenerate code</button>
            </div>
            {copyStatus && <p className={copyStatus.startsWith('Copy failed:') ? 'mobile-error' : 'mobile-success'} role={copyStatus.startsWith('Copy failed:') ? 'alert' : 'status'}>{copyStatus}</p>}
            {available.qrError === 'encoding_failed' && <p className="mobile-error" role="alert">QR encoding failed; the pairing URL is still available to copy.</p>}
          </div>
        </div>
      )}
      {!available && (
        <div className="mobile-actions">
          <button className="mobile-button primary" type="button" disabled={busy} onClick={() => void onGenerate(false)}>{busy ? 'Generating…' : buttonLabel}</button>
        </div>
      )}
      {available && busy && <p className="mobile-muted" role="status">Generating…</p>}
      {enlarged && available?.qrDataUrl && (
        <div className="mobile-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setEnlarged(false) }}>
          <div className="mobile-modal" role="dialog" aria-modal="true" aria-label="Enlarged pairing QR code">
            <button className="mobile-button" type="button" aria-label="Close enlarged QR code" onClick={() => setEnlarged(false)}>Close</button>
            <img src={available.qrDataUrl} alt="Pairing QR code" />
            <code>{available.endpoint}</code>
          </div>
        </div>
      )}
    </section>
  )
}
