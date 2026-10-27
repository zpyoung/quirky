import { describe, expect, test } from 'bun:test'
import { factEvent } from '../src/terminal'

describe('factEvent', () => {
  test('maps the facts the terminal reports to plugin events', () => {
    expect(factEvent('s1', { kind: 'bell' })).toEqual({ name: 'bell', data: { sessionId: 's1' } })
    expect(factEvent('s1', { kind: 'title', title: 't' })).toEqual({ name: 'title', data: { sessionId: 's1', title: 't' } })
    expect(factEvent('s1', { kind: 'cwd', cwd: '/tmp' })).toEqual({ name: 'cwd', data: { sessionId: 's1', cwd: '/tmp' } })
    expect(factEvent('s1', { kind: 'command-finished', exitCode: 2 })).toEqual({
      name: 'commandFinished',
      data: { sessionId: 's1', exitCode: 2 }
    })
  })

  test('prompt and program-status facts are not plugin events', () => {
    expect(factEvent('s1', { kind: 'prompt' })).toBeNull()
    expect(factEvent('s1', { kind: 'program-status', body: '?' })).toBeNull()
  })
})
