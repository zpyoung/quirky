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
