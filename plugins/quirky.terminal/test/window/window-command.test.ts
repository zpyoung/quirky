import { describe, expect, test } from 'bun:test'
import { fakeContext } from '../ui-fake'
import { requestWindowCommand } from '../../src/window/window-command'

const descriptor = { command: 'command:quirky.terminal/focus-pane', args: { pane: 'pane-1', workspace: 'wt-main' } }

describe('requestWindowCommand', () => {
  for (const auxiliary of [false, true]) {
    test(`preserves the clicking ${auxiliary ? 'auxiliary' : 'ordinary'} window and its refusal`, async () => {
      const refused = { ok: false, reason: 'refused' }
      const fake = fakeContext({
        'ui.window.self': () => ({ connId: 41, auxiliary }),
        'ui.window.command.run': () => ({ result: refused })
      })
      let ownerCalls = 0
      fake.context.executeCommand = async () => { ownerCalls++ }
      expect(await requestWindowCommand(fake.context, descriptor)).toEqual(refused)
      expect(fake.callsTo('ui.window.command.run').map((call) => call.params)).toEqual([{ connId: 41, id: descriptor.command, args: descriptor.args }])
      expect(ownerCalls).toBe(0)
    })
  }

  for (const connId of [undefined, 0, -1, 1.5, NaN, Number.MAX_SAFE_INTEGER + 1]) {
    test(`refuses unavailable connection ${connId}`, async () => {
      const fake = fakeContext({ 'ui.window.self': () => ({ connId }) })
      await expect(requestWindowCommand(fake.context, descriptor)).rejects.toThrow('window connection is unavailable')
      expect(fake.callsTo('ui.window.command.run')).toEqual([])
    })
  }

  for (const method of ['ui.window.self', 'ui.window.command.run']) {
    test(`propagates ${method} rejection without owner fallback`, async () => {
      const failure = new Error('offline')
      const fake = fakeContext({
        'ui.window.self': () => ({ connId: 41 }),
        [method]: () => { throw failure }
      })
      let ownerCalls = 0
      fake.context.executeCommand = async () => { ownerCalls++ }
      await expect(requestWindowCommand(fake.context, descriptor)).rejects.toBe(failure)
      expect(ownerCalls).toBe(0)
    })
  }

  test('returns the enclosed successful value without interpreting it', async () => {
    const fake = fakeContext({
      'ui.window.self': () => ({ connId: 41 }),
      'ui.window.command.run': () => ({ result: { ok: true, text: 'pane-1' } })
    })
    expect(await requestWindowCommand(fake.context, descriptor)).toEqual({ ok: true, text: 'pane-1' })
  })
})
