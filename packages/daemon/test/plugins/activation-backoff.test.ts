import { afterEach, describe, expect, test } from 'bun:test'
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { RpcErrorCode, type QuirkyEvent } from '@quirky/protocol'
import { PluginHost, type ContextExtension } from '../../src/plugins/host'
import { makeTempDir, readMarker, removeTempDirs, writeModulePlugin, writePlugin, type ModuleBehavior } from './fixtures'

const hosts: PluginHost[] = []

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.stop()
  removeTempDirs()
})

const BROKEN_METHOD = 'method:acme.broken/go'
const DEP_METHOD = 'method:acme.dep/go'
const TOP_METHOD = 'method:acme.top/go'
const BROKEN_ERROR = {
  code: RpcErrorCode.Conflict,
  message: 'acme.broken failed to activate: boom'
}
const DEP_ERROR = {
  code: RpcErrorCode.Conflict,
  message: 'acme.dep failed to activate: dependency acme.broken failed to activate'
}
const TOP_ERROR = {
  code: RpcErrorCode.Conflict,
  message: 'acme.top failed to activate: dependency acme.dep failed to activate'
}

type SetupOptions = {
  timeoutMs?: number
  withExtension?: boolean
  throwOnCreate?: boolean
}

function setup(options: SetupOptions = {}) {
  const root = makeTempDir('qd-activation-backoff-')
  const builtinDir = join(root, 'builtin')
  const installedDir = join(root, 'installed')
  mkdirSync(builtinDir)
  mkdirSync(installedDir)
  const marker = join(root, 'marker.log')
  const gate = join(root, 'gate')
  const disabled = new Set<string>()
  const events: QuirkyEvent[] = []
  const logs: string[] = []
  let clock = 50_000
  const record = (line: string) => appendFileSync(marker, `${line}\n`)
  const extension: ContextExtension = {
    create: (plugin) => {
      record(`create ${plugin.id}`)
      if (options.throwOnCreate) throw new Error('create blew up')
      return {
        dataDir: `/data/${plugin.id}`,
        createFileResource: async () => {
          throw new Error('unused')
        },
        home: '/home',
        pty: {} as never,
        notify: () => undefined,
        launch: {} as never,
        emit: () => true,
        subscribe: () => () => undefined,
        call: async () => null,
        openStore: () => {
          throw new Error('unused')
        },
        getSetting: () => undefined,
        error: (_kind, message) => new Error(message)
      }
    },
    revoke: (pluginId) => record(`revoke ${pluginId}`)
  }
  const host = new PluginHost({
    builtinDir,
    installedDir,
    store: {
      listDisabledIds: () => [...disabled].sort(),
      setDisabledId: (id, isDisabled) => {
        if (isDisabled) disabled.add(id)
        else disabled.delete(id)
      }
    },
    emit: (event) => events.push(event),
    log: (message) => logs.push(message),
    activationTimeoutMs: options.timeoutMs ?? 100,
    now: () => clock,
    ...(options.withExtension === false ? {} : { extension })
  })
  hosts.push(host)
  const installed = (manifest: { id: string } & Record<string, unknown>, behavior?: ModuleBehavior) =>
    writeModulePlugin(installedDir, marker, manifest, behavior)
  const lines = () => readMarker(marker)
  const stateOf = (id: string) => host.list().find((plugin) => plugin.id === id)?.state
  const diagnosticsOf = (id: string) => host.list().find((plugin) => plugin.id === id)?.diagnostics
  const setNow = (value: number) => {
    clock = value
  }
  const now = () => clock
  const release = () => writeFileSync(gate, '')
  return {
    root,
    host,
    events,
    logs,
    disabled,
    marker,
    gate,
    installedDir,
    installed,
    lines,
    stateOf,
    diagnosticsOf,
    setNow,
    now,
    release
  }
}

type TestSetup = ReturnType<typeof setup>

function installBroken(t: TestSetup): void {
  t.installed(
    { id: 'acme.broken', contributes: { method: [{ id: 'go' }] } },
    {
      activate: `if (!existsSync(${JSON.stringify(t.gate)})) throw new Error('boom')\n` +
        `context.provide(${JSON.stringify(BROKEN_METHOD)}, () => 'recovered')`
    }
  )
}

function installDependents(t: TestSetup): void {
  installBroken(t)
  t.installed(
    { id: 'acme.dep', dependencies: ['acme.broken'], contributes: { method: [{ id: 'go' }] } },
    { activate: `context.provide(${JSON.stringify(DEP_METHOD)}, () => 'dependent')` }
  )
  t.installed(
    { id: 'acme.top', dependencies: ['acme.dep'], contributes: { method: [{ id: 'go' }] } },
    { activate: `context.provide(${JSON.stringify(TOP_METHOD)}, () => 'top')` }
  )
}

function attemptCount(t: TestSetup, id: string): number {
  return t.lines().filter((line) => line === `activate ${id}`).length
}

async function expectBrokenFailure(t: TestSetup, useImplementation = false): Promise<void> {
  const request = useImplementation ? t.host.resolveImplementation(BROKEN_METHOD) : t.host.resolve(BROKEN_METHOD)
  await expect(request).rejects.toMatchObject(BROKEN_ERROR)
}

async function expectDepFailure(t: TestSetup): Promise<void> {
  await expect(t.host.resolve(DEP_METHOD)).rejects.toMatchObject(DEP_ERROR)
}

async function expectTopFailure(t: TestSetup): Promise<void> {
  await expect(t.host.resolve(TOP_METHOD)).rejects.toMatchObject(TOP_ERROR)
}

describe('activation backoff', () => {
  test('refuses calls during the first delay without attempts, events, or logs', async () => {
    const t = setup()
    installBroken(t)
    t.host.load()
    const failedAt = t.now()
    await expectBrokenFailure(t)
    expect(t.stateOf('acme.broken')).toBe('failed')
    expect(t.lines().filter((line) => line === 'activate acme.broken')).toHaveLength(1)
    const linesAfterFailure = t.lines()
    const eventsAfterFailure = t.events.length
    const logsAfterFailure = [...t.logs]

    for (let index = 0; index < 4; index++) await expectBrokenFailure(t, true)
    t.setNow(failedAt + 999)
    await expectBrokenFailure(t, true)

    expect(t.lines()).toEqual(linesAfterFailure)
    expect(t.events).toHaveLength(eventsAfterFailure)
    expect(t.logs).toEqual(logsAfterFailure)
  })

  test('retries at exactly 1,000 ms', async () => {
    const t = setup()
    installBroken(t)
    t.host.load()
    const failedAt = t.now()
    await expectBrokenFailure(t)
    t.setNow(failedAt + 999)
    await expectBrokenFailure(t)
    expect(attemptCount(t, 'acme.broken')).toBe(1)
    t.setNow(failedAt + 1_000)
    await expectBrokenFailure(t)
    expect(attemptCount(t, 'acme.broken')).toBe(2)
  })

  test('doubles each delay to the 300,000 ms cap and honors both boundaries', async () => {
    const t = setup()
    installBroken(t)
    t.host.load()
    const delays = [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 64_000, 128_000, 256_000, 300_000, 300_000]
    await expectBrokenFailure(t)
    let failures = 1

    for (const delay of delays) {
      const failedAt = t.now()
      const eventsAfterFailure = t.events.length
      const logsAfterFailure = t.logs.length
      t.setNow(failedAt + delay - 1)
      await expectBrokenFailure(t)
      expect(attemptCount(t, 'acme.broken')).toBe(failures)
      expect(t.events).toHaveLength(eventsAfterFailure)
      expect(t.logs).toHaveLength(logsAfterFailure)

      t.setNow(failedAt + delay)
      await expectBrokenFailure(t)
      failures++
      expect(attemptCount(t, 'acme.broken')).toBe(failures)
      expect(t.events).toHaveLength(eventsAfterFailure + 2)
      expect(t.logs).toHaveLength(logsAfterFailure + 1)
    }
    expect(failures).toBe(12)
  })

  test('explicit activation skips the hold and its failure starts a fresh doubled delay', async () => {
    const t = setup()
    installBroken(t)
    t.host.load()
    const failedAt = t.now()
    await expectBrokenFailure(t)
    t.setNow(failedAt + 1)
    await expect(t.host.activate('acme.broken')).rejects.toMatchObject(BROKEN_ERROR)
    expect(attemptCount(t, 'acme.broken')).toBe(2)

    t.setNow(failedAt + 1 + 1_999)
    await expectBrokenFailure(t)
    expect(attemptCount(t, 'acme.broken')).toBe(2)
    t.setNow(failedAt + 1 + 2_000)
    await expectBrokenFailure(t)
    expect(attemptCount(t, 'acme.broken')).toBe(3)
  })

  test('a retry succeeds at the third delay boundary and clears diagnostics', async () => {
    const t = setup()
    installBroken(t)
    t.host.load()
    const failedAt = t.now()
    await expectBrokenFailure(t)
    t.setNow(failedAt + 1_000)
    await expectBrokenFailure(t)
    t.setNow(failedAt + 3_000)
    await expectBrokenFailure(t)
    expect(attemptCount(t, 'acme.broken')).toBe(3)

    t.release()
    t.setNow(failedAt + 3_000 + 3_999)
    await expectBrokenFailure(t)
    expect(attemptCount(t, 'acme.broken')).toBe(3)
    t.setNow(failedAt + 3_000 + 4_000)
    const implementation = await t.host.resolveImplementation(BROKEN_METHOD) as () => string
    expect(implementation()).toBe('recovered')
    expect(t.stateOf('acme.broken')).toBe('active')
    expect(t.diagnosticsOf('acme.broken')).toEqual([])
    expect(attemptCount(t, 'acme.broken')).toBe(4)
  })

  test('disabling and enabling resets the failure count and delay', async () => {
    const t = setup()
    installBroken(t)
    t.host.load()
    const failedAt = t.now()
    await expectBrokenFailure(t)
    await t.host.setEnabled('acme.broken', false)
    await t.host.setEnabled('acme.broken', true)

    t.setNow(failedAt + 1)
    await expectBrokenFailure(t)
    expect(attemptCount(t, 'acme.broken')).toBe(2)
    t.setNow(failedAt + 1 + 999)
    await expectBrokenFailure(t)
    expect(attemptCount(t, 'acme.broken')).toBe(2)
    t.setNow(failedAt + 1 + 1_000)
    await expectBrokenFailure(t)
    expect(attemptCount(t, 'acme.broken')).toBe(3)
  })

  test('replacing a failed plugin clears its delay', async () => {
    const t = setup()
    installBroken(t)
    t.host.load()
    const failedAt = t.now()
    await expectBrokenFailure(t)

    await t.host.replacePlugin('acme.broken', () => {
      t.installed(
        { id: 'acme.broken', contributes: { method: [{ id: 'go' }] } },
        { activate: `context.provide(${JSON.stringify(BROKEN_METHOD)}, () => 'replacement')` }
      )
    })
    t.setNow(failedAt + 1)
    const implementation = await t.host.resolveImplementation(BROKEN_METHOD) as () => string
    expect(implementation()).toBe('replacement')
    expect(t.stateOf('acme.broken')).toBe('active')
  })

  test('a backwards clock does not keep a failed plugin held', async () => {
    const t = setup()
    installBroken(t)
    t.host.load()
    const failedAt = t.now()
    await expectBrokenFailure(t)
    t.setNow(failedAt - 60_000)
    await expectBrokenFailure(t)
    expect(attemptCount(t, 'acme.broken')).toBe(2)
  })

  test('a stopped host rejects before consulting a failed plugin backoff', async () => {
    const t = setup()
    installBroken(t)
    t.host.load()
    const failedAt = t.now()
    await expectBrokenFailure(t)
    await t.host.stop()
    t.setNow(failedAt + 1)
    await expect(t.host.resolve(BROKEN_METHOD)).rejects.toMatchObject({
      code: RpcErrorCode.Conflict,
      message: 'the plugin host is stopped'
    })
    expect(attemptCount(t, 'acme.broken')).toBe(1)
  })

  test('a dependent makes one dependency attempt and records the exact blocked failure', async () => {
    const t = setup()
    installDependents(t)
    t.host.load()
    const first = t.host.resolve(DEP_METHOD)
    await expect(first).rejects.toMatchObject(DEP_ERROR)
    const firstEvents = t.events.length
    const firstLogs = [...t.logs]
    const firstLines = t.lines()

    for (let index = 0; index < 2; index++) await expectDepFailure(t)
    expect(attemptCount(t, 'acme.broken')).toBe(1)
    expect(t.lines().filter((line) => line === 'import acme.dep')).toHaveLength(0)
    expect(t.stateOf('acme.dep')).toBe('failed')
    expect(t.diagnosticsOf('acme.dep')).toEqual([
      { level: 'error', message: 'dependency acme.broken failed to activate' }
    ])
    expect(t.logs).toEqual([
      'plugin acme.broken failed to activate: boom',
      'plugin acme.dep: dependency acme.broken failed: acme.broken failed to activate: boom',
      'plugin acme.dep failed to activate: dependency acme.broken failed to activate'
    ])
    expect(firstLogs).toEqual(t.logs)
    expect(firstLines.filter((line) => line === 'activate acme.broken')).toHaveLength(1)
    expect(t.events).toHaveLength(firstEvents)
  })

  test('a dependent retries when its dependency delay ends', async () => {
    const t = setup()
    installDependents(t)
    t.host.load()
    const failedAt = t.now()
    await expectDepFailure(t)
    t.setNow(failedAt + 1_000)
    await expectDepFailure(t)
    expect(attemptCount(t, 'acme.broken')).toBe(2)
    expect(t.lines()).not.toContain('import acme.dep')
  })

  test('dependency failures do not grow the dependent count and recovery activates it immediately', async () => {
    const t = setup()
    installDependents(t)
    t.host.load()
    const failedAt = t.now()
    await expectDepFailure(t)
    await expectDepFailure(t)
    t.release()
    t.setNow(failedAt + 10)
    expect((await t.host.activate('acme.broken')).state).toBe('active')

    const implementation = await t.host.resolveImplementation(DEP_METHOD) as () => string
    expect(implementation()).toBe('dependent')
    expect(t.stateOf('acme.dep')).toBe('active')
    expect(attemptCount(t, 'acme.dep')).toBe(1)
  })

  test('explicit activation of a dependent forces its failed dependency to retry', async () => {
    const t = setup()
    installDependents(t)
    t.host.load()
    const failedAt = t.now()
    await expectDepFailure(t)
    t.setNow(failedAt + 1)
    await expect(t.host.activate('acme.dep')).rejects.toMatchObject(DEP_ERROR)
    expect(attemptCount(t, 'acme.broken')).toBe(2)
  })

  const chainLogs = [
    'plugin acme.broken failed to activate: boom',
    'plugin acme.dep: dependency acme.broken failed: acme.broken failed to activate: boom',
    'plugin acme.dep failed to activate: dependency acme.broken failed to activate',
    'plugin acme.top: dependency acme.dep failed: acme.dep failed to activate: dependency acme.broken failed to activate',
    'plugin acme.top failed to activate: dependency acme.dep failed to activate'
  ]

  test('a three-plugin chain stays quiet for repeated calls inside the end plugin delay', async () => {
    const t = setup()
    installDependents(t)
    t.host.load()
    const failedAt = t.now()
    await expectTopFailure(t)
    expect(t.events).toHaveLength(6)
    expect(t.logs).toEqual(chainLogs)
    expect(t.lines().filter((line) => line === 'activate acme.broken')).toHaveLength(1)
    expect(t.lines()).not.toContain('import acme.dep')
    expect(t.lines()).not.toContain('import acme.top')
    const firstLines = t.lines()
    const firstEvents = t.events.length
    const firstLogs = [...t.logs]

    await expectTopFailure(t)
    await expectTopFailure(t)
    t.setNow(failedAt + 999)
    await expectTopFailure(t)
    expect(t.lines()).toEqual(firstLines)
    expect(t.events).toHaveLength(firstEvents)
    expect(t.logs).toEqual(firstLogs)
  })

  test('the chain retries at the failed plugin delay boundary', async () => {
    const t = setup()
    installDependents(t)
    t.host.load()
    const failedAt = t.now()
    await expectTopFailure(t)
    t.setNow(failedAt + 1_000)
    await expectTopFailure(t)
    expect(attemptCount(t, 'acme.broken')).toBe(2)
  })

  test('the chain recovers as soon as its last failed dependency activates', async () => {
    const t = setup()
    installDependents(t)
    t.host.load()
    const failedAt = t.now()
    await expectTopFailure(t)
    t.release()
    t.setNow(failedAt + 10)
    expect((await t.host.activate('acme.broken')).state).toBe('active')

    const implementation = await t.host.resolveImplementation(TOP_METHOD) as () => string
    expect(implementation()).toBe('top')
    expect(t.stateOf('acme.dep')).toBe('active')
    expect(t.stateOf('acme.top')).toBe('active')
  })

  test('a newly reached dependent joins a blocked chain once, then stays quiet', async () => {
    const t = setup()
    installDependents(t)
    t.host.load()
    await expectDepFailure(t)
    await expectDepFailure(t)
    const priorEvents = t.events.length
    const priorLogs = t.logs.length
    const priorBrokenAttempts = attemptCount(t, 'acme.broken')

    const failedAt = t.now()
    t.setNow(failedAt + 1)
    await expectTopFailure(t)
    expect(t.logs.slice(priorLogs)).toEqual([
      'plugin acme.top: dependency acme.dep failed: acme.dep failed to activate: dependency acme.broken failed to activate',
      'plugin acme.top failed to activate: dependency acme.dep failed to activate'
    ])
    expect(t.events).toHaveLength(priorEvents + 2)
    expect(attemptCount(t, 'acme.broken')).toBe(priorBrokenAttempts)
    expect(t.stateOf('acme.top')).toBe('failed')
    expect(t.diagnosticsOf('acme.top')).toEqual([
      { level: 'error', message: 'dependency acme.dep failed to activate' }
    ])
    const heldEvents = t.events.length
    const heldLogs = [...t.logs]
    const heldLines = t.lines()
    await expectTopFailure(t)
    expect(t.events).toHaveLength(heldEvents)
    expect(t.logs).toEqual(heldLogs)
    expect(t.lines()).toEqual(heldLines)
  })

  test('explicit activation at the top forces the whole dependency chain', async () => {
    const t = setup()
    installDependents(t)
    t.host.load()
    const failedAt = t.now()
    await expectTopFailure(t)
    t.setNow(failedAt + 1)
    await expect(t.host.activate('acme.top')).rejects.toMatchObject(TOP_ERROR)
    expect(attemptCount(t, 'acme.broken')).toBe(2)
  })
})

describe('failed activation cleanup', () => {
  test('a thrown activation deactivates before revoking its extension', async () => {
    const t = setup()
    t.installed({ id: 'acme.half' }, { activate: "throw new Error('boom')" })
    t.host.load()

    await expect(t.host.activate('acme.half')).rejects.toMatchObject({
      code: RpcErrorCode.Conflict,
      message: 'acme.half failed to activate: boom'
    })
    expect(t.lines()).toEqual([
      'create acme.half',
      'import acme.half',
      'activate acme.half',
      'deactivate acme.half',
      'revoke acme.half'
    ])
    expect(t.stateOf('acme.half')).toBe('failed')
  })

  test('a timed-out activation deactivates the imported module', async () => {
    const t = setup({ withExtension: false, timeoutMs: 100 })
    t.installed({ id: 'acme.hang' }, { activate: 'await new Promise(() => {})' })
    t.host.load()

    await expect(t.host.activate('acme.hang')).rejects.toMatchObject({
      code: RpcErrorCode.Conflict,
      message: 'acme.hang failed to activate: activation timed out after 100 ms'
    })
    expect(t.lines()).toEqual(['import acme.hang', 'activate acme.hang', 'deactivate acme.hang'])
    expect(t.stateOf('acme.hang')).toBe('failed')
  })

  test('an invalid activation disposer still deactivates the module that was called', async () => {
    const t = setup()
    t.installed({ id: 'acme.invalid-disposer' }, { activate: 'return 42' })
    t.host.load()

    await expect(t.host.activate('acme.invalid-disposer')).rejects.toMatchObject({
      code: RpcErrorCode.Conflict,
      message: 'acme.invalid-disposer failed to activate: main activate returned an invalid disposer'
    })
    expect(t.lines()).toEqual([
      'create acme.invalid-disposer',
      'import acme.invalid-disposer',
      'activate acme.invalid-disposer',
      'deactivate acme.invalid-disposer',
      'revoke acme.invalid-disposer'
    ])
  })

  const neverActivatedCases: Array<{
    name: string
    id: string
    options?: SetupOptions
    prepare: (t: TestSetup) => void
  }> = [
    {
      name: 'the module throws at import',
      id: 'acme.import-fail',
      options: { withExtension: false },
      prepare: (t) => {
        writePlugin(
          t.installedDir,
          { id: 'acme.import-fail', name: 'acme.import-fail', version: '1.0.0', main: 'main.ts' },
          { 'main.ts': "throw new Error('import boom')\n" }
        )
      }
    },
    {
      name: 'the module has no activate export',
      id: 'acme.no-activate',
      options: { withExtension: false },
      prepare: (t) => t.installed({ id: 'acme.no-activate' }, { omitActivate: true })
    },
    {
      name: 'a dependency failed before the module was imported',
      id: 'acme.consumer',
      options: { withExtension: false },
      prepare: (t) => {
        t.installed({ id: 'acme.source' }, { activate: "throw new Error('boom')" })
        t.installed({ id: 'acme.consumer', dependencies: ['acme.source'] })
      }
    },
    {
      name: 'the extension create hook throws',
      id: 'acme.create-fail',
      options: { throwOnCreate: true },
      prepare: (t) => t.installed({ id: 'acme.create-fail' })
    }
  ]

  for (const scenario of neverActivatedCases) {
    test(`does not deactivate when ${scenario.name}`, async () => {
      const t = setup(scenario.options)
      scenario.prepare(t)
      t.host.load()

      await expect(t.host.activate(scenario.id)).rejects.toMatchObject({ code: RpcErrorCode.Conflict })
      expect(t.stateOf(scenario.id)).toBe('failed')
      expect(t.lines()).not.toContain(`deactivate ${scenario.id}`)
    })
  }

  test('a throwing deactivate warns without replacing the activation error', async () => {
    const t = setup()
    t.installed(
      { id: 'acme.half' },
      { activate: "throw new Error('boom')", deactivate: "throw new Error('nope')" }
    )
    t.host.load()

    await expect(t.host.activate('acme.half')).rejects.toMatchObject({
      code: RpcErrorCode.Conflict,
      message: 'acme.half failed to activate: boom'
    })
    expect(t.stateOf('acme.half')).toBe('failed')
    expect(t.diagnosticsOf('acme.half')).toEqual([
      { level: 'error', message: 'boom' },
      { level: 'warning', message: 'deactivate failed: nope' }
    ])
  })

  test('a timed-out deactivate warns without replacing the activation error', async () => {
    const t = setup({ withExtension: false, timeoutMs: 100 })
    t.installed(
      { id: 'acme.half' },
      { activate: "throw new Error('boom')", deactivate: 'await new Promise(() => {})' }
    )
    t.host.load()

    await expect(t.host.activate('acme.half')).rejects.toMatchObject({
      code: RpcErrorCode.Conflict,
      message: 'acme.half failed to activate: boom'
    })
    expect(t.stateOf('acme.half')).toBe('failed')
    expect(t.diagnosticsOf('acme.half')).toEqual([
      { level: 'error', message: 'boom' },
      { level: 'warning', message: 'deactivate timed out after 100 ms' }
    ])
  })

  test('deactivate runs once per failed explicit attempt and is not repeated at stop', async () => {
    const t = setup({ withExtension: false })
    t.installed({ id: 'acme.half' }, { activate: "throw new Error('boom')" })
    t.host.load()

    await expect(t.host.activate('acme.half')).rejects.toMatchObject({ code: RpcErrorCode.Conflict })
    expect(t.lines().filter((line) => line === 'deactivate acme.half')).toHaveLength(1)
    await expect(t.host.activate('acme.half')).rejects.toMatchObject({ code: RpcErrorCode.Conflict })
    expect(t.lines().filter((line) => line === 'deactivate acme.half')).toHaveLength(2)
    await t.host.stop()
    expect(t.lines().filter((line) => line === 'deactivate acme.half')).toHaveLength(2)
  })
})
