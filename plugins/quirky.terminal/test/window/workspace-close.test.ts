import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { act } from 'react'
import { RpcErrorCode } from '@quirky/protocol'
import {
  callsTo,
  click,
  conceptualWorkspace,
  fakeDaemon,
  fire,
  group,
  loadWorkspace,
  makeWorkspace,
  mountFixture,
  notFound,
  pane,
  settle,
  simpleWorkspace,
  sleep,
  startRecording,
  stopRecording,
  tab,
  unloadWorkspace,
  type DaemonOptions,
  type MountedWorkspace
} from './workspace-support'

let mounted: MountedWorkspace | null = null

beforeAll(loadWorkspace)
afterAll(unloadWorkspace)
beforeEach(startRecording)
afterEach(async () => {
  await mounted?.unmount()
  mounted = null
  stopRecording()
  document.body.innerHTML = ''
})

const GUARD_WAIT = 380

async function mount(workspace = simpleWorkspace(), daemon: DaemonOptions = {}, options: Record<string, unknown> = {}) {
  mounted = await mountFixture(fakeDaemon(workspace, daemon), options as never)
  return mounted
}

const dialog = (view: MountedWorkspace) => view.q('[role="dialog"]')
const button = (view: MountedWorkspace, label: string) => [...view.element.querySelectorAll<HTMLElement>('[role="dialog"] button')].find((el) => el.textContent === label) ?? null
async function closeFocused(view: MountedWorkspace) {
  await act(async () => void view.controller().closeFocused())
  await settle()
}
const twoTabs = () => makeWorkspace(group('grp-1', [tab('tab-1', pane('pane-1', 's-1'), { defaultTitle: 'Terminal 1' }), tab('tab-2', pane('pane-2', 's-2'), { defaultTitle: 'Terminal 2' })]))

describe('SC-13: closing a tab running a command asks first', () => {
  const RUNNING = { describe: 'Stop sleep in Terminal 1?' }

  test('shows the question with the tab name, Cancel, Stop and Close and the checkbox', async () => {
    const view = await mount(simpleWorkspace(), RUNNING)
    await closeFocused(view)
    expect(callsTo(view.fake, 'describeClose')).toEqual([{ tab: 'tab-1' }])
    expect(dialog(view)!.getAttribute('aria-label')).toBe('Stop running command?')
    expect(dialog(view)!.textContent).toContain('Closing this terminal will stop the command running inside it.')
    expect(dialog(view)!.textContent).toContain('Terminal 1')
    expect([...dialog(view)!.querySelectorAll('button')].map((el) => el.textContent)).toEqual(['Cancel', 'Stop and Close'])
    expect(dialog(view)!.textContent).toContain("Don't ask again for running terminals")
    expect(view.last().dialog).toEqual({ kind: 'close-running', title: 'Stop running command?' })
    expect(callsTo(view.fake, 'closeTab')).toEqual([])
  })

  test('Cancel keeps the tab', async () => {
    const view = await mount(simpleWorkspace(), RUNNING)
    await closeFocused(view)
    await click(button(view, 'Cancel'))
    expect(dialog(view)).toBeNull()
    expect(callsTo(view.fake, 'closeTab')).toEqual([])
  })

  test('Escape cancels as well', async () => {
    const view = await mount(simpleWorkspace(), RUNNING)
    await closeFocused(view)
    await fire(window, new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(dialog(view)).toBeNull()
    expect(callsTo(view.fake, 'closeTab')).toEqual([])
  })

  test('Stop and Close calls closeTab with yes', async () => {
    const view = await mount(simpleWorkspace(), RUNNING)
    await closeFocused(view)
    await click(button(view, 'Stop and Close'))
    expect(callsTo(view.fake, 'closeTab')).toEqual([{ tab: 'tab-1', yes: true }])
    expect(dialog(view)).toBeNull()
  })

  test('ticking the box turns the setting off, and the next close does not ask', async () => {
    const view = await mount(twoTabs(), { describe: 'Stop sleep in Terminal 1?' })
    await closeFocused(view)
    await click(view.q('[role="dialog"] input[type="checkbox"]'))
    await click(button(view, 'Stop and Close'))
    expect(view.fake.callsTo('setting.set').map((call) => call.params)).toEqual([{ id: 'setting:quirky.terminal/confirm-close-running', value: false }])
    expect(callsTo(view.fake, 'closeTab')).toEqual([{ tab: 'tab-1', yes: true }])
    await sleep(GUARD_WAIT)
    await closeFocused(view)
    expect(dialog(view)).toBeNull()
    expect(callsTo(view.fake, 'closeTab')).toHaveLength(2)
  })

  test('with the setting off a running command closes without a dialog', async () => {
    const view = await mount(simpleWorkspace(), RUNNING, { settings: { 'confirm-close-running': false } })
    await closeFocused(view)
    expect(dialog(view)).toBeNull()
    expect(callsTo(view.fake, 'closeTab')).toEqual([{ tab: 'tab-1', yes: true }])
  })

  test('an agent session asks "Stop this agent?" with Stop Agent', async () => {
    const view = await mount(simpleWorkspace(), { describe: 'Stop agent Claude?' })
    await closeFocused(view)
    expect(dialog(view)!.getAttribute('aria-label')).toBe('Stop this agent?')
    expect(button(view, 'Stop Agent')).not.toBeNull()
    expect(dialog(view)!.textContent).toContain("Closing this terminal will stop the agent's current work.")
    await click(button(view, 'Stop Agent'))
    expect(callsTo(view.fake, 'closeTab')).toEqual([{ tab: 'tab-1', yes: true }])
  })

  test('nothing to confirm closes at once with yes', async () => {
    const view = await mount()
    await closeFocused(view)
    expect(dialog(view)).toBeNull()
    expect(callsTo(view.fake, 'closeTab')).toEqual([{ tab: 'tab-1', yes: true }])
  })

  test('a failed question shows a toast and closes nothing', async () => {
    const view = await mount(simpleWorkspace(), {}, {
      extra: {
        'quirky.terminal/describeClose': () => {
          throw notFound('no tab tab-1')
        }
      }
    })
    await closeFocused(view)
    expect(view.fake.toasts.map((toast) => toast.title)).toEqual(['Could not close'])
    expect(callsTo(view.fake, 'closeTab')).toEqual([])
  })
})

describe('SC-15: a double click cannot confirm the next tab', () => {
  test('a close requested right after a confirmed one is dropped; later ones go through', async () => {
    const view = await mount(twoTabs(), { describe: 'Stop sleep?' })
    await closeFocused(view)
    await click(button(view, 'Stop and Close'))
    expect(callsTo(view.fake, 'closeTab')).toEqual([{ tab: 'tab-1', yes: true }])
    const asked = callsTo(view.fake, 'describeClose').length
    await act(async () => void view.controller().closeTab('tab-2'))
    await settle()
    expect(callsTo(view.fake, 'describeClose')).toHaveLength(asked)
    expect(dialog(view)).toBeNull()
    await sleep(GUARD_WAIT)
    await act(async () => void view.controller().closeTab('tab-2'))
    await settle()
    expect(dialog(view)).not.toBeNull()
  })

  test('a second click on a dialog that opened straight after a confirmed one is ignored', async () => {
    const ws = twoTabs()
    ;(ws.root as any).tabs[0].pinned = true
    const view = await mount(ws, { describe: 'Stop sleep in Terminal 1?' })
    await act(async () => void view.controller().closeTab('tab-1'))
    await settle()
    expect(dialog(view)!.getAttribute('aria-label')).toBe('Close pinned tab?')
    await click(button(view, 'Close'))
    expect(dialog(view)!.getAttribute('aria-label')).toBe('Stop running command?')
    await click(button(view, 'Stop and Close'))
    expect(callsTo(view.fake, 'closeTab')).toEqual([])
    expect(dialog(view)).not.toBeNull()
    await sleep(GUARD_WAIT)
    await click(button(view, 'Stop and Close'))
    expect(callsTo(view.fake, 'closeTab')).toEqual([{ tab: 'tab-1', yes: true }])
  })
})

describe('SC-16: closing a pinned tab asks unless turned off', () => {
  const pinned = () => {
    const ws = simpleWorkspace()
    ;(ws.root as any).tabs[0].pinned = true
    return ws
  }

  test('asks "Close pinned tab?" with the pinned checkbox', async () => {
    const view = await mount(pinned())
    await closeFocused(view)
    expect(dialog(view)!.getAttribute('aria-label')).toBe('Close pinned tab?')
    expect(dialog(view)!.textContent).toContain("Don't ask again for pinned tabs")
    expect(callsTo(view.fake, 'closeTab')).toEqual([])
    expect(callsTo(view.fake, 'describeClose')).toEqual([])
  })

  test('Close closes it', async () => {
    const view = await mount(pinned())
    await closeFocused(view)
    await click(button(view, 'Close'))
    expect(callsTo(view.fake, 'closeTab')).toEqual([{ tab: 'tab-1', yes: true }])
  })

  test('Cancel keeps it', async () => {
    const view = await mount(pinned())
    await closeFocused(view)
    await click(button(view, 'Cancel'))
    expect(callsTo(view.fake, 'closeTab')).toEqual([])
  })

  test('ticking the box turns Confirm before closing pinned tabs off', async () => {
    const view = await mount(pinned())
    await closeFocused(view)
    await click(view.q('[role="dialog"] input[type="checkbox"]'))
    await click(button(view, 'Close'))
    expect(view.fake.callsTo('setting.set').map((call) => call.params)).toEqual([{ id: 'setting:quirky.terminal/confirm-close-pinned', value: false }])
  })

  test('with the setting off it closes without asking', async () => {
    const view = await mount(pinned(), {}, { settings: { 'confirm-close-pinned': false } })
    await closeFocused(view)
    expect(dialog(view)).toBeNull()
    expect(callsTo(view.fake, 'closeTab')).toEqual([{ tab: 'tab-1', yes: true }])
  })
})

describe('closing panes', () => {
  test('closing the focused pane of a split tab closes the pane', async () => {
    const view = await mount(conceptualWorkspace())
    await closeFocused(view)
    expect(callsTo(view.fake, 'describeClose')).toEqual([{ pane: 'pane-3' }])
    expect(callsTo(view.fake, 'closePane')).toEqual([{ pane: 'pane-3', yes: true }])
    expect(callsTo(view.fake, 'closeTab')).toEqual([])
  })

  test('a running pane asks before closing', async () => {
    const view = await mount(conceptualWorkspace(), { describe: 'Stop vim in Build?' })
    await closeFocused(view)
    expect(dialog(view)!.textContent).toContain('Build')
    await click(button(view, 'Stop and Close'))
    expect(callsTo(view.fake, 'closePane')).toEqual([{ pane: 'pane-3', yes: true }])
  })

  test('the header close button of a lone pane closes the tab; of a split pane, the pane', async () => {
    const lone = await mount()
    await click(lone.q('[aria-label="Close tab"]'))
    expect(callsTo(lone.fake, 'closeTab')).toEqual([{ tab: 'tab-1', yes: true }])
    await lone.unmount()
    mounted = null
    const split = await mount(conceptualWorkspace())
    await click(split.q('[data-pane-header] [aria-label="Close Pane"]'))
    expect(callsTo(split.fake, 'closePane')).toEqual([{ pane: 'pane-3', yes: true }])
  })

  test('a titled split pane shows Remove title instead of close', async () => {
    const ws = conceptualWorkspace()
    ;(ws.root as any).first.tabs[1].root.second.first.title = 'logs'
    const view = await mount(ws)
    const header = view.q('[data-pane-header]')!
    expect(header.textContent).toContain('logs')
    expect(header.querySelector('[aria-label="Close Pane"]')).toBeNull()
    await click(header.querySelector('[aria-label="Remove title"]'))
    expect(callsTo(view.fake, 'setPaneTitle')).toEqual([{ pane: 'pane-3', title: '' }])
  })

  test('with no tab open the floating workspace minimizes instead', async () => {
    const empty = makeWorkspace(group('grp-1', []), { id: 'floating' })
    mounted = await mountFixture(fakeDaemon(empty), { input: undefined, view: { workspace: 'floating' } })
    await act(async () => void mounted!.controller().closeFocused())
    await settle()
    expect(mounted.fake.callsTo('quirky.terminal/setFloating').map((call) => call.params)).toEqual([{ open: false }])
  })

  describe('closing the last tab of the floating workspace', () => {
    const floating = (tabs = 1) =>
      makeWorkspace(
        group(
          'grp-1',
          Array.from({ length: tabs }, (_, index) => tab(`tab-${index + 1}`, pane(`pane-${index + 1}`, `s-${index + 1}`)))
        ),
        { id: 'floating' }
      )
    const mountFloating = async (workspace = floating(), daemon: DaemonOptions = {}) => {
      mounted = await mountFixture(fakeDaemon(workspace, daemon), { input: undefined, view: { workspace: 'floating' } })
      return mounted
    }
    const minimized = (view: MountedWorkspace) => view.fake.callsTo('quirky.terminal/setFloating').map((call) => call.params)

    test('minimizes the panel in the same command', async () => {
      const view = await mountFloating()
      await closeFocused(view)
      expect(callsTo(view.fake, 'closeTab')).toEqual([{ tab: 'tab-1', yes: true }])
      expect(minimized(view)).toEqual([{ open: false }])
    })

    test('keeps the panel open while another tab remains', async () => {
      const view = await mountFloating(floating(2))
      await closeFocused(view)
      expect(callsTo(view.fake, 'closeTab')).toHaveLength(1)
      expect(minimized(view)).toEqual([])
    })

    test('minimizes after a confirmed close through the dialog', async () => {
      const view = await mountFloating(floating(), { describe: 'Stop sleep in Tab tab-1?' })
      await closeFocused(view)
      expect(minimized(view)).toEqual([])
      await click(button(view, 'Stop and Close'))
      expect(callsTo(view.fake, 'closeTab')).toEqual([{ tab: 'tab-1', yes: true }])
      expect(minimized(view)).toEqual([{ open: false }])
    })

    test('a failed close leaves the panel open', async () => {
      const view = await mountFloating()
      view.daemon.fail('closeTab', RpcErrorCode.Internal, 'boom')
      await closeFocused(view)
      expect(minimized(view)).toEqual([])
    })

    test('the tab close button minimizes too', async () => {
      const view = await mountFloating()
      await click(view.q('.qt-tab-close'))
      expect(minimized(view)).toEqual([{ open: false }])
    })

    test('a worktree workspace never minimizes the panel', async () => {
      const view = await mount()
      await closeFocused(view)
      expect(callsTo(view.fake, 'closeTab')).toHaveLength(1)
      expect(minimized(view)).toEqual([])
    })
  })
})

describe('SC-33: the exit overlay', () => {
  const exited = () => {
    const ws = conceptualWorkspace()
    ;(ws.root as any).first.tabs[1].root.second.second.exit = { code: 3, signal: null }
    return ws
  }

  test('Restart restarts the pane', async () => {
    const view = await mount(exited())
    await click([...view.element.querySelectorAll<HTMLElement>('[data-exit-overlay="pane-4"] button')].find((el) => el.textContent === 'Restart')!)
    expect(callsTo(view.fake, 'restartPane')).toEqual([{ pane: 'pane-4' }])
  })

  test('Close closes the pane', async () => {
    const view = await mount(exited())
    await click([...view.element.querySelectorAll<HTMLElement>('[data-exit-overlay="pane-4"] button')].find((el) => el.textContent === 'Close')!)
    expect(callsTo(view.fake, 'closePane')).toEqual([{ pane: 'pane-4', yes: true }])
  })

  test('the pane no longer takes keystrokes', async () => {
    const view = await mount(exited())
    await act(async () => {
      const terminal = (await import('./workspace-support')).terminals.find((candidate) => view.q('[data-pane="pane-4"]')!.contains(candidate.element ?? null))!
      terminal.input('ls')
    })
    expect(view.fake.callsTo('quirky.terminal/write')).toEqual([])
  })
})

describe('SC-72: reopen with nothing to reopen', () => {
  const reopen = async (view: MountedWorkspace) => {
    await act(async () => void view.controller().reopenTab())
    await settle()
  }

  test('a not-found answer shows the "No closed tab to reopen" toast', async () => {
    const view = await mount(simpleWorkspace(), {}, {
      extra: {
        'quirky.terminal/reopenTab': () => {
          throw notFound('no closed tab to reopen in main')
        }
      }
    })
    await reopen(view)
    expect(view.fake.toasts.map((toast) => toast.title)).toEqual(['No closed tab to reopen'])
  })

  test('another failure is shown as its own error', async () => {
    const view = await mount(simpleWorkspace(), {}, {
      extra: {
        'quirky.terminal/reopenTab': () => {
          throw Object.assign(new Error('boom'), { code: RpcErrorCode.Internal })
        }
      }
    })
    await reopen(view)
    expect(view.fake.toasts).toEqual([{ title: 'Could not reopen the tab', body: 'boom' }])
  })

  test('a closed tab is reopened through the workspace', async () => {
    const view = await mount(simpleWorkspace(), {}, { extra: { 'quirky.terminal/reopenTab': () => ({ workspace: { ...simpleWorkspace(), revision: 9 } }) } })
    await reopen(view)
    expect(callsTo(view.fake, 'reopenTab')).toEqual([{ workspace: 'wt-main' }])
    expect(view.last().layout.revision).toBe(9)
  })
})
