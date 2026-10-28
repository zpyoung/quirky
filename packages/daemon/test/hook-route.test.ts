import { afterEach, describe, expect, test } from 'bun:test'
import { HOOK_TOKEN_HEADER, type QuirkyEvent } from '@quirky/protocol'
import type { Core } from '../src/service'
import { startServer } from '../src/server'
import { FileResourceRegistry } from '../src/file-resources'

const TOKEN = 'hook-token'

let stop: (() => void) | null = null
afterEach(() => {
  stop?.()
  stop = null
})

function start() {
  const delivered: QuirkyEvent[] = []
  const core = {
    hookToken: TOKEN,
    deliverToPlugins: (event: QuirkyEvent) => delivered.push(event)
  } as unknown as Core
  const server = startServer({
    core,
    handle: async () => {},
    port: 0,
    rpcToken: 'rpc-token',
    daemonVersion: 'test',
    uiDir: '/nonexistent',
    pluginFile: () => null,
    fileResources: new FileResourceRegistry(),
    log: () => {}
  })
  stop = () => void server.stop(true)
  return {
    delivered,
    post(query: string, body: string = '{}', token: string | null = TOKEN) {
      return fetch(`http://127.0.0.1:${server.port}/hook/claude?${query}`, {
        method: 'POST',
        body,
        headers: token === null ? {} : { [HOOK_TOKEN_HEADER]: token }
      })
    }
  }
}

describe('hook route agent identity', () => {
  test('pid, pstart and event pass through to hook.received', async () => {
    const { post, delivered } = start()
    const response = await post(`session=s_1&pid=4242&pstart=${encodeURIComponent('Mon Oct 26 10:00:00 2026')}&event=PreToolUse`)
    expect(response.status).toBe(200)
    expect(delivered).toEqual([
      {
        type: 'hook.received',
        agent: 'claude',
        sessionId: 's_1',
        payload: {},
        agentPid: 4242,
        agentStart: 'Mon Oct 26 10:00:00 2026',
        event: 'PreToolUse'
      }
    ])
  })

  test('absent params leave the event as it was', async () => {
    const { post, delivered } = start()
    await post('session=s_1')
    expect(delivered).toEqual([{ type: 'hook.received', agent: 'claude', sessionId: 's_1', payload: {} }])
    expect('agentPid' in delivered[0]!).toBe(false)
  })

  test('malformed values are dropped and the hook is still accepted', async () => {
    const { post, delivered } = start()
    const long = 'x'.repeat(65)
    const cases = [
      'pid=12ab&pstart=ok&event=Stop',
      'pid=-5&event=a%20b',
      'pid=&pstart=&event=',
      `pid=1&pstart=${long}&event=${long}`,
      `pid=1&pstart=${encodeURIComponent('tab\there')}&event=${encodeURIComponent('bad/event')}`
    ]
    for (const query of cases) expect((await post(`session=s_1&${query}`)).status).toBe(200)
    const [first, second, third, fourth, fifth] = delivered as Array<Record<string, unknown>>
    expect(first).toMatchObject({ agentStart: 'ok', event: 'Stop' })
    expect('agentPid' in first!).toBe(false)
    expect(second).not.toHaveProperty('agentPid')
    expect(second).not.toHaveProperty('event')
    expect(third).not.toHaveProperty('agentPid')
    expect(third).not.toHaveProperty('agentStart')
    expect(third).not.toHaveProperty('event')
    expect(fourth).toMatchObject({ agentPid: 1 })
    expect(fourth).not.toHaveProperty('agentStart')
    expect(fourth).not.toHaveProperty('event')
    expect(fifth).toMatchObject({ agentPid: 1 })
    expect(fifth).not.toHaveProperty('agentStart')
    expect(fifth).not.toHaveProperty('event')
  })

  test('existing answers are unchanged: 401 without the token, 400 without a session, 400 for a bad body', async () => {
    const { post, delivered } = start()
    expect((await post('session=s_1&pid=1', '{}', null)).status).toBe(401)
    expect((await post('pid=1')).status).toBe(400)
    expect((await post('session=s_1&pid=1', 'not json')).status).toBe(400)
    expect(delivered).toEqual([])
  })
})
