import { afterEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  HOOK_TOKEN_HEADER,
  QuirkyClient,
  RpcError,
  RpcErrorCode,
  type ApiDescription,
  type PluginInfo,
  type QuirkyEvent
} from '@quirky/protocol'
import { makeTempHome, startHarness, waitFor, type Harness } from './helpers'
import { makeTempDir, readMarker, removeTempDirs, writePlugin } from './plugins/fixtures'

let h: Harness | null = null
const sockets: QuirkyClient[] = []
afterEach(async () => {
  for (const client of sockets.splice(0)) client.close()
  await h?.cleanup()
  h = null
  removeTempDirs()
})

/** A fake `quirky.ask` the dispatcher can open confirmations through; `answer` stands in for the person. */
const FAKE_ASK_MAIN = `
import type { PluginContext } from '@quirky/protocol'
const asks = new Map<string, { spec: unknown; status: 'pending' | 'answered'; value: unknown }>()
export function activate(context: PluginContext) {
  context.provide('method:quirky.ask/create', (params: Record<string, unknown>) => {
    const askId = 'ask_' + (asks.size + 1)
    asks.set(askId, { spec: params.spec, status: 'pending', value: null })
    return { askId }
  })
  context.provide('method:quirky.ask/list', (params: Record<string, unknown>) => [...asks]
    .filter(([askId]) => params.askId === undefined || params.askId === askId)
    .map(([askId, ask]) => ({
      id: askId,
      envelope: {
        status: ask.status,
        askId,
        answers: ask.status === 'answered' ? { confirm: { value: ask.value, source: 'input' } } : {},
        skipped: []
      }
    })))
  context.provide('method:quirky.ask/answer', (params: Record<string, unknown>) => {
    const ask = asks.get(String(params.askId))
    if (!ask) throw context.error('not-found', 'no such ask')
    ask.status = 'answered'
    ask.value = params.value
    return { ok: true }
  })
}
`

const TOOLS_MAIN = (marker: string) => `
import { appendFileSync } from 'node:fs'
let count = 0
export function activate(context: any) {
  context.provide('method:acme.tools/bump', (params: any) => {
    count += 1
    appendFileSync(${JSON.stringify(marker)}, 'bump ' + params.key + '\\n')
    return { count }
  })
  context.provide('method:acme.tools/wipe', (params: any) => {
    appendFileSync(${JSON.stringify(marker)}, 'wipe ' + params.target + '\\n')
    return { wiped: params.target }
  })
}
`

const HEAR_MAIN = (marker: string) => `
import { appendFileSync } from 'node:fs'
export function activate(context: any) {
  context.subscribe((event: any) => {
    if (event.type === 'hook.received') appendFileSync(${JSON.stringify(marker)}, 'hook ' + JSON.stringify(event) + '\\n')
  })
}
`

const EXTRA_MAIN = `
export function activate(context: any) {
  context.provide('method:acme.extra/ping', () => 'pong')
}
`

function builtinPlugins(marker: string): string {
  const dir = makeTempDir('qd-w2b-')
  writePlugin(
    dir,
    {
      id: 'quirky.ask',
      name: 'Ask',
      version: '1.0.0',
      main: 'main.ts',
      contributes: {
        method: [
          {
            id: 'create',
            params: {
              type: 'object',
              properties: { spec: { type: 'object', additionalProperties: true }, session: { type: 'string' }, worktree: { type: 'string' } },
              required: ['spec']
            }
          },
          {
            id: 'list',
            readOnly: true,
            params: { type: 'object', properties: { askId: { type: 'string' } } }
          },
          {
            id: 'answer',
            params: { type: 'object', properties: { askId: { type: 'string' }, value: { type: 'boolean' } }, required: ['askId', 'value'] }
          }
        ]
      }
    },
    { 'main.ts': FAKE_ASK_MAIN }
  )
  writePlugin(
    dir,
    {
      id: 'acme.tools',
      name: 'Acme tools',
      version: '1.0.0',
      main: 'main.ts',
      contributes: {
        method: [
          { id: 'bump', params: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] } },
          {
            id: 'wipe',
            destructive: true,
            confirm: 'Wipe {target}?',
            params: { type: 'object', properties: { target: { type: 'string' } }, required: ['target'] }
          }
        ],
        setting: [{ id: 'level', type: 'number', title: 'Level', default: 1 }],
        view: [{ id: 'main', title: 'Main' }]
      }
    },
    { 'main.ts': TOOLS_MAIN(marker) }
  )
  writePlugin(
    dir,
    {
      id: 'acme.extra',
      name: 'Acme extra',
      version: '1.0.0',
      main: 'main.ts',
      contributes: { method: [{ id: 'ping', readOnly: true }] }
    },
    { 'main.ts': EXTRA_MAIN }
  )
  writePlugin(
    dir,
    { id: 'acme.hear', name: 'Acme hear', version: '1.0.0', main: 'main.ts', activation: 'startup' },
    { 'main.ts': HEAR_MAIN(marker) }
  )
  return dir
}

async function boot() {
  const marker = join(makeTempDir('qd-w2m-'), 'marker.log')
  const harness = await startHarness({ home: makeTempHome('qd-w2-'), builtinPluginsDir: builtinPlugins(marker) })
  h = harness
  const socket = async (role: 'cli' | 'ui' = 'cli') => {
    const client = await QuirkyClient.connectSocket(harness.runtime.socket!, {
      role,
      name: `w2-${role}`,
      token: harness.runtime.token
    })
    sockets.push(client)
    return client
  }
  return { harness, marker, socket }
}

/** Reads a kernel table straight from the daemon's database, to see what was persisted. */
function rows(harness: Harness, table: 'request_log' | 'confirmations'): Record<string, unknown>[] {
  const db = new Database(join(harness.home, 'quirky.db'), { readonly: true })
  try {
    return db.query(`SELECT * FROM ${table}`).all() as Record<string, unknown>[]
  } finally {
    db.close()
  }
}

async function failure(call: Promise<unknown>): Promise<RpcError> {
  const error = await call.then(
    () => undefined,
    (caught: unknown) => caught
  )
  expect(error).toBeInstanceOf(RpcError)
  return error as RpcError
}

describe('request IDs', () => {
  test('SC-11: a plugin method with a request ID runs once on a repeat', async () => {
    const { harness, marker, socket } = await boot()
    const client = await socket()

    const first = await client.callAny('acme.tools/bump', { key: 'a' }, { requestId: 'r-1' })
    const again = await client.callAny('acme.tools/bump', { key: 'a' }, { requestId: 'r-1' })

    expect(first).toEqual({ count: 1 })
    expect(again).toEqual({ count: 1 })
    expect(readMarker(marker)).toEqual(['bump a'])
    expect(rows(harness, 'request_log').map((row) => row.request_id)).toEqual(['r-1'])
    expect(await client.callAny('acme.tools/bump', { key: 'a' })).toEqual({ count: 2 })
  })

  test('SC-12: the same request ID with other params is a Conflict and runs nothing', async () => {
    const { marker, socket } = await boot()
    const client = await socket()
    await client.callAny('acme.tools/bump', { key: 'a' }, { requestId: 'r-1' })

    const error = await failure(client.callAny('acme.tools/bump', { key: 'b' }, { requestId: 'r-1' }))

    expect(error.code).toBe(RpcErrorCode.Conflict)
    expect(error.message).toBe('request ID reused with different params')
    expect(readMarker(marker)).toEqual(['bump a'])
  })
})

describe('confirmations', () => {
  test('SC-43: a destructive plugin method without yes asks first, then runs once on the answered confirmation', async () => {
    const { harness, marker, socket } = await boot()
    const client = await socket()

    const refused = await failure(client.callAny('acme.tools/wipe', { target: 'cache' }))
    const data = refused.data as { askId: string; action: string }
    expect(refused.code).toBe(-32010)
    expect(data.askId).toMatch(/^ask_/)
    expect(data.action).toBe('Wipe cache?')
    expect(rows(harness, 'confirmations').map((row) => row.ask_id)).toEqual([data.askId])
    expect(readMarker(marker)).toEqual([])

    const early = await failure(client.callAny('acme.tools/wipe', { target: 'cache', confirmation: data.askId }))
    expect(early.message).toBe('confirmation not answered yet')

    await client.callAny('quirky.ask/answer', { askId: data.askId, value: true })
    expect(await client.callAny('acme.tools/wipe', { target: 'cache', confirmation: data.askId })).toEqual({ wiped: 'cache' })
    expect(readMarker(marker)).toEqual(['wipe cache'])

    const reused = await failure(client.callAny('acme.tools/wipe', { target: 'cache', confirmation: data.askId }))
    expect(reused.message).toBe('confirmation already used')
  })

  test('yes: true skips the ask', async () => {
    const { marker, socket } = await boot()
    const client = await socket()
    expect(await client.callAny('acme.tools/wipe', { target: 'cache', yes: true })).toEqual({ wiped: 'cache' })
    expect(readMarker(marker)).toEqual(['wipe cache'])
  })
})

const LIVE_MANIFEST = {
  id: 'acme.live',
  name: 'Live',
  version: '1.0.0',
  main: 'main.ts',
  cliAliases: ['lv'],
  contributes: { method: [{ id: 'hi', readOnly: true }], panel: [{ id: 'notes', title: 'Notes' }] }
}
const LIVE_MAIN = "export function activate(context: any) { context.provide('method:acme.live/hi', () => 'hi') }\n"

function writeLive(): string {
  return writePlugin(makeTempDir('qd-w2s-'), LIVE_MANIFEST, { 'main.ts': LIVE_MAIN })
}

describe('plugin.install', () => {
  test('SC-50: the confirmation of an install carries the SC-49 listing and installs nothing', async () => {
    const { socket } = await boot()
    const client = await socket()
    const source = writeLive()

    const refused = await failure(client.callAny('plugin.install', { path: source }))

    expect(refused.code).toBe(-32010)
    const { action } = refused.data as { askId: string; action: string }
    expect(action).toBe(
      [
        `Install plugin ${source}?`,
        '',
        'acme.live 1.0.0 (Live)',
        'method     method:acme.live/hi',
        'panel      panel:acme.live/notes'
      ].join('\n')
    )
    const listed = (await client.call('plugin.list', {})) as PluginInfo[]
    expect(listed.some((plugin) => plugin.id === 'acme.live')).toBe(false)
  })

  test('yes: true installs the plugin live, with its accepted CLI aliases, and an answered confirmation does too', async () => {
    const { socket } = await boot()
    const client = await socket()
    const source = writeLive()

    const info = (await client.callAny('plugin.install', { path: source, yes: true })) as PluginInfo

    expect(info).toMatchObject({ id: 'acme.live', source: 'installed', cliAliases: ['lv'] })
    expect(await client.callAny('acme.live/hi', {})).toBe('hi')
    const described = (await client.call('api.describe', {})) as ApiDescription
    expect(described.cli.groups).toContainEqual({ plugin: 'acme.live', words: 'acme.live', aliases: ['lv'] })

    await client.callAny('plugin.uninstall', { id: 'acme.live', yes: true })
    const refused = await failure(client.callAny('plugin.install', { path: source }))
    const { askId } = refused.data as { askId: string }
    await client.callAny('quirky.ask/answer', { askId, value: true })
    const confirmed = (await client.callAny('plugin.install', { path: source, confirmation: askId })) as PluginInfo
    expect(confirmed.id).toBe('acme.live')
    expect(await client.callAny('acme.live/hi', {})).toBe('hi')
  })
})

describe('distro.install', () => {
  const LEVEL = 'setting:acme.tools/level'

  function writeNight(): string {
    const dir = join(makeTempDir('qd-w2d-'), 'night')
    mkdirSync(dir)
    const manifest = { id: 'night', name: 'Night', version: '1.0.0', disable: ['acme.extra'], settings: { 'acme.tools/level': 5 } }
    writeFileSync(join(dir, 'quirky-distro.json'), JSON.stringify(manifest))
    return dir
  }

  const levelOf = async (client: QuirkyClient) => (await client.call('setting.get', { id: LEVEL })) as { value: unknown; source: string }

  test('SC-57: the confirmation of a distro install carries the distro listing and installs nothing', async () => {
    const { socket } = await boot()
    const client = await socket()
    const night = writeNight()

    const refused = await failure(client.callAny('distro.install', { path: night }))

    expect(refused.code).toBe(-32010)
    const { action } = refused.data as { action: string }
    expect(action).toBe(
      [
        `Install distro ${night}?`,
        '',
        'distro night 1.0.0 (Night)',
        '',
        'disable    acme.extra',
        `setting    ${LEVEL}  1 \u2192 5`
      ].join('\n')
    )
    expect(await client.call('distro.list', {})).toEqual([])
  })

  test('SC-54: yes: true disables a built-in in the running daemon and layers a setting, and distro.remove restores both', async () => {
    const { socket } = await boot()
    const client = await socket()
    const watcher = await socket('ui')
    const events: QuirkyEvent[] = []
    watcher.onEvent((event) => events.push(event))
    await watcher.call('events.subscribe', {})
    const night = writeNight()
    expect(await client.callAny('acme.extra/ping', {})).toBe('pong')
    expect(await levelOf(client)).toMatchObject({ value: 1, source: 'default' })

    const info = await client.callAny('distro.install', { path: night, yes: true })

    expect(info).toMatchObject({ id: 'night', plugins: [] })
    const listed = (await client.call('plugin.list', {})) as PluginInfo[]
    expect(listed.find((plugin) => plugin.id === 'acme.extra')).toMatchObject({ state: 'disabled', disabledReason: 'distro' })
    expect((await failure(client.callAny('acme.extra/ping', {}))).code).toBe(RpcErrorCode.MethodNotFound)
    expect(await levelOf(client)).toMatchObject({ value: 5, source: 'distro' })
    await waitFor(() => events.some((event) => event.type === 'setting.changed' && event.value === 5))

    await client.callAny('distro.remove', { id: 'night', yes: true })

    expect(await client.callAny('acme.extra/ping', {})).toBe('pong')
    expect(await levelOf(client)).toMatchObject({ value: 1, source: 'default' })
    expect(await client.call('distro.list', {})).toEqual([])
  })
})

describe('hook.received', () => {
  test('a hook POST with the hook token reaches a plugin listener and no subscribed client', async () => {
    const { harness, marker, socket } = await boot()
    const watcher = await socket('ui')
    const events: QuirkyEvent[] = []
    watcher.onEvent((event) => events.push(event))
    await watcher.call('events.subscribe', {})

    const response = await fetch(`http://127.0.0.1:${harness.runtime.port}/hook/claude?session=s_none`, {
      method: 'POST',
      headers: { [HOOK_TOKEN_HEADER]: harness.runtime.hookToken },
      body: JSON.stringify({ hook_event_name: 'Stop' })
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
    const heard = await waitFor(() => readMarker(marker).find((line) => line.startsWith('hook ')))
    expect(JSON.parse(heard.slice('hook '.length))).toEqual({
      type: 'hook.received',
      agent: 'claude',
      sessionId: 's_none',
      payload: { hook_event_name: 'Stop' }
    })
    await Bun.sleep(50)
    expect(events.some((event) => event.type === 'hook.received')).toBe(false)
  })
})

describe('layout', () => {
  test('SC-35: ui.state on one connection reflects ui.view.open from another', async () => {
    const { socket } = await boot()
    const opener = await socket('cli')
    const window = await socket('ui')
    const view = 'view:acme.tools/main'

    const opened = await opener.callAny('ui.view.open', { id: view, input: { page: 2 } })

    expect(opened).toMatchObject({ view: { id: view, input: { page: 2 } } })
    const state = (await window.callAny('ui.state', {})) as {
      layout: { view: unknown }
      windows: { name?: string }[]
      slots: { id: string; shown: boolean }[]
    }
    expect(state.layout.view).toEqual({ id: view, input: { page: 2 } })
    expect(state.windows.map((entry) => entry.name)).toEqual(['w2-ui'])
    expect(state.slots.find((slot) => slot.id === view)?.shown).toBe(true)
  })
})
