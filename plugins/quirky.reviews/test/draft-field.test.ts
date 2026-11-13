import { afterAll, afterEach, expect, test } from 'bun:test'
import { act, createElement, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import {
  createDraftFieldController,
  createDraftVersions,
  nextDraftTick,
  useTargetGuard,
  useDraftField,
  type DraftField,
  type DraftFieldController,
  type DraftWrite,
} from '../src/draft-field'

GlobalRegistrator.register()
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

interface Input<T> {
  identity: string
  remote: T
  snapshot: number | undefined
  write: DraftWrite<T>
  refresh: () => Promise<void>
  resend?: boolean
  equal?: (left: T, right: T) => boolean
}

interface DraftFieldHarness<T> {
  controller: DraftFieldController<T>
  writes: T[]
  readonly refreshCount: number
  update(next: Partial<Input<T>>): void
  readonly input: Input<T>
}

interface Deferred<T> {
  promise: Promise<T>
  resolve(value: T): void
  reject(error: unknown): void
}

function harness<T>(remote: T, options: Partial<Input<T>> = {}): DraftFieldHarness<T> {
  const writes: T[] = []
  let refreshCount = 0
  const suppliedRefresh = options.refresh
  let input: Input<T> = {
    identity: 'target-a',
    remote,
    snapshot: undefined,
    write: (value) => {
      writes.push(value)
      return Promise.resolve(true)
    },
    ...options,
    refresh: async () => {
      refreshCount++
      await suppliedRefresh?.()
    },
  }
  const controller = createDraftFieldController(input)
  return {
    controller,
    writes,
    get refreshCount() {
      return refreshCount
    },
    update(next) {
      input = { ...input, ...next }
      controller.update(input)
    },
    get input() {
      return input
    },
  }
}

function deferred<T>(): Deferred<T> {
  const { promise, resolve, reject } = Promise.withResolvers<T>()
  return { promise, resolve, reject }
}

async function flush() {
  for (let index = 0; index < 8; index++) await Promise.resolve()
}

const roots: Root[] = []
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount())
})
afterAll(() => GlobalRegistrator.unregister())

test('D1 keeps the latest edit when a snapshot echoes an earlier value', async () => {
  const pending = deferred<boolean>()
  const field = harness('', { write: () => pending.promise })

  field.controller.edit('a')
  field.controller.edit('ab')
  field.update({ remote: 'a', snapshot: nextDraftTick() })

  expect(field.controller.value).toBe('ab')
  pending.resolve(true)
  await field.controller.settled()
})

test('D2 serializes writes and keeps only the latest queued value', async () => {
  const first = deferred<boolean>()
  const second = deferred<boolean>()
  let unresolved = 0
  let maximumUnresolved = 0
  const writes: string[] = []
  const field = harness('', {
    write: (value) => {
      writes.push(value)
      unresolved++
      maximumUnresolved = Math.max(maximumUnresolved, unresolved)
      const reply = writes.length === 1 ? first.promise : second.promise
      return reply.finally(() => unresolved--)
    },
  })

  field.controller.edit('a')
  field.controller.edit('ab')
  field.controller.edit('abc')
  first.resolve(true)
  await flush()
  expect(field.refreshCount).toBe(0)

  expect(writes).toEqual(['a', 'abc'])
  expect(maximumUnresolved).toBe(1)
  second.resolve(true)
  await field.controller.settled()
  expect(field.refreshCount).toBe(1)
})

test('D3 rejects a snapshot requested before the final write settled', async () => {
  const first = deferred<boolean>()
  const second = deferred<boolean>()
  const field = harness('', {
    write: (value) => (value === 'a' ? first.promise : second.promise),
  })

  field.controller.edit('a')
  field.controller.edit('ab')
  const stale = nextDraftTick()
  first.resolve(true)
  await flush()
  second.resolve(true)
  await field.controller.settled()
  field.update({ remote: 'a', snapshot: stale })

  expect(field.controller.value).toBe('ab')
})

test('D4 refreshes once after the final write settles and takes a later tick', async () => {
  const pending = deferred<boolean>()
  let refreshTick = 0
  const before = nextDraftTick()
  const field = harness('', {
    write: () => pending.promise,
    refresh: async () => {
      refreshTick = nextDraftTick()
    },
  })

  field.controller.edit('a')
  pending.resolve(true)
  await field.controller.settled()

  expect(field.refreshCount).toBe(1)
  expect(refreshTick).toBe(before + 2)
})

test('D5 adopts another window value from its post-settle refresh but keeps its own echo', async () => {
  for (const refreshedValue of ['zz', 'ab']) {
    const pending = deferred<boolean>()
    let field!: DraftFieldHarness<string>
    field = harness('', {
      write: () => pending.promise,
      refresh: async () => field.update({ remote: refreshedValue, snapshot: nextDraftTick() }),
    })
    field.controller.edit('ab')
    field.update({ remote: 'zz', snapshot: nextDraftTick() })
    field.update({ remote: 'zz', snapshot: nextDraftTick() })
    pending.resolve(true)
    await field.controller.settled()
    await flush()

    expect(field.controller.value).toBe(refreshedValue)
  }
})

test('D6 retries once on a fresh snapshot and refreshes after the retry', async () => {
  for (const retrySucceeds of [false, true]) {
    const retryReply = deferred<boolean>()
    const sent: string[] = []
    let field!: DraftFieldHarness<string>
    let refreshCount = 0
    field = harness('', {
      resend: true,
      write: (value) => {
        sent.push(value)
        return sent.length === 1
          ? Promise.reject(new Error('first failure'))
          : retryReply.promise
      },
      refresh: async () => {
        refreshCount++
        const remote = retrySucceeds && refreshCount === 2 ? 'abc' : 'ab'
        field.update({ remote, snapshot: nextDraftTick() })
      },
    })

    field.controller.edit('abc')
    await flush()
    expect(field.controller.value).toBe('abc')
    expect(field.controller.error).toBe('first failure')
    expect(sent).toEqual(['abc', 'abc'])
    expect(refreshCount).toBe(1)

    if (retrySucceeds) retryReply.resolve(true)
    else retryReply.reject(new Error('second failure'))
    await field.controller.settled()
    await flush()
    if (!retrySucceeds) field.update({ remote: 'later remote', snapshot: nextDraftTick() })

    expect(field.controller.error).toBe(retrySucceeds ? null : 'second failure')
    expect(field.controller.value).toBe('abc')
    expect(sent).toEqual(['abc', 'abc'])
    expect(refreshCount).toBe(2)
  }
})

test('D7 retains a failed edit until a later snapshot when refresh rejects', async () => {
  const sent: string[] = []
  let field!: DraftFieldHarness<string>
  field = harness('', {
    resend: true,
    write: (value) => {
      sent.push(value)
      return Promise.reject(new Error('stale target'))
    },
    refresh: async () => {
      throw new Error('refresh failed')
    },
  })

  field.controller.edit('abc')
  await field.controller.settled()
  await flush()
  expect(field.controller.value).toBe('abc')
  expect(field.controller.error).toBe('stale target')
  expect(field.refreshCount).toBe(1)

  field.update({ remote: 'ab', snapshot: nextDraftTick() })
  await flush()
  expect(sent).toEqual(['abc', 'abc'])
})

test('D8 does not resend or adopt snapshots when resend is disabled until another edit', async () => {
  const sent: string[] = []
  const field = harness('', {
    resend: false,
    write: (value) => {
      sent.push(value)
      return Promise.reject(new Error('network failure'))
    },
  })
  field.controller.edit('abc')
  await field.controller.settled()
  field.update({ remote: 'remote', snapshot: nextDraftTick() })

  expect(field.controller.value).toBe('abc')
  expect(field.controller.error).toBe('network failure')
  expect(field.refreshCount).toBe(1)
  expect(sent).toEqual(['abc'])

  field.controller.edit('next')
  await field.controller.settled()
  expect(sent).toEqual(['abc', 'next'])
})

test('D9 treats an unapplied write as a quiet held value until another edit', async () => {
  const sent: string[] = []
  const field = harness('', {
    write: (value) => {
      sent.push(value)
      return Promise.resolve(false)
    },
  })
  field.controller.edit('abc')
  await field.controller.settled()
  field.update({ remote: 'remote', snapshot: nextDraftTick() })

  expect(field.controller.value).toBe('abc')
  expect(field.controller.error).toBeNull()
  expect(field.refreshCount).toBe(1)
  expect(sent).toEqual(['abc'])

  field.controller.edit('new')
  await field.controller.settled()
  expect(field.controller.value).toBe('new')
  expect(sent).toEqual(['abc', 'new'])
})

test('D10 drops queued work and ignores an old target write settling either way', async () => {
  for (const fail of [false, true]) {
    const first = deferred<boolean>()
    const sent: string[] = []
    let refreshCount = 0
    const field = harness('', {
      write: (value) => {
        sent.push(value)
        return first.promise
      },
      refresh: async () => {
        refreshCount++
      },
    })
    field.controller.edit('a')
    field.controller.edit('ab')
    field.update({ identity: 'target-b', remote: 'other', snapshot: nextDraftTick() })
    fail ? first.reject(new Error('old failure')) : first.resolve(true)
    await flush()

    expect(field.controller.value).toBe('other')
    expect(field.controller.error).toBeNull()
    expect(sent).toEqual(['a'])
    expect(refreshCount).toBe(0)
  }
})

test('D11 keeps one write lane across A-to-B-to-A identity changes', async () => {
  for (const fail of [false, true]) {
    const oldWrite = deferred<boolean>()
    const firstCalls: string[] = []
    const currentCalls: string[] = []
    const field = harness('', {
      write: (value) => {
        firstCalls.push(value)
        return oldWrite.promise
      },
    })

    field.controller.edit('a')
    field.update({ identity: 'target-b', remote: 'b', snapshot: nextDraftTick() })
    field.update({ identity: 'target-a', remote: '', snapshot: nextDraftTick() })
    field.update({
      write: (value) => {
        currentCalls.push(value)
        return Promise.resolve(true)
      },
    })
    field.controller.edit('new')
    expect(firstCalls).toEqual(['a'])
    expect(currentCalls).toEqual([])

    fail ? oldWrite.reject(new Error('old failure')) : oldWrite.resolve(true)
    await field.controller.settled()

    expect(field.controller.value).toBe('new')
    expect(firstCalls).toEqual(['a'])
    expect(currentCalls).toEqual(['new'])
    expect(field.controller.error).toBeNull()
  }
})

test('D12 holds a local value without writing and through an older write echo', async () => {
  const pending = deferred<boolean>()
  const sent: string[] = []
  const field = harness('main', {
    write: (value) => {
      sent.push(value)
      return pending.promise
    },
  })
  field.controller.hold('rel')
  field.update({ remote: 'release', snapshot: nextDraftTick() })
  expect(field.controller.value).toBe('rel')
  expect(sent).toEqual([])

  field.controller.edit('release')
  field.controller.hold('rel-next')
  pending.resolve(true)
  await field.controller.settled()
  field.update({ remote: 'release', snapshot: nextDraftTick() })

  expect(field.controller.value).toBe('rel-next')
  expect(sent).toEqual(['release'])
})

test('D13 reset fences snapshots requested before it', () => {
  const field = harness('abc')
  const oldSnapshot = nextDraftTick()

  field.controller.reset('')
  field.update({ remote: 'abc', snapshot: oldSnapshot })

  expect(field.controller.value).toBe('')
  expect(field.writes).toEqual([])
})

test('D14 settled waits for the latest queued write but resolves immediately when idle', async () => {
  const first = deferred<boolean>()
  const second = deferred<boolean>()
  const field = harness('', {
    write: (value) => (value === 'a' ? first.promise : second.promise),
  })
  await field.controller.settled()

  let settled = false
  field.controller.edit('a')
  field.controller.edit('ab')
  const waiting = field.controller.settled().then(() => {
    settled = true
  })
  first.resolve(true)
  await flush()
  expect(settled).toBe(false)

  second.resolve(true)
  await waiting
  expect(settled).toBe(true)
})

test('D15 action status tracks edits, holds, takes, and irreversible identity changes', async () => {
  const field = harness('before')
  const action = field.controller.begin()
  expect(action.status()).toBe('same')
  field.controller.edit('after')
  expect(action.status()).toBe('edited')
  expect(action.take()).toBe('after')
  expect(action.status()).toBe('same')
  field.controller.hold('held')
  expect(action.status()).toBe('edited')
  expect(action.take()).toBe('held')
  expect(action.status()).toBe('same')
  field.update({ identity: 'target-b', remote: 'other' })
  expect(action.status()).toBe('gone')
  field.update({ identity: 'target-a', remote: 'back' })
  expect(action.status()).toBe('gone')
  await field.controller.settled()
})

test('D16 discards queued work and does not refresh or surface old failures after unmount', async () => {
  const first = deferred<boolean>()
  const sent: string[] = []
  const field = harness('', {
    write: (value) => {
      sent.push(value)
      return first.promise
    },
  })
  field.controller.edit('a')
  field.controller.edit('abc')
  field.controller.unmount()
  first.reject(new Error('late failure'))
  await flush()

  expect(field.controller.value).toBe('abc')
  expect(field.controller.error).toBeNull()
  expect(field.refreshCount).toBe(0)
  expect(sent).toEqual(['a'])
})

test('D17 treats a snapshot without a tick as newer than every settle', async () => {
  const field = harness('old')
  field.controller.edit('written')
  await field.controller.settled()
  field.update({ remote: 'newer remote', snapshot: undefined })

  expect(field.controller.value).toBe('newer remote')
})

test('D17 does not treat an unchanged unticked remote as a fresh snapshot', async () => {
  const field: DraftFieldHarness<string> = harness('old', {
    resend: true,
    write: (value) => {
      field.writes.push(value)
      return Promise.reject(new Error('stale_target'))
    },
  })
  field.controller.edit('local')
  await field.controller.settled()

  field.update({ remote: 'old', snapshot: undefined })

  expect(field.writes).toEqual(['local'])
  expect(field.controller.value).toBe('local')
  expect(field.controller.error).toBe('stale_target')
})

test('D18 preserves the local reference when equal values have the same structure', () => {
  const initial = { labels: ['one'], enabled: true }
  const field = harness(initial, {
    equal: (left, right) => JSON.stringify(left) === JSON.stringify(right),
  })
  const reference = field.controller.value
  field.update({ remote: { labels: ['one'], enabled: true }, snapshot: nextDraftTick() })

  expect(field.controller.value).toBe(reference)
})

test('D19 rebases a draft version before retrying the same unapplied text', async () => {
  let now = 1_700_000_000_000
  const versions = createDraftVersions(() => now)
  const calls: { text: string; draftVersion: number }[] = []
  const replies = [{ applied: false }, { applied: true }]
  const versionedWrite = async (text: string) => {
    const first = { text, draftVersion: versions.next() }
    calls.push(first)
    const firstReply = replies.shift()!
    if (!firstReply.applied) {
      now++
      versions.rebase()
      const retry = { text, draftVersion: versions.next() }
      calls.push(retry)
      return replies.shift()!.applied
    }
    return firstReply.applied
  }

  const applied = await versionedWrite('same text')

  expect(applied).toBe(true)
  expect(calls).toHaveLength(2)
  expect(calls[1].text).toBe(calls[0].text)
  expect(calls[0].draftVersion).toBeGreaterThanOrEqual(1_700_000_000_000_000)
  expect(calls[1].draftVersion).toBeGreaterThanOrEqual(now * 1000)
  expect(calls[1].draftVersion).toBeGreaterThan(calls[0].draftVersion)
})

test('D20 preserves edits made during an action and resends after success clears the draft', async () => {
  const writes: { value: string | null; reply: Deferred<boolean> }[] = []
  let field!: DraftFieldHarness<string | null>
  field = harness<string | null>('x', {
    write: (value) => {
      const reply = deferred<boolean>()
      writes.push({ value, reply })
      return reply.promise
    },
    refresh: async () => field.update({
      remote: field.refreshCount === 1 ? null : 'xy',
      snapshot: nextDraftTick(),
    }),
  })
  const action = field.controller.begin()
  action.take()
  field.controller.edit('xy')
  writes[0].reply.resolve(true)
  await flush()
  expect(field.controller.value).toBe('xy')

  action.succeed(null)
  expect(field.controller.value).toBe('xy')
  expect(writes.map(({ value }) => value)).toEqual(['xy', 'xy'])
  writes[1].reply.resolve(true)
  await field.controller.settled()
  expect(field.refreshCount).toBe(2)
})

test('D21 uses an unchanged action clear and honors an explicit send request', async () => {
  const plain = harness<string | null>('x')
  const action = plain.controller.begin()
  action.take()
  const beforeActionEnd = nextDraftTick()
  plain.update({ remote: null, snapshot: beforeActionEnd })
  action.succeed(null)
  plain.update({ remote: 'x', snapshot: beforeActionEnd })
  expect(plain.controller.value).toBeNull()
  expect(plain.writes).toEqual([])
  expect(plain.refreshCount).toBe(1)

  const sent = harness<string | null>('x')
  const sendAction = sent.controller.begin()
  sendAction.take()
  sendAction.succeed('', { send: true })
  await sent.controller.settled()
  expect(sent.controller.value).toBe('')
  expect(sent.writes).toEqual([''])
})

test('D22 holds action edits over restored snapshots after failure without resending', async () => {
  let field!: DraftFieldHarness<string | null>
  field = harness<string | null>('original', {
    write: (value) => {
      field.writes.push(value)
      return Promise.resolve(true)
    },
    refresh: async () => field.update({ remote: 'original', snapshot: nextDraftTick() }),
  })
  const action = field.controller.begin()
  action.take()
  field.controller.edit('xy')
  await field.controller.settled()
  const writesBeforeFailure = [...field.writes]
  const refreshesBeforeFailure = field.refreshCount

  action.fail()
  await flush()
  field.update({ remote: 'original', snapshot: nextDraftTick() })

  expect(field.controller.value).toBe('xy')
  expect(field.writes).toEqual(writesBeforeFailure)
  expect(field.refreshCount).toBe(refreshesBeforeFailure + 1)
})

test('D22 keeps an action edit held when its in-flight write fails afterward', async () => {
  const reply = deferred<boolean>()
  const field = harness('original', {
    resend: true,
    write: (value) => {
      field.writes.push(value)
      return reply.promise
    },
  })
  const action = field.controller.begin()
  action.take()
  field.controller.edit('xy')
  action.fail()
  reply.reject(new Error('write failed'))
  await field.controller.settled()

  field.update({ remote: 'original', snapshot: nextDraftTick() })

  expect(field.controller.value).toBe('xy')
  expect(field.controller.error).toBe('write failed')
  expect(field.writes).toEqual(['xy'])
})

test('D6 retries a failed write on an explicit fresh tick with the same remote value', async () => {
  const field: DraftFieldHarness<string> = harness('abc', {
    resend: true,
    write: (value) => {
      field.writes.push(value)
      return field.writes.length === 1
        ? Promise.reject(new Error('stale_target'))
        : Promise.resolve(true)
    },
  })
  field.controller.edit('abc')
  await field.controller.settled()
  expect(field.controller.error).toBe('stale_target')

  field.update({ remote: 'abc', snapshot: nextDraftTick() })
  await field.controller.settled()

  expect(field.writes).toEqual(['abc', 'abc'])
  expect(field.controller.error).toBeNull()
})

test('D23 ignores action completion after a target change', async () => {
  for (const finish of ['succeed', 'fail'] as const) {
    let refreshCount = 0
    const field = harness('before', {
      refresh: async () => {
        refreshCount++
      },
    })
    const action = field.controller.begin()
    field.update({ identity: 'target-b', remote: 'other' })
    if (finish === 'succeed') action.succeed('cleared')
    else action.fail()

    expect(field.controller.value).toBe('other')
    expect(field.writes).toEqual([])
    expect(refreshCount).toBe(0)
  }
})

test('D24 target guards stay false after identity changes away and back', async () => {
  let guard: () => boolean = () => false
  function Probe({ identity }: { identity: string }) {
    guard = useTargetGuard(identity)()
    return null
  }
  const root = createRoot(document.createElement('div'))
  roots.push(root)
  await act(async () => root.render(createElement(Probe, { identity: 'A' })))
  const here = guard
  expect(here()).toBe(true)
  await act(async () => root.render(createElement(Probe, { identity: 'B' })))
  expect(here()).toBe(false)
  await act(async () => root.render(createElement(Probe, { identity: 'A' })))
  expect(here()).toBe(false)
  expect(guard()).toBe(true)
})

test('useDraftField keeps reset text through a local render with unchanged unticked props', async () => {
  let field!: DraftField<string>
  let rerender!: () => void
  function Probe() {
    const [, setRevision] = useState(0)
    rerender = () => setRevision((revision) => revision + 1)
    field = useDraftField({
      identity: 'target-a',
      remote: 'abc',
      snapshot: undefined,
      write: async () => true,
      refresh: async () => {},
    })
    return null
  }

  const root = createRoot(document.createElement('div'))
  roots.push(root)
  await act(async () => root.render(createElement(Probe)))
  await act(async () => {
    field.reset('')
    rerender()
  })

  expect(field.value).toBe('')
})

test('useDraftField keeps an applied edit through an unrelated local render before refresh', async () => {
  const write = deferred<boolean>()
  let field!: DraftField<string>
  let rerender!: () => void
  function Probe() {
    const [, setRevision] = useState(0)
    rerender = () => setRevision((revision) => revision + 1)
    field = useDraftField({
      identity: 'target-a',
      remote: '',
      snapshot: undefined,
      write: () => write.promise,
      refresh: async () => {},
    })
    return null
  }

  const root = createRoot(document.createElement('div'))
  roots.push(root)
  await act(async () => root.render(createElement(Probe)))
  await act(async () => field.edit('typed'))
  await act(async () => {
    write.resolve(true)
    await flush()
  })
  await act(async () => rerender())

  expect(field.value).toBe('typed')
})

test('D24 target guards stay false after unmount', async () => {
  let here = () => false
  function Probe() {
    here = useTargetGuard('A')()
    return null
  }
  const root = createRoot(document.createElement('div'))
  await act(async () => root.render(createElement(Probe)))
  expect(here()).toBe(true)
  await act(async () => root.unmount())
  expect(here()).toBe(false)
})
