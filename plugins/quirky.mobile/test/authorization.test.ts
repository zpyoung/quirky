import { describe, expect, test } from 'bun:test'
import { assertMobileCallAllowed } from '../src/daemon/authorization'

describe('mobile RPC authorization', () => {
  test('rejects caller-supplied executable and launch configuration on session creation', () => {
    expect(() => assertMobileCallAllowed('quirky.session/create', { worktree: 'floating', agent: 'shell', prompt: 'check status' })).not.toThrow()
    for (const key of ['command', 'cwd', 'extraArgs', 'model', 'options']) {
      expect(() => assertMobileCallAllowed('quirky.session/create', { agent: 'shell', [key]: 'unrestricted' })).toThrow()
    }
  })

  test('rejects prefixes, unknown routes, and request-supplied identity or credential fields', () => {
    for (const method of ['quirky.terminal/attachMore', 'quirky.git/status/admin', 'quirky.unknown/list']) {
      expect(() => assertMobileCallAllowed(method, {})).toThrow()
    }
    for (const key of ['deviceId', 'role', 'token', 'deviceToken', 'credential', 'caller', 'client', 'scope']) {
      expect(() => assertMobileCallAllowed('quirky.terminal/write', { session: 's', data: 'ok', [key]: 'spoofed' })).toThrow()
    }
  })

  test('rejects unknown fields and bounds terminal write, resize, and attach input', () => {
    expect(() => assertMobileCallAllowed('status.get', { foo: true })).toThrow()
    expect(() => assertMobileCallAllowed('quirky.terminal/write', { session: 's', data: 'x'.repeat(65 * 1024) })).toThrow()
    expect(() => assertMobileCallAllowed('quirky.terminal/resize', { session: 's', cols: 1001, rows: 25 })).toThrow()
    expect(() => assertMobileCallAllowed('quirky.terminal/attach', { session: 's', cols: 80, rows: 24, claim: 'yes' })).toThrow()
    expect(() => assertMobileCallAllowed('quirky.terminal/attach', { session: 's', cols: 80, rows: 24 })).not.toThrow()
    expect(() => assertMobileCallAllowed('quirky.terminal/claim', { session: 's', cols: 1000, rows: 500 })).not.toThrow()
    expect(() => assertMobileCallAllowed('quirky.terminal/claim', { session: 's', cols: 1001, rows: 25 })).toThrow()
  })

  test('admits only safe bounded ask answers and read-only files methods', () => {
    expect(() => assertMobileCallAllowed('quirky.ask/answer', { askId: 'ask-1', answers: { question: 'yes' } })).not.toThrow()
    expect(() => assertMobileCallAllowed('quirky.ask/answer', { askId: 'ask-1', answers: {}, token: 'secret' })).toThrow()
    expect(() => assertMobileCallAllowed('quirky.hosting/fileContents', { number: 2, path: '../secrets' })).toThrow()
    expect(() => assertMobileCallAllowed('quirky.git/status', { worktree: 'current' })).not.toThrow()
  })
})
