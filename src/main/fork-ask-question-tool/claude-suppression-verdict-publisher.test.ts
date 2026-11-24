import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const execLocal = vi.fn()

vi.mock('../ipc/preflight-command-exec', () => ({
  execLocalPreflightCommandOrThrow: (command: string, args: string[]) =>
    execLocal(command, args) as Promise<{ stdout: string; stderr: string }>,
  shellQuote: (value: string) => `'${value}'`
}))

const { clearClaudeAskSuppressionGateForTests } = await import('./claude-ask-suppression-gate')
const { resolveClaudeSuppressionVerdict, setLocalClaudeSuppressionVerdictReader } =
  await import('../../shared/fork-ask-question-tool/claude-suppression-verdict')
const {
  startClaudeSuppressionVerdictPublisher,
  ASK_SUPPRESSION_VERDICT_CHANNEL,
  ASK_SUPPRESSION_VERDICT_GET_CHANNEL
} = await import('./claude-suppression-verdict-publisher')

type SettingsListener = (updates: Record<string, unknown>) => void

function makeHarness(settings: Record<string, unknown> = {}) {
  const listeners: SettingsListener[] = []
  const current = { ...settings }
  const send = vi.fn()
  const handlers = new Map<string, () => unknown>()
  const stop = startClaudeSuppressionVerdictPublisher({
    store: {
      getSettings: () => current,
      onSettingsChanged: (listener) => {
        listeners.push(listener)
        return () => undefined
      }
    },
    ipcMain: {
      handle: (channel: string, handler: () => unknown) => handlers.set(channel, handler),
      removeHandler: (channel: string) => handlers.delete(channel)
    } as never,
    getWindows: () => [{ isDestroyed: () => false, webContents: { send } } as never]
  })
  const changeSettings = (updates: Record<string, unknown>): void => {
    Object.assign(current, updates)
    for (const listener of listeners) {
      listener(updates)
    }
  }
  return { send, handlers, changeSettings, stop }
}

beforeEach(() => {
  clearClaudeAskSuppressionGateForTests()
  execLocal.mockReset().mockResolvedValue({ stdout: '1.2.0', stderr: '' })
})

afterEach(() => {
  setLocalClaudeSuppressionVerdictReader(null)
})

describe('startClaudeSuppressionVerdictPublisher', () => {
  it('registers the reader that main-process launch composition resolves against', async () => {
    const harness = makeHarness()

    await vi.waitFor(() => expect(resolveClaudeSuppressionVerdict({})).not.toBe('pending'))
    expect(resolveClaudeSuppressionVerdict({})).toEqual([
      '--disallowedTools',
      'AskUserQuestion',
      '--append-system-prompt',
      expect.stringContaining('quirky ask')
    ])
    harness.stop()
  })

  it('pushes the verdict to the renderer once the probe lands', async () => {
    const harness = makeHarness()

    await vi.waitFor(() => expect(harness.send).toHaveBeenCalledTimes(1))
    expect(harness.send).toHaveBeenCalledWith(
      ASK_SUPPRESSION_VERDICT_CHANNEL,
      expect.arrayContaining(['AskUserQuestion'])
    )
    harness.stop()
  })

  it('does not re-send an unchanged verdict', async () => {
    const harness = makeHarness()
    await vi.waitFor(() => expect(harness.send).toHaveBeenCalledTimes(1))

    harness.changeSettings({ someUnrelatedSetting: true })
    await Promise.resolve()

    expect(harness.send).toHaveBeenCalledTimes(1)
    harness.stop()
  })

  it('re-probes and re-publishes when the claude command override changes', async () => {
    const harness = makeHarness()
    await vi.waitFor(() => expect(harness.send).toHaveBeenCalledTimes(1))

    execLocal.mockResolvedValue({ stdout: '1.0.0', stderr: '' })
    harness.changeSettings({ agentCmdOverrides: { claude: 'old-claude' } })

    await vi.waitFor(() => expect(harness.send).toHaveBeenCalledTimes(2))
    expect(harness.send).toHaveBeenLastCalledWith(ASK_SUPPRESSION_VERDICT_CHANNEL, null)
    harness.stop()
  })

  it('answers the renderer fetch that runs before the first probe lands', () => {
    const harness = makeHarness()

    expect(harness.handlers.get(ASK_SUPPRESSION_VERDICT_GET_CHANNEL)?.()).toBe('pending')
    harness.stop()
  })

  it('stops answering as the local verdict source once disposed', async () => {
    const harness = makeHarness()
    await vi.waitFor(() => expect(resolveClaudeSuppressionVerdict({})).not.toBe('pending'))

    harness.stop()

    expect(resolveClaudeSuppressionVerdict({})).toBe('pending')
    expect(harness.handlers.has(ASK_SUPPRESSION_VERDICT_GET_CHANNEL)).toBe(false)
  })
})
