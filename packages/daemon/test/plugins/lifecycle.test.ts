import { afterEach, describe, expect, test } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { makeTempHome, startHarness, waitFor, type Harness } from '../helpers'
import { makeTempDir, readMarker, removeTempDirs, writePlugin } from './fixtures'

let h: Harness | null = null
afterEach(async () => {
  await h?.cleanup()
  h = null
  removeTempDirs()
})

const JOB = 'job:acme.all/long'

/**
 * A startup plugin that holds a listener, an open store, a running job and a reference to its first
 * context, all in module scope so `probe` can try them after a disable and re-enable.
 */
function allSource(marker: string, gate: string, deactivateGate?: string): string {
  return `
import { appendFileSync, existsSync } from 'node:fs'
const record = (line: string) => appendFileSync(${JSON.stringify(marker)}, line + '\\n')
let savedContext: any
let savedStore: any

export function activate(context: any) {
  savedContext ??= context
  savedStore ??= context.openStore(['CREATE TABLE t (n INTEGER)'])
  context.subscribe((event: any) => record('event ' + event.type))
  context.provide('job:acme.all/long', async ({ signal }: { signal: AbortSignal }) => {
    record('job started')
    while (!existsSync(${JSON.stringify(gate)}) && !signal.aborted) await Bun.sleep(5)
    record(signal.aborted ? 'job aborted' : 'job finished')
  })
  context.provide('method:acme.all/probe', async () => {
    const message = async (use: () => unknown) => {
      try {
        await use()
        return 'no error'
      } catch (error: any) {
        return error.message
      }
    }
    return {
      emit: await message(() => savedContext.emit('ping', {})),
      call: await message(() => savedContext.call('job.list', {})),
      openStore: await message(() => savedContext.openStore(['CREATE TABLE t (n INTEGER)'])),
      store: await message(() => savedStore.version),
    }
  })
}

export async function deactivate() {
  record('deactivate')
  ${deactivateGate === undefined ? '' : `while (!existsSync(${JSON.stringify(deactivateGate)})) await Bun.sleep(5)`}
}
`
}

describe('plugin lifecycle', () => {
  test('SC-27: deactivation revokes everything the context handed out', async () => {
    const home = makeTempHome()
    const scratch = makeTempDir()
    const marker = join(scratch, 'marker.log')
    const gate = join(scratch, 'gate')
    writePlugin(
      join(home, 'plugins'),
      {
        id: 'acme.all',
        name: 'acme.all',
        version: '1.0.0',
        main: 'main.ts',
        activation: 'startup',
        contributes: { method: [{ id: 'probe' }], event: [{ id: 'ping' }], job: [{ id: 'long', interval: '1h' }] }
      },
      { 'main.ts': allSource(marker, gate) }
    )
    h = await startHarness({ home, builtinPluginsDir: null })
    const client = await h.connect()
    const lines = () => readMarker(marker)
    const info = async () => (await client.call('plugin.list', {})).find((plugin) => plugin.id === 'acme.all')!
    expect((await info()).state).toBe('active')

    // the listener is live while the plugin is active
    await client.call('ui.sidebar.set', { visible: false })
    await waitFor(() => lines().includes('event ui.state.changed'))

    const running = client.call('job.run', { id: JOB })
    await waitFor(() => lines().includes('job started'))
    expect((await client.call('job.list', {}))[0]).toMatchObject({ id: JOB, state: 'running' })

    await client.call('plugin.disable', { id: 'acme.all' })
    expect((await info()).state).toBe('disabled')

    // the job's stop signal fired and the in-flight job.run settled
    await waitFor(() => lines().includes('job aborted'))
    expect(lines()).not.toContain('job finished')
    expect(await running).toMatchObject({ status: 'failed', error: 'acme.all was revoked' })

    // events after the disable never reach the listener
    const seen = lines().filter((line) => line.startsWith('event ')).length
    await client.call('ui.sidebar.set', { visible: true })
    await Bun.sleep(100)
    expect(lines().filter((line) => line.startsWith('event ')).length).toBe(seen)

    // re-enabling re-activates the cached module, whose saved context and store are the first activation's
    await client.call('plugin.enable', { id: 'acme.all' })
    const gone = 'acme.all is no longer active'
    expect(await client.callAny('acme.all/probe', {})).toEqual({ emit: gone, call: gone, openStore: gone, store: gone })
  })

  test('rescan blocks activation until stale runtime cleanup finishes', async () => {
    const home = makeTempHome()
    const scratch = makeTempDir()
    const marker = join(scratch, 'marker.log')
    const gate = join(scratch, 'gate')
    const pluginsDir = join(home, 'plugins')
    const manifest = (version: string) => ({
      id: 'acme.all',
      name: 'acme.all',
      version,
      main: 'main.ts',
      activation: 'startup',
      contributes: { method: [{ id: 'probe' }], event: [{ id: 'ping' }], job: [{ id: 'long', interval: '1h' }] }
    })
    const lines = () => readMarker(marker)
    writePlugin(pluginsDir, manifest('1.0.0'), { 'main.ts': allSource(marker, gate, gate) })
    h = await startHarness({ home, builtinPluginsDir: null })
    const client = await h.connect()

    writePlugin(pluginsDir, manifest('2.0.0'), { 'main.ts': allSource(marker, gate) })
    const rescanning = h.daemon.plugins.rescan()
    try {
      await waitFor(() => lines().includes('deactivate'))
      await expect(h.daemon.plugins.activate('acme.all')).rejects.toThrow('acme.all is being replaced')
    } finally {
      writeFileSync(gate, '')
    }
    await rescanning

    expect((await h.daemon.plugins.activate('acme.all')).state).toBe('active')
    const eventsBefore = lines().filter((line) => line === 'event ui.state.changed').length
    await client.call('ui.sidebar.set', { visible: false })
    await waitFor(() => lines().filter((line) => line === 'event ui.state.changed').length > eventsBefore)
    expect(await client.callAny('acme.all/probe', {})).toEqual({
      emit: 'no error',
      call: 'no error',
      openStore: 'no error',
      store: 'no error'
    })
  })
})
