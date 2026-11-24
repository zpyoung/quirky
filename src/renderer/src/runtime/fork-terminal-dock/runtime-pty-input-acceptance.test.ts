import { beforeEach, describe, expect, it, vi } from 'vitest'
import { sendRuntimePtyInput, sendRuntimePtyInputAcceptance } from '../runtime-terminal-inspection'
import { CLIPBOARD_TEXT_MEASURE_YIELD_CODE_UNITS } from '../../../../shared/clipboard-text'
import {
  createCompatibleRuntimeStatusResponseIfNeeded,
  type RuntimeEnvironmentCallRequest
} from '../runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCacheForTests } from '../runtime-rpc-client'
import { TERMINAL_INPUT_MAX_BYTES } from '../../../../shared/terminal-input'
import { useAppStore } from '../../store'

const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const PANE_KEY = `tab-1:${LEAF_ID}`

function makeByteOversizedTerminalInput(): string {
  return '😀'.repeat(Math.floor(TERMINAL_INPUT_MAX_BYTES / 4) + 1)
}

describe('runtime terminal input acceptance', () => {
  const runtimeCall = vi.fn()
  const runtimeTransportCall = vi.fn()
  const localWrite = vi.fn()
  const localWriteAccepted = vi.fn()
  const localForeground = vi.fn()
  const localHasChildren = vi.fn()
  const localInspect = vi.fn()

  beforeEach(() => {
    clearRuntimeCompatibilityCacheForTests()
    vi.clearAllMocks()
    runtimeCall.mockResolvedValue({
      ok: true,
      result: { process: { foregroundProcess: 'bash', hasChildProcesses: true } },
      _meta: { runtimeId: 'runtime-1' }
    })
    runtimeTransportCall.mockImplementation((args: RuntimeEnvironmentCallRequest) => {
      return createCompatibleRuntimeStatusResponseIfNeeded(args) ?? runtimeCall(args)
    })
    vi.stubGlobal('window', {
      api: {
        runtimeEnvironments: { call: runtimeTransportCall },
        pty: {
          write: localWrite,
          writeAccepted: localWriteAccepted,
          getForegroundProcess: localForeground,
          hasChildProcesses: localHasChildren,
          inspectProcess: localInspect
        }
      }
    })
    useAppStore.setState({
      settings: { experimentalAgentHibernation: true } as never,
      terminalLayoutsByTabId: {},
      lastTerminalInputAtByPaneKey: {}
    })
  })

  describe('sendRuntimePtyInputAcceptance', () => {
    it('resolves false on a remote RPC rejection, without throwing', async () => {
      runtimeCall.mockRejectedValue(new Error('terminal_handle_stale'))

      await expect(
        sendRuntimePtyInputAcceptance('remote:env-1@@terminal-stale', 'x', 'driving')
      ).resolves.toBe(false)

      expect(useAppStore.getState().lastTerminalInputAtByPaneKey).toEqual({})
    })

    it('resolves false when the remote transport reports accepted: false', async () => {
      runtimeCall.mockResolvedValue({
        ok: true,
        result: { send: { handle: 'terminal-1', accepted: false, bytesWritten: 0 } },
        _meta: { runtimeId: 'runtime-1' }
      })

      await expect(
        sendRuntimePtyInputAcceptance('remote:env-1@@terminal-1', 'x', 'driving')
      ).resolves.toBe(false)

      expect(runtimeCall).toHaveBeenCalledWith({
        selector: 'env-1',
        method: 'terminal.send',
        params: {
          terminal: 'terminal-1',
          text: 'x',
          client: { id: 'quirky-desktop', type: 'desktop' }
        },
        timeoutMs: 15_000
      })
    })

    it('resolves false when the deferred size check suppresses an oversized body, before any transport call', async () => {
      vi.useFakeTimers()
      try {
        const text = makeByteOversizedTerminalInput()
        const accepted = sendRuntimePtyInputAcceptance('remote:env-1@@terminal-1', text, 'driving')

        await vi.runAllTimersAsync()

        await expect(accepted).resolves.toBe(false)
        expect(runtimeTransportCall).not.toHaveBeenCalled()
        expect(localWrite).not.toHaveBeenCalled()
      } finally {
        vi.useRealTimers()
      }
    })

    it('resolves true and records the owning pane on a successful remote send', async () => {
      runtimeCall.mockResolvedValue({
        ok: true,
        result: { send: { handle: 'terminal-1', accepted: true, bytesWritten: 1 } },
        _meta: { runtimeId: 'runtime-1' }
      })
      useAppStore.setState({
        settings: { experimentalAgentHibernation: true } as never,
        terminalLayoutsByTabId: {
          'tab-1': {
            root: { type: 'leaf', leafId: LEAF_ID },
            activeLeafId: LEAF_ID,
            expandedLeafId: null,
            ptyIdsByLeafId: { [LEAF_ID]: 'remote:env-1@@terminal-1' }
          }
        }
      })

      await expect(
        sendRuntimePtyInputAcceptance('remote:env-1@@terminal-1', 'x', 'driving')
      ).resolves.toBe(true)

      expect(useAppStore.getState().lastTerminalInputAtByPaneKey[PANE_KEY]).toEqual(
        expect.any(Number)
      )
    })

    it('resolves true and records the owning pane when main accepts a local write', async () => {
      localWriteAccepted.mockResolvedValue(true)
      useAppStore.setState({
        settings: { experimentalAgentHibernation: true } as never,
        terminalLayoutsByTabId: {
          'tab-1': {
            root: { type: 'leaf', leafId: LEAF_ID },
            activeLeafId: LEAF_ID,
            expandedLeafId: null,
            ptyIdsByLeafId: { [LEAF_ID]: 'local-pty' }
          }
        }
      })

      await expect(sendRuntimePtyInputAcceptance('local-pty', 'x', 'driving')).resolves.toBe(true)

      expect(localWriteAccepted).toHaveBeenCalledWith('local-pty', 'x', 'driving', {
        requireWriteSettlement: true
      })
      expect(localWrite).not.toHaveBeenCalled()
      expect(useAppStore.getState().lastTerminalInputAtByPaneKey[PANE_KEY]).toEqual(
        expect.any(Number)
      )
    })

    it('resolves false without recording input when main rejects a local write', async () => {
      localWriteAccepted.mockResolvedValue(false)

      await expect(sendRuntimePtyInputAcceptance('local-pty', 'x', 'driving')).resolves.toBe(false)

      expect(localWriteAccepted).toHaveBeenCalledWith('local-pty', 'x', 'driving', {
        requireWriteSettlement: true
      })
      expect(useAppStore.getState().lastTerminalInputAtByPaneKey).toEqual({})
    })

    it('leaves the fire-and-forget local write path untouched', async () => {
      expect(sendRuntimePtyInput('local-pty', 'x', 'driving')).toBe(true)

      expect(localWrite).toHaveBeenCalledWith('local-pty', 'x', 'driving')
      expect(localWriteAccepted).not.toHaveBeenCalled()
    })

    it('does not dispatch the local ack IPC when cancelled during deferred size validation', async () => {
      vi.useFakeTimers()
      try {
        const text = 'a'.repeat(CLIPBOARD_TEXT_MEASURE_YIELD_CODE_UNITS + 1)
        let cancelled = false
        const accepted = sendRuntimePtyInputAcceptance(
          'local-pty',
          text,
          'driving',
          () => cancelled
        )
        cancelled = true

        await vi.runAllTimersAsync()

        await expect(accepted).resolves.toBe(false)
        expect(localWriteAccepted).not.toHaveBeenCalled()
      } finally {
        vi.useRealTimers()
      }
    })

    it('does not dispatch the remote RPC when cancelled during deferred size validation', async () => {
      vi.useFakeTimers()
      try {
        const text = 'a'.repeat(CLIPBOARD_TEXT_MEASURE_YIELD_CODE_UNITS + 1)
        let cancelled = false
        const accepted = sendRuntimePtyInputAcceptance(
          'remote:env-1@@terminal-1',
          text,
          'driving',
          () => cancelled
        )
        cancelled = true

        await vi.runAllTimersAsync()

        await expect(accepted).resolves.toBe(false)
        expect(runtimeTransportCall).not.toHaveBeenCalled()
      } finally {
        vi.useRealTimers()
      }
    })

    it('dispatches normally when isCancelled is omitted or stays false', async () => {
      localWriteAccepted.mockResolvedValue(true)

      await expect(
        sendRuntimePtyInputAcceptance('local-pty', 'x', 'driving', () => false)
      ).resolves.toBe(true)
      expect(localWriteAccepted).toHaveBeenCalledWith('local-pty', 'x', 'driving', {
        requireWriteSettlement: true
      })
    })
  })
})
