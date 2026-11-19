import { describe, expect, test } from 'bun:test'
import { getTerminalAccessorySource } from '../../src/window/workspace/accessories'
import { fakeContext, type FakeContext } from '../ui-fake'

const ACCESSORY_ID = 'terminal-accessory:test.accessory/account'
const VIEW_ID = 'view:test.accessory/account'

function contribution(
  id = ACCESSORY_ID,
  view = VIEW_ID,
  title = 'Account',
  order: unknown = 10,
  extra: Record<string, unknown> = {}
) {
  return {
    id,
    kind: 'terminal-accessory',
    plugin: 'test.accessory',
    status: 'effective',
    data: { title, order, view, ...extra }
  }
}

function uiModel(...views: { id: string; module?: string }[]) {
  return { views }
}

function deferred<T>() {
  const { promise, resolve, reject } = Promise.withResolvers<T>()
  return { promise, resolve, reject }
}

async function drain(): Promise<void> {
  for (let index = 0; index < 8; index++) await Promise.resolve()
}

const pluginCalls = (fake: FakeContext) => fake.callsTo('plugin.contributions')
const uiCalls = (fake: FakeContext) => fake.callsTo('ui.contributions')

describe('terminal accessory catalog', () => {
  test('shares validated descriptors and preserves snapshot identity when unchanged', async () => {
    const defaultAccessory = contribution(
      'terminal-accessory:test.accessory/default',
      'view:test.accessory/default',
      'Default'
    )
    defaultAccessory.data.order = undefined
    const fake = fakeContext({
      'plugin.contributions': () => [
        contribution('terminal-accessory:test.accessory/z', 'view:test.accessory/z', 'Zed', 5),
        contribution('terminal-accessory:test.accessory/a', 'view:test.accessory/a', 'Alpha', 5),
        defaultAccessory,
        contribution('terminal-accessory:test.accessory/unavailable', 'view:test.accessory/missing'),
        contribution('terminal-accessory:test.accessory/empty-module', 'view:test.accessory/empty'),
        contribution('terminal-accessory:test.accessory/extra', VIEW_ID, 'Extra', 1, { hidden: true }),
        contribution('invalid-id', VIEW_ID),
        contribution('terminal-accessory:test.accessory/wrong-kind', VIEW_ID, 'Wrong', 1, { view: 'command:test.accessory/action' }),
        null,
        'malformed'
      ],
      'ui.contributions': () => uiModel(
        { id: 'view:test.accessory/z', module: 'ui/z.js' },
        { id: 'view:test.accessory/a', module: 'ui/a.js' },
        { id: 'view:test.accessory/default', module: 'ui/default.js' },
        { id: 'view:test.accessory/empty', module: '' }
      )
    })
    const source = getTerminalAccessorySource(fake.context)
    expect(getTerminalAccessorySource(fake.context)).toBe(source)
    let notifications = 0
    const unsubscribe = source.subscribe(() => notifications++)
    await drain()

    expect(pluginCalls(fake)).toHaveLength(1)
    expect(uiCalls(fake)).toHaveLength(1)
    const snapshot = source.getSnapshot()
    expect(snapshot).toEqual([
      { id: 'terminal-accessory:test.accessory/a', plugin: 'test.accessory', title: 'Alpha', order: 5, view: 'view:test.accessory/a' },
      { id: 'terminal-accessory:test.accessory/z', plugin: 'test.accessory', title: 'Zed', order: 5, view: 'view:test.accessory/z' },
      { id: 'terminal-accessory:test.accessory/default', plugin: 'test.accessory', title: 'Default', order: 100, view: 'view:test.accessory/default' }
    ])
    const publishedNotifications = notifications

    await fake.emit({ type: 'plugin.changed' })
    await drain()
    expect(pluginCalls(fake)).toHaveLength(2)
    expect(uiCalls(fake)).toHaveLength(2)
    expect(source.getSnapshot()).toBe(snapshot)
    expect(notifications).toBe(publishedNotifications)
    unsubscribe()

    const other = fakeContext({
      'plugin.contributions': () => [],
      'ui.contributions': () => uiModel()
    })
    const otherSource = getTerminalAccessorySource(other.context)
    expect(otherSource).not.toBe(source)
    const stopOther = otherSource.subscribe(() => {})
    await drain()
    expect(pluginCalls(other)).toHaveLength(1)
    expect(uiCalls(other)).toHaveLength(1)
    stopOther()
  })

  test('coalesces in-flight invalidations and publishes only the follow-up result', async () => {
    const pluginRuns = [deferred<unknown>(), deferred<unknown>()]
    const uiRuns = [deferred<unknown>(), deferred<unknown>()]
    let pluginIndex = 0
    let uiIndex = 0
    const fake = fakeContext({
      'plugin.contributions': () => pluginRuns[pluginIndex++]!.promise,
      'ui.contributions': () => uiRuns[uiIndex++]!.promise
    })
    const source = getTerminalAccessorySource(fake.context)
    let notifications = 0
    source.subscribe(() => notifications++)
    await drain()
    expect(pluginCalls(fake)).toHaveLength(1)
    expect(uiCalls(fake)).toHaveLength(1)

    for (let index = 0; index < 5; index++) await fake.emit({ type: 'plugin.changed' })
    expect(pluginCalls(fake)).toHaveLength(1)
    expect(uiCalls(fake)).toHaveLength(1)

    pluginRuns[0]!.resolve([contribution(ACCESSORY_ID, VIEW_ID, 'Obsolete')])
    uiRuns[0]!.resolve(uiModel({ id: VIEW_ID, module: 'ui/account.js' }))
    await drain()
    expect(pluginCalls(fake)).toHaveLength(2)
    expect(uiCalls(fake)).toHaveLength(2)
    expect(source.getSnapshot()).toEqual([])
    expect(notifications).toBe(0)

    pluginRuns[1]!.resolve([contribution(ACCESSORY_ID, VIEW_ID, 'Current')])
    uiRuns[1]!.resolve(uiModel({ id: VIEW_ID, module: 'ui/account.js' }))
    await drain()
    expect(source.getSnapshot()).toEqual([
      { id: ACCESSORY_ID, plugin: 'test.accessory', title: 'Current', order: 10, view: VIEW_ID }
    ])
    expect(notifications).toBe(1)
  })

  test('waits for both discovery calls to settle before a coalesced refresh', async () => {
    const failedPlugin = deferred<unknown>()
    const pendingUi = deferred<unknown>()
    let pluginIndex = 0
    let uiIndex = 0
    const logs: string[] = []
    const fake = fakeContext({
      'plugin.contributions': () => {
        if (pluginIndex++ === 0) return failedPlugin.promise
        return [contribution(ACCESSORY_ID, VIEW_ID, 'Latest')]
      },
      'ui.contributions': () => {
        if (uiIndex++ === 0) return pendingUi.promise
        return uiModel({ id: VIEW_ID, module: 'ui/account.js' })
      }
    })
    fake.context.log = (message) => logs.push(message)
    const source = getTerminalAccessorySource(fake.context)
    let notifications = 0
    source.subscribe(() => notifications++)
    await drain()

    await fake.emit({ type: 'plugin.changed' })
    failedPlugin.reject(new Error('obsolete failure'))
    await drain()
    expect(pluginCalls(fake)).toHaveLength(1)
    expect(uiCalls(fake)).toHaveLength(1)
    expect(logs).toEqual([])

    pendingUi.resolve(uiModel({ id: VIEW_ID, module: 'ui/account.js' }))
    await drain()
    expect(pluginCalls(fake)).toHaveLength(2)
    expect(uiCalls(fake)).toHaveLength(2)
    expect(source.getSnapshot()).toEqual([
      { id: ACCESSORY_ID, plugin: 'test.accessory', title: 'Latest', order: 10, view: VIEW_ID }
    ])
    expect(notifications).toBe(1)
    expect(logs).toEqual([])
  })

  test('logs one initial failure, retries on reconnect, and retains the last successful snapshot', async () => {
    let failuresRemaining = 2
    const logs: string[] = []
    const fake = fakeContext({
      'plugin.contributions': () => {
        if (failuresRemaining > 0) {
          failuresRemaining--
          throw new Error('catalog unavailable')
        }
        return [contribution()]
      },
      'ui.contributions': () => {
        if (failuresRemaining > 0) {
          failuresRemaining--
          throw new Error('catalog unavailable')
        }
        return uiModel({ id: VIEW_ID, module: 'ui/account.js' })
      }
    })
    fake.context.log = (message) => logs.push(message)
    const source = getTerminalAccessorySource(fake.context)
    const unsubscribe = source.subscribe(() => {})
    await drain()

    expect(pluginCalls(fake)).toHaveLength(1)
    expect(uiCalls(fake)).toHaveLength(1)
    expect(source.getSnapshot()).toEqual([])
    expect(logs).toEqual(['terminal accessory refresh failed: catalog unavailable'])

    await fake.setConnection('connected')
    await drain()
    expect(pluginCalls(fake)).toHaveLength(2)
    expect(uiCalls(fake)).toHaveLength(2)
    const successfulSnapshot = source.getSnapshot()
    expect(successfulSnapshot).toEqual([
      { id: ACCESSORY_ID, plugin: 'test.accessory', title: 'Account', order: 10, view: VIEW_ID }
    ])

    failuresRemaining = 2
    await fake.emit({ type: 'plugin.changed' })
    await drain()
    expect(pluginCalls(fake)).toHaveLength(3)
    expect(uiCalls(fake)).toHaveLength(3)
    expect(source.getSnapshot()).toBe(successfulSnapshot)
    expect(logs).toEqual([
      'terminal accessory refresh failed: catalog unavailable',
      'terminal accessory refresh failed: catalog unavailable'
    ])
    unsubscribe()
  })

  test('ignores an obsolete failure and never notifies an unsubscribed pane', async () => {
    const stalePlugin = deferred<unknown>()
    const staleUi = deferred<unknown>()
    const latestPlugin = deferred<unknown>()
    const latestUi = deferred<unknown>()
    let pluginIndex = 0
    let uiIndex = 0
    const logs: string[] = []
    const fake = fakeContext({
      'plugin.contributions': () => {
        const index = pluginIndex++
        if (index === 0) return [contribution(ACCESSORY_ID, VIEW_ID, 'Initial')]
        if (index === 1) return stalePlugin.promise
        return latestPlugin.promise
      },
      'ui.contributions': () => {
        const index = uiIndex++
        if (index === 0) return uiModel({ id: VIEW_ID, module: 'ui/account.js' })
        if (index === 1) return staleUi.promise
        return latestUi.promise
      }
    })
    fake.context.log = (message) => logs.push(message)
    const source = getTerminalAccessorySource(fake.context)
    let notifications = 0
    const unsubscribe = source.subscribe(() => notifications++)
    await drain()
    const initiallyPublishedNotifications = notifications

    await fake.emit({ type: 'plugin.changed' })
    await drain()
    await fake.emit({ type: 'plugin.changed' })
    unsubscribe()
    stalePlugin.reject(new Error('obsolete failure'))
    staleUi.reject(new Error('obsolete failure'))
    await drain()
    expect(pluginCalls(fake)).toHaveLength(3)
    expect(uiCalls(fake)).toHaveLength(3)
    expect(logs).toEqual([])

    latestPlugin.resolve([contribution(ACCESSORY_ID, VIEW_ID, 'Latest')])
    latestUi.resolve(uiModel({ id: VIEW_ID, module: 'ui/account.js' }))
    await drain()
    expect(source.getSnapshot()).toEqual([
      { id: ACCESSORY_ID, plugin: 'test.accessory', title: 'Latest', order: 10, view: VIEW_ID }
    ])
    expect(notifications).toBe(initiallyPublishedNotifications)
    expect(logs).toEqual([])
  })
})
