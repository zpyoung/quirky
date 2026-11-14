import { afterEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { terminalCommands } from '../../src/window/commands'
import { fakeContext } from '../ui-fake'
import {
  copyTextCommand,
  dockFocusCommand,
  requestWindowCommand,
  searchCloseCommand,
  searchCommand,
  searchNextCommand,
  searchPreviousCommand,
  type WindowCommandDescriptor
} from '../../src/window/pane/commands'

let restoreClipboard: (() => void) | null = null

afterEach(() => {
  restoreClipboard?.()
  restoreClipboard = null
})

function setClipboard(writeText?: (text: string) => Promise<void>): void {
  if (restoreClipboard === null) {
    const original = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
    restoreClipboard = () => {
      if (original) Object.defineProperty(navigator, 'clipboard', original)
      else Reflect.deleteProperty(navigator, 'clipboard')
    }
  }
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: writeText === undefined ? undefined : { writeText }
  })
}

describe('terminal pane command contracts', () => {
  test('copies explicit link text without a mounted workspace', async () => {
    const copied: string[] = []
    setClipboard(async (value) => { copied.push(value) })
    const commands = terminalCommands(fakeContext().context)

    await expect(commands.copy!({ text: 'https://example.test/x' })).resolves.toEqual({ text: 'https://example.test/x' })
    await expect(commands.copy!({ text: '' })).resolves.toEqual({ text: '' })
    expect(copied).toEqual(['https://example.test/x', ''])
  })

  test('rejects explicit non-string text before workspace resolution', async () => {
    const commands = terminalCommands(fakeContext().context)
    await expect(commands.copy!({ text: 42 })).rejects.toThrow('text must be a string')
  })

  test('reports unavailable clipboard access and propagates clipboard rejection', async () => {
    const commands = terminalCommands(fakeContext().context)
    setClipboard()
    await expect(commands.copy!({ text: 'x' })).rejects.toThrow('Clipboard access is unavailable in this window.')

    setClipboard(async () => { throw new Error('clipboard offline') })
    await expect(commands.copy!({ text: 'x' })).rejects.toThrow('clipboard offline')
  })

  test('publishes explicit copy text and pane-scoped search arguments', () => {
    const manifest = JSON.parse(readFileSync(fileURLToPath(new URL('../../quirky-plugin.json', import.meta.url)), 'utf8')) as {
      contributes?: { command?: { id: string; args?: { properties?: Record<string, { type?: string }> } }[] }
    }
    const copy = manifest.contributes?.command?.find((entry) => entry.id === 'copy')
    const search = manifest.contributes?.command?.find((entry) => entry.id === 'search')

    expect(copy?.args?.properties?.text?.type).toBe('string')
    expect(search?.args?.properties?.pane?.type).toBe('string')
  })
})

type WindowRequest = { method: string; params: Record<string, unknown> }

function exactWindowContext(
  self: () => unknown | Promise<unknown>,
  run: (params: Record<string, unknown>) => unknown | Promise<unknown>
) {
  const fake = fakeContext()
  const requests: WindowRequest[] = []
  const ownerCalls = { count: 0 }
  const call = fake.context.call.bind(fake.context)
  fake.context.call = async (method, params = {}) => {
    requests.push({ method, params })
    if (method === 'ui.window.self') return self()
    if (method === 'ui.window.command.run') return run(params)
    return call(method, params)
  }
  fake.context.executeCommand = async () => {
    ownerCalls.count += 1
    throw new Error('owner command fallback was used')
  }
  return { context: fake.context, requests, ownerCalls }
}

describe('exact-window pane command dispatch', () => {
  test('builds literal descriptors for every pane action', () => {
    expect(searchCommand('pane-3', { query: '19', regex: true })).toEqual({
      command: 'command:quirky.terminal/search',
      args: { pane: 'pane-3', query: '19', regex: true }
    })
    expect(searchNextCommand('pane-3')).toEqual({ command: 'command:quirky.terminal/search-next', args: { pane: 'pane-3' } })
    expect(searchPreviousCommand('pane-3')).toEqual({ command: 'command:quirky.terminal/search-previous', args: { pane: 'pane-3' } })
    expect(searchCloseCommand('pane-3')).toEqual({ command: 'command:quirky.terminal/search-close', args: { pane: 'pane-3' } })
    expect(copyTextCommand('https://example.test/x')).toEqual({
      command: 'command:quirky.terminal/copy',
      args: { text: 'https://example.test/x' }
    })
    expect(dockFocusCommand('pane-3')).toEqual({
      command: 'command:quirky.terminal-dock/focus',
      args: { pane: 'pane-3' }
    })
  })

  test('caches self per context without crossing windows', async () => {
    const first = exactWindowContext(() => ({ connId: 42 }), (params) => ({ result: params.connId }))
    const second = exactWindowContext(() => ({ connId: 43 }), (params) => ({ result: params.connId }))
    const descriptor: WindowCommandDescriptor = searchNextCommand('pane-3')

    await expect(requestWindowCommand(first.context, descriptor)).resolves.toBe(42)
    await expect(requestWindowCommand(second.context, descriptor)).resolves.toBe(43)
    await expect(requestWindowCommand(first.context, descriptor)).resolves.toBe(42)

    expect(first.requests.filter(({ method }) => method === 'ui.window.self')).toHaveLength(1)
    expect(second.requests.filter(({ method }) => method === 'ui.window.self')).toHaveLength(1)
    expect(first.requests.filter(({ method }) => method === 'ui.window.command.run').map(({ params }) => params.connId)).toEqual([42, 42])
    expect(second.requests.filter(({ method }) => method === 'ui.window.command.run').map(({ params }) => params.connId)).toEqual([43])
    expect(first.ownerCalls.count).toBe(0)
  })

  test('rejects an invalid connection and retries a failed self lookup on the next action', async () => {
    let calls = 0
    const fixture = exactWindowContext(
      () => {
        calls += 1
        if (calls === 1) return { connId: 0 }
        if (calls === 2) throw new Error('window gone')
        return { connId: 42 }
      },
      () => ({ result: 'ok' })
    )
    const descriptor = searchNextCommand('pane-3')

    await expect(requestWindowCommand(fixture.context, descriptor)).rejects.toThrow('No live window connection is available.')
    await expect(requestWindowCommand(fixture.context, descriptor)).rejects.toThrow('window gone')
    await expect(requestWindowCommand(fixture.context, descriptor)).resolves.toBe('ok')
    expect(fixture.requests.filter(({ method }) => method === 'ui.window.self')).toHaveLength(3)
    expect(fixture.requests.filter(({ method }) => method === 'ui.window.command.run')).toHaveLength(1)
  })

  test('does not replay a failed command and reacquires its dead connection', async () => {
    let connId = 42
    let fail = true
    const fixture = exactWindowContext(
      () => ({ connId }),
      (params) => {
        if (fail) {
          fail = false
          throw new Error('connection closed')
        }
        return { result: 'ok' }
      }
    )
    const descriptor = searchNextCommand('pane-3')

    await expect(requestWindowCommand(fixture.context, descriptor)).rejects.toThrow('connection closed')
    connId = 43
    await expect(requestWindowCommand(fixture.context, descriptor)).resolves.toBe('ok')
    expect(fixture.requests.filter(({ method }) => method === 'ui.window.self').map(({ method }) => method)).toHaveLength(2)
    expect(fixture.requests.filter(({ method }) => method === 'ui.window.command.run').map(({ params }) => params.connId)).toEqual([42, 43])
  })

  test('rejects command refusal objects using their reason', async () => {
    const fixture = exactWindowContext(() => ({ connId: 42 }), () => ({
      result: { ok: false, reason: 'no mounted terminal workspace holds pane-3' }
    }))
    await expect(requestWindowCommand(fixture.context, searchNextCommand('pane-3'))).rejects.toThrow('no mounted terminal workspace holds pane-3')
  })
})
