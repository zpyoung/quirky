import { expect, test } from 'bun:test'
import { inspect } from 'node:util'
import { installProcessErrorGuards } from '../src/node/process-guard'

for (const event of ['uncaughtException', 'unhandledRejection'] as const) {
  test(`${event} logs stacks and arbitrary rejection values without throwing`, () => {
    const lines: string[] = []
    const previous = process.listeners(event)
    const dispose = installProcessErrorGuards({ label: 'quirky-pty', write: (line) => { lines.push(line) } })
    try {
      const listener = process.listeners(event).find((fn) => !previous.includes(fn))! as (reason: unknown) => void
      const circular = Object.create(null)
      circular.self = circular
      const error = new Error('boom')
      const withoutStack = new Error('no stack')
      withoutStack.stack = ''
      for (const value of [error, withoutStack, 'plain', undefined, null, 7, 42n, Symbol('fault'), circular]) {
        listener(value)
        const detail = value instanceof Error ? value.stack || `${value.name}: ${value.message}` : typeof value === 'string' ? value : inspect(value)
        expect(lines.at(-1)).toBe(`[quirky-pty] ${event}: ${detail}\n`)
      }
    } finally {
      dispose()
    }
    expect(process.listeners(event)).toEqual(previous)
  })
}

test('broken formatting and log sinks never escape the guard', () => {
  for (const write of [() => {}, () => { throw Object.assign(new Error('broken pipe'), { code: 'EPIPE' }) }]) {
    const previous = process.listeners('uncaughtException')
    const dispose = installProcessErrorGuards({ label: 'quirkyd', write })
    try {
      const listener = process.listeners('uncaughtException').find((fn) => !previous.includes(fn))! as (reason: unknown) => void
      const error = new Error('boom')
      Object.defineProperty(error, 'stack', { get() { throw new Error('broken stack getter') } })
      expect(() => listener(error)).not.toThrow()
      expect(() => listener('plain')).not.toThrow()
    } finally {
      dispose()
    }
  }
})

test('disposal removes only its own listeners and is idempotent', () => {
  const exceptions = process.listeners('uncaughtException')
  const rejections = process.listeners('unhandledRejection')
  const first = installProcessErrorGuards({ label: 'first', write: () => {} })
  const second = installProcessErrorGuards({ label: 'second', write: () => {} })
  try {
    first()
    first()
    expect(process.listeners('uncaughtException')).toHaveLength(exceptions.length + 1)
    expect(process.listeners('unhandledRejection')).toHaveLength(rejections.length + 1)
  } finally {
    first()
    second()
  }
  expect(process.listeners('uncaughtException')).toEqual(exceptions)
  expect(process.listeners('unhandledRejection')).toEqual(rejections)
})
