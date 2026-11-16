import { expect, test } from 'bun:test'
import { validateValue, type Schema } from '../../../packages/protocol/src/schema'
import manifest from '../quirky-plugin.json'

const close = manifest.contributes.command.find((command) => command.id === 'close')!
const args = ('args' in close ? close.args : { type: 'object' }) as Schema

test('close accepts an explicit buffer and tab', () => {
  expect(validateValue(args, { bufferId: 'b1', tabId: 't1' }, 'args')).toBeNull()
})

test('close accepts the focused tab without arguments', () => {
  expect(validateValue(args, {}, 'args')).toBeNull()
})

test('close refuses unknown arguments', () => {
  expect(validateValue(args, { bufferId: 'b1', extra: 1 }, 'args')).toBe('args.extra is not allowed')
})

test('close refuses a non-string buffer identity', () => {
  expect(validateValue(args, { bufferId: 7 }, 'args')).not.toBeNull()
})
