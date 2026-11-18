import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RpcErrorCode, type AskSpec, type QueuedMessage } from '@quirky/protocol'
import { waitFor, waitForAsync } from '../../../packages/daemon/test/helpers'
import { bootChat, teardownChat, type ChatBoot } from './chat-harness'

let chat: ChatBoot | undefined
afterEach(async () => {
  await teardownChat(chat)
  chat = undefined
})

async function working(boot: ChatBoot) {
  const session = await boot.create('start')
  await waitFor(() => boot.world.statusLog.some((entry) => entry.status === 'working'))
  return session
}

describe('create with a permission mode', () => {
  test('hands the mode to the runner and keeps it out of the launch record', async () => {
    chat = await bootChat()
    await chat.call('quirky.structured/create', { worktree: 'main', agent: 'claude', prompt: 'go', permissionMode: 'plan' })
    await waitFor(() => chat!.runner?.startOptions.length === 1)
    expect(chat.runner.startOptions[0]).toMatchObject({ permissionMode: 'plan' })
    expect(chat.world.resolveLaunchCalls).toEqual([])
    expect(chat.world.registerCalls[0]).not.toHaveProperty('launchSettings')
  })

  test('no mode starts the runner without one', async () => {
    chat = await bootChat()
    await chat.create('go')
    await waitFor(() => chat!.runner?.startOptions.length === 1)
    expect(chat.runner.startOptions[0]).not.toHaveProperty('permissionMode')
  })

  test('a mode the agent does not offer is refused before anything is registered', async () => {
    chat = await bootChat()
    const unknown = await chat.failure(chat.call('quirky.structured/create', { worktree: 'main', agent: 'claude', prompt: 'x', permissionMode: 'bypassPermissions' }))
    expect(unknown.code).toBe(RpcErrorCode.InvalidParams)
    expect(unknown.message).toContain('permissionMode must be one of default, acceptEdits, auto, plan')
    const codex = await chat.failure(chat.call('quirky.structured/create', { worktree: 'main', agent: 'codex', prompt: 'x', permissionMode: 'plan' }))
    expect(codex.code).toBe(RpcErrorCode.InvalidParams)
    expect(codex.message).toContain('Codex runs with on-request approval in Quirky')
    expect((await chat.failure(chat.call('quirky.structured/create', { worktree: 'main', agent: 'claude', prompt: 'x', permissionMode: 3 }))).code).toBe(RpcErrorCode.InvalidParams)
    expect(chat.world.registerCalls).toEqual([])
  })
})

describe('configure', () => {
  test('takes a permission mode and reports it back', async () => {
    chat = await bootChat()
    const session = await working(chat)
    expect(await chat.call('quirky.structured/configure', { session: session.id, permissionMode: 'plan' })).toEqual({ ok: true, settings: { permissionMode: 'plan' } })
    expect(chat.runner.configured).toEqual([{ sessionId: session.id, settings: { permissionMode: 'plan' } }])
  })

  test('planMode is no longer a setting', async () => {
    chat = await bootChat()
    const session = await working(chat)
    const error = await chat.failure(chat.call('quirky.structured/configure', { session: session.id, planMode: true }))
    expect(error.code).toBe(RpcErrorCode.InvalidParams)
    expect(error.message).toContain('planMode')
    expect(chat.runner.configured).toEqual([])
  })

  test('auto is refused while the runner reports it unavailable', async () => {
    chat = await bootChat()
    const session = await working(chat)
    chat.runner.autoOffered = false
    const error = await chat.failure(chat.call('quirky.structured/configure', { session: session.id, permissionMode: 'auto' }))
    expect(error.code).toBe(RpcErrorCode.Conflict)
    expect(error.message).toBe('auto mode is not available')
    expect(chat.runner.configured).toEqual([])
    chat.runner.autoOffered = true
    expect(await chat.call('quirky.structured/configure', { session: session.id, permissionMode: 'auto' })).toMatchObject({ ok: true })
  })

  test('a mode outside the capability list is invalid', async () => {
    chat = await bootChat()
    const session = await working(chat)
    expect((await chat.failure(chat.call('quirky.structured/configure', { session: session.id, permissionMode: 'bypassPermissions' }))).code).toBe(RpcErrorCode.InvalidParams)
  })
})

describe('send while a plan waits', () => {
  const queued = (boot: ChatBoot, session: string) => boot.call('quirky.structured/queue', { session }) as Promise<QueuedMessage[]>

  for (const when of ['idle', 'now'] as const) {
    test(`when ${when} the text becomes feedback: journaled, not sent, not queued`, async () => {
      chat = await bootChat()
      const session = await working(chat)
      chat.runner.waitingPlans.add(session.id)
      expect(await chat.call('quirky.structured/send', { session: session.id, text: 'Split step 2', when })).toEqual({ ok: true })
      expect(chat.runner.feedback).toEqual([{ sessionId: session.id, text: 'Split step 2' }])
      expect(chat.runner.sent).toEqual([])
      expect(await queued(chat, session.id)).toEqual([])
      const items = (await chat.messages(session.id)).map((message) => message.item)
      expect(items).toContainEqual({ kind: 'user', text: 'Split step 2' })
    })
  }

  test('without a waiting plan a send goes through as usual', async () => {
    chat = await bootChat()
    const session = await working(chat)
    await chat.call('quirky.structured/send', { session: session.id, text: 'hello' })
    expect(chat.runner.sent.map((sent) => sent.text)).toEqual(['hello'])
    expect(chat.runner.feedback).toEqual([])
  })

  test('a receipt key completes once and a replay does not send feedback twice', async () => {
    chat = await bootChat()
    const session = await working(chat)
    chat.runner.waitingPlans.add(session.id)
    const params = { session: session.id, text: 'once', operationId: 'op-1' }
    expect(await chat.call('quirky.structured/send', params)).toEqual({ ok: true })
    expect(await chat.call('quirky.structured/send', params)).toEqual({ ok: true })
    expect(chat.runner.feedback).toHaveLength(1)
  })

  test('a guarded send still refuses while the plan waits, because the session is waiting', async () => {
    chat = await bootChat()
    const session = await working(chat)
    chat.runner.waitingPlans.add(session.id)
    chat.runner.context.setStatus(session.id, 'waiting')
    await waitFor(() => chat!.world.statusLog.at(-1)?.status === 'waiting')
    const error = await chat.failure(chat.call('quirky.structured/send', { session: session.id, text: 'x', requireIdle: true }))
    expect(error.code).toBe(RpcErrorCode.Conflict)
    expect(error.message).toContain('agent-busy')
    expect(chat.runner.feedback).toEqual([])
  })

  test('images are refused on feedback and the plan keeps waiting', async () => {
    chat = await bootChat()
    const session = await working(chat)
    chat.runner.waitingPlans.add(session.id)
    const dir = mkdtempSync(join(tmpdir(), 'plan-img-'))
    const image = join(dir, 'a.png')
    writeFileSync(image, 'PNG')
    const error = await chat.failure(chat.call('quirky.structured/send', { session: session.id, text: 'look', images: [image] }))
    expect(error.code).toBe(RpcErrorCode.InvalidParams)
    expect(error.message).toBe("images can't be sent as plan feedback")
    expect(chat.runner.feedback).toEqual([])
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('silent asks', () => {
  const spec: AskSpec = { questions: [{ id: 'decision', type: 'select', question: 'Plan?', options: [{ value: 'keep', label: 'Keep' }] }] }
  const askItems = async (boot: ChatBoot, session: string) => (await boot.messages(session)).filter((message) => message.item?.kind === 'ask')

  test('a silent ask still exists but journals no ask item, and reports its id', async () => {
    chat = await bootChat()
    const session = await working(chat)
    let askId: string | undefined
    const pending = chat.runner.context.createAsk(spec, session.id, { silent: true, onAsk: (id) => (askId = id) })
    const ask = await waitForAsync(async () => ((await chat!.call('quirky.ask/list', { pendingOnly: true })) as any[])[0])
    expect(askId).toBe(ask.id)
    expect(await askItems(chat, session.id)).toEqual([])
    await chat.runner.context.cancelAsk(ask.id)
    expect((await pending).status).toBe('declined')
  })

  test('an ordinary ask still journals its ask item', async () => {
    chat = await bootChat()
    const session = await working(chat)
    const pending = chat.runner.context.createAsk(spec, session.id)
    const ask = await waitForAsync(async () => ((await chat!.call('quirky.ask/list', { pendingOnly: true })) as any[])[0])
    expect((await askItems(chat, session.id)).map((message) => message.item)).toEqual([{ kind: 'ask', askId: ask.id, variant: 'approval' }])
    await chat.runner.context.cancelAsk(ask.id)
    await pending
  })
})
