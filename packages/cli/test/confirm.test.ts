import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { RpcErrorCode } from '@quirky/protocol'
import { FakeDaemon, runCli } from './fixtures/fake-daemon'

let daemon: FakeDaemon

beforeEach(() => {
  daemon = new FakeDaemon().start()
  daemon.addMethod('acme.tools/wipe', { destructive: true, confirm: 'Wipe cache?', description: 'Wipe the cache.' })
  daemon.results.set('plugin.uninstall', { ok: true })
  daemon.addMethod('acme.tools/size', { readOnly: true, description: 'Cache size.' })
})
afterEach(() => daemon.stop())

const run = (args: string[]) => runCli(args, { home: daemon.home })
const ACTION = 'Uninstall plugin acme.tools?'
const NOTICE = `confirm in Quirky: ${ACTION} (ask ask_c1); or rerun with --yes\n`

describe('SC-43: a destructive call asks first', () => {
  test('(a) on Yes the call repeats with the confirmation and succeeds', async () => {
    daemon.requireConfirmation('plugin.uninstall', { action: ACTION })
    const result = await run(['plugin', 'uninstall', 'acme.tools'])
    expect(result.code).toBe(0)
    expect(result.stderr).toBe(NOTICE)
    expect(result.stdout).toBe('uninstalled acme.tools\n')
    expect(daemon.methodCalls('plugin.uninstall')).toEqual([
      { id: 'acme.tools' },
      { id: 'acme.tools', confirmation: 'ask_c1' }
    ])
    expect(daemon.methodCalls('quirky.ask/wait')).toEqual([{ askId: 'ask_c1', timeoutMs: 60000 }])
  })

  test('(b) on No the call stops with exit 1 and the code declined', async () => {
    daemon.requireConfirmation('plugin.uninstall', { action: ACTION, answer: 'declined' })
    const result = await run(['plugin', 'uninstall', 'acme.tools'])
    expect(result.code).toBe(1)
    expect(result.stderr).toBe(`${NOTICE}quirky: declined\n`)
    expect(result.stdout).toBe('')
    expect(daemon.methodCalls('plugin.uninstall')).toEqual([{ id: 'acme.tools' }])
  })

  test('(b) under --json the error document has code declined', async () => {
    daemon.requireConfirmation('plugin.uninstall', { action: ACTION, answer: 'declined' })
    const result = await run(['plugin', 'uninstall', 'acme.tools', '--json'])
    expect(result.code).toBe(1)
    expect(JSON.parse(result.stdout)).toEqual({ error: { code: 'declined', message: 'declined' } })
  })

  test('the wait repeats while the ask is pending', async () => {
    daemon.requireConfirmation('plugin.uninstall', { action: ACTION, pendingWaits: 2 })
    const result = await run(['plugin', 'uninstall', 'acme.tools'])
    expect(result.code).toBe(0)
    expect(daemon.methodCalls('quirky.ask/wait')).toHaveLength(3)
  })

  test('a connection lost while waiting reconnects and keeps waiting', async () => {
    daemon.requireConfirmation('plugin.uninstall', { action: ACTION })
    daemon.dropAfter('quirky.ask/wait')
    const result = await run(['plugin', 'uninstall', 'acme.tools'])
    expect(result.code).toBe(0)
    expect(daemon.methodCalls('quirky.ask/wait')).toHaveLength(2)
    expect(daemon.methodCalls('plugin.uninstall')).toHaveLength(2)
  })

  test('a plugin method the catalog marks destructive asks the same way', async () => {
    daemon.requireConfirmation('acme.tools/wipe', { action: 'Wipe cache?' })
    const result = await run(['acme.tools', 'wipe'])
    expect(result.code).toBe(0)
    expect(result.stderr).toBe('confirm in Quirky: Wipe cache? (ask ask_c1); or rerun with --yes\n')
    expect(daemon.methodCalls('acme.tools/wipe')).toEqual([{}, { confirmation: 'ask_c1' }])
  })
})

describe('SC-44: --yes skips the confirmation', () => {
  test('a kernel destructive method gets yes and no ask is created', async () => {
    daemon.requireConfirmation('plugin.uninstall', { action: ACTION })
    const result = await run(['plugin', 'uninstall', 'acme.tools', '--yes'])
    expect(result.code).toBe(0)
    expect(result.stderr).toBe('')
    expect(daemon.methodCalls('plugin.uninstall')).toEqual([{ id: 'acme.tools', yes: true }])
    expect(daemon.methodCalls('quirky.ask/wait')).toEqual([])
  })

  test('a plugin method the catalog marks destructive gets yes', async () => {
    daemon.requireConfirmation('acme.tools/wipe', { action: 'Wipe cache?' })
    const result = await run(['acme.tools', 'wipe', '--yes'])
    expect(result.code).toBe(0)
    expect(daemon.methodCalls('acme.tools/wipe')).toEqual([{ yes: true }])
  })

  test('methods that are not destructive never get yes', async () => {
    const result = await run(['acme.tools', 'size', '--yes'])
    expect(result.code).toBe(0)
    expect(daemon.methodCalls('acme.tools/size')).toEqual([{}])
    expect((await run(['plugin', 'list', '--yes'])).code).toBe(0)
    expect(daemon.methodCalls('plugin.list')).toEqual([{}])
  })

  test('--yes anywhere before -- is a global switch', async () => {
    const result = await run(['--yes', 'plugin', 'uninstall', '--json', 'acme.tools'])
    expect(result.code).toBe(0)
    expect(daemon.methodCalls('plugin.uninstall')).toEqual([{ id: 'acme.tools', yes: true }])
  })
})

describe('SC-46: with asks switched off the message says to pass yes', () => {
  test('the daemon error reaches stderr with exit 1', async () => {
    const message = 'this action needs confirmation and asks are off; pass --yes'
    daemon.errors.set('plugin.uninstall', { code: RpcErrorCode.Conflict, message })
    const result = await run(['plugin', 'uninstall', 'acme.tools'])
    expect(result.code).toBe(1)
    expect(result.stderr).toBe(`quirky: ${message}\n`)
    expect(daemon.methodCalls('quirky.ask/wait')).toEqual([])
  })

  test('under --json an unanswered confirmation reports its code', async () => {
    daemon.errors.set('plugin.uninstall', { code: RpcErrorCode.ConfirmationRequired, message: 'confirmation required' })
    const result = await run(['plugin', 'uninstall', 'acme.tools', '--json'])
    expect(result.code).toBe(1)
    expect(JSON.parse(result.stdout).error.code).toBe('confirmation-required')
  })
})
