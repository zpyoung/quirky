import { afterEach, expect, test } from 'bun:test'
import { RpcErrorCode, type QuirkyEvent, type WindowRoute } from '@quirky/protocol'
import { bootWindow, closeWindows, installUiPlugin } from './fixtures/window-env'

afterEach(async () => {
  await closeWindows()
  delete (globalThis as { __ran?: unknown }).__ran
})

const GREET = 'command:acme.tools/greet'
const BOOM = 'command:acme.tools/boom'

/** `acme.tools` commands record every run in `globalThis.__ran`, which the headless window shares with the test. */
function writeTools(installed: string): void {
  installUiPlugin(
    installed,
    'acme.tools',
    {
      command: [
        {
          id: 'greet',
          title: 'Greet',
          args: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] }
        },
        { id: 'boom', title: 'Boom' }
      ]
    },
    [
      `context.provide(${JSON.stringify(GREET)}, async (args) => { (globalThis.__ran ??= []).push(args); return 'hello ' + args.name })`,
      `context.provide(${JSON.stringify(BOOM)}, () => { throw new Error('kaboom') })`
    ].join('\n')
  )
}

const ran = () => ((globalThis as { __ran?: unknown[] }).__ran ?? []) as unknown[]

async function failure(call: Promise<unknown>): Promise<{ code: number; message: string }> {
  try {
    await call
  } catch (error) {
    return error as { code: number; message: string }
  }
  throw new Error('expected the call to reject')
}

test('SC-40: ui.command.run runs the command in the window and returns what it returned', async () => {
  const { agent } = await bootWindow(writeTools)
  expect(await agent.callAny('ui.command.run', { id: GREET, args: { name: 'zed' } })).toEqual({ result: 'hello zed' })
  expect(ran()).toEqual([{ name: 'zed' }])
})

test('SC-40: args that miss the declared schema fail before reaching the window', async () => {
  const { agent } = await bootWindow(writeTools)
  const error = await failure(agent.callAny('ui.command.run', { id: GREET, args: {} }))
  expect(error.code).toBe(RpcErrorCode.InvalidParams)
  expect(ran()).toEqual([])
})

test('SC-40: a command whose code throws fails with the thrown message', async () => {
  const { agent } = await bootWindow(writeTools)
  const error = await failure(agent.callAny('ui.command.run', { id: BOOM }))
  expect(error.code).toBe(RpcErrorCode.Conflict)
  expect(error.message).toContain('kaboom')
})

test('SC-40: a command that returns nothing answers with a null result', async () => {
  const { agent } = await bootWindow((installed) =>
    installUiPlugin(installed, 'acme.quiet', { command: [{ id: 'noop', title: 'Noop' }] }, `context.provide('command:acme.quiet/noop', () => {})`)
  )
  expect(await agent.callAny('ui.command.run', { id: 'command:acme.quiet/noop' })).toEqual({ result: null })
})

test('SC-41: with no window open the command fails saying so', async () => {
  const env = await bootWindow(writeTools)
  await env.win.stop()
  // the daemon learns of the closed connection on its own; until then it still routes to it
  const error = await env.win.waitFor(async () => {
    const failed = await failure(env.agent.callAny('ui.command.run', { id: GREET, args: { name: 'zed' } }))
    return failed.message === 'no Quirky window is open' ? failed : null
  })
  expect(error.code).toBe(RpcErrorCode.Conflict)
})

test('SC-41: ambiguous commands refuse and exact routes ignore the latest focus', async () => {
  const env = await bootWindow(writeTools)
  const second = await env.harness.connectWithEvents('ui')
  const firstRoute = (await env.win.connection.callAny('ui.window.self', {})) as WindowRoute
  const secondRoute = (await second.client.call('ui.window.self', {})) as WindowRoute
  const firstConnId = firstRoute.connId
  const secondConnId = secondRoute.connId
  const firstRequests: Extract<QuirkyEvent, { type: 'ui.command.request' }>[] = []
  const unsubscribe = env.win.connection.onEvent((event) => {
    if (event.type === 'ui.command.request') firstRequests.push(event)
  })
  const requests = () => second.events.filter((event: QuirkyEvent) => event.type === 'ui.command.request')

  await second.client.call('ui.window.focused', { focused: true })
  await env.win.waitFor(async () => {
    const state = (await env.agent.callAny('ui.state', {})) as { windows: { connId: number; focused: boolean }[] }
    return (
      state.windows.find((window) => window.connId === firstConnId)?.focused === false &&
      state.windows.find((window) => window.connId === secondConnId)?.focused === true
    )
  })

  const ambiguous = await failure(env.agent.callAny('ui.command.run', { id: GREET, args: { name: 'ambiguous' } }))
  expect(ambiguous.code).toBe(RpcErrorCode.Conflict)
  expect(ran()).toEqual([])
  expect(firstRequests).toEqual([])
  expect(requests()).toEqual([])

  expect(
    await env.agent.callAny('ui.window.command.run', { connId: firstConnId, id: GREET, args: { name: 'first' } })
  ).toEqual({ result: 'hello first' })
  expect(firstRequests).toHaveLength(1)
  expect(firstRequests[0]).toMatchObject({ requestId: expect.any(String), id: GREET, args: { name: 'first' } })
  expect(ran()).toEqual([{ name: 'first' }])
  expect(requests()).toEqual([])
  unsubscribe()

  second.client.close()
  await env.win.waitFor(async () => {
    const state = (await env.agent.callAny('ui.state', {})) as { windows: { connId: number }[] }
    return !state.windows.some((window) => window.connId === secondConnId)
  })
  const stale = await failure(
    env.agent.callAny('ui.window.command.run', { connId: secondConnId, id: GREET, args: { name: 'stale' } })
  )
  expect(stale.code).toBe(RpcErrorCode.Conflict)
  expect(firstRequests).toHaveLength(1)
  expect(ran()).toEqual([{ name: 'first' }])
})

test('the window reports focus when it gains and loses it', async () => {
  const env = await bootWindow(writeTools)
  const focused = async () => {
    const state = (await env.agent.callAny('ui.state', {})) as { windows: { focused: boolean }[] }
    return state.windows[0]!.focused
  }
  expect(await focused()).toBe(false)

  env.win.setFocus(true)
  await env.win.waitFor(focused)
  env.win.setFocus(false)
  await env.win.waitFor(async () => !(await focused()))
})

test('a command the window does not know answers with an error instead of hanging', async () => {
  const env = await bootWindow(writeTools)
  const reply = await env.win.host.runCommandForResult(GREET, { name: 'direct' })
  expect(reply).toBe('hello direct')
  await expect(env.win.host.runCommandForResult('command:acme.tools/missing')).rejects.toThrow('no command command:acme.tools/missing')
})
