import { expect, test } from 'bun:test'
import type { QuirkyEvent, Session, UiPluginContext } from '@quirky/protocol'
import { WorktreeSessions } from '../../src/window/model'

const session = (status: Session['status'], lastActivityAt: number): Session =>
  ({
    id: 's_1',
    kind: 'structured',
    agent: 'claude',
    worktreeId: 'wt_1',
    cwd: '/w',
    title: 'Claude',
    status,
    createdAt: 1,
    lastActivityAt,
    exitCode: null,
    exitSignal: null,
    exitCause: null,
    restorable: false
  }) as Session

function harness(listed: Session) {
  let emit: (event: QuirkyEvent) => void = () => {}
  const list = Promise.withResolvers<Session[]>()
  const context = {
    subscribe(listener: (event: QuirkyEvent) => void) {
      emit = listener
      return () => {}
    },
    onConnection: () => () => {},
    async call(method: string) {
      if (method === 'quirky.worktree/resolve') return { id: 'wt_1', name: 'wt', path: '/w' }
      if (method === 'quirky.session/list') return list.promise
      throw new Error(`unexpected ${method}`)
    },
    openView() {},
    toast() {}
  } as unknown as UiPluginContext
  const model = new WorktreeSessions(context, 'wt_1', 's_1')
  model.start()
  return { model, emit: (s: Session) => emit({ type: 'quirky.session/changed', data: { session: s } } as unknown as QuirkyEvent), finish: () => list.resolve([listed]) }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 5))

test('an event queued during a load that is older than the loaded record does not overwrite its status', async () => {
  const { model, emit, finish } = harness(session('working', 20))
  await settle()
  emit(session('done', 10))
  finish()
  await settle()
  expect(model.getSnapshot().sessions[0]?.status).toBe('working')
})

test('an event queued during a load that is newer than the loaded record still applies', async () => {
  const { model, emit, finish } = harness(session('done', 10))
  await settle()
  emit(session('working', 20))
  finish()
  await settle()
  expect(model.getSnapshot().sessions[0]?.status).toBe('working')
})
