import { afterEach, describe, expect, it, vi } from 'vitest'
import { ACTION_CATALOG, isCatalogedActionId } from '../../../shared/keybindings/action-catalog'
import { APP_COMMAND_HANDLER_IDS } from '../app-shell/app-command-handlers'
import {
  dispatchAppCommand,
  dispatchAppCommandWithResult,
  registerAppCommandDispatcher
} from './app-command-dispatch'

vi.mock('../store', () => ({
  useAppStore: Object.assign(vi.fn(), { getState: () => ({}) })
}))

let cleanup: (() => void) | null = null

afterEach(() => cleanup?.())

describe('app command dispatch', () => {
  it('routes known action ids through the current handler registry', () => {
    const dispatcher = vi.fn(() => true)
    cleanup = registerAppCommandDispatcher(dispatcher)

    expect(dispatchAppCommand('view.tasks', 'plugin-palette')).toBe(true)
    expect(dispatcher).toHaveBeenCalledWith('view.tasks', 'plugin-palette')
  })

  it('rejects unknown actions and unregisters only the current dispatcher', () => {
    const staleCleanup = registerAppCommandDispatcher(() => true)
    const current = vi.fn(() => true)
    cleanup = registerAppCommandDispatcher(current)
    staleCleanup()

    expect(dispatchAppCommand('missing.action', 'plugin-keybinding')).toBe(false)
    expect(dispatchAppCommand('view.tasks', 'plugin-keybinding')).toBe(true)
    cleanup()
    cleanup = null
    expect(dispatchAppCommand('view.tasks', 'plugin-keybinding')).toBe(false)
  })

  it('keeps the boolean return for plugin callers when the dispatcher explains a decline', () => {
    cleanup = registerAppCommandDispatcher(() => ({ claimed: false, reason: 'no tab' }))

    expect(dispatchAppCommand('tab.close', 'plugin-palette')).toBe(false)
  })

  describe('dispatchAppCommandWithResult', () => {
    it('passes the rpc source and options to the dispatcher and reports a claim', () => {
      const dispatcher = vi.fn(() => ({ claimed: true }))
      cleanup = registerAppCommandDispatcher(dispatcher)

      expect(
        dispatchAppCommandWithResult('tab.close', 'rpc', {
          worktreeId: 'repo::/a',
          probeOnly: true
        })
      ).toEqual({ claimed: true })
      expect(dispatcher).toHaveBeenCalledWith('tab.close', 'rpc', {
        worktreeId: 'repo::/a',
        probeOnly: true
      })
    })

    it('returns the reason the dispatcher gave when nothing claimed the command', () => {
      cleanup = registerAppCommandDispatcher(() => ({
        claimed: false,
        reason: 'no focused tab in workspace repo::/a'
      }))

      expect(dispatchAppCommandWithResult('tab.close', 'rpc')).toEqual({
        claimed: false,
        reason: 'no focused tab in workspace repo::/a'
      })
    })

    it('gives a reason when a boolean dispatcher declines', () => {
      cleanup = registerAppCommandDispatcher(() => false)

      const result = dispatchAppCommandWithResult('view.tasks', 'rpc')

      expect(result.claimed).toBe(false)
      expect(result.reason).toContain('view.tasks')
    })

    it('explains an unknown action and a missing dispatcher', () => {
      expect(dispatchAppCommandWithResult('view.tasks', 'rpc')).toMatchObject({
        claimed: false,
        reason: expect.stringContaining('not ready')
      })

      cleanup = registerAppCommandDispatcher(() => true)
      expect(dispatchAppCommandWithResult('missing.action', 'rpc')).toEqual({
        claimed: false,
        reason: 'unknown action missing.action'
      })
    })
  })
})

describe('action catalog against the app command map', () => {
  it('backs every rpc action with a handler', () => {
    const handlerIds = new Set<string>(APP_COMMAND_HANDLER_IDS)
    const unbacked = Object.entries(ACTION_CATALOG)
      .filter(([, entry]) => entry.dispatch === 'rpc')
      .map(([id]) => id)
      .filter((id) => !handlerIds.has(id))

    expect(unbacked).toEqual([])
  })

  it('catalogs every handled action as rpc, so a ui-only action never has a handler', () => {
    const mislabelled = APP_COMMAND_HANDLER_IDS.filter(
      (id) => !isCatalogedActionId(id) || ACTION_CATALOG[id].dispatch !== 'rpc'
    )

    expect(mislabelled).toEqual([])
  })
})
