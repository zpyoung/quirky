import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HandlerContext } from '../dispatch'
import type { RuntimeClient } from '../runtime/client'
import { UI_ACTION_HANDLERS } from './ui-actions'

const UI_STATE = {
  worktreeId: 'wt-1',
  view: 'terminal',
  tab: { id: 'tab-1', type: 'terminal', title: 'zsh' },
  paneId: null,
  panels: {
    leftSidebar: true,
    rightSidebar: { open: false, tab: null },
    floatingTerminal: false
  },
  editorFile: null
}

const READY = { type: 'ready', subscriptionId: 'sub-1', cursor: 3 }

const UI_EVENT = {
  seq: 4,
  at: 1000,
  topic: 'ui',
  type: 'tab.opened',
  data: { worktreeId: 'wt-1', tabId: 'tab-2' }
}

function envelope(result: unknown) {
  return { id: 'req-1', ok: true, result, _meta: { runtimeId: 'runtime-1' } }
}

type FakeClient = {
  call: ReturnType<typeof vi.fn>
  stream: ReturnType<typeof vi.fn<RuntimeClient['stream']>>
  isRemote: boolean
}

function contextFor(
  client: FakeClient,
  flags: Record<string, string | boolean>,
  json = true
): HandlerContext {
  // SAFETY: the handlers under test touch only call, stream and isRemote on the client
  const asClient = client as unknown as RuntimeClient
  return { flags: new Map(Object.entries(flags)), cwd: '/', json, client: asClient, rawArgs: [] }
}

/** A stream that delivers `frames` after it opens, then stays open until the caller aborts. */
function openStream(frames: unknown[]) {
  return vi.fn<RuntimeClient['stream']>(async (_method, _params, onFrame, options) => {
    for (const frame of frames) {
      onFrame(frame)
      await Promise.resolve()
    }
    await new Promise<void>((resolve) => {
      if (options?.signal?.aborted) {
        resolve()
        return
      }
      options?.signal?.addEventListener('abort', () => resolve(), { once: true })
    })
  })
}

function fakeClient(overrides: Partial<FakeClient> = {}): FakeClient {
  const call = vi.fn(async (method: string) => {
    if (method === 'ui.state') {
      return envelope(UI_STATE)
    }
    if (method === 'ui.listActions') {
      return envelope({
        actions: [{ id: 'view.tasks', description: 'Open tasks', available: true }]
      })
    }
    return envelope({ claimed: true })
  })
  return { call, stream: openStream([]), isRemote: false, ...overrides }
}

const CALLER_ENV = [
  'QUIRKY_CALLER_ROLE',
  'QUIRKY_AGENT_SESSION_ID',
  'QUIRKY_WORKTREE_ID',
  'QUIRKY_TERMINAL_HANDLE'
]

describe('ui and action handlers', () => {
  let logSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    for (const key of CALLER_ENV) {
      vi.stubEnv(key, '')
    }
  })

  afterEach(() => {
    logSpy.mockRestore()
    vi.unstubAllEnvs()
    vi.useRealTimers()
  })

  function printed(): string {
    return logSpy.mock.calls.map((call) => String(call[0])).join('\n')
  }

  describe('ui state', () => {
    it('calls ui.state with the public contract and prints the snapshot', async () => {
      const client = fakeClient()
      await UI_ACTION_HANDLERS['ui state'](contextFor(client, {}, false))
      expect(client.call).toHaveBeenCalledWith('ui.state', undefined, {
        publicContract: true,
        confirm: false,
        caller: undefined
      })
      expect(printed()).toContain('worktree: wt-1')
      expect(printed()).toContain('tab: terminal tab-1 zsh')
    })
  })

  describe('action list', () => {
    it('sends only the filters that were given', async () => {
      const client = fakeClient()
      await UI_ACTION_HANDLERS['action list'](contextFor(client, { available: true }))
      expect(client.call).toHaveBeenCalledWith(
        'ui.listActions',
        { available: true },
        expect.objectContaining({ publicContract: true })
      )
    })

    it('passes --workspace through as the workspace param', async () => {
      const client = fakeClient()
      await UI_ACTION_HANDLERS['action list'](contextFor(client, { workspace: 'id:repo::/work' }))
      expect(client.call).toHaveBeenCalledWith(
        'ui.listActions',
        { workspace: 'id:repo::/work' },
        expect.anything()
      )
    })
  })

  describe('action run', () => {
    it('sends publicContract, confirm from --yes and the caller hint', async () => {
      vi.stubEnv('QUIRKY_AGENT_SESSION_ID', 'session-9')
      const client = fakeClient()
      await UI_ACTION_HANDLERS['action run'](
        contextFor(client, { id: 'view.tasks', workspace: 'id:repo::/work', yes: true })
      )
      expect(client.call).toHaveBeenCalledWith(
        'ui.runAction',
        { actionId: 'view.tasks', workspace: 'id:repo::/work' },
        { publicContract: true, confirm: true, caller: { agentSessionId: 'session-9' } }
      )
    })

    it('does not confirm without --yes', async () => {
      const client = fakeClient()
      await UI_ACTION_HANDLERS['action run'](contextFor(client, { id: 'view.tasks' }))
      expect(client.call).toHaveBeenCalledWith(
        'ui.runAction',
        { actionId: 'view.tasks' },
        { publicContract: true, confirm: false, caller: undefined }
      )
    })

    it('sends a remote run straight to the server gate, with confirm following --yes', async () => {
      const call = vi.fn(async () => envelope({ claimed: true }))
      const client = fakeClient({ call, isRemote: true })
      await UI_ACTION_HANDLERS['action run'](contextFor(client, { id: 'workspace.delete' }))
      await UI_ACTION_HANDLERS['action run'](
        contextFor(client, { id: 'workspace.delete', yes: true })
      )
      expect(call.mock.calls).toEqual([
        [
          'ui.runAction',
          { actionId: 'workspace.delete' },
          expect.objectContaining({ confirm: false })
        ],
        [
          'ui.runAction',
          { actionId: 'workspace.delete' },
          expect.objectContaining({ confirm: true })
        ]
      ])
    })

    describe('--wait', () => {
      it('returns the next ui event once the action has run', async () => {
        const client = fakeClient({ stream: openStream([READY, UI_EVENT]) })
        await UI_ACTION_HANDLERS['action run'](contextFor(client, { id: 'view.tasks', wait: true }))
        expect(client.stream).toHaveBeenCalledWith(
          'events.subscribe',
          { topics: ['ui'] },
          expect.any(Function),
          expect.objectContaining({ publicContract: true })
        )
        const result = JSON.parse(printed()).result
        expect(result).toMatchObject({ claimed: true, event: { type: 'tab.opened', seq: 4 } })
        expect(client.call).not.toHaveBeenCalledWith(
          'ui.state',
          expect.anything(),
          expect.anything()
        )
      })

      it('prints the current ui state when no event arrives within 2 seconds', async () => {
        vi.useFakeTimers()
        const client = fakeClient({ stream: openStream([READY]) })
        const done = UI_ACTION_HANDLERS['action run'](
          contextFor(client, { id: 'view.tasks', wait: true })
        )
        await vi.advanceTimersByTimeAsync(1999)
        expect(client.call).not.toHaveBeenCalledWith('ui.state', undefined, expect.anything())
        await vi.advanceTimersByTimeAsync(1)
        await done

        expect(client.call).toHaveBeenCalledWith(
          'ui.runAction',
          { actionId: 'view.tasks' },
          expect.anything()
        )
        expect(client.call).toHaveBeenCalledWith('ui.state', undefined, expect.anything())
        const result = JSON.parse(printed()).result
        expect(result).toMatchObject({
          claimed: true,
          state: { worktreeId: 'wt-1', view: 'terminal' }
        })
        expect(result.event).toBeUndefined()
      })

      it('surfaces a failed action instead of waiting for an event', async () => {
        const failure = Object.assign(new Error('no ui'), { code: 'unavailable' })
        const call = vi.fn(async () => {
          throw failure
        })
        const client = fakeClient({ call, stream: openStream([READY]) })
        await expect(
          UI_ACTION_HANDLERS['action run'](contextFor(client, { id: 'view.tasks', wait: true }))
        ).rejects.toBe(failure)
      })
    })
  })

  describe('layout get', () => {
    it('prints the first frame of the layout stream and stops listening', async () => {
      const snapshot = { type: 'snapshot', subscriptionId: 'layout-1', workspaces: [], seq: 1 }
      const stream = openStream([snapshot, { type: 'records', workspaces: [], seq: 2 }])
      const client = fakeClient({ stream })
      await UI_ACTION_HANDLERS['layout get'](contextFor(client, {}))

      expect(stream).toHaveBeenCalledTimes(1)
      expect(stream.mock.calls[0][0]).toBe('layout.subscribe')
      expect(stream.mock.calls[0][3]?.signal?.aborted).toBe(true)
      expect(logSpy).toHaveBeenCalledTimes(1)
      expect(JSON.parse(printed())).toEqual(snapshot)
    })

    it('fails as unavailable when the stream ends without a frame', async () => {
      const client = fakeClient({ stream: vi.fn(async () => {}) })
      await expect(UI_ACTION_HANDLERS['layout get'](contextFor(client, {}))).rejects.toMatchObject({
        code: 'unavailable'
      })
    })
  })
})
