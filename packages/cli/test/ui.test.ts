import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { FakeDaemon, runCli } from './fixtures/fake-daemon'

let daemon: FakeDaemon

beforeEach(() => {
  daemon = new FakeDaemon().start()
})
afterEach(() => daemon.stop())

const run = (args: string[]) => runCli(args, { home: daemon.home })

describe('ui contributions', () => {

  test('omits empty sections', async () => {
    daemon.addUiSlot('status-bar', 'acme.notes', 'usage')
    daemon.addUiSlot('panel', 'acme.notes', 'inspector')
    const result = await run(['ui', 'contributions'])
    const headers = result.stdout.trimEnd().split('\n\n').map((section) => section.split('\n')[0])
    expect(headers).toEqual(['STATUS BARS', 'PANELS', 'THEMES'])
  })

  test('says so when every section is empty', async () => {
    daemon.ui.themes.length = 0
    const result = await run(['ui', 'contributions'])
    expect(result.code).toBe(0)
    expect(result.stdout).toBe('no UI contributions\n')
  })

  test('a line break inside a title cannot break the table', async () => {
    daemon.addUiCommand('acme.notes', 'new', { title: 'New\nnote' })
    const result = await run(['ui', 'contributions'])
    expect(result.stdout).toContain('New\\nnote')
    const commands = result.stdout.split('\n\n').find((section) => section.startsWith('COMMANDS'))!
    expect(commands.split('\n')).toHaveLength(3)
  })

  test('--json prints the model', async () => {
    daemon.addUiSlot('view', 'acme.notes', 'editor')
    const result = await run(['ui', 'contributions', '--json'])
    expect(result.code).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual(daemon.ui)
  })

  test('surplus arguments are a usage error', async () => {
    const result = await run(['ui', 'contributions', 'extra'])
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('unexpected argument "extra"')
    expect(daemon.methodCalls('ui.contributions')).toEqual([])
  })
})

describe('ui tool commands', () => {
  test('invalid slots and empty size changes fail before reaching the daemon', async () => {
    const close = await run(['ui', 'close-tool', 'middle'])
    const resize = await run(['ui', 'resize-tools'])
    expect(close.code).toBe(2)
    expect(resize.code).toBe(2)
    expect(daemon.calls).toEqual([])
  })
})

describe('help', () => {
  test('lists the ui group and the command in the top-level help', async () => {
    const group = await run(['ui', '--help'])
    expect(group.code).toBe(0)
    expect(group.stdout).toContain('ui contributions')
    expect((await run(['help'])).stdout).toContain('ui contributions')
  })
})
