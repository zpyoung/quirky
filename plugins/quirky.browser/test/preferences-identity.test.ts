import { expect, test } from 'bun:test'
import { userAgentForIdentity } from '../src/preferences/identity'

test('clean identity removes embedding tokens and normalizes headless Chrome', () => {
  const original = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/128.0.0.0 Quirky/0.1 Electrobun/1 Electron/32.0.0 Safari/537.36'
  expect(userAgentForIdentity('clean', original)).toBe('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36')
})

test('native identity preserves the exact Chrome user agent', () => {
  const original = 'Mozilla/5.0 HeadlessChrome/128 Electron/32.0.0 Quirky/0.1'
  expect(userAgentForIdentity('native', original)).toBe(original)
})
