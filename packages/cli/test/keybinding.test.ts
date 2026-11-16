import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { FakeDaemon, runCli } from './fixtures/fake-daemon'

let daemon: FakeDaemon

const BINDING_ID = 'keybinding:acme.notes/new'
const COMMAND_ID = 'command:acme.notes/new'
const SHADOWED_ID = 'keybinding:acme.notes/old'

beforeEach(() => {
  daemon = new FakeDaemon().start()
  daemon.addKeybinding('acme.notes', 'new', 'mod+n', COMMAND_ID)
})
afterEach(() => daemon.stop())

const run = (args: string[]) => runCli(args, { home: daemon.home })

function tableLines(stdout: string): string[] {
  return stdout.trimEnd().split('\n')
}

describe('keybinding CLI', () => {
  test('list prints each binding and describes a shadowed binding', async () => {
    daemon.addKeybinding('acme.notes', 'old', 'mod+n', 'command:acme.notes/old', {
      status: 'shadowed',
      shadowedBy: BINDING_ID
    })

    const result = await run(['keybinding', 'list'])

    expect(result.code).toBe(0)
    const lines = tableLines(result.stdout)
    expect(lines[0]?.split(/\s+/)).toEqual(['ID', 'KEY', 'COMMAND', 'STATUS'])
    expect(lines[1]?.split(/\s+/)).toEqual([BINDING_ID, 'mod+n', COMMAND_ID, 'active'])
    expect(lines[2]).toContain(`${SHADOWED_ID}  mod+n  command:acme.notes/old`)
    expect(lines[2]).toContain(`shadowed by ${BINDING_ID}`)
    expect(daemon.methodCalls('keybinding.list')).toEqual([{}])
  })

  test('list --json prints the daemon array unchanged', async () => {
    const expected = [...daemon.ui.keybindings]

    const result = await run(['keybinding', 'list', '--json'])

    expect(result.code).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual(expected)
    expect(daemon.methodCalls('keybinding.list')).toEqual([{}])
  })

  test('set changes the requested key and prints only that binding', async () => {
    const result = await run(['keybinding', 'set', BINDING_ID, 'mod+j'])

    expect(result.code).toBe(0)
    expect(daemon.methodCalls('keybinding.set')).toEqual([{ id: BINDING_ID, key: 'mod+j' }])
    const lines = tableLines(result.stdout)
    expect(lines[0]?.split(/\s+/)).toEqual(['ID', 'KEY', 'COMMAND', 'STATUS'])
    expect(lines).toHaveLength(2)
    expect(lines[1]?.split(/\s+/)).toEqual([BINDING_ID, 'mod+j', COMMAND_ID, 'active'])
  })

  test('disable sends a null key and prints the unbound status', async () => {
    const result = await run(['keybinding', 'disable', BINDING_ID])

    expect(result.code).toBe(0)
    expect(daemon.methodCalls('keybinding.set')).toEqual([{ id: BINDING_ID, key: null }])
    const lines = tableLines(result.stdout)
    expect(lines[0]?.split(/\s+/)).toEqual(['ID', 'KEY', 'COMMAND', 'STATUS'])
    expect(lines).toHaveLength(2)
    expect(lines[1]).toContain('unbound')
  })

  test('reset restores the seeded key after a set', async () => {
    await run(['keybinding', 'set', BINDING_ID, 'mod+j'])
    const result = await run(['keybinding', 'reset', BINDING_ID])

    expect(result.code).toBe(0)
    expect(daemon.methodCalls('keybinding.set')).toEqual([{ id: BINDING_ID, key: 'mod+j' }])
    expect(daemon.methodCalls('keybinding.reset')).toEqual([{ id: BINDING_ID }])
    const lines = tableLines(result.stdout)
    expect(lines).toHaveLength(2)
    expect(lines[1]?.split(/\s+/)).toEqual([BINDING_ID, 'mod+n', COMMAND_ID, 'active'])
  })

  test('set of an unknown binding exits with the daemon error', async () => {
    const id = 'keybinding:acme.ghost/x'
    const result = await run(['keybinding', 'set', id, 'mod+j'])

    expect(result.code).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain(`no keybinding ${id}`)
    expect(daemon.methodCalls('keybinding.set')).toEqual([{ id, key: 'mod+j' }])
  })

  test('missing positional arguments are usage errors before any RPC', async () => {
    const missingKey = await run(['keybinding', 'set', BINDING_ID])
    expect(missingKey.code).toBe(2)
    expect(missingKey.stderr).toContain('missing <key>')

    const missingId = await run(['keybinding', 'reset'])
    expect(missingId.code).toBe(2)
    expect(missingId.stderr).toContain('missing <id>')

    expect(daemon.methodCalls('keybinding.set')).toEqual([])
    expect(daemon.methodCalls('keybinding.reset')).toEqual([])
  })
})
