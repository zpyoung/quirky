import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HandlerContext } from '../dispatch'
import type { RuntimeClient } from '../runtime/client'
import { ADMIN_HANDLERS } from './admin'

const PUBLIC_OPTIONS = { publicContract: true, confirm: false, caller: undefined }

function envelope(result: unknown) {
  return { id: 'req-1', ok: true, result, _meta: { runtimeId: 'runtime-1' } }
}

type FakeClient = { call: ReturnType<typeof vi.fn>; isRemote: boolean }

function fakeClient(result: unknown = { settings: {} }, isRemote = false): FakeClient {
  return { call: vi.fn(async () => envelope(result)), isRemote }
}

function contextFor(
  client: FakeClient,
  flags: Record<string, string | boolean>,
  json = true
): HandlerContext {
  // SAFETY: the handlers under test touch only call and isRemote on the client
  const asClient = client as unknown as RuntimeClient
  return { flags: new Map(Object.entries(flags)), cwd: '/', json, client: asClient, rawArgs: [] }
}

describe('admin handlers', () => {
  let logSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    for (const key of [
      'QUIRKY_CALLER_ROLE',
      'QUIRKY_AGENT_SESSION_ID',
      'QUIRKY_WORKTREE_ID',
      'QUIRKY_TERMINAL_HANDLE'
    ]) {
      vi.stubEnv(key, '')
    }
  })

  afterEach(() => {
    logSpy.mockRestore()
    vi.unstubAllEnvs()
  })

  function printed(): string {
    return logSpy.mock.calls.map((call) => String(call[0])).join('\n')
  }

  describe('settings set', () => {
    it.each<[string, unknown]>([
      ['true', true],
      ['3', 3],
      ['null', null],
      ['["a","b"]', ['a', 'b']],
      ['{"A":"1"}', { A: '1' }],
      ['build box', 'build box'],
      ['', '']
    ])('sends %j as %j', async (raw, expected) => {
      const client = fakeClient()
      await ADMIN_HANDLERS['settings set'](contextFor(client, { key: 'machineName', value: raw }))
      expect(client.call).toHaveBeenCalledWith(
        'settings.update',
        { machineName: expected },
        PUBLIC_OPTIONS
      )
    })

    it('forwards --yes as confirm', async () => {
      const client = fakeClient()
      await ADMIN_HANDLERS['settings set'](
        contextFor(client, { key: 'agentStatusHooksEnabled', value: 'true', yes: true })
      )
      expect(client.call).toHaveBeenCalledWith(
        'settings.update',
        { agentStatusHooksEnabled: true },
        { ...PUBLIC_OPTIONS, confirm: true }
      )
    })

    it('rejects an unknown key with invalid_argument and lists the valid keys', async () => {
      const client = fakeClient()
      const attempt = ADMIN_HANDLERS['settings set'](
        contextFor(client, { key: 'notASetting', value: '1' })
      )
      await expect(attempt).rejects.toMatchObject({
        code: 'invalid_argument',
        message: expect.stringContaining('notASetting')
      })
      await expect(attempt).rejects.toThrow(/machineName.*nativeChatPermissionMode/)
      expect(client.call).not.toHaveBeenCalled()
    })

    it('does not accept an inherited object property as a key', async () => {
      const client = fakeClient()
      await expect(
        ADMIN_HANDLERS['settings set'](contextFor(client, { key: 'toString', value: '1' }))
      ).rejects.toMatchObject({ code: 'invalid_argument' })
      expect(client.call).not.toHaveBeenCalled()
    })

    it('sends a security setting to a remote runtime for the server approval policy to decide', async () => {
      const client = fakeClient({ settings: {} }, true)
      await ADMIN_HANDLERS['settings set'](
        contextFor(client, { key: 'agentDefaultEnv', value: '{"A":"1"}' })
      )
      expect(client.call).toHaveBeenCalledWith(
        'settings.update',
        { agentDefaultEnv: { A: '1' } },
        PUBLIC_OPTIONS
      )
    })

    it('sends an ordinary setting to a remote runtime without --yes', async () => {
      const client = fakeClient({ settings: {} }, true)
      await ADMIN_HANDLERS['settings set'](
        contextFor(client, { key: 'compactWorktreeCards', value: 'true' })
      )
      expect(client.call).toHaveBeenCalledTimes(1)
    })

    it('prints the stored value', async () => {
      const client = fakeClient({ settings: { machineName: 'build box' } })
      await ADMIN_HANDLERS['settings set'](
        contextFor(client, { key: 'machineName', value: 'build box' }, false)
      )
      expect(printed()).toBe('machineName: build box')
    })
  })

  describe('settings list and get', () => {
    const settings = { machineName: 'box', compactWorktreeCards: true, agentDefaultEnv: { A: '1' } }

    it('prints sorted key: value lines', async () => {
      const client = fakeClient({ settings })
      await ADMIN_HANDLERS['settings list'](contextFor(client, {}, false))
      expect(client.call).toHaveBeenCalledWith('settings.get', undefined, PUBLIC_OPTIONS)
      expect(printed()).toBe(
        ['agentDefaultEnv: {"A":"1"}', 'compactWorktreeCards: true', 'machineName: box'].join('\n')
      )
    })

    it('narrows settings get to one key on the client', async () => {
      const client = fakeClient({ settings })
      await ADMIN_HANDLERS['settings get'](contextFor(client, { key: 'machineName' }))
      expect(JSON.parse(printed()).result).toEqual({ settings: { machineName: 'box' } })
    })

    it('reports not_found for a key the settings do not hold', async () => {
      const client = fakeClient({ settings })
      await expect(
        ADMIN_HANDLERS['settings get'](contextFor(client, { key: 'missing' }))
      ).rejects.toMatchObject({ code: 'not_found' })
    })
  })

  describe('plugins enable and disable', () => {
    it.each([
      ['plugins enable', true],
      ['plugins disable', false]
    ])('%s sends enabled=%s to plugins.setEnabled', async (command, enabled) => {
      const client = fakeClient([])
      await ADMIN_HANDLERS[command](contextFor(client, { key: 'quirky:example' }))
      expect(client.call).toHaveBeenCalledWith(
        'plugins.setEnabled',
        { pluginKey: 'quirky:example', enabled },
        PUBLIC_OPTIONS
      )
    })
  })

  describe('notifications', () => {
    it('lists from sequence 0 by default', async () => {
      const client = fakeClient({ notifications: [], epoch: 'e1' })
      await ADMIN_HANDLERS['notifications list'](contextFor(client, {}))
      expect(client.call).toHaveBeenCalledWith(
        'notifications.getMissedSince',
        { lastSeenSeq: 0 },
        PUBLIC_OPTIONS
      )
    })

    it('lists from --last-seen-seq', async () => {
      const client = fakeClient({ notifications: [], epoch: 'e1' })
      await ADMIN_HANDLERS['notifications list'](contextFor(client, { 'last-seen-seq': '12' }))
      expect(client.call).toHaveBeenCalledWith(
        'notifications.getMissedSince',
        { lastSeenSeq: 12 },
        PUBLIC_OPTIONS
      )
    })

    it('prints one line per notification', async () => {
      const client = fakeClient({
        notifications: [
          {
            type: 'notification',
            notificationSeq: 7,
            notificationId: 'n-7',
            title: 'Done',
            body: 'ok'
          }
        ],
        epoch: 'e1'
      })
      await ADMIN_HANDLERS['notifications list'](contextFor(client, {}, false))
      expect(printed()).toBe('7  n-7  Done - ok')
    })

    it('dismisses by id through notifications.dismiss', async () => {
      const client = fakeClient({ dismissed: true, id: 'n-7' })
      await ADMIN_HANDLERS['notifications dismiss'](contextFor(client, { id: 'n-7' }))
      expect(client.call).toHaveBeenCalledWith(
        'notifications.dismiss',
        { id: 'n-7' },
        PUBLIC_OPTIONS
      )
    })
  })
})
