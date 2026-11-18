import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RpcErrorCode, type QueuedMessage } from '@quirky/protocol'
import { openPluginStore } from '../../../packages/daemon/src/plugins/stores'
import { waitFor, waitForAsync } from '../../../packages/daemon/test/helpers'
import { journalMigrations } from '../journal'
import { MessageQueue } from '../queue'
import { bootChat, teardownChat, type ChatBoot } from './chat-harness'
import { FakeWorld } from './fakes/world'

let chat: ChatBoot | undefined
afterEach(async () => {
  await teardownChat(chat)
  chat = undefined
})

const queueEvents = (boot: ChatBoot) =>
  boot.events.filter((event) => event.type === 'quirky.structured/queueChanged').map((event) => (event as { data: { queue: QueuedMessage[] } }).data.queue)

async function working(boot: ChatBoot) {
  const session = await boot.create('start')
  await waitFor(() => boot.world.statusLog.some((entry) => entry.status === 'working'))
  return session
}

describe('send when', () => {
  test('the default sends at once even while the agent is working', async () => {
    chat = await bootChat()
    const session = await working(chat)
    expect(await chat.call('quirky.structured/send', { session: session.id, text: 'now' })).toEqual({ ok: true })
    expect(chat.runner.sent.map((sent) => sent.text)).toEqual(['now'])
    expect(await chat.call('quirky.structured/queue', { session: session.id })).toEqual([])
  })

  test('idle queues while working, then sends one message per finished turn in order', async () => {
    chat = await bootChat()
    const session = await working(chat)
    const first = await chat.call('quirky.structured/send', { session: session.id, text: 'one', when: 'idle' })
    await chat.call('quirky.structured/send', { session: session.id, text: 'two', when: 'idle' })
    expect(first).toMatchObject({ ok: true, queuedId: expect.any(String) })
    expect(chat.runner.sent).toEqual([])
    const queued = (await chat.call('quirky.structured/queue', { session: session.id })) as QueuedMessage[]
    expect(queued.map((message) => message.text)).toEqual(['one', 'two'])
    expect(queued[0]).toMatchObject({ id: first.queuedId, at: expect.stringMatching(/^\d{4}-\d\d-\d\dT/) })
    expect(queueEvents(chat).at(-1)!.map((message) => message.text)).toEqual(['one', 'two'])

    chat.runner.finish(session.id)
    await waitFor(() => chat!.runner.sent.length === 1)
    expect(chat.runner.sent[0]).toMatchObject({ text: 'one', options: { queuedId: first.queuedId } })
    expect(((await chat.call('quirky.structured/queue', { session: session.id })) as QueuedMessage[]).map((m) => m.text)).toEqual(['two'])
    await Bun.sleep(50)
    expect(chat.runner.sent).toHaveLength(1)

    chat.runner.finish(session.id)
    await waitFor(() => chat!.runner.sent.length === 2)
    expect(chat.runner.sent[1]!.text).toBe('two')
    expect(await chat.call('quirky.structured/queue', { session: session.id })).toEqual([])
  })

  test('idle sends at once when the agent is idle', async () => {
    chat = await bootChat()
    const session = await working(chat)
    chat.runner.finish(session.id)
    await waitFor(() => chat!.world.statusLog.some((entry) => entry.status === 'done'))
    expect(await chat.call('quirky.structured/send', { session: session.id, text: 'right away', when: 'idle' })).toEqual({ ok: true })
    expect(chat.runner.sent.map((sent) => sent.text)).toEqual(['right away'])
  })

  test('a rejected queued send is tried once, noted, and flushing resumes after a direct send', async () => {
    chat = await bootChat()
    const session = await working(chat)
    await chat.call('quirky.structured/send', { session: session.id, text: 'keep me', when: 'idle' })
    let attempts = 0
    const realSend = chat.runner.send.bind(chat.runner)
    chat.runner.send = async (...args) => {
      attempts++
      return realSend(...args)
    }
    chat.runner.sendError = new Error('agent gone')
    chat.runner.finish(session.id)
    await waitFor(() => attempts === 1)
    chat.runner.finish(session.id)
    await Bun.sleep(100)
    expect(attempts).toBe(1)
    expect(((await chat.call('quirky.structured/queue', { session: session.id })) as QueuedMessage[]).map((m) => m.text)).toEqual(['keep me'])
    const notes = (await chat.messages(session.id)).filter((m) => m.role === 'system' && m.text.includes("Couldn't send the queued message"))
    expect(notes).toHaveLength(1)

    chat.runner.sendError = null
    await chat.call('quirky.structured/send', { session: session.id, text: 'direct' })
    chat.runner.finish(session.id)
    await waitFor(() => chat!.runner.sent.some((sent) => sent.text === 'keep me'))
  })

  test('a flush that fails keeps the message queued', async () => {
    chat = await bootChat()
    const session = await working(chat)
    await chat.call('quirky.structured/send', { session: session.id, text: 'keep me', when: 'idle' })
    chat.runner.sendError = new Error('agent gone')
    chat.runner.finish(session.id)
    await Bun.sleep(100)
    expect(((await chat.call('quirky.structured/queue', { session: session.id })) as QueuedMessage[]).map((m) => m.text)).toEqual(['keep me'])
  })

  test('stop leaves the queue untouched', async () => {
    chat = await bootChat()
    const session = await working(chat)
    await chat.call('quirky.structured/send', { session: session.id, text: 'later', when: 'idle' })
    await chat.call('quirky.structured/stop', { session: session.id })
    expect(chat.runner.sent).toEqual([])
    expect(((await chat.call('quirky.structured/queue', { session: session.id })) as QueuedMessage[]).map((m) => m.text)).toEqual(['later'])
  })

  test('interrupt ends the turn and leaves the queue unsent, and the next normal turn end still flushes', async () => {
    chat = await bootChat()
    const session = await working(chat)
    await chat.call('quirky.structured/send', { session: session.id, text: 'later', when: 'idle' })
    expect(await chat.call('quirky.structured/interrupt', { session: session.id })).toEqual({ ok: true })
    expect(chat.runner.interrupted).toEqual([session.id])
    await Bun.sleep(100)
    expect(chat.runner.sent).toEqual([])
    expect(((await chat.call('quirky.structured/queue', { session: session.id })) as QueuedMessage[]).map((m) => m.text)).toEqual(['later'])

    await chat.call('quirky.structured/send', { session: session.id, text: 'next' })
    chat.runner.finish(session.id)
    await waitFor(() => chat!.runner.sent.some((sent) => sent.text === 'later'))
    expect(await chat.call('quirky.structured/queue', { session: session.id })).toEqual([])
  })

  test('steer still works on a queued message after an interrupt', async () => {
    chat = await bootChat()
    const session = await working(chat)
    const queued = await chat.call('quirky.structured/send', { session: session.id, text: 'later', when: 'idle' })
    await chat.call('quirky.structured/interrupt', { session: session.id })
    await chat.call('quirky.structured/steer', { session: session.id, id: queued.queuedId })
    expect(chat.runner.sent.map((sent) => sent.text)).toEqual(['later'])
  })

  test('interrupt rejects unknown params', async () => {
    chat = await bootChat()
    const session = await working(chat)
    await expect(chat.call('quirky.structured/interrupt', { session: session.id, extra: 1 })).rejects.toMatchObject({ code: RpcErrorCode.InvalidParams })
  })

  test('a repeated operationId does not queue twice', async () => {
    chat = await bootChat()
    const session = await working(chat)
    const params = { session: session.id, text: 'once', when: 'idle', operationId: 'op-1' }
    await chat.call('quirky.structured/send', params)
    expect(await chat.call('quirky.structured/send', params)).toEqual({ ok: true })
    expect(await chat.call('quirky.structured/queue', { session: session.id })).toHaveLength(1)
  })

  test('an unknown when is refused', async () => {
    chat = await bootChat()
    const session = await working(chat)
    const error = await chat.failure(chat.call('quirky.structured/send', { session: session.id, text: 'x', when: 'later' }))
    expect(error.code).toBe(RpcErrorCode.InvalidParams)
  })

  test('the queue survives a daemon restart', async () => {
    const home = mkdtempSync('/tmp/qs-')
    chat = await bootChat({ home })
    const session = await working(chat)
    await chat.call('quirky.structured/send', { session: session.id, text: 'persist me', when: 'idle' })
    await chat.stopDaemon()
    const second = new FakeWorld()
    second.addStructuredSession(session.id)
    chat = await bootChat({ home, world: second })
    const queued = (await chat.call('quirky.structured/queue', { session: session.id })) as QueuedMessage[]
    expect(queued.map((message) => message.text)).toEqual(['persist me'])
  })
})

describe('queue methods', () => {
  test('dequeue removes a message and an unknown id is not-found', async () => {
    chat = await bootChat()
    const session = await working(chat)
    const { queuedId } = await chat.call('quirky.structured/send', { session: session.id, text: 'drop', when: 'idle' })
    expect(await chat.call('quirky.structured/dequeue', { session: session.id, id: queuedId })).toEqual({ ok: true })
    expect(await chat.call('quirky.structured/queue', { session: session.id })).toEqual([])
    expect(queueEvents(chat).at(-1)).toEqual([])
    const error = await chat.failure(chat.call('quirky.structured/dequeue', { session: session.id, id: queuedId }))
    expect(error.code).toBe(RpcErrorCode.NotFound)
  })

  test('editQueued changes the text in place', async () => {
    chat = await bootChat()
    const session = await working(chat)
    await chat.call('quirky.structured/send', { session: session.id, text: 'first', when: 'idle' })
    const { queuedId } = await chat.call('quirky.structured/send', { session: session.id, text: 'second', when: 'idle' })
    expect(await chat.call('quirky.structured/editQueued', { session: session.id, id: queuedId, text: 'second, edited' })).toEqual({ ok: true })
    expect(((await chat.call('quirky.structured/queue', { session: session.id })) as QueuedMessage[]).map((m) => m.text)).toEqual(['first', 'second, edited'])
    const error = await chat.failure(chat.call('quirky.structured/editQueued', { session: session.id, id: 'nope', text: 'x' }))
    expect(error.code).toBe(RpcErrorCode.NotFound)
    const blank = await chat.failure(chat.call('quirky.structured/editQueued', { session: session.id, id: queuedId, text: '  ' }))
    expect(blank.code).toBe(RpcErrorCode.InvalidParams)
  })

  test('steer removes the message and sends it now', async () => {
    chat = await bootChat()
    const session = await working(chat)
    await chat.call('quirky.structured/send', { session: session.id, text: 'first', when: 'idle' })
    const { queuedId } = await chat.call('quirky.structured/send', { session: session.id, text: 'urgent', when: 'idle' })
    expect(await chat.call('quirky.structured/steer', { session: session.id, id: queuedId })).toEqual({ ok: true })
    expect(chat.runner.sent).toEqual([{ sessionId: session.id, text: 'urgent', options: { queuedId } }])
    expect(((await chat.call('quirky.structured/queue', { session: session.id })) as QueuedMessage[]).map((m) => m.text)).toEqual(['first'])
    const error = await chat.failure(chat.call('quirky.structured/steer', { session: session.id, id: queuedId }))
    expect(error.code).toBe(RpcErrorCode.NotFound)
  })

  test('steer on an agent without steering is a conflict with steer-unsupported', async () => {
    chat = await bootChat()
    const session = await working(chat)
    const { queuedId } = await chat.call('quirky.structured/send', { session: session.id, text: 'x', when: 'idle' })
    chat.world.sessions.set(session.id, { ...chat.world.sessions.get(session.id)!, agent: 'gemini' })
    const error = await chat.failure(chat.call('quirky.structured/steer', { session: session.id, id: queuedId }))
    expect(error.code).toBe(RpcErrorCode.Conflict)
    expect(error.data).toEqual({ reason: 'steer-unsupported' })
    expect(await chat.call('quirky.structured/queue', { session: session.id })).toHaveLength(1)
  })

  test('a steer whose send fails restores the message', async () => {
    chat = await bootChat()
    const session = await working(chat)
    const { queuedId } = await chat.call('quirky.structured/send', { session: session.id, text: 'x', when: 'idle' })
    chat.runner.sendError = new Error('nope')
    await chat.failure(chat.call('quirky.structured/steer', { session: session.id, id: queuedId }))
    expect(((await chat.call('quirky.structured/queue', { session: session.id })) as QueuedMessage[]).map((m) => m.id)).toEqual([queuedId])
  })

  test('the queue methods refuse a session that is not structured', async () => {
    chat = await bootChat()
    const terminal = chat.world.addTerminalSession()
    const error = await chat.failure(chat.call('quirky.structured/queue', { session: terminal.id }))
    expect(error.code).toBe(RpcErrorCode.InvalidParams)
  })
})

describe('images', () => {
  let dir: string
  afterEach(() => rmSync(dir, { recursive: true, force: true }))
  const refusal = async (boot: ChatBoot, session: string, images: unknown) =>
    boot.failure(boot.call('quirky.structured/send', { session, text: 'look', images }))

  test('valid image paths reach the runner and the queue; each bad one is invalid-params', async () => {
    dir = mkdtempSync(join(tmpdir(), 'qs-img-'))
    const png = join(dir, 'a.PNG')
    writeFileSync(png, 'x')
    const big = join(dir, 'big.jpg')
    writeFileSync(big, '')
    truncateSync(big, 20 * 1024 * 1024 + 1)
    const folder = join(dir, 'folder.png')
    mkdirSync(folder)
    const text = join(dir, 'notes.txt')
    writeFileSync(text, 'x')

    chat = await bootChat()
    const session = await working(chat)
    await chat.call('quirky.structured/send', { session: session.id, text: 'look', images: [png] })
    expect(chat.runner.sent.at(-1)).toMatchObject({ text: 'look', options: { images: [png] } })

    const { queuedId } = await chat.call('quirky.structured/send', { session: session.id, text: 'later', images: [png], when: 'idle' })
    expect(await chat.call('quirky.structured/queue', { session: session.id })).toEqual([
      expect.objectContaining({ id: queuedId, text: 'later', images: [png] })
    ])

    for (const bad of [[join(dir, 'missing.png')], ['relative.png'], [folder], [text], [big], 'a.png', [1]]) {
      const error = await refusal(chat, session.id, bad)
      expect(error.code).toBe(RpcErrorCode.InvalidParams)
    }
  })
})

describe('queued images at flush time', () => {
  let dir: string
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  test('an image replaced by a FIFO, a text file or an oversized file is dropped with a status item', async () => {
    dir = mkdtempSync(join(tmpdir(), 'qs-flush-'))
    const keep = join(dir, 'keep.png')
    const fifo = join(dir, 'fifo.png')
    const big = join(dir, 'big.png')
    for (const path of [keep, fifo, big]) writeFileSync(path, 'x')
    chat = await bootChat()
    const session = await working(chat)
    await chat.call('quirky.structured/send', { session: session.id, text: 'later', images: [keep, fifo, big], when: 'idle' })
    rmSync(fifo)
    expect(Bun.spawnSync(['mkfifo', fifo]).exitCode).toBe(0)
    truncateSync(big, 20 * 1024 * 1024 + 1)
    chat.runner.finish(session.id)
    await waitFor(() => chat!.runner.sent.length === 1)
    expect(chat.runner.sent[0]!.options).toMatchObject({ images: [keep] })
    const statuses = (await chat.messages(session.id)).flatMap((message) => (message.item?.kind === 'status' ? [message.item.text] : []))
    expect(statuses).toEqual([`Image not sent: image ${fifo} is not a regular file`, `Image not sent: image ${big} is larger than 20 MB`])
  })

  test('a message whose images all fail is sent as text alone', async () => {
    dir = mkdtempSync(join(tmpdir(), 'qs-flush-'))
    const gone = join(dir, 'gone.png')
    writeFileSync(gone, 'x')
    chat = await bootChat()
    const session = await working(chat)
    await chat.call('quirky.structured/send', { session: session.id, text: 'later', images: [gone], when: 'idle' })
    rmSync(gone)
    chat.runner.finish(session.id)
    await waitFor(() => chat!.runner.sent.length === 1)
    expect(chat.runner.sent[0]!.options?.images).toBeUndefined()
    expect(chat.runner.sent[0]!.text).toBe('later')
  })
})

describe('the queue store', () => {
  test('keeps order, edits, takes and restores a message to its place', () => {
    const home = mkdtempSync(join(tmpdir(), 'qs-queue-'))
    const opened = openPluginStore({ home, pluginId: 'quirky.structured', migrations: journalMigrations(home), isActive: () => true })
    try {
      const queue = new MessageQueue(opened.store)
      const a = queue.add('s1', { text: 'a' }, 1000)
      const b = queue.add('s1', { text: 'b', images: ['/x.png'] }, 2000)
      queue.add('s2', { text: 'other' }, 3000)
      expect(queue.list('s1').map((m) => m.text)).toEqual(['a', 'b'])
      expect(queue.list('s1')[1]).toEqual({ id: b.id, text: 'b', images: ['/x.png'], at: new Date(2000).toISOString() })
      expect(queue.edit('s1', a.id, 'a2')).toBe(true)
      expect(queue.edit('s2', a.id, 'wrong session')).toBe(false)
      const taken = queue.take('s1', a.id)!
      expect(queue.list('s1').map((m) => m.text)).toEqual(['b'])
      queue.restore('s1', taken)
      expect(queue.list('s1').map((m) => m.text)).toEqual(['a2', 'b'])
      expect(queue.take('s1', 'nope')).toBeNull()
      queue.clear('s1')
      expect(queue.list('s1')).toEqual([])
      expect(queue.list('s2')).toHaveLength(1)
    } finally {
      opened.close()
      rmSync(home, { recursive: true, force: true })
    }
  })
})

describe('queue store reorder and move', () => {
  const withQueue = (run: (queue: MessageQueue) => void) => {
    const home = mkdtempSync(join(tmpdir(), 'qs-queue-'))
    const opened = openPluginStore({ home, pluginId: 'quirky.structured', migrations: journalMigrations(home), isActive: () => true })
    try {
      run(new MessageQueue(opened.store))
    } finally {
      opened.close()
      rmSync(home, { recursive: true, force: true })
    }
  }

  test('reorder keeps ids, text and images and rejects anything but a permutation', () => {
    withQueue((queue) => {
      const a = queue.add('s1', { text: 'a' }, 1000)
      const b = queue.add('s1', { text: 'b', images: ['/x.png'] }, 2000)
      const c = queue.add('s1', { text: 'c' }, 3000)
      const before = queue.list('s1')
      expect(queue.reorder('s1', [c.id, a.id, b.id])).toBe(true)
      expect(queue.list('s1')).toEqual([before[2]!, before[0]!, before[1]!])
      expect(queue.reorder('s1', [a.id, b.id])).toBe(false)
      expect(queue.reorder('s1', [a.id, a.id, b.id])).toBe(false)
      expect(queue.reorder('s1', [a.id, b.id, 'nope'])).toBe(false)
      expect(queue.list('s1').map((m) => m.id)).toEqual([c.id, a.id, b.id])
    })
  })

  test('a message taken before a reorder still restores into the queue', () => {
    withQueue((queue) => {
      const a = queue.add('s1', { text: 'a' }, 1000)
      const b = queue.add('s1', { text: 'b' }, 2000)
      const c = queue.add('s1', { text: 'c' }, 3000)
      const taken = queue.take('s1', a.id)!
      queue.reorder('s1', [c.id, b.id])
      queue.restore('s1', taken)
      expect(queue.list('s1').map((m) => m.text)).toEqual(['a', 'c', 'b'])
    })
  })

  test('moveSession moves the messages in order and leaves other sessions alone', () => {
    withQueue((queue) => {
      queue.add('old', { text: 'a' }, 1000)
      queue.add('other', { text: 'x' }, 1500)
      queue.add('old', { text: 'b' }, 2000)
      queue.moveSession('old', 'new')
      expect(queue.list('new').map((m) => m.text)).toEqual(['a', 'b'])
      expect(queue.list('old')).toEqual([])
      expect(queue.list('other')).toHaveLength(1)
    })
  })
})

describe('reorderQueued', () => {
  test('sets the order, keeps the messages and emits queueChanged', async () => {
    chat = await bootChat()
    const session = await working(chat)
    const one = await chat.call('quirky.structured/send', { session: session.id, text: 'one', when: 'idle' })
    const two = await chat.call('quirky.structured/send', { session: session.id, text: 'two', when: 'idle' })
    const before = (await chat.call('quirky.structured/queue', { session: session.id })) as QueuedMessage[]
    expect(await chat.call('quirky.structured/reorderQueued', { session: session.id, ids: [two.queuedId, one.queuedId] })).toEqual({ ok: true })
    expect(await chat.call('quirky.structured/queue', { session: session.id })).toEqual([before[1]!, before[0]!])
    expect(queueEvents(chat).at(-1)!.map((m) => m.text)).toEqual(['two', 'one'])
  })

  test('an unknown id is not-found and a non-permutation is invalid-params', async () => {
    chat = await bootChat()
    const session = await working(chat)
    const one = await chat.call('quirky.structured/send', { session: session.id, text: 'one', when: 'idle' })
    await chat.call('quirky.structured/send', { session: session.id, text: 'two', when: 'idle' })
    expect((await chat.failure(chat.call('quirky.structured/reorderQueued', { session: session.id, ids: [one.queuedId, 'nope'] }))).code).toBe(RpcErrorCode.NotFound)
    expect((await chat.failure(chat.call('quirky.structured/reorderQueued', { session: session.id, ids: [one.queuedId] }))).code).toBe(RpcErrorCode.InvalidParams)
    expect((await chat.failure(chat.call('quirky.structured/reorderQueued', { session: session.id, ids: [one.queuedId, one.queuedId] }))).code).toBe(RpcErrorCode.InvalidParams)
    expect((await chat.failure(chat.call('quirky.structured/reorderQueued', { session: 'missing', ids: [] }))).code).toBe(RpcErrorCode.NotFound)
  })
})

describe('sendQueued', () => {
  const held = async (boot: ChatBoot, texts: string[]) => {
    const session = await working(boot)
    const ids: string[] = []
    for (const text of texts) ids.push((await boot.call('quirky.structured/send', { session: session.id, text, when: 'idle' })).queuedId)
    await boot.call('quirky.structured/interrupt', { session: session.id })
    await waitFor(() => boot.world.statusLog.some((entry) => entry.status === 'done'))
    return { session, ids }
  }

  test('sends the chosen message now while idle and leaves the rest queued', async () => {
    chat = await bootChat()
    const { session, ids } = await held(chat, ['first', 'second'])
    expect(await chat.call('quirky.structured/sendQueued', { session: session.id, id: ids[1] })).toEqual({ ok: true })
    expect(chat.runner.sent).toEqual([{ sessionId: session.id, text: 'second', options: { queuedId: ids[1] } }])
    expect(((await chat.call('quirky.structured/queue', { session: session.id })) as QueuedMessage[]).map((m) => m.text)).toEqual(['first'])
    expect(queueEvents(chat).at(-1)!.map((m) => m.text)).toEqual(['first'])
  })

  test('an id that is not queued is not-found', async () => {
    chat = await bootChat()
    const { session } = await held(chat, ['first'])
    expect((await chat.failure(chat.call('quirky.structured/sendQueued', { session: session.id, id: 'nope' }))).code).toBe(RpcErrorCode.NotFound)
  })

  test('a working session is a busy conflict and keeps the message', async () => {
    chat = await bootChat()
    const session = await working(chat)
    const { queuedId } = await chat.call('quirky.structured/send', { session: session.id, text: 'x', when: 'idle' })
    const error = await chat.failure(chat.call('quirky.structured/sendQueued', { session: session.id, id: queuedId }))
    expect(error.code).toBe(RpcErrorCode.Conflict)
    expect(error.data).toEqual({ reason: 'busy' })
    expect(await chat.call('quirky.structured/queue', { session: session.id })).toHaveLength(1)
  })

  test('an ended session is an exited conflict', async () => {
    chat = await bootChat()
    const session = await working(chat)
    const { queuedId } = await chat.call('quirky.structured/send', { session: session.id, text: 'x', when: 'idle' })
    await chat.call('quirky.structured/stop', { session: session.id })
    const error = await chat.failure(chat.call('quirky.structured/sendQueued', { session: session.id, id: queuedId }))
    expect(error.code).toBe(RpcErrorCode.Conflict)
    expect(error.data).toEqual({ reason: 'exited' })
  })

  test('a failed send restores the message to its place', async () => {
    chat = await bootChat()
    const { session, ids } = await held(chat, ['first', 'second'])
    chat.runner.sendError = new Error('nope')
    const error = await chat.failure(chat.call('quirky.structured/sendQueued', { session: session.id, id: ids[0] }))
    expect(error.message).toContain('nope')
    expect(((await chat.call('quirky.structured/queue', { session: session.id })) as QueuedMessage[]).map((m) => m.text)).toEqual(['first', 'second'])
  })
})

describe('commands', () => {
  test('is empty until a runner reports, then returns the list without duplicates and emits commandsChanged', async () => {
    chat = await bootChat()
    const session = await working(chat)
    expect(await chat.call('quirky.structured/commands', { session: session.id })).toEqual({ commands: [] })
    chat.runner.context.reportCommands!(session.id, [
      { name: 'compact', kind: 'command' },
      { name: 'compact', kind: 'command' },
      { name: 'compact', kind: 'skill' }
    ])
    const expected = [
      { name: 'compact', kind: 'command' },
      { name: 'compact', kind: 'skill' }
    ]
    expect(await chat.call('quirky.structured/commands', { session: session.id })).toEqual({ commands: expected })
    await waitFor(() => chat!.events.some((event) => event.type === 'quirky.structured/commandsChanged'))
    const event = chat.events.find((e) => e.type === 'quirky.structured/commandsChanged') as { data: unknown }
    expect(event.data).toEqual({ sessionId: session.id, commands: expected })
  })

  test('an unknown session is not-found', async () => {
    chat = await bootChat()
    expect((await chat.failure(chat.call('quirky.structured/commands', { session: 'missing' }))).code).toBe(RpcErrorCode.NotFound)
  })
})

describe('turn baseline', () => {
  test('the snapshot is awaited before the message reaches the agent, for send, flush and steer', async () => {
    chat = await bootChat({ git: true })
    const session = await working(chat)
    chat.runner.finish(session.id)
    await waitFor(() => chat!.world.statusLog.some((entry) => entry.status === 'done'))
    const order: string[] = []
    chat.git.snapshotTree = async () => {
      order.push('snapshot-start')
      await Bun.sleep(60)
      order.push('snapshot-end')
      return { tree: 'late' }
    }
    chat.runner.onSend = () => order.push('send')
    await chat.call('quirky.structured/send', { session: session.id, text: 'direct' })
    expect(order).toEqual(['snapshot-start', 'snapshot-end', 'send'])

    const queuedMessage = await chat.call('quirky.structured/send', { session: session.id, text: 'later', when: 'idle' })
    expect(queuedMessage.queuedId).toBeDefined()
    order.length = 0
    chat.runner.finish(session.id)
    await waitFor(() => order.includes('send'))
    expect(order.slice(-3)).toEqual(['snapshot-start', 'snapshot-end', 'send'])
  })

  test('a failing snapshot does not block the send', async () => {
    chat = await bootChat({ git: true })
    const session = await working(chat)
    chat.runner.finish(session.id)
    await waitFor(() => chat!.world.statusLog.some((entry) => entry.status === 'done'))
    chat.git.snapshotTree = () => {
      throw new Error('git is down')
    }
    expect(await chat.call('quirky.structured/send', { session: session.id, text: 'still goes' })).toEqual({ ok: true })
    expect(chat.runner.sent.map((sent) => sent.text)).toEqual(['still goes'])
  })
})

describe('models', () => {
  test('returns the runner list', async () => {
    chat = await bootChat()
    const session = await working(chat)
    chat.runner.models = async () => [{ id: 'a/one', label: 'One (a)' }]
    expect(await chat.call('quirky.structured/models', { session: session.id })).toEqual({ models: [{ id: 'a/one', label: 'One (a)' }], current: null })
  })

  test('is empty for a runner without models', async () => {
    chat = await bootChat()
    const session = await working(chat)
    expect(await chat.call('quirky.structured/models', { session: session.id })).toEqual({ models: [], current: null })
  })

  test('rejects unknown params', async () => {
    chat = await bootChat()
    const session = await working(chat)
    expect((await chat.failure(chat.call('quirky.structured/models', { session: session.id, bogus: 1 }))).code).toBe(RpcErrorCode.InvalidParams)
  })
})

describe('configure', () => {
  test('hands the picks to the runner and reports the settings in force', async () => {
    chat = await bootChat()
    const session = await working(chat)
    const result = await chat.call('quirky.structured/configure', { session: session.id, permissionMode: 'plan' })
    expect(result).toEqual({ ok: true, settings: { permissionMode: 'plan' } })
    expect(chat.runner.configured).toEqual([{ sessionId: session.id, settings: { permissionMode: 'plan' } }])
  })

  test('a pick the agent cannot take fails with the capability reason', async () => {
    chat = await bootChat()
    const session = await chat.call('quirky.structured/create', { worktree: 'main', agent: 'codex', prompt: 'go' })
    const error = await chat.failure(chat.call('quirky.structured/configure', { session: session.id, permissionMode: 'plan' }))
    expect(error.message).toContain('Codex runs with on-request approval in Quirky')
    expect(chat.runner.configured).toEqual([])
  })

  test('rejects unknown keys and bad types', async () => {
    chat = await bootChat()
    const session = await working(chat)
    expect((await chat.failure(chat.call('quirky.structured/configure', { session: session.id, permissionMode: 5 }))).code).toBe(RpcErrorCode.InvalidParams)
    expect((await chat.failure(chat.call('quirky.structured/configure', { session: session.id, bogus: 1 }))).code).toBe(RpcErrorCode.InvalidParams)
  })
})

describe('stop during the baseline snapshot', () => {
  test('a start whose snapshot resolves after stop never reaches the agent', async () => {
    chat = await bootChat({ git: true })
    const gate = Promise.withResolvers<{ tree: string }>()
    chat.git.snapshotTree = () => gate.promise
    const session = await chat.create('go')
    await waitFor(() => chat!.git.calls.some((call) => call.method === 'snapshotTree'))
    await chat.call('quirky.structured/stop', { session: session.id })
    gate.resolve({ tree: 'late' })
    await Bun.sleep(100)
    expect(await chat.messages(session.id)).toEqual([])
    expect(chat.world.statusLog.some((entry) => entry.status === 'working')).toBe(false)
  })
})
