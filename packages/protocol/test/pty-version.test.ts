import { describe, expect, test } from 'bun:test'
import {
  PTY_PROTOCOL_MIN_VERSION,
  PTY_PROTOCOL_VERSION,
  negotiatePtyVersion,
  parsePtyVersionRejection,
  ptyVersionRejection,
  type PtyRequest
} from '../src/pty'

describe('PTY protocol version negotiation', () => {
  test('selects the highest version in both supported ranges', () => {
    const host = { min: 4, max: 6 }
    expect(negotiatePtyVersion({ version: 6 }, host)).toBe(6)
    expect(negotiatePtyVersion({ version: 5 }, host)).toBe(5)
    expect(negotiatePtyVersion({ version: 9, minVersion: 5 }, host)).toBe(6)
    expect(negotiatePtyVersion({ version: 9 }, host)).toBeNull()
    expect(negotiatePtyVersion({ version: 3 }, host)).toBeNull()
    expect(negotiatePtyVersion({ version: 9, minVersion: 7 }, host)).toBeNull()
    expect(negotiatePtyVersion({ version: 5, minVersion: 6 }, host)).toBeNull()

    for (const version of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(negotiatePtyVersion({ version }, host)).toBeNull()
    }
    for (const minVersion of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(negotiatePtyVersion({ version: 6, minVersion }, host)).toBeNull()
    }
  })

  test('keeps the legacy rejection text and parses its fields', () => {
    expect(ptyVersionRejection(5, 4)).toBe('unsupported protocol version 5, host speaks 4')
    expect(parsePtyVersionRejection(ptyVersionRejection(5, 4))).toEqual({ requested: 5, host: 4 })
    expect(parsePtyVersionRejection('invalid token')).toBeNull()
  })

  test('exports the current floor and allows a hello minimum', () => {
    expect(PTY_PROTOCOL_VERSION).toBe(4)
    expect(PTY_PROTOCOL_MIN_VERSION).toBe(4)
    const hello: Extract<PtyRequest, { type: 'hello' }> = {
      id: 1,
      type: 'hello',
      token: 'token',
      version: 5,
      minVersion: 4
    }
    expect(hello.minVersion).toBe(4)
  })
})
