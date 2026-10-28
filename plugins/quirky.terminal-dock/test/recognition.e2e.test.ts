import { afterEach, expect, test } from 'bun:test'
import { join } from 'node:path'
import type { DockState, SendResult } from '../src/types'
import { enableDock, inputBytes, launchShell, paneOf, startDockE2E, waitForTuiInput, type DockHarness } from './support'
import { RECOGNITION_TUI } from './fixtures/recognition-tui'
import { openTab } from '../../quirky.terminal/test/e2e/support'
import { waitFor } from '../../quirky.terminal/test/e2e-support'

let harness: DockHarness | undefined

afterEach(async () => {
  await harness?.cleanup()
  harness = undefined
})

async function getDock(pane: string): Promise<DockState> {
  return await harness!.call('quirky.terminal-dock/get', { pane }) as DockState
}

async function setDock(pane: string, state: DockState, docked: boolean): Promise<DockState> {
  return await harness!.call('quirky.terminal-dock/set', { pane, revision: state.revision, docked }) as DockState
}

test(
  'a disabled public catalog agent docks and uses the generic unobservable PTY input tier',
  async () => {
    harness = await startDockE2E()
    await harness.call('quirky.agents/configure', {
      agent: 'gemini',
      command: join(harness.home, 'bin', 'dock-fake-claude')
    })
    const shell = await launchShell(harness)
    const opened = await openTab(harness, ['--agent', 'gemini'], { ready: false })
    const managed = await harness.sessionRecord(opened.session)
    await harness.call('quirky.agents/setEnabled', { agent: 'gemini', enabled: false })
    const catalog = await harness.call('quirky.agents/list', { all: true }) as { agents: { id: string; enabled: boolean }[] }
    expect(catalog.agents.find((agent) => agent.id === 'gemini')?.enabled).toBe(false)

    await enableDock(harness)
    const plainShellPane = await paneOf(harness, shell.id)
    const plainShell = await getDock(plainShellPane)
    expect(plainShell).toMatchObject({ supported: false, docked: false, agent: null })

    const pane = await paneOf(harness, managed.id)
    const openedDock = await waitFor('disabled catalog Gemini session to auto-dock', async () => {
      const state = await getDock(pane)
      return state.supported && state.docked && state.agent === 'gemini' ? state : undefined
    })
    expect(openedDock).toMatchObject({ supported: true, docked: true, agent: 'gemini' })
    expect((await harness.sessionRecord(managed.id)).agent).toBe('gemini')

    const sending = harness.call('quirky.terminal-dock/send', { pane, id: 'gemini-unobservable', text: 'input tier reaches Gemini' }) as Promise<SendResult>
    await waitForTuiInput(harness, (input) => input.includes(Buffer.from('input tier reaches Gemini')))
    await expect(sending).resolves.toMatchObject({ outcome: 'unobservable', accepted: true })
    expect(inputBytes(harness).includes(Buffer.from('input tier reaches Gemini'))).toBe(true)
  },
  90_000
)

test(
  'manual shell agents use live/title evidence, latch through transient loss, and close/reopen on confirmed return',
  async () => {
    harness = await startDockE2E()
    harness.writeBinScript('dock-recognition-tui', RECOGNITION_TUI)
    const shell = await launchShell(harness)
    await enableDock(harness)
    const pane = await paneOf(harness, shell.id)
    expect(await getDock(pane)).toMatchObject({ supported: false, docked: false, agent: null })
    const nonAgentTitles = ['user@host:/repo/claude', 'working on codex docs']
    harness.writeBinScript(
      'dock-title-probe',
      nonAgentTitles.map((title) => `printf '\\033]0;${title}\\007'; sleep 0.5`).join('; ')
    )
    const eventStart = harness.events.length
    await harness.type(shell.id, 'dock-title-probe')
    for (const title of nonAgentTitles) {
      await waitFor(`public PTY title fact ${title}`, () =>
        harness!.events.slice(eventStart).find((event) => {
          if (event.type !== 'quirky.terminal/title' || !('data' in event)) return false
          const data = event.data
          return typeof data === 'object' && data !== null && !Array.isArray(data) &&
            'sessionId' in data && data.sessionId === shell.id && 'title' in data && data.title === title
        })
      )
      expect(await getDock(pane)).toMatchObject({ supported: false, docked: false, agent: null })
    }
    await waitFor('plain title probe command to finish', () =>
      harness!.events.slice(eventStart).find((event) => {
        if (event.type !== 'quirky.terminal/commandFinished' || !('data' in event)) return false
        const data = event.data
        return typeof data === 'object' && data !== null && !Array.isArray(data) &&
          'sessionId' in data && data.sessionId === shell.id
      })
    )

    await harness.type(shell.id, 'dock-recognition-tui')
    const titled = await waitFor('manual Claude-branded terminal title to auto-dock', async () => {
      const state = await getDock(pane)
      return state.supported && state.docked && state.agent === 'claude' ? state : undefined
    })
    expect(titled).toMatchObject({ supported: true, docked: true, agent: 'claude', userUndocked: false })
    expect((await harness.sessionRecord(shell.id)).agent).toBe('shell')
    const manualSend = harness.call('quirky.terminal-dock/send', {
      pane,
      id: 'manual-claude-projection',
      text: 'manual Claude bridge input'
    }) as Promise<SendResult>
    void manualSend.catch(() => undefined)
    await waitForTuiInput(harness, (input) => input.includes(Buffer.from('manual Claude bridge input')))
    const manualSendResult = await manualSend
    expect(manualSendResult.accepted).toBe(true)
    expect(manualSendResult.outcome).not.toBe('unobservable')
    expect(inputBytes(harness).includes(Buffer.from('manual Claude bridge input'))).toBe(true)
    expect((await harness.sessionRecord(shell.id)).agent).toBe('shell')

    const manuallyClosed = await setDock(pane, titled, false)
    expect(manuallyClosed).toMatchObject({ supported: true, docked: false, userUndocked: true })
    await harness.type(shell.id, 'P')
    await waitFor('live program-app evidence for manual Claude', async () => {
      const row = await harness!.call('quirky.agent-status/get', { session: shell.id }) as { programStatus?: { app?: string } } | null
      return row?.programStatus?.app === 'ClaudeCode' ? row : undefined
    })
    expect(await getDock(pane)).toMatchObject({ supported: true, docked: false, userUndocked: true })

    await harness.type(shell.id, 'L')
    await waitFor('program-app evidence to disappear', async () => {
      const row = await harness!.call('quirky.agent-status/get', { session: shell.id }) as { programStatus?: { app?: string } } | null
      return !row?.programStatus?.app ? true : undefined
    })
    expect(await getDock(pane)).toMatchObject({ supported: false, docked: false, userUndocked: true })

    await harness.type(shell.id, 'R')
    const relaunchedTitle = await waitFor('fresh title after manual close', async () => {
      const state = await getDock(pane)
      return state.supported && !state.docked && state.userUndocked && state.agent === 'claude' ? state : undefined
    })
    expect(relaunchedTitle.docked).toBe(false)
    const reopened = await setDock(pane, relaunchedTitle, true)
    const drafted = await harness.call('quirky.terminal-dock/set', {
      pane,
      revision: reopened.revision,
      draft: 'keep this draft through title loss'
    }) as DockState
    await harness.type(shell.id, 'L')
    await waitFor('latched manual dock to survive title and app loss', async () => {
      const state = await getDock(pane)
      return state.docked && state.supported && state.agent === 'claude' && state.draft === 'keep this draft through title loss' ? state : undefined
    })
    expect(await getDock(pane)).toMatchObject({ supported: true, docked: true, agent: 'claude', draft: drafted.draft })

    await harness.type(shell.id, 'Q')
    const returned = await waitFor('foreground CLI command-finished to undock without a manual-close latch', async () => {
      const state = await getDock(pane)
      return !state.docked && !state.supported && !state.userUndocked ? state : undefined
    })
    expect(returned).toMatchObject({ docked: false, supported: false, userUndocked: false, agent: null })

    await harness.type(shell.id, 'dock-recognition-tui')
    const relaunched = await waitFor('fresh manual CLI identity to auto-open after confirmed exit', async () => {
      const state = await getDock(pane)
      return state.docked && state.supported && state.agent === 'claude' ? state : undefined
    })
    expect(relaunched).toMatchObject({ supported: true, docked: true, agent: 'claude', userUndocked: false })
  },
  90_000
)
