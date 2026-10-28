import QRCode from 'qrcode'
import type { MobilePairingResult } from '@quirky/protocol'
import type { MobileDeviceRecord } from './storage'

export type PairingDevice = Pick<MobileDeviceRecord, 'deviceId' | 'token'>
export type QrResult = { dataUrl: string; size: number }
export type QrRenderer = (url: string) => Promise<QrResult>

const qrRenderer: QrRenderer = async (url) => {
  const symbol = QRCode.create(url, { errorCorrectionLevel: 'M' })
  const dataUrl = await QRCode.toDataURL(url, { errorCorrectionLevel: 'M', margin: 4, scale: 2 })
  return { dataUrl, size: (symbol.modules.size + 8) * 2 }
}

export async function createPairingResult(
  input: { device: PairingDevice; endpoint: string; publicKeyB64: string },
  renderQr: QrRenderer = qrRenderer
): Promise<MobilePairingResult> {
  const offer = {
    v: 2 as const,
    endpoint: input.endpoint,
    deviceToken: input.device.token,
    publicKeyB64: input.publicKeyB64,
    pairedDeviceId: input.device.deviceId,
    scope: 'mobile' as const
  }
  const code = Buffer.from(JSON.stringify(offer)).toString('base64url')
  const pairingUrl = `quirky://pair?code=${code}`
  try {
    const qr = await renderQr(pairingUrl)
    return {
      available: true,
      pairingUrl,
      endpoint: input.endpoint,
      deviceId: input.device.deviceId,
      connectionMode: 'local-only',
      qrDataUrl: qr.dataUrl,
      qrSize: qr.size
    }
  } catch {
    return {
      available: true,
      pairingUrl,
      endpoint: input.endpoint,
      deviceId: input.device.deviceId,
      connectionMode: 'local-only',
      qrDataUrl: null,
      qrSize: null,
      qrError: 'encoding_failed'
    }
  }
}
