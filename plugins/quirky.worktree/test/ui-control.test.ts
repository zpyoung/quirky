import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import type { UiPluginContext } from '@quirky/protocol'
import {
  dispatchUiControl,
  requestUiControl,
  registerUiController,
  UI_CONTROL_ACTIONS,
  UI_CONTROL_COMMAND,
  type UiControlArgs,
  type UiControlTarget
} from '../src/ui-control'

const INVALID_ARGS_MESSAGE = 'Worktree UI control needs a known action and its target.'
const INVALID_RESULT_MESSAGE = 'The window returned no UI control result.'

type CallRecord = { method: string; params: Record<string, unknown> }
type ContextCall = (method: string, params: Record<string, unknown>) => Promise<unknown>

function emptyContext(): UiPluginContext {
  return {} as unknown as UiPluginContext
}

function contextWith(call: ContextCall, executeCommand: () => unknown = () => {
  throw new Error('executeCommand must not be used')
}): UiPluginContext {
  return { call, executeCommand } as unknown as UiPluginContext
}

function expectInvalidArgs(context: UiPluginContext, args: unknown): void {
  let failure: unknown
  try {
    dispatchUiControl(context, args)
  } catch (error) {
    failure = error
  }
  expect(failure).toBeInstanceOf(Error)
  expect((failure as Error).message).toBe(INVALID_ARGS_MESSAGE)
}

async function captureRejection(operation: () => Promise<unknown>): Promise<unknown> {
  try {
    await operation()
  } catch (error) {
    return error
  }
  return undefined
}

describe('Worktree UI control command', () => {
  test('scenario 1: declares the hidden command and its exact argument schema', () => {
    const manifest = JSON.parse(readFileSync(join(import.meta.dir, '../quirky-plugin.json'), 'utf8')) as {
      contributes: { command: Array<{ id: string } & Record<string, unknown>> }
    }
    const command = manifest.contributes.command.find((entry) => entry.id === 'uiControl')

    expect(command).toEqual({
      id: 'uiControl',
      title: 'Worktree UI Control',
      description: 'Open or close the row menu of a remote workspace or VM listed by quirky worktree remote-list or vm-list, or add or unlink a draft reference in the open Worktree details dialog of a worktree listed by quirky worktree list. Returns how many mounted targets received it.',
      palette: false,
      args: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['open-workspace-menu', 'close-workspace-menu', 'open-vm-menu', 'close-vm-menu', 'add-reference', 'unlink-reference', 'control']
          },
          workspace: { type: 'string' },
          vm: { type: 'string' },
          worktree: { type: 'string' },
          url: { type: 'string' },
          label: { type: 'string' },
          scope: { type: 'string' },
          target: { type: 'string' },
          operation: { type: 'string' },
          payload: { type: 'object', additionalProperties: true }
        },
        required: ['action'],
        additionalProperties: false
      }
    })
    expect(UI_CONTROL_ACTIONS).toEqual([
      'open-workspace-menu',
      'close-workspace-menu',
      'open-vm-menu',
      'close-vm-menu',
      'add-reference',
      'unlink-reference'
    ])
    expect(UI_CONTROL_COMMAND).toBe('command:quirky.worktree/uiControl')
  })

  test('scenario 2: routes every action only to its target kind', () => {
    const context = emptyContext()
    const delivered: Record<UiControlTarget, UiControlArgs[]> = {
      'remote-workspaces': [],
      'vm-environments': [],
      'worktree-details': []
    }
    for (const target of Object.keys(delivered) as UiControlTarget[]) {
      registerUiController(context, target, (args) => {
        delivered[target].push(args)
        return true
      })
    }

    const cases: Array<{ target: UiControlTarget; args: UiControlArgs }> = [
      { target: 'remote-workspaces', args: { action: 'open-workspace-menu', workspace: 'rw-1' } },
      { target: 'remote-workspaces', args: { action: 'close-workspace-menu', workspace: 'rw-1' } },
      { target: 'vm-environments', args: { action: 'open-vm-menu', vm: 'vm-1' } },
      { target: 'vm-environments', args: { action: 'close-vm-menu', vm: 'vm-1' } },
      { target: 'worktree-details', args: { action: 'add-reference', worktree: 'w-1', url: 'https://example.com/task', label: 'Task' } },
      { target: 'worktree-details', args: { action: 'unlink-reference', worktree: 'w-1', url: 'https://example.com/task' } }
    ]

    for (const { target, args } of cases) {
      for (const calls of Object.values(delivered)) calls.length = 0
      expect(dispatchUiControl(context, args)).toEqual({ ...args, delivered: 1 })
      for (const candidate of Object.keys(delivered) as UiControlTarget[]) {
        expect(delivered[candidate]).toEqual(candidate === target ? [args] : [])
      }
    }
  })

  test('scenario 3: counts only handlers that accept the action', () => {
    const context = emptyContext()
    const calls: UiControlArgs[] = []
    registerUiController(context, 'remote-workspaces', (args) => {
      calls.push(args)
      return false
    })

    expect(dispatchUiControl(context, { action: 'open-workspace-menu', workspace: 'rw-1' })).toEqual({
      action: 'open-workspace-menu',
      workspace: 'rw-1',
      delivered: 0
    })
    expect(calls).toEqual([{ action: 'open-workspace-menu', workspace: 'rw-1' }])
  })

  test('scenario 4: supports multiple mounts and removes only the cleaned-up handler', () => {
    const context = emptyContext()
    const firstCalls: UiControlArgs[] = []
    const secondCalls: UiControlArgs[] = []
    const cleanupFirst = registerUiController(context, 'remote-workspaces', (args) => {
      firstCalls.push(args)
      return true
    })
    registerUiController(context, 'remote-workspaces', (args) => {
      secondCalls.push(args)
      return true
    })
    const args: UiControlArgs = { action: 'open-workspace-menu', workspace: 'rw-1' }

    expect(dispatchUiControl(context, args).delivered).toBe(2)
    cleanupFirst()
    expect(dispatchUiControl(context, args).delivered).toBe(1)
    expect(firstCalls).toEqual([args])
    expect(secondCalls).toEqual([args, args])
  })

  test('scenario 5: keeps controller registries isolated by context', () => {
    const contextX = emptyContext()
    const contextY = emptyContext()
    const calls: UiControlArgs[] = []
    registerUiController(contextX, 'remote-workspaces', (args) => {
      calls.push(args)
      return true
    })

    expect(dispatchUiControl(contextY, { action: 'open-workspace-menu', workspace: 'rw-1' })).toEqual({
      action: 'open-workspace-menu',
      workspace: 'rw-1',
      delivered: 0
    })
    expect(calls).toEqual([])
  })

  test('scenario 6: rejects malformed payloads with one exact error before dispatching', () => {
    const context = emptyContext()
    const calls: UiControlArgs[] = []
    registerUiController(context, 'remote-workspaces', (args) => {
      calls.push(args)
      return true
    })
    registerUiController(context, 'vm-environments', (args) => {
      calls.push(args)
      return true
    })
    registerUiController(context, 'worktree-details', (args) => {
      calls.push(args)
      return true
    })

    const malformed: unknown[] = [
      undefined,
      null,
      'open-vm-menu',
      {},
      { action: 'explode', vm: 'v' },
      { action: 'open-vm-menu' },
      { action: 'open-vm-menu', vm: '' },
      { action: 'open-vm-menu', vm: 7 },
      { action: 'open-workspace-menu', vm: 'v' },
      { action: 'add-reference', worktree: 'w2' },
      { action: 'add-reference', worktree: 'w2', url: '   ' },
      { action: 'add-reference', worktree: 'w2', url: 'u', label: 3 },
      { action: 'unlink-reference', url: 'u' }
    ]

    for (const args of malformed) expectInvalidArgs(context, args)
    expect(calls).toEqual([])
  })

  test('scenario 7: strips extra fields and normalizes optional reference labels', () => {
    const context = emptyContext()
    const calls: UiControlArgs[] = []
    registerUiController(context, 'worktree-details', (args) => {
      calls.push(args)
      return true
    })

    const unlink = dispatchUiControl(context, {
      action: 'unlink-reference',
      worktree: 'w2',
      url: 'https://a',
      vm: 'x',
      extra: 1
    })
    const add = dispatchUiControl(context, { action: 'add-reference', worktree: 'w2', url: ' https://b ' })

    expect(calls).toEqual([
      { action: 'unlink-reference', worktree: 'w2', url: 'https://a' },
      { action: 'add-reference', worktree: 'w2', url: ' https://b ', label: '' }
    ])
    expect(unlink).toEqual({ action: 'unlink-reference', worktree: 'w2', url: 'https://a', delivered: 1 })
    expect(add).toEqual({ action: 'add-reference', worktree: 'w2', url: ' https://b ', label: '', delivered: 1 })
  })

  test('scenario 8: routes each request to the calling window without executeCommand', async () => {
    const connections = new Map<number, UiPluginContext>()
    const callsA: CallRecord[] = []
    const callsB: CallRecord[] = []
    const executed: number[] = []
    const makeWindow = (connId: number, calls: CallRecord[]): UiPluginContext => {
      const context = contextWith(async (method, params) => {
        calls.push({ method, params })
        if (method === 'ui.window.self') return { connId }
        if (method === 'ui.window.command.run') {
          const target = connections.get(params.connId as number)
          if (!target) throw new Error(`no live UI window ${String(params.connId)}`)
          return { result: dispatchUiControl(target, params.args) }
        }
        throw new Error(`Unexpected method ${method}`)
      }, () => {
        executed.push(connId)
        throw new Error('executeCommand must not be used')
      })
      connections.set(connId, context)
      return context
    }
    const contextA = makeWindow(7, callsA)
    const contextB = makeWindow(9, callsB)
    const handlerCallsA: UiControlArgs[] = []
    const handlerCallsB: UiControlArgs[] = []
    registerUiController(contextA, 'vm-environments', (args) => {
      handlerCallsA.push(args)
      return true
    })
    registerUiController(contextB, 'vm-environments', (args) => {
      handlerCallsB.push(args)
      return true
    })
    const args: UiControlArgs = { action: 'open-vm-menu', vm: 'vm-1' }

    expect(await requestUiControl(contextA, args)).toEqual({ ...args, delivered: 1 })
    expect(callsA.filter((call) => call.method === 'ui.window.command.run')).toEqual([{
      method: 'ui.window.command.run',
      params: { connId: 7, id: UI_CONTROL_COMMAND, args }
    }])
    expect(handlerCallsA).toEqual([args])
    expect(handlerCallsB).toEqual([])

    expect(await requestUiControl(contextB, args)).toEqual({ ...args, delivered: 1 })
    expect(callsB.filter((call) => call.method === 'ui.window.command.run')).toEqual([{
      method: 'ui.window.command.run',
      params: { connId: 9, id: UI_CONTROL_COMMAND, args }
    }])
    expect(handlerCallsA).toEqual([args])
    expect(handlerCallsB).toEqual([args])
    expect(executed).toEqual([])
  })

  test('scenario 8: rejects invalid self identity without sending a window command', async () => {
    const calls: CallRecord[] = []
    const context = contextWith(async (method, params) => {
      calls.push({ method, params })
      if (method === 'ui.window.self') return {}
      throw new Error(`Unexpected method ${method}`)
    })
    const failure = await captureRejection(() => requestUiControl(context, { action: 'open-vm-menu', vm: 'vm-1' }))

    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toBe('ui.window.self returned an invalid connection identity.')
    expect(calls.filter((call) => call.method === 'ui.window.command.run')).toEqual([])
  })

  test('scenario 8: preserves rejected daemon calls and rejects malformed results', async () => {
    const routeFailure = new Error('no live UI window 7')
    const rejectedRoute = contextWith(async (method) => {
      if (method === 'ui.window.self') return { connId: 7 }
      if (method === 'ui.window.command.run') throw routeFailure
      throw new Error(`Unexpected method ${method}`)
    })
    expect(await captureRejection(() => requestUiControl(rejectedRoute, { action: 'open-vm-menu', vm: 'vm-1' }))).toBe(routeFailure)

    for (const result of [null, { action: 'open-vm-menu' }]) {
      const invalidReply = contextWith(async (method) => {
        if (method === 'ui.window.self') return { connId: 7 }
        if (method === 'ui.window.command.run') return { result }
        throw new Error(`Unexpected method ${method}`)
      })
      const failure = await captureRejection(() => requestUiControl(invalidReply, { action: 'open-vm-menu', vm: 'vm-1' }))
      expect(failure).toBeInstanceOf(Error)
      expect((failure as Error).message).toBe(INVALID_RESULT_MESSAGE)
    }
  })
})
