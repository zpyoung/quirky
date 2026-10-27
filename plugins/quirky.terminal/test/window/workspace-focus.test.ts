import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { act } from 'react'
import { fakeDaemon, loadWorkspace, mountFixture, settle, simpleWorkspace, startRecording, stopRecording, unloadWorkspace, type MountedWorkspace } from './workspace-support'

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
