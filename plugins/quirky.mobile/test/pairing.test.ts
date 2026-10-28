import { describe, expect, test } from 'bun:test'
import { createPairingResult } from '../src/daemon/pairing'

const record = { deviceId: '12345678-1234-4234-8234-123456789abc', token: '0123456789abcdef0123456789abcdef0123456789abcdef' }

describe('mobile pairing offer', () => {
  test('encodes the direct v2 Quirky offer as an unpadded base64url query value', async () => {
    const result = await createPairingResult({ device: record, endpoint: 'ws://192.0.2.4:6768', publicKeyB64: Buffer.alloc(32, 7).toString('base64') }, async () => ({ dataUrl: 'data:image/png;base64,QR', size: 132 }))
    expect(result).toMatchObject({ available: true, endpoint: 'ws://192.0.2.4:6768', deviceId: record.deviceId, connectionMode: 'local-only', qrDataUrl: 'data:image/png;base64,QR', qrSize: 132 })
    if (!result.available) throw new Error(result.guidance)
    const code = new URL(result.pairingUrl).searchParams.get('code')!
    expect(code).not.toContain('=')
    expect(JSON.parse(Buffer.from(code, 'base64url').toString('utf8'))).toEqual({
      v: 2, endpoint: 'ws://192.0.2.4:6768', deviceToken: record.token,
      publicKeyB64: Buffer.alloc(32, 7).toString('base64'), pairedDeviceId: record.deviceId, scope: 'mobile'
    })
  })

  test('keeps a copyable valid URL when QR rendering fails', async () => {
    const result = await createPairingResult({ device: record, endpoint: 'ws://127.0.0.1:6768', publicKeyB64: Buffer.alloc(32, 7).toString('base64') }, async () => { throw new Error('renderer failed') })
    expect(result.available).toBe(true)
    if (!result.available) throw new Error(result.guidance)
    expect(result.qrDataUrl).toBeNull()
    expect(result.qrSize).toBeNull()
    expect(result.qrError).toBe('encoding_failed')
    expect(new URL(result.pairingUrl).searchParams.get('code')).toBeTruthy()
  })
})
