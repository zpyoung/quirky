import { Button, Dialog, InlineError, NoticeLine, TextField, ToolPanelFrame, uiTokens } from '@quirky/ui'
import { useEffect, useState } from 'react'
import type { MobilePairingResult, UiPluginContext } from '@quirky/protocol'
import { COPY_PAIRING_CODE_COMMAND, showPairingCode } from './pairing-code'

type AvailableOffer = Extract<MobilePairingResult, { available: true }>

type PairingPanelProps = {
  context: UiPluginContext
  offer: MobilePairingResult | null
  busy: boolean
  buttonLabel: string
  onGenerate(rotate: boolean): Promise<void>
}

function QrPreview({ src, onEnlarge }: { src: string; onEnlarge(): void }) {
  return (
    <Button aria-label="Enlarge pairing QR code" onClick={onEnlarge}>
      <img
        src={src}
        alt="Pairing QR code"
        style={{ width: `calc(var(${uiTokens.row.double}) * 6)`, maxWidth: '100%' }}
      />
    </Button>
  )
}

function QrDialog({ offer, open, onClose }: { offer: AvailableOffer | null; open: boolean; onClose(): void }) {
  return (
    <Dialog
      open={open && Boolean(offer?.qrDataUrl)}
      title="Enlarged pairing QR code"
      onClose={onClose}
      actions={<Button onClick={onClose}>Close</Button>}
    >
      {offer?.qrDataUrl && (
        <div className="ui-stack">
          <img
            src={offer.qrDataUrl}
            alt="Pairing QR code"
            style={{ width: `calc(var(${uiTokens.row.double}) * 12)`, maxWidth: '100%' }}
          />
          <pre className="ui-readout">{offer.endpoint}</pre>
        </div>
      )}
    </Dialog>
  )
}

export function PairingPanel({ context, offer, busy, buttonLabel, onGenerate }: PairingPanelProps) {
  const [enlarged, setEnlarged] = useState(false)
  const [copyNotice, setCopyNotice] = useState<string | null>(null)
  const [copyError, setCopyError] = useState<string | null>(null)
  const available = offer?.available === true ? offer : null
  const unavailable = offer !== null && !offer.available ? offer : null
  const pairingUrl = available?.pairingUrl ?? null

  useEffect(() => {
    setEnlarged(false)
    setCopyNotice(null)
    setCopyError(null)
  }, [pairingUrl])

  useEffect(() => {
    if (pairingUrl === null) return
    return showPairingCode(pairingUrl)
  }, [pairingUrl])

  const copy = async () => {
    if (!available) return
    setCopyNotice(null)
    setCopyError(null)
    try {
      await context.executeCommand(COPY_PAIRING_CODE_COMMAND, { pairingUrl: available.pairingUrl }, { activateOwner: false })
      setCopyNotice('Pairing code copied.')
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason)
      setCopyError(`Copy failed: ${message}`)
    }
  }

  return (
    <ToolPanelFrame title="Phone pairing">
      <div className="ui-stack">
        <p className="ui-text-muted">Open Quirky Mobile and scan this code. Pairing is direct over your selected LAN or Tailscale address.</p>
        {unavailable && <InlineError message={unavailable.guidance} />}
        {available && (
          <div className="ui-stack">
            {available.qrDataUrl ? (
              <QrPreview src={available.qrDataUrl} onEnlarge={() => setEnlarged(true)} />
            ) : (
              <InlineError message="This pairing code couldn’t be rendered as a QR code. Copy it into Quirky Mobile instead." />
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
              <Button disabled={busy} onClick={() => onGenerate(true)}>Regenerate code</Button>
            </div>
            {copyNotice && <p className="ui-text-muted" role="status">{copyNotice}</p>}
            {copyError && <InlineError message={copyError} />}
          </div>
        )}
        {!available && (
          <div className="ui-cluster">
            <Button variant="primary" disabled={busy} onClick={() => onGenerate(false)}>{busy ? 'Generating…' : buttonLabel}</Button>
          </div>
        )}
        {available && busy && <NoticeLine>Generating…</NoticeLine>}
        <QrDialog offer={available} open={enlarged} onClose={() => setEnlarged(false)} />
      </div>
    </ToolPanelFrame>
  )
}
