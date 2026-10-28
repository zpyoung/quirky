import { expect, test } from 'bun:test'
import { mkdirSync, rmSync, symlinkSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { makeTempHome, startHarness, type Harness } from '../../../packages/daemon/test/helpers'
import { writePlugin } from '../../../packages/daemon/test/plugins/fixtures'
import { isolateGitConfig } from '../../quirky.repo/test/git-fixtures'
import type { StructuredRunnerFactory } from '../runner'

isolateGitConfig()
const globals = globalThis as typeof globalThis & { __QUIRKY_TEST_STRUCTURED_RUNNER__?: StructuredRunnerFactory }
const BUILTINS = ['quirky.agents', 'quirky.ask', 'quirky.repo', 'quirky.session', 'quirky.structured', 'quirky.worktree']

test('a startup creator keeps its deferred structured session while a lazy plugin activates', async () => {
  const home = makeTempHome('structured-startup-owner-')
  const folderPath = join(home, 'folder-workspace')
  const ownerId = 'acme.structured-startup-owner'
  const pulseId = 'acme.structured-startup-pulse'
  const oldHome = process.env.HOME
  const oldQuirkyHome = process.env.QUIRKY_HOME
  const oldRunnerFactory = globals.__QUIRKY_TEST_STRUCTURED_RUNNER__
  let harness: Harness | undefined

  try {
    process.env.HOME = home
    process.env.QUIRKY_HOME = home
    mkdirSync(folderPath)
    globals.__QUIRKY_TEST_STRUCTURED_RUNNER__ = (context) => ({
      async start(session, prompt) {
        if (prompt !== undefined) throw new Error('Deferred startup session unexpectedly started a provider turn')
        context.setStatus(session.id, 'running')
      },
      async send() { throw new Error('Deferred startup session unexpectedly received a provider turn') },
      async stop(sessionId) { context.setStatus(sessionId, 'exited') }
    })

    const builtins = join(home, 'builtins')
    mkdirSync(builtins)
    for (const id of BUILTINS) symlinkSync(resolve(import.meta.dir, '../..', id), join(builtins, id))

    writePlugin(join(home, 'plugins'), {
      id: ownerId,
      name: 'Structured startup owner',
      version: '1.0.0',
      main: 'main.ts',
      activation: 'startup',
      dependencies: ['quirky.structured'],
      contributes: { method: [{ id: 'preparedSession', params: { type: 'object', additionalProperties: false } }] }
    }, {
      'main.ts': `import type { PluginContext } from '@quirky/protocol'
let preparedSessionId: string | undefined
export async function activate(context: PluginContext): Promise<void> {
  await context.call('quirky.repo/add', { path: ${JSON.stringify(folderPath)}, folder: true })
  const worktree = await context.call('quirky.worktree/resolve', { selector: ${JSON.stringify(`path:${folderPath}`)} }) as { id: string }
  const session = await context.call('quirky.structured/create', {
    worktree: worktree.id,
    agent: 'claude',
    background: true,
    deferStart: true
  }) as { id: string }
  preparedSessionId = session.id
  await context.call('${pulseId}/pulse', {})
  context.provide('method:${ownerId}/preparedSession', () => ({ sessionId: preparedSessionId }))
}
`
    })
    writePlugin(join(home, 'plugins'), {
      id: pulseId,
      name: 'Structured startup pulse',
      version: '1.0.0',
      main: 'main.ts',
      activation: 'lazy',
      dependencies: ['quirky.repo'],
      contributes: { method: [{ id: 'pulse', params: { type: 'object', additionalProperties: false } }] }
    }, {
      'main.ts': `import type { PluginContext } from '@quirky/protocol'
export async function activate(context: PluginContext): Promise<void> {
  await context.call('quirky.repo/add', { path: ${JSON.stringify(folderPath)}, folder: true })
  context.provide('method:${pulseId}/pulse', () => null)
}
`
    })

    harness = await startHarness({ home, builtinPluginsDir: builtins })
    const client = await harness.connect()
    await client.call('plugin.list', {})
    const prepared = await client.callAny(`${ownerId}/preparedSession`, {}) as { sessionId?: unknown }
    if (typeof prepared.sessionId !== 'string') throw new Error('startup owner did not expose its prepared session ID')

    const session = await client.callAny('quirky.session/get', { session: prepared.sessionId }) as {
      status?: unknown
      background?: unknown
      worktreeId?: unknown
    }
    expect(session.status).not.toBe('exited')
    expect(session.background).toBe(true)
    if (typeof session.worktreeId !== 'string') throw new Error('prepared session has no worktree ID')
    const listed = await client.callAny('quirky.session/list', { worktree: session.worktreeId }) as { id?: unknown }[]
    expect(listed.some((item) => item.id === prepared.sessionId)).toBe(true)
    expect(await client.callAny('quirky.structured/messages', { session: prepared.sessionId })).toEqual([])
  } finally {
    try {
      await harness?.cleanup()
    } finally {
      if (oldHome === undefined) delete process.env.HOME
      else process.env.HOME = oldHome
      if (oldQuirkyHome === undefined) delete process.env.QUIRKY_HOME
      else process.env.QUIRKY_HOME = oldQuirkyHome
      if (oldRunnerFactory === undefined) delete globals.__QUIRKY_TEST_STRUCTURED_RUNNER__
      else globals.__QUIRKY_TEST_STRUCTURED_RUNNER__ = oldRunnerFactory
      rmSync(home, { recursive: true, force: true })
    }
  }
}, 20_000)
