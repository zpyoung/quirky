import { expect, test } from 'bun:test'
import { assertMobileCallAllowed } from '../src/daemon/authorization'

const method = 'quirky.terminal/artifacts'
const source = { worktree: 'worktree-one', session: 'terminal-one' }
const authorization = { artifactId: 'opaque-artifact', grant: 'opaque-grant' }

test('a phone cannot turn artifact discovery into arbitrary path or caller authority', () => {
  for (const input of [
    { action: 'list', ...source, path: '/private/unprinted.txt' },
    { action: 'list', ...source, deviceId: 'another-phone' },
    { action: 'list', ...source, ...authorization },
    { action: 'list', ...source, session: '' },
    { action: 'preview', ...source, ...authorization, artifactId: '/private/unprinted.txt' },
    { action: 'preview', ...source, artifactId: authorization.artifactId },
    { action: 'refresh', ...source, ...authorization, expectedRevision: 'a'.repeat(64) },
    { action: 'overwrite', ...source, ...authorization },
  ]) expect(() => assertMobileCallAllowed(method, input)).toThrow()
})

test('artifact saves require bounded UTF-8 and an exact preview revision rather than force flags', () => {
  const request = { action: 'save', ...source, ...authorization, expectedRevision: 'a'.repeat(64), content: 'draft' }
  for (const input of [
    { ...request, content: '界'.repeat(16_385) },
    { ...request, expectedRevision: 'not-a-revision' },
    { ...request, expectedRevision: undefined },
    { ...request, content: undefined },
    { ...request, force: true },
    { ...request, yes: true },
    { ...request, path: '../unprinted.txt' },
  ]) expect(() => assertMobileCallAllowed(method, input)).toThrow()
})
