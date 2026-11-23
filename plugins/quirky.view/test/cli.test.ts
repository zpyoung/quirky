import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CliContext } from '@quirky/protocol'
import authFlowV1 from './fixtures/auth-flow-v1.json'
import authFlowV2 from './fixtures/auth-flow-v2.json'
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
    expect(await h.call('get', { viewId: printed.viewId }, windowCaller)).toMatchObject({ title: 'Bundle size by route', placement: 'pane', sessionId: 's1' })
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

  test.each([
    ['view-open', { spec: '{}' }],
    ['view-update', { id: 'view_x', spec: '{}' }],
    ['view-patch', { id: 'view_x', ops: '[]' }],
    ['view-get', { id: 'view_x' }],
    ['view-close', { id: 'view_x' }],
    ['view-done', { id: 'view_x' }],
    ['view-wait', { id: 'view_x' }]
  ] as const)(
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

describe('quirky view patch', () => {
  const ops = [
    { op: 'replace', path: '/root/children/0/props/source', value: authFlowV2.root.children[0].props!.source },
    { op: 'add', path: '/root/children/1/props/rows/-', value: ['Refresh', 'expiry under 5 min', 'lease.ts'] }
  ]

  async function opened() {
    const { h, cli } = setup()
    await run(cli, 'view-open', { spec: JSON.stringify(authFlowV1) })
    const [{ viewId }] = cli.lines as [{ viewId: string }]
    return { h, cli, viewId }
  }

  test('applies inline ops or @file ops and prints the view and its new version', async () => {
    const { h, cli, viewId } = await opened()
    await run(cli, 'view-patch', { id: viewId, ops: JSON.stringify([ops[0]]) })
    await run(cli, 'view-patch', { id: viewId, ops: `@${specFile([ops[1]])}` })
    expect(cli.lines.slice(1)).toEqual([{ viewId, version: 2 }, { viewId, version: 3 }])
    expect((await h.call('get', { viewId }, windowCaller)).spec).toEqual(authFlowV2)
  })

  test('a bad op exits 2 with path: message and stores nothing', async () => {
    const { h, cli, viewId } = await opened()
    const error = await failure(run(cli, 'view-patch', { id: viewId, ops: JSON.stringify([{ op: 'remove', path: '/root/children/9' }]) }))
    expect(error).toMatchObject({ exit: 2, message: 'ops[0].path: /root/children/9 does not exist' })
    expect(cli.lines).toHaveLength(1)
    expect(await h.call('get', { viewId }, windowCaller)).toMatchObject({ version: 1, spec: authFlowV1 })
  })

  test('ops that leave an invalid spec exit 2 with the spec error', async () => {
    const { cli, viewId } = await opened()
    const error = await failure(run(cli, 'view-patch', { id: viewId, ops: JSON.stringify([{ op: 'replace', path: '/root/children/1/props/rows', value: [['only one cell']] }]) }))
    expect(error).toMatchObject({ exit: 2, message: 'root.children[1].props.rows[0]: row has 1 cells; the table has 3 columns' })
  })

  test('text that is not JSON exits 2, and an unreadable @file exits 2 without calling the daemon', async () => {
    const { cli, viewId } = await opened()
    expect(await failure(run(cli, 'view-patch', { id: viewId, ops: '[oops' }))).toMatchObject({ exit: 2 })
    const before = cli.calls.length
    const error = await failure(run(cli, 'view-patch', { id: viewId, ops: '@/no/such/ops.json' }))
    expect(error).toMatchObject({ exit: 2 })
    expect(error.message).toStartWith('--ops: cannot read /no/such/ops.json')
    expect(cli.calls).toHaveLength(before)
  })

  test('an unknown view is a runtime error, not a usage error', async () => {
    const { cli } = setup()
    const error = await failure(run(cli, 'view-patch', { id: 'view_missing', ops: '[]' }))
    expect(error.message).toContain('not found')
    expect(error).not.toHaveProperty('exit', 2)
  })
})

describe('quirky view get', () => {
  async function twoVersions() {
    const { h, cli } = setup()
    await run(cli, 'view-open', { spec: JSON.stringify(authFlowV1) })
    const [{ viewId }] = cli.lines as [{ viewId: string }]
    await run(cli, 'view-update', { id: viewId, spec: JSON.stringify(authFlowV2) })
    cli.lines.length = 0
    return { h, cli, viewId }
  }

  test('prints the latest version as one JSON line with the fields an agent needs to reload it', async () => {
    const { cli, viewId } = await twoVersions()
    await run(cli, 'view-get', { id: viewId })
    expect(cli.lines).toEqual([{ viewId, title: 'Auth flow', version: 2, latestVersion: 2, spec: authFlowV2 }])
  })

  test('--at-version prints that version and still names the latest', async () => {
    const { cli, viewId } = await twoVersions()
    await run(cli, 'view-get', { id: viewId, 'at-version': 1 })
    expect(cli.lines).toEqual([{ viewId, title: 'Auth flow', version: 1, latestVersion: 2, spec: authFlowV1 }])
    expect(cli.calls.at(-1)).toEqual({ method: 'quirky.view/get', params: { viewId, version: 1 } })
  })

  test('an unknown version or view is a runtime error, and --at-version must be at least 1', async () => {
    const { cli, viewId } = await twoVersions()
    const missing = await failure(run(cli, 'view-get', { id: viewId, 'at-version': 9 }))
    expect(missing.message).toContain('no version 9')
    expect(missing).not.toHaveProperty('exit', 2)
    expect((await failure(run(cli, 'view-get', { id: 'view_missing' }))).message).toContain('not found')
    expect(await failure(run(cli, 'view-get', { id: viewId, 'at-version': 0 }))).toMatchObject({ exit: 2 })
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

describe('quirky view done', () => {
  test('marks the view done and prints nothing; --undo clears it', async () => {
    const { h, cli } = setup()
    await run(cli, 'view-open', { spec: JSON.stringify(bundleSize) })
    const [{ viewId }] = cli.lines as [{ viewId: string }]
    await run(cli, 'view-done', { id: viewId })
    expect(await h.call('get', { viewId }, windowCaller)).toMatchObject({ done: true })
    await run(cli, 'view-done', { id: viewId, undo: true })
    expect(await h.call('get', { viewId }, windowCaller)).toMatchObject({ done: false })
    expect(cli.lines).toEqual([{ viewId }])
    expect(cli.calls.slice(1)).toEqual([
      { method: 'quirky.view/done', params: { viewId, done: true } },
      { method: 'quirky.view/done', params: { viewId, done: false } }
    ])
  })

  test('an unknown view is a runtime error (exit 1)', async () => {
    const { cli } = setup()
    const error = await failure(run(cli, 'view-done', { id: 'view_missing' }))
    expect(error.message).toContain('not found')
    expect(error).not.toHaveProperty('exit', 2)
  })
})

describe('quirky view --help', () => {
  test('the help text has the usage and the whole catalog with an example for every component', () => {
    const text = helpText()
    for (const line of ['quirky view open --spec @file.json [--placement inline|pane]', 'quirky view update --id <viewId> --spec @file.json', 'quirky view patch --id <viewId> --ops <json|@file>', 'quirky view get --id <viewId> [--at-version N]', 'quirky view close --id <viewId>', 'quirky view done --id <viewId> [--undo]', 'quirky view wait --id <viewId> [--timeout-ms N]', 'quirky view --help']) {
      expect(text).toContain(line)
    }
    for (const type of CATALOG_TYPES) {
      expect(text).toContain(`  ${type}: `)
      expect(text).toContain(`example: ${JSON.stringify(COMPONENTS[type].example)}`)
    }
    expect(text.indexOf('usage:')).toBeLessThan(text.indexOf('Components'))
  })

  test('the usage puts done under close, and the spec paragraph documents the label', () => {
    const text = helpText()
    expect(text.indexOf('quirky view done')).toBeGreaterThan(text.indexOf('quirky view close'))
    expect(text.indexOf('quirky view done')).toBeLessThan(text.indexOf('quirky view wait'))
    expect(text).toContain('"label" is a short tab name for the view, up to 24 characters.')
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

  test('declares the eight commands the CLI module implements', () => {
    expect(declared.map((command) => [command.id, command.words])).toEqual([
      ['view', ''],
      ['view-open', 'open'],
      ['view-update', 'update'],
      ['view-patch', 'patch'],
      ['view-get', 'get'],
      ['view-close', 'close'],
      ['view-done', 'done'],
      ['view-wait', 'wait']
    ])
    expect(Object.keys(commands).sort()).toEqual(declared.map((command) => command.id).sort())
  })

  test('declares the flags the commands read', () => {
    const flagsOf = (id: string) => Object.keys(declared.find((command) => command.id === id)!.flags)
    expect(flagsOf('view-open')).toEqual(['spec', 'placement'])
    expect(flagsOf('view-update')).toEqual(['id', 'spec'])
    expect(flagsOf('view-patch')).toEqual(['id', 'ops'])
    expect(flagsOf('view-get')).toEqual(['id', 'at-version'])
    expect(flagsOf('view-close')).toEqual(['id'])
    expect(flagsOf('view-done')).toEqual(['id', 'undo'])
    expect(flagsOf('view-wait')).toEqual(['id', 'timeout-ms'])
  })
})

describe('the manifest and the module agree on the new methods', () => {
  test('every declared method is one the CLI commands list, and patch and get exist', () => {
    const methods = manifest.contributes.method.map((method) => method.id)
    for (const id of ['patch', 'render-failed', 'get']) expect(methods).toContain(id)
    for (const command of manifest.contributes['cli-command']) {
      for (const method of command.methods) expect(methods).toContain(method.slice('quirky.view/'.length))
    }
  })

  test('reopen is not offered to the CLI, because an agent reopens a view by updating it', () => {
    const exposed = manifest.contributes['cli-command'].flatMap((command) => command.methods)
    expect(exposed).not.toContain('quirky.view/reopen')
    expect(manifest.contributes.method.map((method) => method.id)).toContain('reopen')
  })

  test('render-failed is not offered to the CLI, because only the window reports it', () => {
    const exposed = manifest.contributes['cli-command'].flatMap((command) => command.methods)
    expect(exposed).not.toContain('quirky.view/render-failed')
  })
})

describe('the help the CLI appends to quirky view --help', () => {
  test('is the usage and component catalog', () => {
    expect(Object.keys(help)).toEqual(['view'])
    expect(help.view).toBe(helpText())
    expect(help.view).toContain('Components')
  })
})
