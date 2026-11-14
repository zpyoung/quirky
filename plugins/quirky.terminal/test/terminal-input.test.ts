import { describe, expect, test } from 'bun:test'
import { checkSchemaDeclaration, type PluginCaller, type PluginContext } from '@quirky/protocol'
import { InputTracker } from '../src/input-tracker'
import { TerminalService } from '../src/terminal'

const session = { id: 's', kind: 'terminal', status: 'running', agent: 'shell' }
const liveIdentity = { sessionId: 's', processIncarnation: 'p', live: true }
const pluginCaller = { role: 'plugin' } as PluginCaller

type RigOptions = {
  session?: unknown | null
  identity?: unknown
  identityProvider?: () => unknown | Promise<unknown>
  guardThrows?: boolean
  onGuard?: () => void
  onWrite?: () => void
}

function createRig(options: RigOptions = {}) {
  const log: string[] = []
  const calls: string[] = []
  const writes: { sessionId: string; text: string }[] = []
  const inputs = new InputTracker()
  const mark = inputs.mark.bind(inputs)
  inputs.mark = (sessionId) => {
    log.push(`mark(${sessionId})`)
    mark(sessionId)
  }
  const context = {
    call: async (method: string) => {
      calls.push(method)
      if (method === 'quirky.session/get') {
        if (options.session === null) throw rpcError('not-found', 'unknown session')
        return options.session ?? session
      }
      if (method === 'quirky.session/identity') {
        if (options.identityProvider) return options.identityProvider()
        return Object.prototype.hasOwnProperty.call(options, 'identity') ? options.identity : liveIdentity
      }
      throw new Error(`unexpected context call: ${method}`)
    },
    error: rpcError,
    emit: () => {},
    log: () => {},
    pty: {
      list: async () => [],
      resize: async () => {},
      reportUserInput: ({ session: sessionId, expectedIncarnation }: { session: string; expectedIncarnation: string }) => {
        log.push(`guard(${sessionId},${expectedIncarnation})`)
        options.onGuard?.()
        if (options.guardThrows) throw rpcError('conflict', 'custody refused')
      },
      write: (sessionId: string, bytes: Uint8Array) => {
        options.onWrite?.()
        const text = new TextDecoder().decode(bytes)
        log.push(`write(${sessionId},${text})`)
        writes.push({ sessionId, text })
      }
    }
  } as unknown as PluginContext
  return {
    service: new TerminalService(context, async () => new Map(), inputs),
    calls,
    inputs,
    log,
    writes
  }
}

function rpcError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code })
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  const failure = await promise.then(() => undefined, (error: unknown) => error)
  expect(failure).toMatchObject({ code })
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

function mobileCaller(connectionId: number, deviceId: string): PluginCaller {
  return {
    role: 'mobile',
    deviceId,
    connection: {
      id: connectionId,
      transport: 'websocket',
      onClose: () => () => {}
    }
  } as unknown as PluginCaller
}

describe('TerminalService guarded input', () => {
  test('guards before marking and writing, while declaring the optional schema field', async () => {
    let guardYielded = false
    let yieldedBeforeWrite = false
    const rig = createRig({
      onGuard: () => queueMicrotask(() => { guardYielded = true }),
      onWrite: () => { yieldedBeforeWrite = guardYielded }
    })

    const result = await rig.service.write({ session: 's', data: 'x', expectedIncarnation: 'p' }, pluginCaller)

    expect(result).toEqual({ ok: true })
    expect(rig.log).toEqual(['guard(s,p)', 'mark(s)', 'write(s,x)'])
    expect(yieldedBeforeWrite).toBe(false)
    expect(rig.inputs.has('s')).toBe(true)

    const manifest = JSON.parse(await Bun.file(new URL('../quirky-plugin.json', import.meta.url)).text()) as {
      contributes: {
        method: {
          id: string
          params?: { properties?: Record<string, unknown>; required?: string[] }
        }[]
      }
    }
    const writeMethod = manifest.contributes.method.find((method) => method.id === 'write')!
    const userInputMethod = manifest.contributes.method.find((method) => method.id === 'userInput')!
    expect(checkSchemaDeclaration(writeMethod.params, 'write.params', { object: true })).toEqual([])
    expect(checkSchemaDeclaration(userInputMethod.params, 'userInput.params', { object: true })).toEqual([])
    expect(writeMethod.params?.properties?.expectedIncarnation).toMatchObject({ type: 'string' })
    expect(writeMethod.params?.required).toEqual(['session', 'data'])
  })

  test('keeps omitted-incarnation writes legacy and standalone userInput reports without writing', async () => {
    const rig = createRig()

    expect(await rig.service.write({ session: 's', data: 'legacy' }, pluginCaller)).toEqual({ ok: true })
    expect(rig.log).toEqual(['mark(s)', 'write(s,legacy)'])
    expect(rig.inputs.has('s')).toBe(true)
    expect(rig.calls).not.toContain('quirky.session/identity')

    const standalone = createRig()
    expect(await standalone.service.userInput({ session: 's', expectedIncarnation: 'p' })).toEqual({ ok: true })
    expect(standalone.log).toEqual(['guard(s,p)'])
    expect(standalone.writes).toEqual([])
    expect(standalone.inputs.has('s')).toBe(false)
  })

  test('rejects stale-incarnation before marking or writing', async () => {
    const rig = createRig({ identity: { ...liveIdentity, processIncarnation: 'replacement' } })

    await expectCode(rig.service.write({ session: 's', data: 'x', expectedIncarnation: 'p' }, pluginCaller), 'conflict')

    expect(rig.log).toEqual([])
    expect(rig.writes).toEqual([])
  })

  test('rejects not-live identity before marking or writing', async () => {
    const rig = createRig({ identity: { ...liveIdentity, live: false } })

    await expectCode(rig.service.write({ session: 's', data: 'x', expectedIncarnation: 'p' }, pluginCaller), 'conflict')

    expect(rig.log).toEqual([])
    expect(rig.writes).toEqual([])
  })

  test('rejects wrong-session identity before marking or writing', async () => {
    const rig = createRig({ identity: { ...liveIdentity, sessionId: 'other' } })

    await expectCode(rig.service.write({ session: 's', data: 'x', expectedIncarnation: 'p' }, pluginCaller), 'conflict')

    expect(rig.log).toEqual([])
    expect(rig.writes).toEqual([])
  })

  test('rejects custody-refused before marking or writing', async () => {
    const rig = createRig({ guardThrows: true })

    await expectCode(rig.service.write({ session: 's', data: 'x', expectedIncarnation: 'p' }, pluginCaller), 'conflict')

    expect(rig.log).toEqual(['guard(s,p)'])
    expect(rig.writes).toEqual([])
    expect(rig.inputs.has('s')).toBe(false)
  })

  for (const [name, identity] of [
    ['missing-identity-incarnation', { sessionId: 's', live: true }],
    ['empty-live-identity-incarnation', { ...liveIdentity, processIncarnation: '' }],
    ['invalid-live-identity-incarnation-type', { ...liveIdentity, processIncarnation: 3 }]
  ] as const) {
    test(`rejects ${name} as an unverifiable live identity`, async () => {
      const rig = createRig({ identity })

      await expectCode(rig.service.write({ session: 's', data: 'x', expectedIncarnation: 'p' }, pluginCaller), 'conflict')

      expect(rig.log).toEqual([])
      expect(rig.writes).toEqual([])
    })
  }

  for (const [name, expectedIncarnation] of [
    ['empty-incarnation', ''],
    ['null-incarnation', null],
    ['invalid-incarnation-type', 3],
    ['undefined-incarnation', undefined]
  ] as const) {
    test(`rejects ${name} instead of falling back to a legacy write`, async () => {
      const rig = createRig()

      await expectCode(rig.service.write({ session: 's', data: 'x', expectedIncarnation }, pluginCaller), 'invalid-params')

      expect(rig.log).toEqual([])
      expect(rig.writes).toEqual([])
    })
  }

  test('rejects unknown-session with a supplied incarnation without marking or writing', async () => {
    const rig = createRig({ session: null })

    await expectCode(rig.service.write({ session: 's', data: 'x', expectedIncarnation: 'p' }, pluginCaller), 'not-found')

    expect(rig.log).toEqual([])
    expect(rig.writes).toEqual([])
    expect(rig.calls).not.toContain('quirky.session/identity')
  })

  test('rejects structured-session with a supplied incarnation without marking or writing', async () => {
    const rig = createRig({ session: { id: 's', kind: 'view', status: 'running' } })

    await expectCode(rig.service.write({ session: 's', data: 'x', expectedIncarnation: 'p' }, pluginCaller), 'invalid-params')

    expect(rig.log).toEqual([])
    expect(rig.writes).toEqual([])
    expect(rig.calls).not.toContain('quirky.session/identity')
  })

  test('rejects exited-session with a supplied incarnation without marking or writing', async () => {
    const rig = createRig({ session: { ...session, status: 'exited' } })

    await expectCode(rig.service.write({ session: 's', data: 'x', expectedIncarnation: 'p' }, pluginCaller), 'conflict')

    expect(rig.log).toEqual([])
    expect(rig.writes).toEqual([])
    expect(rig.calls).not.toContain('quirky.session/identity')
  })

  test('rejects mobile-watch-only writes before identity lookup or evidence', async () => {
    const rig = createRig()
    const mobile = (rig.service as unknown as {
      mobile: { attach: (sessionId: string, cols: number, rows: number, caller: PluginCaller) => Promise<void> }
    }).mobile
    await mobile.attach('s', 80, 24, mobileCaller(1, 'driver'))
    await mobile.attach('s', 80, 24, mobileCaller(2, 'watcher'))

    await expectCode(
      rig.service.write({ session: 's', data: 'x', expectedIncarnation: 'p' }, mobileCaller(2, 'watcher')),
      'conflict'
    )

    expect(rig.log).toEqual([])
    expect(rig.writes).toEqual([])
    expect(rig.calls).not.toContain('quirky.session/identity')
  })

  test('rechecks mobile input authority after awaited identity lookup', async () => {
    const identity = deferred<unknown>()
    let identityRequested!: () => void
    const requested = new Promise<void>((resolve) => { identityRequested = resolve })
    const rig = createRig({ identityProvider: () => { identityRequested(); return identity.promise } })
    const mobile = (rig.service as unknown as {
      mobile: { attach: (sessionId: string, cols: number, rows: number, caller: PluginCaller) => Promise<void> }
    }).mobile

    const pendingWrite = rig.service.write({ session: 's', data: 'x', expectedIncarnation: 'p' }, { role: 'ui' } as PluginCaller)
    await requested
    await mobile.attach('s', 80, 24, mobileCaller(1, 'driver'))
    identity.resolve(liveIdentity)

    await expectCode(pendingWrite, 'conflict')
    expect(rig.log).toEqual([])
    expect(rig.writes).toEqual([])
  })

  test('shares nonempty-incarnation validation with standalone userInput', async () => {
    const rig = createRig()

    await expectCode(rig.service.userInput({ session: 's', expectedIncarnation: '' }), 'invalid-params')

    expect(rig.calls).not.toContain('quirky.session/identity')
    expect(rig.log).toEqual([])
    expect(rig.writes).toEqual([])
  })
})
