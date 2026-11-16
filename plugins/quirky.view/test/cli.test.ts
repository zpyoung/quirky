import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CliContext } from '@quirky/protocol'
import bundleSize from './fixtures/bundle-size.json'
import manifest from '../quirky-plugin.json'
import { commands, help, helpText, waitForAction } from '../cli'
import { CATALOG_TYPES, COMPONENTS, formatViewErrors, validateViewSpec } from '../src/core/catalog'
import { agent, cleanupViews, startView, windowCaller, type ViewHarness } from './support'

const SESSION_ENV = { QUIRKY_SESSION_ID: 's1', QUIRKY_SESSION_TOKEN: 'token' }

const started: ViewHarness[] = []
const dirs: string[] = []

afterEach(() => {
  for (const harness of started.splice(0)) harness.stop()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  cleanupViews()
})

type TestCli = { ctx: CliContext; lines: unknown[]; calls: { method: string; params: unknown }[] }

/** A CLI context whose calls reach the plugin as the agent in session s1. */
function cliOver(
  h: ViewHarness,
  options: { env?: Record<string, string | undefined>; call?: CliContext['call']; now?: () => number } = {}
): TestCli {
  const lines: unknown[] = []
  const calls: TestCli['calls'] = []
  const ctx: CliContext = {
    requestBase: 'test',
    call: async (method, params = {}) => {
      calls.push({ method, params })
      if (options.call) return options.call(method, params)
      return h.call(method.slice('quirky.view/'.length), params, agent())
    },
    out: { json: false, result: () => {}, line: (text) => void lines.push(text), jsonLine: (value) => void lines.push(value) },
    format: { table: () => '', record: () => '' },
    env: options.env ?? SESSION_ENV,
    cwd: process.cwd(),
    readFile: async (path) => readFileSync(path, 'utf8'),
    sleep: async () => {},
    now: options.now ?? Date.now,
    usage: (message) => Object.assign(new Error(message), { exit: 2 }),
    fail: (message) => Object.assign(new Error(message), { exit: 1 }),
    reconnect: async () => {}
  }
  return { ctx, lines, calls }
}

function setup(options?: Parameters<typeof cliOver>[1]) {
  const h = startView()
  started.push(h)
  return { h, cli: cliOver(h, options) }
}

function specFile(content: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'qv-cli-'))
  dirs.push(dir)
  const path = join(dir, 'spec.json')
  writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content))
  return path
}

async function failure(promise: Promise<unknown>): Promise<Error & { exit?: number }> {
  try {
    await promise
  } catch (error) {
    return error as never
  }
  throw new Error('expected a failure')
}

const run = (cli: TestCli, command: keyof typeof commands, flags: Record<string, unknown>) =>
  commands[command]({ positionals: [], flags }, cli.ctx)

describe('quirky view open', () => {
  test('prints the new view\'s ID, reading the spec from @file', async () => {
    const { h, cli } = setup()
    await run(cli, 'view-open', { spec: `@${specFile(bundleSize)}` })
    const [printed] = cli.lines as [{ viewId: string }]
    expect(printed.viewId).toMatch(/^view_/)
    expect(await h.call('get', { viewId: printed.viewId }, windowCaller)).toMatchObject({ title: 'Bundle size by route', placement: 'inline', sessionId: 's1' })
  })

  test('takes inline JSON and --placement', async () => {
    const { h, cli } = setup()
    await run(cli, 'view-open', { spec: JSON.stringify(bundleSize), placement: 'pane' })
    const [{ viewId }] = cli.lines as [{ viewId: string }]
    expect((await h.call('get', { viewId }, windowCaller)).placement).toBe('pane')
  })

  test('an invalid spec is a usage error (exit 2) whose message is the formatted errors, and the transcript is told', async () => {
    const { h, cli } = setup()
    const invalid = { title: 'Broken', root: { type: 'tabel' } }
    const error = await failure(run(cli, 'view-open', { spec: `@${specFile(invalid)}` }))
    const expected = formatViewErrors((validateViewSpec(invalid) as unknown as { errors: never[] }).errors)
    expect(error).toMatchObject({ exit: 2, message: expected })
    expect(expected).toBe("root.type: unknown type 'tabel'; did you mean table?")
    expect(cli.lines).toEqual([])
    expect(h.events).toEqual([{ event: 'rejected', data: expect.objectContaining({ title: 'Broken', errors: [expected] }) }])
  })

  test('text that is not JSON exits 2 and its text reaches the transcript as the source', async () => {
    const { h, cli } = setup()
    const error = await failure(run(cli, 'view-open', { spec: `@${specFile('{ not json')}` }))
    expect(error.exit).toBe(2)
    expect(error.message).toContain('spec is not valid JSON')
    expect(h.events[0].data).toMatchObject({ title: 'Untitled view', source: '{ not json' })
  })

  test('an unreadable @file exits 2 without calling the daemon', async () => {
    const { cli } = setup()
    const error = await failure(run(cli, 'view-open', { spec: '@/no/such/file.json' }))
    expect(error.exit).toBe(2)
    expect(error.message).toStartWith('--spec: cannot read /no/such/file.json')
    expect(cli.calls).toEqual([])
  })

  test.each([['view-open', { spec: '{}' }], ['view-update', { id: 'view_x', spec: '{}' }], ['view-close', { id: 'view_x' }], ['view-wait', { id: 'view_x' }]] as const)(
    '%s exits 1 outside an agent session without calling the daemon',
    async (command, flags) => {
      for (const env of [{}, { QUIRKY_SESSION_ID: 's1' }, { QUIRKY_SESSION_TOKEN: 'token' }]) {
        const { cli } = setup({ env })
        const error = await failure(run(cli, command, flags))
        expect(error).toMatchObject({ exit: 1, message: 'quirky view works only inside a Quirky agent session' })
        expect(cli.calls).toEqual([])
      }
    }
  )

  test('a daemon that refuses the caller\'s identity also exits 1 with that message', async () => {
    const h = startView()
    started.push(h)
    const cli = cliOver(h, { call: (method, params) => h.call(method.slice('quirky.view/'.length), params, { role: 'cli' }) })
    const error = await failure(run(cli, 'view-open', { spec: JSON.stringify(bundleSize) }))
    expect(error.message).toBe('quirky view works only inside a Quirky agent session')
    expect(error).not.toHaveProperty('exit', 2)
  })
})

describe('quirky view update and close', () => {
  test('update replaces the view and prints its ID; close closes it', async () => {
    const { h, cli } = setup()
    await run(cli, 'view-open', { spec: JSON.stringify(bundleSize) })
    const [{ viewId }] = cli.lines as [{ viewId: string }]
    await run(cli, 'view-update', { id: viewId, spec: JSON.stringify({ title: 'Later', root: { type: 'stack' } }) })
    expect(await h.call('get', { viewId }, windowCaller)).toMatchObject({ title: 'Later', updates: 1 })
    await run(cli, 'view-close', { id: viewId })
    expect(await h.call('get', { viewId }, windowCaller)).toMatchObject({ closed: true })
    expect(cli.lines.slice(1)).toEqual([{ viewId }, { viewId, closed: true }])
  })

  test('an invalid update exits 2 and leaves the view as it was', async () => {
    const { h, cli } = setup()
    await run(cli, 'view-open', { spec: JSON.stringify(bundleSize) })
    const [{ viewId }] = cli.lines as [{ viewId: string }]
    const error = await failure(run(cli, 'view-update', { id: viewId, spec: JSON.stringify({ title: 'X', root: { type: 'carousel' } }) }))
    expect(error.exit).toBe(2)
    expect(await h.call('get', { viewId }, windowCaller)).toMatchObject({ title: 'Bundle size by route', updates: 0 })
  })

  test('an unknown view is a runtime error (exit 1), not a usage error', async () => {
    const { cli } = setup()
    const error = await failure(run(cli, 'view-close', { id: 'view_missing' }))
    expect(error.message).toContain('not found')
    expect(error).not.toHaveProperty('exit', 2)
  })
})

describe('quirky view wait', () => {
  test('prints the action a click sends', async () => {
    const { h, cli } = setup()
    await run(cli, 'view-open', { spec: JSON.stringify(bundleSize) })
    const [{ viewId }] = cli.lines as [{ viewId: string }]
    const waiting = run(cli, 'view-wait', { id: viewId })
    await Bun.sleep(5)
    await h.call('action', { viewId, name: 'lazy-load-zxcvbn', source: 'button' }, windowCaller)
    await waiting
    expect(cli.lines[1]).toEqual({ action: { name: 'lazy-load-zxcvbn', viewId, source: 'button', at: expect.any(String) } })
    expect(h.sends).toEqual([])
  })

  test('prints a timeout once --timeout-ms passes', async () => {
    let now = 0
    const { cli } = setup({
      now: () => now,
      call: async () => {
        now += 300
        return { status: 'timeout' }
      }
    })
    await run(cli, 'view-wait', { id: 'view_x', 'timeout-ms': 1000 })
    expect(cli.lines).toEqual([{ status: 'timeout' }])
    expect(cli.calls.map((call) => call.params)).toEqual([
      { viewId: 'view_x', timeoutMs: 1000 },
      { viewId: 'view_x', timeoutMs: 700 },
      { viewId: 'view_x', timeoutMs: 400 },
      { viewId: 'view_x', timeoutMs: 100 }
    ])
  })

  test('keeps waiting through the daemon\'s own 60 s timeouts when there is no limit', async () => {
    const replies: unknown[] = [{ status: 'timeout' }, { status: 'timeout' }, { action: { name: 'go' } }]
    const { cli } = setup({ call: async () => replies.shift() })
    await run(cli, 'view-wait', { id: 'view_x' })
    expect(cli.lines).toEqual([{ action: { name: 'go' } }])
    expect(cli.calls.every((call) => (call.params as { timeoutMs: number }).timeoutMs === 60_000)).toBe(true)
  })

  test('a closed view ends the wait', async () => {
    const { cli } = setup({ call: async () => ({ status: 'closed' }) })
    await run(cli, 'view-wait', { id: 'view_x' })
    expect(cli.lines).toEqual([{ status: 'closed' }])
  })

  test('a dropped connection is retried, a refusal is not', async () => {
    let reconnects = 0
    const replies: (() => unknown)[] = [
      () => {
        throw new Error('socket closed')
      },
      () => ({ action: { name: 'go' } })
    ]
    const { cli } = setup({ call: async () => replies.shift()!() })
    cli.ctx.reconnect = async () => void reconnects++
    await waitForAction(cli.ctx, 'view_x')
    expect(reconnects).toBe(1)
    expect(cli.lines).toEqual([{ action: { name: 'go' } }])

    const { h } = setup()
    const refused = cliOver(h, { call: (method, params) => h.call(method.slice('quirky.view/'.length), params, agent('s2')) })
    expect((await failure(waitForAction(refused.ctx, 'view_missing'))).message).toContain('not found')
  })

  test('--timeout-ms must be at least 1', async () => {
    const { cli } = setup()
    expect(await failure(run(cli, 'view-wait', { id: 'view_x', 'timeout-ms': 0 }))).toMatchObject({ exit: 2 })
  })
})

describe('quirky view --help', () => {
  test('the help text has the usage and the whole catalog with an example for every component', () => {
    const text = helpText()
    for (const line of ['quirky view open --spec @file.json [--placement inline|pane]', 'quirky view update --id <viewId> --spec @file.json', 'quirky view close --id <viewId>', 'quirky view wait --id <viewId> [--timeout-ms N]', 'quirky view --help']) {
      expect(text).toContain(line)
    }
    for (const type of CATALOG_TYPES) {
      expect(text).toContain(`  ${type}: `)
      expect(text).toContain(`example: ${JSON.stringify(COMPONENTS[type].example)}`)
    }
    expect(text.indexOf('usage:')).toBeLessThan(text.indexOf('Components'))
  })

  test('the bare command prints it, with or without a session', async () => {
    const { cli } = setup({ env: {} })
    await run(cli, 'view', {})
    expect(cli.lines).toEqual([helpText()])
    expect(cli.calls).toEqual([])
  })
})

describe('the manifest', () => {
  const declared = manifest.contributes['cli-command']

  test('declares the five commands the CLI module implements', () => {
    expect(declared.map((command) => [command.id, command.words])).toEqual([
      ['view', ''],
      ['view-open', 'open'],
      ['view-update', 'update'],
      ['view-close', 'close'],
      ['view-wait', 'wait']
    ])
    expect(Object.keys(commands).sort()).toEqual(declared.map((command) => command.id).sort())
  })

  test('declares the flags the commands read', () => {
    const flagsOf = (id: string) => Object.keys(declared.find((command) => command.id === id)!.flags)
    expect(flagsOf('view-open')).toEqual(['spec', 'placement'])
    expect(flagsOf('view-update')).toEqual(['id', 'spec'])
    expect(flagsOf('view-close')).toEqual(['id'])
    expect(flagsOf('view-wait')).toEqual(['id', 'timeout-ms'])
  })
})

describe('the help the CLI appends to quirky view --help', () => {
  test('is the usage and component catalog', () => {
    expect(Object.keys(help)).toEqual(['view'])
    expect(help.view).toBe(helpText())
    expect(help.view).toContain('Components')
  })
})
