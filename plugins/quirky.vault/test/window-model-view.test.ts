import { expect, test } from 'bun:test'
import type { UiPluginContext } from '@quirky/protocol'
import { DEFAULT_VIEW, VaultWindowModel } from '../src/window/model'
import type { ViewState } from '../src/types'

type CallRecord = { method: string; params: Record<string, unknown> }
type PendingCall = { method: string; resolve: (value: unknown) => void; reject: (error: unknown) => void }
type TestEvent = { type: string; data: unknown }

function makeContext() {
  const calls: CallRecord[] = []
  const pending: PendingCall[] = []
  let receiveEvent: ((event: TestEvent) => void) | null = null
  const context = {
    call: (method: string, params: Record<string, unknown> = {}) => {
      calls.push({ method, params })
      if (method === 'quirky.vault/getView' || method === 'quirky.vault/setView') {
        const { promise, resolve, reject } = Promise.withResolvers<unknown>()
        pending.push({ method, resolve, reject })
        return promise
      }
      return Promise.resolve(undefined)
    },
    subscribe: (listener: (event: TestEvent) => void) => {
      receiveEvent = listener
      return () => { receiveEvent = null }
    },
    onLayout: () => () => {},
    getLayout: () => ({}),
    setPanelBadge: () => {},
    toast: () => {}
  } as unknown as UiPluginContext

  return {
    context,
    calls,
    emit(data: unknown) {
      if (!receiveEvent) throw new Error('The model has not subscribed to events.')
      receiveEvent({ type: 'quirky.vault/viewChanged', data })
    },
    takePending(method: string): PendingCall {
      const index = pending.findIndex((call) => call.method === method)
      if (index < 0) throw new Error(`No pending ${method} call`)
      return pending.splice(index, 1)[0]!
    }
  }
}

async function settle(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve()
}

const countReads = (calls: CallRecord[]) => calls.filter((call) => call.method === 'quirky.vault/getView').length

test('view changes ignore old and equal revisions and read newer state in caller scope', async () => {
  const fake = makeContext()
  const model = new VaultWindowModel(fake.context)
  model.start()

  fake.takePending('quirky.vault/getView').resolve(DEFAULT_VIEW)
  await settle()
  expect(model.getSnapshot().view).toEqual(DEFAULT_VIEW)

  const legacyAnswer = { ...DEFAULT_VIEW, scope: 'workspace', query: 'legacy answer' } satisfies ViewState
  fake.emit({ view: { ...DEFAULT_VIEW, query: 'event body' } })
  fake.takePending('quirky.vault/getView').resolve(legacyAnswer)
  await settle()
  expect(model.getSnapshot().view).toEqual(legacyAnswer)

  const ownView = { ...DEFAULT_VIEW, query: 'window state', selectedId: 'own', revision: 12 }
  const ownWrite = model.setView({ query: ownView.query, selectedId: ownView.selectedId })
  fake.takePending('quirky.vault/setView').resolve(ownView)
  expect(await ownWrite).toEqual(ownView)

  const readsBeforeStaleEvents = countReads(fake.calls)
  fake.emit({ view: { ...DEFAULT_VIEW, selectedId: 'old', revision: 11 } })
  fake.emit({ view: { ...DEFAULT_VIEW, selectedId: 'equal', revision: 12 } })
  await settle()
  expect(countReads(fake.calls)).toBe(readsBeforeStaleEvents)
  expect(model.getSnapshot().view).toEqual(ownView)

  const eventView = { ...DEFAULT_VIEW, scope: 'all', selectedId: 'b', revision: 14 } satisfies ViewState
  const callerView = { ...DEFAULT_VIEW, scope: 'workspace', selectedId: 'b', revision: 14 } satisfies ViewState
  fake.emit({ view: eventView })
  expect(countReads(fake.calls)).toBe(readsBeforeStaleEvents + 1)
  fake.takePending('quirky.vault/getView').resolve(callerView)
  await settle()
  expect(model.getSnapshot().view).toEqual(callerView)
  expect(model.getSnapshot().view).not.toEqual(eventView)

  model.setActionError('keep this action error')
  const viewBeforeFailedRead = model.getSnapshot().view
  fake.emit({ view: { ...DEFAULT_VIEW, scope: 'all', selectedId: 'failed', revision: 15 } })
  fake.takePending('quirky.vault/getView').reject(new Error('read failed'))
  await settle()
  expect(model.getSnapshot().view).toEqual(viewBeforeFailedRead)
  expect(model.getSnapshot().actionError).toBe('keep this action error')
  model.stop()
})

test('out-of-order setView answers keep the highest revision', async () => {
  const fake = makeContext()
  const model = new VaultWindowModel(fake.context)
  model.start()

  fake.takePending('quirky.vault/getView').resolve({ ...DEFAULT_VIEW, revision: 10 })
  await settle()

  const firstWrite = model.setView({ expandedIds: [] })
  const secondWrite = model.setView({ expandedIds: ['a'] })
  const firstAnswer = fake.takePending('quirky.vault/setView')
  const secondAnswer = fake.takePending('quirky.vault/setView')

  secondAnswer.resolve({ ...DEFAULT_VIEW, expandedIds: ['a'], revision: 13 })
  await secondWrite
  firstAnswer.resolve({ ...DEFAULT_VIEW, expandedIds: [], revision: 12 })
  await firstWrite

  expect(model.getSnapshot().view.revision).toBe(13)
  expect(model.getSnapshot().view.expandedIds).toEqual(['a'])
  model.stop()
})
