import { afterEach, describe, expect, test } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { startHarness, waitFor, type Harness } from '../helpers'
import { makeTempDir, readMarker, removeTempDirs, waitForFile, writeModulePlugin, type ModuleBehavior } from './fixtures'

const pluginId = 'acme.fail'

let harness: Harness | null = null

afterEach(async () => {
  await harness?.cleanup()
  harness = null
  removeTempDirs()
})

async function boot(behavior: ModuleBehavior, options: { pluginActivationTimeoutMs?: number } = {}) {
  const pluginsDir = makeTempDir('qd-activation-failure-plugins-')
  const marker = join(makeTempDir('qd-activation-failure-marker-'), 'marker.log')
  const logs: string[] = []
  writeModulePlugin(pluginsDir, marker, { id: pluginId }, behavior)
  const started = await startHarness({
    builtinPluginsDir: pluginsDir,
    log: (message) => logs.push(message),
    ...options
  })
  harness = started
  return { harness: started, marker, logs }
}

describe('failed plugin activation cleanup', () => {
  test('deactivates a plugin after activate throws and preserves its failure diagnostic', async () => {
    const { harness, marker } = await boot({ activate: "throw new Error('boom')" })

    await expect(harness.daemon.plugins.activate(pluginId)).rejects.toThrow('acme.fail failed to activate: boom')

    expect(readMarker(marker)).toEqual(['import acme.fail', 'activate acme.fail', 'deactivate acme.fail'])
    expect(harness.daemon.plugins.list().find((plugin) => plugin.id === pluginId)!).toMatchObject({
      state: 'failed',
      diagnostics: expect.arrayContaining([{ level: 'error', message: 'boom' }])
    })
  })

  test('runs deactivate before revoking the failed activation context', async () => {
    const { harness, logs } = await boot({
      imports: ['let savedContext: { subscribe: (listener: () => void) => unknown; log: (message: string) => void }'],
      activate: "savedContext = context; throw new Error('boom')",
      deactivate: "savedContext.subscribe(() => {}); savedContext.log('still live')"
    })

    await expect(harness.daemon.plugins.activate(pluginId)).rejects.toThrow('acme.fail failed to activate: boom')

    expect(logs).toContain('acme.fail: still live')
    expect(logs.some((line) => line.includes('deactivate failed'))).toBe(false)
  })

  test('waits for an async deactivate before revoking the failed activation context', async () => {
    const { harness, logs } = await boot({
      imports: ['let savedContext: { subscribe: (listener: () => void) => unknown; log: (message: string) => void }'],
      activate: "savedContext = context; throw new Error('boom')",
      deactivate: "await Bun.sleep(50); savedContext.subscribe(() => {}); savedContext.log('still live after waiting')"
    })

    await expect(harness.daemon.plugins.activate(pluginId)).rejects.toThrow('acme.fail failed to activate: boom')

    expect(logs).toContain('acme.fail: still live after waiting')
    expect(logs.some((line) => line.includes('deactivate failed'))).toBe(false)
  })

  test('waits for an async deactivate when the plugin is disabled while it activates', async () => {
    const gate = join(makeTempDir('qd-activation-failure-gate-'), 'release')
    const { harness, marker } = await boot({
      activate: waitForFile(gate),
      deactivate: "await Bun.sleep(50); record('deactivate finished')"
    })
    let outcome: Promise<unknown> | undefined
    let disabling: Promise<unknown> | undefined

    try {
      outcome = harness.daemon.plugins.activate(pluginId).then(() => null, (error) => error)
      await waitFor(() => readMarker(marker).includes('activate acme.fail'))
      disabling = harness.daemon.plugins.setEnabled(pluginId, false)
      writeFileSync(gate, '')

      const expectedLines = [
        'import acme.fail',
        'activate acme.fail',
        'deactivate acme.fail',
        'deactivate finished'
      ]
      expect(await outcome).toMatchObject({ message: 'acme.fail was disabled during activation' })
      expect(readMarker(marker)).toEqual(expectedLines)

      await disabling
      expect(readMarker(marker)).toEqual(expectedLines)
    } finally {
      writeFileSync(gate, '')
      if (outcome) await outcome
      if (disabling) await disabling
      if (readMarker(marker).includes('deactivate acme.fail')) {
        await waitFor(() => readMarker(marker).includes('deactivate finished'))
      }
    }
  })

  test('keeps the activation failure when deactivate also throws', async () => {
    const { harness, logs } = await boot({
      activate: "throw new Error('boom')",
      deactivate: "throw new Error('bad cleanup')"
    })

    await expect(harness.daemon.plugins.activate(pluginId)).rejects.toThrow('acme.fail failed to activate: boom')

    expect(harness.daemon.plugins.list().find((plugin) => plugin.id === pluginId)!).toMatchObject({
      state: 'failed',
      diagnostics: expect.arrayContaining([{ level: 'error', message: 'boom' }])
    })
    expect(logs).toContain('plugin acme.fail: deactivate failed: bad cleanup')
  })

  test('does not call deactivate when the module has no deactivate export', async () => {
    const { harness, marker } = await boot({ activate: "throw new Error('boom')", omitDeactivate: true })

    await expect(harness.daemon.plugins.activate(pluginId)).rejects.toThrow('acme.fail failed to activate: boom')

    expect(readMarker(marker)).toEqual(['import acme.fail', 'activate acme.fail'])
    expect(harness.daemon.plugins.list().find((plugin) => plugin.id === pluginId)!.state).toBe('failed')
  })

  test('does not call deactivate when importing the module fails', async () => {
    const { harness, marker } = await boot({ imports: ["throw new Error('import boom')"] })

    await expect(harness.daemon.plugins.activate(pluginId)).rejects.toThrow('acme.fail failed to activate: import boom')

    expect(readMarker(marker)).not.toContain('deactivate acme.fail')
  })

  test('deactivates a timed-out activation exactly once', async () => {
    const gate = join(makeTempDir('qd-activation-failure-gate-'), 'release')
    const { harness, marker } = await boot(
      { activate: `${waitForFile(gate)}; record('activation returned')` },
      { pluginActivationTimeoutMs: 1000 }
    )
    const attempt = harness.daemon.plugins.activate(pluginId)
    const rejected = expect(attempt).rejects.toThrow(/timed out/i)
    let started = false

    try {
      await waitFor(() => {
        started = readMarker(marker).includes('activate acme.fail')
        return started
      })
      await rejected
      expect(readMarker(marker).filter((line) => line === 'deactivate acme.fail')).toHaveLength(1)
    } finally {
      writeFileSync(gate, '')
      if (started) await waitFor(() => readMarker(marker).includes('activation returned'))
    }

    expect(readMarker(marker).filter((line) => line === 'deactivate acme.fail')).toHaveLength(1)
  })

  test('can retry a failed activation and deactivate the successful retry on stop', async () => {
    const flag = join(makeTempDir('qd-activation-failure-retry-'), 'allow')
    const { harness: startedHarness, marker } = await boot({
      activate: `if (!existsSync(${JSON.stringify(flag)})) throw new Error('boom')`
    })

    await expect(startedHarness.daemon.plugins.activate(pluginId)).rejects.toThrow('acme.fail failed to activate: boom')
    writeFileSync(flag, '')
    expect((await startedHarness.daemon.plugins.activate(pluginId)).state).toBe('active')

    await startedHarness.cleanup()
    harness = null
    expect(readMarker(marker).filter((line) => line === 'deactivate acme.fail')).toHaveLength(2)
  })
})
