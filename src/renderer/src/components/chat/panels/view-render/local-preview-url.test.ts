import { describe, expect, it } from 'vitest'
import { localPreviewUrl } from './local-preview-url'

describe('localPreviewUrl', () => {
  it.each([
    ['http://localhost:3000', 'http://localhost:3000/'],
    ['https://127.0.0.1:5173/app?x=1', 'https://127.0.0.1:5173/app?x=1'],
    ['http://LOCALHOST/path', 'http://localhost/path']
  ])('accepts %s', (input, expected) => {
    expect(localPreviewUrl(input)).toBe(expected)
  })

  it.each([
    'http://example.com',
    'http://localhost.evil.com',
    'http://user@localhost:3000',
    'http://127.0.0.1.nip.io',
    'ftp://localhost',
    'javascript:alert(1)',
    'file:///etc/passwd',
    'localhost:3000',
    'not a url',
    ''
  ])('rejects %s', (input) => {
    expect(localPreviewUrl(input)).toBeNull()
  })
})
