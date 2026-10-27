import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { act } from 'react'
import { fakeDaemon, fire, loadWorkspace, mountFixture, mouse, settle, simpleWorkspace, startRecording, stopRecording, unloadWorkspace, type MountedWorkspace } from './workspace-support'

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

async function revise(view: MountedWorkspace) {
  view.daemon.set({ ...view.daemon.workspace })
  await act(async () => {
    await view.controller().refresh()
  })
  await settle()
}

describe('focus across a layout revision', () => {
  test('an open search field keeps focus when another client revises the layout', async () => {
    mounted = await mountFixture(fakeDaemon(simpleWorkspace()))
    await act(async () => mounted!.controller().search('abc'))
    await settle()
    const field = mounted.q<HTMLInputElement>('[data-pane-search] input')!
    expect(document.activeElement).toBe(field)
    const before = mounted.last().layout.revision
    await revise(mounted)
    expect(mounted.last().layout.revision).toBeGreaterThan(before)
    expect(document.activeElement).toBe(field)
  })

  test('the terminal takes focus back after a revision when it is what lost it', async () => {
    mounted = await mountFixture(fakeDaemon(simpleWorkspace()))
    const area = mounted.q<HTMLTextAreaElement>('textarea.xterm-helper-textarea')!
    mounted.element.ownerDocument.body.focus()
    await revise(mounted)
    expect(document.activeElement).toBe(area)
  })

  test('a button of the workspace gives focus back to the terminal after a revision', async () => {
    mounted = await mountFixture(fakeDaemon(simpleWorkspace()))
    const area = mounted.q<HTMLTextAreaElement>('textarea.xterm-helper-textarea')!
    await act(async () => mounted!.q<HTMLButtonElement>('.qt-plus')!.focus())
    expect(document.activeElement).not.toBe(area)
    await revise(mounted)
    expect(document.activeElement).toBe(area)
  })
})

describe('authoritative terminal focus reporting', () => {
  test('reports a workspace only when its terminal input receives focus', async () => {
    mounted = await mountFixture(fakeDaemon(simpleWorkspace()), {
      extra: { 'quirky.terminal/focusContext': (params) => ({ workspace: params.workspace ?? null }) }
    })
    const pane = mounted.q('[data-pane="pane-1"]')!
    const textarea = mounted.q<HTMLTextAreaElement>('[data-pane="pane-1"] textarea.xterm-helper-textarea')!
    const focusCalls = () => mounted!.fake.callsTo('quirky.terminal/focusContext').map((call) => call.params)
    const panel = document.createElement('button')
    panel.dataset.sessionInfoPanel = 'true'
    document.body.appendChild(panel)
    await act(async () => void panel.focus())
    const callsBeforeMouseDown = focusCalls().length
    await fire(pane, mouse('mousedown', { button: 0 }))
    expect(focusCalls()).toHaveLength(callsBeforeMouseDown)
    await act(async () => void textarea.focus())
    expect(focusCalls()).toHaveLength(callsBeforeMouseDown + 1)
    expect(focusCalls().at(-1)).toEqual({ workspace: 'wt-main' })
    const callsBeforePanelFocus = focusCalls().length
    await act(async () => void panel.focus())
    expect(focusCalls()).toHaveLength(callsBeforePanelFocus)
  })
})
