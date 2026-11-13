import { expect, test } from 'bun:test'
import { PaneAnnouncer } from '../src/announcer'

type State = { revision: number; queued: string[] }
const state = (revision: number, queued: string[] = []): State => ({ revision, queued })
function rig() {
  const reads: { pane: string; resolve(state: State): void; reject(error: Error): void }[] = []
  const events: { pane: string; state: State }[] = []
  const announcer = new PaneAnnouncer<State>({
    read(pane) {
      const { promise, resolve, reject } = Promise.withResolvers<State>()
      reads.push({ pane, resolve, reject })
      return promise
    },
    emit(pane, state) { events.push({ pane, state }) }
  })
  return { announcer, reads, events }
}
async function flush() {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

test('emits equal states once and includes non-revision fields in comparison', async () => {
  const { announcer, reads, events } = rig()
  for (const value of [state(1), state(1), state(2)]) {
    announcer.announce('a')
    reads.at(-1)!.resolve(value)
    await flush()
  }
  expect(events.map((event) => event.state)).toEqual([state(1), state(2)])
  announcer.stop()
})

test('coalesces reads per pane while allowing other panes to read', async () => {
  const { announcer, reads, events } = rig()
  announcer.announce('a')
  for (let i = 0; i < 5; i++) announcer.announce('a')
  announcer.announce('b')
  expect(reads.map((read) => read.pane)).toEqual(['a', 'b'])
  reads[0]!.resolve(state(1))
  await flush()
  expect(reads.map((read) => read.pane)).toEqual(['a', 'b', 'a'])
  reads[2]!.resolve(state(2))
  reads[1]!.resolve(state(1))
  await flush()
  expect(reads).toHaveLength(3)
  expect(events.filter((event) => event.pane === 'a').map((event) => event.state)).toEqual([state(1), state(2)])
  announcer.stop()
})

test('a direct publication overtakes an older read even at the same revision', async () => {
  const { announcer, reads, events } = rig()
  announcer.announce('a')
  reads[0]!.resolve(state(1))
  await flush()
  announcer.announce('a')
  announcer.publishNow('a', state(1, ['send-1']))
  reads[1]!.resolve(state(1))
  await flush()
  expect(events.map((event) => event.state)).toEqual([state(1), state(1, ['send-1'])])
  expect(reads).toHaveLength(3)
  reads[2]!.resolve(state(1, ['send-1']))
  await flush()
  expect(events).toHaveLength(2)
  expect(reads).toHaveLength(3)
  announcer.stop()
})

test('a direct publication without an active read still refreshes real state', async () => {
  const { announcer, reads, events } = rig()
  announcer.publishNow('a', state(1, ['send-1']))
  expect(reads).toHaveLength(1)
  expect(events.map((event) => event.state)).toEqual([state(1, ['send-1'])])
  reads[0]!.resolve(state(2))
  await flush()
  expect(events.map((event) => event.state)).toEqual([state(1, ['send-1']), state(2)])
  announcer.stop()
})

test('retaining no pane overtakes its read and drops its publication record', async () => {
  const { announcer, reads, events } = rig()
  announcer.announce('a')
  reads[0]!.resolve(state(1))
  await flush()
  announcer.announce('a')
  announcer.retain(new Set())
  reads[1]!.resolve(state(2))
  await flush()
  expect(events).toHaveLength(1)
  expect(reads).toHaveLength(3)
  reads[2]!.reject(new Error('closed'))
  await flush()
  announcer.announce('a')
  reads[3]!.resolve(state(1))
  await flush()
  expect(events.map((event) => event.state)).toEqual([state(1), state(1)])
  announcer.stop()
})

test('failed reads clear the record so the same returning state is announced', async () => {
  const { announcer, reads, events } = rig()
  announcer.announce('a')
  reads[0]!.resolve(state(1))
  await flush()
  announcer.announce('a')
  reads[1]!.reject(new Error('missing'))
  await flush()
  announcer.announce('a')
  reads[2]!.resolve(state(1))
  await flush()
  expect(events.map((event) => event.state)).toEqual([state(1), state(1)])
  announcer.stop()
})

test('stop discards a held reply, queued work, and future publications', async () => {
  const { announcer, reads, events } = rig()
  announcer.announce('a')
  announcer.announce('a')
  announcer.stop()
  reads[0]!.resolve(state(1))
  await flush()
  announcer.announce('a')
  announcer.publishNow('a', state(2))
  expect(events).toEqual([])
  expect(reads).toHaveLength(1)
})
