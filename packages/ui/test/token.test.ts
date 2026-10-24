import { expect, test } from 'bun:test'
import { parseHashToken, rpcUrl } from '../src/lib/token'

test('parses the token from a hash', () => {
  expect(parseHashToken('#token=abc123')).toBe('abc123')
  expect(parseHashToken('#foo=1&token=abc%2B1')).toBe('abc+1')
})

test('returns null when there is no token', () => {
  expect(parseHashToken('')).toBeNull()
  expect(parseHashToken('#')).toBeNull()
  expect(parseHashToken('#token=')).toBeNull()
  expect(parseHashToken('#other=1')).toBeNull()
})

test('builds the rpc url', () => {
  expect(rpcUrl('127.0.0.1:4000', 'a+b')).toBe('ws://127.0.0.1:4000/rpc?token=a%2Bb')
})
