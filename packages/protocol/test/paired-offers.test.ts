import { describe, expect, test } from 'bun:test'
import type { OwnerCliPairOffer } from '../src/runtime-owner'
import { parseMobileOffer, parseOwnerCliOffer } from '../src/paired-client/offers'

const ownerOffer = {
  v: 2,
  endpoint: 'ws://192.0.2.17:6768',
  deviceToken: 'a'.repeat(48),
  publicKeyB64: Buffer.alloc(32, 1).toString('base64'),
  pairedDeviceId: '123e4567-e89b-42d3-a456-426614174000',
  scope: 'owner-cli'
} satisfies OwnerCliPairOffer

function encodeOffer(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url')
}

describe('owner-cli pairing offers', () => {
  test('parses an exact full-owner offer while the mobile parser refuses it', () => {
    expect(parseOwnerCliOffer(encodeOffer(ownerOffer))).toEqual(ownerOffer)
    expect(() => parseMobileOffer(encodeOffer(ownerOffer))).toThrow(/mobile v2 offer/)
  })

  test('rejects extra or forged role fields instead of interpreting them as owner scope', () => {
    expect(() => parseOwnerCliOffer(encodeOffer({ ...ownerOffer, role: 'cli' }))).toThrow(/owner-cli v2 offer/)
    expect(() => parseOwnerCliOffer(encodeOffer({ ...ownerOffer, scope: 'mobile' }))).toThrow(/owner-cli v2 offer/)
  })
})
