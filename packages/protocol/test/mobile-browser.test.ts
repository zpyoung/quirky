import { expect, test } from 'bun:test'
import { validMobileBrowserParams } from '../src/mobile-browser'

const lease = { worktree: 'wt_phone', tabId: 'tab_browser', watchId: 'lease_1' }

test('Watch input rejects command widening and invalid coordinates before producer dispatch', () => {
  expect(validMobileBrowserParams('quirky.mobile/browserWatchInput', { ...lease, kind: 'mouse', type: 'mousePressed', button: 'left', x: 1, y: 2 })).toBe(true)
  expect(validMobileBrowserParams('quirky.mobile/browserWatchInput', { ...lease, kind: 'mouse', type: 'mousePressed', button: 'left', x: -1, y: 2 })).toBe(false)
  expect(validMobileBrowserParams('quirky.mobile/browserWatchInput', { ...lease, kind: 'key', type: 'evaluate', key: 'Enter' })).toBe(false)
  expect(validMobileBrowserParams('quirky.mobile/browserWatchInput', { ...lease, kind: 'text', text: 'é'.repeat(32769) })).toBe(false)
  expect(validMobileBrowserParams('quirky.mobile/browserWatchControl', { ...lease, action: 'eval', text: 'alert(1)' })).toBe(false)
  expect(validMobileBrowserParams('quirky.mobile/browserWatchControl', { ...lease, action: 'reload', level: 1 })).toBe(false)
})

test('exact Watch leases and finite acknowledgements cannot be replaced by a generic browser authority', () => {
  expect(validMobileBrowserParams('quirky.mobile/browserWatchFrameAck', { ...lease, sequence: 1 })).toBe(true)
  expect(validMobileBrowserParams('quirky.mobile/browserWatchFrameAck', { ...lease, sequence: Number.MAX_SAFE_INTEGER + 1 })).toBe(false)
  expect(validMobileBrowserParams('quirky.mobile/browserWatchFrame', { ...lease, watchId: '' })).toBe(false)
  expect(validMobileBrowserParams('quirky.mobile/browserWatchFrame', { ...lease, deviceId: 'spoofed' })).toBe(false)
  expect(validMobileBrowserParams('quirky.mobile/browserWatchAnything', lease)).toBe(false)
})
